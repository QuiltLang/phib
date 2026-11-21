// Noise for land: pure functions of where a cell is and a salt, so land
// can grow in any order and come out the same (Automata's, kept as they
// were). hash is a number in [0, 1); vnoise and blob are smooth noise, a
// value in [0, 1) that changes about once every `scale` cells; lattice is
// the open world's smooth noise, a table that repeats every 256 × scale.

export function hash(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

export function vnoise(x, y, scale, s) {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = smooth(fx - x0);
  const ty = smooth(fy - y0);
  const a = hash(x0, y0, s);
  const b = hash(x0 + 1, y0, s);
  const c = hash(x0, y0 + 1, s);
  const e = hash(x0 + 1, y0 + 1, s);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + e) * tx * ty;
}

// Lumpier: two vnoises, one finer.
export const blob = (x, y, scale, s) => vnoise(x, y, scale, s) * 0.7 + vnoise(x, y, scale / 2.7, s + 1) * 0.3;

// mulberry32: a seeded stream of numbers in [0, 1).
export function mulberry(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function lattice(seed, scale) {
  const r = mulberry(seed >>> 0 || 1);
  const n = 256;
  const L = Float32Array.from({ length: n * n }, r);
  const at = (x, y) => L[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
  return (x, y) => {
    const fx = x / scale;
    const fy = y / scale;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return a + (b - a) * ty;
  };
}
