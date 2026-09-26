/**
 * @file Inspector (SPEC §F "Inspector", §C.4 G6, ADDENDUM §8): the right-panel card under the price
 * board that shows either one Wickling or one market's offers.
 *
 * DOM only (plus `THREE.Vector3` points for the path line). Listens to SELECT_AGENT and
 * SELECT_MARKET itself; writes only `sim.ui` (selectedMarketId, selectedGood, chartTab) and emits
 * UI events (SELECT_AGENT / SELECT_MARKET null from ✕, FOLLOW, FLY_TO, SELECT_GOOD). Each view's
 * DOM is built once (again after a language change) and re-filled per selection; `update()`
 * rewrites text at `CONFIG.ui.hudHz` and touches only nodes whose content changed. "Show path"
 * re-sends the remaining path to `sim.fx.setPathLine` at 4 Hz. When the inspected Wickling dies
 * or leaves, its epitaph shows and the card closes 4 s later.
 */
import * as THREE from 'three';
import { CONFIG, TICKS, GOODS, PROFESSIONS, ITEMS } from '../core/config.js';
import { EV } from '../core/events.js';
import { scarcityColor } from './hud.js';
import {
  t, tr, onLangChange, fmtPrice, fmtNum, fmtSigned, goodName, profName, marketName, marketShort, clanName,
} from '../core/i18n.js';

const PER_HOUR = TICKS?.PER_HOUR ?? 100;
const PER_DAY = TICKS?.PER_DAY ?? 2400;
const MINUS = '−';
const EPITAPH_SEC = 4;
const PATH_PERIOD = 0.25;                 // "Show path" refresh: 4 Hz (SPEC §F)
const MAX_PATH_POINTS = 512;
const LADDER = 5;                         // depth ladder rows per side
const STRIP_N = 25;                       // 24 bells back + now
const FLAME_RICH = 400;                   // glim at which the flame icon reaches full size / white
const BELIEF_BAND = 1.03;                 // |P / belief − 1| below 3% shows no arrow
const MARKET_LINE = ['#B08D57', '#3E7C8C'];
const FLAME_RAMP = [[0xFF, 0x7A, 0x2E], [0xFF, 0xC2, 0x47], [0xFF, 0xF4, 0xD6]];
const NEEDS = [['tallow', '#D9A441'], ['rest', '#5B6FA8'], ['lustre', '#E8961E']];
const ITEM_COLORS = { lens: '#BFE6F0' };
const SKILL_MIN = CONFIG.agent?.skill?.min ?? 0.6;
const SKILL_MAX = CONFIG.agent?.skill?.max ?? 1.5;
const HUNGRY = CONFIG.agent?.hungry ?? 25;

const DASH_REF = [2, 2];
const NO_DASH = [];

const byLimitDesc = (a, b) => b.limit - a.limit;
const byAskAsc = (a, b) => a.ask - b.ask;

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

function setStyle(node, prop, value) {
  const key = '_wm_' + prop;
  if (node && node[key] !== value) {
    node[key] = value;
    if (prop.startsWith('--')) node.style.setProperty(prop, value);
    else node.style[prop] = value;
  }
}

function setHidden(node, hidden) {
  if (node && node.hidden !== !!hidden) node.hidden = !!hidden;
}

function toggleClass(node, cls, on) {
  if (node && node.classList.contains(cls) !== !!on) node.classList.toggle(cls, !!on);
}

function setClass(node, cls) {
  if (node && node._wmCls !== cls) {
    node._wmCls = cls;
    node.className = cls;
  }
}

const finite = (v, d = 0) => (Number.isFinite(v) ? v : d);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const pad2 = (n) => (n < 10 ? '0' + n : String(n));
const itemName = (g) => (g === 'lens' ? t('good.lens') : goodName(g));
const goodColor = (g) => CONFIG.goods?.[g]?.color ?? ITEM_COLORS[g] ?? '#999999';
const goodRef = (g) => CONFIG.goods?.[g]?.ref ?? 1;
const profColor = (p) => CONFIG.professions?.[p]?.color ?? '#999999';
const carryOf = (p) => CONFIG.professions?.[p]?.carry ?? 0;
const goalName = (g) => (g ? t(`goal.${g}`) : '—');

