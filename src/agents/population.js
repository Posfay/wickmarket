/**
 * @file Wickling population lifecycle (SPEC §C.4 "G3: population.js", §D.2, §D.7–§D.9, §E.5).
 *
 * Owns the live agent list, spawning (founders, births, immigrants), the per-tick body/brain
 * loop, a 4×4-column spatial hash, rumours, deaths, emigration, relocation and the dawn
 * routine (skills, housing, profession reviews, births, emigration).
 *
 * Money rule: every glim created or destroyed here goes through `sim.ledger.record`
 * (immigration, gift, death, emigration). Births and inheritances are transfers.
 *
 * Sim-side: no DOM, no three; randomness only through `sim.rng`.
 */
import { CONFIG, TICKS, GOODS, PROFESSIONS } from '../core/config.js';
import { EV } from '../core/events.js';
import { createAgent, stepAgent, flushDemurrage, leavePuddle, resetMotion, addItem, removeItem, serializeAgent, reviveAgent } from './agent.js';
import { updateBrain, reviewProfession, interrupt } from './brain.js';
import { B } from '../world/blocks.js';

const POP = CONFIG.population;
const AG = CONFIG.agent;
const MONEY = CONFIG.money;
const WHISPER = CONFIG.tools.whisper;
const TAP = CONFIG.tools.tap;
const MC = CONFIG.market;

const PER_SEC = TICKS.PER_SEC;
const PER_HOUR = TICKS.PER_HOUR;
const PER_DAY = TICKS.PER_DAY;
const SEC_PER_DAY = PER_DAY / PER_SEC;

/** Spatial hash bucket size in columns (SPEC §C.4: "4×4 columns"). */
const HASH_CELL = 4;
/** Hourly P̄ samples kept for the rumour stall test ("over the last 6 h" → now + 6 back). */
const TREND_HOURS = 6;
const TREND_RING = TREND_HOURS + 1;
/** Founders and immigrants carry this starter food (SPEC §C.4 spawnInitial). */
const STARTER_TABLETS = 2;
const STARTER_BERRIES = 2;
// SPEC §D.8 literal: an unhoused agent commissions when glim ≥ 1.2·houseBudget + 15.
const COMMISSION_MUL = 1.2;
const COMMISSION_PAD = 15;
const MONEY_EPS = 1e-12;

const GOOD_INDEX = new Map(GOODS.map((g, i) => [g, i]));
/** Built blocks nobody should be set down on top of (relocation targets natural ground). */
const BUILT_FLOOR = new Set([B.CUT_STONE, B.THATCH, B.LENS_MOUNT, B.KETTLE, B.LANTERN, B.GLASS_WALL, B.CLAN_WALL]);

/**
 * @typedef {import('./agent.js').Agent} Agent
 * @typedef {{x:number, y:number, z:number}} Cell
 * @typedef {{guild:object, meanY:number, subsistence:number, budget:{left:number}}} ReviewCtx
 */

export class Population {
  /** @param {object} sim the shared sim context (SPEC §C.1) */
  constructor(sim) {
    this.sim = sim;
    /** @type {Agent[]} live agents only, in stable (spawn) order */
    this.agents = [];
    /** @type {Map<number, Agent>} live agents by id */
    this.byId = new Map();
    /** Next agent id; ids are never reused. */
    this.nextId = 1;

    const W = (sim && sim.world) || CONFIG.world;
    this._SX = W.SX || CONFIG.world.SX;
    this._SZ = W.SZ || CONFIG.world.SZ;

    // Spatial hash (counting sort into typed arrays, rebuilt every tick without allocation).
    this._hx = Math.ceil(this._SX / HASH_CELL);
    this._hz = Math.ceil(this._SZ / HASH_CELL);
    const buckets = this._hx * this._hz;
    this._bStart = new Int32Array(buckets + 1);
    this._bFill = new Int32Array(buckets);
    this._hashCap = 0;
    this._hashBucket = new Int32Array(0);
    this._hashItems = new Int32Array(0);
    /** @type {Agent[]} agents as indexed by the hash at its last rebuild */
    this._hashAgents = [];
    this._hashN = 0;
    this._ensureHashCapacity(POP.max + 16);

    // Reused scratch lists.
    this._iter = [];
    this._near = [];
    this._believers = [];
    this._doomed = [];
    this._doomedCause = [];
    this._nets = new Float64Array(POP.max + 16);

    // Rumours: hourly P̄ ring per good, 6-hour trend, last announced believer counts.
    this._pRing = new Float64Array(GOODS.length * TREND_RING);
    this._pHead = 0;
    this._pSamples = 0;
    this._trend = new Float64Array(GOODS.length);
    this._rumorCount = new Int32Array(GOODS.length);
    this._rumorDirSum = new Int32Array(GOODS.length);
    this._rumorLast = new Int32Array(GOODS.length);
    this._rumorLastDir = new Int8Array(GOODS.length).fill(1);

    // Clans: live head count per clan; immigration pacing per clan.
    const clanList = sim?.clans?.list ?? [{ id: 0, profMix: POP.initialProf, initial: POP.initial, max: POP.max, floor: POP.floor }];
    this._clanList = clanList;
    this._clanN = new Int32Array(clanList.length);
    this._lastFloorTick = new Float64Array(clanList.length).fill(-Infinity);
    this._lastProsperityTick = new Float64Array(clanList.length).fill(-Infinity);

    // Immigrant professions follow each clan's founders' mix (cumulative weights).
    this._profCums = clanList.map((cl) => {
      const cum = [];
      let acc = 0;
      for (const p of PROFESSIONS) {
        acc += Math.max(0, (cl.profMix && cl.profMix[p]) || 0);
        cum.push(acc);
      }
      return cum;
    });
  }

  /** Live members of clan c. */
  clanCount(c = 0) {
    return this._clanN[c] ?? 0;
  }

  /** Population cap of clan c. */
  clanMax(c = 0) {
    return this._clanList[c]?.max ?? POP.max;
  }

  /** Immigration floor of clan c. */
  clanFloor(c = 0) {
    return this._clanList[c]?.floor ?? POP.floor;
  }

