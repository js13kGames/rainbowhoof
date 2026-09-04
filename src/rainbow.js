// ============================================================
// rainbow.js —— 彩虹墨 / 画线输入 / 弧线生成 / 消散 / 碰撞体
//
// 这是本作唯一的操作：按住拖拽画出彩虹，松手后弧线成为实体平台。
// 弧线用世界坐标存储（相机移动时它钉在世界里不动）。
//
// 碰撞模型：每条弧是一条折线，附带"累计弧长表 cum"。
//   · 起跳落点查询用 x 投影（surfAt）
//   · 落地后的沿弧滑行用弧长参数（pointAt），因此陡坡甚至接近竖直的
//     段也能稳定行走，不会像"x 查表"那样出现一个 x 对应多个 y 的歧义
// ============================================================

import { abs, min, max, sqrt } from './lib.js';

/** 彩虹墨上限 */
export const INK_MAX = 100;
/** 每秒回复量 */
export const INK_REGEN = 6;
/** 每 px 弧长消耗的墨（100 墨 ≈ 450px 彩虹） */
export const INK_PER_PX = 0.22;
/** 弧线存活时间（秒） */
export const ARC_LIFE = 4.6;
/** 生命末尾的渐隐时长（秒） */
export const ARC_FADE = 1.1;
/** 同时存在的弧线上限（超出则挤掉最老的，防止无限堆积） */
export const ARC_MAX = 7;
/** 采点最小间距（px） */
const MIN_SEG = 9;
/** 弧线最短有效长度，短于此判定为"手抖"，退墨并丢弃 */
const MIN_LEN = 26;
/** 判定"踩上"的垂直容差带（px） */
const CATCH = 15;

export const RB = {
  arcs: [],          // 已成形的弧
  cur: null,         // 正在绘制的弧：{p:[x,y,...], len}
  ink: INK_MAX,
  drawing: false,
  painted: 0,        // 本局画出的总弧长
  blocked: 0,        // 墨尽提示计时（UI 闪红）
  gain: 0,           // 星尘回墨的瞬间反馈计时
};

/** 重开一局 */
export function reset() {
  RB.arcs.length = 0;
  RB.cur = null;
  RB.ink = INK_MAX;
  RB.drawing = false;
  RB.painted = 0;
  RB.blocked = 0;
  RB.gain = 0;
}

// ------------------------------------------------------------
// 输入（参数为世界坐标）
// ------------------------------------------------------------

/** 按下：起笔（坐标必须有限——防御 NaN 从输入层污染墨量/弧数据） */
export function down(x, y) {
  if (RB.ink < 1 || x !== x || y !== y) { RB.blocked = 0.4; return; }
  RB.drawing = true;
  RB.cur = { p: [x, y], len: 0 };
}

/**
 * 移动：续笔。返回是否真的落了一笔（调用方据此播"唰"音效）。
 * 墨不够画完整段时会画到耗尽为止并自动收笔。
 */
export function move(x, y) {
  const c = RB.cur;
  if (!RB.drawing || !c) return false;
  const p = c.p, n = p.length;
  const dx = x - p[n - 2], dy = y - p[n - 1];
  const d = sqrt(dx * dx + dy * dy);
  if (!(d < 1e7)) return false;                       // NaN/Infinity 段直接丢弃
  if (d < MIN_SEG) return false;
  const cost = d * INK_PER_PX;
  if (RB.ink < cost) {
    const k = RB.ink / cost;
    if (k > 0.15) {
      p.push(p[n - 2] + dx * k, p[n - 1] + dy * k);
      c.len += d * k;
      RB.ink = 0;
    }
    RB.blocked = 0.45;
    up();
    return false;
  }
  p.push(x, y);
  c.len += d;
  RB.ink -= cost;
  return true;
}

