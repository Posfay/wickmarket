/**
 * @file HUD: the top bar, the tool tray, the market price board, the help overlay, the shared
 * `#tooltip` and the global hotkeys (SPEC §F, §C.4 G6, ADDENDUM §8).
 *
 * DOM only. Reads the sim; writes only `sim.ui`, `sim.speed` and `sim.paused`; emits UI events.
 * The DOM is built once (and again when the language changes); `update()` rewrites text and
 * styles at `CONFIG.ui.hudHz` and only touches nodes whose content actually changed.
 * Sparklines redraw only after a market bell.
 *
 * Tooltip convention: any element under `#ui-root` with `data-tip` (and optionally
 * `data-tip-name` / `data-tip-key`) shows the parchment tooltip on hover.
 */
import { CONFIG, TICKS, GOODS } from '../core/config.js';
import { EV } from '../core/events.js';
import { parseSeed, randomSeed } from '../core/rng.js';
import {
  t, getLang, setLang, onLangChange, LANGS, fmtPrice, fmtInt, fmtNum, goodName, profName, marketShort, marketName, clanName,
} from '../core/i18n.js';

const PER_HOUR = TICKS?.PER_HOUR ?? 100;
const PER_DAY = TICKS?.PER_DAY ?? 2400;
const PER_SEC = TICKS?.PER_SEC ?? 10;
const SPARK_N = 25;                        // now + 24 hourly samples back
const MINUS = '−';
const SCARCITY = [[0x5A, 0xA7, 0xD6], [0xED, 0xE3, 0xC8], [0xE0, 0x48, 0x3A]];

// ---------------------------------------------------------------- small DOM helpers

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

/** Writes textContent only when it changed (no DOM mutation at 4 Hz for static values). */
function setText(node, s) {
  if (node && node._wmText !== s) {
    node._wmText = s;
    node.textContent = s;
  }
}

function setStyle(node, prop, value) {
  const key = '_wm_' + prop;
  if (node && node[key] !== value) {
    node[key] = value;
    if (prop.startsWith('--')) node.style.setProperty(prop, value);
    else node.style[prop] = value;
  }
}

function toggleClass(node, cls, on) {
  if (node && node.classList.contains(cls) !== !!on) node.classList.toggle(cls, !!on);
}

