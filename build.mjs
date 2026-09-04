// ============================================================
// build.mjs —— js13kGames 构建流水线
//
//   src/*.js ──esbuild(bundle, IIFE, 不压缩)──▶ bundle.js
//            ──terser(mangle + compress passes:3 + unsafe)──▶ min.js
//            ──roadroller(熵编码打包)──▶ packed.js
//            ──内联进 index.html 的 <script>──▶ dist/index.html
//            ──zlib.deflateRaw(level 9) + 自研 ZIP writer──▶ dist/game.zip
//
// 产出后打印字节报表，并做两道硬校验：
//   1) js13k 合规扫描（禁止外部资源引用 / 禁止 localStorage.clear）
//   2) ZIP 体积门禁：> 12,800 B 直接 exit(1)（官方上限 13,312 B，留 512 B 缓冲）
//
// 用法：
//   node build.mjs            # 完整流水线（Roadroller optimize level 2）
//   node build.mjs --fast     # 跳过 Roadroller，只 terser + deflate（迭代用）
//   node build.mjs --level=1  # Roadroller 快速档
//   node build.mjs --raw      # 同时保留未打包的可读 dist/game.debug.html
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { minify } from 'terser';
import { Packer } from 'roadroller';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const LIMIT = 12800;        // 内部硬门禁
const OFFICIAL = 13312;     // js13kGames 官方上限

const argv = process.argv.slice(2);
const FAST = argv.includes('--fast');
const RAW = argv.includes('--raw');
const LEVEL = (() => {
  const a = argv.find((s) => s.startsWith('--level='));
  return a ? Number(a.slice(8)) : 2;
})();

const B = (n) => n.toLocaleString('en-US');
const kb = (n) => (n / 1024).toFixed(2) + ' KiB';
const line = (label, value, note) =>
  console.log('  ' + label.padEnd(26, ' ') + String(value).padStart(10, ' ') + (note ? '   ' + note : ''));

// ------------------------------------------------------------
// ZIP writer（local file header + data + central directory + EOCD）
// ------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    // DOS 纪年从 1980 起
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * 打一个最小合法 ZIP。
 * @param {{name:string,data:Buffer}[]} files
 * @returns {Buffer}
 */
function makeZip(files) {
  const { time, date } = dosTime(new Date());
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const comp = zlib.deflateRawSync(f.data, { level: 9 });
    const crc = crc32(f.data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);        // local file header 签名
    lh.writeUInt16LE(20, 4);                // 解包所需版本
    lh.writeUInt16LE(0x0800, 6);            // flag: 文件名为 UTF-8
    lh.writeUInt16LE(8, 8);                 // method: deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);                // extra 长度
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);        // central directory 签名
    ch.writeUInt16LE(20, 4);                // version made by
    ch.writeUInt16LE(20, 6);                // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);                // extra
    ch.writeUInt16LE(0, 32);                // comment
    ch.writeUInt16LE(0, 34);                // disk number
    ch.writeUInt16LE(0, 36);                // internal attrs
    ch.writeUInt32LE(0, 38);                // external attrs
    ch.writeUInt32LE(offset, 42);           // 对应 local header 偏移
    centrals.push(ch, name);

    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);         // EOCD 签名
  end.writeUInt16LE(0, 4);                  // 本盘号
  end.writeUInt16LE(0, 6);                  // 中央目录所在盘号
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

// ------------------------------------------------------------
// 流水线
// ------------------------------------------------------------

console.log('\n=== Rainbowhoof · js13kGames 2026 build ===\n');
const t0 = Date.now();

// 1) 源码体积清单
const srcFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) srcFiles.push(p);
  }
})(SRC);
// 模板入包前先去掉注释（中文注释在 UTF-8 下 3 字节/字，且压缩率差）
const tplPath = path.join(ROOT, 'index.html');
const tpl = prepTemplate(fs.readFileSync(tplPath, 'utf8'));
let srcTotal = Buffer.byteLength(tpl);
console.log('  source modules:');
for (const f of srcFiles.sort()) {
  const n = fs.statSync(f).size;
  srcTotal += n;
  console.log('    ' + path.relative(ROOT, f).padEnd(28, ' ') + B(n).padStart(8, ' ') + ' B');
}
console.log('    ' + 'index.html (template)'.padEnd(28, ' ') + B(Buffer.byteLength(tpl)).padStart(8, ' ') + ' B');
line('源码合计', B(srcTotal) + ' B');
console.log('');