/** 松手：定稿（平滑 → 统一方向 → 累计弧长 → 包围盒 → 入列） */
export function up() {
  RB.drawing = false;
  const c = RB.cur;
  RB.cur = null;
  if (!c) return null;
  let p = smooth(c.p);
  let len = polyLen(p);
  // len!==len 拦 NaN（NaN 与任何数比较均为 false，会绕过下面的长度检查）
  if (p.length < 4 || len !== len || len < MIN_LEN) {
    RB.ink = min(INK_MAX, RB.ink + (len === len ? len : 0) * INK_PER_PX);   // 手抖退墨
    return null;
  }
  // 统一为"从左到右"，于是沿弧长前进 ≈ 沿 +x 前进（独角兽永远向右跑）
  if (p[p.length - 2] < p[0]) {
    const q = new Array(p.length);
    for (let i = 0; i < p.length; i += 2) {
      q[p.length - 2 - i] = p[i];
      q[p.length - 1 - i] = p[i + 1];
    }
    p = q;
  }
  const cum = [0];
  for (let i = 2; i < p.length; i += 2) {
    const dx = p[i] - p[i - 2], dy = p[i + 1] - p[i - 1];
    cum.push(cum[i / 2 - 1] + sqrt(dx * dx + dy * dy));
  }
  const arc = { p, cum, hint: 0, age: 0, len, x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9 };
  for (let i = 0; i < p.length; i += 2) {
    arc.x0 = min(arc.x0, p[i]); arc.x1 = max(arc.x1, p[i]);
    arc.y0 = min(arc.y0, p[i + 1]); arc.y1 = max(arc.y1, p[i + 1]);
  }
  RB.painted += len;
  RB.arcs.push(arc);
  if (RB.arcs.length > ARC_MAX) RB.arcs.shift();
  return arc;
}

/** Chaikin 切角平滑一遍，再按最小间距抽稀，得到圆润又紧凑的弧线 */
function smooth(src) {
  if (src.length < 6) return src.slice();
  const o = [src[0], src[1]];
  for (let i = 0; i < src.length - 3; i += 2) {
    const x0 = src[i], y0 = src[i + 1], x1 = src[i + 2], y1 = src[i + 3];
    o.push(x0 * 0.72 + x1 * 0.28, y0 * 0.72 + y1 * 0.28,
           x0 * 0.28 + x1 * 0.72, y0 * 0.28 + y1 * 0.72);
  }
  o.push(src[src.length - 2], src[src.length - 1]);
  const r = [o[0], o[1]];                              // 抽稀：间距 ≥11px
  for (let i = 2; i < o.length - 2; i += 2) {
    const dx = o[i] - r[r.length - 2], dy = o[i + 1] - r[r.length - 1];
    if (dx * dx + dy * dy >= 121) r.push(o[i], o[i + 1]);
  }
  r.push(o[o.length - 2], o[o.length - 1]);
  return r;
}

/** 折线总长 */
function polyLen(p) {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) {
    const dx = p[i] - p[i - 2], dy = p[i + 1] - p[i - 1];
    L += sqrt(dx * dx + dy * dy);
  }
  return L;
}

// ------------------------------------------------------------
// 每帧更新
// ------------------------------------------------------------

export function update(dt) {
  RB.ink = min(INK_MAX, RB.ink + INK_REGEN * dt);
  if (RB.blocked > 0) RB.blocked -= dt;
  if (RB.gain > 0) RB.gain -= dt;
  for (let i = RB.arcs.length - 1; i >= 0; i--) {
    RB.arcs[i].age += dt;
    if (RB.arcs[i].age >= ARC_LIFE) RB.arcs.splice(i, 1);
  }
}

/** 弧线当前不透明度（淡入 0.12s，末尾 ARC_FADE 秒淡出） */
export function alpha(a) {
  const inA = min(1, a.age / 0.12);
  const left = ARC_LIFE - a.age;
  return inA * (left < ARC_FADE ? max(0, left / ARC_FADE) : 1);
}

