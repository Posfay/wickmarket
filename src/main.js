// Wickmarket bootstrap: picks the language, decides which world to show (URL, title screen or a
// saved game), builds the sim, attaches renderer + UI, runs the fixed-timestep loop and autosaves.
//
// URL parameters:
//   ?seed=5a1f[&setup=…]   start that world at once (setup: clans and walls, see ui/menu.js)
//   ?load=<slot>           continue a saved game
//   ?resume                continue the newest save (a page refresh lands here)
//   ?headless=1&days=30    run without graphics and print the daily invariants
//   ?lang=hu               start in Hungarian
import { CONFIG, TICKS } from './core/config.js';
import { parseSeed, randomSeed } from './core/rng.js';
import { EV } from './core/events.js';
import { createSim, simTick, createInvariantTracker } from './sim.js';
import { setLang, getLang, t, bindSim } from './core/i18n.js';
import { restoreSim } from './core/save.js';
import { normalizeSetup } from './economy/clans.js';
import { initialLang, decodeSetup, worldUrl, showTitle, Menu } from './ui/menu.js';
import * as saves from './ui/saves.js';

const params = new URLSearchParams(location.search);
const loadingEl = document.getElementById('loading');
const setProgress = p => loadingEl?.style.setProperty('--p', String(Math.max(0, Math.min(1, p))));
// Yield so the loading card can paint; the timeout keeps boot moving in a hidden tab (no rAF there).
const nextFrame = () => new Promise(r => {
  let done = false;
  const go = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(go);
  setTimeout(go, 60);
});

function setLoadingText(text) {
  const p = loadingEl?.querySelector('p');
  if (p) p.textContent = text;
}

function showLoading(on) {
  if (!loadingEl) return;
  loadingEl.hidden = !on;
  loadingEl.classList.remove('done');
  loadingEl.style.display = on ? '' : 'none';
}

function showFatal(err) {
  console.error(err);
  if (!loadingEl) return;
  showLoading(true);
  const p = loadingEl.querySelector('p') || loadingEl.appendChild(document.createElement('p'));
  p.textContent = t('boot.fatal', { msg: err?.message || String(err) });
  p.style.color = '#C0392B';
}

async function runHeadless(seed, days, setup) {
  const log = document.getElementById('headless-log');
  const out = line => { console.log(line); if (log) log.textContent += line + '\n'; };
  if (log) log.hidden = false;
  if (loadingEl) loadingEl.hidden = true;

  const sim = createSim(seed, true, setup);
  window.__sim = sim;
  const tracker = createInvariantTracker(sim);
  out(`Wickmarket headless — seed ${seed.toString(16)} — ${sim.clans.count} clan(s) — ${days} days`);
  out(tracker.header);
  const violations = [];
  const endTick = sim.clock.tick + days * TICKS.PER_DAY;
  const t0 = performance.now();

  await new Promise((resolve, reject) => {
    const batch = () => {
      try {
        for (let i = 0; i < TICKS.PER_DAY && sim.clock.tick < endTick; i++) {
          simTick(sim);
          const report = tracker.afterTick();
          if (report) {
            out(report.csv + (report.violations.length ? `   !! ${report.violations.join('; ')}` : ''));
            for (const v of report.violations) violations.push(`day ${report.day}: ${v}`);
          }
        }
        if (sim.clock.tick < endTick) setTimeout(batch, 0); else resolve();
      } catch (err) { reject(err); }
    };
    setTimeout(batch, 0);
  });

  out(`--- done in ${((performance.now() - t0) / 1000).toFixed(1)} s — ` +
    (violations.length ? `${violations.length} INVARIANT VIOLATIONS` : 'ALL INVARIANTS PASSED'));
  for (const v of violations) out('   ' + v);
}

/** Put a saved game's view back: camera, speed, selected good, chart tab and the news. */
function applyUiState(sim, ui) {
  if (!ui || typeof ui !== 'object') return;
  const r = sim.renderer;
  const cam = ui.camera;
  if (r && cam && Array.isArray(cam.pos) && Array.isArray(cam.target)) {
    r.camera.position.fromArray(cam.pos);
    r.controls.target.fromArray(cam.target);
    r.controls.update?.();
  }
  if (Number.isFinite(ui.speed) && ui.speed > 0) sim.speed = ui.speed;
  if (typeof ui.selectedGood === 'string') sim.ui.selectedGood = ui.selectedGood;
  if (typeof ui.chartTab === 'string') sim.ui.chartTab = ui.chartTab;
  if (Array.isArray(ui.ticker)) sim.ticker.restore(ui.ticker);
}

