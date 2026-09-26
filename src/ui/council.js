/**
 * @file The clan council (K): every clan's numbers and laws, the walls between them, and how each
 * pair of clans gets on — with the player's levers: change a law, tear down or build a wall, calm
 * two clans down or stir them up.
 *
 * DOM only; writes the sim only through `sim.clans` (setPolicy, setWall, setAllWalls, diplomacy).
 * The card is built when opened (and after a language change) and its numbers refresh twice a second.
 */
import { t, onLangChange, clanName, fmtInt, fmtNum, fmtPrice, profName } from '../core/i18n.js';
import { POLICY_OPTIONS, POLICY_KEYS, REL_KEYS } from '../economy/clans.js';

const REFRESH = 0.5;

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

export class Council {
  /** @param {object} sim */
  constructor(sim) {
    this.sim = sim;
    this._open = false;
    this._acc = 0;
    this.$ov = el('div', 'wm-overlay council-overlay', null, document.getElementById('ui-root') || document.body);
    this.$ov.hidden = true;
    this.$ov.addEventListener('click', (e) => { if (e.target === this.$ov) this.close(); });
    this._onKey = (e) => {
      if (!this._open) return;
      if (e.key === 'Escape' || ((e.key === 'k' || e.key === 'K') && !(e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)))) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
    window.addEventListener('keydown', this._onKey, true);
    this._offLang = onLangChange(() => { if (this._open) this._build(); });
  }

  isOpen() {
    return this._open;
  }

  open() {
    if (!this.sim.clans) return;
    this._open = true;
    this.$ov.hidden = false;
    this._build();
  }

  close() {
    this._open = false;
    this.$ov.hidden = true;
    this.$ov.textContent = '';
  }

  toggle() {
    if (this._open) this.close();
    else this.open();
  }

  /** Per-frame hook from main.js: refreshes the numbers while open. */
  update(realDt) {
    if (!this._open) return;
    this._acc += Number.isFinite(realDt) ? realDt : 0;
    if (this._acc < REFRESH) return;
    this._acc = 0;
    try { this._refresh(); } catch (err) { console.error('[council] refresh failed', err); }
  }

  // ================================================================ build

  _build() {
    const sim = this.sim;
    const clans = sim.clans;
    const ov = this.$ov;
    ov.textContent = '';
    const card = el('div', 'wm-card council-card', null, ov);
    card.setAttribute('role', 'dialog');
    const close = button('wm-btn help-close', '✕', card);
    close.setAttribute('aria-label', t('menu.close'));
    close.addEventListener('click', () => this.close());
    el('h2', 'wm-h', t('council.title'), card);
    el('p', 'help-lede', t('council.lede'), card);

    // Clans.
    const grid = el('div', 'council-clans', null, card);
    this.$clans = clans.list.map((cl) => {
      const box = el('div', 'council-clan', null, grid);
      box.style.setProperty('--c', cl.flag);
      box.style.setProperty('--b', cl.body);
      const head = el('div', 'council-clan-h', null, box);
      el('i', 'clan-flag', null, head).style.setProperty('--c', cl.flag);
      el('b', null, clanName(cl.id), head);
      const traits = [];
      if (cl.size !== 'normal') traits.push(t(`trait.size.${cl.size}`));
      if (cl.wealth !== 'normal') traits.push(t(`trait.wealth.${cl.wealth}`));
      if (cl.talent && cl.talent !== 'none') traits.push(t('council.talent', { prof: profName(cl.talent) }));
      if (traits.length) el('span', 'council-traits', traits.join(' · '), head);
      const stats = el('div', 'council-stats', null, box);
      const stat = (key) => {
        const s = el('div', 'kv', null, stats);
        el('span', 'k', t(`council.stat.${key}`), s);
        return el('span', 'v', '—', s);
      };
      const v = {
        pop: stat('pop'), money: stat('money'), gini: stat('gini'), towers: stat('towers'), berry: stat('berry'),
      };
      const laws = el('div', 'council-laws', null, box);
      const sels = {};
      for (const key of POLICY_KEYS) {
        if (!clans.multi && (key === 'temper' || key === 'trade')) continue;
        const l = el('label', 'setup-k', t(`law.${key}`), laws);
        l.dataset.tip = t(`law.${key}.info`);
        const sel = el('select', 'setup-sel', null, laws);
        for (const val of POLICY_OPTIONS[key]) {
          const o = el('option', null, t(`law.${key}.${val}`), sel);
          o.value = val;
        }
        sel.value = cl[key];
        sel.addEventListener('change', () => {
          if (!clans.setPolicy(cl.id, key, sel.value)) sel.value = cl[key];
        });
        sels[key] = sel;
      }
      return { cl, v, sels };
    });

    this.$walls = [];
    this.$rels = [];
    if (!clans.multi) {
      el('p', 'menu-note', t('council.single'), card);
      this._refresh();
      return;
    }

    // Walls.
    el('h3', 'menu-h', t('council.walls'), card);
    const wallBox = el('div', 'council-walls', null, card);
    const all = el('div', 'menu-actions', null, wallBox);
    const down = button('wm-btn', t('council.allDown'), all, t('council.allDownTip'));
    down.addEventListener('click', () => { clans.setAllWalls(false); this._refresh(); });
    const up = button('wm-btn', t('council.allUp'), all, t('council.allUpTip'));
    up.addEventListener('click', () => { clans.setAllWalls(true); this._refresh(); });
    this.$walls = clans.walls.map((w) => {
      const row = el('div', 'council-row', null, wallBox);
      const name = el('span', 'council-pair', null, row);
      this._pairLabel(name, w.a, w.b);
      const state = el('span', 'council-state', '', row);
      const btn = button('wm-btn', '', row);
      btn.addEventListener('click', () => { clans.setWall(w.id, !w.up); this._refresh(); });
      return { w, state, btn };
    });

    // Relations.
    el('h3', 'menu-h', t('council.relations'), card);
    el('p', 'menu-note', t('council.relationsNote'), card);
    const relBox = el('div', 'council-rels', null, card);
    this.$rels = [];
    for (let a = 0; a < clans.count; a++) {
      for (let b = a + 1; b < clans.count; b++) {
        const row = el('div', 'council-row', null, relBox);
        const name = el('span', 'council-pair', null, row);
        this._pairLabel(name, a, b);
        const bar = el('span', 'rel-bar', null, row);
        const fill = el('i', null, null, bar);
        const state = el('span', 'council-state', '', row);
        const peace = button('wm-btn', '☮', row, t('council.peaceTip'));
        peace.addEventListener('click', () => { clans.diplomacy(a, b, 1); this._refresh(); });
        const stir = button('wm-btn', '⚔', row, t('council.stirTip'));
        stir.addEventListener('click', () => { clans.diplomacy(a, b, -1); this._refresh(); });
        this.$rels.push({ a, b, fill, state, peace, stir });
      }
    }
    this._refresh();
  }

