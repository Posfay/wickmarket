// Simulation assembly: builds the shared `sim` context (SPEC §C.1) and advances it one fixed tick.
// Sim-side only — no DOM, no three — so it runs identically in the browser and in Node (scripts/headless.mjs).
import { CONFIG, TICKS, GOODS } from './core/config.js';
import { createRng } from './core/rng.js';
import { EventBus, EV, SimClock } from './core/events.js';
import { World } from './world/world.js';
import { generateWorld } from './world/worldgen.js';
import { Pathfinder } from './agents/pathfinding.js';
import { Population } from './agents/population.js';
import { Market } from './economy/market.js';
import { Ledger } from './economy/ledger.js';
import { Production } from './economy/production.js';
import { Clans, normalizeSetup } from './economy/clans.js';

/** A fresh id for one world's lifetime (autosave slots use it to tell worlds apart). */
export function newWorldId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** The shared context object, without any module (createSim and the save loader fill it). */
export function simShell(seed, headless, setup, world, worldInfo) {
  return {
    config: CONFIG, seed, headless, setup, worldId: newWorldId(),
    rng: createRng((seed ^ 0xA5A5A5A5) >>> 0),
    events: new EventBus(),
    clock: new SimClock(CONFIG),
    world, worldInfo,
    pathfinder: null, clans: null, ledger: null, market: null, production: null, population: null,
    effects: { eclipses: [], seals: [], panes: [], nextId: 1 },
    speed: 1, paused: false, lagging: false,
    ui: {
      selectedAgentId: null, selectedMarketId: null, followAgentId: null, selectedGood: 'berry',
      chartTab: 'prices', muted: true, cutaway: null, hideUI: false,
    },
    renderer: null, agentRenderer: null, fx: null, tools: null,
    hud: null, charts: null, inspector: null, ticker: null,
  };
}

/**
 * Build a complete simulation for `seed`.
 * @param {number} seed uint32 world seed
 * @param {boolean} headless true when no renderer/UI will be attached
 * @param {object} [setupIn] world setup (clans and walls); omitted = the classic single-clan jar
 */
export function createSim(seed, headless = false, setupIn = null) {
  const setup = normalizeSetup(setupIn);
  const world = new World(CONFIG);
  const worldInfo = generateWorld(world, seed, CONFIG, setup);
  const sim = simShell(seed, headless, setup, world, worldInfo);
  sim.pathfinder = new Pathfinder(world, CONFIG);
  sim.clans = new Clans(sim, setup, worldInfo);   // before the ledger: its series depend on the clans
  sim.ledger = new Ledger(sim);            // before market/production: they call into the ledger
  sim.market = new Market(sim, worldInfo.markets);
  sim.production = new Production(sim, worldInfo);
  sim.population = new Population(sim);
  sim.population.spawnInitial(worldInfo);
  sim.pathfinder.refreshRegions(true);
  return sim;
}

/** Advance the simulation by exactly one fixed tick (1 / TICKS.PER_SEC sim-seconds). */
export function simTick(sim) {
  sim.clock.advance(sim.events);
  sim.pathfinder.processQueue();
  sim.population.tick(sim);
  sim.clans.tick(sim);                     // fights and relations (inert with one clan)
  sim.production.tick(sim);
  sim.market.tick(sim);                    // the Chime clears on hour ticks
  sim.ledger.tick(sim);                    // samples after the Chime
}

const SOURCES = ['mint', 'gift', 'immigration'];
const SINKS = ['demurrage', 'fee', 'death', 'emigration', 'estate'];

/**
 * Tracks the headless liveness invariants and produces one CSV line per sim day.
 * Adapted from SPEC §G: Wicklings sleep at night, so "trades on ≥ 20 of 24 Chimes" became
 * "each staple trades on some Chimes every day"; construction inputs (stone, log, peat) may
 * legitimately idle at their floor between building booms, so the clamp-pin check covers the
 * staples and luxuries and allows 48 h.
 * Call `afterTick()` after every simTick; it returns a day report on new-day ticks, else null.
 */
