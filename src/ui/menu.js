/**
 * @file Menus: the title screen (before a world exists), the in-game menu (save, load, export,
 * import, new world, language) and the new-world setup with its clans.
 *
 * DOM only. Overlays carry the `.wm-overlay` class: while one is open the HUD and the tools leave
 * the keyboard alone. Starting or loading a world from inside a game navigates to a new URL after an
 * autosave (`?seed=…&setup=…` or `?load=<slot>`), so every world starts from a clean page.
 */
import { t, getLang, setLang, LANGS, onLangChange, profName } from '../core/i18n.js';
import { CLAN_DEFS, POLICY_OPTIONS, FIXED_OPTIONS, POLICY_KEYS, MAX_CLANS, normalizeSetup } from '../economy/clans.js';
import { randomSeed, parseSeed } from '../core/rng.js';
import { PROFESSIONS } from '../core/config.js';
import * as saves from './saves.js';

const FIXED_KEYS = Object.keys(FIXED_OPTIONS);
const DEFAULTS = normalizeSetup({ clans: [{}] }).clans[0];

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

function uiRoot() {
  return document.getElementById('ui-root') || document.body;
}

/** Remember the language for the next visit. */
export function rememberLang(id) {
  try { localStorage.setItem('wm.lang', id); } catch { /* storage may be blocked */ }
}

/** The language to start in: ?lang=, then the stored choice, then the browser's. */
export function initialLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (q && LANGS.some((l) => l.id === q)) return q;
  try {
    const s = localStorage.getItem('wm.lang');
    if (s && LANGS.some((l) => l.id === s)) return s;
  } catch { /* ignore */ }
  const nav = (navigator.language || '').toLowerCase();
  return nav.startsWith('hu') ? 'hu' : 'en';
}

function langButton(parent, onChange) {
  const row = el('div', 'menu-lang', null, parent);
  for (const l of LANGS) {
    const b = button(`wm-btn${l.id === getLang() ? ' on' : ''}`, l.name, row);
    b.addEventListener('click', () => {
      if (setLang(l.id)) {
        rememberLang(l.id);
        if (onChange) onChange();
      }
    });
  }
  return row;
}

// ---------------------------------------------------------------- setup in URLs

function b64url(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  const b = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(b + '==='.slice((b.length + 3) % 4))));
}

/** A setup as a short URL parameter (only what differs from the defaults), or '' for the classic jar. */
export function encodeSetup(setup) {
  const s = normalizeSetup(setup);
  const clans = s.clans.map((c) => {
    const o = {};
    for (const k of Object.keys(c)) if (c[k] !== DEFAULTS[k] && c[k] !== '') o[k] = c[k];
    return o;
  });
  const classic = clans.length === 1 && Object.keys(clans[0]).length === 0;
  if (classic) return '';
  return b64url(JSON.stringify({ c: clans, w: s.walls === 'down' ? 0 : 1 }));
}

/** Inverse of encodeSetup (anything broken becomes the classic jar). */
export function decodeSetup(param) {
  if (!param) return normalizeSetup(null);
  try {
    const o = JSON.parse(unb64url(param));
    return normalizeSetup({ clans: Array.isArray(o.c) ? o.c : [{}], walls: o.w === 0 ? 'down' : 'up' });
  } catch {
    return normalizeSetup(null);
  }
}

/** The page URL that makes world `seed` with `setup`. */
export function worldUrl(seed, setup) {
  const p = new URLSearchParams();
  p.set('seed', (seed >>> 0).toString(16));
  const s = encodeSetup(setup);
  if (s) p.set('setup', s);
  return `${location.pathname}?${p}`;
}

// ---------------------------------------------------------------- saved-game rows

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return t('menu.ago.now');
  if (s < 3600) return t('menu.ago.min', { n: Math.round(s / 60) });
  if (s < 86400) return t('menu.ago.hour', { n: Math.round(s / 3600) });
  return t('menu.ago.day', { n: Math.round(s / 86400) });
}

