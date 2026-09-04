// ============================================================
// verify.mjs —— Rainbowhoof 自动化验证流水线
//
// 方法论沿用 thunder-racing-v2：状态驱动等待（waitForFunction，
// 不用固定 sleep）、四通道错误捕获（console/pageerror/requestfailed/
// HTTP>=400）、截图归档、退出码反映成败。
//
// 验证对象：dist/index.html（Roadroller 打包产物，即提交物本体）
// 以及 dist/game.zip 解包后的独立副本（提交物回测）。
//
// 用法：
//   node verify/verify.mjs              # Chromium 全量 + Firefox 核心 + ZIP 回测
//   node verify/verify.mjs --fast       # 只跑 Chromium 核心（迭代用）
//   node verify/verify.mjs --keep       # 结束后不关浏览器（肉眼复查用）
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const SHOTS = path.join(ROOT, 'verify', 'shots');
const argv = process.argv.slice(2);
const FAST = argv.includes('--fast');
const KEEP = argv.includes('--keep');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('    ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? `（${detail}）` : '')); console.log('    ✗ ' + name + (detail ? ` —— ${detail}` : '')); }
}
const sec = (s) => console.log('\n  —— ' + s + ' ——');

// ------------------------------------------------------------
// 极简静态文件服务器（零依赖，随机端口）
// ------------------------------------------------------------
function serve(root) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
    fs.readFile(p, (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(d);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}

/** 打开游戏页面，挂好四通道错误捕获 */
async function open(browser, url, shot) {
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));
  page.on('response', (r) => { if (r.status() >= 400) errors.push('HTTP ' + r.status() + ': ' + r.url()); });
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__rb && typeof window.__rb.stats === 'function', null, { timeout: 15000 });
  if (shot) await page.screenshot({ path: path.join(SHOTS, shot) });
  return { page, errors };
}

const stats = (page) => page.evaluate(() => __rb.stats());
/** 状态驱动等待：谓词以 __rb.stats() 为入参，在浏览器内反复求值 */
const waitSt = (page, pred, timeout = 8000) =>
  page.waitForFunction(
    (src) => { try { return (eval(src))(__rb.stats()); } catch { return false; } },
    `(${pred.toString()})`, { timeout, polling: 100 },
  ).catch(() => null);

/** 在独角兽前方找一段起伏 <18px 的平地，返回 {x0, x1, y}（世界坐标） */
const flatSpot = (page) => page.evaluate(() => {
  const W = __rb.W, U = __rb.U, s = __rb.stats();
  const STEP = 26, from = Math.floor((U.x + 60) / STEP), cols = 20;
  for (let c = from; c < from + 60; c++) {
    let ok = true, y0 = W.ground.get(c);
    if (y0 === undefined || y0 !== y0) continue;
    for (let k = 1; k < cols; k++) {
      const y = W.ground.get(c + k);
      if (y === undefined || y !== y || Math.abs(y - y0) > 18) { ok = false; break; }
    }
    if (ok) return { x0: c * STEP, x1: (c + cols) * STEP, y: y0 };
  }
  return null;
});

