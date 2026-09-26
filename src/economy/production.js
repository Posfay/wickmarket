/**
 * Production: the physical economy of Wickmarket (SPEC §C.4 G4 production.js).
 *
 * Owns capital (lens towers, cottages), minting, crafting, construction projects,
 * nature (bushes, trees, bog, moss, desire paths), lanterns and resource reservations.
 * Sim-side: no three, no DOM. Randomness only through `sim.rng`.
 */
import { CONFIG, TICKS } from '../core/config.js';
import { EV } from '../core/events.js';
import { B, BLOCKS, houseTemplate, towerTemplate, treeTemplate } from '../world/blocks.js';
import { addItem, removeItem, countItem, freeCapacity } from '../agents/agent.js';
import { bytesToB64, b64ToBytes, rleEncode, rleDecode } from '../core/codec.js';

/** Recipe table: `{[recipeId]: {in, out, sec, station, prof}}`. */
export const RECIPES = CONFIG.production.recipes;

/**
 * @typedef {{x:number,y:number,z:number}} Cell
 * @typedef {{id:number, base:Cell, lens:Cell, stand:Cell, operatorId:number|null, lensQ:number,
 *   lensCracksAt:number, active:boolean, boostUntil:number, mintedToday:number}} Tower
 * @typedef {{id:number, origin:Cell, door:Cell, bed:Cell, approach:Cell, lanternSlots:Cell[],
 *   capacity:number, residents:number[], ownerId:number|null}} House
 * @typedef {{id:number, kind:'house'|'tower', ownerId:number, masonId:number|null, site:Cell,
 *   blocks:{x:number,y:number,z:number,id:number}[], placed:number, price:number,
 *   materials:{stone:number,log:number}, delivered:{stone:number,log:number},
 *   status:'open'|'claimed'|'done'|'abandoned', createdTick:number, approach:Cell}} Project
 * @typedef {{id:number, x:number, y:number, z:number, height:number, stage:'sapling'|'mature',
 *   matureAtTick:number}} Tree
 */

// ---------------------------------------------------------------------------
// Module-level constants and small pure helpers
// ---------------------------------------------------------------------------

function lut(ids) {
  const a = new Uint8Array(256);
  for (const id of ids) if (Number.isInteger(id)) a[id] = 1;
  return a;
}

/** Floor blocks a cottage (and a planted bush) may stand on. */
const SOFT_GROUND = lut([B.MOSS, B.LOAM, B.PATH]);
/** Natural solid ground a tower may be founded on. */
const TOWER_GROUND = lut([B.BASALT, B.LOAM, B.MOSS, B.PATH, B.PEAT, B.QUARTZ, B.AMBER]);
/** Blocks under a lantern slot that must not be replaced by a lantern. */
const NO_LANTERN = lut([B.BEDROCK, B.KETTLE, B.LENS_MOUNT, B.GLASS_WALL, B.WATER, B.CLAN_WALL]);

const MASK_STRUCT = 1; // column holds a house footprint, a tower or a project block
const MASK_CLEAR = 2;  // column must stay walkable (approach / stand cells)
const MATERIALS = ['stone', 'log'];
const TWO_PI = Math.PI * 2;

