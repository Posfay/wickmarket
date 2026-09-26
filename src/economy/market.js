/**
 * @file Market: the two plazas, their per-good order books and the hourly Chime, a
 * uniform-price call auction (SPEC §C.4 G4 market.js, §D.4–§D.6).
 *
 * Money handling (the ledger audits it daily, see ledger.js):
 *  - postBid moves qty·limit from glim to escrow (a transfer inside M). Bids live for exactly
 *    one Chime, so every Chime returns all remaining escrow to glim; cancelBids does the same.
 *  - A traded unit takes p* out of the buyer's escrow. The seller receives p*·(1−fee), `fee`
 *    burns p*·fee, and for estate lots the seller's share burns as `estate`.
 *  - An agent leaving the jar takes its escrow out of M, so onAgentRemoved burns it as `estate`.
 */
import { CONFIG, GOODS, TICKS } from '../core/config.js';
import { EV } from '../core/events.js';
import { addItem, removeItem, freeCapacity } from '../agents/agent.js';

/**
 * @typedef {{id:number, agentId:number, marketId:number, good:string, qty:number, limit:number,
 *   purpose:'food'|'input'|'luxury'|'speculate'|'arbitrage', postedTick:number}} Order
 * @typedef {{id:number, agentId:number, marketId:number, good:string, qty:number, ask:number,
 *   floor:number, postedTick:number}} Lot
 * @typedef {{price:number|null, volume:number, bestBid:number|null, bestAsk:number|null,
 *   unfilledQty:number, unsoldQty:number, sealed:'ceiling'|'floor'|null}} ClearResult
 * @typedef {{good:string, buyerId:number, sellerId:number, qty:number, price:number}} Trade
 */

const MC = CONFIG.market;
const EPS = 1e-6;
const ESTATE = -1;

// SPEC-GAP: new config key market.starterLots. The defaults are the SPEC §C.4 starter table,
// indexed by marketId (0 Sunward, 1 Dewside).
const STARTER_LOTS = CONFIG.market?.starterLots ?? [
  { tablet: 8, stone: 10, quartz: 8, log: 6, amber: 2, lantern: 2 },
  { berry: 20, tablet: 8, peat: 6 },
];
const DEFAULT_NAMES = ['Sunward', 'Dewside'];
const DEFAULT_KEYS = ['sunward', 'dewside'];
const EMPTY_BOOK = Object.freeze({ bids: Object.freeze([]), lots: Object.freeze([]) });

const refOf = (good) => CONFIG.goods[good]?.ref ?? 1;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Units are sorted per order/lot: every unit of an order shares its limit, tick and id, so
// sorting whole orders and walking them unit-by-unit is the same as expanding them.
let lotSortFloor = 0; // effective ask floor (floor seal) for the sort in progress
function byBidPriority(a, b) {
  return (b.limit - a.limit) || (a.postedTick - b.postedTick) || (a.id - b.id);
}
function byAskPriority(a, b) {
  return (Math.max(a.ask, lotSortFloor) - Math.max(b.ask, lotSortFloor))
    || (a.postedTick - b.postedTick) || (a.id - b.id);
}

/** Private per-agent market state (ADDENDUM §3: `agent._mk`). */
function mkState(agent) {
  let st = agent._mk;
  if (!st) {
    st = { bids: [] };
    agent._mk = st;
  } else if (!Array.isArray(st.bids)) {
    st.bids = [];
  }
  return st;
}

function removeFrom(arr, item) {
  const i = arr.indexOf(item);
  if (i >= 0) arr.splice(i, 1);
}

/**
 * Escrow is light locked in open bids (§C.2), so once an agent has none left, whatever escrow
 * remains (float residue from many partial fills) goes back to glim. Both sit inside M, so this
 * is audit-neutral.
 */
function releaseIdleEscrow(agent) {
  const e = agent.escrow;
  if (!Number.isFinite(e)) agent.escrow = 0;
  else if (e !== 0) {
    agent.glim += e;
    agent.escrow = 0;
  }
  if (agent.glim < 0 && agent.glim > -EPS) agent.glim = 0;
}

function beliefOf(agent, good) {
  const b = agent.beliefs?.[good];
  return b > 0 ? b : refOf(good);
}

function setBelief(agent, good, value) {
  const ref = refOf(good);
  const lo = MC.beliefClamp[0] * ref;
  const hi = MC.beliefClamp[1] * ref;
  if (!agent.beliefs) agent.beliefs = {};
  const v = Number.isFinite(value) ? value : ref;
  agent.beliefs[good] = v < lo ? lo : v > hi ? hi : v;
}

