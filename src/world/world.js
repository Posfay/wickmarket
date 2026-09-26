// Voxel storage, queries, dirty-chunk tracking and picking (SPEC §C.4 G1 world.js).
import { CONFIG } from '../core/config.js';
import { B, SOLID } from './blocks.js';

/** Block ids with per-chunk counts, so resource searches skip empty chunks. */
export const TRACKED = [B.QUARTZ, B.AMBER, B.BUSH_RIPE, B.BUSH_BARE, B.PEAT, B.WATER, B.WAX_PUDDLE, B.SAPLING, B.LOG];

export class World {
  /** @param {typeof CONFIG} config */
  constructor(config = CONFIG) {
    const w = config.world;
    this.SX = w.SX; this.SY = w.SY; this.SZ = w.SZ;
    this.CHUNK = w.CHUNK;
    this.CX = w.CX; this.CZ = w.CZ; this.RADIUS = w.RADIUS;
    this.WATER_LEVEL = w.WATER_LEVEL;
    this.NCX = Math.ceil(this.SX / this.CHUNK);
    this.NCY = Math.ceil(this.SY / this.CHUNK);
    this.NCZ = Math.ceil(this.SZ / this.CHUNK);
    this.chunkCount = this.NCX * this.NCY * this.NCZ;

    this.data = new Uint8Array(this.SX * this.SY * this.SZ);
    this.heightmap = new Int16Array(this.SX * this.SZ).fill(-1);
    this.footfall = new Uint16Array(this.SX * this.SZ);
    this.version = 0;
    /** @type {Set<number>} */
    this.dirty = new Set();

    this.mask = new Uint8Array(this.SX * this.SZ);
    const r2 = this.RADIUS * this.RADIUS;
    for (let z = 0; z < this.SZ; z++) {
      for (let x = 0; x < this.SX; x++) {
        const dx = x + 0.5 - this.CX, dz = z + 0.5 - this.CZ;
        if (dx * dx + dz * dz <= r2) this.mask[x + this.SX * z] = 1;
      }
    }

    this.trackIndex = new Int8Array(256).fill(-1);
    TRACKED.forEach((id, i) => { this.trackIndex[id] = i; });
    this.counts = new Int32Array(TRACKED.length * this.chunkCount);
    this.totals = new Int32Array(TRACKED.length);

    this._cand = [];            // scratch for findNearest chunk ordering
  }

  // ---------------------------------------------------------------------------
  // Basic queries
  // ---------------------------------------------------------------------------

  inBounds(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.SX && y < this.SY && z < this.SZ;
  }

  isInside(x, z) {
    return x >= 0 && z >= 0 && x < this.SX && z < this.SZ && this.mask[x + this.SX * z] === 1;
  }

  index(x, y, z) { return x + this.SX * (z + this.SZ * y); }

  columnIndex(x, z) { return x + this.SX * z; }

  /** Block id; AIR out of bounds above ground, BEDROCK below y=0. */
  get(x, y, z) {
    if (y < 0) return B.BEDROCK;
    if (x < 0 || z < 0 || x >= this.SX || y >= this.SY || z >= this.SZ) return B.AIR;
    return this.data[x + this.SX * (z + this.SZ * y)];
  }

  /**
   * Write a block. Marks affected chunks dirty, maintains the heightmap and tracked counts,
   * bumps `version`. Emits nothing.
   * @returns {boolean} whether the cell changed
   */
  set(x, y, z, id) {
    if (!this.inBounds(x, y, z)) return false;
    const i = x + this.SX * (z + this.SZ * y);
    const old = this.data[i];
    if (old === id) return false;
    this.data[i] = id;

    const ck = this.chunkKey((x / this.CHUNK) | 0, (y / this.CHUNK) | 0, (z / this.CHUNK) | 0);
    const to = this.trackIndex[old], tn = this.trackIndex[id];
    if (to >= 0) { this.counts[to * this.chunkCount + ck]--; this.totals[to]--; }
    if (tn >= 0) { this.counts[tn * this.chunkCount + ck]++; this.totals[tn]++; }

    const col = x + this.SX * z;
    if (SOLID[id]) {
      if (y > this.heightmap[col]) this.heightmap[col] = y;
    } else if (y === this.heightmap[col]) {
      let yy = y - 1;
      while (yy >= 0 && !SOLID[this.data[x + this.SX * (z + this.SZ * yy)]]) yy--;
      this.heightmap[col] = yy;
    }

    this._markCellDirty(x, y, z);
    this.version++;
    return true;
  }

