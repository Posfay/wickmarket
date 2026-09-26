// The island split between clans (2–6): pie-slice sectors around the centre of the jar. Every sector
// gets what one clan needs on its own: a market (plaza with kettles and pads), a pond with a swamp
// ring for fuel, a rocky hill with crystal veins for lenses, houses, lens towers, trees and berry
// bushes. Radial walls of unbreakable glass separate the sectors (economy/clans.js can remove them).
// Sectors differ a little on purpose (pond size, hill height, crystal), so clans have something to
// trade once they meet. Deterministic: same seed and setup ⇒ identical bytes.
import { createRng, createNoise, hash3 } from '../core/rng.js';
import { B, houseTemplate, towerTemplate, treeTemplate } from './blocks.js';
import { relaxSlopes, bfsReach } from './worldgen.js';
import { stampWallColumn, clanSizes, CLAN_DEFS } from '../economy/clans.js';
import { GOODS } from '../core/config.js';

const OCC_FREE = 0, OCC_PLAZA = 1, OCC_ROAD = 2, OCC_STRUCT = 3, OCC_CLEAR = 4, OCC_TREE = 5, OCC_BUSH = 6;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NONE = 255;
const TAU = Math.PI * 2;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 8-connected Bresenham from (x0,z0) to (x1,z1), calling fn(x, z) per cell. */
function line8(x0, z0, x1, z1, fn) {
  const dx = Math.abs(x1 - x0), dz = -Math.abs(z1 - z0);
  const sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
  let err = dx + dz, x = x0, z = z0;
  for (let guard = 0; guard < 512; guard++) {
    fn(x, z);
    if (x === x1 && z === z1) break;
    const e2 = 2 * err;
    if (e2 >= dz) { err += dz; x += sx; }
    if (e2 <= dx) { err += dx; z += sz; }
  }
}

/**
 * @param {import('./world.js').World} world
 * @param {number} seed
 * @param {object} config CONFIG
 * @param {{clans: object[], walls: string}} setup normalized setup with ≥ 2 clans
 * @returns {object} WorldInfo, plus clan fields: clanCount, sectorMap, wallLines, wallStamp, spawnByClan, ponds
 */
