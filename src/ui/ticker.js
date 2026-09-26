/**
 * @file The news ticker (SPEC §F Gazette, §C.3 TICKER, §C.4 G6).
 *
 * Headlines come from three places:
 *  - `post(message, kind, pos?)` and the `TICKER` event (any module);
 *  - event rules evaluated here (price moves with guessed causes, job changes, the morning
 *    summary, new buildings, towers going dark or lit, smugglers, price-seal queues, rumors,
 *    panic, clan wars and fights, safety nets in grey, player actions in gold);
 *  - the evening bell line.
 * Every line is stored as a message (`[key, params]`, see src/core/i18n.js) and rendered in the
 * current language, so switching the language rewrites the whole list, and saves keep the news.
 * Event handlers run inside the sim tick, so they only queue; the DOM is written in `update()`.
 * Line nodes are recycled: the list never holds more than `CONFIG.ui.tickerMax` elements.
 */
import { CONFIG, TICKS, GOODS, PROFESSIONS } from '../core/config.js';
import { EV } from '../core/events.js';
import { t, tr, onLangChange } from '../core/i18n.js';
import { placeOf } from './place.js';

const PER_HOUR = TICKS?.PER_HOUR ?? 100;
const PER_DAY = TICKS?.PER_DAY ?? 2400;
const KINDS = new Set(['econ', 'labor', 'life', 'world', 'player', 'stabilizer', 'alert', 'clan']);
const RING = 25;                                      // now + 24 hourly samples back

const PRICE_MOVE = 0.30;                              // |P̄/P̄_24h − 1| threshold
const PRICE_MOVE_GAP = 12 * PER_HOUR;                 // at most one per good per 12 h
const PRICE_MIN_HISTORY = 6;                          // hours of history before judging a move
const RUMOR_GAP = 6 * PER_HOUR;
const RUMOR_MIN = 5;
const STAB_GAP = 6 * PER_HOUR;
const SEAL_QUEUE = 10;
// SPEC-GAP: seal-queue headlines repeat at most every 6 h per (plaza, good); §F gives no rate.
const SEAL_GAP = 6 * PER_HOUR;
const LABOR_MIN = 3;
const LABOR_QUIET = 5;                                // ticks without a new switch = the wave is over
const TOWERS_HIGH = 5;
const TOWERS_LOW = 2;
const DUSK_HOUR = 18;
const FIGHT_GAP = 2 * PER_HOUR;                       // fight summaries per clan pair

/** Professions whose head-count moves a good's price (producers and big consumers). */
const GOOD_PROFS = {
  berry: ['tender', 'chandler'], tablet: ['chandler'], peat: ['woodwarden', 'chandler'],
  log: ['woodwarden', 'mason'], stone: ['delver', 'mason'], quartz: ['delver', 'lenswright'],
  amber: ['delver', 'woodwarden', 'chandler'], lantern: ['chandler'],
};
/** Desk tools that plausibly move a good's price (a marker naming the good wins outright). */
const TOOL_GOODS = {
  geode: ['quartz', 'amber', 'lantern'], cupped: ['quartz'], magnifier: ['berry', 'lantern'],
  tap: ['berry', 'tablet', 'lantern'], pipette: ['berry'], pane: GOODS, seal: [], whisper: [], clans: GOODS,
};

// ---------------------------------------------------------------- helpers

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const pad2 = (n) => (n < 10 ? '0' + n : String(n));

function clockText(tick) {
  const tk = Math.max(0, Math.floor(num(tick)));
  const inDay = tk % PER_DAY;
  return `${pad2(Math.floor(inDay / PER_HOUR))}:${pad2(Math.floor(((inDay % PER_HOUR) * 60) / PER_HOUR))}`;
}

function stamp(tick) {
  return t('gz.stamp', { d: Math.floor(Math.max(0, num(tick)) / PER_DAY) + 1, time: clockText(tick) });
}

