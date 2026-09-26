/**
 * @file Clans: several kinds of Wicklings sharing one jar.
 *
 * Each clan owns a pie-slice "sector" of the island with its own market, houses, towers, pond and
 * rocky hill. Unbreakable glass walls may separate the sectors; the player can tear any wall down
 * (or build it again) at any time. Clans that can reach each other trade, compete for land and
 * slowly become friends or enemies:
 *   - trade between clans raises their relation, working on another clan's land lowers it;
 *   - hostile clans refuse each other at their markets and scuffle on contact; at war fights are
 *     common, losers are robbed and may be snuffed out;
 *   - walls and time cool things down (relations drift to a baseline set by the clans' tempers).
 * Every clan has laws the player can change: temper, how fast money fades, wealth sharing, trade
 * with other clans (open / border tax / closed) and family size.
 *
 * With a single clan (the classic jar) this module is inert: every query returns the classic answer
 * and it uses no randomness, so the classic economy is unchanged.
 *
 * Money rule: fights and sharing only move light between agents (transfers inside M); the border
 * tax is burned as a `fee` (a recorded sink).
 * Sim-side: no DOM, no three; randomness only through `sim.rng`.
 */
import { CONFIG, TICKS, GOODS, PROFESSIONS } from '../core/config.js';
import { EV } from '../core/events.js';
import { B } from '../world/blocks.js';
import { addItem, removeItem } from '../agents/agent.js';
import { interrupt } from '../agents/brain.js';

const PER_SEC = TICKS.PER_SEC;
const PER_HOUR = TICKS.PER_HOUR;
const PER_DAY = TICKS.PER_DAY;

export const MAX_CLANS = 6;

/** Visual identity and name pools. Clan 0 keeps the classic look and names. */
export const CLAN_DEFS = Object.freeze([
  { key: 'honey', body: '#F3E3C3', flag: '#D9A441',
    first: ['Tallowby', 'Wickett', 'Ember', 'Candor', 'Taper', 'Flick', 'Glimmer', 'Sconce', 'Votive', 'Snuff', 'Lumen', 'Cera', 'Beeswick', 'Dripley', 'Moth'],
    last: ['Fenn', 'Wax', 'Brass', 'Dew', 'Peat', 'Quill', 'Soot', 'Pine', 'Ridge', 'Hollow', 'Bell', 'Tallow', 'Rush', 'Mote'] },
  { key: 'frost', body: '#CDE5F4', flag: '#4F9BC7',
    first: ['Rime', 'Sleet', 'Glint', 'Frosty', 'Icicle', 'Hail', 'Snowy', 'Chill', 'Flurry', 'Glaze', 'Winter', 'Crystal'],
    last: ['Pale', 'Drift', 'Cold', 'Shard', 'Hoar', 'Frost', 'Crisp', 'North', 'White', 'Blue'] },
  { key: 'moss', body: '#C8DFA5', flag: '#5E9A45',
    first: ['Fern', 'Clover', 'Lichen', 'Sprout', 'Bramble', 'Sage', 'Tansy', 'Reed', 'Leafy', 'Nettle', 'Basil', 'Olive'],
    last: ['Green', 'Root', 'Leaf', 'Bark', 'Glen', 'Moss', 'Thicket', 'Vale', 'Burrow', 'Loam'] },
  { key: 'rose', body: '#F3C2C9', flag: '#D2607A',
    first: ['Petal', 'Posy', 'Blush', 'Rosy', 'Poppy', 'Tulip', 'Peony', 'Dahlia', 'Sweetpea', 'Cherry', 'Ruby', 'Coral'],
    last: ['Bloom', 'Thorn', 'Garden', 'Pink', 'Blossom', 'Rose', 'Bud', 'Meadow', 'Heart', 'Dew'] },
  { key: 'ash', body: '#CBC5BC', flag: '#6F6A75',
    first: ['Cinder', 'Flint', 'Smudge', 'Ashby', 'Dusty', 'Slate', 'Coal', 'Pepper', 'Grit', 'Soot', 'Stony', 'Graphite'],
    last: ['Grey', 'Smoke', 'Coal', 'Char', 'Ember', 'Stone', 'Hearth', 'Pike', 'Ash', 'Dust'] },
  { key: 'plum', body: '#D8C0EA', flag: '#8B5BB8',
    first: ['Damson', 'Sloe', 'Mauve', 'Violet', 'Lilac', 'Berry', 'Fig', 'Mulberry', 'Iris', 'Heather', 'Grape', 'Juniper'],
    last: ['Plum', 'Dusk', 'Velvet', 'Twilight', 'Vine', 'Grove', 'Purple', 'Night', 'Wine', 'Moon'] },
]);