function setHidden(node, hidden) {
  if (node && node.hidden !== !!hidden) node.hidden = !!hidden;
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

function ensureEl(id, tag, parent) {
  let node = document.getElementById(id);
  if (!node) {
    node = el(tag, null, null, parent);
    node.id = id;
  }
  return node;
}

function isTypingTarget(node) {
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
}

// ---------------------------------------------------------------- formatting & colour

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

export { fmtPrice };

function fmtPct(r) {
  if (!Number.isFinite(r)) return '—';
  const p = Math.round(r * 100);
  if (p === 0) return '0%';
  return (p > 0 ? '+' : MINUS) + Math.abs(p) + '%';
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function clockParts(tick) {
  const tk = Math.max(0, Math.floor(num(tick)));
  const inDay = tk % PER_DAY;
  const hour = Math.floor(inDay / PER_HOUR);
  const min = Math.floor(((inDay % PER_HOUR) * 60) / PER_HOUR);
  return { day: Math.floor(tk / PER_DAY), hour, min, frac: inDay / PER_DAY };
}

function lerp(a, b, k) {
  return a + (b - a) * k;
}

/**
 * Scarcity scale for P/ref: ≤0.7 glut blue, 1 balanced parchment, ≥1.5 scarce red, linear between.
 * @returns {string} css rgba()
 */
export function scarcityColor(ratio, alpha = 0.78) {
  const r = num(ratio, 1);
  let a;
  let b;
  let k;
  if (r <= 1) {
    a = SCARCITY[0]; b = SCARCITY[1];
    k = Math.min(1, Math.max(0, (r - 0.7) / 0.3));
  } else {
    a = SCARCITY[1]; b = SCARCITY[2];
    k = Math.min(1, Math.max(0, (r - 1) / 0.5));
  }
  return `rgba(${Math.round(lerp(a[0], b[0], k))},${Math.round(lerp(a[1], b[1], k))},${Math.round(lerp(a[2], b[2], k))},${alpha})`;
}

function seedHex(seed) {
  return ((num(seed) >>> 0).toString(16)).toUpperCase();
}

const goodColor = (g) => CONFIG.goods?.[g]?.color ?? '#999999';
const goodRef = (g) => CONFIG.goods?.[g]?.ref ?? 1;

/** Sizes a canvas backing store to its CSS box × devicePixelRatio. */
function fitCanvas(canvas) {
  const dpr = Math.min(2.5, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
  const w = Math.max(1, canvas.clientWidth || canvas.width || 1);
  const h = Math.max(1, canvas.clientHeight || canvas.height || 1);
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  return { w, h, dpr };
}

// ---------------------------------------------------------------- help overlay copy

const HELP_KEYS = [
  ['Space', 'help.key.space'], ['[  ]', 'help.key.speed'], ['0–9', 'help.key.tools'], ['G', 'help.key.charts'],
  ['H', 'help.key.hide'], ['M', 'help.key.mute'], ['C', 'help.key.cut'], ['F', 'help.key.follow'],
  ['K', 'help.key.clans'], ['Ctrl+S', 'help.key.save'], ['P', 'help.key.debug'], ['W A S D', 'help.key.pan'],
  ['Q  E', 'help.key.orbit'], ['?', 'help.key.help'],
];

// ---------------------------------------------------------------- Hud

/**
 * Top bar, tool tray, market price board, help overlay and global hotkeys.
 */
export class Hud {
  /** @param {object} sim the shared sim context (SPEC §C.1) */
  constructor(sim) {
    this.sim = sim;
    const ui = sim.config?.ui ?? CONFIG.ui ?? {};
    this._period = 1 / Math.max(0.5, num(ui.hudHz, 4));
    this._acc = this._period;
    this._time = 0;
    this._lagUntil = -1;
    this._errors = 0;
    this._helpOpen = false;
    this._help = null;
    this._tipAnchor = null;
    this._trayBuilt = false;
    this._sparkDirty = true;
    this._lastGood = null;
    this._unsubs = [];

    const speeds = sim.config?.time?.speeds ?? CONFIG.time?.speeds ?? [0, 1, 2, 4, 8];
    this._speeds = speeds.filter((s) => s > 0).sort((a, b) => a - b);
    if (!this._speeds.length) this._speeds = [1];

    // Hourly P̄ ring for the sparklines and Δ24h: SPARK_N samples per good.
    this._hist = new Float32Array(GOODS.length * SPARK_N);
    this._histCount = 0;
    this._histHead = 0;
    this._pushHistory();

    this.root = uiRoot();
    this._buildTopbar();
    this._trayBuilt = this._buildTray();
    this._buildBoard();
    this._bindTooltip();
    this._bindKeys();
    this._subscribe();
    this._syncHideUI();
    this._unsubs.push(onLangChange(() => this.relabel()));
    document.documentElement.lang = getLang();
  }

  /**
   * Per-frame hook. Cheap bookkeeping every frame; DOM refresh at `hudHz`.
   * @param {number} realDt real seconds since the last frame
   */
  update(realDt) {
    const dt = Number.isFinite(realDt) && realDt > 0 ? Math.min(realDt, 1) : 0;
    this._time += dt;
    if (this.sim.lagging) this._lagUntil = this._time + 1;
    this._acc += dt;
    if (this._acc < this._period) return;
    this._acc = 0;
    try {
      if (!this._trayBuilt) this._trayBuilt = this._buildTray();
      this._syncHideUI();
      if (this.sim.ui?.hideUI) return;
      this._refreshClock();
      this._refreshSpeed();
      this._refreshStats();
      this._refreshToggles();
      this._refreshTools();
      this._refreshBoard();
      // Redraw sparklines when their canvases change size (resize, monitor change), even while paused.
      const sw = this.$rows?.[0]?.spark?.clientWidth ?? 0;
      if (sw !== this._sparkW) { this._sparkW = sw; this._sparkDirty = true; }
      if (this._sparkDirty) {
        this._sparkDirty = false;
        this._drawSparks();
      }
    } catch (err) {
      if (this._errors++ < 3) console.error('[hud] update failed', err);
    }
  }

  /** Removes listeners (the DOM stays). */
  dispose() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    window.removeEventListener('keydown', this._onKey);
  }

  /** Rebuild every static label in the current language. */
  relabel() {
    document.documentElement.lang = getLang();
    this._hideTip();
    this._buildTopbar();
    this._trayBuilt = this._buildTray();
    this._buildBoard();
    if (this._help) {
      const open = this._helpOpen;
      this._help.remove();
      this._help = null;
      if (open) this._toggleHelp(true);
    }
    this._sparkDirty = true;
    this._forceRefresh();
  }

  // ================================================================ top bar

  _buildTopbar() {
    const sim = this.sim;
    const bar = ensureEl('topbar', 'header', this.root);
    bar.classList.add('wm-topbar');
    bar.textContent = '';

    // World number, new random world and the number input.
    const gSeed = el('div', 'tb-group tb-seed', null, bar);
    const plate = el('div', 'seed-plate', null, gSeed);
    plate.dataset.tipName = t('hud.worldTipName');
    plate.dataset.tip = t('hud.worldTip');
    el('span', 'sp-label', t('hud.world'), plate);
    this.$seed = el('span', 'sp-num', seedHex(sim.seed), plate);
    const reroll = button('tb-btn tb-reroll', '⟳', gSeed, t('hud.reroll'));
    reroll.setAttribute('aria-label', t('hud.reroll'));
    reroll.addEventListener('click', () => {
      let s;
      try { s = randomSeed(); } catch { s = Math.floor(Math.random() * 0xFFFFFFFF); }
      this._reroll(s);
    });
    const input = el('input', 'seed-input', null, gSeed);
    input.type = 'text';
    input.placeholder = t('hud.seedPh');
    input.maxLength = 10;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', t('hud.seedAria'));
    input.dataset.tip = t('hud.seedTip');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const seed = this._parseSeedInput(input.value);
        if (seed == null) {
          input.classList.remove('bad');
          void input.offsetWidth; // restart the shake animation
          input.classList.add('bad');
          return;
        }
        input.classList.remove('bad');
        this._reroll(seed);
      } else if (e.key === 'Escape') {
        input.value = '';
        input.blur();
      }
    });
    input.addEventListener('input', () => input.classList.remove('bad'));
    this.$seedInput = input;

    // Day clock and the next-bell countdown.
    const gClock = el('div', 'tb-group tb-clock', null, bar);
    this.$dial = el('div', 'dial', null, gClock);
    this.$dial.dataset.tip = t('hud.dialTip');
    this.$dialGlyph = el('span', 'dial-glyph', '☀', this.$dial);
    const ct = el('div', 'clock-text', null, gClock);
    this.$clockMain = el('span', 'clock-main', '', ct);
    this.$clockSub = el('span', 'clock-sub', '', ct);

    // Speed buttons and the lagging badge.
    const gSpeed = el('div', 'tb-group tb-speed', null, bar);
    this.$pause = button('tb-btn', '⏸', gSpeed, t('hud.pause'));
    this.$pause.addEventListener('click', () => this._setPaused(!this.sim.paused));
    this.$speedBtns = this._speeds.map((s) => {
      const b = button('tb-btn', `${s}×`, gSpeed, t('hud.speed', { s }));
      b.addEventListener('click', () => this._setSpeed(s));
      return b;
    });
    this.$lag = el('span', 'lag-badge', t('hud.lagging'), gSpeed);
    this.$lag.dataset.tip = t('hud.laggingTip');
    this.$lag.hidden = true;

    // Stats.
    const gStats = el('div', 'tb-group tb-stats', null, bar);
    this.$pop = this._stat(gStats, t('hud.pop'), t('hud.popTip'));
    const light = this._stat(gStats, t('hud.money'), t('hud.moneyTip'), true);
    this.$M = light.value;
    this.$haze = light.bar;
    this.$cpi = this._stat(gStats, t('hud.cpi'), t('hud.cpiTip'));
    this.$gini = this._stat(gStats, t('hud.gini'), t('hud.giniTip'));
    this.$towers = this._stat(gStats, t('hud.towers'), t('hud.towersTip'));

    // Clans: one coloured head count per clan; opens the council.
    this.$clanBtn = null;
    this.$clanChips = null;
    const clans = sim.clans;
    if (clans?.multi) {
      const gClans = el('div', 'tb-group tb-clans', null, bar);
      const b = button('tb-btn tb-clanbtn', null, gClans);
      b.dataset.tipName = t('hud.clans');
      b.dataset.tipKey = 'K';
      b.dataset.tip = t('hud.clansTip');
      el('span', 'tb-clanglyph', '⚑', b);
      this.$clanChips = clans.list.map((cl) => {
        const chip = el('span', 'tb-clanchip', '0', b);
        chip.style.setProperty('--c', cl.flag);
        chip.title = clanName(cl.id);
        return chip;
      });
      b.addEventListener('click', () => this._openCouncil());
      this.$clanBtn = b;
    }

    el('div', 'tb-spacer', null, bar);

    // Toggles.
    const gToggle = el('div', 'tb-group tb-toggles', null, bar);
    const other = LANGS.find((l) => l.id !== getLang()) || LANGS[0];
    const lang = button('tb-btn tb-toggle tb-lang', LANGS.find((l) => l.id === getLang())?.short ?? 'EN', gToggle, t('hud.lang'));
    lang.addEventListener('click', () => { setLang(other.id); this._rememberLang(other.id); });
    this.$menuBtn = button('tb-btn tb-toggle', '☰', gToggle, t('hud.menu'));
    this.$menuBtn.addEventListener('click', () => this.sim.menu?.toggle?.());
    this.$mute = button('tb-btn tb-toggle', '♪', gToggle, t('hud.mute'));
    this.$mute.addEventListener('click', () => this._toggleMute());
    this.$cut = button('tb-btn tb-toggle', '◧', gToggle, t('hud.cut'));
    this.$cut.addEventListener('click', () => this._toggleCutaway());
    this.$helpBtn = button('tb-btn tb-toggle', '?', gToggle, t('hud.help'));
    this.$helpBtn.addEventListener('click', () => this._toggleHelp());
  }

  _rememberLang(id) {
    try { localStorage.setItem('wm.lang', id); } catch { /* storage may be blocked */ }
  }

  _openCouncil() {
    const c = this.sim.council;
    if (c && typeof c.toggle === 'function') c.toggle();
  }

  _stat(parent, label, tip, withBar = false) {
    const s = el('div', 'stat', null, parent);
    s.dataset.tipName = label;
    s.dataset.tip = tip;
    el('span', 'stat-l', label, s);
    if (!withBar) return el('span', 'stat-v', '—', s);
    const row = el('div', 'stat-row', null, s);
    const value = el('span', 'stat-v', '—', row);
    const barBox = el('span', 'haze-bar', null, row);
    const bar = el('i', null, null, barBox);
    return { value, bar };
  }

  _parseSeedInput(raw) {
    const s = String(raw || '').trim();
    if (!/^(0x)?[0-9a-f]{1,8}$/i.test(s)) return null;
    let seed;
    try { seed = parseSeed(s); } catch { seed = NaN; }
    if (!Number.isFinite(seed)) seed = parseInt(s.replace(/^0x/i, ''), 16);
    return Number.isFinite(seed) ? seed >>> 0 : null;
  }

  _reroll(seed) {
    this._emit(EV.REROLL, { seed: num(seed) >>> 0 });
  }

  _refreshClock() {
    const clock = this.sim.clock;
    if (!clock) return;
    const tick = num(clock.tick);
    const c = clockParts(tick);
    setText(this.$clockMain, t('hud.clock', { d: c.day + 1, time: `${pad2(c.hour)}:${pad2(c.min)}` }));
    const night = clock.isNight ?? (c.hour < 6 || c.hour >= 18);
    toggleClass(this.$dial, 'night', night);
    setText(this.$dialGlyph, night ? '☾' : '☀');
    setStyle(this.$dial, '--p', c.frac.toFixed(4));

    const inHour = ((tick % PER_HOUR) + PER_HOUR) % PER_HOUR;
    const ticksLeft = inHour === 0 ? PER_HOUR : PER_HOUR - inHour;
    const nextHour = (c.hour + 1) % 24;
    let sub;
    if (this.sim.paused) {
      sub = t('hud.paused', { time: `${pad2(nextHour)}:00` });
    } else {
      const secs = ticksLeft / (PER_SEC * Math.max(0.01, num(this.sim.speed, 1)));
      const s = secs < 10 ? fmtNum(secs, 1) : String(Math.round(secs));
      sub = t(nextHour === 18 ? 'hud.eveningBell' : 'hud.nextBell', { s });
    }
    setText(this.$clockSub, sub);
  }

  _refreshSpeed() {
    const sim = this.sim;
    toggleClass(this.$pause, 'on', !!sim.paused);
    for (let i = 0; i < this._speeds.length; i++) {
      toggleClass(this.$speedBtns[i], 'on', !sim.paused && this._speeds[i] === sim.speed);
    }
    setHidden(this.$lag, !(this._time < this._lagUntil));
  }

  _refreshStats() {
    const sim = this.sim;
    const agents = sim.population?.agents;
    if (Array.isArray(agents)) {
      let housed = 0;
      for (let i = 0; i < agents.length; i++) if (agents[i] && agents[i].homeId != null) housed++;
      setText(this.$pop, `${housed}/${agents.length}`);
      if (this.$clanChips) {
        const n = this.$clanChips.map(() => 0);
        for (let i = 0; i < agents.length; i++) {
          const c = agents[i]?.clan ?? 0;
          if (c < n.length) n[c]++;
        }
        for (let c = 0; c < n.length; c++) setText(this.$clanChips[c], String(n[c]));
      }
    }
    const ledger = sim.ledger;
    if (ledger) {
      let M = ledger.M;
      if (!Number.isFinite(M) && typeof ledger.moneySupply === 'function') M = ledger.moneySupply();
      setText(this.$M, fmtInt(M));
      const eta = Number.isFinite(ledger.haze) ? ledger.haze : 1;
      setStyle(this.$haze, 'width', `${(Math.min(1, Math.max(0, 1 - eta)) * 100).toFixed(1)}%`);
      const cpi = typeof ledger.cpi === 'function' ? ledger.cpi() : NaN;
      setText(this.$cpi, fmtNum(cpi, 1));
      const gini = typeof ledger.gini === 'function' ? ledger.gini() : NaN;
      setText(this.$gini, fmtNum(gini, 2));
    }
    const prod = sim.production;
    if (prod) {
      const lit = typeof prod.activeTowerCount === 'function' ? prod.activeTowerCount() : 0;
      const total = Array.isArray(prod.towers) ? prod.towers.length : 0;
      setText(this.$towers, `${num(lit)}/${total}`);
    }
  }

  _refreshToggles() {
    const ui = this.sim.ui || {};
    toggleClass(this.$mute, 'muted', !!ui.muted);
    toggleClass(this.$cut, 'on', ui.cutaway != null);
    toggleClass(this.$helpBtn, 'on', this._helpOpen);
    toggleClass(this.$menuBtn, 'on', !!this.sim.menu?.isOpen?.());
    if (this.$clanBtn) toggleClass(this.$clanBtn, 'on', !!this.sim.council?.isOpen?.());
  }

  // ================================================================ tool tray

  _buildTray() {
    const tools = this.sim.tools?.tools;
    if (!Array.isArray(tools) || !tools.length) return false;
    const tray = ensureEl('tooltray', 'nav', this.root);
    tray.classList.add('wm-card', 'wm-tray');
    tray.textContent = '';
    el('div', 'tt-title', t('hud.tools'), tray);
    this.$toolBtns = new Map();
    for (const tl of tools) {
      if (!tl || !tl.id) continue;
      const b = button('tt-btn', null, tray);
      el('span', 'tt-glyph', tl.glyph ?? '•', b);
      if (tl.hotkey != null) el('span', 'tt-key', String(tl.hotkey), b);
      b.dataset.tipName = tl.name ?? tl.id;
      if (tl.hotkey != null) b.dataset.tipKey = String(tl.hotkey);
      b.dataset.tip = tl.blurb ?? '';
      b.setAttribute('aria-label', `${tl.name ?? tl.id}${tl.hotkey != null ? ` (${tl.hotkey})` : ''}`);
      b.addEventListener('click', () => {
        const tt = this.sim.tools;
        if (tt && typeof tt.setActive === 'function') tt.setActive(tl.id);
        b.blur();
      });
      this.$toolBtns.set(tl.id, b);
    }
    this._activeTool = null;
    this._markTool(this.sim.tools.active);
    return true;
  }

  _markTool(id) {
    if (!this.$toolBtns || id === this._activeTool) return;
    this._activeTool = id;
    for (const [tid, b] of this.$toolBtns) toggleClass(b, 'on', tid === id);
  }

  _refreshTools() {
    const active = this.sim.tools?.active;
    if (active != null) this._markTool(active);
  }

  // ================================================================ market board

  /** Column plan for n markets: sparklines, Δ and stock only while they fit. */
  _boardLayout(n) {
    const s = (px) => `calc(${px}px * var(--s))`;
    if (n <= 2) {
      return { spark: true, delta: true, piles: true,
        cols: `minmax(0, 1fr) repeat(${n}, ${s(47)}) ${s(38)} ${s(50)} ${s(42)}` };
    }
    if (n === 3) return { spark: false, delta: true, piles: true, cols: `minmax(0, 1fr) repeat(3, ${s(45)}) ${s(38)} ${s(34)}` };
    return { spark: false, delta: false, piles: false, cols: `${s(n >= 6 ? 64 : 72)} repeat(${n}, minmax(0, 1fr))` };
  }

  _buildBoard() {
    const panel = ensureEl('rightpanel', 'aside', this.root);
    const board = ensureEl('marketboard', 'section', panel);
    board.classList.add('wm-card', 'wm-board');
    board.textContent = '';
    const nm = Math.max(1, this.sim.market?.markets?.length ?? 2);
    const L = this._boardLayout(nm);
    this._layout = L;
    this._nm = nm;
    this.root.classList.toggle('clans-many', nm >= 5);

    const head = el('div', 'card-head', null, board);
    el('h2', 'wm-h', t('hud.board'), head);
    this.$boardSub = el('span', 'card-sub', t('hud.boardWaiting'), head);

    const grid = el('div', 'mb-grid', null, board);
    const hdr = el('div', 'mb-row mb-hdr', null, grid);
    hdr.style.gridTemplateColumns = L.cols;
    el('span', null, t('hud.good'), hdr);
    const clans = this.sim.clans;
    this.$mkBtns = [];
    for (let m = 0; m < nm; m++) {
      const b = button('mb-mk', marketShort(m), hdr, t('hud.marketTip', { market: marketName(m) }));
      if (clans?.multi) {
        const cl = clans.list[this.sim.market.markets[m]?.clan ?? 0];
        if (cl) b.style.setProperty('--c', cl.flag);
        b.classList.add('clan');
      }
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this._selectMarket(m);
      });
      this.$mkBtns.push(b);
    }
    if (L.delta) {
      const dH = el('span', null, t('hud.delta'), hdr);
      dH.dataset.tip = t('hud.deltaTip');
    }
    if (L.spark) el('span', null, t('hud.spark'), hdr);
    if (L.piles) {
      const pH = el('span', null, t('hud.piles'), hdr);
      const names = [];
      for (let m = 0; m < nm; m++) names.push(marketShort(m));
      pH.dataset.tip = t('hud.pilesTip', { names: names.join(' / ') });
    }

    this.$rows = GOODS.map((g) => {
      const row = el('div', 'mb-row', null, grid);
      row.style.gridTemplateColumns = L.cols;
      row.dataset.good = g;
      row.dataset.tipName = goodName(g);
      row.dataset.tip = `${t(`goodInfo.${g}`)} ${t('hud.rowTip')}`;
      const gCell = el('span', 'mb-good', null, row);
      const sw = el('i', 'sw', null, gCell);
      sw.style.setProperty('--c', goodColor(g));
      el('b', null, goodName(g), gCell);
      const prices = [];
      for (let m = 0; m < nm; m++) {
        const cell = el('span', 'mb-p', null, row);
        const seal = el('i', 'seal', '●', cell);
        seal.hidden = true;
        const txt = el('span', null, '—', cell);
        prices.push({ cell, seal, txt });
      }
      const delta = L.delta ? el('span', 'mb-d', '0%', row) : null;
      const spark = L.spark ? el('canvas', 'mb-spark', null, row) : null;
      const piles = L.piles ? el('span', 'mb-piles', '0', row) : null;
      row.addEventListener('click', () => this._selectGood(g));
      return { row, prices, delta, spark, piles };
    });
    this._lastGood = null;
    this._sparkW = -1;
  }

  _selectGood(good) {
    const ui = this.sim.ui;
    if (ui) {
      ui.selectedGood = good;
      ui.chartTab = 'prices';
    }
    this._emit(EV.SELECT_GOOD, { good });
    const charts = this.sim.charts;
    if (charts && typeof charts.setTab === 'function') charts.setTab('prices');
    this._refreshSelectedRow();
  }

  _selectMarket(m) {
    const ui = this.sim.ui || {};
    if (ui.selectedAgentId != null) this._emit(EV.SELECT_AGENT, { agentId: null });
    this._emit(EV.SELECT_MARKET, { marketId: m });
  }

  _refreshSelectedRow() {
    const g = this.sim.ui?.selectedGood ?? null;
    if (g === this._lastGood) return;
    this._lastGood = g;
    for (let i = 0; i < GOODS.length; i++) toggleClass(this.$rows[i].row, 'sel', GOODS[i] === g);
  }

  _refreshBoard() {
    const market = this.sim.market;
    this._refreshSelectedRow();
    if (!market) return;
    const nm = this._nm;
    const L = this._layout;
    const piles = [];
    if (L.piles && typeof market.getPiles === 'function') {
      // getPiles returns one reused object per plaza; copy the numbers we need.
      for (let m = 0; m < nm; m++) piles.push({ ...market.getPiles(m) });
    }
    const hasSeal = typeof market.activeSeal === 'function';

    for (let i = 0; i < GOODS.length; i++) {
      const g = GOODS[i];
      const r = this.$rows[i];
      const ref = goodRef(g);
      for (let m = 0; m < nm; m++) {
        const P = typeof market.price === 'function' ? market.price(m, g) : NaN;
        const c = r.prices[m];
        setText(c.txt, fmtPrice(P));
        setStyle(c.cell, 'background', scarcityColor(P / ref));
        const seal = hasSeal ? market.activeSeal(m, g) : null;
        setHidden(c.seal, !seal);
        if (seal) {
          const until = clockParts(seal.untilTick);
          c.seal.dataset.tip = t('hud.sealTip', { kind: seal.kind, price: seal.price, d: until.day + 1, time: `${pad2(until.hour)}:${pad2(until.min)}` });
        }
      }
      if (r.delta) {
        const d = this._delta24(i, typeof market.avgPrice === 'function' ? market.avgPrice(g) : NaN);
        setText(r.delta, fmtPct(d));
        toggleClass(r.delta, 'up', d >= 0.005);
        toggleClass(r.delta, 'down', d <= -0.005);
      }
      if (r.piles) {
        if (nm <= 2) setText(r.piles, piles.map((p) => num(p?.[g])).join('/'));
        else {
          let sum = 0;
          for (const p of piles) sum += num(p?.[g]);
          setText(r.piles, String(sum));
        }
      }
    }

    const clock = this.sim.clock;
    if (clock && this._histCount > 1) {
      const c = clockParts(Math.floor(num(clock.tick) / PER_HOUR) * PER_HOUR);
      const sealed = Array.isArray(this.sim.effects?.seals) ? this.sim.effects.seals.length : 0;
      const sub = t('hud.boardSub', { time: `${pad2(c.hour)}:00` });
      setText(this.$boardSub, sealed ? `${sub} · ${t('hud.boardSeals', { n: sealed })}` : sub);
    }
  }

  _pushHistory() {
    const market = this.sim.market;
    if (!market || typeof market.avgPrice !== 'function') return;
    const h = this._histHead;
    for (let i = 0; i < GOODS.length; i++) this._hist[i * SPARK_N + h] = num(market.avgPrice(GOODS[i]), goodRef(GOODS[i]));
    this._histHead = (h + 1) % SPARK_N;
    if (this._histCount < SPARK_N) this._histCount++;
  }

  /** Δ of P̄ against the oldest sample in the 24h ring (the full ring spans exactly 24 bells). */
  _delta24(gi, now) {
    if (this._histCount < 2 || !Number.isFinite(now)) return 0;
    const oldest = (this._histHead - this._histCount + SPARK_N) % SPARK_N;
    const then = this._hist[gi * SPARK_N + oldest];
    return then > 0 ? now / then - 1 : 0;
  }

  _drawSparks() {
    const n = this._histCount;
    for (let i = 0; i < GOODS.length; i++) {
      const canvas = this.$rows[i].spark;
      const ctx = canvas && canvas.getContext && canvas.getContext('2d');
      if (!ctx) continue;
      const { w, h, dpr } = fitCanvas(canvas);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (n < 1) continue;
      const base = i * SPARK_N;
      const start = (this._histHead - n + SPARK_N) % SPARK_N;
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < n; k++) {
        const v = this._hist[base + ((start + k) % SPARK_N)];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const ref = goodRef(GOODS[i]);
      if (hi - lo < ref * 0.04) {
        const mid = (hi + lo) / 2;
        lo = mid - ref * 0.02;
        hi = mid + ref * 0.02;
      }
      const padY = 2;
      const step = (w - 4) / (SPARK_N - 1);
      const x = (k) => 1.5 + (SPARK_N - n + k) * step;       // newest sample at the right edge
      const y = (v) => padY + (1 - (v - lo) / (hi - lo)) * (h - 2 * padY);

      if (ref > lo && ref < hi) {
        ctx.strokeStyle = 'rgba(27,23,18,0.25)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y(ref)) + 0.5);
        ctx.lineTo(w, Math.round(y(ref)) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const v = this._hist[base + ((start + k) % SPARK_N)];
        if (k === 0) ctx.moveTo(x(k), y(v));
        else ctx.lineTo(x(k), y(v));
      }
      ctx.strokeStyle = '#3F362A';
      ctx.lineWidth = 1.25;
      ctx.lineJoin = 'round';
      ctx.stroke();
      const lastV = this._hist[base + ((start + n - 1) % SPARK_N)];
      ctx.fillStyle = scarcityColor(lastV / ref, 1);
      ctx.strokeStyle = '#1B1712';
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.arc(x(n - 1), y(lastV), 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // ================================================================ tooltip

  _bindTooltip() {
    this.$tip = ensureEl('tooltip', 'div', this.root);
    this.$tip.classList.add('wm-tip');
    this.$tip.hidden = true;
    this.$tip.textContent = '';
    const row = el('div', 'tip-row', null, this.$tip);
    this.$tipName = el('span', 'tip-name', '', row);
    this.$tipKey = el('span', 'tip-key', '', row);
    this.$tipBlurb = el('div', 'tip-blurb', '', this.$tip);

    this.root.addEventListener('pointerover', (e) => {
      const tg = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (tg && tg !== this._tipAnchor && this.root.contains(tg)) this._showTip(tg);
      else if (!tg && this._tipAnchor) this._hideTip();
    });
    this.root.addEventListener('pointerout', (e) => {
      if (!this._tipAnchor) return;
      const to = e.relatedTarget;
      if (!to || !this._tipAnchor.contains(to)) this._hideTip();
    });
    this.root.addEventListener('pointerdown', () => this._hideTip());
  }

  _showTip(anchor) {
    const text = anchor.dataset.tip || '';
    const name = anchor.dataset.tipName || '';
    if (!text && !name) return;
    this._tipAnchor = anchor;
    this.$tipName.textContent = name;
    this.$tipName.hidden = !name;
    this.$tipKey.textContent = anchor.dataset.tipKey || '';
    this.$tipKey.hidden = !anchor.dataset.tipKey;
    this.$tipBlurb.textContent = text;
    this.$tipBlurb.hidden = !text;
    this.$tip.hidden = false;

    const r = anchor.getBoundingClientRect();
    const tw = this.$tip.offsetWidth;
    const th = this.$tip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x;
    let y;
    if (this.$toolBtns && anchor.classList.contains('tt-btn')) {
      x = r.right + 8;
      y = r.top + (r.height - th) / 2;
    } else {
      x = r.left + (r.width - tw) / 2;
      y = r.bottom + 6;
      if (y + th > vh - 4) y = r.top - th - 6;
    }
    x = Math.max(4, Math.min(vw - tw - 4, x));
    y = Math.max(4, Math.min(vh - th - 4, y));
    this.$tip.style.left = `${Math.round(x)}px`;
    this.$tip.style.top = `${Math.round(y)}px`;
  }

  _hideTip() {
    this._tipAnchor = null;
    if (this.$tip) this.$tip.hidden = true;
  }

  // ================================================================ help overlay

  _toggleHelp(force) {
    const open = force != null ? !!force : !this._helpOpen;
    if (open && !this._help) this._buildHelp();
    this._helpOpen = open;
    if (this._help) this._help.hidden = !open;
    toggleClass(this.$helpBtn, 'on', open);
    if (open) this._hideTip();
  }

  _buildHelp() {
    const overlay = el('div', null, null, this.root);
    overlay.id = 'help-overlay';
    overlay.hidden = true;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this._toggleHelp(false); });
    const card = el('div', 'wm-card help-card', null, overlay);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', t('help.title'));
    const close = button('wm-btn help-close', '✕', card);
    close.setAttribute('aria-label', t('menu.close'));
    close.addEventListener('click', () => this._toggleHelp(false));
    el('h2', 'wm-h', t('help.title'), card);
    el('p', 'help-lede', t('help.lede'), card);

    const grid = el('div', 'help-grid', null, card);

    const s1 = el('div', 'help-sec', null, grid);
    el('h3', null, t('help.money.h'), s1);
    el('p', null, t('help.money.p1'), s1);
    const ramp = el('div', 'help-ramp flame', null, s1);
    ramp.setAttribute('aria-hidden', 'true');
    const rl = el('div', 'help-ramp-l', null, s1);
    el('span', null, t('help.poor'), rl);
    el('span', null, t('help.rich'), rl);
    el('p', null, t('help.money.p2'), s1);

    const s2 = el('div', 'help-sec', null, grid);
    el('h3', null, t('help.bell.h'), s2);
    el('p', null, t('help.bell.p1'), s2);
    el('div', 'help-ramp scarcity', null, s2);
    const sl = el('div', 'help-ramp-l', null, s2);
    el('span', null, t('help.cheap'), sl);
    el('span', null, t('help.normal'), sl);
    el('span', null, t('help.dear'), sl);
    el('p', null, t('help.bell.p2'), s2);

    const s3 = el('div', 'help-sec', null, grid);
    el('h3', null, t('help.jobs.h'), s3);
    el('p', null, t('help.jobs.p'), s3);
    const sw = el('div', 'help-swatches', null, s3);
    const profs = CONFIG.professions || {};
    for (const p of Object.keys(profs)) {
      const item = el('span', null, null, sw);
      item.dataset.tip = t(`profInfo.${p}`);
      const chip = el('i', 'sw', null, item);
      chip.style.setProperty('--c', profs[p].color);
      item.appendChild(document.createTextNode(profName(p)));
    }
    const goodsList = el('ul', 'help-goods', null, s3);
    for (const g of GOODS) {
      const li = el('li', null, null, goodsList);
      const chip = el('i', 'sw', null, li);
      chip.style.setProperty('--c', goodColor(g));
      el('b', null, ` ${goodName(g)}: `, li);
      li.appendChild(document.createTextNode(t(`goodInfo.${g}`)));
    }

    const s4 = el('div', 'help-sec', null, grid);
    el('h3', null, t('help.tools.h'), s4);
    const tl = el('div', 'help-tools', null, s4);
    const tools = Array.isArray(this.sim.tools?.tools) ? this.sim.tools.tools : [];
    for (const tt of tools) {
      el('span', 'g', tt.glyph ?? '•', tl);
      el('span', 'n', `${tt.hotkey != null ? tt.hotkey + ' · ' : ''}${tt.name ?? tt.id}`, tl);
      el('span', 'b', tt.blurb ?? '', tl);
    }

    const s7 = el('div', 'help-sec', null, grid);
    el('h3', null, t('help.clans.h'), s7);
    el('p', null, t('help.clans.p1'), s7);
    el('p', null, t('help.clans.p2'), s7);

    const s8 = el('div', 'help-sec', null, grid);
    el('h3', null, t('help.save.h'), s8);
    el('p', null, t('help.save.p'), s8);

    const s5 = el('div', 'help-sec', null, grid);
    el('h3', null, t('help.keys.h'), s5);
    const keys = el('div', 'help-keys', null, s5);
    for (const [k, v] of HELP_KEYS) {
      const kbd = el('span', null, null, keys);
      el('kbd', 'wm-kbd', k, kbd);
      el('span', null, t(v), keys);
    }

    const s6 = el('div', 'help-sec', null, grid);
    el('h3', null, t('help.mouse.h'), s6);
    const mk = el('div', 'help-keys', null, s6);
    for (const [k, v] of [[t('tool.inspect.name'), 'help.mouse.look'], [t('help.mouse.otherName'), 'help.mouse.other']]) {
      el('span', null, null, mk).appendChild(el('kbd', 'wm-kbd', k));
      el('span', null, t(v), mk);
    }
    const ul = el('ul', null, null, s6);
    el('li', null, t('help.tip1'), ul);
    el('li', null, t('help.tip2'), ul);
    el('li', null, t('help.tip3'), ul);

    this._help = overlay;
  }

  // ================================================================ global keys

  _bindKeys() {
    this._onKey = (e) => {
      if (isTypingTarget(document.activeElement)) return;
      // Ctrl+S: quick save (the browser's "save page" is useless here).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        this.sim.menu?.quickSave?.();
        return;
      }
      // AltGr arrives as Ctrl+Alt on Windows; it is needed for [ and ] on many layouts.
      if (e.metaKey || (e.ctrlKey && !e.altKey)) return;
      const key = e.key;
      const code = e.code;
      if (key === 'Escape') {
        if (this._helpOpen) this._toggleHelp(false);
        return;
      }
      // Menus and the council take the keyboard while they are open.
      if (document.querySelector('.wm-overlay:not([hidden])')) return;
      if (e.repeat) {
        if (key === '[' || key === ']') e.preventDefault();
        return;
      }
      if (key === ' ' || code === 'Space') {
        e.preventDefault();
        this._setPaused(!this.sim.paused);
        return;
      }
      if (key === '[') {
        e.preventDefault();
        this._stepSpeed(-1);
        return;
      }
      if (key === ']') {
        e.preventDefault();
        this._stepSpeed(1);
        return;
      }
      if (key === '?') {
        // SPEC-GAP: '?' also opens the help overlay (the spec gives it only a toggle button).
        this._toggleHelp();
        return;
      }
      switch ((key || '').toLowerCase()) {
        case 'g': this._toggleDrawer(); break;
        case 'h': this._toggleHideUI(); break;
        case 'm': this._toggleMute(); break;
        case 'c': this._toggleCutaway(); break;
        case 'f': this._toggleFollow(); break;
        case 'k': this._openCouncil(); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', this._onKey);
  }

  _setPaused(paused) {
    this.sim.paused = !!paused;
    this._emit(EV.SPEED, { speed: this.sim.speed, paused: this.sim.paused });
    this._forceRefresh();
  }

  _setSpeed(speed) {
    this.sim.speed = speed;
    this.sim.paused = false;
    this._emit(EV.SPEED, { speed, paused: false });
    this._forceRefresh();
  }

  /** `[`/`]`: steps through ⏸ → 1× → 2× → 4× → 8×. */
  _stepSpeed(dir) {
    const sp = this._speeds;
    let level = 0;
    if (!this.sim.paused) {
      let best = 0;
      for (let i = 0; i < sp.length; i++) if (Math.abs(sp[i] - this.sim.speed) < Math.abs(sp[best] - this.sim.speed)) best = i;
      level = best + 1;
    }
    const next = Math.max(0, Math.min(sp.length, level + dir));
    if (next === level) return;
    if (next === 0) this._setPaused(true);
    else this._setSpeed(sp[next - 1]);
  }

  _toggleDrawer() {
    const charts = this.sim.charts;
    if (charts && typeof charts.toggleDrawer === 'function') {
      charts.toggleDrawer();
      return;
    }
    const drawer = document.getElementById('drawer');
    if (!drawer) return;
    const collapsed = !drawer.classList.contains('collapsed');
    drawer.classList.toggle('collapsed', collapsed);
    this.root.classList.toggle('drawer-collapsed', collapsed);
  }

  _toggleHideUI() {
    const ui = this.sim.ui;
    if (!ui) return;
    ui.hideUI = !ui.hideUI;
    this._syncHideUI();
    if (ui.hideUI) {
      this._hideTip();
    } else {
      this._forceRefresh();
      this._sparkDirty = true;
    }
  }

  _syncHideUI() {
    toggleClass(this.root, 'ui-hidden', !!this.sim.ui?.hideUI);
  }

  _toggleMute() {
    const ui = this.sim.ui;
    if (!ui) return;
    ui.muted = !ui.muted;
    if (!ui.muted) {
      const fx = this.sim.fx;
      if (fx && typeof fx.resumeAudio === 'function') fx.resumeAudio();
    }
    this._refreshToggles();
  }

  /** ADDENDUM §8: cutaway toggles between null and the rounded camera-target y. */
  _toggleCutaway() {
    const ui = this.sim.ui;
    const r = this.sim.renderer;
    if (!ui) return;
    if (ui.cutaway != null) {
      ui.cutaway = null;
    } else {
      const y = r?.controls?.target?.y;
      if (!Number.isFinite(y)) return;
      ui.cutaway = Math.round(y);
    }
    if (r && typeof r.setCutaway === 'function') r.setCutaway(ui.cutaway);
    this._refreshToggles();
  }

  /** ADDENDUM §8: F follows the selected agent, or stops following. */
  _toggleFollow() {
    const ui = this.sim.ui || {};
    const agentId = ui.followAgentId != null ? null : ui.selectedAgentId ?? null;
    this._emit(EV.FOLLOW, { agentId });
  }

  _forceRefresh() {
    this._acc = this._period;
  }

  // ================================================================ events

  _subscribe() {
    const bus = this.sim.events;
    if (!bus || typeof bus.on !== 'function') return;
    const on = (name, fn) => {
      if (!name) return;
      const off = bus.on(name, fn);
      this._unsubs.push(typeof off === 'function' ? off : () => bus.off?.(name, fn));
    };
    on(EV.TOOL_CHANGED, (p) => this._markTool(p?.tool));
    on(EV.MARKET_CHIME, (p) => {
      const n = this.sim.market?.markets?.length || 2;
      if (p && p.marketId !== n - 1) return;       // sample once, after the last plaza cleared
      this._pushHistory();
      this._sparkDirty = true;
    });
    on(EV.SELECT_GOOD, () => this._refreshSelectedRow());
    on(EV.SPEED, () => this._forceRefresh());
    on(EV.POLICY, () => this._forceRefresh());
  }

  _emit(name, payload) {
    const bus = this.sim.events;
    if (name && bus && typeof bus.emit === 'function') bus.emit(name, payload);
  }
}
