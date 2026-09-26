// Seeded randomness and noise (SPEC §C.4 G1 rng.js). No imports, no DOM: runs in Node and the browser.

/**
 * @typedef {object} Rng
 * @property {() => number} next               uniform [0,1)
 * @property {(lo:number, hi:number) => number} int   integer in [lo, hi] inclusive
 * @property {(lo:number, hi:number) => number} range uniform float in [lo, hi)
 * @property {<T>(arr:T[]) => T} pick
 * @property {(p:number) => boolean} chance
 * @property {() => number} normal             standard normal
 * @property {(salt:number) => Rng} fork       independent stream derived from this one
 */

/** mulberry32 PRNG. @param {number} seed uint32 @returns {Rng} */
export function createRng(seed) {
  let s = seed >>> 0;
  let spare = null;
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    range: (lo, hi) => lo + next() * (hi - lo),
    pick: arr => arr[Math.floor(next() * arr.length)],
    chance: p => next() < p,
    normal() {
      if (spare !== null) { const v = spare; spare = null; return v; }
      let u = 0, v = 0, r = 0;
      do { u = next() * 2 - 1; v = next() * 2 - 1; r = u * u + v * v; } while (r >= 1 || r === 0);
      const k = Math.sqrt((-2 * Math.log(r)) / r);
      spare = v * k;
      return u * k;
    },
    fork: salt => createRng(mix32((s ^ Math.imul((salt | 0) + 0x9E3779B9, 0x85EBCA6B)) >>> 0)),
    /** Snapshot for save files: [state, cached normal or null]. */
    getState: () => [s, spare],
    /** Continue exactly where a getState() snapshot left off. */
    setState(st) {
      if (!Array.isArray(st)) return;
      s = (Number(st[0]) >>> 0);
      spare = typeof st[1] === 'number' && Number.isFinite(st[1]) ? st[1] : null;
    },
  };
}

function mix32(h) {
  h = Math.imul(h ^ (h >>> 16), 0x7FEB352D);
  h = Math.imul(h ^ (h >>> 15), 0x846CA68B);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Stateless integer hash of a lattice point → [0,1). */
export function hash3(x, y, z, salt = 0) {
  let h = Math.imul(x | 0, 0x27D4EB2D) ^ Math.imul(y | 0, 0x165667B1) ^ Math.imul(z | 0, 0x9E3779B1) ^ Math.imul(salt | 0, 0x85EBCA77);
  return mix32(h >>> 0) / 4294967296;
}

/** FNV-1a string hash → uint32. */
export function hashString(str) {
  let h = 0x811C9DC5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h >>> 0);
}

/**
 * Parse a user/URL seed. Hex is the canonical display form ("5a1f", optional 0x prefix);
 * a leading "d" marks decimal ("d1234"); any other text is hashed, so words make valid seeds.
 */
export function parseSeed(str) {
  const s = String(str ?? '').trim().toLowerCase();
  if (/^(0x)?[0-9a-f]{1,8}$/.test(s)) return parseInt(s.replace(/^0x/, ''), 16) >>> 0;
  if (/^d\d{1,10}$/.test(s)) return (Number(s.slice(1)) % 4294967296) >>> 0;
  return hashString(s);
}

/** A fresh random seed (Math.random: re-rolls only, never sim logic). */
export function randomSeed() {
  return (Math.floor(Math.random() * 0xFFFF_FFFF) ^ (Date.now() & 0xFFFF)) >>> 0 || 0x5A1F;
}

// ---------------------------------------------------------------------------
// Simplex noise (2D + 3D), seeded permutation table
// ---------------------------------------------------------------------------

const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

/**
 * @param {number} seed
 * @returns {{noise2:(x:number,z:number)=>number, noise3:(x:number,y:number,z:number)=>number,
 *   fbm2:(x:number,z:number,oct?:number)=>number, ridged2:(x:number,z:number,oct?:number)=>number}}
 */
export function createNoise(seed) {
  const rng = createRng((seed ^ 0x51A7E5ED) >>> 0);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; permMod12[i] = perm[i] % 12; }

  function noise2(xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = permMod12[ii + perm[jj]] * 3; t0 *= t0; n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = permMod12[ii + i1 + perm[jj + j1]] * 3; t1 *= t1; n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = permMod12[ii + 1 + perm[jj + 1]] * 3; t2 *= t2; n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2); }
    return 70 * n;
  }

  function noise3(xin, yin, zin) {
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) { const g = permMod12[ii + perm[jj + perm[kk]]] * 3; t0 *= t0; n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0); }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) { const g = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3; t1 *= t1; n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1); }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) { const g = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3; t2 *= t2; n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2); }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) { const g = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3; t3 *= t3; n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3); }
    return 32 * n;
  }

  /** Fractal Brownian motion, roughly [-1,1]. */
  function fbm2(x, z, oct = 4) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += amp * noise2(x * freq, z * freq);
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0,1]: sharp crests where the noise crosses zero. */
  function ridged2(x, z, oct = 4) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < oct; o++) {
      const r = 1 - Math.abs(noise2(x * freq + o * 17.3, z * freq - o * 9.1));
      sum += amp * r * r;
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return Math.min(1, Math.max(0, sum / norm));
  }

  return { noise2, noise3, fbm2, ridged2 };
}
