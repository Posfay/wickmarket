/**
 * @file Wickling navigation (SPEC §C.4 G3 pathfinding, §C.2 PathNode, §G budgets, ADDENDUM §4).
 *
 * - Weighted A* over foot cells: 4 horizontal directions × dy ∈ {−1, 0, +1}.
 * - Dig-A*: AGENT_DIGGABLE blocks count as passable at +digPenalty per dug cell, and each
 *   PathNode carries the dig bitmask the mover must execute before entering it.
 * - Regions: flood-fill labels over walkable cells, used to reject unreachable requests unsearched.
 *
 * Every search reuses world-sized typed arrays stamped with a generation counter plus a typed
 * binary heap, so a search allocates nothing except the PathNode array it returns.
 * Sim-side module: no three, no DOM; it runs under Node.
 */

// Namespace imports so that a peer build missing an optional export cannot break module linking;
// every table read from them has a fallback taken from the SPEC §C.4 block table.
import * as blocks from '../world/blocks.js';
import * as core from '../core/config.js';

/**
 * @typedef {{x:number, y:number, z:number}} Cell
 * @typedef {{x:number, y:number, z:number, dig:number}} PathNode  foot cell + dig bitmask (SPEC §C.2)
 * @typedef {{x:number, y:number, z:number, radius?:number, adjacentTo?:boolean}} Goal
 * @typedef {{allowDig?:boolean, digPenalty?:number, maxNodes?:number}} PathOpts
 * @typedef {{ok:true, path:PathNode[], cost:number} | {ok:false, reason:'unreachable'|'budget'|'badStart'}} PathResult
 */

/** PathNode.dig bit: the node's feet cell must be dug. */
export const DIG_FEET = 1;
/** PathNode.dig bit: the node's head cell (y+1) must be dug. */
export const DIG_HEAD = 2;
/**
 * PathNode.dig bit: the extra-clearance cell must be dug. Stepping up it is the previous cell's
 * y+2; stepping down it is the node's column one above the previous feet level (node y+2).
 */
export const DIG_CLEAR = 4;

/**
 * The cell a dig bit refers to when moving from `prev` (the previous foot cell) into `node`.
 * @param {Cell} prev
 * @param {PathNode} node
 * @param {number} bit one of DIG_FEET, DIG_HEAD, DIG_CLEAR
 * @returns {Cell}
 */
export function digCellFor(prev, node, bit) {
  if (bit === DIG_FEET) return { x: node.x, y: node.y, z: node.z };
  if (bit === DIG_HEAD) return { x: node.x, y: node.y + 1, z: node.z };
  return node.y > prev.y
    ? { x: prev.x, y: prev.y + 2, z: prev.z }
    : { x: node.x, y: node.y + 2, z: node.z };
}

// Per-block-id classification bits.
const C_SOLID = 1, C_PASS = 2, C_DIG = 4, C_FAST = 8, C_WATER = 16;

// Search status codes.
const ST_OK = 0, ST_UNREACHABLE = 1, ST_BUDGET = 2;

// Goal modes.
const MODE_EXACT = 0, MODE_RADIUS = 1, MODE_ADJ = 2;

// Region verdicts computed when a request is prepared.
const HINT_SAME = 0, HINT_UNKNOWN = 1, HINT_DIFFERENT = 2, HINT_NOGOAL = 3;

// Direction tables. A move code is d*3 + (dy+1) in 0..11; 15 marks the search start.
const DX = [1, -1, 0, 0];
const DZ = [0, 0, 1, -1];
const START_CODE = 15;
const POPCOUNT3 = [0, 1, 1, 2, 1, 2, 2, 3];

// Radius goals larger than this are region-checked through nearestWalkable instead of enumerated.
const MAX_ENUM_RADIUS = 10;

// Dynamic weighting (see _search): the heuristic weight doubles after every 1/BOOST_PARTS of the
// node cap, at most BOOSTS times.
const BOOST_PARTS = 8;
const BOOSTS = 3;

const FAIL_UNREACHABLE = Object.freeze({ ok: false, reason: 'unreachable' });
const FAIL_BUDGET = Object.freeze({ ok: false, reason: 'budget' });
const FAIL_BADSTART = Object.freeze({ ok: false, reason: 'badStart' });

// Fallback ids and diggable set straight from the SPEC §C.4 block table.
const SPEC_ID = { AIR: 0, PATH: 5, WATER: 14, PAVING: 17 };
const SPEC_DIGGABLE = [2, 3, 4, 5, 6, 7, 8, 10]; // BASALT LOAM MOSS PATH PEAT QUARTZ AMBER NEEDLES

const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? () => performance.now()
  : () => Date.now();

/** Build the per-block-id classification table (solid / passable / path-diggable / fast floor / water). */
function buildBlockClasses() {
  const B = blocks.B ?? {};
  const air = B.AIR ?? SPEC_ID.AIR;
  const water = B.WATER ?? SPEC_ID.WATER;
  const fastA = B.PATH ?? SPEC_ID.PATH;
  const fastB = B.PAVING ?? SPEC_ID.PAVING;
  const solidTable = blocks.SOLID;
  const digTable = blocks.AGENT_DIGGABLE;
  const defs = blocks.BLOCKS;
  const cls = new Uint8Array(256);
  for (let id = 0; id < 256; id++) {
    const solid = solidTable
      ? solidTable[id] !== 0
      : typeof blocks.isSolid === 'function' ? !!blocks.isSolid(id) : id !== air && id !== water;
    const passable = typeof blocks.isPassable === 'function'
      ? !!blocks.isPassable(id)
      : !solid && id !== water;
    const breakable = !(defs && defs[id] && defs[id].hardness === Infinity);
    const listed = digTable ? digTable[id] !== 0 : SPEC_DIGGABLE.includes(id);
    let c = 0;
    if (solid) c |= C_SOLID;
    if (passable && !solid) c |= C_PASS;
    if (solid && listed && breakable && id !== water) c |= C_DIG;
    if (id === fastA || id === fastB) c |= C_FAST;
    if (id === water) c |= C_WATER;
    cls[id] = c;
  }
  return cls;
}