function safeAdd(agent, good, n) {
  try {
    const added = addItem(agent, good, n);
    if (added === true) return n;
    return added > 0 ? Math.min(n, Math.floor(added)) : 0;
  } catch {
    return 0;
  }
}

function safeFreeCapacity(agent) {
  try {
    const c = freeCapacity(agent);
    return Number.isFinite(c) ? c : 0;
  } catch {
    return 0;
  }
}

function emptyClear() {
  return { price: null, volume: 0, bestBid: null, bestAsk: null, unfilledQty: 0, unsoldQty: 0, sealed: null };
}

/** Normalises WorldInfo market sites, falling back to CONFIG.worldgen.marketSites. */
function normaliseSites(marketSites) {
  const raw = Array.isArray(marketSites) && marketSites.length
    ? marketSites.slice()
    : (CONFIG.worldgen?.marketSites ?? []).map((s, i) => ({ id: i, x: s.x, z: s.z }));
  if (raw.every((s) => Number.isInteger(s?.id))) raw.sort((a, b) => a.id - b.id);
  const half = CONFIG.worldgen?.plazaHalf ?? MC.plazaRadius;
  return raw.map((site, m) => {
    const s = site || {};
    const center = s.center
      ?? (s.plaza
        ? { x: Math.floor((s.plaza.x0 + s.plaza.x1) / 2), y: s.plaza.y ?? 0, z: Math.floor((s.plaza.z0 + s.plaza.z1) / 2) }
        : { x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0 });
    const plaza = s.plaza
      ?? { x0: center.x - half, z0: center.z - half, x1: center.x + half, z1: center.z + half, y: center.y };
    return {
      site: s, center, plaza, name: s.name ?? DEFAULT_NAMES[m] ?? `Plaza ${m}`, key: s.key ?? DEFAULT_KEYS[m] ?? `m${m}`,
      clan: Number.isInteger(s.clan) ? s.clan : 0,
    };
  });
}

/**
 * Order books, price discovery and the hourly Chime for both plazas.
 * `markets[m] = {site, books: {[good]: {bids, lots}}, P: {[good]}, last: {[good]: ClearResult}}`.
 */
export class Market {
  /**
   * @param {object} sim the shared sim context (SPEC §C.1)
   * @param {Array<object>} marketSites `worldInfo.markets`
   */
  constructor(sim, marketSites) {
    this.sim = sim;
    /** @type {Array<{id:number, site:object, name:string, key:string, center:{x:number,y:number,z:number},
     *   plaza:{x0:number,z0:number,x1:number,z1:number,y:number}, books:object, P:object, last:object}>} */
    this.markets = [];
    /** Debug stats: wall-clock ms spent in the last Chime (both plazas, excluding listeners). */
    this.stats = { chimeMs: 0, chimes: 0 };

    this._nextId = 1;
    this._bidAgent = new Map(); // orderId → Agent (still reachable after the agent is removed)
    this._eligibleBids = [];
    this._eligibleLots = [];
    this._lotSold = new Int32Array(64);
    this._payloads = [];
    this._piles = [];

    normaliseSites(marketSites).forEach((s, m) => {
      const books = {};
      const P = {};
      const last = {};
      const piles = {};
      for (const good of GOODS) {
        books[good] = { bids: [], lots: [] };
        P[good] = refOf(good);
        last[good] = emptyClear();
        piles[good] = 0;
      }
      this.markets.push({ id: m, site: s.site, name: s.name, key: s.key, clan: s.clan, center: s.center, plaza: s.plaza, books, P, last });
      this._piles.push(piles);
    });
    this._seedStarterLots();
  }

  // ---------------------------------------------------------------- price queries

  /** Public price P of `good` at plaza `m` (ref for an unknown plaza or good). */
  price(m, good) {
    const p = this.markets[m]?.P[good];
    return p > 0 ? p : refOf(good);
  }

  /** P̄: the mean of P over both plazas. */
  avgPrice(good) {
    const n = this.markets.length;
    if (!n) return refOf(good);
    let sum = 0;
    for (let m = 0; m < n; m++) sum += this.price(m, good);
    return sum / n;
  }

  /**
   * Nearest plaza by xz distance among those open to the agent (its clan may trade there) and not
   * considered blocked (`agent.marketBlockedUntil[m] > tick`); falls back to the nearest open one,
   * then the nearest overall.
   * @returns {number} marketId
   */
  nearestMarket(agent) {
    const pos = agent?.pos ?? agent?.cell;
    if (!pos || !this.markets.length) return 0;
    const tick = this._tick();
    const blocked = agent.marketBlockedUntil;
    const clans = this.sim?.clans;
    let best = -1;
    let bestD = Infinity;
    let any = -1;
    let anyD = Infinity;
    let far = 0;
    let farD = Infinity;
    for (let m = 0; m < this.markets.length; m++) {
      const c = this.markets[m].center;
      const dx = c.x + 0.5 - pos.x;
      const dz = c.z + 0.5 - pos.z;
      const d = dx * dx + dz * dz;
      if (d < farD) { farD = d; far = m; }
      if (clans && !clans.marketOpen(agent, m)) continue;
      if (d < anyD) { anyD = d; any = m; }
      if (!(blocked && blocked[m] > tick) && d < bestD) { bestD = d; best = m; }
    }
    return best >= 0 ? best : any >= 0 ? any : far;
  }