  isSolidAt(x, y, z) { return SOLID[this.get(x, y, z)] === 1; }

  /** Not solid and not water. */
  isPassableAt(x, y, z) {
    const id = this.get(x, y, z);
    return SOLID[id] === 0 && id !== B.WATER;
  }

  /** Inside the island, solid floor at y−1, passable at y and y+1. */
  isWalkable(x, y, z) {
    if (!this.isInside(x, z) || y < 1 || y >= this.SY - 1) return false;
    const base = x + this.SX * z, layer = this.SX * this.SZ;
    if (!SOLID[this.data[base + layer * (y - 1)]]) return false;
    const a = this.data[base + layer * y], b = this.data[base + layer * (y + 1)];
    return SOLID[a] === 0 && a !== B.WATER && SOLID[b] === 0 && b !== B.WATER;
  }

  /** Feet level of the column's top solid block (heightmap + 1). */
  surfaceY(x, z) {
    if (x < 0 || z < 0 || x >= this.SX || z >= this.SZ) return 0;
    return this.heightmap[x + this.SX * z] + 1;
  }

  topBlock(x, z) {
    if (x < 0 || z < 0 || x >= this.SX || z >= this.SZ) return B.AIR;
    const h = this.heightmap[x + this.SX * z];
    return h < 0 ? B.AIR : this.data[x + this.SX * (z + this.SZ * h)];
  }

  /** Open sky above (y above the column's top solid block). */
  isExposed(x, y, z) {
    if (x < 0 || z < 0 || x >= this.SX || z >= this.SZ) return true;
    return y > this.heightmap[x + this.SX * z];
  }

  // ---------------------------------------------------------------------------
  // Tracked-resource search
  // ---------------------------------------------------------------------------

  /** Total count of a tracked block (O(1)); falls back to a full scan for untracked ids. */
  countBlocks(id) {
    const t = this.trackIndex[id];
    if (t >= 0) return this.totals[t];
    let n = 0;
    for (let i = 0; i < this.data.length; i++) if (this.data[i] === id) n++;
    return n;
  }

  /** Nearest cell holding `id` within Euclidean `maxDist`, optionally filtered by pred(x,y,z). */
  findNearest(id, x, y, z, maxDist = Infinity, pred = null) {
    const r = this.findNearestK(id, x, y, z, 1, maxDist, pred);
    return r.length ? { x: r[0].x, y: r[0].y, z: r[0].z } : null;
  }

  /**
   * Up to k nearest cells holding `id`, sorted by distance: [{x,y,z,d}].
   * Only visits chunks whose tracked count is > 0, nearest chunk first, and stops once the
   * next chunk cannot beat the current k-th best.
   */
  findNearestK(id, x, y, z, k = 1, maxDist = Infinity, pred = null) {
    const t = this.trackIndex[id];
    if (t < 0 || this.totals[t] === 0 || k <= 0) return [];
    const C = this.CHUNK, cand = this._cand;
    cand.length = 0;
    const base = t * this.chunkCount;
    for (let key = 0; key < this.chunkCount; key++) {
      if (this.counts[base + key] <= 0) continue;
      const cx = key % this.NCX, cz = ((key / this.NCX) | 0) % this.NCZ, cy = (key / (this.NCX * this.NCZ)) | 0;
      const dx = axisGap(x, cx * C, cx * C + C - 1), dy = axisGap(y, cy * C, cy * C + C - 1), dz = axisGap(z, cz * C, cz * C + C - 1);
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d <= maxDist) cand.push(d, key);
    }
    const order = [];
    for (let i = 0; i < cand.length; i += 2) order.push(i);
    order.sort((a, b) => cand[a] - cand[b]);

