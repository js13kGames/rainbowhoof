// ============================================================
// unicorn.js —— 独角兽物理：自动奔跑 / 重力 / 沿弧投影 / 连段 / squash&stretch
//
// 手感三原则：
//  1. 泥地上向"基准奔跑速度"松弛 → 永远是自动跑酷，玩家不用管前进；
//  2. 彩虹弧上只受"重力沿切线分量"驱动，不做速度松弛 → half-pipe 手感，
//     俯冲攒速度、上坡吐速度，从弧顶飞出是自然而非脚本；
//  3. 起飞判据 = 贴合曲面所需的向心加速度 v²κ 超过重力 g，
//     所以山脊与弧顶都会真实地把独角兽抛出去。
//
// 坐标：x 向右、y 向下为正（与 Canvas 一致）。U.x/U.y 表示"蹄底"位置，
// 身体画在其上方，这样碰撞判定只需一个点。
// ============================================================

import {
  abs, max, min, atan2, pow, ceil, hypot, clamp, lerp,
} from './lib.js';
import { W, ginfo, hitSpike, deathY, burst } from './world.js';
import { surfAt, pointAt, alpha } from './rainbow.js';

/** 重力加速度 px/s²（偏大 → 起落干脆有"爽快感"） */
export const GRAV = 1200;
/** 基础奔跑速度 px/s */
export const RUN_MIN = 200;
/** 距离拉满后的奔跑速度 px/s */
export const RUN_MAX = 340;
/** 速度上限（俯冲攒速不至于失控） */
export const SPD_CAP = 950;
/** 蹄底碰撞半径 */
export const HOOF_R = 14;
/** 泥地上可"踏上"多高的彩虹（px）。没有它玩家无法用彩虹越过尖刺 */
export const STEP_UP = 46;
/** 起飞判据的松弛系数：<1 更容易飞起来 */
const LAUNCH_K = 0.9;

/** 事件位掩码：update() 后由 main 读取并清零 */
export const EV = { LAUNCH: 1, ARC: 2, DIRT: 4, ARCLOST: 8, STEPUP: 16 };

export const U = {
  x: 0, y: 0, vx: 0, vy: 0, speed: RUN_MIN,
  surf: 'dirt',        // 'dirt' | 'rainbow' | 'air'
  arc: null, arcD: 0,  // 当前踩着的弧 + 弧长参数
  combo: 0, best: 0, lastArc: 0,
  sq: 1, sqv: 0,       // squash & stretch（1 = 原形，<1 压扁，>1 拉长）
  rot: 0, phase: 0, spin: 0,
  air: 0, arcTime: 0,
  ev: 0, alive: true,
  dustT: 0, sparkT: 0,
};

/** 当前基准奔跑速度（随距离线性提速，约 9000px 到顶） */
export const runSpeed = () => RUN_MIN + min(1, W.dist / 9000) * (RUN_MAX - RUN_MIN);

/** 重开一局：站起跑线上 */
export function reset() {
  const g = ginfo(W.startX);
  U.x = W.startX;
  U.y = g ? g.y : 470;
  U.speed = RUN_MIN;
  U.vx = RUN_MIN; U.vy = 0;
  U.surf = 'dirt'; U.arc = null; U.arcD = 0;
  U.combo = 0; U.best = 0; U.lastArc = 0;
  U.sq = 1; U.sqv = 0; U.rot = 0; U.phase = 0; U.spin = 0;
  U.air = 0; U.arcTime = 0; U.ev = 0; U.alive = true;
  U.dustT = 0; U.sparkT = 0;
}

// ------------------------------------------------------------
// 状态切换
// ------------------------------------------------------------

function toAir() {
  if (U.surf === 'air') return;
  U.surf = 'air';
  U.lastArc = U.arc;                                  // 供连段判定：回踩同一弧不算新链
  U.arc = null;
  U.air = 0;
  U.ev |= EV.LAUNCH;
}

/** 踏上彩虹弧。fromAir=true 表示从空中接住 → 计连段 */
function onArc(s, fromAir) {
  U.surf = 'rainbow';
  U.arc = s.arc;
  U.arcD = s.d;
  U.y = s.y;
  U.speed = clamp(max(U.speed, runSpeed() * 0.62), 0, SPD_CAP);
  U.vx = s.tx * U.speed;
  U.vy = s.ty * U.speed;
  U.sq = fromAir ? 0.58 : 0.82;
  U.sqv = 0;
  if (fromAir) {
    // 连段判据：真实飞行（≥0.15s）且落上的是另一条弧。
    // 否则视为"微弹跳回同一弧"，只给软反馈——堵住同弧弹跳刷连段的漏洞。
    const chain = U.air > 0.15 && s.arc !== U.lastArc;
    U.air = 0;
    if (chain) {
      U.combo++;
      if (U.combo > U.best) U.best = U.combo;
      U.ev |= EV.ARC;
      burst('spark', U.x, U.y, 14, 0, -50);
    } else {
      U.ev |= EV.STEPUP;
      burst('spark', U.x, U.y, 5, 0, -30);
    }
  } else {
    U.ev |= EV.STEPUP;
    burst('spark', U.x, U.y, 5, 0, -30);
  }
}

/** 落回泥地：连段中断 */
function onDirt(g, y) {
  const lost = U.combo > 0;
  U.surf = 'dirt';
  U.arc = null;
  U.y = y;
  U.speed = max(U.speed * 0.88, runSpeed() * 0.72);
  const L = hypot(1, g.d1) || 1;
  U.vx = U.speed / L;
  U.vy = (U.speed * g.d1) / L;
  U.sq = lost ? 0.5 : 0.72;
  U.sqv = 0;
  U.air = 0;
  U.combo = 0;
  U.ev |= EV.DIRT;
  burst('dust', U.x, U.y, lost ? 12 : 7, -U.vx * 0.22, -70);
}