  get _multi() {
    return this._clanList.length > 1;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Save files
  // ───────────────────────────────────────────────────────────────────────────

  /** Plain data for a save file (stringify it before the sim ticks again). */
  serialize() {
    const ticks = (arr) => Array.from(arr, (v) => (Number.isFinite(v) ? v : null));
    return {
      nextId: this.nextId,
      agents: this.agents.map(serializeAgent),
      pRing: Array.from(this._pRing), pHead: this._pHead, pSamples: this._pSamples, trend: Array.from(this._trend),
      rumorLast: Array.from(this._rumorLast), rumorLastDir: Array.from(this._rumorLastDir),
      lastFloor: ticks(this._lastFloorTick), lastProsperity: ticks(this._lastProsperityTick),
    };
  }

  /** Replace the population with a saved one (see serialize). */
  restore(s) {
    if (!s) return;
    this.agents = [];
    this.byId.clear();
    this._clanN.fill(0);
    const nm = this.sim.worldInfo?.markets?.length || 2;
    const nc = this._clanN.length;
    let maxId = 0;
    for (const rec of Array.isArray(s.agents) ? s.agents : []) {
      if (!rec || !Number.isInteger(rec.id) || rec.id <= 0 || this.byId.has(rec.id)) continue;
      const a = reviveAgent(rec, nm);
      if (a.clan >= nc) a.clan = 0;
      this.agents.push(a);
      this.byId.set(a.id, a);
      this._clanN[a.clan]++;
      if (a.id > maxId) maxId = a.id;
    }
    this.nextId = Math.max(Number.isInteger(s.nextId) ? s.nextId : 1, maxId + 1);
    const fill = (dst, src, map) => {
      if (!Array.isArray(src) || src.length !== dst.length) return;
      for (let i = 0; i < dst.length; i++) dst[i] = map ? map(src[i]) : Number(src[i]) || 0;
    };
    fill(this._pRing, s.pRing);
    this._pHead = clampInt(s.pHead | 0, 0, TREND_RING - 1);
    this._pSamples = clampInt(s.pSamples | 0, 0, TREND_RING);
    fill(this._trend, s.trend);
    fill(this._rumorLast, s.rumorLast);
    fill(this._rumorLastDir, s.rumorLastDir, (v) => (v < 0 ? -1 : 1));
    const tick = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : -Infinity);
    fill(this._lastFloorTick, s.lastFloor, tick);
    fill(this._lastProsperityTick, s.lastProsperity, tick);
    this._rebuildHash();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Spawning
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create the founding population (SPEC §C.4): `initial` agents on shuffled spawn cells with
   * professions per `initialProf`, ages U(initialAgeDays), glim U(startGlim), 2 tablets and
   * 2 berries each; the first 2·houses agents (shuffled) take beds; lenswrights claim towers.
   * @param {object} worldInfo WorldInfo from generateWorld
   * @returns {Agent[]} the founders
   */
  spawnInitial(worldInfo) {
    const sim = this.sim;
    const rng = sim.rng;
    const info = worldInfo || sim.worldInfo || {};
    const clans = sim.clans;
    const [g0, g1] = MONEY.startGlim;
    const [a0, a1] = AG.initialAgeDays;
    const prod = sim.production;

    const founders = [];
    for (const cl of this._clanList) {
      const c = cl.id ?? 0;
      const n = Math.max(0, (cl.initial ?? POP.initial) | 0);
      const profs = this._initialProfessions(n, c);
      const spawnCells = info.spawnByClan?.[c] ?? info.spawnCells;
      const cells = shuffle(Array.isArray(spawnCells) ? spawnCells.slice() : [], rng);
      // The clan's starting wealth (poor ×0.5, normal ×1, rich ×2).
      const wm = clans ? clans.wealthMul(c) : 1;
      const lo = wm === 1 ? g0 : g0 * wm, hi = wm === 1 ? g1 : g1 * wm;
      const mine = [];
      for (let i = 0; i < n; i++) {
        const cell = cells.length ? cells[i % cells.length] : this._fallbackCell(c);
        const agent = this.spawn({
          kind: 'initial', clan: c, cell, profession: profs[i], glim: rng.range(lo, hi), ageDays: rng.range(a0, a1),
        });
        if (!agent) break;
        addItem(agent, 'tablet', STARTER_TABLETS);
        addItem(agent, 'berry', STARTER_BERRIES);
        mine.push(agent);
      }

      if (prod) {
        const all = Array.isArray(prod.houses) ? prod.houses : (info.houses || []);
        const houses = all.filter((h) => (h.clan ?? 0) === c);
        let beds = 0;
        for (const h of houses) beds += Number.isInteger(h.capacity) ? h.capacity : CONFIG.production.house.capacity;
        if (!(beds > 0)) beds = 2 * houses.length;
        const order = shuffle(mine.slice(), rng);
        const m = Math.min(order.length, beds);
        if (typeof prod.vacancy === 'function' && typeof prod.claimBed === 'function') {
          for (let i = 0; i < m; i++) {
            const house = prod.vacancy(order[i]);
            if (house) prod.claimBed(order[i], house);
          }
        }
        if (typeof prod.claimTower === 'function') {
          for (const a of mine) if (a.profession === 'lenswright') prod.claimTower(a);
        }
      }
      for (const a of mine) founders.push(a);
    }
    this._rebuildHash();
    return founders;
  }

  /**
   * Add one agent with the next id.
   * - `kind: 'birth'` (or a `parent` given): moves `birthGlimShare` of the parent's glim to the
   *   child without a ledger flow, links the lineage, adds the parent's lustre bonus, emits AGENT_BORN.
   * - `kind: 'immigrant'` (or a `reason` given): arrives with `immigrantGlim` (or `glim`), recorded as
   *   `ledger.record('immigration', …)`, emits AGENT_IMMIGRATED {reason}.
   * - `kind: 'initial'`: a founder; its glim predates the ledger's opening snapshot.
   * Returns null when the population is at `max` (founders excepted).
   * @param {{cell?:Cell, profession?:string, glim?:number, ageDays?:number, parent?:Agent,
   *          kind?:'initial'|'birth'|'immigrant', reason?:'floor'|'prosperity'}} [opts]
   * @returns {Agent|null}
   */
  spawn(opts = {}) {
    const sim = this.sim;
    const parent = opts.parent && opts.parent.alive !== false ? opts.parent : null;
    const kind = opts.kind || (parent ? 'birth' : opts.reason ? 'immigrant' : 'initial');
    const clan = Number.isInteger(opts.clan) ? opts.clan : parent ? parent.clan ?? 0 : 0;
    if (kind !== 'initial' && this.clanCount(clan) >= this.clanMax(clan)) return null;
    if (kind === 'birth' && !parent) return null;

    let glim;
    if (kind === 'birth') {
      const share = Math.max(0, parent.glim) * POP.birthGlimShare;
      parent.glim -= share;
      glim = share;
    } else if (kind === 'immigrant') {
      glim = Number.isFinite(opts.glim) && opts.glim >= 0 ? opts.glim : MONEY.immigrantGlim;
    } else {
      glim = Number.isFinite(opts.glim) && opts.glim > 0 ? opts.glim : 0;
    }

    const cell = opts.cell || (parent && parent.cell) || this._fallbackCell();
    const agent = createAgent(sim, {
      cell,
      profession: opts.profession || (parent ? parent.profession : undefined),
      glim,
      ageDays: Number.isFinite(opts.ageDays) ? opts.ageDays : 0,
      parent,
      clan,
      id: this.nextId++,
    });
    this.agents.push(agent);
    this.byId.set(agent.id, agent);
    this._clanN[clan]++;

    if (kind === 'birth') {
      parent.childrenIds.push(agent.id);
      const l = parent.needs.lustre + POP.birthLustreBonus;
      parent.needs.lustre = l > 100 ? 100 : l;
      this._emit(EV.AGENT_BORN, { agentId: agent.id, parentId: parent.id });
    } else if (kind === 'immigrant') {
      this._record('immigration', agent.glim);
      this._emit(EV.AGENT_IMMIGRATED, { agentId: agent.id, reason: opts.reason === 'prosperity' ? 'prosperity' : 'floor' });
    }
    return agent;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Per-tick update
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * One sim tick: `stepAgent` then `updateBrain` for every agent, spatial-hash rebuild, rumours
   * every sim-second, deaths and immigration on hour ticks, `onDawn` on the dawn tick.
   * @param {object} [sim]
   */
  tick(sim = this.sim) {
    if (!sim) return;
    const clock = sim.clock;
    const tick = clock ? clock.tick : 0;

    // Iterate a snapshot so removals during the loop never skip anyone.
    const list = this._iter;
    const n = this.agents.length;
    for (let i = 0; i < n; i++) list[i] = this.agents[i];
    if (list.length > n) list.length = n;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (!a.alive) continue;
      stepAgent(a, sim);
      if (a.alive) updateBrain(a, sim);
    }

    this._rebuildHash();
    if (tick % PER_SEC === 0) this.tickRumors(sim);

    if (clockFlag(clock, 'isHourTick', tick % PER_HOUR === 0)) {
      this._samplePrices();
      this._checkDeaths();
      this._immigration(tick);
    }
    if (clockFlag(clock, 'isDawnTick', tick % PER_DAY === 6 * PER_HOUR)) this.onDawn(sim);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Queries
  // ───────────────────────────────────────────────────────────────────────────

  /** @returns {Agent|null} the live agent with this id */
  get(id) {
    return this.byId.get(id) || null;
  }

  /** @returns {number} live agents */
  count() {
    return this.agents.length;
  }

  /**
   * @param {number} [clan] only this clan's members (all when omitted)
   * @returns {Object<string, number>} live agents per profession (every profession key present)
   */
  professionCounts(clan) {
    const out = {};
    for (const p of PROFESSIONS) out[p] = 0;
    for (const a of this.agents) {
      if (clan != null && (a.clan ?? 0) !== clan) continue;
      out[a.profession] = (out[a.profession] || 0) + 1;
    }
    return out;
  }

  /**
   * Agents holding a rumour, optionally only about `good`.
   * @param {string} [good]
   * @returns {number}
   */
  believerCount(good) {
    let n = 0;
    for (const a of this.agents) {
      const r = a.rumor;
      if (r && (good === undefined || good === null || r.good === good)) n++;
    }
    return n;
  }

  /**
   * Live agents whose feet are within xz distance `r` of (x, z), read from the spatial hash
   * (rebuilt each tick). Pass `out` to reuse an array; otherwise a new one is returned.
   * @param {number} x
   * @param {number} z
   * @param {number} r
   * @param {Agent[]} [out]
   * @returns {Agent[]}
   */
  neighbors(x, z, r, out = []) {
    out.length = 0;
    if (!(r >= 0) || !Number.isFinite(x) || !Number.isFinite(z)) return out;
    const hx = this._hx, hz = this._hz;
    const bx0 = clampInt(Math.floor((x - r) / HASH_CELL), 0, hx - 1);
    const bx1 = clampInt(Math.floor((x + r) / HASH_CELL), 0, hx - 1);
    const bz0 = clampInt(Math.floor((z - r) / HASH_CELL), 0, hz - 1);
    const bz1 = clampInt(Math.floor((z + r) / HASH_CELL), 0, hz - 1);
    const r2 = r * r;
    const start = this._bStart, items = this._hashItems, agents = this._hashAgents;
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const b = bx + hx * bz;
        for (let k = start[b], end = start[b + 1]; k < end; k++) {
          const a = agents[items[k]];
          if (!a || !a.alive) continue;
          const dx = a.pos.x - x, dz = a.pos.z - z;
          if (dx * dx + dz * dz <= r2) out.push(a);
        }
      }
    }
    return out;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Removal
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Remove a dead agent (SPEC §C.4 kill, §D.9): leaves a WAX_PUDDLE, hands (1 − deathBurn) of its
   * glim to the heir (youngest living child, else a housemate), burns the rest as `death`,
   * cleans up market/production state and emits AGENT_DIED.
   * @param {Agent} agent
   * @param {'age'|'starved'|'fight'} [cause]
   * @returns {boolean} whether the agent was removed
   */
  kill(agent, cause = 'age') {
    if (!this._isMember(agent)) return false;
    const sim = this.sim;
    const why = cause === 'starved' || cause === 'fight' ? cause : 'age';
    const pos = { x: agent.pos.x, y: agent.pos.y, z: agent.pos.z };

    this._detach(agent, why === 'starved' ? ['th.diedHunger'] : why === 'fight' ? ['th.diedFight'] : ['th.diedAge']);
    leavePuddle(agent, sim);

    const heir = this._heirOf(agent);
    const total = agent.glim > 0 ? agent.glim : 0;
    const inherited = heir ? total * (1 - MONEY.deathBurn) : 0;
    agent.glim -= total;
    if (inherited > 0) heir.glim += inherited;
    this._record('death', total - inherited);

    this._remove(agent, 'death');
    this._emit(EV.AGENT_DIED, { agentId: agent.id, name: agent.name, profession: agent.profession, clan: agent.clan ?? 0, cause: why, pos });
    return true;
  }

  /**
   * Remove an agent that rides a moth out (SPEC §C.4 emigrate): everything it carries is
   * recorded as `emigration`, then the same cleanup as `kill`; emits AGENT_EMIGRATED.
   * @param {Agent} agent
   * @returns {boolean}
   */
  emigrate(agent) {
    if (!this._isMember(agent)) return false;
    const pos = { x: agent.pos.x, y: agent.pos.y, z: agent.pos.z };
    this._detach(agent, ['th.leaving']);
    const carried = agent.glim > 0 ? agent.glim : 0;
    agent.glim -= carried;
    this._record('emigration', carried);
    this._remove(agent, 'emigration');
    this._emit(EV.AGENT_EMIGRATED, { agentId: agent.id, name: agent.name, glim: carried, pos });
    return true;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Relocation
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Snap an agent to the nearest walkable cell (`pathfinder.nearestWalkable`) and interrupt it.
   * @param {Agent} agent
   * @returns {boolean} whether it was moved
   */
  relocate(agent) {
    if (!this._isMember(agent)) return false;
    const c = agent.cell;
    const target = this._standCellNear(c.x, c.y, c.z);
    if (!target) return false;
    this._place(agent, target);
    interrupt(agent, this.sim, ['th.setDown']);
    // SPEC-GAP: a teleport invalidates any path, so population clears it (and any pending
    // ticket) even though paths are normally brain-owned.
    this._dropPath(agent);
    return true;
  }

  /**
   * Move an agent to a given cell (e.g. back to its own clan's land when a wall rises between).
   * @param {Agent} agent
   * @param {Cell} cell
   * @param {Array} [reason] thought message
   * @returns {boolean}
   */
  teleport(agent, cell, reason) {
    if (!this._isMember(agent) || !cell) return false;
    const target = this.sim.world && this.sim.world.isWalkable(cell.x, cell.y, cell.z)
      ? cell : this._standCellNear(cell.x, cell.y, cell.z);
    if (!target) return false;
    this._place(agent, target);
    interrupt(agent, this.sim, reason || ['th.setDown']);
    this._dropPath(agent);
    return true;
  }

  /**
   * Relocate agents inside the inclusive cell box after a terrain edit (tools call this).
   * SPEC-GAP: only agents the edit actually displaced are moved — those whose body overlaps the
   * box and whose foot cell is no longer walkable and who cannot simply fall. Agents still
   * standing on walkable ground keep their task (paths are re-validated lazily by stepAgent),
   * and agents over a fresh hole fall under gravity.
   * @returns {number} agents relocated
   */
  relocateInBox(x0, y0, z0, x1, y1, z1) {
    const world = this.sim.world;
    if (!world) return 0;
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1), by = Math.max(y0, y1);
    const az = Math.min(z0, z1), bz = Math.max(z0, z1);
    const hits = [];
    for (const a of this.agents) {
      const c = a.cell;
      if (c.x < ax || c.x > bx || c.z < az || c.z > bz || c.y > by || c.y + 1 < ay) continue;
      if (world.isWalkable(c.x, c.y, c.z)) continue;
      const canFall = c.y > 1 && world.isPassableAt(c.x, c.y, c.z) && world.isPassableAt(c.x, c.y + 1, c.z)
        && world.isPassableAt(c.x, c.y - 1, c.z);
      if (!canFall) hits.push(a);
    }
    let moved = 0;
    for (const a of hits) if (this.relocate(a)) moved++;
    return moved;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Player hooks
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Tap the Glass (SPEC §C.4 panic, §E row 6). Agents within `radius` (weight w = 1 − d/radius)
   * panic for panicSec·(0.5+0.5w), lose each carried unit with probability `tap.cargoLoss`,
   * gain fright ≥ w and are interrupted. Emits PANIC.
   * @param {{x:number, z:number}} center
   * @param {number} radius
   * @returns {number} agents affected
   */
  panic(center, radius) {
    const sim = this.sim;
    if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.z) || !(radius > 0)) return 0;
    const tick = sim.clock ? sim.clock.tick : 0;
    const rng = sim.rng;
    const hit = this.neighbors(center.x, center.z, radius, []);
    for (const a of hit) {
      const dx = a.pos.x - center.x, dz = a.pos.z - center.z;
      const w = clamp(1 - Math.sqrt(dx * dx + dz * dz) / radius, 0, 1);
      const until = tick + Math.round(AG.panicSec * (0.5 + 0.5 * w) * PER_SEC);
      if (until > a.panicUntil) a.panicUntil = until;
      // SPEC-GAP: "each carried unit" means traded goods; a lens is not cargo and is kept.
      for (const g of GOODS) {
        const held = a.inv[g] | 0;
        let lost = 0;
        for (let k = 0; k < held; k++) if (rng.next() < TAP.cargoLoss) lost++;
        if (lost > 0) removeItem(a, g, lost);
      }
      if (w > a.fright) a.fright = w;
      interrupt(a, sim, ['th.panic']);
    }
    this._emit(EV.PANIC, { x: center.x, z: center.z, radius, count: hit.length });
    return hit.length;
  }

