// Wickmarket i18n: every player-facing text lives in src/core/lang/*.js and is looked up here.
// Pure JS (no DOM), so sim-side modules may import it and it runs under Node.
//
// The sim never stores finished sentences. It stores messages as `[key, params]` arrays
// (e.g. agent.thought = ['th.food', {good: 'berry', price: 2.1, m: 0}]); the UI turns them into
// text with `tr()` at display time. Saves therefore stay language-neutral and switching the
// language re-renders everything at once.
//
// Dictionary entries are plain strings with {name} placeholders, or functions (params, helpers)
// for sentences that need grammar (plurals, names of goods, markets and clans).
import { EN } from './lang/en.js';
import { HU } from './lang/hu.js';

export const LANGS = Object.freeze([
  Object.freeze({ id: 'en', short: 'EN', name: 'English' }),
  Object.freeze({ id: 'hu', short: 'HU', name: 'Magyar' }),
]);

const DICTS = { en: EN, hu: HU };
const EMPTY = Object.freeze({});
const listeners = new Set();
let lang = 'en';
let boundSim = null;

/** @returns {'en'|'hu'} the current language id */
export function getLang() {
  return lang;
}

/**
 * Switch the language. Listeners (UI modules) re-render their text.
 * @param {string} id
 * @returns {boolean} whether the language changed
 */
export function setLang(id) {
  if (!DICTS[id] || id === lang) return false;
  lang = id;
  for (const fn of [...listeners]) {
    try { fn(id); } catch (err) { console.error('[i18n] language listener failed', err); }
  }
  return true;
}

/** @returns {() => void} unsubscribe */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The running sim: market and clan names depend on the world. */
export function bindSim(sim) {
  boundSim = sim || null;
}

// ---------------------------------------------------------------- numbers

const MINUS = '−';

function decimal(s) {
  return lang === 'hu' ? s.replace('.', ',') : s;
}

/** Fixed decimals in the current language ("7.5" / "7,5"). */
export function fmtNum(v, digits = 1) {
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(digits);
  return (v < 0 && Number(s) !== 0 ? MINUS : '') + decimal(s);
}

/** Price with about three significant digits: 0.42, 7.10, 11.4, 148. */
export function fmtPrice(p) {
  if (!Number.isFinite(p)) return '—';
  const a = Math.abs(p);
  return decimal(a >= 100 ? p.toFixed(0) : a >= 10 ? p.toFixed(1) : p.toFixed(2));
}

/** Rounded integer with thousands separators ("1,250" / "1 250"). */
export function fmtInt(v) {
  if (!Number.isFinite(v)) return '—';
  const s = String(Math.round(Math.abs(v)));
  const sep = lang === 'hu' ? ' ' : ',';
  const out = s.length > 4 || (lang === 'en' && s.length > 3) ? s.replace(/\B(?=(\d{3})+(?!\d))/g, sep) : s;
  return (v < 0 && Math.round(v) !== 0 ? MINUS : '') + out;
}

/** Signed amount: "+3.2", "−0.5", "0". */
export function fmtSigned(v, digits = 1) {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) < 0.5 * Math.pow(10, -digits)) return '0';
  return (v > 0 ? '+' : MINUS) + fmtNum(Math.abs(v), digits);
}

function fmtAuto(v) {
  return Number.isInteger(v) ? fmtInt(v) : fmtNum(v, 1);
}

// ---------------------------------------------------------------- names

const HU_VOWELS = 'aáeéiíoóöőuúüűAÁEÉIÍOÓÖŐUÚÜŰ';

