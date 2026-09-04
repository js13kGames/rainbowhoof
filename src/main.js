// ============================================================
// main.js —— 入口：画布初始化、输入、状态机、游戏循环、计分
//
// 状态机：title → play → gameover → (点击/空格) → play
// title 状态下世界照常演进（"展示模式"：无断崖无尖刺），
// 于是标题页背后就是一只独角兽在黄昏丘陵上自己奔跑 —— 免费的 attract mode。
// ============================================================

import { max, min, floor, clamp, pow } from './lib.js';
import {
  W, reset as wReset, resize as wResize, update as wUpdate,
  collectDust, burst, deathY, wx, wy,
} from './world.js';
import {
  RB, reset as rReset, update as rUpdate, down as rDown, move as rMove,
  up as rUp, addInk, INK_MAX,
} from './rainbow.js';
import {
  U, reset as uReset, update as uUpdate, checkDeath, runSpeed, mult,
  EV, GRAV, HOOF_R,
} from './unicorn.js';
import { init as rInit, resize as rResize, draw, resetIntro } from './render.js';
import { play as sfx, unlock as audioUnlock, music, mute, AX } from './audio.js';

/** 最高分的本地存储键（js13k 允许读写 localStorage，但严禁 clear） */
const BEST_KEY = 'rainbowhoof_best_v1';

/** 全局游戏状态（也作为渲染层的唯一入参） */
export const G = {
  mode: 'title',        // 'title' | 'play' | 'gameover'
  t: 0, dt: 0,
  score: 0, best: 0,
  overT: 0,             // 结算面板已展示时长（用于重开防误触）
  comboT: -9,           // 上次连段提升时刻（UI 弹跳动画用）
  reason: '',           // 'void' | 'spike'
  touch: false,         // 是否触屏设备（提示文案分支）
  px: 0,                // 上一帧独角兽 x（算距离增量→分数）
  deadX: 0, deadY: 0,   // 死亡瞬间位置（结算时冻结摄像机）
  frame: 0, fps: 60,
};

let cv = null;

// ------------------------------------------------------------
// 存档
// ------------------------------------------------------------

function loadBest() {
  try {
    const v = localStorage.getItem(BEST_KEY);
    G.best = v ? max(0, Number(v) || 0) : 0;
  } catch (e) {
    G.best = 0;                              // 隐私模式等场景：静默降级
  }
}

function saveBest() {
  try { localStorage.setItem(BEST_KEY, String(floor(G.best))); } catch (e) { /* 忽略 */ }
}

// ------------------------------------------------------------
// 状态切换
// ------------------------------------------------------------

/** 开始新的一局 */
export function start() {
  G.mode = 'play';
  G.score = 0;
  G.overT = 0;
  G.reason = '';
  G.comboT = -9;
  wReset(false);
  rReset();
  uReset();
  G.px = U.x;
  G.deadX = U.x; G.deadY = U.y;
  audioUnlock();
  music(true);
  sfx('start');
}

/** 回到标题展示 */
export function toTitle() {
  G.mode = 'title';
  G.score = 0;
  G.overT = 0;
  wReset(true);
  rReset();
  uReset();
  G.px = U.x;
  music(false);
  resetIntro();
}

/** 死亡结算 */
export function gameOver(reason) {
  if (G.mode !== 'play') return;
  G.mode = 'gameover';
  G.overT = 0;
  G.reason = reason;
  U.alive = false;
  G.deadX = U.x; G.deadY = U.y;
  // 死亡抛飞：撞刺向后翻倒，坠落则保持惯性
  const spike = reason === 'spike';
  U.vx = spike ? -U.speed * 0.3 : U.vx * 0.45;
  U.vy = spike ? -430 : -40;
  U.spin = spike ? -9 : -2.4;
  U.surf = 'air';
  U.arc = null;
  burst('boom', U.x, U.y - 24, 28, 0, -90);
  sfx(spike ? 'spike' : 'fall');
  music(false);
  if (G.score > G.best) { G.best = G.score; saveBest(); }
}

// ------------------------------------------------------------
// 每帧逻辑
// ------------------------------------------------------------

function update(dt) {
  if (G.mode === 'play') {
    uUpdate(dt);
    rUpdate(dt);
    wUpdate(dt, U.x, U.y);

    // --- 计分：距离 × 连段倍率 ---
    const dx = U.x - G.px;
    G.px = U.x;
    if (dx > 0) G.score += dx * 0.1 * mult();

    // --- 星尘拾取 ---
    const got = collectDust(U.x, U.y - 22, HOOF_R + 8);
    for (let i = 0; i < got.length; i++) {
      const d = got[i];
      G.score += 50 * mult();
      addInk(20);
      burst('star', d.x, d.y, 12);
      sfx('star', 1 + min(0.55, U.combo * 0.07));
    }

    // --- 物理事件 → 音效反馈 ---
    const ev = U.ev;
    if (ev & EV.ARC) {
      G.comboT = G.t;
      // 连段越高音越亮：每级 +9%，封顶 12 级
      sfx('combo', pow(1.09, min(12, U.combo)));
    } else if (ev & EV.STEPUP) {
      sfx('land', 1, 0.05);
    }
    if (ev & EV.DIRT) sfx('thud', 1, 0.05);
    if (ev & EV.LAUNCH) sfx('jump', 1, 0.09);
    if (ev & EV.ARCLOST) sfx('cast', 0.8, 0.06);

    // --- 死亡 ---
    const dead = checkDeath();
    if (dead) gameOver(dead);
  } else if (G.mode === 'title') {
    // 展示模式：独角兽永远跑得下去（world 已关闭虚空与尖刺）
    uUpdate(dt);
    rUpdate(dt);
    wUpdate(dt, U.x, U.y);
    if (U.y > deathY()) {                    // 兜底：万一掉出去就捞回来
      U.y = W.cam.gy - 10; U.vy = 0; U.surf = 'air';
    }
  } else {
    // gameover：尸体做抛体翻滚，摄像机冻结在死亡点
    G.overT += dt;
    U.vy += GRAV * dt;
    U.x += U.vx * dt;
    U.y += U.vy * dt;
    U.rot += U.spin * dt;
    rUpdate(dt);
    wUpdate(dt, G.deadX, G.deadY);
  }
}