  /**
   * Whisper (SPEC §C.4 startRumor, §E row 5): the agent believes `good` will rise (dir 1) or fall
   * (dir −1) with strength 1; its belief is scaled by `whisper.bull` / `whisper.bear`. Emits RUMOR.
   * @param {Agent} agent
   * @param {string} good
   * @param {1|-1} dir
   * @returns {boolean}
   */
  startRumor(agent, good, dir) {
    if (!this._isMember(agent)) return false;
    const gi = GOOD_INDEX.get(good);
    if (gi === undefined) return false;
    const d = dir < 0 ? -1 : 1;
    const tick = this.sim.clock ? this.sim.clock.tick : 0;
    agent.rumor = { good, dir: d, strength: 1, sinceTick: tick };
    // SPEC-GAP: the scaled belief is kept inside the §D.11 belief clamps.
    agent.beliefs[good] = clampBelief(good, agent.beliefs[good] * (d > 0 ? WHISPER.bull : WHISPER.bear));
    const believers = this.believerCount(good);
    this._rumorLast[gi] = believers;
    this._rumorLastDir[gi] = d;
    this._emit(EV.RUMOR, { good, dir: d, believers });
    return true;
  }

  /**
   * Magnifier gift: new money, recorded as `gift`.
   * @param {Agent} agent
   * @param {number} amount glim
   * @returns {number} the amount given
   */
  gift(agent, amount) {
    if (!this._isMember(agent) || !(amount > 0) || !Number.isFinite(amount)) return 0;
    agent.glim += amount;
    this._record('gift', amount);
    return amount;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Rumours (SPEC §E row 5)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * One sim-second of rumour dynamics. Decay: strength falls by decayPerDay, plus
   * stallPenaltyPerDay while P̄ moved against the rumour over the last 6 h; a rumour at 0 is
   * dropped. Spread: every believer above minStrength converts each non-believer within
   * spreadRadius with probability spreadChancePerSec·strength·(1 − skepticism); the convert
   * gets strength ×0.9 and moves its belief halfway to the believer's. Emits RUMOR whenever a
   * good's believer count changes.
   * @param {object} [sim]
   */
  tickRumors(sim = this.sim) {
    const rng = sim.rng;
    const tick = sim.clock ? sim.clock.tick : 0;
    const decay = WHISPER.decayPerDay / SEC_PER_DAY;
    const stall = WHISPER.stallPenaltyPerDay / SEC_PER_DAY;
    const spreaders = this._believers;
    spreaders.length = 0;

    for (const a of this.agents) {
      const r = a.rumor;
      if (!r) continue;
      const gi = GOOD_INDEX.get(r.good);
      if (gi === undefined || !(r.strength > 0)) { a.rumor = null; continue; }
      r.strength -= this._trend[gi] * r.dir < 0 ? decay + stall : decay;
      if (r.strength <= 0) { a.rumor = null; continue; }
      if (r.strength > WHISPER.minStrength) spreaders.push(a);
    }

    const near = this._near;
    for (let i = 0; i < spreaders.length; i++) {
      const b = spreaders[i];
      const r = b.rumor;
      if (!r || !b.alive) continue;
      this.neighbors(b.pos.x, b.pos.z, WHISPER.spreadRadius, near);
      for (let k = 0; k < near.length; k++) {
        const n = near[k];
        if (n === b || n.rumor) continue;
        const p = WHISPER.spreadChancePerSec * r.strength * (1 - (n.skepticism || 0));
        if (!(rng.next() < p)) continue;
        n.rumor = { good: r.good, dir: r.dir, strength: r.strength * 0.9, sinceTick: tick };
        const mine = n.beliefs[r.good], theirs = b.beliefs[r.good];
        n.beliefs[r.good] = clampBelief(r.good, mine + 0.5 * (theirs - mine));
      }
    }
    near.length = 0;
    spreaders.length = 0;
    this._announceRumors();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Dawn (SPEC §C.4 onDawn, §D.7–§D.9)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Dawn routine, in order: skills, housing, profession reviews (shared ctx, forced first),
   * births (§D.9), emigration (§D.9).
   * @param {object} [sim]
   */
  onDawn(sim = this.sim) {
    if (!sim) return;
    if (sim.clans) sim.clans.onDawn();          // clans that share wealth split it first
    this._updateSkills();
    this._housing(sim);
    const ctxs = this._reviewContexts(sim);
    this._reviews(sim, ctxs);
    this._births(sim, ctxs);
    this._emigration();
  }

  /**
   * Skills: +gainPerDay in the current profession, −lossPerDay in the others (clamped).
   * A clan's talent trade is learned faster.
   */
  _updateSkills() {
    const S = AG.skill;
    const clans = this.sim.clans;
    const talentGain = CONFIG.clans?.talentGain ?? 1.5;
    for (const a of this.agents) {
      const sk = a.skills;
      const talent = clans ? clans.talent(a.clan ?? 0) : null;
      for (const p of PROFESSIONS) {
        let d = p === a.profession ? S.gainPerDay : -S.lossPerDay;
        if (talent === p && d > 0) d *= talentGain;
        const v = (Number.isFinite(sk[p]) ? sk[p] : S.min) + d;
        sk[p] = clamp(v, S.min, S.max);
      }
    }
  }

  /**
   * Unhoused agents, richest first, take the nearest vacancy of their clan; failing that, those
   * with glim ≥ 1.2·houseBudget + 15 commission a cottage while their clan has fewer than
   * `maxOpen` projects open.
   */
  _housing(sim) {
    const prod = sim.production;
    if (!prod || typeof prod.vacancy !== 'function' || typeof prod.claimBed !== 'function') return;
    const unhoused = this.agents.filter((a) => a.homeId == null);
    if (!unhoused.length) return;
    unhoused.sort((a, b) => b.glim - a.glim || a.id - b.id);

    const multi = this._multi;
    const nc = this._clanList.length;
    const open = typeof prod.openProjects === 'function' ? prod.openProjects() || [] : [];
    const openBy = new Int32Array(nc);
    const owners = new Set();
    for (const p of open) {
      openBy[multi ? Math.min(nc - 1, p.clan ?? 0) : 0]++;
      owners.add(p.ownerId);
    }
    const budgets = [];
    for (let c = 0; c < nc; c++) budgets.push(typeof prod.houseBudget === 'function' ? prod.houseBudget(c) : NaN);
    const maxOpen = (c) => (multi ? this._clanList[c].maxOpen ?? 3 : CONFIG.production.house.maxOpen);

    for (const a of unhoused) {
      const c = multi ? a.clan ?? 0 : 0;
      const house = prod.vacancy(a);
      if (house && prod.claimBed(a, house)) continue;
      const budget = budgets[c];
      const canCommission = typeof prod.commissionHouse === 'function' && budget > 0 && Number.isFinite(budget);
      const threshold = COMMISSION_MUL * budget + COMMISSION_PAD;
      if (!canCommission || openBy[c] >= maxOpen(c) || owners.has(a.id) || !(a.glim >= threshold)) continue;
      if (prod.commissionHouse(a)) {
        openBy[c]++;
        owners.add(a.id);
      }
    }
  }

  /** The review context of every clan (SPEC §D.7), built once per dawn. @returns {ReviewCtx[]} */
  _reviewContexts(sim) {
    const ledger = sim.ledger;
    const prod = sim.production;
    return this._clanList.map((cl, c) => {
      const guild = ledger && typeof ledger.guild === 'function' ? ledger.guild(c) || {} : {};
      const meanY = ledger && typeof ledger.meanY === 'function' ? finiteOr(ledger.meanY(c), 0) : 0;
      const subsistence = prod && typeof prod.subsistenceCost === 'function' ? finiteOr(prod.subsistenceCost(c), 0) : 0;
      return { clan: c, guild, meanY, subsistence, budget: { left: Math.ceil(POP.maxSwitchFrac * this.clanCount(c)) } };
    });
  }

  /**
   * Profession reviews: forced reviews (last net income below subsistence) first, poorest first,
   * then a `reviewFrac` random sample; at most `budget.left` switches per clan.
   */
  _reviews(sim, ctxs) {
    const rng = sim.rng;
    const forced = [];
    const sampled = [];
    for (const a of this.agents) {
      const ctx = ctxs[a.clan ?? 0] || ctxs[0];
      const nh = a.netHistory;
      const last = nh && nh.length ? nh[nh.length - 1] : NaN;
      if (Number.isFinite(last) && last < ctx.subsistence) forced.push(a);
      else if (rng.next() < POP.reviewFrac) sampled.push(a);
    }
    forced.sort((a, b) => lastNet(a) - lastNet(b) || a.id - b.id);
    // A clan whose switch budget is spent skips its remaining reviews (no randomness is used).
    for (const a of forced) this._review(a, sim, ctxs[a.clan ?? 0] || ctxs[0]);
    for (const a of sampled) this._review(a, sim, ctxs[a.clan ?? 0] || ctxs[0]);
  }

  /** One review; returns false once the switch budget is spent. */
  _review(agent, sim, ctx) {
    if (!(ctx.budget.left > 0)) return false;
    if (!agent.alive) return true;
    const before = agent.profession;
    const left = ctx.budget.left;
    reviewProfession(agent, sim, ctx);
    // Count the switch here if the brain did not.
    if (agent.profession !== before && ctx.budget.left === left) ctx.budget.left--;
    return ctx.budget.left > 0;
  }

  /**
   * Births (§D.9): a housed parent older than birthMinAgeDays with tallow > birthTallow,
   * lustre > birthLustre and glim ≥ birthGlim has a child with chance birthChance·(1 − pop/max).
   * The child appears at the home door and starts with one profession review.
   */
  _births(sim, ctxs) {
    const rng = sim.rng;
    const prod = sim.production;
    const clans = sim.clans;
    const multi = this._multi;
    const parents = this.agents.slice();
    for (const a of parents) {
      const c = a.clan ?? 0;
      const pop = this.clanCount(c);
      const max = this.clanMax(c);
      if (pop >= max) {
        if (!multi) break;
        continue;
      }
      if (!a.alive || a.homeId == null) continue;
      const n = a.needs;
      if (!(n.tallow > POP.birthTallow && n.lustre > POP.birthLustre && a.glim >= POP.birthGlim
        && a.ageDays > POP.birthMinAgeDays)) continue;
      // The clan's family law (small ×0.5, normal ×1, big ×1.6).
      const mul = clans ? clans.birthMul(c) : 1;
      const chance = mul === 1 ? POP.birthChance : POP.birthChance * mul;
      if (!(rng.next() < chance * (1 - pop / max))) continue;

      const house = prod && typeof prod.houseOf === 'function' ? prod.houseOf(a.id) : null;
      const door = house && house.door ? house.door : a.cell;
      const cell = this._standCellNear(door.x, door.y, door.z) || a.cell;
      const child = this.spawn({ kind: 'birth', parent: a, cell, profession: a.profession, ageDays: 0 });
      if (!child) {
        if (!multi) break;
        continue;
      }
      // SPEC-GAP: the newborn's first review has its own one-switch budget so a busy dawn
      // cannot deny it a first choice of trade.
      const ctx = ctxs[c] || ctxs[0];
      reviewProfession(child, sim, { clan: c, guild: ctx.guild, meanY: ctx.meanY, subsistence: ctx.subsistence, budget: { left: 1 } });
    }
  }

  /**
   * Emigration (§D.9): `lowDays` counts consecutive dawns with lustre < emigrateLustre and
   * glim < emigrateGlim; at emigrateDays the agent leaves.
   * SPEC-GAP: voluntary departures stop at the clan's population floor (the immigration floor
   * would only refill it).
   */
  _emigration() {
    const leaving = [];
    for (const a of this.agents) {
      if (a.needs.lustre < POP.emigrateLustre && a.glim < POP.emigrateGlim) a.lowDays++;
      else a.lowDays = 0;
      if (a.lowDays >= POP.emigrateDays) leaving.push(a);
    }
    for (const a of leaving) {
      const c = a.clan ?? 0;
      if (this.clanCount(c) <= this.clanFloor(c)) {
        if (!this._multi) break;
        continue;
      }
      this.emigrate(a);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Hourly: deaths and immigration
  // ───────────────────────────────────────────────────────────────────────────

  /** Deaths by starvation (starveDays at tallow 0) and by age (ageDays ≥ lifespanDays). */
  _checkDeaths() {
    const doomed = this._doomed, causes = this._doomedCause;
    doomed.length = 0;
    causes.length = 0;
    const starveLimit = AG.starveDays * PER_DAY;
    for (const a of this.agents) {
      if (a.starveTicks >= starveLimit) { doomed.push(a); causes.push('starved'); }
      else if (a.ageDays >= a.lifespanDays) { doomed.push(a); causes.push('age'); }
    }
    for (let i = 0; i < doomed.length; i++) this.kill(doomed[i], causes[i]);
    doomed.length = 0;
    causes.length = 0;
  }

  /**
   * Immigration (§D.9): below the floor, one immigrant every floorEveryHours (a stabilizer);
   * when the median real wage ≥ prosperityRealWage, vacant beds ≥ prosperityVacancy and
   * pop < max, one every prosperityEveryHours.
   */
  _immigration(tick) {
    for (let c = 0; c < this._clanList.length; c++) {
      if (this.clanCount(c) < this.clanFloor(c) && tick - this._lastFloorTick[c] >= POP.floorEveryHours * PER_HOUR) {
        const a = this._immigrate('floor', c);
        if (a) {
          this._lastFloorTick[c] = tick;
          const ledger = this.sim.ledger;
          if (ledger && typeof ledger.stabilizer === 'function') {
            ledger.stabilizer('immigrationFloor', 1, ['stab.mothArrives', { name: a.name }]);
          }
        }
      }
      if (this.clanCount(c) < this.clanMax(c) && tick - this._lastProsperityTick[c] >= POP.prosperityEveryHours * PER_HOUR
        && this._prosperous(c)) {
        if (this._immigrate('prosperity', c)) this._lastProsperityTick[c] = tick;
      }
    }
  }

  /** Clan c's median real wage (last net / P̄tablet) ≥ threshold and enough vacant beds. */
  _prosperous(c = 0) {
    const sim = this.sim;
    const prod = sim.production;
    const houses = prod && Array.isArray(prod.houses) ? prod.houses : null;
    if (!houses) return false;
    let vacant = 0;
    for (const h of houses) {
      if ((h.clan ?? 0) !== c) continue;
      const cap = Number.isInteger(h.capacity) ? h.capacity : CONFIG.production.house.capacity;
      vacant += Math.max(0, cap - (h.residents ? h.residents.length : 0));
    }
    if (vacant < POP.prosperityVacancy) return false;

    if (this._nets.length < this.agents.length) this._nets = new Float64Array(this.agents.length + 16);
    const nets = this._nets;
    let k = 0;
    for (const a of this.agents) {
      if ((a.clan ?? 0) !== c) continue;
      const nh = a.netHistory;
      const v = nh && nh.length ? nh[nh.length - 1] : NaN;
      if (Number.isFinite(v)) nets[k++] = v;
    }
    if (k === 0) return false;
    const sorted = nets.subarray(0, k).sort();
    const median = k & 1 ? sorted[k >> 1] : 0.5 * (sorted[(k >> 1) - 1] + sorted[k >> 1]);
    const market = sim.market;
    let pTablet = 0;
    if (this._multi && sim.clans) pTablet = finiteOr(sim.clans.clanPrice(c, 'tablet'), 0);
    else if (market && typeof market.avgPrice === 'function') pTablet = finiteOr(market.avgPrice('tablet'), 0);
    const price = pTablet > 0 ? pTablet : CONFIG.goods.tablet.ref;
    return median / price >= POP.prosperityRealWage;
  }

  /** Drop one immigrant of clan c by moth onto one of the clan's plazas. */
  _immigrate(reason, c = 0) {
    const sim = this.sim;
    const rng = sim.rng;
    const [a0, a1] = AG.initialAgeDays;
    // SPEC-GAP: immigrants take a trade in the founders' mix, arrive with a founder's age range
    // and the founders' starter food; their review at dawn moves them where the Guild Board points.
    const agent = this.spawn({
      kind: 'immigrant', reason, clan: c, cell: this._plazaDropCell(c), profession: this._pickProfession(c),
      ageDays: rng.range(a0, a1), glim: MONEY.immigrantGlim,
    });
    if (!agent) return null;
    addItem(agent, 'tablet', STARTER_TABLETS);
    addItem(agent, 'berry', STARTER_BERRIES);
    return agent;
  }

  _pickProfession(c = 0) {
    const cum = this._profCums[c] || this._profCums[0];
    const total = cum.length ? cum[cum.length - 1] : 0;
    if (!(total > 0)) return this.sim.rng.pick(PROFESSIONS);
    const r = this.sim.rng.next() * total;
    for (let i = 0; i < cum.length; i++) if (r < cum[i]) return PROFESSIONS[i];
    return PROFESSIONS[PROFESSIONS.length - 1];
  }

  /** A walkable cell on a random plaza of clan c. */
  _plazaDropCell(c = 0) {
    const sim = this.sim;
    const rng = sim.rng;
    const world = sim.world;
    const all = (sim.worldInfo && sim.worldInfo.markets) || [];
    const markets = this._multi ? all.filter((mk) => (mk.clan ?? 0) === c) : all;
    if (markets.length && world) {
      const mk = markets[rng.int(0, markets.length - 1)];
      const pz = mk.plaza;
      if (pz) {
        for (let tries = 0; tries < 12; tries++) {
          const x = rng.int(pz.x0, pz.x1), z = rng.int(pz.z0, pz.z1);
          if (world.isWalkable(x, pz.y, z)) return { x, y: pz.y, z };
        }
      }
      const ctr = mk.center;
      if (ctr) {
        const near = this._standCellNear(ctr.x, ctr.y, ctr.z);
        if (near) return near;
      }
    }
    return this._fallbackCell(c);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  _isMember(agent) {
    return !!agent && agent.alive !== false && this.byId.get(agent.id) === agent;
  }

  /**
   * Stop everything the agent is doing before it leaves: flush pending demurrage, interrupt the
   * brain, cancel the path ticket and refund open bids into glim.
   */
  _detach(agent, reason) {
    const sim = this.sim;
    flushDemurrage(agent, sim);
    interrupt(agent, sim, reason);
    this._dropPath(agent);
    if (sim.market && typeof sim.market.cancelBids === 'function') sim.market.cancelBids(agent);
    agent.tending = null;
  }

  _dropPath(agent) {
    const pf = this.sim.pathfinder;
    if (agent.pathTicket != null && pf && typeof pf.cancel === 'function') pf.cancel(agent.pathTicket);
    agent.pathTicket = null;
    agent.path = null;
    agent.pathI = 0;
    agent.pathBlocked = false;
  }

  /**
   * Final cleanup shared by kill and emigrate: market and production hooks, then any money
   * still on the agent (refunded after settlement by a peer) is swept into `sinkKind` so the
   * money audit stays exact; then the agent leaves the live lists.
   */
  _remove(agent, sinkKind) {
    const sim = this.sim;
    if (sim.market && typeof sim.market.onAgentRemoved === 'function') sim.market.onAgentRemoved(agent);
    if (sim.production && typeof sim.production.onAgentRemoved === 'function') sim.production.onAgentRemoved(agent);
    flushDemurrage(agent, sim);
    const residual = finiteOr(agent.glim, 0) + finiteOr(agent.escrow, 0);
    if (Math.abs(residual) > MONEY_EPS) this._record(sinkKind, residual);
    agent.glim = 0;
    agent.escrow = 0;
    agent.openBids = 0;
    agent.alive = false;
    const i = this.agents.indexOf(agent);
    if (i >= 0) this.agents.splice(i, 1);
    this.byId.delete(agent.id);
    const c = agent.clan ?? 0;
    if (this._clanN[c] > 0) this._clanN[c]--;
  }

  /** Youngest living child, else a living housemate, else null. */
  _heirOf(agent) {
    let heir = null;
    for (const id of agent.childrenIds) {
      const c = this.byId.get(id);
      if (c && c.alive && c !== agent && (!heir || c.ageDays < heir.ageDays)) heir = c;
    }
    if (heir || agent.homeId == null) return heir;
    const prod = this.sim.production;
    const house = prod && typeof prod.houseOf === 'function' ? prod.houseOf(agent.id) : null;
    if (house && Array.isArray(house.residents)) {
      for (const id of house.residents) {
        const h = id !== agent.id ? this.byId.get(id) : null;
        if (h && h.alive) return h;
      }
    }
    for (const a of this.agents) if (a !== agent && a.homeId === agent.homeId) return a;
    return null;
  }

  /** Teleport an agent onto a foot cell (no interpolation streak, motion state reset). */
  _place(agent, cell) {
    const x = cell.x | 0, y = cell.y | 0, z = cell.z | 0;
    agent.pos.x = x + 0.5; agent.pos.y = y; agent.pos.z = z + 0.5;
    agent.prevPos.x = agent.pos.x; agent.prevPos.y = y; agent.prevPos.z = agent.pos.z;
    agent.cell.x = x; agent.cell.y = y; agent.cell.z = z;
    resetMotion(agent);
  }

  /** Nearest walkable cell to (x, y, z): pathfinder first, then the surface, then a local scan. */
  _standCellNear(x, y, z) {
    const sim = this.sim;
    const pf = sim.pathfinder;
    const world = sim.world;
    const ground = this._groundCellNear(x, y, z);
    if (ground) return ground;
    if (pf && typeof pf.nearestWalkable === 'function') {
      const c = pf.nearestWalkable(x, y, z, 6)
        || (world && typeof world.surfaceY === 'function' ? pf.nearestWalkable(x, world.surfaceY(x, z), z, 6) : null)
        || pf.nearestWalkable(x, y, z, 12);
      if (c) return { x: c.x, y: c.y, z: c.z };
    }
    if (!world) return null;
    if (world.isWalkable(x, y, z)) return { x, y, z };
    for (let r = 1; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            if (world.isWalkable(x + dx, y + dy, z + dz)) return { x: x + dx, y: y + dy, z: z + dz };
          }
        }
      }
    }
    if (typeof world.surfaceY === 'function') {
      const sy = world.surfaceY(x, z);
      if (world.isWalkable(x, sy, z)) return { x, y: sy, z };
    }
    return null;
  }

  /**
   * Nearest walkable cell on natural ground (never atop a wall, roof, lens mount, kettle, lantern
   * or glass), preferring cells that share a walkable region with a plaza. The plain nearest
   * walkable cell was often the top of a wall that had just been built, stranding masons on roofs.
   * @returns {{x:number,y:number,z:number}|null}
   */
  _groundCellNear(x, y, z) {
    const world = this.sim.world;
    const pf = this.sim.pathfinder;
    if (!world) return null;
    pf?.refreshRegions?.(false);
    const markets = this.sim.worldInfo?.markets || [];
    const linked = (c) => !pf || !markets.length || markets.some((m) => pf.sameRegion(c, m.center));
    const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
    let fallback = null;
    for (let r = 0; r <= 12; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const px = cx + dx, pz = cz + dz;
          const top = world.surfaceY(px, pz);
          for (const py of [top, cy, cy - 1, cy + 1, cy - 2]) {
            if (!world.isWalkable(px, py, pz) || BUILT_FLOOR.has(world.get(px, py - 1, pz))) continue;
            const c = { x: px, y: py, z: pz };
            if (linked(c)) return c;
            if (!fallback) fallback = c;
          }
        }
      }
    }
    return fallback;
  }

