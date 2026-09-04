// ============================================================
// shots.mjs —— 生成 js13k 提交所需规格截图
//   160×160（方形头像图）与 400×250（预览图）
// 流程：高分屏抓 4× 母版帧 → 页面内 canvas 缩放到精确尺寸
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'verify', 'shots');

function serve(root) {
  const srv = http.createServer((req, res) => {
    fs.readFile(path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html'),
      (e, d) => {
        if (e) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(d);
      });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}

const { srv, url } = await serve(path.join(ROOT, 'dist'));
const browser = await chromium.launch();

// ---- 1) 抓 1600×1000 母版（4× of 400×250）----
const page = await browser.newPage({ viewport: { width: 400, height: 250 }, deviceScaleFactor: 4 });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__rb);
await page.waitForTimeout(800);
await page.evaluate(() => {
  __rb.start();
  __rb.G.score = 1234;      // HUD 展示值（仅截图用）
  // 铺平前方地形，画一条长弧，并把独角兽抬到弧上空制造接弧瞬间
  const U = __rb.U, W = __rb.W;
  const c0 = Math.floor(U.x / 26) + 2;
  const gy = W.ground.get(c0) ?? 470;
  for (let k = 0; k < 30; k++) W.ground.set(c0 + k, gy);
  W.spikes = W.spikes.filter((s) => s.x < c0 * 26 || s.x > (c0 + 30) * 26);
  __rb.ink(100);
  const arcY = gy - 110;
  __rb.paint((c0 + 2) * 26, arcY + 30, (c0 + 20) * 26, arcY, 18);
  U.surf = 'air'; U.arc = null; U.x = (c0 + 5) * 26; U.y = arcY - 80; U.vy = 150; U.vx = 330;
  U.combo = 3;   // HUD 显示 x3 倍率
});
// 等接上弧的瞬间
await page.waitForFunction(() => __rb.stats().surf === 'rainbow', null, { timeout: 6000 }).catch(() => {});
await page.waitForTimeout(250);   // 火花粒子铺开一拍
const master = await page.screenshot();
fs.writeFileSync(path.join(OUT, 'master-1600x1000.png'), master);
console.log('母版帧已抓取');

// ---- 2) 页面内缩放到精确尺寸 ----
const page2 = await browser.newPage();
await page2.setContent('<canvas id="a"></canvas><canvas id="b"></canvas>');
const b64 = master.toString('base64');
const files = await page2.evaluate(async (b64str) => {
  const bytes = Uint8Array.from(atob(b64str), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'image/png' });
  const img = await createImageBitmap(blob);
  const to = (id, w, h, sx, sy, sw, sh) => {
    const c = document.getElementById(id);
    c.width = w; c.height = h;
    c.getContext('2d').imageSmoothingQuality = 'high';
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  };
  // 400×250：整幅 4:2.5 等比缩放
  to('a', 400, 250, 0, 0, img.width, img.height, img.width, img.height);
  // 160×160：中央方形裁剪（偏上一点保住独角兽与标题）
  const side = img.height;                       // 1000
  const sx = (img.width - side) / 2;
  to('b', 160, 160, sx, 0, side, side);
  const out = {};
  for (const id of ['a', 'b']) {
    out[id] = await new Promise((r) => {
      document.getElementById(id).toBlob(async (b) => {
        r(new Uint8Array(await b.arrayBuffer()));
      }, 'image/png');
    });
  }
  return out;
}, b64);
fs.writeFileSync(path.join(OUT, 'shot-400x250.png'), Buffer.from(files.a));
fs.writeFileSync(path.join(OUT, 'shot-160x160.png'), Buffer.from(files.b));
console.log('shot-400x250.png:', files.a.length, 'bytes');
console.log('shot-160x160.png:', files.b.length, 'bytes');

await browser.close();
srv.close();
console.log('完成 → verify/shots/');