/** Island mask per column (SPEC §C.0), taken from world.isInside when available. */
function buildIslandMask(world, wc, SX, SZ) {
  const mask = new Uint8Array(SX * SZ);
  const hasFn = typeof world.isInside === 'function';
  const cx = wc.CX ?? SX / 2, cz = wc.CZ ?? SZ / 2;
  const r2 = (wc.RADIUS ?? Math.min(SX, SZ) / 2 - 2) ** 2;
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      const inside = hasFn
        ? world.isInside(x, z)
        : (x + 0.5 - cx) ** 2 + (z + 0.5 - cz) ** 2 <= r2;
      mask[x + SX * z] = inside ? 1 : 0;
    }
  }
  return mask;
}

/** Growable Int32Array helper: returns an array of at least `need` entries, preserving the first `keep`. */
function ensureInt32(arr, need, keep) {
  if (arr.length >= need) return arr;
  let size = arr.length || 1024;
  while (size < need) size *= 2;
  const out = new Int32Array(size);
  out.set(arr.subarray(0, keep));
  return out;
}

/** A queued or in-flight path request (pooled). */
class PathRequest {
  constructor() { this.reset(); }
  reset() {
    this.ticket = 0; this.cancelled = false;
    this.sx = 0; this.sy = 0; this.sz = 0; this.startIdx = -1;
    this.gx = 0; this.gy = 0; this.gz = 0;          // goal as given (used for the detour test)
    this.tx = 0; this.ty = 0; this.tz = 0;          // search target (exact goals may be re-targeted)
    this.mode = MODE_EXACT; this.radius = 0;
    this.allowDig = false; this.digPenalty = 0; this.maxNodes = 0;
    this.hint = HINT_UNKNOWN;
  }
}

/** A stored result with its expiry tick (pooled). */
class ResultEntry {
  constructor() { this.res = null; this.expires = 0; }
}

/**
 * Pathfinding service shared by all agents (`sim.pathfinder`).
 *
 * Coordinates are voxel ints; a foot cell (x,y,z) is walkable when it is inside the island, the
 * block at y−1 is solid and the blocks at y and y+1 are passable (same rule as World.isWalkable).
 */
