// ============================================================
// zzfx.js —— 微型程序化音效合成器（ZzFX 风格，本项目自实现）
//
// 为什么自己写：js13kGames 禁止任何运行时外部资源，而 ZzFX 本身就是
// "用 WebAudio 现场合成波形"，不加载任何音频文件，完全合规。
// 这里给出一套与 ZzFX v1.3 参数顺序兼容的实现，方便直接套用社区音效配方。
//
// 参数顺序（全部可省略，时间单位 = 秒）：
//   0  volume        总音量 0~1
//   1  frequency     基频 Hz
//   2  attack        起音（0 → 峰值）
//   3  decay         衰减（峰值 → sustainVolume）
//   4  sustain       延音保持时长
//   5  release       释放（→ 0）
//   6  shape         波形 0 正弦 1 方波 2 锯齿 3 三角 4 正切(刺耳) 5 半正弦脉冲
//   7  shapeCurve    波形整形指数，1 = 原样，>1 更"厚"，<1 更"扁"
//   8  slide         滑音速率 Hz/秒（负 = 下滑）
//   9  deltaSlide    滑音加速度 Hz/秒²
//  10  pitchJump     音高跳变量 Hz（正负皆可）
//  11  pitchJumpTime 跳变发生在第几秒
//  12  repeatTime    每 N 秒重启一次包络+相位（机关枪/引擎声）
//  13  noise         白噪声混入比例 0~1
//  14  modulation    颤音/调制频率 Hz（0 = 关闭）
//  15  bitCrush      每 N 个采样保持一次（0 = 关闭），做出 chiptune 颗粒感
//  16  delay         起声延迟（秒）
//  17  sustainVolume 延音段音量倍率 0~1
//  18  volumeRandom  音量随机抖动幅度
//  19  pitchRandom   频率随机抖动幅度 Hz
//  20  pan           声像 -1(左) ~ 1(右)
// ============================================================

import { sin, cos, abs, max, min, floor, pow, random, sign, TAU } from '../lib.js';

/** 合成采样率（与 ZzFX 一致；浏览器会自动重采样到设备采样率） */
export const RATE = 44100;

/**
 * 全局音频状态。ctx 延迟到首次用户手势时创建，避免浏览器
 * "AudioContext was not allowed to start" 警告。
 */
export const AX = { ctx: null, muted: false, volume: 0.45, master: null };

/** 取得（必要时创建）AudioContext 与总线增益 */
export function ctx() {
  if (!AX.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;                       // 极端环境无声卡：静默降级
    AX.ctx = new AC();
    AX.master = AX.ctx.createGain();
    AX.master.gain.value = AX.volume;
    AX.master.connect(AX.ctx.destination);
  }
  if (AX.ctx.state === 'suspended') AX.ctx.resume();
  return AX.ctx;
}

/** 设置全局音量 / 静音 */
export function setVolume(v, muted) {
  AX.volume = v;
  if (muted !== undefined) AX.muted = muted;
  if (AX.master) AX.master.gain.value = AX.muted ? 0 : v;
}

/**
 * 纯离线合成：把一组参数渲染成 Float32Array（不播放）。
 * zzfx() 与 zzfxM() 都复用它，避免重复实现 DSP。
 */
