// ============================================================
// lib.js —— 共享数学工具
// 说明：把 Math 的方法解构成裸标识符，压缩后只占 1~2 字节，
//       而 Math.sin 要占 8 字节。js13k 体积敏感，故统一从这里取。
// ============================================================

export const {
  sin, cos, tan, abs, max, min, floor, ceil, round, sqrt, pow,
  atan2, random, hypot, sign, PI,
} = Math;

/** 圆周率 ×2，画整圆时用 */
export const TAU = PI * 2;

/** 夹到 [a,b] */
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 线性插值 */
export const lerp = (a, b, t) => a + (b - a) * t;

/** 指数平滑：与帧率无关的追随（rate 越大追得越快） */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - pow(2, -rate * dt));

/** [a,b) 均匀随机 */
export const rng = (a, b) => a + random() * (b - a);

/** 整数随机 [a,b] */
export const rngi = (a, b) => floor(rng(a, b + 1));

/** 一维值噪声（平滑、确定性），用于地形起伏 */
export function noise1(x) {
  const i = floor(x), t = x - i, s = t * t * (3 - 2 * t);
  return lerp(hash(i), hash(i + 1), s);
}

/** 整数哈希 → [0,1)，确定性且分布均匀 */
export function hash(n) {
  let h = (n | 0) * 374761393;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}
