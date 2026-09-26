/**
 * @file The naturalist's desk tools (SPEC §C.4 G5, §E, §F camera modes, ADDENDUM §8).
 *
 * `Tools` owns every player gesture on the canvas: picking, hover previews,
 * cursor styles, the 0-9/Esc hotkeys, the popovers in `#popover`, and the nine
 * interventions that write `sim.effects` or edit the world. Camera gestures stay
 * with OrbitControls: in 'inspect' orbit mode a short LMB click is ours and a
 * drag orbits; in 'tool' mode LMB belongs to the tool and RMB orbits.
 *
 * Tools never tick sim state (§E): eclipse expiry lives in production, seal
 * expiry in market. Everything here runs from DOM events or `update(realDt)`.
 */
import { CONFIG, TICKS, GOODS } from '../core/config.js';
import { EV } from '../core/events.js';
import { createRng } from '../core/rng.js';
import { B, BLOCKS } from '../world/blocks.js';
import { t, goodName as goodLabel } from '../core/i18n.js';
import { REL_KEYS } from '../economy/clans.js';
import { placeOf } from '../ui/place.js';

// ---------------------------------------------------------------------------
// Block ids and lookup tables
// ---------------------------------------------------------------------------

const bid = (key, fallback) => (B && Number.isInteger(B[key]) ? B[key] : fallback);
const AIR = bid('AIR', 0);
const BEDROCK = bid('BEDROCK', 1);
const BASALT = bid('BASALT', 2);
const LOAM = bid('LOAM', 3);
const MOSS = bid('MOSS', 4);
const PATH = bid('PATH', 5);
const PEAT = bid('PEAT', 6);
const QUARTZ = bid('QUARTZ', 7);
const AMBER = bid('AMBER', 8);
const NEEDLES = bid('NEEDLES', 10);
const BUSH_BARE = bid('BUSH_BARE', 11);
const BUSH_RIPE = bid('BUSH_RIPE', 12);
const SAPLING = bid('SAPLING', 13);
const WATER = bid('WATER', 14);
const PAVING = bid('PAVING', 17);
const KETTLE = bid('KETTLE', 18);
const LENS_MOUNT = bid('LENS_MOUNT', 19);
const GLASS_WALL = bid('GLASS_WALL', 21);
const CLAN_WALL = bid('CLAN_WALL', 23);

function idTable(...ids) {
  const t = new Uint8Array(256);
  for (const id of ids) t[id & 255] = 1;
  return t;
}

/** The unbreakable blocks of the §C.4 registry; also the Trowel's forbidden list (§E.9). */
const UNBREAKABLE = idTable(BEDROCK, KETTLE, LENS_MOUNT, GLASS_WALL, CLAN_WALL);
/** Natural terrain that counts as "the ground" of a column (vegetation, structures and water do not). */
const GROUND = idTable(BEDROCK, BASALT, LOAM, MOSS, PATH, PEAT, QUARTZ, AMBER, PAVING);
/** Cells a Geode may crystallise. */
const GEODE_HOST = idTable(BASALT, LOAM, MOSS, PATH, PEAT, QUARTZ, AMBER);
/** Column tops the Dew Pipette may pool water on. */
const POOL_BED = idTable(BASALT, LOAM, MOSS, PATH, PEAT, QUARTZ, AMBER);
const BUSHES = idTable(BUSH_BARE, BUSH_RIPE);
const SCORCH_TO_AIR = idTable(BUSH_BARE, BUSH_RIPE, SAPLING, NEEDLES);

// ---------------------------------------------------------------------------
// Tool catalogue and UI constants
// ---------------------------------------------------------------------------

// Names and descriptions live in the language files (tool.<id>.name / tool.<id>.blurb).
const TOOL_DEFS = [
  { id: 'inspect', hotkey: '0', glyph: '⌕' }, // SPEC-GAP: §E gives no glyph for Inspect.
  { id: 'cupped', hotkey: '1', glyph: '✋' },
  { id: 'geode', hotkey: '2', glyph: '◆' },
  { id: 'pane', hotkey: '3', glyph: '▮' },
  { id: 'seal', hotkey: '4', glyph: '●' },
  { id: 'whisper', hotkey: '5', glyph: '❝' },
  { id: 'tap', hotkey: '6', glyph: '≋' },
  { id: 'magnifier', hotkey: '7', glyph: '◎' },
  { id: 'pipette', hotkey: '8', glyph: '💧' },
  { id: 'trowel', hotkey: '9', glyph: '⛏' },
];

/** A tool entry whose name and blurb follow the current language. */
function toolEntry(d) {
  return {
    ...d,
    get name() { return t(`tool.${d.id}.name`); },
    get blurb() { return t(`tool.${d.id}.blurb`); },
  };
}

const COL = {
  accent: '#C9A45C', alert: '#C0392B', grey: '#8C8577', eclipse: '#141A30', quartz: '#DDEFF5',
  pane: '#CFE8EC', paneDeep: '#6FD3E8', seal: '#C0392B', rumor: '#B388FF', tap: '#FFE2B0',
  magnifier: '#FFF4D6', water: '#6FB7C9', dig: '#EDE3C8', loam: '#C9A45C', dust: '#9C8763',
};

const F_AGENT = 1;
const F_MARKET = 2;
const F_TOWER = 4;
const F_WATER = 8;
const HOVER_FLAGS = {
  inspect: F_AGENT | F_MARKET, cupped: 0, geode: 0, pane: 0, seal: F_MARKET,
  whisper: F_AGENT, tap: 0, magnifier: F_AGENT | F_TOWER, pipette: F_WATER, trowel: F_WATER,
};
/** Tools whose own effect Ctrl+click removes (§E header). */
const REMOVABLE = { cupped: true, pane: true, seal: true };
/** Tools with a Shift+wheel brush. */
const BRUSHED = { cupped: true, pipette: true };

const RAY_MAX = 400;
// Glass panes are see-through: every tool but the Pane itself picks what lies behind them.
const RAY_WET_THRU = Object.freeze({ hitWater: true, skipGlass: true, skipWalls: true });
const RAY_DRY_THRU = Object.freeze({ hitWater: false, skipGlass: true, skipWalls: true });
// Clan walls are see-through for every tool; only Inspect looks for them (to open the wall card).
const RAY_WET_PANE = Object.freeze({ hitWater: true, skipWalls: true });
const RAY_DRY_PANE = Object.freeze({ hitWater: false, skipWalls: true });
const RAY_WALLS = Object.freeze({ hitWater: false, skipGlass: true });

const CLICK_SLOP_PX = 6;      // inspect mode: a longer LMB drag was a camera orbit, not a click
const TOOL_SLOP_PX = 14;      // tool mode: LMB never orbits, so be lenient with shaky clicks
const DOUBLE_CLICK_MS = 400;
const WHEEL_STEP = 60;        // normalised wheel delta per brush step
const PLACE_REPEAT_PX = 4;    // held Shift+Trowel places again only after the pointer moves
const HINT_MS = 700;
const OCCLUDE_SLACK = 0.75;   // an agent more than this behind the terrain hit is hidden
const TAP_SHAKE = 0.4;        // §E.6 renderer.shake(0.4)
const TAP_RIPPLE_LIFT = 10;   // §E.6 ripple at "hit y + 10"
const BREACH_DEPTH = 2;       // see _onAgentDug
const POP_OFFSET = 14;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isCtrl = (e) => !!(e && (e.ctrlKey || e.metaKey));

/**
 * 8-connected Bresenham line from (x0,z0) to (x1,z1), capped at `max` cells.
 * An 8-connected barrier is enough: agents only move along the 4 axes.
 * @returns {number[]} `out`, refilled with flat [x, z, x, z, ...] pairs
 */
function bresenham(x0, z0, x1, z1, max, out) {
  out.length = 0;
  const dx = Math.abs(x1 - x0);
  const dz = -Math.abs(z1 - z0);
  const sx = x0 < x1 ? 1 : -1;
  const sz = z0 < z1 ? 1 : -1;
  let err = dx + dz;
  let x = x0;
  let z = z0;
  for (;;) {
    out.push(x, z);
    if (out.length >= max * 2 || (x === x1 && z === z1)) break;
    const e2 = 2 * err;
    if (e2 >= dz) { err += dz; x += sx; }
    if (e2 <= dx) { err += dx; z += sz; }
  }
  return out;
}

function goodName(g) {
  return goodLabel(g);
}

function goodColor(g) {
  return (CONFIG.goods && CONFIG.goods[g] && CONFIG.goods[g].color) || COL.grey;
}

function blockColor(id) {
  const b = Array.isArray(BLOCKS) ? BLOCKS[id] : null;
  return (b && b.color) || COL.dust;
}

function makePick() {
  return { ray: false, hit: false, x: 0, y: 0, z: 0, id: 0, nx: 0, ny: 1, nz: 0, dist: Infinity,
    agentId: null, marketId: null, towerId: null };
}

function dom(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function popButton(label, on, onClick) {
  const b = dom('button', on ? 'pop-btn on' : 'pop-btn', label);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    try { onClick(e); } catch (err) { console.error('[tools] popover action failed', err); }
  });
  return b;
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * The player's hands: nine desk tools plus Inspect.
 *
 * Fields: `tools` ([{id, name, hotkey, glyph, blurb}] in hotkey order), `active`
 * (the current tool id) and `brush` ({cupped, pipette} radii set by Shift+wheel).
 */