function lower(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : '';
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** Label of a good ("Berries"). */
export function goodName(g) {
  return t(`good.${g}`);
}

/** Good as a counted word: 1 → "berry", else "berries" (Hungarian nouns stay singular after numbers). */
export function goodWord(g, n) {
  return t(n === 1 ? `good.${g}.one` : `good.${g}.many`);
}

/** Label of a profession ("Farmer"). */
export function profName(p) {
  return t(`prof.${p}`);
}

/** Profession as a counted word: 1 → "farmer", else "farmers". */
export function profWord(p, n) {
  return t(n === 1 ? `prof.${p}.one` : `prof.${p}.many`);
}

/** Display name of clan `c` (a custom name wins over the default). */
export function clanName(c) {
  const cl = boundSim?.clans?.list?.[c];
  if (cl && typeof cl.name === 'string' && cl.name.trim()) return cl.name.trim();
  return t(`clan.${cl?.key ?? `c${c}`}`);
}

function marketInfo(m) {
  return boundSim?.worldInfo?.markets?.[m] ?? boundSim?.market?.markets?.[m] ?? null;
}

/** Display name of market `m` ("Hill market", "Frost market"). */
export function marketName(m) {
  const mk = marketInfo(m);
  if (!mk) return t('market.unknown', { n: (m | 0) + 1 });
  if (mk.clan != null && (boundSim?.clans?.count ?? 1) > 1) return t('market.ofClan', { clan: clanName(mk.clan) });
  const key = `market.${mk.key}`;
  const v = t(key);
  return v === key ? t('market.unknown', { n: (m | 0) + 1 }) : v;
}

/** Short column label of market `m` ("Hill", "Frost"). */
export function marketShort(m) {
  const mk = marketInfo(m);
  if (!mk) return String((m | 0) + 1);
  if (mk.clan != null && (boundSim?.clans?.count ?? 1) > 1) return clanName(mk.clan);
  const key = `market.short.${mk.key}`;
  const v = t(key);
  return v === key ? String((m | 0) + 1) : v;
}

/** Helpers handed to function-valued dictionary entries. */
const H = Object.freeze({
  t: (k, p) => t(k, p),
  tr: (m) => tr(m),
  num: fmtNum,
  price: fmtPrice,
  int: fmtInt,
  signed: fmtSigned,
  good: goodName,
  goods: goodWord,
  ngoods: (n, g) => `${fmtInt(n)} ${goodWord(g, n)}`,
  prof: profName,
  profs: profWord,
  market: marketName,
  clan: clanName,
  plural: (n, one, many) => (n === 1 ? one : many),
  /** Hungarian definite article for the following word: "az" before a vowel, else "a". */
  az: (w) => (w && HU_VOWELS.includes(String(w).charAt(0)) ? 'az' : 'a'),
  lower,
  cap,
});

// ---------------------------------------------------------------- lookup

/**
 * Translate `key` with `params` in the current language (English fallback, then the key itself).
 * @param {string} key
 * @param {object} [p]
 * @returns {string}
 */
export function t(key, p) {
  let v = DICTS[lang][key];
  if (v === undefined && lang !== 'en') v = EN[key];
  if (v === undefined) return key;
  if (typeof v === 'function') {
    try {
      return String(v(p || EMPTY, H));
    } catch (err) {
      console.error(`[i18n] entry "${key}" failed`, err);
      return key;
    }
  }
  if (p && v.indexOf('{') >= 0) {
    return v.replace(/\{(\w+)\}/g, (m, k) => {
      const x = p[k];
      if (x === undefined || x === null) return m;
      if (typeof x === 'number') return fmtAuto(x);
      if (Array.isArray(x)) return tr(x);
      return String(x);
    });
  }
  return v;
}

/**
 * Render a stored message: a plain string, a `[key, params]` array or a `{k, p}` object.
 * @param {*} m
 * @returns {string}
 */
export function tr(m) {
  if (m == null || m === '') return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return typeof m[0] === 'string' ? t(m[0], m[1]) : '';
  if (typeof m === 'object' && typeof m.k === 'string') return t(m.k, m.p);
  return String(m);
}

/** True when `key` exists in the English dictionary (used by checks and fallbacks). */
export function hasKey(key) {
  return EN[key] !== undefined;
}

/** Every key of a language's dictionary (for the completeness check). */
export function dictKeys(id) {
  return Object.keys(DICTS[id] || {});
}