function saveName(meta) {
  if (meta.id === saves.AUTO) return t('menu.autoName');
  if (meta.id === saves.AUTO_PREV) return t('menu.autoPrevName');
  if (meta.id === saves.QUICK) return t('menu.quickName');
  return meta.name || t('menu.untitled', { day: meta.summary?.day ?? '?' });
}

function saveInfo(meta) {
  const s = meta.summary || {};
  return t('menu.saveInfo', { day: s.day ?? '?', pop: s.pop ?? '?', clans: meta.clans ?? s.clans ?? 1, seed: (meta.seed >>> 0).toString(16).toUpperCase(), ago: ago(meta.savedAt || 0) });
}

/**
 * The list of saved games with Load / file / Delete buttons.
 * @param {HTMLElement} parent
 * @param {{onLoad:(meta)=>void, onChanged?:()=>void}} h
 */
async function fillSaveList(parent, h) {
  parent.textContent = '';
  let list = [];
  try {
    list = await saves.listSaves();
  } catch (err) {
    el('p', 'menu-note bad', t('menu.storageError', { msg: err && err.message ? err.message : String(err) }), parent);
    return;
  }
  if (!list.length) {
    el('p', 'menu-note', t('menu.noSaves'), parent);
    return;
  }
  for (const meta of list) {
    const row = el('div', 'save-row', null, parent);
    const text = el('div', 'save-text', null, row);
    el('b', null, saveName(meta), text);
    el('span', null, saveInfo(meta), text);
    const load = button('wm-btn', t('menu.load'), row, t('menu.loadTip'));
    load.addEventListener('click', () => h.onLoad(meta));
    const file = button('wm-btn', '⇩', row, t('menu.exportSlotTip'));
    file.addEventListener('click', async () => {
      try { await saves.exportSlot(meta.id); } catch (err) { console.error(err); }
    });
    const del = button('wm-btn', '✕', row, t('menu.deleteTip'));
    del.addEventListener('click', async () => {
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.textContent = t('menu.deleteSure');
        setTimeout(() => { del.classList.remove('confirm'); del.textContent = '✕'; }, 3000);
        return;
      }
      try {
        await saves.deleteSave(meta.id);
      } catch (err) { console.error(err); }
      fillSaveList(parent, h);
      h.onChanged?.();
    });
  }
}

// ---------------------------------------------------------------- new-world setup

function randomPick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** A random but sensible clan: mostly normal laws with a few twists. */
function randomClan() {
  const c = { ...DEFAULTS };
  const twist = (k, list) => { if (Math.random() < 0.5) c[k] = randomPick(list); };
  twist('temper', POLICY_OPTIONS.temper);
  twist('fade', POLICY_OPTIONS.fade);
  twist('sharing', POLICY_OPTIONS.sharing);
  if (Math.random() < 0.35) c.trade = randomPick(POLICY_OPTIONS.trade);
  twist('family', POLICY_OPTIONS.family);
  twist('size', FIXED_OPTIONS.size);
  twist('wealth', FIXED_OPTIONS.wealth);
  c.talent = Math.random() < 0.6 ? randomPick(PROFESSIONS) : 'none';
  return c;
}

function optionLabel(key, value) {
  if (key === 'talent' && value !== 'none') return profName(value);
  return t(POLICY_KEYS.includes(key) ? `law.${key}.${value}` : `trait.${key}.${value}`);
}

/**
 * The new-world form.
 * @param {HTMLElement} parent
 * @param {{seed?:number, setup?:object, onStart:(seed:number, setup:object)=>void, onCancel?:()=>void}} opts
 */