const cellKey = (x, y, z) => x + ',' + y + ',' + z;
const copyCell = (c) => ({ x: c.x, y: c.y, z: c.z });
const isUnbreakable = (id) => id !== B.AIR && BLOCKS[id] != null && BLOCKS[id].hardness === Infinity;
const finiteOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Calls fn(x, z) for every column on the Chebyshev ring of radius r; stops when fn returns true. */
function scanRing(cx, cz, r, fn) {
  if (r === 0) return fn(cx, cz) === true;
  for (let dx = -r; dx <= r; dx++) {
    if (fn(cx + dx, cz - r) === true || fn(cx + dx, cz + r) === true) return true;
  }
  for (let dz = -r + 1; dz <= r - 1; dz++) {
    if (fn(cx - r, cz + dz) === true || fn(cx + r, cz + dz) === true) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

export class Production {
  /**
   * @param {object} sim        the sim context (§C.1); population may not exist yet
   * @param {object} worldInfo  WorldInfo from generateWorld
   */
  constructor(sim, worldInfo) {
    this.sim = sim;
    this.cfg = (sim && sim.config) || CONFIG;
    this.world = (sim && sim.world) || null;
    this.worldInfo = worldInfo || (sim && sim.worldInfo) || {};

    const W = this.cfg.world;
    this.SX = (this.world && this.world.SX) || W.SX;
    this.SY = (this.world && this.world.SY) || W.SY;
    this.SZ = (this.world && this.world.SZ) || W.SZ;

    /** @type {Tower[]} */ this.towers = [];
    /** @type {House[]} */ this.houses = [];
    /** @type {Project[]} unfinished projects only (status 'open' or 'claimed') */
    this.projects = [];
    /** @type {Tree[]} */ this.trees = [];
    /** @type {Map<number, number>} cellIndex → readyTick for bare bushes */
    this.bushTimers = new Map();
    /** @type {Map<string, {agentId:number, until:number}>} */
    this.reservations = new Map();

    this._towerById = new Map();
    this._houseById = new Map();
    this._projectById = new Map();
    this._treeById = new Map();
    this._homeOf = new Map(); // agentId → houseId
    this._nextTowerId = 1;
    this._nextHouseId = 1;
    this._nextProjectId = 1;
    this._nextTreeId = 1;

    /** Lit lantern placements in house slots: {x,y,z,prev,until,agentId,houseId}. */
    this._lanterns = [];

    const cols = this.SX * this.SZ;
    this._mask = new Uint8Array(cols);
    this._waterDist = new Uint8Array(cols).fill(255);
    this._waterCount = -1;
    this._pathIdle = new Uint8Array(cols);

    // Site-search cache, valid while neither the voxels (world.version) nor the structure
    // layout (_structVer, bumped by _rebuildMask) change. undefined = not computed, null = none.
    this._structVer = 0;
    this._siteWorldVer = -1;
    this._siteStructVer = -1;
    this._houseSiteCache = new Map();
    this._towerSiteCache = new Map();

    const startTick = finiteOr(sim && sim.clock && sim.clock.tick, this.cfg.time.startHour * TICKS.PER_HOUR);
    this._initTowers(startTick);
    this._initHouses();
    this._initTrees();
    this._rebuildMask();
    this._refreshWaterMap(true);
    this._initBushes(startTick);
  }

  // =========================================================================
  // Construction-time setup
  // =========================================================================

  _initTowers(startTick) {
    const list = this.worldInfo.towers || [];
    const lifeTicks = this.cfg.money.lensLifeDays * TICKS.PER_DAY;
    // SPEC-GAP: worldgen towers start with a lens (quality of a skill-1.0 lenswright) so the
    // economy mints from day 0 (§D.1 worked example assumes lit towers). Crack times are
    // staggered deterministically between 50% and 100% of the lens life so they do not all fail together.
    const q0 = lensQualityFromSkill(1.0);
    list.forEach((t, i) => {
      const id = Number.isInteger(t.id) ? t.id : this._nextTowerId;
      const tower = {
        id,
        clan: Number.isInteger(t.clan) ? t.clan : 0,
        base: copyCell(t.base),
        lens: t.lens ? copyCell(t.lens) : { x: t.base.x, y: t.base.y + 3, z: t.base.z },
        stand: t.stand ? copyCell(t.stand) : { x: t.base.x + 1, y: t.base.y, z: t.base.z },
        operatorId: null,
        lensQ: q0,
        lensCracksAt: startTick + Math.round(lifeTicks * (0.5 + 0.5 * (i + 1) / list.length)),
        active: false,
        boostUntil: 0,
        mintedToday: 0,
      };
      this._addTower(tower);
    });
  }

  _initHouses() {
    const cap = this.cfg.production.house.capacity;
    for (const h of this.worldInfo.houses || []) {
      const origin = h.origin ? copyCell(h.origin) : { x: h.door.x - 1, y: h.door.y, z: h.door.z };
      const a = houseAnchors(origin);
      const house = {
        id: Number.isInteger(h.id) ? h.id : this._nextHouseId,
        clan: Number.isInteger(h.clan) ? h.clan : 0,
        origin,
        door: h.door ? copyCell(h.door) : a.door,
        bed: h.bed ? copyCell(h.bed) : a.bed,
        approach: h.approach ? copyCell(h.approach) : a.approach,
        lanternSlots: (h.lanternSlots || a.lanternSlots).map(copyCell),
        capacity: Number.isInteger(h.capacity) ? h.capacity : cap,
        residents: [],
        ownerId: null,
      };
      this._addHouse(house);
    }
  }

  _initTrees() {
    for (const t of this.worldInfo.trees || []) {
      this._addTree({ id: this._nextTreeId, x: t.x, y: t.y, z: t.z, height: t.height, stage: 'mature', matureAtTick: 0 });
    }
  }

  _initBushes(startTick) {
    const rng = this.sim && this.sim.rng;
    const w = this.world;
    for (const b of this.worldInfo.bushes || []) {
      if (b.ripe) continue;
      if (w && w.get(b.x, b.y, b.z) !== B.BUSH_BARE) continue;
      // Stagger the initial regrowth so the flats do not all ripen in the same hour.
      const frac = rng ? rng.range(0.15, 1) : 0.5;
      this.bushTimers.set(this._cellIndex(b.x, b.y, b.z), startTick + Math.round(this._regrowTicks(b.x, b.z) * frac));
    }
  }

  _addTower(t) {
    this.towers.push(t);
    this._towerById.set(t.id, t);
    if (t.id >= this._nextTowerId) this._nextTowerId = t.id + 1;
  }

  _addHouse(h) {
    this.houses.push(h);
    this._houseById.set(h.id, h);
    if (h.id >= this._nextHouseId) this._nextHouseId = h.id + 1;
  }

  _addTree(t) {
    this.trees.push(t);
    this._treeById.set(t.id, t);
    if (t.id >= this._nextTreeId) this._nextTreeId = t.id + 1;
    return t;
  }

  _removeTreeAt(i) {
    const t = this.trees[i];
    this.trees.splice(i, 1);
    if (t) this._treeById.delete(t.id);
  }

  // =========================================================================
  // Per-tick update
  // =========================================================================

  /**
   * Advances production by one tick: eclipse expiry, minting and lens cracking every tick;
   * bushes, lanterns, moss and saplings on hour ticks; desire paths, bog and wild saplings at dawn.
   * @param {object} [sim]
   */
  tick(sim = this.sim) {
    if (!sim || !sim.clock || !this.world) return;
    const clock = sim.clock;
    const tick = clock.tick;
    const inDay = tick % TICKS.PER_DAY;

    this._expireEclipses(sim, tick);
    this._tickTowers(sim, tick);

    if (clock.isNewDayTick ?? inDay === 0) this._onNewDay();
    if (clock.isHourTick ?? tick % TICKS.PER_HOUR === 0) this._onHour(tick);
    if (clock.isDawnTick ?? inDay === 6 * TICKS.PER_HOUR) this._onDawn(tick);
  }

  _expireEclipses(sim, tick) {
    const ecl = sim.effects && sim.effects.eclipses;
    if (!ecl || ecl.length === 0) return;
    for (let i = ecl.length - 1; i >= 0; i--) {
      const e = ecl[i];
      if (!e || !(e.untilTick > tick)) ecl.splice(i, 1);
    }
  }

  _tickTowers(sim, tick) {
    const sun = finiteOr(sim.clock.sun, 0);
    const eta = this._eta();
    const ledger = sim.ledger;
    const boostMul = this.cfg.tools.magnifier.boostMul;
    const perTick = (this.cfg.money.mintPerHour * sun * eta) / TICKS.PER_HOUR;

    for (let i = 0; i < this.towers.length; i++) {
      const t = this.towers[i];
      if (t.lensQ > 0 && tick >= t.lensCracksAt) {
        t.lensQ = 0;
        this._emit(EV.TOWER_LENS, { towerId: t.id, what: 'cracked', agentId: t.operatorId });
      }
      let op = null;
      if (t.operatorId != null) {
        op = this._agent(t.operatorId);
        if (!op && this._hasPopulation()) t.operatorId = null;
      }
      const active = op !== null && op.tending === t.id && t.lensQ > 0 && sun > 0 &&
        !this.isEclipsed(t.base.x + 0.5, t.base.z + 0.5);
      t.active = active;
      if (!active) continue;

      const x = perTick * t.lensQ * (t.boostUntil > tick ? boostMul : 1);
      if (!(x > 0)) continue;
      op.glim += x;
      t.mintedToday += x;
      if (ledger) {
        ledger.record('mint', x);
        ledger.income(op, x, 'mint');
      }
    }
  }

  _onNewDay() {
    for (const t of this.towers) t.mintedToday = 0;
  }

  _onHour(tick) {
    this._refreshWaterMap(false);
    this._ripenBushes(tick);
    this._expireLanterns(tick);
    this._spreadMoss();
    this._growSaplings(tick);
    this._sweepHourly(tick);
  }

  _onDawn(tick) {
    this._desirePaths();
    this._bogAccretion();
    this._wildSaplings(tick);
    this._abandonStale(tick);
  }

  // =========================================================================
  // Towers and minting (§D.1)
  // =========================================================================

  /**
   * Claims a tower for a lenswright: keeps a current un-eclipsed tower, otherwise takes the
   * best free tower (non-eclipsed first, then nearest to the agent).
   * @returns {Tower|null}
   */
  claimTower(agent) {
    if (!isLive(agent)) return null;
    const current = agent.towerId != null ? this._towerById.get(agent.towerId) : null;
    if (current && current.operatorId !== agent.id) agent.towerId = null;
    const own = current && current.operatorId === agent.id ? current : null;
    if (own && !this._towerEclipsed(own)) return own;

    const px = agent.pos ? agent.pos.x : 0;
    const pz = agent.pos ? agent.pos.z : 0;
    const clan = agent.clan ?? 0;
    let best = null;
    let bestScore = Infinity;
    for (const t of this.towers) {
      if (t === own || t.clan !== clan || !this._towerFree(t)) continue;
      const dx = t.stand.x + 0.5 - px;
      const dz = t.stand.z + 0.5 - pz;
      const score = (this._towerEclipsed(t) ? 1e9 : 0) + dx * dx + dz * dz;
      if (score < bestScore) { bestScore = score; best = t; }
    }
    if (own) {
      // Re-claim only to escape an eclipse.
      if (!best || this._towerEclipsed(best)) return own;
      this.releaseTower(agent);
    }
    if (!best) return null;
    best.operatorId = agent.id;
    agent.towerId = best.id;
    return best;
  }

  /** Releases the agent's tower (it keeps its lens). */
  releaseTower(agent) {
    if (!agent) return;
    const t = agent.towerId != null ? this._towerById.get(agent.towerId) : null;
    if (t && t.operatorId === agent.id) {
      t.operatorId = null;
      t.active = false;
    }
    for (const o of this.towers) {
      if (o.operatorId === agent.id) { o.operatorId = null; o.active = false; }
    }
    agent.towerId = null;
  }

  /** @returns {Tower|null} the tower operated by this agent */
  towerOf(agentId) {
    if (agentId == null) return null;
    for (const t of this.towers) if (t.operatorId === agentId) return t;
    return null;
  }

  /**
   * Tower whose column contains the cell (base..lens mount, ±1 in y). With y omitted, matches the column.
   * @returns {number|null} tower id
   */
  towerAt(x, y, z) {
    for (const t of this.towers) {
      if (t.base.x !== x || t.base.z !== z) continue;
      if (y == null || (y >= t.base.y - 1 && y <= t.lens.y + 1)) return t.id;
    }
    return null;
  }

  /**
   * Installs a lens from the agent's inventory into an empty tower.
   * lensQ = 0.8 + 0.4·(skill − 0.6)/0.9, cracking after lensLifeDays.
   * @param {Tower|number} tower
   * @returns {boolean}
   */
  installLens(tower, agent) {
    const t = this._resolveTower(tower);
    if (!t || !isLive(agent) || t.lensQ > 0) return false;
    if (countItem(agent, 'lens') < 1 || !removeItem(agent, 'lens', 1)) return false;
    const skill = finiteOr(agent.skills && agent.skills.lenswright, 1);
    t.lensQ = lensQualityFromSkill(skill);
    t.lensCracksAt = this._tick() + this.cfg.money.lensLifeDays * TICKS.PER_DAY;
    this._emit(EV.TOWER_LENS, { towerId: t.id, what: 'installed', agentId: agent.id });
    return true;
  }

  /**
   * Magnifier boost: minting ×boostMul until `hours` from now (holding does not stack).
   * @returns {boolean}
   */
  boostTower(id, hours) {
    const t = this._resolveTower(id);
    if (!t) return false;
    const h = finiteOr(hours, this.cfg.tools.magnifier.boostHours);
    t.boostUntil = Math.max(t.boostUntil, this._tick() + Math.round(h * TICKS.PER_HOUR));
    return true;
  }

  /**
   * True when (x, z) lies under an active Cupped Hand disc. Numbers are world coordinates;
   * an object argument is treated as a cell and tested at its centre.
   */
  isEclipsed(x, z) {
    let px = x;
    let pz = z;
    if (x !== null && typeof x === 'object') { px = x.x + 0.5; pz = x.z + 0.5; }
    const ecl = this.sim && this.sim.effects && this.sim.effects.eclipses;
    if (!ecl || ecl.length === 0) return false;
    const tick = this._tick();
    for (let i = 0; i < ecl.length; i++) {
      const e = ecl[i];
      if (!e || !(e.untilTick > tick)) continue;
      const dx = px - e.x;
      const dz = pz - e.z;
      if (dx * dx + dz * dz <= e.r * e.r) return true;
    }
    return false;
  }

  /** Current mint rate of a tower in glim/hour (0 unless active). */
  mintRatePerHour(tower) {
    const t = this._resolveTower(tower);
    if (!t || !t.active) return 0;
    const sun = finiteOr(this.sim && this.sim.clock && this.sim.clock.sun, 0);
    const boost = t.boostUntil > this._tick() ? this.cfg.tools.magnifier.boostMul : 1;
    return this.cfg.money.mintPerHour * sun * t.lensQ * this._eta() * boost;
  }

  /** Number of towers minting this tick (of one clan when `clan` is given). */
  activeTowerCount(clan) {
    let n = 0;
    for (const t of this.towers) if (t.active && (clan == null || t.clan === clan)) n++;
    return n;
  }

  /** Towers standing on clan c's land. */
  clanTowerCount(clan) {
    let n = 0;
    for (const t of this.towers) if (t.clan === clan) n++;
    return n;
  }

  /** Most towers clan c may own (the classic cap for the single clan). */
  towerMax(clan) {
    return this.sim?.clans?.list?.[clan]?.towerMax ?? this.cfg.production.tower.max;
  }

  _towerFree(t) {
    return t.operatorId == null || (this._hasPopulation() && !this._agent(t.operatorId));
  }

  _towerEclipsed(t) {
    return this.isEclipsed(t.base.x + 0.5, t.base.z + 0.5);
  }

  _resolveTower(t) {
    if (t == null) return null;
    if (typeof t === 'object') return this._towerById.get(t.id) || null;
    return this._towerById.get(t) || null;
  }

  // =========================================================================
  // Crafting
  // =========================================================================

  /**
   * Swaps recipe inputs for outputs and updates the outputs' cost basis.
   * Location and duration are the brain's responsibility.
   * @returns {boolean}
   */
  craft(agent, recipeId) {
    const r = RECIPES[recipeId];
    if (!r || !isLive(agent)) return false;
    let inUnits = 0;
    let outUnits = 0;
    let outTotal = 0;
    for (const g in r.in) {
      if (countItem(agent, g) < r.in[g]) return false;
      if (g !== 'lens') inUnits += r.in[g];
    }
    for (const g in r.out) {
      outTotal += r.out[g];
      if (g !== 'lens') outUnits += r.out[g];
    }
    if (outUnits - inUnits > freeCapacity(agent)) return false;

    let inputCost = 0;
    for (const g in r.in) inputCost += r.in[g] * this._unitCost(agent, g);
    for (const g in r.in) removeItem(agent, g, r.in[g]);

    const unit = outTotal > 0 ? inputCost / outTotal : 0;
    const cb = agent.costBasis;
    for (const g in r.out) {
      const q = r.out[g];
      const held = countItem(agent, g);
      const added = addItem(agent, g, q);
      if (cb && g in cb && added > 0) {
        const prev = finiteOr(cb[g], 0);
        cb[g] = (prev * held + unit * added) / (held + added);
      }
    }
    return true;
  }

  /**
   * Value of one held unit as a crafting input.
   * SPEC-GAP: self-produced inputs have costBasis 0; they are valued at the agent's belief
   * (opportunity cost), else ref, so crafted-goods floors never collapse to 0.
   */
  _unitCost(agent, g) {
    const cb = agent.costBasis && agent.costBasis[g];
    if (cb > 0) return cb;
    const b = agent.beliefs && agent.beliefs[g];
    if (b > 0) return b;
    const good = this.cfg.goods[g];
    return good ? good.ref : 0;
  }

  // =========================================================================
  // Beds
  // =========================================================================

  /** Nearest house with a free bed (excluding the agent's current home). @returns {House|null} */
  vacancy(agent) {
    const px = agent && agent.pos ? agent.pos.x : this.cfg.world.CX;
    const pz = agent && agent.pos ? agent.pos.z : this.cfg.world.CZ;
    const selfId = agent ? agent.id : null;
    const clan = agent ? agent.clan ?? 0 : 0;
    let best = null;
    let bestD = Infinity;
    for (const h of this.houses) {
      if (h.clan !== clan || h.residents.length >= h.capacity || h.residents.includes(selfId)) continue;
      const dx = h.door.x + 0.5 - px;
      const dz = h.door.z + 0.5 - pz;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
  }

  /**
   * Moves the agent into a bed of `house` (House or id), leaving any previous home.
   * @returns {boolean}
   */
  claimBed(agent, house) {
    if (!isLive(agent)) return false;
    const h = house != null && typeof house === 'object' ? this._houseById.get(house.id) : this._houseById.get(house);
    if (!h) return false;
    if (h.residents.includes(agent.id)) {
      agent.homeId = h.id;
      this._homeOf.set(agent.id, h.id);
      return true;
    }
    if (h.residents.length >= h.capacity) return false;
    if (agent.homeId != null || this._homeOf.has(agent.id)) this.releaseBed(agent);
    h.residents.push(agent.id);
    agent.homeId = h.id;
    this._homeOf.set(agent.id, h.id);
    if (agent.lanterns && agent.lanterns.length) this._placeAgentLanterns(agent, h);
    return true;
  }

  /**
   * Leaves the agent's bed. Lanterns it hung there come down with it (they stay lit in
   * `agent.lanterns` and are re-hung at the next bed); freed slots go to housemates' lanterns.
   */
  releaseBed(agent) {
    if (!agent) return;
    const hid = this._homeOf.has(agent.id) ? this._homeOf.get(agent.id) : agent.homeId;
    const h = hid != null ? this._houseById.get(hid) : null;
    if (h) {
      const i = h.residents.indexOf(agent.id);
      if (i >= 0) h.residents.splice(i, 1);
    }
    this._homeOf.delete(agent.id);
    agent.homeId = null;
    if (this._takeDownLanterns(agent.id) && h) this._rehang(h);
  }

  /** @returns {House|null} */
  houseOf(agentId) {
    const hid = this._homeOf.get(agentId);
    return hid != null ? this._houseById.get(hid) || null : null;
  }

  // =========================================================================
  // Commissions (§D.8)
  // =========================================================================

  /** house.markup·(stone·P̄stone + log·P̄log) + house.laborDays·meanY, at clan c's prices. */
  houseBudget(clan = 0) {
    return this._budget(this.cfg.production.house, clan);
  }

  /** Same formula with the tower materials. */
  towerBudget(clan = 0) {
    return this._budget(this.cfg.production.tower, clan);
  }

  _budget(spec, clan = 0) {
    const mat = spec.stone * this._avgP('stone', clan) + spec.log * this._avgP('log', clan);
    return spec.markup * mat + spec.laborDays * this._meanY(clan);
  }

  /**
   * Commissions a cottage near the agent's market: moves the budget from glim into the project.
   * The caller (population) applies the §D.8 eligibility rule; this enforces cash, one live
   * commission per agent and the `maxOpen` cap (per clan when there are several).
   * @returns {Project|null}
   */
  commissionHouse(agent) {
    if (!this._canCommission(agent)) return null;
    const clan = agent.clan ?? 0;
    const clans = this.sim && this.sim.clans;
    if (clans && clans.multi) {
      let open = 0;
      for (const p of this.projects) if (p.clan === clan) open++;
      if (open >= (clans.list[clan]?.maxOpen ?? 3)) return null;
    } else if (this.projects.length >= this.cfg.production.house.maxOpen) return null;
    const price = this.houseBudget(clan);
    if (!(price > 0) || agent.glim < price) return null;

    const markets = this.worldInfo.markets || [];
    const pref = this._preferredMarket(agent);
    let origin = this.findHouseSite(pref);
    for (let m = 0; !origin && m < markets.length; m++) {
      if (m !== pref && (markets[m].clan ?? 0) === clan) origin = this.findHouseSite(m);
    }
    if (!origin) return null;

    const tpl = houseTemplate(origin.x, origin.y, origin.z);
    const anchors = houseAnchors(origin, tpl);
    return this._openProject('house', agent, origin, tpl.blocks, price, this.cfg.production.house, anchors.approach, anchors);
  }

  /**
   * Commissions a lens tower on the clan's high ground (its tower count incl. unfinished below the cap).
   * @returns {Project|null}
   */
  commissionTower(agent) {
    if (!this._canCommission(agent)) return null;
    const clan = agent.clan ?? 0;
    let pending = 0;
    for (const p of this.projects) if (p.kind === 'tower' && p.clan === clan) pending++;
    if (this.clanTowerCount(clan) + pending >= this.towerMax(clan)) return null;
    const price = this.towerBudget(clan);
    if (!(price > 0) || agent.glim < price) return null;
    const site = this._towerSite(clan);
    if (!site) return null;

    const base = copyCell(site.base);
    const stand = copyCell(site.stand);
    const tpl = towerTemplate(base.x, base.y, base.z);
    const lens = tpl.lens ? copyCell(tpl.lens) : { x: base.x, y: base.y + 3, z: base.z };
    return this._openProject('tower', agent, base, tpl.blocks, price, this.cfg.production.tower, stand, { lens, stand });
  }

  _canCommission(agent) {
    if (!isLive(agent) || !this.world) return false;
    if (agent.commissionId != null) {
      const p = this._projectById.get(agent.commissionId);
      if (p && isUnfinished(p)) return false;
      agent.commissionId = null;
    }
    return true;
  }

  _openProject(kind, owner, site, blocks, price, spec, approach, anchors) {
    // Build bottom-up so every block has support; the sort is stable so template order holds per layer.
    const sorted = blocks.map((b) => ({ x: b.x, y: b.y, z: b.z, id: b.id })).sort((a, b) => a.y - b.y);
    const p = {
      id: this._nextProjectId++,
      kind,
      clan: owner.clan ?? 0,
      ownerId: owner.id,
      masonId: null,
      site: copyCell(site),
      blocks: sorted,
      placed: 0,
      price,
      materials: { stone: spec.stone, log: spec.log },
      delivered: { stone: 0, log: 0 },
      status: 'open',
      createdTick: this._tick(),
      approach: copyCell(approach),
    };
    Object.defineProperty(p, '_anchors', { value: anchors, enumerable: false });
    // A transfer inside M: the price leaves the owner's glim and sits in the open project.
    owner.glim -= price;
    owner.commissionId = p.id;
    this.projects.push(p);
    this._projectById.set(p.id, p);
    this._rebuildMask();
    this._emit(EV.PROJECT_COMMISSIONED, { projectId: p.id, kind, ownerId: owner.id, site: copyCell(p.site), price });
    return p;
  }

  _preferredMarket(agent) {
    const clan = agent.clan ?? 0;
    const markets = this.worldInfo.markets || [];
    const market = this.sim && this.sim.market;
    if (market && typeof market.nearestMarket === 'function') {
      const m = market.nearestMarket(agent);
      if (Number.isInteger(m) && (markets[m]?.clan ?? 0) === clan) return m;
    }
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < markets.length; i++) {
      if ((markets[i].clan ?? 0) !== clan) continue;
      const c = markets[i].center;
      const dx = c.x - (agent.pos ? agent.pos.x : 0);
      const dz = c.z - (agent.pos ? agent.pos.z : 0);
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * Spirals out from a plaza over `house.siteR` for a 3×3 cottage origin (feet level).
   * Rules: 9 floor blocks in {MOSS, LOAM, PATH} at one height, air y0..y0+3, walkable approach,
   * 1-cell margin from structures/projects/towers/PAVING, ≥ 2 from tree trunks, inside the mask.
   * @param {number} nearMarketId
   * @returns {Cell|null} origin
   */
  findHouseSite(nearMarketId) {
    const markets = this.worldInfo.markets || [];
    const m = markets[nearMarketId] ? nearMarketId : 0;
    if (!markets[m] || !this.world) return null;
    this._validateSiteCache();
    let site = this._houseSiteCache.get(m);
    if (site === undefined) {
      site = this._houseSiteSearch(markets[m]);
      this._houseSiteCache.set(m, site);
    }
    return site ? copyCell(site) : null;
  }

  _houseSiteSearch(mk) {
    const [r0, r1] = this.cfg.production.house.siteR;
    const cx = Math.floor(mk.center.x);
    const cz = Math.floor(mk.center.z);
    const clan = mk.clan ?? 0;
    let found = null;
    for (let r = r0; r <= r1 && !found; r++) {
      scanRing(cx, cz, r, (fx, fz) => {
        const x0 = fx - 1;
        const z0 = fz - 1;
        const y0 = this._houseSiteY(x0, z0, clan);
        if (y0 < 0) return false;
        found = { x: x0, y: y0, z: z0 };
        return true;
      });
    }
    return found;
  }

  _houseSiteY(x0, z0, clan = 0) {
    const w = this.world;
    const SX = this.SX;
    if (x0 < 1 || z0 < 2 || x0 + 3 >= SX || z0 + 3 >= this.SZ) return -1;
    const hm = w.heightmap;
    const top = hm[x0 + SX * z0];
    if (top < 1) return -1;
    const clans = this.sim && this.sim.clans;
    const multi = !!(clans && clans.multi);
    for (let dz = 0; dz < 3; dz++) {
      for (let dx = 0; dx < 3; dx++) {
        const x = x0 + dx;
        const z = z0 + dz;
        if (!w.isInside(x, z) || hm[x + SX * z] !== top || !SOFT_GROUND[w.get(x, top, z)]) return -1;
        if (multi && clans.sectorAt(x, z) !== clan) return -1;
      }
    }
    if (multi && clans.sectorAt(x0 + 1, z0 - 1) !== clan) return -1;
    const y0 = top + 1;
    if (y0 + 4 >= this.SY) return -1;
    for (let dz = 0; dz < 3; dz++) {
      for (let dx = 0; dx < 3; dx++) {
        for (let y = y0; y <= y0 + 3; y++) if (w.get(x0 + dx, y, z0 + dz) !== B.AIR) return -1;
      }
    }
    const ax = x0 + 1;
    const az = z0 - 1;
    if (!w.isInside(ax, az) || !w.isWalkable(ax, y0, az)) return -1;
    if (!this._marginClear(x0, z0, x0 + 2, z0 + 2)) return -1;
    return this._reachable({ x: ax, y: y0, z: az }, clan) ? y0 : -1;
  }

  /**
   * Footprint [x0..x1]×[z0..z1]: no structure within 1 cell, no keep-clear cell inside,
   * no PAVING/KETTLE top within 1 cell and no tree trunk within 1 cell (distance ≥ 2).
   */
  _marginClear(x0, z0, x1, z1) {
    const w = this.world;
    const SX = this.SX;
    for (let z = z0 - 1; z <= z1 + 1; z++) {
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        if (x < 0 || z < 0 || x >= SX || z >= this.SZ) return false;
        const m = this._mask[x + SX * z];
        if (m & MASK_STRUCT) return false;
        if ((m & MASK_CLEAR) && x >= x0 && x <= x1 && z >= z0 && z <= z1) return false;
        const top = w.topBlock(x, z);
        if (top === B.PAVING || top === B.KETTLE) return false;
      }
    }
    for (const t of this.trees) {
      if (t.x >= x0 - 1 && t.x <= x1 + 1 && t.z >= z0 - 1 && t.z <= z1 + 1) return false;
    }
    return true;
  }

  /**
   * Finds a tower base (feet-level cell) on the ridge: x ≥ tower.minX, spaced ≥ minSpacing from
   * towers and tower projects, natural ground, air for the 4-high column, a walkable stand beside it.
   * @returns {Cell|null}
   */
  findTowerSite(clan = 0) {
    const s = this._towerSite(clan);
    return s ? copyCell(s.base) : null;
  }

  /** Cached tower site search per clan. @returns {{base:Cell, stand:Cell}|null} (shared; copy before storing) */
  _towerSite(clan = 0) {
    if (!this.world) return null;
    this._validateSiteCache();
    let s = this._towerSiteCache.get(clan);
    if (s === undefined) {
      s = this._towerSiteSearch(clan);
      this._towerSiteCache.set(clan, s);
    }
    return s;
  }

  /** Drops cached site searches once voxels or structures have changed. */
  _validateSiteCache() {
    const v = this.world.version;
    if (v === this._siteWorldVer && this._structVer === this._siteStructVer) return;
    this._siteWorldVer = v;
    this._siteStructVer = this._structVer;
    this._houseSiteCache.clear();
    this._towerSiteCache.clear();
  }

  _towerSiteSearch(clan = 0) {
    const spec = this.cfg.production.tower;
    const multi = !!(this.sim && this.sim.clans && this.sim.clans.multi);
    // Spiral from the centroid of the clan's towers (its hill), else from its (first) plaza.
    let ax = 0;
    let az = 0;
    let n = 0;
    for (const t of this.towers) { if (t.clan !== clan) continue; ax += t.base.x; az += t.base.z; n++; }
    if (n > 0) { ax = Math.round(ax / n); az = Math.round(az / n); } else {
      const markets = this.worldInfo.markets || [];
      const mk = multi ? markets.find((m) => (m.clan ?? 0) === clan) : markets[0];
      ax = mk ? Math.floor(mk.center.x) : spec.minX + 10;
      az = mk ? Math.floor(mk.center.z) : this.cfg.world.CZ;
    }
    if (!multi) ax = Math.max(ax, spec.minX);
    const maxR = Math.max(this.SX, this.SZ);
    let found = null;
    for (let r = 0; r <= maxR && !found; r++) {
      scanRing(ax, az, r, (x, z) => {
        const s = this._towerSiteAt(x, z, spec, clan);
        if (!s) return false;
        found = s;
        return true;
      });
    }
    return found;
  }

  _towerSiteAt(x, z, spec, clan = 0) {
    const w = this.world;
    const clans = this.sim && this.sim.clans;
    const multi = !!(clans && clans.multi);
    if ((!multi && x < spec.minX) || x < 1 || z < 1 || x >= this.SX - 1 || z >= this.SZ - 1 || !w.isInside(x, z)) return null;
    if (multi && clans.sectorAt(x, z) !== clan) return null;
    const top = w.heightmap[x + this.SX * z];
    if (top < 1 || !TOWER_GROUND[w.get(x, top, z)]) return null;
    const y = top + 1;
    if (y + 4 >= this.SY) return null;
    for (let yy = y; yy <= y + 4; yy++) if (w.get(x, yy, z) !== B.AIR) return null;

    const minSp2 = spec.minSpacing * spec.minSpacing;
    for (const t of this.towers) {
      const dx = t.base.x - x;
      const dz = t.base.z - z;
      if (dx * dx + dz * dz < minSp2) return null;
    }
    for (const p of this.projects) {
      if (p.kind !== 'tower') continue;
      const dx = p.site.x - x;
      const dz = p.site.z - z;
      if (dx * dx + dz * dz < minSp2) return null;
    }
    if (!this._marginClear(x, z, x, z)) return null;

    for (let k = 0; k < 4; k++) {
      const sx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const sz = z + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (!w.isInside(sx, sz) || (this._mask[sx + this.SX * sz] & MASK_STRUCT)) continue;
      if (multi && clans.sectorAt(sx, sz) !== clan) continue;
      for (let dy = 0; dy <= 2; dy++) {
        const sy = dy === 0 ? y : dy === 1 ? y - 1 : y + 1;
        if (!w.isWalkable(sx, sy, sz)) continue;
        const stand = { x: sx, y: sy, z: sz };
        if (!this._reachable(stand, clan)) continue;
        return { base: { x, y, z }, stand };
      }
    }
    return null;
  }

  /**
   * Same walkable region as at least one plaza (of clan c when there are several clans);
   * skipped when the pathfinder cannot tell.
   */
  _reachable(cell, clan = 0) {
    const pf = this.sim && this.sim.pathfinder;
    const markets = this.worldInfo.markets || [];
    if (!pf || typeof pf.sameRegion !== 'function' || markets.length === 0) return true;
    const multi = !!(this.sim.clans && this.sim.clans.multi);
    for (const m of markets) {
      if (multi && (m.clan ?? 0) !== clan) continue;
      if (pf.sameRegion(cell, m.center)) return true;
    }
    return false;
  }

  // =========================================================================
  // Project work
  // =========================================================================

  /**
   * Unfinished projects (status 'open' or 'claimed'), oldest first. Their prices are part of M.
   * SPEC-GAP: "open" is read as "not done/abandoned" so M and the mason niche count include
   * projects already claimed by a mason; finished projects are dropped from `this.projects`.
   * @returns {Project[]} a fresh array
   */
  openProjects() {
    return this.projects.slice();
  }

  /**
   * Gives a mason its current project, or the oldest unclaimed one.
   * @returns {Project|null}
   */
  claimProject(agent) {
    if (!isLive(agent)) return null;
    if (agent.projectId != null) {
      const cur = this._projectById.get(agent.projectId);
      if (cur && isUnfinished(cur) && cur.masonId === agent.id) return cur;
      agent.projectId = null;
    }
    const clan = agent.clan ?? 0;
    for (const p of this.projects) {
      if (p.status !== 'open' || p.masonId != null || p.clan !== clan) continue;
      p.masonId = agent.id;
      p.status = 'claimed';
      agent.projectId = p.id;
      return p;
    }
    return null;
  }

  /** The mason drops its project; delivered materials stay on site. */
  releaseProject(agent) {
    if (!agent) return;
    const p = agent.projectId != null ? this._projectById.get(agent.projectId) : null;
    if (p && p.masonId === agent.id && isUnfinished(p)) {
      p.masonId = null;
      p.status = 'open';
    }
    for (const o of this.projects) {
      if (o.masonId === agent.id) { o.masonId = null; o.status = 'open'; }
    }
    agent.projectId = null;
  }

  /**
   * Moves stone and log from the agent's inventory into `project.delivered`, up to what is still needed.
   * @returns {number} units delivered
   */
  deliver(project, agent) {
    const p = this._resolveProject(project);
    if (!p || !isUnfinished(p) || !isLive(agent)) return 0;
    let n = 0;
    for (const k of MATERIALS) {
      const q = Math.min(p.materials[k] - p.delivered[k], countItem(agent, k));
      if (q > 0 && removeItem(agent, k, q)) {
        p.delivered[k] += q;
        n += q;
      }
    }
    return n;
  }

  /** Materials still to be delivered: {stone, log}. */
  missingMaterials(project) {
    const p = this._resolveProject(project);
    if (!p) return { stone: 0, log: 0 };
    return {
      stone: Math.max(0, p.materials.stone - p.delivered.stone),
      log: Math.max(0, p.materials.log - p.delivered.log),
    };
  }

  /** True when the delivered materials cover the next block. */
  canBuild(project) {
    const p = this._resolveProject(project);
    return !!p && isUnfinished(p) && p.placed < p.blocks.length && p.placed < this._buildAllowance(p);
  }

  /** @returns {{x:number,y:number,z:number,id:number}|null} the next block to place */
  nextBuildBlock(project) {
    const p = this._resolveProject(project);
    if (!p || !isUnfinished(p) || p.placed >= p.blocks.length) return null;
    return p.blocks[p.placed];
  }

  /**
   * Places the next block (world.set + AGENT_PLACED). The last block completes the project:
   * the mason is paid the price ('wage'), the House/Tower is created, the owner moves in or
   * operates it, and PROJECT_DONE fires. Materials gate progress proportionally.
   * @returns {boolean} true if a block was placed
   */
  buildNext(project, agent) {
    const p = this._resolveProject(project);
    if (!p || !isUnfinished(p) || !isLive(agent) || !this.world) return false;
    if (p.masonId !== agent.id) {
      if (p.masonId != null && this._agent(p.masonId)) return false;
      p.masonId = agent.id;
      p.status = 'claimed';
      agent.projectId = p.id;
    }
    if (p.placed >= p.blocks.length) { this._completeProject(p, agent); return false; }
    if (p.placed >= this._buildAllowance(p)) return false;

    const b = p.blocks[p.placed];
    const w = this.world;
    const cur = w.get(b.x, b.y, b.z);
    p.placed++;
    if (cur !== b.id && !isUnbreakable(cur) && w.inBounds(b.x, b.y, b.z)) {
      w.set(b.x, b.y, b.z, b.id);
      this._emit(EV.AGENT_PLACED, { agentId: agent.id, x: b.x, y: b.y, z: b.z, blockId: b.id });
      this._relocateOccupants(b.x, b.y, b.z);
    }
    if (p.placed >= p.blocks.length) this._completeProject(p, agent);
    return true;
  }

  /**
   * Blocks placeable with the delivered materials: floor(N · min_k delivered_k / materials_k).
   * SPEC-GAP: the SPEC does not say how materials gate building; progress is proportional to the
   * scarcest delivered material, so a fully supplied site can be finished and an unsupplied one not started.
   */
  _buildAllowance(p) {
    let frac = 1;
    for (const k of MATERIALS) {
      const need = p.materials[k];
      if (need > 0) frac = Math.min(frac, p.delivered[k] / need);
    }
    return Math.floor(p.blocks.length * frac + 1e-9);
  }

  _completeProject(p, mason) {
    if (!isUnfinished(p)) return;
    p.status = 'done';
    this._dropProject(p);

    const ledger = this.sim && this.sim.ledger;
    mason.glim += p.price;
    if (ledger) ledger.income(mason, p.price, 'wage');
    if (mason.projectId === p.id) mason.projectId = null;

    const owner = this._agent(p.ownerId);
    if (owner && owner.commissionId === p.id) owner.commissionId = null;
    const a = p._anchors || {};

    if (p.kind === 'house') {
      const anchors = a.door ? a : houseAnchors(p.site);
      const house = {
        id: this._nextHouseId,
        clan: p.clan ?? 0,
        origin: copyCell(p.site),
        door: copyCell(anchors.door),
        bed: copyCell(anchors.bed),
        approach: copyCell(anchors.approach),
        lanternSlots: anchors.lanternSlots.map(copyCell),
        capacity: this.cfg.production.house.capacity,
        residents: [],
        // SPEC-GAP: a dead owner's cottage has no owner and is a plain vacancy (§C.4 onAgentRemoved).
        ownerId: owner ? owner.id : null,
      };
      this._addHouse(house);
      if (owner && owner.homeId == null) this.claimBed(owner, house);
    } else {
      const tower = {
        id: this._nextTowerId,
        clan: p.clan ?? 0,
        base: copyCell(p.site),
        lens: a.lens ? copyCell(a.lens) : { x: p.site.x, y: p.site.y + 3, z: p.site.z },
        stand: copyCell(a.stand || p.approach),
        operatorId: null,
        lensQ: 0,
        lensCracksAt: 0,
        active: false,
        boostUntil: 0,
        mintedToday: 0,
      };
      this._addTower(tower);
      // SPEC-GAP: the owner operates the new tower only while still a lenswright (a switched
      // owner would never tend it and would block other lenswrights).
      if (owner && owner.profession === 'lenswright') {
        this.releaseTower(owner);
        tower.operatorId = owner.id;
        owner.towerId = tower.id;
      }
    }
    this._rebuildMask();
    this._emit(EV.PROJECT_DONE, {
      projectId: p.id, kind: p.kind, ownerId: p.ownerId, masonId: mason.id, site: copyCell(p.site),
    });
  }

  /**
   * Abandons an unfinished project: the price is refunded to the owner, or burned as 'death'
   * when the owner is gone. Placed blocks remain as a ruin.
   * @param {Project|number} project
   * @returns {boolean}
   */
  abandonProject(project) {
    const p = this._resolveProject(project);
    if (!p || !isUnfinished(p)) return false;
    p.status = 'abandoned';
    this._dropProject(p);
    const owner = this._agent(p.ownerId);
    if (owner) {
      owner.glim += p.price;
      if (owner.commissionId === p.id) owner.commissionId = null;
    } else {
      const ledger = this.sim && this.sim.ledger;
      if (ledger && p.price > 0) ledger.record('death', p.price);
    }
    const mason = p.masonId != null ? this._agent(p.masonId) : null;
    if (mason && mason.projectId === p.id) mason.projectId = null;
    p.masonId = null;
    this._rebuildMask();
    return true;
  }

  _dropProject(p) {
    const i = this.projects.indexOf(p);
    if (i >= 0) this.projects.splice(i, 1);
    this._projectById.delete(p.id);
  }

  _resolveProject(p) {
    if (p == null) return null;
    if (typeof p === 'object') return p;
    return this._projectById.get(p) || null;
  }

  /**
   * SPEC-GAP: new config key production.projectStaleDays (default 3). A project nobody has
   * started (no block placed, nothing delivered) is abandoned with a refund once it is that old
   * and unclaimed, or twice that old even if a mason holds it, so commissions whose site no mason
   * can serve do not lock money away forever.
   */
  _abandonStale(tick) {
    const limit = finiteOr(this.cfg.production.projectStaleDays, 3) * TICKS.PER_DAY;
    for (let i = this.projects.length - 1; i >= 0; i--) {
      const p = this.projects[i];
      if (p.placed > 0 || p.delivered.stone + p.delivered.log > 0) continue;
      const age = tick - p.createdTick;
      if ((p.masonId == null && age >= limit) || age >= 2 * limit) this.abandonProject(p);
    }
  }

  // =========================================================================
  // Bushes
  // =========================================================================

  /**
   * Strips a ripe bush: qty = floor(harvestYield·skill + rng()) for tenders, forageYield otherwise.
   * Excess beyond carry capacity is lost. Starts the regrowth timer and emits AGENT_HARVEST.
   * @returns {number} berries added to the inventory
   */
  harvestBush(x, y, z, agent) {
    const w = this.world;
    if (!w || !isLive(agent) || w.get(x, y, z) !== B.BUSH_RIPE) return 0;
    const pc = this.cfg.production;
    let qty = pc.forageYield;
    if (agent.profession === 'tender') {
      const skill = finiteOr(agent.skills && agent.skills.tender, 1);
      qty = Math.floor(pc.harvestYield * skill + this._rand());
    }
    w.set(x, y, z, B.BUSH_BARE);
    this.bushTimers.set(this._cellIndex(x, y, z), this._tick() + this._regrowTicks(x, z));
    const added = qty > 0 ? addItem(agent, 'berry', qty) : 0;
    this.reservations.delete(cellKey(x, y, z));
    this._emit(EV.AGENT_HARVEST, { agentId: agent.id, x, y, z, item: 'berry', qty: added });
    return added;
  }

  /**
   * Plants a bare bush at an air cell standing on MOSS/LOAM/PATH (bush count below maxBushes).
   * @returns {boolean}
   */
  plantBush(x, y, z, agent) {
    const w = this.world;
    if (!w || !isLive(agent)) return false;
    if (!w.inBounds(x, y, z) || y < 1 || !w.isInside(x, z)) return false;
    if (w.get(x, y, z) !== B.AIR || !SOFT_GROUND[w.get(x, y - 1, z)]) return false;
    if (this._mask[x + this.SX * z] & (MASK_STRUCT | MASK_CLEAR)) return false;
    if (this.bushCount() >= this.cfg.production.maxBushes) return false;
    const clans = this.sim && this.sim.clans;
    if (clans && clans.multi) {
      const c = clans.sectorAt(x, z);
      if (c >= clans.count || this.bushCount(c) >= this.bushMax(c)) return false;
    }
    if (this._cellOccupied(x, y, z)) return false;
    w.set(x, y, z, B.BUSH_BARE);
    this.bushTimers.set(this._cellIndex(x, y, z), this._tick() + this._regrowTicks(x, z));
    this._emit(EV.AGENT_PLACED, { agentId: agent.id, x, y, z, blockId: B.BUSH_BARE });
    return true;
  }

  /**
   * Nearest surface cell to (x, z) within 6 of water whose top block is MOSS, LOAM or PATH
   * (and, with several clans, on land the agent may work).
   * @param {object} [agent] the planter
   * @returns {Cell|null} the air cell to plant in
   */
  findPlantSite(x, z, agent = null) {
    const w = this.world;
    if (!w) return null;
    const clans = this.sim && this.sim.clans;
    const landOk = clans && clans.multi && agent ? (px, pz) => clans.resourceOk(agent, px, pz) : null;
    // SPEC-GAP: new config keys production.plantWaterR (default 6, SPEC text) and
    // production.plantSearchR (default: the island diameter).
    const waterR = finiteOr(this.cfg.production.plantWaterR, 6);
    const maxR = finiteOr(this.cfg.production.plantSearchR, this.cfg.world.RADIUS * 2);
    const cx = Math.floor(x);
    const cz = Math.floor(z);
    const SX = this.SX;
    let found = null;
    for (let r = 0; r <= maxR && !found; r++) {
      scanRing(cx, cz, r, (px, pz) => {
        if (px < 0 || pz < 0 || px >= SX || pz >= this.SZ) return false;
        const col = px + SX * pz;
        if (this._waterDist[col] > waterR || (this._mask[col] & (MASK_STRUCT | MASK_CLEAR))) return false;
        if (!w.isInside(px, pz)) return false;
        const top = w.heightmap[col];
        if (top < 1 || top + 2 >= this.SY || !SOFT_GROUND[w.get(px, top, pz)]) return false;
        if (w.get(px, top + 1, pz) !== B.AIR || w.get(px, top + 2, pz) !== B.AIR) return false;
        if (this._cellOccupied(px, top + 1, pz)) return false;
        if (landOk && !landOk(px, pz)) return false;
        found = { x: px, y: top + 1, z: pz };
        return true;
      });
    }
    return found;
  }

  /** Bushes on the island (ripe + bare), or only on clan c's land when there are several clans. */
  bushCount(clan) {
    const w = this.world;
    const clans = this.sim && this.sim.clans;
    if (clan != null && clans && clans.multi && w) {
      if (this._bushVer !== w.version) {
        // A bush is always the top solid block of its column, so one pass over the columns counts them.
        this._bushVer = w.version;
        const by = this._bushBy || (this._bushBy = new Int32Array(clans.count));
        by.fill(0);
        for (let z = 0; z < this.SZ; z++) {
          for (let x = 0; x < this.SX; x++) {
            const top = w.topBlock(x, z);
            if (top !== B.BUSH_RIPE && top !== B.BUSH_BARE) continue;
            const s = clans.sectorAt(x, z);
            if (s < by.length) by[s]++;
          }
        }
      }
      return this._bushBy[clan] ?? 0;
    }
    if (w && typeof w.countBlocks === 'function') return w.countBlocks(B.BUSH_RIPE) + w.countBlocks(B.BUSH_BARE);
    return this.bushTimers.size;
  }

  /** Most bushes clan c's farmers may plant (a fair share of the island cap). */
  bushMax(clan) {
    const clans = this.sim && this.sim.clans;
    const max = this.cfg.production.maxBushes;
    if (clan == null || !clans || !clans.multi) return max;
    let total = 0;
    for (const cl of clans.list) total += cl.initial;
    return Math.max(24, Math.round((max * (clans.list[clan]?.initial ?? 0)) / Math.max(1, total)));
  }

  /** Regrowth: bushRegrowHours, sped up ×waterMul within waterRadius of water. */
  _regrowTicks(x, z) {
    const pc = this.cfg.production;
    const col = x + this.SX * z;
    const wet = col >= 0 && col < this._waterDist.length && this._waterDist[col] <= pc.waterRadius;
    return Math.round((pc.bushRegrowHours / (wet ? pc.waterMul : 1)) * TICKS.PER_HOUR);
  }

  _ripenBushes(tick) {
    if (this.bushTimers.size === 0) return;
    const w = this.world;
    const SX = this.SX;
    const layer = SX * this.SZ;
    for (const [idx, ready] of this.bushTimers) {
      const y = Math.floor(idx / layer);
      const rem = idx - y * layer;
      const z = Math.floor(rem / SX);
      const x = rem - z * SX;
      if (w.get(x, y, z) !== B.BUSH_BARE) { this.bushTimers.delete(idx); continue; }
      if (this.isEclipsed(x + 0.5, z + 0.5)) { this.bushTimers.set(idx, ready + TICKS.PER_HOUR); continue; }
      if (ready <= tick) {
        w.set(x, y, z, B.BUSH_RIPE);
        this.bushTimers.delete(idx);
      }
    }
  }

  // =========================================================================
  // Trees
  // =========================================================================

  /**
   * Nearest mature tree to (x, z) within maxDist whose trunk key is not reserved by another agent
   * (and, with several clans, on land the agent may work).
   * @param {object} [agent] the woodcutter
   * @returns {Tree|null}
   */
  nearestMatureTree(x, z, maxDist, agentId, agent = null) {
    const w = this.world;
    if (!w) return null;
    const clans = this.sim && this.sim.clans;
    const landOk = clans && clans.multi && agent;
    const max2 = finiteOr(maxDist, Infinity) ** 2;
    let best = null;
    let bestD = Infinity;
    for (const t of this.trees) {
      if (t.stage !== 'mature') continue;
      const dx = t.x + 0.5 - x;
      const dz = t.z + 0.5 - z;
      const d = dx * dx + dz * dz;
      if (d > max2 || d >= bestD) continue;
      if (w.get(t.x, t.y, t.z) !== B.LOG) continue;
      if (this.isReserved(cellKey(t.x, t.y, t.z), agentId)) continue;
      if (landOk && !clans.resourceOk(agent, t.x, t.z)) continue;
      best = t;
      bestD = d;
    }
    return best;
  }

  /**
   * Fells a mature tree: removes its LOG and NEEDLES, gives logs (and amber with treeAmberChance),
   * leaves a SAPLING that regrows after saplingDays, and emits TREE_FELLED.
   * @param {number|Tree} treeId
   * @returns {{logs:number, amber:number}} units added to the inventory
   */
  fellTree(treeId, agent) {
    const t = treeId != null && typeof treeId === 'object' ? this._treeById.get(treeId.id) : this._treeById.get(treeId);
    const w = this.world;
    if (!t || !w || t.stage !== 'mature' || !isLive(agent)) return { logs: 0, amber: 0 };
    if (w.get(t.x, t.y, t.z) !== B.LOG) {
      this._removeTreeAt(this.trees.indexOf(t));
      return { logs: 0, amber: 0 };
    }
    const tpl = treeTemplate(t.x, t.y, t.z, t.height);
    let logs = 0;
    for (const b of tpl.blocks) {
      const cur = w.get(b.x, b.y, b.z);
      if (b.id === B.LOG && cur === B.LOG) { w.set(b.x, b.y, b.z, B.AIR); logs++; } else if (b.id === B.NEEDLES && cur === B.NEEDLES) {
        w.set(b.x, b.y, b.z, B.AIR);
      }
    }
    const pc = this.cfg.production;
    const gotLogs = logs > 0 ? addItem(agent, 'log', logs) : 0;
    const gotAmber = this._rand() < pc.treeAmberChance ? addItem(agent, 'amber', 1) : 0;

    this.reservations.delete(cellKey(t.x, t.y, t.z));
    if (w.get(t.x, t.y, t.z) === B.AIR && w.isSolidAt(t.x, t.y - 1, t.z)) {
      w.set(t.x, t.y, t.z, B.SAPLING);
      t.stage = 'sapling';
      t.height = this._randInt(pc.treeHeight[0], pc.treeHeight[1]);
      t.matureAtTick = this._tick() + pc.saplingDays * TICKS.PER_DAY;
    } else {
      this._removeTreeAt(this.trees.indexOf(t));
    }
    this._emit(EV.TREE_FELLED, { x: t.x, y: t.y, z: t.z, logs, agentId: agent.id });
    return { logs: gotLogs, amber: gotAmber };
  }

  _growSaplings(tick) {
    const w = this.world;
    for (let i = this.trees.length - 1; i >= 0; i--) {
      const t = this.trees[i];
      if (t.stage !== 'sapling') continue;
      if (w.get(t.x, t.y, t.z) !== B.SAPLING) { this._removeTreeAt(i); continue; }
      if (tick < t.matureAtTick) continue;
      const tpl = treeTemplate(t.x, t.y, t.z, t.height);
      if (!this._treeSpaceClear(t, tpl.blocks)) { t.matureAtTick = tick + TICKS.PER_HOUR; continue; }
      for (const b of tpl.blocks) {
        if (b.id === B.LOG) w.set(b.x, b.y, b.z, B.LOG);
        else if (w.get(b.x, b.y, b.z) === B.AIR) w.set(b.x, b.y, b.z, b.id);
      }
      t.stage = 'mature';
    }
  }

  _treeSpaceClear(t, blocks) {
    const w = this.world;
    let x0 = t.x, x1 = t.x, y0 = t.y, y1 = t.y, z0 = t.z, z1 = t.z;
    for (const b of blocks) {
      if (!w.inBounds(b.x, b.y, b.z)) return false;
      const cur = w.get(b.x, b.y, b.z);
      const isBase = b.x === t.x && b.y === t.y && b.z === t.z;
      if (!(cur === B.AIR || cur === B.NEEDLES || (isBase && cur === B.SAPLING))) return false;
      if (this._mask[b.x + this.SX * b.z] & (MASK_STRUCT | MASK_CLEAR)) return false;
      if (b.x < x0) x0 = b.x; if (b.x > x1) x1 = b.x;
      if (b.y < y0) y0 = b.y; if (b.y > y1) y1 = b.y;
      if (b.z < z0) z0 = b.z; if (b.z > z1) z1 = b.z;
    }
    const agents = this._agents();
    for (let i = 0; i < agents.length; i++) {
      const c = agents[i].cell;
      if (!c || c.x < x0 || c.x > x1 || c.z < z0 || c.z > z1 || c.y + 1 < y0 || c.y > y1) continue;
      for (const b of blocks) {
        if (b.x === c.x && b.z === c.z && (b.y === c.y || b.y === c.y + 1)) return false;
      }
    }
    return true;
  }

  /**
   * Stabilizer: while mature trees < minTrees, `wildSaplings` saplings sprout on open moss.
   * SPEC-GAP: "trees" counts mature trees; saplings are not yet trees.
   */
  _wildSaplings(tick) {
    const pc = this.cfg.production;
    let mature = 0;
    for (const t of this.trees) if (t.stage === 'mature') mature++;
    if (mature >= pc.minTrees) return;
    const w = this.world;
    let planted = 0;
    for (let attempt = 0; attempt < pc.wildSaplings * 60 && planted < pc.wildSaplings; attempt++) {
      const x = this._randInt(0, this.SX - 1);
      const z = this._randInt(0, this.SZ - 1);
      const y = this._saplingSiteY(x, z);
      if (y < 0) continue;
      w.set(x, y, z, B.SAPLING);
      this._addTree({
        id: this._nextTreeId, x, y, z,
        height: this._randInt(pc.treeHeight[0], pc.treeHeight[1]),
        stage: 'sapling',
        matureAtTick: tick + pc.saplingDays * TICKS.PER_DAY,
      });
      planted++;
    }
    if (planted > 0) this._stabilizer('wildSapling', planted, ['stab.saplings', { n: planted }]);
  }

  _saplingSiteY(x, z) {
    const w = this.world;
    if (x < 2 || z < 2 || x >= this.SX - 2 || z >= this.SZ - 2 || !w.isInside(x, z)) return -1;
    const top = w.heightmap[x + this.SX * z];
    if (top < 1 || top + 3 >= this.SY || w.get(x, top, z) !== B.MOSS) return -1;
    const y = top + 1;
    if (w.get(x, y, z) !== B.AIR || w.get(x, y + 1, z) !== B.AIR) return -1;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (this._mask[x + dx + this.SX * (z + dz)]) return -1;
        if (w.topBlock(x + dx, z + dz) === B.PAVING) return -1;
      }
    }
    for (const t of this.trees) {
      if (Math.abs(t.x - x) < 3 && Math.abs(t.z - z) < 3) return -1;
    }
    if (this._cellOccupied(x, y, z)) return -1;
    return y;
  }

  // =========================================================================
  // Land stabilizers: bog, moss, desire paths
  // =========================================================================

  /** Stabilizer: up to peatAccretion bog cells in each pond's bog ring turn (back) into PEAT each dawn. */
  _bogAccretion() {
    const ponds = this.worldInfo.ponds || (this.worldInfo.pond ? [this.worldInfo.pond] : []);
    let total = 0;
    for (const pond of ponds) total += this._bogAccreteAround(pond);
    if (total > 0) this._stabilizer('bogAccretion', total, ['stab.bog', { n: total }]);
  }

  _bogAccreteAround(pond) {
    const w = this.world;
    const target = this.cfg.production.peatAccretion;
    const ring = this.cfg.worldgen.bogRing;
    let added = 0;
    for (let attempt = 0; attempt < target * 30 && added < target; attempt++) {
      const a = this._rand() * TWO_PI;
      const d = pond.r + ring[0] + this._rand() * (ring[1] - ring[0]);
      const x = Math.floor(pond.x + Math.cos(a) * d);
      const z = Math.floor(pond.z + Math.sin(a) * d);
      if (x < 1 || z < 1 || x >= this.SX - 1 || z >= this.SZ - 1 || !w.isInside(x, z)) continue;
      const col = x + this.SX * z;
      if (this._mask[col]) continue;
      const y = w.heightmap[col];
      if (y < 1 || y + 2 >= this.SY || w.get(x, y + 1, z) !== B.AIR) continue;
      const top = w.get(x, y, z);
      if (top === B.LOAM || top === B.MOSS) {
        w.set(x, y, z, B.PEAT);
        added++;
      } else if (top === B.PEAT && this._isPit(x, z, y) && w.get(x, y + 2, z) === B.AIR && !this._cellOccupied(x, y + 1, z)) {
        w.set(x, y + 1, z, B.PEAT); // peat grows up out of a dug pit
        added++;
      }
    }
    return added;
  }

  _isPit(x, z, y) {
    const hm = this.world.heightmap;
    const SX = this.SX;
    return hm[x + 1 + SX * z] > y && hm[x - 1 + SX * z] > y && hm[x + SX * (z + 1)] > y && hm[x + SX * (z - 1)] > y;
  }

  /** Stabilizer: sampled exposed LOAM next to moss turns back into MOSS. */
  _spreadMoss() {
    const w = this.world;
    const pc = this.cfg.production;
    const SX = this.SX;
    const hm = w.heightmap;
    let converted = 0;
    for (let i = 0; i < pc.mossSamplesPerHour; i++) {
      const x = this._randInt(1, SX - 2);
      const z = this._randInt(1, this.SZ - 2);
      const col = x + SX * z;
      const y = hm[col];
      if (y < 0 || y + 1 >= this.SY || !w.isInside(x, z)) continue;
      if (w.get(x, y, z) !== B.LOAM || w.get(x, y + 1, z) !== B.AIR) continue;
      if (w.topBlock(x + 1, z) !== B.MOSS && w.topBlock(x - 1, z) !== B.MOSS &&
          w.topBlock(x, z + 1) !== B.MOSS && w.topBlock(x, z - 1) !== B.MOSS) continue;
      if (this._rand() >= pc.mossChance) continue;
      w.set(x, y, z, B.MOSS);
      converted++;
    }
    if (converted > 0) this._stabilizer('mossSpread', converted, ['stab.moss', { n: converted }]);
  }

  /**
   * Dawn pass over every column: desire paths from footfall (MOSS → PATH at ≥ pathFootfall,
   * PATH → MOSS after pathDecayDays dawns without footfall), then footfall resets. The same pass
   * adopts any bare bush that has no regrowth timer (e.g. placed by another module).
   */
  _desirePaths() {
    const w = this.world;
    const ff = w.footfall;
    const hm = w.heightmap;
    const pc = this.cfg.production;
    const SX = this.SX;
    const SZ = this.SZ;
    const tick = this._tick();
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const col = x + SX * z;
        const y = hm[col];
        if (y < 0) continue;
        const top = w.get(x, y, z);
        const f = ff ? ff[col] : 0;
        if (top === B.MOSS) {
          if (f >= pc.pathFootfall && w.isInside(x, z)) { w.set(x, y, z, B.PATH); this._pathIdle[col] = 0; }
        } else if (top === B.PATH) {
          if (f > 0) this._pathIdle[col] = 0;
          else if (++this._pathIdle[col] >= pc.pathDecayDays && w.get(x, y + 1, z) !== B.WATER) {
            w.set(x, y, z, B.MOSS);
            this._pathIdle[col] = 0;
          }
        } else if (top === B.BUSH_BARE) {
          this._adoptBush(x, y, z, tick);
        }
        if (y + 1 < this.SY && w.get(x, y + 1, z) === B.BUSH_BARE) this._adoptBush(x, y + 1, z, tick);
      }
    }
    if (ff) ff.fill(0);
  }

  _adoptBush(x, y, z, tick) {
    const idx = this._cellIndex(x, y, z);
    if (!this.bushTimers.has(idx)) this.bushTimers.set(idx, tick + this._regrowTicks(x, z));
  }

  // =========================================================================
  // Reservations
  // =========================================================================

  /**
   * Reserves a target ("x,y,z") for an agent. Fails if another agent holds a live reservation.
   * @returns {boolean}
   */
  reserve(key, agentId, hours) {
    const tick = this._tick();
    const r = this.reservations.get(key);
    if (r && r.until > tick && r.agentId !== agentId) return false;
    const until = tick + Math.max(1, Math.round(finiteOr(hours, 1) * TICKS.PER_HOUR));
    if (r) { r.agentId = agentId; r.until = until; } else this.reservations.set(key, { agentId, until });
    return true;
  }

  /** True if `key` is held by an agent other than `agentId`. */
  isReserved(key, agentId) {
    const r = this.reservations.get(key);
    if (!r) return false;
    if (!(r.until > this._tick())) { this.reservations.delete(key); return false; }
    return r.agentId !== agentId;
  }

  /** Drops the agent's reservation of `key` (extra helper). */
  unreserve(key, agentId) {
    const r = this.reservations.get(key);
    if (r && r.agentId === agentId) this.reservations.delete(key);
  }

  // =========================================================================
  // Lanterns
  // =========================================================================

  /**
   * Lights a lantern from the inventory (≤ maxLanterns lit, each lasting lanternLifeDays).
   * A housed agent's lantern also takes the next free lantern slot of its cottage.
   * @returns {boolean}
   */
  lightLantern(agent) {
    if (!isLive(agent) || !Array.isArray(agent.lanterns)) return false;
    if (agent.lanterns.length >= this.cfg.agent.maxLanterns) return false;
    if (countItem(agent, 'lantern') < 1 || !removeItem(agent, 'lantern', 1)) return false;
    const until = this._tick() + Math.round(this.cfg.agent.lanternLifeDays * TICKS.PER_DAY);
    agent.lanterns.push(until);
    const h = this.houseOf(agent.id);
    if (h) this._placeLantern(h, agent.id, until);
    return true;
  }

  /** Positions of lanterns burning in cottage slots (read-only; reused between calls). */
  litLanterns() {
    return this._lanterns;
  }

  _placeLantern(house, agentId, until) {
    const w = this.world;
    if (!w) return false;
    for (const s of house.lanternSlots) {
      if (this._lanternAt(s.x, s.y, s.z)) continue;
      const prev = w.get(s.x, s.y, s.z);
      if (NO_LANTERN[prev] || this._cellOccupied(s.x, s.y, s.z)) continue;
      w.set(s.x, s.y, s.z, B.LANTERN);
      this._lanterns.push({ x: s.x, y: s.y, z: s.z, prev, until, agentId, houseId: house.id });
      this._emit(EV.AGENT_PLACED, { agentId, x: s.x, y: s.y, z: s.z, blockId: B.LANTERN });
      return true;
    }
    return false;
  }

  _lanternAt(x, y, z) {
    for (const e of this._lanterns) if (e.x === x && e.y === y && e.z === z) return true;
    return false;
  }

  /** Hangs the agent's lit lanterns that are not yet in a slot (lit while unhoused, or slots were full). */
  _placeAgentLanterns(agent, house) {
    if (!agent || !Array.isArray(agent.lanterns) || agent.lanterns.length === 0) return;
    const placed = [];
    for (const e of this._lanterns) if (e.agentId === agent.id) placed.push(e.until);
    for (const until of agent.lanterns) {
      const i = placed.indexOf(until);
      if (i >= 0) { placed.splice(i, 1); continue; }
      if (!this._placeLantern(house, agent.id, until)) break;
    }
  }

  /** Removes an agent's slot lanterns, restoring the slot blocks. @returns {boolean} any removed */
  _takeDownLanterns(agentId) {
    const w = this.world;
    let any = false;
    for (let i = this._lanterns.length - 1; i >= 0; i--) {
      const e = this._lanterns[i];
      if (e.agentId !== agentId) continue;
      if (w && w.get(e.x, e.y, e.z) === B.LANTERN) w.set(e.x, e.y, e.z, e.prev);
      this._lanterns.splice(i, 1);
      any = true;
    }
    return any;
  }

  /** Offers a house's free lantern slots to its residents' unplaced lanterns. */
  _rehang(house) {
    for (let i = 0; i < house.residents.length; i++) {
      const a = this._agent(house.residents[i]);
      if (a) this._placeAgentLanterns(a, house);
    }
  }

  /**
   * Hourly: drops expired expiry ticks from `agent.lanterns` and takes down expired slot lanterns
   * (restoring the slot block). A slot lantern whose block was dug away is destroyed: it leaves
   * the slot list and its owner's `lanterns`. Freed slots go to residents' waiting lanterns.
   */
  _expireLanterns(tick) {
    const w = this.world;
    let freed = false;
    for (let i = this._lanterns.length - 1; i >= 0; i--) {
      const e = this._lanterns[i];
      const present = w.get(e.x, e.y, e.z) === B.LANTERN;
      if (e.until > tick && present) continue;
      if (present) {
        w.set(e.x, e.y, e.z, e.prev);
      } else if (e.until > tick) {
        const owner = this._agent(e.agentId);
        const L = owner && owner.lanterns;
        const j = L ? L.indexOf(e.until) : -1;
        if (j >= 0) L.splice(j, 1);
      }
      this._lanterns.splice(i, 1);
      freed = true;
    }
    const agents = this._agents();
    for (let i = 0; i < agents.length; i++) {
      const L = agents[i].lanterns;
      if (!L || L.length === 0) continue;
      let n = 0;
      for (let j = 0; j < L.length; j++) if (L[j] > tick) L[n++] = L[j];
      L.length = n;
    }
    if (!freed) return;
    for (const h of this.houses) if (h.residents.length > 0) this._rehang(h);
  }

  // =========================================================================
  // Estimates (§D.7)
  // =========================================================================

  /**
   * Theoretical income per day for a profession at average prices (§D.7 table), for clan c
   * (its own market prices, towers and building jobs).
   * @param {string} prof
   * @param {number} [clan=0]
   * @returns {number} glim/day
   */
  estimateIncome(prof, clan = 0) {
    const e = this.cfg.production.est;
    const P = (g) => this._avgP(g, clan);
    switch (prof) {
      case 'tender':
        return e.tenderBerries * P('berry');
      case 'chandler':
        return e.chandlerBatches * Math.max(0, 2 * P('tablet') - 3 * P('berry') - P('peat'));
      case 'delver':
        return e.delverQuartz * P('quartz') + e.delverStone * P('stone') + e.delverAmber * P('amber');
      case 'woodwarden':
        return Math.max(e.wardenLogs * P('log'), e.wardenPeat * P('peat')) + 0.3 * P('amber');
      case 'mason': {
        let count = 0;
        for (const p of this.projects) if (p.clan === clan) count++;
        if (count === 0) return 0;
        const ps = P('stone');
        const pl = P('log');
        let sum = 0;
        for (const p of this.projects) if (p.clan === clan) sum += p.price - (p.materials.stone * ps + p.materials.log * pl);
        // SPEC-GAP: clamped at 0 (a loss-making niche advertises nothing).
        return Math.max(0, e.masonProjects * (sum / count));
      }
      case 'lenswright': {
        let free = false;
        for (const t of this.towers) if (t.clan === clan && this._towerFree(t)) { free = true; break; }
        if (!free) return 0;
        const m = this.cfg.money;
        return (m.mintPerHour * 24 / Math.PI) * this._eta() - (2 * P('quartz')) / m.lensLifeDays;
      }
      case 'porter': {
        const market = this.sim && this.sim.market;
        const fee = this.cfg.market.fee;
        const clans = this.sim && this.sim.clans;
        // Markets this clan can trade at (every plaza in the classic jar).
        const open = clans && clans.multi ? clans.openMarkets(clan) : null;
        const nm = open ? open.length : (this.worldInfo.markets || []).length || 2;
        let best = 0;
        for (const g in this.cfg.goods) {
          let hi = -Infinity;
          let lo = Infinity;
          for (let k = 0; k < nm; k++) {
            const m = open ? open[k] : k;
            const p = market && typeof market.price === 'function' ? finiteOr(market.price(m, g), NaN) : NaN;
            const v = p > 0 ? p : this.cfg.goods[g].ref;
            if (v > hi) hi = v;
            if (v < lo) lo = v;
          }
          const spread = (1 - fee) * hi - lo;
          if (spread > best) best = spread;
        }
        return e.porterTrips * this.cfg.professions.porter.carry * best * 0.5;
      }
      default:
        return 0;
    }
  }

  /**
   * Cost of feeding one Wickling of clan c for a day with the cheaper food per tallow point.
   * @returns {number} glim/day
   */
  subsistenceCost(clan = 0) {
    const g = this.cfg.goods;
    const perTallow = Math.min(this._avgP('berry', clan) / g.berry.tallow, this._avgP('tablet', clan) / g.tablet.tallow);
    return this.cfg.agent.tallowPerDay * perTallow;
  }

  // =========================================================================
  // Save files
  // =========================================================================

  /**
   * Towers, cottages, building sites, trees, bush timers and hanging lanterns. Reservations are
   * not saved: they belong to tasks, and on load every Wickling decides afresh.
   */
  serialize() {
    const copy = (v) => JSON.parse(JSON.stringify(v));
    const bush = [];
    for (const [idx, t] of this.bushTimers) bush.push(idx, t);
    return {
      next: [this._nextTowerId, this._nextHouseId, this._nextProjectId, this._nextTreeId],
      towers: copy(this.towers),
      houses: copy(this.houses),
      projects: this.projects.map((p) => ({ ...copy(p), anchors: p._anchors ? copy(p._anchors) : null })),
      trees: this.trees.map((t) => [t.id, t.x, t.y, t.z, t.height, t.stage === 'mature' ? 1 : 0, t.matureAtTick]),
      bushTimers: bush,
      lanterns: copy(this._lanterns),
      pathIdle: bytesToB64(rleEncode(this._pathIdle)),
    };
  }

  /** Replace every structure and timer with saved ones (see serialize); agents must exist already. */
  restore(s) {
    if (!s) return;
    const cell = (c) => ({ x: c?.x | 0, y: c?.y | 0, z: c?.z | 0 });
    this.towers = [];
    this.houses = [];
    this.projects = [];
    this.trees = [];
    this._towerById.clear();
    this._houseById.clear();
    this._projectById.clear();
    this._treeById.clear();
    this._homeOf.clear();
    this.bushTimers.clear();
    this.reservations.clear();
    this._lanterns = [];
    for (const t of Array.isArray(s.towers) ? s.towers : []) {
      if (!t || !Number.isInteger(t.id)) continue;
      this._addTower({
        id: t.id, clan: t.clan | 0, base: cell(t.base), lens: cell(t.lens), stand: cell(t.stand),
        operatorId: Number.isInteger(t.operatorId) ? t.operatorId : null,
        lensQ: finiteOr(t.lensQ, 0), lensCracksAt: finiteOr(t.lensCracksAt, 0), active: !!t.active,
        boostUntil: finiteOr(t.boostUntil, 0), mintedToday: finiteOr(t.mintedToday, 0),
      });
    }
    for (const h of Array.isArray(s.houses) ? s.houses : []) {
      if (!h || !Number.isInteger(h.id)) continue;
      const house = {
        id: h.id, clan: h.clan | 0, origin: cell(h.origin), door: cell(h.door), bed: cell(h.bed), approach: cell(h.approach),
        lanternSlots: (Array.isArray(h.lanternSlots) ? h.lanternSlots : []).map(cell),
        capacity: Number.isInteger(h.capacity) ? h.capacity : this.cfg.production.house.capacity,
        residents: (Array.isArray(h.residents) ? h.residents : []).filter(Number.isInteger),
        ownerId: Number.isInteger(h.ownerId) ? h.ownerId : null,
      };
      this._addHouse(house);
      for (const id of house.residents) this._homeOf.set(id, house.id);
    }
    for (const r of Array.isArray(s.projects) ? s.projects : []) {
      if (!r || !Number.isInteger(r.id) || !Array.isArray(r.blocks)) continue;
      const { anchors, ...rest } = r;
      const p = { ...rest, site: cell(r.site), approach: cell(r.approach) };
      if (p.status !== 'open' && p.status !== 'claimed') continue;
      Object.defineProperty(p, '_anchors', { value: anchors || undefined, enumerable: false });
      this.projects.push(p);
      this._projectById.set(p.id, p);
    }
    for (const row of Array.isArray(s.trees) ? s.trees : []) {
      const [id, x, y, z, height, mature, matureAtTick] = row;
      if (!Number.isInteger(id)) continue;
      this._addTree({ id, x, y, z, height, stage: mature ? 'mature' : 'sapling', matureAtTick: finiteOr(matureAtTick, 0) });
    }
    const bt = Array.isArray(s.bushTimers) ? s.bushTimers : [];
    for (let i = 0; i + 1 < bt.length; i += 2) this.bushTimers.set(bt[i], bt[i + 1]);
    for (const e of Array.isArray(s.lanterns) ? s.lanterns : []) {
      if (e && Number.isInteger(e.x)) this._lanterns.push({ ...e });
    }
    if (typeof s.pathIdle === 'string') this._pathIdle.set(rleDecode(b64ToBytes(s.pathIdle), this._pathIdle.length));
    const [nt, nh, np, ntr] = Array.isArray(s.next) ? s.next : [];
    this._nextTowerId = Math.max(this._nextTowerId, nt | 0);
    this._nextHouseId = Math.max(this._nextHouseId, nh | 0);
    let maxP = 0;
    for (const p of this.projects) if (p.id > maxP) maxP = p.id;
    this._nextProjectId = Math.max(maxP + 1, np | 0, 1);
    this._nextTreeId = Math.max(this._nextTreeId, ntr | 0);
    this._bushVer = undefined;
    this._rebuildMask();
    this._refreshWaterMap(true);
  }

  // =========================================================================
  // Agent removal
  // =========================================================================

  /**
   * Releases the agent's tower, bed, mason project and reservations. A commission the agent paid
   * for stays open; if it finishes, the cottage becomes a vacancy.
   */
  onAgentRemoved(agent) {
    if (!agent) return;
    this.releaseTower(agent);
    this.releaseBed(agent);
    this.releaseProject(agent);
    for (const h of this.houses) if (h.ownerId === agent.id) h.ownerId = null;
    for (const [k, r] of this.reservations) if (r.agentId === agent.id) this.reservations.delete(k);
  }

  // =========================================================================
  // Hourly bookkeeping
  // =========================================================================

  /** Drops stale links to agents that died without onAgentRemoved, dead trees and old reservations. */
  _sweepHourly(tick) {
    for (const [k, r] of this.reservations) if (!(r.until > tick)) this.reservations.delete(k);
    const w = this.world;
    for (let i = this.trees.length - 1; i >= 0; i--) {
      const t = this.trees[i];
      if (t.stage === 'mature' && w.get(t.x, t.y, t.z) !== B.LOG) this._removeTreeAt(i);
    }
    if (!this._hasPopulation()) return; // cannot tell dead agents from a missing registry
    for (const h of this.houses) {
      for (let i = h.residents.length - 1; i >= 0; i--) {
        const id = h.residents[i];
        const a = this._agent(id);
        if (!a || a.homeId !== h.id) {
          h.residents.splice(i, 1);
          if (this._homeOf.get(id) === h.id) this._homeOf.delete(id);
          if (!a) this._takeDownLanterns(id);
        }
      }
    }
    for (const p of this.projects) {
      if (p.masonId == null) continue;
      const m = this._agent(p.masonId);
      if (!m || m.projectId !== p.id) { p.masonId = null; p.status = 'open'; }
    }
  }

  _hasPopulation() {
    const pop = this.sim && this.sim.population;
    return !!pop && (typeof pop.get === 'function' || !!pop.byId);
  }

  // =========================================================================
  // Maps: structures and water
  // =========================================================================

  _rebuildMask() {
    this._structVer++;
    const m = this._mask;
    m.fill(0);
    // Wall lines between clans stay free of buildings and plants, standing or not.
    const clans = this.sim && this.sim.clans;
    if (clans && clans.multi) for (const c of clans.lineColumns()) m[c] |= MASK_STRUCT;
    for (const h of this.houses) {
      this._markRect(h.origin.x, h.origin.z, h.origin.x + 2, h.origin.z + 2, MASK_STRUCT);
      this._markRect(h.approach.x, h.approach.z, h.approach.x, h.approach.z, MASK_CLEAR);
    }
    for (const t of this.towers) {
      this._markRect(t.base.x, t.base.z, t.base.x, t.base.z, MASK_STRUCT);
      this._markRect(t.stand.x, t.stand.z, t.stand.x, t.stand.z, MASK_CLEAR);
    }
    for (const p of this.projects) {
      for (const b of p.blocks) this._markRect(b.x, b.z, b.x, b.z, MASK_STRUCT);
      if (p.kind === 'house') this._markRect(p.site.x, p.site.z, p.site.x + 2, p.site.z + 2, MASK_STRUCT);
      this._markRect(p.approach.x, p.approach.z, p.approach.x, p.approach.z, MASK_CLEAR);
    }
  }

  _markRect(x0, z0, x1, z1, bit) {
    for (let z = Math.max(0, z0); z <= Math.min(this.SZ - 1, z1); z++) {
      for (let x = Math.max(0, x0); x <= Math.min(this.SX - 1, x1); x++) this._mask[x + this.SX * z] |= bit;
    }
  }

  /**
   * Chebyshev distance (columns, capped at 255) to the nearest column with surface water.
   * Recomputed only when the WATER block count changes (e.g. after a Dew Pipette).
   */
  _refreshWaterMap(force) {
    const w = this.world;
    if (!w || !w.heightmap) return;
    const count = typeof w.countBlocks === 'function' ? w.countBlocks(B.WATER) : -2;
    if (!force && count === this._waterCount) return;
    this._waterCount = count;
    const SX = this.SX;
    const SZ = this.SZ;
    const d = this._waterDist;
    const hm = w.heightmap;
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const col = x + SX * z;
        d[col] = w.get(x, hm[col] + 1, z) === B.WATER ? 0 : 255;
      }
    }
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const c = x + SX * z;
        let v = d[c];
        if (x > 0 && d[c - 1] + 1 < v) v = d[c - 1] + 1;
        if (z > 0) {
          if (d[c - SX] + 1 < v) v = d[c - SX] + 1;
          if (x > 0 && d[c - SX - 1] + 1 < v) v = d[c - SX - 1] + 1;
          if (x < SX - 1 && d[c - SX + 1] + 1 < v) v = d[c - SX + 1] + 1;
        }
        d[c] = v;
      }
    }
    for (let z = SZ - 1; z >= 0; z--) {
      for (let x = SX - 1; x >= 0; x--) {
        const c = x + SX * z;
        let v = d[c];
        if (x < SX - 1 && d[c + 1] + 1 < v) v = d[c + 1] + 1;
        if (z < SZ - 1) {
          if (d[c + SX] + 1 < v) v = d[c + SX] + 1;
          if (x < SX - 1 && d[c + SX + 1] + 1 < v) v = d[c + SX + 1] + 1;
          if (x > 0 && d[c + SX - 1] + 1 < v) v = d[c + SX - 1] + 1;
        }
        d[c] = v;
      }
    }
  }

  // =========================================================================
  // Small shared helpers
  // =========================================================================

  _tick() {
    return finiteOr(this.sim && this.sim.clock && this.sim.clock.tick, 0);
  }

  _rand() {
    const rng = this.sim && this.sim.rng;
    return rng ? rng.next() : 0.5;
  }

  _randInt(lo, hi) {
    const rng = this.sim && this.sim.rng;
    return rng ? rng.int(lo, hi) : Math.floor((lo + hi) / 2);
  }

  _cellIndex(x, y, z) {
    return x + this.SX * (z + this.SZ * y);
  }

  _emit(name, payload) {
    const ev = this.sim && this.sim.events;
    if (ev && name) ev.emit(name, payload);
  }

  _stabilizer(kind, amount, message) {
    const ledger = this.sim && this.sim.ledger;
    if (ledger && typeof ledger.stabilizer === 'function') ledger.stabilizer(kind, amount, message);
  }

  /** Live agent by id, or null. */
  _agent(id) {
    const pop = this.sim && this.sim.population;
    if (!pop || id == null) return null;
    const a = typeof pop.get === 'function' ? pop.get(id) : pop.byId ? pop.byId.get(id) : null;
    return a && a.alive !== false ? a : null;
  }

  _agents() {
    const pop = this.sim && this.sim.population;
    return (pop && pop.agents) || EMPTY;
  }

  _cellOccupied(x, y, z) {
    const agents = this._agents();
    for (let i = 0; i < agents.length; i++) {
      const c = agents[i].cell;
      if (c && c.x === x && c.z === z && (c.y === y || c.y + 1 === y)) return true;
    }
    return false;
  }

  _relocateOccupants(x, y, z) {
    const pop = this.sim && this.sim.population;
    if (!pop || typeof pop.relocate !== 'function') return;
    const agents = this._agents();
    for (let i = agents.length - 1; i >= 0; i--) {
      const a = agents[i];
      const c = a.cell;
      if (c && c.x === x && c.z === z && (c.y === y || c.y + 1 === y)) pop.relocate(a);
    }
  }

  /** Average market price P̄ (clan c's own markets when there are several clans), falling back to ref. */
  _avgP(good, clan = 0) {
    const market = this.sim && this.sim.market;
    const clans = this.sim && this.sim.clans;
    let p = NaN;
    if (clans && clans.multi && market) p = clans.clanPrice(clan, good);
    else if (market && typeof market.avgPrice === 'function') p = market.avgPrice(good);
    if (typeof p === 'number' && p > 0 && Number.isFinite(p)) return p;
    const g = this.cfg.goods[good];
    return g ? g.ref : 1;
  }

  /** Haze factor η from the ledger (1 before the ledger has computed it). */
  _eta() {
    const ledger = this.sim && this.sim.ledger;
    const h = ledger ? ledger.haze : NaN;
    return typeof h === 'number' && Number.isFinite(h) ? h : 1;
  }

  /**
   * meanY from the ledger.
   * SPEC-GAP: before the ledger has income data (≤ 0 or not finite), twice the subsistence cost
   * stands in (≈ 11.7/day at ref prices), which reproduces the §D.8 "about 61 glim" cottage budget.
   */
  _meanY(clan = 0) {
    const ledger = this.sim && this.sim.ledger;
    const y = ledger && typeof ledger.meanY === 'function' ? ledger.meanY(clan) : NaN;
    if (typeof y === 'number' && y > 0 && Number.isFinite(y)) return y;
    return 2 * this.subsistenceCost(clan);
  }
}