  // ---------------------------------------------------------------- plaza queries

  /** Plaza whose paving (plus a 1-cell rim) contains column (x, z), else null. */
  marketAt(x, z) {
    const cx = Math.floor(x);
    const cz = Math.floor(z);
    for (let m = 0; m < this.markets.length; m++) {
      const p = this.markets[m].plaza;
      if (cx >= p.x0 - 1 && cx <= p.x1 + 1 && cz >= p.z0 - 1 && cz <= p.z1 + 1) return m;
    }
    return null;
  }

  /** True when the agent's foot cell is within xz Chebyshev `plazaRadius + 1` of plaza m's centre. */
  isAtPlaza(agent, m) {
    const mk = this.markets[m];
    if (!mk || !agent || agent.alive === false) return false;
    let ax;
    let az;
    if (agent.cell) { ax = agent.cell.x; az = agent.cell.z; } else if (agent.pos) { ax = Math.floor(agent.pos.x); az = Math.floor(agent.pos.z); } else return false;
    const c = mk.center;
    return Math.max(Math.abs(ax - c.x), Math.abs(az - c.z)) <= MC.plazaRadius + 1;
  }

  // ---------------------------------------------------------------- orders

  /** Units the agent has bid for but not yet received (all goods, both plazas). */
  pendingBidQty(agent) {
    const bids = agent?._mk?.bids;
    if (!bids) return 0;
    let q = 0;
    for (let i = 0; i < bids.length; i++) q += bids[i].qty;
    return q;
  }

  /**
   * Posts a bid for the next Chime and escrows qty·limit.
   * Requires the agent at plaza m, `qty ≤ freeCapacity − pendingBidQty` and `qty·limit ≤ glim`.
   * @returns {number} orderId, or 0 when refused
   */
  postBid(agent, m, good, qty, limit, purpose) {
    if (!agent || agent.alive === false) return 0;
    const book = this.markets[m]?.books[good];
    if (!book) return 0;
    const n = Math.floor(qty);
    if (!(n >= 1) || !(limit > 0) || !Number.isFinite(limit)) return 0;
    if (!this.isAtPlaza(agent, m)) return 0;
    if (n > safeFreeCapacity(agent) - this.pendingBidQty(agent)) return 0;
    const cost = n * limit;
    if (!(cost <= agent.glim)) return 0;

    agent.glim -= cost;
    agent.escrow = (Number.isFinite(agent.escrow) ? agent.escrow : 0) + cost;
    const order = {
      id: this._nextId++, agentId: agent.id, marketId: m, good, qty: n, limit,
      purpose: purpose ?? 'food', postedTick: this._tick(),
    };
    const st = mkState(agent);
    book.bids.push(order);
    st.bids.push(order);
    this._bidAgent.set(order.id, agent);
    agent.openBids = st.bids.length;
    return order.id;
  }

  /**
   * Consigns up to `qty` held units, merged into the agent's existing lot for (m, good) and
   * capped at `maxLotQty` per lot. A merge takes the new ask and the lower floor.
   * @returns {number} lotId, or 0 when nothing was consigned
   */
  consign(agent, m, good, qty, ask, floor) {
    if (!agent || agent.alive === false) return 0;
    const book = this.markets[m]?.books[good];
    if (!book) return 0;
    const want = Math.floor(qty);
    if (!(want >= 1) || !(ask > 0) || !Number.isFinite(ask)) return 0;
    if (!this.isAtPlaza(agent, m)) return 0;
    const fl = floor > 0 && Number.isFinite(floor) ? floor : 0;
    // SPEC-GAP: an ask below its own floor could never trade at its ask; lift it to the floor.
    const effAsk = Math.max(ask, fl);

    let lot = null;
    for (let i = 0; i < book.lots.length; i++) {
      if (book.lots[i].agentId === agent.id) { lot = book.lots[i]; break; }
    }
    const held = Math.max(0, Math.floor(agent.inv?.[good] ?? 0));
    const n = Math.min(want, held, MC.maxLotQty - (lot ? lot.qty : 0));
    if (n <= 0) return 0;
    let removed = false;
    try { removed = removeItem(agent, good, n) !== false; } catch { removed = false; }
    if (!removed) return 0;

    const tick = this._tick();
    if (lot) {
      // SPEC-GAP: a merged lot's postedTick is the unit-weighted mean, so spoilage and
      // time priority neither reset nor ignore the older units.
      lot.postedTick = Math.round((lot.postedTick * lot.qty + tick * n) / (lot.qty + n));
      lot.qty += n;
      lot.ask = effAsk;
      lot.floor = Math.min(lot.floor, fl);
      return lot.id;
    }
    lot = { id: this._nextId++, agentId: agent.id, marketId: m, good, qty: n, ask: effAsk, floor: fl, postedTick: tick };
    book.lots.push(lot);
    return lot.id;
  }

