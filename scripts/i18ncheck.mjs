#!/usr/bin/env node
// Language check:  node scripts/i18ncheck.mjs
//  1. English and Hungarian have exactly the same keys.
//  2. Every key the code names literally (t('…'), ['…', {…}] messages) exists.
//  3. The dynamic key families (goods, jobs, laws, tools…) are complete.
//  4. Every entry renders in both languages with sample parameters (no exceptions, no raw keys).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EN } from '../src/core/lang/en.js';
import { HU } from '../src/core/lang/hu.js';
import { setLang, t } from '../src/core/i18n.js';
import { GOODS, PROFESSIONS } from '../src/core/config.js';
import { POLICY_OPTIONS, FIXED_OPTIONS, CLAN_DEFS, REL_KEYS } from '../src/economy/clans.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let problems = 0;
const bad = (msg) => { problems++; console.log('  ' + msg); };

// 1. Same keys.
console.log('keys: en', Object.keys(EN).length, 'hu', Object.keys(HU).length);
for (const k of Object.keys(EN)) if (!(k in HU) && !k.endsWith('.acc')) bad(`missing in hu: ${k}`);
for (const k of Object.keys(HU)) if (!(k in EN) && !k.endsWith('.acc')) bad(`only in hu: ${k}`);

// 2. Literal keys in the code.
const files = [];
const walk = (dir) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (f.name !== 'lang') walk(p); } else if (/\.m?js$/.test(f.name)) files.push(p);
  }
};
walk(path.join(root, 'src'));
const used = new Set();
const PREFIX = /^(good|goodInfo|prof|job|profInfo|goal|step|why|task|th|reason|stab|gz|place|market|clan|clanInfo|rel|relName|law|trait|tool|hint|float|pop|seal|whisper|wall|hud|help|ins|need|ch|menu|title|setup|council|boot|fx)\./;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
  for (const m of src.matchAll(/\[\s*'([A-Za-z0-9_.]+)'\s*[,\]]/g)) if (PREFIX.test(m[1])) used.add(m[1]);
  for (const m of src.matchAll(/label:\s*\[\s*'([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
}
for (const k of used) if (!(k in EN)) bad(`used in code but not in en: ${k}`);
console.log('literal keys used in code:', used.size);

// 3. Dynamic families.
const need = [];
for (const g of GOODS) need.push(`good.${g}`, `good.${g}.one`, `good.${g}.many`, `goodInfo.${g}`);
need.push('good.lens', 'good.lens.one', 'good.lens.many');
for (const p of PROFESSIONS) need.push(`prof.${p}`, `prof.${p}.one`, `prof.${p}.many`, `job.${p}`, `profInfo.${p}`);
for (const [k, list] of Object.entries(POLICY_OPTIONS)) { need.push(`law.${k}`, `law.${k}.info`); for (const v of list) need.push(`law.${k}.${v}`); }
for (const [k, list] of Object.entries(FIXED_OPTIONS)) {
  need.push(`trait.${k}`, `trait.${k}.info`);
  for (const v of list) if (k !== 'talent' || v === 'none') need.push(`trait.${k}.${v}`);
}
for (const d of CLAN_DEFS) need.push(`clan.${d.key}`, `clanInfo.${d.key}`);
for (const r of REL_KEYS) need.push(`rel.${r}`, `relName.${r}`);
for (const id of ['inspect', 'cupped', 'geode', 'pane', 'seal', 'whisper', 'tap', 'magnifier', 'pipette', 'trowel']) need.push(`tool.${id}.name`, `tool.${id}.blurb`);
need.push('tool.clans.name');
for (const g of ['sleep', 'food', 'forage', 'work', 'lantern', 'speculate', 'dump', 'sell', 'idle', 'fight']) need.push(`goal.${g}`);
for (const s of ['forage', 'immigrationFloor', 'wildSapling', 'bogAccretion', 'priceClamp', 'mossSpread', 'hazeFloor']) need.push(`stab.${s}`, `gz.stab.${s}`, `ch.stab.${s}`);
for (const n of ['tallow', 'rest', 'lustre']) need.push(`need.${n}`, `need.${n}.info`);
for (const tab of ['prices', 'labor', 'light', 'lives', 'wealth', 'clans']) need.push(`ch.tab.${tab}`, `ch.tab.${tab}.tip`);
for (const c of ['pop', 'money', 'gini', 'rel']) need.push(`ch.clan.${c}`, `ch.clan.${c}.tip`);
for (const w of ['1d', '5d', 'all']) need.push(`ch.win.${w}`, `ch.win.${w}.tip`);
for (const k of ['space', 'speed', 'tools', 'charts', 'hide', 'mute', 'cut', 'follow', 'clans', 'save', 'debug', 'pan', 'orbit', 'help']) need.push(`help.key.${k}`);
for (const k of ['left', 'starved', 'fight', 'aged', 'gone']) need.push(`ins.epitaph.${k}`);
for (const k of ['tend', 'tower', 'build', 'waiting']) need.push(`ins.work.${k}`);
for (const k of need) if (!(k in EN)) bad(`family key missing in en: ${k}`);

// 4. Render everything with sample parameters.
const sample = {
  n: 3, x: 2.5, y: 1.2, a: 0, b: 1, m: 0, m2: 1, from: 0, to: 1, clan: 0, c: 0, wc: 0, lc: 1, good: 'berry', heard: 'amber',
  prof: 'tender', price: 4.25, limit: 5, P: 3, mul: 1.5, pct: 34, hours: 12, up: true, kind: 'floor', day: 4, d: 2,
  time: '08:00', seed: '5A1F', pop: 60, clans: 2, name: 'Tallowby Fenn', owner: 'Ember Wax', by: 'Moth Pine',
  place: ['place.pond'], where: ['place.ridge'], cause: ['gz.causeTool', { tool: 'geode' }], why: ['gz.whyTimes', { to: 'delver', x: 1.5 }],
  reason: ['reason.pays', { to: 'delver', x: 12, from: 'tender', y: 6 }], task: ['task.harvest'], label: ['tool.tap.name'], last: ['stab.forageOne'],
  f: 12, e: 8, h: 30, money: 4, q: 3, s: 2, l: 4, p: 1, out: 2, id: 3, rate: 1.5, pa: 2, pb: 3, profit: 4, exp: 2.5, total: 20, placed: 5,
  amount: 12.5, value: 'fast', key: 'fade', rel: 'friendly', trade: 'tax', list: 'Honey, Frost', bids: 2, lots: 5, bid: 3.2, ask: 4.1, belief: 2.2,
  heardUp: false, deep: true, across: false, gen: 1, age: 3.2, life: 14, home: true, cap: 6, eta: 0.4, bound: 'floor', stolen: 12, killed: true,
  winner: 'A', loser: 'B', born: 2, aged: 1, starved: 1, left: 1, arrived: 2, thin: true, today: 1, g: '0.35', w: 1, ref: 7, dir: 1, msg: 'x',
  tool: 'geode', glyph: '◆', when: 'day 3', i: 1, units: 5, names: 'Hill / Pond', seed2: 1, mine: 2, list2: [], ago: '2 min ago', slot: 'auto',
  max: 2, market: 'Pond market', state: 'war',
};
for (const lang of ['en', 'hu']) {
  setLang(lang);
  for (const k of Object.keys(EN)) {
    let out;
    const err = console.error;
    console.error = () => {};
    try { out = t(k, { ...sample }); } finally { console.error = err; }
    if (out === k) bad(`${lang}: ${k} did not render`);
    else if (/undefined|NaN|\{[a-z]+\}/.test(out)) bad(`${lang}: ${k} → ${out}`);
  }
}
setLang('en');
console.log(problems ? `${problems} PROBLEMS` : 'ALL OK');
process.exit(problems ? 1 : 0);