/** Laws the player can change at any time. The first option of each list is not the default. */
export const POLICY_OPTIONS = Object.freeze({
  temper: Object.freeze(['peaceful', 'normal', 'warlike']),
  fade: Object.freeze(['slow', 'normal', 'fast']),
  sharing: Object.freeze(['none', 'some', 'much']),
  trade: Object.freeze(['open', 'tax', 'closed']),
  family: Object.freeze(['small', 'normal', 'big']),
});
/** Chosen when the world is made, fixed afterwards. */
export const FIXED_OPTIONS = Object.freeze({
  size: Object.freeze(['small', 'normal', 'large']),
  wealth: Object.freeze(['poor', 'normal', 'rich']),
  talent: Object.freeze(['none', ...PROFESSIONS]),
});
export const POLICY_KEYS = Object.freeze(Object.keys(POLICY_OPTIONS));
const DEFAULTS = {
  temper: 'normal', fade: 'normal', sharing: 'none', trade: 'open', family: 'normal',
  size: 'normal', wealth: 'normal', talent: 'none',
};

const FADE_MUL = { slow: 0.5, normal: 1, fast: 2 };
const SHARE_RATE = { none: 0, some: 0.05, much: 0.15 };
const FAMILY_MUL = { small: 0.5, normal: 1, big: 1.6 };
const WEALTH_MUL = { poor: 0.5, normal: 1, rich: 2 };
const SIZE_MUL = { small: 0.65, normal: 1, large: 1.4 };
/** Fight chance multiplier, relation baseline and trespass anger per temper. */
const TEMPER = {
  peaceful: { fight: 0.3, base: 1, anger: 0.5, bold: false },
  normal: { fight: 1, base: 0, anger: 1, bold: false },
  warlike: { fight: 2.2, base: -1.6, anger: 2, bold: true },
};
export const BORDER_TAX = 0.15;
export const TALENT_SKILL = 0.3;

/** Relation states, worst first. */
export const REL = Object.freeze({ WAR: 0, HOSTILE: 1, NEUTRAL: 2, FRIENDLY: 3, ALLIED: 4 });
export const REL_KEYS = Object.freeze(['war', 'hostile', 'neutral', 'friendly', 'allied']);

const FIGHT_TICKS = 3 * PER_SEC;
const FIGHT_RADIUS = 1.3;
const FIGHT_CHANCE = { [REL.WAR]: 0.3, [REL.HOSTILE]: 0.045 };
const LOOT_FRAC = 0.25;
const WAR_DEATH = 0.12;
const REL_TRADE = 0.35;
const REL_TRESPASS = -0.25;
const REL_FIGHT = -2.5;
const REL_DEATH = -10;
const REL_HOUR_CAP = 5;
const DIPLOMACY = 25;
const DIPLOMACY_COOLDOWN = 6 * PER_HOUR;
const WALL_ABOVE = 6;
const NONE = 255;

const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);

/**
 * A complete, valid world setup from anything (URL, menu, old saves).
 * @returns {{clans: object[], walls: 'up'|'down'}}
 */
export function normalizeSetup(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(src.clans) ? src.clans : [];
  const n = clampNum(Math.floor(Number(src.count ?? list.length) || list.length || 1), 1, MAX_CLANS);
  const clans = [];
  for (let i = 0; i < n; i++) {
    const c = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const out = { name: typeof c.name === 'string' ? c.name.trim().slice(0, 20) : '' };
    for (const k of POLICY_KEYS) out[k] = pick(c[k], POLICY_OPTIONS[k], DEFAULTS[k]);
    for (const k of Object.keys(FIXED_OPTIONS)) out[k] = pick(c[k], FIXED_OPTIONS[k], DEFAULTS[k]);
    clans.push(out);
  }
  return { clans, walls: src.walls === 'down' ? 'down' : 'up' };
}

/** Starting size, floor and cap per clan (the classic single clan keeps SPEC numbers). */
export function clanSizes(setup) {
  const P = CONFIG.population;
  const n = setup.clans.length;
  if (n === 1) {
    const k = SIZE_MUL[setup.clans[0].size];
    return [{ initial: Math.round(P.initial * k), max: Math.round(P.max * k), floor: Math.round(P.floor * k) }];
  }
  const per = n <= 2 ? 30 : n === 3 ? 24 : n === 4 ? 19 : n === 5 ? 16 : 14;
  const raw = setup.clans.map((c) => Math.max(8, Math.round(per * SIZE_MUL[c.size])));
  const total = raw.reduce((s, v) => s + v, 0);
  const scale = total > 120 ? 120 / total : 1;
  return raw.map((v) => {
    const initial = Math.max(8, Math.round(v * scale));
    return { initial, max: Math.round(initial * 2), floor: Math.max(4, Math.round(initial * 0.45)) };
  });
}

/** Profession mix of a clan's founders and immigrants (porters only matter once clans meet). */
function professionMix(clan, multi) {
  const base = CONFIG.population.initialProf;
  const mix = {};
  for (const p of PROFESSIONS) mix[p] = Math.max(0, base[p] || 0);
  if (multi) mix.porter = 0;
  if (clan.talent !== 'none') mix[clan.talent] = Math.round(mix[clan.talent] * 1.5 + 2);
  return mix;
}

// ═════════════════════════════════════════════════════════════════════════════
// Wall stamping (shared with worldgen)
// ═════════════════════════════════════════════════════════════════════════════