export function buildSetupForm(parent, opts) {
  const state = {
    seed: Number.isFinite(opts.seed) ? opts.seed >>> 0 : randomSeed() >>> 0,
    count: 1,
    walls: 'up',
    clans: Array.from({ length: MAX_CLANS }, () => ({ ...DEFAULTS })),
  };
  if (opts.setup) {
    const s = normalizeSetup(opts.setup);
    state.count = s.clans.length;
    state.walls = s.walls;
    s.clans.forEach((c, i) => { state.clans[i] = { ...c }; });
  }

  const form = el('div', 'setup', null, parent);
  el('h2', 'wm-h setup-title', t('setup.title'), form);

  // World number.
  const rowSeed = el('div', 'setup-row', null, form);
  el('label', 'setup-l', t('setup.seed'), rowSeed);
  const seedIn = el('input', 'seed-input setup-seed', null, rowSeed);
  seedIn.type = 'text';
  seedIn.maxLength = 10;
  seedIn.spellcheck = false;
  seedIn.value = state.seed.toString(16).toUpperCase();
  seedIn.dataset.tip = t('setup.seedTip');
  const dice = button('wm-btn', '🎲', rowSeed, t('setup.seedRandom'));
  dice.addEventListener('click', () => {
    state.seed = randomSeed() >>> 0;
    seedIn.value = state.seed.toString(16).toUpperCase();
  });
  seedIn.addEventListener('input', () => seedIn.classList.remove('bad'));

  // Number of clans.
  const rowCount = el('div', 'setup-row', null, form);
  el('label', 'setup-l', t('setup.clans'), rowCount);
  const countBtns = [];
  for (let n = 1; n <= MAX_CLANS; n++) {
    const b = button('wm-btn setup-count', String(n), rowCount, t(n === 1 ? 'setup.clansOne' : 'setup.clansMany', { n }));
    b.addEventListener('click', () => {
      state.count = n;
      render();
    });
    countBtns.push(b);
  }
  el('p', 'setup-hint', t('setup.clansHint'), form);

  // Walls.
  const rowWalls = el('div', 'setup-row', null, form);
  el('label', 'setup-l', t('setup.walls'), rowWalls);
  const wallBtns = ['up', 'down'].map((w) => {
    const b = button('wm-btn', t(`setup.walls.${w}`), rowWalls, t(`setup.walls.${w}.tip`));
    b.addEventListener('click', () => {
      state.walls = w;
      render();
    });
    return b;
  });

  const cards = el('div', 'setup-cards', null, form);

  const actions = el('div', 'setup-actions', null, form);
  const rnd = button('wm-btn', t('setup.random'), actions, t('setup.randomTip'));
  rnd.addEventListener('click', () => {
    for (let i = 0; i < MAX_CLANS; i++) {
      const name = state.clans[i].name;
      state.clans[i] = { ...randomClan(), name };
    }
    render();
  });
  const reset = button('wm-btn', t('setup.reset'), actions, t('setup.resetTip'));
  reset.addEventListener('click', () => {
    state.clans = Array.from({ length: MAX_CLANS }, () => ({ ...DEFAULTS }));
    render();
  });
  el('div', 'setup-fill', null, actions);
  if (opts.onCancel) {
    const cancel = button('wm-btn', t('pop.cancel'), actions);
    cancel.addEventListener('click', () => opts.onCancel());
  }
  const start = button('wm-btn on setup-start', t('setup.start'), actions);
  start.addEventListener('click', () => {
    const raw = seedIn.value.trim();
    let seed = state.seed;
    if (raw) {
      if (!/^(0x)?[0-9a-f]{1,8}$/i.test(raw)) {
        seedIn.classList.remove('bad');
        void seedIn.offsetWidth;
        seedIn.classList.add('bad');
        return;
      }
      seed = parseSeed(raw) >>> 0;
    }
    const setup = normalizeSetup({ clans: state.clans.slice(0, state.count), walls: state.walls });
    opts.onStart(seed, setup);
  });

  function clanCard(i) {
    const c = state.clans[i];
    const def = CLAN_DEFS[i];
    const card = el('div', 'setup-card', null, cards);
    card.style.setProperty('--c', def.flag);
    card.style.setProperty('--b', def.body);
    const head = el('div', 'setup-card-h', null, card);
    const chip = el('i', 'clan-flag', null, head);
    chip.style.setProperty('--c', def.flag);
    const name = el('input', 'setup-name', null, head);
    name.type = 'text';
    name.maxLength = 20;
    name.placeholder = t(`clan.${def.key}`);
    name.value = c.name || '';
    name.setAttribute('aria-label', t('setup.name'));
    name.addEventListener('input', () => { c.name = name.value; });
    el('div', 'setup-card-info', t(`clanInfo.${def.key}`), card);

    const grid = el('div', 'setup-grid', null, card);
    const multi = state.count > 1;
    const addSelect = (key, list, group) => {
      if (!multi && (key === 'temper' || key === 'trade')) return;
      const l = el('label', `setup-k ${group}`, t(POLICY_KEYS.includes(key) ? `law.${key}` : `trait.${key}`), grid);
      l.dataset.tip = t(POLICY_KEYS.includes(key) ? `law.${key}.info` : `trait.${key}.info`);
      const sel = el('select', 'setup-sel', null, grid);
      for (const v of list) {
        const o = el('option', null, optionLabel(key, v), sel);
        o.value = v;
      }
      sel.value = c[key];
      sel.addEventListener('change', () => { c[key] = sel.value; });
    };
    for (const k of POLICY_KEYS) addSelect(k, POLICY_OPTIONS[k], 'law');
    for (const k of FIXED_KEYS) addSelect(k, FIXED_OPTIONS[k], 'trait');
  }

  function render() {
    countBtns.forEach((b, i) => b.classList.toggle('on', i + 1 === state.count));
    rowWalls.hidden = state.count < 2;
    wallBtns.forEach((b, i) => b.classList.toggle('on', (i === 0 ? 'up' : 'down') === state.walls));
    cards.textContent = '';
    cards.classList.toggle('one', state.count === 1);
    el('p', 'setup-hint', t(state.count === 1 ? 'setup.lawsHintOne' : 'setup.lawsHint'), cards);
    for (let i = 0; i < state.count; i++) clanCard(i);
  }
  render();
  return form;
}

