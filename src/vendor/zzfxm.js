// ============================================================
// zzfxm.js —— 微型 MOD 风格音乐渲染器（ZzFXM 风格，本项目自实现）
//
// 数据结构（与 ZzFXM 一致的三段式）：
//   data = [
//     instruments,   // 乐器数组，每个乐器 = 一组 zzfx 参数（见 vendor/zzfx.js）
//     order,         // 播放顺序：pattern 下标数组，可重复
//     patterns,      // pattern 数组；每个 pattern = track 数组；每个 track = 音符数组
//     rowDuration?   // 可选，每"列"的秒数，默认 0.15s（≈100 BPM 的十六分音符）
//   ]
//
// 音符写法：
//   0 / null / undefined  → 休止符
//   69                    → 简写：用乐器 0 演奏 MIDI 音高 69（A4 = 440Hz）
//   [乐器, 音高, 列偏移, 音量倍率, 持续列数]  → 完整写法（后三项可省略）
//
// 音高 → 频率：f = 440 * 2^((n - 69) / 12)（标准 MIDI 换算）
// 渲染结果是一整块 AudioBuffer，可 loop 播放当 BGM。
// ============================================================

import { pow, floor, max, round } from '../lib.js';
import { render, RATE, toBuffer, playBuffer } from './zzfx.js';

/** 默认每列时长（秒） */
export const ROW = 0.15;

/**
 * 把乐曲渲染成单声道 Float32Array。
 * @returns {{data: Float32Array, duration: number}}
 */
export function zzfxM(data) {
  const instruments = data[0] || [];
  const order = data[1] || [];
  const patterns = data[2] || [];
  const row = data[3] || ROW;

  // 每个 pattern 的行数 = 它最长的 track 长度（至少 1 行）
  const rows = patterns.map((p) => max(1, ...p.map((t) => (t ? t.length : 0))));

  let totalRows = 0;
  for (const pi of order) totalRows += rows[pi] || 1;

  const tail = floor(RATE * 0.3);                       // 尾音余量：够最后一个音释放，又不至于循环时留长静音
  const len = floor(totalRows * row * RATE) + tail;
  const mix = new Float32Array(max(len, 1));

  let cursor = 0;                                        // 当前 pattern 起始行号
  for (const pi of order) {
    const pat = patterns[pi];
    if (!pat) { cursor += 1; continue; }
    for (let t = 0; t < pat.length; t++) {
      const track = pat[t];
      if (!track) continue;
      for (let r = 0; r < track.length; r++) {           // r = pattern 内行号
        const raw = track[r];
        if (!raw) continue;                              // 休止
        const n = typeof raw === 'number' ? [0, raw] : raw;
        const note = n[1];
        if (!note) continue;                             // 音高 0 = 休止
        const inst = (instruments[n[0] | 0] || []).slice();
        const tOff = n[2] || 0;
        const vMul = n[3] === undefined ? 1 : n[3];
        const lenRows = n[4] || 0;

        inst[1] = 440 * pow(2, (note - 69) / 12);        // 音高
        inst[0] = (inst[0] === undefined ? 1 : inst[0]) * vMul;
        if (lenRows > 0) {
          // 拉长延音，让音符铺满 lenRows 列（长音铺底/贝斯用）
          const head = (inst[2] || 0) + (inst[3] || 0);
          const want = lenRows * row;
          inst[4] = max(0, want - head - (inst[5] || 0));
        }

        const s = render(inst);
        const at = round((cursor + r + tOff) * row * RATE);
        for (let i = 0; i < s.length; i++) {
          const j = at + i;
          if (j >= 0 && j < len) mix[j] += s[i];
        }
      }
    }
    cursor += rows[pi] || 1;
  }

  // 软限幅：多轨叠加时避免爆音（tanh 近似，用有理式省字节）
  for (let i = 0; i < len; i++) {
    const v = mix[i];
    mix[i] = v / (1 + (v < 0 ? -v : v) * 0.35);
  }
  return { data: mix, duration: len / RATE };
}

/** 渲染并返回可播放的 AudioBuffer（无声卡时返回 null） */
export function zzfxMBuffer(data) {
  const r = zzfxM(data);
  const buf = toBuffer(r.data);
  return buf ? { buffer: buf, duration: r.duration } : null;
}

/** 渲染 + 立即循环播放，返回 source 节点（可 stop()） */
export function zzfxMPlay(data) {
  const b = zzfxMBuffer(data);
  return b ? playBuffer(b.buffer, true) : null;
}
