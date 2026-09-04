// ============================================================
// audio-check.mjs —— BGM 与音效的离线客观分析
// （ZzFX/ZzFXM 的 render 是纯函数，可在 Node 直接跑）
// 检查：时长 / 峰值（削波）/ RMS / DC 偏移 / 每拍能量（静音与密度）
// ============================================================

import { render, RATE } from '../src/vendor/zzfx.js';
import { zzfxM } from '../src/vendor/zzfxm.js';
import { SFX, MUSIC } from '../src/audio.js';

const stats = (data) => {
  let peak = 0, sum = 0, dc = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
    sum += data[i] * data[i];
    dc += data[i];
  }
  return {
    seconds: +(data.length / RATE).toFixed(2),
    peak: +peak.toFixed(3),
    rms: +Math.sqrt(sum / data.length).toFixed(4),
    dc: +(dc / data.length).toFixed(4),
    clipped: +(data.filter((v) => v > 0.999 || v < -0.999).length / RATE * 1000).toFixed(1) + 'ms',
  };
};

console.log('=== BGM（Rainbow Fields）===');
const t0 = Date.now();
const bgm = zzfxM(MUSIC);
const renderMs = Date.now() - t0;
const s = stats(bgm.data);
console.log('  时长 ' + s.seconds + 's | 峰值 ' + s.peak + ' | RMS ' + s.rms + ' | DC ' + s.dc + ' | 削波 ' + s.clipped);
console.log('  离线渲染耗时 ' + renderMs + 'ms（浏览器首次播放前的阻塞量）');

// 每拍（0.15s）能量：找长静音与密度分布
const rowLen = Math.floor(0.15 * RATE);
const rows = Math.floor(bgm.data.length / rowLen);
let silent = 0, energies = [];
for (let r = 0; r < rows; r++) {
  let e = 0;
  for (let i = 0; i < rowLen; i++) e += bgm.data[r * rowLen + i] ** 2;
  e = Math.sqrt(e / rowLen);
  energies.push(e);
  if (e < 0.004) silent++;
}
const avg = energies.reduce((a, b) => a + b, 0) / energies.length;
console.log('  拍能量：均值 ' + avg.toFixed(3) + ' | 最弱 ' + Math.min(...energies).toFixed(4) + ' | 最强 ' + Math.max(...energies).toFixed(3));
console.log('  近静音拍数：' + silent + '/' + rows + (silent > 2 ? ' ⚠ 存在长静音段' : ' ✓ 无长静音'));

// 首尾接缝：循环点两侧能量接近（循环平滑度的粗指标）
const seamA = stats(bgm.data.slice(0, rowLen)).rms;
const seamB = stats(bgm.data.slice(bgm.data.length - rowLen - 1, bgm.data.length - 1)).rms;
console.log('  循环接缝 RMS：首 ' + seamA + ' / 尾 ' + seamB + (Math.abs(seamA - seamB) < 0.02 ? ' ✓ 平滑' : ' — 有差异（尾音余量设计）'));

console.log('\n=== 音效配方（全部离线渲染）===');
let bad = 0;
for (const [name, p] of Object.entries(SFX)) {
  const d = render(p);
  const st = stats(d);
  const finite = d.every(Number.isFinite);
  const ok = finite && st.peak > 0.01 && st.peak <= 1 && st.rms > 0.001;
  if (!ok) bad++;
  console.log('  ' + name.padEnd(7) + ' ' + st.seconds.toFixed(2) + 's  peak ' + String(st.peak).padEnd(5) + ' rms ' + st.rms.toFixed(3) + (finite ? '' : ' ⚠ 含非有限值') + (ok ? '' : ' ⚠'));
}
console.log(bad === 0 ? '\n全部音效渲染正常 ✓' : '\n⚠ ' + bad + ' 条音效异常');
if (bgm.data.every(Number.isFinite) && bad === 0) console.log('BGM 采样全部有限 ✓');