/** 星尘回墨 */
export function addInk(v) {
  RB.ink = min(INK_MAX, RB.ink + v);
  RB.gain = 0.35;
}

// ------------------------------------------------------------
// 碰撞查询
// ------------------------------------------------------------

/**
 * 在 x 处查找可踩踏的弧面（"从上方落下"才成立）。
 * @param {number} x  脚底世界 x
 * @param {number} py 上一帧脚底 y
 * @param {number} y  当前脚底 y
 * @param {number} vy 垂直速度（y 向下为正）
 * @returns {null | {arc, y, tx, ty, d}} d = 接触点的弧长参数
 */
export function surfAt(x, py, y, vy) {
  let best = null;
  for (let k = RB.arcs.length - 1; k >= 0; k--) {       // 最新画的优先
    const a = RB.arcs[k], p = a.p, cum = a.cum;
    if (x < a.x0 - 2 || x > a.x1 + 2) continue;          // 包围盒剔除
    if (alpha(a) <= 0.03) continue;                      // 快消散的弧不再承重
    for (let i = 0; i + 1 < cum.length; i++) {
      const ax = p[2 * i], bx = p[2 * i + 2];
      const lo = min(ax, bx), hi = max(ax, bx);
      if (x < lo || x > hi || hi - lo < 1e-6) continue;
      const t = (x - ax) / (bx - ax);
      const ay = p[2 * i + 1], by = p[2 * i + 3];
      const hy = ay + (by - ay) * t;
      if (py > hy + 2) continue;                         // 上一帧还在其下方 → 不算踩上
      if (y < hy - CATCH) continue;                      // 本帧还没够到
      if (vy < -40 && y < hy - 2) continue;              // 强烈上升时不吸附
      if (best && hy >= best.y) continue;                // 取最高（y 最小）的接触面
      let tx = bx - ax, ty = by - ay;
      const L = sqrt(tx * tx + ty * ty) || 1;
      tx /= L; ty /= L;
      if (tx < 0) { tx = -tx; ty = -ty; }
      best = { arc: a, y: hy, tx, ty, d: cum[i] + (cum[i + 1] - cum[i]) * t };
    }
  }
  return best;
}

/**
 * 沿弧长取点（落地后沿弧滑行用）。
 * @returns {null | {x, y, tx, ty, curv}} curv>0 表示弧顶（可飞出）
 */
export function pointAt(a, d) {
  const cum = a.cum, n = cum.length, p = a.p;
  if (!(d >= 0) || d >= cum[n - 1]) return null;
  let i = a.hint;
  if (i > n - 2) i = n - 2;
  while (i > 0 && cum[i] > d) i--;
  while (i < n - 2 && cum[i + 1] <= d) i++;
  a.hint = i;
  const seg = cum[i + 1] - cum[i] || 1;
  const t = (d - cum[i]) / seg;
  const x0 = p[2 * i], y0 = p[2 * i + 1], x1 = p[2 * i + 2], y1 = p[2 * i + 3];
  let tx = x1 - x0, ty = y1 - y0;
  const L = sqrt(tx * tx + ty * ty) || 1;
  tx /= L; ty /= L;
  if (tx < 0) { tx = -tx; ty = -ty; }
  let curv = 0;
  if (i > 0 && i < n - 2) {
    const px = p[2 * i] - p[2 * i - 2], py = p[2 * i + 1] - p[2 * i - 1];
    const pl = sqrt(px * px + py * py) || 1;
    let ux = px / pl, uy = py / pl;
    if (ux < 0) { ux = -ux; uy = -uy; }
    curv = (ty - uy) / max(9, (cum[i + 1] - cum[i - 1]) * 0.5);
  }
  return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, tx, ty, curv };
}

/** 供调试/验证：当前所有弧的点数合计 */
export const arcPoints = () => RB.arcs.reduce((s, a) => s + a.cum.length, 0);