    const best = [];                       // sorted [{x,y,z,d}] length ≤ k
    const layer = this.SX * this.SZ;
    for (const oi of order) {
      const bound = cand[oi];
      if (best.length === k && bound > best[k - 1].d) break;
      const key = cand[oi + 1];
      const cx = key % this.NCX, cz = ((key / this.NCX) | 0) % this.NCZ, cy = (key / (this.NCX * this.NCZ)) | 0;
      const x0 = cx * C, y0 = cy * C, z0 = cz * C;
      const x1 = Math.min(this.SX, x0 + C), y1 = Math.min(this.SY, y0 + C), z1 = Math.min(this.SZ, z0 + C);
      for (let yy = y0; yy < y1; yy++) {
        for (let zz = z0; zz < z1; zz++) {
          let i = x0 + this.SX * zz + layer * yy;
          for (let xx = x0; xx < x1; xx++, i++) {
            if (this.data[i] !== id) continue;
            const ddx = xx - x, ddy = yy - y, ddz = zz - z;
            const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
            if (d > maxDist || (best.length === k && d >= best[k - 1].d)) continue;
            if (pred && !pred(xx, yy, zz)) continue;
            let j = best.length < k ? best.length : k - 1;
            if (best.length < k) best.push(null);
            while (j > 0 && best[j - 1].d > d) { best[j] = best[j - 1]; j--; }
            best[j] = { x: xx, y: yy, z: zz, d };
          }
        }
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Chunk plumbing
  // ---------------------------------------------------------------------------

  chunkKey(cx, cy, cz) { return cx + this.NCX * (cz + this.NCZ * cy); }

  chunkCoords(key) {
    return { cx: key % this.NCX, cz: ((key / this.NCX) | 0) % this.NCZ, cy: (key / (this.NCX * this.NCZ)) | 0 };
  }

  /** Remove and return up to `max` dirty chunk keys. */
  takeDirty(max = Infinity) {
    const out = [];
    for (const key of this.dirty) {
      if (out.length >= max) break;
      out.push(key);
    }
    for (const key of out) this.dirty.delete(key);
    return out;
  }

  markAllDirty() {
    for (let key = 0; key < this.chunkCount; key++) this.dirty.add(key);
  }

  /** Mark the cell's chunk plus any neighbour chunk whose meshing (faces or AO) reads this cell. */
  _markCellDirty(x, y, z) {
    const C = this.CHUNK;
    const cx = (x / C) | 0, cy = (y / C) | 0, cz = (z / C) | 0;
    const lx = x - cx * C, ly = y - cy * C, lz = z - cz * C;
    const ox0 = lx === 0 ? -1 : 0, ox1 = lx === C - 1 ? 1 : 0;
    const oy0 = ly === 0 ? -1 : 0, oy1 = ly === C - 1 ? 1 : 0;
    const oz0 = lz === 0 ? -1 : 0, oz1 = lz === C - 1 ? 1 : 0;
    for (let oy = oy0; oy <= oy1; oy++) {
      const ny = cy + oy;
      if (ny < 0 || ny >= this.NCY) continue;
      for (let oz = oz0; oz <= oz1; oz++) {
        const nz = cz + oz;
        if (nz < 0 || nz >= this.NCZ) continue;
        for (let ox = ox0; ox <= ox1; ox++) {
          const nx = cx + ox;
          if (nx < 0 || nx >= this.NCX) continue;
          this.dirty.add(this.chunkKey(nx, ny, nz));
        }
      }
    }
  }

  /** Rebuild heightmap and tracked counts from `data` (after bulk writes by worldgen). */
  recomputeDerived() {
    const { SX, SY, SZ } = this, layer = SX * SZ;
    this.heightmap.fill(-1);
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const col = x + SX * z;
        for (let y = SY - 1; y >= 0; y--) {
          if (SOLID[this.data[col + layer * y]]) { this.heightmap[col] = y; break; }
        }
      }
    }
    this.counts.fill(0);
    this.totals.fill(0);
    const C = this.CHUNK;
    for (let y = 0; y < SY; y++) {
      for (let z = 0; z < SZ; z++) {
        let i = SX * z + layer * y;
        for (let x = 0; x < SX; x++, i++) {
          const t = this.trackIndex[this.data[i]];
          if (t < 0) continue;
          this.counts[t * this.chunkCount + this.chunkKey((x / C) | 0, (y / C) | 0, (z / C) | 0)]++;
          this.totals[t]++;
        }
      }
    }
    this.version++;
  }