/** Highest natural-ground block of a column (structures, plants, water and glass skipped), or -1. */
export function groundTopAt(world, x, z) {
  const GROUND = GROUND_TABLE;
  let y = world.surfaceY(x, z) - 1;
  while (y > 0 && !GROUND[world.get(x, y, z)]) y--;
  return y;
}

const GROUND_TABLE = (() => {
  const t = new Uint8Array(256);
  for (const id of [B.BEDROCK, B.BASALT, B.LOAM, B.MOSS, B.PATH, B.PEAT, B.QUARTZ, B.AMBER, B.PAVING]) t[id] = 1;
  return t;
})();

/**
 * Stamp a wall column: CLAN_WALL from y=1 to ground+6, returning what it replaced.
 * `direct` writes world.data without bookkeeping (worldgen recomputes derived data afterwards).
 * @returns {{y0:number, y1:number, prev:Uint8Array}}
 */
export function stampWallColumn(world, x, z, groundTop, direct) {
  const y0 = 1;
  const y1 = Math.min(world.SY - 1, Math.max(y0, groundTop + WALL_ABOVE));
  const prev = new Uint8Array(y1 - y0 + 1);
  for (let y = y0; y <= y1; y++) {
    const i = x + world.SX * (z + world.SZ * y);
    const id = world.data[i];
    prev[y - y0] = id;
    if (id === B.BEDROCK) continue;
    if (direct) world.data[i] = B.CLAN_WALL;
    else world.set(x, y, z, B.CLAN_WALL);
  }
  return { y0, y1, prev };
}

// ═════════════════════════════════════════════════════════════════════════════
// Clans
// ═════════════════════════════════════════════════════════════════════════════

