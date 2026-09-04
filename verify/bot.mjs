// ============================================================
// bot.mjs —— 机器人长跑测试：难度曲线 / 死亡分布 / 墨经济数据采集
//
// 策略：以 ~15Hz 读取 __rb 状态，发现前方虚空（NaN 列）时
// 从断崖边画一条桥（略上拱），有墨就画。其余时间不管。
// 这模拟一个"只会基础操作"的普通玩家。
//
// 用法：node verify/bot.mjs [局数=12] [并行=4]
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const N_RUNS = Number(process.argv[2] || 12);
const PARALLEL = Number(process.argv[3] || 4);
const MAX_T = 180;                      // 单局硬超时（秒）

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

// 浏览器内常驻的机器人循环（setInterval 驱动，返回值写到 window.__bot）
const BOT_SRC = `
window.__bot = { done: false, result: null };
(() => {
  const t0 = performance.now();
  const STEP = 26, LOOK = 16;                 // 前望 16 列 ≈ 416px
  const log = { bridges: 0, starve: 0, maxCombo: 0 };
  let lastBridgeX = -1e9;
  __rb.start();
  const timer = setInterval(() => {
    const s = __rb.stats();
    log.maxCombo = Math.max(log.maxCombo, s.combo);
    if (s.mode === 'gameover') {
      clearInterval(timer);
      __bot.result = { ...s, reason: __rb.G.reason, t: (performance.now() - t0) / 1000, ...log };
      __bot.done = true;
      return;
    }
    if (s.mode !== 'play') return;
    const W = __rb.W, U = __rb.U;
    const c0 = Math.floor(U.x / STEP);
    // 扫前方：找第一段虚空
    let vStart = -1;
    for (let k = 2; k < LOOK; k++) {
      const y = W.ground.get(c0 + k);
      if (y !== undefined && y !== y) { vStart = c0 + k; break; }
    }
    if (vStart < 0) return;                          // 前方无虚空
    // 虚空末端
    let vEnd = vStart;
    while (vEnd - vStart < 14) {
      const y = W.ground.get(vEnd + 1);
      if (y === undefined || y !== y) vEnd++; else break;
    }
    const after = W.ground.get(vEnd + 1);
    if (after === undefined || after !== after) return;   // 末端未知（还没生成）→ 等一拍
    const eg = W.ground.get(vStart - 1);
    const edgeY = eg !== undefined && eg === eg ? eg : after;   // ?? 不拦 NaN，手动判
    const x0 = (vStart - 1) * STEP, x1 = (vEnd + 2) * STEP;
    const span = x1 - x0;
    // 已在桥起点附近才算"该画了"；避免重复画
    if (U.x < x0 - 260 || x1 < lastBridgeX) return;
    // 墨不够画整条：等回复（记录饥饿）
    if (__rb.RB.ink < span * 0.22 + 6) { log.starve++; return; }
    __rb.paint(x0, edgeY - 14, x1, Math.min(edgeY, after) - 18, 16);
    lastBridgeX = x1;
    log.bridges++;
  }, 66);
  // 硬超时：视为"通关存活"
  setTimeout(() => {
    if (__bot.done) return;
    clearInterval(timer);
    const s = __rb.stats();
    __bot.result = { ...s, reason: 'timeout-alive', t: (performance.now() - t0) / 1000, ...log };
    __bot.done = true;
  }, ${MAX_T} * 1000);
})();
`;

async function oneRun(browser, url, idx) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rb, null, { timeout: 15000 });
  await page.evaluate(BOT_SRC);
  await page.waitForFunction(() => window.__bot && window.__bot.done, null, { timeout: (MAX_T + 30) * 1000 });
  const r = await page.evaluate(() => window.__bot.result);
  await page.close();
  return { idx, ...r, distM: (r.dist / 10).toFixed(0), errors: errs };
}

const { srv, url } = await serve(DIST);
const browser = await chromium.launch();
const results = [];
console.log(`机器人长跑：${N_RUNS} 局，${PARALLEL} 并行\n`);
try {
  for (let i = 0; i < N_RUNS; i += PARALLEL) {
    const batch = [];
    for (let j = 0; j < PARALLEL && i + j < N_RUNS; j++) batch.push(oneRun(browser, url, i + j));
    const rs = await Promise.all(batch);
    results.push(...rs);
    for (const r of rs) {
      console.log(`  局${String(r.idx).padStart(2)} | ${String(r.distM).padStart(5)}m | ${r.t.toFixed(0).padStart(3)}s | ${r.reason.padEnd(12)} | 桥${String(r.bridges).padStart(3)} 最高连段${r.maxCombo} 饥饿${r.starve}${r.errors.length ? ' ⚠ ' + r.errors[0] : ''}`);
    }
  }
} finally { await browser.close(); srv.close(); }

// ---- 汇总 ----
const dists = results.map((r) => r.dist).sort((a, b) => a - b);
const med = dists[Math.floor(dists.length / 2)] / 10;
const q1 = dists[Math.floor(dists.length / 4)] / 10;
const q3 = dists[Math.floor(dists.length * 3 / 4)] / 10;
const reasons = {};
for (const r of results) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
const alive = results.filter((r) => r.reason === 'timeout-alive').length;
const errRuns = results.filter((r) => r.errors.length).length;

console.log('\n=== 汇总（基础策略机器人）===');
console.log(`  存活距离：中位 ${med.toFixed(0)}m（四分位 ${q1.toFixed(0)}–${q3.toFixed(0)}m，最远 ${(dists[dists.length - 1] / 10).toFixed(0)}m）`);
console.log(`  死因分布：${Object.entries(reasons).map(([k, v]) => k + '×' + v).join('，')}`);
console.log(`  180s 存活：${alive}/${results.length}`);
console.log(`  平均饥饿事件：${(results.reduce((s, r) => s + r.starve, 0) / results.length).toFixed(1)} 次/局`);
console.log(`  平均最高连段：${(results.reduce((s, r) => s + r.maxCombo, 0) / results.length).toFixed(1)}`);
console.log(`  运行时报错局数：${errRuns}/${results.length}${errRuns ? ' ⚠' : ' ✓'}`);
fs.mkdirSync(path.join(ROOT, 'verify', 'shots'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'verify', 'bot-results.json'), JSON.stringify(results, null, 2));
console.log('  明细已存 verify/bot-results.json');