// ---------------------------------------------------------------- the in-game menu

/**
 * The in-game menu (☰). `getExtra()` supplies the UI part of a save file.
 */
export class Menu {
  /**
   * @param {object} sim
   * @param {{getExtra:()=>object}} hooks
   */
  constructor(sim, hooks = {}) {
    this.sim = sim;
    this.getExtra = hooks.getExtra || (() => ({}));
    this._open = false;
    this._view = 'main';
    this._busy = false;
    this.$ov = el('div', 'wm-overlay menu-overlay', null, uiRoot());
    this.$ov.hidden = true;
    this.$ov.addEventListener('click', (e) => { if (e.target === this.$ov) this.close(); });
    this._onKey = (e) => {
      if (!this._open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (this._view !== 'main') this._show('main');
        else this.close();
      }
    };
    window.addEventListener('keydown', this._onKey, true);
    this._offLang = onLangChange(() => { if (this._open) this._render(); });
  }

  isOpen() {
    return this._open;
  }

  open(view = 'main') {
    this._open = true;
    this._view = view;
    this.$ov.hidden = false;
    this._wasPaused = this.sim.paused;
    this.sim.paused = true;
    this._render();
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.$ov.hidden = true;
    this.$ov.textContent = '';
    this.sim.paused = !!this._wasPaused;
  }

  toggle() {
    if (this._open) this.close();
    else this.open();
  }

  /** Ctrl+S: the quick-save slot. */
  async quickSave() {
    try {
      await saves.saveGame(this.sim, { id: saves.QUICK, extra: this.getExtra() });
      this._toast(t('menu.quickSaved'));
    } catch (err) {
      console.error('[menu] quick save failed', err);
      this._toast(t('menu.saveFailed'), true);
    }
  }

