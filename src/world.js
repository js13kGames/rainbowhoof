// ============================================================
// world.js —— 程序化地形 / 星尘 / 尖刺 / 粒子 / 摄像机
//
// 世界坐标：x 向右为正，y 向下为正（与 Canvas 一致），单位 = px。
// 地形按"列"采样存储（每列 STEP px），列间线性插值 → 平滑丘陵。
// 虚空（断崖）列的 y 存为 NaN，groundAt() 遇到就返回 null。
// ============================================================

import {
  sin, cos, abs, max, min, floor, ceil, random, TAU,
  clamp, rng, rngi, damp,
} from './lib.js';

/** 地形采样步长（px）。越小越平滑，越大越省内存/查找 */
export const STEP = 26;
/** 基准地面高度（世界 y） */
export const BASE_Y = 470;
/** 地形允许起伏范围 */
const Y_MIN = BASE_Y - 220, Y_MAX = BASE_Y + 150;

/** 尖刺外观/判定尺寸 */
export const SPIKE_W = 22, SPIKE_H = 26;
/** 星尘拾取半径 */
export const DUST_R = 30;

export const W = {
  ground: new Map(),      // 列下标 → 地面 y（NaN = 虚空）
  genCol: 0,              // 下一个待生成列
  pruneCol: 0,            // 已清理到的列
  gy: BASE_Y,             // 生成游标：当前地面高度
  lastY: BASE_Y,          // 最近一处实地高度（虚空中放星尘时当参考）
  hillT: 0, hillAmp: 16, hillRate: 0.08,
  mode: 'solid', modeLeft: 0, voidDust: false,
  spikes: [], dust: [], fx: [],
  cam: { x: 0, y: 0, zoom: 1, w: 960, h: 600, gy: BASE_Y },
  dist: 0,                // 已前进距离（px），驱动难度与计分
  time: 0,
  startX: 120,            // 独角兽出生点世界 x
  attract: false,         // 标题展示模式：不生成虚空与尖刺，独角兽永远跑得下去
  nextDustX: 0,           // 下一颗星尘的世界 x
  nextSpikeX: 0,          // 下一根尖刺的世界 x
};

// ------------------------------------------------------------
// 初始化 / 视口
// ------------------------------------------------------------

/** 重开一局：清空所有程序化内容并铺好起跑段
 *  @param {boolean} attract 标题展示模式（无断崖、无尖刺）
 */
export function reset(attract) {
  W.attract = !!attract;
  W.ground.clear();
  W.spikes.length = 0;
  W.dust.length = 0;
  W.fx.length = 0;
  W.gy = W.lastY = W.cam.gy = BASE_Y;
  W.hillT = 0; W.hillAmp = 16; W.hillRate = 0.08;
  W.mode = 'solid'; W.modeLeft = 60; W.voidDust = false;  // 起跑给一段长平地（约 1km）
  W.dist = 0; W.time = 0;
  W.startX = 120;
  W.genCol = floor((W.startX - 620) / STEP);
  W.pruneCol = W.genCol;
  W.nextDustX = W.startX + 300;
  W.nextSpikeX = W.startX + 2400;   // 首刺延后：留出约 240m 学会"画弧跨刺"
  genTo(W.startX + 1600);
  // 摄像机立刻就位（不做平滑，避免开局抖动）
  const c = W.cam;
  c.x = W.startX - viewW() * 0.32;
  c.y = BASE_Y - viewH() * 0.52;
}

/** 视口尺寸变化（canvas resize）时更新 zoom */
export function resize(w, h) {
  const c = W.cam;
  c.w = w; c.h = h;
  // 以高度为基准缩放：无论屏幕多大，可见世界高度恒为 620px
  c.zoom = clamp(h / 620, 0.5, 2.4);
}

export const viewW = () => W.cam.w / W.cam.zoom;
export const viewH = () => W.cam.h / W.cam.zoom;

// ------------------------------------------------------------
// 地形生成
// ------------------------------------------------------------

/** 难度 0~1（按距离递增，约 9000px 到顶） */
export const difficulty = () => clamp(W.dist / 9000, 0, 1);