async function runBrowser(start) {
  setLoadingText(t('boot.loading'));
  showLoading(true);
  setProgress(0.02);
  await nextFrame();                                   // let the loading card paint before worldgen blocks

  const [
    { Renderer }, { AgentRenderer }, { Fx }, { Tools },
    { Hud }, { Charts }, { Inspector }, { Ticker }, { Council },
  ] = await Promise.all([
    import('./render/renderer.js'), import('./render/agentRenderer.js'), import('./render/fx.js'),
    import('./player/tools.js'), import('./ui/hud.js'), import('./ui/charts.js'),
    import('./ui/inspector.js'), import('./ui/ticker.js'), import('./ui/council.js'),
  ]);
  setProgress(0.08);
  await nextFrame();

  const loaded = start.kind === 'load';
  const sim = loaded ? restoreSim(start.save, false) : createSim(start.seed, false, start.setup);
  bindSim(sim);
  window.__sim = sim;                                  // handy for poking at the economy from devtools
  setProgress(0.2);
  await nextFrame();

  const canvas = document.getElementById('view');
  const renderer = new Renderer(canvas, sim);
  sim.renderer = renderer;
  await renderer.buildAllChunks(p => setProgress(0.2 + 0.75 * p));

  sim.agentRenderer = new AgentRenderer(renderer.scene, sim);
  sim.fx = new Fx(renderer.scene, sim);
  sim.tools = new Tools(sim, canvas);
  if (loaded && Array.isArray(start.save.toolsRng)) sim.tools.rng.setState(start.save.toolsRng);
  sim.ticker = new Ticker(sim);                        // before the HUD so early events reach the news
  sim.council = new Council(sim);
  sim.hud = new Hud(sim);
  sim.charts = new Charts(sim);
  sim.inspector = new Inspector(sim);
  const { agentRenderer, fx, tools, hud, charts, inspector, ticker, council } = sim;

  const getExtra = () => ({
    ui: {
      camera: { pos: renderer.camera.position.toArray(), target: renderer.controls.target.toArray() },
      speed: sim.speed,
      selectedGood: sim.ui.selectedGood,
      chartTab: sim.ui.chartTab,
      ticker: ticker.serialize(),
      lang: getLang(),
    },
    toolsRng: tools.rng && typeof tools.rng.getState === 'function' ? tools.rng.getState() : null,
  });
  const menu = new Menu(sim, { getExtra });
  sim.menu = menu;

  // Cross-module wiring owned by the integrator (SPEC §C.4 INTEGRATOR).
  const ev = sim.events;
  ev.on(EV.SELECT_AGENT, ({ agentId }) => {
    sim.ui.selectedAgentId = agentId ?? null;
    agentRenderer.setSelected(agentId ?? null);
    fx.setPathLine(null);
  });
  ev.on(EV.FOLLOW, ({ agentId }) => {
    sim.ui.followAgentId = agentId ?? null;
    renderer.setFollowTarget(agentId ?? null);
  });
  ev.on(EV.FLY_TO, pos => { if (pos) renderer.flyTo(pos); });
  ev.on(EV.REROLL, async ({ seed: s }) => {
    const next = typeof s === 'number' ? s >>> 0 : parseSeed(String(s)) >>> 0;
    await menu.autosave();
    location.href = worldUrl(next, sim.setup);
  });
  window.addEventListener('resize', () => renderer.resize());
  window.addEventListener('pointerdown', () => fx.resumeAudio?.(), { once: true });

  if (loaded) {
    applyUiState(sim, start.save.ui);
    ticker.post(['gz.loaded', { day: sim.clock.day + 1 }], 'world');
  } else {
    const hex = sim.seed.toString(16).toUpperCase();
    ticker.post(sim.clans.multi
      ? ['gz.welcomeClans', { seed: hex, clans: sim.clans.count, n: sim.population.count() }]
      : ['gz.welcome', { seed: hex, n: sim.population.count() }], 'world');
  }

  setProgress(1);
  if (loadingEl) {
    loadingEl.classList.add('done');
    setTimeout(() => { loadingEl.hidden = true; }, 450);
  }

  // Autosave: now (so a refresh continues this world), every two minutes, and when the page hides.
  menu.autosave().then((meta) => {
    if (meta) history.replaceState(null, '', `${location.pathname}?resume`);
  });
  setInterval(() => { if (!document.hidden) menu.autosave(); }, 120000);
  // Leaving: a synchronous snapshot (always completes) plus the normal autosave (may not finish).
  const leaving = () => {
    saves.emergencySave(sim, getExtra());
    menu.autosave();
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leaving(); });
  window.addEventListener('pagehide', leaving);

  // One misbehaving subsystem must not freeze the terrarium: log its first few errors and keep going.
  const errorCounts = new Map();
  const guard = (name, fn) => {
    try { fn(); } catch (err) {
      const n = (errorCounts.get(name) || 0) + 1;
      errorCounts.set(name, n);
      if (n <= 3) console.error(`[${name}]`, err);
    }
  };

  const STEP = 1 / TICKS.PER_SEC;
  let acc = 0;
  let last = performance.now();
  const frame = now => {
    requestAnimationFrame(frame);
    const workStart = performance.now();
    const realDt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!sim.paused) acc += realDt * sim.speed;
    sim.pathfinder.beginFrame();
    const t0 = performance.now();
    let n = 0;
    guard('sim', () => {
      while (acc >= STEP && n < CONFIG.time.maxTicksPerFrame && performance.now() - t0 < CONFIG.time.simBudgetMs) {
        acc -= STEP;
        n++;
        simTick(sim);
      }
    });
    sim.simMs = performance.now() - t0;                // read by the renderer's debug overlay
    sim.lagging = acc > 3 * STEP;
    if (sim.lagging) acc = Math.min(acc, 3 * STEP);
    const alpha = Math.min(1, acc * TICKS.PER_SEC);

    guard('renderer', () => renderer.update(realDt, sim, alpha));
    guard('agentRenderer', () => agentRenderer.update(sim, alpha, renderer.camera));
    guard('fx', () => fx.update(realDt, sim));
    guard('tools', () => tools.update(realDt));
    guard('hud', () => hud.update(realDt));
    guard('inspector', () => inspector.update(realDt));
    guard('charts', () => charts.update(realDt));
    guard('ticker', () => ticker.update(realDt));
    guard('council', () => council.update(realDt));
    guard('render', () => renderer.render());
    sim.frameWorkMs = performance.now() - workStart;   // adaptive quality judges this, not the rAF interval
  };
  requestAnimationFrame(frame);
}