export function generateClanWorld(world, seed, config, setup) {
  const g = config.worldgen, W = config.world, P = config.production;
  const N = setup.clans.length;
  const sizes = clanSizes(setup);
  const rng = createRng((seed ^ 0x0C1A45ED) >>> 0);
  const noise = createNoise(seed >>> 0);
  const { SX, SY, SZ } = world;
  const LAYER = SX * SZ;
  const LEVEL = W.WATER_LEVEL;
  const CX = W.CX, CZ = W.CZ;
  const data = world.data;
  data.fill(B.AIR);
  world.footfall.fill(0);

  const col = (x, z) => x + SX * z;
  const idx = (x, y, z) => x + SX * (z + SZ * y);
  const inside = (x, z) => world.isInside(x, z);
  const rDist = (x, z) => Math.hypot(x + 0.5 - CX, z + 0.5 - CZ);
  const theta0 = rng.range(0, TAU);
  const step = TAU / N;
  const polar = (r, ang) => ({ x: CX + Math.cos(ang) * r, z: CZ + Math.sin(ang) * r });
  const sectorByAngle = (x, z) => {
    let a = Math.atan2(z + 0.5 - CZ, x + 0.5 - CX) - theta0;
    a = ((a % TAU) + TAU) % TAU;
    return Math.min(N - 1, Math.floor(a / step));
  };
  /** Distance of a point inside sector i from the sector's walls (negative outside the sector). */
  const wedgeMargin = (x, z, i) => {
    const px = x + 0.5 - CX, pz = z + 0.5 - CZ;
    if (sectorByAngle(x, z) !== i) return -1;
    const d = (ang) => {
      const ux = Math.cos(ang), uz = Math.sin(ang);
      const proj = px * ux + pz * uz;
      return proj <= 0 ? Math.hypot(px, pz) : Math.abs(px * uz - pz * ux);
    };
    return Math.min(d(theta0 + i * step), d(theta0 + (i + 1) * step));
  };

  // -------------------------------------------------------------------------
  // 1. Sector features
  // -------------------------------------------------------------------------
  const sectors = [];
  for (let i = 0; i < N; i++) {
    const phi = theta0 + (i + 0.5) * step;
    const off = Math.min((step / 2) * 0.45, 0.5);
    const side = rng.next() < 0.5 ? 1 : -1;
    const pondR = clamp(10.5 - 0.9 * N, 5, 9) * rng.range(0.85, 1.15);
    const pond = { ...polar(N <= 3 ? 30 : 34, phi + side * off), r: pondR, depth: g.pond.depth };
    const hill = { ...polar(N <= 3 ? 37 : 39, phi - side * off), w: clamp(16 - N, 9, 14), amp: g.ridgeAmp * rng.range(0.75, 1.2) };
    const site = polar(N <= 3 ? 20 : N === 4 ? 21 : 23, phi);
    sectors.push({ i, phi, pond, hill, site: { x: Math.round(site.x), z: Math.round(site.z) } });
  }
  const ponds = sectors.map((s) => s.pond);
  const nearestPond = (x, z) => {
    let best = ponds[0], bd = Infinity;
    for (const p of ponds) {
      const d = Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z) - p.r;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };

  // -------------------------------------------------------------------------
  // 2. Heightmap
  // -------------------------------------------------------------------------
  const Hf = new Float32Array(LAYER);
  const hillMask = new Float32Array(LAYER);
  const steep = new Uint8Array(LAYER);
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      const c = col(x, z);
      let h = g.baseHeight + g.hillAmp * noise.fbm2(x / 40, z / 40);
      let hm = 0, crag = 0;
      for (const s of sectors) {
        const dx = x + 0.5 - s.hill.x, dz = z + 0.5 - s.hill.z;
        const d2 = (dx * dx + dz * dz) / (s.hill.w * s.hill.w);
        if (d2 > 6) continue;
        const w = Math.exp(-d2 * 1.4);
        const rv = noise.ridged2((x + s.i * 31.7) / 15, (z - s.i * 17.3) / 15);
        h += s.hill.amp * w * (0.5 + 0.5 * rv);
        if (w > hm) { hm = w; crag = rv; }
      }
      hillMask[c] = hm;
      steep[c] = hm > 0.45 && crag > 0.72 ? 1 : 0;
      const pond = nearestPond(x, z);
      const d = Math.hypot(x + 0.5 - pond.x, z + 0.5 - pond.z);
      if (d < pond.r) {
        h = Math.min(h, LEVEL - 1 - pond.depth * (1 - d / pond.r) ** 2);
      } else {
        const t = (d - pond.r) / (g.pondBlend ?? 8);
        if (t < 1) h = lerp(LEVEL, h, smoothstep(0, 1, t));
        h = Math.max(h, LEVEL);
      }
      Hf[c] = h;
    }
  }
  const H = new Int16Array(LAYER);
  for (let c = 0; c < LAYER; c++) H[c] = Math.max(3, Math.min(SY - 14, Math.round(Hf[c])));
  const slopeOf = (a, b) => (steep[a] && steep[b] ? 2 : g.maxSlope);
  const locked = new Uint8Array(LAYER);
  relaxSlopes(H, locked, slopeOf, SX, SZ, false);

  // Plazas: the flattest 9×9 near each sector's site, well inside the sector and clear of ponds.
  const half = g.plazaHalf;
  const plazas = sectors.map((s) => {
    let best = null;
    for (let reach = g.siteJitter; reach <= g.siteJitter + 12 && !best; reach += 4) {
      for (let dz = -reach; dz <= reach; dz++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const cx = s.site.x + dx, cz = s.site.z + dz;
          let ok = true, lo = Infinity, hi = -Infinity;
          for (let z = cz - half; z <= cz + half && ok; z++) {
            for (let x = cx - half; x <= cx + half; x++) {
              if (!inside(x, z) || rDist(x, z) > g.rimStart - 4 || wedgeMargin(x, z, s.i) < 3) { ok = false; break; }
              for (const p of ponds) if (Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z) < p.r + 3) { ok = false; break; }
              if (!ok) break;
              const h = H[col(x, z)];
              if (h < lo) lo = h;
              if (h > hi) hi = h;
            }
          }
          if (!ok) continue;
          const score = (hi - lo) + 0.15 * Math.hypot(dx, dz) + 0.01 * hash3(cx, s.i, cz, seed);
          if (!best || score < best.score) best = { cx, cz, score };
        }
      }
    }
    if (!best) best = { cx: s.site.x, cz: s.site.z };
    const hs = [];
    for (let z = best.cz - half; z <= best.cz + half; z++) for (let x = best.cx - half; x <= best.cx + half; x++) hs.push(H[col(x, z)]);
    hs.sort((a, b) => a - b);
    const h = Math.max(LEVEL, hs[hs.length >> 1]);
    for (let z = best.cz - half; z <= best.cz + half; z++) {
      for (let x = best.cx - half; x <= best.cx + half; x++) { H[col(x, z)] = h; locked[col(x, z)] = 1; }
    }
    return { cx: best.cx, cz: best.cz, h, clan: s.i };
  });

  // Village greens: the ground around each plaza is levelled toward the plaza height, so there is
  // flat land for houses (the classic plazas get this from their long road).
  const VR = N <= 3 ? 19 : 17;
  for (const p of plazas) {
    for (let z = p.cz - VR; z <= p.cz + VR; z++) {
      for (let x = p.cx - VR; x <= p.cx + VR; x++) {
        if (!inside(x, z)) continue;
        const c = col(x, z);
        if (locked[c]) continue;
        const d = Math.hypot(x - p.cx, z - p.cz);
        if (d > VR || wedgeMargin(x, z, p.clan) < 0) continue;
        let wet = false;
        for (const pd of ponds) if (Math.hypot(x + 0.5 - pd.x, z + 0.5 - pd.z) < pd.r + 2) { wet = true; break; }
        if (wet) continue;
        const w = 1 - smoothstep(VR * 0.72, VR, d);
        H[c] = Math.round(H[c] + (p.h - H[c]) * w);
        if (w > 0.95) steep[c] = 0;
      }
    }
  }
  const inVillage = (x, z, margin = 0) => plazas.some((p) => Math.hypot(x - p.cx, z - p.cz) < VR - margin);

  // Roads: from each plaza toward the centre of the jar (they meet once the walls come down).
  const occ = new Uint8Array(LAYER);
  for (const p of plazas) {
    for (let z = p.cz - half; z <= p.cz + half; z++) for (let x = p.cx - half; x <= p.cx + half; x++) occ[col(x, z)] = OCC_PLAZA;
  }
  const rw = g.roadHalfWidth ?? 1;
  for (const s of sectors) {
    const a = plazas[s.i];
    const endR = N <= 2 ? 10 : 12;
    const end = polar(endR, s.phi);
    const bx = Math.round(end.x), bz = Math.round(end.z);
    const bh = H[col(bx, bz)];
    const len = Math.hypot(bx - a.cx, bz - a.cz);
    const steps = Math.ceil(len * 3);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = Math.round(lerp(a.cx, bx, t)), z = Math.round(lerp(a.cz, bz, t));
      const h = Math.round(lerp(a.h, bh, t));
      for (let dz = -rw; dz <= rw; dz++) {
        for (let dx = -rw; dx <= rw; dx++) {
          const xx = x + dx, zz = z + dz;
          if (!inside(xx, zz) || wedgeMargin(xx, zz, s.i) < 2.5) continue;
          const c = col(xx, zz);
          if (occ[c] !== OCC_FREE) continue;
          occ[c] = OCC_ROAD;
          H[c] = h;
          locked[c] = 1;
        }
      }
    }
  }
  relaxSlopes(H, locked, slopeOf, SX, SZ, true);

  // Dry pits below the water line that belong to no pond are filled; the rim rises at the glass.
  {
    const wet = new Uint8Array(LAYER);
    const q = [];
    for (const p of ponds) {
      const c0 = col(Math.floor(p.x), Math.floor(p.z));
      if (H[c0] < LEVEL && !wet[c0]) { wet[c0] = 1; q.push(c0); }
    }
    while (q.length) {
      const c = q.pop();
      const x = c % SX, z = (c / SX) | 0;
      for (const [dx, dz] of DIRS) {
        const nx = x + dx, nz = z + dz;
        if (!inside(nx, nz)) continue;
        const n = col(nx, nz);
        if (!wet[n] && H[n] < LEVEL) { wet[n] = 1; q.push(n); }
      }
    }
    for (let c = 0; c < LAYER; c++) if (H[c] < LEVEL && !wet[c]) H[c] = LEVEL;
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const r = rDist(x, z);
        if (r > g.rimStart) H[col(x, z)] = Math.min(SY - 10, H[col(x, z)] + Math.round((r - g.rimStart) * 2));
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Columns
  // -------------------------------------------------------------------------
  const [ldLo, ldHi] = g.loamDepth;
  const [bog0, bog1] = g.bogRing;
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      if (!inside(x, z)) continue;
      const c = col(x, z);
      const h = H[c];
      const r = rDist(x, z);
      data[idx(x, 0, z)] = B.BEDROCK;
      const rim = r > g.rimStart;
      const bare = !rim && steep[c] === 1;
      const loamDepth = ldLo + Math.floor(hash3(x, 0, z, seed ^ 0x10A) * (ldHi - ldLo + 1));
      const under = h < LEVEL;
      const pond = nearestPond(x, z);
      const e = Math.hypot(x + 0.5 - pond.x, z + 0.5 - pond.z) - pond.r;
      const wobble = noise.noise2(x / 6 + 31.7, z / 6 - 12.3);
      const bog = !under && !rim && e >= bog0 + wobble && e <= bog1 + 2 * wobble;
      for (let y = 1; y <= h; y++) {
        let id;
        if (rim || bare) id = B.BASALT;
        else if (y <= h - loamDepth) id = B.BASALT;
        else if (y < h) id = B.LOAM;
        else id = under ? B.LOAM : B.MOSS;
        if (bog && y >= h - 1) id = B.PEAT;
        data[idx(x, y, z)] = id;
      }
      if (occ[c] === OCC_PLAZA) data[idx(x, h, z)] = B.PAVING;
      else if (occ[c] === OCC_ROAD) data[idx(x, h, z)] = B.PATH;
      if (under) for (let y = h + 1; y <= LEVEL; y++) data[idx(x, y, z)] = B.WATER;
    }
  }

  // -------------------------------------------------------------------------
  // 4. Walls and sectors
  // -------------------------------------------------------------------------
  const rayCols = (ang) => {
    const out = [];
    const x0 = Math.floor(CX), z0 = Math.floor(CZ);
    const x1 = Math.round(CX + Math.cos(ang) * (W.RADIUS + 2)), z1 = Math.round(CZ + Math.sin(ang) * (W.RADIUS + 2));
    line8(x0, z0, x1, z1, (x, z) => { if (inside(x, z)) out.push(col(x, z)); });
    return out;
  };
  const hub = [];
  for (let z = Math.floor(CZ) - 2; z <= Math.floor(CZ) + 2; z++) {
    for (let x = Math.floor(CX) - 2; x <= Math.floor(CX) + 2; x++) {
      if (inside(x, z) && Math.hypot(x + 0.5 - CX, z + 0.5 - CZ) <= 1.8) hub.push(col(x, z));
    }
  }
  const uniq = (arr) => Array.from(new Set(arr));
  const wallLines = [];
  if (N === 2) {
    wallLines.push({ id: 0, a: 0, b: 1, cols: uniq([...hub, ...rayCols(theta0), ...rayCols(theta0 + Math.PI)]) });
  } else {
    for (let j = 0; j < N; j++) {
      wallLines.push({ id: j, a: (j - 1 + N) % N, b: j, cols: uniq([...hub, ...rayCols(theta0 + j * step)]) });
    }
  }
  const isWall = new Uint8Array(LAYER);
  const wallStamp = new Map();
  for (const w of wallLines) {
    for (const c of w.cols) {
      if (isWall[c]) continue;
      isWall[c] = 1;
      const x = c % SX, z = (c / SX) | 0;
      wallStamp.set(c, stampWallColumn(world, x, z, H[c], true));
      occ[c] = OCC_STRUCT;
    }
  }

  // Sectors: flood fill from each plaza without crossing walls; stray pockets go by angle.
  const sectorMap = new Uint8Array(LAYER).fill(NONE);
  for (const p of plazas) {
    const start = col(p.cx, p.cz);
    if (sectorMap[start] !== NONE) continue;
    sectorMap[start] = p.clan;
    const q = [start];
    while (q.length) {
      const c = q.pop();
      const x = c % SX, z = (c / SX) | 0;
      for (const [dx, dz] of DIRS) {
        const nx = x + dx, nz = z + dz;
        if (!inside(nx, nz)) continue;
        const n = col(nx, nz);
        if (isWall[n] || sectorMap[n] !== NONE) continue;
        sectorMap[n] = p.clan;
        q.push(n);
      }
    }
  }
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      const c = col(x, z);
      if (inside(x, z) && !isWall[c] && sectorMap[c] === NONE) sectorMap[c] = sectorByAngle(x, z);
    }
  }
  const sectorOf = (x, z) => (x < 0 || z < 0 || x >= SX || z >= SZ ? NONE : sectorMap[col(x, z)]);

  // Crystal veins inside every clan's hill (each clan gets enough near the surface).
  for (const s of sectors) {
    const cells = [], vals = [], near = [];
    const nearDepth = g.quartzNearDepth ?? 12;
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const c = col(x, z);
        if (!inside(x, z) || sectorMap[c] !== s.i || hillMask[c] < 0.15 || rDist(x, z) > g.rimStart - 1) continue;
        const h = H[c];
        const soft = hillMask[c] < 0.4;
        for (let y = 1; y <= h; y++) {
          const i = idx(x, y, z);
          if (data[i] !== B.BASALT) continue;
          if (soft && y > h - 2) continue;
          cells.push(i);
          vals.push(noise.noise3(x / 9, y / 9, z / 9));
          near.push(y >= h - nearDepth ? 1 : 0);
        }
      }
    }
    let t = g.quartzVein;
    const floorT = g.quartzVeinFloor ?? 0.4;
    const need = Math.max(60, Math.round(((g.quartzMinNear ?? 320) * 1.3) / N));
    for (;;) {
      let n = 0;
      for (let k = 0; k < cells.length; k++) if (near[k] && vals[k] > t) n++;
      if (n >= need || t <= floorT) break;
      t = Math.max(floorT, t - 0.03);
    }
    for (let k = 0; k < cells.length; k++) if (vals[k] > t) data[cells[k]] = B.QUARTZ;
  }

  // Amber: rare resin nodules deep in the basalt (as in the classic jar).
  {
    const maxY = g.amberMaxY ?? 14;
    for (let y = 1; y < Math.min(maxY, SY); y++) {
      for (let z = 0; z < SZ; z++) {
        for (let x = 0; x < SX; x++) {
          const i = idx(x, y, z);
          if (data[i] === B.BASALT && hash3(x, y, z, seed ^ 0xA3BE) < g.amberChance) data[i] = B.AMBER;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. Plaza furniture (as in the classic jar)
  // -------------------------------------------------------------------------
  const markets = plazas.map((p, m) => {
    const y = p.h + 1;
    const kettles = [{ x: p.cx - 2, y, z: p.cz - 2 }, { x: p.cx + 2, y, z: p.cz + 2 }];
    for (const k of kettles) data[idx(k.x, k.y, k.z)] = B.KETTLE;
    const rim = [];
    const x0 = p.cx - half, x1 = p.cx + half, z0 = p.cz - half, z1 = p.cz + half;
    for (let x = x0; x < x1; x++) rim.push([x, z0]);
    for (let z = z0; z < z1; z++) rim.push([x1, z]);
    for (let x = x1; x > x0; x--) rim.push([x, z1]);
    for (let z = z1; z > z0; z--) rim.push([x0, z]);
    const pads = {};
    const stride = rim.length / GOODS.length;
    GOODS.forEach((good, i) => {
      const [px, pz] = rim[Math.floor(i * stride + stride / 2) % rim.length];
      pads[good] = { x: px, y, z: pz };
    });
    return {
      id: m, key: `clan${p.clan}`, name: CLAN_DEFS[p.clan].key, clan: p.clan,
      center: { x: p.cx, y, z: p.cz }, plaza: { x0, z0, x1, z1, y }, kettles, pads,
    };
  });

  // -------------------------------------------------------------------------
  // 6. Reachability (each sector from its own plaza; walls keep them apart)
  // -------------------------------------------------------------------------
  const reachAll = () => {
    let r = null;
    for (const mk of markets) {
      const one = bfsReach(world, mk.center);
      if (!r) r = one;
      else for (let i = 0; i < one.length; i++) if (one[i]) r[i] = 1;
    }
    return r;
  };
  let reach = reachAll();
  const reachable = (x, y, z) => world.inBounds(x, y, z) && reach[idx(x, y, z)] === 1;
  const surfaceReach = (x, z) => inside(x, z) && reachable(x, H[col(x, z)] + 1, z);
  const occNear = (x, z, r, pred) => {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= SX || zz >= SZ) continue;
        if (pred(occ[col(xx, zz)])) return true;
      }
    }
    return false;
  };
  const place = (blocks) => { for (const b of blocks) if (world.inBounds(b.x, b.y, b.z)) data[idx(b.x, b.y, b.z)] = b.id; };
  const airAt = (x, y, z) => world.inBounds(x, y, z) && data[idx(x, y, z)] === B.AIR;

  // 7a. Lens towers on each clan's high ground.
  const towers = [];
  for (const s of sectors) {
    const want = Math.max(2, Math.round(sizes[s.i].initial / 9));
    const cands = [];
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const c = col(x, z);
        if (sectorMap[c] !== s.i || !inside(x, z) || rDist(x, z) > g.rimStart - 2) continue;
        if (occ[c] !== OCC_FREE || H[c] < LEVEL) continue;
        if (occNear(x, z, 1, (o) => o === OCC_STRUCT)) continue;
        if (markets.some((mk) => Math.hypot(x - mk.center.x, z - mk.center.z) < (g.towerPlazaClear ?? 7))) continue;
        const y = H[c] + 1;
        let clear = true;
        for (let k = 0; k < 5; k++) if (!airAt(x, y + k, z)) { clear = false; break; }
        if (!clear) continue;
        let stand = null;
        for (const [dx, dz] of DIRS) {
          const sx = x + dx, sz = z + dz;
          if (!inside(sx, sz) || occ[col(sx, sz)] !== OCC_FREE || sectorOf(sx, sz) !== s.i) continue;
          const sy = H[col(sx, sz)] + 1;
          if (Math.abs(sy - y) <= 1 && reachable(sx, sy, sz)) { stand = { x: sx, y: sy, z: sz }; break; }
        }
        if (!stand) continue;
        cands.push({ x, y, z, stand, score: H[c] + 6 * hillMask[c] + 3 * hash3(x, 7, z, seed) });
      }
    }
    cands.sort((a, b) => b.score - a.score || a.x - b.x || a.z - b.z);
    let got = 0;
    for (const spacing of [g.towerSpreadSpacing ?? 8, P.tower.minSpacing]) {
      for (const cd of cands) {
        if (got >= want) break;
        if (occ[col(cd.x, cd.z)] !== OCC_FREE || occ[col(cd.stand.x, cd.stand.z)] !== OCC_FREE) continue;
        if (towers.some((t) => Math.hypot(t.base.x - cd.x, t.base.z - cd.z) < spacing)) continue;
        const tpl = towerTemplate(cd.x, cd.y, cd.z);
        place(tpl.blocks);
        occ[col(cd.x, cd.z)] = OCC_STRUCT;
        occ[col(cd.stand.x, cd.stand.z)] = OCC_CLEAR;
        towers.push({ id: towers.length + 1, base: tpl.base, lens: tpl.lens, stand: cd.stand, clan: s.i });
        got++;
      }
    }
  }

  // 7b. Houses around each clan's plaza, inside its own land.
  const houses = [];
  {
    const SOFT = new Set([B.MOSS, B.LOAM, B.PATH]);
    const [r0, r1] = g.houseR ?? [5, 18];
    const rFallback = g.houseRFallback ?? 26;
    const siteOk = (x0, z0, clan) => {
      const h = H[col(x0, z0)];
      for (let dz = 0; dz < 3; dz++) {
        for (let dx = 0; dx < 3; dx++) {
          const x = x0 + dx, z = z0 + dz;
          if (!inside(x, z) || rDist(x, z) > g.rimStart - 2 || sectorOf(x, z) !== clan) return false;
          const c = col(x, z);
          if (H[c] !== h || occ[c] !== OCC_FREE) return false;
          if (!SOFT.has(data[idx(x, h, z)])) return false;
          for (let k = 1; k <= 4; k++) if (!airAt(x, h + k, z)) return false;
        }
      }
      for (let z = z0 - 1; z <= z0 + 3; z++) {
        for (let x = x0 - 1; x <= x0 + 3; x++) {
          if (x < 0 || z < 0 || x >= SX || z >= SZ) return false;
          const o = occ[col(x, z)];
          if (o === OCC_STRUCT || o === OCC_PLAZA || o === OCC_CLEAR) return false;
        }
      }
      const ax = x0 + 1, az = z0 - 1;
      if (!inside(ax, az) || sectorOf(ax, az) !== clan) return false;
      const ao = occ[col(ax, az)];
      if (ao === OCC_STRUCT || ao === OCC_PLAZA) return false;
      return reachable(ax, h + 1, az);
    };
    for (const mk of markets) {
      const want = Math.max(3, Math.ceil(sizes[mk.clan].initial * 0.28));
      for (let i = 0; i < want; i++) {
        let site = null;
        for (const [lo, hi] of [[r0, r1], [r0, rFallback]]) {
          const cands = [];
          for (let z0 = mk.center.z - hi - 2; z0 <= mk.center.z + hi; z0++) {
            for (let x0 = mk.center.x - hi - 2; x0 <= mk.center.x + hi; x0++) {
              const d = Math.hypot(x0 + 1 - mk.center.x, z0 + 1 - mk.center.z);
              if (d >= lo && d <= hi) cands.push([x0, z0, d]);
            }
          }
          cands.sort((a, b) => (a[2] + 6 * hash3(a[0], 3, a[1], seed)) - (b[2] + 6 * hash3(b[0], 3, b[1], seed)));
          for (const [x0, z0] of cands) if (siteOk(x0, z0, mk.clan)) { site = [x0, z0]; break; }
          if (site) break;
        }
        if (!site) break;
        const [x0, z0] = site;
        const y0 = H[col(x0, z0)] + 1;
        const tpl = houseTemplate(x0, y0, z0);
        place(tpl.blocks);
        for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) occ[col(x0 + dx, z0 + dz)] = OCC_STRUCT;
        if (occ[col(x0 + 1, z0 - 1)] === OCC_FREE) occ[col(x0 + 1, z0 - 1)] = OCC_CLEAR;
        houses.push({ id: houses.length + 1, ...tpl, marketId: mk.id, clan: mk.clan });
      }
    }
  }

  // 7c. Resinpine groves, shared out between the sectors.
  const trees = [];
  {
    const total = Math.round(g.trees * 1.1);
    const cap = Math.ceil(total / N) + 1;
    const perSector = new Int32Array(N);
    const spacing = g.treeSpacing ?? 4;
    const [hLo, hHi] = P.treeHeight ?? [4, 7];
    const blocked = (o) => o === OCC_STRUCT || o === OCC_PLAZA || o === OCC_ROAD || o === OCC_CLEAR;
    for (let attempt = 0; attempt < 9000 && trees.length < total; attempt++) {
      const x = rng.int(2, SX - 3), z = rng.int(2, SZ - 3);
      if (!inside(x, z) || rDist(x, z) > g.rimStart - 3) continue;
      const sec = sectorOf(x, z);
      if (sec === NONE || perSector[sec] >= cap || inVillage(x, z, 3)) continue;
      const c = col(x, z);
      if (data[idx(x, H[c], z)] !== B.MOSS) continue;
      const grove = 0.3 + 0.7 * smoothstep(-0.25, 0.35, noise.fbm2(x / (g.groveScale ?? 22) + 101.3, z / (g.groveScale ?? 22) - 47.1, 3));
      if (rng.next() > grove) continue;
      if (occNear(x, z, 2, blocked)) continue;
      if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < spacing)) continue;
      const y = H[c] + 1;
      const height = rng.int(hLo, hHi);
      const tpl = treeTemplate(x, y, z, height);
      if (!tpl.blocks.every((b) => inside(b.x, b.z) && airAt(b.x, b.y, b.z))) continue;
      if (!DIRS.some(([dx, dz]) => surfaceReach(x + dx, z + dz))) continue;
      place(tpl.blocks);
      occ[c] = OCC_TREE;
      trees.push({ x, y, z, height });
      perSector[sec]++;
    }
  }

  // 7d. Waxberry bushes, mostly around each clan's own pond.
  const bushes = [];
  {
    const nearFrac = g.bushNearPondFrac ?? 0.7;
    const ripeFrac = g.bushRipeFrac ?? 0.7;
    const blocked = (o) => o !== OCC_FREE && o !== OCC_BUSH;
    for (const s of sectors) {
      const want = Math.max(12, Math.round((g.bushes * sizes[s.i].initial) / 60));
      const band = Math.min(g.bushPondBand ?? 14, 8 + s.pond.r);
      let got = 0;
      for (let attempt = 0; attempt < 5000 && got < want; attempt++) {
        let x, z;
        let nearPond = false;
        if (rng.next() < nearFrac) {
          const a = rng.range(0, TAU), d = s.pond.r + rng.range(0, band);
          x = Math.floor(s.pond.x + Math.cos(a) * d); z = Math.floor(s.pond.z + Math.sin(a) * d);
          nearPond = true;
        } else {
          x = rng.int(2, SX - 3); z = rng.int(2, SZ - 3);
        }
        if (!inside(x, z) || rDist(x, z) > g.rimStart - 2 || sectorOf(x, z) !== s.i) continue;
        if (!nearPond && inVillage(x, z)) continue;
        const c = col(x, z);
        if (occ[c] !== OCC_FREE || data[idx(x, H[c], z)] !== B.MOSS) continue;
        if (occNear(x, z, 1, blocked)) continue;
        const y = H[c] + 1;
        if (!airAt(x, y, z) || !airAt(x, y + 1, z)) continue;
        if (!DIRS.some(([dx, dz]) => surfaceReach(x + dx, z + dz) && occ[col(x + dx, z + dz)] !== OCC_BUSH)) continue;
        const ripe = rng.next() < ripeFrac;
        data[idx(x, y, z)] = ripe ? B.BUSH_RIPE : B.BUSH_BARE;
        occ[c] = OCC_BUSH;
        bushes.push({ x, y, z, ripe });
        got++;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 8. Final audit and spawn cells
  // -------------------------------------------------------------------------
  world.recomputeDerived();
  reach = reachAll();
  const keptTowers = [];
  for (const t of towers) {
    if (reachable(t.stand.x, t.stand.y, t.stand.z)) keptTowers.push(t);
    else for (const b of towerTemplate(t.base.x, t.base.y, t.base.z).blocks) data[idx(b.x, b.y, b.z)] = B.AIR;
  }
  const keptHouses = [];
  for (const h of houses) {
    if (reachable(h.approach.x, h.approach.y, h.approach.z)) keptHouses.push(h);
    else for (const b of h.blocks) data[idx(b.x, b.y, b.z)] = B.AIR;
  }
  if (keptTowers.length !== towers.length || keptHouses.length !== houses.length) {
    world.recomputeDerived();
    reach = reachAll();
  }
  keptTowers.forEach((t, i) => { t.id = i + 1; });
  keptHouses.forEach((h, i) => { h.id = i + 1; });

  const spawnR = g.spawnR ?? 12;
  const spawnByClan = markets.map(() => []);
  for (const mk of markets) {
    for (let z = mk.center.z - spawnR; z <= mk.center.z + spawnR; z++) {
      for (let x = mk.center.x - spawnR; x <= mk.center.x + spawnR; x++) {
        if (!inside(x, z) || Math.hypot(x - mk.center.x, z - mk.center.z) > spawnR || sectorOf(x, z) !== mk.clan) continue;
        const y = world.heightmap[col(x, z)] + 1;
        if (reachable(x, y, z) && world.isWalkable(x, y, z)) spawnByClan[mk.clan].push({ x, y, z });
      }
    }
  }

  world.markAllDirty();
  const pondInfo = ponds.map((p) => ({ x: p.x, z: p.z, r: p.r, level: LEVEL }));
  return {
    seed: seed >>> 0,
    clanCount: N,
    markets,
    towers: keptTowers,
    houses: keptHouses,
    trees,
    bushes,
    pond: pondInfo[0],
    ponds: pondInfo,
    spawnCells: spawnByClan.flat(),
    spawnByClan,
    sectorMap,
    wallLines,
    wallStamp,
    theta0,
  };
}
