/**
 * @file Wickling body (SPEC §C.2, §C.4 "G3: agent.js", ADDENDUM §3–§6).
 *
 * Creates agents with every public field, runs the per-tick body update
 * (physiology, demurrage, spoilage, gravity, path following with digging) and
 * provides the inventory helpers shared by brain, market and production.
 *
 * Sim-side: no DOM, no three. `stepAgent` runs ~110× per tick, so it allocates
 * nothing in steady state and keeps its scratch state in `agent._mv`.
 */
import { CONFIG, TICKS, GOODS, ITEMS, PROFESSIONS } from '../core/config.js';
import { EV } from '../core/events.js';
import { B, BLOCKS, AGENT_DIGGABLE } from '../world/blocks.js';

/** Alias of `CONFIG.professions` ({name, color, carry} per profession id). */
export const PROF_INFO = CONFIG.professions;

const AG = CONFIG.agent;
const MONEY = CONFIG.money;
const DT = 1 / TICKS.PER_SEC;
const PER_HOUR = TICKS.PER_HOUR;
const PER_DAY = TICKS.PER_DAY;
const HOURS_PER_DAY = PER_DAY / PER_HOUR;
const EPS = 1e-9;
const TWO_PI = Math.PI * 2;

const LENS = 'lens';
const GOOD_SET = new Set(GOODS);
const ITEM_SET = new Set(ITEMS);
/** Goods that spoil in a pocket (berry, tablet). */
const PERISHABLE = GOODS.filter((g) => (CONFIG.goods[g]?.invSpoilPerDay ?? 0) > 0);

// Literals fixed by SPEC §C.4 (not CONFIG keys).
const EAT_TABLET_AT = 60;      // eat(): a tablet when tallow ≤ 60, else a berry
const LOADED_FRAC = 0.7;       // loadedMul applies when load > 0.7
const SKILL_OWN = 1.0, SKILL_OTHER = 0.8;               // founders
const SKILL_CHILD_OWN = 0.9, SKILL_CHILD_OTHER = 0.7;   // children
const SKEPTICISM_MAX = 0.8;

// SPEC-GAP: a path node further than 2 cells (any axis) from the current cell
// cannot be a legal next step, so it is treated as blocked.
const MAX_HOP = 2;
// SPEC-GAP: an agent wedged in a non-walkable cell with nothing to fall into
// (a block placed into it, flooding…) and no active path asks population to
// relocate it after this many ticks.
const WEDGED_TICKS = 2 * TICKS.PER_SEC;

const FIRST_NAMES = ['Tallowby', 'Wickett', 'Ember', 'Candor', 'Taper', 'Flick', 'Glimmer', 'Sconce',
  'Votive', 'Snuff', 'Lumen', 'Cera', 'Beeswick', 'Dripley', 'Moth'];
const SURNAMES = ['Fenn', 'Wax', 'Brass', 'Dew', 'Peat', 'Quill', 'Soot', 'Pine', 'Ridge', 'Hollow',
  'Bell', 'Tallow', 'Rush', 'Mote'];

/** Per-sim fallback id counters for agents created without an explicit id. */
const idCounters = new WeakMap();

/** Scratch cell reused by the dig logic (never escapes this module). */
const DC = { x: 0, y: 0, z: 0 };

/**
 * @typedef {{x:number, y:number, z:number}} Vec3
 * @typedef {{x:number, y:number, z:number, dig:number}} PathNode
 * @typedef {object} Agent  Public fields exactly as SPEC §C.2; private scratch lives in `_mv`
 *   (agent.js), `_br` (brain), `_pop` (population), `_mk` (market), `_pr` (production).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Creation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a Wickling with every SPEC §C.2 field filled.
 *
 * @param {object} sim
 * @param {{cell: Vec3, profession: string, glim?: number, ageDays?: number, parent?: Agent|null,
 *          id?: number, needs?: {tallow:number, rest:number, lustre:number}}} opts
 *   `id` is normally assigned by `Population.spawn`; `needs` optionally overrides the start needs.
 * @returns {Agent}
 */
