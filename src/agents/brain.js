/**
 * @file Wickling minds (SPEC §C.4 "G3: brain.js", §D.3 utilities, §D.4 order placement,
 * §D.7 profession review, §D.7b profession plans, ADDENDUM §3–§6).
 *
 * Each agent runs one Task at a time: a list of Steps executed by a small step machine with
 * per-step timeouts, repaths, blacklisting and cooldowns, so nobody stays stuck. When a task
 * ends, `decide()` scores every goal and builds the best feasible plan.
 * Private per-agent state lives in `agent._br`. Sim-side only: no DOM, no three, `sim.rng` only.
 */
import { CONFIG, TICKS, GOODS, PROFESSIONS } from '../core/config.js';
import { EV } from '../core/events.js';
import { B, BLOCKS } from '../world/blocks.js';
import {
  setAnim, eat, addItem, countItem, totalItems, carryCap, freeCapacity, foodStock, digBlock,
} from './agent.js';

const BR = CONFIG.brain;
const AG = CONFIG.agent;
const MC = CONFIG.market;
const MONEY = CONFIG.money;
const PROD = CONFIG.production;
const RECIPES = PROD.recipes;
const PER_SEC = TICKS.PER_SEC;
const PER_HOUR = TICKS.PER_HOUR;

const RUN = 0, DONE = 1, FAIL = 2;
const BUILT_FLOOR = new Set([B.CUT_STONE, B.THATCH, B.LENS_MOUNT, B.KETTLE, B.LANTERN, B.GLASS_WALL, B.CLAN_WALL]);
const TABLET_T = CONFIG.goods.tablet.tallow;
const BERRY_T = CONFIG.goods.berry.tallow;
const K_MINT_DAY = (MONEY.mintPerHour * 24) / Math.PI;        // day-averaged glim per lit tower at η = 1

const ref = g => CONFIG.goods[g]?.ref ?? 1;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const ckey = (x, y, z) => `${x},${y},${z}`;
/** The price level an agent reasons with: its own clan's markets (every plaza in the classic jar). */
const cprice = (sim, agent, g) => (sim.clans?.multi ? sim.clans.clanPrice(agent.clan ?? 0, g) : sim.market.avgPrice(g));
/** With several clans, a filter for land the agent may work (reachable, not an enemy's); else null. */
const landFilter = (sim, agent) => (sim.clans?.multi ? (x, z) => sim.clans.resourceOk(agent, x, z) : null);
// Thoughts, task labels and failure reasons are stored as [key, params] messages (src/core/i18n.js),
// rendered in the player's language by the UI.

/** Per-sim decision budget (decisionsPerTick). */
const decisionBudget = new WeakMap();

function st(agent) {
  let br = agent._br;
  if (!br) {
    br = agent._br = {
      task: null, stepIdx: -1, t: 0, deadline: 0, repaths: 0, stuckT: 0, lastCell: '',
      postTick: -1, posted: 0, intent: null, rebids: 0,
      cool: Object.create(null), urgentCool: 0, roll: null, resKey: null, wakeTick: Infinity,
      builtT: 0, hops: 0,
    };
  }
  return br;
}

// ═════════════════════════════════════════════════════════════════════════════
// Per-tick entry point
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Run one tick of the agent's mind (called by population after stepAgent).
 * @param {object} agent
 * @param {object} sim
 */
export function updateBrain(agent, sim) {
  if (!agent || !agent.alive) return;
  const tick = sim.clock.tick;
  const br = st(agent);

  // 1. Panic: curled up and rolling downhill; nothing else happens.
  if (tick < agent.panicUntil) { panicRoll(agent, sim, br); return; }
  if (br.roll) { br.roll = null; setAnim(agent, 'idle'); }
  // 1b. A fight with a Wickling of an enemy clan (economy/clans.js resolves it).
  if (tick < agent.fightUntil) { fightStep(agent, sim); return; }

  // 2. Reflexes, staggered every 10 ticks.
  if ((tick + agent.id) % 10 === 0) reflexes(agent, sim);

  // 3. Urgent interrupts.
  const task = agent.task;
  if (task && tick >= br.urgentCool) {
    const n = agent.needs;
    if (n.tallow < 15 && task.goal !== 'food' && task.goal !== 'forage' && foodStock(agent) <= 0) {
      br.urgentCool = tick + 30 * PER_SEC;
      interrupt(agent, sim, ['th.starving', { f: n.tallow }]);
    } else if (n.rest < 8 && task.goal !== 'sleep' && task.goal !== 'food' && task.goal !== 'forage') {
      br.urgentCool = tick + 30 * PER_SEC;
      interrupt(agent, sim, ['th.exhausted', { e: n.rest }]);
    }
  }

  // 4. Decide (throttled), else 5. execute.
  if (!agent.task) {
    if (!takeDecision(sim, tick)) { if (!agent.path) setAnim(agent, 'idle'); return; }
    decide(agent, sim);
    if (!agent.task) { setAnim(agent, 'idle'); return; }
  }
  execute(agent, sim, br);
}

function takeDecision(sim, tick) {
  let b = decisionBudget.get(sim);
  if (!b) { b = { tick: -1, n: 0 }; decisionBudget.set(sim, b); }
  if (b.tick !== tick) { b.tick = tick; b.n = 0; }
  if (b.n >= BR.decisionsPerTick) return false;
  b.n++;
  return true;
}

function reflexes(agent, sim) {
  if (!agent.asleep && agent.needs.tallow < AG.eatBelow && foodStock(agent) > 0) eat(agent, sim);
  if (countItem(agent, 'lantern') > 0 && agent.lanterns.length < AG.maxLanterns) sim.production?.lightLantern?.(agent);
  trackRumor(agent, st(agent));
}

/**
 * Disillusionment: when a whisper fades from a Wickling's mind, the belief it inflated (or
 * deflated) is undone by the whisper's own multiplier — the bust half of the bubble.
 * SPEC-GAP: §E.5 decays rumour strength but never unwinds the beliefs it moved, which left
 * prices stranded at bubble levels long after the last believer lapsed.
 */
function trackRumor(agent, br) {
  const r = agent.rumor;
  const alive = r && r.strength >= CONFIG.tools.whisper.minStrength;
  if (alive && br.rumorSince !== r.sinceTick) {
    br.rumorGood = r.good;
    br.rumorDir = r.dir;
    br.rumorSince = r.sinceTick;
    return;
  }
  if (alive || !br.rumorGood) return;
  const g = br.rumorGood;
  const W = CONFIG.tools.whisper;
  const f = br.rumorDir > 0 ? 1 / W.bull : 1 / W.bear;
  const [lo, hi] = MC.beliefClamp;
  agent.beliefs[g] = clamp(agent.beliefs[g] * f, lo * ref(g), hi * ref(g));
  agent.thought = ['th.rumorFalse', { good: g }];
  br.rumorGood = null;
}

/**
 * Cancel whatever the agent is doing (path, bids, tending, sleep, task) and note why.
 * @param {object} agent
 * @param {object} sim
 * @param {Array|string} reason a [key, params] message for `agent.thought`
 */
export function interrupt(agent, sim, reason) {
  if (!agent) return;
  const br = st(agent);
  if (agent.pathTicket != null) { sim?.pathfinder?.cancel?.(agent.pathTicket); agent.pathTicket = null; }
  agent.path = null;
  agent.pathI = 0;
  agent.pathBlocked = false;
  if (agent.openBids > 0 || agent.escrow > 0) sim?.market?.cancelBids?.(agent);
  agent.tending = null;
  agent.asleep = false;
  if (br.resKey) { sim?.production?.unreserve?.(br.resKey, agent.id); br.resKey = null; }
  agent.task = null;
  br.task = null;
  br.stepIdx = -1;
  if (reason) agent.thought = reason;
}

// ═════════════════════════════════════════════════════════════════════════════
// Step machine
// ═════════════════════════════════════════════════════════════════════════════

function mkTask(goal, label, steps, sim) {
  return { goal, steps, i: 0, startedTick: sim.clock.tick, label };
}

function execute(agent, sim, br) {
  const task = agent.task;
  for (let guard = 0; guard < 4; guard++) {
    const step = task.steps[task.i];
    if (!step) { endTask(agent, sim, br); return; }
    if (br.task !== task || br.stepIdx !== task.i) beginStep(agent, sim, br, task, step);
    if (sim.clock.tick > br.deadline) { failTask(agent, sim, br, step, 'slow'); return; }
    const runner = RUNNERS[step.k] || runIdle;
    const res = runner(agent, sim, step, br);
    if (agent.task !== task) return;                 // interrupted from inside a runner
    if (res === RUN) return;
    if (res === FAIL) { failTask(agent, sim, br, step, step.why || 'failed'); return; }
    endStep(agent, sim, br, step);
    task.i++;
    if (task.i >= task.steps.length) { endTask(agent, sim, br); return; }
  }
}

function beginStep(agent, sim, br, task, step) {
  br.task = task;
  br.stepIdx = task.i;
  br.t = 0;
  br.repaths = 0;
  br.stuckT = 0;
  br.lastCell = '';
  br.hops = 0;
  br.deadline = sim.clock.tick + stepBudgetTicks(step);
  if (step.k !== 'goto' && agent.path) { agent.path = null; agent.pathI = 0; }
}

function stepBudgetTicks(step) {
  switch (step.k) {
    case 'goto': return 40 * PER_SEC;                 // until a path arrives; extended then
    case 'sleep': return 16 * PER_HOUR;
    case 'tend': return 5 * PER_HOUR;
    case 'waitChime': return 2.6 * PER_HOUR;
    case 'build': return 90 * PER_SEC;
    case 'wander': return 30 * PER_SEC;
    default: return 60 * PER_SEC;
  }
}

function endStep(agent, sim, br, step) {
  if (step.k === 'sleep') agent.asleep = false;
  if (step.k === 'tend') agent.tending = null;
}

function endTask(agent, sim, br) {
  const step = agent.task?.steps[agent.task.i];
  if (step) endStep(agent, sim, br, step);
  agent.tending = null;
  agent.asleep = false;
  if (br.resKey) { sim.production?.unreserve?.(br.resKey, agent.id); br.resKey = null; }
  agent.task = null;
  br.task = null;
  br.stepIdx = -1;
}