export function render(p) {
  const R = RATE;
  const volume = p[0] === undefined ? 1 : p[0];
  const frequency = p[1] === undefined ? 220 : p[1];
  const attack = p[2] || 0, decay = p[3] || 0, sustain = p[4] || 0, release = p[5] || 0;
  const shape = p[6] | 0, shapeCurve = p[7] === undefined ? 1 : p[7];
  const slide = p[8] || 0, deltaSlide = p[9] || 0;
  const pitchJump = p[10] || 0, pitchJumpTime = p[11] || 0;
  const repeatTime = p[12] || 0, noise = p[13] || 0, modulation = p[14] || 0;
  const bitCrush = p[15] | 0, delay = p[16] || 0;
  const sustainVolume = p[17] === undefined ? 1 : p[17];
  const volumeRandom = p[18] || 0, pitchRandom = p[19] || 0;

  // 随机抖动：让同一配方连续触发时不呆板
  const vol = max(0, volume + volumeRandom * (random() * 2 - 1));
  const frq = max(1, frequency + pitchRandom * (random() * 2 - 1));
  if (!vol) return new Float32Array(0);

  const A = max(1, floor(attack * R));
  const D = max(1, floor(decay * R));
  const S = max(0, floor(sustain * R));
  const L = max(1, floor(release * R));
  const REP = floor(repeatTime * R);
  const lead = floor(delay * R);
  const body = A + D + S + L;
  const out = new Float32Array(lead + body + 8);

  let phase = 0;      // 振荡相位（单位：周期）
  let modPhase = 0;   // 调制相位
  let f = frq;        // 当前频率
  let sl = slide;     // 当前滑音速率
  let crushHold = 0, crushTimer = 0;
  const jumpAt = pitchJumpTime ? floor(pitchJumpTime * R) : 0;

  for (let i = 0; i < body; i++) {
    // repeatTime：整段包络/相位按周期重启
    const j = REP > 0 ? i % REP : i;

    // --- 频率演化 ---
    if (j === 0) { phase = 0; f = frq; sl = slide; }
    f += sl / R;
    sl += deltaSlide / R;
    if (jumpAt && j === jumpAt) f += pitchJump;
    f = max(1, f);
    phase += f / R;
    if (modulation) modPhase += modulation / R;

    // --- 包络（attack → decay → sustain → release）---
    let env;
    if (j < A) env = (j / A) * vol;
    else if (j < A + D) env = vol * (1 - ((j - A) / D) * (1 - sustainVolume));
    else if (j < A + D + S) env = vol * sustainVolume;
    else env = vol * sustainVolume * (1 - (j - A - D - S) / L);

    // --- 波形 ---
    const ph = modulation ? phase + 0.35 * sin(modPhase * TAU) : phase;
    const t = ph - floor(ph);                 // 0~1 周期内位置
    let s;
    switch (shape) {
      case 1: s = t < 0.5 ? 1 : -1; break;                            // 方波
      case 2: s = t * 2 - 1; break;                                   // 锯齿
      case 3: s = abs(t * 4 - 2) - 1; break;                          // 三角
      case 4: s = sin(t * TAU) / max(0.12, cos(t * TAU)); break;      // 正切（限幅，刺耳铜管）
      case 5: s = max(0, sin(t * TAU)) * 2 - 1; break;                // 半正弦脉冲
      default: s = sin(t * TAU);                                      // 正弦
    }
    s = s < -1 ? -1 : s > 1 ? 1 : s;                                  // 硬限幅
    if (shapeCurve !== 1) s = sign(s) * pow(abs(s), shapeCurve);      // 波形整形

    // --- 噪声混合 ---
    if (noise) s = s * (1 - noise) + (random() * 2 - 1) * noise;

    // --- 位深压碎（每 bitCrush 个采样保持一次）---
    if (bitCrush > 1) {
      if (++crushTimer >= bitCrush) { crushTimer = 0; crushHold = s; }
      s = crushHold;
    }

    out[lead + i] = s * env;
  }
  return out;
}

/**
 * 合成并立即播放一个音效。返回 AudioBufferSourceNode（可用于 stop）。
 */
export function zzfx(...p) {
  const C = ctx();
  if (!C || AX.muted) return null;
  const data = render(p);
  if (!data.length) return null;
  const buf = C.createBuffer(1, data.length, RATE);
  buf.getChannelData(0).set(data);
  const src = C.createBufferSource();
  src.buffer = buf;
  let node = src;
  const pan = p[20] || 0;
  if (pan && C.createStereoPanner) {
    const sp = C.createStereoPanner();
    sp.pan.value = max(-1, min(1, pan));
    src.connect(sp);
    node = sp;
  }
  node.connect(AX.master);
  src.start(C.currentTime);
  return src;
}

/** 把 Float32Array 数据塞进 AudioBuffer（zzfxM 渲染用） */
export function toBuffer(data) {
  const C = ctx();
  if (!C) return null;
  const buf = C.createBuffer(1, data.length, RATE);
  buf.getChannelData(0).set(data);
  return buf;
}

/** 播放一个已渲染的 AudioBuffer，可循环 */
export function playBuffer(buf, loop) {
  const C = ctx();
  if (!C || !buf || AX.muted) return null;
  const src = C.createBufferSource();
  src.buffer = buf;
  src.loop = !!loop;
  src.connect(AX.master);
  src.start(C.currentTime);
  return src;
}