/** 决定下一段地形：实地（丘陵）还是虚空（断崖） */
function planMode() {
  const diff = difficulty();
  if (W.mode === 'void') {
    W.mode = 'solid';
    W.modeLeft = rngi(11, 24);
    W.hillAmp = rng(10, 28) * (0.6 + diff * 0.8);
    W.hillRate = rng(0.045, 0.13);
    // 断崖之后偶尔带一个小台阶，增加节奏变化
    if (random() < 0.3) W.gy = clamp(W.gy + rng(-46, 40), Y_MIN, Y_MAX);
  } else if (!W.attract && random() < 0.1 + diff * 0.52) {
    W.mode = 'void';
    W.modeLeft = rngi(4, 5 + floor(diff * 7));        // 4~12 列 = 104~312px
    W.voidDust = false;
  } else {
    W.modeLeft = rngi(8, 20);
    W.hillAmp = rng(8, 30) * (0.6 + diff * 0.8);
    W.hillRate = rng(0.04, 0.14);
  }
}

/** 生成地形直到世界坐标 xTarget */
export function genTo(xTarget) {
  const colTarget = ceil(xTarget / STEP);
  let nextDust = W.nextDustX, nextSpike = W.nextSpikeX;
  while (W.genCol <= colTarget) {
    if (W.modeLeft <= 0) planMode();
    const x = W.genCol * STEP;
    if (W.mode === 'void') {
      W.ground.set(W.genCol, NaN);
      // 虚空正中央浮一颗星尘：天然的"画桥"引导
      if (!W.voidDust && W.modeLeft <= 2) {
        W.dust.push({ x: x + STEP / 2, y: W.lastY - rng(60, 130), ph: random() * TAU, taken: false });
        W.voidDust = true;
        nextDust = x + rng(260, 420);
      }
    } else {
      W.hillT += W.hillRate;
      W.gy = clamp(W.gy + sin(W.hillT) * W.hillAmp * 0.42, Y_MIN, Y_MAX);
      W.ground.set(W.genCol, W.gy);
      W.lastY = W.gy;
      // 尖刺：只长在实地上，且与虚空保持安全距离
      if (!W.attract && x > nextSpike) {
        W.spikes.push({ x: x + STEP / 2, y: W.gy });
        nextSpike = x + rng(560, 1200) * (1 - difficulty() * 0.35);
      }
    }
    // 常规星尘：每 200~400px 一颗
    if (x > nextDust) {
      const base = W.mode === 'void' ? W.lastY : W.gy;
      W.dust.push({ x: x + STEP / 2, y: base - rng(46, 140), ph: random() * TAU, taken: false });
      nextDust = x + rng(200, 400);
    }
    W.modeLeft--; W.genCol++;
  }
  W.nextDustX = nextDust; W.nextSpikeX = nextSpike;
}

/**
 * 查询地面信息。
 * @returns {null | {y:number, d1:number, curv:number}}
 *   y    = 地面高度；d1 = 斜率 dy/dx；curv = 曲率 d²y/dx²（y 向下为正，
 *   所以"山脊"处 curv > 0，是起飞的判据）
 */
export function ginfo(x) {
  const f = x / STEP, i = floor(f), t = f - i;
  const g = W.ground;
  const a = g.get(i), b = g.get(i + 1), p = g.get(i - 1);
  const bad = (v) => v === undefined || v !== v;       // undefined 或 NaN
  if (bad(a) || bad(b)) return null;
  const y = a + (b - a) * t;
  const d1 = (b - a) / STEP;
  return { y, d1, curv: bad(p) ? 0 : (b - 2 * a + p) / (STEP * STEP) };
}

/** 只要地面高度（虚空返回 null） */
export function groundAt(x) {
  const g = ginfo(x);
  return g ? g.y : null;
}

// ------------------------------------------------------------
// 拾取 / 碰撞查询
// ------------------------------------------------------------