  /** Cancels all of the agent's open bids, refunding their escrow to glim. */
  cancelBids(agent) {
    if (!agent) return;
    const st = agent._mk;
    if (st && Array.isArray(st.bids) && st.bids.length) {
      for (let i = 0; i < st.bids.length; i++) {
        const o = st.bids[i];
        this._unlinkOrder(o);
        const reserved = o.qty * o.limit;
        agent.escrow -= reserved;
        agent.glim += reserved;
      }
      st.bids.length = 0;
    }
    agent.openBids = 0;
    releaseIdleEscrow(agent);
  }

  /**
   * Cleanup for an agent leaving the jar (death or emigration): drops its bids and turns
   * its lots into estate lots.
   */
  onAgentRemoved(agent) {
    if (!agent) return;
    const st = agent._mk;
    if (st && Array.isArray(st.bids)) {
      for (let i = 0; i < st.bids.length; i++) this._unlinkOrder(st.bids[i]);
      st.bids.length = 0;
    }
    // SPEC-GAP: the escrow is burned as `estate` instead of being refunded to glim.
    // population.kill/emigrate settle `glim` only (heir share, death/emigration burn), and they
    // may do so before this call; a refund made after that settlement would leave M unrecorded.
    // Burning whatever escrow is still held keeps the money audit exact in either order.
    const e = Number.isFinite(agent.escrow) ? agent.escrow : 0;
    if (e > 0) this._record('estate', e);
    agent.escrow = 0;
    agent.openBids = 0;
    for (let m = 0; m < this.markets.length; m++) {
      const books = this.markets[m].books;
      for (let g = 0; g < GOODS.length; g++) {
        const lots = books[GOODS[g]].lots;
        for (let i = 0; i < lots.length; i++) if (lots[i].agentId === agent.id) lots[i].agentId = ESTATE;
      }
    }
  }

  // ---------------------------------------------------------------- book views

  /** Live order book of (m, good). Treat as read-only. */
  getBook(m, good) {
    return this.markets[m]?.books[good] ?? EMPTY_BOOK;
  }

  /** Units on lots per good at plaza m (a reused object; read it, do not keep it). */
  getPiles(m) {
    const mk = this.markets[m];
    const piles = this._piles[m];
    if (!mk || !piles) return {};
    for (let g = 0; g < GOODS.length; g++) {
      const lots = mk.books[GOODS[g]].lots;
      let q = 0;
      for (let i = 0; i < lots.length; i++) q += lots[i].qty;
      piles[GOODS[g]] = q;
    }
    return piles;
  }

  /** @returns {ClearResult|null} the result of the last Chime for (m, good) */
  getLastClear(m, good) {
    return this.markets[m]?.last[good] ?? null;
  }

  /** The Wax Seal in force on (m, good), read from `sim.effects.seals`, or null. */
  activeSeal(m, good) {
    const seals = this.sim?.effects?.seals;
    if (!seals || !seals.length) return null;
    const tick = this._tick();
    for (let i = seals.length - 1; i >= 0; i--) {
      const s = seals[i];
      if (s && Number(s.marketId) === m && s.good === good && s.untilTick > tick) return s;
    }
    return null;
  }

  // ---------------------------------------------------------------- tick & Chime

  /** Per-tick update: expires seals; on hour ticks runs the Chime at both plazas. */
  tick(sim = this.sim) {
    const clock = sim?.clock;
    if (!clock) return;
    this._expireSeals(clock.tick);
    const isHour = clock.isHourTick ?? clock.tick % TICKS.PER_HOUR === 0;
    if (isHour) this.clearAll();
  }