export class Pathfinder {
  /**
   * @param {object} world World instance (reads SX/SY/SZ, data, heightmap, version, isInside)
   * @param {object} config CONFIG (reads config.path, config.world, config.time)
   */
  constructor(world, config) {
    this.world = world;
    this.config = config ?? {};
    const wc = this.config.world ?? {};
    const SX = world.SX ?? wc.SX ?? 112;
    const SY = world.SY ?? wc.SY ?? 64;
    const SZ = world.SZ ?? wc.SZ ?? 112;
    this.SX = SX; this.SY = SY; this.SZ = SZ;
    this.L = SX * SZ;
    this.N = this.L * SY;

    this._cls = buildBlockClasses();
    this._inside = buildIslandMask(world, wc, SX, SZ);
    this._data = world.data;

    // Move code tables: index delta and per-axis offsets.
    this._delta = new Int32Array(16);
    this._cdx = new Int8Array(16);
    this._cdy = new Int8Array(16);
    this._cdz = new Int8Array(16);
    for (let d = 0; d < 4; d++) {
      for (let dy = -1; dy <= 1; dy++) {
        const code = d * 3 + dy + 1;
        this._delta[code] = DX[d] + SX * DZ[d] + this.L * dy;
        this._cdx[code] = DX[d]; this._cdy[code] = dy; this._cdz[code] = DZ[d];
      }
    }

    // Search state, reused by every search.
    this._g = new Float32Array(this.N);
    this._mark = new Uint16Array(this.N);   // == gen: seen/open, == gen+1: closed
    this._via = new Uint8Array(this.N);     // move code (bits 0-3) | dig bits (bits 4-6)
    this._gen = 0;
    this._heapF = new Float32Array(1 << 15);
    this._heapI = new Int32Array(1 << 15);
    this._heapSize = 0;
    this._nbIdx = new Int32Array(12);
    this._nbCode = new Uint8Array(12);      // move code | dig bits << 4 | fast floor << 7
    this._endIdx = -1;
    this._endCost = 0;
    this._expanded = 0;

    // Active goal (loaded from a request before each search).
    this._gm = MODE_EXACT; this._gx = 0; this._gy = 0; this._gz = 0; this._gr = 0; this._gIdx = -1;

    /** Region label per world cell: 0 = none (not walkable, or walkable since the last refresh). */
    this.regions = new Int32Array(this.N);
    this.regionCount = 0;
    this._rCells = new Int32Array(1 << 15);
    this._rCount = 0;
    this._rQueue = new Int32Array(1 << 15);
    this._regionVersion = NaN;
    this._regionTick = -Infinity;

    // Requests and results.
    this._tick = 0;
    this._nextTicket = 1;
    this._queue = [];
    this._qHead = 0;
    this._pending = new Map();   // ticket → PathRequest
    this._results = new Map();   // ticket → ResultEntry, insertion order == expiry order
    this._reqPool = [];
    this._entryPool = [];
    this._frameDriven = false;
    this._ticksSinceFrame = 0;
    this._warned = false;

    /** Read by the debug overlay (SPEC §C.4); extra fields are informational. */
    this.stats = {
      msThisFrame: 0, servedThisFrame: 0, queued: 0,
      regionMs: 0, regionCount: 0, lastSearchMs: 0, lastExpanded: 0, totalServed: 0,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Public API: requests
  // ---------------------------------------------------------------------------------------------

  /**
   * Queue a path search.
   * @param {Cell} start foot cell (copied; later mutation of the object has no effect)
   * @param {Goal} goal exact cell, `{radius}` (Chebyshev xz ≤ radius, |dy| ≤ 3) or
   *   `{adjacentTo:true}` (max(|dx|,|dz|) ≤ 1 excluding the goal column, goal.y−2 ≤ y ≤ goal.y+1)
   * @param {PathOpts} [opts]
   * @returns {number} ticket for poll/cancel (never 0)
   */
  request(start, goal, opts = {}) {
    const ticket = this._nextTicket++;
    const rec = this._allocRequest();
    rec.ticket = ticket;
    let res;
    try {
      res = this._prepare(rec, start, goal, opts, false);
    } catch (err) {
      this._warnOnce(err);
      res = FAIL_UNREACHABLE;
    }
    if (res) {
      this._storeResult(ticket, res);
      this._freeRequest(rec);
    } else {
      this._pending.set(ticket, rec);
      this._queue.push(rec);
    }
    this.stats.queued = this._pending.size;
    return ticket;
  }

  /**
   * @param {number} ticket
   * @returns {PathResult|null} null while pending. `path` excludes the start cell; an empty path
   *   means the start already satisfies the goal.
   */
  poll(ticket) {
    const entry = this._results.get(ticket);
    if (entry) {
      if (entry.expires > this._tick) return entry.res;
      this._dropResult(ticket, entry);
    }
    if (this._pending.has(ticket)) return null;
    // SPEC-GAP: unknown, cancelled or expired tickets report a 'budget' failure (never null, so a
    // caller that lost track of a ticket re-requests instead of waiting forever).
    return FAIL_BUDGET;
  }

  /** Drop a pending request or a stored result. Unknown tickets are ignored. */
  cancel(ticket) {
    const rec = this._pending.get(ticket);
    if (rec) {
      rec.cancelled = true;          // recycled when the queue reaches it
      this._pending.delete(ticket);
    }
    const entry = this._results.get(ticket);
    if (entry) this._dropResult(ticket, entry);
    this.stats.queued = this._pending.size;
  }

  /** Reset the per-frame millisecond budget (called once per rendered frame). */
  beginFrame() {
    this._frameDriven = true;
    this._ticksSinceFrame = 0;
    this.stats.msThisFrame = 0;
    this.stats.servedThisFrame = 0;
  }

  /**
   * Serve queued requests; called once per sim tick. Stops after `maxRequests` searches or once
   * the frame has used `CONFIG.path.frameBudgetMs`. Also refreshes regions (throttled) and
   * expires old results.
   * @param {number} [maxRequests]
   */
  processQueue(maxRequests = this._pathCfg().requestsPerTick ?? 3) {
    const stats = this.stats;
    this._tick++;
    this._autoFrame();
    this._purgeResults();

    try {
      if (this._regionsDue()) {
        const t0 = now();
        this._computeRegions();
        const dt = now() - t0;
        stats.regionMs = dt;
        stats.msThisFrame += dt;
      }
    } catch (err) {
      this._warnOnce(err);
    }

    // The millisecond budget protects rendered frames. Headless runs (no beginFrame) serve by count
    // only, so their results never depend on how fast the machine happens to be.
    const budgetMs = this._frameDriven ? this._pathCfg().frameBudgetMs ?? 3 : Infinity;
    let served = 0;
    while (served < maxRequests && stats.msThisFrame < budgetMs) {
      const rec = this._dequeue();
      if (!rec) break;
      if (rec.cancelled) { this._freeRequest(rec); continue; }
      const t0 = now();
      let res;
      try {
        res = this._serve(rec);
      } catch (err) {
        this._warnOnce(err);
        res = FAIL_UNREACHABLE;
      }
      const dt = now() - t0;
      stats.lastSearchMs = dt;
      stats.lastExpanded = this._expanded;
      stats.msThisFrame += dt;
      stats.servedThisFrame++;
      stats.totalServed++;
      served++;
      this._pending.delete(rec.ticket);
      this._storeResult(rec.ticket, res);
      this._freeRequest(rec);
    }
    stats.queued = this._pending.size;
  }

  /**
   * Synchronous, unbudgeted search for tools and tests. Same semantics as request + poll, except
   * that the region fail-fast is used only while the region labels match the current world.
   * @param {Cell} start
   * @param {Goal} goal
   * @param {PathOpts} [opts]
   * @returns {PathResult}
   */
  findPathNow(start, goal, opts = {}) {
    const rec = this._allocRequest();
    const t0 = now();
    this._expanded = 0;
    try {
      return this._prepare(rec, start, goal, opts, true) ?? this._serve(rec);
    } catch (err) {
      this._warnOnce(err);
      return FAIL_UNREACHABLE;
    } finally {
      this.stats.lastSearchMs = now() - t0;
      this.stats.lastExpanded = this._expanded;
      this._freeRequest(rec);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Public API: cells and regions
  // ---------------------------------------------------------------------------------------------

  /**
   * Nearest walkable foot cell, searching cube shells of increasing Chebyshev radius; within a
   * shell the smallest Euclidean offset wins (ties prefer the same level, then higher).
   * Also accepts a cell object as the first argument: nearestWalkable(cell, maxR).
   * @returns {Cell|null}
   */
  nearestWalkable(x, y, z, maxR = 6) {
    if (x !== null && typeof x === 'object') {
      maxR = typeof y === 'number' ? y : 6;
      ({ x, y, z } = x);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    this._data = this.world.data;
    const i = this._nearestWalkableIdx(Math.floor(x), Math.floor(y), Math.floor(z), maxR);
    return i < 0 ? null : this._cellOf(i);
  }

  /** True when the foot cell is walkable in the current world. */
  isWalkable(x, y, z) {
    this._data = this.world.data;
    return this._walkable(Math.floor(x), Math.floor(y), Math.floor(z));
  }

  /**
   * Region label of a foot cell as of the last refresh.
   * SPEC-GAP: returns −1 for cells that were not walkable at the last refresh (or are out of bounds).
   * Also accepts a cell object: regionOf(cell).
   */
  regionOf(x, y, z) {
    if (x !== null && typeof x === 'object') ({ x, y, z } = x);
    const i = this._index(x, y, z);
    if (i < 0) return -1;
    const r = this.regions[i];
    return r > 0 ? r : -1;
  }

  /**
   * Whether two cells are in the same walkable region (as of the last refresh).
   * SPEC-GAP: a cell without a label (a block such as a bush or quartz, or a freshly opened cell)
   * belongs to the regions of the labelled foot cells around it (the adjacentTo box, plus standing
   * on top of it), so targets can be passed directly.
   * @param {Cell} a
   * @param {Cell} b
   */
  sameRegion(a, b) {
    if (!a || !b) return false;
    const ia = this._index(a.x, a.y, a.z), ib = this._index(b.x, b.y, b.z);
    if (ia < 0 || ib < 0) return false;
    const la = this.regions[ia], lb = this.regions[ib];
    if (la > 0 && lb > 0) return la === lb;
    if (la > 0) return this._touchesRegion(b, la);
    if (lb > 0) return this._touchesRegion(a, lb);
    const ax = Math.floor(a.x), ay = Math.floor(a.y), az = Math.floor(a.z);
    for (let dy = -2; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = this._index(ax + dx, ay + dy, az + dz);
          const l = j < 0 ? 0 : this.regions[j];
          if (l > 0 && this._touchesRegion(b, l)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Recompute region labels. Unless `force`, only when world.version changed and at least
   * CONFIG.path.regionRefreshSec sim-seconds passed since the last refresh.
   * SPEC-GAP: sim time is measured in processQueue calls (one per tick); this module has no clock.
   * @param {boolean} [force]
   * @returns {boolean} whether labels were recomputed
   */
  refreshRegions(force = false) {
    if (!force && !this._regionsDue()) return false;
    const t0 = now();
    this._computeRegions();
    this.stats.regionMs = now() - t0;
    return true;
  }

  /** True when the region labels were computed from the current world version. */
  regionsFresh() {
    return this._regionVersion === this.world.version;
  }

  // ---------------------------------------------------------------------------------------------
  // Request preparation and serving
  // ---------------------------------------------------------------------------------------------

  /**
   * Validate and normalise a request into `rec`. Returns an immediate result (bad input, bad start,
   * start already at the goal, region fail-fast) or null when a search is needed.
   * @param {boolean} strict only trust region labels computed from the current world version
   */
  _prepare(rec, start, goal, opts, strict) {
    this._data = this.world.data;
    if (!start || !Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(start.z)) {
      return FAIL_BADSTART;
    }
    if (!goal || !Number.isFinite(goal.x) || !Number.isFinite(goal.y) || !Number.isFinite(goal.z)) {
      return FAIL_UNREACHABLE;
    }
    const o = opts ?? {};
    const P = this._pathCfg();
    rec.sx = Math.floor(start.x); rec.sy = Math.floor(start.y); rec.sz = Math.floor(start.z);
    rec.gx = Math.floor(goal.x); rec.gy = Math.floor(goal.y); rec.gz = Math.floor(goal.z);
    rec.allowDig = !!o.allowDig;
    rec.digPenalty = Number.isFinite(o.digPenalty) && o.digPenalty >= 0
      ? o.digPenalty
      : (P.digPenalty?.default ?? 8);
    // SPEC-GAP: opts.maxNodes, when given, caps every search phase of the request.
    rec.maxNodes = Number.isFinite(o.maxNodes) && o.maxNodes > 0 ? Math.floor(o.maxNodes) : 0;

    if (goal.adjacentTo) {
      rec.mode = MODE_ADJ; rec.radius = 1;
    } else if (goal.radius != null && Number.isFinite(goal.radius)) {
      rec.mode = MODE_RADIUS; rec.radius = Math.max(0, Math.floor(goal.radius));
    } else {
      rec.mode = MODE_EXACT; rec.radius = 0;
    }

    if (!this._walkable(rec.sx, rec.sy, rec.sz)) return FAIL_BADSTART;
    rec.startIdx = this._idx(rec.sx, rec.sy, rec.sz);

    rec.tx = rec.gx; rec.ty = rec.gy; rec.tz = rec.gz;
    if (rec.mode === MODE_EXACT && !this._walkable(rec.gx, rec.gy, rec.gz)) {
      // SPEC-GAP: an exact goal that is not walkable is re-targeted to nearestWalkable(goal); if
      // none exists, a dig request may still target the goal itself when it can be dug out.
      const nw = this._nearestWalkableIdx(rec.gx, rec.gy, rec.gz, 6);
      if (nw >= 0) {
        const c = this._decode(nw);
        rec.tx = c.x; rec.ty = c.y; rec.tz = c.z;
      } else if (!(rec.allowDig && this._digStandable(rec.gx, rec.gy, rec.gz))) {
        return FAIL_UNREACHABLE;
      }
    }

    this._loadGoal(rec);
    if (this._isGoal(rec.sx, rec.sy, rec.sz, rec.startIdx)) return { ok: true, path: [], cost: 0 };

    rec.hint = this._regionHint(rec, strict);
    if (!rec.allowDig && (rec.hint === HINT_DIFFERENT || rec.hint === HINT_NOGOAL)) return FAIL_UNREACHABLE;
    return null;
  }

  /** Run the search(es) for a prepared request. */
  _serve(rec) {
    this._data = this.world.data;
    this._expanded = 0;
    if (!this._walkable(rec.sx, rec.sy, rec.sz)) return FAIL_BADSTART;
    this._loadGoal(rec);
    if (this._isGoal(rec.sx, rec.sy, rec.sz, rec.startIdx)) return { ok: true, path: [], cost: 0 };

    const P = this._pathCfg();
    const capNormal = rec.maxNodes || (P.maxNodes ?? 4000);
    const wNormal = P.wNormal ?? 1.2;

    if (!rec.allowDig) {
      const st = this._search(rec, false, 0, capNormal, wNormal);
      if (st === ST_OK) return this._success(rec);
      return st === ST_BUDGET ? FAIL_BUDGET : FAIL_UNREACHABLE;
    }

    // allowDig: prefer walking when it is not a long detour, otherwise tunnel.
    let walked = null;
    if (rec.hint === HINT_SAME || rec.hint === HINT_UNKNOWN) {
      if (this._search(rec, false, 0, capNormal, wNormal) === ST_OK) {
        const manhattan = Math.abs(rec.sx - rec.gx) + Math.abs(rec.sy - rec.gy) + Math.abs(rec.sz - rec.gz);
        if (this._endCost <= (P.detourFactor ?? 2.5) * manhattan + 8) return this._success(rec);
        walked = this._success(rec);
      }
    }
    const capDig = rec.maxNodes || (P.maxNodesDig ?? 12000);
    const st = this._search(rec, true, rec.digPenalty, capDig, P.wDig ?? 2.0);
    // SPEC-GAP: when both searches succeed the cheaper path wins; a failed dig search falls back
    // to the (long) walking path.
    if (st === ST_OK && (!walked || this._endCost < walked.cost)) return this._success(rec);
    if (walked) return walked;
    return st === ST_BUDGET ? FAIL_BUDGET : FAIL_UNREACHABLE;
  }

  _success(rec) {
    return { ok: true, path: this._buildPath(this._endIdx, rec.startIdx), cost: this._endCost };
  }

  /**
   * Region verdict for the fail-fast rule (SPEC: unreachable when !sameRegion(start,
   * nearestWalkable(goal))). SPEC-GAP refinements: radius/adjacent goals compare every acceptable
   * walkable cell, not only the nearest one; cells with no label yet (opened since the last refresh)
   * give UNKNOWN, which never fails fast; NOGOAL means no acceptable walkable cell exists at all.
   */
  _regionHint(rec, strict) {
    const labels = this.regions;
    const usable = !strict || this.regionsFresh();
    const sl = usable ? labels[rec.startIdx] : 0;

    if (rec.mode === MODE_EXACT) {
      if (!this._walkable(rec.tx, rec.ty, rec.tz)) return HINT_NOGOAL;
      const tl = usable ? labels[this._idx(rec.tx, rec.ty, rec.tz)] : 0;
      if (sl > 0 && tl > 0) return sl === tl ? HINT_SAME : HINT_DIFFERENT;
      return HINT_UNKNOWN;
    }

    if (rec.mode === MODE_RADIUS && rec.radius > MAX_ENUM_RADIUS) {
      const nw = this._nearestWalkableIdx(rec.gx, rec.gy, rec.gz, 6);
      if (nw < 0) return HINT_UNKNOWN;
      const tl = usable ? labels[nw] : 0;
      if (sl > 0 && tl > 0) return sl === tl ? HINT_SAME : HINT_DIFFERENT;
      return HINT_UNKNOWN;
    }

    const r = rec.radius;
    const y0 = rec.mode === MODE_ADJ ? rec.gy - 2 : rec.gy - 3;
    const y1 = rec.mode === MODE_ADJ ? rec.gy + 1 : rec.gy + 3;
    let anyWalkable = false, anyUnknown = false;
    for (let y = y0; y <= y1; y++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (rec.mode === MODE_ADJ && dx === 0 && dz === 0) continue;
          const x = rec.gx + dx, z = rec.gz + dz;
          if (!this._walkable(x, y, z)) continue;
          anyWalkable = true;
          const l = usable ? labels[this._idx(x, y, z)] : 0;
          if (sl > 0 && l === sl) return HINT_SAME;
          if (sl <= 0 || l <= 0) anyUnknown = true;
        }
      }
    }
    if (!anyWalkable) return HINT_NOGOAL;
    return anyUnknown ? HINT_UNKNOWN : HINT_DIFFERENT;
  }

  // ---------------------------------------------------------------------------------------------
  // A* core
  // ---------------------------------------------------------------------------------------------

  _loadGoal(rec) {
    this._gm = rec.mode;
    this._gx = rec.tx; this._gy = rec.ty; this._gz = rec.tz;
    this._gr = rec.radius;
    this._gIdx = rec.mode === MODE_EXACT ? this._idx(rec.tx, rec.ty, rec.tz) : -1;
  }

  /** Goal distance in cells (Manhattan to the accepted box); the heuristic is 0.75·w times this. */
  _hDist(x, y, z) {
    let dx = x - this._gx; if (dx < 0) dx = -dx;
    let dy = y - this._gy; if (dy < 0) dy = -dy;
    let dz = z - this._gz; if (dz < 0) dz = -dz;
    const m = this._gm;
    if (m === MODE_EXACT) return dx + dy + dz;
    if (m === MODE_RADIUS) {
      const r = this._gr;
      return (dx > r ? dx - r : 0) + (dz > r ? dz - r : 0) + (dy > 3 ? dy - 3 : 0);
    }
    const ry = y < this._gy - 2 ? this._gy - 2 - y : y > this._gy + 1 ? y - this._gy - 1 : 0;
    return (dx > 1 ? dx - 1 : 0) + (dz > 1 ? dz - 1 : 0) + ry;
  }

  _isGoal(x, y, z, idx) {
    const m = this._gm;
    if (m === MODE_EXACT) return idx === this._gIdx;
    const ax = x > this._gx ? x - this._gx : this._gx - x;
    const az = z > this._gz ? z - this._gz : this._gz - z;
    if (m === MODE_RADIUS) {
      const ay = y > this._gy ? y - this._gy : this._gy - y;
      return ax <= this._gr && az <= this._gr && ay <= 3;
    }
    return ax <= 1 && az <= 1 && (ax | az) !== 0 && y >= this._gy - 2 && y <= this._gy + 1;
  }

  /**
   * Weighted A* from rec's start toward the loaded goal. On success sets _endIdx/_endCost.
   *
   * SPEC-GAP: dynamic weighting. The search starts with the SPEC heuristic weight; each time it
   * has expanded another eighth of its node cap without reaching the goal, the weight doubles
   * (at most BOOSTS times) and the open heap is re-keyed. Easy searches keep SPEC-quality paths,
   * while hard ones (long detours, deep delver shafts, tunnels under a Glass Pane, where the dig
   * cost dwarfs the heuristic) still finish inside maxNodes / maxNodesDig: with the fixed SPEC
   * weights more than half of the delver dig searches on a realistic island ended in 'budget'.
   * @returns {number} ST_OK | ST_UNREACHABLE | ST_BUDGET
   */
  _search(rec, dig, penalty, cap, weight) {
    const gen = this._nextGen();
    const closed = gen + 1;
    const mark = this._mark, g = this._g, via = this._via;
    const nbIdx = this._nbIdx, nbCode = this._nbCode;
    const cdx = this._cdx, cdy = this._cdy, cdz = this._cdz;
    const SX = this.SX, L = this.L;
    const P = this._pathCfg();
    const fastCost = P.fastFloorCost ?? 0.75;
    const climbCost = P.climbCost ?? 0.3;
    let hw = 0.75 * weight;
    const start = rec.startIdx;
    const boostStep = Math.max(64, (cap / BOOST_PARTS) | 0);
    let nextBoost = boostStep, boosts = 0;

    this._heapSize = 0;
    mark[start] = gen; g[start] = 0; via[start] = START_CODE;
    this._heapPush(start, hw * this._hDist(rec.sx, rec.sy, rec.sz));

    let expanded = 0;
    while (this._heapSize > 0) {
      const idx = this._heapPop();
      if (mark[idx] === closed) continue;
      mark[idx] = closed;
      const y = (idx / L) | 0;
      const rem = idx - y * L;
      const z = (rem / SX) | 0;
      const x = rem - z * SX;
      if (this._isGoal(x, y, z, idx)) {
        this._endIdx = idx;
        this._endCost = g[idx];
        this._expanded = expanded;
        return ST_OK;
      }
      if (expanded >= cap) { this._expanded = expanded; return ST_BUDGET; }
      expanded++;
      if (expanded === nextBoost && boosts < BOOSTS) {
        boosts++;
        nextBoost += boostStep;
        hw *= 2;
        this._rekeyHeap(hw, closed);
      }

      const gi = g[idx];
      const n = dig ? this._digNeighbors(idx, x, y, z) : this._walkNeighbors(idx, x, y, z);
      for (let k = 0; k < n; k++) {
        const ni = nbIdx[k];
        if (mark[ni] === closed) continue;
        const code = nbCode[k];
        const mv = code & 15;
        const bits = (code >> 4) & 7;
        const dy = cdy[mv];
        const ng = gi + ((code & 128) ? fastCost : 1) + (dy !== 0 ? climbCost : 0) + penalty * POPCOUNT3[bits];
        if (mark[ni] === gen && g[ni] <= ng) continue;
        mark[ni] = gen;
        g[ni] = ng;
        via[ni] = code & 127;
        this._heapPush(ni, ng + hw * this._hDist(x + cdx[mv], y + dy, z + cdz[mv]));
      }
    }
    this._expanded = expanded;
    return ST_UNREACHABLE;
  }

  /**
   * Walking moves out of walkable foot cell i (at most one per direction, since the three dy
   * variants are mutually exclusive). Clearance: stepping up needs the origin's y+2 passable;
   * stepping down needs the destination column at the origin's y+1 passable (see SPEC-GAP below).
   * Writes _nbIdx/_nbCode and returns the count.
   */
  _walkNeighbors(i, x, y, z) {
    const data = this._data, cls = this._cls, inside = this._inside;
    const SX = this.SX, SY = this.SY, SZ = this.SZ, L = this.L;
    const nbIdx = this._nbIdx, nbCode = this._nbCode;
    const topOK = y + 2 >= SY;
    let n = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], nz = z + DZ[d];
      if (nx < 0 || nz < 0 || nx >= SX || nz >= SZ || inside[nx + SX * nz] === 0) continue;
      const b = i + DX[d] + SX * DZ[d];          // neighbour column at the origin's feet level
      const cb = cls[data[b]];
      if (cb & C_PASS) {
        // Level move or step down; both need (nx, y+1) passable: the level move's head, and the
        // step-down clearance.
        // SPEC-GAP: "destination's y+1" on a step down is read relative to the origin's feet level
        // (i.e. node y+2), mirroring the step-up rule; this keeps moves symmetric so regions are
        // exact, and it is the cell PathNode.dig bit 4 names on a descending node.
        if (y + 1 < SY && (cls[data[b + L]] & C_PASS) === 0) continue;
        const cf = cls[data[b - L]];
        if (cf & C_SOLID) {
          nbIdx[n] = b; nbCode[n] = (d * 3 + 1) | ((cf & C_FAST) ? 128 : 0); n++;
        } else if ((cf & C_PASS) && y >= 2) {
          const cf2 = cls[data[b - 2 * L]];
          if (cf2 & C_SOLID) { nbIdx[n] = b - L; nbCode[n] = (d * 3) | ((cf2 & C_FAST) ? 128 : 0); n++; }
        }
      } else if (cb & C_SOLID) {
        // Step up onto the block at b: feet b+L and head b+2L passable, origin y+2 passable.
        if (y + 1 >= SY || (cls[data[b + L]] & C_PASS) === 0) continue;
        if (!topOK && ((cls[data[b + 2 * L]] & C_PASS) === 0 || (cls[data[i + 2 * L]] & C_PASS) === 0)) continue;
        nbIdx[n] = b + L; nbCode[n] = (d * 3 + 2) | ((cb & C_FAST) ? 128 : 0); n++;
      }
    }
    return n;
  }

  /**
   * Dig-search moves out of foot cell i: every dy variant whose floor is really solid and whose
   * feet / head / clearance cells are passable or diggable. Dig bits go into the move code.
   */
  _digNeighbors(i, x, y, z) {
    const data = this._data, cls = this._cls, inside = this._inside;
    const SX = this.SX, SY = this.SY, SZ = this.SZ, L = this.L;
    const nbIdx = this._nbIdx, nbCode = this._nbCode;
    let n = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], nz = z + DZ[d];
      if (nx < 0 || nz < 0 || nx >= SX || nz >= SZ || inside[nx + SX * nz] === 0) continue;
      const b = i + DX[d] + SX * DZ[d];
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 1 || ny >= SY) continue;
        const ni = b + dy * L;
        // The floor under the destination must be solid now and is never part of the dig.
        const cf = cls[data[ni - L]];
        if ((cf & C_SOLID) === 0) continue;
        let bits = 0;
        if ((cls[data[ni]] & C_PASS) === 0) {
          if (!this._canDig(ni, ny)) continue;
          bits = DIG_FEET;
        }
        if (ny + 1 < SY && (cls[data[ni + L]] & C_PASS) === 0) {
          if (!this._canDig(ni + L, ny + 1)) continue;
          bits |= DIG_HEAD;
        }
        if (dy !== 0) {
          const ci = dy > 0 ? i + 2 * L : b + L;
          const cy = dy > 0 ? y + 2 : y + 1;
          if (cy < SY && (cls[data[ci]] & C_PASS) === 0) {
            if (!this._canDig(ci, cy)) continue;
            bits |= DIG_CLEAR;
          }
        }
        nbIdx[n] = ni;
        nbCode[n] = (d * 3 + dy + 1) | (bits << 4) | ((cf & C_FAST) ? 128 : 0);
        n++;
      }
    }
    return n;
  }