export function createAgent(sim, opts = {}) {
  const rng = sim.rng;
  const parent = opts.parent || null;
  const profession = PROF_INFO[opts.profession] ? opts.profession
    : (parent && PROF_INFO[parent.profession] ? parent.profession : PROFESSIONS[0]);
  const id = Number.isInteger(opts.id) ? reserveId(sim, opts.id) : takeId(sim);
  const tick = sim.clock ? sim.clock.tick | 0 : 0;
  const ageDays = Math.max(0, Number(opts.ageDays) || 0);
  const c = opts.cell || { x: 0, y: 1, z: 0 };
  const cx = Math.floor(c.x), cy = Math.floor(c.y), cz = Math.floor(c.z);
  const clan = Number.isInteger(opts.clan) ? opts.clan : (parent ? parent.clan ?? 0 : 0);
  const clans = sim.clans || null;

  let name = generateName(rng, clans ? clans.namePool(clan) : null);
  if (parent && typeof parent.name === 'string') {
    // Children keep the family surname.
    const sp = parent.name.lastIndexOf(' ');
    if (sp > 0) name = name.slice(0, name.indexOf(' ')) + parent.name.slice(sp);
  }

  const skills = {};
  for (const p of PROFESSIONS) {
    skills[p] = parent
      ? (p === parent.profession ? SKILL_CHILD_OWN : SKILL_CHILD_OTHER)
      : (p === profession ? SKILL_OWN : SKILL_OTHER);
  }
  // A clan's talent: everyone born into it starts better at that trade.
  const talent = clans ? clans.talent(clan) : null;
  if (talent) skills[talent] = Math.min(AG.skill.max, skills[talent] + (CONFIG.clans?.talentSkill ?? 0.3));

  const [bLo, bHi] = CONFIG.market.beliefClamp;
  const beliefs = {};
  const costBasis = {};
  for (const g of GOODS) {
    const ref = CONFIG.goods[g].ref;
    const pb = parent && parent.beliefs ? parent.beliefs[g] : 0;
    const b = pb > 0 ? pb * rng.range(0.9, 1.1) : ref * rng.range(0.8, 1.2);
    beliefs[g] = clamp(b, bLo * ref, bHi * ref);
    costBasis[g] = 0;
  }

  const inv = {};
  for (const it of ITEMS) inv[it] = 0;

  let lifespanDays = rng.range(AG.lifespanDays[0], AG.lifespanDays[1]);
  // SPEC-GAP: nobody is created already past their lifespan (only reachable with retuned CONFIG).
  if (lifespanDays < ageDays + 1) lifespanDays = ageDays + 1;
  const skepticism = rng.range(0, SKEPTICISM_MAX);
  const heading = rng.range(0, TWO_PI);
  // SPEC-GAP: start needs are not specified; Wicklings arrive fed, rested and middling in esteem.
  const needs = opts.needs
    ? { tallow: clamp(+opts.needs.tallow || 0, 0, 100), rest: clamp(+opts.needs.rest || 0, 0, 100),
        lustre: clamp(+opts.needs.lustre || 0, 0, 100) }
    : { tallow: rng.range(60, 90), rest: rng.range(60, 90), lustre: rng.range(40, 65) };

  const pos = { x: cx + 0.5, y: cy, z: cz + 0.5 };
  const nMarkets = sim.worldInfo?.markets?.length || 2;
  return {
    id, name, clan,
    alive: true,
    generation: parent ? (parent.generation | 0) + 1 : 0,
    parentId: parent ? parent.id : null,
    childrenIds: [],
    profession,
    skills,
    bornTick: tick - Math.round(ageDays * PER_DAY),
    ageDays,
    lifespanDays,
    pos,
    prevPos: { x: pos.x, y: pos.y, z: pos.z },
    cell: { x: cx, y: cy, z: cz },
    heading,
    anim: 'idle', animT: 0,
    needs,
    starveTicks: 0,
    asleep: false,
    fright: 0,
    panicUntil: 0,
    glim: Math.max(0, Number(opts.glim) || 0),
    escrow: 0,
    inv,
    lanterns: [],
    homeId: null,
    towerId: null,
    tending: null,
    projectId: null,
    commissionId: null,
    beliefs,
    costBasis,
    skepticism,
    rumor: null,
    spec: null,
    porter: null,
    task: null,
    goal: 'idle',
    thought: parent ? ['th.born'] : ['th.arrived'],
    utilities: [],
    path: null, pathI: 0, pathTicket: null, pathBlocked: false,
    openBids: 0, chimeResult: null,
    blacklist: new Map(),
    marketBlockedUntil: new Array(nMarkets).fill(0),
    earnedToday: 0, inputsToday: 0, netHistory: [],
    lowDays: 0,
    fightUntil: 0, fightWith: null,
    _mv: makeMotionState(),
  };
}

/**
 * A random Wickling name such as "Tallowby Fenn".
 * @param {{pick: function(Array): *}} rng
 * @param {{first:string[], last:string[]}|null} [pool] the clan's names (the classic names by default)
 * @returns {string}
 */