export class Tools {
  /**
   * @param {object} sim the shared sim context (§C.1)
   * @param {HTMLCanvasElement} canvas the 3D view the tools listen on
   */
  constructor(sim, canvas) {
    this.sim = sim;
    this.canvas = canvas || null;
    /** @type {{id:string,name:string,hotkey:string,glyph:string,blurb:string}[]} */
    this.tools = TOOL_DEFS.map(toolEntry);
    /** @type {string} */
    this.active = 'inspect';

    const k = this._readConfig(sim && sim.config ? sim.config : CONFIG);
    this.k = k;
    this.brush = { cupped: k.eclipseR, pipette: k.pipetteR };
    // A private stream: tool randomness never perturbs the deterministic sim.rng sequence.
    this.rng = createRng((((sim && sim.seed) >>> 0) ^ 0x70015eed) >>> 0);

    this._px = 0;
    this._py = 0;
    this._hasPointer = false;
    this._inside = false;
    this._shift = false;
    this._ctrl = false;
    this._g = null;              // the LMB gesture in progress
    this._hv = makePick();       // hover pick, refreshed every frame
    this._ev = makePick();       // scratch pick for pointer events
    this._pc = { x: 0, y: 0, z: 0 };   // scratch target cell for Shift+Trowel
    this._wheelAcc = 0;
    this._geodeReadyAt = 0;
    this._hintAt = 0;
    this._hintText = '';
    this._lastClickAgent = null;
    this._lastClickAt = 0;
    this._selAgentId = null;
    this._selMarketId = null;
    this._pop = null;            // open popover state
    this._popNode = null;
    this._hovered = null;
    this._cursor = '';
    this._paneCells = new WeakMap();
    this._errLogged = false;
    this._disposed = false;

    this._want = { kind: null, x: 0, y: 0, z: 0, r: 0, color: '', cells: null };
    this._have = { kind: null, x: 0, y: 0, z: 0, r: 0, color: '', cells: null };
    this._pv = {
      disc: { x: 0, y: 0, z: 0, r: 0, color: '' },
      ring: { x: 0, y: 0, z: 0, r: 0, color: '' },
      box: { x: 0, y: 0, z: 0, color: '' },
      line: { cells: null, color: '' },
    };

    this._bindDom();
    this._subscribe();
    this._applyOrbitMode();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Switch tools: cancels any gesture, closes popovers, sets the orbit mode
   * ('inspect' for Inspect, 'tool' otherwise) and emits TOOL_CHANGED.
   * @param {string} id one of the ids in `tools`
   */
  setActive(id) {
    if (!this._def(id)) return;
    this._cancelGesture();
    this._closePopover();
    this._wheelAcc = 0;
    if (id === this.active) {
      this._applyOrbitMode();
      return;
    }
    this.active = id;
    this._applyOrbitMode();
    this._emit(EV.TOOL_CHANGED, { tool: id });
  }

  /**
   * Per-frame work: hover picking, previews, cursors, and the hold-to-apply
   * tools (Tap radius growth, Magnifier, Trowel repeat, Pane drag).
   * @param {number} realDt real seconds since the last frame
   */
  update(realDt) {
    if (this._disposed) return;
    const dt = Number.isFinite(realDt) && realDt > 0 ? Math.min(realDt, 0.25) : 0;
    const now = nowMs();
    // Each stage is isolated so one misbehaving peer (say, a throwing agent pick)
    // cannot also freeze the hold tools, previews and popovers.
    this._stage(this._updateHover, dt, now);
    this._stage(this._updateHold, dt, now);
    this._stage(this._updatePreview, now);
    this._stage(this._watchPopover);
  }

  /** Remove every listener and visual trace of the tools. */
  dispose() {
    if (this._disposed) return;
    this._cancelGesture();
    this._closePopover();
    this._disposed = true;
    const c = this.canvas;
    if (c) {
      c.removeEventListener('pointerdown', this._onPointerDown);
      c.removeEventListener('pointermove', this._onPointerMove);
      c.removeEventListener('pointerup', this._onPointerUp);
      c.removeEventListener('pointercancel', this._onPointerCancel);
      c.removeEventListener('pointerenter', this._onPointerEnter);
      c.removeEventListener('pointerleave', this._onPointerLeave);
      if (c.style) c.style.cursor = '';
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('blur', this._onBlur);
      window.removeEventListener('wheel', this._onWheel, { capture: true });
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerdown', this._onDocPointerDown, { capture: true });
    }
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    const fx = this.sim.fx;
    if (fx && typeof fx.setPreview === 'function') fx.setPreview(null);
    this._setHovered(null);
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  _readConfig(c) {
    const t = c.tools || {};
    const w = c.world || {};
    const wg = c.worldgen || {};
    const e = t.eclipse || {};
    const ge = t.geode || {};
    const pa = t.pane || {};
    const se = t.seal || {};
    const ta = t.tap || {};
    const mg = t.magnifier || {};
    const pp = t.pipette || {};
    const tr = t.trowel || {};
    return {
      eclipseR: e.radius ?? 12, eclipseMin: e.minR ?? 6, eclipseMax: e.maxR ?? 20,
      eclipseDays: e.durationDays ?? 1, eclipseCount: e.max ?? 3,
      geodeR: ge.radius ?? 2.6, geodeQuartz: ge.quartzFrac ?? 0.8, geodeDepth: ge.depth ?? 2,
      geodeCooldown: ge.cooldownSec ?? 20,
      paneMaxLen: pa.maxLen ?? 64, paneAbove: pa.above ?? 5, paneBelow: pa.below ?? 5, paneMax: pa.max ?? 4,
      sealDays: se.durationDays ?? 1, sealMinMul: se.minMul ?? 0.25, sealMaxMul: se.maxMul ?? 4,
      tapMinR: ta.minR ?? 15, tapMaxR: ta.maxR ?? 60, tapHoldMin: ta.holdMin ?? 0.2, tapHoldMax: ta.holdMax ?? 1.5,
      magGlimPerSec: mg.glimPerSec ?? 20, magScorchR: mg.scorchRadius ?? 2, magScorchPerSec: mg.scorchPerSec ?? 4,
      magBoostHours: mg.boostHours ?? 1,
      pipetteR: pp.radius ?? 3, pipetteMin: pp.minR ?? 2, pipetteMax: pp.maxR ?? 5,
      trowelRepeat: tr.repeatSec ?? 0.15,
      SX: w.SX ?? 112, SY: w.SY ?? 64, SZ: w.SZ ?? 112, CX: w.CX ?? 56, CZ: w.CZ ?? 56,
      jarR: (c.render && c.render.jar && c.render.jar.radius) ?? 57,
      plazaHalf: wg.plazaHalf ?? 4, ridgeX: wg.ridgeStartX ?? 74, rimStart: wg.rimStart ?? 50,
      bogOuter: (wg.bogRing && wg.bogRing[1]) ?? 8,
      perDay: TICKS.PER_DAY,
    };
  }

  _bindDom() {
    this._onPointerDown = this._guarded('pointerdown', this._onPointerDown);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._guarded('pointerup', this._onPointerUp);
    this._onPointerCancel = this._guarded('pointercancel', this._onPointerCancel);
    this._onPointerEnter = this._onPointerEnter.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);
    this._onKeyDown = this._guarded('keydown', this._onKeyDown);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._guarded('blur', this._onBlur);
    this._onWheel = this._onWheel.bind(this);
    this._onDocPointerDown = this._guarded('popover dismiss', this._onDocPointerDown);
    const c = this.canvas;
    if (c && typeof c.addEventListener === 'function') {
      c.addEventListener('pointerdown', this._onPointerDown);
      c.addEventListener('pointermove', this._onPointerMove);
      c.addEventListener('pointerup', this._onPointerUp);
      c.addEventListener('pointercancel', this._onPointerCancel);
      c.addEventListener('pointerenter', this._onPointerEnter);
      c.addEventListener('pointerleave', this._onPointerLeave);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('blur', this._onBlur);
      // Capture phase on window runs before OrbitControls' own wheel listener on the
      // canvas, so Shift+wheel can resize a brush without also zooming the camera.
      window.addEventListener('wheel', this._onWheel, { capture: true, passive: false });
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('pointerdown', this._onDocPointerDown, { capture: true });
    }
  }

  _subscribe() {
    this._unsubs = [];
    const bus = this.sim && this.sim.events;
    if (!bus || typeof bus.on !== 'function') return;
    const on = (name, fn) => {
      if (!name) return;
      const off = bus.on(name, fn);
      this._unsubs.push(typeof off === 'function' ? off : () => bus.off && bus.off(name, fn));
    };
    on(EV.AGENT_DUG, (p) => this._onAgentDug(p));
    on(EV.SELECT_AGENT, (p) => { this._selAgentId = p && p.agentId != null ? p.agentId : null; });
    on(EV.SELECT_MARKET, (p) => { this._selMarketId = p && p.marketId != null ? p.marketId : null; });
    // SPEC-GAP: a TOOL_CHANGED emitted by someone else (e.g. a tray that emits instead of
    // calling setActive) is adopted too, so `active` and the orbit mode never disagree
    // with the tray. Our own emits arrive with tool === active and are ignored.
    on(EV.TOOL_CHANGED, (p) => {
      const id = p && p.tool;
      if (!id || id === this.active || !this._def(id)) return;
      this._cancelGesture();
      this._closePopover();
      this._wheelAcc = 0;
      this.active = id;
      this._applyOrbitMode();
    });
  }

  _applyOrbitMode() {
    const r = this.sim.renderer;
    if (r && typeof r.setOrbitMode === 'function') r.setOrbitMode(this.active === 'inspect' ? 'inspect' : 'tool');
  }

  _def(id) {
    for (const t of this.tools) if (t.id === id) return t;
    return null;
  }

  // -------------------------------------------------------------------------
  // DOM event handlers
  // -------------------------------------------------------------------------

  _trackPointer(e) {
    this._px = e.clientX;
    this._py = e.clientY;
    this._hasPointer = true;
    this._shift = !!e.shiftKey;
    this._ctrl = isCtrl(e);
  }

  _onPointerEnter(e) {
    this._inside = true;
    this._trackPointer(e);
  }

  _onPointerLeave() {
    this._inside = false;
  }

  _onPointerDown(e) {
    this._inside = true;
    this._trackPointer(e);
    if (e.button !== 0) return;               // RMB/MMB belong to the camera
    // A gesture still open here lost its pointerup (released over another element or
    // window); finish it as a cancel so the new press is never swallowed.
    if (this._g) this._cancelGesture();
    const g = {
      tool: this.active, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, moved: 0,
      ctrl: isCtrl(e) && !!REMOVABLE[this.active], shift: !!e.shiftKey, t0: nowMs(),
    };
    this._g = g;
    this._capture(e);                         // the matching pointerup always reaches the canvas
    if (g.ctrl) return;                       // removals resolve as clicks on release
    switch (g.tool) {
      case 'pane': this._beginPane(g, e); break;
      case 'tap': this._beginTap(g, e); break;
      case 'magnifier': g.seg = null; break;
      case 'trowel': this._beginTrowel(g, e); break;
      default: break;
    }
  }

  _onPointerMove(e) {
    this._trackPointer(e);
    const g = this._g;
    // Releasing LMB while RMB is still held (orbiting mid-gesture) arrives as a pointermove, not a
    // pointerup: end the gesture here, or the Trowel/Magnifier would keep working with no button down.
    if (g && e.pointerId === g.pointerId && e.pointerType === 'mouse' && (e.buttons & 1) === 0) {
      this._onPointerUp(e, true);
      return;
    }
    // Uncaptured moves only arrive while over the canvas; pointerenter is missed when an
    // overlay above a resting mouse goes away.
    if (!g) this._inside = true;
    if (g && e.pointerId === g.pointerId) {
      const d = Math.hypot(e.clientX - g.x0, e.clientY - g.y0);
      if (d > g.moved) g.moved = d;
    }
  }

  _onPointerUp(e, chorded = false) {
    this._trackPointer(e);
    const g = this._g;
    if (!g || e.pointerId !== g.pointerId || (!chorded && e.button !== 0)) return;
    this._g = null;
    this._releaseCapture(e.pointerId);
    const click = g.moved <= (g.tool === 'inspect' ? CLICK_SLOP_PX : TOOL_SLOP_PX);
    const cx = e.clientX;
    const cy = e.clientY;
    switch (g.tool) {
      case 'inspect': if (click) this._inspectClick(cx, cy); break;
      case 'cupped': if (click) { if (g.ctrl) this._liftEclipseAt(cx, cy); else this._cup(cx, cy); } break;
      case 'geode': if (click) this._geode(cx, cy); break;
      case 'pane': if (g.ctrl) { if (click) this._liftPaneAt(cx, cy); } else this._layPane(g, cx, cy, !!e.shiftKey); break;
      case 'seal': if (click) { if (g.ctrl) this._breakSealAt(cx, cy); else this._openSeal(cx, cy); } break;
      case 'whisper': if (click) this._openWhisper(cx, cy); break;
      case 'tap': this._releaseTap(g); break;
      case 'magnifier': this._flushMagnifier(g); break;
      case 'pipette': if (click) this._pipette(cx, cy); break;
      case 'trowel': this._finishTrowel(g); break;
      default: break;
    }
  }

  _onPointerCancel(e) {
    if (this._g && e.pointerId === this._g.pointerId) this._cancelGesture();
  }

  _onBlur() {
    this._shift = false;
    this._ctrl = false;
    this._cancelGesture();
  }

  _onKeyUp(e) {
    if (e.key === 'Shift') this._shift = false;
    else if (e.key === 'Control' || e.key === 'Meta') this._ctrl = isCtrl(e);
  }

  _onKeyDown(e) {
    const key = e.key;
    if (key === 'Shift') { this._shift = true; return; }
    if (key === 'Control' || key === 'Meta') { this._ctrl = true; return; }
    const ae = typeof document !== 'undefined' ? document.activeElement : null;
    if (key === 'Escape') {
      // SPEC-GAP: Esc first dismisses an open popover or an in-progress gesture;
      // only an Esc with nothing open selects Inspect (§C.4 hotkeys).
      if (this._pop || this._g) {
        this._closePopover();
        this._cancelGesture();
        e.preventDefault();
        return;
      }
      // Esc that closes the help notes or abandons the seed input is theirs, not a tool change.
      if (isTypingTarget(ae) || isTypingTarget(e.target) || this.sim.hud?._helpOpen
        || document.getElementById('help-overlay')?.offsetParent || document.querySelector('.wm-overlay:not([hidden])')) return;
      this.setActive('inspect');
      return;
    }
    if (isTypingTarget(ae) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (document.querySelector('.wm-overlay:not([hidden])')) return;
    const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code || '');
    const digit = m ? m[1] : (key && key.length === 1 && key >= '0' && key <= '9' ? key : null);
    if (digit == null) return;
    const def = this.tools.find((t) => t.hotkey === digit);
    if (!def) return;
    e.preventDefault();
    this.setActive(def.id);
  }

  _onWheel(e) {
    if (!e.shiftKey || e.target !== this.canvas || !BRUSHED[this.active]) return;
    e.preventDefault();
    e.stopPropagation();
    // Browsers often report Shift+wheel as horizontal scroll.
    let d = e.deltaY || e.deltaX || 0;
    if (e.deltaMode === 1) d *= 33;
    else if (e.deltaMode === 2) d *= 400;
    if (Math.sign(d) !== Math.sign(this._wheelAcc)) this._wheelAcc = 0;
    this._wheelAcc += d;
    while (this._wheelAcc <= -WHEEL_STEP) { this._wheelAcc += WHEEL_STEP; this._stepBrush(1); }
    while (this._wheelAcc >= WHEEL_STEP) { this._wheelAcc -= WHEEL_STEP; this._stepBrush(-1); }
  }

  _stepBrush(dir) {
    const k = this.k;
    if (this.active === 'cupped') this.brush.cupped = clamp(Math.round(this.brush.cupped + dir), k.eclipseMin, k.eclipseMax);
    else if (this.active === 'pipette') this.brush.pipette = clamp(Math.round(this.brush.pipette + dir), k.pipetteMin, k.pipetteMax);
  }

  _onDocPointerDown(e) {
    if (!this._pop) return;
    const el = this._popEl();
    if (el && e.target && typeof el.contains === 'function' && el.contains(e.target)) return;
    this._closePopover();
  }

  _capture(e) {
    const c = this.canvas;
    if (!c || typeof c.setPointerCapture !== 'function') return;
    try { c.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
  }

  _releaseCapture(pointerId) {
    const c = this.canvas;
    if (!c || typeof c.releasePointerCapture !== 'function') return;
    try {
      if (typeof c.hasPointerCapture !== 'function' || c.hasPointerCapture(pointerId)) c.releasePointerCapture(pointerId);
    } catch { /* capture was already released */ }
  }

  /** End the current gesture without completing it; hold tools report what they already did. */
  _cancelGesture() {
    const g = this._g;
    if (!g) return;
    this._g = null;
    this._releaseCapture(g.pointerId);
    if (g.tool === 'magnifier') this._flushMagnifier(g);
    else if (g.tool === 'trowel') this._finishTrowel(g);
  }

  /** Run one per-frame stage; the first failure is logged, later ones stay quiet. */
  _stage(fn, a, b) {
    try {
      fn.call(this, a, b);
    } catch (err) {
      if (!this._errLogged) {
        this._errLogged = true;
        console.error('[tools] update failed', err);
      }
    }
  }

  /** Drop a gesture that never started (nothing under the pointer); nothing to report. */
  _abortGesture(g) {
    if (this._g === g) this._g = null;
    this._releaseCapture(g.pointerId);
  }

  /**
   * Wrap a DOM handler so a misbehaving peer can never leave a gesture half-open or
   * surface as an uncaught error: the gesture is dropped and the error logged.
   */
  _guarded(name, fn) {
    const handler = fn.bind(this);
    return (e) => {
      try {
        handler(e);
      } catch (err) {
        const g = this._g;
        this._g = null;
        if (g) this._releaseCapture(g.pointerId);
        console.error(`[tools] ${name} failed`, err);
      }
    };
  }

  // -------------------------------------------------------------------------
  // Picking
  // -------------------------------------------------------------------------

  /**
   * Pick under a client point into a reusable pick record.
   * Terrain through `world.raycast`, agents through `agentRenderer.pick` (dropped
   * when hidden behind terrain), plazas through `market.marketAt`, towers through
   * `production.towerAt`.
   */
  _pickInto(pk, cx, cy, flags) {
    pk.ray = false;
    pk.hit = false;
    pk.agentId = null;
    pk.marketId = null;
    pk.towerId = null;
    pk.dist = Infinity;
    const sim = this.sim;
    const r = sim.renderer;
    if (!r || typeof r.pickRay !== 'function') return pk;
    const ray = r.pickRay(cx, cy);
    if (!ray || !ray.origin || !ray.dir) return pk;
    pk.ray = true;
    const w = sim.world;
    const thru = this.active !== 'pane';
    const opts = flags & F_WATER ? (thru ? RAY_WET_THRU : RAY_WET_PANE) : (thru ? RAY_DRY_THRU : RAY_DRY_PANE);
    const h = w && typeof w.raycast === 'function' ? w.raycast(ray.origin, ray.dir, RAY_MAX, opts) : null;
    if (h) {
      pk.hit = true;
      pk.x = h.x; pk.y = h.y; pk.z = h.z; pk.id = h.id | 0;
      const n = h.normal;
      pk.nx = n ? n.x | 0 : 0; pk.ny = n ? n.y | 0 : 1; pk.nz = n ? n.z | 0 : 0;
      pk.dist = Number.isFinite(h.dist) ? h.dist : Infinity;
    }
    if (flags & F_AGENT) pk.agentId = this._pickAgent(ray, pk);
    if (pk.hit && (flags & F_MARKET)) {
      const m = sim.market;
      const id = m && typeof m.marketAt === 'function' ? m.marketAt(pk.x, pk.z) : null;
      pk.marketId = id == null ? null : id;
    }
    if (pk.hit && (flags & F_TOWER)) {
      const p = sim.production;
      const id = p && typeof p.towerAt === 'function' ? p.towerAt(pk.x, pk.y, pk.z) : null;
      pk.towerId = id == null ? null : id;
    }
    return pk;
  }

  _pickAgent(ray, pk) {
    const ar = this.sim.agentRenderer;
    if (!ar || typeof ar.pick !== 'function') return null;
    const id = ar.pick(ray);
    if (id == null) return null;
    const a = this._agent(id);
    if (!a || !a.pos) return null;
    if (pk.hit) {
      const o = ray.origin;
      const d = ray.dir;
      const len = Math.hypot(d.x, d.y, d.z) || 1;
      const t = ((a.pos.x - o.x) * d.x + (a.pos.y + 0.6 - o.y) * d.y + (a.pos.z - o.z) * d.z) / len;
      if (pk.dist + OCCLUDE_SLACK < t) return null;
    }
    return id;
  }

  _updateHover() {
    const hv = this._hv;
    if (!this._hasPointer || (!this._inside && !this._g)) {
      hv.ray = false; hv.hit = false; hv.agentId = null; hv.marketId = null; hv.towerId = null;
      return;
    }
    try {
      this._pickInto(hv, this._px, this._py, HOVER_FLAGS[this.active] | 0);
    } catch (err) {
      // A failed pick leaves nothing under the cursor rather than a half-written record.
      hv.ray = false; hv.hit = false; hv.agentId = null; hv.marketId = null; hv.towerId = null;
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Sim accessors
  // -------------------------------------------------------------------------

  _agent(id) {
    const pop = this.sim.population;
    if (!pop || id == null) return null;
    const a = typeof pop.get === 'function' ? pop.get(id) : (pop.byId && pop.byId.get(id));
    return a && a.alive !== false ? a : null;
  }

  _tick() {
    const c = this.sim.clock;
    return c && Number.isFinite(c.tick) ? c.tick : 0;
  }

  _effects() {
    const sim = this.sim;
    let e = sim.effects;
    if (!e) e = sim.effects = { eclipses: [], seals: [], panes: [], nextId: 1 };
    if (!Array.isArray(e.eclipses)) e.eclipses = [];
    if (!Array.isArray(e.seals)) e.seals = [];
    if (!Array.isArray(e.panes)) e.panes = [];
    if (!Number.isFinite(e.nextId)) e.nextId = 1;
    return e;
  }

  _nextId() {
    return this._effects().nextId++;
  }

  _market(m) {
    const info = this.sim.worldInfo;
    return info && Array.isArray(info.markets) ? info.markets[m] || null : null;
  }

  _price(m, good) {
    const mk = this.sim.market;
    const p = mk && typeof mk.price === 'function' ? mk.price(m, good) : null;
    if (Number.isFinite(p) && p > 0) return p;
    const ref = CONFIG.goods && CONFIG.goods[good] && CONFIG.goods[good].ref;
    return Number.isFinite(ref) ? ref : 1;
  }

  _tower(id) {
    const p = this.sim.production;
    if (!p || !Array.isArray(p.towers)) return null;
    for (const t of p.towers) if (t && t.id === id) return t;
    return null;
  }

  _defaultGood() {
    const g = this.sim.ui && this.sim.ui.selectedGood;
    return GOODS.includes(g) ? g : GOODS[0];
  }

  /** y of the top natural-ground block in a column (skipping plants, structures, glass, water), or -1. */
  _groundTop(x, z) {
    const w = this.sim.world;
    if (!w || typeof w.surfaceY !== 'function') return -1;
    let y = w.surfaceY(x, z) - 1;
    while (y > 0 && !GROUND[w.get(x, y, z)]) y--;
    return y;
  }

  _relocate(x0, y0, z0, x1, y1, z1) {
    const pop = this.sim.population;
    if (pop && typeof pop.relocateInBox === 'function') pop.relocateInBox(x0, y0, z0, x1, y1, z1);
  }

  /** Is a Wickling's feet or head in cell (x,y,z)? */
  _agentAt(x, y, z) {
    const pop = this.sim.population;
    const list = pop && Array.isArray(pop.agents) ? pop.agents : null;
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a || a.alive === false) continue;
      const c = a.cell;
      if (c && c.x === x && c.z === z && (c.y === y || c.y + 1 === y)) return true;
      const p = a.pos;
      if (p && Math.floor(p.x) === x && Math.floor(p.z) === z) {
        const fy = Math.floor(p.y);
        if (fy === y || fy + 1 === y) return true;
      }
    }
    return false;
  }

  /** A place message for labels, e.g. "near Pond market", "on the rocky hill" (see ui/place.js). */
  _where(x, z) {
    return placeOf(this.sim, x, z);
  }

  // -------------------------------------------------------------------------
  // Events and feedback
  // -------------------------------------------------------------------------

  _emit(name, payload) {
    const bus = this.sim.events;
    if (name && bus && typeof bus.emit === 'function') bus.emit(name, payload);
  }

  /** PLAYER_TOOL {tool, label, glyph, pos?, params}: the ledger stamps a marker, the Gazette prints it in gold. */
  _emitTool(tool, label, pos, params) {
    const def = this._def(tool);
    const payload = { tool, label, glyph: def ? def.glyph : '', params: params || {} };
    if (pos) payload.pos = pos;
    this._emit(EV.PLAYER_TOOL, payload);
  }

  _burst(x, y, z, color, n, kind) {
    const fx = this.sim.fx;
    if (fx && typeof fx.burst === 'function') fx.burst(x, y, z, color, n, kind);
  }

  _float(x, y, z, text, color, sec) {
    const fx = this.sim.fx;
    if (fx && typeof fx.floatText === 'function') fx.floatText(x, y, z, text, color, sec);
  }

  /** Throttled grey floating hint explaining why a gesture did nothing. */
  _hint(x, y, z, text) {
    const now = nowMs();
    if (text === this._hintText && now < this._hintAt) return;
    this._hintText = text;
    this._hintAt = now + HINT_MS;
    this._float(x, y, z, text, COL.grey, 1.2);
  }

  _hintAtPick(pk, text) {
    if (pk.hit) this._hint(pk.x + 0.5, pk.y + 1.6, pk.z + 0.5, text);
  }

  // -------------------------------------------------------------------------
  // Inspect
  // -------------------------------------------------------------------------

  _inspectClick(cx, cy) {
    const pk = this._pickInto(this._ev, cx, cy, F_AGENT | F_MARKET);
    const now = nowMs();
    if (pk.agentId != null) {
      const id = pk.agentId;
      if (this._selMarketId != null) this._emit(EV.SELECT_MARKET, { marketId: null });
      this._emit(EV.SELECT_AGENT, { agentId: id });
      if (this._lastClickAgent === id && now - this._lastClickAt <= DOUBLE_CLICK_MS) {
        this._emit(EV.FOLLOW, { agentId: id });
        this._lastClickAgent = null;
      } else {
        this._lastClickAgent = id;
        this._lastClickAt = now;
      }
      return;
    }
    this._lastClickAgent = null;
    if (pk.marketId != null) {
      if (this._selAgentId != null) this._emit(EV.SELECT_AGENT, { agentId: null });
      this._emit(EV.SELECT_MARKET, { marketId: pk.marketId });
      return;
    }
    const wallId = this._wallAt(cx, cy);
    if (wallId >= 0) { this._openWall(wallId, cx, cy); return; }
    if (!pk.hit) return;
    const ui = this.sim.ui || {};
    if (this._selAgentId != null || ui.selectedAgentId != null) this._emit(EV.SELECT_AGENT, { agentId: null });
    if (this._selMarketId != null || ui.selectedMarketId != null) this._emit(EV.SELECT_MARKET, { marketId: null });
  }

  // -------------------------------------------------------------------------
  // 1. Cupped Hand
  // -------------------------------------------------------------------------

  _cup(cx, cy) {
    const pk = this._pickInto(this._ev, cx, cy, 0);
    if (!pk.hit) return;
    const k = this.k;
    const list = this._effects().eclipses;
    const tick = this._tick();
    let active = 0;
    let oldest = -1;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || !(e.untilTick > tick)) continue;
      active++;
      if (oldest < 0 || e.untilTick < list[oldest].untilTick) oldest = i;
    }
    // SPEC-GAP: at the cap (tools.eclipse.max) the oldest live hand is lifted to make room.
    let replaced = null;
    if (active >= k.eclipseCount && oldest >= 0) replaced = list.splice(oldest, 1)[0].id;
    const ecl = {
      id: this._nextId(), x: pk.x + 0.5, z: pk.z + 0.5, r: this.brush.cupped,
      untilTick: tick + Math.round(k.eclipseDays * k.perDay),
    };
    list.push(ecl);
    this._emitTool('cupped', ['tool.cupped.label', { where: this._where(ecl.x, ecl.z) }],
      { x: ecl.x, y: pk.y + 1, z: ecl.z },
      { id: ecl.id, x: ecl.x, z: ecl.z, r: ecl.r, untilTick: ecl.untilTick, replaced });
  }