  /** Last-resort spawn cell: a spawn cell (of clan `clan`), a plaza centre, or the island centre surface. */
  _fallbackCell(clan = 0) {
    const sim = this.sim;
    const info = sim.worldInfo || {};
    const cells = info.spawnByClan?.[clan]?.length ? info.spawnByClan[clan] : info.spawnCells;
    if (Array.isArray(cells) && cells.length) {
      const c = cells[sim.rng.int(0, cells.length - 1)];
      return { x: c.x, y: c.y, z: c.z };
    }
    const m = Array.isArray(info.markets) && (info.markets.find((mk) => (mk.clan ?? 0) === clan) || info.markets[0]);
    if (m && m.center) return { x: m.center.x, y: m.center.y, z: m.center.z };
    const W = CONFIG.world;
    const world = sim.world;
    const y = world && typeof world.surfaceY === 'function' ? world.surfaceY(W.CX, W.CZ) : W.WATER_LEVEL + 4;
    return this._standCellNear(W.CX, y, W.CZ) || { x: W.CX, y, z: W.CZ };
  }

  _ensureHashCapacity(n) {
    if (n <= this._hashCap) return;
    const cap = Math.max(n, this._hashCap * 2);
    this._hashBucket = new Int32Array(cap);
    this._hashItems = new Int32Array(cap);
    this._hashCap = cap;
  }

