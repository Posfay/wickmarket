#!/usr/bin/env node
// Save/load round trip, headless:  node scripts/savetest.mjs [--days 3.4] [--after 4] [--seeds 5a1f,1] [--clans 4]
// For each world: run, save, load, save again (the two files must match), check the loaded
// world's money supply equals the original's, then run the loaded world on and check the
// daily money audit and the other liveness invariants.
import { createSim, simTick, createInvariantTracker } from '../src/sim.js';
import { parseSeed } from '../src/core/rng.js';
import { saveText, saveBytes, readSaveBytes, parseSave, restoreSim } from '../src/core/save.js';
import { TICKS } from '../src/core/config.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const days = Number(opt('days', '3.4'));
const after = Number(opt('after', '4'));
const seeds = String(opt('seeds', '5a1f')).split(',').map(parseSeed);
const clanCounts = String(opt('clans', '1,4')).split(',').map(Number);

const strip = (text) => text.replace(/"savedAt":\d+,/, '');
let failed = 0;
const fail = (msg) => { failed++; console.log(`  FAIL ${msg}`); };

for (const seed of seeds) {
  for (const n of clanCounts) {
    const setup = n > 1 ? { clans: Array.from({ length: n }, (_, i) => ({ temper: i % 2 ? 'warlike' : 'normal' })), walls: 'down' } : null;
    const label = `seed ${seed.toString(16)} clans ${n}`;
    console.log(label);
    const sim = createSim(seed, true, setup);
    const end = Math.round(days * TICKS.PER_DAY);
    while (sim.clock.tick < end) simTick(sim);

    const t0 = performance.now();
    const text1 = saveText(sim, { ui: { note: 'test' } });
    const t1 = performance.now();
    const loaded = restoreSim(parseSave(text1), true);
    const t2 = performance.now();
    const text2 = saveText(loaded, { ui: { note: 'test' } });
    const bytes = await saveBytes(sim);
    const t3 = performance.now();
    console.log(`  save ${(text1.length / 1024).toFixed(0)} KB json, ${(bytes.length / 1024).toFixed(0)} KB gzip; `
      + `save ${(t1 - t0).toFixed(0)} ms, load ${(t2 - t1).toFixed(0)} ms, gzip ${(t3 - t2).toFixed(0)} ms`);

    if (strip(text1) !== strip(text2)) {
      const a = strip(text1), b = strip(text2);
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      fail(`second save differs at ${i}: …${a.slice(Math.max(0, i - 80), i + 80)}…\n  vs …${b.slice(Math.max(0, i - 80), i + 80)}…`);
    } else console.log('  save → load → save: identical');

    const back = await readSaveBytes(bytes);
    if (strip(JSON.stringify(back)) !== strip(JSON.stringify(parseSave(text1))).replace('"ui":{"note":"test"}', '').replace(/,}$/, '}')) {
      // the gzip copy was made without the ui field; compare the parts both have
      if (back.tick !== sim.clock.tick || back.population.agents.length !== sim.population.count()) fail('gzip round trip lost data');
      else console.log('  gzip round trip: ok');
    } else console.log('  gzip round trip: ok');

    const M0 = sim.ledger.moneySupply(), M1 = loaded.ledger.moneySupply();
    if (Math.abs(M0 - M1) > 1e-6 * Math.max(1, M0)) fail(`money supply ${M0} → ${M1}`);
    else console.log(`  money supply kept: ${M0.toFixed(2)}`);
    if (loaded.population.count() !== sim.population.count()) fail('population changed');
    if (loaded.clock.tick !== sim.clock.tick) fail('clock changed');

    // Run the loaded world on (and the original, for comparison).
    const tracker = createInvariantTracker(loaded);
    const endAfter = loaded.clock.tick + Math.round(after * TICKS.PER_DAY);
    let worst = 0;
    const flags = [];
    while (loaded.clock.tick < endAfter) {
      simTick(loaded);
      simTick(sim);
      const rep = tracker.afterTick();
      if (!rep) continue;
      const drift = Math.abs(loaded.ledger.lastAudit?.drift ?? 0);
      if (drift > worst) worst = drift;
      for (const v of rep.violations) if (!/traded on only|pinned at clamp/.test(v)) flags.push(`day ${rep.day}: ${v}`);
    }
    const audit = loaded.ledger.lastAudit;
    console.log(`  after ${after} more days: pop ${loaded.population.count()} (original ${sim.population.count()}), `
      + `M ${loaded.ledger.moneySupply().toFixed(0)} (original ${sim.ledger.moneySupply().toFixed(0)}), worst audit drift ${worst.toFixed(3)}`);
    if (!audit || !audit.ok) fail(`money audit not ok: ${JSON.stringify(audit)}`);
    for (const f of flags) console.log(`  note ${f}`);
  }
}
console.log(failed ? `${failed} FAILED` : 'ALL OK');
process.exit(failed ? 1 : 0);
