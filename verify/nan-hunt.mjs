// ============================================================
// nan-hunt.mjs —— NaN 中毒根因追踪
// 复现 bot 长跑，页面内 watchdog 每 50ms 检查关键数值的有限性，
// 首次出现 NaN 时转存最近 40 帧状态环形缓冲 + 当帧上下文。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const WATCHDOG = `
window.__nan = { caught: null };
(() => {
  const ring = [];
  const t0 = performance.now();
  const STEP = 26, LOOK = 16;
  let lastBridgeX = -1e9;
  __rb.start();
  const snap = (tag) => {
    const s = __rb.stats();
    const U = __rb.U, W = __rb.W, RB = __rb.RB;
    const arcs = RB.arcs.map(a => ({
      n: a.p.length / 2, len: a.len.toFixed(0), age: a.age.toFixed(1),
      x0: a.x0.toFixed(0), x1: a.x1.toFixed(0), y0: a.y0.toFixed(0), y1: a.y1.toFixed(0),
      pFinite: a.p.every(Number.isFinite), cumFinite: a.cum.every(Number.isFinite),
      ageFinite: Number.isFinite(a.age), lenFinite: Number.isFinite(a.len),
    }));
    return { tag, t: +(performance.now() - t0).toFixed(0), mode: s.mode,
      x: U.x, y: U.y, vx: U.vx, vy: U.vy, speed: U.speed, surf: U.surf,
      arcD: U.arcD, combo: U.combo, air: U.air,
      camX: W.cam.x, camY: W.cam.y, dist: W.dist, ink: RB.ink,
      curArc: !!U.arc, arcs };
  };
  const check = (tag) => {
    const s = snap(tag);
    ring.push(s); if (ring.length > 40) ring.shift();
    const bad = ['x','y','vx','vy','speed','arcD','camX','camY','dist','ink'].filter(k => !Number.isFinite(s[k]));
    const arcBad = s.arcs.filter(a => !a.pFinite || !a.cumFinite || !a.ageFinite || !a.lenFinite);
    if ((bad.length || arcBad.length) && !__nan.caught) {
      __nan.caught = { badKeys: bad, badArcs: arcBad, ring: ring.slice() };
    }
    return !bad.length && !arcBad.length;
  };
  check('start');
  const timer = setInterval(() => {
    if (__nan.caught) { clearInterval(timer); return; }
    const s = __rb.stats();
    if (s.mode === 'gameover') { check('gameover'); return; }
    const W = __rb.W, U = __rb.U;
    const c0 = Math.floor(U.x / STEP);
    let vStart = -1;
    for (let k = 2; k < LOOK; k++) {
      const y = W.ground.get(c0 + k);
      if (y !== undefined && y !== y) { vStart = c0 + k; break; }
    }
    if (vStart >= 0) {
      let vEnd = vStart;
      while (vEnd - vStart < 14) {
        const y = W.ground.get(vEnd + 1);
        if (y === undefined || y !== y) vEnd++; else break;
      }
      const after = W.ground.get(vEnd + 1);
      if (after !== undefined && after === after) {
        const eg = W.ground.get(vStart - 1);
        const edgeY = eg !== undefined && eg === eg ? eg : after;
        const x0 = (vStart - 1) * STEP, x1 = (vEnd + 2) * STEP;
        const span = x1 - x0;
        if (!(U.x < x0 - 260 || x1 < lastBridgeX) && __rb.RB.ink >= span * 0.22 + 6) {
          __rb.paint(x0, edgeY - 14, x1, Math.min(edgeY, after) - 18, 16);
          lastBridgeX = x1;
        }
      }
    }
    check('tick');
  }, 66);
  setTimeout(() => { clearInterval(timer); if (!__nan.caught) __nan.caught = { badKeys: [], badArcs: [], ring: ring.slice(), timeout: true }; }, 240000);
})();
`;

const { srv, url } = await serve(path.join(ROOT, 'dist'));
const browser = await chromium.launch();
try {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__rb, null, { timeout: 15000 });
    await page.evaluate(WATCHDOG);
    const done = await page.waitForFunction(() => window.__nan && window.__nan.caught, null, { timeout: 260000 }).then(() => true).catch(() => false);
    if (done) {
      const r = await page.evaluate(() => window.__nan.caught);
      if (r.timeout) { console.log(`尝试 ${attempt}: 240s 未复现（本次无 NaN）`); await page.close(); continue; }
      console.log(`尝试 ${attempt}: 抓到了！badKeys=${r.badKeys} badArcs=${JSON.stringify(r.badArcs)}`);
      console.log('\n=== 最后 12 帧回放（tag/t/mode/x/y/vy/speed/surf/arcD/air/camY/dist/arcs）===');
      for (const f of r.ring.slice(-12)) {
        console.log(`  ${f.tag} t=${f.t} ${f.mode} x=${f.x?.toFixed?.(0) ?? f.x} y=${f.y?.toFixed?.(0) ?? f.y} vy=${f.vy?.toFixed?.(0) ?? f.vy} v=${f.speed?.toFixed?.(0) ?? f.speed} ${f.surf} arcD=${f.arcD?.toFixed?.(1) ?? f.arcD} air=${f.air?.toFixed?.(2) ?? f.air} camY=${f.camY?.toFixed?.(0) ?? f.camY} dist=${f.dist?.toFixed?.(0) ?? f.dist} arcs=${f.arcs.length}${f.curArc ? '*' : ''}`);
      }
      const lastArcs = r.ring[r.ring.length - 1].arcs;
      console.log('\n=== 中毒时弧线状态 ===');
      for (const a of lastArcs) console.log('  ' + JSON.stringify(a));
      fs.writeFileSync(path.join(ROOT, 'verify', 'nan-caught.json'), JSON.stringify(r, null, 2));
      console.log('\n完整环形缓冲已存 verify/nan-caught.json');
      await page.close();
      break;
    }
    await page.close();
  }
} finally { await browser.close(); srv.close(); }
