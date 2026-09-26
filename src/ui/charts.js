/**
 * @file The chart drawer (SPEC §F "Charts", §C.4 G6): hand-rolled, DPR-aware canvas charts —
 * Prices · Jobs · Money · People · Wealth (and Clans when there are several) — drawn from the
 * Ledger's hourly and daily history rings.
 *
 * DOM + 2D canvas only. Reads the sim; writes only `sim.ui.chartTab` and `sim.ui.selectedGood`,
 * and emits SELECT_GOOD. Series are pulled from `ledger.getSeries` at `CONFIG.ui.chartsHz` and
 * cached; hovering (crosshair + values card) redraws from that cache, at most once per frame.
 * Every tab shows the player's actions from `ledger.markers` as dashed gold verticals with
 * their glyphs. The drawer folds with G (the HUD calls `toggleDrawer()`).
 */
import { CONFIG, TICKS, GOODS, PROFESSIONS } from '../core/config.js';
import { EV } from '../core/events.js';
import { t, tr, onLangChange, fmtPrice, goodName, profName, marketShort, clanName, getLang } from '../core/i18n.js';

const PER_HOUR = TICKS?.PER_HOUR ?? 100;
const PER_DAY = TICKS?.PER_DAY ?? 2400;
const TAU = Math.PI * 2;
const MINUS = '−';
const MONO = "'JetBrains Mono', ui-monospace, Consolas, monospace";
const SERIF = "Georgia, 'Times New Roman', serif";

const TAB_DEFS = ['prices', 'labor', 'light', 'lives', 'wealth', 'clans'];
const WINDOWS = [
  { id: '1d', days: 1 },
  { id: '5d', days: 5 },
  { id: 'all', days: Infinity },
];
const CLAN_METRICS = ['pop', 'money', 'gini', 'rel'];
const HOUR_STEPS = [1, 2, 3, 4, 6, 12, 24, 48, 72, 96, 120, 168, 240, 360, 480, 720, 1440, 2160];
const LOG_SETS = [[1], [1, 3], [1, 2, 5], [1, 1.5, 2, 3, 5, 7]];
const HAZE_TICKS = [0, 0.25, 0.5, 0.75, 1];
const REL_TICKS = [-100, -60, -20, 20, 60, 100];
const HIST_BINS = 10;
const LORENZ_N = 20;

const COL = {
  ink: '#1B1712', ink2: '#3F362A', ink3: '#6E6250', ink4: '#9A8C74',
  grid: 'rgba(110, 98, 80, 0.17)', gridDay: 'rgba(110, 98, 80, 0.34)', axis: 'rgba(63, 54, 42, 0.55)',
  cross: 'rgba(27, 23, 18, 0.5)', backdrop: 'rgba(239, 230, 210, 0.86)',
  sunward: '#B08D57', dewside: '#3E7C8C',
  gapSun: 'rgba(176, 141, 87, 0.24)', gapDew: 'rgba(62, 124, 140, 0.22)',
  vol: 'rgba(63, 54, 42, 0.34)', ref: 'rgba(110, 98, 80, 0.75)',
  marker: 'rgba(138, 100, 32, 0.85)', gold: '#C9A45C', goldInk: '#8A6420', parch: '#F7F1E3',
  M: '#C9A45C', Mstar: '#8A6420', haze: '#5B6FA8', mint: '#E0B04A', burn: '#6B4A2E',
  pop: '#1B1712', housed: '#3F5E2E',
  births: '#6FA35A', deaths: '#3F362A', starved: '#C0392B', starvedBg: 'rgba(192, 57, 43, 0.16)',
  imm: '#3E7C8C', emi: '#8A5A9E',
  gini: '#6B4A2E', lorenz: '#1B1712', lorenzFill: 'rgba(201, 164, 92, 0.3)', equality: 'rgba(63, 54, 42, 0.55)',
  alert: '#C0392B', grey: '#8C8577',
};
/** Background bands of the relations chart, worst first (value ranges of the relation states). */
const REL_BANDS = [
  { lo: -100, hi: -60, fill: 'rgba(192, 57, 43, 0.14)' },
  { lo: -60, hi: -20, fill: 'rgba(224, 128, 58, 0.10)' },
  { lo: -20, hi: 20, fill: 'rgba(0, 0, 0, 0)' },
  { lo: 20, hi: 60, fill: 'rgba(111, 163, 90, 0.10)' },
  { lo: 60, hi: 100, fill: 'rgba(63, 94, 46, 0.16)' },
];
const REL_KEYS = ['war', 'hostile', 'neutral', 'friendly', 'allied'];
const FLAME_RAMP = [[0xFF, 0x7A, 0x2E], [0xFF, 0xC2, 0x47], [0xFF, 0xF4, 0xD6]];
const NO_DASH = [];
const DASH_REF = [2, 3];
const DASH_STAR = [6, 4];
const DASH_MARK = [3, 3];
const DASH_EQ = [4, 4];
const EMPTY = Object.freeze([]);
const EMPTY_SERIES = Object.freeze({ ticks: EMPTY, values: EMPTY });
const TK = [];                                      // reused axis-tick scratch

// ---------------------------------------------------------------- small helpers