export function createInvariantTracker(sim) {
  const clamp = CONFIG.market.clamp;
  const minChimes = { berry: 6, tablet: 1, quartz: 1 };
  const pinChecked = new Set(['berry', 'tablet', 'lantern']);
  const PIN_HOURS = 48;
  const hourVolume = Object.fromEntries(GOODS.map(g => [g, 0]));
  const chimesTraded = Object.fromEntries(GOODS.map(g => [g, 0]));
  const nMarkets = sim.market.markets.length;
  const clampRun = GOODS.map(() => new Array(nMarkets).fill(0));   // consecutive clamped hours per [good][market]
  let M0 = sim.ledger.moneySupply();
  let maxLit = 0;
  let day = 0;

  sim.events.on(EV.MARKET_CHIME, ({ cleared }) => {
    if (!cleared) return;
    for (const g of GOODS) hourVolume[g] += cleared[g]?.volume || 0;
  });

  const multi = !!sim.clans?.multi;
  const header = ['day', 'pop', 'housed', 'M', 'Mstar', 'haze', 'cpi', 'gini', 'towersLit',
    ...GOODS.map(g => `P:${g}`), 'births', 'deaths', 'starved', 'immig', 'emig', 'trades',
    ...Object.keys(CONFIG.professions).map(p => `n:${p}`), 'drift%',
    ...(multi ? ['clanPops', 'clanMoney', 'berryByClan', 'relations', 'fights', 'killed'] : [])].join(',');

  function afterTick() {
    const { clock } = sim;
    if (clock.isHourTick) {
      for (const g of GOODS) {
        if (hourVolume[g] > 0) chimesTraded[g]++;
        hourVolume[g] = 0;
      }
      GOODS.forEach((g, gi) => {
        const ref = CONFIG.goods[g].ref;
        for (let m = 0; m < nMarkets; m++) {
          const p = sim.market.price(m, g);
          const pinned = p <= clamp[0] * ref * 1.0001 || p >= clamp[1] * ref * 0.9999;
          clampRun[gi][m] = pinned ? clampRun[gi][m] + 1 : 0;
        }
      });
      maxLit = Math.max(maxLit, sim.production.activeTowerCount());
    }
    if (!clock.isNewDayTick) return null;

    day++;
    const violations = [];
    const pop = sim.population.count();
    const M1 = sim.ledger.moneySupply();
    const y = sim.ledger.yesterday || {};
    const flows = SOURCES.reduce((s, k) => s + (y[k] || 0), 0) - SINKS.reduce((s, k) => s + (y[k] || 0), 0);
    const drift = M1 - M0 - flows;
    const driftPct = M0 > 0 ? (100 * drift) / M0 : 0;
    M0 = M1;

    for (const cl of sim.clans.list) {
      const n = sim.population.clanCount(cl.id);
      if (n < cl.floor || n > cl.max) violations.push(`${cl.key} pop ${n} outside [${cl.floor}, ${cl.max}]`);
    }
    if (M1 < 10 * pop) violations.push(`M ${M1.toFixed(0)} < 10·pop`);
    if (Math.abs(driftPct) >= 1) violations.push(`money audit drift ${driftPct.toFixed(2)}%`);
    GOODS.forEach((g, gi) => {
      if (!pinChecked.has(g)) return;
      for (let m = 0; m < nMarkets; m++) if (clampRun[gi][m] >= PIN_HOURS) violations.push(`${g}@${m} pinned at clamp ${clampRun[gi][m]}h`);
    });
    for (const g in minChimes) if (chimesTraded[g] < minChimes[g]) violations.push(`${g} traded on only ${chimesTraded[g]}/24 chimes`);
    for (const a of sim.population.agents) {
      if (!(a.glim >= -1e-6)) violations.push(`agent ${a.id} glim ${a.glim}`);
      for (const k in a.inv) if (a.inv[k] < 0) violations.push(`agent ${a.id} inv.${k} = ${a.inv[k]}`);
    }

    const counts = sim.population.professionCounts();
    const row = [
      day, pop, sim.population.agents.filter(a => a.homeId != null).length,
      M1.toFixed(0), (sim.ledger.equilibriumM?.() ?? 0).toFixed(0), (sim.ledger.haze ?? 0).toFixed(2),
      (sim.ledger.cpi?.() ?? 0).toFixed(1), (sim.ledger.gini?.() ?? 0).toFixed(3), maxLit,
      ...GOODS.map(g => sim.market.avgPrice(g).toFixed(2)),
      y.births || 0, y.deaths || 0, y.starved || 0, y.immigrants || 0, y.emigrants || 0, y.trades || 0,
      ...Object.keys(CONFIG.professions).map(p => counts[p] || 0), driftPct.toFixed(2),
      ...(multi ? clanColumns(sim, y) : []),
    ].join(',');

    for (const g of GOODS) chimesTraded[g] = 0;
    maxLit = 0;
    return { day, csv: row, violations };
  }

  return { header, afterTick };
}

/** Per-clan CSV cells: head counts, money, berry price, relations (a-b:value) and yesterday's fights. */
function clanColumns(sim, y) {
  const clans = sim.clans;
  const pops = [], money = [], berry = [], rel = [];
  for (const cl of clans.list) {
    const s = sim.ledger.clanStats(cl.id);
    pops.push(s.pop);
    money.push(s.money.toFixed(0));
    berry.push(clans.clanPrice(cl.id, 'berry').toFixed(2));
  }
  for (let a = 0; a < clans.count; a++) {
    for (let b = a + 1; b < clans.count; b++) rel.push(`${a}${b}:${clans.relation(a, b).toFixed(0)}`);
  }
  const cd = clans.yesterday;
  let fights = 0;
  for (let i = 0; i < cd.fights.length; i++) fights += cd.fights[i];
  return [pops.join('/'), money.join('/'), berry.join('/'), rel.join(' '), fights / 2, y.killed || 0];
}

export { TICKS };