/** 收集以 (x,y) 为圆心 r 半径内的星尘，返回收集到的数组 */
export function collectDust(x, y, r) {
  const got = [];
  for (const d of W.dust) {
    if (d.taken) continue;
    const dx = d.x - x, dy = d.y - y;
    if (dx * dx + dy * dy < (r + DUST_R) * (r + DUST_R)) { d.taken = true; got.push(d); }
  }
  return got;
}

/** 是否撞上尖刺（三角形近似为圆） */
export function hitSpike(x, y, r) {
  for (const s of W.spikes) {
    if (abs(s.x - x) > SPIKE_W + r) continue;
    if (y + r > s.y - SPIKE_H * 0.55 && y - r < s.y && abs(s.x - x) < SPIKE_W * 0.62 + r * 0.5) return s;
  }
  return null;
}

// ------------------------------------------------------------
// 粒子特效
// ------------------------------------------------------------

/**
 * 生成一簇粒子。
 * @param {string} kind 'dust'(蹄下扬尘) 'spark'(彩虹火花) 'star'(星尘爆) 'boom'(死亡)
 */
export function burst(kind, x, y, n, vx0, vy0) {
  for (let i = 0; i < n; i++) {
    const a = random() * TAU, sp = rng(20, kind === 'boom' ? 260 : 120);
    W.fx.push({
      kind, x, y,
      vx: cos(a) * sp + (vx0 || 0), vy: sin(a) * sp + (vy0 || 0),
      life: 0, max: rng(0.28, kind === 'boom' ? 1.1 : 0.7),
      size: rng(1.6, kind === 'star' ? 5.5 : 4),
      hue: (random() * 360) | 0,
    });
  }
}

// ------------------------------------------------------------
// 每帧更新
// ------------------------------------------------------------

/**
 * @param {number} dt 秒
 * @param {number} ux 独角兽 x
 * @param {number} uy 独角兽 y
 */
export function update(dt, ux, uy) {
  W.time += dt;
  W.dist = max(W.dist, ux - W.startX);

  // --- 前向生成 ---
  genTo(ux + viewW() * 1.6);

  // --- 摄像机 ---
  const c = W.cam, vw = viewW(), vh = viewH();
  const gi = ginfo(clamp(ux + 60, c.x, c.x + vw));
  // 参考地面高度：虚空中保持上一个值，摄像机才不会跟着掉下去
  if (gi) c.gy = damp(c.gy, gi.y, 6, dt);
  c.x = damp(c.x, ux - vw * 0.32, 9, dt);
  // 纵向：把独角兽夹在 [参考地面-260, 参考地面+130] 内再取景，
  // 于是坠落时镜头不追，独角兽自然掉出屏幕底部 → game over
  const focusY = clamp(uy, c.gy - 260, c.gy + 130);
  c.y = damp(c.y, focusY - vh * 0.52, 5.5, dt);

  // --- 粒子 ---
  for (let i = W.fx.length - 1; i >= 0; i--) {
    const p = W.fx[i];
    p.life += dt;
    if (p.life >= p.max) { W.fx.splice(i, 1); continue; }
    p.vy += (p.kind === 'spark' ? 220 : 780) * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.kind === 'dust' || p.kind === 'boom') p.vx *= 1 - 1.8 * dt;
  }

  // --- 回收身后的内存（每帧只做少量，避免卡顿）---
  const pruneX = c.x - vw;
  while (W.dust.length && W.dust[0].x < pruneX) W.dust.shift();
  while (W.spikes.length && W.spikes[0].x < pruneX) W.spikes.shift();
  const pc = floor(pruneX / STEP) - 4;
  while (W.pruneCol < pc) { W.ground.delete(W.pruneCol++); }
}

/** 死亡线（世界 y）：低于此即坠入虚空 */
export const deathY = () => W.cam.y + viewH() + 40;

/** 世界坐标 → 屏幕坐标（渲染层用） */
export const sx = (x) => (x - W.cam.x) * W.cam.zoom;
export const sy = (y) => (y - W.cam.y) * W.cam.zoom;
/** 屏幕坐标 → 世界坐标（输入层用） */
export const wx = (px) => px / W.cam.zoom + W.cam.x;
export const wy = (py) => py / W.cam.zoom + W.cam.y;
