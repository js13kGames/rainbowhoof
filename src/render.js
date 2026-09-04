// ============================================================
// render.js —— Canvas 2D 绘制层
//
// 分两个坐标空间：
//   · 屏幕空间（CSS px）：天空、视差云、远山、UI、标题/结算面板
//   · 世界空间（world px）：地形、彩虹、星尘、尖刺、独角兽、粒子
// 世界空间通过一次 setTransform 完成 world→screen 映射，避免逐点换算。
//
// 美术方向：梦幻粉彩黄昏 + 高饱和彩虹。几何体绘制，无任何外部图片资源。
// ============================================================

import {
  sin, cos, abs, max, min, floor, ceil, pow, TAU,
  clamp, hash,
} from './lib.js';
import { W, viewW, viewH, STEP, SPIKE_W, SPIKE_H } from './world.js';
import { U, legPhase } from './unicorn.js';
import { RB, alpha, INK_MAX } from './rainbow.js';

/** 彩虹六色（外→内） */
const RAINBOW = ['#ff3358', '#ff9522', '#ffe13d', '#3ddc7f', '#2fa8ff', '#a759ff'];
/** 深紫：文字/描边主色 */
const PLUM = '#3b2352';
/** 显示字体：几何圆体优先（Win/Mac 都有），避免通用无衬线的廉价感 */
const F_DISP = '"Century Gothic","Futura","Questrial","Trebuchet MS",sans-serif';

let cv, ctx, DPR = 1, VW = 960, VH = 600;
let introT = 0;                 // 页面加载后的入场动画计时
const RUNS = [];                // 复用的地形分段缓存

export function init(canvas) {
  cv = canvas;
  ctx = canvas.getContext('2d', { alpha: false });
  resize();
  return ctx;
}

/** canvas 尺寸跟随窗口（含 DPR 高清适配） */
export function resize() {
  DPR = min(2, window.devicePixelRatio || 1);
  VW = cv.clientWidth || window.innerWidth;
  VH = cv.clientHeight || window.innerHeight;
  cv.width = max(1, floor(VW * DPR));
  cv.height = max(1, floor(VH * DPR));
  return { w: VW, h: VH };
}

export const size = () => ({ w: VW, h: VH, dpr: DPR });

// ------------------------------------------------------------
// 小工具
// ------------------------------------------------------------