  /** Counting-sort every live agent into its 4×4-column bucket. */
  _rebuildHash() {
    const agents = this.agents;
    const n = agents.length;
    this._ensureHashCapacity(n);
    const hx = this._hx, hz = this._hz;
    const start = this._bStart, fill = this._bFill, bucketOf = this._hashBucket, items = this._hashItems;
    const snap = this._hashAgents;
    const nb = hx * hz;
    fill.fill(0);
    for (let i = 0; i < n; i++) {
      const a = agents[i];
      snap[i] = a;
      const bx = clampInt(Math.floor(a.pos.x / HASH_CELL), 0, hx - 1);
      const bz = clampInt(Math.floor(a.pos.z / HASH_CELL), 0, hz - 1);
      const b = bx + hx * bz;
      bucketOf[i] = b;
      fill[b]++;
    }
    for (let i = n; i < this._hashN; i++) snap[i] = null;
    this._hashN = n;
    start[0] = 0;
    for (let b = 0; b < nb; b++) {
      start[b + 1] = start[b] + fill[b];
      fill[b] = start[b];
    }
    for (let i = 0; i < n; i++) items[fill[bucketOf[i]]++] = i;
  }

  /** Hourly P̄ sample per good and the 6-hour trend used by the rumour stall penalty. */
  _samplePrices() {
    const market = this.sim.market;
    if (!market || typeof market.avgPrice !== 'function') return;
    const G = GOODS.length;
    const head = this._pHead;
    for (let gi = 0; gi < G; gi++) this._pRing[head * G + gi] = finiteOr(market.avgPrice(GOODS[gi]), 0);
    this._pHead = (head + 1) % TREND_RING;
    if (this._pSamples < TREND_RING) this._pSamples++;
    if (this._pSamples < TREND_RING) return;
    const old = this._pHead; // oldest sample == 6 hours before `head`
    for (let gi = 0; gi < G; gi++) {
      const now = this._pRing[head * G + gi], then = this._pRing[old * G + gi];
      this._trend[gi] = now > 0 && then > 0 ? now - then : 0;
    }
  }

