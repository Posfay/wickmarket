# SPEC ADDENDUM v1.1 — binding clarifications (read AFTER SPEC.md; this file wins on conflict)

These close gaps between modules that are implemented in parallel. Treat every item as part of the contract.

## 1. Integrator files, Node headless
- `src/sim.js` (INTEGRATOR) exports `createSim(seed, headless)` and `simTick(sim)` exactly as written in SPEC §C.4 "INTEGRATOR". `src/main.js` imports them. Nobody else imports `main.js` or `sim.js`.
- `package.json` at the root contains `{"type":"module"}`. **Every sim-side module (G1, G3, G4) must import cleanly and run under Node 24** (no `window`, `document`, `performance` is OK (global in Node), no `three`, no DOM, no `requestAnimationFrame`). `scripts/headless.mjs` (INTEGRATOR) runs the sim in Node for N days.
- Never use top-level `await` in sim-side modules.

## 2. Ownership and config keys
- Only edit/create the files your group owns. If you need a config value that is not in the SPEC Appendix, read it as `CONFIG.section?.key ?? <default>` and mark `// SPEC-GAP: new config key section.key`. G1 writes the Appendix CONFIG verbatim and MAY add keys, never rename or remove.
- Import paths are relative with the `.js` extension, e.g. `import { CONFIG } from '../core/config.js'`.

## 3. Private per-agent state
Each module that needs scratch state on an Agent stores it under ONE private key, created lazily:
| module | key |
|---|---|
| agent.js | `agent._mv` (movement/dig timers, fall state, accumulated demurrage batch) |
| brain.js | `agent._br` (step timers, repath counters, rebid counts, waiting flags, last decide tick) |
| population.js | `agent._pop` |
| market.js | `agent._mk` |
| production.js | `agent._pr` |
Nobody else reads another module's private key. All public fields listed in SPEC §C.2 are created by `createAgent` with sane defaults (numbers 0, objects `{}`, arrays `[]`, nullable → `null`, `marketBlockedUntil: [0,0]`, `blacklist: new Map()`, `netHistory: []`, `lanterns: []`, `childrenIds: []`, `inv` with every ITEMS key set to 0, `beliefs`/`costBasis` with every GOODS key).

## 4. Paths (pathfinding.js ⇄ agent.js ⇄ brain.js)
- `poll()` → `{ok:true, path, cost}`: `path` is an array of PathNode **excluding the start cell**; `path.length === 0` means the start already satisfies the goal.
- Brain, on success: `agent.path = path; agent.pathI = 0; agent.pathBlocked = false;` and clears `agent.pathTicket`.
- `stepAgent` follows `agent.path[agent.pathI]` when `agent.path` is non-null and `agent.pathI < agent.path.length`. On arriving at a node it snaps `pos` to the node (x+0.5, y, z+0.5), sets `cell`, bumps footfall, `pathI++`. It never sets `agent.path = null` itself.
- Arrival test (brain): `agent.path && agent.pathI >= agent.path.length`. Brain then sets `agent.path = null`.
- `stepAgent` sets `agent.pathBlocked = true` (and stops moving) when the next node is no longer enterable. Brain re-requests and resets it to false.
- Brain clears a path by `agent.path = null; agent.pathI = 0`.
- Dig bits are executed by `stepAgent` via `digBlock` before entering the node (feet bit 1 = node cell, head bit 2 = node y+1, bit 4 = the extra-clearance cell described in SPEC §C.2). A cell that is already passable when reached is simply skipped.

## 5. Animation ownership
- `agent.js stepAgent` sets `anim` to `walk` while moving along a path, `dig` while digging a path cell, `fall` while falling; it never sets anim otherwise.
- Brain sets `anim` for every step that is not movement (harvest, build, craft, sleep, tend, trade, eat, idle, panic…) each tick while that step runs.
- Whoever changes `anim` to a different value resets `animT = 0`; `stepAgent` increments `animT` by `1/TICKS.PER_SEC` every tick.

## 6. Ticks and timing helpers
- 1 tick = 0.1 sim-seconds. Durations in CONFIG given in "sec" are sim-seconds (`sec * TICKS.PER_SEC` ticks).
- Staggering "every N ticks" work uses `(clock.tick + agent.id) % N === 0`.

## 7. Colour space (Three.js r170)
- Renderer: `renderer.outputColorSpace = THREE.SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`, `toneMappingExposure ≈ 1.0` (tune).
- `chunkMesher.js` has no three import; it outputs **linear-space** vertex colours: convert each hex sRGB channel with `c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4`. Precompute a per-block linear colour table once.
- `THREE.Color.set('#hex')` already converts to linear — use it for InstancedMesh colours/uniforms.
- In r170 the Lambert fragment shader ends with `#include <opaque_fragment>` (not `output_fragment`). Inject glow/emissive terms by string-replacing `#include <opaque_fragment>` with your code followed by the original include, and modify `outgoingLight` there. Use `#include <worldpos_vertex>` / a custom `varying vec3 vWorldPos` for world XZ.

## 8. UI wiring clarifications
- HUD owns global keys (Space, [, ], G, H, M, C, F); renderer owns `P` and WASD/QE; tools own 0-9 and Esc. All ignore keydown when `document.activeElement` is an input/textarea/select.
- `C` (hud): toggles `sim.ui.cutaway` between `null` and `Math.round(sim.renderer.controls.target.y)`, then calls `sim.renderer.setCutaway(sim.ui.cutaway)`.
- `H` (hud): toggles `sim.ui.hideUI` and the class `ui-hidden` on `#ui-root` (ui.css hides children except `#topbar`'s unhide button — keep it simple: everything hidden, `H` again shows).
- `F` (hud): emits `FOLLOW {agentId: sim.ui.followAgentId ? null : sim.ui.selectedAgentId}`.
- Speed: HUD sets `sim.speed` and `sim.paused` and emits `SPEED`.
- `index.html` (G2) links Google Fonts: `https://fonts.googleapis.com/css2?family=IM+Fell+English+SC&family=JetBrains+Mono:wght@400;600&display=swap`, with fallbacks `Georgia, serif` / `ui-monospace, Consolas, monospace`.
- The inspector listens to `SELECT_AGENT` and `SELECT_MARKET` itself; `main.js` also handles SELECT_AGENT per SPEC.
- Main wires `FOLLOW`, `FLY_TO`, `REROLL`, `resize` (see SPEC). Everything else is self-subscribed by the module.

## 9. Robustness rules (all groups)
- A module must never throw in its per-frame/per-tick path because another module returned `null`/`undefined` or an agent died mid-task. Guard with `if (!x) return` style checks; dead agents have `alive === false` and are no longer in `population.agents`.
- No per-tick allocations in hot loops where avoidable (reuse arrays/typed arrays/vectors).
- Deterministic sim: sim-side modules use `sim.rng` only (never `Math.random`).
- No `console.log` spam in hot paths. `console.warn` for audit drift only.
- Complete implementations only: no `TODO`, no stubbed methods. If something in SPEC is truly impossible, implement the closest simple behaviour and mark `// SPEC-GAP:`.