  /**
   * The Chime: spoils stale lots, clears every book at both plazas (§D.5, §D.6) and then emits
   * one MARKET_CHIME per plaza (listeners only ever see fully settled books).
   */
  clearAll() {
    const tick = this._tick();
    const t0 = now();
    const payloads = this._payloads;
    payloads.length = 0;
    for (let m = 0; m < this.markets.length; m++) {
      const trades = [];
      const cleared = {};
      // SPEC-GAP: spoilage runs before the auction, so `unsoldQty` is what stays on the pads.
      this._spoilLots(m, tick);
      for (let g = 0; g < GOODS.length; g++) cleared[GOODS[g]] = this._clearBook(m, GOODS[g], tick, trades);
      payloads.push({ marketId: m, tick, trades, cleared });
    }
    this.stats.chimeMs = now() - t0;
    this.stats.chimes++;
    const events = this.sim?.events;
    if (events) for (let i = 0; i < payloads.length; i++) events.emit(EV.MARKET_CHIME, payloads[i]);
    payloads.length = 0;
  }

  /** Clears one book (§D.5 steps 1–8) and returns its ClearResult. */
  _clearBook(m, good, tick, trades) {
    const mk = this.markets[m];
    const book = mk.books[good];
    const seal = this.activeSeal(m, good);
    const ceil = seal && seal.kind === 'ceiling' && seal.price > 0 ? seal.price : Infinity;
    const flo = seal && seal.kind === 'floor' && seal.price > 0 ? seal.price : 0;

    const E = this._eligibleBids;
    const L = this._eligibleLots;
    let unfilledQty = this._screenBids(m, book.bids, flo, tick, E);
    this._screenLots(book.lots, ceil, L);
    lotSortFloor = flo;
    E.sort(byBidPriority);
    L.sort(byAskPriority);

    // Step 4: k is the largest unit count with bid_k ≥ ask_k.
    let k = 0;
    let bidK = 0;
    let askK = 0;
    for (let i = 0, j = 0, ri = E.length ? E[0].qty : 0, rj = L.length ? L[0].qty : 0; i < E.length && j < L.length;) {
      const b = E[i].limit;
      const a = Math.max(L[j].ask, flo);
      if (b < a) break;
      const n = Math.min(ri, rj);
      k += n;
      bidK = b;
      askK = a;
      ri -= n;
      rj -= n;
      if (ri === 0 && ++i < E.length) ri = E[i].qty;
      if (rj === 0 && ++j < L.length) rj = L[j].qty;
    }
    let p = 0;
    if (k > 0) p = Math.max(Math.min((bidK + askK) / 2, ceil), flo);

    const bestBid = E.length ? E[0].limit : null;
    const bestAsk = L.length ? Math.max(L[0].ask, flo) : null;
    const hasBids = E.length > 0;
    const hasLots = L.length > 0;

    const settled = this._settle(m, good, p, k, tick, E, L, trades);
    unfilledQty += settled.unfilled;
    this._learnSellers(good, p, L, book.lots, ceil);

    E.length = 0;
    L.length = 0;
    book.bids.length = 0; // every bid has been finished (filled, refunded or dropped)
    let unsoldQty = 0;
    let w = 0;
    for (let i = 0; i < book.lots.length; i++) {
      const lot = book.lots[i];
      if (lot.qty > 0) { book.lots[w++] = lot; unsoldQty += lot.qty; }
    }
    book.lots.length = w;

    this._updatePrice(mk, good, k, p, hasBids, hasLots, bestBid, bestAsk);
    // SPEC-GAP: `volume` counts units actually delivered (k minus any capacity refusals);
    // `sealed` is the seal kind or null.
    const result = {
      price: k > 0 ? p : null, volume: settled.volume, bestBid, bestAsk,
      unfilledQty, unsoldQty, sealed: seal ? seal.kind : null,
    };
    mk.last[good] = result;
    return result;
  }

  /**
   * Steps 1–2 for bids: drops dead/absent bidders (refunded, unfilled), finishes bids below a
   * floor seal as unfilled, and collects the rest into `out`. Returns the units dropped.
   */
  _screenBids(m, bids, flo, tick, out) {
    let unfilled = 0;
    out.length = 0;
    const clans = this.sim?.clans;
    const multi = !!clans?.multi;
    for (let i = 0; i < bids.length; i++) {
      const o = bids[i];
      const agent = this._bidAgent.get(o.id) ?? this._agentById(o.agentId);
      if (!agent || agent.alive === false) {
        unfilled += o.qty;
        this._dropOrphanOrder(o, agent);
      } else if (!this.isAtPlaza(agent, m) || (multi && !clans.marketOpen(agent, m))) {
        // Gone from the plaza, or its clan is no longer welcome here (a quarrel since it bid).
        unfilled += o.qty;
        this._finishOrder(agent, o, 0, 0, 0, tick, false);
      } else if (o.limit < flo) {
        unfilled += o.qty;
        this._finishOrder(agent, o, 0, 0, 0, tick, true);
      } else {
        out.push(o);
      }
    }
    return unfilled;
  }

