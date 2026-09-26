/**
 * @file Ledger: money flows, the daily money audit, economy-wide statistics, the Guild Board and
 * the ring-buffer histories behind every chart (SPEC §C.4 G4 ledger.js, §D.1, §D.7, §D.10, §G).
 *
 * The money audit. M = Σ(glim + escrow) over living agents + Σ price of unfinished projects.
 * Only these recorded flows change M:
 *   sources: mint (towers), gift (Magnifier), immigration (an immigrant's purse)
 *   sinks:   demurrage, fee (2% of each sale), death (the burned half, or all of it without an
 *            heir; abandoned commissions of the dead), emigration, estate (proceeds of starter and
 *            dead agents' lots; the escrow of a removed agent)
 * Everything else moves light inside M and is never recorded as a flow: sale proceeds, escrow
 * ⇄ glim, the birth share and the heir share, commission glim → project price → mason's wage,
 * and an abandoned project refunded to its living owner.
 * At every newday the ledger checks M_end − M_start − (sources − sinks) and warns on drift.
 * Demurrage is burned per tick but reported in hourly batches by agent.js; the newday tick is an
 * hour tick and population ticks before the ledger, so the day's batches are all in by then.
 */
import { CONFIG, GOODS, PROFESSIONS, TICKS } from '../core/config.js';
import { EV } from '../core/events.js';
import { typedToB64, b64ToTyped } from '../core/codec.js';

/** Flow kinds that create light. */
export const SOURCES = Object.freeze(['mint', 'gift', 'immigration']);
/** Flow kinds that destroy light. */
export const SINKS = Object.freeze(['demurrage', 'fee', 'death', 'emigration', 'estate']);
/** Stabilizer kinds (§C.4, §D.11). */
export const STABILIZER_KINDS = Object.freeze([
  'forage', 'immigrationFloor', 'wildSapling', 'bogAccretion', 'priceClamp', 'mossSpread', 'hazeFloor',
]);

const MONEY = CONFIG.money;
const PER_HOUR = TICKS.PER_HOUR;
const PER_DAY = TICKS.PER_DAY;
const SINK_SET = new Set(SINKS);
const PURPOSES = ['food', 'input', 'luxury', 'speculate', 'arbitrage'];
const INPUT_PURPOSES = new Set(['input', 'arbitrage']);

// SPEC-GAP: new config key ledger.cpiWeights; the defaults are the §D.10 Wax Index weights.
const CPI_WEIGHTS = CONFIG.ledger?.cpiWeights
  ?? { berry: 3, tablet: 1, peat: 0.3, log: 0.2, stone: 0.3, quartz: 0.2, amber: 0.05, lantern: 0.1 };
// SPEC-GAP: new config keys ledger.hourlySamples / ledger.dailySamples (§C.4: 720 and 90).
const HOURLY_SAMPLES = CONFIG.ledger?.hourlySamples ?? 720;
const DAILY_SAMPLES = CONFIG.ledger?.dailySamples ?? 90;
// SPEC-GAP: new config key ledger.maxMarkers; the oldest player markers are dropped beyond it.
const MAX_MARKERS = CONFIG.ledger?.maxMarkers ?? 1000;

const NET_HISTORY_DAYS = 3;    // agent.netHistory length (§C.2)
const ACTUAL_DAYS = 2;         // a worker's actual income is its mean last-2 net (§C.4)
const GUILD_FULL_WORKERS = 4;  // blend weight w = min(1, workers/4) (§D.7)
const AUDIT_ABS_TOL = 1;       // drift warning above 1 + 0.001·M (§C.4)
const AUDIT_REL_TOL = 0.001;

/**
 * Hourly series for `nm` markets and `nc` clans: prices per market (`P:m:good`), then the
 * economy-wide series; with several clans also `c:pop:c`, `c:money:c`, `c:gini:c` and `rel:a:b`.
 */
function hourlyNames(nm, nc) {
  const names = [];
  for (let m = 0; m < nm; m++) for (const g of GOODS) names.push(`P:${m}:${g}`);
  for (const g of GOODS) names.push(`P:avg:${g}`);
  for (const g of GOODS) names.push(`V:${g}`);
  names.push('M', 'Mstar', 'haze', 'mintH', 'burnH', 'pop', 'housed', 'towersLit', 'believers');
  for (const p of PROFESSIONS) names.push(`prof:${p}`);
  names.push('cpi', 'gini');
  if (nc > 1) {
    for (let c = 0; c < nc; c++) names.push(`c:pop:${c}`, `c:money:${c}`, `c:gini:${c}`);
    for (let a = 0; a < nc; a++) for (let b = a + 1; b < nc; b++) names.push(`rel:${a}:${b}`);
  }
  return names;
}
// SPEC-GAP: d:trades, d:volume and d:drift are extra daily series beside the §C.4 list;
// d:fights and d:killed count clan fights.
const DAILY_NAMES = [
  'd:births', 'd:deaths', 'd:starved', 'd:immigrants', 'd:emigrants', 'd:mint', 'd:burn',
  'd:trades', 'd:volume', 'd:drift', 'd:fights', 'd:killed',
];