/** 带描边的文字（保证任何背景上都清晰） */
function txt(s, x, y, px, fill, stroke, align, weight) {
  ctx.font = `${weight || 700} ${px}px ${F_DISP}`;
  ctx.textAlign = align || 'center';
  ctx.textBaseline = 'middle';
  if (stroke) {
    ctx.lineWidth = max(2, px * 0.14);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke;
    ctx.strokeText(s, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(s, x, y);
}

/** 字距展开的文字（canvas 的 letterSpacing 只有 Chromium 支持，故手绘） */
function tracked(s, x, y, sp, px, fill, stroke) {
  ctx.font = `700 ${px}px ${F_DISP}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let w = 0;
  for (const c of s) w += ctx.measureText(c).width + sp;
  w -= sp;
  let cx = x - w / 2;
  for (const c of s) {
    if (stroke) {
      ctx.lineWidth = max(2, px * 0.13);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = stroke;
      ctx.strokeText(c, cx, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(c, cx, y);
    cx += ctx.measureText(c).width + sp;
  }
  return w;
}

/** 圆角矩形路径 */
function rr(x, y, w, h, r) {
  r = min(r, abs(w) / 2, abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ------------------------------------------------------------
// 屏幕空间：天空 / 云 / 远山
// ------------------------------------------------------------

function drawSky(t) {
  const g = ctx.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, '#63b8f2');
  g.addColorStop(0.34, '#a9d8f7');
  g.addColorStop(0.62, '#e7d3fb');
  g.addColorStop(0.84, '#ffc9e6');
  g.addColorStop(1, '#ffe7c4');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);

  // 落日柔光（跟着相机轻微横移，产生纵深）
  const sxp = VW * 0.74 - (W.cam.x * 0.02) % VW;
  const rg = ctx.createRadialGradient(sxp, VH * 0.3, 0, sxp, VH * 0.3, VH * 0.55);
  rg.addColorStop(0, 'rgba(255,246,214,0.85)');
  rg.addColorStop(0.32, 'rgba(255,214,236,0.32)');
  rg.addColorStop(1, 'rgba(255,214,236,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, VW, VH);
  ctx.beginPath();
  ctx.arc(sxp, VH * 0.3, 42, 0, TAU);
  ctx.fillStyle = 'rgba(255,252,235,0.92)';
  ctx.fill();

  // 星点（黄昏上半空，随时间闪烁）
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  const drift = ((W.cam.x * 0.04) % VW + VW) % VW;
  for (let i = 0; i < 26; i++) {
    const hx = hash(i * 3 + 1), hy = hash(i * 7 + 5);
    const tw = 0.35 + 0.65 * abs(sin(t * (0.7 + hx * 1.6) + i));
    ctx.globalAlpha = tw * (1 - hy * 0.55) * 0.8;
    let stx = hx * VW - drift;
    if (stx < -4) stx += VW;
    ctx.fillRect(stx, hy * VH * 0.55, 2, 2);
  }
  ctx.globalAlpha = 1;
}

/** 视差云层：两层，程序化位置（hash 决定，不占内存） */
function drawClouds() {
  for (let L = 0; L < 2; L++) {
    const par = L ? 0.34 : 0.16;
    const sc = L ? 1.15 : 0.72;
    const span = 520;
    const off = W.cam.x * par;
    const i0 = floor((off - 300) / span), i1 = floor((off + VW + 300) / span);
    ctx.fillStyle = L ? 'rgba(255,255,255,0.9)' : 'rgba(255,236,248,0.6)';
    for (let i = i0; i <= i1; i++) {
      const hx = hash(i * 11 + L * 53), hy = hash(i * 29 + L * 91);
      const cx = i * span + hx * span * 0.7 - off;
      const cy = VH * (0.06 + hy * 0.3) + sin(i * 1.7) * 12;
      const s = (26 + hx * 34) * sc;
      ctx.beginPath();
      ctx.arc(cx, cy, s, 0, TAU);
      ctx.arc(cx + s * 0.85, cy + s * 0.18, s * 0.72, 0, TAU);
      ctx.arc(cx - s * 0.82, cy + s * 0.24, s * 0.62, 0, TAU);
      ctx.arc(cx + s * 0.2, cy - s * 0.42, s * 0.6, 0, TAU);
      ctx.fill();
    }
  }
}

/** 远山剪影：两层正弦叠加，视差不同 */
function drawHills() {
  const layers = [
    [0.1, VH * 0.6, 78, 'rgba(150,132,196,0.42)', 0.0032],
    [0.22, VH * 0.68, 60, 'rgba(112,148,178,0.5)', 0.0051],
  ];
  for (const [par, base, amp, col, fr] of layers) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, VH);
    for (let x = 0; x <= VW + 8; x += 10) {
      const wx = x + W.cam.x * par;
      const y = base - (sin(wx * fr) * 0.55 + sin(wx * fr * 2.7 + 1.3) * 0.3 + 0.55) * amp;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(VW, VH);
    ctx.closePath();
    ctx.fill();
  }
}

/** 底部深渊渐暗：提示"掉下去就完蛋" */
function drawAbyss() {
  const g = ctx.createLinearGradient(0, VH * 0.7, 0, VH);
  g.addColorStop(0, 'rgba(46,20,66,0)');
  g.addColorStop(1, 'rgba(46,20,66,0.5)');
  ctx.fillStyle = g;
  ctx.fillRect(0, VH * 0.7, VW, VH * 0.3);
}

/** 暗角，聚焦画面中心 */
function drawVignette() {
  const g = ctx.createRadialGradient(VW / 2, VH / 2, VH * 0.34, VW / 2, VH / 2, VH * 0.92);
  g.addColorStop(0, 'rgba(40,16,58,0)');
  g.addColorStop(1, 'rgba(40,16,58,0.34)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
}

// ------------------------------------------------------------
// 世界空间：地形 / 尖刺 / 星尘 / 彩虹 / 独角兽 / 粒子
// ------------------------------------------------------------

/** 收集屏幕可见的地面分段（虚空把地面切成多段） */
function collectRuns() {
  RUNS.length = 0;
  const c = W.cam;
  const i0 = floor((c.x - 60) / STEP), i1 = ceil((c.x + viewW() + 60) / STEP);
  let cur = null;
  for (let i = i0; i <= i1; i++) {
    const v = W.ground.get(i);
    if (v === undefined || v !== v) { cur = null; continue; }   // NaN = 虚空
    if (!cur) { cur = []; RUNS.push(cur); }
    cur.push(i * STEP, v);
  }
}

function drawTerrain() {
  collectRuns();
  const bottom = W.cam.y + viewH() + 260;
  const g = ctx.createLinearGradient(0, W.cam.y, 0, bottom);
  g.addColorStop(0, '#4fae63');
  g.addColorStop(0.14, '#3b8d55');
  g.addColorStop(0.5, '#2d6446');
  g.addColorStop(1, '#243a52');
  ctx.fillStyle = g;
  // 一次 beginPath 画多个子路径，fill 的非零环绕会把它们都填上
  ctx.beginPath();
  for (const r of RUNS) {
    ctx.moveTo(r[0], r[1]);
    for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i], r[i + 1]);
    ctx.lineTo(r[r.length - 2], bottom);
    ctx.lineTo(r[0], bottom);
    ctx.closePath();
  }
  ctx.fill();

  // 草皮亮边
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#7ee08a';
  ctx.lineWidth = 6;
  ctx.beginPath();
  for (const r of RUNS) {
    ctx.moveTo(r[0], r[1] - 1);
    for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i], r[i + 1] - 1);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(214,255,220,0.6)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 草丛与小花（用列号 hash 决定，确定性、零内存）
  for (const r of RUNS) {
    for (let i = 0; i < r.length; i += 2) {
      const h = hash(floor(r[i] / STEP) * 17 + 3);
      if (h < 0.62) continue;
      const x = r[i], y = r[i + 1];
      if (h < 0.86) {                                  // 草叶
        ctx.strokeStyle = 'rgba(150,235,160,0.85)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        for (let k = -1; k <= 1; k++) {
          ctx.moveTo(x + k * 3, y);
          ctx.lineTo(x + k * 3 + k * 2.6, y - 7 - h * 6);
        }
        ctx.stroke();
      } else {                                         // 小花
        const hue = [330, 48, 275, 12][floor(h * 40) % 4];
        ctx.fillStyle = `hsl(${hue} 92% 74%)`;
        const fy = y - 9 - h * 5;
        ctx.strokeStyle = '#63c477';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, fy); ctx.stroke();
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * TAU + W.time * 0.4;
          ctx.beginPath();
          ctx.arc(x + cos(a) * 3.2, fy + sin(a) * 3.2, 2.4, 0, TAU);
          ctx.fill();
        }
        ctx.fillStyle = '#fff3b0';
        ctx.beginPath(); ctx.arc(x, fy, 1.9, 0, TAU); ctx.fill();
      }
    }
  }
}

function drawSpikes() {
  for (const s of W.spikes) {
    if (s.x < W.cam.x - 60 || s.x > W.cam.x + viewW() + 60) continue;
    ctx.fillStyle = '#5b4a72';
    for (let k = -1; k <= 1; k++) {
      const h = k === 0 ? SPIKE_H : SPIKE_H * 0.66;
      const x = s.x + k * SPIKE_W * 0.36;
      ctx.beginPath();
      ctx.moveTo(x - SPIKE_W * 0.2, s.y + 2);
      ctx.lineTo(x, s.y - h);
      ctx.lineTo(x + SPIKE_W * 0.2, s.y + 2);
      ctx.closePath();
      ctx.fill();
    }
    // 高光尖端，让危险一眼可读
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(s.x - 2, s.y - SPIKE_H * 0.55);
    ctx.lineTo(s.x, s.y - SPIKE_H);
    ctx.stroke();
  }
}

function drawDust(t) {
  for (const d of W.dust) {
    if (d.taken) continue;
    if (d.x < W.cam.x - 40 || d.x > W.cam.x + viewW() + 40) continue;
    const bob = sin(t * 2.4 + d.ph) * 5;
    const pulse = 0.72 + 0.28 * sin(t * 5 + d.ph * 2);
    const y = d.y + bob;
    const rg = ctx.createRadialGradient(d.x, y, 0, d.x, y, 22);
    rg.addColorStop(0, `rgba(255,236,150,${0.55 * pulse})`);
    rg.addColorStop(1, 'rgba(255,214,90,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(d.x - 22, y - 22, 44, 44);
    // 四角星芒
    ctx.strokeStyle = `rgba(255,246,190,${0.9 * pulse})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const r = 9 * pulse;
    ctx.moveTo(d.x - r, y); ctx.lineTo(d.x + r, y);
    ctx.moveTo(d.x, y - r); ctx.lineTo(d.x, y + r);
    ctx.stroke();
    ctx.fillStyle = '#fff6c9';
    ctx.beginPath();
    ctx.arc(d.x, y, 4.6 * pulse, 0, TAU);
    ctx.fill();
  }
}

/** 一条彩虹弧：宽线叠窄线 → 天然的同心六色带 + 外发光 */
function strokeArc(p, w, col, a) {
  ctx.globalAlpha = a;
  ctx.strokeStyle = col;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
  ctx.stroke();
}

function drawRainbows(t) {
  for (const a of RB.arcs) {
    const al = alpha(a);
    if (al <= 0) continue;
    // 外发光
    strokeArc(a.p, 26, 'rgba(255,255,255,0.2)', al * 0.55);
    strokeArc(a.p, 20, 'rgba(255,225,250,0.28)', al * 0.4);
    for (let i = 0; i < 6; i++) strokeArc(a.p, 19 - i * 3.1, RAINBOW[i], al);
    // 顶部高光随时间流动，让彩虹"活着"
    const p = a.p, np = p.length / 2;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    for (let i = 0; i + 1 < np; i++) {
      const f = (i / np + t * 0.35) % 1;
      ctx.globalAlpha = al * 0.55 * pow(sin(f * 3.1416), 3);
      ctx.beginPath();
      ctx.moveTo(p[2 * i], p[2 * i + 1] - 8);
      ctx.lineTo(p[2 * i + 2], p[2 * i + 3] - 8);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // 正在绘制的笔迹（更亮、更细，实时反馈）
  if (RB.cur && RB.cur.p.length >= 2) {
    const p = RB.cur.p;
    strokeArc(p, 20, 'rgba(255,255,255,0.35)', 0.85);
    for (let i = 0; i < 6; i++) strokeArc(p, 17 - i * 2.7, RAINBOW[i], 0.92);
    ctx.globalAlpha = 1;
  }
}

function drawFX() {
  for (const p of W.fx) {
    const k = 1 - p.life / p.max;
    if (p.kind === 'spark') {
      ctx.fillStyle = `hsla(${(p.hue + W.time * 220) % 360} 100% 72% / ${k})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * k + 0.6, 0, TAU);
      ctx.fill();
    } else if (p.kind === 'star') {
      ctx.fillStyle = `rgba(255,240,170,${k})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * k * 1.4, 0, TAU);
      ctx.fill();
    } else {
      ctx.fillStyle = p.kind === 'boom'
        ? `hsla(${p.hue} 90% 66% / ${k})`
        : `rgba(226,214,196,${k * 0.6})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (2 - k), 0, TAU);
      ctx.fill();
    }
  }
}

/**
 * 独角兽：椭圆身体 + 三角耳 + 螺旋角 + 四条摆动的腿 + 彩虹鬃毛/尾巴。
 * 原点 = 蹄底接触点，+x 前方，-y 上方。
 */
function drawUnicorn(t) {
  const air = U.surf === 'air';
  ctx.save();
  ctx.translate(U.x, U.y);
  ctx.rotate(U.rot * (air ? 1 : 0.7));
  // squash & stretch：压扁时横向变宽
  ctx.scale(2 - U.sq, U.sq);

  const bodyY = -33;
  const legLen = air ? 20 : 30;

  // ---- 腿（画在身体后面，先画远侧两条）----
  ctx.strokeStyle = '#e6dcf5';
  ctx.lineWidth = 4.4;
  ctx.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    ctx.strokeStyle = pass ? '#fdf7ff' : '#ddd0ee';
    for (let k = 0; k < 2; k++) {
      const hipX = k ? -15 : 11;
      const ph = legPhase(k * 2 + pass);
      const lift = air ? 9 : (1 - cos(ph)) * 6.5;
      const hx = hipX + (air ? -6 : sin(ph) * 13);
      const hy = -lift - (air ? 6 : 0);
      ctx.beginPath();
      ctx.moveTo(hipX, bodyY + 6);
      ctx.quadraticCurveTo(hipX + (hx - hipX) * 0.4 + 4, bodyY + legLen * 0.55, hx, hy);
      ctx.stroke();
      // 蹄
      ctx.fillStyle = pass ? '#c9a7f0' : '#b695dd';
      ctx.beginPath();
      ctx.arc(hx, hy, 2.7, 0, TAU);
      ctx.fill();
    }
  }

  // ---- 尾巴（彩虹飘带）----
  const tw = W.time * 7 + U.phase;
  for (let i = 0; i < 6; i++) {
    ctx.strokeStyle = RAINBOW[i];
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.moveTo(-24, bodyY - 4 + i * 1.5);
    const sway = sin(tw * 0.5 + i * 0.4) * 5;
    ctx.quadraticCurveTo(-36 - i, bodyY - 2 + i * 3.4 + sway, -46 - i * 1.6, bodyY + 8 + i * 3.6 + sway * 1.6);
    ctx.stroke();
  }

  // ---- 身体 ----
  const bg = ctx.createLinearGradient(0, bodyY - 18, 0, bodyY + 18);
  bg.addColorStop(0, '#ffffff');
  bg.addColorStop(0.62, '#f6efff');
  bg.addColorStop(1, '#ddcdf2');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.ellipse(-1, bodyY, 26, 16.5, -0.06, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,90,160,0.28)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // ---- 脖子 + 头 ----
  ctx.fillStyle = '#fbf6ff';
  ctx.beginPath();
  ctx.moveTo(12, bodyY - 9);
  ctx.quadraticCurveTo(20, bodyY - 22, 27, bodyY - 28);
  ctx.lineTo(35, bodyY - 20);
  ctx.quadraticCurveTo(26, bodyY - 10, 20, bodyY + 2);
  ctx.closePath();
  ctx.fill();

  ctx.save();
  ctx.translate(33, bodyY - 27);
  ctx.rotate(-0.42);
  ctx.fillStyle = '#fdf9ff';
  ctx.beginPath();
  ctx.ellipse(0, 0, 13.5, 9.2, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,90,160,0.25)';
  ctx.lineWidth = 1.1;
  ctx.stroke();
  // 口鼻
  ctx.fillStyle = '#f3dff0';
  ctx.beginPath();
  ctx.ellipse(10, 3, 5.4, 4.2, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#c99ab8';
  ctx.beginPath();
  ctx.arc(12.4, 2.2, 1.1, 0, TAU);
  ctx.fill();
  // 眼睛（会眨眼）
  const blink = (t * 0.9) % 4 < 0.13;
  ctx.fillStyle = PLUM;
  if (blink) {
    ctx.strokeStyle = PLUM; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(2.6, -1.6); ctx.lineTo(6.4, -1.6); ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.ellipse(4.5, -1.8, 2.1, 2.6, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(5.2, -2.7, 0.8, 0, TAU);
    ctx.fill();
  }
  // 耳朵
  ctx.fillStyle = '#f6ecff';
  ctx.beginPath();
  ctx.moveTo(-3, -7); ctx.lineTo(-0.6, -16); ctx.lineTo(4.2, -7.6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#e5c8ef';
  ctx.beginPath();
  ctx.moveTo(-1.6, -8.6); ctx.lineTo(-0.4, -13.4); ctx.lineTo(2.4, -8.8);
  ctx.closePath();
  ctx.fill();
  // 螺旋角：金色锥形 + 三道缠绕纹
  ctx.save();
  ctx.translate(3, -12);
  ctx.rotate(-0.5);
  ctx.fillStyle = '#ffd76a';
  ctx.beginPath();
  ctx.moveTo(-3.2, 2); ctx.lineTo(0, -19); ctx.lineTo(3.2, 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(190,132,30,0.65)';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  for (let k = 1; k <= 3; k++) {
    const y = 2 - k * 5.2, w = 3.2 - k * 0.72;
    ctx.moveTo(-w, y); ctx.lineTo(w, y - 2.2);
  }
  ctx.stroke();
  // 角尖闪光
  ctx.fillStyle = `rgba(255,255,255,${0.5 + 0.5 * sin(t * 6)})`;
  ctx.beginPath();
  ctx.arc(0, -19, 2.2, 0, TAU);
  ctx.fill();
  ctx.restore();
  // 鬃毛（彩虹，从头后沿脖子铺开）
  for (let i = 0; i < 6; i++) {
    ctx.strokeStyle = RAINBOW[i];
    ctx.lineWidth = 3;
    const sw = sin(tw * 0.55 + i * 0.45) * 2.6;
    ctx.beginPath();
    ctx.moveTo(-4 + i * 0.6, -8 + i * 1.1);
    ctx.quadraticCurveTo(-12 - i * 1.1, 2 + i * 2.4 + sw, -16 - i * 1.5, 14 + i * 2.6 + sw);
    ctx.stroke();
  }
  ctx.restore();

  // 蹄下接地光（踩在彩虹上时特别亮）
  if (!air) {
    const onRB = U.surf === 'rainbow';
    const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, onRB ? 34 : 20);
    rg.addColorStop(0, onRB ? 'rgba(255,235,255,0.6)' : 'rgba(255,255,255,0.28)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(-36, -30, 72, 34);
  }
  ctx.restore();
}

// ------------------------------------------------------------
// UI（屏幕空间）
// ------------------------------------------------------------

function drawHUD(G, t) {
  const pad = 18;
  // 分数
  ctx.textAlign = 'right';
  txt(String(floor(G.score)), VW - pad, pad + 24, 44, '#fff', 'rgba(59,35,82,0.55)', 'right');
  txt(`${floor(W.dist / 10)} m`, VW - pad, pad + 54, 16, 'rgba(255,255,255,0.92)',
    'rgba(59,35,82,0.4)', 'right', 600);
  txt(`BEST ${floor(G.best)}`, VW - pad, pad + 76, 14, 'rgba(255,240,250,0.85)',
    'rgba(59,35,82,0.35)', 'right', 600);

  // 连段倍率
  const m = max(1, U.combo);
  if (m > 1) {
    const pop = 1 + max(0, 0.4 - (t - G.comboT) * 2.2);
    ctx.save();
    ctx.translate(VW - pad - 66, pad + 118);
    ctx.scale(pop, pop);
    ctx.rotate(-0.06);
    const g = ctx.createLinearGradient(-40, 0, 40, 0);
    for (let i = 0; i < 6; i++) g.addColorStop(i / 5, RAINBOW[i]);
    txt(`x${m}`, 0, 0, 40, '#fff', 'rgba(59,35,82,0.7)');
    ctx.globalAlpha = 0.9;
    txt('COMBO', 0, 24, 12, g, null, 'center', 700);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // 彩虹墨条
  const bw = min(280, VW * 0.34), bh = 15, bx = pad, by = VH - pad - bh;
  ctx.fillStyle = 'rgba(40,20,60,0.42)';
  rr(bx - 3, by - 3, bw + 6, bh + 6, 10);
  ctx.fill();
  ctx.save();
  rr(bx, by, bw, bh, 7);
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fillRect(bx, by, bw, bh);
  const frac = clamp(RB.ink / INK_MAX, 0, 1);
  const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
  for (let i = 0; i < 6; i++) g.addColorStop(i / 5, RAINBOW[i]);
  ctx.fillStyle = g;
  ctx.fillRect(bx, by, bw * frac, bh);
  // 墨满时的流光
  if (frac > 0.995) {
    ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.3 * sin(t * 6)})`;
    ctx.fillRect(bx, by, bw, bh);
  }
  ctx.restore();
  if (RB.blocked > 0) {                       // 墨尽闪红
    ctx.strokeStyle = `rgba(255,70,90,${min(1, RB.blocked * 3)})`;
    ctx.lineWidth = 2.5;
    rr(bx - 3, by - 3, bw + 6, bh + 6, 10);
    ctx.stroke();
  }
  txt('RAINBOW INK', bx + 2, by - 11, 11, 'rgba(255,255,255,0.86)', null, 'left', 700);
  txt(RB.gain > 0 ? '+STARDUST' : `${ceil(RB.ink)}%`, bx + bw, by - 11, 11,
    RB.gain > 0 ? '#fff0a8' : 'rgba(255,255,255,0.7)', null, 'right', 700);
}

/** 标题画面：彩虹字 + 逐字波动入场 */
function drawTitle(G, t) {
  ctx.fillStyle = `rgba(30,14,48,${0.34 * min(1, introT * 2)})`;
  ctx.fillRect(0, 0, VW, VH);

  const title = 'RAINBOWHOOF';
  const px = clamp(VW * 0.085, 40, 104);
  ctx.font = `700 ${px}px ${F_DISP}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let w = 0;
  for (const c of title) w += ctx.measureText(c).width + px * 0.035;
  w -= px * 0.035;
  let cx = VW / 2 - w / 2;
  const cy = VH * 0.3;
  for (let i = 0; i < title.length; i++) {
    const c = title[i];
    const delay = i * 0.055;
    const k = clamp((introT - delay) * 4.5, 0, 1);
    const ease = 1 - pow(1 - k, 3);
    const y = cy - (1 - ease) * 60 + sin(t * 1.9 + i * 0.5) * 4;
    ctx.save();
    ctx.translate(cx, y);
    ctx.scale(0.6 + ease * 0.4, 0.6 + ease * 0.4);
    ctx.globalAlpha = ease;
    ctx.lineWidth = px * 0.16;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(59,35,82,0.85)';
    ctx.strokeText(c, 0, 0);
    ctx.fillStyle = RAINBOW[i % 6];
    ctx.fillText(c, 0, 0);
    ctx.restore();
    cx += ctx.measureText(c).width + px * 0.035;
  }
  ctx.globalAlpha = 1;

  // 副标题横条彩虹
  const uw = min(430, VW * 0.5);
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    ctx.strokeStyle = RAINBOW[i];
    ctx.globalAlpha = 0.9 * clamp(introT * 1.4 - 0.5, 0, 1);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(VW / 2 - uw / 2, VH * 0.3 + px * 0.52 + i * 3.2);
    ctx.quadraticCurveTo(VW / 2, VH * 0.3 + px * 0.52 + i * 3.2 - 10, VW / 2 + uw / 2, VH * 0.3 + px * 0.52 + i * 3.2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const sub = clamp(introT * 1.6 - 0.7, 0, 1);
  ctx.globalAlpha = sub;
  txt('drag to paint a rainbow - then gallop on it', VW / 2, VH * 0.3 + px * 0.52 + 42,
    clamp(VW * 0.021, 13, 21), '#fff', 'rgba(59,35,82,0.6)', 'center', 600);
  // 呼吸的"开始"提示
  const pulse = 0.55 + 0.45 * sin(t * 3.2);
  ctx.globalAlpha = sub * (0.55 + pulse * 0.45);
  txt(G.touch ? 'TAP TO START' : 'CLICK  or  SPACE', VW / 2, VH * 0.79,
    clamp(VW * 0.028, 15, 28), '#fff8ff', `rgba(59,35,82,${0.55 * pulse})`);
  ctx.globalAlpha = sub * 0.85;
  txt('chain rainbows mid-air to raise the multiplier   -   stardust refills your ink',
    VW / 2, VH * 0.86, clamp(VW * 0.015, 11, 16), 'rgba(255,244,252,0.95)',
    'rgba(59,35,82,0.4)', 'center', 600);
  ctx.globalAlpha = 1;
}

function drawOver(G, t) {
  const k = clamp(G.overT * 2.4, 0, 1);
  ctx.fillStyle = `rgba(28,12,44,${0.56 * k})`;
  ctx.fillRect(0, 0, VW, VH);
  ctx.globalAlpha = k;
  const px = clamp(VW * 0.062, 30, 76);
  ctx.save();
  ctx.translate(VW / 2, VH * 0.32);
  ctx.scale(1 + (1 - k) * 0.5, 1 + (1 - k) * 0.5);
  tracked('GAME OVER', 0, 0, px * 0.06, px, '#fff', 'rgba(59,35,82,0.9)');
  ctx.restore();

  txt(G.reason === 'spike' ? 'impaled on the spikes' : 'lost to the void', VW / 2, VH * 0.44,
    clamp(VW * 0.022, 13, 22), '#ffd9ec', 'rgba(59,35,82,0.5)', 'center', 600);

  const bw = min(360, VW * 0.5);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  rr(VW / 2 - bw / 2, VH * 0.5, bw, 108, 16);
  ctx.fill();
  txt('SCORE', VW / 2, VH * 0.5 + 22, 13, 'rgba(255,240,250,0.8)', null, 'center', 700);
  txt(String(floor(G.score)), VW / 2, VH * 0.5 + 56, 46, '#fff', 'rgba(59,35,82,0.45)');
  const rec = G.score >= G.best && G.score > 0;
  txt(rec ? '** NEW BEST **' : `BEST ${floor(G.best)}   -   ${floor(W.dist / 10)} m   -   TOP CHAIN x${max(1, U.best)}`,
    VW / 2, VH * 0.5 + 88, 14, rec ? '#ffe27a' : 'rgba(255,240,250,0.85)', null, 'center', 700);

  if (G.overT > 0.6) {
    ctx.globalAlpha = k * (0.6 + 0.4 * sin(t * 3.4));
    txt(G.touch ? 'TAP TO RETRY' : 'CLICK  or  SPACE  to retry', VW / 2, VH * 0.79,
      clamp(VW * 0.024, 14, 24), '#fff8ff', 'rgba(59,35,82,0.5)');
  }
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------
// 主绘制
// ------------------------------------------------------------

/**
 * @param {object} G 游戏状态 {mode, score, best, t, overT, comboT, reason, touch}
 */
export function draw(G) {
  const t = G.t;
  introT = min(introT + G.dt, 99);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawSky(t);
  drawClouds();
  drawHills();

  // ---- 世界空间 ----
  const z = W.cam.zoom;
  ctx.setTransform(DPR * z, 0, 0, DPR * z, -DPR * z * W.cam.x, -DPR * z * W.cam.y);
  drawTerrain();
  drawSpikes();
  drawDust(t);
  drawRainbows(t);
  drawFX();
  drawUnicorn(t);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  drawAbyss();
  if (G.mode === 'title') drawTitle(G, t);
  else {
    drawHUD(G, t);
    if (G.mode === 'gameover') drawOver(G, t);
  }
  drawVignette();

  // 入场白闪（页面刚加载）
  if (introT < 0.5) {
    ctx.fillStyle = `rgba(255,255,255,${(1 - introT * 2) * 0.5})`;
    ctx.fillRect(0, 0, VW, VH);
  }
}

/** 重置入场动画计时（重开一局时用） */
export function resetIntro() { introT = 0; }