  _eclipseAt(x, z) {
    const list = this._effects().eclipses;
    const tick = this._tick();
    let best = null;
    let bestD = Infinity;
    for (const e of list) {
      if (!e || !(e.untilTick > tick)) continue;
      const d = Math.hypot(x - e.x, z - e.z);
      if (d <= e.r && d < bestD) { best = e; bestD = d; }
    }
    return best;
  }

  _liftEclipseAt(cx, cy) {
    const pk = this._pickInto(this._ev, cx, cy, 0);
    if (!pk.hit) return;
    const e = this._eclipseAt(pk.x + 0.5, pk.z + 0.5);
    if (!e) { this._hintAtPick(pk, t('hint.noShade')); return; }
    const list = this._effects().eclipses;
    const i = list.indexOf(e);
    if (i >= 0) list.splice(i, 1);
    this._emitTool('cupped', ['tool.cupped.lift', { where: this._where(e.x, e.z) }],
      { x: e.x, y: pk.y + 1, z: e.z }, { remove: true, id: e.id, x: e.x, z: e.z, r: e.r });
  }

  // -------------------------------------------------------------------------
  // 2. Geode
  // -------------------------------------------------------------------------

  // SPEC-GAP: the cooldown and every other tool timing (Tap hold, Trowel repeat,
  // Magnifier rates) are player-gesture times in real seconds, so the hand feels
  // the same at every sim speed and while paused.
  _geode(cx, cy) {
    const pk = this._pickInto(this._ev, cx, cy, 0);
    if (!pk.hit) return;
    const now = nowMs();
    if (now < this._geodeReadyAt) {
      this._hintAtPick(pk, t('hint.geodeWait', { s: Math.ceil((this._geodeReadyAt - now) / 1000) }));
      return;
    }
    const w = this.sim.world;
    const k = this.k;
    // SPEC-GAP: "2 below the hit" is measured from the ground of the clicked column, so a
    // click on a roof or a tree seeds the geode under it rather than inside the cottage.
    const top = this._groundTop(pk.x, pk.z);
    if (!w || top < 1) return;
    const r = k.geodeR;
    const r2 = r * r;
    const cxw = pk.x + 0.5;
    const cyw = top + 0.5 - k.geodeDepth;
    const czw = pk.z + 0.5;
    let quartz = 0;
    let amber = 0;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let y = Math.floor(cyw - r); y <= Math.floor(cyw + r); y++) {
      if (y < 1) continue;
      for (let z = Math.floor(czw - r); z <= Math.floor(czw + r); z++) {
        for (let x = Math.floor(cxw - r); x <= Math.floor(cxw + r); x++) {
          const dx = x + 0.5 - cxw;
          const dy = y + 0.5 - cyw;
          const dz = z + 0.5 - czw;
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          if (!w.inBounds(x, y, z) || !w.isInside(x, z)) continue;
          const id = w.get(x, y, z);
          // SPEC-GAP: only natural rock and soil crystallise. Air is left alone as well as
          // unbreakable, structure (incl. plants and trees) and water cells, so a geode
          // never forms a surface outcrop or fills a tunnel or a cottage.
          if (!GEODE_HOST[id]) continue;
          const nid = this.rng.next() < k.geodeQuartz ? QUARTZ : AMBER;
          if (nid !== id) w.set(x, y, z, nid);
          if (nid === QUARTZ) quartz++; else amber++;
          if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
          if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
        }
      }
    }
    if (quartz + amber === 0) { this._hintAtPick(pk, t('hint.noRock')); return; }
    this._geodeReadyAt = now + k.geodeCooldown * 1000;
    this._relocate(x0, y0, z0, x1, y1, z1);
    this._burst(cxw, top + 1.2, czw, COL.quartz, 28, 'glint');
    this._burst(cxw, top + 1.2, czw, goodColor('amber'), 8, 'glint');
    this._float(cxw, top + 2.6, czw, t('float.geode'), COL.quartz, 1.8);
    this._emitTool('geode', ['tool.geode.label', { where: this._where(cxw, czw) }], { x: cxw, y: top + 1, z: czw },
      { x: pk.x, y: Math.floor(cyw), z: pk.z, r, quartz, amber });
  }

  // -------------------------------------------------------------------------
  // 3. Glass Pane
  // -------------------------------------------------------------------------

  _beginPane(g, e) {
    const pk = this._pickInto(this._ev, e.clientX, e.clientY, 0);
    if (!pk.hit) { this._abortGesture(g); return; }
    g.sx = pk.x; g.sz = pk.z; g.ex = pk.x; g.ez = pk.z;
    g.line = [];
    g.cells = null;
    this._rebuildPaneLine(g);
  }

  /** Recompute the drag's Bresenham cells; the preview array is rebuilt only when the end cell moves. */
  _rebuildPaneLine(g) {
    const w = this.sim.world;
    bresenham(g.sx, g.sz, g.ex, g.ez, this.k.paneMaxLen, g.line);
    const cells = [];
    for (let i = 0; i < g.line.length; i += 2) {
      const x = g.line[i];
      const z = g.line[i + 1];
      if (!w || !w.isInside(x, z)) continue;
      cells.push({ x, y: this._groundTop(x, z) + 1, z });
    }
    g.cells = cells;
  }

  _layPane(g, cx, cy, deep) {
    if (!g.line) return;
    const end = this._pickInto(this._ev, cx, cy, 0);
    if (end.hit && (end.x !== g.ex || end.z !== g.ez)) {
      g.ex = end.x; g.ez = end.z;
      this._rebuildPaneLine(g);
    }
    const w = this.sim.world;
    if (!w || g.line.length < 4 || !g.cells || g.cells.length < 2) {
      this._hint(g.sx + 0.5, this._groundTop(g.sx, g.sz) + 2, g.sz + 0.5, t('hint.dragWall'));
      return;
    }
    const k = this.k;
    const fxs = this._effects();
    // SPEC-GAP: at the cap (tools.pane.max) the oldest pane is lifted to make room.
    let replaced = null;
    while (fxs.panes.length >= k.paneMax && fxs.panes.length > 0) {
      const old = fxs.panes[0];
      replaced = old ? old.id : null;
      if (!old || !this._liftPane(old)) fxs.panes.shift();
    }
    // SPEC-GAP: columns already walled by another pane are skipped so panes never overlap
    // and each pane can restore its own `prev` blocks exactly.
    const covered = new Set();
    for (const p of fxs.panes) for (const c of (p && p.cells) || []) covered.add(c.x + k.SX * c.z);

    const pane = { id: this._nextId(), deep: !!deep, breached: false, cells: [] };
    for (let i = 0; i < g.line.length; i += 2) {
      const x = g.line[i];
      const z = g.line[i + 1];
      if (!w.isInside(x, z) || covered.has(x + k.SX * z)) continue;
      // SPEC-GAP: "surfaceY" is taken as the natural ground surface (above the top
      // soil/rock block), not heightmap+1, so a pane crossing a tree or a cottage is
      // anchored to the ground instead of floating from the treetop.
      const s = this._groundTop(x, z) + 1;
      if (s < 1) continue;
      const y0 = deep ? 1 : Math.max(1, s - k.paneBelow);
      const y1 = Math.min(k.SY - 1, s + k.paneAbove);
      const prev = new Array(y1 - y0 + 1);
      for (let y = y0; y <= y1; y++) {
        const id = w.get(x, y, z);
        prev[y - y0] = id;
        if (!UNBREAKABLE[id]) w.set(x, y, z, GLASS_WALL);
      }
      pane.cells.push({ x, z, y0, y1, prev });
    }
    if (pane.cells.length === 0) return;
    fxs.panes.push(pane);
    for (const c of pane.cells) this._relocate(c.x, c.y0 - 1, c.z, c.x, c.y1, c.z);

    const a = pane.cells[0];
    const b = pane.cells[pane.cells.length - 1];
    const mid = pane.cells[pane.cells.length >> 1];
    const where = this._paneWhere(a, b);
    this._float(mid.x + 0.5, mid.y1 + 1.5, mid.z + 0.5, t('float.pane'), COL.pane, 2.2);
    this._burst(mid.x + 0.5, mid.y1 + 0.5, mid.z + 0.5, COL.pane, 16, 'glint');
    this._emitTool('pane', ['tool.pane.label', { deep: !!deep, ...where }],
      { x: mid.x + 0.5, y: mid.y1 + 1, z: mid.z + 0.5 },
      { id: pane.id, deep: pane.deep, cells: pane.cells.length, from: { x: a.x, z: a.z }, to: { x: b.x, z: b.z }, replaced });
  }

  _paneWhere(a, b) {
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    if (span >= 40) return { across: true };
    return { where: this._where((a.x + b.x) / 2 + 0.5, (a.z + b.z) / 2 + 0.5) };
  }

  /** The pane whose column is at (x,z), else one within one cell of it. */
  _paneNear(x, z) {
    let near = null;
    for (const p of this._effects().panes) {
      if (!p || !Array.isArray(p.cells)) continue;
      for (const c of p.cells) {
        if (c.x === x && c.z === z) return p;
        if (!near && Math.abs(c.x - x) <= 1 && Math.abs(c.z - z) <= 1) near = p;
      }
    }
    return near;
  }

  _liftPaneAt(cx, cy) {
    const pk = this._pickInto(this._ev, cx, cy, 0);
    if (!pk.hit) return;
    const pane = this._paneNear(pk.x, pk.z);
    if (!pane) { this._hintAtPick(pk, t('hint.noWall')); return; }
    const mid = pane.cells[pane.cells.length >> 1];
    const where = mid ? this._where(mid.x + 0.5, mid.z + 0.5) : this._where(pk.x + 0.5, pk.z + 0.5);
    if (!this._liftPane(pane)) return;
    this._emitTool('pane', ['tool.pane.lift', { where }],
      mid ? { x: mid.x + 0.5, y: mid.y1 + 1, z: mid.z + 0.5 } : null,
      { remove: true, id: pane.id, cells: pane.cells.length, breached: !!pane.breached });
  }

  /** Restore a pane's `prev` blocks (only where the glass still stands) and forget it. */
  _liftPane(pane) {
    const w = this.sim.world;
    if (!w) return false;
    const cells = Array.isArray(pane.cells) ? pane.cells : [];
    for (const c of cells) {
      if (!c || !Array.isArray(c.prev)) continue;
      for (let y = c.y0; y <= c.y1; y++) {
        const prev = c.prev[y - c.y0];
        if (prev === undefined || prev === GLASS_WALL) continue;
        if (w.get(c.x, y, c.z) === GLASS_WALL) w.set(c.x, y, c.z, prev);
      }
    }
    const panes = this._effects().panes;
    const i = panes.indexOf(pane);
    if (i >= 0) panes.splice(i, 1);
    this._paneCells.delete(pane);
    for (const c of cells) if (c) this._relocate(c.x, c.y0 - 1, c.z, c.x, c.y1 + 1, c.z);
    for (let j = 0; j < cells.length; j += 4) {
      const c = cells[j];
      if (c) this._burst(c.x + 0.5, c.y1 + 0.5, c.z + 0.5, COL.pane, 3, 'glint');
    }
    return true;
  }

  /** Cached top-row cells of a pane for the Ctrl+hover 'line' preview. */
  _paneTopCells(pane) {
    let cells = this._paneCells.get(pane);
    if (!cells) {
      cells = pane.cells.map((c) => ({ x: c.x, y: c.y1, z: c.z }));
      this._paneCells.set(pane, cells);
    }
    return cells;
  }

  /**
   * SMUGGLE_BREACH: the first AGENT_DUG within one cell beside or below a pane's bottom.
   * SPEC-GAP: "below" reaches BREACH_DEPTH (2) cells down, so the feet cell of a
   * 2-high tunnel hugging the pane bottom counts as well as its head cell. Deep
   * panes sit on y = 1 and can never be tunnelled under, so they are never breached.
   */
  _onAgentDug(p) {
    if (!p || !Number.isFinite(p.x)) return;
    const e = this.sim.effects;
    const panes = e && Array.isArray(e.panes) ? e.panes : null;
    if (!panes || panes.length === 0) return;
    for (const pane of panes) {
      if (!pane || pane.breached || pane.deep || !Array.isArray(pane.cells)) continue;
      for (const c of pane.cells) {
        if (Math.abs(p.x - c.x) > 1 || Math.abs(p.z - c.z) > 1) continue;
        if (p.y > c.y0 || p.y < c.y0 - BREACH_DEPTH) continue;
        pane.breached = true;
        this._emit(EV.SMUGGLE_BREACH, { paneId: pane.id, agentId: p.agentId, x: p.x, y: p.y, z: p.z });
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Wax Seal
  // -------------------------------------------------------------------------

  _openSeal(cx, cy) {
    const pk = this._pickInto(this._ev, cx, cy, F_MARKET);
    if (pk.marketId == null) { this._hintAtPick(pk, t('hint.pickMarket')); return; }
    const st = { kind: 'seal', marketId: pk.marketId, good: this._defaultGood(), sealKind: 'ceiling',
      mul: 0.75, touched: false, cx, cy };
    this._syncSeal(st);
    this._pop = st;
    this._renderPopover();
  }

  _activeSeal(m, good) {
    const tick = this._tick();
    for (const s of this._effects().seals) {
      if (s && s.marketId === m && s.good === good && s.untilTick > tick) return s;
    }
    return null;
  }

  // SPEC-GAP: the slider opens at 0.75×P for a ceiling and 1.5×P for a floor, or at the
  // live seal's price when that good is already sealed.
  _syncSeal(st) {
    const k = this.k;
    // Freeze the reference price: the value shown is exactly the value pressed, even at 8×.
    st.P = this._price(st.marketId, st.good);
    const s = this._activeSeal(st.marketId, st.good);
    if (s) {
      st.sealKind = s.kind === 'floor' ? 'floor' : 'ceiling';
      st.mul = clamp(s.price / st.P, k.sealMinMul, k.sealMaxMul);
    } else if (!st.touched) {
      st.mul = clamp(st.sealKind === 'floor' ? 1.5 : 0.75, k.sealMinMul, k.sealMaxMul);
    }
  }

  _sealSliderToMul(v) {
    const k = this.k;
    return k.sealMinMul * Math.pow(k.sealMaxMul / k.sealMinMul, clamp(v, 0, 1000) / 1000);
  }

  _sealMulToSlider(mul) {
    const k = this.k;
    const span = Math.log(k.sealMaxMul / k.sealMinMul) || 1;
    return Math.round(1000 * clamp(Math.log(mul / k.sealMinMul) / span, 0, 1));
  }

  _sealValueText(st) {
    const P = st.P ?? this._price(st.marketId, st.good);
    return t('seal.value', { kind: st.sealKind, price: P * st.mul, mul: st.mul, P });
  }

  _renderSeal(el, st) {
    const title = dom('div', 'pop-row pop-title', t('seal.title', { m: st.marketId }));
    const goods = this._goodRow(st.good, (g) => {
      st.good = g;
      this._syncSeal(st);
      this._renderPopover();
    });
    const kinds = dom('div', 'pop-row');
    for (const kind of ['ceiling', 'floor']) {
      kinds.append(popButton(t(kind === 'ceiling' ? 'seal.ceiling' : 'seal.floor'), st.sealKind === kind, () => {
        if (st.sealKind === kind) return;
        st.sealKind = kind;
        if (!this._activeSeal(st.marketId, st.good)) this._syncSeal(st);
        this._renderPopover();
      }));
    }
    const value = dom('div', 'pop-row pop-value', this._sealValueText(st));
    const sliderRow = dom('div', 'pop-row');
    const slider = dom('input', 'pop-slider');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1000';
    slider.step = '1';
    slider.value = String(this._sealMulToSlider(st.mul));
    slider.addEventListener('input', () => {
      st.mul = this._sealSliderToMul(Number(slider.value));
      st.touched = true;
      value.textContent = this._sealValueText(st);
    });
    slider.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._applySeal(); }
    });
    sliderRow.append(slider);
    const actions = dom('div', 'pop-row');
    actions.append(popButton(t('seal.apply'), true, () => this._applySeal()));
    if (this._activeSeal(st.marketId, st.good)) {
      actions.append(popButton(t('seal.break'), false, () => {
        this._breakSeal(st.marketId, st.good);
        this._closePopover();
      }));
    }
    actions.append(popButton(t('pop.cancel'), false, () => this._closePopover()));
    el.append(title, goods, kinds, sliderRow, value, actions);
  }

  _applySeal() {
    const st = this._pop;
    if (!st || st.kind !== 'seal') return;
    const k = this.k;
    const P = st.P ?? this._price(st.marketId, st.good);
    const price = Math.round(P * st.mul * 100) / 100;
    const seals = this._effects().seals;
    for (let i = seals.length - 1; i >= 0; i--) {
      const s = seals[i];
      if (s && s.marketId === st.marketId && s.good === st.good) seals.splice(i, 1);
    }
    const seal = { id: this._nextId(), marketId: st.marketId, good: st.good, kind: st.sealKind, price,
      untilTick: this._tick() + Math.round(k.sealDays * k.perDay) };
    seals.push(seal);
    const pos = this._padPos(st.marketId, st.good);
    if (pos) this._float(pos.x, pos.y + 1.5, pos.z, t('float.seal', { kind: seal.kind, price }), COL.seal, 1.8);
    this._emitTool('seal', ['tool.seal.label', { m: seal.marketId, good: seal.good, kind: seal.kind, price }],
      pos, { id: seal.id, marketId: seal.marketId, good: seal.good, kind: seal.kind, price, mul: st.mul,
        untilTick: seal.untilTick });
    this._closePopover();
  }

  _padPos(m, good) {
    const site = this._market(m);
    if (!site) return null;
    const pad = site.pads && site.pads[good];
    if (pad) return { x: pad.x + 0.5, y: pad.y, z: pad.z + 0.5 };
    return site.center ? { x: site.center.x + 0.5, y: site.center.y, z: site.center.z + 0.5 } : null;
  }

  _breakSeal(m, good) {
    const seals = this._effects().seals;
    let removed = null;
    for (let i = seals.length - 1; i >= 0; i--) {
      const s = seals[i];
      if (s && s.marketId === m && s.good === good) { removed = s; seals.splice(i, 1); }
    }
    if (!removed) return false;
    const pos = this._padPos(m, good);
    if (pos) this._burst(pos.x, pos.y + 1, pos.z, COL.seal, 10, 'spark');
    this._emitTool('seal', ['tool.seal.lift', { m, good }], pos,
      { remove: true, id: removed.id, marketId: m, good });
    return true;
  }

  /** Ctrl+click on a plaza breaks the live seal whose pad is nearest the cursor. */
  _breakSealAt(cx, cy) {
    const pk = this._pickInto(this._ev, cx, cy, F_MARKET);
    if (pk.marketId == null) return;
    const tick = this._tick();
    let best = null;
    let bestD = Infinity;
    for (const s of this._effects().seals) {
      if (!s || s.marketId !== pk.marketId || !(s.untilTick > tick)) continue;
      const pos = this._padPos(s.marketId, s.good);
      const d = pos ? Math.hypot(pos.x - pk.x - 0.5, pos.z - pk.z - 0.5) : 0;
      if (d < bestD) { best = s; bestD = d; }
    }
    if (!best) { this._hintAtPick(pk, t('hint.noLimit')); return; }
    this._breakSeal(best.marketId, best.good);
  }

  // -------------------------------------------------------------------------
  // 5. Whisper
  // -------------------------------------------------------------------------

  _openWhisper(cx, cy) {
    const pk = this._pickInto(this._ev, cx, cy, F_AGENT);
    const a = this._agent(pk.agentId);
    if (!a) { this._hintAtPick(pk, t('hint.pickWickling')); return; }
    const good = a.rumor && GOODS.includes(a.rumor.good) ? a.rumor.good : this._defaultGood();
    this._pop = { kind: 'whisper', agentId: a.id, good, cx, cy };
    this._renderPopover();
  }

  _renderWhisper(el, st) {
    const a = this._agent(st.agentId);
    if (!a) return;
    const title = dom('div', 'pop-row pop-title', t('whisper.title', { name: a.name || '?' }));
    const belief = a.beliefs && Number.isFinite(a.beliefs[st.good]) ? a.beliefs[st.good] : NaN;
    const note = t('whisper.note', { prof: a.profession, good: st.good, belief,
      heard: a.rumor && a.rumor.good ? a.rumor.good : null, heardUp: !!(a.rumor && a.rumor.dir > 0) });
    const sub = dom('div', 'pop-row pop-note', note);
    const goods = this._goodRow(st.good, (g) => {
      st.good = g;
      this._renderPopover();
    });
    const dirs = dom('div', 'pop-row');
    dirs.append(
      popButton(t('whisper.up'), false, () => this._applyWhisper(1)),
      popButton(t('whisper.down'), false, () => this._applyWhisper(-1)),
      popButton(t('pop.cancel'), false, () => this._closePopover()),
    );
    el.append(title, sub, goods, dirs);
  }

  _applyWhisper(dir) {
    const st = this._pop;
    if (!st || st.kind !== 'whisper') return;
    const pop = this.sim.population;
    const a = this._agent(st.agentId);
    if (!a || !pop || typeof pop.startRumor !== 'function') { this._closePopover(); return; }
    pop.startRumor(a, st.good, dir > 0 ? 1 : -1);
    const p = a.pos || { x: 0, y: 0, z: 0 };
    this._float(p.x, p.y + 1.9, p.z, t('float.rumor', { good: st.good, up: dir > 0 }), COL.rumor, 1.8);
    this._burst(p.x, p.y + 1.3, p.z, COL.rumor, 10, 'spark');
    this._emitTool('whisper', ['tool.whisper.label', { name: a.name || '?', good: st.good, up: dir > 0 }],
      { x: p.x, y: p.y, z: p.z }, { agentId: a.id, good: st.good, dir: dir > 0 ? 1 : -1 });
    this._closePopover();
  }

  // -------------------------------------------------------------------------
  // 6. Tap the Glass
  // -------------------------------------------------------------------------

  _beginTap(g, e) {
    const pk = this._pickInto(this._ev, e.clientX, e.clientY, 0);
    if (!pk.hit) { this._abortGesture(g); return; }
    g.hx = pk.x; g.hy = pk.y; g.hz = pk.z;
  }

  _tapRadius(heldSec) {
    const k = this.k;
    const span = k.tapHoldMax - k.tapHoldMin;
    const f = span > 0 ? clamp((heldSec - k.tapHoldMin) / span, 0, 1) : 1;
    return k.tapMinR + (k.tapMaxR - k.tapMinR) * f;
  }

  _releaseTap(g) {
    if (g.hx === undefined) return;
    const k = this.k;
    const R = this._tapRadius((nowMs() - g.t0) / 1000);
    const x = g.hx + 0.5;
    const z = g.hz + 0.5;
    const pop = this.sim.population;
    if (pop && typeof pop.panic === 'function') pop.panic({ x, z }, R);
    const r = this.sim.renderer;
    if (r && typeof r.shake === 'function') r.shake(TAP_SHAKE);
    let dx = x - k.CX;
    let dz = z - k.CZ;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) { dx = 1; dz = 0; } else { dx /= len; dz /= len; }
    const fx = this.sim.fx;
    if (fx && typeof fx.ripple === 'function') fx.ripple(k.CX + dx * k.jarR, g.hy + TAP_RIPPLE_LIFT, k.CZ + dz * k.jarR);
    this._emitTool('tap', ['tool.tap.label', { where: this._where(x, z) }], { x, y: g.hy + 1, z },
      { x, z, r: Math.round(R * 10) / 10 });
  }

  // -------------------------------------------------------------------------
  // 7. Magnifier
  // -------------------------------------------------------------------------

  /**
   * One frame of a held Magnifier. The target under the cursor decides the action;
   * each continuous stretch on one target is a segment, reported as one PLAYER_TOOL
   * when the target changes or the button is released.
   * SPEC-GAP: one PLAYER_TOOL per segment rather than per frame keeps the Gazette and
   * chart markers readable; the boost is applied once per segment. Any voxel of a tower
   * column (as resolved by `production.towerAt`) counts as its lens mount, so the thin
   * one-voxel target is easy to hold.
   */
  _magnifierStep(g, dt, now) {
    const hv = this._hv;
    let kind = null;
    let target = -1;
    if (hv.agentId != null) { kind = 'gift'; target = hv.agentId; }
    else if (hv.towerId != null) { kind = 'boost'; target = hv.towerId; }
    else if (hv.hit) kind = 'scorch';
    let seg = g.seg;
    if (!seg || seg.kind !== kind || seg.target !== target) {
      this._flushMagnifier(g);
      seg = g.seg = kind ? { kind, target, amount: 0, shown: 0, cells: 0, acc: 0, done: false,
        x: 0, y: 0, z: 0, name: '', nextFx: 0 } : null;
    }
    if (!seg || dt <= 0) return;
    const k = this.k;
    if (kind === 'gift') {
      const a = this._agent(target);
      const pop = this.sim.population;
      if (!a || !pop || typeof pop.gift !== 'function') return;
      const amt = k.magGlimPerSec * dt;
      pop.gift(a, amt);
      seg.amount += amt;
      seg.name = a.name || '?';
      seg.x = a.pos.x; seg.y = a.pos.y; seg.z = a.pos.z;
      if (now >= seg.nextFx) {
        seg.nextFx = now + 110;
        this._burst(a.pos.x, a.pos.y + 1.2, a.pos.z, COL.magnifier, 3, 'spark');
      }
      if (seg.amount - seg.shown >= k.magGlimPerSec) {
        seg.shown = seg.amount;
        this._float(a.pos.x, a.pos.y + 1.8, a.pos.z, t('float.gift', { n: Math.round(seg.amount) }), COL.magnifier, 1);
      }
    } else if (kind === 'boost') {
      if (seg.done) return;
      seg.done = true;
      const p = this.sim.production;
      if (p && typeof p.boostTower === 'function') p.boostTower(target, k.magBoostHours);
      const t = this._tower(target);
      const lens = (t && t.lens) || { x: hv.x, y: hv.y, z: hv.z };
      seg.x = lens.x + 0.5; seg.y = lens.y + 0.5; seg.z = lens.z + 0.5;
      this._burst(seg.x, seg.y, seg.z, COL.magnifier, 18, 'glint');
      this._float(seg.x, seg.y + 1.5, seg.z, t('float.boost'), COL.magnifier, 1.5);
    } else {
      seg.acc += k.magScorchPerSec * dt;
      seg.x = hv.x + 0.5; seg.y = hv.y + 1; seg.z = hv.z + 0.5;
      while (seg.acc >= 1) {
        seg.acc -= 1;
        if (this._scorchOne(hv.x + 0.5, hv.z + 0.5)) seg.cells++;
      }
      if (now >= seg.nextFx) {
        seg.nextFx = now + 140;
        this._burst(seg.x, seg.y + 0.1, seg.z, COL.magnifier, 2, 'spark');
      }
    }
  }

  /** Scorch one random cell within `scorchRadius`: plants to AIR, MOSS to LOAM. */
  _scorchOne(cx, cz) {
    const w = this.sim.world;
    if (!w) return false;
    const a = this.rng.next() * TAU;
    const d = Math.sqrt(this.rng.next()) * this.k.magScorchR;
    const x = Math.floor(cx + Math.cos(a) * d);
    const z = Math.floor(cz + Math.sin(a) * d);
    if (!w.isInside(x, z)) return false;
    const top = w.surfaceY(x, z) - 1;
    if (top < 1) return false;
    let y = top + 1;                       // a non-solid sapling can sit above the top solid block
    let id = w.get(x, y, z);
    if (!SCORCH_TO_AIR[id]) { y = top; id = w.get(x, y, z); }
    if (SCORCH_TO_AIR[id]) w.set(x, y, z, AIR);
    else if (id === MOSS) w.set(x, y, z, LOAM);
    else return false;
    this._burst(x + 0.5, y + 0.8, z + 0.5, COL.grey, 5, 'smoke');
    return true;
  }

  _flushMagnifier(g) {
    const seg = g && g.seg;
    if (!seg) return;
    g.seg = null;
    const pos = { x: seg.x, y: seg.y, z: seg.z };
    if (seg.kind === 'gift' && seg.amount > 0) {
      const amount = Math.round(seg.amount * 100) / 100;
      this._emitTool('magnifier', ['tool.magnifier.gift', { amount, name: seg.name }], pos,
        { mode: 'gift', agentId: seg.target, amount });
    } else if (seg.kind === 'boost' && seg.done) {
      this._emitTool('magnifier', ['tool.magnifier.boost', { where: this._where(seg.x, seg.z) }], pos,
        { mode: 'boost', towerId: seg.target, hours: this.k.magBoostHours });
    } else if (seg.kind === 'scorch' && seg.cells > 0) {
      this._emitTool('magnifier', ['tool.magnifier.scorch', { n: seg.cells, where: this._where(seg.x, seg.z) }], pos,
        { mode: 'scorch', cells: seg.cells });
    }
  }

  // -------------------------------------------------------------------------
  // 8. Dew Pipette
  // -------------------------------------------------------------------------

  _pipette(cx, cy) {
    const pk = this._pickInto(this._ev, cx, cy, F_WATER);
    const w = this.sim.world;
    if (!pk.hit || !w) return;
    const r = this.brush.pipette;
    const R = Math.ceil(r);
    const hitSurface = this._groundTop(pk.x, pk.z) + 1;
    if (hitSurface < 1) return;
    let placed = 0;
    let cleared = 0;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > r * r) continue;
        const x = pk.x + dx;
        const z = pk.z + dz;
        if (!w.isInside(x, z)) continue;
        const top = this._groundTop(x, z);
        // SPEC-GAP: pools form only on natural ground, never on paving, roofs or glass.
        if (top < 1 || !POOL_BED[w.get(x, top, z)]) continue;
        const s = top + 1;
        if (s > hitSurface) continue;
        let id = w.get(x, s, z);
        if (BUSHES[id]) { w.set(x, s, z, AIR); id = AIR; cleared++; }
        if (id !== AIR) continue;
        w.set(x, s, z, WATER);
        placed++;
        this._relocate(x, s, z, x, s, z);
        if ((placed & 3) === 1) this._burst(x + 0.5, s + 1, z + 0.5, COL.water, 4, 'glint');
      }
    }
    const x = pk.x + 0.5;
    const z = pk.z + 0.5;
    if (placed === 0) { this._hint(x, hitSurface + 1.5, z, t('hint.waterRunsOff')); return; }
    this._burst(x, hitSurface + 1.5, z, COL.water, 18, 'glint');
    this._emitTool('pipette', ['tool.pipette.label', { where: this._where(x, z) }], { x, y: hitSurface, z },
      { x: pk.x, z: pk.z, r, cells: placed, bushes: cleared });
  }

  // -------------------------------------------------------------------------
  // 9. Trowel
  // -------------------------------------------------------------------------

  _beginTrowel(g, e) {
    g.place = g.shift;
    g.count = 0;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    g.pos = null;
    this._trowelStep(g, e.clientX, e.clientY);
    g.nextAt = nowMs() + this.k.trowelRepeat * 1000;
  }

  /**
   * One Trowel application at a client point. Digging repeats every `repeatSec`
   * while held. SPEC-GAP: a held Shift+Trowel places again only after the pointer
   * moves, so it paints along the drag instead of stacking loam toward the camera.
   */
  _trowelStep(g, cx, cy) {
    const pk = this._pickInto(this._ev, cx, cy, F_WATER);
    if (!pk.hit) return;
    const ok = g.place ? this._placeLoam(pk) : this._dig(pk);
    if (!ok) return;
    g.count++;
    g.lastX = cx;
    g.lastY = cy;
    const c = g.place ? this._pc : pk;
    g.pos = { x: c.x + 0.5, y: c.y, z: c.z + 0.5 };
  }

  _digForbidden(pk) {
    const w = this.sim.world;
    return !w || pk.y < 1 || UNBREAKABLE[pk.id] === 1 || !w.isInside(pk.x, pk.z);
  }

  _dig(pk) {
    const w = this.sim.world;
    if (this._digForbidden(pk)) { this._hintAtPick(pk, t('hint.tooHard')); return false; }
    if (pk.id === AIR) return false;
    w.set(pk.x, pk.y, pk.z, AIR);
    this._relocate(pk.x, pk.y, pk.z, pk.x, pk.y + 2, pk.z);
    this._burst(pk.x + 0.5, pk.y + 0.5, pk.z + 0.5, blockColor(pk.id), 8, 'dust');
    return true;
  }

  /** Why loam cannot go into (x,y,z), or null when it can. */
  _placeBlocked(x, y, z) {
    const w = this.sim.world;
    const k = this.k;
    if (!w || !w.inBounds(x, y, z) || y < 1 || y >= k.SY - 2 || !w.isInside(x, z)) return t('hint.outOfReach');
    const id = w.get(x, y, z);
    if (id !== AIR && id !== WATER) return t('hint.occupied');
    if (this._agentAt(x, y, z)) return t('hint.wicklingThere');
    return null;
  }

  /**
   * The cell Shift+Trowel fills for a pick, written into the reusable `_pc`; false when
   * the hit has no face. SPEC-GAP: a hit on a water surface fills that water cell itself
   * (dams and causeways) instead of floating loam on top of the pond.
   */
  _placeCell(pk) {
    const c = this._pc;
    if (pk.id === WATER) { c.x = pk.x; c.y = pk.y; c.z = pk.z; return true; }
    if (pk.nx === 0 && pk.ny === 0 && pk.nz === 0) return false;
    c.x = pk.x + pk.nx; c.y = pk.y + pk.ny; c.z = pk.z + pk.nz;
    return true;
  }

  _placeLoam(pk) {
    if (!this._placeCell(pk)) return false;
    const { x, y, z } = this._pc;
    const why = this._placeBlocked(x, y, z);
    if (why) { this._hint(x + 0.5, y + 1.5, z + 0.5, why); return false; }
    this.sim.world.set(x, y, z, LOAM);
    this._relocate(x, y - 1, z, x, y, z);
    this._burst(x + 0.5, y + 0.5, z + 0.5, blockColor(LOAM), 8, 'dust');
    return true;
  }

  _finishTrowel(g) {
    if (!g || !(g.count > 0) || !g.pos) return;
    const n = g.count;
    g.count = 0;
    const label = [g.place ? 'tool.trowel.place' : 'tool.trowel.dig', { n, where: this._where(g.pos.x, g.pos.z) }];
    this._emitTool('trowel', label, g.pos, { mode: g.place ? 'place' : 'dig', count: n });
  }

  // -------------------------------------------------------------------------
  // Held gestures, previews, cursors
  // -------------------------------------------------------------------------

  _updateHold(dt, now) {
    const g = this._g;
    if (!g || g.ctrl) return;
    const hv = this._hv;
    if (g.tool === 'pane') {
      if (g.line && hv.hit && (hv.x !== g.ex || hv.z !== g.ez)) {
        g.ex = hv.x;
        g.ez = hv.z;
        this._rebuildPaneLine(g);
      }
    } else if (g.tool === 'magnifier') {
      this._magnifierStep(g, dt, now);
    } else if (g.tool === 'trowel' && now >= g.nextAt) {
      g.nextAt = now + this.k.trowelRepeat * 1000;
      if (!g.place || Math.hypot(this._px - g.lastX, this._py - g.lastY) >= PLACE_REPEAT_PX) {
        this._trowelStep(g, this._px, this._py);
      }
    }
  }

  _wantShape(kind, x, y, z, r, color) {
    const w = this._want;
    w.kind = kind; w.x = x; w.y = y; w.z = z; w.r = r; w.color = color; w.cells = null;
  }

  _wantLine(cells, color) {
    const w = this._want;
    w.kind = 'line'; w.x = 0; w.y = 0; w.z = 0; w.r = 0; w.color = color; w.cells = cells;
  }

  /**
   * Push the wanted preview to fx only when it changed; params objects are reused.
   * SPEC-GAP: §C.4 fx does not fix the units of preview params. Here 'disc' and 'ring'
   * carry world-space centres (cell centre x+0.5, z+0.5; y = the surface they lie on),
   * while 'box' and every 'line' cell carry integer voxel coordinates (the cell that
   * occupies [x,x+1)×[y,y+1)×[z,z+1) per §C.0).
   */
  _commitPreview() {
    const w = this._want;
    const h = this._have;
    if (w.kind === h.kind && w.x === h.x && w.y === h.y && w.z === h.z && w.r === h.r
      && w.color === h.color && w.cells === h.cells) return;
    h.kind = w.kind; h.x = w.x; h.y = w.y; h.z = w.z; h.r = w.r; h.color = w.color; h.cells = w.cells;
    const fx = this.sim.fx;
    if (!fx || typeof fx.setPreview !== 'function') return;
    if (!w.kind) { fx.setPreview(null); return; }
    const p = this._pv[w.kind];
    if (w.kind === 'line') {
      p.cells = w.cells;
    } else {
      p.x = w.x; p.y = w.y; p.z = w.z;
      if (w.kind !== 'box') p.r = w.r;
    }
    p.color = w.color;
    fx.setPreview(w.kind, p);
  }

  _setHovered(id) {
    if (id === this._hovered) return;
    this._hovered = id;
    const ar = this.sim.agentRenderer;
    if (ar && typeof ar.setHovered === 'function') ar.setHovered(id);
  }

  _setCursor(cursor) {
    if (cursor === this._cursor) return;
    this._cursor = cursor;
    if (this.canvas && this.canvas.style) this.canvas.style.cursor = cursor;
  }

  _updatePreview(now) {
    const hv = this._hv;
    const g = this._g;
    const k = this.k;
    this._want.kind = null;
    this._want.cells = null;
    let hovered = null;
    let cursor = 'default';
    if ((this._inside || g) && hv.ray) {
      switch (this.active) {
        case 'inspect': {
          if (hv.agentId != null) { hovered = hv.agentId; cursor = 'pointer'; break; }
          const site = hv.marketId != null ? this._market(hv.marketId) : null;
          if (site && site.center) {
            this._wantShape('ring', site.center.x + 0.5, site.center.y, site.center.z + 0.5, k.plazaHalf + 0.5, COL.accent);
            cursor = 'pointer';
          }
          break;
        }
        case 'cupped': {
          if (!hv.hit) break;
          cursor = 'crosshair';
          if (this._ctrl) {
            const e = this._eclipseAt(hv.x + 0.5, hv.z + 0.5);
            if (e) { this._wantShape('ring', e.x, hv.y + 1, e.z, e.r, COL.alert); cursor = 'pointer'; }
            break;
          }
          this._wantShape('disc', hv.x + 0.5, hv.y + 1, hv.z + 0.5, this.brush.cupped, COL.eclipse);
          break;
        }
        case 'geode': {
          if (!hv.hit) break;
          const cooling = now < this._geodeReadyAt;
          this._wantShape('ring', hv.x + 0.5, this._groundTop(hv.x, hv.z) + 1, hv.z + 0.5, k.geodeR,
            cooling ? COL.grey : COL.quartz);
          cursor = cooling ? 'wait' : 'crosshair';
          break;
        }
        case 'pane': {
          if (g && g.tool === 'pane' && !g.ctrl && g.cells) {
            this._wantLine(g.cells, this._shift ? COL.paneDeep : COL.pane);
            cursor = 'crosshair';
            break;
          }
          if (!hv.hit) break;
          cursor = 'crosshair';
          if (this._ctrl) {
            const p = this._paneNear(hv.x, hv.z);
            if (p) { this._wantLine(this._paneTopCells(p), COL.alert); cursor = 'pointer'; }
            break;
          }
          this._wantShape('box', hv.x, this._groundTop(hv.x, hv.z) + 1, hv.z, 0, this._shift ? COL.paneDeep : COL.pane);
          break;
        }
        case 'seal': {
          const site = hv.marketId != null ? this._market(hv.marketId) : null;
          if (!site || !site.center) { cursor = hv.hit ? 'not-allowed' : 'default'; break; }
          this._wantShape('ring', site.center.x + 0.5, site.center.y, site.center.z + 0.5, k.plazaHalf + 1,
            this._ctrl ? COL.alert : COL.seal);
          cursor = 'pointer';
          break;
        }
        case 'whisper': {
          const a = this._agent(hv.agentId);
          if (!a || !a.pos) { cursor = hv.hit ? 'not-allowed' : 'default'; break; }
          hovered = a.id;
          this._wantShape('ring', a.pos.x, a.pos.y, a.pos.z, 0.8, COL.rumor);
          cursor = 'pointer';
          break;
        }
        case 'tap': {
          if (g && g.tool === 'tap' && g.hx !== undefined) {
            this._wantShape('ring', g.hx + 0.5, g.hy + 1, g.hz + 0.5, this._tapRadius((now - g.t0) / 1000), COL.tap);
            cursor = 'grabbing';
            break;
          }
          if (!hv.hit) break;
          this._wantShape('ring', hv.x + 0.5, hv.y + 1, hv.z + 0.5, k.tapMinR, COL.tap);
          cursor = 'grab';
          break;
        }
        case 'magnifier': {
          cursor = 'zoom-in';
          const a = this._agent(hv.agentId);
          if (a && a.pos) {
            hovered = a.id;
            this._wantShape('ring', a.pos.x, a.pos.y, a.pos.z, 0.7, COL.magnifier);
            break;
          }
          const t = hv.towerId != null ? this._tower(hv.towerId) : null;
          if (t && t.lens) { this._wantShape('box', t.lens.x, t.lens.y, t.lens.z, 0, COL.magnifier); break; }
          if (hv.hit) this._wantShape('disc', hv.x + 0.5, hv.y + 1, hv.z + 0.5, k.magScorchR, COL.magnifier);
          break;
        }
        case 'pipette': {
          if (!hv.hit) break;
          this._wantShape('disc', hv.x + 0.5, this._groundTop(hv.x, hv.z) + 1, hv.z + 0.5, this.brush.pipette, COL.water);
          cursor = 'crosshair';
          break;
        }
        case 'trowel': {
          if (!hv.hit) break;
          const place = g && g.tool === 'trowel' ? g.place : this._shift;
          if (place) {
            if (!this._placeCell(hv)) { cursor = 'not-allowed'; break; }
            const c = this._pc;
            const bad = this._placeBlocked(c.x, c.y, c.z) !== null;
            this._wantShape('box', c.x, c.y, c.z, 0, bad ? COL.alert : COL.loam);
            cursor = bad ? 'not-allowed' : 'cell';
          } else {
            const bad = this._digForbidden(hv);
            this._wantShape('box', hv.x, hv.y, hv.z, 0, bad ? COL.alert : COL.dig);
            cursor = bad ? 'not-allowed' : 'cell';
          }
          break;
        }
        default: break;
      }
    }
    this._commitPreview();
    this._setHovered(hovered);
    this._setCursor(cursor);
  }

  // -------------------------------------------------------------------------
  // Popovers
  // -------------------------------------------------------------------------

  _popEl() {
    if (this._popNode && this._popNode.isConnected !== false) return this._popNode;
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;
    this._popNode = document.getElementById('popover');
    return this._popNode;
  }

  /** (Re)build the open popover's content and place it near the cursor that opened it. */
  _renderPopover() {
    const st = this._pop;
    const el = this._popEl();
    if (!st || !el) { this._pop = null; return; }
    el.replaceChildren();
    if (el.classList) el.classList.add('popover');
    if (st.kind === 'seal') this._renderSeal(el, st);
    else if (st.kind === 'whisper') this._renderWhisper(el, st);
    else if (st.kind === 'wall') this._renderWall(el, st);
    if (!el.firstChild) { this._closePopover(); return; }
    el.hidden = false;
    this._placePopover(el, st.cx, st.cy);
  }

  _placePopover(el, cx, cy) {
    const s = el.style;
    s.position = 'fixed';
    s.right = 'auto';
    s.bottom = 'auto';
    // Keep the eight-good row wrapping into a compact card instead of a viewport-wide strip.
    s.maxWidth = 'min(calc(340px * var(--s, 1)), calc(100vw - 16px))';
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
    const box = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : { width: 0, height: 0 };
    let x = cx + POP_OFFSET;
    let y = cy + POP_OFFSET;
    if (x + box.width > vw - 8) x = Math.max(8, cx - POP_OFFSET - box.width);
    if (y + box.height > vh - 8) y = Math.max(8, vh - 8 - box.height);
    s.left = `${Math.round(x)}px`;
    s.top = `${Math.round(y)}px`;
  }

  _closePopover() {
    if (!this._pop) return;
    this._pop = null;
    const el = this._popEl();
    if (!el) return;
    el.hidden = true;
    el.replaceChildren();
  }

  /** Clan wall under a client point (Inspect only; every other pick sees through the walls), or -1. */
  _wallAt(cx, cy) {
    const clans = this.sim.clans;
    const r = this.sim.renderer;
    const w = this.sim.world;
    if (!clans || !clans.multi || !w || !r || typeof r.pickRay !== 'function') return -1;
    const ray = r.pickRay(cx, cy);
    const h = ray && ray.origin && ray.dir ? w.raycast(ray.origin, ray.dir, RAY_MAX, RAY_WALLS) : null;
    return h && h.id === CLAN_WALL ? clans.wallAt(h.x, h.z) : -1;
  }

  _openWall(wallId, cx, cy) {
    this._pop = { kind: 'wall', wallId, cx, cy };
    this._renderPopover();
  }

  /** The card of one clan wall: who it separates, how they get on, and a button to tear it down. */
  _renderWall(el, st) {
    const clans = this.sim.clans;
    const w = clans && clans.walls.find((x) => x.id === st.wallId);
    if (!w) return;
    const rel = REL_KEYS[clans.relState(w.a, w.b)] || 'neutral';
    el.append(
      dom('div', 'pop-row pop-title', t('wall.title', { a: w.a, b: w.b })),
      dom('div', 'pop-row pop-note', t('wall.note', { up: w.up, rel })),
    );
    const row = dom('div', 'pop-row');
    row.append(popButton(t(w.up ? 'wall.down' : 'wall.up'), true, () => {
      clans.setWall(w.id, !w.up);
      this._closePopover();
    }));
    const council = this.sim.council;
    if (council && typeof council.open === 'function') {
      row.append(popButton(t('wall.council'), false, () => { this._closePopover(); council.open(); }));
    }
    row.append(popButton(t('pop.cancel'), false, () => this._closePopover()));
    el.append(row);
  }

  /** Close a Whisper popover whose Wickling died or left while it was open. */
  _watchPopover() {
    const st = this._pop;
    if (st && st.kind === 'whisper' && !this._agent(st.agentId)) this._closePopover();
  }

  _goodRow(selected, onPick) {
    const row = dom('div', 'pop-row pop-goods');
    for (const g of GOODS) {
      const b = popButton('', g === selected, () => onPick(g));
      const sw = dom('i', 'pop-swatch');
      sw.style.display = 'inline-block';
      sw.style.width = '0.7em';
      sw.style.height = '0.7em';
      sw.style.marginRight = '0.35em';
      sw.style.borderRadius = '2px';
      sw.style.background = goodColor(g);
      b.append(sw, document.createTextNode(goodName(g)));
      b.title = goodName(g);
      row.append(b);
    }
    return row;
  }
}