  /** Autosave now (called before leaving the page). */
  async autosave() {
    try {
      const meta = await saves.autosave(this.sim, this.getExtra());
      try { localStorage.removeItem('wm.emergency'); } catch { /* ignore */ }
      return meta;
    } catch (err) {
      console.error('[menu] autosave failed', err);
      return null;
    }
  }

  _toast(text, bad) {
    const tt = el('div', `wm-toast${bad ? ' bad' : ''}`, text, uiRoot());
    setTimeout(() => tt.classList.add('out'), 1600);
    setTimeout(() => tt.remove(), 2200);
  }

  _show(view) {
    this._view = view;
    this._render();
  }

  _render() {
    const ov = this.$ov;
    ov.textContent = '';
    const card = el('div', `wm-card menu-card${this._view === 'new' ? ' wide' : ''}`, null, ov);
    card.setAttribute('role', 'dialog');
    const close = button('wm-btn help-close', '✕', card);
    close.setAttribute('aria-label', t('menu.close'));
    close.addEventListener('click', () => this.close());
    if (this._view === 'new') {
      buildSetupForm(card, {
        seed: this.sim.seed,
        setup: this.sim.setup,
        onStart: (seed, setup) => this._go(worldUrl(seed, setup)),
        onCancel: () => this._show('main'),
      });
      return;
    }
    el('h2', 'wm-h', t('menu.title'), card);
    const top = el('div', 'menu-actions', null, card);
    const back = button('wm-btn on', t('menu.resume'), top);
    back.addEventListener('click', () => this.close());

    const saveRow = el('div', 'menu-save', null, card);
    const name = el('input', 'menu-name', null, saveRow);
    name.type = 'text';
    name.maxLength = 60;
    name.placeholder = t('menu.namePh', { day: this.sim.clock.day + 1 });
    name.setAttribute('aria-label', t('menu.nameAria'));
    const saveBtn = button('wm-btn', t('menu.save'), saveRow, t('menu.saveTip'));
    const list = el('div', 'save-list', null, card);
    const doSave = async () => {
      if (this._busy) return;
      this._busy = true;
      try {
        await saves.saveGame(this.sim, { name: name.value.trim() || name.placeholder, extra: this.getExtra() });
        name.value = '';
        this._toast(t('menu.saved'));
        await fillSaveList(list, this._listHandlers(list));
      } catch (err) {
        console.error('[menu] save failed', err);
        this._toast(t('menu.saveFailed'), true);
      }
      this._busy = false;
    };
    saveBtn.addEventListener('click', doSave);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });

    el('h3', 'menu-h', t('menu.saves'), card);
    card.appendChild(list);
    fillSaveList(list, this._listHandlers(list));

    const more = el('div', 'menu-actions', null, card);
    const imp = button('wm-btn', t('menu.import'), more, t('menu.importTip'));
    imp.addEventListener('click', async () => {
      const file = await saves.pickFile();
      if (!file) return;
      try {
        const { meta } = await saves.importFile(file);
        this._go(`${location.pathname}?load=${encodeURIComponent(meta.id)}`);
      } catch (err) {
        console.error('[menu] import failed', err);
        this._toast(t(err && err.code === 'tooNew' ? 'menu.tooNew' : 'menu.notASave'), true);
      }
    });
    const exp = button('wm-btn', t('menu.export'), more, t('menu.exportTip'));
    exp.addEventListener('click', async () => {
      try { await saves.exportRunning(this.sim, this.getExtra()); } catch (err) { console.error(err); }
    });
    const nw = button('wm-btn', t('menu.newWorld'), more, t('menu.newWorldTip'));
    nw.addEventListener('click', () => this._show('new'));
    const link = button('wm-btn', t('menu.link'), more, t('menu.linkTip'));
    link.addEventListener('click', async () => {
      const url = `${location.origin}${worldUrl(this.sim.seed, this.sim.setup)}`;
      try {
        await navigator.clipboard.writeText(url);
        this._toast(t('menu.linkCopied'));
      } catch {
        window.prompt(t('menu.linkTip'), url);
      }
    });

    el('h3', 'menu-h', t('menu.language'), card);
    langButton(card);
    el('p', 'menu-note', t('menu.autoNote'), card);
  }

  _listHandlers(list) {
    return {
      onLoad: (meta) => this._go(`${location.pathname}?load=${encodeURIComponent(meta.id)}`),
      onChanged: () => {},
    };
  }

  /** Autosave, then leave for `url` (a new world or a saved one). */
  async _go(url) {
    if (this._busy) return;
    this._busy = true;
    this._toast(t('menu.leaving'));
    await this.autosave();
    location.href = url;
  }
}

