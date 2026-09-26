/**
 * Wickmarket: chunk mesher (G2).
 *
 * Pure and three.js-free: turns one 16³ voxel chunk into typed-array mesh data.
 * - face culling against opaque neighbours (and same-id non-opaque neighbours)
 * - classic 3-neighbour per-vertex ambient occlusion with anisotropy-aware quad flip
 * - linear-space vertex colours: block colour × face shade × AO × per-block jitter
 * - two passes: opaque (rgb colours) and transparent WATER / GLASS_WALL (rgba colours)
 * - water surfaces lowered by 0.12, per-vertex `emit` from the EMISSIVE table
 *
 * Vertex positions are emitted in world coordinates, so chunk meshes need no transform.
 * Scratch buffers are module-level and grow geometrically; results are right-sized copies.
 */
import { B, BLOCKS, OPAQUE, TRANSPARENT, EMISSIVE } from '../world/blocks.js';
import { hash3 } from '../core/rng.js';
import { CONFIG } from '../core/config.js';

const AO_LEVELS = new Float32Array([0.55, 0.7, 0.85, 1.0]);
/** Face order: +X, −X, +Y, −Y, +Z, −Z. */
const FACE_SHADE = new Float32Array([0.8, 0.8, 1.0, 0.55, 0.7, 0.7]);
const WATER_TOP_DROP = 0.12;
const JITTER_BASE = 0.92;
const JITTER_AMP = 0.16;
const SPECKLE_SALT = 101;
const MOSS_SIDE_LOAM_MIX = 0.6;
const DEFAULT_SPECKLE = '#F2E6C8';
const FALLBACK_COLOR = '#808080';

const ID_AIR = 0;
const ID_LOAM = B?.LOAM ?? 3;
const ID_MOSS = B?.MOSS ?? 4;
const ID_BUSH_RIPE = B?.BUSH_RIPE ?? 12;
const ID_WATER = B?.WATER ?? 14;