  /**
   * Whether the path may dig cell ci (at height cy): an AGENT_DIGGABLE, breakable solid at y ≥ 1
   * with no WATER beside or above it (removing it would let water in). Callers only pass cells in
   * island columns (the origin's or the destination's), so the mask rule holds by construction.
   */
  _canDig(ci, cy) {
    if (cy < 1) return false;
    const data = this._data, cls = this._cls;
    if ((cls[data[ci]] & C_DIG) === 0) return false;
    const SX = this.SX;
    if ((cls[data[ci + 1]] | cls[data[ci - 1]] | cls[data[ci + SX]] | cls[data[ci - SX]]) & C_WATER) return false;
    if (cy + 1 < this.SY && (cls[data[ci + this.L]] & C_WATER)) return false;
    return true;
  }

  /** A goal cell a dig path could end on: inside, solid floor, feet/head passable or diggable. */
  _digStandable(x, y, z) {
    if (!this._inColumn(x, z) || y < 1 || y >= this.SY) return false;
    const i = this._idx(x, y, z);
    const data = this._data, cls = this._cls;
    if ((cls[data[i - this.L]] & C_SOLID) === 0) return false;
    if ((cls[data[i]] & C_PASS) === 0 && !this._canDig(i, y)) return false;
    if (y + 1 < this.SY && (cls[data[i + this.L]] & C_PASS) === 0 && !this._canDig(i + this.L, y + 1)) return false;
    return true;
  }