  _pairLabel(node, a, b) {
    const clans = this.sim.clans;
    const chip = (c) => {
      const i = el('i', 'clan-flag', null, node);
      i.style.setProperty('--c', clans.list[c].flag);
      el('span', null, clanName(c), node);
    };
    chip(a);
    el('span', 'council-amp', '–', node);
    chip(b);
  }

  // ================================================================ refresh

  _refresh() {
    const sim = this.sim;
    const clans = sim.clans;
    const ledger = sim.ledger;
    const prod = sim.production;
    for (const c of this.$clans) {
      const s = ledger.clanStats(c.cl.id);
      setText(c.v.pop, `${fmtInt(s.housed)}/${fmtInt(s.pop)}`);
      setText(c.v.money, fmtInt(s.money));
      setText(c.v.gini, fmtNum(s.gini, 2));
      setText(c.v.towers, `${fmtInt(prod.activeTowerCount(c.cl.id))}/${fmtInt(prod.clanTowerCount(c.cl.id))}`);
      setText(c.v.berry, fmtPrice(clans.clanPrice(c.cl.id, 'berry')));
      for (const key of POLICY_KEYS) if (c.sels[key] && c.sels[key].value !== c.cl[key]) c.sels[key].value = c.cl[key];
    }
    for (const r of this.$walls) {
      setText(r.state, t(r.w.up ? 'council.wallUp' : 'council.wallDown'));
      r.state.classList.toggle('down', !r.w.up);
      setText(r.btn, t(r.w.up ? 'wall.down' : 'wall.up'));
    }
    for (const r of this.$rels) {
      const v = clans.relation(r.a, r.b);
      const st = REL_KEYS[clans.relState(r.a, r.b)] || 'neutral';
      r.fill.style.left = v < 0 ? `${50 + v / 2}%` : '50%';
      r.fill.style.width = `${Math.abs(v) / 2}%`;
      r.fill.className = v < 0 ? 'neg' : 'pos';
      const linked = clans.linked(r.a, r.b);
      setText(r.state, `${t(`relName.${st}`)} (${v >= 0 ? '+' : '−'}${Math.round(Math.abs(v))})${linked ? '' : ` · ${t('council.apart')}`}`);
      r.state.className = `council-state rel-${st}`;
      const ready = clans.diplomacyReady(r.a, r.b);
      r.peace.disabled = !ready;
      r.stir.disabled = !ready;
    }
  }
}