  // ---------------------------------------------------------------------------
  // Picking
  // ---------------------------------------------------------------------------

  /**
   * Amanatides–Woo voxel traversal. The origin may lie outside the world (camera outside the jar).
   * @returns {{x:number,y:number,z:number,id:number,normal:{x:number,y:number,z:number},dist:number}|null}
   */
  raycast(origin, dir, maxDist = 400, { hitWater = false, skipGlass = false, skipWalls = false } = {}) {
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (!(len > 0)) return null;
    const dx = dir.x / len, dy = dir.y / len, dz = dir.z / len;

    // Clip the ray to the world box.
    let tMin = 0, tMax = maxDist, enterAxis = -1;
    const o = [origin.x, origin.y, origin.z], d = [dx, dy, dz], hi = [this.SX, this.SY, this.SZ];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-12) {
        if (o[a] < 0 || o[a] >= hi[a]) return null;
        continue;
      }
      let t0 = (0 - o[a]) / d[a], t1 = (hi[a] - o[a]) / d[a];
      if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
      if (t0 > tMin) { tMin = t0; enterAxis = a; }
      if (t1 < tMax) tMax = t1;
      if (tMin > tMax) return null;
    }

    const eps = 1e-6;
    const px = origin.x + dx * (tMin + eps), py = origin.y + dy * (tMin + eps), pz = origin.z + dz * (tMin + eps);
    let x = Math.min(this.SX - 1, Math.max(0, Math.floor(px)));
    let y = Math.min(this.SY - 1, Math.max(0, Math.floor(py)));
    let z = Math.min(this.SZ - 1, Math.max(0, Math.floor(pz)));
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = Math.abs(1 / dx), tdy = Math.abs(1 / dy), tdz = Math.abs(1 / dz);
    let tx = dx === 0 ? Infinity : tMin + (dx > 0 ? x + 1 - px : px - x) * tdx;
    let ty = dy === 0 ? Infinity : tMin + (dy > 0 ? y + 1 - py : py - y) * tdy;
    let tz = dz === 0 ? Infinity : tMin + (dz > 0 ? z + 1 - pz : pz - z) * tdz;
    let t = tMin;
    const normal = { x: 0, y: 0, z: 0 };
    if (enterAxis === 0) normal.x = -sx; else if (enterAxis === 1) normal.y = -sy; else if (enterAxis === 2) normal.z = -sz;

    for (let guard = 0; guard < 2048; guard++) {
      const id = this.data[x + this.SX * (z + this.SZ * y)];
      if ((SOLID[id] && !(skipGlass && id === B.GLASS_WALL) && !(skipWalls && id === B.CLAN_WALL)) || (hitWater && id === B.WATER)) {
        return { x, y, z, id, normal: { ...normal }, dist: t };
      }
      if (tx < ty && tx < tz) {
        x += sx; t = tx; tx += tdx; normal.x = -sx; normal.y = 0; normal.z = 0;
        if (x < 0 || x >= this.SX) break;
      } else if (ty < tz) {
        y += sy; t = ty; ty += tdy; normal.x = 0; normal.y = -sy; normal.z = 0;
        if (y < 0 || y >= this.SY) break;
      } else {
        z += sz; t = tz; tz += tdz; normal.x = 0; normal.y = 0; normal.z = -sz;
        if (z < 0 || z >= this.SZ) break;
      }
      if (t > tMax) break;
    }
    return null;
  }
}

function axisGap(v, lo, hi) {
  return v < lo ? lo - v : v > hi ? v - hi : 0;
}