/** Quad corners per face, counter-clockwise seen from outside (outward normal by right-hand rule). */
const FACE_DEFS = [
  { n: [1, 0, 0], v: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { n: [-1, 0, 0], v: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { n: [0, 1, 0], v: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { n: [0, -1, 0], v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [0, 0, 1], v: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { n: [0, 0, -1], v: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];

// ---------------------------------------------------------------------------
// Lookup tables (built lazily so a late-initialised block registry is fine)
// ---------------------------------------------------------------------------

const OPQ = new Uint8Array(256);
const TRN = new Uint8Array(256);
const EMIT = new Float32Array(256);
const ALPHA = new Float32Array(256);
const COLORS = new Float32Array(256 * 3);
const MOSS_SIDE = new Float32Array(3);
const SPECKLE = new Float32Array(3);
let blockTablesReady = false;

function srgbChannelToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexToLinear(hex, out, o) {
  let h = typeof hex === 'string' ? hex.trim().replace('#', '') : '';
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const v = h.length >= 6 ? parseInt(h.slice(0, 6), 16) : NaN;
  const n = Number.isFinite(v) ? v : 0x808080;
  out[o] = srgbChannelToLinear(((n >> 16) & 255) / 255);
  out[o + 1] = srgbChannelToLinear(((n >> 8) & 255) / 255);
  out[o + 2] = srgbChannelToLinear((n & 255) / 255);
}

function ensureBlockTables() {
  if (blockTablesReady) return;
  for (let id = 0; id < 256; id++) {
    const def = BLOCKS?.[id];
    OPQ[id] = OPAQUE?.[id] ? 1 : 0;
    TRN[id] = TRANSPARENT?.[id] ? 1 : 0;
    EMIT[id] = Number(EMISSIVE?.[id]) || 0;
    const a = Number(def?.alpha);
    ALPHA[id] = Number.isFinite(a) && a > 0 ? Math.min(1, a) : 1;
    hexToLinear(def?.color ?? FALLBACK_COLOR, COLORS, id * 3);
  }
  OPQ[ID_AIR] = 0;
  const m = ID_MOSS * 3;
  const l = ID_LOAM * 3;
  for (let c = 0; c < 3; c++) {
    MOSS_SIDE[c] = COLORS[m + c] * (1 - MOSS_SIDE_LOAM_MIX) + COLORS[l + c] * MOSS_SIDE_LOAM_MIX;
  }
  // SPEC-GAP: the block definition shape has no speckle field; read `speckle` if G1 adds one, else §C.4's #F2E6C8.
  hexToLinear(BLOCKS?.[ID_BUSH_RIPE]?.speckle ?? DEFAULT_SPECKLE, SPECKLE, 0);
  blockTablesReady = true;
}

// Per padded-chunk-size face tables (offsets are relative to the cell index in the padded array).
let tableDim = -1;
const FACE_NOFF = new Int32Array(6);
const FACE_AO = new Int32Array(6 * 4 * 3);
const FACE_VX = new Uint8Array(6 * 4 * 3);
const FACE_NORMAL = new Float32Array(6 * 3);

function ensureFaceTables(pd) {
  if (tableDim === pd) return;
  const strideY = pd * pd;
  const strideZ = pd;
  const off = (dx, dy, dz) => dx + dy * strideY + dz * strideZ;
  for (let f = 0; f < 6; f++) {
    const { n, v } = FACE_DEFS[f];
    FACE_NOFF[f] = off(n[0], n[1], n[2]);
    FACE_NORMAL[f * 3] = n[0];
    FACE_NORMAL[f * 3 + 1] = n[1];
    FACE_NORMAL[f * 3 + 2] = n[2];
    const axis = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2;
    const t1 = axis === 0 ? 1 : 0;
    const t2 = axis === 2 ? 1 : 2;
    for (let j = 0; j < 4; j++) {
      const c = v[j];
      const d1 = [0, 0, 0];
      const d2 = [0, 0, 0];
      d1[t1] = c[t1] ? 1 : -1;
      d2[t2] = c[t2] ? 1 : -1;
      const k = (f * 4 + j) * 3;
      FACE_AO[k] = off(n[0] + d1[0], n[1] + d1[1], n[2] + d1[2]);
      FACE_AO[k + 1] = off(n[0] + d2[0], n[1] + d2[1], n[2] + d2[2]);
      FACE_AO[k + 2] = off(n[0] + d1[0] + d2[0], n[1] + d1[1] + d2[1], n[2] + d1[2] + d2[2]);
      FACE_VX[k] = c[0];
      FACE_VX[k + 1] = c[1];
      FACE_VX[k + 2] = c[2];
    }
  }
  tableDim = pd;
}

// Columns outside the bell jar are never drawn (worldgen may leave bedrock in the square's corners).
let colMask = null;
let colMaskKey = '';

function columnMask(SX, SZ) {
  const W = CONFIG?.world ?? {};
  const cxw = W.CX ?? SX / 2;
  const czw = W.CZ ?? SZ / 2;
  const jarR = CONFIG?.render?.jar?.radius ?? 57;
  // A cell must fit inside the glass: centre distance + half-diagonal ≤ jar radius.
  const r = Math.max((W.RADIUS ?? 54) + 0.5, jarR - 0.75);
  const key = `${SX}|${SZ}|${cxw}|${czw}|${r}`;
  if (colMask && colMaskKey === key) return colMask;
  colMask = new Uint8Array(SX * SZ);
  const r2 = r * r;
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      const dx = x + 0.5 - cxw;
      const dz = z + 0.5 - czw;
      colMask[x + SX * z] = dx * dx + dz * dz <= r2 ? 1 : 0;
    }
  }
  colMaskKey = key;
  return colMask;
}

// ---------------------------------------------------------------------------
// Growable scratch buffers
// ---------------------------------------------------------------------------

function createScratch(colorStride) {
  return { stride: colorStride, cap: 0, quads: 0, pos: null, nor: null, col: null, emit: null, idx: null };
}

function growArray(old, Ctor, length) {
  const next = new Ctor(length);
  if (old) next.set(old);
  return next;
}

function ensureCapacity(buf, quads) {
  if (quads <= buf.cap) return;
  let cap = Math.max(1024, buf.cap);
  while (cap < quads) cap *= 2;
  buf.pos = growArray(buf.pos, Float32Array, cap * 12);
  buf.nor = growArray(buf.nor, Float32Array, cap * 12);
  buf.col = growArray(buf.col, Float32Array, cap * 4 * buf.stride);
  buf.emit = growArray(buf.emit, Float32Array, cap * 4);
  buf.idx = growArray(buf.idx, Uint32Array, cap * 6);
  buf.cap = cap;
}

const SCRATCH_OPAQUE = createScratch(3);
const SCRATCH_TRANSPARENT = createScratch(4);
let pad = new Uint8Array(18 * 18 * 18);

function finish(buf) {
  const vc = buf.quads * 4;
  return {
    positions: buf.pos ? buf.pos.slice(0, vc * 3) : new Float32Array(0),
    normals: buf.nor ? buf.nor.slice(0, vc * 3) : new Float32Array(0),
    colors: buf.col ? buf.col.slice(0, vc * buf.stride) : new Float32Array(0),
    emit: buf.emit ? buf.emit.slice(0, vc) : new Float32Array(0),
    indices: buf.idx ? buf.idx.slice(0, buf.quads * 6) : new Uint32Array(0),
    vertexCount: vc,
  };
}

// ---------------------------------------------------------------------------
// Meshing
// ---------------------------------------------------------------------------

/**
 * Copies the chunk plus a one-cell border into `pad` (x fastest, then z, then y).
 * Outside the world, and outside the jar footprint, cells read as AIR.
 * SPEC-GAP: below y=0 also reads as AIR (not BEDROCK) so the terrain shell is closed
 * underneath; the cutaway's back-face caps rely on a watertight surface.
 * @returns {number} count of non-air cells inside the chunk proper
 */
function fillPadded(world, x0, y0, z0, S, pd) {
  const SX = world.SX ?? CONFIG.world.SX;
  const SY = world.SY ?? CONFIG.world.SY;
  const SZ = world.SZ ?? CONFIG.world.SZ;
  const data = world.data;
  const direct = data && data.length >= SX * SY * SZ;
  const mask = columnMask(SX, SZ);
  const layer = pd * pd;
  let p = 0;
  let solid = 0;
  for (let ly = -1; ly <= S; ly++) {
    const wy = y0 + ly;
    if (wy < 0 || wy >= SY) {
      pad.fill(ID_AIR, p, p + layer);
      p += layer;
      continue;
    }
    const inY = ly >= 0 && ly < S;
    for (let lz = -1; lz <= S; lz++) {
      const wz = z0 + lz;
      if (wz < 0 || wz >= SZ) {
        pad.fill(ID_AIR, p, p + pd);
        p += pd;
        continue;
      }
      const inYZ = inY && lz >= 0 && lz < S;
      const row = SX * (wz + SZ * wy);
      const maskRow = SX * wz;
      for (let lx = -1; lx <= S; lx++, p++) {
        const wx = x0 + lx;
        let id = ID_AIR;
        if (wx >= 0 && wx < SX && mask[maskRow + wx] === 1) {
          id = direct ? data[row + wx] : (world.get(wx, wy, wz) | 0) & 255;
        }
        pad[p] = id;
        if (id !== ID_AIR && inYZ && lx >= 0 && lx < S) solid++;
      }
    }
  }
  return solid;
}

/**
 * Emits one quad for face `f` of the cell at padded index `p` / world cell (wx,wy,wz).
 */
function emitFace(buf, f, p, wx, wy, wz, id, jitter, lowerTop) {
  if (buf.quads >= buf.cap) ensureCapacity(buf, buf.quads + 1);
  const q = buf.quads++;
  const v0 = q * 4;
  const pos = buf.pos;
  const nor = buf.nor;
  const col = buf.col;
  const emit = buf.emit;
  const stride = buf.stride;
  const shade = FACE_SHADE[f] * jitter;

  let br;
  let bg;
  let bb;
  if (id === ID_MOSS && f !== 2 && f !== 3) {
    br = MOSS_SIDE[0]; bg = MOSS_SIDE[1]; bb = MOSS_SIDE[2];
  } else {
    const ci = id * 3;
    br = COLORS[ci]; bg = COLORS[ci + 1]; bb = COLORS[ci + 2];
  }
  const speckled = id === ID_BUSH_RIPE;
  const e = EMIT[id];
  const alpha = ALPHA[id];
  const nx = FACE_NORMAL[f * 3];
  const ny = FACE_NORMAL[f * 3 + 1];
  const nz = FACE_NORMAL[f * 3 + 2];

  let a0 = 3;
  let a1 = 3;
  let a2 = 3;
  let a3 = 3;
  for (let j = 0; j < 4; j++) {
    const k = (f * 4 + j) * 3;
    const s1 = OPQ[pad[p + FACE_AO[k]]];
    const s2 = OPQ[pad[p + FACE_AO[k + 1]]];
    const cr = OPQ[pad[p + FACE_AO[k + 2]]];
    const ao = s1 && s2 ? 0 : 3 - (s1 + s2 + cr);
    if (j === 0) a0 = ao;
    else if (j === 1) a1 = ao;
    else if (j === 2) a2 = ao;
    else a3 = ao;

    const ix = wx + FACE_VX[k];
    const iy = wy + FACE_VX[k + 1];
    const iz = wz + FACE_VX[k + 2];
    const v = v0 + j;
    const o3 = v * 3;
    pos[o3] = ix;
    pos[o3 + 1] = lowerTop && FACE_VX[k + 1] === 1 ? iy - WATER_TOP_DROP : iy;
    pos[o3 + 2] = iz;
    nor[o3] = nx;
    nor[o3 + 1] = ny;
    nor[o3 + 2] = nz;

    let r = br;
    let g = bg;
    let b = bb;
    if (speckled && hash3(ix, iy, iz, SPECKLE_SALT) > 0.5) {
      r = SPECKLE[0]; g = SPECKLE[1]; b = SPECKLE[2];
    }
    const s = shade * AO_LEVELS[ao];
    const oc = v * stride;
    col[oc] = r * s;
    col[oc + 1] = g * s;
    col[oc + 2] = b * s;
    if (stride === 4) col[oc + 3] = alpha;
    emit[v] = e;
  }

  // Anisotropy fix: split along the diagonal whose corners are brighter in sum.
  const idx = buf.idx;
  const ib = q * 6;
  if (a0 + a2 < a1 + a3) {
    idx[ib] = v0 + 1; idx[ib + 1] = v0 + 2; idx[ib + 2] = v0 + 3;
    idx[ib + 3] = v0 + 1; idx[ib + 4] = v0 + 3; idx[ib + 5] = v0;
  } else {
    idx[ib] = v0; idx[ib + 1] = v0 + 1; idx[ib + 2] = v0 + 2;
    idx[ib + 3] = v0; idx[ib + 4] = v0 + 2; idx[ib + 5] = v0 + 3;
  }
}

/**
 * Meshes one chunk.
 * @param {object} world World (reads `data`, `SX/SY/SZ`, `CHUNK`; falls back to `get()` without `data`)
 * @param {number} cx chunk x index
 * @param {number} cy chunk y index
 * @param {number} cz chunk z index
 * @returns {{opaque: MeshData, transparent: MeshData}} where
 *   MeshData = {positions, normals, colors (rgb opaque / rgba transparent), emit, indices: Uint32Array, vertexCount}
 */
export function meshChunk(world, cx, cy, cz) {
  ensureBlockTables();
  const S = world?.CHUNK ?? CONFIG.world.CHUNK ?? 16;
  const pd = S + 2;
  if (pad.length !== pd * pd * pd) pad = new Uint8Array(pd * pd * pd);
  ensureFaceTables(pd);

  const O = SCRATCH_OPAQUE;
  const T = SCRATCH_TRANSPARENT;
  O.quads = 0;
  T.quads = 0;
  if (!world) return { opaque: finish(O), transparent: finish(T) };

  const x0 = cx * S;
  const y0 = cy * S;
  const z0 = cz * S;
  if (fillPadded(world, x0, y0, z0, S, pd) === 0) {
    return { opaque: finish(O), transparent: finish(T) };
  }

  const layer = pd * pd;
  const up = FACE_NOFF[2];
  for (let ly = 0; ly < S; ly++) {
    const wy = y0 + ly;
    for (let lz = 0; lz < S; lz++) {
      const wz = z0 + lz;
      let p = 1 + pd * (lz + 1) + layer * (ly + 1);
      for (let lx = 0; lx < S; lx++, p++) {
        const id = pad[p];
        if (id === ID_AIR) continue;
        const buf = TRN[id] ? T : O;
        const lowerTop = id === ID_WATER && pad[p + up] !== ID_WATER;
        let jitter = -1;
        for (let f = 0; f < 6; f++) {
          const nid = pad[p + FACE_NOFF[f]];
          if (nid === id || OPQ[nid] === 1) continue;
          const wx = x0 + lx;
          if (jitter < 0) jitter = JITTER_BASE + JITTER_AMP * hash3(wx, wy, wz);
          emitFace(buf, f, p, wx, wy, wz, id, jitter, lowerTop);
        }
      }
    }
  }
  return { opaque: finish(O), transparent: finish(T) };
}