// ---------------------------------------------------------------- the title screen

/**
 * The title screen shown when the page opens without a world in the URL.
 * @returns {Promise<{kind:'new', seed:number, setup:object}|{kind:'load', save:object, id:string}>}
 */
export function showTitle() {
  return new Promise((resolve) => {
    const ov = el('div', 'wm-overlay title-overlay', null, uiRoot());
    let view = 'main';
    let latest = null;
    const done = (decision) => {
      offLang();
      ov.remove();
      resolve(decision);
    };
    const loadSlot = async (meta, note) => {
      try {
        note.textContent = t('menu.loading');
        const save = await saves.loadSave(meta.id);
        done({ kind: 'load', save, id: meta.id });
      } catch (err) {
        console.error('[title] load failed', err);
        note.textContent = t(err && err.code === 'tooNew' ? 'menu.tooNew' : 'menu.notASave');
      }
    };
    const render = async () => {
      ov.textContent = '';
      const card = el('div', `wm-card title-card${view === 'new' ? ' wide' : ''}`, null, ov);
      if (view === 'new') {
        buildSetupForm(card, {
          onStart: (seed, setup) => done({ kind: 'new', seed, setup }),
          onCancel: () => { view = 'main'; render(); },
        });
        return;
      }
      el('div', 'title-flame', null, card);
      el('h1', 'title-name', 'Wickmarket', card);
      el('p', 'title-sub', t('title.sub'), card);
      const note = el('p', 'menu-note title-note', '', card);
      const col = el('div', 'title-buttons', null, card);
      try { latest = await saves.latestSave(); } catch { latest = null; }
      if (latest) {
        const cont = button('wm-btn on title-btn', null, col);
        el('b', null, t('title.continue'), cont);
        el('span', null, `${saveName(latest)} · ${saveInfo(latest)}`, cont);
        cont.addEventListener('click', () => loadSlot(latest, note));
      }
      const nw = button(`wm-btn title-btn${latest ? '' : ' on'}`, t('title.new'), col);
      nw.addEventListener('click', () => { view = 'new'; render(); });
      const classic = button('wm-btn title-btn', t('title.quick'), col, t('title.quickTip'));
      classic.addEventListener('click', () => done({ kind: 'new', seed: randomSeed() >>> 0, setup: normalizeSetup(null) }));
      const imp = button('wm-btn title-btn', t('menu.import'), col, t('menu.importTip'));
      imp.addEventListener('click', async () => {
        const file = await saves.pickFile();
        if (!file) return;
        try {
          const { meta, save } = await saves.importFile(file);
          done({ kind: 'load', save, id: meta.id });
        } catch (err) {
          console.error('[title] import failed', err);
          note.textContent = t(err && err.code === 'tooNew' ? 'menu.tooNew' : 'menu.notASave');
        }
      });
      const listBox = el('div', 'title-saves', null, card);
      el('h3', 'menu-h', t('menu.saves'), listBox);
      const list = el('div', 'save-list', null, listBox);
      fillSaveList(list, { onLoad: (meta) => loadSlot(meta, note), onChanged: () => render() });
      langButton(card);
    };
    const offLang = onLangChange(() => render());
    render();
  });
}