export function generateName(rng, pool = null) {
  return `${rng.pick(pool?.first ?? FIRST_NAMES)} ${rng.pick(pool?.last ?? SURNAMES)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Save files
// ─────────────────────────────────────────────────────────────────────────────

/** Agent fields a save file keeps as they are; everything else starts fresh on load. */
const SAVED_FIELDS = ['id', 'name', 'clan', 'generation', 'parentId', 'childrenIds', 'profession', 'skills',
  'bornTick', 'ageDays', 'lifespanDays', 'pos', 'prevPos', 'cell', 'heading', 'needs', 'starveTicks', 'fright',
  'panicUntil', 'inv', 'lanterns', 'homeId', 'towerId', 'projectId', 'commissionId', 'beliefs', 'costBasis',
  'skepticism', 'rumor', 'spec', 'porter', 'goal', 'thought', 'earnedToday', 'inputsToday', 'netHistory',
  'lowDays', 'fightUntil', 'fightWith', 'marketBlockedUntil'];

/**
 * An agent as plain data for a save file. What it is doing right now (task, path, open bids) is
 * not kept: on load every Wickling decides afresh. Open bids' escrow is counted back into glim
 * (both are part of the money supply, so the audit is unchanged).
 * The record shares sub-objects with the live agent: stringify it before the sim ticks again.
 */
export function serializeAgent(a) {
  const o = {};
  for (const k of SAVED_FIELDS) o[k] = a[k];
  o.glim = (Number.isFinite(a.glim) ? a.glim : 0) + (Number.isFinite(a.escrow) ? a.escrow : 0);
  o.blacklist = a.blacklist instanceof Map ? [...a.blacklist] : [];
  // Demurrage already taken from glim but not yet reported to the ledger (it reports hourly).
  o.dem = a._mv && a._mv.dem > 0 ? a._mv.dem : 0;
  return o;
}

/**
 * Rebuild a live agent from a serializeAgent record (every field createAgent sets).
 * @param {object} r the saved record
 * @param {number} nMarkets markets in the world
 */
export function reviveAgent(r, nMarkets = 2) {
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const vec = (p, d) => ({ x: num(p?.x, d.x), y: num(p?.y, d.y), z: num(p?.z, d.z) });
  const cell = { x: Math.floor(num(r.cell?.x, 0)), y: Math.floor(num(r.cell?.y, 1)), z: Math.floor(num(r.cell?.z, 0)) };
  const pos = vec(r.pos, { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 });
  const skills = {};
  for (const p of PROFESSIONS) skills[p] = clamp(num(r.skills?.[p], SKILL_OTHER), AG.skill.min, AG.skill.max);
  const [bLo, bHi] = CONFIG.market.beliefClamp;
  const beliefs = {};
  const costBasis = {};
  for (const g of GOODS) {
    const ref = CONFIG.goods[g].ref;
    beliefs[g] = clamp(num(r.beliefs?.[g], ref), bLo * ref, bHi * ref);
    costBasis[g] = Math.max(0, num(r.costBasis?.[g], 0));
  }
  const inv = {};
  for (const it of ITEMS) inv[it] = Math.max(0, Math.floor(num(r.inv?.[it], 0)));
  const blocked = new Array(nMarkets).fill(0);
  if (Array.isArray(r.marketBlockedUntil)) for (let m = 0; m < nMarkets; m++) blocked[m] = num(r.marketBlockedUntil[m], 0);
  const n = r.needs || {};
  const idOrNull = (v) => (Number.isInteger(v) ? v : null);
  const agent = {
    id: r.id | 0, name: typeof r.name === 'string' ? r.name : 'Wickling', clan: Math.max(0, r.clan | 0),
    alive: true,
    generation: Math.max(0, r.generation | 0),
    parentId: idOrNull(r.parentId),
    childrenIds: Array.isArray(r.childrenIds) ? r.childrenIds.filter(Number.isInteger) : [],
    profession: PROF_INFO[r.profession] ? r.profession : PROFESSIONS[0],
    skills,
    bornTick: num(r.bornTick, 0),
    ageDays: Math.max(0, num(r.ageDays, 0)),
    lifespanDays: num(r.lifespanDays, AG.lifespanDays[1]),
    pos,
    prevPos: vec(r.prevPos, pos),
    cell,
    heading: num(r.heading, 0),
    anim: 'idle', animT: 0,
    needs: { tallow: clamp(num(n.tallow, 60), 0, 100), rest: clamp(num(n.rest, 60), 0, 100), lustre: clamp(num(n.lustre, 50), 0, 100) },
    starveTicks: Math.max(0, r.starveTicks | 0),
    asleep: false,
    fright: Math.max(0, num(r.fright, 0)),
    panicUntil: num(r.panicUntil, 0),
    glim: Math.max(0, num(r.glim, 0)),
    escrow: 0,
    inv,
    lanterns: Array.isArray(r.lanterns) ? r.lanterns.filter(Number.isFinite).slice(0, AG.maxLanterns) : [],
    homeId: idOrNull(r.homeId),
    towerId: idOrNull(r.towerId),
    tending: null,
    projectId: idOrNull(r.projectId),
    commissionId: idOrNull(r.commissionId),
    beliefs,
    costBasis,
    skepticism: clamp(num(r.skepticism, SKEPTICISM_MAX / 2), 0, 1),
    rumor: r.rumor && GOOD_SET.has(r.rumor.good) ? { ...r.rumor } : null,
    spec: r.spec && GOOD_SET.has(r.spec.good) ? { ...r.spec } : null,
    porter: r.porter && GOOD_SET.has(r.porter.good) ? { ...r.porter } : null,
    task: null,
    goal: typeof r.goal === 'string' ? r.goal : 'idle',
    thought: Array.isArray(r.thought) || typeof r.thought === 'string' ? r.thought : ['th.setDown'],
    utilities: [],
    path: null, pathI: 0, pathTicket: null, pathBlocked: false,
    openBids: 0, chimeResult: null,
    blacklist: new Map(Array.isArray(r.blacklist) ? r.blacklist.filter((e) => Array.isArray(e) && e.length === 2) : []),
    marketBlockedUntil: blocked,
    earnedToday: num(r.earnedToday, 0), inputsToday: num(r.inputsToday, 0),
    netHistory: Array.isArray(r.netHistory) ? r.netHistory.filter(Number.isFinite).slice(-3) : [],
    lowDays: Math.max(0, r.lowDays | 0),
    fightUntil: num(r.fightUntil, 0), fightWith: idOrNull(r.fightWith),
    _mv: makeMotionState(),
  };
  agent._mv.dem = Math.max(0, num(r.dem, 0));
  return agent;
}

function takeId(sim) {
  const next = idCounters.get(sim) ?? 1;
  idCounters.set(sim, next + 1);
  return next;
}

function reserveId(sim, id) {
  if ((idCounters.get(sim) ?? 1) <= id) idCounters.set(sim, id + 1);
  return id;
}

function makeMotionState() {
  return {
    path: null,      // path array whose node is in progress
    nodeI: -1,       // index of that node (-1 = none begun)
    ox: 0, oy: 0, oz: 0, // origin cell of the current hop
    digMask: 0,      // dig bits still to process for the current node
    digLeft: -1,     // seconds left on the current dig cell (-1 = not started)
    climbLeft: 0,    // seconds of climb delay left for the current hop
    speed: 0,        // cells/sec for the current hop
    nodeWv: NaN,     // world.version at the last enterability check
    falling: false,
    wv: NaN, gx: 0, gy: 0, gz: 0, // world.version / cell at the last walkability check
    bad: false,      // current cell is not walkable
    badT: 0,         // ticks wedged without a path
    dem: 0,          // demurrage not yet sent to the ledger
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-tick body update
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Advance one agent by one tick (SPEC §C.4 stepAgent, ADDENDUM §4–§5).
 * Order: prevPos snapshot, physiology, demurrage, spoilage (hour ticks), gravity,
 * path following.
 * @param {Agent} agent
 * @param {object} sim
 */
export function stepAgent(agent, sim) {
  if (!agent || !agent.alive) return;
  const mv = agent._mv || (agent._mv = makeMotionState());
  const pos = agent.pos, prev = agent.prevPos;
  prev.x = pos.x; prev.y = pos.y; prev.z = pos.z;

  const hourTick = sim.clock ? sim.clock.tick % PER_HOUR === 0 : false;
  physiology(agent);
  demurrage(agent, mv, sim, hourTick);
  if (hourTick) spoilInventory(agent, sim);

  const world = sim.world;
  if (world && !gravity(agent, mv, sim, world)) followPath(agent, mv, sim, world);
  agent.animT += DT;
}

function physiology(agent) {
  const n = agent.needs;
  const housed = agent.homeId != null;
  if (agent.asleep) {
    n.tallow -= AG.tallowSleepPerDay / PER_DAY;
    n.rest += (housed ? AG.restPerHourHoused : AG.restPerHourUnhoused) / PER_HOUR;
  } else {
    n.tallow -= AG.tallowPerDay / PER_DAY;
    n.rest -= AG.restPerDay / PER_DAY;
  }
  const lit = agent.lanterns ? agent.lanterns.length : 0;
  n.lustre += (-AG.lustrePerDay + (housed ? AG.lustreHousedPerDay : 0) + lit * AG.lustrePerLanternPerDay) / PER_DAY;

  n.tallow = n.tallow < 0 ? 0 : n.tallow > 100 ? 100 : n.tallow;
  n.rest = n.rest < 0 ? 0 : n.rest > 100 ? 100 : n.rest;
  n.lustre = n.lustre < 0 ? 0 : n.lustre > 100 ? 100 : n.lustre;

  if (n.tallow <= 0) agent.starveTicks++;
  else agent.starveTicks = 0;
  if (agent.fright > 0) {
    const f = agent.fright - AG.frightDecayPerDay / PER_DAY;
    agent.fright = f > 0 ? f : 0;
  }
  agent.ageDays += 1 / PER_DAY;
}

/** Burn demurrage continuously; the ledger sees it in hourly batches. */
function demurrage(agent, mv, sim, hourTick) {
  const g = agent.glim;
  if (g > 0) {
    let rate = agent.homeId != null ? MONEY.demurrageHoused : MONEY.demurrageUnhoused;
    // The clan's law on fading money (slow ×0.5, normal ×1, fast ×2).
    const mul = sim.clans ? sim.clans.fadeMul(agent.clan ?? 0) : 1;
    if (mul !== 1) rate *= mul;
    const loss = g * rate / PER_DAY;
    agent.glim = g - loss;
    mv.dem += loss;
  }
  // Hour ticks include the newday tick, so the ledger's daily audit sees every burn.
  if (hourTick) flushDemurrage(agent, sim);
}

/**
 * Send an agent's pending demurrage batch to `ledger.record('demurrage', …)`.
 * Population calls this before removing an agent so the money audit balances.
 * @param {Agent} agent
 * @param {object} sim
 * @returns {number} the amount recorded
 */
export function flushDemurrage(agent, sim) {
  const mv = agent && agent._mv;
  if (!mv || !(mv.dem > 0)) return 0;
  const amount = mv.dem;
  mv.dem = 0;
  const ledger = sim && sim.ledger;
  if (ledger && typeof ledger.record === 'function') ledger.record('demurrage', amount);
  return amount;
}

function spoilInventory(agent, sim) {
  const rng = sim.rng;
  if (!rng) return;
  const inv = agent.inv;
  for (let i = 0; i < PERISHABLE.length; i++) {
    const g = PERISHABLE[i];
    const n = inv[g] | 0;
    if (n <= 0) continue;
    const p = CONFIG.goods[g].invSpoilPerDay / HOURS_PER_DAY;
    let lost = 0;
    for (let k = 0; k < n; k++) if (rng.next() < p) lost++;
    if (lost === 0) continue;
    inv[g] = n - lost;
    // SPEC-GAP: pocket spoilage is tallied with lot spoilage in the day record.
    const spoiled = sim.ledger && sim.ledger.today && sim.ledger.today.spoiled;
    if (spoiled) spoiled[g] = (spoiled[g] || 0) + lost;
  }
}

/**
 * Falling and wedge detection. Returns true while the agent is falling (path
 * following is suspended for the tick).
 */
function gravity(agent, mv, sim, world) {
  if (mv.falling) {
    fall(agent, mv, world);
    return true;
  }
  const c = agent.cell;
  const wv = world.version;
  if (wv !== mv.wv || c.x !== mv.gx || c.y !== mv.gy || c.z !== mv.gz) {
    mv.wv = wv; mv.gx = c.x; mv.gy = c.y; mv.gz = c.z;
    mv.bad = !world.isWalkable(c.x, c.y, c.z);
  }
  if (!mv.bad) {
    mv.badT = 0;
    return false;
  }
  if (c.y > 1 && world.isPassableAt(c.x, c.y - 1, c.z)) {
    mv.falling = true;
    mv.nodeI = -1;
    mv.digMask = 0;
    mv.digLeft = -1;
    fall(agent, mv, world);
    return true;
  }
  if (!pathActive(agent) && ++mv.badT >= WEDGED_TICKS) {
    mv.badT = 0;
    const pop = sim.population;
    if (pop && typeof pop.relocate === 'function') pop.relocate(agent);
  }
  return false;
}

function fall(agent, mv, world) {
  const c = agent.cell, pos = agent.pos;
  setAnim(agent, 'fall');
  let landY = c.y;
  while (landY > 1 && world.isPassableAt(c.x, landY - 1, c.z)) landY--;
  const y = pos.y - AG.fallSpeed * DT;
  if (y <= landY) {
    pos.y = landY;
    c.y = landY;
    mv.falling = false;
    mv.wv = NaN;
    // The old path started from a cell we no longer stand on.
    if (pathActive(agent)) agent.pathBlocked = true;
  } else {
    pos.y = y;
    c.y = Math.max(landY, Math.floor(y));
  }
}

function pathActive(agent) {
  const p = agent.path;
  return !!p && !agent.pathBlocked && agent.pathI < p.length;
}

/**
 * Follow `agent.path[agent.pathI]` (ADDENDUM §4). Leftover time after arriving
 * at a node carries into the next hop, so fast walkers do not stutter.
 */
function followPath(agent, mv, sim, world) {
  let t = DT;
  for (let hop = 0; hop < 3 && t > EPS; hop++) {
    const path = agent.path;
    if (!path || agent.pathBlocked || agent.pathI >= path.length) {
      mv.nodeI = -1;
      if (hop === 0) settle(agent, sim);
      return;
    }
    const node = path[agent.pathI];
    if (mv.path !== path || mv.nodeI !== agent.pathI) {
      if (!node || !beginNode(agent, mv, node, world)) {
        blockPath(agent, mv);
        return;
      }
    }
    if (mv.digMask !== 0) {
      t = digStep(agent, mv, node, sim, world, t);
      if (agent.pathBlocked || mv.digMask !== 0) return;
    }
    if (mv.nodeWv !== world.version) {
      mv.nodeWv = world.version;
      if (!world.isWalkable(node.x, node.y, node.z)) {
        blockPath(agent, mv);
        return;
      }
    }
    setAnim(agent, 'walk');
    if (mv.climbLeft > 0) {
      const used = t < mv.climbLeft ? t : mv.climbLeft;
      mv.climbLeft -= used;
      t -= used;
      if (t <= EPS) return;
    }
    const pos = agent.pos;
    const hx = node.x + 0.5 - pos.x, hz = node.z + 0.5 - pos.z;
    const dist = Math.sqrt(hx * hx + hz * hz);
    if (dist > 1e-6) agent.heading = Math.atan2(hx, hz);
    const step = mv.speed * t;
    if (dist > step) {
      const f = step / dist;
      pos.x += hx * f;
      pos.z += hz * f;
      pos.y += (node.y - pos.y) * f;
      return;
    }
    t -= dist / mv.speed;
    arrive(agent, mv, node, world);
  }
}

/**
 * SPEC-GAP: a path cleared or blocked mid-hop would leave the agent hovering
 * between two cells (possibly half over a ledge). With no path to follow, the
 * body glides back to the centre of its foot cell. Skipped while panicking,
 * because the brain's panic roll owns the body then. Never changes `anim`.
 */
function settle(agent, sim) {
  const pos = agent.pos, c = agent.cell;
  const hx = c.x + 0.5 - pos.x, hz = c.z + 0.5 - pos.z, hy = c.y - pos.y;
  if (hx * hx + hz * hz < 1e-8 && hy * hy < 1e-8) return;
  if (sim.clock && sim.clock.tick < agent.panicUntil) return;
  const dist = Math.sqrt(hx * hx + hz * hz);
  const step = AG.speed * DT;
  if (dist <= step) {
    pos.x = c.x + 0.5; pos.y = c.y; pos.z = c.z + 0.5;
    return;
  }
  const f = step / dist;
  pos.x += hx * f;
  pos.z += hz * f;
  pos.y += hy * f;
}

/** Set up a new hop; returns false when the node cannot be entered. */
function beginNode(agent, mv, node, world) {
  const c = agent.cell;
  mv.path = agent.path;
  mv.nodeI = agent.pathI;
  mv.ox = c.x; mv.oy = c.y; mv.oz = c.z;
  mv.digLeft = -1;
  mv.digMask = 0;
  mv.nodeWv = NaN;
  const dy = node.y - c.y;
  if (Math.abs(node.x - c.x) > MAX_HOP || Math.abs(node.z - c.z) > MAX_HOP || Math.abs(dy) > MAX_HOP) return false;
  mv.climbLeft = Math.abs(dy) * AG.climbSec;
  mv.speed = moveSpeed(agent, node, world);

  let mask = (node.dig | 0) & 7;
  if (mask !== 0) {
    // The floor under a dug node is never itself dug and must hold.
    if (!world.isSolidAt(node.x, node.y - 1, node.z)) return false;
    for (let bit = 1; bit <= 4; bit <<= 1) {
      if ((mask & bit) === 0) continue;
      if (!digCell(bit, node, mv)) { mask &= ~bit; continue; }
      if (world.isPassableAt(DC.x, DC.y, DC.z)) continue;
      if (!pathDiggable(world.get(DC.x, DC.y, DC.z), DC.y)) {
        if (optionalClearance(bit, node, mv)) { mask &= ~bit; continue; }
        return false;
      }
    }
  } else if (!world.isWalkable(node.x, node.y, node.z)) {
    return false;
  }
  mv.digMask = mask;
  return true;
}

/**
 * Resolve the cell for one dig bit into DC (SPEC §C.2 PathNode):
 * 1 = feet cell, 2 = head cell, 4 = extra clearance (origin y+2 stepping up;
 * the destination column at origin y+1 stepping down). Returns false when the
 * bit names no cell (bit 4 on a level hop).
 */
function digCell(bit, node, mv) {
  if (bit === 1) { DC.x = node.x; DC.y = node.y; DC.z = node.z; return true; }
  if (bit === 2) { DC.x = node.x; DC.y = node.y + 1; DC.z = node.z; return true; }
  if (node.y > mv.oy) { DC.x = mv.ox; DC.y = mv.oy + 2; DC.z = mv.oz; return true; }
  if (node.y < mv.oy) { DC.x = node.x; DC.y = mv.oy + 1; DC.z = node.z; return true; }
  return false;
}

/**
 * SPEC-GAP: the step-down clearance cell is described ambiguously in §C.2; if it
 * turns out undiggable the hop is still taken (a harmless visual squeeze) rather
 * than failing a path the pathfinder considered valid.
 */
function optionalClearance(bit, node, mv) {
  return bit === 4 && node.y < mv.oy;
}

function pathDiggable(id, y) {
  if (y < 1 || !AGENT_DIGGABLE[id]) return false;
  const def = BLOCKS[id];
  return !!def && def.hardness < Infinity;
}

/** Dig the node's flagged cells in bit order, spending hardness/skill seconds each. */
function digStep(agent, mv, node, sim, world, t) {
  while (mv.digMask !== 0 && t > EPS) {
    const bit = mv.digMask & -mv.digMask;
    digCell(bit, node, mv);
    const x = DC.x, y = DC.y, z = DC.z;
    if (mv.digLeft < 0) {
      if (world.isPassableAt(x, y, z)) { mv.digMask &= ~bit; continue; }
      const id = world.get(x, y, z);
      if (!pathDiggable(id, y)) {
        if (optionalClearance(bit, node, mv)) { mv.digMask &= ~bit; continue; }
        blockPath(agent, mv);
        return t;
      }
      mv.digLeft = BLOCKS[id].hardness / digSkill(agent);
    }
    setAnim(agent, 'dig');
    const hx = x + 0.5 - agent.pos.x, hz = z + 0.5 - agent.pos.z;
    if (hx * hx + hz * hz > 1e-6) agent.heading = Math.atan2(hx, hz);
    const used = t < mv.digLeft ? t : mv.digLeft;
    mv.digLeft -= used;
    t -= used;
    if (mv.digLeft > EPS) return 0;
    mv.digLeft = -1;
    digBlock(agent, x, y, z, sim);
    if (!world.isPassableAt(x, y, z)) {
      blockPath(agent, mv);
      return t;
    }
    mv.digMask &= ~bit;
  }
  return t;
}

// SPEC-GAP: "hardness/skill" uses the skill of the agent's current profession.
function digSkill(agent) {
  const s = agent.skills ? agent.skills[agent.profession] : 1;
  return s > 0.1 ? s : 0.1;
}

function moveSpeed(agent, node, world) {
  let s = AG.speed;
  const floor = world.get(node.x, node.y - 1, node.z);
  if (floor === B.PATH || floor === B.PAVING) s *= AG.fastFloorMul;
  if (agent.needs.tallow < AG.hungry) s *= AG.hungryMul;
  const cap = carryCap(agent);
  if (cap > 0 && totalItems(agent) / cap > LOADED_FRAC) s *= AG.loadedMul;
  return s > 0.05 ? s : 0.05;
}

function arrive(agent, mv, node, world) {
  const pos = agent.pos, c = agent.cell;
  pos.x = node.x + 0.5; pos.y = node.y; pos.z = node.z + 0.5;
  c.x = node.x; c.y = node.y; c.z = node.z;
  const ff = world.footfall;
  if (ff && node.x >= 0 && node.z >= 0 && node.x < world.SX && node.z < world.SZ) {
    const i = typeof world.columnIndex === 'function' ? world.columnIndex(node.x, node.z) : node.x + world.SX * node.z;
    if (ff[i] < 65535) ff[i]++;
  }
  agent.pathI++;
  mv.nodeI = -1;
}

function blockPath(agent, mv) {
  agent.pathBlocked = true;
  mv.nodeI = -1;
  mv.digMask = 0;
  mv.digLeft = -1;
}

/**
 * Change `anim`, resetting `animT` only when the value actually changes (ADDENDUM §5).
 * @param {Agent} agent
 * @param {string} anim
 */
export function setAnim(agent, anim) {
  if (agent.anim !== anim) {
    agent.anim = anim;
    agent.animT = 0;
  }
}

/**
 * Forget in-progress movement (hop, dig, fall). Population calls this after
 * teleporting an agent.
 * @param {Agent} agent
 */
export function resetMotion(agent) {
  const mv = agent && agent._mv;
  if (!mv) return;
  mv.path = null;
  mv.nodeI = -1;
  mv.digMask = 0;
  mv.digLeft = -1;
  mv.climbLeft = 0;
  mv.nodeWv = NaN;
  mv.falling = false;
  mv.wv = NaN;
  mv.bad = false;
  mv.badT = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Digging
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dig one block (SPEC §C.4 digBlock): refuses unbreakable blocks, sets AIR,
 * rolls the registry yield into the inventory (lost when full) and emits AGENT_DUG.
 * @param {Agent|null} agent
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {object} sim
 * @returns {string|null} the item gained, or null
 */
export function digBlock(agent, x, y, z, sim) {
  const world = sim && sim.world;
  if (!world || y < 1) return null;
  if (typeof world.inBounds === 'function' && !world.inBounds(x, y, z)) return null;
  const id = world.get(x, y, z);
  if (id === B.AIR || id === B.WATER) return null;
  const def = BLOCKS[id];
  if (!def || !(def.hardness < Infinity)) return null;
  world.set(x, y, z, B.AIR);

  let item = null;
  if (def.yields) {
    const chance = id === B.BASALT ? CONFIG.production.basaltStoneChance : (def.yieldChance ?? 1);
    const rolled = chance >= 1 || (chance > 0 && !!sim.rng && sim.rng.next() < chance);
    if (rolled && agent && addItem(agent, def.yields, 1) === 1) item = def.yields;
  }
  if (sim.events) {
    sim.events.emit(EV.AGENT_DUG, { agentId: agent ? agent.id : -1, x, y, z, blockId: id, item });
  }
  return item;
}

/**
 * Leave the dead body as a WAX_PUDDLE in the feet cell when that cell is air
 * over a solid floor (SPEC §C.4 population.kill, §D.9).
 * @param {Agent} agent
 * @param {object} sim
 * @returns {boolean} whether a puddle was placed
 */
export function leavePuddle(agent, sim) {
  const world = sim && sim.world;
  if (!world || !agent || !agent.cell) return false;
  const { x, y, z } = agent.cell;
  if (y < 1 || world.get(x, y, z) !== B.AIR || !world.isSolidAt(x, y - 1, z)) return false;
  return world.set(x, y, z, B.WAX_PUDDLE) !== false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventory helpers (the only writers of agent.inv)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add up to `n` units, limited by free carry capacity (lenses need none).
 * @returns {number} units actually added
 */
export function addItem(agent, item, n = 1) {
  if (!agent || !agent.inv || !ITEM_SET.has(item)) return 0;
  n = Math.floor(n);
  if (!(n > 0)) return 0;
  const add = item === LENS ? n : Math.min(n, freeCapacity(agent));
  if (add > 0) agent.inv[item] = (agent.inv[item] | 0) + add;
  return add > 0 ? add : 0;
}

/**
 * Remove exactly `n` units; nothing is removed when fewer are held.
 * @returns {boolean}
 */
export function removeItem(agent, item, n = 1) {
  if (!agent || !agent.inv || !ITEM_SET.has(item)) return false;
  n = Math.floor(n);
  if (!(n > 0)) return true;
  const have = agent.inv[item] | 0;
  if (have < n) return false;
  agent.inv[item] = have - n;
  return true;
}

/** Units of `item` held. */
export function countItem(agent, item) {
  return (agent && agent.inv && agent.inv[item]) | 0;
}

/** Units of traded goods held (lenses excluded). */
export function totalItems(agent) {
  const inv = agent && agent.inv;
  if (!inv) return 0;
  let n = 0;
  for (let i = 0; i < GOODS.length; i++) n += inv[GOODS[i]] | 0;
  return n;
}

/** Carry capacity of the agent's profession. */
export function carryCap(agent) {
  const info = agent && PROF_INFO[agent.profession];
  return info ? info.carry : 0;
}

/** Remaining carry capacity (never negative). */
export function freeCapacity(agent) {
  const free = carryCap(agent) - totalItems(agent);
  return free > 0 ? free : 0;
}

/** Tallow points held as food: berry·12 + tablet·40. */
export function foodStock(agent) {
  return countItem(agent, 'berry') * CONFIG.goods.berry.tallow
    + countItem(agent, 'tablet') * CONFIG.goods.tablet.tallow;
}

/** True when `good` is one of the 8 traded goods. */
export function isGood(good) {
  return GOOD_SET.has(good);
}

/**
 * Eat one unit: a tablet when tallow ≤ 60, otherwise a berry, falling back to
 * whichever is held.
 * @param {Agent} agent
 * @param {object} [sim]
 * @returns {boolean} whether anything was eaten
 */
export function eat(agent, sim) { // eslint-disable-line no-unused-vars
  if (!agent || !agent.alive || !agent.inv) return false;
  const n = agent.needs;
  let item = n.tallow <= EAT_TABLET_AT ? 'tablet' : 'berry';
  if ((agent.inv[item] | 0) <= 0) item = item === 'tablet' ? 'berry' : 'tablet';
  if (!removeItem(agent, item, 1)) return false;
  const t = n.tallow + CONFIG.goods[item].tallow;
  n.tallow = t > 100 ? 100 : t;
  return true;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
