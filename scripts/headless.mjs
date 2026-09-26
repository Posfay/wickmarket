// Headless runner: simulates N days per seed in Node and checks the SPEC §G invariants.
// Usage: node scripts/headless.mjs [--days 30] [--seeds 5a1f,1,2,3] [--quiet]
//          [--clans 3] [--walls up|down] [--tear 4] [--temper normal|peaceful|warlike]
//   --clans  number of clans (1 = the classic jar)       --walls  walls between clans at the start
//   --tear   tear every wall down at the dawn of this day --temper every clan's temper
import { TICKS } from '../src/core/config.js';
import { parseSeed } from '../src/core/rng.js';
import { createSim, simTick, createInvariantTracker } from '../src/sim.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const days = Number(opt('days', 30));
const seeds = String(opt('seeds', '5a1f')).split(',').map(s => s.trim()).filter(Boolean);
const quiet = args.includes('--quiet');
const clanCount = Math.max(1, Math.min(6, Number(opt('clans', 1)) || 1));
const walls = opt('walls', 'up') === 'down' ? 'down' : 'up';
const tearDay = Number(opt('tear', -1));
const temper = opt('temper', 'normal');
const setup = clanCount > 1
  ? { walls, clans: Array.from({ length: clanCount }, () => ({ temper })) }
  : null;

let failed = 0;
for (const seedStr of seeds) {
  const seed = parseSeed(seedStr);
  const t0 = performance.now();
  const sim = createSim(seed, true, setup);
  const tBuilt = performance.now();
  const tracker = createInvariantTracker(sim);
  const allViolations = [];
  const clanInfo = clanCount > 1 ? ` · ${clanCount} clans, walls ${walls}${tearDay >= 0 ? `, torn down on day ${tearDay}` : ''}` : '';
  console.log(`\n=== seed ${seedStr} (${seed >>> 0}) — built in ${(tBuilt - t0).toFixed(0)} ms, ${sim.population.count()} agents${clanInfo} ===`);
  if (!quiet) console.log(tracker.header);

  const endTick = sim.clock.tick + days * TICKS.PER_DAY;
  let report;
  try {
    while (sim.clock.tick < endTick) {
      simTick(sim);
      if (tearDay >= 0 && sim.clock.isDawnTick && sim.clock.day === tearDay) sim.clans.setAllWalls(false);
      if ((report = tracker.afterTick())) {
        if (!quiet) console.log(report.csv + (report.violations.length ? `   !! ${report.violations.join('; ')}` : ''));
        for (const v of report.violations) allViolations.push(`day ${report.day}: ${v}`);
      }
    }
  } catch (err) {
    console.error(`CRASH at tick ${sim.clock.tick} (day ${sim.clock.day}):`, err);
    failed++;
    continue;
  }
  const secs = (performance.now() - tBuilt) / 1000;
  const ticks = days * TICKS.PER_DAY;
  console.log(`--- ${days} days in ${secs.toFixed(1)} s (${((secs * 1000) / ticks).toFixed(3)} ms/tick) — ` +
    (allViolations.length ? `${allViolations.length} invariant violations` : 'all invariants passed'));
  if (allViolations.length) {
    failed++;
    for (const v of allViolations.slice(0, 25)) console.log('   ' + v);
    if (allViolations.length > 25) console.log(`   … ${allViolations.length - 25} more`);
  }
}
process.exitCode = failed ? 1 : 0;