  /** Allocate the returned path by walking parent codes back from endIdx (start excluded). */
  _buildPath(endIdx, startIdx) {
    const via = this._via, delta = this._delta;
    const SX = this.SX, L = this.L;
    const guard = this._expanded + 2;
    let len = 0;
    for (let i = endIdx; i !== startIdx && len <= guard; len++) i -= delta[via[i] & 15];
    const path = new Array(len);
    let i = endIdx;
    for (let k = len - 1; k >= 0; k--) {
      const code = via[i];
      const y = (i / L) | 0;
      const rem = i - y * L;
      const z = (rem / SX) | 0;
      path[k] = { x: rem - z * SX, y, z, dig: (code >> 4) & 7 };
      i -= delta[code & 15];
    }
    return path;
  }

  _nextGen() {
    let gen = this._gen + 2;
    if (gen > 0xfffe) {           // gen+1 must fit in a Uint16
      this._mark.fill(0);
      gen = 2;
    }
    this._gen = gen;
    return gen;
  }

  _heapPush(idx, f) {
    let n = this._heapSize++;
    if (n >= this._heapF.length) this._growHeap();
    const F = this._heapF, I = this._heapI;
    while (n > 0) {
      const p = (n - 1) >> 1;
      const pf = F[p];
      if (pf <= f) break;
      F[n] = pf; I[n] = I[p];
      n = p;
    }
    F[n] = f; I[n] = idx;
  }