function failTask(agent, sim, br, step, why) {
  const tick = sim.clock.tick;
  if (step.key) agent.blacklist.set(step.key, tick + BR.blacklistHours * PER_HOUR);
  const goal = agent.task?.goal;
  if (goal) br.cool[goal] = tick + (goal === 'work' ? 0.3 : 0.75) * PER_HOUR;
  const label = agent.task?.label || (goal ? [`goal.${goal}`] : ['task.task']);
  if (agent.pathTicket != null) { sim.pathfinder?.cancel?.(agent.pathTicket); agent.pathTicket = null; }
  agent.path = null;
  agent.pathI = 0;
  agent.pathBlocked = false;
  if (agent.openBids > 0) sim.market?.cancelBids?.(agent);
  endTask(agent, sim, br);
  agent.thought = ['th.gaveUp', { task: label, why }];
}

function isBlacklisted(agent, key, tick) {
  const until = agent.blacklist.get(key);
  if (until == null) return false;
  if (until <= tick) { agent.blacklist.delete(key); return false; }
  return true;
}

/** Count `br.t` up to `secs` sim-seconds; true when done. */
function timer(br, secs) {
  br.t++;
  return br.t >= Math.max(1, Math.round(secs * PER_SEC));
}

function face(agent, x, z) {
  const hx = x + 0.5 - agent.pos.x, hz = z + 0.5 - agent.pos.z;
  if (hx * hx + hz * hz > 1e-6) agent.heading = Math.atan2(hx, hz);
}