// ---------------------------------------------------------------------------
// Private module helpers
// ---------------------------------------------------------------------------

const EMPTY = Object.freeze([]);

function isLive(agent) {
  return !!agent && agent.alive !== false;
}

function isUnfinished(p) {
  return p.status === 'open' || p.status === 'claimed';
}

/** §D.1: lensQ = 0.8 + 0.4·(skill − 0.6)/0.9 */
function lensQualityFromSkill(skill) {
  return 0.8 + (0.4 * (skill - 0.6)) / 0.9;
}

/** Cottage anchors (§C.4 houseTemplate), taken from a template result when it provides them. */
function houseAnchors(o, tpl) {
  const t = tpl || {};
  return {
    door: t.door ? copyCell(t.door) : { x: o.x + 1, y: o.y, z: o.z },
    bed: t.bed ? copyCell(t.bed) : { x: o.x + 1, y: o.y, z: o.z + 1 },
    approach: t.approach ? copyCell(t.approach) : { x: o.x + 1, y: o.y, z: o.z - 1 },
    lanternSlots: (t.lanternSlots || [
      { x: o.x, y: o.y + 1, z: o.z },
      { x: o.x + 2, y: o.y + 1, z: o.z },
      { x: o.x + 1, y: o.y + 2, z: o.z },
    ]).map(copyCell),
  };
}