  _heapPop() {
    const F = this._heapF, I = this._heapI;
    const top = I[0];
    const n = --this._heapSize;
    if (n > 0) {
      const f = F[n], idx = I[n];
      const half = n >> 1;
      let i = 0;
      while (i < half) {
        let c = 2 * i + 1;
        let cf = F[c];
        const r = c + 1;
        if (r < n && F[r] < cf) { c = r; cf = F[r]; }
        if (cf >= f) break;
        F[i] = cf; I[i] = I[c];
        i = c;
      }
      F[i] = f; I[i] = idx;
    }
    return top;
  }

  _growHeap() {
    const size = this._heapF.length * 2;
    const F = new Float32Array(size), I = new Int32Array(size);
    F.set(this._heapF); I.set(this._heapI);
    this._heapF = F; this._heapI = I;
  }

  /**
   * Recompute every open entry's key as g + hw·hDist (dropping entries of closed cells) and
   * restore the heap property bottom-up. O(open size), no allocation.
   */
  _rekeyHeap(hw, closed) {
    const F = this._heapF, I = this._heapI, g = this._g, mark = this._mark;
    const SX = this.SX, L = this.L;
    let n = 0;
    for (let k = 0, size = this._heapSize; k < size; k++) {
      const idx = I[k];
      if (mark[idx] === closed) continue;
      const y = (idx / L) | 0;
      const rem = idx - y * L;
      const z = (rem / SX) | 0;
      F[n] = g[idx] + hw * this._hDist(rem - z * SX, y, z);
      I[n] = idx;
      n++;
    }
    this._heapSize = n;
    for (let i = (n >> 1) - 1; i >= 0; i--) {
      const f = F[i], idx = I[i];
      let j = i;
      for (;;) {
        let c = 2 * j + 1;
        if (c >= n) break;
        if (c + 1 < n && F[c + 1] < F[c]) c++;
        if (F[c] >= f) break;
        F[j] = F[c]; I[j] = I[c];
        j = c;
      }
      F[j] = f; I[j] = idx;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Regions
  // ---------------------------------------------------------------------------------------------

  _regionsDue() {
    if (this.world.version === this._regionVersion) return false;
    const perSec = core.TICKS?.PER_SEC ?? 10;
    const interval = Math.max(1, Math.round((this._pathCfg().regionRefreshSec ?? 2) * perSec));
    return this._tick - this._regionTick >= interval;
  }

  /**
   * Label walkable cells by connectivity under the walking move rules. Candidates are scanned per
   * island column up to heightmap+1 (no walkable cell can sit higher), then flood-filled.
   */
  _computeRegions() {
    const world = this.world;
    const data = (this._data = world.data);
    const cls = this._cls, inside = this._inside, labels = this.regions;
    const SX = this.SX, SY = this.SY, SZ = this.SZ, L = this.L;
    const hm = world.heightmap;
    const useHm = hm && hm.length === SX * SZ;

    let cells = this._rCells;
    for (let k = 0; k < this._rCount; k++) labels[cells[k]] = 0;

    let count = 0;
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const col = x + SX * z;
        if (inside[col] === 0) continue;
        const top = useHm ? Math.min(SY - 1, hm[col] + 1) : SY - 1;
        if (top < 1) continue;
        let idx = col + L;
        let below = cls[data[col]];
        let cur = cls[data[idx]];
        for (let y = 1; y <= top; y++) {
          const above = y + 1 < SY ? cls[data[idx + L]] : C_PASS;
          if ((below & C_SOLID) && (cur & C_PASS) && (above & C_PASS)) {
            if (count >= cells.length) cells = this._rCells = ensureInt32(cells, count + 1, count);
            labels[idx] = -1;
            cells[count++] = idx;
          }
          below = cur; cur = above; idx += L;
        }
      }
    }
    this._rCount = count;

    const queue = this._rQueue = ensureInt32(this._rQueue, count, 0);
    const nbIdx = this._nbIdx;
    let next = 1;
    for (let k = 0; k < count; k++) {
      const s = cells[k];
      if (labels[s] !== -1) continue;
      const label = next++;
      labels[s] = label;
      let head = 0, tail = 0;
      queue[tail++] = s;
      while (head < tail) {
        const i = queue[head++];
        const y = (i / L) | 0;
        const rem = i - y * L;
        const z = (rem / SX) | 0;
        const n = this._walkNeighbors(i, rem - z * SX, y, z);
        for (let j = 0; j < n; j++) {
          const ni = nbIdx[j];
          if (labels[ni] === -1) { labels[ni] = label; queue[tail++] = ni; }
        }
      }
    }
    this.regionCount = next - 1;
    this.stats.regionCount = this.regionCount;
    this._regionVersion = world.version;
    this._regionTick = this._tick;
  }