const EMPTY = Object.freeze([]);
const finite = (v) => (Number.isFinite(v) ? v : 0);
const refOf = (good) => CONFIG.goods[good]?.ref ?? 1;

/**
 * A fresh day record; every numeric field starts at 0 (§C.4).
 * SPEC-GAP: `turnover` (glim value of the day's trades) is an extra field.
 */
function newDayRecord() {
  const spend = {};
  for (const p of PURPOSES) spend[p] = 0;
  const stab = {};
  for (const k of STABILIZER_KINDS) stab[k] = 0;
  const spoiled = {};
  for (const g of GOODS) spoiled[g] = 0;
  return {
    mint: 0, gift: 0, immigration: 0,
    demurrage: 0, fee: 0, death: 0, emigration: 0, estate: 0,
    spend, stab, spoiled,
    births: 0, deaths: 0, starved: 0, killed: 0, immigrants: 0, emigrants: 0,
    trades: 0, volume: 0, turnover: 0,
  };
}

function netFlow(rec) {
  let net = 0;
  for (const k of SOURCES) net += finite(rec[k]);
  for (const k of SINKS) net -= finite(rec[k]);
  return net;
}

function sinkTotal(rec) {
  let s = 0;
  for (const k of SINKS) s += finite(rec[k]);
  return s;
}

/**
 * Fixed-capacity ring of samples for a set of named series that are always sampled together,
 * so one tick column serves them all.
 */
class SeriesRing {
  constructor(capacity, names) {
    this.capacity = Math.max(1, capacity | 0);
    this.ticks = new Float64Array(this.capacity);
    /** @type {Map<string, Float64Array>} */
    this.cols = new Map();
    for (const n of names) this.cols.set(n, new Float64Array(this.capacity));
    this.head = 0;
    this.size = 0;
  }

  col(name) {
    return this.cols.get(name) ?? null;
  }

  /** Starts the row for `tick` with every column zeroed and returns its slot. */
  open(tick) {
    const slot = this.head;
    this.ticks[slot] = tick;
    for (const c of this.cols.values()) c[slot] = 0;
    return slot;
  }

  close() {
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /** @returns {{ticks:number[], values:number[]}|null} oldest first, or null for an unknown name */
  read(name) {
    const col = this.cols.get(name);
    if (!col) return null;
    const n = this.size;
    const ticks = new Array(n);
    const values = new Array(n);
    let j = (this.head - n + this.capacity) % this.capacity;
    for (let i = 0; i < n; i++) {
      ticks[i] = this.ticks[j];
      values[i] = col[j];
      if (++j === this.capacity) j = 0;
    }
    return { ticks, values };
  }
}

/**
 * Money flows, the daily audit, indices, the Guild Board and chart histories.
 * Listens to MARKET_CHIME, AGENT_BORN, AGENT_DIED, AGENT_IMMIGRATED, AGENT_EMIGRATED, PLAYER_TOOL.
 */
export class Ledger {
  /** @param {object} sim the shared sim context (SPEC §C.1) */
  constructor(sim) {
    this.sim = sim;
    /** Flows and counts of the running day (see newDayRecord). */
    this.today = newDayRecord();
    /** The last finished day. */
    this.yesterday = newDayRecord();
    /** @type {Array<{tick:number, tool:string, glyph:string, label:string}>} player-tool chart markers */
    this.markers = [];
    /**
     * Result of the most recent daily money audit.
     * @type {null|{day:number, tick:number, Mstart:number, Mend:number, sources:number, sinks:number, drift:number, ok:boolean}}
     */
    this.lastAudit = null;
    const nm = Math.max(1, sim?.worldInfo?.markets?.length ?? 2);
    const nc = Math.max(1, sim?.clans?.count ?? 1);
    this._nm = nm;
    this._nc = nc;
    this._hourlyNames = hourlyNames(nm, nc);
    this.hourly = new SeriesRing(HOURLY_SAMPLES, this._hourlyNames);
    this.daily = new SeriesRing(DAILY_SAMPLES, DAILY_NAMES);

    this._M = 0;
    this._haze = 1;
    this._primed = false;
    this._started = false;
    this._Mstart = 0;
    /** Guild Board and mean income per clan (index = clan id). */
    this._guilds = null;
    this._meanYs = new Float64Array(nc);
    this._hourMint = 0;
    this._hourBurn = 0;
    this._hourVol = new Float64Array(GOODS.length);
    this._goodIndex = Object.create(null);
    GOODS.forEach((g, i) => { this._goodIndex[g] = i; });
    this._profIndex = Object.create(null);
    PROFESSIONS.forEach((p, i) => { this._profIndex[p] = i; });
    this._profCount = new Int32Array(PROFESSIONS.length);
    this._gWorkers = new Int32Array(PROFESSIONS.length * nc);
    this._gHist = new Int32Array(PROFESSIONS.length * nc);
    this._gSum = new Float64Array(PROFESSIONS.length * nc);
    this._scratch = new Float64Array(128);

    const H = this.hourly;
    const pairs = [];
    for (let a = 0; a < nc; a++) for (let b = a + 1; b < nc; b++) pairs.push({ a, b, col: H.col(`rel:${a}:${b}`) });
    this._h = {
      P: Array.from({ length: nm }, (_, m) => GOODS.map((g) => H.col(`P:${m}:${g}`))),
      Pavg: GOODS.map((g) => H.col(`P:avg:${g}`)),
      V: GOODS.map((g) => H.col(`V:${g}`)),
      prof: PROFESSIONS.map((p) => H.col(`prof:${p}`)),
      M: H.col('M'), Mstar: H.col('Mstar'), haze: H.col('haze'), mintH: H.col('mintH'), burnH: H.col('burnH'),
      pop: H.col('pop'), housed: H.col('housed'), towersLit: H.col('towersLit'), believers: H.col('believers'),
      cpi: H.col('cpi'), gini: H.col('gini'),
      cpop: nc > 1 ? Array.from({ length: nc }, (_, c) => H.col(`c:pop:${c}`)) : null,
      cmoney: nc > 1 ? Array.from({ length: nc }, (_, c) => H.col(`c:money:${c}`)) : null,
      cgini: nc > 1 ? Array.from({ length: nc }, (_, c) => H.col(`c:gini:${c}`)) : null,
      rel: pairs,
    };

    this._unsubs = [];
    this._subscribe(sim?.events);
  }