export class Clans {
  /**
   * @param {object} sim the sim context (world and worldInfo are set)
   * @param {object} setup a normalized setup (normalizeSetup)
   * @param {object} worldInfo WorldInfo from generateWorld
   */
  constructor(sim, setup, worldInfo) {
    this.sim = sim;
    this.setup = normalizeSetup(setup);
    const n = this.setup.clans.length;
    this.count = n;
    this.multi = n > 1;
    const world = sim.world;
    const SX = world ? world.SX : CONFIG.world.SX;
    const SZ = world ? world.SZ : CONFIG.world.SZ;
    this.SX = SX;
    this.SZ = SZ;

    const markets = worldInfo?.markets || [];
    const sizes = clanSizes(this.setup);
    this.list = this.setup.clans.map((c, i) => {
      const def = CLAN_DEFS[i];
      const own = [];
      markets.forEach((mk, m) => { if ((mk.clan ?? 0) === i) own.push(m); });
      return {
        id: i, key: def.key, body: def.body, flag: def.flag, first: def.first, last: def.last,
        name: c.name, size: c.size, wealth: c.wealth, talent: c.talent,
        temper: c.temper, fade: c.fade, sharing: c.sharing, trade: c.trade, family: c.family,
        initial: sizes[i].initial, max: sizes[i].max, floor: sizes[i].floor,
        markets: own.length ? own : (i === 0 ? markets.map((_, m) => m) : []),
        towerMax: n === 1 ? CONFIG.production.tower.max : Math.max(3, Math.ceil(CONFIG.production.tower.max * 1.6 / n)),
        maxOpen: n === 1 ? CONFIG.production.house.maxOpen : Math.max(3, Math.ceil(CONFIG.production.house.maxOpen * 1.5 / n)),
        profMix: null,
      };
    });
    for (const c of this.list) c.profMix = professionMix(c, this.multi);

    /** Owning sector (= clan id) of every column; NONE on walls and outside the island. */
    this.sectorMap = worldInfo?.sectorMap instanceof Uint8Array && worldInfo.sectorMap.length === SX * SZ
      ? worldInfo.sectorMap : new Uint8Array(SX * SZ);
    this._marketSector = markets.map((mk) => this._sectorAtRaw(mk.center.x, mk.center.z, mk.clan ?? 0));

    // Walls.
    this.walls = (worldInfo?.wallLines || []).map((w) => ({ id: w.id, a: w.a, b: w.b, cols: Int32Array.from(w.cols), up: true }));
    this.cover = new Uint8Array(SX * SZ);
    /** @type {Map<number, {y0:number, y1:number, prev:Uint8Array}>} what each walled column replaced */
    this.prev = new Map();
    const stamped = worldInfo?.wallStamp;
    if (stamped instanceof Map) {
      for (const [col, rec] of stamped) this.prev.set(col, rec);
      for (const w of this.walls) for (const col of w.cols) this.cover[col]++;
      delete worldInfo.wallStamp;
    }
    this._root = new Int32Array(n);
    this._relinks();
    if (this.setup.walls === 'down' && this.walls.length) {
      for (const w of this.walls) this._setWallQuiet(w, false);
      this._relinks();
    }

    // Relations.
    this.rel = new Float32Array(n * n);
    this.state = new Uint8Array(n * n).fill(REL.NEUTRAL);
    this._hourGain = new Float32Array(n * n);
    this._diploUntil = new Float64Array(n * n);
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) this._set(a, b, this._baseline(a, b) * 0.5, true);
    }

    // Fights and daily counters.
    /** @type {{a:number, b:number, until:number, x:number, y:number, z:number}[]} */
    this.fights = [];
    this.today = this._newDay();
    this.yesterday = this._newDay();
    this._near = [];
    this._enemy = new Uint8Array(n);

    this._unsubs = [];
    if (this.multi) this._subscribe();
  }

  // ───────────────────────────────────────────────────────────────── queries

  /** Clan record of an agent (clan 0 when unknown). */
  of(agent) {
    return this.list[agent?.clan ?? 0] || this.list[0];
  }

  /** Market ids owned by clan c. */
  marketsOf(c) {
    return (this.list[c] || this.list[0]).markets;
  }

  /** Owning clan of market m. */
  marketClan(m) {
    return this.sim.worldInfo?.markets?.[m]?.clan ?? 0;
  }

  /** Mean price of `good` over clan c's own markets (classic: both plazas, same as avgPrice). */
  clanPrice(c, good) {
    const market = this.sim.market;
    const ms = this.marketsOf(c);
    if (!market || !ms.length) return market ? market.avgPrice(good) : CONFIG.goods[good]?.ref ?? 1;
    let s = 0;
    for (let i = 0; i < ms.length; i++) s += market.price(ms[i], good);
    return s / ms.length;
  }

  _sectorAtRaw(x, z, dflt) {
    const xi = Math.floor(x), zi = Math.floor(z);
    if (xi < 0 || zi < 0 || xi >= this.SX || zi >= this.SZ) return dflt;
    const s = this.sectorMap[xi + this.SX * zi];
    return s === NONE ? dflt : s;
  }

  /** Sector (owning clan) of column (x, z), or 255 on a wall line / outside. */
  sectorAt(x, z) {
    if (!this.multi) return 0;
    const xi = Math.floor(x), zi = Math.floor(z);
    if (xi < 0 || zi < 0 || xi >= this.SX || zi >= this.SZ) return NONE;
    return this.sectorMap[xi + this.SX * zi];
  }

  /** The sector an agent stands in (its home sector while on a wall line). */
  agentSector(agent) {
    if (!this.multi) return 0;
    const c = agent.cell;
    const s = this.sectorAt(c.x, c.z);
    return s === NONE ? (agent.clan ?? 0) : s;
  }

  /** Whether sectors a and b are connected through removed walls. */
  linked(a, b) {
    if (!this.multi) return true;
    if (a === NONE || b === NONE) return false;
    return this._root[a] === this._root[b];
  }

  /** Relation value of clans a and b (−100 … 100). */
  relation(a, b) {
    if (a === b) return 100;
    return this.rel[a * this.count + b];
  }

  /** Relation state (REL.*) of clans a and b. */
  relState(a, b) {
    if (a === b) return REL.ALLIED;
    return this.state[a * this.count + b];
  }

  /** May this agent work land at column (x, z)? (reachable, and not an enemy's land unless the clan is bold) */
  resourceOk(agent, x, z) {
    if (!this.multi) return true;
    const s = this.sectorAt(x, z);
    if (s === NONE || !this.linked(this.agentSector(agent), s)) return false;
    const own = agent.clan ?? 0;
    if (s === own) return true;
    return this.relState(own, s) > REL.HOSTILE || TEMPER[this.list[own].temper].bold;
  }

  /** May this agent trade at market m? (reachable, open to its clan and not an enemy) */
  marketOpen(agent, m) {
    if (!this.multi) return true;
    const own = agent.clan ?? 0;
    const ms = this._marketSector[m];
    if (ms === undefined || !this.linked(this.agentSector(agent), ms)) return false;
    const mc = this.marketClan(m);
    if (mc === own) return true;
    return this.list[mc].trade !== 'closed' && this.relState(own, mc) >= REL.NEUTRAL;
  }

  /** Whether clan c can use market m (policy and reachability from the clan's home, not one agent's). */
  clanMarketOpen(c, m) {
    if (!this.multi) return true;
    const ms = this._marketSector[m];
    if (ms === undefined || !this.linked(c, ms)) return false;
    const mc = this.marketClan(m);
    if (mc === c) return true;
    return this.list[mc].trade !== 'closed' && this.relState(c, mc) >= REL.NEUTRAL;
  }

  /** Markets clan c can use (own first). */
  openMarkets(c) {
    const n = this.sim.worldInfo?.markets?.length ?? 0;
    const out = [];
    for (let m = 0; m < n; m++) if (this.clanMarketOpen(c, m)) out.push(m);
    return out;
  }

  /** Border tax a seller of `sellerClan` pays at market m (0 at home, between allies or when open). */
  taxRate(sellerClan, m) {
    if (!this.multi || sellerClan == null) return 0;
    const mc = this.marketClan(m);
    if (mc === sellerClan || this.list[mc].trade !== 'tax' || this.relState(sellerClan, mc) >= REL.ALLIED) return 0;
    return BORDER_TAX;
  }

  fadeMul(c) {
    return FADE_MUL[(this.list[c] || this.list[0]).fade] ?? 1;
  }

  birthMul(c) {
    return FAMILY_MUL[(this.list[c] || this.list[0]).family] ?? 1;
  }

  wealthMul(c) {
    return WEALTH_MUL[(this.list[c] || this.list[0]).wealth] ?? 1;
  }

  /** Talent profession of clan c, or null. */
  talent(c) {
    const t = (this.list[c] || this.list[0]).talent;
    return t && t !== 'none' ? t : null;
  }

  /** Name pools for new members of clan c. */
  namePool(c) {
    const cl = this.list[c] || this.list[0];
    return { first: cl.first, last: cl.last };
  }

  // ───────────────────────────────────────────────────────────────── tick

  /** Runs after population every tick: fights (multi only) and hourly relation drift. */
  tick(sim = this.sim) {
    if (!this.multi) return;
    const tick = sim.clock.tick;
    if (this.fights.length) this._resolveFights(tick);
    if (tick % PER_SEC === 0) this._checkFights(tick);
    if (sim.clock.isHourTick) this._hourly();
    if (sim.clock.isNewDayTick) {
      this.yesterday = this.today;
      this.today = this._newDay();
    }
  }

  /** Dawn: clans that share wealth pool a part of every member's light and split it equally. */
  onDawn() {
    const pop = this.sim.population;
    if (!pop) return;
    for (const cl of this.list) {
      const rate = SHARE_RATE[cl.sharing] || 0;
      if (!(rate > 0)) continue;
      let pool = 0;
      let n = 0;
      for (const a of pop.agents) {
        if ((a.clan ?? 0) !== cl.id) continue;
        n++;
        if (a.glim > 0) {
          const x = a.glim * rate;
          a.glim -= x;
          pool += x;
        }
      }
      if (n === 0 || !(pool > 0)) continue;
      const each = pool / n;
      for (const a of pop.agents) if ((a.clan ?? 0) === cl.id) a.glim += each;
    }
  }

  // ───────────────────────────────────────────────────────────────── player actions

  /**
   * Change one of a clan's laws.
   * @returns {boolean}
   */
  setPolicy(c, key, value) {
    const cl = this.list[c];
    if (!cl || !POLICY_OPTIONS[key] || !POLICY_OPTIONS[key].includes(value) || cl[key] === value) return false;
    const from = cl[key];
    cl[key] = value;
    this.setup.clans[c][key] = value;
    this._emit(EV.POLICY, { clan: c, key, from, to: value });
    this._emit(EV.PLAYER_TOOL, {
      tool: 'clans', glyph: '⚑', label: ['tool.clans.policy', { clan: c, key, value }],
      params: { clan: c, key, value },
    });
    return true;
  }

  /** Whether the player may nudge the pair now (6-hour cooldown per pair). */
  diplomacyReady(a, b) {
    return this.sim.clock.tick >= this._diploUntil[a * this.count + b];
  }

  /**
   * The player calms (+1) or stirs up (−1) two clans.
   * @returns {boolean}
   */
  diplomacy(a, b, dir) {
    if (!this.multi || a === b || !this.list[a] || !this.list[b] || !this.diplomacyReady(a, b)) return false;
    const until = this.sim.clock.tick + DIPLOMACY_COOLDOWN;
    this._diploUntil[a * this.count + b] = until;
    this._diploUntil[b * this.count + a] = until;
    this._bump(a, b, dir > 0 ? DIPLOMACY : -DIPLOMACY, true);
    this._emit(EV.PLAYER_TOOL, {
      tool: 'clans', glyph: dir > 0 ? '☮' : '⚔', label: [dir > 0 ? 'tool.clans.peace' : 'tool.clans.stir', { a, b }],
      params: { a, b, dir },
    });
    return true;
  }

  /**
   * Tear down (up=false) or build (up=true) wall `id`.
   * @returns {boolean}
   */
  setWall(id, up) {
    const w = this.walls.find((x) => x.id === id);
    if (!w || w.up === !!up) return false;
    this._setWallQuiet(w, !!up);
    this._relinks();
    if (up) this._afterRaise(w);
    this._emit(EV.WALL, { wallId: w.id, a: w.a, b: w.b, up: !!up });
    this._emit(EV.PLAYER_TOOL, {
      tool: 'clans', glyph: '▮', label: [up ? 'tool.clans.wallUp' : 'tool.clans.wallDown', { a: w.a, b: w.b }],
      pos: this._wallMid(w), params: { wallId: w.id, up: !!up },
    });
    return true;
  }

  /** Every wall up or down at once. @returns {number} walls changed */
  setAllWalls(up) {
    let n = 0;
    for (const w of this.walls) {
      if (w.up === !!up) continue;
      this._setWallQuiet(w, !!up);
      n++;
    }
    if (!n) return 0;
    this._relinks();
    if (up) for (const w of this.walls) this._afterRaise(w);
    this._emit(EV.WALL, { wallId: -1, up: !!up, count: n });
    this._emit(EV.PLAYER_TOOL, {
      tool: 'clans', glyph: '▮', label: [up ? 'tool.clans.allUp' : 'tool.clans.allDown'], params: { up: !!up },
    });
    return n;
  }

  /** Wall id whose column is (x, z), or -1. */
  wallAt(x, z) {
    const col = Math.floor(x) + this.SX * Math.floor(z);
    if (col < 0 || col >= this.cover.length) return -1;
    let hit = -1;
    for (const w of this.walls) {
      for (let i = 0; i < w.cols.length; i++) {
        if (w.cols[i] !== col) continue;
        if (w.up) return w.id;
        if (hit < 0) hit = w.id;
      }
    }
    return hit;
  }

  /** Every column any wall line covers (standing or not); production keeps them free of buildings. */
  lineColumns() {
    const out = [];
    for (const w of this.walls) for (let i = 0; i < w.cols.length; i++) out.push(w.cols[i]);
    return out;
  }

  // ───────────────────────────────────────────────────────────────── walls (internals)

  _setWallQuiet(w, up) {
    w.up = up;
    const world = this.sim.world;
    const SX = this.SX;
    for (let i = 0; i < w.cols.length; i++) {
      const col = w.cols[i];
      if (up) {
        if (this.cover[col]++ > 0) continue;
        const x = col % SX, z = (col / SX) | 0;
        if (world) this.prev.set(col, stampWallColumn(world, x, z, groundTopAt(world, x, z), false));
      } else {
        if (this.cover[col] === 0) continue;
        if (--this.cover[col] > 0) continue;
        const rec = this.prev.get(col);
        this.prev.delete(col);
        if (!rec || !world) continue;
        const x = col % SX, z = (col / SX) | 0;
        for (let y = rec.y0; y <= rec.y1; y++) {
          if (world.get(x, y, z) === B.CLAN_WALL) world.set(x, y, z, rec.prev[y - rec.y0]);
        }
      }
    }
  }

  _relinks() {
    const n = this.count;
    const root = this._root;
    for (let i = 0; i < n; i++) root[i] = i;
    const find = (i) => { while (root[i] !== i) { root[i] = root[root[i]]; i = root[i]; } return i; };
    for (const w of this.walls) {
      if (w.up) continue;
      const ra = find(w.a), rb = find(w.b);
      if (ra !== rb) root[ra] = rb;
    }
    for (let i = 0; i < n; i++) root[i] = find(i);
  }

  /** After a wall rises: free anyone inside the glass, then carry strays back to their own land. */
  _afterRaise(w) {
    const pop = this.sim.population;
    if (!pop) return;
    const SX = this.SX;
    const world = this.sim.world;
    for (let i = 0; i < w.cols.length; i++) {
      const col = w.cols[i];
      const rec = this.prev.get(col);
      const x = col % SX, z = (col / SX) | 0;
      pop.relocateInBox(x, rec ? rec.y0 : 1, z, x, rec ? rec.y1 + 1 : world.SY - 1, z);
    }
    const rng = this.sim.rng;
    for (const a of pop.agents.slice()) {
      const s = this.agentSector(a);
      const home = a.clan ?? 0;
      if (this.linked(s, home) && this.sectorAt(a.cell.x, a.cell.z) !== NONE) continue;
      const cells = this.sim.worldInfo?.spawnByClan?.[home];
      if (!cells || !cells.length) continue;
      const cell = cells[rng.int(0, cells.length - 1)];
      pop.teleport(a, cell, ['th.sentHome']);
    }
  }

  _wallMid(w) {
    if (!w.cols.length) return null;
    const col = w.cols[w.cols.length >> 1];
    const x = col % this.SX, z = (col / this.SX) | 0;
    const world = this.sim.world;
    return { x: x + 0.5, y: world ? world.surfaceY(x, z) : 20, z: z + 0.5 };
  }

  // ───────────────────────────────────────────────────────────────── relations (internals)

  _baseline(a, b) {
    return 12 * (TEMPER[this.list[a].temper].base + TEMPER[this.list[b].temper].base);
  }

  _set(a, b, v, quiet) {
    const n = this.count;
    const val = clampNum(v, -100, 100);
    this.rel[a * n + b] = val;
    this.rel[b * n + a] = val;
    const old = this.state[a * n + b];
    let s;
    if (old === REL.WAR && val < -48) s = REL.WAR;
    else if (old === REL.ALLIED && val > 48) s = REL.ALLIED;
    else s = val <= -60 ? REL.WAR : val < -20 ? REL.HOSTILE : val < 20 ? REL.NEUTRAL : val < 60 ? REL.FRIENDLY : REL.ALLIED;
    this.state[a * n + b] = s;
    this.state[b * n + a] = s;
    if (s !== old && !quiet) this._emit(EV.RELATION, { a, b, from: old, to: s, value: val });
  }

  /** Change a relation; contact effects are capped per hour (player diplomacy is not). */
  _bump(a, b, dv, uncapped) {
    if (a === b || !this.multi) return;
    const n = this.count;
    let d = dv;
    if (!uncapped) {
      const k = a < b ? a * n + b : b * n + a;
      const used = this._hourGain[k];
      if (d > 0) d = Math.min(d, Math.max(0, REL_HOUR_CAP - used));
      else d = Math.max(d, Math.min(0, -REL_HOUR_CAP - used));
      if (d === 0) return;
      this._hourGain[k] = used + d;
    }
    this._set(a, b, this.rel[a * n + b] + d, false);
  }

  _hourly() {
    const n = this.count;
    this._hourGain.fill(0);
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const v = this.rel[a * n + b];
        const k = this.linked(a, b) ? 0.01 : 0.04;
        this._set(a, b, v + (this._baseline(a, b) - v) * k, false);
      }
    }
  }

  _subscribe() {
    const bus = this.sim.events;
    if (!bus) return;
    const on = (name, fn) => this._unsubs.push(bus.on(name, fn));
    on(EV.MARKET_CHIME, (p) => this._onChime(p));
    on(EV.AGENT_HARVEST, (p) => this._onWork(p));
    on(EV.TREE_FELLED, (p) => this._onWork(p));
    on(EV.AGENT_DUG, (p) => { if (p && p.item) this._onWork(p); });
  }

  _onChime(p) {
    const trades = p && p.trades;
    if (!Array.isArray(trades) || !trades.length) return;
    const pop = this.sim.population;
    for (const tr of trades) {
      if (!tr || tr.sellerId < 0) continue;
      const b = pop.get(tr.buyerId);
      const s = pop.get(tr.sellerId);
      if (!b || !s || (b.clan ?? 0) === (s.clan ?? 0)) continue;
      this._bump(b.clan, s.clan, REL_TRADE, false);
      this.today.trades[b.clan * this.count + s.clan] += tr.qty || 0;
    }
  }

  /** Harvesting, felling or digging on another clan's land angers the owners (not between allies). */
  _onWork(p) {
    if (!p || !Number.isFinite(p.x)) return;
    const agent = this.sim.population?.get(p.agentId);
    if (!agent) return;
    const owner = this.sectorAt(p.x, p.z);
    const own = agent.clan ?? 0;
    if (owner === NONE || owner === own || this.relState(own, owner) >= REL.ALLIED) return;
    this._bump(own, owner, REL_TRESPASS * TEMPER[this.list[owner].temper].anger, false);
    this.today.trespass[owner]++;
  }

  // ───────────────────────────────────────────────────────────────── fights (internals)

  _checkFights(tick) {
    const n = this.count;
    const enemy = this._enemy;
    let any = false;
    for (let a = 0; a < n; a++) {
      enemy[a] = 0;
      for (let b = 0; b < n; b++) {
        if (a !== b && this.state[a * n + b] <= REL.HOSTILE && this.linked(a, b)) { enemy[a] = 1; any = true; }
      }
    }
    if (!any) return;
    const pop = this.sim.population;
    const rng = this.sim.rng;
    const near = this._near;
    for (const a of pop.agents) {
      const ca = a.clan ?? 0;
      if (!enemy[ca] || !a.alive || a.fightUntil > tick || a.panicUntil > tick) continue;
      pop.neighbors(a.pos.x, a.pos.z, FIGHT_RADIUS, near);
      for (let i = 0; i < near.length; i++) {
        const b = near[i];
        const cb = b.clan ?? 0;
        if (b === a || cb === ca || b.id < a.id || b.fightUntil > tick || b.panicUntil > tick) continue;
        const st = this.state[ca * n + cb];
        const base = FIGHT_CHANCE[st];
        if (!base) continue;
        if ((a.asleep || b.asleep) && st !== REL.WAR) continue;
        const p = base * 0.5 * (TEMPER[this.list[ca].temper].fight + TEMPER[this.list[cb].temper].fight);
        if (!(rng.next() < p)) continue;
        this._startFight(a, b, tick);
        break;
      }
    }
    near.length = 0;
  }

  _startFight(a, b, tick) {
    const until = tick + FIGHT_TICKS;
    a.fightUntil = until;
    b.fightUntil = until;
    a.fightWith = b.id;
    b.fightWith = a.id;
    interrupt(a, this.sim, ['th.fight', { name: b.name, clan: b.clan ?? 0 }]);
    interrupt(b, this.sim, ['th.fight', { name: a.name, clan: a.clan ?? 0 }]);
    const x = (a.pos.x + b.pos.x) / 2, y = Math.max(a.pos.y, b.pos.y), z = (a.pos.z + b.pos.z) / 2;
    this.fights.push({ a: a.id, b: b.id, until, x, y, z });
    this.today.fights[a.clan ?? 0]++;
    this.today.fights[b.clan ?? 0]++;
    this._emit(EV.FIGHT, { phase: 'start', aId: a.id, bId: b.id, x, y, z });
  }

  _strength(agent) {
    const n = agent.needs;
    const sk = agent.skills || {};
    const muscle = Math.max(sk.mason || 0, sk.delver || 0, sk.woodwarden || 0);
    const home = this.sectorAt(agent.cell.x, agent.cell.z) === (agent.clan ?? 0) ? 0.3 : 0;
    const bold = TEMPER[this.of(agent).temper].bold ? 0.3 : 0;
    return 1 + 0.4 * (n.tallow / 100) + 0.4 * (n.rest / 100) + 0.3 * muscle + home + bold;
  }

  _resolveFights(tick) {
    const pop = this.sim.population;
    const rng = this.sim.rng;
    let w = 0;
    for (let i = 0; i < this.fights.length; i++) {
      const f = this.fights[i];
      if (f.until > tick) { this.fights[w++] = f; continue; }
      const A = pop.get(f.a), Bg = pop.get(f.b);
      if (A) { A.fightWith = null; }
      if (Bg) { Bg.fightWith = null; }
      if (!A || !Bg) continue;
      const sa = this._strength(A), sb = this._strength(Bg);
      const aWins = rng.next() * (sa + sb) < sa;
      const winner = aWins ? A : Bg, loser = aWins ? Bg : A;
      const state = this.relState(A.clan ?? 0, Bg.clan ?? 0);
      // Loot: a quarter of the loser's light (a transfer) and whatever goods the winner can carry.
      const x = loser.glim > 0 ? loser.glim * LOOT_FRAC : 0;
      if (x > 0) { loser.glim -= x; winner.glim += x; }
      for (const g of GOODS) {
        const held = loser.inv[g] | 0;
        if (held <= 0) continue;
        removeItem(loser, g, held);
        addItem(winner, g, held);
      }
      const ln = loser.needs;
      ln.rest = Math.max(0, ln.rest - 25);
      ln.lustre = Math.max(0, ln.lustre - 15);
      loser.fright = Math.max(loser.fright || 0, 0.9);
      loser.panicUntil = tick + 8 * PER_SEC;
      winner.needs.lustre = Math.min(100, winner.needs.lustre + 6);
      winner.thought = ['th.wonFight', { x }];
      loser.thought = ['th.lostFight', { x }];
      const killed = state === REL.WAR && (rng.next() < WAR_DEATH || ln.tallow < 12);
      this._bump(A.clan ?? 0, Bg.clan ?? 0, REL_FIGHT + (killed ? REL_DEATH : 0), true);
      const pos = { x: f.x, y: f.y, z: f.z };
      if (killed) {
        this.today.killed[loser.clan ?? 0]++;
        pop.kill(loser, 'fight');
      }
      this._emit(EV.FIGHT, {
        phase: 'end', winnerId: winner.id, loserId: loser.id, winnerName: winner.name, loserName: loser.name,
        winnerClan: winner.clan ?? 0, loserClan: loser.clan ?? 0, stolen: x, killed, ...pos,
      });
    }
    this.fights.length = w;
  }

  _newDay() {
    const n = this.count;
    return { fights: new Int32Array(n), killed: new Int32Array(n), trespass: new Int32Array(n), trades: new Float64Array(n * n) };
  }

  _emit(name, payload) {
    const ev = this.sim.events;
    if (ev && name) ev.emit(name, payload);
  }

  // ───────────────────────────────────────────────────────────────── save / load

  serialize() {
    const walls = this.walls.map((w) => ({ id: w.id, up: w.up }));
    const prev = [];
    for (const [col, r] of this.prev) prev.push([col, r.y0, r.y1, Array.from(r.prev)]);
    const day = (d) => ({ fights: Array.from(d.fights), killed: Array.from(d.killed), trespass: Array.from(d.trespass), trades: Array.from(d.trades) });
    return {
      setup: this.setup,
      policies: this.list.map((c) => { const o = {}; for (const k of POLICY_KEYS) o[k] = c[k]; return o; }),
      walls, prev, cover: Array.from(this.cover),
      rel: Array.from(this.rel), state: Array.from(this.state), hourGain: Array.from(this._hourGain),
      diploUntil: Array.from(this._diploUntil),
      fights: this.fights.map((f) => ({ ...f })),
      today: day(this.today), yesterday: day(this.yesterday),
    };
  }

  restore(s) {
    if (!s) return;
    const n = this.count;
    if (Array.isArray(s.policies)) {
      s.policies.forEach((p, c) => {
        const cl = this.list[c];
        if (!cl || !p) return;
        for (const k of POLICY_KEYS) if (POLICY_OPTIONS[k].includes(p[k])) { cl[k] = p[k]; this.setup.clans[c][k] = p[k]; }
      });
    }
    if (Array.isArray(s.walls)) for (const r of s.walls) { const w = this.walls.find((x) => x.id === r.id); if (w) w.up = !!r.up; }
    this.prev.clear();
    if (Array.isArray(s.prev)) for (const [col, y0, y1, arr] of s.prev) this.prev.set(col, { y0, y1, prev: Uint8Array.from(arr) });
    if (Array.isArray(s.cover) && s.cover.length === this.cover.length) this.cover.set(s.cover);
    this._relinks();
    const fill = (dst, src) => { if (Array.isArray(src) && src.length === dst.length) dst.set(src); };
    fill(this.rel, s.rel);
    fill(this.state, s.state);
    fill(this._hourGain, s.hourGain);
    fill(this._diploUntil, s.diploUntil);
    this.fights = Array.isArray(s.fights) ? s.fights.map((f) => ({ ...f })) : [];
    const day = (d) => {
      const out = this._newDay();
      if (!d) return out;
      fill(out.fights, d.fights); fill(out.killed, d.killed); fill(out.trespass, d.trespass); fill(out.trades, d.trades);
      return out;
    };
    this.today = day(s.today);
    this.yesterday = day(s.yesterday);
    void n;
  }
}