  /**
   * Whether any labelled foot cell around c carries `label`: the 3×3 columns around c over
   * y−2..y+1, i.e. the adjacentTo box plus standing on top of c.
   */
  _touchesRegion(c, label) {
    const cx = Math.floor(c.x), cy = Math.floor(c.y), cz = Math.floor(c.z);
    for (let dy = -2; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = this._index(cx + dx, cy + dy, cz + dz);
          if (j >= 0 && this.regions[j] === label) return true;
        }
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // Cells
  // ---------------------------------------------------------------------------------------------

  _idx(x, y, z) { return x + this.SX * (z + this.SZ * y); }

  /** Bounds-checked index (floors its inputs); −1 when outside the world. */
  _index(x, y, z) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return -1;
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (x < 0 || y < 0 || z < 0 || x >= this.SX || y >= this.SY || z >= this.SZ) return -1;
    return this._idx(x, y, z);
  }

  _inColumn(x, z) {
    return x >= 0 && z >= 0 && x < this.SX && z < this.SZ && this._inside[x + this.SX * z] === 1;
  }

  _decode(i) {
    const y = (i / this.L) | 0;
    const rem = i - y * this.L;
    const z = (rem / this.SX) | 0;
    return { x: rem - z * this.SX, y, z };
  }

  _cellOf(i) { return this._decode(i); }