// ------------------------------------------------------------
// 输入
// ------------------------------------------------------------

function ptrDown(e) {
  G.touch = e.pointerType !== 'mouse';
  audioUnlock();
  if (G.mode === 'title') { start(); return; }
  if (G.mode === 'gameover') {
    if (G.overT > 0.55) start();
    return;
  }
  if (e.preventDefault) e.preventDefault();
  rDown(wx(e.clientX), wy(e.clientY));
  if (RB.cur) sfx('draw', 1, 0.12);
  else sfx('empty', 1, 0.3);
  if (cv.setPointerCapture && e.pointerId !== undefined) {
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  }
}

function ptrMove(e) {
  if (G.mode !== 'play' || !RB.drawing) return;
  if (rMove(wx(e.clientX), wy(e.clientY))) sfx('draw', 1, 0.09);
}

function ptrUp(e) {
  if (G.mode !== 'play' || !RB.drawing) return;
  const a = rUp();
  if (a) sfx('cast');
  if (e && e.pointerId !== undefined && cv.releasePointerCapture) {
    try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  }
}

function keyDown(e) {
  const c = e.code;
  if (c === 'Space' || c === 'Enter' || c === 'NumpadEnter') {
    e.preventDefault();
    if (G.mode === 'title') start();
    else if (G.mode === 'gameover' && G.overT > 0.55) start();
  } else if (c === 'KeyM') {
    AX.muted = !AX.muted;
    mute(AX.muted);
  } else if (c === 'KeyR' && G.mode !== 'title') {
    start();
  }
}

// ------------------------------------------------------------
// 画布 / 主循环
// ------------------------------------------------------------

function onResize() {
  const s = rResize();
  wResize(s.w, s.h);
}

let last = 0, fpsAcc = 0, fpsN = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (!last) last = now;
  // 切后台回来会有巨大 dt，夹住防止物理爆炸
  const dt = clamp((now - last) / 1000, 0, 0.05);
  last = now;
  G.dt = dt;
  G.t += dt;
  G.frame++;
  // 帧率滑动均值（每 0.5s 刷新一次，供调试/验证使用）
  fpsAcc += dt; fpsN++;
  if (fpsAcc >= 0.5) { G.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  update(dt);
  draw(G);
}

/** 启动 */
export function boot() {
  cv = document.getElementById('game');
  rInit(cv);
  onResize();
  loadBest();

  cv.addEventListener('pointerdown', ptrDown);
  window.addEventListener('pointermove', ptrMove, { passive: true });
  window.addEventListener('pointerup', ptrUp);
  window.addEventListener('pointercancel', ptrUp);
  window.addEventListener('keydown', keyDown);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  // 移动端长按会弹右键菜单/选中文本，一律掐掉
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  toTitle();
  requestAnimationFrame(frame);
}

// 脚本可能位于 <head>（构建产物内联时），因此等 DOM 就绪再启动
if (document.getElementById('game')) boot();
else window.addEventListener('DOMContentLoaded', boot);

// ------------------------------------------------------------
// 调试 / 自动化验证钩子
// 体积成本极低（约 80 字节），但让 verify.mjs 能做状态驱动断言，
// 而不是靠固定 sleep 猜测。发布版也保留（js13k 规则不禁止）。
// ------------------------------------------------------------
window.__rb = {
  G, U, W, RB, EV, INK_MAX,
  version: '0.1.0',
  start, toTitle, gameOver,
  runSpeed, mult, deathY,
  /** 供验证脚本在世界坐标下画一条彩虹 */
  paint(x0, y0, x1, y1, steps) {
    const n = max(2, steps || 24);
    rDown(x0, y0);
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      rMove(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k);
    }
    return rUp();
  },
  /** 直接注入彩虹墨（测试用） */
  ink: (v) => { RB.ink = clamp(v, 0, INK_MAX); },
  stats: () => ({
    mode: G.mode, score: G.score, best: G.best, dist: W.dist,
    combo: U.combo, bestCombo: U.best, surf: U.surf, speed: U.speed,
    x: U.x, y: U.y, ink: RB.ink, arcs: RB.arcs.length,
    dust: W.dust.length, spikes: W.spikes.length, fx: W.fx.length,
    ground: W.ground.size, fps: G.fps, frame: G.frame, muted: AX.muted,
  }),
};