// ------------------------------------------------------------
// 单个物理子步
// ------------------------------------------------------------

function step(h) {
  const rs = runSpeed();
  const px = U.x, py = U.y;

  if (U.surf === 'dirt') {
    const nx = px + U.vx * h;
    const g = ginfo(nx);
    if (!g) {
      toAir();                                     // 走到断崖边 → 抛出
    } else {
      let dx = nx - px, dy = g.y - py;
      let L = hypot(dx, dy);
      if (L < 1e-6) { dx = 1; dy = 0; L = 1; }
      dx /= L; dy /= L;
      if (dx < 0.05) { dx = 0.05; dy = 0; }            // 禁止倒退/立墙
      U.speed += GRAV * dy * h;                     // 下坡攒速、上坡吐速
      U.speed += (rs - U.speed) * min(1, 1.6 * h);  // 泥地：向基准速度松弛
      U.speed = clamp(U.speed, rs * 0.5, SPD_CAP);
      U.x = nx; U.y = g.y;
      U.vx = dx * U.speed; U.vy = dy * U.speed;
      U.rot = lerp(U.rot, atan2(dy, dx), min(1, 14 * h));
      if (g.curv > 0 && U.speed * U.speed * g.curv > GRAV * LAUNCH_K) toAir();
      // 泥地上也可能踩到玩家铺的彩虹（同高度或略高 → 允许"抬"过尖刺）
      if (U.surf === 'dirt') {
        const s = surfAt(U.x, U.y - STEP_UP, U.y, U.vy);
        if (s) onArc(s, false);
      }
    }
  } else if (U.surf === 'rainbow') {
    U.arcD += U.speed * h;                          // 沿弧长前进
    U.arcTime += h;
    const q = U.arc ? pointAt(U.arc, U.arcD) : null;
    const fade = U.arc ? alpha(U.arc) : 0;
    if (!q || fade <= 0.03) {
      toAir();                                      // 走到弧端 / 彩虹消散
      U.ev |= EV.ARCLOST;
    } else {
      // 不做速度松弛：纯 half-pipe，靠重力沿切线加减速
      U.speed += GRAV * q.ty * h;
      U.speed = clamp(U.speed, rs * 0.42, SPD_CAP);
      U.x = q.x; U.y = q.y;
      U.vx = q.tx * U.speed; U.vy = q.ty * U.speed;
      U.rot = lerp(U.rot, atan2(q.ty, q.tx), min(1, 16 * h));
      const g = ginfo(U.x);
      if (g && q.y > g.y + 1) onDirt(g, g.y);       // 彩虹钻到地里了 → 回到地面
      else if (q.curv > 0 && U.speed * U.speed * q.curv > GRAV * LAUNCH_K) toAir();
    }
  } else {
    // ---- 腾空 ----
    U.vy += GRAV * h;
    U.vx += (rs - U.vx) * min(1, 0.45 * h);         // 轻微空气追随，防止起飞后水平停滞
    U.vx = max(U.vx, rs * 0.32);
    U.x += U.vx * h;
    U.y += U.vy * h;
    U.speed = hypot(U.vx, U.vy);
    U.air += h;
    U.rot = lerp(U.rot, atan2(U.vy, max(50, U.vx)), min(1, 9 * h));

    // 落地判定：彩虹与泥地都测，取更高的那个面（y 更小）
    const s = surfAt(U.x, py, U.y, U.vy);
    const g = ginfo(U.x);
    let kind = 0, ly = 1e9;
    if (s) { kind = 1; ly = s.y; }
    if (g && py <= g.y + 2 && U.y >= g.y && g.y < ly) { kind = 2; ly = g.y; }
    if (kind === 1) onArc(s, true);
    else if (kind === 2) onDirt(g, ly);
  }

  // ---- squash & stretch ----
  if (U.surf === 'air') {
    U.sq = lerp(U.sq, 1 + min(0.4, abs(U.vy) / 950), min(1, 10 * h));
  } else {
    U.sqv += (1 - U.sq) * 300 * h;                  // 弹簧回正（带过冲）
    U.sqv *= pow(0.002, h);
    U.sq += U.sqv * h;
  }

  // ---- 奔跑动画相位 & 环境粒子 ----
  U.phase += U.speed * h * 0.042;
  if (U.surf === 'dirt' && (U.dustT -= h) <= 0) {
    U.dustT = 0.1;
    burst('dust', U.x - 10, U.y, 1, -U.vx * 0.3, -25);
  } else if (U.surf === 'rainbow' && (U.sparkT -= h) <= 0) {
    U.sparkT = 0.05;
    burst('spark', U.x - 6, U.y, 1, -U.vx * 0.35, -55);
  }
}

// ------------------------------------------------------------
// 对外主更新
// ------------------------------------------------------------

/**
 * @param {number} dt 秒（内部按 120Hz 细分，防止高速穿模）
 */
export function update(dt) {
  U.ev = 0;
  const n = clamp(ceil(dt * 120), 1, 8);
  const h = dt / n;
  for (let i = 0; i < n; i++) step(h);
}

/** @returns {null|'void'|'spike'} 死亡原因 */
export function checkDeath() {
  if (!U.alive) return null;
  if (U.y > deathY()) return 'void';
  if (hitSpike(U.x, U.y - 6, HOOF_R)) return 'spike';
  return null;
}

/** 连段倍率（落地重置为 1） */
export const mult = () => max(1, U.combo);

/** 供渲染层使用的腿部位相（4 条腿错开） */
export const legPhase = (k) => U.phase + k * 1.5708;