  /** Integer-coordinate walkability (World.isWalkable semantics). */
  _walkable(x, y, z) {
    if (y < 1 || y >= this.SY || !this._inColumn(x, z)) return false;
    const i = this._idx(x, y, z);
    const data = this._data, cls = this._cls;
    return (cls[data[i - this.L]] & C_SOLID) !== 0
      && (cls[data[i]] & C_PASS) !== 0
      && (y + 1 >= this.SY || (cls[data[i + this.L]] & C_PASS) !== 0);
  }

  _nearestWalkableIdx(x, y, z, maxR) {
    if (this._walkable(x, y, z)) return this._idx(x, y, z);
    const R = Math.max(0, Math.floor(maxR));
    for (let r = 1; r <= R; r++) {
      let best = -1, bestD = Infinity;
      for (let k = 0; k <= 2 * r; k++) {
        const dy = k & 1 ? (k + 1) >> 1 : -(k >> 1);   // 0, +1, −1, +2, −2 …
        const ady = dy < 0 ? -dy : dy;
        for (let dz = -r; dz <= r; dz++) {
          const onFace = ady === r || dz === r || dz === -r;
          const step = onFace ? 1 : 2 * r;              // interior rows only touch the x faces
          for (let dx = -r; dx <= r; dx += step) {
            const d = dx * dx + dy * dy + dz * dz;
            if (d >= bestD || !this._walkable(x + dx, y + dy, z + dz)) continue;
            bestD = d;
            best = this._idx(x + dx, y + dy, z + dz);
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  // ---------------------------------------------------------------------------------------------
  // Queue / result bookkeeping
  // ---------------------------------------------------------------------------------------------

  _pathCfg() { return this.config.path ?? {}; }

  /**
   * SPEC-GAP: headless runs never call beginFrame, so the frame budget also resets when no frame
   * has ever begun, or after CONFIG.time.maxTicksPerFrame ticks without one.
   */
  _autoFrame() {
    const maxTicks = this.config.time?.maxTicksPerFrame ?? 12;
    if (!this._frameDriven || this._ticksSinceFrame >= maxTicks) {
      this._ticksSinceFrame = 0;
      this.stats.msThisFrame = 0;
      this.stats.servedThisFrame = 0;
    }
    this._ticksSinceFrame++;
  }

  _dequeue() {
    const q = this._queue;
    if (this._qHead >= q.length) {
      if (q.length) { q.length = 0; this._qHead = 0; }
      return null;
    }
    const rec = q[this._qHead];
    q[this._qHead++] = null;
    if (this._qHead >= 64 && this._qHead * 2 >= q.length) {
      q.copyWithin(0, this._qHead);
      q.length -= this._qHead;
      this._qHead = 0;
    }
    return rec;
  }

  _storeResult(ticket, res) {
    const entry = this._entryPool.pop() ?? new ResultEntry();
    entry.res = res;
    entry.expires = this._tick + (this._pathCfg().resultTTLTicks ?? 600);
    this._results.set(ticket, entry);
  }

  _dropResult(ticket, entry) {
    this._results.delete(ticket);
    entry.res = null;
    this._entryPool.push(entry);
  }

  /** Results expire in insertion order, so only the head of the map needs checking. */
  _purgeResults() {
    if (this._results.size === 0) return;
    const tick = this._tick;
    for (const [ticket, entry] of this._results) {
      if (entry.expires > tick) break;
      this._dropResult(ticket, entry);
    }
  }

  _allocRequest() {
    const rec = this._reqPool.pop() ?? new PathRequest();
    rec.reset();
    return rec;
  }

  _freeRequest(rec) {
    rec.cancelled = true;
    this._reqPool.push(rec);
  }

  _warnOnce(err) {
    if (this._warned) return;
    this._warned = true;
    console.warn('[pathfinding] request failed:', err);
  }
}