function rampColor(k) {
  const x = clamp01(k) * 2;
  const i = x >= 1 ? 1 : 0;
  const f = x - i;
  const a = FLAME_RAMP[i];
  const b = FLAME_RAMP[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

function fmtGlim(v) {
  if (!Number.isFinite(v)) return '—';
  return Math.abs(v) >= 100 ? fmtNum(v, 0) : fmtNum(v, 1);
}

function clockTime(tick) {
  const tk = Math.max(0, Math.floor(finite(tick)));
  const inDay = tk % PER_DAY;
  return `${pad2(Math.floor(inDay / PER_HOUR))}:${pad2(Math.floor(((inDay % PER_HOUR) * 60) / PER_HOUR))}`;
}

function ageOf(a, tick) {
  if (Number.isFinite(a?.ageDays)) return a.ageDays;
  if (Number.isFinite(a?.bornTick)) return (tick - a.bornTick) / PER_DAY;
  return NaN;
}

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

function uiRoot() {
  let root = document.getElementById('ui-root');
  if (!root) {
    // SPEC-GAP: index.html (G2) provides #ui-root; build a bare one if it is missing.
    root = el('div', null, null, document.getElementById('app') || document.body);
    root.id = 'ui-root';
  }
  return root;
}

function section(parent, title, tip) {
  const s = el('div', 'ins-sec', null, parent);
  const h = el('h3', 'ins-sec-h', title, s);
  if (tip) {
    h.dataset.tipName = title;
    h.dataset.tip = tip;
  }
  return s;
}

function meter(parent, label, color, thin) {
  const row = el('div', 'meter', null, parent);
  const l = el('span', null, label, row);
  const bar = el('div', thin ? 'bar thin' : 'bar', null, row);
  const fill = el('i', null, null, bar);
  if (color) fill.style.setProperty('--bc', color);
  const num = el('span', 'num', '—', row);
  return { row, l, fill, num };
}

function kv(parent, label) {
  const d = el('div', 'kv', null, parent);
  return { box: d, k: el('span', 'k', label, d), v: el('span', 'v', '—', d) };
}

// ---------------------------------------------------------------- Inspector

/**
 * The inspector card inside `#rightpanel` (`#inspector`, shown and hidden via `hidden`).
 */
export class Inspector {
  /** @param {object} sim the shared sim context (SPEC §C.1) */
  constructor(sim) {
    this.sim = sim;
    const ui = sim.config?.ui ?? CONFIG.ui ?? {};
    this._period = 1 / Math.max(0.5, finite(ui.hudHz, 4) || 4);
    this._acc = this._period;
    this._pathAcc = PATH_PERIOD;
    this._errors = 0;
    this._unsubs = [];

    /** @type {null|'agent'|'market'} what the card shows */
    this.mode = null;
    this.agentId = null;
    this.agent = null;
    this.marketId = null;

    this._dead = false;
    this._deadLeft = 0;
    this._showPath = false;
    this._pathShown = false;
    this._pathRef = null;
    this._pathI = -1;
    this._ppx = NaN;
    this._ppy = NaN;
    this._ppz = NaN;
    this._stripsDirty = true;
    this._stripW = 0;
    this._bidScratch = [];
    this._lotScratch = [];

    this.root = uiRoot();
    let panel = document.getElementById('rightpanel');
    if (!panel) {
      panel = el('aside', null, null, this.root);
      panel.id = 'rightpanel';
    }
    let box = document.getElementById('inspector');
    if (!box) {
      box = el('section', null, null, panel);
      box.id = 'inspector';
    }
    box.classList.add('wm-card', 'wm-inspector');
    box.textContent = '';
    box.hidden = true;
    box.setAttribute('aria-label', t('ins.aria'));
    this.$root = box;
    this.$a = null;
    this.$m = null;

    this._subscribe();
    this._unsubs.push(onLangChange(() => this.relabel()));
    const u = sim.ui || {};
    if (u.selectedAgentId != null) this._openAgent(u.selectedAgentId);
    else if (u.selectedMarketId != null) this._openMarket(u.selectedMarketId);
  }

  /**
   * Per-frame hook: runs the epitaph timer and the 4 Hz path line every frame; rewrites the
   * card at `hudHz`.
   * @param {number} realDt real seconds since the last frame
   */
  update(realDt) {
    const dt = Number.isFinite(realDt) && realDt > 0 ? Math.min(realDt, 1) : 0;
    try {
      if (this._dead && this.mode === 'agent') {
        this._deadLeft -= dt;
        if (this._deadLeft <= 0) this._finishEpitaph();
      }
      if (this.mode === 'agent' || this._pathShown) {
        this._pathAcc += dt;
        if (this._pathAcc >= PATH_PERIOD) {
          this._pathAcc = 0;
          this._refreshPath();
        }
      }
      this._acc += dt;
      if (this._acc < this._period) return;
      this._acc = 0;
      if (!this.mode || this.sim.ui?.hideUI) return;
      if (this.mode === 'agent') this._refreshAgent();
      else this._refreshMarket();
    } catch (err) {
      if (this._errors++ < 3) console.error('[inspector] update failed', err);
    }
  }

  /** Removes listeners and the path line (the DOM stays). */
  dispose() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    this._clearPath();
  }

  /** Rebuild both views in the current language and refill the open one. */
  relabel() {
    this.$root.setAttribute('aria-label', t('ins.aria'));
    const mode = this.mode;
    const agentId = this.agentId;
    const marketId = this.marketId;
    const dead = this._dead;
    if (this.$a) { this.$a.view.remove(); this.$a = null; }
    if (this.$m) { this.$m.view.remove(); this.$m = null; }
    this.mode = null;
    this.$root.hidden = true;
    if (mode === 'agent' && !dead) this._openAgent(agentId);
    else if (mode === 'market') this._openMarket(marketId);
  }

  // ================================================================ selection

  _subscribe() {
    const bus = this.sim.events;
    if (!bus || typeof bus.on !== 'function') return;
    const on = (name, fn) => {
      if (!name) return;
      const off = bus.on(name, fn);
      this._unsubs.push(typeof off === 'function' ? off : () => bus.off?.(name, fn));
    };
    on(EV.SELECT_AGENT, (p) => this._onSelectAgent(p));
    on(EV.SELECT_MARKET, (p) => this._onSelectMarket(p));
    on(EV.AGENT_DIED, (p) => this._onAgentGone(p, 'died'));
    on(EV.AGENT_EMIGRATED, (p) => this._onAgentGone(p, 'emigrated'));
    on(EV.MARKET_CHIME, (p) => {
      if (this.mode === 'market' && (!p || p.marketId == null || Number(p.marketId) === this.marketId)) this._stripsDirty = true;
    });
    on(EV.FOLLOW, () => this._forceRefresh());
    on(EV.SELECT_GOOD, () => this._forceRefresh());
  }

  _onSelectAgent(p) {
    const id = p && p.agentId != null ? p.agentId : null;
    if (id == null) {
      if (this.mode === 'agent') this._close();
      return;
    }
    this._openAgent(id);
  }

  _onSelectMarket(p) {
    const m = p && p.marketId != null && Number.isFinite(Number(p.marketId)) ? Number(p.marketId) : null;
    const valid = m != null && !!this.sim.market?.markets?.[m];
    if (this.sim.ui) this.sim.ui.selectedMarketId = valid ? m : null;
    if (!valid) {
      if (this.mode === 'market') this._close();
      return;
    }
    this._openMarket(m);
  }

  _onAgentGone(p, how) {
    if (this.mode !== 'agent' || this._dead || !p || p.agentId !== this.agentId) return;
    this._markDead(how, p.cause);
  }

  _openAgent(id) {
    const pop = this.sim.population;
    const agent = pop && typeof pop.get === 'function' ? pop.get(id) : null;
    if (!agent || agent.alive === false) {
      if (this.mode === 'agent') this._close();
      return;
    }
    if (this.mode === 'agent' && this.agentId !== id) this._clearPath();
    if (this.mode === 'market') this._leaveMarket();
    if (this.sim.ui) this.sim.ui.selectedMarketId = null;
    this.mode = 'agent';
    this.agentId = id;
    this.agent = agent;
    this._dead = false;
    this._deadLeft = 0;
    // main.js clears the path line on every SELECT_AGENT after this handler: re-send it next frame.
    this._pathShown = false;
    this._pathRef = null;
    this._pathAcc = PATH_PERIOD;

    const v = this._agentView();
    setHidden(v.view, false);
    if (this.$m) setHidden(this.$m.view, true);
    toggleClass(v.view, 'dead', false);
    setHidden(v.epitaph, true);
    v.follow.disabled = false;
    v.path.disabled = false;
    v.fly.disabled = false;
    this._refreshAgent();
    this.$root.hidden = false;
    this.$root.scrollTop = 0;
    this._acc = 0;
  }

  _openMarket(m) {
    if (this.mode === 'agent') this._leaveAgent();
    this.mode = 'market';
    this.marketId = m;
    this._stripsDirty = true;
    const v = this._marketView();
    setHidden(v.view, false);
    if (this.$a) setHidden(this.$a.view, true);
    this._refreshMarket();
    this.$root.hidden = false;
    this.$root.scrollTop = 0;
    this._acc = 0;
  }

  _leaveAgent() {
    this._clearPath();
    this.agent = null;
    this.agentId = null;
    this._dead = false;
  }

  _leaveMarket() {
    this.marketId = null;
  }

  _close() {
    if (this.mode === 'agent') this._leaveAgent();
    else if (this.mode === 'market') this._leaveMarket();
    this.mode = null;
    this.$root.hidden = true;
  }

  /** ✕: deselect through the bus (main.js and the renderer follow); close directly without one. */
  _requestClose() {
    if (this.mode === 'agent') {
      this._emit(EV.SELECT_AGENT, { agentId: null });
      if (this.mode === 'agent') this._close();
    } else if (this.mode === 'market') {
      this._emit(EV.SELECT_MARKET, { marketId: null });
      if (this.mode === 'market') this._close();
    }
  }

  _markDead(how, cause) {
    const v = this.$a;
    const a = this.agent;
    this._dead = true;
    this._deadLeft = EPITAPH_SEC;
    const age = ageOf(a, finite(this.sim.clock?.tick));
    const key = how === 'emigrated' ? 'left' : how === 'gone' ? 'gone'
      : cause === 'starved' ? 'starved' : cause === 'fight' ? 'fight' : 'aged';
    const text = t(`ins.epitaph.${key}`, { age: Number.isFinite(age) ? age : null });
    if (v) {
      setText(v.epitaph, text);
      setHidden(v.epitaph, false);
      toggleClass(v.view, 'dead', true);
      v.follow.disabled = true;
      v.path.disabled = true;
      v.fly.disabled = true;
      this.$root.scrollTop = 0;
    }
    this._clearPath();
    if (this.sim.ui && this.sim.ui.followAgentId != null && this.sim.ui.followAgentId === this.agentId) {
      this._emit(EV.FOLLOW, { agentId: null });
    }
  }

  _finishEpitaph() {
    this._dead = false;
    if (this.mode !== 'agent') return;
    this._emit(EV.SELECT_AGENT, { agentId: null });
    if (this.mode === 'agent') this._close();
  }

  _forceRefresh() {
    this._acc = this._period;
  }

  _emit(name, payload) {
    const bus = this.sim.events;
    if (name && bus && typeof bus.emit === 'function') bus.emit(name, payload);
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
    this._forceRefresh();
  }

  // ================================================================ path line

  _clearPath() {
    if (!this._pathShown) return;
    this._pathShown = false;
    this._pathRef = null;
    const fx = this.sim.fx;
    if (fx && typeof fx.setPathLine === 'function') fx.setPathLine(null);
  }

  _refreshPath() {
    const fx = this.sim.fx;
    if (!fx || typeof fx.setPathLine !== 'function') return;
    const a = this.agent;
    const want = this._showPath && this.mode === 'agent' && !!a && !this._dead && a.alive !== false;
    const path = want ? a.path : null;
    const i0 = want ? Math.max(0, a.pathI | 0) : 0;
    if (!want || !Array.isArray(path) || i0 >= path.length) {
      this._clearPath();
      return;
    }
    const px = finite(a.pos?.x);
    const py = finite(a.pos?.y);
    const pz = finite(a.pos?.z);
    const rx = Math.round(px * 10);
    const ry = Math.round(py * 10);
    const rz = Math.round(pz * 10);
    if (this._pathShown && path === this._pathRef && i0 === this._pathI && rx === this._ppx && ry === this._ppy && rz === this._ppz) return;
    const end = Math.min(path.length, i0 + MAX_PATH_POINTS);
    // fx.setPathLine treats all-integer x/z as cell indices and centres them; feet positions are
    // world coordinates already, so keep an exactly-integer one from being shifted.
    const nudge = Number.isInteger(px) && Number.isInteger(pz) ? 1e-3 : 0;
    const pts = [new THREE.Vector3(px + nudge, py, pz)];
    for (let i = i0; i < end; i++) {
      const nd = path[i];
      if (nd && Number.isFinite(nd.x) && Number.isFinite(nd.y) && Number.isFinite(nd.z)) {
        pts.push(new THREE.Vector3(nd.x + 0.5, nd.y, nd.z + 0.5));
      }
    }
    if (pts.length < 2) {
      this._clearPath();
      return;
    }
    fx.setPathLine(pts);
    this._pathShown = true;
    this._pathRef = path;
    this._pathI = i0;
    this._ppx = rx;
    this._ppy = ry;
    this._ppz = rz;
  }

  // ================================================================ agent view

  _agentView() {
    if (this.$a) return this.$a;
    const multi = !!this.sim.clans?.multi;
    const v = { view: el('div', 'ins-view ins-agent', null, this.$root) };
    const head = el('div', 'ins-head', null, v.view);
    v.apron = el('span', 'apron-chip', null, head);
    v.apron.dataset.tipName = t('ins.apron');
    v.clanChip = multi ? el('span', 'clan-flag', null, head) : null;
    const title = el('div', 'ins-title', null, head);
    v.name = el('div', 'wm-h ins-name', '', title);
    v.sub = el('div', 'ins-sub', '', title);
    const close = button('ins-close', '✕', head, t('ins.close'));
    close.setAttribute('aria-label', t('ins.close'));
    close.addEventListener('click', () => this._requestClose());

    v.epitaph = el('div', 'ins-epitaph', '', v.view);
    v.epitaph.hidden = true;

    const badges = el('div', 'ins-badges', null, v.view);
    const badge = (cls, tip) => {
      const b = el('span', `badge ${cls}`, '', badges);
      b.hidden = true;
      if (tip) b.dataset.tip = tip;
      return b;
    };
    v.bPanic = badge('panic', t('ins.panicTip'));
    v.bFight = badge('panic', t('ins.fightTip'));
    v.bHunger = badge('fright', t('ins.hungerTip'));
    v.bRumor = badge('rumor', t('ins.rumorTip'));
    v.bFright = badge('fright', t('ins.frightTip'));
    v.bSleep = badge('sleep', t('ins.sleepTip'));
    v.bSpec = badge('plan', t('ins.specTip'));
    v.bPorter = badge('plan', t('ins.porterTip'));
    v.bWork = badge('plan', null);

    // Money.
    const sm = section(v.view, t('ins.purse'), t('ins.purseTip'));
    const money = el('div', 'ins-money', null, sm);
    const fbox = el('div', 'flame-box', null, money);
    v.flame = el('i', 'flame-ico', null, fbox);
    v.glim = kv(money, t('ins.glim'));
    v.escrow = kv(money, t('ins.escrow'));
    v.earned = kv(money, t('ins.earned'));
    v.net = kv(money, t('ins.net'));
    v.net.box.dataset.tip = t('ins.netTip');

    // Needs.
    const sn = section(v.view, t('ins.needs'));
    v.needs = NEEDS.map(([key, color]) => {
      const m = meter(sn, t(`need.${key}`), color, false);
      m.row.dataset.tipName = t(`need.${key}`);
      m.row.dataset.tip = t(`need.${key}.info`);
      m.key = key;
      m.color = color;
      return m;
    });

    // Bag.
    const sp = section(v.view, t('ins.pack'), t('ins.packTip'));
    const chips = el('div', 'chips', null, sp);
    v.items = ITEMS.map((it) => {
      const c = el('span', 'chip', null, chips);
      const sw = el('i', 'sw', null, c);
      sw.style.setProperty('--c', goodColor(it));
      el('span', null, itemName(it), c);
      const q = el('b', null, '0', c);
      c.hidden = true;
      return { chip: c, q, item: it };
    });
    v.lanterns = [];
    const maxL = Math.max(1, CONFIG.agent?.maxLanterns ?? 3);
    for (let i = 0; i < maxL; i++) {
      const c = el('span', 'chip lantern', null, chips);
      el('i', 'ln', null, c);
      el('span', null, t('ins.lantern'), c);
      const d = el('b', null, '', c);
      c.hidden = true;
      c.dataset.tip = t('ins.lanternTip');
      v.lanterns.push({ chip: c, d });
    }
    v.packNote = el('div', 'ins-note', '', sp);

    // Skills.
    const ss = section(v.view, t('ins.skills'), t('ins.skillsTip'));
    v.skills = PROFESSIONS.map((p) => {
      const m = meter(ss, profName(p), profColor(p), true);
      m.row.dataset.tip = t(`profInfo.${p}`);
      m.prof = p;
      return m;
    });

    // Mind.
    const sd = section(v.view, t('ins.mind'), t('ins.mindTip'));
    const goal = el('div', 'mind-line', null, sd);
    el('span', null, t('ins.goal'), goal);
    v.goal = el('span', null, '—', goal);
    const step = el('div', 'mind-line', null, sd);
    el('span', null, t('ins.step'), step);
    v.step = el('span', null, '—', step);
    v.thought = el('div', 'thought', '', sd);
    v.utils = [0, 1, 2].map(() => {
      const m = meter(sd, '', '#8A6A34', true);
      m.row.hidden = true;
      return m;
    });
    v.utilNote = el('div', 'ins-note', t('ins.weighing'), sd);

    // Beliefs against market prices: both plazas in the classic jar; home and the others with clans.
    const sb = section(v.view, t('ins.beliefs'), t('ins.beliefsTip'));
    const tbl = el('div', 'bel-table', null, sb);
    el('span', 'bel-good bel-h', t('hud.good'), tbl);
    el('span', 'bel-h', t('ins.mine'), tbl);
    const cols = multi ? [t('ins.home'), t('ins.others')] : [marketShort(0), marketShort(1)];
    const colTips = multi ? [t('ins.homeTip'), t('ins.othersTip')] : [marketName(0), marketName(1)];
    cols.forEach((c, i) => {
      const hc = el('span', 'bel-h', c, tbl);
      hc.dataset.tip = colTips[i];
    });
    v.beliefs = GOODS.map((g) => {
      const gc = el('span', 'bel-good', null, tbl);
      const sw = el('i', 'sw', null, gc);
      sw.style.setProperty('--c', goodColor(g));
      el('span', null, goodName(g), gc);
      const mine = el('span', null, '—', tbl);
      const cells = [0, 1].map(() => {
        const c = el('span', null, null, tbl);
        const arrow = el('i', null, '', c);
        const txt = el('span', null, '—', c);
        return { arrow, txt };
      });
      return { good: g, mine, cells };
    });

    // Actions.
    const act = el('div', 'ins-actions', null, v.view);
    v.follow = button('ins-btn', t('ins.follow'), act, t('ins.followTip'));
    v.follow.addEventListener('click', () => {
      const a = this.agent;
      if (!a || this._dead) return;
      const following = this.sim.ui?.followAgentId === a.id;
      this._emit(EV.FOLLOW, { agentId: following ? null : a.id });
      this._forceRefresh();
      v.follow.blur();
    });
    v.path = button('ins-btn', t('ins.path'), act, t('ins.pathTip'));
    v.path.addEventListener('click', () => {
      this._showPath = !this._showPath;
      toggleClass(v.path, 'on', this._showPath);
      this._refreshPath();
      v.path.blur();
    });
    v.fly = button('ins-btn', t('ins.fly'), act, t('ins.flyTip'));
    v.fly.addEventListener('click', () => {
      const p = this.agent?.pos;
      if (p && !this._dead) this._emit(EV.FLY_TO, { x: finite(p.x), y: finite(p.y), z: finite(p.z) });
      v.fly.blur();
    });
    toggleClass(v.path, 'on', this._showPath);

    this.$a = v;
    return v;
  }

  /** Mean price of `good` over the markets clan c can use, other than its own (NaN when none). */
  _othersPrice(c, good) {
    const clans = this.sim.clans;
    const market = this.sim.market;
    let sum = 0;
    let n = 0;
    for (const m of clans.openMarkets(c)) {
      if (clans.marketClan(m) === c) continue;
      sum += market.price(m, good);
      n++;
    }
    return n ? sum / n : NaN;
  }

  _refreshAgent() {
    const v = this.$a;
    if (!v || this.mode !== 'agent') return;
    if (this._dead) return;                  // the card freezes on the epitaph
    let a = this.agent;
    const pop = this.sim.population;
    const live = pop && typeof pop.get === 'function' ? pop.get(this.agentId) : a;
    if (!live || !a || a.alive === false) {
      this._markDead('gone', null);
      return;
    }
    if (live !== a) {
      a = live;
      this.agent = live;
    }
    const sim = this.sim;
    const clans = sim.clans;
    const multi = !!clans?.multi;
    const tick = finite(sim.clock?.tick);
    const prof = a.profession;
    const clan = a.clan ?? 0;

    // Identity.
    setStyle(v.apron, '--c', profColor(prof));
    v.apron.dataset.tip = t('ins.apronTip', { prof: profName(prof) });
    if (v.clanChip) {
      const cl = clans.list[clan];
      setStyle(v.clanChip, '--c', cl?.flag ?? '#999');
      v.clanChip.dataset.tip = t('ins.clanTip', { clan });
    }
    setText(v.name, a.name || `#${a.id}`);
    const age = ageOf(a, tick);
    setText(v.sub, t('ins.sub', { prof, clan: multi ? clan : null, age, life: a.lifespanDays, gen: (finite(a.generation) | 0) + 1, home: a.homeId != null }));

    // Badges.
    const needs = a.needs || {};
    const tallow = finite(needs.tallow, 50);
    const panic = finite(a.panicUntil) > tick;
    setHidden(v.bPanic, !panic);
    if (panic) setText(v.bPanic, t('ins.badge.panic'));
    const fighting = finite(a.fightUntil) > tick;
    setHidden(v.bFight, !fighting);
    if (fighting) setText(v.bFight, t('ins.badge.fight'));
    const starving = tallow <= 0 || finite(a.starveTicks) > 0;
    const hungry = starving || tallow < HUNGRY;
    setHidden(v.bHunger, !hungry);
    if (hungry) {
      setClass(v.bHunger, starving ? 'badge panic' : 'badge fright');
      setText(v.bHunger, t(starving ? 'ins.badge.starving' : 'ins.badge.hungry'));
    }
    const rumor = a.rumor;
    setHidden(v.bRumor, !rumor);
    if (rumor) {
      setText(v.bRumor, t('ins.badge.rumor', { good: rumor.good, up: rumor.dir >= 0, pct: Math.round(finite(rumor.strength, 1) * 100) }));
    }
    const fright = finite(a.fright);
    setHidden(v.bFright, !(fright > 0.02) || panic);
    if (fright > 0.02) setText(v.bFright, t('ins.badge.fright', { pct: Math.round(clamp01(fright) * 100) }));
    setHidden(v.bSleep, !a.asleep);
    if (a.asleep) setText(v.bSleep, t('ins.badge.asleep'));
    const spec = a.spec;
    setHidden(v.bSpec, !spec);
    if (spec) setText(v.bSpec, t('ins.badge.spec', { n: finite(spec.qty), good: spec.good }));
    const porter = a.porter;
    setHidden(v.bPorter, !porter);
    if (porter) setText(v.bPorter, t('ins.badge.porter', { n: finite(porter.qty), good: porter.good, from: porter.from, to: porter.to }));
    let work = '';
    if (a.tending != null) work = 'tend';
    else if (a.towerId != null) work = 'tower';
    else if (a.projectId != null) work = 'build';
    else if (a.commissionId != null) work = 'waiting';
    setHidden(v.bWork, !work);
    if (work) setText(v.bWork, t(`ins.work.${work}`));

    // Money.
    const glim = finite(a.glim);
    const escrow = finite(a.escrow);
    setText(v.glim.v, fmtGlim(glim));
    setText(v.escrow.v, fmtGlim(escrow));
    const k = clamp01(Math.log1p(Math.max(0, glim + escrow)) / Math.log1p(FLAME_RICH));
    setStyle(v.flame, '--fl', `calc(${(10 + 20 * k).toFixed(1)}px * var(--s, 1))`);
    setStyle(v.flame, '--flc', rampColor(k));
    setText(v.earned.v, fmtSigned(finite(a.earnedToday), 1));
    const inputs = finite(a.inputsToday);
    setText(v.earned.k, inputs > 0.05 ? t('ins.earnedInputs', { x: fmtGlim(inputs) }) : t('ins.earned'));
    const hist = Array.isArray(a.netHistory) ? a.netHistory : null;
    let netTxt = '';
    let netSum = 0;
    if (hist) {
      for (let i = Math.max(0, hist.length - 3); i < hist.length; i++) {
        const x = finite(hist[i]);
        netSum += x;
        netTxt += (netTxt ? ' · ' : '') + fmtSigned(x, 1);
      }
    }
    setText(v.net.v, netTxt || t('ins.noDay'));
    toggleClass(v.net.v, 'small', !netTxt || netTxt.length > 14);
    toggleClass(v.net.v, 'pos', !!netTxt && netSum > 0.05);
    toggleClass(v.net.v, 'neg', !!netTxt && netSum < -0.05);

    // Needs.
    for (let i = 0; i < v.needs.length; i++) {
      const m = v.needs[i];
      const val = Math.max(0, Math.min(100, finite(needs[m.key])));
      setStyle(m.fill, 'width', `${val.toFixed(0)}%`);
      setStyle(m.fill, '--bc', val < HUNGRY ? '#C0392B' : m.color);
      setText(m.num, String(Math.round(val)));
    }

    // Bag.
    const inv = a.inv || {};
    let total = 0;
    for (let i = 0; i < v.items.length; i++) {
      const it = v.items[i];
      const q = finite(inv[it.item]) | 0;
      if (q > 0) total += q;
      setHidden(it.chip, q <= 0);
      if (q > 0) setText(it.q, String(q));
    }
    const lanterns = Array.isArray(a.lanterns) ? a.lanterns : null;
    let lit = 0;
    for (let i = 0; i < v.lanterns.length; i++) {
      const exp = lanterns ? finite(lanterns[i], -1) : -1;
      const on = exp > tick;
      setHidden(v.lanterns[i].chip, !on);
      if (on) {
        lit++;
        setText(v.lanterns[i].d, t('ins.days', { d: fmtNum((exp - tick) / PER_DAY, 1) }));
      }
    }
    const carry = total > 0 ? t('ins.carrying', { n: total, cap: carryOf(prof) }) : t('ins.empty');
    setText(v.packNote, `${carry} · ${t('ins.lit', { n: lit })}`);

    // Skills.
    const skills = a.skills || {};
    for (let i = 0; i < v.skills.length; i++) {
      const m = v.skills[i];
      const s = finite(skills[m.prof], SKILL_MIN);
      setStyle(m.fill, 'width', `${(clamp01((s - SKILL_MIN) / (SKILL_MAX - SKILL_MIN)) * 100).toFixed(0)}%`);
      setText(m.num, fmtNum(s, 2));
      toggleClass(m.row, 'cur', m.prof === prof);
    }

    // Mind.
    setText(v.goal, goalName(a.goal));
    const task = a.task;
    let stepTxt = '—';
    if (task && typeof task === 'object') {
      const steps = Array.isArray(task.steps) ? task.steps : null;
      const n = steps ? steps.length : 0;
      const i = finite(task.i) | 0;
      const st = steps && i >= 0 && i < n ? steps[i] : null;
      stepTxt = task.label ? tr(task.label) : goalName(task.goal);
      if (st && st.k) stepTxt += ` · ${t(`step.${st.k}`)}`;
      if (n) stepTxt += ` (${Math.min(i + 1, n)}/${n})`;
    }
    if (a.pathBlocked) stepTxt += ` · ${t('ins.blocked')}`;
    setText(v.step, stepTxt);
    setText(v.thought, a.thought ? tr(a.thought) : '…');
    const utils = Array.isArray(a.utilities) ? a.utilities : null;
    const nu = utils ? Math.min(3, utils.length) : 0;
    let umax = 1e-6;
    for (let i = 0; i < nu; i++) umax = Math.max(umax, Math.abs(finite(utils[i]?.score)));
    for (let i = 0; i < v.utils.length; i++) {
      const m = v.utils[i];
      const u = i < nu ? utils[i] : null;
      setHidden(m.row, !u);
      if (!u) continue;
      const sc = finite(u.score);
      setText(m.l, goalName(u.goal));
      setStyle(m.fill, 'width', `${(clamp01(sc / umax) * 100).toFixed(0)}%`);
      setText(m.num, (sc < -0.005 ? MINUS : '') + fmtNum(Math.abs(sc), 2));
      toggleClass(m.row, 'cur', u.goal === a.goal);
    }
    setHidden(v.utilNote, nu > 0);

    // Beliefs vs market prices.
    const market = sim.market;
    const hasPrice = market && typeof market.price === 'function';
    const beliefs = a.beliefs || {};
    const home = multi ? clans.marketsOf(clan)[0] ?? 0 : 0;
    for (let i = 0; i < v.beliefs.length; i++) {
      const row = v.beliefs[i];
      const mine = beliefs[row.good];
      setText(row.mine, Number.isFinite(mine) ? fmtPrice(mine) : '—');
      for (let c = 0; c < 2; c++) {
        const cell = row.cells[c];
        let P = NaN;
        if (hasPrice) {
          if (!multi) P = market.price(c, row.good);
          else P = c === 0 ? market.price(home, row.good) : this._othersPrice(clan, row.good);
        }
        setText(cell.txt, fmtPrice(P));
        let dir = 0;
        if (Number.isFinite(P) && mine > 0) dir = P > mine * BELIEF_BAND ? 1 : P < mine / BELIEF_BAND ? -1 : 0;
        setText(cell.arrow, dir > 0 ? '▲' : dir < 0 ? '▼' : '·');
        toggleClass(cell.arrow, 'up', dir > 0);
        toggleClass(cell.arrow, 'down', dir < 0);
      }
    }

    // Actions.
    const following = sim.ui?.followAgentId != null && sim.ui.followAgentId === a.id;
    toggleClass(v.follow, 'on', following);
    setText(v.follow, t(following ? 'ins.following' : 'ins.follow'));
    toggleClass(v.path, 'on', this._showPath);
  }

  // ================================================================ market view

  _marketView() {
    if (this.$m) return this.$m;
    const v = { view: el('div', 'ins-view ins-market', null, this.$root) };
    const head = el('div', 'ins-head', null, v.view);
    v.chip = el('span', 'apron-chip brass', null, head);
    const title = el('div', 'ins-title', null, head);
    v.name = el('div', 'wm-h ins-name', '', title);
    v.sub = el('div', 'ins-sub', '', title);
    const close = button('ins-close', '✕', head, t('ins.close'));
    close.setAttribute('aria-label', t('ins.close'));
    close.addEventListener('click', () => this._requestClose());
    v.clanLine = el('div', 'ins-note ins-mkclan', '', v.view);
    v.clanLine.hidden = true;

    v.goods = GOODS.map((g) => {
      const box = el('div', 'mk-good', null, v.view);
      const gh = el('div', 'mk-good-head', null, box);
      gh.dataset.tipName = goodName(g);
      gh.dataset.tip = `${t(`goodInfo.${g}`)} ${t('ins.mkGoodTip')}`;
      const sw = el('i', 'sw', null, gh);
      sw.style.setProperty('--c', goodColor(g));
      el('b', null, goodName(g), gh);
      const price = el('span', 'mk-price', '—', gh);
      gh.addEventListener('click', () => this._selectGood(g));

      const meta = el('div', 'mk-meta', null, box);
      const last = el('span', null, '', meta);
      last.dataset.tip = t('ins.mkLastTip');
      const spread = el('span', null, '', meta);
      spread.dataset.tip = t('ins.mkSpreadTip');
      const queue = el('span', null, '', meta);
      queue.dataset.tip = t('ins.mkQueueTip');
      const seal = el('span', 'mk-seal', '', meta);
      seal.hidden = true;

      const strip = el('canvas', 'mk-strip', null, box);
      strip.dataset.tip = t('ins.mkStripTip');

      const lad = el('div', 'mk-ladder', null, box);
      const col = (cls, label) => {
        const c = el('div', `mk-lad-col ${cls}`, null, lad);
        const h = el('div', 'mk-lad-h', label, c);
        const rows = [];
        for (let k = 0; k < LADDER; k++) {
          const row = el('div', 'mk-lad-row empty', null, c);
          rows.push({ row, q: el('span', null, '·', row), p: el('span', null, '', row) });
        }
        return { h, rows };
      };
      const bids = col('bids', t('ins.bids'));
      bids.h.dataset.tip = t('ins.bidsTip');
      const lots = col('lots', t('ins.lots'));
      lots.h.dataset.tip = t('ins.lotsTip');
      return { good: g, box, price, last, spread, queue, seal, strip, bids, lots };
    });
    this.$m = v;
    return v;
  }

  /** Copies the live entries of `src` into `scratch`, sorted by `cmp` (no allocation). */
  _sorted(src, cmp, scratch) {
    scratch.length = 0;
    if (Array.isArray(src)) {
      for (let i = 0; i < src.length; i++) {
        const o = src[i];
        if (o && o.qty > 0) scratch.push(o);
      }
    }
    if (scratch.length > 1) scratch.sort(cmp);
    return scratch;
  }

  _fillLadder(side, list, priceKey) {
    for (let k = 0; k < LADDER; k++) {
      const r = side.rows[k];
      const o = k < list.length ? list[k] : null;
      toggleClass(r.row, 'empty', !o);
      if (o) {
        setText(r.q, `${o.qty} ×`);
        setText(r.p, fmtPrice(o[priceKey]));
      } else {
        setText(r.q, '·');
        setText(r.p, '');
      }
    }
  }

  _refreshMarket() {
    const v = this.$m;
    if (!v || this.mode !== 'market') return;
    const market = this.sim.market;
    const m = this.marketId;
    const mk = market?.markets?.[m];
    if (!mk) {
      this._close();
      return;
    }
    const tick = finite(this.sim.clock?.tick);
    setText(v.name, marketName(m));
    const clans = this.sim.clans;
    if (clans?.multi) {
      const c = mk.clan ?? 0;
      const cl = clans.list[c];
      setStyle(v.chip, 'background', cl?.flag ?? '');
      const open = [];
      for (const other of clans.list) if (clans.clanMarketOpen(other.id, m)) open.push(clanName(other.id));
      setText(v.clanLine, `${t('ins.mkClan', { clan: c, trade: cl?.trade ?? 'open' })} · ${t('ins.mkOpen', { list: open.join(', ') })}`);
      setHidden(v.clanLine, false);
    }
    const sel = this.sim.ui?.selectedGood;
    let nBids = 0;
    let nLots = 0;

    for (let i = 0; i < v.goods.length; i++) {
      const row = v.goods[i];
      const g = row.good;
      const P = typeof market.price === 'function' ? market.price(m, g) : NaN;
      setText(row.price, fmtPrice(P));
      setStyle(row.price, 'background', scarcityColor(P / goodRef(g)));
      toggleClass(row.box, 'sel', g === sel);

      const book = typeof market.getBook === 'function' ? market.getBook(m, g) : null;
      const bids = this._sorted(book?.bids, byLimitDesc, this._bidScratch);
      nBids += bids.length;
      this._fillLadder(row.bids, bids, 'limit');
      setText(row.bids.h, bids.length ? t('ins.bidsN', { n: bids.length }) : t('ins.bids'));
      const bestBid = bids.length ? bids[0].limit : null;
      const lots = this._sorted(book?.lots, byAskAsc, this._lotScratch);
      nLots += lots.length;
      this._fillLadder(row.lots, lots, 'ask');
      setText(row.lots.h, lots.length ? t('ins.lotsN', { n: lots.length }) : t('ins.lots'));
      const bestAsk = lots.length ? lots[0].ask : null;

      const last = typeof market.getLastClear === 'function' ? market.getLastClear(m, g) : null;
      if (last && last.price != null && finite(last.volume) > 0) setText(row.last, t('ins.last', { n: finite(last.volume), price: last.price }));
      else setText(row.last, t('ins.noTrade'));
      setText(row.spread, t('ins.spread', { bid: bestBid, ask: bestAsk }));
      const unf = finite(last?.unfilledQty);
      const uns = finite(last?.unsoldQty);
      let q = '';
      if (unf > 0) q = t('ins.wanting', { n: unf });
      if (uns > 0) q += `${q ? ' · ' : ''}${t('ins.unsold', { n: uns })}`;
      setText(row.queue, q);
      setHidden(row.queue, !q);

      const seal = typeof market.activeSeal === 'function' ? market.activeSeal(m, g) : null;
      setHidden(row.seal, !seal);
      if (seal) {
        setText(row.seal, t('ins.seal', { kind: seal.kind, price: seal.price, d: Math.floor(seal.untilTick / PER_DAY) + 1, time: clockTime(seal.untilTick) }));
      }
    }

    const inHour = ((tick % PER_HOUR) + PER_HOUR) % PER_HOUR;
    const nextHour = Math.floor(((tick - inHour + PER_HOUR) % PER_DAY) / PER_HOUR);
    setText(v.sub, t('ins.mkSub', { bids: nBids, lots: nLots, time: `${pad2(nextHour)}:00` }));

    const w = v.goods[0].strip.clientWidth | 0;
    if (w !== this._stripW) {
      this._stripW = w;
      this._stripsDirty = true;
    }
    if (this._stripsDirty) {
      this._stripsDirty = false;
      this._drawStrips();
    }
  }

  _drawStrips() {
    const v = this.$m;
    const L = this.sim.ledger;
    const m = this.marketId;
    if (!v || m == null) return;
    const clans = this.sim.clans;
    const line = clans?.multi ? clans.list[this.sim.market.markets[m]?.clan ?? 0]?.flag ?? '#3F362A' : MARKET_LINE[m] ?? '#3F362A';
    for (let gi = 0; gi < v.goods.length; gi++) {
      const row = v.goods[gi];
      const canvas = row.strip;
      const ctx = canvas.getContext ? canvas.getContext('2d') : null;
      if (!ctx) continue;
      const { w, h, dpr } = fitCanvas(canvas);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const s = L && typeof L.getSeries === 'function' ? L.getSeries(`P:${m}:${row.good}`) : null;
      const vals = s && s.values ? s.values : null;
      const n = vals ? vals.length : 0;
      if (!n) continue;
      const start = Math.max(0, n - STRIP_N);
      const count = n - start;
      const ref = goodRef(row.good);
      let lo = ref;
      let hi = ref;
      for (let i = start; i < n; i++) {
        const x = vals[i];
        if (!(x > 0)) continue;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      if (hi - lo < ref * 0.06) {
        const mid = (hi + lo) / 2;
        lo = mid - ref * 0.03;
        hi = mid + ref * 0.03;
      }
      const padY = 2;
      const step = (w - 5) / (STRIP_N - 1);
      const X = (k) => 1.5 + (STRIP_N - count + k) * step;
      const Y = (x) => padY + (1 - (x - lo) / (hi - lo)) * (h - 2 * padY);
      const yr = Math.round(Y(ref)) + 0.5;
      ctx.strokeStyle = 'rgba(27, 23, 18, 0.28)';
      ctx.lineWidth = 1;
      ctx.setLineDash(DASH_REF);
      ctx.beginPath();
      ctx.moveTo(0, yr);
      ctx.lineTo(w, yr);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
      ctx.beginPath();
      let pen = false;
      let lastX = 0;
      let lastY = 0;
      let lastV = ref;
      for (let k = 0; k < count; k++) {
        const x = vals[start + k];
        if (!(x > 0)) {
          pen = false;
          continue;
        }
        lastX = X(k);
        lastY = Y(x);
        lastV = x;
        if (pen) ctx.lineTo(lastX, lastY);
        else {
          ctx.moveTo(lastX, lastY);
          pen = true;
        }
      }
      ctx.strokeStyle = line;
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.fillStyle = scarcityColor(lastV / ref, 1);
      ctx.strokeStyle = '#1B1712';
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.arc(lastX, lastY, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