// 2) esbuild：ESM → IIFE 单文件（不压缩，便于看报表与排错）
const esb = await build({
  entryPoints: [path.join(SRC, 'main.js')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  platform: 'browser',
  write: false,
  minify: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});
const bundled = esb.outputFiles[0].text;
line('esbuild bundle', B(Buffer.byteLength(bundled)) + ' B', '(IIFE, 未压缩)');
// 逐模块入包字节（含注释，仅供定位大头；terser 会剔掉注释）
const outKey = Object.keys(esb.metafile.outputs)[0];
const perInput = esb.metafile.outputs[outKey].inputs;
console.log('  bundle breakdown:');
for (const [k, v] of Object.entries(perInput).sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)) {
  console.log('    ' + k.replace(/\\/g, '/').padEnd(28, ' ') + B(v.bytesInOutput).padStart(8, ' ') + ' B');
}

// 3) Terser：真正的压缩
const terserOut = await minify(bundled, {
  ecma: 2020,
  module: false,
  toplevel: true,
  compress: {
    passes: 3,
    unsafe: true,
    unsafe_arrows: true,
    unsafe_math: true,
    unsafe_Function: true,
    pure_getters: true,
    booleans_as_integers: true,
    hoist_funs: true,
    toplevel: true,
    ecma: 2020,
  },
  mangle: { toplevel: true, safari10: false },
  format: { comments: false, ascii_only: true, ecma: 2020 },
});
if (terserOut.error) throw terserOut.error;
const minJs = terserOut.code;
line('terser', B(Buffer.byteLength(minJs)) + ' B',
  `(${((Buffer.byteLength(minJs) / Buffer.byteLength(bundled)) * 100).toFixed(1)}% of bundle)`);

// 4) Roadroller：熵编码二次压缩
let finalJs = minJs;
let usedRoadroller = false;
if (!FAST) {
  const packer = new Packer([{ action: 'eval', type: 'js', data: minJs }], {
    numThreads: Math.max(1, (process.availableParallelism?.() || 4) - 1),
    inputEnd: 'both',
  });
  await packer.optimize(LEVEL);
  // roadroller 2.1 API：make() 已更名 makeDecoder()
  const { firstLine, secondLine } = packer.makeDecoder();
  const packed = firstLine + '\n' + secondLine;
  line('roadroller (L' + LEVEL + ')', B(Buffer.byteLength(packed)) + ' B',
    `(${((Buffer.byteLength(packed) / Buffer.byteLength(minJs)) * 100).toFixed(1)}% of terser)`);
  // 只在真的更小时才用（Roadroller 输出熵极高，deflate 帮不上忙，
  // 而纯 terser + deflate 有时反而更小 —— 两条路都算，取最优）
  const zipPacked = makeZip([{ name: 'index.html', data: Buffer.from(inline(tpl, packed), 'utf8') }]).length;
  const zipPlain = makeZip([{ name: 'index.html', data: Buffer.from(inline(tpl, minJs), 'utf8') }]).length;
  usedRoadroller = zipPacked <= zipPlain;
  finalJs = usedRoadroller ? packed : minJs;
  line('  取舍', usedRoadroller ? 'roadroller' : 'terser(deflate 更小)',
    `roadroller ZIP ${B(zipPacked)} B vs 纯 terser ZIP ${B(zipPlain)} B`);
} else {
  line('roadroller', 'skipped', '(--fast)');
}

// 5) 内联进 index.html
const html = inline(tpl, finalJs);
line('dist/index.html', B(Buffer.byteLength(html)) + ' B',
  usedRoadroller ? '(roadroller)' : '(terser)');

// 6) js13k 合规扫描
console.log('\n  compliance scan:');
const bad = scan(html);
for (const b of bad) console.log('    ✗ ' + b);
if (!bad.length) console.log('    ✓ 无外部资源引用 / 无 localStorage.clear / 纯 ASCII 脚本体');