  // ---------------------------------------------------------------- flows

  /**
   * Records a money flow into `today[kind]`. Sources: mint, gift, immigration. Sinks: demurrage,
   * fee, death, emigration, estate. Transfers inside M must not be recorded.
   * @param {string} kind
   * @param {number} amount glim
   */
  record(kind, amount) {
    if (typeof kind !== 'string' || !Number.isFinite(amount) || amount === 0) return;
    const t = this.today;
    const cur = t[kind];
    // SPEC-GAP: an unknown kind is kept on the day record but stays outside the audit.
    if (cur === undefined) t[kind] = amount;
    else if (typeof cur === 'number') t[kind] = cur + amount;
    else return; // spend / stab / spoiled are tallies, not flows
    if (kind === 'mint') this._hourMint += amount;
    else if (SINK_SET.has(kind)) this._hourBurn += amount;
  }

  /**
   * Credits an agent's income for the day (sale, mint, wage…). Not a flow: the money itself is
   * moved (and, for mint, recorded) by the caller.
   * @param {object} agent
   * @param {number} amount glim
   * @param {string} [kind]
   */
  income(agent, amount, kind) { // eslint-disable-line no-unused-vars
    if (!agent || !Number.isFinite(amount)) return;
    agent.earnedToday = finite(agent.earnedToday) + amount;
  }

  /**
   * Books a purchase: input and arbitrage spending counts against the agent's net income, and
   * every purchase is tallied in `today.spend[purpose]`.
   * @param {object} agent
   * @param {number} amount glim
   * @param {string} purpose 'food'|'input'|'luxury'|'speculate'|'arbitrage'
   */
  expense(agent, amount, purpose) {
    if (!Number.isFinite(amount)) return;
    const p = typeof purpose === 'string' && purpose ? purpose : 'food';
    if (agent && INPUT_PURPOSES.has(p)) agent.inputsToday = finite(agent.inputsToday) + amount;
    const spend = this.today.spend;
    spend[p] = finite(spend[p]) + amount;
  }

  /**
   * Notes a stabilizer intervention in `today.stab[kind]` and emits STABILIZER for the Gazette.
   * @param {string} kind one of STABILIZER_KINDS
   * @param {number} [amount=1] kind-specific size (units, cells, hours…)
   * @param {Array} [message] Gazette message ([key, params]); the kind's default text when omitted
   */
  stabilizer(kind, amount, message) {
    const k = typeof kind === 'string' && kind ? kind : 'unknown';
    // SPEC-GAP: a call without an amount (e.g. `stabilizer('priceClamp')`) counts one occurrence.
    const a = amount === undefined ? 1 : finite(amount);
    const stab = this.today.stab;
    stab[k] = finite(stab[k]) + a;
    const text = message != null && message !== '' ? message : [`stab.${k}`];
    const events = this.sim?.events;
    if (events && EV.STABILIZER) events.emit(EV.STABILIZER, { kind: k, amount: a, message: text });
  }

  // ---------------------------------------------------------------- money aggregates