  /** Step 2 for lots: dead sellers' lots become estate lots; lots above a ceiling sit out. */
  _screenLots(lots, ceil, out) {
    out.length = 0;
    for (let i = 0; i < lots.length; i++) {
      const lot = lots[i];
      if (lot.agentId !== ESTATE) {
        const seller = this._agentById(lot.agentId);
        if (!seller || seller.alive === false) lot.agentId = ESTATE;
      }
      if (lot.qty > 0 && lot.ask <= ceil) out.push(lot);
    }
  }

  /**
   * Steps 5–6: walks the k matched unit pairs in order, delivering goods and moving money per
   * (order, lot) segment, then finishes every eligible order. `this._lotSold[j]` receives the
   * units sold from L[j].
   */
  _settle(m, good, p, k, tick, E, L, trades) {
    if (this._lotSold.length < L.length) this._lotSold = new Int32Array(Math.max(L.length, this._lotSold.length * 2));
    const sold = this._lotSold;
    sold.fill(0, 0, L.length);
    let unfilled = 0;
    let volume = 0;
    let left = k;
    let j = 0;
    let rj = L.length ? L[0].qty : 0;
    for (let i = 0; i < E.length; i++) {
      const o = E[i];
      const buyer = this._bidAgent.get(o.id) ?? this._agentById(o.agentId);
      let want = Math.min(o.qty, left);
      left -= want;
      let filled = 0;
      let spent = 0;
      let full = false;
      while (want > 0 && j < L.length) {
        const lot = L[j];
        const n = Math.min(want, rj);
        const added = full ? 0 : safeAdd(buyer, good, n);
        if (added < n) full = true; // the buyer's capacity is exhausted; its later units refund
        if (added > 0) {
          this._trade(buyer, o, lot, good, added, p, trades);
          filled += added;
          spent += added * p;
          sold[j] += added;
        }
        want -= n;
        rj -= n;
        if (rj === 0 && ++j < L.length) rj = L[j].qty;
      }
      volume += filled;
      unfilled += o.qty - filled;
      this._finishOrder(buyer, o, filled, spent, p, tick, true);
    }
    return { unfilled, volume };
  }

  /** Moves goods and money for `n` units from `lot` to the buyer of order `o` at price p. */
  _trade(buyer, o, lot, good, n, p, trades) {
    const gross = n * p;
    const fee = gross * MC.fee;
    let net = gross - fee;
    this._updateCostBasis(buyer, good, n, gross);
    lot.qty -= n;
    const ledger = this.sim?.ledger;
    ledger?.expense(buyer, gross, o.purpose);
    let seller = lot.agentId === ESTATE ? null : this._agentById(lot.agentId);
    if (seller && seller.alive === false) seller = null;
    if (seller) {
      // A foreign seller may owe the host clan's border tax (burned like the fee).
      const tax = this.sim?.clans ? this.sim.clans.taxRate(seller.clan, lot.marketId) : 0;
      if (tax > 0) {
        const duty = gross * tax;
        net -= duty;
        this._record('fee', duty);
      }
      seller.glim += net;
      ledger?.income(seller, net, 'sale');
    } else {
      lot.agentId = ESTATE;
      this._record('estate', net);
    }
    this._record('fee', fee);
    trades.push({ good, buyerId: buyer.id, sellerId: seller ? seller.id : ESTATE, qty: n, price: p });
  }

  /** costBasis = average purchase cost per held unit (the units were just added to inv). */
  _updateCostBasis(agent, good, n, gross) {
    if (!agent.costBasis) agent.costBasis = {};
    const heldBefore = Math.max(0, Math.floor(agent.inv?.[good] ?? n) - n);
    const prev = agent.costBasis[good];
    agent.costBasis[good] = heldBefore > 0 && prev > 0
      ? (prev * heldBefore + gross) / (heldBefore + n)
      : gross / n;
  }