function near(agent, x, y, z, r = 1, dyMax = 2) {
  const c = agent.cell;
  return Math.max(Math.abs(c.x - x), Math.abs(c.z - z)) <= r && Math.abs(c.y - y) <= dyMax;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runners
// ─────────────────────────────────────────────────────────────────────────────

const RUNNERS = {
  goto: runGoto,
  dig: runDig,
  harvest: runHarvest,
  plant: runPlant,
  fell: runFell,
  craft: runCraft,
  trade: runTrade,
  waitChime: runWaitChime,
  sleep: runSleep,
  tend: runTend,
  installLens: runInstallLens,
  deliver: runDeliver,
  build: runBuild,
  eat: runEat,
  wander: runWander,
  idle: runIdle,
  scrape: runScrape,
};

function requestPath(agent, sim, s) {
  const pf = sim.pathfinder;
  if (!pf) return;
  const pen = CONFIG.path.digPenalty;
  agent.pathTicket = pf.request(agent.cell, s.goal, {
    allowDig: !!s.dig,
    digPenalty: pen[agent.profession] ?? pen.default,
  });
}

function repath(agent, sim, s, br, why) {
  br.repaths++;
  agent.path = null;
  agent.pathI = 0;
  agent.pathBlocked = false;
  if (br.repaths > AG.maxRepaths) { s.why = why; return FAIL; }
  requestPath(agent, sim, s);
  br.deadline = Math.max(br.deadline, sim.clock.tick + 40 * PER_SEC);
  return RUN;
}

function runGoto(agent, sim, s, br) {
  const tick = sim.clock.tick;
  if (agent.path) {
    if (agent.pathI >= agent.path.length) { agent.path = null; agent.pathI = 0; return DONE; }
    if (agent.pathBlocked) return repath(agent, sim, s, br, 'blocked');
    const key = ckey(agent.cell.x, agent.cell.y, agent.cell.z);
    if (key !== br.lastCell) { br.lastCell = key; br.stuckT = 0; }
    else if (agent.anim !== 'dig' && agent.anim !== 'fall' && ++br.stuckT > AG.stuckSec * PER_SEC) {
      return repath(agent, sim, s, br, 'stuck');
    }
    return RUN;
  }
  if (agent.pathTicket == null) { requestPath(agent, sim, s); return RUN; }
  const res = sim.pathfinder.poll(agent.pathTicket);
  if (res === null) return RUN;
  agent.pathTicket = null;
  if (res.ok) {
    if (!res.path.length) return DONE;
    agent.path = res.path;
    agent.pathI = 0;
    agent.pathBlocked = false;
    br.lastCell = '';
    br.stuckT = 0;
    let digs = 0;
    for (const n of res.path) if (n.dig) digs += (n.dig & 1 ? 1 : 0) + (n.dig & 2 ? 1 : 0) + (n.dig & 4 ? 1 : 0);
    const secs = (3 * res.path.length) / AG.speed + 10 + digs * 5;
    br.deadline = tick + Math.ceil(secs * PER_SEC);
    return RUN;
  }
  // A dig search that ran out of nodes is final: retrying it (a Deep Pane makes them all fail)
  // only burns the path budget for everyone else.
  if (res.reason === 'budget' && !s.dig && br.repaths < AG.maxRepaths + 2) {
    br.repaths++;
    requestPath(agent, sim, s);
    return RUN;
  }
  // A Wickling walled in (a fresh tunnel, a pit, a flooded or sealed-off hollow) digs its way out.
  // From open ground an unreachable target is simply given up (and blacklisted): a Glass Pane
  // divides the jar for all but porters, and doomed dig searches are the costliest kind.
  if (res.reason === 'unreachable' && !s.dig && !s.triedDig && isUnderground(agent, sim)) {
    s.dig = true;
    s.triedDig = true;
    requestPath(agent, sim, s);
    return RUN;
  }
  if (s.market != null && (res.reason === 'unreachable' || (s.dig && res.reason === 'budget'))) {
    agent.marketBlockedUntil[s.market] = tick + 4 * PER_HOUR;
  }
  // Stranded on top of something built (a wall, a roof, a tower): set down on the ground.
  const c = agent.cell;
  if (BUILT_FLOOR.has(sim.world.get(c.x, c.y - 1, c.z))) sim.population?.relocate?.(agent);
  s.why = res.reason === 'unreachable' ? 'noWay' : res.reason === 'badStart' ? 'footing' : 'lost';
  return FAIL;
}

/** Walled in: below the open surface (a tunnel) or cut off from every plaza (a pit, a flooded hollow). */
function isUnderground(agent, sim) {
  const c = agent.cell;
  if (c.y < sim.world.surfaceY(c.x, c.z) - 1) return true;
  const pf = sim.pathfinder;
  const markets = sim.worldInfo?.markets || [];
  return markets.length > 0 && !markets.some(mk => pf.sameRegion(c, mk.center));
}

function runDig(agent, sim, s, br) {
  const w = sim.world;
  if (w.get(s.x, s.y, s.z) !== s.expect) return DONE;          // someone else took it
  if (!near(agent, s.x, s.y, s.z, 2, 3)) { s.why = 'reach'; return FAIL; }
  setAnim(agent, 'dig');
  face(agent, s.x, s.z);
  const skill = Math.max(0.1, agent.skills[agent.profession] ?? 1);
  if (!timer(br, (BLOCKS[s.expect]?.hardness ?? 2) / skill)) return RUN;
  digBlock(agent, s.x, s.y, s.z, sim);
  return DONE;
}

function runHarvest(agent, sim, s, br) {
  if (sim.world.get(s.x, s.y, s.z) !== B.BUSH_RIPE) return DONE;
  if (!near(agent, s.x, s.y, s.z, 1, 2)) { s.why = 'reach'; return FAIL; }
  setAnim(agent, 'harvest');
  face(agent, s.x, s.z);
  if (!timer(br, AG.act.harvest)) return RUN;
  const qty = sim.production.harvestBush(s.x, s.y, s.z, agent);
  if (s.forage && qty > 0) sim.ledger?.stabilizer?.('forage', qty, ['stab.forageOne']);
  return DONE;
}

function runPlant(agent, sim, s, br) {
  if (!near(agent, s.x, s.y, s.z, 1, 2)) { s.why = 'reach'; return FAIL; }
  setAnim(agent, 'harvest');
  face(agent, s.x, s.z);
  if (!timer(br, AG.act.plant)) return RUN;
  if (!sim.production.plantBush(s.x, s.y, s.z, agent)) { s.why = 'ground'; return FAIL; }
  return DONE;
}

function runFell(agent, sim, s, br) {
  if (sim.world.get(s.x, s.y, s.z) !== B.LOG) return DONE;
  if (!near(agent, s.x, s.y, s.z, 1, 2)) { s.why = 'reach'; return FAIL; }
  setAnim(agent, 'dig');
  face(agent, s.x, s.z);
  const skill = Math.max(0.1, agent.skills.woodwarden ?? 1);
  if (!timer(br, (AG.act.fellPerLog * s.height) / skill)) return RUN;
  sim.production.fellTree(s.treeId, agent);
  return DONE;
}

function runCraft(agent, sim, s, br) {
  if (s.station && !near(agent, s.station.x, s.station.y, s.station.z, 2, 3)) { s.why = 'station'; return FAIL; }
  const r = RECIPES[s.recipe];
  if (!r) return DONE;
  setAnim(agent, 'craft');
  if (s.station) face(agent, s.station.x, s.station.z);
  if (!timer(br, r.sec)) return RUN;
  br.t = 0;
  if (!sim.production.craft(agent, s.recipe)) return DONE;
  s.times = (s.times ?? 1) - 1;
  return s.times > 0 ? RUN : DONE;
}

function runInstallLens(agent, sim, s, br) {
  const t = sim.production.towerOf(agent.id);
  if (!t || t.id !== s.towerId) { s.why = 'towerLost'; return FAIL; }
  if (t.lensQ > 0) return DONE;
  setAnim(agent, 'craft');
  face(agent, t.base.x, t.base.z);
  if (!timer(br, AG.act.installLens)) return RUN;
  return sim.production.installLens(t, agent) ? DONE : FAIL;
}

function runTend(agent, sim, s, br) {
  const prod = sim.production;
  const t = prod.towerOf(agent.id);
  if (!t || t.id !== s.towerId) return DONE;
  if (!near(agent, t.stand.x, t.stand.y, t.stand.z, 1, 1)) { s.why = 'stand'; return FAIL; }
  const clock = sim.clock;
  if (t.lensQ <= 0 || prod.isEclipsed(t.base) || (clock.sun <= 0 && clock.hourFloat >= 12)) return DONE;
  agent.tending = t.id;
  setAnim(agent, 'tend');
  face(agent, t.base.x, t.base.z);
  if (br.t++ > 4 * PER_HOUR) return DONE;                         // re-decide now and then (food, sleep)
  return RUN;
}

function runSleep(agent, sim, s, br) {
  const clock = sim.clock;
  if (br.t === 0) {
    agent.asleep = true;
    br.wakeTick = clock.isNight
      ? clock.tick + (((6 * PER_HOUR - (clock.tick % TICKS.PER_DAY)) + TICKS.PER_DAY) % TICKS.PER_DAY || TICKS.PER_DAY)
      : Infinity;
  }
  br.t++;
  agent.asleep = true;
  setAnim(agent, 'sleep');
  const n = agent.needs;
  if (n.rest >= 95 || clock.tick >= br.wakeTick || (n.tallow < 10 && foodStock(agent) <= 0)) {
    agent.asleep = false;
    return DONE;
  }
  return RUN;
}

function runDeliver(agent, sim, s) {
  const p = projectById(sim, s.projectId);
  if (!p) { s.why = 'projectGone'; return FAIL; }
  sim.production.deliver(p, agent);
  setAnim(agent, 'build');
  return DONE;
}

function runBuild(agent, sim, s, br) {
  const prod = sim.production;
  const p = projectById(sim, s.projectId);
  if (!p) return DONE;
  const b = prod.nextBuildBlock(p);
  if (!b || !prod.canBuild(p)) return DONE;
  if (!near(agent, b.x, b.y, b.z, AG.reach + 1, AG.reach + 1)) { s.why = 'site'; return FAIL; }
  setAnim(agent, 'build');
  face(agent, b.x, b.z);
  const skill = Math.max(0.1, agent.skills.mason ?? 1);
  if (!timer(br, AG.act.build / skill)) return RUN;
  br.t = 0;
  br.deadline = sim.clock.tick + 60 * PER_SEC;
  const ok = prod.buildNext(p, agent);
  if (!ok) return DONE;
  if (p.placed >= p.blocks.length || p.status === 'done') {
    agent.thought = p.kind === 'tower' ? ['th.builtTower'] : ['th.builtHouse'];
    return DONE;
  }
  return RUN;
}

function runEat(agent, sim, s, br) {
  setAnim(agent, 'eat');
  if (!timer(br, AG.act.eat)) return RUN;
  eat(agent, sim);
  return DONE;
}

function runScrape(agent, sim, s, br) {
  if (sim.world.get(s.x, s.y, s.z) !== B.WAX_PUDDLE) return DONE;
  if (!near(agent, s.x, s.y, s.z, 1, 2)) { s.why = 'reach'; return FAIL; }
  setAnim(agent, 'dig');
  face(agent, s.x, s.z);
  if (!timer(br, AG.act.scrape)) return RUN;
  digBlock(agent, s.x, s.y, s.z, sim);
  addItem(agent, 'tablet', PROD.puddleTablets);
  agent.thought = ['th.scraped', { n: PROD.puddleTablets }];
  return DONE;
}

function runIdle(agent, sim, s, br) {
  setAnim(agent, s.anim || 'idle');
  return timer(br, s.secs ?? 3) ? DONE : RUN;
}

/** Random walk of a few single-cell hops (no pathfinder cost), optionally tethered to a centre. */
function runWander(agent, sim, s, br) {
  if (agent.path) {
    if (agent.pathI < agent.path.length && !agent.pathBlocked) return RUN;
    agent.path = null;
    agent.pathI = 0;
    agent.pathBlocked = false;
    br.hops++;
  }
  if (br.hops >= (s.hops ?? 4)) return DONE;
  if (!hop(agent, sim, s.center, s.r ?? 4)) {
    setAnim(agent, s.anim || 'idle');
    return timer(br, 2) ? DONE : RUN;
  }
  return RUN;
}

/** Start a single-cell hop to a random legal neighbour (within r of center if given). */
function hop(agent, sim, center, r) {
  const w = sim.world, c = agent.cell, rng = sim.rng;
  const start = rng.int(0, 3);
  for (let k = 0; k < 4; k++) {
    const d = (start + k) & 3;
    const nx = c.x + (d === 0 ? 1 : d === 1 ? -1 : 0), nz = c.z + (d === 2 ? 1 : d === 3 ? -1 : 0);
    if (center && Math.max(Math.abs(nx - center.x), Math.abs(nz - center.z)) > r) continue;
    for (let dy = 0; dy >= -1; dy--) {
      const ny = c.y + dy;
      if (!w.isWalkable(nx, ny, nz)) continue;
      if (dy === -1 && !w.isPassableAt(nx, c.y + 1, nz)) continue;
      agent.path = [{ x: nx, y: ny, z: nz, dig: 0 }];
      agent.pathI = 0;
      agent.pathBlocked = false;
      return true;
    }
    if (w.isWalkable(nx, c.y + 1, nz) && w.isPassableAt(c.x, c.y + 2, c.z)) {
      agent.path = [{ x: nx, y: c.y + 1, z: nz, dig: 0 }];
      agent.pathI = 0;
      agent.pathBlocked = false;
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trading at the plaza (§D.4)
// ─────────────────────────────────────────────────────────────────────────────

function runTrade(agent, sim, s, br) {
  const market = sim.market;
  const m = s.m;
  if (!market.isAtPlaza(agent, m)) { s.why = 'plaza'; return FAIL; }
  setAnim(agent, 'trade');

  // Beliefs drift toward the posted price on arrival.
  const vp = MC.visitPull;
  for (const g of GOODS) agent.beliefs[g] += vp * (market.price(m, g) - agent.beliefs[g]);

  const consigned = consignSurplus(agent, sim, m, s);
  if (s.intent === 'sell' && consigned === 0) {
    // My lots here are full and unsold: stop hauling more until they move.
    br.cool.sell = sim.clock.tick + 2 * PER_HOUR;
    br.saturatedUntil = sim.clock.tick + 2 * PER_HOUR;
    agent.thought = ['th.stallFull', { m }];
  }
  br.intent = s;
  br.posted = placeBids(agent, sim, m, s);
  br.postTick = sim.clock.tick;
  return DONE;
}

function runWaitChime(agent, sim, s, br) {
  const tick = sim.clock.tick;
  if (agent.openBids <= 0 || br.posted <= 0) {
    if (br.posted > 0 && agent.chimeResult && agent.chimeResult.tick >= br.postTick) afterChime(agent, sim, br);
    br.posted = 0;
    return DONE;
  }
  if (!sim.market.isAtPlaza(agent, s.m)) {                        // wandered or was carried off
    sim.market.cancelBids(agent);
    br.posted = 0;
    return DONE;
  }
  // Mill about the plaza while waiting for the bell.
  if (agent.path) {
    if (agent.pathI >= agent.path.length || agent.pathBlocked) { agent.path = null; agent.pathI = 0; agent.pathBlocked = false; }
  } else if ((tick + agent.id * 7) % 25 === 0 && sim.rng.next() < 0.5) {
    hop(agent, sim, sim.worldInfo.markets[s.m].center, 3);
  }
  if (!agent.path) setAnim(agent, 'trade');
  return RUN;
}

/** Post-Chime bookkeeping: speculation / porter cargo, and food re-bids. */
function afterChime(agent, sim, br) {
  const s = br.intent;
  const cr = agent.chimeResult;
  if (!s || !cr) return;
  const bought = cr.bought || {};
  if (s.intent === 'speculate' && bought[s.good] > 0) {
    const q = bought[s.good];
    const prev = agent.spec && agent.spec.good === s.good ? agent.spec : { good: s.good, qty: 0, cost: 0 };
    agent.spec = { good: s.good, qty: prev.qty + q, cost: (prev.cost * prev.qty + (cr.spent || 0)) / (prev.qty + q) };
    agent.thought = ['th.hoarded', { n: q, good: s.good }];
  }
  if (s.intent === 'porterBuy' && bought[s.good] > 0) {
    const q = countItem(agent, s.good);
    agent.porter = { good: s.good, from: s.m, to: s.to, qty: q, cost: (cr.spent || 0) / Math.max(1, bought[s.good]) };
    agent.thought = ['th.loaded', { n: q, good: s.good, m: s.to }];
  }
  if (s.intent === 'food') {
    const unfilled = cr.unfilled || {};
    const short = (unfilled.berry || 0) + (unfilled.tablet || 0);
    const task = agent.task;
    if (short > 0 && br.rebids < MC.maxRebids && foodStock(agent) < foodTarget(agent) && task) {
      br.rebids++;
      const m2 = foodMarket(agent, sim);
      if (m2 !== s.m) {
        task.steps.splice(task.i + 1, 0, gotoMarket(sim, m2), { k: 'trade', m: m2, intent: 'food' }, { k: 'waitChime', m: m2 });
        agent.thought = ['th.noFoodTry', { m: s.m, m2 }];
      } else {
        task.steps.splice(task.i + 1, 0, { k: 'trade', m: s.m, intent: 'food' }, { k: 'waitChime', m: s.m });
        agent.thought = ['th.outbid', { n: br.rebids, max: MC.maxRebids }];
      }
    }
  }
}

function foodTarget(agent) {
  return AG.foodTarget * (1 + (agent.fright || 0));
}

/** Units of `g` the agent keeps back from sale (§D.4 reserved goods). */
function reservedQty(agent, sim, g, atMarket) {
  const inv = agent.inv;
  let keep = 0;
  // Food up to the food target (tablets first).
  if (g === 'tablet' || g === 'berry') {
    const target = foodTarget(agent);
    const tabKeep = Math.min(inv.tablet | 0, Math.ceil(target / TABLET_T));
    if (g === 'tablet') keep = tabKeep;
    else keep = Math.min(inv.berry | 0, Math.max(0, Math.ceil((target - tabKeep * TABLET_T) / BERRY_T)));
  }
  switch (agent.profession) {
    case 'chandler':
      if (chandlerWantsLanterns(sim, agent)) {
        if (g === 'amber' || g === 'quartz') keep = Math.min(inv[g] | 0, 1);
        if (g === 'tablet') keep = Math.max(keep, Math.min(inv.tablet | 0, 1));
      } else {
        if (g === 'berry') keep = Math.max(keep, Math.min(inv.berry | 0, 3));
        if (g === 'peat') keep = Math.min(inv.peat | 0, 1);
      }
      break;
    case 'lenswright':
      if (g === 'quartz') keep = Math.min(inv.quartz | 0, 2);
      break;
    case 'mason': {
      if (g === 'stone' || g === 'log') {
        const p = agent.projectId != null ? projectById(sim, agent.projectId) : null;
        if (p) keep = Math.min(inv[g] | 0, sim.production.missingMaterials(p)[g] || 0);
      }
      break;
    }
    case 'porter':
      if (agent.porter && agent.porter.good === g && atMarket !== agent.porter.to) keep = inv[g] | 0;
      break;
    default:
  }
  if (agent.spec && agent.spec.good === g) keep = Math.max(keep, Math.min(inv[g] | 0, agent.spec.qty));
  // A bull believer will not sell what the whisper says is about to rise — except staple wax,
  // whose withholding starved the jar (food rumours act through speculative buying instead).
  if (agent.rumor && agent.rumor.dir > 0 && agent.rumor.good === g && agent.rumor.strength > 0.15
    && g !== 'berry' && g !== 'tablet') keep = inv[g] | 0;
  return keep;
}

/** Consign every unreserved unit (§D.4). @returns {number} units consigned */
function consignSurplus(agent, sim, m, s) {
  const market = sim.market;
  const cap = Math.max(1, carryCap(agent));
  let total = 0;
  for (const g of GOODS) {
    const held = agent.inv[g] | 0;
    if (held <= 0) continue;
    const isDump = s.intent === 'dump' && g === s.good;
    const isCargo = agent.porter && agent.porter.good === g && m === agent.porter.to;
    const qty = isDump ? held : held - reservedQty(agent, sim, g, m);
    if (qty <= 0) continue;
    const b = agent.beliefs[g];
    const P = market.price(m, g);
    let ask, floor;
    if (isDump) {
      ask = 0.9 * P; floor = 0;
    } else if (isCargo) {
      floor = 1.02 * agent.porter.cost;
      ask = Math.max(0.98 * P, floor);
    } else {
      if (g === 'berry') floor = 0;
      else if (g === 'tablet' || g === 'lantern') floor = MC.craftFloorFrac * (agent.costBasis[g] || 0);
      else floor = MC.rawFloorFrac * b;
      ask = Math.max(floor, b * (MC.askMarkup - MC.askSurplusCut * (qty / cap)));
    }
    if (!(ask > 0)) ask = Math.max(0.01, 0.5 * ref(g));
    const before = agent.inv[g] | 0;
    market.consign(agent, m, g, qty, ask, floor);
    total += before - (agent.inv[g] | 0);
    if (isCargo) agent.porter = null;
    if (isDump || (agent.spec && agent.spec.good === g && (agent.inv[g] | 0) === 0)) agent.spec = null;
  }
  return total;
}

/** Post the bids for this visit. Returns the number of bids posted. */
function placeBids(agent, sim, m, s) {
  const market = sim.market;
  let posted = 0;
  const post = (good, qty, limit, purpose) => {
    const room = freeCapacity(agent) - market.pendingBidQty(agent);
    let q = Math.min(Math.floor(qty), room, Math.floor(agent.glim / limit));
    if (q < 1 || !(limit > 0)) return 0;
    if (market.postBid(agent, m, good, q, limit, purpose)) { posted++; return q; }
    return 0;
  };
  const t = agent.needs.tallow / 100;
  const fright = agent.fright || 0;

  switch (s.intent) {
    case 'food': {
      const target = foodTarget(agent);
      const stock = foodStock(agent);
      if (stock >= target) break;
      const good = cheaperFood(agent, sim, m);
      const b = agent.beliefs[good];
      const limit = b * (1 + MC.urgencyGain * (1 - t)) * (1 + MC.frightGain * fright);
      const per = CONFIG.goods[good].tallow;
      const need = Math.ceil((target - stock) / per);
      const frac = agent.needs.tallow < 25 ? MC.starvingCashFrac : MC.bidCashFrac;
      let qty = Math.min(need, Math.floor((frac * agent.glim) / limit));
      if (qty < 1 && agent.glim >= limit) qty = 1;
      post(good, qty, limit, 'food');
      break;
    }
    case 'lantern': {
      const b = agent.beliefs.lantern;
      const limit = b * (1 + MC.urgencyGain * (1 - agent.needs.lustre / 100));
      post('lantern', 1, limit, 'luxury');
      break;
    }
    case 'input':
      // Recomputed here: beliefs were just pulled toward this plaza's prices.
      for (const [good, qty, limit] of inputBids(agent, sim)) post(good, qty, limit, 'input');
      break;
    case 'speculate': {
      const g = s.good;
      const limit = agent.beliefs[g];
      const qty = Math.floor((BR_HOARD() * agent.glim) / limit);
      post(g, Math.min(qty, carryCap(agent) - (agent.inv[g] | 0)), limit, 'speculate');
      break;
    }
    case 'porterBuy': {
      const Pa = market.price(m, s.good), Pb = market.price(s.to, s.good);
      const limit = Math.min(1.05 * Pa, 0.85 * (1 - MC.fee) * Pb);
      post(s.good, carryCap(agent), limit, 'arbitrage');
      break;
    }
    default:
  }
  return posted;
}

const BR_HOARD = () => CONFIG.tools.whisper.hoardFraction;

/** Units of `good` offered on plaza m's pads. */
function offered(sim, m, good) {
  const lots = sim.market.getBook(m, good).lots;
  let q = 0;
  for (let i = 0; i < lots.length; i++) q += lots[i].qty;
  return q;
}

/**
 * The plaza a hungry Wickling heads for: the cheapest tallow among plazas with food on the pads
 * (a short walk is worth it when the near plaza is bare), else the nearest.
 * SPEC-GAP: §D.3 says "nearest market"; an empty nearest plaza starved whole districts.
 */
function foodMarket(agent, sim) {
  const near = sim.market.nearestMarket(agent);
  const bulk = BR.berryBulk ?? 1.3;
  let best = -1, bestCost = Infinity;
  for (const mk of sim.worldInfo.markets) {
    const m = mk.id;
    if (!marketUsable(agent, sim, m)) continue;
    const dist = Math.hypot(mk.center.x - agent.pos.x, mk.center.z - agent.pos.z);
    for (const g of ['berry', 'tablet']) {
      if (offered(sim, m, g) <= 0) continue;
      const perTallow = (sim.market.price(m, g) * (g === 'berry' ? bulk : 1)) / CONFIG.goods[g].tallow;
      const cost = perTallow * (1 + dist / 120) * (m === near ? 1 : 1.1);
      if (cost < bestCost) { bestCost = cost; best = m; }
    }
  }
  return best >= 0 ? best : near;
}

function cheaperFood(agent, sim, m) {
  const b = agent.beliefs;
  const r = agent.rumor;
  const bearOn = g => r && r.dir < 0 && r.good === g && agent.needs.tallow >= 25;
  // Berries are bulky (12 tallow per carry slot vs 40) and spoil fast, so they carry a premium.
  // SPEC-GAP: new config key brain.berryBulk (default 1.3).
  const bulk = BR.berryBulk ?? 1.3;
  let good = (bulk * b.berry) / BERRY_T <= b.tablet / TABLET_T ? 'berry' : 'tablet';
  // Bid for what is actually on the pads when only one kind is.
  const other = good === 'berry' ? 'tablet' : 'berry';
  if (offered(sim, m, good) <= 0 && offered(sim, m, other) > 0) good = other;
  if (bearOn(good)) good = good === 'berry' ? 'tablet' : 'berry';     // bears delay buying
  // A sealed-out good at this plaza is skipped when the other is available.
  const seal = sim.market.activeSeal(m, good);
  if (seal && seal.kind === 'floor' && seal.price > b[good] * 1.5) good = good === 'berry' ? 'tablet' : 'berry';
  return good;
}

// ═════════════════════════════════════════════════════════════════════════════
// decide(): goal utilities (§D.3) → plan
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Score every goal, keep the top 3 in `agent.utilities`, and adopt the best feasible plan.
 * @param {object} agent
 * @param {object} sim
 */
export function decide(agent, sim) {
  const br = st(agent);
  const tick = sim.clock.tick;
  const clock = sim.clock;
  const n = agent.needs;
  const t = n.tallow / 100, r = n.rest / 100, l = n.lustre / 100;
  const lambda = clamp(BR.lambdaK / (agent.glim + BR.lambdaOff), 0.4, 2.5);
  const market = sim.market;
  const m = market.nearestMarket(agent);
  const blockedAll = allMarketsBlocked(agent, sim, tick);
  const cap = Math.max(1, carryCap(agent));
  const night = clock.isNight;

  const scores = [];
  const add = (goal, u) => {
    if (!Number.isFinite(u)) return;
    if (br.cool[goal] > tick) u -= 1;
    if (goal === agent.goal) u += BR.hysteresis;
    scores.push({ goal, score: u });
  };

  // sleep — but a starving Wickling eats first: runSleep would wake it for hunger at once, and
  // "exhausted beats hungry" otherwise loops sleep→wake→sleep until it gutters out.
  const stock = foodStock(agent);
  const starving = n.tallow < 10 && stock <= 0;
  let uSleep = BR.wSleep * (1 - r) ** 2 + (night ? BR.nightSleep : 0);
  if (r > 0.9) uSleep = -1;
  if (n.rest < 8 && !starving) uSleep += 10;
  add('sleep', uSleep);

  // food / forage
  const target = foodTarget(agent);
  if (stock < target) {
    const uFood = BR.wFood * (1 - t) ** 2 + BR.foodStockW * (1 - stock / target)
      + (starving ? 12 : n.tallow < 15 ? 2 : 0);
    const anyMarket = anyMarketUsable(agent, sim);
    const canBuy = anyMarket && agent.glim >= BR.forageCashMul * market.price(m, 'berry');
    add(canBuy ? 'food' : 'forage', uFood);
  }

  // work (the clan's own Guild Board)
  const clan = agent.clan ?? 0;
  const guild = sim.ledger?.guild?.(clan) || {};
  const meanY = Math.max(1, sim.ledger?.meanY?.(clan) || 1);
  const prof = agent.profession;
  const yHat = (guild[prof]?.blended ?? sim.production.estimateIncome(prof, clan)) * (agent.skills[prof] ?? 1);
  const feasible = workFeasible(agent, sim);
  add('work', BR.workBase + BR.workGain * lambda * clamp(yHat / meanY, 0, 2)
    - (night ? BR.nightWork : 0) - (feasible ? 0 : BR.noJobPenalty));

  // lantern
  const pLantern = market.price(m, 'lantern');
  if (!blockedAll && agent.glim > BR.lanternCashMul * pLantern && agent.lanterns.length + countItem(agent, 'lantern') < AG.maxLanterns
    && (agent.fright || 0) < 0.3) {
    add('lantern', BR.wLantern * (1 - l) ** 2 + BR.lanternBase);
  }

  // rumours: speculate / dump
  const rum = agent.rumor;
  if (!blockedAll && rum && rum.dir > 0 && agent.glim > 25 && (agent.inv[rum.good] | 0) < cap / 2) {
    add('speculate', BR.speculateBase + BR.speculateGain * rum.strength);
  }
  const bearHold = rum && rum.dir < 0 && (agent.inv[rum.good] | 0) > reservedQty(agent, sim, rum.good, -1);
  const lapsedSpec = agent.spec && (agent.inv[agent.spec.good] | 0) > 0
    && (!rum || rum.good !== agent.spec.good || rum.dir < 0);
  if (!blockedAll && (bearHold || lapsedSpec)) add('dump', BR.dump);
  if (agent.spec && (agent.inv[agent.spec.good] | 0) === 0) agent.spec = null;

  // sell
  if (!blockedAll && sellableUnits(agent, sim) >= 0.7 * cap) add('sell', BR.sell);

  add('idle', BR.idle);

  scores.sort((a, b) => b.score - a.score);
  agent.utilities = scores.slice(0, 3).map(s => ({ goal: s.goal, score: +s.score.toFixed(3) }));

  br.rebids = 0;
  for (const s of scores) {
    // No reachable market for wax: forage instead of falling through to other goals.
    const task = buildPlan(s.goal, agent, sim, { m, lambda }) || (s.goal === 'food' ? planForage(agent, sim) : null);
    if (task) {
      agent.task = task;
      agent.goal = s.goal;
      return;
    }
  }
  agent.task = mkTask('idle', ['task.loiter'], [{ k: 'idle', secs: 3 }], sim);
  agent.goal = 'idle';
}

function sellableUnits(agent, sim) {
  let n = 0;
  for (const g of GOODS) n += Math.max(0, (agent.inv[g] | 0) - reservedQty(agent, sim, g, -1));
  return n;
}

function buildPlan(goal, agent, sim, ctx) {
  switch (goal) {
    case 'sleep': return planSleep(agent, sim);
    case 'food': return planFood(agent, sim, foodMarket(agent, sim));
    case 'forage': return planForage(agent, sim);
    case 'work': return planWork(agent, sim);
    case 'lantern': return planLantern(agent, sim, ctx.m);
    case 'speculate': return planSpeculate(agent, sim, ctx.m);
    case 'dump': return planDump(agent, sim, ctx.m);
    case 'sell': return planSell(agent, sim, ctx.m);
    case 'idle': return planIdle(agent, sim);
    default: return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plans for the non-work goals
// ─────────────────────────────────────────────────────────────────────────────

function gotoMarket(sim, m, dig = false) {
  const c = sim.worldInfo.markets[m].center;
  return { k: 'goto', goal: { x: c.x, y: c.y, z: c.z, radius: 3 }, market: m, key: `market:${m}`, dig };
}

function marketUsable(agent, sim, m) {
  return !(agent.marketBlockedUntil[m] > sim.clock.tick) && !isBlacklisted(agent, `market:${m}`, sim.clock.tick)
    && (!sim.clans || sim.clans.marketOpen(agent, m));
}

/** Every market open to the agent is marked unreachable for now. */
function allMarketsBlocked(agent, sim, tick) {
  const n = sim.market.markets.length;
  for (let k = 0; k < n; k++) {
    if (!(agent.marketBlockedUntil[k] > tick) && (!sim.clans || sim.clans.marketOpen(agent, k))) return false;
  }
  return true;
}

function anyMarketUsable(agent, sim) {
  const n = sim.market.markets.length;
  for (let k = 0; k < n; k++) if (marketUsable(agent, sim, k)) return true;
  return false;
}

/** The nearest usable market other than `except`, or -1. */
function otherUsableMarket(agent, sim, except) {
  let best = -1, bestD = Infinity;
  const markets = sim.worldInfo.markets;
  for (let k = 0; k < markets.length; k++) {
    if (k === except || !marketUsable(agent, sim, k)) continue;
    const c = markets[k].center;
    const d = (c.x - agent.pos.x) ** 2 + (c.z - agent.pos.z) ** 2;
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

function tradeTrip(agent, sim, m, intent, extra = {}) {
  if (!marketUsable(agent, sim, m)) {
    const other = otherUsableMarket(agent, sim, m);
    if (other < 0) return null;
    m = other;
  }
  return [
    gotoMarket(sim, m, !!extra.dig),
    { k: 'trade', m, intent, ...extra },
    { k: 'waitChime', m },
  ];
}

function planSleep(agent, sim) {
  let home = agent.homeId != null ? sim.production.houseOf(agent.id) : null;
  // A bed across a Glass Pane (or behind a blocked door) is no bed tonight: sleep rough instead.
  if (home && (isBlacklisted(agent, `bed:${home.id}`, sim.clock.tick)
    || !sim.pathfinder.sameRegion(agent.cell, home.approach || home.bed))) home = null;
  const steps = [];
  if (home && home.bed) {
    steps.push({ k: 'goto', goal: { x: home.bed.x, y: home.bed.y, z: home.bed.z, radius: 1 }, key: `bed:${home.id}` });
    agent.thought = ['th.sleepHome', { e: agent.needs.rest }];
  } else {
    agent.thought = ['th.sleepRough', { e: agent.needs.rest }];
  }
  steps.push({ k: 'sleep' });
  return mkTask('sleep', home ? ['task.sleepHome'] : ['task.sleepRough'], steps, sim);
}

function planFood(agent, sim, m) {
  const steps = tradeTrip(agent, sim, m, 'food');
  if (!steps) return null;
  const mm = steps[1].m;
  const good = cheaperFood(agent, sim, mm);
  const P = sim.market.price(mm, good);
  const b = agent.beliefs[good];
  const lim = b * (1 + MC.urgencyGain * (1 - agent.needs.tallow / 100)) * (1 + MC.frightGain * (agent.fright || 0));
  agent.thought = ['th.food', { good, price: P, limit: lim, m: mm }];
  return mkTask('food', ['task.buyFood', { m: mm }], steps, sim);
}

function planForage(agent, sim) {
  const tick = sim.clock.tick;
  const prod = sim.production;
  const c = agent.cell;
  const land = landFilter(sim, agent);
  const list = sim.world.findNearestK(B.BUSH_RIPE, c.x, c.y, c.z, 6, 60, land ? (x, y, z) => land(x, z) : null);
  for (const bush of list) {
    const key = ckey(bush.x, bush.y, bush.z);
    if (prod.isReserved(key, agent.id) || isBlacklisted(agent, key, tick)) continue;
    if (!prod.reserve(key, agent.id, 1)) continue;
    st(agent).resKey = key;
    agent.thought = agent.glim < 10 ? ['th.foragePoor', { money: agent.glim }] : ['th.forageNoMarket'];
    return mkTask('forage', ['task.forage'], [
      { k: 'goto', goal: { x: bush.x, y: bush.y, z: bush.z, adjacentTo: true }, key },
      { k: 'harvest', x: bush.x, y: bush.y, z: bush.z, forage: true },
      { k: 'eat' },
    ], sim);
  }
  return null;
}

function planLantern(agent, sim, m) {
  const steps = tradeTrip(agent, sim, m, 'lantern');
  if (!steps) return null;
  const P = sim.market.price(steps[1].m, 'lantern');
  agent.thought = ['th.lantern', { h: agent.needs.lustre, price: P }];
  return mkTask('lantern', ['task.buyLantern'], steps, sim);
}

function planSpeculate(agent, sim, m) {
  const r = agent.rumor;
  if (!r) return null;
  const steps = tradeTrip(agent, sim, m, 'speculate', { good: r.good });
  if (!steps) return null;
  agent.thought = ['th.speculate', { good: r.good, price: agent.beliefs[r.good] }];
  return mkTask('speculate', ['task.hoard', { good: r.good }], steps, sim);
}

function planDump(agent, sim, m) {
  const good = agent.spec?.good ?? agent.rumor?.good;
  if (!good || (agent.inv[good] | 0) <= 0) return null;
  const steps = tradeTrip(agent, sim, m, 'dump', { good });
  if (!steps) return null;
  steps.pop();                                                     // nothing to wait for
  agent.thought = ['th.dump', { n: agent.inv[good] | 0, good }];
  return mkTask('dump', ['task.dump', { good }], steps, sim);
}

function planSell(agent, sim, m) {
  const steps = tradeTrip(agent, sim, m, 'sell');
  if (!steps) return null;
  steps.pop();
  agent.thought = ['th.sell', { m: steps[1].m }];
  return mkTask('sell', ['task.sell', { m: steps[1].m }], steps, sim);
}

function planIdle(agent, sim) {
  const rng = sim.rng;
  const home = agent.homeId != null ? sim.production.houseOf(agent.id) : null;
  const center = home?.approach ?? sim.worldInfo.markets[sim.market.nearestMarket(agent)]?.center ?? null;
  agent.thought = ['th.idle'];
  if (rng.next() < 0.5) return mkTask('idle', ['task.loiter'], [{ k: 'idle', secs: rng.range(3, 6) }], sim);
  return mkTask('idle', ['task.wander'], [{ k: 'wander', hops: rng.int(2, 5), center, r: 6 }, { k: 'idle', secs: rng.range(1, 3) }], sim);
}

// ─────────────────────────────────────────────────────────────────────────────
// Work plans (§D.7b)
// ─────────────────────────────────────────────────────────────────────────────

const RAW_PRODUCERS = new Set(['tender', 'delver', 'woodwarden']);

function workFeasible(agent, sim) {
  const prod = sim.production;
  // A producer whose stall is heaped with unsold stock and whose pockets are full has no work.
  if (RAW_PRODUCERS.has(agent.profession) && st(agent).saturatedUntil > sim.clock.tick
    && freeCapacity(agent) <= 0.2 * carryCap(agent)) return false;
  const clan = agent.clan ?? 0;
  switch (agent.profession) {
    case 'mason':
      return agent.projectId != null || prod.openProjects().some(p => p.status === 'open' && p.masonId == null && p.clan === clan);
    case 'lenswright':
      return !!prod.towerOf(agent.id) || prod.towers.some(t => t.operatorId == null && t.clan === clan) || canCommissionTower(agent, sim);
    case 'porter':
      return !!(agent.porter && (agent.inv[agent.porter.good] | 0) > 0) || !!bestRoute(agent, sim);
    case 'delver':
      return sim.world.countBlocks(B.QUARTZ) + sim.world.countBlocks(B.AMBER) > 0;
    case 'tender': {
      const pc = sim.clans?.multi ? clan : undefined;
      return sim.world.countBlocks(B.BUSH_RIPE) > 0 || (prod.bushCount() < PROD.maxBushes && prod.bushCount(pc) < prod.bushMax(pc))
        || (agent.inv.berry | 0) > 0;
    }
    default:
      return true;
  }
}

function planWork(agent, sim) {
  switch (agent.profession) {
    case 'tender': return planTender(agent, sim);
    case 'chandler': return planChandler(agent, sim);
    case 'delver': return planDelver(agent, sim);
    case 'woodwarden': return planWoodwarden(agent, sim);
    case 'mason': return planMason(agent, sim);
    case 'lenswright': return planLenswright(agent, sim);
    case 'porter': return planPorter(agent, sim);
    default: return null;
  }
}

function sellTrip(agent, sim, label, thought) {
  if (st(agent).saturatedUntil > sim.clock.tick) return null;       // my lots are not moving
  const m = sim.market.nearestMarket(agent);
  const steps = tradeTrip(agent, sim, m, 'sell');
  if (!steps) return null;
  steps.pop();
  agent.thought = thought;
  return mkTask('work', label, steps, sim);
}

function planTender(agent, sim) {
  const tick = sim.clock.tick;
  const cap = carryCap(agent);
  const berries = agent.inv.berry | 0;
  if (berries >= 0.8 * cap || freeCapacity(agent) === 0) {
    const m = sim.market.nearestMarket(agent);
    return sellTrip(agent, sim, ['task.sellBerries'], ['th.basketFull', { n: berries, price: sim.market.price(m, 'berry'), m }]);
  }
  const prod = sim.production;
  const c = agent.cell;
  const land = landFilter(sim, agent);
  for (const bush of sim.world.findNearestK(B.BUSH_RIPE, c.x, c.y, c.z, 8, 40, land ? (x, y, z) => land(x, z) : null)) {
    const key = ckey(bush.x, bush.y, bush.z);
    if (prod.isReserved(key, agent.id) || isBlacklisted(agent, key, tick)) continue;
    if (!prod.reserve(key, agent.id, 1)) continue;
    st(agent).resKey = key;
    agent.thought = ['th.picking', { price: cprice(sim, agent, 'berry') }];
    return mkTask('work', ['task.harvest'], [
      { k: 'goto', goal: { x: bush.x, y: bush.y, z: bush.z, adjacentTo: true }, key },
      { k: 'harvest', x: bush.x, y: bush.y, z: bush.z },
    ], sim);
  }
  const plantClan = sim.clans?.multi ? agent.clan ?? 0 : undefined;
  if (prod.bushCount() < PROD.maxBushes && prod.bushCount(plantClan) < prod.bushMax(plantClan)) {
    const site = prod.findPlantSite(c.x, c.z, agent);
    if (site && !isBlacklisted(agent, ckey(site.x, site.y, site.z), tick)) {
      const key = ckey(site.x, site.y, site.z);
      agent.thought = ['th.planting'];
      return mkTask('work', ['task.plant'], [
        { k: 'goto', goal: { x: site.x, y: site.y, z: site.z, adjacentTo: true }, key },
        { k: 'plant', x: site.x, y: site.y, z: site.z },
      ], sim);
    }
  }
  if (berries > 0) return sellTrip(agent, sim, ['task.sellBerries'], ['th.bushesBare']);
  return null;
}

function nearestKettle(agent, sim) {
  let best = null, bestD = Infinity;
  for (const mk of sim.worldInfo.markets) {
    if (!marketUsable(agent, sim, mk.id)) continue;
    for (const k of mk.kettles || []) {
      const d = (k.x - agent.pos.x) ** 2 + (k.z - agent.pos.z) ** 2;
      if (d < bestD) { bestD = d; best = { ...k, m: mk.id }; }
    }
  }
  return best;
}

function lanternWorthIt(sim, agent) {
  const P = g => cprice(sim, agent, g);
  return P('lantern') >= 1.25 * (P('amber') + P('quartz') + P('tablet'));
}

/**
 * Chandlers specialise in whichever kettle product pays more per batch: lanterns (amber + quartz +
 * tablet) or tablets (3 berries + peat → 2), at their clan's prices. A chandler's pockets cannot
 * hold both input sets.
 */
function chandlerWantsLanterns(sim, agent) {
  if (!lanternWorthIt(sim, agent)) return false;
  const P = g => cprice(sim, agent, g);
  const lanternMargin = P('lantern') - (P('amber') + P('quartz') + P('tablet'));
  const tabletMargin = 2 * P('tablet') - 3 * P('berry') - P('peat');
  return lanternMargin > tabletMargin;
}

/** Input bids for the agent's profession: [[good, qty, limit], ...] (§D.4 derived demand). */
function inputBids(agent, sim) {
  const b = agent.beliefs;
  const out = [];
  const bid = (good, qty, limit) => { if (qty > 0 && limit > 0) out.push([good, qty, limit]); };
  const mrp = (recipe, good) => {
    const r = RECIPES[recipe];
    let v = 0;
    for (const o in r.out) v += (b[o] ?? 0) * r.out[o];
    for (const i in r.in) if (i !== good) v -= (b[i] ?? 0) * r.in[i];
    return v / r.in[good];
  };
  switch (agent.profession) {
    case 'chandler': {
      if (chandlerWantsLanterns(sim, agent)) {
        for (const g of ['amber', 'quartz', 'tablet']) {
          if ((agent.inv[g] | 0) < 1) bid(g, 1, Math.min(1.15 * b[g], 0.9 * mrp('lantern', g)));
        }
      } else {
        const r = RECIPES.tablet;
        bid('berry', r.in.berry - (agent.inv.berry | 0), Math.min(1.15 * b.berry, 0.9 * mrp('tablet', 'berry')));
        bid('peat', r.in.peat - (agent.inv.peat | 0), Math.min(1.15 * b.peat, 0.9 * mrp('tablet', 'peat')));
      }
      break;
    }
    case 'lenswright': {
      const eta = sim.ledger?.haze ?? 1;
      const skill = agent.skills.lenswright ?? 1;
      const q = 0.8 + (0.4 * (skill - 0.6)) / 0.9;
      const m = ((K_MINT_DAY * eta * MONEY.lensLifeDays * q) / 2) * 0.5;
      bid('quartz', 2 - (agent.inv.quartz | 0), Math.min(1.15 * b.quartz, 0.9 * m));
      break;
    }
    case 'mason': {
      const p = agent.projectId != null ? projectById(sim, agent.projectId) : null;
      if (p) {
        const miss = sim.production.missingMaterials(p);
        bid('stone', miss.stone - (agent.inv.stone | 0), 1.2 * b.stone);
        bid('log', miss.log - (agent.inv.log | 0), 1.2 * b.log);
      }
      break;
    }
    default:
  }
  return out;
}

function planChandler(agent, sim) {
  const kettle = nearestKettle(agent, sim);
  if (!kettle) return null;
  const inv = agent.inv;
  const r = RECIPES.tablet;
  const gotoKettle = { k: 'goto', goal: { x: kettle.x, y: kettle.y, z: kettle.z, adjacentTo: true }, key: `kettle:${kettle.x},${kettle.z}` };
  const L = RECIPES.lantern;
  if (chandlerWantsLanterns(sim, agent) && Object.keys(L.in).every(g => (inv[g] | 0) >= L.in[g])) {
    agent.thought = ['th.makeLantern', { price: cprice(sim, agent, 'lantern') }];
    return mkTask('work', ['task.craftLantern'], [gotoKettle, { k: 'craft', recipe: 'lantern', times: 1, station: kettle }], sim);
  }
  if ((inv.berry | 0) >= r.in.berry && (inv.peat | 0) >= r.in.peat) {
    const times = (inv.berry | 0) >= 2 * r.in.berry && (inv.peat | 0) >= 2 * r.in.peat ? 2 : 1;
    agent.thought = ['th.cook', { n: times * r.in.berry, out: times * r.out.tablet, price: cprice(sim, agent, 'tablet') }];
    return mkTask('work', ['task.cook'], [gotoKettle, { k: 'craft', recipe: 'tablet', times, station: kettle }], sim);
  }
  if (lanternWorthIt(sim, agent) && Object.keys(L.in).every(g => (inv[g] | 0) >= L.in[g])) {
    agent.thought = ['th.makeLantern', { price: cprice(sim, agent, 'lantern') }];
    return mkTask('work', ['task.craftLantern'], [gotoKettle, { k: 'craft', recipe: 'lantern', times: 1, station: kettle }], sim);
  }
  const c = agent.cell;
  const tick = sim.clock.tick;
  const land = landFilter(sim, agent);
  const puddle = sim.world.findNearest(B.WAX_PUDDLE, c.x, c.y, c.z, 25,
    (x, y, z) => !isBlacklisted(agent, ckey(x, y, z), tick) && (!land || land(x, z)));
  if (puddle) {
    const key = ckey(puddle.x, puddle.y, puddle.z);
    if (sim.production.reserve(key, agent.id, 1)) {
      st(agent).resKey = key;
      agent.thought = ['th.scrape'];
      return mkTask('work', ['task.scrape'], [
        { k: 'goto', goal: { x: puddle.x, y: puddle.y, z: puddle.z, adjacentTo: true }, key },
        { k: 'scrape', x: puddle.x, y: puddle.y, z: puddle.z },
      ], sim);
    }
  }
  const buys = inputBids(agent, sim);
  const steps = tradeTrip(agent, sim, kettle.m, 'input', { buys });
  if (!steps) return null;
  agent.thought = chandlerWantsLanterns(sim, agent)
    ? ['th.buyLanternInputs', { m: steps[1].m }]
    : ['th.buyCookInputs', { price: buys[0]?.[2], m: steps[1].m }];
  return mkTask('work', ['task.buyInputs'], steps, sim);
}

function planDelver(agent, sim) {
  const cap = carryCap(agent);
  if (freeCapacity(agent) <= Math.floor(0.2 * cap)) {
    return sellTrip(agent, sim, ['task.sellOre'], ['th.sackFull', { q: agent.inv.quartz | 0, s: agent.inv.stone | 0 }]);
  }
  const tick = sim.clock.tick;
  const prod = sim.production;
  const c = agent.cell;
  const land = landFilter(sim, agent);
  const ok = (x, y, z) => !prod.isReserved(ckey(x, y, z), agent.id) && !isBlacklisted(agent, ckey(x, y, z), tick)
    && (!land || land(x, z));
  const cands = [
    ...sim.world.findNearestK(B.QUARTZ, c.x, c.y, c.z, 4, 40, ok).map(o => ({ ...o, id: B.QUARTZ, good: 'quartz' })),
    ...sim.world.findNearestK(B.AMBER, c.x, c.y, c.z, 2, 40, ok).map(o => ({ ...o, id: B.AMBER, good: 'amber' })),
  ];
  let best = null, bestS = -Infinity;
  for (const o of cands) {
    const s = agent.beliefs[o.good] / (10 + o.d);
    if (s > bestS) { bestS = s; best = o; }
  }
  if (!best) return totalItems(agent) > 0 ? sellTrip(agent, sim, ['task.sellOre'], ['th.veinsGone']) : null;
  const key = ckey(best.x, best.y, best.z);
  if (!prod.reserve(key, agent.id, 2)) return null;
  st(agent).resKey = key;
  agent.thought = ['th.digFor', { good: best.good, price: agent.beliefs[best.good], d: Math.round(best.d) }];
  return mkTask('work', ['task.dig', { good: best.good }], [
    { k: 'goto', goal: { x: best.x, y: best.y, z: best.z, adjacentTo: true }, dig: true, key },
    { k: 'dig', x: best.x, y: best.y, z: best.z, expect: best.id },
  ], sim);
}

function planWoodwarden(agent, sim) {
  const cap = carryCap(agent);
  if (freeCapacity(agent) <= Math.floor(0.2 * cap)) {
    return sellTrip(agent, sim, ['task.sellWood'], ['th.woodFull', { l: agent.inv.log | 0, p: agent.inv.peat | 0 }]);
  }
  const b = agent.beliefs;
  let wantLog = b.log / ref('log') >= b.peat / ref('peat');
  if (sim.rng.next() < 0.2) wantLog = !wantLog;
  const tick = sim.clock.tick;
  const prod = sim.production;
  const c = agent.cell;
  const land = landFilter(sim, agent);
  const tryLog = () => {
    const tree = prod.nearestMatureTree(c.x + 0.5, c.z + 0.5, 60, agent.id, agent);
    if (!tree) return null;
    const key = ckey(tree.x, tree.y, tree.z);
    if (isBlacklisted(agent, key, tick) || !prod.reserve(key, agent.id, 2)) return null;
    st(agent).resKey = key;
    agent.thought = ['th.fell', { h: tree.height, price: cprice(sim, agent, 'log') }];
    return mkTask('work', ['task.fell'], [
      { k: 'goto', goal: { x: tree.x, y: tree.y, z: tree.z, adjacentTo: true }, key },
      { k: 'fell', treeId: tree.id, x: tree.x, y: tree.y, z: tree.z, height: tree.height },
    ], sim);
  };
  const tryPeat = () => {
    const w = sim.world;
    const ok = (x, y, z) => w.isPassableAt(x, y + 1, z) && !prod.isReserved(ckey(x, y, z), agent.id)
      && !isBlacklisted(agent, ckey(x, y, z), tick) && (!land || land(x, z));
    const p = w.findNearest(B.PEAT, c.x, c.y, c.z, 50, ok);
    if (!p) return null;
    const key = ckey(p.x, p.y, p.z);
    if (!prod.reserve(key, agent.id, 1)) return null;
    st(agent).resKey = key;
    agent.thought = ['th.peat', { price: cprice(sim, agent, 'peat') }];
    return mkTask('work', ['task.peat'], [
      { k: 'goto', goal: { x: p.x, y: p.y + 1, z: p.z, adjacentTo: true }, key },
      { k: 'dig', x: p.x, y: p.y, z: p.z, expect: B.PEAT },
    ], sim);
  };
  return (wantLog ? tryLog() || tryPeat() : tryPeat() || tryLog())
    || (totalItems(agent) > 0 ? sellTrip(agent, sim, ['task.sellWood'], ['th.nothingToCut']) : null);
}

function projectById(sim, id) {
  if (id == null) return null;
  const list = sim.production.projects || [];
  for (const p of list) if (p.id === id) return p;
  return null;
}

function planMason(agent, sim) {
  const prod = sim.production;
  const p = prod.claimProject(agent);
  if (!p) return null;
  const site = p.approach || p.site;
  const miss = prod.missingMaterials(p);
  const holdS = Math.min(agent.inv.stone | 0, miss.stone), holdL = Math.min(agent.inv.log | 0, miss.log);
  const owner = sim.population.get(p.ownerId);
  if (isBlacklisted(agent, `site:${p.id}`, sim.clock.tick)) { prod.releaseProject(agent); return null; }
  // The exact approach cell, on the ground: a radius goal let masons climb onto the rising walls.
  const gotoSite = { k: 'goto', goal: { x: site.x, y: site.y, z: site.z }, key: `site:${p.id}` };
  if (holdS + holdL > 0 || prod.canBuild(p)) {
    agent.thought = ['th.building', { kind: p.kind, owner: owner ? owner.name : null, placed: p.placed, total: p.blocks.length }];
    return mkTask('work', p.kind === 'tower' ? ['task.buildTower'] : ['task.buildHouse'], [
      gotoSite, { k: 'deliver', projectId: p.id }, { k: 'build', projectId: p.id },
    ], sim);
  }
  // Buy the missing stone and logs at the plaza nearest the site.
  let m = 0, bestD = Infinity;
  for (const mk of sim.worldInfo.markets) {
    const d = (mk.center.x - site.x) ** 2 + (mk.center.z - site.z) ** 2;
    if (d < bestD && marketUsable(agent, sim, mk.id)) { bestD = d; m = mk.id; }
  }
  const buys = inputBids(agent, sim);
  if (!buys.length) return null;
  const steps = tradeTrip(agent, sim, m, 'input', { buys });
  if (!steps) return null;
  agent.thought = ['th.buyStone', { kind: p.kind, s: miss.stone, l: miss.log, m: steps[1].m }];
  return mkTask('work', ['task.buyStone'], steps, sim);
}

function canCommissionTower(agent, sim) {
  const prod = sim.production;
  const clan = agent.clan ?? 0;
  const pending = prod.openProjects().filter(p => p.kind === 'tower' && p.clan === clan).length;
  return prod.clanTowerCount(clan) + pending < prod.towerMax(clan) && agent.glim >= 1.2 * prod.towerBudget(clan)
    && agent.commissionId == null;
}

function planLenswright(agent, sim) {
  const prod = sim.production;
  const clock = sim.clock;
  let tower = prod.claimTower(agent);
  if (!tower) {
    if (canCommissionTower(agent, sim)) {
      const p = prod.commissionTower(agent);
      if (p) {
        agent.thought = ['th.newTower', { price: p.price }];
        return mkTask('work', ['task.orderTower'], [{ k: 'idle', secs: 2, anim: 'trade' }], sim);
      }
    }
    return null;
  }
  const stand = tower.stand;
  if (isBlacklisted(agent, `stand:${tower.id}`, sim.clock.tick)) { prod.releaseTower(agent); return null; }
  const gotoStand = { k: 'goto', goal: { x: stand.x, y: stand.y, z: stand.z }, key: `stand:${tower.id}` };
  const daylight = clock.sun > 0.05 || (clock.hourFloat >= 5.5 && clock.hourFloat < 12);
  if (tower.lensQ <= 0) {
    if (countItem(agent, 'lens') > 0) {
      agent.thought = ['th.installLens'];
      return mkTask('work', ['task.installLens'], [gotoStand, { k: 'installLens', towerId: tower.id }], sim);
    }
    if ((agent.inv.quartz | 0) >= 2) {
      agent.thought = ['th.grindLens'];
      return mkTask('work', ['task.grindLens'], [
        gotoStand, { k: 'craft', recipe: 'lens', times: 1, station: tower.base }, { k: 'installLens', towerId: tower.id },
      ], sim);
    }
    const m = sim.market.nearestMarket(agent);
    if (agent.glim < 2 * sim.market.price(m, 'quartz')) {
      // Too poor to re-lens: hand the tower to someone who can, rather than keep it dark.
      prod.releaseTower(agent);
      agent.thought = ['th.leaveTower'];
      return null;
    }
    const buys = inputBids(agent, sim);
    if (!buys.length) return null;
    const steps = tradeTrip(agent, sim, m, 'input', { buys });
    if (!steps) return null;
    agent.thought = ['th.buyQuartz', { price: buys[0][2] }];
    return mkTask('work', ['task.buyQuartz'], steps, sim);
  }
  if (daylight && !prod.isEclipsed(tower.base)) {
    const rate = MONEY.mintPerHour * tower.lensQ * (sim.ledger?.haze ?? 1);
    agent.thought = ['th.tend', { id: tower.id, rate }];
    return mkTask('work', ['task.tend', { id: tower.id }], [gotoStand, { k: 'tend', towerId: tower.id }], sim);
  }
  if (!daylight && (agent.inv.quartz | 0) >= 2 && countItem(agent, 'lens') === 0) {
    agent.thought = ['th.nightLens'];
    return mkTask('work', ['task.spareLens'], [gotoStand, { k: 'craft', recipe: 'lens', times: 1, station: tower.base }], sim);
  }
  return null;
}

/** Best porter route {good, a, b, profit} over every ordered pair of markets, or null (§D.7b). */
function bestRoute(agent, sim) {
  const market = sim.market;
  const cap = carryCap(agent);
  const n = market.markets.length;
  const clans = sim.clans;
  let best = null;
  for (const g of GOODS) {
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        if (a === b) continue;
        // Selling abroad may cost the host's border tax.
        const tax = clans && clans.multi ? clans.taxRate(agent.clan ?? 0, b) : 0;
        const keep = tax > 0 ? 1 - MC.fee - tax : 1 - MC.fee;
        const profit = cap * (keep * market.price(b, g) - 1.05 * market.price(a, g));
        if (profit > BR.porterMinProfit && (!best || profit > best.profit)
          && marketUsable(agent, sim, a) && marketUsable(agent, sim, b) && market.getBook(a, g).lots.length > 0) {
          best = { good: g, a, b, profit };
        }
      }
    }
  }
  return best;
}

function planPorter(agent, sim) {
  const pt = agent.porter;
  if (pt && !marketUsable(agent, sim, pt.to)) agent.porter = null;   // cannot deliver: sell as ordinary stock
  if (agent.porter && (agent.inv[pt.good] | 0) > 0) {
    const steps = [gotoMarket(sim, pt.to, true), { k: 'trade', m: pt.to, intent: 'sell' }];
    const exp = (agent.inv[pt.good] | 0) * ((1 - MC.fee) * sim.market.price(pt.to, pt.good) - pt.cost);
    agent.thought = ['th.haul', { n: agent.inv[pt.good] | 0, good: pt.good, from: pt.from, to: pt.to, exp }];
    return mkTask('work', ['task.haul', { good: pt.good }], steps, sim);
  }
  if (pt) agent.porter = null;
  const route = bestRoute(agent, sim);
  if (!route) return null;
  const steps = tradeTrip(agent, sim, route.a, 'porterBuy', { good: route.good, to: route.b, dig: true });
  if (!steps || steps[1].m !== route.a) return null;
  agent.thought = ['th.route', {
    good: route.good, pa: sim.market.price(route.a, route.good), a: route.a,
    pb: sim.market.price(route.b, route.good), b: route.b, profit: route.profit,
  }];
  return mkTask('work', ['task.buyToHaul', { good: route.good }], steps, sim);
}

// ═════════════════════════════════════════════════════════════════════════════
// Profession review at dawn (§D.7)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Maybe switch profession, by softmax over blended guild incomes × skill minus a switch cost.
 * @param {object} agent
 * @param {object} sim
 * @param {{guild:object, meanY:number, subsistence:number, budget:{left:number}}} ctx
 */
export function reviewProfession(agent, sim, ctx) {
  if (!agent || !agent.alive || !ctx || !(ctx.budget?.left > 0)) return;
  const prod = sim.production;
  const market = sim.market;
  const cur = agent.profession;
  const clan = agent.clan ?? 0;
  const clans = sim.clans;
  const counts = sim.population?.professionCounts?.(clan) || {};
  const openProjects = prod.openProjects().filter(p => (p.status === 'open' || p.status === 'claimed') && p.clan === clan).length;

  // The widest price gap between markets the clan can trade at (traders live on it).
  let maxSpread = 1;
  const open = clans?.multi ? clans.openMarkets(clan) : null;
  for (const g of GOODS) {
    if (!open) {
      const a = market.price(0, g), b = market.price(1, g);
      maxSpread = Math.max(maxSpread, Math.max(a, b) / Math.max(1e-6, Math.min(a, b)));
      continue;
    }
    if (open.length < 2) continue;
    let hi = 0, lo = Infinity;
    for (const m of open) {
      const p = market.price(m, g);
      if (p > hi) hi = p;
      if (p < lo) lo = p;
    }
    maxSpread = Math.max(maxSpread, hi / Math.max(1e-6, lo));
  }
  const towerFree = prod.towers.some(t => t.operatorId == null && t.clan === clan)
    || (prod.clanTowerCount(clan) + prod.openProjects().filter(p => p.kind === 'tower' && p.clan === clan).length < prod.towerMax(clan));

  const subsistence = Math.max(0, ctx.subsistence || 0);
  const cands = [];
  for (const p of PROFESSIONS) {
    if (p !== cur) {
      if (p === 'lenswright' && !towerFree) continue;
      if (p === 'mason' && !(openProjects > (counts.mason || 0))) continue;
      if (p === 'porter' && !(maxSpread > 1.2)) continue;
    }
    const g = ctx.guild?.[p];
    const blended = Number.isFinite(g?.blended) ? g.blended : prod.estimateIncome(p, clan);
    const score = blended * (agent.skills[p] ?? 1) - (p !== cur ? CONFIG.population.switchCostMul * subsistence : 0);
    cands.push({ p, score, blended });
  }
  if (!cands.length) return;

  const T = Math.max(1, CONFIG.population.softmaxTemp * (ctx.meanY || 0));
  const top = Math.max(...cands.map(c => c.score));
  let sum = 0;
  for (const c of cands) { c.w = Math.exp((c.score - top) / T); sum += c.w; }
  let roll = sim.rng.next() * sum;
  let pick = cands[cands.length - 1];
  for (const c of cands) { roll -= c.w; if (roll <= 0) { pick = c; break; } }
  if (pick.p === cur) return;

  const from = cands.find(c => c.p === cur);
  const reason = ['reason.pays', { to: pick.p, x: pick.blended, from: cur, y: from ? from.blended : 0 }];
  interrupt(agent, sim, ['th.newJob', { prof: pick.p, reason }]);
  prod.releaseTower(agent);
  prod.releaseProject(agent);
  if (agent.porter) agent.porter = null;
  agent.profession = pick.p;
  agent.goal = 'idle';
  ctx.budget.left--;
  sim.events.emit(EV.AGENT_PROFESSION, { agentId: agent.id, from: cur, to: pick.p, reason });
}

// ═════════════════════════════════════════════════════════════════════════════
// Fights between clans
// ═════════════════════════════════════════════════════════════════════════════

/** Face the opponent and scuffle in place until the fight ends. */
function fightStep(agent, sim) {
  if (agent.path) { agent.path = null; agent.pathI = 0; agent.pathBlocked = false; }
  agent.asleep = false;
  const foe = agent.fightWith != null ? sim.population?.get(agent.fightWith) : null;
  if (foe) face(agent, Math.floor(foe.pos.x), Math.floor(foe.pos.z));
  setAnim(agent, 'fight');
}

// ═════════════════════════════════════════════════════════════════════════════
// Panic roll (Tap the Glass)
// ═════════════════════════════════════════════════════════════════════════════

function panicRoll(agent, sim, br) {
  if (!br.roll) {
    br.roll = { steps: 0, t: 0, tx: null, ty: 0, tz: 0 };
    if (agent.path) { agent.path = null; agent.pathI = 0; }
    agent.asleep = false;
  }
  const roll = br.roll;
  setAnim(agent, 'panic');
  const pos = agent.pos;
  if (roll.tx != null) {
    const hx = roll.tx + 0.5 - pos.x, hz = roll.tz + 0.5 - pos.z, hy = roll.ty - pos.y;
    const d = Math.hypot(hx, hz);
    const stepLen = 2.5 / PER_SEC;
    if (d <= stepLen) {
      pos.x = roll.tx + 0.5; pos.y = roll.ty; pos.z = roll.tz + 0.5;
      agent.cell.x = roll.tx; agent.cell.y = roll.ty; agent.cell.z = roll.tz;
      roll.tx = null;
    } else {
      pos.x += (hx / d) * stepLen;
      pos.z += (hz / d) * stepLen;
      pos.y += hy * Math.min(1, stepLen / d);
      agent.heading = Math.atan2(hx, hz);
    }
    return;
  }
  if (roll.steps >= AG.rollSteps || ++roll.t < 4) return;
  roll.t = 0;
  // Roll to the lowest walkable neighbour (ties broken at random).
  const w = sim.world, c = agent.cell;
  let best = null, bestY = c.y + 1;
  const start = sim.rng.int(0, 3);
  for (let k = 0; k < 4; k++) {
    const d = (start + k) & 3;
    const nx = c.x + (d === 0 ? 1 : d === 1 ? -1 : 0), nz = c.z + (d === 2 ? 1 : d === 3 ? -1 : 0);
    for (let dy = -1; dy <= 0; dy++) {
      const ny = c.y + dy;
      if (!w.isWalkable(nx, ny, nz)) continue;
      if (dy === -1 && !w.isPassableAt(nx, c.y + 1, nz)) continue;
      if (ny < bestY) { bestY = ny; best = { x: nx, y: ny, z: nz }; }
    }
  }
  roll.steps++;
  if (best) { roll.tx = best.x; roll.ty = best.y; roll.tz = best.z; }
}