// ============================================================
// 核心断言组（Chromium 全量跑；Firefox 跑同一组）
// ============================================================
async function coreSuite(label, url, browserName, full) {
  console.log(`\n╔══ ${label}（${browserName}）`);
  const browser = browserName === 'firefox'
    ? await firefox.launch()
    : await chromium.launch();
  try {
    const { page, errors } = await open(browser, url, browserName + '-01-title.png');
    const uniqErr = () => [...new Set(errors)];

    sec('§1 启动 / 标题模式');
    let st = await stats(page);
    ok(st.mode === 'title', '初始状态为 title', 'got ' + st.mode);
    ok(uniqErr().length === 0, '启动零错误', uniqErr()[0]);
    const x0 = st.x;
    await waitSt(page, (s) => s.x > x0 + 60, 5000);
    st = await stats(page);
    ok(st.x > x0 + 60, '展示模式独角兽自动奔跑', `x ${x0.toFixed(0)}→${st.x.toFixed(0)}`);
    ok(st.fps > 30, '标题页帧率 >30', st.fps.toFixed(1) + ' fps');

    sec('§2 开始游戏 / 计分');
    await page.evaluate(() => __rb.start());
    st = await stats(page);
    ok(st.mode === 'play', '__rb.start() 进入 play', 'got ' + st.mode);
    await waitSt(page, (s) => s.score > 10, 8000);
    st = await stats(page);
    ok(st.score > 10, '距离驱动计分增长', 'score=' + st.score.toFixed(1));
    ok(st.dist > 80, '世界距离推进', 'dist=' + (st.dist / 10).toFixed(0) + 'm');

    sec('§3 画彩虹（确定性场景：直接铺平前方地形）');
    const patch3 = await page.evaluate(() => {
      const U = __rb.U, W = __rb.W, s = __rb.stats();
      if (s.mode !== 'play') __rb.start();
      // 取独角兽当前脚下高度，把前方 27 列（702px）全部铺平。
      // 这些列均已生成，genTo 游标已越过，不会被再覆盖 —— 场景完全确定。
      const c0 = Math.floor(U.x / 26) + 3;
      const gy = W.ground.get(Math.floor(U.x / 26)) ?? 470;
      for (let k = 0; k < 27; k++) W.ground.set(c0 + k, gy);
      // 清掉区间内的尖刺与星尘，排除干扰
      W.spikes = W.spikes.filter((sp) => sp.x < c0 * 26 || sp.x > (c0 + 27) * 26);
      W.dust = W.dust.filter((d) => d.x < c0 * 26 || d.x > (c0 + 27) * 26);
      __rb.ink(100);
      return { x0: c0 * 26, x1: (c0 + 17) * 26, y: gy };   // 弧 442px，墨预算内
    });
    const arc3 = await page.evaluate((a) => __rb.paint(a.x0, a.y - 18, a.x1, a.y - 30, 20), patch3);
    st = await stats(page);
    ok(st.arcs >= 1, '生成一条弧并入队', 'arcs=' + st.arcs);
    ok(st.ink < 100, '画弧消耗墨量', `100→${st.ink.toFixed(1)}`);
    // 独角兽跑到弧起点会踏上（STEPUP 路径；弧 ~440px @300px/s ≈ 1.5s 可乘窗口）
    const rode = await waitSt(page, (s) => s.surf === 'rainbow', 10000);
    ok(!!rode, '独角兽踏上彩虹（surf=rainbow）', 'surf=' + (await stats(page)).surf);

    sec('§4 墨系统');
    st = await stats(page);
    ok(st.ink <= 100.01, '墨量上限钳制', st.ink.toFixed(1));
    await page.evaluate(() => __rb.ink(30));               // 钉在半墨，避开满墨钳制
    st = await stats(page);
    const inkA = st.ink;
    await page.waitForTimeout(1300);                       // INK_REGEN=5/s → +6.5
    st = await stats(page);
    ok(st.ink > inkA + 3, '墨随时间回复', `${inkA.toFixed(1)}→${st.ink.toFixed(1)}`);
    await page.evaluate(() => __rb.ink(0));
    const drew = await page.evaluate(() => {
      const s = __rb.stats();
      return __rb.paint(s.x + 40, s.y - 30, s.x + 80, s.y - 40, 4); // 墨为 0，应画不出
    });
    ok(drew === null, '墨尽时拒绝起笔');

    sec('§5 星尘拾取（回墨 + 计分）');
    const starDone = await page.evaluate(() => {
      const s = __rb.stats();
      if (s.mode !== 'play') __rb.start();
      __rb.ink(0);
      const W = __rb.W, U = __rb.U;
      W.dust.push({ x: U.x + 16, y: U.y - 22, ph: 0, taken: false });  // 嘴边一颗
      return true;
    });
    ok(starDone, '注入合成星尘');
    const beforeStar = await stats(page);
    const starHit = await waitSt(page, (s) => s.ink >= 19, 5000);      // 0 → ≥20 即拾取成功
    st = await stats(page);
    ok(!!starHit, '拾取星尘回墨（0→+20）', `ink=${st.ink.toFixed(1)}`);

    sec('§6 空中接弧 = 连段（fromAir 路径）');
    const comboSetup = await page.evaluate(() => {
      const U = __rb.U, W = __rb.W, s = __rb.stats();
      if (s.mode !== 'play') return 'not-playing';
      // 前方找第一段实地（跳过虚空列），在其上空画水平弧
      const c0 = Math.floor(U.x / 26);
      let c = c0;
      for (let k = 0; k < 40; k++) {
        const y = W.ground.get(c0 + k);
        if (y !== undefined && y === y) { c = c0 + k; break; }
      }
      const gy = W.ground.get(c);
      if (gy === undefined || gy !== gy) return 'no-ground';
      const arcY = gy - 150;
      __rb.ink(100);
      const a = __rb.paint((c + 1) * 26, arcY, (c + 17) * 26, arcY, 16);   // 416px，墨预算内
      if (!a) return 'no-arc';
      U.surf = 'air'; U.arc = null;
      U.x = (c + 6) * 26; U.y = arcY - 110; U.vy = 60; U.vx = 300;
      return 'ok';
    });
    ok(comboSetup === 'ok', '布置空中接弧场景', comboSetup);
    const comboed = await waitSt(page, (s) => s.combo >= 1, 8000);
    st = await stats(page);
    ok(!!comboed, '空中落上弧计连段', 'combo=' + st.combo + ' surf=' + st.surf);
    await page.screenshot({ path: path.join(SHOTS, browserName + '-02-play.png') });

    if (full) {
      sec('§7 真实指针输入（屏幕坐标 → 世界坐标换算）');
      await page.evaluate(() => __rb.start());             // 重置到干净局面
      st = await stats(page);
      // 屏幕中心偏左下按下，拖到偏右上 —— 覆盖独角兽前方
      await page.mouse.move(280, 380);
      await page.mouse.down();
      await page.mouse.move(520, 260, { steps: 12 });
      await page.mouse.up();
      st = await stats(page);
      ok(st.arcs >= 1, '鼠标拖拽画出弧（输入管线完好）', 'arcs=' + st.arcs);

      sec('§8 撞尖刺死亡（合成尖刺）');
      await page.evaluate(() => {
        const W = __rb.W, U = __rb.U;
        W.spikes.push({ x: U.x + 60, y: U.y });            // 脚下正前方一根
        U.x += 44;                                          // 推进到刺的判定圈内
      });
      const spiked = await waitSt(page, (s) => s.mode === 'gameover', 5000);
      st = await stats(page);
      ok(!!spiked, '尖刺致死进入 gameover', 'mode=' + st.mode);
      ok(await page.evaluate(() => __rb.G.reason) === 'spike', '死因标记 spike');
      await page.screenshot({ path: path.join(SHOTS, browserName + '-03-gameover.png') });

      sec('§9 重开 & 最高分持久化');
      await page.waitForTimeout(700);                       // overT>0.55 防误触窗口
      await page.keyboard.press('Space');
      st = await stats(page);
      ok(st.mode === 'play', '结算后空格重开', 'mode=' + st.mode);
      const best = await page.evaluate(() => __rb.G.best);
      ok(best >= 0, 'best 已持久化', 'best=' + best.toFixed(0));
      const stored = await page.evaluate(() => localStorage.getItem('rainbowhoof_best_v1'));
      ok(stored !== null && Number(stored) === Math.floor(best), 'localStorage 与内存一致', 'stored=' + stored);

      sec('§10 坠落虚空死亡（自然路径）');
      await page.evaluate(() => {
        const U = __rb.U, W = __rb.W;
        // 在前方挖 12 列虚空（312px），独角兽会自然跑进去坠落
        const c0 = Math.floor(U.x / 26) + 2;
        const gy = W.ground.get(c0) ?? 470;
        for (let k = 0; k < 12; k++) W.ground.set(c0 + k, NaN);
        W.spikes = W.spikes.filter((sp) => sp.x < c0 * 26 || sp.x > (c0 + 12) * 26);
        W.dust = W.dust.filter((d) => d.x < c0 * 26 || d.x > (c0 + 12) * 26);
        U.y = gy; U.vy = 0; U.vx = 260; U.surf = 'dirt'; U.arc = null;
      });
      const fell = await waitSt(page, (s) => s.mode === 'gameover', 12000);
      st = await stats(page);
      ok(!!fell, '坠入虚空判定 gameover', 'mode=' + st.mode);
      ok(await page.evaluate(() => __rb.G.reason) === 'void', '死因标记 void');

      sec('§11 静音键 / 重开键');
      await page.waitForTimeout(700);
      await page.keyboard.press('KeyM');
      st = await stats(page);
      ok(st.muted === true, 'M 键静音', 'muted=' + st.muted);
      await page.keyboard.press('KeyM');
      st = await stats(page);
      ok(st.muted === false, 'M 键取消静音');
      await page.keyboard.press('KeyR');
      st = await stats(page);
      ok(st.mode === 'play', 'R 键随时重开');
    }

    sec('§12 帧率与健康度收口');
    await page.waitForTimeout(1500);
    st = await stats(page);
    ok(st.fps > 40, '游戏内帧率 >40', st.fps.toFixed(1) + ' fps');
    ok(st.ground > 10, '地形列正常生成', 'cols=' + st.ground);
    ok(uniqErr().length === 0, '全程零错误', uniqErr().slice(0, 2).join(' | '));

    if (!KEEP) await page.close();
  } finally {
    if (!KEEP) await browser.close();
  }
  console.log(`╚══ ${label} 完成`);
}