function el(tag, cls, text, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function button(cls, text, parent, tip) {
  const b = el('button', cls, text, parent);
  b.type = 'button';
  if (tip) b.dataset.tip = tip;
  return b;
}

function setText(node, s) {
  if (node && node._wmText !== s) {
    node._wmText = s;
    node.textContent = s;
  }
}

function setHidden(node, hidden) {
  if (node && node.hidden !== !!hidden) node.hidden = !!hidden;
}

function toggleClass(node, cls, on) {
  if (node && node.classList.contains(cls) !== !!on) node.classList.toggle(cls, !!on);
}

const finite = (v) => (Number.isFinite(v) ? v : 0);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const pad2 = (n) => (n < 10 ? '0' + n : String(n));
const goodColor = (g) => CONFIG.goods?.[g]?.color ?? '#999999';
const goodRef = (g) => CONFIG.goods?.[g]?.ref ?? 1;
const profColor = (p) => CONFIG.professions?.[p]?.color ?? '#999999';

function rampColor(k) {
  const x = clamp01(k) * 2;
  const i = x >= 1 ? 1 : 0;
  const f = x - i;
  const a = FLAME_RAMP[i];
  const b = FLAME_RAMP[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

/** The average of two #rrggbb colours (a clan pair's line). */
function mixHex(a, b) {
  const p = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round((p(a, i) + p(b, i)) / 2));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Histogram bar colours along the flame ramp, poorest bin first. */
const FLAME_BINS = Array.from({ length: HIST_BINS }, (_, i) => rampColor((i + 0.5) / HIST_BINS));

/** First index with arr[i] >= t (arr ascending). */
function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function niceStep(range, maxTicks) {
  const raw = Math.max(1e-9, range) / Math.max(1, maxTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const s = niceStep(v, 4);
  return Math.ceil(v / s - 1e-9) * s;
}

function linTicks(lo, hi, maxN, out) {
  out.length = 0;
  if (!(hi > lo)) return out;
  const step = niceStep(hi - lo, maxN);
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6; v += step) out.push(Math.round(v / step) * step);
  return out;
}

function countLog(lo, hi, set) {
  let n = 0;
  for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++) {
    const d = Math.pow(10, k);
    for (let j = 0; j < set.length; j++) {
      const v = set[j] * d;
      if (v >= lo && v <= hi) n++;
    }
  }
  return n;
}

function logTicks(lo, hi, maxN, out) {
  out.length = 0;
  if (!(lo > 0 && hi > lo)) return out;
  let best = null;
  for (let s = 0; s < LOG_SETS.length; s++) {
    if (countLog(lo, hi, LOG_SETS[s]) <= maxN) best = LOG_SETS[s];
    else break;
  }
  if (!best) best = LOG_SETS[0];
  for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++) {
    const d = Math.pow(10, k);
    for (let j = 0; j < best.length; j++) {
      const v = best[j] * d;
      if (v >= lo && v <= hi) out.push(v);
    }
  }
  if (out.length < 2) linTicks(lo, hi, 3, out);
  return out;
}

const decimal = (s) => (getLang() === 'hu' ? s.replace('.', ',') : s);

/** Compact axis/tooltip number: 7, 12.5, 0.35, 1.2k, 14k. */
function fmtNum(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  let s;
  if (a >= 10000) s = `${Math.round(a / 1000)}k`;
  else if (a >= 1000) s = `${(a / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  else if (a >= 100 || Number.isInteger(a)) s = String(Math.round(a));
  else if (a >= 10) s = a.toFixed(1);
  else s = a.toFixed(2);
  return (v < 0 ? MINUS : '') + decimal(s);
}

function fmtFix(v, d) {
  return Number.isFinite(v) ? decimal(v.toFixed(d)) : '—';
}

function fmtHaze(v) {
  return v === 0 ? '0' : v === 1 ? '1' : decimal(v.toFixed(2).replace(/^0/, ''));
}

function fmtPct(v) {
  return `${Math.round(v * 100)}%`;
}

function fmtWhen(tick) {
  const tk = Math.max(0, Math.floor(finite(tick)));
  const inDay = tk % PER_DAY;
  const h = Math.floor(inDay / PER_HOUR);
  const m = Math.floor(((inDay % PER_HOUR) * 60) / PER_HOUR);
  return t('ch.when', { d: Math.floor(tk / PER_DAY) + 1, time: `${pad2(h)}:${pad2(m)}` });
}

function uiRoot() {
  let root = document.getElementById('ui-root');
  if (!root) {
    // SPEC-GAP: index.html (G2) provides #ui-root; build a bare one if it is missing.
    root = el('div', null, null, document.getElementById('app') || document.body);
    root.id = 'ui-root';
  }
  return root;
}

function clipRect(ctx, r) {
  ctx.beginPath();
  ctx.rect(r.x, r.y - 1, r.w, r.h + 2);
  ctx.clip();
}

// ---------------------------------------------------------------- Charts

/**
 * The chart drawer along the bottom edge: tabs, a good selector (Prices), a clan-measure selector
 * (Clans), a legend, the 1d / 5d / all window selector, the fold toggle and one canvas that draws
 * the active tab.
 */
export class Charts {
  /** @param {object} sim the shared sim context (SPEC §C.1) */
  constructor(sim) {
    this.sim = sim;
    const ui = sim.config?.ui ?? CONFIG.ui ?? {};
    this._period = 1 / Math.max(0.2, finite(ui.chartsHz) || 1);
    this._acc = this._period;
    this._errors = 0;
    this._stale = true;
    this._dirty = false;
    this._collapsed = false;
    this._unsubs = [];

    this._multi = !!sim.clans?.multi;
    this._tabs = TAB_DEFS.filter((id) => id !== 'clans' || this._multi);
    const want = sim.ui?.chartTab;
    this._tab = this._tabs.includes(want) ? want : 'prices';
    this._win = '5d';
    this._winDays = 5;
    this._good = GOODS.includes(sim.ui?.selectedGood) ? sim.ui.selectedGood : GOODS[0];
    this._clanMetric = 'pop';
    this._nm = Math.max(1, sim.market?.markets?.length ?? 2);

    // Cached data (refreshed at chartsHz) and reused scratch.
    this._S = {
      pm: [], v: EMPTY_SERIES,
      prof: PROFESSIONS.map(() => EMPTY_SERIES),
      M: EMPTY_SERIES, Mstar: EMPTY_SERIES, haze: EMPTY_SERIES, mint: EMPTY_SERIES, burn: EMPTY_SERIES,
      pop: EMPTY_SERIES, housed: EMPTY_SERIES,
      births: EMPTY_SERIES, deaths: EMPTY_SERIES, starved: EMPTY_SERIES, imm: EMPTY_SERIES, emi: EMPTY_SERIES,
      gini: EMPTY_SERIES, lorenz: null, giniNow: 0, today: null,
      clan: [], rel: [],
    };
    this._cum = new Float64Array(PROFESSIONS.length * 64);
    this._hist = new Int32Array(HIST_BINS);
    this._histTop = 10;
    this._histN = 0;
    this._markers = EMPTY;
    this._mkHits = [];
    this._now = 0;
    this._f = { xMin: 0, xMax: 1, k: 1, i0: 0 };
    this._r0 = { x: 0, y: 0, w: 1, h: 1 };
    this._r1 = { x: 0, y: 0, w: 1, h: 1 };
    this._r2 = { x: 0, y: 0, w: 1, h: 1 };
    this._r3 = { x: 0, y: 0, w: 1, h: 1 };

    // Canvas metrics.
    this._cw = 0;
    this._ch = 0;
    this._dpr = 1;
    this._fa = 10;
    this._fontAxis = `10px ${MONO}`;
    this._fontNote = `italic 11px ${SERIF}`;
    this._fontGlyph = `11px ${SERIF}`;
    this._hatchPat = null;

    // Hover.
    this._hoverOn = false;
    this._hx = 0;
    this._hy = 0;
    this._tipN = 0;
    this._tipTitle = '';
    this._tipRows = [];

    this.root = uiRoot();
    this._build();
    this._subscribe();
    this._unsubs.push(onLangChange(() => this.relabel()));
  }

  /** The active tab id ('prices' | 'labor' | 'light' | 'lives' | 'wealth' | 'clans'). */
  get tab() {
    return this._tab;
  }

  /** True while the drawer is folded down to its header. */
  get collapsed() {
    return this._collapsed;
  }

  /**
   * Per-frame hook: refetches and redraws at `chartsHz`, redraws hover changes at most once per
   * frame, and does nothing while the drawer is folded or the UI is hidden.
   * @param {number} realDt real seconds since the last frame
   */
  update(realDt) {
    const dt = Number.isFinite(realDt) && realDt > 0 ? Math.min(realDt, 1) : 0;
    this._acc += dt;
    if (this._collapsed || this.sim.ui?.hideUI) return;
    try {
      this._syncFromUi();
      if (this._stale || this._acc >= this._period) {
        this._acc = 0;
        this._stale = false;
        this._dirty = false;
        this._fetch();
        this._draw();
      } else if (this._dirty) {
        this._dirty = false;
        this._draw();
      }
    } catch (err) {
      if (this._errors++ < 3) console.error('[charts] update failed', err);
    }
  }

  /**
   * Switches the drawer to a tab (and records it in `sim.ui.chartTab`).
   * @param {string} tab one of prices, labor, light, lives, wealth, clans
   * @param {boolean} [expand=true] also unfold a folded drawer
   */
  setTab(tab, expand = true) {
    if (!this._tabs.includes(tab)) return;
    if (this.sim.ui) this.sim.ui.chartTab = tab;
    if (expand && this._collapsed) this.toggleDrawer(false);
    if (tab === this._tab && this._built) return;
    this._tab = tab;
    for (let i = 0; i < this._tabs.length; i++) toggleClass(this.$tabs[i], 'on', this._tabs[i] === tab);
    setHidden(this.$goods, tab !== 'prices');
    if (this.$clanSel) setHidden(this.$clanSel, tab !== 'clans');
    this._buildLegend();
    this._tipHide();
    this._stale = true;
  }

  /**
   * Selects the time window of the time-axis charts.
   * @param {'1d'|'5d'|'all'} id
   */
  setWindow(id) {
    const def = WINDOWS.find((w) => w.id === id);
    if (!def) return;
    this._win = id;
    this._winDays = def.days;
    for (let i = 0; i < WINDOWS.length; i++) toggleClass(this.$winBtns[i], 'on', WINDOWS[i].id === id);
    this._stale = true;
  }

  /**
   * Folds or unfolds the drawer (G). Toggles `.collapsed` on `#drawer` and `.drawer-collapsed`
   * on `#ui-root` so the other cards re-anchor above it.
   * @param {boolean} [force] true folds, false unfolds; omitted toggles
   * @returns {boolean} whether the drawer is now folded
   */
  toggleDrawer(force) {
    const collapsed = force != null ? !!force : !this._collapsed;
    this._collapsed = collapsed;
    toggleClass(this.$drawer, 'collapsed', collapsed);
    toggleClass(this.root, 'drawer-collapsed', collapsed);
    setText(this.$toggle, collapsed ? '▴' : '▾');
    this.$toggle.dataset.tip = t(collapsed ? 'ch.unfold' : 'ch.fold');
    this.$toggle.setAttribute('aria-expanded', String(!collapsed));
    if (collapsed) {
      this._hoverOn = false;
      this._tipHide();
    } else {
      this._stale = true;
    }
    return collapsed;
  }

  /** Removes listeners (the DOM stays). */
  dispose() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    if (this._ro) this._ro.disconnect();
  }

  /** Rebuild the drawer's labels in the current language. */
  relabel() {
    const collapsed = this._collapsed;
    if (this._ro) this._ro.disconnect();
    this._tipRows = [];
    this._build();
    if (collapsed) this.toggleDrawer(true);
    this._stale = true;
  }

  // ================================================================ DOM

  _build() {
    const cfgH = finite((this.sim.config?.ui ?? CONFIG.ui ?? {}).drawerHeight) || 210;
    this.root.style.setProperty('--drawer-cfg', `${cfgH}px`);

    let d = document.getElementById('drawer');
    if (!d) {
      d = el('section', null, null, this.root);
      d.id = 'drawer';
    }
    d.classList.add('wm-card', 'wm-drawer');
    d.textContent = '';
    d.setAttribute('aria-label', t('ch.aria'));
    this.$drawer = d;

    const head = el('div', 'dr-head', null, d);
    const tabs = el('div', 'dr-tabs', null, head);
    tabs.setAttribute('role', 'tablist');
    this.$tabs = this._tabs.map((id) => {
      const b = button('dr-tab', t(`ch.tab.${id}`), tabs, t(`ch.tab.${id}.tip`));
      b.dataset.tipName = t(`ch.tab.${id}`);
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => {
        this.setTab(id);
        b.blur();
      });
      return b;
    });

    this.$goods = el('div', 'dr-goods', null, head);
    this.$goodBtns = GOODS.map((g) => {
      const b = button('dr-good', null, this.$goods, t('ch.goodTip', { good: goodName(g), ref: goodRef(g) }));
      b.dataset.tipName = goodName(g);
      const sw = el('i', 'sw', null, b);
      sw.style.setProperty('--c', goodColor(g));
      el('span', null, goodName(g), b);
      b.addEventListener('click', () => {
        this._selectGood(g);
        b.blur();
      });
      return b;
    });

    this.$clanSel = null;
    if (this._multi) {
      this.$clanSel = el('div', 'dr-goods dr-clansel', null, head);
      this.$clanBtns = CLAN_METRICS.map((id) => {
        const b = button('dr-good', t(`ch.clan.${id}`), this.$clanSel, t(`ch.clan.${id}.tip`));
        b.addEventListener('click', () => {
          this._clanMetric = id;
          for (let i = 0; i < CLAN_METRICS.length; i++) toggleClass(this.$clanBtns[i], 'on', CLAN_METRICS[i] === id);
          this._buildLegend();
          this._tipHide();
          this._stale = true;
          b.blur();
        });
        return b;
      });
      for (let i = 0; i < CLAN_METRICS.length; i++) toggleClass(this.$clanBtns[i], 'on', CLAN_METRICS[i] === this._clanMetric);
    }

    this.$legend = el('div', 'dr-legend', null, head);
    el('div', 'dr-fill', null, head);

    const win = el('div', 'dr-win', null, head);
    this.$winBtns = WINDOWS.map((w) => {
      const b = button('dr-winbtn', t(`ch.win.${w.id}`), win, t(`ch.win.${w.id}.tip`));
      b.addEventListener('click', () => {
        this.setWindow(w.id);
        b.blur();
      });
      return b;
    });

    this.$toggle = button('dr-toggle', '▾', head, t('ch.fold'));
    this.$toggle.setAttribute('aria-label', t('ch.toggleAria'));
    this.$toggle.addEventListener('click', () => {
      this.toggleDrawer();
      this.$toggle.blur();
    });

    const body = el('div', 'dr-body', null, d);
    this.$body = body;
    this.$canvas = el('canvas', 'dr-canvas', null, body);
    this.$canvas.setAttribute('role', 'img');
    this.$canvas.setAttribute('aria-label', t('ch.canvasAria'));
    this.$tip = el('div', 'dr-hover', null, body);
    this.$tip.hidden = true;
    this.$tipT = el('div', 'dr-hover-t', '', this.$tip);

    const cv = this.$canvas;
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      this._hx = e.clientX - r.left;
      this._hy = e.clientY - r.top;
      this._hoverOn = true;
      this._dirty = true;
    });
    cv.addEventListener('pointerleave', () => {
      this._hoverOn = false;
      this._dirty = true;
      this._tipHide();
    });

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => { this._stale = true; });
      this._ro.observe(body);
    }

    this._built = false;
    for (let i = 0; i < this._tabs.length; i++) toggleClass(this.$tabs[i], 'on', this._tabs[i] === this._tab);
    setHidden(this.$goods, this._tab !== 'prices');
    if (this.$clanSel) setHidden(this.$clanSel, this._tab !== 'clans');
    this._buildLegend();
    this.setWindow(this._win);
    this._refreshGoods();
    this._built = true;
  }

  /** Colour of market m's price line (clan markets wear their clan's flag). */
  _mkColor(m) {
    const clans = this.sim.clans;
    if (clans?.multi) return clans.list[this.sim.market?.markets?.[m]?.clan ?? 0]?.flag ?? COL.ink2;
    return m === 0 ? COL.sunward : m === 1 ? COL.dewside : COL.ink2;
  }

  _buildLegend() {
    const lg = this.$legend;
    if (!lg) return;
    lg.textContent = '';
    let items;
    switch (this._tab) {
      case 'prices': {
        items = [];
        for (let m = 0; m < this._nm; m++) items.push(['line', this._mkColor(m), marketShort(m)]);
        if (this._nm === 2) items.push(['fill', 'rgba(176, 141, 87, 0.45)', t('ch.lg.gap')]);
        items.push(['bar', COL.vol, t('ch.lg.sold')], ['dash', COL.ref, t('ch.lg.ref')]);
        break;
      }
      case 'labor':
        items = PROFESSIONS.map((p) => ['fill', profColor(p), profName(p)]);
        break;
      case 'light':
        items = [['line', COL.M, t('ch.lg.money')], ['dash', COL.Mstar, t('ch.lg.balance')], ['line', COL.haze, t('ch.lg.haze')],
          ['bar', COL.mint, t('ch.lg.made')], ['bar', COL.burn, t('ch.lg.lost')]];
        break;
      case 'lives':
        items = [['line', COL.pop, t('ch.lg.pop')], ['line', COL.housed, t('ch.lg.housed')], ['bar', COL.births, t('ch.lg.born')],
          ['bar', COL.deaths, t('ch.lg.died')], ['hatch', COL.starved, t('ch.lg.starved')], ['bar', COL.imm, t('ch.lg.arrived')],
          ['bar', COL.emi, t('ch.lg.left')]];
        break;
      case 'clans': {
        const clans = this.sim.clans;
        if (this._clanMetric === 'rel') {
          items = [];
          for (let a = 0; a < clans.count; a++) {
            for (let b = a + 1; b < clans.count; b++) items.push(['line', mixHex(clans.list[a].flag, clans.list[b].flag), `${clanName(a)}–${clanName(b)}`]);
          }
        } else {
          items = clans.list.map((cl) => ['line', cl.flag, clanName(cl.id)]);
        }
        break;
      }
      default:
        items = [['line', COL.lorenz, t('ch.lg.lorenz')], ['dash', COL.equality, t('ch.lg.equality')], ['line', COL.gini, 'Gini'],
          ['fill', FLAME_BINS[5], t('ch.lg.flames')]];
    }
    for (const [kind, color, label] of items) {
      const item = el('span', 'lg', null, lg);
      const sw = el('i', kind === 'line' ? 'lg-sw' : `lg-sw ${kind}`, null, item);
      sw.style.setProperty('--c', color);
      item.appendChild(document.createTextNode(label));
    }
  }

  _refreshGoods() {
    for (let i = 0; i < GOODS.length; i++) toggleClass(this.$goodBtns[i], 'on', GOODS[i] === this._good);
  }

  _selectGood(good) {
    if (!GOODS.includes(good)) return;
    if (this.sim.ui) this.sim.ui.selectedGood = good;
    this._emit(EV.SELECT_GOOD, { good });
    this._syncGood();
  }

  _syncGood() {
    const g = this.sim.ui?.selectedGood;
    if (!GOODS.includes(g) || g === this._good) return;
    this._good = g;
    this._refreshGoods();
    if (this._tab === 'prices') {
      this._tipHide();
      this._stale = true;
    }
  }

  _syncFromUi() {
    const want = this.sim.ui?.chartTab;
    if (want && want !== this._tab && this._tabs.includes(want)) this.setTab(want, false);
    this._syncGood();
  }

  _subscribe() {
    const bus = this.sim.events;
    if (!bus || typeof bus.on !== 'function') return;
    const on = (name, fn) => {
      if (!name) return;
      const off = bus.on(name, fn);
      this._unsubs.push(typeof off === 'function' ? off : () => bus.off?.(name, fn));
    };
    on(EV.SELECT_GOOD, () => this._syncGood());
    on(EV.PLAYER_TOOL, () => { this._stale = true; });
  }

  _emit(name, payload) {
    const bus = this.sim.events;
    if (name && bus && typeof bus.emit === 'function') bus.emit(name, payload);
  }

  // ================================================================ data

  _series(name) {
    const L = this.sim.ledger;
    if (!L || typeof L.getSeries !== 'function') return EMPTY_SERIES;
    const s = L.getSeries(name);
    return s && s.ticks && s.values && typeof s.ticks.length === 'number' ? s : EMPTY_SERIES;
  }

  _fetch() {
    const sim = this.sim;
    const L = sim.ledger;
    const S = this._S;
    this._now = finite(sim.clock?.tick);
    this._markers = Array.isArray(L?.markers) ? L.markers : EMPTY;
    S.today = L?.today ?? null;
    switch (this._tab) {
      case 'prices': {
        const g = this._good;
        S.pm.length = 0;
        for (let m = 0; m < this._nm; m++) S.pm.push(this._series(`P:${m}:${g}`));
        S.v = this._series(`V:${g}`);
        break;
      }
      case 'labor':
        for (let k = 0; k < PROFESSIONS.length; k++) S.prof[k] = this._series(`prof:${PROFESSIONS[k]}`);
        break;
      case 'light':
        S.M = this._series('M');
        S.Mstar = this._series('Mstar');
        S.haze = this._series('haze');
        S.mint = this._series('mintH');
        S.burn = this._series('burnH');
        break;
      case 'lives':
        S.pop = this._series('pop');
        S.housed = this._series('housed');
        S.births = this._series('d:births');
        S.deaths = this._series('d:deaths');
        S.starved = this._series('d:starved');
        S.imm = this._series('d:immigrants');
        S.emi = this._series('d:emigrants');
        break;
      case 'clans': {
        const clans = sim.clans;
        S.clan.length = 0;
        S.rel.length = 0;
        if (this._clanMetric === 'rel') {
          for (let a = 0; a < clans.count; a++) {
            for (let b = a + 1; b < clans.count; b++) {
              S.rel.push({ a, b, color: mixHex(clans.list[a].flag, clans.list[b].flag), s: this._series(`rel:${a}:${b}`) });
            }
          }
        } else {
          for (const cl of clans.list) S.clan.push({ c: cl.id, color: cl.flag, s: this._series(`c:${this._clanMetric}:${cl.id}`) });
        }
        break;
      }
      default: {
        S.gini = this._series('gini');
        S.emi = this._series('d:emigrants');
        S.lorenz = L && typeof L.lorenz === 'function' ? L.lorenz(LORENZ_N) : null;
        S.giniNow = L && typeof L.gini === 'function' ? finite(L.gini()) : 0;
        this._fillHistogram();
      }
    }
  }

  _fillHistogram() {
    const agents = this.sim.population?.agents;
    const hist = this._hist;
    hist.fill(0);
    let maxW = 0;
    let n = 0;
    if (Array.isArray(agents)) {
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        if (!a || a.alive === false) continue;
        const v = Math.max(0, finite(a.glim) + finite(a.escrow));
        if (v > maxW) maxW = v;
        n++;
      }
      const top = niceMax(Math.max(10, maxW));
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        if (!a || a.alive === false) continue;
        const v = Math.max(0, finite(a.glim) + finite(a.escrow));
        hist[Math.min(HIST_BINS - 1, Math.floor((v / top) * HIST_BINS))]++;
      }
      this._histTop = top;
    }
    this._histN = n;
  }

  // ================================================================ drawing frame

  /** Sizes the canvas backing store to CSS px × DPR; refreshes font metrics on change. */
  _fit() {
    const cv = this.$canvas;
    const dpr = Math.min(2.5, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    const w = Math.max(1, cv.clientWidth || 1);
    const h = Math.max(1, cv.clientHeight || 1);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    if (w !== this._cw || h !== this._ch || dpr !== this._dpr) {
      this._cw = w;
      this._ch = h;
      this._dpr = dpr;
      let fs = 12;
      if (typeof getComputedStyle === 'function') fs = parseFloat(getComputedStyle(this.$body).fontSize) || 12;
      const fa = Math.max(9, Math.round(fs * 0.86));
      this._fa = fa;
      this._fontAxis = `${fa}px ${MONO}`;
      this._fontNote = `italic ${Math.round(fa * 1.08)}px ${SERIF}`;
      this._fontGlyph = `${Math.round(fa * 1.05)}px ${SERIF}`;
      this._hatchPat = null;
    }
    return dpr;
  }

  _draw() {
    const cv = this.$canvas;
    const ctx = cv && cv.getContext ? cv.getContext('2d') : null;
    if (!ctx) return;
    const dpr = this._fit();
    const w = this._cw;
    const h = this._ch;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setLineDash(NO_DASH);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;
    this._tipN = 0;
    this._tipTitle = '';
    this._mkHits.length = 0;
    if (w < 40 || h < 30) {
      this._tipHide();
      return;
    }
    if (!this.sim.ledger) {
      this._drawEmpty(ctx, w, h);
      this._tipHide();
      return;
    }
    switch (this._tab) {
      case 'prices': this._drawPrices(ctx, w, h); break;
      case 'labor': this._drawLabor(ctx, w, h); break;
      case 'light': this._drawLight(ctx, w, h); break;
      case 'lives': this._drawLives(ctx, w, h); break;
      case 'clans': this._drawClans(ctx, w, h); break;
      default: this._drawWealth(ctx, w, h);
    }
    this._tipFlush();
  }

  _rect(out, x, y, w, h) {
    out.x = Math.round(x);
    out.y = Math.round(y);
    out.w = Math.max(8, Math.round(w));
    out.h = Math.max(8, Math.round(h));
    return out;
  }

  /** Standard plot rectangle: y labels on the left, optionally a right axis. */
  _plotRect(w, h, rightAxis) {
    const fa = this._fa;
    const L = fa * 4.6;
    const R = rightAxis ? fa * 3.8 : fa * 1.4;
    const T = fa * 1.9;
    const B = fa * 1.9;
    return this._rect(this._r0, L, T, w - L - R, h - T - B);
  }

  /** Time frame for `ticks` under the active window; sets `_f` and returns it. */
  _frame(ticks, r) {
    const f = this._f;
    const n = ticks.length;
    const now = this._now;
    const first = n ? ticks[0] : now - PER_HOUR;
    const xMax = n ? Math.max(ticks[n - 1], now) : now;
    const days = this._winDays;
    let xMin = days === Infinity ? first : Math.max(first, xMax - days * PER_DAY);
    if (xMax - xMin < PER_HOUR) xMin = xMax - PER_HOUR;
    f.xMin = xMin;
    f.xMax = xMax;
    f.k = r.w / (xMax - xMin);
    f.i0 = Math.max(0, lowerBound(ticks, xMin) - 1);
    return f;
  }

  _drawEmpty(ctx, w, h, msg) {
    ctx.font = this._fontNote;
    ctx.fillStyle = COL.ink3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg || t('ch.empty'), w / 2, h / 2);
  }

  /** Italic note with a parchment backdrop, anchored at its top-left (or top-right). */
  _note(ctx, x, y, text, color, alignRight) {
    ctx.font = this._fontNote;
    const tw = ctx.measureText(text).width;
    const fh = this._fa * 1.35;
    const x0 = alignRight ? x - tw - 8 : x;
    ctx.fillStyle = COL.backdrop;
    ctx.fillRect(x0, y, tw + 8, fh);
    ctx.fillStyle = color || COL.ink2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x0 + 4, y + fh / 2 + 0.5);
  }

  /** Horizontal grid lines + labels on one side of `r`. */
  _yAxis(ctx, r, ticks, Y, fmt, side, grid) {
    ctx.font = this._fontAxis;
    ctx.fillStyle = COL.ink3;
    ctx.textBaseline = 'middle';
    ctx.textAlign = side === 'left' ? 'right' : 'left';
    ctx.lineWidth = 1;
    ctx.setLineDash(NO_DASH);
    ctx.strokeStyle = grid ? COL.grid : COL.axis;
    const lx = side === 'left' ? r.x - 5 : r.x + r.w + 5;
    for (let i = 0; i < ticks.length; i++) {
      const y = Math.round(Y(ticks[i])) + 0.5;
      if (y < r.y - 1 || y > r.y + r.h + 1) continue;
      ctx.beginPath();
      if (grid) {
        ctx.moveTo(r.x, y);
        ctx.lineTo(r.x + r.w, y);
      } else {
        const x = side === 'left' ? r.x : r.x + r.w;
        ctx.moveTo(x - 3, y);
        ctx.lineTo(x + 3, y);
      }
      ctx.stroke();
      ctx.fillText(fmt(ticks[i]), lx, y);
    }
  }

  /** Vertical grid at nice hour steps and "Day N" / "HH:00" labels below `r`. */
  _timeAxis(ctx, r, f) {
    const fa = this._fa;
    const spanH = (f.xMax - f.xMin) / PER_HOUR;
    const maxLabels = Math.max(2, Math.floor(r.w / (fa * 7.5)));
    let stepH = HOUR_STEPS[HOUR_STEPS.length - 1];
    for (let i = 0; i < HOUR_STEPS.length; i++) {
      if (spanH / HOUR_STEPS[i] <= maxLabels) {
        stepH = HOUR_STEPS[i];
        break;
      }
    }
    const step = stepH * PER_HOUR;
    ctx.font = this._fontAxis;
    ctx.fillStyle = COL.ink3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 1;
    ctx.setLineDash(NO_DASH);
    for (let tk = Math.ceil(f.xMin / step) * step; tk <= f.xMax; tk += step) {
      const x = Math.round(r.x + (tk - f.xMin) * f.k) + 0.5;
      const isDay = tk % PER_DAY === 0;
      ctx.strokeStyle = isDay ? COL.gridDay : COL.grid;
      ctx.beginPath();
      ctx.moveTo(x, r.y);
      ctx.lineTo(x, r.y + r.h);
      ctx.stroke();
      const label = isDay ? t('ch.day', { d: tk / PER_DAY + 1 }) : `${pad2(Math.floor((tk % PER_DAY) / PER_HOUR))}:00`;
      const tw = ctx.measureText(label).width;
      const lx = Math.min(Math.max(x, r.x + tw / 2 - fa * 2), r.x + r.w + fa * 1.2 - tw / 2);
      ctx.fillText(label, lx, r.y + r.h + 4);
    }
    ctx.strokeStyle = COL.axis;
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + r.h + 0.5);
    ctx.lineTo(r.x + r.w, r.y + r.h + 0.5);
    ctx.stroke();
  }

  /** Player marks: dashed gold verticals with their glyphs; collects hover hits. */
  _drawMarkers(ctx, r, f) {
    const mk = this._markers;
    if (!mk || !mk.length) return;
    const fa = this._fa;
    const rad = fa * 0.72;
    ctx.save();
    ctx.lineWidth = 1;
    for (let i = 0; i < mk.length; i++) {
      const m = mk[i];
      const tk = m ? finite(m.tick) : -1;
      if (!m || tk < f.xMin || tk > f.xMax) continue;
      const x = Math.round(r.x + (tk - f.xMin) * f.k) + 0.5;
      ctx.setLineDash(DASH_MARK);
      ctx.strokeStyle = COL.marker;
      ctx.beginPath();
      ctx.moveTo(x, r.y);
      ctx.lineTo(x, r.y + r.h);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
      const cy = r.y - rad - 1;
      ctx.fillStyle = COL.parch;
      ctx.strokeStyle = COL.gold;
      ctx.beginPath();
      ctx.arc(x, cy, rad, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = COL.goldInk;
      ctx.font = this._fontGlyph;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.glyph ? String(m.glyph) : '✦', x, cy + 0.5);
      if (this._hoverOn && Math.abs(this._hx - x) <= Math.max(5, rad)) this._mkHits.push(m);
    }
    ctx.restore();
  }

  /** Sample index nearest the pointer inside `r`'s x-range, or -1. */
  _hoverIndex(ticks, r, f) {
    if (!this._hoverOn || !ticks.length) return -1;
    const hx = this._hx;
    if (hx < r.x - 1 || hx > r.x + r.w + 1) return -1;
    const tk = f.xMin + (hx - r.x) / f.k;
    let i = lowerBound(ticks, tk);
    if (i >= ticks.length) i = ticks.length - 1;
    else if (i > 0 && tk - ticks[i - 1] < ticks[i] - tk) i--;
    if (ticks[i] < f.xMin - PER_HOUR * 0.5 || ticks[i] > f.xMax + 1) return -1;
    return i;
  }

  _crosshair(ctx, r, x) {
    const xx = Math.round(x) + 0.5;
    ctx.save();
    ctx.setLineDash(NO_DASH);
    ctx.strokeStyle = COL.cross;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xx, r.y);
    ctx.lineTo(xx, r.y + r.h);
    ctx.stroke();
    ctx.restore();
  }

  _dot(ctx, x, y, color) {
    if (!Number.isFinite(y)) return;
    ctx.fillStyle = color;
    ctx.strokeStyle = COL.parch;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, TAU);
    ctx.fill();
    ctx.stroke();
  }

  /** Polyline of one series from the frame's first index; a lone sample becomes a dot. */
  _line(ctx, ticks, vals, f, r, Y, color, width, dash, positiveOnly) {
    const n = Math.min(ticks.length, vals.length);
    if (n <= f.i0) return;
    ctx.beginPath();
    let pen = false;
    let count = 0;
    let lx = 0;
    let ly = 0;
    for (let i = f.i0; i < n; i++) {
      const v = vals[i];
      if (!Number.isFinite(v) || (positiveOnly && !(v > 0))) {
        pen = false;
        continue;
      }
      const x = r.x + (ticks[i] - f.xMin) * f.k;
      const y = Y(v);
      if (pen) ctx.lineTo(x, y);
      else {
        ctx.moveTo(x, y);
        pen = true;
      }
      count++;
      lx = x;
      ly = y;
    }
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    if (count === 1) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(lx, ly, width + 1, 0, TAU);
      ctx.fill();
    }
  }

  _hatch(ctx) {
    if (this._hatchPat) return this._hatchPat;
    const c = document.createElement('canvas');
    c.width = 6;
    c.height = 6;
    const g = c.getContext ? c.getContext('2d') : null;
    if (!g) return COL.starved;
    g.strokeStyle = COL.starved;
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(0, 6);
    g.lineTo(6, 0);
    g.moveTo(-3, 3);
    g.lineTo(3, -3);
    g.moveTo(3, 9);
    g.lineTo(9, 3);
    g.stroke();
    this._hatchPat = ctx.createPattern(c, 'repeat') || COL.starved;
    return this._hatchPat;
  }

  // ================================================================ tabs

  _drawPrices(ctx, w, h) {
    const S = this._S;
    const PM = S.pm;
    const V = S.v;
    let ticks = EMPTY;
    for (const s of PM) if (s.ticks.length > ticks.length) ticks = s.ticks;
    const r = this._plotRect(w, h, false);
    if (!ticks.length) {
      this._drawEmpty(ctx, w, h);
      return;
    }
    const f = this._frame(ticks, r);
    const n = ticks.length;
    const g = this._good;
    const ref = goodRef(g);
    let lo = Infinity;
    let hi = -Infinity;
    let vmax = 0;
    for (let i = f.i0; i < n; i++) {
      for (const s of PM) {
        const a = s.values[i];
        if (a > 0) {
          if (a < lo) lo = a;
          if (a > hi) hi = a;
        }
      }
      const v = V.values[i];
      if (v > vmax) vmax = v;
    }
    if (!(hi >= lo)) {
      lo = ref;
      hi = ref;
    }
    if (ref > lo / 1.6 && ref < hi * 1.6) {
      if (ref < lo) lo = ref;
      if (ref > hi) hi = ref;
    }
    let l0 = Math.log(lo);
    let l1 = Math.log(hi);
    const minSpan = Math.log(1.4);
    if (l1 - l0 < minSpan) {
      const mid = (l0 + l1) / 2;
      l0 = mid - minSpan / 2;
      l1 = mid + minSpan / 2;
    }
    const pad = (l1 - l0) * 0.08;
    l0 -= pad;
    l1 += pad;

    const fa = this._fa;
    const volH = Math.max(10, Math.round(r.h * 0.2));
    const pr = this._rect(this._r1, r.x, r.y, r.w, r.h - volH - 5);
    const vr = this._rect(this._r2, r.x, r.y + r.h - volH, r.w, volH);
    const Y = (v) => pr.y + pr.h - ((Math.log(v) - l0) / (l1 - l0)) * pr.h;
    const X = (tk) => r.x + (tk - f.xMin) * f.k;

    logTicks(Math.exp(l0), Math.exp(l1), Math.max(2, Math.floor(pr.h / (fa * 2.3))), TK);
    this._yAxis(ctx, pr, TK, Y, fmtPrice, 'left', true);
    this._timeAxis(ctx, r, f);

    ctx.save();
    clipRect(ctx, r);
    if (PM.length === 2) {
      // Difference shading between the two plazas: one path per side so the fill changes twice.
      const A = PM[0];
      const B = PM[1];
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        let any = false;
        for (let i = f.i0; i < n - 1; i++) {
          const a0 = A.values[i];
          const a1 = A.values[i + 1];
          const b0 = B.values[i];
          const b1 = B.values[i + 1];
          if (!(a0 > 0 && a1 > 0 && b0 > 0 && b1 > 0)) continue;
          if ((a0 + a1 >= b0 + b1) !== (pass === 0)) continue;
          const x0 = X(ticks[i]);
          const x1 = X(ticks[i + 1]);
          ctx.moveTo(x0, Y(a0));
          ctx.lineTo(x1, Y(a1));
          ctx.lineTo(x1, Y(b1));
          ctx.lineTo(x0, Y(b0));
          ctx.closePath();
          any = true;
        }
        if (any) {
          ctx.fillStyle = pass === 0 ? COL.gapSun : COL.gapDew;
          ctx.fill();
        }
      }
    }
    // Normal (reference) price.
    const yRef = Y(ref);
    if (yRef > pr.y && yRef < pr.y + pr.h) {
      ctx.setLineDash(DASH_REF);
      ctx.strokeStyle = COL.ref;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pr.x, Math.round(yRef) + 0.5);
      ctx.lineTo(pr.x + pr.w, Math.round(yRef) + 0.5);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
    }
    // Volume bars.
    if (vmax > 0) {
      const bw = Math.max(1, Math.min(PER_HOUR * f.k * 0.72, 16));
      ctx.fillStyle = COL.vol;
      for (let i = f.i0; i < n; i++) {
        const v = V.values[i];
        if (!(v > 0)) continue;
        const bh = Math.max(1, (v / vmax) * (vr.h - 1));
        ctx.fillRect(X(ticks[i]) - bw / 2, vr.y + vr.h - bh, bw, bh);
      }
    }
    for (let m = PM.length - 1; m >= 0; m--) {
      this._line(ctx, ticks, PM[m].values, f, r, Y, this._mkColor(m), PM.length > 3 ? 1.5 : 1.8, NO_DASH, true);
    }
    ctx.restore();

    // Volume band: separator, scale and reference label.
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(vr.x, vr.y - 2.5);
    ctx.lineTo(vr.x + vr.w, vr.y - 2.5);
    ctx.stroke();
    ctx.font = this._fontAxis;
    ctx.fillStyle = COL.ink4;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(t('ch.soldAxis', { n: fmtNum(vmax > 0 ? vmax : 0) }), r.x - 5, vr.y);
    if (yRef > pr.y && yRef < pr.y + pr.h) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = COL.ref;
      ctx.fillText(t('ch.refLabel', { p: fmtPrice(ref) }), pr.x + pr.w - 2, yRef - 1);
    }

    this._drawMarkers(ctx, r, f);
    const i = this._hoverIndex(ticks, r, f);
    if (i >= 0) {
      const x = X(ticks[i]);
      this._crosshair(ctx, r, x);
      this._tipTitle = `${fmtWhen(ticks[i])} · ${goodName(g)}`;
      for (let m = 0; m < PM.length; m++) {
        const a = PM[m].values[i];
        if (a > 0) this._dot(ctx, x, Y(a), this._mkColor(m));
        this._tipRow('line', this._mkColor(m), t('ch.tip.price', { m: marketShort(m) }), a > 0 ? fmtPrice(a) : '—');
      }
      if (PM.length === 2) {
        const a = PM[0].values[i];
        const b = PM[1].values[i];
        if (a > 0 && b > 0) {
          const gap = a / b - 1;
          const label = Math.abs(gap) < 0.005 ? t('ch.tip.noGap') : t('ch.tip.dearer', { m: marketShort(gap > 0 ? 0 : 1) });
          this._tipRow('box', gap >= 0 ? 'rgba(176, 141, 87, 0.6)' : 'rgba(62, 124, 140, 0.6)', label, `${Math.round(Math.abs(gap) * 100)}%`);
        }
      }
      this._tipRow('box', COL.vol, t('ch.tip.sold'), fmtNum(finite(V.values[i])));
    }
  }

  _drawLabor(ctx, w, h) {
    const P = this._S.prof;
    const np = PROFESSIONS.length;
    const ticks = P[0] ? P[0].ticks : EMPTY;
    const r = this._plotRect(w, h, false);
    if (!ticks.length) {
      this._drawEmpty(ctx, w, h);
      return;
    }
    const f = this._frame(ticks, r);
    const n = ticks.length;
    if (this._cum.length < n * np) this._cum = new Float64Array(Math.max(n * np, this._cum.length * 2));
    const cum = this._cum;
    let ymax = 0;
    for (let i = f.i0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < np; k++) {
        const v = P[k].values[i];
        s += v > 0 ? v : 0;
        cum[i * np + k] = s;
      }
      if (s > ymax) ymax = s;
    }
    ymax = niceMax(Math.max(4, ymax * 1.06));
    const Y = (v) => r.y + r.h - (v / ymax) * r.h;
    const X = (tk) => r.x + (tk - f.xMin) * f.k;

    linTicks(0, ymax, Math.max(2, Math.floor(r.h / (this._fa * 2.3))), TK);
    this._yAxis(ctx, r, TK, Y, fmtNum, 'left', true);
    this._timeAxis(ctx, r, f);

    ctx.save();
    clipRect(ctx, r);
    if (n - f.i0 === 1) {
      const x = X(ticks[n - 1]);
      for (let k = 0; k < np; k++) {
        const top = cum[(n - 1) * np + k];
        const bot = k > 0 ? cum[(n - 1) * np + k - 1] : 0;
        ctx.fillStyle = profColor(PROFESSIONS[k]);
        ctx.fillRect(x - 4, Y(top), 8, Y(bot) - Y(top));
      }
    } else {
      for (let k = 0; k < np; k++) {
        ctx.beginPath();
        for (let i = f.i0; i < n; i++) {
          const x = X(ticks[i]);
          const y = Y(cum[i * np + k]);
          if (i === f.i0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        for (let i = n - 1; i >= f.i0; i--) ctx.lineTo(X(ticks[i]), Y(k > 0 ? cum[i * np + k - 1] : 0));
        ctx.closePath();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = profColor(PROFESSIONS[k]);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        for (let i = f.i0; i < n; i++) {
          const x = X(ticks[i]);
          const y = Y(cum[i * np + k]);
          if (i === f.i0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(27, 23, 18, 0.38)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }
    ctx.restore();

    this._drawMarkers(ctx, r, f);
    const i = this._hoverIndex(ticks, r, f);
    if (i >= 0) {
      const x = X(ticks[i]);
      this._crosshair(ctx, r, x);
      const total = i >= f.i0 ? cum[i * np + np - 1] : 0;
      this._tipTitle = t('ch.tip.laborTitle', { when: fmtWhen(ticks[i]), n: fmtNum(total) });
      for (let k = np - 1; k >= 0; k--) {
        const p = PROFESSIONS[k];
        this._tipRow('box', profColor(p), profName(p), fmtNum(finite(P[k].values[i])));
      }
    }
  }

  _drawLight(ctx, w, h) {
    const S = this._S;
    const ticks = S.M.ticks;
    const r = this._plotRect(w, h, true);
    if (!ticks.length) {
      this._drawEmpty(ctx, w, h);
      return;
    }
    const f = this._frame(ticks, r);
    const n = ticks.length;
    const fa = this._fa;
    const band = Math.max(12, Math.round(r.h * 0.26));
    const lr = this._rect(this._r1, r.x, r.y, r.w, r.h - band - 5);
    const br = this._rect(this._r2, r.x, r.y + r.h - band, r.w, band);
    let mmax = 0;
    let bmax = 0;
    for (let i = f.i0; i < n; i++) {
      const m = S.M.values[i];
      const ms = S.Mstar.values[i];
      const mi = S.mint.values[i];
      const bu = S.burn.values[i];
      if (m > mmax) mmax = m;
      if (ms > mmax) mmax = ms;
      if (mi > bmax) bmax = mi;
      if (bu > bmax) bmax = bu;
    }
    const ymax = niceMax(Math.max(10, mmax * 1.08));
    const Y = (v) => lr.y + lr.h - (v / ymax) * lr.h;
    const H = (v) => lr.y + lr.h - clamp01(v) * lr.h;
    const X = (tk) => r.x + (tk - f.xMin) * f.k;
    const mid = br.y + br.h / 2;
    const half = br.h / 2 - 1;

    linTicks(0, ymax, Math.max(2, Math.floor(lr.h / (fa * 2.3))), TK);
    this._yAxis(ctx, lr, TK, Y, fmtNum, 'left', true);
    this._yAxis(ctx, lr, HAZE_TICKS, H, fmtHaze, 'right', false);
    this._timeAxis(ctx, r, f);
    ctx.font = this._fontAxis;
    ctx.fillStyle = COL.haze;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(t('ch.hazeAxis'), r.x + r.w + 5, lr.y - 2);

    ctx.save();
    clipRect(ctx, r);
    // Made (up) against lost (down) per hour.
    ctx.strokeStyle = COL.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(br.x, Math.round(mid) + 0.5);
    ctx.lineTo(br.x + br.w, Math.round(mid) + 0.5);
    ctx.stroke();
    if (bmax > 0) {
      const bw = Math.max(1, Math.min(PER_HOUR * f.k * 0.72, 16));
      for (let i = f.i0; i < n; i++) {
        const x = X(ticks[i]) - bw / 2;
        const mi = S.mint.values[i];
        const bu = S.burn.values[i];
        if (mi > 0) {
          const bh = Math.max(1, (mi / bmax) * half);
          ctx.fillStyle = COL.mint;
          ctx.fillRect(x, mid - bh, bw, bh);
        }
        if (bu > 0) {
          const bh = Math.max(1, (bu / bmax) * half);
          ctx.fillStyle = COL.burn;
          ctx.fillRect(x, mid, bw, bh);
        }
      }
    }
    this._line(ctx, ticks, S.haze.values, f, r, H, COL.haze, 1.3, NO_DASH, false);
    this._line(ctx, ticks, S.Mstar.values, f, r, Y, COL.Mstar, 1.5, DASH_STAR, false);
    this._line(ctx, ticks, S.M.values, f, r, Y, COL.M, 2.3, NO_DASH, false);
    ctx.restore();

    ctx.font = this._fontAxis;
    ctx.textAlign = 'right';
    ctx.fillStyle = COL.goldInk;
    ctx.textBaseline = 'top';
    ctx.fillText(`↑${fmtNum(bmax)}`, r.x - 5, br.y);
    ctx.fillStyle = COL.burn;
    ctx.textBaseline = 'bottom';
    ctx.fillText(`↓${fmtNum(bmax)}`, r.x - 5, br.y + br.h);

    this._drawMarkers(ctx, r, f);
    const i = this._hoverIndex(ticks, r, f);
    if (i >= 0) {
      const x = X(ticks[i]);
      this._crosshair(ctx, r, x);
      const M = finite(S.M.values[i]);
      const Ms = finite(S.Mstar.values[i]);
      const eta = S.haze.values[i];
      this._dot(ctx, x, Y(M), COL.M);
      this._dot(ctx, x, Y(Ms), COL.Mstar);
      if (Number.isFinite(eta)) this._dot(ctx, x, H(eta), COL.haze);
      this._tipTitle = fmtWhen(ticks[i]);
      this._tipRow('line', COL.M, t('ch.lg.money'), fmtNum(M));
      this._tipRow('dash', COL.Mstar, t('ch.lg.balance'), fmtNum(Ms));
      this._tipRow('line', COL.haze, t('ch.tip.haze'), fmtFix(eta, 2));
      this._tipRow('box', COL.mint, t('ch.tip.made'), fmtNum(finite(S.mint.values[i])));
      this._tipRow('box', COL.burn, t('ch.tip.lost'), fmtNum(finite(S.burn.values[i])));
    }
  }

  _drawLives(ctx, w, h) {
    const S = this._S;
    const ticks = S.pop.ticks;
    const r = this._plotRect(w, h, true);
    if (!ticks.length) {
      this._drawEmpty(ctx, w, h);
      return;
    }
    const f = this._frame(ticks, r);
    const n = ticks.length;
    const fa = this._fa;
    const X = (tk) => r.x + (tk - f.xMin) * f.k;
    const today = S.today;
    const dt = S.births.ticks;
    const dn = dt.length;
    const dayStart = Math.floor(this._now / PER_DAY) * PER_DAY;

    let pmax = 0;
    for (let i = f.i0; i < n; i++) {
      const p = S.pop.values[i];
      if (p > pmax) pmax = p;
    }
    let dmax = 0;
    for (let j = 0; j < dn; j++) {
      if (dt[j] <= f.xMin) continue;
      dmax = Math.max(dmax, finite(S.births.values[j]), finite(S.deaths.values[j]), finite(S.imm.values[j]), finite(S.emi.values[j]));
    }
    if (today) dmax = Math.max(dmax, finite(today.births), finite(today.deaths), finite(today.immigrants), finite(today.emigrants));
    const ymax = niceMax(Math.max(10, pmax * 1.1));
    const dTop = niceMax(Math.max(3, dmax));
    const bandH = Math.round(r.h * 0.42);
    const base = r.y + r.h;
    const Y = (v) => r.y + r.h - (v / ymax) * r.h;
    const YB = (v) => base - (v / dTop) * bandH;

    linTicks(0, ymax, Math.max(2, Math.floor(r.h / (fa * 2.3))), TK);
    this._yAxis(ctx, r, TK, Y, fmtNum, 'left', true);
    linTicks(0, dTop, 2, TK);
    this._yAxis(ctx, r, TK, YB, fmtNum, 'right', false);
    ctx.font = this._fontAxis;
    ctx.fillStyle = COL.ink4;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(t('ch.perDay'), r.x + r.w + 5, base - bandH - 6);
    this._timeAxis(ctx, r, f);

    ctx.save();
    clipRect(ctx, r);
    for (let j = 0; j < dn; j++) {
      const T = dt[j];
      const x0 = X(Math.max(T - PER_DAY, f.xMin));
      const x1 = X(Math.min(T, f.xMax));
      if (x1 - x0 < 2) continue;
      this._dayBars(ctx, x0, x1, YB, base, S.births.values[j], S.deaths.values[j], S.starved.values[j],
        S.imm.values[j], S.emi.values[j], 1);
    }
    if (today && dayStart < f.xMax) {
      const x0 = X(Math.max(dayStart, f.xMin));
      const x1 = X(f.xMax);
      if (x1 - x0 >= 2) {
        this._dayBars(ctx, x0, x1, YB, base, today.births, today.deaths, today.starved, today.immigrants, today.emigrants, 0.5);
      }
    }
    this._line(ctx, ticks, S.housed.values, f, r, Y, COL.housed, 1.6, NO_DASH, false);
    this._line(ctx, ticks, S.pop.values, f, r, Y, COL.pop, 2, NO_DASH, false);
    ctx.restore();

    this._note(ctx, r.x + 4, r.y + 3, this._stabText(today), COL.grey, false);
    this._drawMarkers(ctx, r, f);

    const i = this._hoverIndex(ticks, r, f);
    if (i >= 0) {
      const tk = ticks[i];
      const x = X(tk);
      this._crosshair(ctx, r, x);
      const pop = finite(S.pop.values[i]);
      const housed = finite(S.housed.values[i]);
      this._dot(ctx, x, Y(pop), COL.pop);
      this._dot(ctx, x, Y(housed), COL.housed);
      this._tipTitle = fmtWhen(tk);
      this._tipRow('line', COL.pop, t('ch.lg.pop'), fmtNum(pop));
      this._tipRow('line', COL.housed, t('ch.lg.housed'), fmtNum(housed));
      const j = lowerBound(dt, tk + 1);
      let rec = null;
      let label = '';
      if (j < dn && dt[j] - PER_DAY <= tk) {
        rec = j;
        label = t('ch.tip.dayN', { d: Math.max(1, Math.round(dt[j] / PER_DAY)) });
      } else if (today && tk >= dayStart) {
        rec = -1;
        label = t('ch.tip.today');
      }
      if (rec !== null) {
        const pick = (series, key) => (rec >= 0 ? finite(series.values[rec]) : finite(today[key]));
        const deaths = pick(S.deaths, 'deaths');
        const starved = pick(S.starved, 'starved');
        this._tipRow('box', COL.births, t('ch.tip.born', { when: label }), fmtNum(pick(S.births, 'births')));
        this._tipRow('box', COL.deaths, t('ch.lg.died'), starved > 0 ? t('ch.tip.diedStarved', { n: fmtNum(deaths), s: fmtNum(starved) }) : fmtNum(deaths));
        this._tipRow('box', COL.imm, t('ch.lg.arrived'), fmtNum(pick(S.imm, 'immigrants')));
        this._tipRow('box', COL.emi, t('ch.lg.left'), fmtNum(pick(S.emi, 'emigrants')));
      }
    }
  }

  /** Four bars (born, died with starved hatched, arrived, left) centred in a day slot. */
  _dayBars(ctx, x0, x1, YB, base, births, deaths, starved, imm, emi, alpha) {
    const slot = x1 - x0;
    const bw = Math.max(1, Math.min(12, (slot * 0.72) / 4 - 1));
    const gw = bw * 4 + 3;
    let x = (x0 + x1) / 2 - gw / 2;
    ctx.globalAlpha = alpha;
    const bar = (v, color) => {
      if (v > 0) {
        const y = YB(v);
        ctx.fillStyle = color;
        ctx.fillRect(x, y, bw, base - y);
      }
      x += bw + 1;
    };
    bar(finite(births), COL.births);
    const d = finite(deaths);
    const s = Math.min(d, finite(starved));
    if (d > 0) {
      const yd = YB(d);
      const ys = YB(s);
      ctx.fillStyle = COL.deaths;
      ctx.fillRect(x, yd, bw, ys - yd);
      if (s > 0) {
        ctx.fillStyle = COL.starvedBg;
        ctx.fillRect(x, ys, bw, base - ys);
        ctx.fillStyle = this._hatch(ctx);
        ctx.fillRect(x, ys, bw, base - ys);
      }
    }
    x += bw + 1;
    bar(finite(imm), COL.imm);
    bar(finite(emi), COL.emi);
    ctx.globalAlpha = 1;
  }

  _stabText(today) {
    const stab = today && today.stab;
    if (!stab) return t('ch.stabNone');
    let s = '';
    for (const k in stab) {
      const v = stab[k];
      if (!(v > 0)) continue;
      const amt = v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : fmtFix(v, 1);
      s += `${s ? ' · ' : ''}${t(`ch.stab.${k}`)} ${amt}`;
    }
    return s ? t('ch.stabToday', { list: s }) : t('ch.stabQuiet');
  }

  /** Clans tab: one line per clan (size, money, Gini) or per pair of clans (relations). */
  _drawClans(ctx, w, h) {
    const S = this._S;
    const rel = this._clanMetric === 'rel';
    const lines = rel ? S.rel : S.clan;
    let ticks = EMPTY;
    for (const l of lines) if (l.s.ticks.length > ticks.length) ticks = l.s.ticks;
    const r = this._plotRect(w, h, false);
    if (!ticks.length) {
      this._drawEmpty(ctx, w, h);
      return;
    }
    const f = this._frame(ticks, r);
    const n = ticks.length;
    const fa = this._fa;
    let lo = 0;
    let hi = 1;
    if (rel) {
      lo = -100;
      hi = 100;
    } else {
      let vmax = 0;
      for (const l of lines) for (let i = f.i0; i < Math.min(n, l.s.values.length); i++) if (l.s.values[i] > vmax) vmax = l.s.values[i];
      hi = this._clanMetric === 'gini' ? Math.min(1, niceMax(Math.max(0.1, vmax * 1.15))) : niceMax(Math.max(4, vmax * 1.08));
    }
    const Y = (v) => r.y + r.h - ((v - lo) / (hi - lo)) * r.h;
    const X = (tk) => r.x + (tk - f.xMin) * f.k;
    const fmt = this._clanMetric === 'gini' ? (v) => fmtFix(v, 2) : fmtNum;

    if (rel) {
      ctx.save();
      clipRect(ctx, r);
      for (const b of REL_BANDS) {
        ctx.fillStyle = b.fill;
        ctx.fillRect(r.x, Y(b.hi), r.w, Y(b.lo) - Y(b.hi));
      }
      ctx.restore();
      this._yAxis(ctx, r, REL_TICKS, Y, fmtNum, 'left', true);
      ctx.font = this._fontAxis;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let k = 0; k < REL_BANDS.length; k++) {
        const b = REL_BANDS[k];
        ctx.fillStyle = k < 2 ? COL.alert : k > 2 ? '#3F5E2E' : COL.ink4;
        ctx.fillText(t(`relName.${REL_KEYS[k]}`), r.x + r.w - 4, (Y(b.lo) + Y(b.hi)) / 2);
      }
    } else {
      linTicks(lo, hi, Math.max(2, Math.floor(r.h / (fa * 2.3))), TK);
      this._yAxis(ctx, r, TK, Y, fmt, 'left', true);
    }
    this._timeAxis(ctx, r, f);

    ctx.save();
    clipRect(ctx, r);
    for (const l of lines) this._line(ctx, l.s.ticks, l.s.values, f, r, Y, l.color, 2, NO_DASH, false);
    ctx.restore();

    this._drawMarkers(ctx, r, f);
    const i = this._hoverIndex(ticks, r, f);
    if (i >= 0) {
      const x = X(ticks[i]);
      this._crosshair(ctx, r, x);
      this._tipTitle = `${fmtWhen(ticks[i])} · ${t(`ch.clan.${this._clanMetric}`)}`;
      for (const l of lines) {
        const v = l.s.values[i];
        if (Number.isFinite(v)) this._dot(ctx, x, Y(v), l.color);
        const label = rel ? `${clanName(l.a)}–${clanName(l.b)}` : clanName(l.c);
        let val = fmt(finite(v));
        if (rel) {
          const k = v <= -60 ? 0 : v < -20 ? 1 : v < 20 ? 2 : v < 60 ? 3 : 4;
          val = `${fmtNum(Math.round(finite(v)))} · ${t(`relName.${REL_KEYS[k]}`)}`;
        }
        this._tipRow('line', l.color, label, val);
      }
    }
  }

  _drawWealth(ctx, w, h) {
    const fa = this._fa;
    const top = fa * 1.9;
    const H = Math.max(20, h - top - fa * 1.9);
    const lw = Math.max(40, Math.min(H * 1.3, w * 0.2));
    const lr = this._rect(this._r1, fa * 4.2, top, lw, H);
    const hw = Math.max(120, Math.min(360, w * 0.26));
    const hr = this._rect(this._r3, w - fa * 1.4 - hw, top, hw, H);
    const gx = lr.x + lr.w + fa * 4.8;
    const gr = this._rect(this._r2, gx, top, hr.x - fa * 3.8 - gx, H);
    this._drawLorenz(ctx, lr);
    this._drawHist(ctx, hr);
    if (hr.x - fa * 3.8 - gx >= 60) this._drawGini(ctx, gr);
  }

  _drawLorenz(ctx, r) {
    const L = this._S.lorenz;
    const n = L && L.length > 1 ? L.length - 1 : 0;
    const X = (p) => r.x + p * r.w;
    const Y = (q) => r.y + r.h - q * r.h;
    ctx.save();
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    for (let q = 0.25; q < 1; q += 0.25) {
      ctx.beginPath();
      ctx.moveTo(r.x, Math.round(Y(q)) + 0.5);
      ctx.lineTo(r.x + r.w, Math.round(Y(q)) + 0.5);
      ctx.moveTo(Math.round(X(q)) + 0.5, r.y);
      ctx.lineTo(Math.round(X(q)) + 0.5, r.y + r.h);
      ctx.stroke();
    }
    ctx.strokeStyle = COL.axis;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    ctx.setLineDash(DASH_EQ);
    ctx.strokeStyle = COL.equality;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    ctx.lineTo(X(1), Y(1));
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    if (n > 0) {
      ctx.beginPath();
      ctx.moveTo(X(0), Y(clamp01(L[0])));
      for (let i = 1; i <= n; i++) ctx.lineTo(X(i / n), Y(clamp01(L[i])));
      ctx.lineTo(X(0), Y(0));
      ctx.closePath();
      ctx.fillStyle = COL.lorenzFill;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(X(0), Y(clamp01(L[0])));
      for (let i = 1; i <= n; i++) ctx.lineTo(X(i / n), Y(clamp01(L[i])));
      ctx.strokeStyle = COL.lorenz;
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }
    ctx.restore();

    ctx.font = this._fontAxis;
    ctx.fillStyle = COL.ink3;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('100%', r.x - 4, r.y + 3);
    ctx.fillText('50%', r.x - 4, Y(0.5));
    ctx.fillText('0', r.x - 4, r.y + r.h - 3);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(t('ch.poorest'), r.x, r.y + r.h + 4);
    ctx.textAlign = 'right';
    ctx.fillText(t('ch.richest'), r.x + r.w, r.y + r.h + 4);
    ctx.font = this._fontNote;
    ctx.fillStyle = COL.ink2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(t('ch.lorenzTitle', { g: fmtFix(this._S.giniNow, 2) }), r.x, r.y - 3);

    if (this._hoverOn && n > 0 && this._hx >= r.x && this._hx <= r.x + r.w) {
      const p = clamp01((this._hx - r.x) / r.w);
      const pos = p * n;
      const i = Math.min(n - 1, Math.floor(pos));
      const q = clamp01(L[i] + (L[i + 1] - L[i]) * (pos - i));
      this._crosshair(ctx, r, X(p));
      this._dot(ctx, X(p), Y(q), COL.lorenz);
      this._tipTitle = t('ch.tip.whoHolds');
      this._tipRow('line', COL.lorenz, t('ch.tip.poorest', { p: fmtPct(p) }), t('ch.tip.share', { q: fmtPct(q) }));
      this._tipRow('line', COL.lorenz, t('ch.tip.richest', { p: fmtPct(1 - p) }), t('ch.tip.share', { q: fmtPct(1 - q) }));
    }
  }

  _drawHist(ctx, r) {
    const hist = this._hist;
    const top = this._histTop;
    let cmax = 0;
    for (let i = 0; i < HIST_BINS; i++) if (hist[i] > cmax) cmax = hist[i];
    const ymax = niceMax(Math.max(2, cmax));
    const Y = (v) => r.y + r.h - (v / ymax) * r.h;
    const bw = r.w / HIST_BINS;

    linTicks(0, ymax, Math.max(2, Math.floor(r.h / (this._fa * 2.3))), TK);
    this._yAxis(ctx, r, TK, Y, fmtNum, 'left', true);
    ctx.strokeStyle = COL.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + r.h + 0.5);
    ctx.lineTo(r.x + r.w, r.y + r.h + 0.5);
    ctx.stroke();

    let hoverBin = -1;
    if (this._hoverOn && this._hx >= r.x && this._hx < r.x + r.w) hoverBin = Math.min(HIST_BINS - 1, Math.floor((this._hx - r.x) / bw));
    for (let i = 0; i < HIST_BINS; i++) {
      const c = hist[i];
      if (c <= 0) continue;
      const x = r.x + i * bw + 1;
      const y = Y(c);
      ctx.fillStyle = FLAME_BINS[i];
      ctx.fillRect(x, y, bw - 2, r.y + r.h - y);
      ctx.strokeStyle = i === hoverBin ? COL.ink : 'rgba(27, 23, 18, 0.45)';
      ctx.lineWidth = i === hoverBin ? 1.5 : 0.75;
      ctx.strokeRect(x + 0.5, y + 0.5, bw - 3, r.y + r.h - y - 1);
    }
    ctx.font = this._fontAxis;
    ctx.fillStyle = COL.ink3;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('0', r.x, r.y + r.h + 4);
    ctx.textAlign = 'center';
    ctx.fillText(fmtNum(top / 2), r.x + r.w / 2, r.y + r.h + 4);
    ctx.textAlign = 'right';
    ctx.fillText(t('ch.lightAxis', { n: fmtNum(top) }), r.x + r.w, r.y + r.h + 4);
    ctx.font = this._fontNote;
    ctx.fillStyle = COL.ink2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(t('ch.histTitle', { n: this._histN }), r.x, r.y - 3);

    if (hoverBin >= 0) {
      const a = (top / HIST_BINS) * hoverBin;
      const b = (top / HIST_BINS) * (hoverBin + 1);
      const c = hist[hoverBin];
      this._tipTitle = t('ch.lg.flames');
      this._tipRow('box', FLAME_BINS[hoverBin], t('ch.tip.range', { a: fmtNum(a), b: fmtNum(b) }), t('ch.tip.count', { n: c }));
      if (this._histN > 0) this._tipRow('box', FLAME_BINS[hoverBin], t('ch.tip.ofJar'), fmtPct(c / this._histN));
    }
  }

  _drawGini(ctx, r) {
    const S = this._S;
    const ticks = S.gini.ticks;
    if (!ticks.length) {
      ctx.font = this._fontNote;
      ctx.fillStyle = COL.ink3;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t('ch.giniEmpty'), r.x + r.w / 2, r.y + r.h / 2);
      return;
    }
    const f = this._frame(ticks, r);
    const n = ticks.length;
    let gmax = 0;
    for (let i = f.i0; i < n; i++) {
      const g = S.gini.values[i];
      if (g > gmax) gmax = g;
    }
    const ymax = Math.min(1, niceMax(Math.max(0.1, gmax * 1.15)));
    const Y = (v) => r.y + r.h - (clamp01(v) / ymax) * r.h;
    const X = (tk) => r.x + (tk - f.xMin) * f.k;

    linTicks(0, ymax, Math.max(2, Math.floor(r.h / (this._fa * 2.3))), TK);
    this._yAxis(ctx, r, TK, Y, (v) => fmtFix(v, 2), 'left', true);
    this._timeAxis(ctx, r, f);
    ctx.save();
    clipRect(ctx, r);
    this._line(ctx, ticks, S.gini.values, f, r, Y, COL.gini, 2, NO_DASH, false);
    ctx.restore();

    const today = S.today;
    const emiToday = finite(today?.emigrants);
    let emiTotal = emiToday;
    const ev = S.emi.values;
    for (let j = 0; j < ev.length; j++) emiTotal += finite(ev[j]);
    this._note(ctx, r.x + 4, r.y + 3, t('ch.giniNote', { g: fmtFix(S.giniNow, 2), today: emiToday, total: emiTotal }), COL.ink2, false);

    this._drawMarkers(ctx, r, f);
    const i = this._hoverIndex(ticks, r, f);
    if (i >= 0) {
      const x = X(ticks[i]);
      const g = finite(S.gini.values[i]);
      this._crosshair(ctx, r, x);
      this._dot(ctx, x, Y(g), COL.gini);
      this._tipTitle = fmtWhen(ticks[i]);
      this._tipRow('line', COL.gini, 'Gini', fmtFix(g, 3));
    }
  }

  // ================================================================ hover card

  _tipRow(kind, color, label, value) {
    let row = this._tipRows[this._tipN];
    if (!row) {
      const r = el('div', 'dr-hover-r', null, this.$tip);
      row = { row: r, sw: el('i', null, null, r), l: el('span', null, '', r), v: el('b', null, '', r), kind: null, color: null };
      this._tipRows.push(row);
    }
    if (row.kind !== kind) {
      row.kind = kind;
      row.row.className = kind === 'mk' ? 'dr-hover-r mk' : 'dr-hover-r';
      row.sw.className = kind === 'line' || kind === 'mk' ? '' : kind;
    }
    if (row.color !== color) {
      row.color = color;
      row.sw.style.setProperty('--c', color);
    }
    setText(row.l, label);
    setText(row.v, value);
    this._tipN++;
  }

  _tipFlush() {
    if (!this._hoverOn) {
      this._tipHide();
      return;
    }
    const hits = this._mkHits;
    const MAX_MARKS = 4;                       // a flurry of marks must not grow the card off-screen
    for (let i = 0; i < Math.min(hits.length, MAX_MARKS); i++) {
      const m = hits[i];
      const label = m.label ? tr(m.label) : t(`tool.${m.tool}.name`);
      this._tipRow('mk', COL.gold, `${m.glyph ? m.glyph + ' ' : ''}${label}`, fmtWhen(m.tick));
    }
    if (hits.length > MAX_MARKS) this._tipRow('mk', COL.gold, t('ch.tip.moreMarks', { n: hits.length - MAX_MARKS }), '');
    if (this._tipN === 0) {
      this._tipHide();
      return;
    }
    setText(this.$tipT, this._tipTitle || t('ch.tip.yourActions'));
    const rows = this._tipRows;
    for (let i = 0; i < rows.length; i++) setHidden(rows[i].row, i >= this._tipN);
    const tip = this.$tip;
    tip.hidden = false;
    const bw = this.$body.clientWidth;
    const bh = this.$body.clientHeight;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const ox = this.$canvas.offsetLeft || 0;
    const oy = this.$canvas.offsetTop || 0;
    let x = ox + this._hx + 16;
    if (x + tw > bw - 4) x = ox + this._hx - 16 - tw;
    if (x < 2) x = 2;
    let y = oy + this._hy - th / 2;
    if (y > bh - th - 2) y = bh - th - 2;
    if (y < 2 && th < bh - 4) y = 2;
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  }

  _tipHide() {
    if (this.$tip && !this.$tip.hidden) this.$tip.hidden = true;
  }
}