  /**
   * Step 6 for one order: releases its escrow (spent part paid, the rest refunded), applies
   * buyer learning (§D.6) when `learn`, and writes `chimeResult`.
   */
  _finishOrder(agent, o, filled, spent, p, tick, learn) {
    const reserved = o.qty * o.limit;
    agent.escrow -= reserved;
    agent.glim += reserved - spent;

    if (learn) {
      const b = beliefOf(agent, o.good);
      if (filled > 0) setBelief(agent, o.good, b + MC.learnFill * (p - b));
      else setBelief(agent, o.good, Math.min(b * MC.unfilledBidMul, MC.beliefClamp[1] * refOf(o.good)));
    }

    let cr = agent.chimeResult;
    if (!cr || cr.tick !== tick) {
      cr = { tick, marketId: o.marketId, bought: {}, spent: 0, unfilled: {} };
      agent.chimeResult = cr;
    }
    if (filled > 0) cr.bought[o.good] = (cr.bought[o.good] ?? 0) + filled;
    if (o.qty > filled) cr.unfilled[o.good] = (cr.unfilled[o.good] ?? 0) + (o.qty - filled);
    cr.spent += spent;

    // Only called from inside a Chime, which empties the whole book afterwards: splicing
    // book.bids here would corrupt the loop that is walking it.
    this._bidAgent.delete(o.id);
    const st = mkState(agent);
    removeFrom(st.bids, o);
    agent.openBids = st.bids.length;
    if (st.bids.length === 0) releaseIdleEscrow(agent);
  }

  /**
   * A bid whose agent is gone. Normally onAgentRemoved already removed it; if not, the
   * agent's escrow left the money supply with it, so the reserve is burned as `estate`.
   */
  _dropOrphanOrder(o, agent) {
    this._bidAgent.delete(o.id);
    const reserved = o.qty * o.limit;
    if (!agent) {
      this._record('estate', reserved);
      return;
    }
    const burn = Math.min(reserved, Math.max(0, Number.isFinite(agent.escrow) ? agent.escrow : 0));
    agent.escrow -= burn;
    this._record('estate', burn);
    const st = agent._mk;
    if (st && Array.isArray(st.bids)) removeFrom(st.bids, o);
    agent.openBids = st?.bids?.length ?? 0;
    if (!agent.openBids || Math.abs(agent.escrow) < EPS) agent.escrow = 0;
  }

  /**
   * §D.6 seller side: filled sellers learn toward p* (sold out: ×soldOutMul); unsold lots
   * decay their ask toward the floor and nudge the seller's belief down. Lots excluded by a
   * ceiling seal count as unsold.
   */
  _learnSellers(good, p, L, lots, ceil) {
    const sold = this._lotSold;
    for (let j = 0; j < L.length; j++) this._learnLot(L[j], good, p, sold[j]);
    if (ceil !== Infinity) {
      // Eligible lots all had ask ≤ ceil and decay only lowers asks, so ask > ceil still
      // identifies exactly the lots the ceiling excluded.
      for (let i = 0; i < lots.length; i++) if (lots[i].qty > 0 && lots[i].ask > ceil) this._learnLot(lots[i], good, p, 0);
    }
  }

  _learnLot(lot, good, p, soldUnits) {
    const seller = lot.agentId === ESTATE ? null : this._agentById(lot.agentId);
    const live = seller && seller.alive !== false;
    if (soldUnits > 0) {
      if (!live) return;
      let b = beliefOf(seller, good);
      b += MC.learnFill * (p - b);
      if (lot.qty <= 0) b *= MC.soldOutMul;
      setBelief(seller, good, b);
      return;
    }
    lot.ask = Math.max(lot.floor, lot.ask * MC.lotAskDecay);
    if (live) setBelief(seller, good, Math.max(beliefOf(seller, good) * MC.unsoldAskMul, MC.beliefClamp[0] * refOf(good)));
  }

  /** Step 7: public price update and clamp (a clamp hit is a visible stabilizer). */
  _updatePrice(mk, good, k, p, hasBids, hasLots, bestBid, bestAsk) {
    const ref = refOf(good);
    let P = mk.P[good] > 0 ? mk.P[good] : ref;
    if (k > 0) P = (1 - MC.smoothing) * P + MC.smoothing * p;
    else if (hasBids && !hasLots) P *= MC.noAskRise;
    else if (hasLots && !hasBids) P *= MC.noBidDecay;
    else if (hasBids && hasLots) P += MC.crossPull * ((bestBid + bestAsk) / 2 - P);

    const lo = MC.clamp[0] * ref;
    const hi = MC.clamp[1] * ref;
    let bound = null;
    if (!(P >= lo)) { P = lo; bound = 'floor'; } else if (P > hi) { P = hi; bound = 'ceiling'; }
    mk.P[good] = P;
    if (bound) {
      this.sim?.ledger?.stabilizer('priceClamp', 1, ['stab.clampOne', { good, bound, price: P, m: mk.id }]);
    }
  }