function el(tag, cls, text, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** A message from anything: [key, params] stays, {k, p} becomes [k, p], text stays text. */
function asMessage(m) {
  if (Array.isArray(m)) return m;
  if (m && typeof m === 'object' && typeof m.k === 'string') return [m.k, m.p];
  return m == null ? '' : String(m);
}

const sameMessage = (a, b) => (typeof a === 'string' || typeof b === 'string' ? a === b : JSON.stringify(a) === JSON.stringify(b));

// ---------------------------------------------------------------- Ticker

/**
 * The news list. Newest line on top, `tickerVisible` shown, older lines fading;
 * clicking a line with a position flies the camera there.
 */
export class Ticker {
  /** @param {object} sim the shared sim context (SPEC §C.1) */
  constructor(sim) {
    this.sim = sim;
    const ui = sim.config?.ui ?? CONFIG.ui ?? {};
    this.max = Math.max(1, num(ui.tickerMax, 40));
    this.visible = Math.max(1, Math.min(this.max, num(ui.tickerVisible, 7)));
    this._period = 1 / Math.max(0.5, num(ui.hudHz, 4));
    this._acc = this._period;
    this._errors = 0;
    this._expanded = false;

    /** Newest first: {node, stampEl, textEl, msg, kind, pos, rep, tick}. */
    this.lines = [];
    this._queue = [];
    this._unsubs = [];

    // Hourly samples for causal headlines.
    this._pRing = new Float32Array(GOODS.length * RING);
    this._profRing = new Int16Array(PROFESSIONS.length * RING);
    this._ringCount = 0;
    this._ringHead = 0;
    this._lastPriceMove = new Float64Array(GOODS.length).fill(-Infinity);
    this._lastRumor = new Float64Array(GOODS.length).fill(-Infinity);
    this._believers = new Int16Array(GOODS.length * 2);
    this._believerXZ = new Float64Array(GOODS.length * 2);
    this._marks = [];                                   // recent player actions {tick, tool, good}
    this._labor = new Map();                            // to-profession → wave bucket
    this._life = { born: 0, aged: 0, starved: 0, killed: 0, emigrated: 0, immigrated: 0 };
    this._dawnDay = null;
    this._towerState = null;
    this._sealLast = new Map();
    this._stab = new Map();
    this._dusk = { tick: -1, units: 0, markets: 0 };
    this._lastStarvePost = -Infinity;
    this._fights = new Map();                           // "a:b" → {n, killed, stolen, last, pos}
    this._tradedPairs = new Set();

    this._buildDom();
    this._subscribe();
    this._unsubs.push(onLangChange(() => this.relabel()));
  }

  /**
   * Queues a headline (written to the DOM on the next `update`).
   * @param {Array|string} message a [key, params] message (or plain text)
   * @param {string} [kind='world'] econ, labor, life, world, player, stabilizer, alert or clan
   * @param {{x:number, y?:number, z:number}|null} [pos] clicking the line flies here
   */
  post(message, kind = 'world', pos = null) {
    const msg = asMessage(message);
    if (msg === '' || (Array.isArray(msg) && !msg.length)) return;
    const k = KINDS.has(kind) ? kind : 'world';
    const p = pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)
      ? { x: pos.x, y: Number.isFinite(pos.y) ? pos.y : null, z: pos.z } : null;
    this._queue.push({ msg, kind: k, pos: p, tick: this._tick() });
    if (this._queue.length > this.max) this._queue.splice(0, this._queue.length - this.max);
  }

  /**
   * Per-frame hook: flushes queued headlines, then (at `hudHz`) closes job waves, the morning
   * summary, fight summaries and safety-net aggregates and refreshes the date.
   * @param {number} realDt real seconds since the last frame
   */
  update(realDt) {
    try {
      if (this._queue.length) this._flush();
      const dt = Number.isFinite(realDt) && realDt > 0 ? Math.min(realDt, 1) : 0;
      this._acc += dt;
      if (this._acc < this._period) return;
      this._acc = 0;
      this._checkLabor();
      this._checkDawn();
      this._checkStabilizers();
      this._checkFightSummaries();
      if (this._queue.length) this._flush();
      this._refreshHead();
    } catch (err) {
      if (this._errors++ < 3) console.error('[ticker] update failed', err);
    }
  }

  /** Removes the event subscriptions (the DOM stays). */
  dispose() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
  }

  /** The visible news, oldest last, for save files. */
  serialize() {
    return this.lines.map((l) => ({ msg: l.msg, kind: l.kind, pos: l.pos, tick: l.tick, rep: l.rep }));
  }

  /** Put saved news back (see serialize). */
  restore(list) {
    if (!Array.isArray(list)) return;
    for (let i = Math.min(list.length, this.max) - 1; i >= 0; i--) {
      const s = list[i];
      if (!s) continue;
      this._render({ msg: asMessage(s.msg), kind: KINDS.has(s.kind) ? s.kind : 'world', pos: s.pos || null, tick: num(s.tick) });
      if (s.rep > 1) {
        this.lines[0].rep = s.rep;
        this._paint(this.lines[0]);
      }
    }
    this._restyle();
  }

  /** Re-render every line and label in the current language. */
  relabel() {
    this.$title.textContent = t('gz.title');
    this.$more.dataset.tip = t('gz.moreTip');
    if (this.$empty) this.$empty.textContent = t('gz.empty');
    for (const line of this.lines) this._paint(line);
    this.$date._wmText = null;
    this._refreshHead();
    this._refreshMore();
  }

  // ================================================================ DOM

  _buildDom() {
    let root = document.getElementById('ui-root');
    if (!root) {
      root = el('div', null, null, document.body);
      root.id = 'ui-root';
    }
    let g = document.getElementById('gazette');
    if (!g) {
      g = el('section', null, null, root);
      g.id = 'gazette';
    }
    g.classList.add('wm-card', 'wm-gazette');
    g.textContent = '';
    this.$root = g;
    const head = el('div', 'gz-head', null, g);
    this.$title = el('h2', 'wm-h gz-title', t('gz.title'), head);
    this.$date = el('span', 'gz-date', '', head);
    this.$more = el('button', 'gz-more', '', head);
    this.$more.type = 'button';
    this.$more.dataset.tip = t('gz.moreTip');
    this.$more.hidden = true;
    this.$more.addEventListener('click', () => this._setExpanded(!this._expanded));
    this.$list = el('div', 'gz-list', null, g);
    this.$list.setAttribute('role', 'log');
    this.$list.setAttribute('aria-live', 'polite');
    this.$empty = el('div', 'gz-empty', t('gz.empty'), this.$list);
    this.$list.addEventListener('click', (e) => {
      const node = e.target && e.target.closest ? e.target.closest('.gz-line') : null;
      const line = node && node._wmLine;
      if (line && line.pos) this._flyTo(line.pos);
    });
  }

  _setExpanded(on) {
    this._expanded = on;
    this.$root.classList.toggle('expanded', on);
    this._refreshMore();
  }

  _refreshMore() {
    const hidden = Math.max(0, this.lines.length - this.visible);
    this.$more.hidden = hidden === 0 && !this._expanded;
    this.$more.textContent = this._expanded ? t('gz.fold') : t('gz.more', { n: hidden });
  }

  _refreshHead() {
    const tick = this._tick();
    const s = t('gz.date', { d: Math.floor(tick / PER_DAY) + 1, time: clockText(tick) });
    if (this.$date._wmText !== s) {
      this.$date._wmText = s;
      this.$date.textContent = s;
    }
  }

  _flush() {
    const q = this._queue;
    for (let i = 0; i < q.length; i++) this._render(q[i]);
    q.length = 0;
    this._restyle();
  }

  _paint(line) {
    const text = tr(line.msg);
    line.textEl.textContent = line.rep > 1 ? `${text} (×${line.rep})` : text;
    line.stampEl.textContent = stamp(line.tick);
    line.node.title = line.pos ? t('gz.flyTip') : '';
  }

  _render(msg) {
    const top = this.lines[0];
    if (top && top.kind === msg.kind && sameMessage(top.msg, msg.msg)) {
      top.rep++;
      top.tick = msg.tick;
      if (msg.pos) top.pos = msg.pos;
      top.node.classList.toggle('has-pos', !!top.pos);
      this._paint(top);
      return;
    }
    let line;
    if (this.lines.length >= this.max) {
      line = this.lines.pop();                       // recycle the oldest node
    } else {
      const node = el('div', 'gz-line');
      const stampEl = el('span', 'gz-stamp', '', node);
      const textEl = el('span', 'gz-text', '', node);
      line = { node, stampEl, textEl, msg: '', kind: 'world', pos: null, rep: 1, tick: 0 };
      node._wmLine = line;
    }
    line.msg = msg.msg;
    line.kind = msg.kind;
    line.pos = msg.pos;
    line.rep = 1;
    line.tick = msg.tick;
    line.node.className = `gz-line fresh k-${msg.kind}${msg.pos ? ' has-pos' : ''}`;
    this._paint(line);
    this.lines.unshift(line);
    this.$list.insertBefore(line.node, this.$list.firstChild);
  }

  /** Fades lines by age and hides the ones beyond `tickerVisible` (unless expanded). */
  _restyle() {
    if (this.$empty && this.lines.length) {
      this.$empty.remove();
      this.$empty = null;
    }
    const vis = this.visible;
    for (let i = 0; i < this.lines.length; i++) {
      const node = this.lines[i].node;
      const old = i >= vis;
      if (node.classList.contains('g-old') !== old) node.classList.toggle('g-old', old);
      const op = old ? '' : String(Math.max(0.38, 1 - (i * 0.62) / vis).toFixed(2));
      if (node.style.opacity !== op) node.style.opacity = op;
    }
    this._refreshMore();
  }

  _flyTo(pos) {
    let y = pos.y;
    if (!Number.isFinite(y)) {
      const w = this.sim.world;
      y = w && typeof w.surfaceY === 'function' ? w.surfaceY(Math.floor(pos.x), Math.floor(pos.z)) : 18;
    }
    this._emit(EV.FLY_TO, { x: pos.x, y: num(y, 18), z: pos.z });
  }

  // ================================================================ subscriptions

  _subscribe() {
    const bus = this.sim.events;
    if (!bus || typeof bus.on !== 'function') return;
    const on = (name, fn) => {
      if (!name) return;
      const guarded = (p) => {
        try { fn(p || {}); } catch (err) {
          if (this._errors++ < 3) console.error(`[ticker] ${name} handler failed`, err);
        }
      };
      const off = bus.on(name, guarded);
      this._unsubs.push(typeof off === 'function' ? off : () => bus.off?.(name, guarded));
    };
    on(EV.TICKER, (p) => this.post(p.msg ?? p.text, p.kind, p.pos));
    on(EV.MARKET_CHIME, (p) => this._onChime(p));
    on(EV.AGENT_PROFESSION, (p) => this._onProfession(p));
    on(EV.CLOCK_DAWN, (p) => { this._dawnDay = Number.isFinite(p.day) ? p.day : Math.floor(this._tick() / PER_DAY); });
    on(EV.AGENT_BORN, () => { this._life.born++; });
    on(EV.AGENT_IMMIGRATED, () => { this._life.immigrated++; });
    on(EV.AGENT_EMIGRATED, () => { this._life.emigrated++; });
    on(EV.AGENT_DIED, (p) => this._onDied(p));
    on(EV.PROJECT_DONE, (p) => this._onProjectDone(p));
    on(EV.SMUGGLE_BREACH, (p) => this._onBreach(p));
    on(EV.RUMOR, (p) => this._onRumor(p));
    on(EV.PANIC, (p) => this._onPanic(p));
    on(EV.STABILIZER, (p) => this._onStabilizer(p));
    on(EV.PLAYER_TOOL, (p) => this._onPlayerTool(p));
    on(EV.RELATION, (p) => this._onRelation(p));
    on(EV.FIGHT, (p) => this._onFight(p));
  }

  // ================================================================ rules

  /** Per-plaza: seal queues and the evening bell; after the last plaza: the hourly rules. */
  _onChime(p) {
    const market = this.sim.market;
    const m = Number.isInteger(p.marketId) ? p.marketId : 0;
    const tick = Number.isFinite(p.tick) ? p.tick : this._tick();
    if (p.cleared) this._checkSeals(m, p.cleared, tick);
    if (this.sim.clans?.multi && Array.isArray(p.trades) && p.trades.length) this._checkFirstTrades(p.trades, m);

    if (Math.floor((tick % PER_DAY) / PER_HOUR) === DUSK_HOUR) {
      if (this._dusk.tick !== tick) {
        this._dusk.tick = tick;
        this._dusk.units = 0;
        this._dusk.markets = 0;
      }
      const trades = Array.isArray(p.trades) ? p.trades : [];
      for (let i = 0; i < trades.length; i++) this._dusk.units += num(trades[i]?.qty, 1);
      this._dusk.markets++;
    }

    const nMarkets = market?.markets?.length || 2;
    if (m !== nMarkets - 1) return;
    this._sampleHour();
    this._checkPriceMoves(tick);
    this._checkRumors(tick);
    this._checkTowers();
    if (this._dusk.tick === tick) {
      this.post(['gz.dusk', { n: this._dusk.units }], 'econ');
      this._dusk.tick = -1;
    }
  }

  _sampleHour() {
    const market = this.sim.market;
    if (!market || typeof market.avgPrice !== 'function') return;
    const h = this._ringHead;
    for (let i = 0; i < GOODS.length; i++) this._pRing[i * RING + h] = num(market.avgPrice(GOODS[i]));
    const counts = this.sim.population?.professionCounts?.() ?? null;
    for (let i = 0; i < PROFESSIONS.length; i++) this._profRing[i * RING + h] = num(counts?.[PROFESSIONS[i]]);
    this._ringHead = (h + 1) % RING;
    if (this._ringCount < RING) this._ringCount++;
  }

  _ringIndex(back) {
    return (this._ringHead - 1 - back + RING * 2) % RING;
  }

  /** "Crystal rises to 11.4 (+62% in a day) — 4 miners quit". */
  _checkPriceMoves(tick) {
    const n = this._ringCount;
    if (n < PRICE_MIN_HISTORY + 1) return;
    const back = n - 1;                                // oldest sample: 24 h back once the ring is full
    const iNow = this._ringIndex(0);
    const iThen = this._ringIndex(back);
    const market = this.sim.market;
    for (let gi = 0; gi < GOODS.length; gi++) {
      const now = this._pRing[gi * RING + iNow];
      const then = this._pRing[gi * RING + iThen];
      if (!(then > 0) || !(now > 0)) continue;
      const r = now / then - 1;
      if (Math.abs(r) < PRICE_MOVE || tick - this._lastPriceMove[gi] < PRICE_MOVE_GAP) continue;
      this._lastPriceMove[gi] = tick;
      const g = GOODS[gi];
      const cause = this._priceCause(g, tick);
      let pos = null;
      let best = -1;
      const mk = market?.markets;
      if (Array.isArray(mk)) {
        for (let m = 0; m < mk.length; m++) {
          const d = Math.abs(num(market.price(m, g), then) / then - 1);
          if (d > best && mk[m]?.center) { best = d; pos = mk[m].center; }
        }
      }
      this.post(['gz.price', { good: g, up: r > 0, price: now, pct: Math.round(r * 100), hours: back >= 24 ? 24 : back, cause }],
        'econ', pos);
    }
  }

  /** Guessed cause: a related player action, else the largest related head-count change. */
  _priceCause(good, tick) {
    const since = tick - PER_DAY;
    let related = null;
    let any = null;
    for (let i = this._marks.length - 1; i >= 0; i--) {
      const mk = this._marks[i];
      if (mk.tick < since) break;
      if (!any) any = mk;
      if (mk.good === good || (TOOL_GOODS[mk.tool] || []).includes(good)) { related = mk; break; }
    }
    if (related) return ['gz.causeTool', { tool: related.tool }];

    const n = this._ringCount;
    if (n >= 2) {
      const iNow = this._ringIndex(0);
      const iThen = this._ringIndex(n - 1);
      const linked = GOOD_PROFS[good] || [];
      let bestP = null;
      let bestD = 0;
      let anyP = null;
      let anyD = 0;
      for (let pi = 0; pi < PROFESSIONS.length; pi++) {
        const d = this._profRing[pi * RING + iNow] - this._profRing[pi * RING + iThen];
        if (Math.abs(d) > Math.abs(anyD)) { anyD = d; anyP = PROFESSIONS[pi]; }
        if (linked.includes(PROFESSIONS[pi]) && Math.abs(d) > Math.abs(bestD)) { bestD = d; bestP = PROFESSIONS[pi]; }
      }
      if (bestP && Math.abs(bestD) >= 2) return this._headcount(bestP, bestD);
      if (any) return ['gz.causeTool', { tool: any.tool }];
      if (anyP && Math.abs(anyD) >= 3) return this._headcount(anyP, anyD);
    } else if (any) {
      return ['gz.causeTool', { tool: any.tool }];
    }
    return null;
  }

  _headcount(prof, d) {
    return d < 0 ? ['gz.causeFewer', { prof, n: Math.abs(d) }] : ['gz.causeMore', { prof, n: d }];
  }

  _onProfession(p) {
    const to = p.to;
    if (!to) return;
    const tick = this._tick();
    let b = this._labor.get(to);
    if (!b) {
      b = { n: 0, from: new Map(), firstTick: tick, lastTick: tick, agentId: p.agentId, reason: p.reason || null };
      this._labor.set(to, b);
    }
    b.n++;
    b.lastTick = tick;
    if (p.from) b.from.set(p.from, (b.from.get(p.from) || 0) + 1);
    if (!b.reason && p.reason) b.reason = p.reason;
  }

  /** "3 farmers became miners — mining pays 1.6× more" (≥3 switches into one job within an hour). */
  _checkLabor() {
    if (!this._labor.size) return;
    const tick = this._tick();
    for (const [to, b] of this._labor) {
      if (b.n >= LABOR_MIN && tick - b.lastTick >= LABOR_QUIET) {
        this._labor.delete(to);
        this._postLabor(to, b);
      } else if (tick - b.firstTick > PER_HOUR) {
        this._labor.delete(to);
      }
    }
  }

  _postLabor(to, b) {
    let from = null;
    let fromN = 0;
    for (const [f, n] of b.from) if (n > fromN) { from = f; fromN = n; }
    const agent = this._agent(b.agentId);
    const clan = agent ? agent.clan ?? 0 : 0;
    let why = null;
    const guild = typeof this.sim.ledger?.guild === 'function' ? this.sim.ledger.guild(clan) : null;
    const yTo = num(guild?.[to]?.blended, NaN);
    const yFrom = from ? num(guild?.[from]?.blended, NaN) : NaN;
    if (yTo > 0 && yFrom > 0 && yTo / yFrom >= 1.05) why = ['gz.whyTimes', { to, x: Math.round((yTo / yFrom) * 10) / 10 }];
    else if (yTo > 0 && Number.isFinite(yFrom) && yFrom <= 0 && from) why = ['gz.whyNothing', { to, from, y: yTo }];
    else if (b.reason) why = b.reason;
    const same = from && fromN === b.n;
    this.post(['gz.labor', { n: b.n, from: same ? from : null, to, why }], 'labor', agent?.pos ?? null);
  }

  /** "Morning of day 5: 2 born, 1 died of old age · 64 Wicklings in the jar" (after that tick's dawn work). */
  _checkDawn() {
    if (this._dawnDay == null) return;
    const day = this._dawnDay;
    this._dawnDay = null;
    const L = this._life;
    const pop = this.sim.population?.count?.();
    this.post(['gz.dawn', { day: day + 1, born: L.born, aged: L.aged, starved: L.starved, killed: L.killed,
      left: L.emigrated, arrived: L.immigrated, pop: Number.isFinite(pop) ? pop : null }], 'life');
    L.born = 0; L.aged = 0; L.starved = 0; L.killed = 0; L.emigrated = 0; L.immigrated = 0;
  }

  _onDied(p) {
    if (p.cause === 'starved') {
      this._life.starved++;
      const tick = this._tick();
      if (tick - this._lastStarvePost >= PER_HOUR) {
        this._lastStarvePost = tick;
        const pos = p.pos && Number.isFinite(p.pos.x) ? p.pos : null;
        this.post(['gz.starved', { name: p.name ?? null, place: pos ? this._place(pos.x, pos.z) : null }], 'life', pos);
      }
    } else if (p.cause === 'fight') {
      this._life.killed++;
    } else {
      this._life.aged++;
    }
  }

  /** "A new house was built near Pond market for Tallowby Fenn by Ember Wax"; towers get their own line. */
  _onProjectDone(p) {
    const site = p.site && Number.isFinite(p.site.x) ? p.site : null;
    const owner = this._agent(p.ownerId);
    const mason = this._agent(p.masonId);
    this.post([p.kind === 'tower' ? 'gz.tower' : 'gz.house', {
      place: site ? this._place(site.x, site.z) : null, owner: owner ? owner.name : null, by: mason ? mason.name : null,
    }], 'world', site);
  }

  /** "The towers go dark — the haze is too thick" / "10 towers shine" (judged in full daylight). */
  _checkTowers() {
    const prod = this.sim.production;
    const clock = this.sim.clock;
    if (!prod || typeof prod.activeTowerCount !== 'function' || !clock) return;
    // SPEC-GAP: towers only mint in sunlight, so the lit count is judged only while sun ≥ 0.5
    // (08:00–16:00); otherwise every dusk would read as "the towers go dark".
    if (!(num(clock.sun) >= 0.5)) return;
    const lit = prod.activeTowerCount();
    const pos = this._towerCentroid(prod.towers);
    const eta = num(this.sim.ledger?.haze, 1);
    if (lit >= TOWERS_HIGH) {
      if (this._towerState === 'dark') this.post(['gz.towersUp', { n: lit, thin: eta > 0.7 }], 'world', pos);
      this._towerState = 'lit';
    } else if (lit <= TOWERS_LOW) {
      if (this._towerState === 'lit') {
        const shaded = (this.sim.effects?.eclipses || []).some((e) => e && (prod.towers || []).some(
          (tw) => Math.hypot(tw.base.x + 0.5 - e.x, tw.base.z + 0.5 - e.z) <= num(e.r)));
        const why = shaded ? 'shade' : eta < 0.5 ? 'haze' : 'keepers';
        this.post(['gz.towersDown', { why }], 'world', pos);
      }
      this._towerState = 'dark';
    }
  }

  _towerCentroid(towers) {
    if (!Array.isArray(towers) || !towers.length) return null;
    let x = 0;
    let z = 0;
    let y = 0;
    let n = 0;
    for (const tw of towers) {
      const p = tw && (tw.lens || tw.base);
      if (!p) continue;
      x += p.x + 0.5; y += p.y; z += p.z + 0.5; n++;
    }
    return n ? { x: x / n, y: y / n, z: z / n } : null;
  }

  /** "SMUGGLERS DIG UNDER THE GLASS". */
  _onBreach(p) {
    const agent = this._agent(p.agentId);
    const pos = Number.isFinite(p.x) ? { x: p.x + 0.5, y: p.y, z: p.z + 0.5 } : null;
    this.post(['gz.breach', { name: agent ? agent.name : null }], 'alert', pos);
  }

  /** Queues and piles under price seals, from the bell's clear results. */
  _checkSeals(m, cleared, tick) {
    const market = this.sim.market;
    for (const g of GOODS) {
      const c = cleared[g];
      if (!c || !c.sealed) continue;
      const kind = typeof c.sealed === 'string' ? c.sealed : market?.activeSeal?.(m, g)?.kind ?? 'ceiling';
      const key = `${m}:${g}`;
      if (tick - (this._sealLast.get(key) ?? -Infinity) < SEAL_GAP) continue;
      const pos = this._padPos(m, g);
      if (kind === 'floor') {
        if (num(c.unsoldQty) < SEAL_QUEUE) continue;
        this._sealLast.set(key, tick);
        this.post(['gz.sealFloor', { good: g, m, n: c.unsoldQty }], 'econ', pos);
      } else {
        if (num(c.unfilledQty) < SEAL_QUEUE) continue;
        this._sealLast.set(key, tick);
        this.post(['gz.sealCeiling', { good: g, m, n: c.unfilledQty }], 'econ', pos);
      }
    }
  }

  _padPos(m, g) {
    const info = this.sim.worldInfo?.markets?.[m];
    const pad = info?.pads?.[g];
    if (pad && Number.isFinite(pad.x)) return { x: pad.x + 0.5, y: pad.y, z: pad.z + 0.5 };
    const c = info?.center ?? this.sim.market?.markets?.[m]?.center;
    return c && Number.isFinite(c.x) ? { x: c.x + 0.5, y: c.y, z: c.z + 0.5 } : null;
  }

  /** RUMOR events and an hourly count both feed "Rumor: amber will get expensive — 14 believe it" (≤ 1 per good per 6 h). */
  _onRumor(p) {
    const gi = GOODS.indexOf(p.good);
    if (gi < 0 || !(num(p.believers) >= RUMOR_MIN)) return;
    this._postRumor(gi, p.dir, p.believers, null);
  }

  _checkRumors(tick) {
    const agents = this.sim.population?.agents;
    if (!Array.isArray(agents)) return;
    const cnt = this._believers;
    const xz = this._believerXZ;
    cnt.fill(0);
    xz.fill(0);
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const r = a && a.rumor;
      if (!r) continue;
      const gi = GOODS.indexOf(r.good);
      if (gi < 0) continue;
      cnt[gi * 2 + (r.dir < 0 ? 1 : 0)]++;
      if (a.pos) {
        xz[gi * 2] += a.pos.x;
        xz[gi * 2 + 1] += a.pos.z;
      }
    }
    for (let gi = 0; gi < GOODS.length; gi++) {
      const up = cnt[gi * 2];
      const down = cnt[gi * 2 + 1];
      const n = up + down;
      if (n < RUMOR_MIN || tick - this._lastRumor[gi] < RUMOR_GAP) continue;
      const pos = { x: xz[gi * 2] / n, y: null, z: xz[gi * 2 + 1] / n };
      this._postRumor(gi, up >= down ? 1 : -1, n, pos);
    }
  }

  _postRumor(gi, dir, believers, pos) {
    const tick = this._tick();
    if (tick - this._lastRumor[gi] < RUMOR_GAP) return;
    this._lastRumor[gi] = tick;
    this.post(['gz.rumor', { good: GOODS[gi], up: dir >= 0, n: believers }], 'econ', pos);
  }

  /** "PANIC! 14 Wicklings curl up near Pond market". */
  _onPanic(p) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
    const n = Math.round(num(p.count));
    const pos = { x: p.x, y: null, z: p.z };
    this.post(['gz.panic', { n, place: this._place(p.x, p.z) }], n > 0 ? 'alert' : 'world', pos);
  }

  _onStabilizer(p) {
    const kind = p.kind || 'stabilizer';
    let s = this._stab.get(kind);
    if (!s) {
      s = { amount: 0, count: 0, last: null, lastPrint: -Infinity };
      this._stab.set(kind, s);
    }
    s.amount += num(p.amount);
    s.count++;
    if (p.message) s.last = asMessage(p.message);
  }

  /** Grey safety-net lines: summed per kind, at most once per 6 in-game hours each. */
  _checkStabilizers() {
    if (!this._stab.size) return;
    const tick = this._tick();
    for (const [kind, s] of this._stab) {
      if (!s.count || tick - s.lastPrint < STAB_GAP) continue;
      let msg;
      if (s.count === 1 && s.last && kind !== 'priceClamp') msg = s.last;
      else msg = [`gz.stab.${kind}`, { a: Math.round(s.amount * 10) / 10, n: s.count, last: s.count > 1 ? s.last : null }];
      this.post(msg, 'stabilizer');
      s.amount = 0;
      s.count = 0;
      s.last = null;
      s.lastPrint = tick;
    }
  }

  /** Gold lines for the player's own hand; also remembered as candidate causes. */
  _onPlayerTool(p) {
    const tools = this.sim.tools?.tools;
    const def = Array.isArray(tools) ? tools.find((x) => x && x.id === p.tool) : null;
    const glyph = p.glyph || def?.glyph || '';
    const label = p.label ? asMessage(p.label) : [`tool.${p.tool}.name`];
    const pos = p.pos && Number.isFinite(p.pos.x) ? p.pos : null;
    this.post(['gz.player', { glyph, label }], 'player', pos);
    const tick = this._tick();
    this._marks.push({ tick, tool: p.tool, good: p.params?.good ?? null });
    while (this._marks.length && this._marks[0].tick < tick - PER_DAY) this._marks.shift();
    if (this._marks.length > 64) this._marks.splice(0, this._marks.length - 64);
  }

  // ================================================================ clans

  /** War, peace, friendship: every change of a relation's state is news. */
  _onRelation(p) {
    if (!Number.isInteger(p.a) || !Number.isInteger(p.b)) return;
    const kind = p.to === 0 || p.to === 1 ? 'alert' : 'clan';
    this.post(['gz.relation', { a: p.a, b: p.b, from: p.from, to: p.to }], kind, this._borderPos(p.a, p.b));
  }

  /** Fights are summed per clan pair; a death gets its own line. */
  _onFight(p) {
    if (p.phase !== 'end') return;
    const a = Math.min(p.winnerClan, p.loserClan), b = Math.max(p.winnerClan, p.loserClan);
    const key = `${a}:${b}`;
    let f = this._fights.get(key);
    if (!f) {
      f = { a, b, n: 0, stolen: 0, lastPost: -Infinity, pos: null };
      this._fights.set(key, f);
    }
    f.n++;
    f.stolen += num(p.stolen);
    f.pos = Number.isFinite(p.x) ? { x: p.x, y: p.y, z: p.z } : f.pos;
    if (p.killed) {
      this.post(['gz.killed', { winner: p.winnerName, wc: p.winnerClan, loser: p.loserName, lc: p.loserClan }], 'alert', f.pos);
    }
  }

  _checkFightSummaries() {
    if (!this._fights.size) return;
    const tick = this._tick();
    for (const f of this._fights.values()) {
      if (!f.n || tick - f.lastPost < FIGHT_GAP) continue;
      this.post(['gz.fights', { a: f.a, b: f.b, n: f.n, stolen: Math.round(f.stolen) }], 'clan', f.pos);
      f.n = 0;
      f.stolen = 0;
      f.lastPost = tick;
    }
  }

  /** "First trade between Honey and Frost!" once per pair. */
  _checkFirstTrades(trades, m) {
    const pop = this.sim.population;
    for (const tr0 of trades) {
      if (!tr0 || tr0.sellerId < 0) continue;
      const b = pop.get(tr0.buyerId);
      const s = pop.get(tr0.sellerId);
      if (!b || !s || (b.clan ?? 0) === (s.clan ?? 0)) continue;
      const lo = Math.min(b.clan, s.clan), hi = Math.max(b.clan, s.clan);
      const key = `${lo}:${hi}`;
      if (this._tradedPairs.has(key)) continue;
      this._tradedPairs.add(key);
      this.post(['gz.firstTrade', { a: lo, b: hi, good: tr0.good, m }], 'clan', this._padPos(m, tr0.good));
    }
  }

  _borderPos(a, b) {
    const w = this.sim.clans?.walls?.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    const SX = this.sim.world?.SX ?? CONFIG.world.SX;
    if (w && w.cols.length) {
      const col = w.cols[w.cols.length >> 1];
      return { x: (col % SX) + 0.5, y: null, z: Math.floor(col / SX) + 0.5 };
    }
    return null;
  }

  // ================================================================ utilities

  /** A place message for (x, z): near a market, by the pond, on a clan's land… */
  _place(x, z) {
    return placeOf(this.sim, x, z);
  }

  _agent(id) {
    if (id == null) return null;
    const pop = this.sim.population;
    if (!pop) return null;
    const a = typeof pop.get === 'function' ? pop.get(id) : pop.byId?.get?.(id);
    return a && a.alive !== false ? a : null;
  }

  _tick() {
    return Math.max(0, Math.floor(num(this.sim.clock?.tick)));
  }

  _emit(name, payload) {
    const bus = this.sim.events;
    if (name && bus && typeof bus.emit === 'function') bus.emit(name, payload);
  }
}