// ============================================================
// ZIP 提交物回测：解包 → 独立目录 → 启动
// ============================================================
async function zipSuite() {
  console.log('\n╔══ ZIP 提交物回测');
  const zipPath = path.join(DIST, 'game.zip');
  ok(fs.existsSync(zipPath), 'dist/game.zip 存在');
  const size = fs.statSync(zipPath).size;
  ok(size > 0 && size <= 13312, `体积合规（${size} B ≤ 13312 B）`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-zip-'));
  execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmp}' -Force"`, { stdio: 'ignore' });
  const entries = fs.readdirSync(tmp);
  ok(entries.includes('index.html'), 'ZIP 顶层含 index.html', 'entries: ' + entries.join(','));
  ok(entries.length === 1, 'ZIP 顶层仅一个文件', 'entries: ' + entries.length);

  const { srv, url } = await serve(tmp);
  try {
    await coreSuite('解包副本', url, 'zip-chromium', false);
  } finally { srv.close(); }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('╚══ ZIP 回测完成');
}

// ============================================================
// 入口
// ============================================================
fs.mkdirSync(SHOTS, { recursive: true });
console.log('=== Rainbowhoof verify ===');

const { srv: distSrv, url: distUrl } = await serve(DIST);
try {
  await coreSuite('打包产物', distUrl, 'chromium', !FAST);
  if (!FAST) await zipSuite();
  if (!FAST) {
    // Firefox 用同一份产物跑核心组（js13k 硬性要求：双浏览器零报错）
    await coreSuite('打包产物', distUrl, 'firefox', true);
  } else {
    console.log('\n  (--fast：跳过 ZIP 回测与 Firefox)');
  }
} finally { distSrv.close(); }

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');