  /** M = Σ(glim + escrow) over living agents + Σ price of every unfinished project (§D.1). */
  moneySupply() {
    let M = 0;
    const agents = this._agents();
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a || a.alive === false) continue;
      M += finite(a.glim) + finite(a.escrow);
    }
    const prod = this.sim?.production;
    let projects = prod?.projects;
    if (!Array.isArray(projects) && typeof prod?.openProjects === 'function') projects = prod.openProjects();
    if (Array.isArray(projects)) {
      for (let i = 0; i < projects.length; i++) {
        const p = projects[i];
        if (p && (p.status === 'open' || p.status === 'claimed')) M += finite(p.price);
      }
    }
    return M;
  }

  /** Money supply M, cached each hour. */
  get M() {
    if (!this._primed) this._prime();
    return this._M;
  }

  /** Haze factor η = clamp(1 − M/(hazeK·pop), hazeMin, 1), cached each hour. */
  get haze() {
    if (!this._primed) this._prime();
    return this._haze;
  }

  /**
   * M* (§D.1): solves A·k·(1 − M/(hazeK·pop)) = r̄·M + feesYesterday, so
   * M* = (A·k − fees)/(r̄ + A·k/(hazeK·pop)) with k = mintPerHour·24/π.
   * @returns {number} glim (≥ 0)
   */
  equilibriumM() {
    const agents = this._agents();
    const pop = agents.length;
    if (pop === 0) return 0;
    const clans = this.sim?.clans;
    let rBar;
    if (!clans || (!clans.multi && clans.fadeMul(0) === 1)) {
      let housed = 0;
      for (let i = 0; i < pop; i++) if (agents[i] && agents[i].homeId != null) housed++;
      rBar = (housed * MONEY.demurrageHoused + (pop - housed) * MONEY.demurrageUnhoused) / pop;
    } else {
      // Each clan's law on fading money scales its members' demurrage.
      let sum = 0;
      for (let i = 0; i < pop; i++) {
        const a = agents[i];
        if (!a) continue;
        sum += (a.homeId != null ? MONEY.demurrageHoused : MONEY.demurrageUnhoused) * clans.fadeMul(a.clan ?? 0);
      }
      rBar = sum / pop;
    }
    const Ak = this._operatingTowerCount() * MONEY.mintPerHour * 24 / Math.PI;
    const denom = rBar + Ak / (MONEY.hazeK * pop);
    if (!(denom > 0)) return 0;
    const m = (Ak - finite(this.yesterday.fee)) / denom;
    return m > 0 ? m : 0;
  }

  // ---------------------------------------------------------------- indices

  /** Wax Index: 100·Σw·P̄ / Σw·ref over the §D.10 weights. */
  cpi() {
    const market = this.sim?.market;
    let num = 0;
    let den = 0;
    for (let i = 0; i < GOODS.length; i++) {
      const g = GOODS[i];
      const w = CPI_WEIGHTS[g] ?? 0;
      if (!(w > 0)) continue;
      const ref = refOf(g);
      num += w * this._avgPrice(market, g);
      den += w * ref;
    }
    return den > 0 ? (100 * num) / den : 100;
  }

  /** Gini coefficient of glim + escrow over living agents (0 = equal). */
  gini() {
    const x = this._sortedWealth();
    const n = x.length;
    if (n < 2) return 0;
    let sum = 0;
    let weighted = 0;
    for (let i = 0; i < n; i++) {
      sum += x[i];
      weighted += (i + 1) * x[i];
    }
    if (!(sum > 0)) return 0;
    const g = (2 * weighted) / (n * sum) - (n + 1) / n;
    return g < 0 ? 0 : g > 1 ? 1 : g;
  }

  /**
   * Lorenz curve of glim + escrow.
   * SPEC-GAP: returns n+1 points; L[i] is the share of wealth held by the poorest i/n of the
   * population (L[0] = 0, L[n] = 1), interpolated linearly inside an agent's share.
   * @param {number} [n=20]
   * @returns {Float32Array}
   */
  lorenz(n = 20) {
    const bins = Math.max(1, Math.floor(n) || 20);
    const out = new Float32Array(bins + 1);
    const x = this._sortedWealth();
    const N = x.length;
    let total = 0;
    for (let i = 0; i < N; i++) total += x[i];
    if (N === 0 || !(total > 0)) {
      for (let i = 0; i <= bins; i++) out[i] = i / bins;
      return out;
    }
    let j = 0;
    let cum = 0;
    for (let i = 0; i < bins; i++) {
      const pos = (i / bins) * N;
      while (j < N && j + 1 <= pos) cum += x[j++];
      const partial = j < N ? (pos - j) * x[j] : 0;
      out[i] = (cum + partial) / total;
    }
    out[bins] = 1;
    return out;
  }

  /**
   * SPEC-GAP (§D.10 helper): real wage = median of every agent's last daily net income / P̄tablet.
   * @returns {number}
   */
  realWage() {
    const agents = this._agents();
    const x = this._fill(agents.length, (a) => {
      const h = a.netHistory;
      return Array.isArray(h) && h.length ? finite(h[h.length - 1]) : 0;
    });
    const n = x.length;
    if (n === 0) return 0;
    x.sort();
    const median = n % 2 ? x[(n - 1) >> 1] : (x[n / 2 - 1] + x[n / 2]) / 2;
    const pt = this._avgPrice(this.sim?.market, 'tablet');
    return pt > 0 ? median / pt : 0;
  }

  // ---------------------------------------------------------------- Guild Board

  /**
   * The Guild Board (§D.7), rebuilt at every newday: per profession the head count, the actual
   * income (mean over workers of their mean last-2 net), the estimate from
   * `production.estimateIncome` and blended = w·actual + (1−w)·estimate with w = min(1, workers/4).
   * Each clan has its own board (its members' incomes at its own prices).
   * Treat the returned object as read-only.
   * @param {number} [clan=0]
   * @returns {{[prof:string]: {workers:number, actual:number, estimate:number, blended:number}}}
   */
  guild(clan = 0) {
    if (!this._guilds) this._rebuildGuild();
    return this._guilds[clan] || this._guilds[0];
  }

  /**
   * Mean daily income per Wickling of a clan, refreshed with the Guild Board.
   * SPEC-GAP: the worker-weighted mean of the professions' `actual` incomes, floored at 0 (a
   * profession without history contributes its estimate).
   * @param {number} [clan=0]
   * @returns {number} glim/day
   */
  meanY(clan = 0) {
    if (!this._guilds) this._rebuildGuild();
    return this._meanYs[clan] ?? this._meanYs[0];
  }

  // ---------------------------------------------------------------- history

  /**
   * A history series, oldest first: hourly `P:0:{good}`, `P:1:{good}`, `P:avg:{good}`, `V:{good}`,
   * `M`, `Mstar`, `haze`, `mintH`, `burnH`, `pop`, `housed`, `towersLit`, `believers`,
   * `prof:{prof}`, `cpi`, `gini`; daily `d:births`, `d:deaths`, `d:starved`, `d:immigrants`,
   * `d:emigrants`, `d:mint`, `d:burn` (+ `d:trades`, `d:volume`, `d:drift`). Unknown names are empty.
   * @param {string} name
   * @returns {{ticks:number[], values:number[]}}
   */
  getSeries(name) {
    return this.hourly.read(name) ?? this.daily.read(name) ?? { ticks: [], values: [] };
  }

  /** Names of every recorded series (hourly first). */
  seriesNames() {
    return [...this._hourlyNames, ...DAILY_NAMES];
  }

  // ---------------------------------------------------------------- tick

  /**
   * Runs after the Chime every tick. The first call snapshots M_start; hour ticks refresh M and
   * η and sample the hourly series; newday ticks close the day (nets, Guild Board, audit, roll-over).
   * @param {object} [sim]
   */
  tick(sim = this.sim) {
    const clock = sim?.clock;
    if (!clock) return;
    const tick = clock.tick;
    if (!this._started) this._start(tick);
    if (clock.isHourTick ?? tick % PER_HOUR === 0) {
      this._refreshMoney(true);
      this._sampleHourly(tick);
    }
    if (clock.isNewDayTick ?? tick % PER_DAY === 0) this._newDay(tick);
  }

  // ---------------------------------------------------------------- save files

  /** Flows, audit state, the Guild Boards and every chart history (as float32, oldest first). */
  serialize() {
    const ring = (R) => {
      const out = { size: R.size, ticks: null, cols: {} };
      out.ticks = typedToB64(Float64Array.from(R.read(R.cols.keys().next().value)?.ticks ?? []));
      for (const name of R.cols.keys()) out.cols[name] = typedToB64(Float32Array.from(R.read(name).values));
      return out;
    };
    const copy = (v) => JSON.parse(JSON.stringify(v));
    return {
      today: copy(this.today), yesterday: copy(this.yesterday), markers: copy(this.markers),
      lastAudit: this.lastAudit ? { ...this.lastAudit } : null,
      M: this._M, haze: this._haze, primed: this._primed, started: this._started, Mstart: this._Mstart,
      hourMint: this._hourMint, hourBurn: this._hourBurn, hourVol: Array.from(this._hourVol),
      guilds: this._guilds ? copy(this._guilds) : null, meanYs: Array.from(this._meanYs),
      hourly: ring(this.hourly), daily: ring(this.daily),
    };
  }

  /** Continue from saved books (see serialize). */
  restore(s) {
    if (!s) return;
    const day = (d) => {
      const out = newDayRecord();
      if (!d || typeof d !== 'object') return out;
      for (const k of Object.keys(d)) {
        const v = d[k];
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        else if (v && typeof v === 'object' && out[k] && typeof out[k] === 'object') {
          for (const j of Object.keys(v)) if (Number.isFinite(v[j])) out[k][j] = v[j];
        }
      }
      return out;
    };
    this.today = day(s.today);
    this.yesterday = day(s.yesterday);
    this.markers = Array.isArray(s.markers) ? s.markers.slice(-MAX_MARKERS) : [];
    this.lastAudit = s.lastAudit && typeof s.lastAudit === 'object' ? { ...s.lastAudit } : null;
    this._M = finite(s.M);
    this._haze = Number.isFinite(s.haze) ? s.haze : 1;
    this._primed = !!s.primed;
    this._started = !!s.started;
    this._Mstart = finite(s.Mstart);
    this._hourMint = finite(s.hourMint);
    this._hourBurn = finite(s.hourBurn);
    if (Array.isArray(s.hourVol)) for (let i = 0; i < this._hourVol.length; i++) this._hourVol[i] = finite(s.hourVol[i]);
    if (Array.isArray(s.guilds) && s.guilds.length === this._nc) this._guilds = s.guilds;
    if (Array.isArray(s.meanYs)) for (let c = 0; c < this._nc; c++) this._meanYs[c] = finite(s.meanYs[c]);
    const ring = (R, r) => {
      if (!r || !r.cols) return;
      const ticks = r.ticks ? b64ToTyped(r.ticks, Float64Array) : new Float64Array(0);
      const n = Math.min(ticks.length, R.capacity);
      const skip = ticks.length - n;
      for (let i = 0; i < n; i++) R.ticks[i] = ticks[skip + i];
      for (const [name, col] of R.cols) {
        col.fill(0);
        const src = r.cols[name] ? b64ToTyped(r.cols[name], Float32Array) : null;
        if (src) for (let i = 0; i < n && skip + i < src.length; i++) col[i] = src[skip + i];
      }
      R.size = n;
      R.head = n % R.capacity;
    };
    ring(this.hourly, s.hourly);
    ring(this.daily, s.daily);
  }

  /** Unsubscribes the ledger's event listeners. */
  dispose() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
  }

  // ---------------------------------------------------------------- internals

  _subscribe(events) {
    if (!events || typeof events.on !== 'function') return;
    const on = (name, fn) => {
      if (!name) return;
      const off = events.on(name, fn);
      this._unsubs.push(typeof off === 'function' ? off : () => events.off?.(name, fn));
    };
    on(EV.MARKET_CHIME, (p) => this._onChime(p));
    on(EV.AGENT_BORN, () => { this.today.births++; });
    on(EV.AGENT_DIED, (p) => {
      this.today.deaths++;
      if (p && p.cause === 'starved') this.today.starved++;
      if (p && p.cause === 'fight') this.today.killed++;
    });
    on(EV.AGENT_IMMIGRATED, () => { this.today.immigrants++; });
    on(EV.AGENT_EMIGRATED, () => { this.today.emigrants++; });
    on(EV.PLAYER_TOOL, (p) => this._onPlayerTool(p));
  }

  _onChime(payload) {
    const trades = payload?.trades;
    if (!Array.isArray(trades)) return;
    const t = this.today;
    t.trades += trades.length;
    for (let i = 0; i < trades.length; i++) {
      const tr = trades[i];
      if (!tr) continue;
      const q = finite(tr.qty);
      t.volume += q;
      t.turnover += q * finite(tr.price);
      const gi = this._goodIndex[tr.good];
      if (gi !== undefined) this._hourVol[gi] += q;
    }
  }

  _onPlayerTool(payload) {
    const p = payload || {};
    // `label` is a [key, params] message (rendered by the charts in the current language).
    this.markers.push({
      tick: this.sim?.clock?.tick ?? 0,
      tool: String(p.tool ?? ''),
      glyph: String(p.glyph ?? ''),
      label: p.label ?? [`tool.${p.tool}.name`],
    });
    if (this.markers.length > MAX_MARKERS) this.markers.splice(0, this.markers.length - MAX_MARKERS);
  }

  /** First tick: M, η, the Guild Board, a first chart sample and the audit's M_start. */
  _start(tick) {
    this._started = true;
    this._refreshMoney(false);
    // Flows already recorded today (spawn-time immigration, this tick's mint or sales) have
    // moved M before this snapshot; back them out so today's audit covers them. Only this tick's
    // not-yet-batched demurrage (a few hundredths of a glim) escapes the first day's audit.
    this._Mstart = this._M - netFlow(this.today);
    if (!this._guilds) this._rebuildGuild();
    // SPEC-GAP: an opening sample, so charts have a first point before the first hour tick.
    this._sampleHourly(tick);
  }

  /** Lazily computes M and η when read before the first tick (once agents exist). */
  _prime() {
    if (this._agents().length > 0) this._refreshMoney(false);
  }

  _refreshMoney(checkFloor) {
    const M = this.moneySupply();
    const pop = this._agents().length;
    const cap = MONEY.hazeK * pop;
    const raw = cap > 0 ? 1 - M / cap : (M > 0 ? -Infinity : 1);
    const lo = MONEY.hazeMin;
    this._M = M;
    this._haze = raw < lo ? lo : raw > 1 ? 1 : raw;
    this._primed = true;
    if (checkFloor && raw < lo) this.stabilizer('hazeFloor', 1, ['stab.hazeFloorOne', { eta: lo }]);
  }

  _sampleHourly(tick) {
    const H = this.hourly;
    const c = this._h;
    const slot = H.open(tick);
    const sim = this.sim;
    const market = sim?.market;

    for (let i = 0; i < GOODS.length; i++) {
      const g = GOODS[i];
      for (let m = 0; m < this._nm; m++) c.P[m][i][slot] = this._price(market, m, g);
      c.Pavg[i][slot] = this._avgPrice(market, g);
      c.V[i][slot] = this._hourVol[i];
      this._hourVol[i] = 0;
    }

    c.M[slot] = finite(this._M);
    c.Mstar[slot] = finite(this.equilibriumM());
    c.haze[slot] = finite(this._haze);
    c.mintH[slot] = finite(this._hourMint);
    c.burnH[slot] = finite(this._hourBurn);
    this._hourMint = 0;
    this._hourBurn = 0;

    const agents = this._agents();
    const counts = this._profCount;
    counts.fill(0);
    let housed = 0;
    let believers = 0;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a) continue;
      if (a.homeId != null) housed++;
      if (a.rumor) believers++;
      const pi = this._profIndex[a.profession];
      if (pi !== undefined) counts[pi]++;
    }
    const pop = sim?.population;
    if (typeof pop?.believerCount === 'function') believers = finite(pop.believerCount());
    c.pop[slot] = agents.length;
    c.housed[slot] = housed;
    c.believers[slot] = believers;
    for (let i = 0; i < PROFESSIONS.length; i++) c.prof[i][slot] = counts[i];
    c.towersLit[slot] = this._litTowerCount();
    c.cpi[slot] = finite(this.cpi());
    c.gini[slot] = finite(this.gini());
    if (c.cpop) {
      const clans = sim.clans;
      for (let k = 0; k < this._nc; k++) {
        const s = this.clanStats(k);
        c.cpop[k][slot] = s.pop;
        c.cmoney[k][slot] = s.money;
        c.cgini[k][slot] = s.gini;
      }
      for (const pr of c.rel) pr.col[slot] = clans ? finite(clans.relation(pr.a, pr.b)) : 0;
    }
    H.close();
  }

  /**
   * Live numbers for one clan: population, housed, money (glim + escrow), Gini of its members.
   * @param {number} clan
   * @returns {{pop:number, housed:number, money:number, gini:number}}
   */
  clanStats(clan) {
    const agents = this._agents();
    if (!this._clanBuf || this._clanBuf.length < agents.length) this._clanBuf = new Float64Array(Math.max(64, agents.length * 2));
    const buf = this._clanBuf;
    let n = 0;
    let housed = 0;
    let money = 0;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a || (a.clan ?? 0) !== clan) continue;
      const v = Math.max(0, finite(a.glim) + finite(a.escrow));
      buf[n++] = v;
      money += v;
      if (a.homeId != null) housed++;
    }
    let gini = 0;
    if (n >= 2 && money > 0) {
      const x = buf.subarray(0, n).sort();
      let weighted = 0;
      for (let i = 0; i < n; i++) weighted += (i + 1) * x[i];
      gini = Math.min(1, Math.max(0, (2 * weighted) / (n * money) - (n + 1) / n));
    }
    return { pop: n, housed, money, gini };
  }

  /** Newday: nets → Guild Board → money audit → daily series and roll-over. */
  _newDay(tick) {
    const agents = this._agents();
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a) continue;
      const net = finite(a.earnedToday) - finite(a.inputsToday);
      if (!Array.isArray(a.netHistory)) a.netHistory = [];
      a.netHistory.push(net);
      if (a.netHistory.length > NET_HISTORY_DAYS) a.netHistory.splice(0, a.netHistory.length - NET_HISTORY_DAYS);
      a.earnedToday = 0;
      a.inputsToday = 0;
    }
    this._rebuildGuild();
    this._audit(tick);
    this._sampleDaily(tick);
    this.yesterday = this.today;
    this.today = newDayRecord();
  }

  /** The daily money audit: drift = M_end − M_start − (sources − sinks). */
  _audit(tick) {
    const t = this.today;
    const Mend = this.moneySupply();
    let sources = 0;
    for (const k of SOURCES) sources += finite(t[k]);
    const sinks = sinkTotal(t);
    const drift = Mend - this._Mstart - (sources - sinks);
    const ok = Math.abs(drift) <= AUDIT_ABS_TOL + AUDIT_REL_TOL * Math.abs(Mend);
    const day = Math.max(0, Math.floor((tick - 1) / PER_DAY));
    this.lastAudit = { day, tick, Mstart: this._Mstart, Mend, sources, sinks, drift, ok };
    if (!ok) {
      console.warn(`[ledger] money audit, day ${day}: drift ${drift.toFixed(3)} glim `
        + `(M ${this._Mstart.toFixed(1)} → ${Mend.toFixed(1)}, sources ${sources.toFixed(1)}, sinks ${sinks.toFixed(1)})`);
    }
    this._Mstart = Mend;
  }

  _sampleDaily(tick) {
    const D = this.daily;
    const t = this.today;
    const slot = D.open(tick);
    const put = (name, v) => { D.col(name)[slot] = finite(v); };
    put('d:births', t.births);
    put('d:deaths', t.deaths);
    put('d:starved', t.starved);
    put('d:immigrants', t.immigrants);
    put('d:emigrants', t.emigrants);
    put('d:mint', t.mint);
    put('d:burn', sinkTotal(t));
    put('d:trades', t.trades);
    put('d:volume', t.volume);
    put('d:drift', this.lastAudit ? this.lastAudit.drift : 0);
    // The clans roll their day before the ledger's newday, so the finished day is `yesterday`.
    const cd = this.sim?.clans?.multi ? this.sim.clans.yesterday : null;
    let fights = 0;
    if (cd) for (let i = 0; i < cd.fights.length; i++) fights += cd.fights[i];
    put('d:fights', fights / 2);
    put('d:killed', t.killed);
    D.close();
  }

  _rebuildGuild() {
    const agents = this._agents();
    const np = PROFESSIONS.length;
    const nc = this._nc;
    const workers = this._gWorkers;
    const withHistory = this._gHist;
    const sums = this._gSum;
    workers.fill(0);
    withHistory.fill(0);
    sums.fill(0);
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const pi = a ? this._profIndex[a.profession] : undefined;
      if (pi === undefined) continue;
      const k0 = Math.min(nc - 1, Math.max(0, a.clan | 0)) * np + pi;
      workers[k0]++;
      const h = a.netHistory;
      if (!Array.isArray(h) || h.length === 0) continue;
      const k = Math.min(ACTUAL_DAYS, h.length);
      let s = 0;
      for (let j = h.length - k; j < h.length; j++) s += finite(h[j]);
      sums[k0] += s / k;
      withHistory[k0]++;
    }

    const prod = this.sim?.production;
    const boards = [];
    for (let c = 0; c < nc; c++) {
      const board = {};
      let yNum = 0;
      let yDen = 0;
      for (let i = 0; i < np; i++) {
        const prof = PROFESSIONS[i];
        const k0 = c * np + i;
        const estimate = typeof prod?.estimateIncome === 'function' ? finite(prod.estimateIncome(prof, c)) : 0;
        // SPEC-GAP: until some worker has a day of history, the estimate stands in for `actual`.
        const actual = withHistory[k0] > 0 ? sums[k0] / withHistory[k0] : estimate;
        const w = Math.min(1, workers[k0] / GUILD_FULL_WORKERS);
        board[prof] = { workers: workers[k0], actual, estimate, blended: w * actual + (1 - w) * estimate };
        yNum += workers[k0] * actual;
        yDen += workers[k0];
      }
      boards.push(board);
      const y = yDen > 0 ? yNum / yDen : 0;
      this._meanYs[c] = y > 0 ? y : 0;
    }
    this._guilds = boards;
  }

  /**
   * Towers counted as "lit" for M* (A in §D.1).
   * SPEC-GAP: A counts towers that are operated and hold a lens, not the instantaneous active
   * count, which drops to 0 every night while M* is a day-averaged equilibrium.
   */
  _operatingTowerCount() {
    const towers = this.sim?.production?.towers;
    if (!Array.isArray(towers)) return this._litTowerCount();
    let n = 0;
    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      if (t && t.operatorId != null && t.lensQ > 0) n++;
    }
    return n;
  }

  /** Towers minting right now. */
  _litTowerCount() {
    const prod = this.sim?.production;
    if (typeof prod?.activeTowerCount === 'function') return finite(prod.activeTowerCount());
    const towers = prod?.towers;
    if (!Array.isArray(towers)) return 0;
    let n = 0;
    for (let i = 0; i < towers.length; i++) if (towers[i]?.active) n++;
    return n;
  }

  /** glim + escrow of living agents, sorted ascending (a view into scratch; do not keep). */
  _sortedWealth() {
    const x = this._fill(this._agents().length, (a) => {
      const v = finite(a.glim) + finite(a.escrow);
      return v > 0 ? v : 0;
    });
    return x.sort();
  }

  /** Writes fn(agent) for every living agent into the scratch buffer; returns the filled view. */
  _fill(count, fn) {
    if (this._scratch.length < count) this._scratch = new Float64Array(Math.max(count, this._scratch.length * 2));
    const buf = this._scratch;
    const agents = this._agents();
    let n = 0;
    for (let i = 0; i < agents.length && n < buf.length; i++) {
      const a = agents[i];
      if (a && a.alive !== false) buf[n++] = fn(a);
    }
    return buf.subarray(0, n);
  }

  _price(market, m, good) {
    const p = typeof market?.price === 'function' ? market.price(m, good) : NaN;
    return Number.isFinite(p) && p > 0 ? p : refOf(good);
  }

  _avgPrice(market, good) {
    const p = typeof market?.avgPrice === 'function' ? market.avgPrice(good) : NaN;
    return Number.isFinite(p) && p > 0 ? p : refOf(good);
  }

  _agents() {
    const a = this.sim?.population?.agents;
    return Array.isArray(a) ? a : EMPTY;
  }
}