/** Which world to open: the URL, the newest save (?resume), or the title screen. */
async function chooseStart() {
  await saves.absorbEmergency().catch(() => false);
  if (params.has('seed')) {
    const raw = params.get('seed');
    const seed = raw ? parseSeed(raw) >>> 0 : randomSeed() >>> 0;
    return { kind: 'new', seed, setup: decodeSetup(params.get('setup')) };
  }
  const slot = params.get('load') || (params.has('resume') ? (await saves.latestSave().catch(() => null))?.id : null);
  if (slot) {
    try {
      return { kind: 'load', save: await saves.loadSave(slot), id: slot };
    } catch (err) {
      console.warn('[boot] could not load save', slot, err);
    }
  }
  showLoading(false);
  history.replaceState(null, '', location.pathname);
  return showTitle();
}

async function boot() {
  setLang(initialLang());
  document.documentElement.lang = getLang();
  setLoadingText(t('boot.loading'));
  if (params.get('headless') === '1') {
    const raw = params.get('seed');
    const seed = raw ? parseSeed(raw) >>> 0 : randomSeed() >>> 0;
    const n = Math.max(1, Math.min(6, Number(params.get('clans')) || 1));
    const setup = params.has('setup') ? decodeSetup(params.get('setup'))
      : normalizeSetup({ clans: Array.from({ length: n }, () => ({})), walls: params.get('walls') === 'down' ? 'down' : 'up' });
    await runHeadless(seed, Math.max(1, Number(params.get('days')) || 30), setup);
    return;
  }
  const start = await chooseStart();
  await runBrowser(start);
}

boot().catch(showFatal);