  /** Emit RUMOR for every good whose believer count changed since the last announcement. */
  _announceRumors() {
    const count = this._rumorCount, dirSum = this._rumorDirSum;
    count.fill(0);
    dirSum.fill(0);
    for (const a of this.agents) {
      const r = a.rumor;
      if (!r) continue;
      const gi = GOOD_INDEX.get(r.good);
      if (gi === undefined) continue;
      count[gi]++;
      dirSum[gi] += r.dir < 0 ? -1 : 1;
    }
    for (let gi = 0; gi < GOODS.length; gi++) {
      if (count[gi] === this._rumorLast[gi]) continue;
      this._rumorLast[gi] = count[gi];
      if (dirSum[gi] !== 0) this._rumorLastDir[gi] = dirSum[gi] > 0 ? 1 : -1;
      this._emit(EV.RUMOR, { good: GOODS[gi], dir: this._rumorLastDir[gi], believers: count[gi] });
    }
  }

  /**
   * Professions for clan c's founders per its mix, scaled to `n`, padded/trimmed and shuffled.
   * (The classic single clan uses `initialProf` exactly.)
   */
  _initialProfessions(n, c = 0) {
    const mix = this._clanList[c]?.profMix ?? POP.initialProf;
    let total = 0;
    for (const p of PROFESSIONS) total += Math.max(0, (mix && mix[p]) | 0);
    const scale = this._multi && total > 0 ? n / total : 1;
    const out = [];
    for (const p of PROFESSIONS) {
      const k = Math.max(0, (mix && mix[p]) | 0);
      const kk = scale === 1 ? k : Math.round(k * scale);
      for (let i = 0; i < kk; i++) out.push(p);
    }
    while (out.length < n) out.push(this._pickProfession(c));
    shuffle(out, this.sim.rng);
    out.length = n;
    return out;
  }

  _record(kind, amount) {
    if (!(Math.abs(amount) > MONEY_EPS) || !Number.isFinite(amount)) return;
    const ledger = this.sim.ledger;
    if (ledger && typeof ledger.record === 'function') ledger.record(kind, amount);
  }

  _emit(name, payload) {
    const ev = this.sim.events;
    if (ev && name) ev.emit(name, payload);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Read a SimClock flag, falling back to the tick arithmetic when the field is absent. */
function clockFlag(clock, key, fallback) {
  const v = clock ? clock[key] : undefined;
  return typeof v === 'boolean' ? v : fallback;
}

/** In-place Fisher–Yates shuffle with the sim rng. */
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function lastNet(a) {
  const nh = a.netHistory;
  return nh && nh.length ? nh[nh.length - 1] : 0;
}

function clampBelief(good, v) {
  const ref = CONFIG.goods[good].ref;
  const [lo, hi] = MC.beliefClamp;
  return clamp(Number.isFinite(v) ? v : ref, lo * ref, hi * ref);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampInt(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v | 0;
}

function finiteOr(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