  /** Removes lots older than the good's `lotSpoilHours`, counting the units as spoiled. */
  _spoilLots(m, tick) {
    const books = this.markets[m].books;
    for (let g = 0; g < GOODS.length; g++) {
      const good = GOODS[g];
      const hours = CONFIG.goods[good]?.lotSpoilHours;
      if (!(hours > 0)) continue;
      const maxAge = hours * TICKS.PER_HOUR;
      const lots = books[good].lots;
      let spoiled = 0;
      let w = 0;
      for (let i = 0; i < lots.length; i++) {
        const lot = lots[i];
        if (tick - lot.postedTick >= maxAge) spoiled += lot.qty;
        else lots[w++] = lot;
      }
      lots.length = w;
      const rec = spoiled > 0 ? this.sim?.ledger?.today?.spoiled : null;
      if (rec) rec[good] = (rec[good] ?? 0) + spoiled;
    }
  }

  /** Drops seals whose time has passed from `sim.effects.seals` (in place). */
  _expireSeals(tick) {
    const seals = this.sim?.effects?.seals;
    if (!seals || !seals.length) return;
    let w = 0;
    for (let i = 0; i < seals.length; i++) {
      const s = seals[i];
      if (s && s.untilTick > tick) seals[w++] = s;
    }
    seals.length = w;
  }

  // ---------------------------------------------------------------- save files

  /**
   * Prices, last Chime results and lots on the pads. Open bids are not saved (they last one
   * Chime; the population counts their escrow back into glim).
   */
  serialize() {
    return {
      nextId: this._nextId,
      markets: this.markets.map((mk) => {
        const lots = [];
        for (const good of GOODS) {
          for (const l of mk.books[good].lots) lots.push([l.id, l.agentId, good, l.qty, l.ask, l.floor, l.postedTick]);
        }
        const last = {};
        for (const good of GOODS) last[good] = { ...mk.last[good] };
        return { P: { ...mk.P }, last, lots };
      }),
    };
  }

  /** Replace books and prices with saved ones (see serialize). */
  restore(s) {
    if (!s || !Array.isArray(s.markets)) return;
    this._bidAgent.clear();
    let maxId = 0;
    s.markets.forEach((ms, m) => {
      const mk = this.markets[m];
      if (!mk || !ms) return;
      for (const good of GOODS) {
        mk.books[good].bids.length = 0;
        mk.books[good].lots.length = 0;
        const p = ms.P?.[good];
        if (p > 0 && Number.isFinite(p)) mk.P[good] = p;
        if (ms.last?.[good]) mk.last[good] = { ...emptyClear(), ...ms.last[good] };
      }
      for (const row of Array.isArray(ms.lots) ? ms.lots : []) {
        const [id, agentId, good, qty, ask, floor, postedTick] = row;
        const book = mk.books[good];
        if (!book || !(qty > 0) || !(ask > 0)) continue;
        book.lots.push({
          id: id | 0, agentId: Number.isInteger(agentId) ? agentId : ESTATE, marketId: m, good, qty: Math.floor(qty),
          ask, floor: floor > 0 ? floor : 0, postedTick: Number.isFinite(postedTick) ? postedTick : this._tick(),
        });
        if (id > maxId) maxId = id;
      }
    });
    this._nextId = Math.max(Number.isInteger(s.nextId) ? s.nextId : 1, maxId + 1);
  }

  // ---------------------------------------------------------------- helpers

  _seedStarterLots() {
    const tick = this._tick();
    const clans = this.sim?.clans;
    for (let m = 0; m < this.markets.length; m++) {
      let table = STARTER_LOTS[m];
      if (clans?.multi) {
        // Every clan market opens with a mixed stock, scaled to the clan's size.
        const k = (clans.list[this.markets[m].clan]?.initial ?? 20) / 30;
        const base = CONFIG.clans?.starterLots ?? {};
        table = {};
        for (const g of GOODS) table[g] = Math.round((base[g] ?? 0) * k);
      }
      if (!table) continue;
      for (const good of GOODS) {
        const qty = Math.floor(table[good] ?? 0);
        if (qty <= 0) continue;
        const ref = refOf(good);
        this.markets[m].books[good].lots.push({
          id: this._nextId++, agentId: ESTATE, marketId: m, good, qty, ask: ref, floor: 0.5 * ref, postedTick: tick,
        });
      }
    }
  }

  /** Removes an order from its book and the order→agent index (not from the agent's list). */
  _unlinkOrder(o) {
    this._bidAgent.delete(o.id);
    const bids = this.markets[o.marketId]?.books[o.good]?.bids;
    if (bids) removeFrom(bids, o);
  }

  _agentById(id) {
    const pop = this.sim?.population;
    if (!pop || id == null || id < 0) return null;
    if (pop.byId && typeof pop.byId.get === 'function') return pop.byId.get(id) ?? null;
    return typeof pop.get === 'function' ? pop.get(id) ?? null : null;
  }

  _record(kind, amount) {
    if (amount > 0) this.sim?.ledger?.record(kind, amount);
  }

  _tick() {
    return this.sim?.clock?.tick ?? 0;
  }
}