// 7) 写盘 + 打 ZIP
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), html);
if (RAW) {
  fs.writeFileSync(path.join(DIST, 'game.debug.html'), inline(tpl, bundled.replace(/<\/script/gi, '<\\/script')));
  fs.writeFileSync(path.join(DIST, 'game.min.js'), minJs);
}
const zip = makeZip([{ name: 'index.html', data: Buffer.from(html, 'utf8') }]);
const zipPath = path.join(DIST, 'game.zip');
fs.writeFileSync(zipPath, zip);

// 8) 报表 + 门禁
const ratio = ((zip.length / Buffer.byteLength(html)) * 100).toFixed(1);
console.log('');
line('dist/game.zip', B(zip.length) + ' B', `${kb(zip.length)} · deflate 率 ${ratio}%`);
console.log('');
if (bad.length) {
  console.error('✗ 合规扫描未通过，禁止产出。');
  process.exit(1);
}
if (zip.length > LIMIT) {
  console.error(`✗ 体积门禁失败：${B(zip.length)} B > ${B(LIMIT)} B（超出 ${B(zip.length - LIMIT)} B）`);
  process.exit(1);
}
console.log(`✓ 体积门禁通过：${B(zip.length)} B ≤ ${B(LIMIT)} B`);
console.log(`  距内部门禁余量 ${B(LIMIT - zip.length)} B · 距官方上限 ${B(OFFICIAL)} B 余量 ${B(OFFICIAL - zip.length)} B`);
console.log(`✓ 产出 ${path.relative(ROOT, zipPath)} （解压即玩，顶层仅 index.html）`);
console.log(`\n=== 构建完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s ===\n`);

// ------------------------------------------------------------
// 辅助
// ------------------------------------------------------------

/** 模板预处理：去 HTML / CSS 注释（不动任何实际样式值） */
function prepTemplate(t) {
  return t
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
      (m, a, css, b) => a + css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s+/gm, '') + b);
}

/** 把脚本内联进模板（用函数替换，避免 $& 等被当成替换模式） */
function inline(template, code) {
  const safe = code.replace(/<\/script/gi, '<\\/script');
  const re = /[ \t]*<script[^>]*src=["'][^"']*main\.js["'][^>]*><\/script>/;
  if (!re.test(template)) throw new Error('index.html 里找不到 src/main.js 的 <script> 引用');
  return template.replace(re, () => `<script>${safe}</script>`);
}

/** js13k 合规扫描：外部资源 / 危险 API / 非 ASCII */
function scan(html) {
  const out = [];
  // 剥掉内联 SVG 的 xmlns（那是命名空间标识符，不会发起网络请求）
  const probe = html.replace(/xmlns=['"]http:\/\/www\.w3\.org\/[^'"]*['"]/g, '');
  const net = probe.match(/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  for (const n of new Set(net)) out.push(`外部 URL 引用：${n}`);
  for (const m of probe.matchAll(/<(script|link|img|audio|video|iframe|source)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const tag = m[0];
    // 取出 src/href 的完整值再判定（避开正则可选引号回溯导致的误报）
    const am = tag.match(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const url = am ? (am[1] ?? am[2] ?? am[3] ?? '') : '';
    if (url && !/^(data:|#|about:blank|blob:)/i.test(url)) out.push(`外部资源标签：${tag.slice(0, 90)}`);
  }
  if (/@import|url\(\s*["']?(?!data:)/i.test(probe)) out.push('CSS 中存在外部 url() 或 @import');
  if (/localStorage\s*\.\s*clear\s*\(/.test(html)) out.push('使用了被禁止的 localStorage.clear()');
  if (/(document|window)\s*\.\s*(cookie)/.test(html)) out.push('使用了 document.cookie');
  // 脚本体只允许单字节字符：ASCII 可打印 + 换行/制表 + 控制字符
  // （Roadroller 打包流合法使用 \x00-\x1f，均为 UTF-8 单字节；
  //   真正要拦的是 >0x7e 的多字节字符，如中文）
  const script = (html.match(/<script>([\s\S]*)<\/script>/) || [, ''])[1];
  const nonAscii = script.replace(/[\x00-\x7e]/g, '');
  if (nonAscii.length) {
    const idx = script.search(/[^\x00-\x7e]/);
    out.push(`脚本体含多字节字符（首个位于偏移 ${idx}：${JSON.stringify(script[idx])}）`);
  }
  return out;
}
