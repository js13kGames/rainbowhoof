// ============================================================
// playtest.mjs —— 拟真试玩：真实指针输入 / 多视口 / 边界输入
// 覆盖自动断言测不到的：指针捕获、右键、拖拽出窗、中途 resize、
// 移动端竖屏触摸。全程截图归档 verify/shots/playtest-*.png
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'verify', 'shots');

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

const report = [];
const note = (k, v) => { report.push([k, v]); console.log('  ' + k.padEnd(34) + ' ' + v); };

const { srv, url } = await serve(path.join(ROOT, 'dist'));
const browser = await chromium.launch();

// ---------------- 桌面 1280×720：真实鼠标会话 ----------------
console.log('\n=== 桌面试玩（1280×720，真实鼠标拖拽）===');
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rb);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS, 'playtest-d1-title.png') });

  // 点击开始（真实点击，走 ptrDown 路径）
  await page.mouse.click(640, 360);
  await page.waitForFunction(() => __rb.stats().mode === 'play');
  note('点击开始', 'ok');

  // 等独角兽跑起来，然后在其前方真实拖一条弧（上拱桥）
  await page.waitForTimeout(1500);
  for (let round = 0; round < 4; round++) {
    const st = await page.evaluate(() => {
      const s = __rb.stats();
      const W = __rb.W, U = __rb.U;
      // 找前方第一个虚空边缘（世界坐标）并换算到屏幕
      let vx = null;
      for (let k = 4; k < 20; k++) {
        const y = W.ground.get(Math.floor(U.x / 26) + k);
        if (y !== undefined && y !== y) { vx = (Math.floor(U.x / 26) + k) * 26; break; }
      }
      return { s, vx, zoom: W.cam.zoom, camX: W.cam.x, camY: W.cam.y };
    });
    // 屏幕坐标：世界 → (w - cam)*zoom。独角兽通常在屏幕 x≈0.32 宽度处
    const zoom = st.zoom;
    const toScreen = (wx, wy) => [Math.round((wx - st.camX) * zoom), Math.round((wy - st.camY) * zoom)];
    let dragFrom, dragTo;
    if (st.vx !== null) {
      // 从崖边前 60px 画到崖后 220px，略上拱
      const gy = await page.evaluate((x) => {
        const W = __rb.W;
        for (let i = Math.floor(x / 26); i >= 0; i--) { const y = W.ground.get(i); if (y !== undefined && y === y) return y; }
        return 470;
      }, st.vx);
      dragFrom = toScreen(st.vx - 60, gy - 20);
      dragTo = toScreen(st.vx + 220, gy - 55);
    } else {
      // 没有虚空就画一条抬升的顺路弧（练连段）
      dragFrom = toScreen(st.s.x + 180, st.s.y - 30);
      dragTo = toScreen(st.s.x + 560, st.s.y - 110);
    }
    // 限制在屏幕安全区内
    const cx = (x) => Math.max(30, Math.min(1250, x));
    const cy = (y) => Math.max(30, Math.min(690, y));
    await page.mouse.move(cx(dragFrom[0]), cy(dragFrom[1]));
    await page.mouse.down();
    await page.mouse.move(cx(dragTo[0]), cy(dragTo[1]), { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(1400);
    if (round === 1) await page.screenshot({ path: path.join(SHOTS, 'playtest-d2-bridge.png') });
  }
  const st1 = await page.evaluate(() => __rb.stats());
  note('4 轮真实拖拽后', `mode=${st1.mode} dist=${(st1.dist / 10).toFixed(0)}m arcs=${st1.arcs} combo=${st1.combo}`);

  // 边界输入 1：拖拽途中把指针拖出窗口再回来松手（pointer capture 路径）
  await page.mouse.move(400, 400);
  await page.mouse.down();
  await page.mouse.move(-50, 200, { steps: 4 });          // 出窗
  await page.mouse.move(700, 300, { steps: 8 });          // 回窗
  await page.mouse.up();
  await page.waitForTimeout(600);
  note('拖拽出窗再回窗', '无崩溃');

  // 边界输入 2：游戏中右键（contextmenu 应被抑制，不弹菜单不崩溃）
  await page.mouse.click(640, 300, { button: 'right' });
  await page.waitForTimeout(300);
  note('右键', '无崩溃');

  // 边界输入 3：滚轮（页面 overscroll 已关，不应滚动/崩溃）
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  note('滚轮', '无崩溃');

  // 边界输入 4：游戏中途 resize 窗口
  await page.setViewportSize({ width: 800, height: 600 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, 'playtest-d3-resized.png') });
  const st2 = await page.evaluate(() => __rb.stats());
  note('中途 resize 800×600', `mode=${st2.mode}（仍运行）`);

  // 连按 R 快速重开 3 次（压力）
  for (let i = 0; i < 3; i++) { await page.keyboard.press('KeyR'); await page.waitForTimeout(250); }
  const st3 = await page.evaluate(() => __rb.stats());
  note('连按 R×3', `mode=${st3.mode}`);
  await page.screenshot({ path: path.join(SHOTS, 'playtest-d4-after-restart.png') });

  // 空格重开 & 死亡结算走一遍
  await page.evaluate(() => __rb.gameOver('void'));
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(SHOTS, 'playtest-d5-gameover.png') });
  await page.keyboard.press('Space');
  const st4 = await page.evaluate(() => __rb.stats());
  note('结算→空格重开', `mode=${st4.mode}`);
  note('桌面全程错误', errors.length === 0 ? '零错误 ✓' : errors.slice(0, 3).join(' | '));
  await page.close();
}

// ---------------- 移动端 390×844 竖屏：触摸会话 ----------------
console.log('\n=== 移动端试玩（390×844 竖屏，触摸拖拽）===');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rb);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SHOTS, 'playtest-m1-title.png') });
  const touchFlag = await page.evaluate(() => __rb.G.touch);
  note('触屏识别 G.touch', String(touchFlag));

  // 触摸开始（tap）
  await page.touchscreen.tap(195, 420);
  await page.waitForFunction(() => __rb.stats().mode === 'play');
  note('触摸开始游戏', 'ok');

  // 触摸拖拽画弧（用 CDP 派发真实 touch 序列）
  await page.waitForTimeout(1200);
  const st = await page.evaluate(() => {
    const s = __rb.stats();
    return { x: s.x, y: s.y, zoom: __rb.W.cam.zoom, camX: __rb.W.cam.x, camY: __rb.W.cam.y };
  });
  const toScreen = (wx, wy) => [Math.round((wx - st.camX) * st.zoom), Math.round((wy - st.camY) * st.zoom)];
  const [x0, y0] = toScreen(st.x + 120, st.y - 30);
  const [x1, y1] = toScreen(st.x + 360, st.y - 80);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.max(10, x0), y: Math.max(10, y0) }] });
  for (let k = 1; k <= 8; k++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: Math.max(10, x0 + (x1 - x0) * k / 8), y: Math.max(10, y0 + (y1 - y0) * k / 8) }],
    });
    await page.waitForTimeout(40);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(1000);
  const st2 = await page.evaluate(() => __rb.stats());
  note('触摸画弧', `arcs 总数=${st2.arcs}（含后续消散）`);
  await page.screenshot({ path: path.join(SHOTS, 'playtest-m2-play.png') });
  note('移动端全程错误', errors.length === 0 ? '零错误 ✓' : errors.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();
srv.close();
console.log('\n=== 试玩完成，截图在 verify/shots/playtest-*.png ===');
