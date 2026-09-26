# WICKMARKET: A Candlelight Economy Under Glass
### Build Specification v1.0, the implementation contract for "Agentic Voxel Economy"

**How to use this document.** Six ownership groups (G1 to G6) implement their files in parallel, and the integrator writes `src/main.js` afterwards. §B and §C are a **binding contract**. That covers every export name, signature, field name, event name and unit. You may add private helpers freely. You may not rename, drop or re-shape anything listed here. If you hit a gap, choose the simplest behaviour that is consistent with this spec and mark it `// SPEC-GAP: ...`.

All tunable numbers live in `CONFIG` (see the Appendix). Code reads them from there and never hard-codes them. A reference like `CONFIG.money.mintPerHour` means that exact key.

**Run:** `node serve.mjs`, then open `http://localhost:5173/?seed=5a1f`. The zero-dependency server already exists in the project root. ES modules need http, so `file://` will not work.
**URL flags:**
- `?seed=<hex>` sets the world seed.
- `?headless=1&days=30` runs the sim only, with no renderer or UI. It prints one CSV line per day and checks the invariants in §G.

---

## A. Concept summary

**Fiction.** The world is "Specimen No. {SEED}": a Victorian bell jar on a forgotten naturalist's walnut desk, in a dim study. Inside the jar is a basalt-bowl island (a circle of r = 54 voxels) with these regions:
- the quartz-veined **Sunward Ridge** to the east (+X), which faces the window
- a **Dew Pond** and peat bog to the west (−X)
- resinpine groves, waxberry flats and moss everywhere

**Agents: Wicklings.** Wicklings are thumb-high beeswax folk whose head is a lit wick. There are 60 at the start, at least 30 and at most 110.

**Money is light (glim).**
- **The flame is the purse.** A Wickling's flame is its wallet. Flame radius and colour grow with wealth, so rich and poor are obvious at a glance. After dark, the island is lit only by its money.
- **Minting.** Glim is minted only by **lens towers** on the ridge, and only while a Lenswright tends one in sunlight.
- **Burning.** Glim burns away continuously as demurrage: 2%/day, or 4%/day for the unhoused because drafts steal light. A 2% fee is also burned on every trade.
- **Haze.** The more glim that exists, the thicker the golden haze in the jar and the weaker the lenses. The haze is visible as fog.

**Needs:**
- **Tallow** is body wax. Wicklings restore it by eating waxberries or wax tablets. Hungry Wicklings look visibly stubby.
- **Rest** comes from sleep, which is better in a cottage.
- **Lustre** is esteem, which comes from having a cottage and amber lanterns.

**Resources and goods.** There are 8 traded goods: `berry`, `tablet`, `peat`, `log`, `stone`, `quartz`, `amber` and `lantern`. The lens is an untraded item. Capital comes in two forms: lens towers and cottages. Both are built block by block by Masons, on commission.

**Markets.** There are two plazas:
- **Sunward**, in the east near the quarries
- **Dewside**, in the west near the farms

**The Chime.** Every in-game hour, each plaza runs a **uniform-price call auction** for each good. Every cleared trade fires an **arc of light from the buyer's flame to the seller's flame**. Unsold goods stack up physically on pads around the plaza.

**How agents adapt:**
- They switch professions based on a Guild Board of observed incomes.
- They reroute, and they tunnel, including smuggler tunnels under the player's glass.
- They build cottages and towers.
- They hoard when panicked and chase rumours.

**Player.** The player is the naturalist at the desk and has nine desk tools: Cupped Hand, Geode, Glass Pane, Wax Seal, Whisper, Tap the Glass, Magnifier, Dew Pipette and Trowel.

**Signature moment: the Dusk Chime.** At 18:00 the window-sun sets. The glass flushes amber and then indigo, and seventy flames bloom. A bell rings, and every trade that clears fires at once as arcs of light across the pond. The lenswrights' ridge blazes white-gold while the bog huts sputter orange. Then the player cups a hand over tomorrow's sun and watches the arcs thin.

### Palette (exact)
| Token | Hex | Use |
|---|---|---|
| desk / brass | #2A1C14 / #B08D57 | desk, plinth / plinth rim, lens mounts, UI accent lines |
| glassRim / glassTint | #CFE8EC / #9CC8C0 (8%) | bell-jar fresnel rim / body tint |
| dayKey / sky / bounce | #FFE2B0 / #A8CFE0 / #4A3526 | sun light / hemisphere sky / hemisphere ground |
| dusk | #F2A65A | glass flush and key light at dusk |
| nightAmbient / moon | #141A30 / #5B6FA8 | night ambient / moonlight (intensity 0.12) |
| wax / wick | #F3E3C3 / #2B2320 | Wickling body / wick |
| flame poor → mid → rich | #FF7A2E → #FFC247 → #FFF4D6 | flame ramp by wealth |
| rumour | #B388FF | rumour-believer flame tint |
| glut → balanced → scarce | #5AA7D6 → #EDE3C8 → #E0483A | scarcity scale (P / ref) |
| parchment / ink / accent | #EFE6D2 / #1B1712 / #C9A45C | UI |
| stabilizer grey / alert red / player gold | #8C8577 / #C0392B / #C9A45C | ticker kinds |
| arc | #FFC247 | payment arcs |

**Profession apron colours:**
| Profession | Colour |
|---|---|
| tender | #6FA35A |
| chandler | #D9A441 |
| delver | #5B6477 |
| woodwarden | #4E6B3A |
| mason | #B5654A |
| lenswright | #6FD3E8 |
| porter | #8A5A9E |

---

## B. File layout and ownership

```
index.html                  G2
styles.css                  G2  (base/canvas/loading; first line: @import url("src/ui/ui.css");)
serve.mjs                   (exists, untouched)
src/main.js                 INTEGRATOR
src/core/config.js          G1  CONFIG, TICKS, GOODS, ITEMS, PROFESSIONS
src/core/rng.js             G1  seeded PRNG, noise, hashes
src/core/events.js          G1  EventBus, EV names, SimClock
src/world/blocks.js         G1  block registry + structure templates
src/world/world.js          G1  World (voxel store, queries, dirty chunks, raycast)
src/world/worldgen.js       G1  generateWorld()
src/render/renderer.js      G2  scene, camera, controls, lights, sky, jar, day/night, chunk meshes, glowmap
src/render/chunkMesher.js   G2  meshChunk()
src/render/agentRenderer.js G2  instanced Wicklings, flames, cargo, status icons, picking
src/render/fx.js            G2  particles, arcs, beams, piles, labels, previews, bell
src/agents/pathfinding.js   G3  Pathfinder (A*, dig-A*, regions)
src/agents/agent.js         G3  createAgent, physiology, movement, inventory helpers
src/agents/brain.js         G3  utility AI, tasks and steps, profession review
src/agents/population.js    G3  Population (spawn, births, deaths, migration, panic, rumours)
src/economy/market.js       G4  Market (order books, Chime auction, prices)
src/economy/ledger.js       G4  Ledger (money flows, stats, history, Guild Board)
src/economy/production.js   G4  Production (towers, minting, houses, projects, regrowth, recipes)
src/player/tools.js         G5  Tools (9 interventions, picking, previews, popovers)
src/ui/hud.js               G6  top bar, tool tray, market board, global hotkeys
src/ui/charts.js            G6  canvas chart drawer
src/ui/inspector.js         G6  agent and market inspector
src/ui/ticker.js            G6  "The Chime Gazette"
src/ui/ui.css               G6  all UI styling
```
**Import rules:**
- Modules in G1, G3 and G4 are **sim-side**. They must not import `three` or touch the DOM. They must also run headless.
- Modules reach other modules' *instances* only through the `sim` object (§C.1).
- Static imports are allowed only for the pure data and helpers listed in each module section. This makes the import graph acyclic:
  - `config` and `blocks` import nothing.
  - `rng` imports nothing.
  - `events`, `world`, `worldgen` and `pathfinding` import only core modules and blocks.
  - `agent.js` imports `core/*` and `blocks`.
  - `brain` imports `agent`.
  - `population` imports `agent` and `brain`.
  - `market`, `production` and `ledger` import `core/*`, `blocks` and `agent` (helpers only).
  - The render, player and ui modules import `three` as needed, plus `core/*` and `blocks`.

---

## C. Contracts

### C.0 Conventions
- **Axes.** Y is up. Voxel `(x,y,z)` is an integer cell occupying `[x,x+1)×[y,y+1)×[z,z+1)` in Three.js units, with no offset. +X is east (the window and sunrise side); −X is west (the pond).
- **World size.** `SX=112, SY=64, SZ=112` (`CONFIG.world`). The storage index is `x + SX*(z + SZ*y)`.
- **Island mask.** `isInside(x,z) ⇔ (x+0.5−56)² + (z+0.5−56)² ≤ 54²`.
- **Chunks.** Chunks are 16³, giving 7×4×7 = 196 of them. `chunkKey = cx + 7*(cz + 7*cy)`.
- **Agent position.** `agent.pos` is the **feet** position, in floats. An agent standing on cell `(cx,cy,cz)` has `pos = (cx+0.5, cy, cz+0.5)`, with block `(cx,cy−1,cz)` solid and `(cx,cy,cz)`, `(cx,cy+1,cz)` passable. Heading is yaw in radians, with 0 facing +Z.
- **Time:**
  - `TICKS.PER_SEC = 10`, `PER_HOUR = 100` (one in-game hour is 10 sim-seconds) and `PER_DAY = 2400` (one day is 240 sim-seconds).
  - At 1× speed, one sim-second is one real second, so a day lasts 4 real minutes.
  - The sim starts on day 0 at 07:00, which is tick 700.
  - The hour is `h = (tick % 2400)/100`. The sun factor is `sun = max(0, sin(π(h−6)/12))`. Night is `h < 6 || h ≥ 18`.
  - **The Chime** happens on every tick with `tick % 100 === 0`.
  - CONFIG rates are named `…PerDay`, `…PerHour` or `…Sec` (sim-seconds). Convert them to per-tick values with `TICKS`.
- **Units.** Money is in glim (floats). Goods are integer units.
- **Determinism.** Sim code uses only `sim.rng`. Worldgen uses its own `createRng(seed)` stream. `Math.random` is allowed only for purely visual jitter in G2 and G6.
- **Markets.** `marketId` 0 is Sunward and 1 is Dewside.

### C.1 The `sim` context (created by main.js; all modules receive it)
```js
sim = {
  config: CONFIG, seed /*uint32*/, headless /*bool*/,
  rng /*Rng, createRng(seed ^ 0xA5A5A5A5)*/, events /*EventBus*/, clock /*SimClock*/,
  world /*World*/, worldInfo /*WorldInfo*/, pathfinder /*Pathfinder*/,
  ledger /*Ledger*/, market /*Market*/, production /*Production*/, population /*Population*/,
  effects: { eclipses: [], seals: [], panes: [], nextId: 1 },   // written by G5 tools, read by sim modules
  speed: 1, paused: false, lagging: false,                        // written by hud/main
  ui: { selectedAgentId: null, selectedMarketId: null, followAgentId: null, selectedGood: 'berry',
        chartTab: 'prices', muted: true, cutaway: null, hideUI: false },
  renderer, agentRenderer, fx, tools, hud, charts, inspector, ticker   // null when headless
}
Eclipse = { id, x, z, r, untilTick }
Seal    = { id, marketId, good, kind: 'ceiling'|'floor', price, untilTick }
Pane    = { id, deep: bool, breached: bool, cells: [{ x, z, y0, y1, prev: number[] /* block ids y0..y1 */ }] }
```
Every sim-side module must work when a render or UI field is `null`.

### C.2 Shared data shapes

**Agent** (created by `agent.js createAgent`). The *writer* column says who may mutate each field; everyone may read.
| Field | Type | Writer | Meaning |
|---|---|---|---|
| id, name | int, string | agent | unique id (never reused), e.g. "Tallowby Fenn" |
| alive | bool | population | false once removed |
| generation, parentId, childrenIds | int, int\|null, int[] | population | lineage |
| profession | ProfId | brain | current profession |
| skills | {ProfId: number} | population (dawn) | 0.6..1.5 |
| bornTick, ageDays, lifespanDays | int, number, number | agent | lifecycle |
| pos, prevPos | {x,y,z} | agent / population.relocate | prevPos is pos at the start of the last tick (for interpolation) |
| cell | {x,y,z} ints | agent | current foot cell |
| heading | number | agent | yaw |
| anim, animT | string, number | agent / brain | one of `idle walk dig harvest build craft sleep tend panic eat trade fall`; seconds in anim |
| needs | {tallow, rest, lustre} 0..100 | agent (+ market/production via eating) | needs |
| starveTicks | int | agent | ticks spent at tallow 0 |
| asleep | bool | brain | sleeping |
| fright | 0..1 | population / agent | panic aftermath |
| panicUntil | int tick | population | curled and rolling while `clock.tick < panicUntil` |
| glim, escrow | number | agent (demurrage), market, production, population | spendable light / light locked in open bids |
| inv | {ItemId: int} | agent helpers only | inventory; ItemId = GOODS ∪ {'lens'} |
| lanterns | int[] | production | expiry ticks of lit lanterns (≤ 3) |
| homeId | int\|null | production | cottage bed |
| towerId | int\|null | production | claimed tower (lenswright) |
| tending | int\|null | brain | tower id while standing at the tower in a `tend` step |
| projectId / commissionId | int\|null | production | project a mason works on / project this agent paid for |
| beliefs | {GoodId: number} | market, brain, population | subjective price |
| costBasis | {GoodId: number} | market | average purchase cost per held unit |
| skepticism | 0..0.8 | agent | rumour resistance |
| rumor | null\|{good, dir: 1\|-1, strength, sinceTick} | population | whisper state |
| spec | null\|{good, qty, cost} | brain | speculative holding |
| porter | null\|{good, from, to, qty, cost} | brain | arbitrage cargo plan |
| task, goal, thought, utilities | Task, string, string, [{goal, score}] top 3 | brain | decision state for the inspector |
| path, pathI, pathTicket, pathBlocked | PathNode[]\|null, int, int\|null, bool | brain / agent | navigation |
| openBids, chimeResult | int, null\|{tick, marketId, bought: {}, spent, unfilled: {}} | market | trade state |
| blacklist | Map<string,int> | brain | target key → untilTick |
| marketBlockedUntil | [int, int] | brain | per-market tick until which that market is treated as unreachable |
| earnedToday, inputsToday, netHistory | number, number, number[≤3] | ledger | income accounting |
| lowDays | int | population | consecutive dawns with lustre < 20 and glim < 15 |

**WorldInfo** (returned by `generateWorld`):
```js
{ seed,
  markets: [{ id, key: 'sunward'|'dewside', name, center: {x,y,z} /*feet level on plaza*/,
              plaza: {x0,z0,x1,z1,y} /*paving at y-1, feet at y*/, kettles: [{x,y,z},{x,y,z}],
              pads: { [good]: {x,y,z} } /*pile base cells on plaza rim*/ }],
  towers:  [{ id, base: {x,y,z}, lens: {x,y,z}, stand: {x,y,z} }],       // CONFIG.worldgen.towers
  houses:  [ HouseTemplate & { id } ],                                   // CONFIG.worldgen.houses, pre-built
  trees:   [{ x,y,z /*lowest LOG*/, height }],
  bushes:  [{ x,y,z, ripe: bool }],
  pond:    { x, z, r, level },
  spawnCells: [{x,y,z}]                                                   // ≥ 80 walkable cells near plazas
}
```
**PathNode** = `{x, y, z, dig}`. The node is a foot cell. `dig` is a bitmask of cells that must be dug before entering: 1 = the feet cell, 2 = the head cell, 4 = extra clearance (origin y+2 when stepping up; destination y+1 when stepping down).

**Task** = `{goal, steps: Step[], i, startedTick, label}`. The Step kinds are fixed (brain-internal, but the inspector prints `label` and `steps[i].k`):
`goto dig harvest plant fell craft trade waitChime sleep tend installLens deliver build eat wander idle scrape`.

**Order (bid)** = `{id, agentId, marketId, good, qty, limit, purpose: 'food'|'input'|'luxury'|'speculate'|'arbitrage', postedTick}`
**Lot (ask)** = `{id, agentId /* -1 = estate */, marketId, good, qty, ask, floor, postedTick}`

**Tower** = `{id, base, lens, stand, operatorId|null, lensQ /*0 = no lens*/, lensCracksAt, active: bool, boostUntil, mintedToday}`
**House** = `{id, origin, door, bed, approach, lanternSlots: [{x,y,z}], capacity, residents: int[], ownerId|null}`
**Project** = `{id, kind: 'house'|'tower', ownerId, masonId|null, site: {x,y,z}, blocks: [{x,y,z,id}], placed, price, materials: {stone, log}, delivered: {stone, log}, status: 'open'|'claimed'|'done'|'abandoned', createdTick}`
**Tree** = `{id, x, y, z, height, stage: 'sapling'|'mature', matureAtTick}`

### C.3 Events (`EV` constants in `core/events.js`; synchronous bus)
| EV key | name | Payload | Emitter |
|---|---|---|---|
| CLOCK_NEWDAY | `clock:newday` | {day, tick} (fires at 00:00, before CLOCK_HOUR) | SimClock |
| CLOCK_HOUR | `clock:hour` | {day, hour, tick} | SimClock |
| CLOCK_DAWN | `clock:dawn` | {day, tick} (06:00, after CLOCK_HOUR) | SimClock |
| CLOCK_DUSK | `clock:dusk` | {day, tick} (18:00) | SimClock |
| MARKET_CHIME | `market:chime` | {marketId, tick, trades: [{good, buyerId, sellerId, qty, price}], cleared: {[good]: {price, volume, bestBid, bestAsk, unfilledQty, unsoldQty, sealed}}} | market |
| AGENT_BORN | `agent:born` | {agentId, parentId} | population |
| AGENT_IMMIGRATED | `agent:immigrated` | {agentId, reason: 'floor'\|'prosperity'} | population |
| AGENT_DIED | `agent:died` | {agentId, name, profession, cause: 'age'\|'starved', pos} | population |
| AGENT_EMIGRATED | `agent:emigrated` | {agentId, name, glim, pos} | population |
| AGENT_PROFESSION | `agent:profession` | {agentId, from, to, reason} | brain |
| AGENT_DUG | `agent:dug` | {agentId, x, y, z, blockId, item} | agent.js digBlock |
| AGENT_PLACED | `agent:placed` | {agentId, x, y, z, blockId} | production |
| AGENT_HARVEST | `agent:harvest` | {agentId, x, y, z, item, qty} | production |
| PANIC | `agent:panic` | {x, z, radius, count} | population |
| RUMOR | `rumor:update` | {good, dir, believers} | population |
| PROJECT_COMMISSIONED | `project:commissioned` | {projectId, kind, ownerId, site, price} | production |
| PROJECT_DONE | `project:done` | {projectId, kind, ownerId, masonId, site} | production |
| TOWER_LENS | `tower:lens` | {towerId, what: 'installed'\|'cracked', agentId} | production |
| TREE_FELLED | `tree:felled` | {x, y, z, logs, agentId} | production |
| SMUGGLE_BREACH | `smuggle:breach` | {paneId, agentId, x, y, z} | tools |
| STABILIZER | `stabilizer` | {kind, amount, message} | ledger.stabilizer |
| PLAYER_TOOL | `player:tool` | {tool, label, glyph, pos?, params} | tools |
| TOOL_CHANGED | `tool:changed` | {tool} | tools |
| SELECT_AGENT | `ui:selectAgent` | {agentId\|null} | tools, inspector, ticker |
| SELECT_MARKET | `ui:selectMarket` | {marketId\|null} | tools, hud |
| SELECT_GOOD | `ui:selectGood` | {good} | hud |
| FOLLOW | `ui:follow` | {agentId\|null} | hud, inspector |
| FLY_TO | `ui:flyTo` | {x, y, z} | ticker, inspector |
| SPEED | `ui:speed` | {speed, paused} | hud |
| REROLL | `ui:reroll` | {seed} | hud |
| TICKER | `ticker:post` | {text, kind: 'econ'\|'labor'\|'life'\|'world'\|'player'\|'stabilizer'\|'alert', pos?} | any module |

### C.4 Module contracts

#### G1: `src/core/config.js`
Exports `CONFIG` (the full literal in the Appendix), plus these:
- `TICKS = {PER_SEC: 10, PER_HOUR: 100, PER_DAY: 2400}`
- `GOODS` (8 ids, in the order used by all UI)
- `ITEMS = [...GOODS, 'lens']`
- `PROFESSIONS` (7 ids, in order)

It has no imports and no logic.

#### G1: `src/core/rng.js`
- `createRng(seed:uint32) → Rng`. This is mulberry32. `Rng` has:
  - `next()` → [0,1)
  - `int(lo,hi)` → inclusive
  - `range(lo,hi)`
  - `pick(arr)`
  - `chance(p)` → bool
  - `normal()` → standard normal
  - `fork(salt)` → new Rng
- `createNoise(seed) → {noise2(x,z), noise3(x,y,z), fbm2(x,z,oct=4), ridged2(x,z,oct=4)}`. `noise2` and `noise3` return [−1,1]. `fbm2` returns roughly [−1,1]. `ridged2` returns [0,1]. Use gradient or simplex noise with no dependencies.
- `hash3(x,y,z,salt=0) → [0,1)`. This is a stateless integer hash.
- `hashString(str) → uint32`
- `parseSeed(str) → uint32`, which accepts hex or decimal.
- `randomSeed() → uint32`, which uses Math.random and is for re-rolls only.

#### G1: `src/core/events.js`
- `class EventBus { on(name, fn) → unsubscribeFn; off(name, fn); once(name, fn); emit(name, payload) }`. It is synchronous. A throwing listener is caught and `console.error`ed, and the bus keeps going.
- `EV`, which is a frozen object of the §C.3 names.
- `class SimClock`:
  - `constructor(config)` sets `tick = startHour*100`.
  - Its fields are updated only by `advance(events)`: `tick, day, hour (int), hourFloat, sun, daylight` (smoothstep from 0 to 1 over 05:15 to 06:45 and back over 17:15 to 18:45), `isNight`, `isHourTick`, `isDawnTick`, `isDuskTick` and `isNewDayTick`.
  - `advance(events)` increments `tick`, recomputes the fields and emits the CLOCK events in the order NEWDAY → HOUR → DAWN/DUSK.
  - Helpers: `hours(h) → ticks` and `days(d) → ticks`.

#### G1: `src/world/blocks.js`
Exports `B` (name → id), `BLOCKS` (an array indexed by id) and the lookup tables `SOLID`, `OPAQUE`, `TRANSPARENT`, `AGENT_DIGGABLE` and `EMISSIVE`. The first four are `Uint8Array(256)`; `EMISSIVE` is a `Float32Array(256)`. It also exports `isSolid(id)`, `isPassable(id)` (not solid and not WATER), `houseTemplate(x0,y0,z0)`, `towerTemplate(x,y,z)` and `treeTemplate(x,y,z,height)`.

Each block definition is `{id, key, name, color:'#hex', solid, opaque, transparent, alpha, emissive, hardness /*sec, Infinity = unbreakable*/, agentDiggable, yields: GoodId|null, yieldChance}`.
| id | key | colour | notes (hardness s; yield) |
|---|---|---|---|
| 0 | AIR | — | — |
| 1 | BEDROCK | #1E1B22 | unbreakable |
| 2 | BASALT | #34343F | 2.5; stone @ CONFIG.production.basaltStoneChance; diggable |
| 3 | LOAM | #4A3526 | 0.8; diggable |
| 4 | MOSS | #7FA650 | 0.8; sides rendered as mix(moss, loam, 0.6); diggable |
| 5 | PATH | #9C8763 | 0.8; trampled moss; fast floor; diggable |
| 6 | PEAT | #2B1E18 | 1.2; peat; diggable |
| 7 | QUARTZ | #DDEFF5 | 3.0; quartz; emissive 0.35; diggable |
| 8 | AMBER | #E8961E | 3.0; amber; emissive 0.6; diggable |
| 9 | LOG | #5A3B2A | 1.2; felled only (not path-diggable) |
| 10 | NEEDLES | #2F5A3E | 0.3; diggable |
| 11 | BUSH_BARE | #3E6B4B | 0.5; not path-diggable |
| 12 | BUSH_RIPE | #3E6B4B, speckle #F2E6C8 | 0.5; not path-diggable |
| 13 | SAPLING | #7BAF5A | 0.5; not path-diggable |
| 14 | WATER | #6FB7C9 | non-solid, transparent, alpha 0.6, impassable for walking |
| 15 | CUT_STONE | #7A7684 | 3.0; not path-diggable (buildings) |
| 16 | THATCH | #8A5A3A | 1.0; not path-diggable |
| 17 | PAVING | #B8A98A | 2.0; fast floor; not path-diggable |
| 18 | KETTLE | #6B4F3A | unbreakable; emissive 0.25 |
| 19 | LENS_MOUNT | #B08D57 | unbreakable; emissive 0.3 |
| 20 | LANTERN | #F2A93B | 1.0; emissive 1.0; not path-diggable |
| 21 | GLASS_WALL | #CFE8EF | unbreakable; transparent alpha 0.35; solid |
| 22 | WAX_PUDDLE | #E9D9B0 | 1.0; scraped by chandlers → 2 tablets; not path-diggable |

**Templates.** Each template returns `{blocks: [{x,y,z,id}], ...anchors}`:
- **`houseTemplate(x0,y0,z0)`.** The footprint is 3×3 at feet level `y0` (the floor is the existing ground at y0−1).
  - **Walls:** CUT_STONE on the perimeter at y0 and y0+1, except the door column `(x0+1, z0)`. That is 14 blocks.
  - **Roof:** THATCH over all 3×3 at y0+2. That is 9 blocks.
  - **Anchors:** `door (x0+1,y0,z0)`, `bed (x0+1,y0,z0+1)`, `approach (x0+1,y0,z0−1)`, and `lanternSlots [(x0,y0+1,z0), (x0+2,y0+1,z0), (x0+1,y0+2,z0)]`.
- **`towerTemplate(x,y,z)`.** CUT_STONE at y, y+1 and y+2, with LENS_MOUNT at y+3. Anchors: `base (x,y,z)`, `lens (x,y+3,z)`.
- **`treeTemplate(x,y,z,h)`.** A LOG trunk runs from y to y+h−1. A NEEDLES cone surrounds the upper trunk: radius 2 for layers h−3..h−2 and radius 1 for layers h−1..h, skipping trunk cells.

#### G1: `src/world/world.js`
`class World`. It imports `CONFIG` and `blocks`.
- `constructor(config)` allocates `data: Uint8Array(SX*SY*SZ)`, `heightmap: Int16Array(SX*SZ)` (top solid y, or −1), `footfall: Uint16Array(SX*SZ)`, `version = 0` and `dirty: Set<chunkKey>`.
- Fields: `SX, SY, SZ, CHUNK, NCX, NCY, NCZ`.
- **Basic queries:**
  - `inBounds(x,y,z)`
  - `isInside(x,z)`
  - `get(x,y,z) → id`. Out of bounds returns AIR above and BEDROCK below y=0.
  - `set(x,y,z,id) → bool changed`. This marks the chunk and any neighbour chunks the cell borders as dirty, updates the heightmap, updates the per-chunk counts of tracked blocks and increments `version`. It does **not** emit events.
  - `isSolidAt`, `isPassableAt(x,y,z)`
  - `isWalkable(x,y,z)`: inside, the floor at y−1 is solid, and the cells at y and y+1 are passable.
  - `surfaceY(x,z) = heightmap+1`
  - `topBlock(x,z) → id`
- **Resource search.** `TRACKED` is a list of block ids with per-chunk counts: QUARTZ, AMBER, BUSH_RIPE, BUSH_BARE, PEAT, WATER, WAX_PUDDLE, SAPLING and LOG.
  - `countBlocks(id)` is O(chunks).
  - `findNearest(id, x,y,z, maxDist, pred?) → {x,y,z}|null` scans only chunks whose count is > 0, in order of increasing distance. The same applies to `findNearestK(id, x,y,z, k, maxDist, pred?) → [{x,y,z,d}]`.
- **Chunk plumbing:** `takeDirty(max) → chunkKey[]`, `markAllDirty()`, `chunkKey(cx,cy,cz)`, `chunkCoords(key) → {cx,cy,cz}`.
- **Picking.** `raycast(origin, dir, maxDist=400, {hitWater=false}) → {x,y,z,id,normal:{x,y,z},dist}|null` uses an Amanatides-Woo DDA and returns the first solid block, or the first water block if `hitWater` is set.
- `isExposed(x,y,z)` returns whether `y > heightmap`, meaning open sky above.
- `columnIndex(x,z)` returns `x + SX*z`.

#### G1: `src/world/worldgen.js`
`generateWorld(world, seed, config) → WorldInfo`. It imports rng, blocks and config, and uses `createRng(seed)` and `createNoise(seed)` only. It must be deterministic, with the same seed always giving identical bytes. The steps, in order:
1. **Heightmap.**
   - Start from `h = baseHeight + hillAmp*fbm2(x/40,z/40)`.
   - Add `ridgeAmp*ridged2(x/28,z/28)*smoothstep(ridgeStartX−10, ridgeStartX+14, x)`.
   - Subtract a pond bowl: `depth*(1−d/r)²` inside `pond.r`.
   - Enforce a maximum slope with 2-pass min-propagation so that |Δh| ≤ `maxSlope` (1) between 4-neighbours everywhere, except on the ridge (x > ridgeStartX), where 2 is allowed where `ridged2 > 0.7`.
   - Flatten each 9×9 plaza to its median height.
   - Carve a road between the plazas with interpolated heights and max step 1.
   - Finally add the rim: for r > `rimStart`, `h += (r − rimStart)*2`, with all BASALT.
2. **Columns.**
   - BEDROCK at y=0, and BASALT up to `h − loamDepth`.
   - LOAM up to h−1, then MOSS at h, or LOAM if the column is under water.
   - Inside the bog ring (`bogRing` distance from the pond edge), the top 2 layers are PEAT.
   - Pond cells with `h < level` are filled with WATER up to `level` (`WATER_LEVEL`).
   - QUARTZ replaces BASALT where `noise3(x/9,y/9,z/9) > quartzVein` and x > 60. There is no quartz within 2 of the surface on non-ridge land.
   - AMBER replaces BASALT with probability `amberChance` for y < 14.
   - No caves.
3. **Plazas.** PAVING at y−1 under each 9×9 plaza. There are 2 KETTLE blocks on each plaza at the feet level. There are 8 pads, one per good, on the plaza rim cells, spaced out.
4. **Reachability.** Run a BFS over 2.5-D surface walkability from the Dewside plaza. Every placement below must be on reachable cells.
5. **Structures.**
   - `towers` count of towers at x ≥ `tower.minX`, spaced ≥ `minSpacing`, each with a walkable `stand` cell.
   - `houses` count of houses within 5..18 of the plazas, alternating between the two markets. Use the house site rules from production (§C.4 production `findHouseSite`), but implemented locally.
   - `trees` count of trees on moss via rejection-sampled Poisson (spacing 4), with height `rng.int(4,7)`.
   - `bushes` count of bushes as 1-voxel BUSH_RIPE (70%) or BUSH_BARE, on moss within 14 of the pond edge, or anywhere at 30%.
6. **Spawn cells.** Collect `spawnCells`: walkable cells within 12 of the plazas.

Worldgen writes blocks through `world.set` or directly to `data`, then calls `world.markAllDirty()` and recomputes the heightmap and counts.

#### G2: `index.html`, `styles.css`
- **Importmap:** `{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}`
- **Script:** `<script type="module" src="src/main.js">`.
- **DOM:** exactly these ids must exist:
```html
<div id="app">
  <canvas id="view"></canvas>
  <div id="fxlayer"></div>                      <!-- G2 floating labels -->
  <div id="ui-root">
    <header id="topbar"></header>  <nav id="tooltray"></nav>
    <aside id="rightpanel"><section id="marketboard"></section><section id="inspector" hidden></section></aside>
    <section id="gazette"></section>  <footer id="drawer"></footer>
    <div id="popover" hidden></div>  <div id="tooltip" hidden></div>
  </div>
  <div id="loading"><div class="bar"><i></i></div><p>Pouring the specimen…</p></div>
  <pre id="headless-log" hidden></pre>
</div>
```
- **styles.css (G2).**
  - The first line is `@import url("src/ui/ui.css");`.
  - Page rules: full-viewport canvas, `body {margin:0; overflow:hidden; background:#2A1C14}`.
  - `#fxlayer` is absolutely positioned with `pointer-events:none`.
  - `#loading` is a parchment card whose bar width is set through `--p`.
  - `#ui-root` has `pointer-events:none`, and its children have `pointer-events:auto`.

#### G2: `src/render/chunkMesher.js`
`meshChunk(world, cx, cy, cz) → {opaque: MeshData, transparent: MeshData}`, where `MeshData = {positions: Float32Array, normals: Float32Array, colors: Float32Array /*rgb opaque, rgba transparent*/, emit: Float32Array /*1 per vertex*/, indices: Uint32Array, vertexCount}`. It is a pure function that imports blocks and rng (`hash3`).
- **Face culling.** A face is emitted only when the neighbour is not opaque. Faces between transparent blocks of the same id are culled.
- **Ambient occlusion.** AO is the classic 3-neighbour per-vertex AO, with levels [0.55, 0.7, 0.85, 1.0]. When quad AO is anisotropic, flip the triangulation.
- **Vertex colour.** The colour is block colour × face shade (top 1.0, ±X 0.8, ±Z 0.7, bottom 0.55) × AO × jitter (0.92 + 0.16·hash3).
  - BUSH_RIPE vertices take the speckle colour when `hash3(vertex) > 0.5`.
  - MOSS side faces use mix(moss, loam, 0.6).
- **Water.** The top face of WATER is lowered by 0.12.
- `emit` is `EMISSIVE[id]`.

#### G2: `src/render/renderer.js`
`class Renderer`. Its constructor is `(canvas, sim)`.
- **Scene objects:** the scene, a `PerspectiveCamera` (`fov` from config), `OrbitControls` from `three/addons/controls/OrbitControls.js`, and a WebGLRenderer (antialias, ACES tone mapping, pixelRatio ≤ `maxPixelRatio`).
- **Terrain materials.** `terrainMat` is a `MeshLambertMaterial({vertexColors:true})` patched through `onBeforeCompile`. The patch adds:
  - `attribute float aEmit`
  - `uniform sampler2D uGlow`
  - `uniform float uNight`
  - `uniform vec4 uEclipse[3]` (x, z, r, on)
  - `uniform float uCutY` (used for the cutaway)

  In the fragment shader, `outgoing += vColor*aEmit*mix(0.25,1.0,uNight) + texture(uGlow, worldXZ/112).rgb*uNight`. Inside each eclipse disc the diffuse light is multiplied by 0.35, with a soft edge of 2 voxels. `transparentMat` has the same patch, with `transparent:true, depthWrite:false`.
- **Scenery:**
  - A walnut desk plane at y=−4, 400×400, with a procedural grain CanvasTexture.
  - A plinth cylinder (r 60, y −4..0) with a brass ring.
  - A brass plate with a CanvasTexture reading `SPECIMEN No. {SEED hex} · Cera civitas`.
  - A study backdrop: a large inverted sphere with a vertical gradient that lerps with daylight (day top #D8C7A8, night top #141A30, bottom #2A1C14).
- **Bell jar.** An open cylinder (r 57, h 50) plus a dome (y-scaled hemisphere) and a knob. It uses a ShaderMaterial with `alpha = 0.03 + 0.35·fresnel³`. The colour lerps from glassRim to dusk #F2A65A by `duskFlush`, which peaks at 18:00 with a ±1 h window. It has `depthWrite:false` and `renderOrder` 10.
- **Lights:**
  - `DirectionalLight` sun, colour dayKey. The azimuth goes east→west over 06–18, with max elevation 60°. It casts shadows (map `shadowMap`, ortho box covering the island). At dawn and dusk it lerps to dusk colour. At night it becomes moonlight #5B6FA8 at 0.12.
  - `HemisphereLight` with sky and bounce colours, lerped toward nightAmbient.
  - `FogExp2`, whose density lerps across `CONFIG.render.fog` by the haze `1−η` (from `sim.ledger.haze`). The fog colour is #FFE2B0 by day and #141A30 at night.
- **Methods:**
  - `buildAllChunks(onProgress(frac)) → Promise`. Meshes every chunk and yields to rAF every 12 chunks.
  - `update(realDt, sim, alpha)` does the following:
    - remeshes ≤ `remeshPerFrame` chunks from `world.takeDirty`
    - updates lights and sky from `sim.clock`
    - rebuilds the 128² glowmap `DataTexture`: for each live agent, splat a gaussian of radius `glowRadius`, with the colour from the flame ramp and intensity `0.25+0.75·min(1, log2(1+(glim+escrow)/10)/4)`; lit lanterns from `sim.production.litLanterns()` add intensity 0.6
    - updates eclipse uniforms from `sim.effects.eclipses`
    - moves the follow camera
    - handles camera shake
    - calls `controls.update()`
    - runs adaptive quality
  - `render()`
  - `resize()`
  - `pickRay(clientX, clientY) → {origin:{x,y,z}, dir:{x,y,z}}`
  - `setFollowTarget(agentId|null)`
  - `flyTo({x,y,z}, dist=40)`. This is a 1 s eased move of the target and camera.
  - `shake(amount)`
  - `setCutaway(y|null)`, which uses a clipping plane that hides terrain above y.
  - `setOrbitMode('inspect'|'tool')`:
    - `inspect`: LMB rotates, RMB pans and the wheel zooms.
    - `tool`: LMB does nothing, RMB rotates, Shift+RMB pans and the wheel zooms.
  - Also exposed: `scene`, `camera` and `controls`.
- **Keyboard.** WASD pans the controls target in the camera's ground plane. Q/E orbits ±. These keys are ignored while an input element has focus.
- **Camera limits:** see `CONFIG.render.camera`, with `maxPolarAngle = 0.49π`.
- **Adaptive quality.** If the average frame time exceeds `adaptiveSlowMs` for `adaptiveSec`, step down in this order: shadows off, then pixelRatio 1, then glowmap 64².
- **Debug overlay.** The `P` key toggles FPS, draw calls, sim ms/frame, path ms/frame and remesh queue length.

#### G2: `src/render/agentRenderer.js`
`class AgentRenderer`. Its constructor is `(scene, sim)`. It allocates everything for `CONFIG.population.max`.
- **InstancedMeshes:**
  - **body**: box 0.5×0.8×0.5, wax colour. Y scale is `0.6+0.4·tallow/100`, and × 0.7 while `ageDays < CONFIG.agent.childScaleDays`.
  - **apron**: box 0.54×0.34×0.54 on the lower body, with the instance colour set to the profession colour.
  - **wick**: 0.06×0.18×0.06, #2B2320.
  - **cargo**: 0.22 cubes, up to 4 per agent on the back, each coloured by good. One cube is drawn per carried unit, taking goods in GOODS order and skipping `lens`.
- **Flames.** `THREE.Points` with an additive ShaderMaterial, `depthWrite:false` and a radial falloff in the fragment shader.
  - **Size** is `flameBase + flameK·log2(1+(glim+escrow)/10)` in world units, projected in the vertex shader.
  - **Colour** comes from the ramp by `min(1, log2(1+wealth/10)/4)`, mixed toward #B388FF by `rumor.strength`.
  - **Modifiers:** flicker comes from a per-agent phase. Asleep scales size by 0.6. Panic is reddish and flickers fast.
- **Status icons.** A second `Points` layer samples a canvas-generated glyph atlas and is drawn 1.1 above the head, only within 70 units of the camera. The icon is chosen by priority:

  | Priority | Condition | Icon |
  |---|---|---|
  | 1 | panic | `!` red |
  | 2 | asleep | `z` |
  | 3 | anim `trade` | `◆` gold |
  | 4 | `build` | `▲` |
  | 5 | `tend` | `✦` cyan |
  | 6 | tallow < 25 | `○` hungry |
  | 7 | none of the above | no icon |
- **Animation:**
  - Positions are `lerp(prevPos, pos, alpha)`.
  - Walking adds a bob of `0.06·|sin|`.
  - `dig`, `harvest` and `build` pitch the body forward and back at 3 Hz.
  - Panic renders the body as a 0.55 cube rolled along the heading.
- **Methods:**
  - `update(sim, alpha, camera)`
  - `pick(ray) → agentId|null`: nearest hit against spheres of r 0.6 centred at pos+0.6y.
  - `setSelected(id|null)`: draws a brass ring under the selected agent.
  - `setHovered(id|null)`

#### G2: `src/render/fx.js`
`class Fx`. Its constructor is `(scene, sim)` and it subscribes to events itself.
- **Particles.** A pooled `Points` of 2,000 particles with velocity, gravity and life. `burst(x,y,z, color, n=12, kind='dust'|'spark'|'smoke'|'glint'|'leaf')`.
- **Floating text.** `floatText(x,y,z, text, color='#FFE2B0', sec=1.5)`. A pool of 24 DOM spans in `#fxlayer` is projected each frame.
- **Arcs.** `arc(from, to, color='#FFC247', sec=CONFIG.render.arcSec)`. A pool of 64 quadratic-Bezier lines (height 4 + 0.3·dist) with a moving bright head.
- **Glass ripple.** `ripple(x,y,z)`: an expanding ring on the jar glass, facing outward.
- **Sound.** `bell()` plays a WebAudio synthesized bell (partials 1, 2.76, 5.4 with exponential decay). It is skipped if `sim.ui.muted` is set or `sim.speed > 2`.
- **Previews.** `setPreview(kind|null, params)` where kind is `'disc'` {x,y,z,r,color}, `'line'` {cells:[{x,y,z}],color}, `'box'` {x,y,z,color} or `'ring'` {x,y,z,r,color}.
- **Path line.** `setPathLine(points|null)`: a polyline at feet + 0.1.
- `update(realDt, sim)` also redraws these persistent layers:
  - **Market piles**, rebuilt every chime. For each market and good, `market.getPiles(m)[good]` units are drawn as 0.45 cubes, 4 per layer, stacked on `pads[good]`, up to 32 cubes per pad (then a scaled top cube). Colours are the good colours.
  - **Tower beams.** Every tower with `active` gets an additive cylinder (r 0.15, length 30) from the lens toward the sun direction. Opacity is `0.6·sun·η`, doubled while boosted.
  - **Eclipse hands.** A dark translucent ellipsoid "palm" (sx=r, sy=r·0.3, sz=r·1.2) at y=78 above each eclipse disc.
  - **Seal markers.** A red wax disc (#C0392B) floating over the sealed good's pad.
  - **Pane outlines.** A faint cyan edge line along each pane's top.
- **Event listeners:**

  | Event | Effect |
  |---|---|
  | MARKET_CHIME | One arc per aggregated (buyer, seller) pair, max `maxArcs`. The arc runs from the buyer's current pos+1.2y to the seller's pos+1.2y. For estate sellers it ends at the pad. Also calls `bell()` for marketId 0. |
  | AGENT_DUG | Burst in the block colour. |
  | AGENT_PLACED | Puff. |
  | AGENT_HARVEST | Glint, plus floatText `+2 berry`. |
  | AGENT_BORN | Sparkle. |
  | AGENT_DIED | Smoke. |
  | AGENT_EMIGRATED / AGENT_IMMIGRATED | Moth sprite rising to, or descending from, y=85 over 1.5 s. |
  | PROJECT_DONE | Glint plus text "Cottage raised" or "Tower raised". |
  | TOWER_LENS | Glint. |
  | TREE_FELLED | Leaf burst. |
  | SMUGGLE_BREACH | Large spark burst. |

#### G3: `src/agents/pathfinding.js`
`class Pathfinder`. Its constructor is `(world, config)`.
- **Moves.** There are 4 horizontal directions, each with dy ∈ {−1, 0, +1}.
  - The destination must be `isWalkable`.
  - Stepping up also requires the origin's y+2 to be passable.
  - Stepping down also requires the destination's y+1 to be passable.
- **Costs.** A step costs 1. It costs `fastFloorCost` if the floor block below the destination is PATH or PAVING. Any dy ≠ 0 adds `climbCost`.
- **Heuristic.** `0.75·(|dx|+|dz|+|dy|)·w`, where `w = wNormal` for normal searches and `wDig` for dig searches.
- **Dig search.** Cells that are `AGENT_DIGGABLE` count as passable, at a cost of `+digPenalty` per dug cell. The floor under the destination must be solid and must not itself be dug. There is no digging at y < 1 or outside the island mask.
- **Implementation.** A binary heap over typed arrays with generation-stamped visited arrays. Searches are capped at `maxNodes` (normal) or `maxNodesDig` (dig).
- **Regions.** `regionOf(x,y,z) → int` gives flood-fill labels over walkable cells in an `Int32Array` the size of the world. `refreshRegions(force)` recomputes them only when `world.version` has changed and at least `regionRefreshSec` has passed. `sameRegion(a,b)` compares the regions of two cells.
- **Requests.**
  - `request(start, goal, opts={}) → ticket:int` queues a search. `start` is a cell. The goal is:
    - `{x,y,z}` for an exact cell
    - `{x,y,z, radius}` to accept any walkable cell within Chebyshev xz ≤ radius and |dy| ≤ 3
    - `{x,y,z, adjacentTo:true}` to accept cells with max(|dx|,|dz|) ≤ 1, not (0,0), and goal.y−2 ≤ y ≤ goal.y+1
    
    Opts are `{allowDig=false, digPenalty, maxNodes}`.
  - Without `allowDig`: if `!sameRegion(start, nearestWalkable(goal))`, fail at once with `unreachable` and do not search.
  - When `allowDig` is set:
    - If `sameRegion(start, nearestWalkable(goal))`, run a normal search first and accept it if its cost ≤ `detourFactor·manhattan + 8`.
    - Otherwise run a dig search.
  - `poll(ticket) → null (pending) | {ok:true, path:PathNode[], cost} | {ok:false, reason:'unreachable'|'budget'|'badStart'}`. Results expire after `resultTTLTicks`.
  - `cancel(ticket)`
- **Budget.**
  - `beginFrame()` resets the per-frame millisecond budget.
  - `processQueue(maxRequests=config.path.requestsPerTick)` is called once per tick. It stops when it has served `maxRequests` or used `frameBudgetMs` of time.
  - `stats = {msThisFrame, servedThisFrame, queued}` is read by the debug overlay.
- **Synchronous helpers** (not budgeted):
  - `findPathNow(start, goal, opts)`, for tools and tests only.
  - `nearestWalkable(x,y,z, maxR=6) → cell|null`, which searches shells of increasing radius.

#### G3: `src/agents/agent.js`
Imports `CONFIG`, `TICKS`, `GOODS`, `ITEMS`, `PROFESSIONS`, `EV`, `B`, `BLOCKS` and `AGENT_DIGGABLE`.
- `createAgent(sim, {cell, profession, glim, ageDays, parent?}) → Agent`. Fills every §C.2 field.
  - Beliefs are `ref·U(0.8,1.2)`. A child copies its parent's beliefs × U(0.9,1.1).
  - Skills: 1.0 in the starting profession and 0.8 in the others. Children get 0.9 in the parent's profession and 0.7 in the others.
  - Skepticism is `U(0,0.8)` and the lifespan is `U(lifespanDays)`.
- `stepAgent(agent, sim)` runs each tick:
  1. **Physiology:**
     - Tallow falls by `tallowPerDay` (or `tallowSleepPerDay` when asleep).
     - Rest falls by `restPerDay` while awake. While asleep it rises by `restPerHourHoused` or `restPerHourUnhoused` × 24 per day.
     - Lustre changes by `−lustrePerDay + (homeId? lustreHousedPerDay) + lanterns.length·lustrePerLanternPerDay` per day.
     - Values are clamped to 0..100, and `starveTicks` is tracked.
     - Fright decays at `frightDecayPerDay`, and age advances.
  2. **Demurrage.** `loss = glim·(homeId? demurrageHoused : demurrageUnhoused)/PER_DAY`. It is subtracted from glim and batched into `sim.ledger.record('demurrage', loss)`.
  3. **Inventory spoilage.** On hour ticks only, each berry and tablet unit spoils with probability `invSpoilPerDay/24`.
  4. **Gravity.** If the current cell is not walkable and the cell below is passable, fall at `fallSpeed` until landing on a walkable cell.
  5. **Path following:**
     - If the next node has `dig` bits, dig each flagged cell in order with `digBlock`, spending `hardness/skill` seconds each in anim `dig`.
     - Otherwise move toward the node at `speed × (fast floor ? fastFloorMul) × (tallow<hungry ? hungryMul) × (load>0.7 ? loadedMul)`, adding `climbSec` per dy.
     - On arrival, update `cell`, increment `world.footfall[columnIndex]` and advance `pathI`.
     - Before entering a node, recheck that it is walkable, or diggable when its dig bits are set. If the check fails, set `pathBlocked = true` and stop.
  6. `prevPos` is copied from `pos` at the start of the tick.
- `digBlock(agent, x,y,z, sim) → ItemId|null`:
  - Refuses if the block's hardness is Infinity.
  - Sets AIR.
  - Rolls the yield. A yield goes to the inventory if there is capacity; otherwise it is lost.
  - Emits `AGENT_DUG`.
- **Inventory helpers:**
  - `addItem(agent, item, n) → int added`
  - `removeItem(agent, item, n) → bool`
  - `countItem(agent, item)`
  - `totalItems(agent)`, which excludes lens
  - `carryCap(agent)`, which is `CONFIG.professions[p].carry`
  - `freeCapacity(agent)`
  - `foodStock(agent)`, the tallow points held: `berry·12 + tablet·40`
- **Other helpers:**
  - `eat(agent, sim) → bool` eats one unit: a tablet if `tallow ≤ 60`, otherwise a berry, falling back to whichever is available.
  - `generateName(rng)` combines a first name from [Tallowby, Wickett, Ember, Candor, Taper, Flick, Glimmer, Sconce, Votive, Snuff, Lumen, Cera, Beeswick, Dripley, Moth] with a surname from [Fenn, Wax, Brass, Dew, Peat, Quill, Soot, Pine, Ridge, Hollow, Bell, Tallow, Rush, Mote].
  - `PROF_INFO` is an alias of `CONFIG.professions`.

#### G3: `src/agents/brain.js`
Imports `agent.js` helpers, `CONFIG`, `TICKS`, `GOODS`, `B` and `EV`. The economic rules are in §D; this section covers the machinery.
- **`updateBrain(agent, sim)`** runs per tick after `stepAgent`:
  1. **Panic.** While `clock.tick < panicUntil`, run the panic roll: every 0.4 s move to the lowest walkable neighbour, up to `rollSteps` times. Then return.
  2. **Reflexes.** Every 10 ticks, staggered by id:
     - eat if `tallow < eatBelow` and there is food
     - call `sim.production.lightLantern(agent)` if `inv.lantern > 0` and fewer than `maxLanterns` are lit
  3. **Urgent interrupts.** Interrupt the current task if tallow < 15 and the goal is not food or forage, or if rest < 8 and the goal is not sleep.
  4. **Decide.** If there is no task, or the task has finished or failed, call `decide()`. At most `decisionsPerTick` agents decide per tick; the rest idle.
  5. **Execute.** Otherwise run the current step. Each step has a timeout: 60 s by default, and `goto` gets 3× its path length / speed + 10 s. A timeout or failure aborts the task and blacklists the target key for `blacklistHours`.
- **`goto` step.**
  - It calls `sim.pathfinder.request(agent.cell, goal, {allowDig, digPenalty: CONFIG.path.digPenalty[prof] ?? default})` and polls every tick.
  - On arrival it may call `market`, `production` and so on.
  - It repaths when `pathBlocked` is set, or when the agent has not moved for `stuckSec`. After `maxRepaths` failures, the step fails.
  - If the goal is a market and the result is `unreachable`, it sets `agent.marketBlockedUntil[m]`.
- **`decide(agent, sim)`** scores the goals in §D.3 plus the `hysteresis` bonus for the current goal. It stores the top 3 in `utilities`, builds the plan and sets `thought`. Example thoughts:
  - "Tablets at 9.1 exceed my limit 7.4, so I'm foraging"
  - "Hauling 12 quartz Sunward→Dewside (+18 expected)"
- **`interrupt(agent, sim, reason)`** cancels the path ticket, calls `sim.market.cancelBids(agent)`, clears `tending` and the task, and records `thought = reason`.
- **`reviewProfession(agent, sim, ctx)`** runs at dawn, called by population (§D.7). `ctx = {guild, meanY, subsistence, budget:{left}}`. On a switch it:
  - calls `interrupt`
  - calls `sim.production.releaseTower(agent)` and `releaseProject(agent)`
  - sets `profession`
  - emits `AGENT_PROFESSION` with reason text such as `"delving pays 14.2/day vs tending 6.1"`

#### G3: `src/agents/population.js`
`class Population`. Its constructor is `(sim)`. It imports agent, brain, CONFIG, EV and TICKS.
- **Fields:** `agents: Agent[]` (alive only, stable order) and `byId: Map`.
- **Spawning:**
  - `spawnInitial(worldInfo)` creates `initial` agents on `spawnCells`, following `initialProf`.
    - Ages are `U(initialAgeDays)` and glim is `U(startGlim)`.
    - Each agent starts with 2 tablets and 2 berries.
    - Beds: the first 2·houses agents in shuffled order claim beds (`production.claimBed`).
    - Lenswrights claim the initial towers.
  - `spawn(opts) → Agent` adds an agent and assigns the next id. For an immigrant it also calls `ledger.record('immigration', immigrantGlim)` and emits `AGENT_IMMIGRATED`. For a birth it moves the parent's share without recording a flow and emits `AGENT_BORN`.
- **`tick(sim)`:**
  - Calls `stepAgent` and then `updateBrain` for every agent.
  - Rebuilds the spatial hash of 4×4 columns.
  - Every sim-second, runs `tickRumors`.
  - On hour ticks, checks deaths by age and starvation (`starveTicks ≥ starveDays·PER_DAY`), plus immigration.
  - On dawn ticks, calls `onDawn()`.
- `get(id)`, `count()`, `professionCounts() → {prof: n}` and `believerCount(good?)`.
- `neighbors(x, z, r) → Agent[]`
- **Removal:**
  - `kill(agent, cause)`:
    - Places WAX_PUDDLE at the feet cell if it is air with a solid floor.
    - Hands 50% of glim to the heir: the youngest living child, else a housemate. With no heir, that half is also burned. The rest is burned via `ledger.record('death', burned)`.
    - Calls `market.onAgentRemoved(agent)` and `production.onAgentRemoved(agent)`.
    - Sets `alive = false`, removes the agent and emits `AGENT_DIED`.
  - `emigrate(agent)` records `('emigration', glim)`, runs the same cleanup and emits `AGENT_EMIGRATED`.
- **Relocation:**
  - `relocate(agent)` snaps the agent to `pathfinder.nearestWalkable` and interrupts it.
  - `relocateInBox(x0,y0,z0,x1,y1,z1)` relocates every agent inside the box. Tools call it after edits.
- **Player hooks:**
  - `panic(center:{x,z}, radius)`. For agents within the radius (weight w = 1−d/radius):
    - `panicUntil = tick + panicSec·(0.5+0.5w)·10`
    - each carried unit is lost with probability `tools.tap.cargoLoss`
    - `fright = max(fright, w)`
    - interrupt the agent
    
    Then emit `PANIC`.
  - `startRumor(agent, good, dir)` sets `rumor = {good, dir, strength:1, sinceTick}`, multiplies `beliefs[good]` by `whisper.bull` or `whisper.bear`, and emits `RUMOR`.
  - `gift(agent, amount)` adds `glim += amount` and records `('gift', amount)`.
- **`tickRumors`.** Rumour spread and decay follow §E.5.
- **`onDawn()`**, in this order:
  1. ledger-free skill update: +`gainPerDay` for the current profession and −`lossPerDay` for the others
  2. housing: unhoused agents, by glim descending, take `production.vacancy(agent)` then `claimBed`; otherwise `commissionHouse` if they qualify (§D.8)
  3. profession reviews with a shared ctx (§D.7)
  4. births (§D.9)
  5. emigration (§D.9)

#### G4: `src/economy/market.js`
`class Market`. Its constructor is `(sim, marketSites)`. It imports CONFIG, GOODS, TICKS, EV and `addItem`/`removeItem`/`freeCapacity` from agent.js.
- **Owned state.** `markets[m] = {site, books: {[good]: {bids: Order[], lots: Lot[]}}, P: {[good]}, last: {[good]: ClearResult}}`. Each P starts at `ref`.
- **Starter lots.** The market seeds estate lots (agentId −1, `ask = ref`, `floor = 0.5·ref`):
  - Dewside: berry 20, tablet 8, peat 6
  - Sunward: tablet 8, stone 10, quartz 8, log 6, amber 2, lantern 2
- **Price queries:**
  - `price(m, good)`
  - `avgPrice(good)`
  - `nearestMarket(agent) → m`: nearest by xz distance among the markets that are not blocked (`agent.marketBlockedUntil`). Falls back to the nearest overall.
- **Plaza queries:**
  - `marketAt(x, z) → m|null`: within the plaza bounds +1.
  - `isAtPlaza(agent, m)`: xz Chebyshev distance to the centre ≤ `plazaRadius + 1`.
- **Orders:**
  - `postBid(agent, m, good, qty, limit, purpose) → orderId|0`:
    - Requires `isAtPlaza`, `qty ≤ freeCapacity − pendingBidQty` and `qty·limit ≤ glim`.
    - Moves the amount from `glim` to `escrow` and increments `openBids`.
  - `consign(agent, m, good, qty, ask, floor) → lotId|0`:
    - Requires `isAtPlaza`.
    - Removes the items and merges them into the seller's existing lot for that (m, good), capped at `maxLotQty`, updating `ask` and `floor = min`.
  - `cancelBids(agent)` refunds escrow and zeroes `openBids`.
  - `onAgentRemoved(agent)` cancels the agent's bids and turns its lots into estate lots.
- **Book views:**
  - `getBook(m, good) → {bids, lots}` (read-only)
  - `getPiles(m) → {[good]: qtyOnLots}`
  - `getLastClear(m, good)`
  - `activeSeal(m, good) → Seal|null`, reading `sim.effects.seals` where `untilTick > tick`
- **`tick(sim)`:**
  - On `clock.isHourTick`, runs `clearAll()` (§D.4–D.6) for both markets.
  - Expires seals whose time has passed, removing them from `sim.effects.seals`.
  - Spoils lots older than `lotSpoilHours`, counting the units in `ledger.today.spoiled[good]`.
  - Emits `MARKET_CHIME` once per market.
- **Accounting calls:**
  - `sim.ledger.record('fee'|'estate', x)`
  - `sim.ledger.income(seller, x, 'sale')`
  - `sim.ledger.expense(buyer, x, purpose)`

#### G4: `src/economy/ledger.js`
`class Ledger`. Its constructor is `(sim)`. It listens to `MARKET_CHIME`, `AGENT_BORN`, `AGENT_DIED`, `AGENT_IMMIGRATED`, `AGENT_EMIGRATED` and `PLAYER_TOOL`.
- **Flows:**
  - `record(kind, amount)` adds to `today[kind]`. Sources are `mint`, `gift` and `immigration`. Sinks are `demurrage`, `fee`, `death`, `emigration` and `estate`.
  - `income(agent, amount, kind)` adds to `agent.earnedToday`.
  - `expense(agent, amount, purpose)` adds to `agent.inputsToday` if the purpose is `input` or `arbitrage`, and adds to `today.spend[purpose]`.
  - `stabilizer(kind, amount, message)` adds to `today.stab[kind]` and emits `STABILIZER` (which the ticker prints in grey). Kinds are `forage`, `immigrationFloor`, `wildSapling`, `bogAccretion`, `priceClamp`, `mossSpread`, `hazeFloor`.
- **Aggregates:**
  - `moneySupply()` is the sum over agents of `glim + escrow`, plus the `price` of every open project.
  - `M` is cached each hour.
  - `haze` is η = `clamp(1 − M/(hazeK·pop), hazeMin, 1)`, cached each hour.
  - `equilibriumM()` (§D.1)
  - `cpi()` (§D.10)
  - `gini()`
  - `lorenz(n=20) → Float32Array`
  - `guild() → {[prof]: {workers, actual, estimate, blended}}`, cached at newday
  - `meanY()`
- **Day record.** `today` and `yesterday` have the shape `{mint, gift, immigration, demurrage, fee, death, emigration, estate, spend: {[purpose]: n}, stab: {[kind]: n}, spoiled: {[good]: n}, births, deaths, starved, immigrants, emigrants, trades, volume}`. Every numeric field starts at 0.
- **`tick(sim)`:**
  - On its very first call, whatever the hour, computes `M` and `haze` and snapshots `M_start`.
  - On hour ticks, samples the history series listed below.
  - On newday ticks:
    - pushes each agent's `net = earnedToday − inputsToday` onto `netHistory` (keeping 3) and resets the counters
    - rebuilds `guild` with `estimate` from `sim.production.estimateIncome(prof)` and `actual` as the mean over workers of their mean last-2 net
    - runs the money audit: `M_end − M_start − (sources − sinks)`, with a `console.warn` if the drift exceeds 1 + 0.001·M
    - rolls `today` over to `yesterday` and pushes the daily series
- **History.**
  - Hourly ring (720 samples):
    - prices: `P:0:{good}`, `P:1:{good}`, `P:avg:{good}`, `V:{good}`
    - money: `M`, `Mstar`, `haze`, `mintH`, `burnH`
    - population: `pop`, `housed`, `towersLit`, `believers`, `prof:{prof}`
    - indices: `cpi`, `gini`
  - Daily ring (90 samples): `d:births`, `d:deaths`, `d:starved`, `d:immigrants`, `d:emigrants`, `d:mint`, `d:burn`.
  - `getSeries(name) → {ticks: number[], values: number[]}`, oldest first.
  - `markers: [{tick, tool, glyph, label}]`, appended on `PLAYER_TOOL`.

#### G4: `src/economy/production.js`
`class Production`, plus `export const RECIPES = CONFIG.production.recipes`. Its constructor is `(sim, worldInfo)`. It imports CONFIG, TICKS, B, templates, EV and the agent.js helpers.
- **Owned state:** `towers`, `houses` (from worldInfo), `projects`, `trees`, `bushTimers: Map<cellIndex, readyTick>` and `reservations: Map<key, {agentId, until}>`.
- **`tick(sim)`:**
  - Mints per tick (§D.1) by paying the operator and calling `ledger.record('mint', x)` and `ledger.income(op, x, 'mint')`. A tower is `active` iff its operator is alive, `op.tending === tower.id`, `lensQ > 0`, `clock.sun > 0` and `!isEclipsed(base)`.
  - Cracks lenses at `lensCracksAt`, setting `lensQ = 0` and emitting `TOWER_LENS`.
  - On hour ticks:
    - ripens bush timers (skipped while eclipsed, which adds 1 h)
    - expires lanterns (restoring the house slot block)
    - samples moss spread
    - grows saplings to trees when `matureAtTick` passes and the template space is clear (otherwise retry in 1 h)
  - On dawn:
    - converts footfall paths: MOSS with footfall ≥ `pathFootfall` becomes PATH, and PATH with 0 footfall for `pathDecayDays` becomes MOSS; footfall then resets
    - runs bog accretion and wild saplings, each through `ledger.stabilizer`
- **Towers:**
  - `claimTower(agent) → Tower|null` prefers unclaimed, non-eclipsed and nearest.
  - `releaseTower(agent)`
  - `towerOf(agentId)`
  - `towerAt(x,y,z) → id|null`
  - `installLens(tower, agent) → bool` consumes the lens and sets `lensQ` from skill (§D.1) and `lensCracksAt`.
  - `boostTower(id, hours)`
  - `isEclipsed(x, z)`
  - `mintRatePerHour(tower)`
  - `activeTowerCount()`
- **Crafting.** `craft(agent, recipeId) → bool` checks the inputs, swaps inputs for outputs, and updates `costBasis`. Location and duration are checked by brain.
- **Beds:**
  - `vacancy(agent) → House|null` returns the nearest house with a free bed.
  - `claimBed(agent, house)`
  - `releaseBed(agent)`
  - `houseOf(agentId)`
- **Commissions:**
  - `houseBudget()` and `towerBudget()` (§D.8)
  - `commissionHouse(agent) → Project|null` and `commissionTower(agent) → Project|null` find a site, move `price` from glim into the project and emit `PROJECT_COMMISSIONED`.
  - `findHouseSite(nearMarketId) → origin|null`: spiral out over `house.siteR`. It needs:
    - all 9 floor blocks in {MOSS, LOAM, PATH}, at the same height
    - air from y0 to y0+3
    - the approach cell walkable
    - a 1-cell margin from other structures, projects, towers and PAVING
    - a distance of at least 2 from tree trunks
    - the site inside the mask
  - `findTowerSite() → base|null`
- **Project work:**
  - `openProjects()`
  - `claimProject(agent)` takes the oldest open project.
  - `releaseProject(agent)`
  - `deliver(project, agent)` moves stone and log from the mason's inventory into `delivered`.
  - `nextBuildBlock(project)`
  - `buildNext(project, agent) → bool`:
    - Calls `world.set` and emits `AGENT_PLACED`.
    - When the last block is placed, completes the project: pays `price` to the mason (`ledger.income 'wage'`) and creates the House or Tower. The owner claims the bed, or operates the tower.
    - Then emits `PROJECT_DONE`.
  - `abandonProject(p)` refunds the owner. If the owner is dead, the money is burned as `death`.
- **Resources:**
  - `harvestBush(x,y,z, agent) → qty` sets BUSH_BARE, starts a timer and emits `AGENT_HARVEST`. The quantity is `floor(harvestYield·skill + rng())` for tenders and `forageYield` for everyone else. It is added with `addItem`, and any excess is lost.
  - `plantBush(x,y,z, agent) → bool`
  - `findPlantSite(x, z) → cell|null` finds a surface cell within 6 of water, with top in {MOSS, LOAM, PATH}.
  - `nearestMatureTree(x, z, maxDist, agentId)`
  - `fellTree(treeId, agent) → {logs, amber}` removes the LOG and NEEDLES blocks, places a SAPLING, schedules growth and emits `TREE_FELLED`.
- **Reservations:** `reserve(key, agentId, hours)` and `isReserved(key, agentId)`, where key = `"x,y,z"`.
- **Lanterns:**
  - `lightLantern(agent) → bool` moves one lantern from `inv` to `agent.lanterns`, with expiry `lanternLifeDays`. If the agent is housed, it sets the next free lantern slot to LANTERN.
  - `litLanterns() → [{x,y,z}]`
- **Estimates:** `estimateIncome(prof) → glim/day` (§D.7) and `subsistenceCost() → glim/day`.
- `onAgentRemoved(agent)` releases the agent's tower, bed and project. Its commission stays open; if it finishes, the house becomes a vacancy.

#### G5: `src/player/tools.js`
`class Tools`. Its constructor is `(sim, canvas)`. It imports CONFIG, B and EV.
- **Fields:**
  - `tools: [{id, name, hotkey, glyph, blurb}]`, with the ids `inspect cupped geode pane seal whisper tap magnifier pipette trowel`.
  - `active`
- **Methods:**
  - `setActive(id)` calls `renderer.setOrbitMode` and emits `TOOL_CHANGED`.
  - `update(realDt)` runs previews and hold-to-apply tools.
  - `dispose()`
- **Pointer events.** It listens to pointer events on the canvas. Picking uses `renderer.pickRay` → `world.raycast` for terrain, `agentRenderer.pick` for agents, `production.towerAt` for towers and `market.marketAt` for plazas.
- **Hotkeys:** `0` or `Esc` selects inspect, and `1`–`9` select tools in the order above. They are ignored while an input has focus.
- **Popovers.** Popovers render into `#popover` using the classes `.popover`, `.pop-row`, `.pop-btn`, `.pop-btn.on` and `.pop-slider`.
- **Side effects:** every application emits `PLAYER_TOOL`, and panes emit `SMUGGLE_BREACH` (details in §E).
- **Inspect tool:**
  - Clicking an agent emits `SELECT_AGENT`; double-clicking also emits `FOLLOW`.
  - Clicking a plaza emits `SELECT_MARKET`.
  - Clicking empty terrain clears the selection.

#### G6: UI (`hud.js`, `charts.js`, `inspector.js`, `ticker.js`, `ui.css`)
- Each module exports a class with the constructor `(sim)` and an `update(realDt)` method. Updates throttle themselves (HUD and inspector at `hudHz`, charts at `chartsHz`).
- The UI is DOM-only and uses canvases for charts. It reads the sim and writes only `sim.ui`, `sim.speed` and `sim.paused`, and emits UI events.
- The Ticker also exposes `post(text, kind, pos?)` and listens to `TICKER`.
- Layout and content are in §F.

#### INTEGRATOR: `src/main.js`
```js
import { CONFIG, TICKS } from './core/config.js'; import { createRng, parseSeed, randomSeed } from './core/rng.js';
import { EventBus, EV, SimClock } from './core/events.js'; import { World } from './world/world.js';
import { generateWorld } from './world/worldgen.js'; import { Pathfinder } from './agents/pathfinding.js';
import { Population } from './agents/population.js'; import { Market } from './economy/market.js';
import { Ledger } from './economy/ledger.js'; import { Production } from './economy/production.js';
// browser-only (dynamic import after headless check): Renderer, AgentRenderer, Fx, Tools, Hud, Charts, Inspector, Ticker

function createSim(seed, headless) {
  const events = new EventBus(), world = new World(CONFIG);
  const worldInfo = generateWorld(world, seed, CONFIG);
  const sim = { config: CONFIG, seed, headless, rng: createRng(seed ^ 0xA5A5A5A5), events,
    clock: new SimClock(CONFIG), world, worldInfo, effects: { eclipses: [], seals: [], panes: [], nextId: 1 },
    speed: 1, paused: false, lagging: false, ui: { /* §C.1 defaults */ } };
  sim.pathfinder = new Pathfinder(world, CONFIG);
  sim.ledger = new Ledger(sim);            // before market/production (they call ledger)
  sim.market = new Market(sim, worldInfo.markets);
  sim.production = new Production(sim, worldInfo);
  sim.population = new Population(sim);
  sim.population.spawnInitial(worldInfo);
  sim.pathfinder.refreshRegions(true);
  return sim;
}
function simTick(sim) {                    // fixed step, 1/TICKS.PER_SEC sim-seconds
  sim.clock.advance(sim.events);
  sim.pathfinder.processQueue();
  sim.population.tick(sim);
  sim.production.tick(sim);
  sim.market.tick(sim);                    // Chime on hour ticks
  sim.ledger.tick(sim);                    // samples AFTER the chime
}
```
- **Boot:**
  1. Parse `?seed`; if it is missing, use `randomSeed()` and `history.replaceState` to put it in the URL.
  2. Headless: run `simTick` in batches of 2,400 inside `setTimeout(0)` for `days` days. After each day, print a CSV line (`day,pop,M,cpi,gini,towersLit,P:avg:*`) to `console` and `#headless-log`. Assert the §G invariants.
  3. Browser:
     - Create `Renderer(canvas, sim)`, then `await renderer.buildAllChunks(p => loading.style.setProperty('--p', p))`.
     - Create `AgentRenderer(renderer.scene, sim)` and `Fx(renderer.scene, sim)`.
     - Create `Tools(sim, canvas)`, then Hud, Charts, Inspector and Ticker, and assign them all to `sim`.
     - Hide `#loading`.
- **Frame loop:**
```js
function frame(now) {
  const realDt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!sim.paused) acc += realDt * sim.speed;
  sim.pathfinder.beginFrame();
  const t0 = performance.now(); let n = 0;
  while (acc >= 1 / TICKS.PER_SEC && n < CONFIG.time.maxTicksPerFrame && performance.now() - t0 < CONFIG.time.simBudgetMs) {
    simTick(sim); acc -= 1 / TICKS.PER_SEC; n++; }
  sim.lagging = acc > 3 / TICKS.PER_SEC; if (sim.lagging) acc = Math.min(acc, 3 / TICKS.PER_SEC);
  const alpha = Math.min(1, acc * TICKS.PER_SEC);
  renderer.update(realDt, sim, alpha); agentRenderer.update(sim, alpha, renderer.camera); fx.update(realDt, sim);
  tools.update(realDt); hud.update(realDt); inspector.update(realDt); charts.update(realDt); ticker.update(realDt);
  renderer.render(); requestAnimationFrame(frame);
}
```
- **Event wiring:**
  - `SELECT_AGENT` → set `sim.ui.selectedAgentId`, call `agentRenderer.setSelected`, and call `fx.setPathLine(null)`. The inspector redraws the path.
  - `FOLLOW` → set `sim.ui.followAgentId` and call `renderer.setFollowTarget`.
  - `FLY_TO` → `renderer.flyTo`.
  - `REROLL` → `location.search = '?seed=' + hex`.
  - Window `resize` → `renderer.resize()`.
  - The first pointerdown resumes the AudioContext.

---

## D. Economy

### D.1 Money: glim
- **Money supply** is `M = Σ(glim + escrow) + Σ open-project price`.
- **Sources:**
  - `mint` from the towers
  - `immigration`: `immigrantGlim` each
  - `gift` from the Magnifier
- **Sinks:**
  - `demurrage`: 2%/day housed, 4%/day unhoused, applied continuously per tick
  - `fee`: 2% of each sale, paid by the seller
  - `death`: 50% of the dead agent's glim, or 100% if there is no heir
  - `emigration`: everything the emigrant carries
  - `estate`: proceeds of starter lots and dead agents' lots
- **Minting.** Per tick, each active tower pays its operator
  `mintPerHour · sun · lensQ · η · (boost? boostMul : 1) / PER_HOUR`,
  with haze factor `η = clamp(1 − M/(hazeK·pop), hazeMin, 1)`. That is 4 glim/hour at full sun.
- **Lenses.** `lensQ = 0.8 + 0.4·(skill − 0.6)/0.9`. A lens cracks after `lensLifeDays` (4).
- **Equilibrium.** `Mstar` (charted, dashed) solves `A·k·(1 − M/(hazeK·pop)) = r̄·M + feesYesterday`, where:
  - A is the number of lit towers
  - `k = mintPerHour·24/π` (π because the day-averaged sun factor is 1/π)
  - r̄ is the housed-weighted demurrage rate

  So `M* = (A·k − fees)/(r̄ + A·k/(hazeK·pop))`. Worked example: 6 towers, pop 60, r̄ = 2.8%, fees 14/day. Then k = 30.6 and A·k = 183, giving M* ≈ (183 − 14)/(0.028 + 0.0254) ≈ **3,160 glim**, or about 53 per head. Lenswright income at M* is about 14/day. The initial M is about 4,200, so expect a gentle early deflation.

### D.2 Needs and consumption
- **Food.** Tallow falls 35/day. A berry restores 12 and a tablet 40, so a Wickling needs about 0.9 tablets/day or 3 berries/day.
- **Food buying.** Agents buy food whenever `foodStock < foodTarget` (45). They choose the good with the lower `belief/tallow` (substitution).
- **Rest.** Sleep happens mostly at night. A cottage gives 15 rest/h; sleeping unhoused gives 9/h.
- **Lustre** (luxury demand) changes per day by −10 base, +5 if housed and +4 per lit lantern (up to 3, each lasting 8 days). So housed with 1 lantern is about −1/day, and unhoused with none is −10/day.

### D.3 Decision utilities (brain `decide`)
Let `t = tallow/100`, `r = rest/100` and `l = lustre/100`. Let λ be the marginal value of light, `λ = clamp(lambdaK/(glim + lambdaOff), 0.4, 2.5)`, so the poor value money more.
| Goal | Utility | Plan |
|---|---|---|
| sleep | `wSleep·(1−r)² + (night? nightSleep:0)`; −1 if r > 0.9; forced if rest < 8 | goto bed (if housed) → sleep until rest ≥ 95 or 06:00 |
| food | `wFood·(1−t)² + foodStockW·(1 − stock/foodTarget)`, only if `stock < foodTarget` and glim ≥ `forageCashMul·P_berry` | goto nearest market → trade(buy food, purpose food) |
| forage | same formula, when the agent is too poor or both markets are blocked | goto adjacent to the nearest unreserved BUSH_RIPE → harvest (`forageYield`) → eat; `ledger.stabilizer('forage')` |
| work | `workBase + workGain·λ·clamp(Ŷ_self/meanY, 0, 2) − (night? nightWork:0) − (no feasible job? noJobPenalty:0)` | the profession plan (§D.7b) |
| lantern | `wLantern·(1−l)² + lanternBase`, only if `glim > lanternCashMul·P_lantern`, fewer than 3 lit and fright < 0.3 | goto market → trade(buy 1 lantern, purpose luxury) |
| speculate | `speculateBase + speculateGain·rumor.strength`, only if a bull rumour, glim > 25 and holding < cap/2 | goto market → buy `floor(hoardFraction·glim/limit)` at `limit = belief` |
| dump | `dump`, only if a bear rumour or the rumour has lapsed while holding `spec` | goto market → consign the spec qty at `ask = 0.9·P`, `floor = 0` |
| sell | `sell`, only if non-reserved goods ≥ 0.7·cap | goto market → trade(sell) |
| idle | `idle` | wander 3–6 s near home or the plaza |

The current goal gets `+hysteresis`. While waiting for a Chime, agents wander within the plaza with anim `trade`.

### D.4 Order placement (brain `trade` step, at the plaza)
- **Beliefs.** The initial belief is `b = ref·U(0.8,1.2)`. On arrival at a plaza, every belief is pulled toward the local price: `b += visitPull·(P_m − b)`.
- **Consumer bid:**
  - `limit = b·(1 + urgencyGain·u)·(1 + frightGain·fright)`, where u = 1 − t for food and 1 − l for lanterns.
  - `qty = min(needQty, freeCap, floor(bidCashFrac·glim/limit))`. When tallow < 25, use `starvingCashFrac`.
- **Input bid** (derived demand):
  - `limit = min(1.15·b, 0.9·MRP)`.
  - For a recipe input i: `MRP_i = (Σ_out b_out·q_out − Σ_{j≠i} b_j·q_j)/q_i`.
  - For a lenswright's quartz: `MRP = (mintPerHour·24/π·η·lensLifeDays·q)/2·0.5`.
  - For a mason's stone and logs: `limit = 1.2·b`, because the commission reimburses them.
- **Porter bid:** `limit = min(1.05·P_a, 0.85·(1−fee)·P_b)`.
- **Ask:**
  - `ask = max(floor, b·(askMarkup − askSurplusCut·s))`, where `s = qty/carryCap`.
  - The floor depends on the good:
    - crafted goods: `craftFloorFrac·costBasis`
    - raw goods: `rawFloorFrac·b`
    - berries: 0 (perishable)
    - porter cargo: `1.02·cost`
    - dumps: 0
- **What agents bring to sell.** Agents consign every non-reserved good they carry. The reserved goods are:
  - their food up to `foodTarget`
  - recipe inputs for their own profession
  - mason materials for the current project
  - porter cargo, which is sold only at the destination
- **Leaving.** Agents with bids wait for the next Chime. After the Chime they leave, or re-bid (food only, at most `maxRebids`).

### D.5 The Chime: a uniform-price call auction (market `clearAll`, per market and good)
1. **Drop absent bidders.** Bids whose agent is no longer `isAtPlaza` are refunded and counted as unfilled.
2. **Apply seals.** Under a ceiling `c`, lots with `ask > c` are excluded and `p*` is capped at `c`. Under a floor `f`, bids with `limit < f` are excluded, asks are raised to `f` and `p*` is raised to `f`.
3. **Order the units.** Expand orders into units. Bids are sorted by limit descending (ties: earlier `postedTick`, then id). Asks are sorted by ascending price (ties: earlier, then id).
4. **Find the cut.** `k` is the largest count for which `bid_k ≥ ask_k`. The clearing price is `p* = (bid_k + ask_k)/2`, clamped by the seals. Every matched unit trades at `p*`.
5. **Settle each unit:**
   - The buyer does `addItem`. If it fails, refund that unit and count it as unfilled.
   - The buyer pays `p*` from escrow, and `limit − p*` is refunded.
   - `ledger.expense(buyer, p*, purpose)`
   - The seller gets `glim += p*(1−fee)` and `ledger.income(seller, …, 'sale')`.
   - `ledger.record('fee', p*·fee)`. Estate sellers' proceeds go to `ledger.record('estate', …)`.
6. **Finish bids.** Refund leftover escrow. Set `openBids = 0` and write `chimeResult` for every bidder.
7. **Update the public price P:**
   - If k > 0: `P ← (1−smoothing)·P + smoothing·p*`.
   - Else if there are only bids: `P ← P·noAskRise`.
   - Else if there are only lots: `P ← P·noBidDecay`.
   - Else (both exist but don't cross): `P ← P + crossPull·((bestBid + bestAsk)/2 − P)`.
   - Finally clamp P to `[clamp[0], clamp[1]]·ref`. A clamp hit records `ledger.stabilizer('priceClamp')`.
8. **Record** `last[good] = {price: p* or null, volume: k, bestBid, bestAsk, unfilledQty, unsoldQty, sealed}`.

### D.6 Belief learning (applied in clearing, and to absent sellers too)
- **Filled buyer:** `b += learnFill·(p* − b)`.
- **Unfilled buyer:** `b = min(b·unfilledBidMul, beliefClamp[1]·ref)`.
- **Filled seller:** `b += learnFill·(p* − b)`. If the whole lot sold, also `b ·= soldOutMul`.
- **Unsold lot:** `lot.ask = max(lot.floor, lot.ask·lotAskDecay)`, and the seller's `b = max(b·unsoldAskMul, beliefClamp[0]·ref)`.

This learning, combined with urgency-scaled bids and cost floors, is the price discovery mechanism. `ref` is used only for initialisation, clamps and scarcity colouring.

### D.7 Labour: the Guild Board and profession switching
**Estimates.** `estimateIncome(prof)` gives a theoretical income per day, using the average prices P̄ and the `CONFIG.production.est` values:
| Profession | Estimated income per day |
|---|---|
| tender | `tenderBerries·P̄berry` |
| chandler | `chandlerBatches·max(0, 2P̄tablet − 3P̄berry − P̄peat)` |
| delver | `delverQuartz·P̄quartz + delverStone·P̄stone + delverAmber·P̄amber` |
| woodwarden | `max(wardenLogs·P̄log, wardenPeat·P̄peat) + 0.3·P̄amber` |
| mason | `openProjects > 0 ? masonProjects·(mean open price − materials at P̄) : 0` |
| lenswright | `freeTower ? mintPerHour·24/π·η − 2P̄quartz/lensLifeDays : 0` |
| porter | `porterTrips·carry·max_g((1−fee)·maxP − minP)·0.5` |

**Blend.** `blended = w·actual + (1−w)·estimate`, with `w = min(1, workers/4)`. Empty niches therefore still advertise their potential.

**Review at dawn** (population builds `ctx` once per dawn):
- **Who reviews.** An agent reviews if `rng < reviewFrac`, or if its last net income was below `subsistenceCost()`. The latter are forced reviews and are processed first.
- **Candidate scores.** `score_p = blended_p·skill_p − (p ≠ current ? switchCostMul·subsistence : 0)`. The candidates exclude:
  - lenswright, unless a tower is free or can be commissioned
  - mason, unless open projects > masons
  - porter, unless the maximum spread (P_high/P_low) > 1.2
- **Choice.** Choose by softmax with temperature `T = max(1, softmaxTemp·meanY)`.
- **Limit.** At most `ceil(maxSwitchFrac·pop)` switches per dawn.

**Skills** rise by `gainPerDay` in the current profession and fall by `lossPerDay` in all others. This specialisation makes switching back slow, which produces cycles.

### D.7b Profession work plans (brain; each plan is one cycle and is re-decided afterwards)
- **Tender:**
  1. If holding ≥ 0.8·cap in berries, sell at the nearest market (usually Dewside).
  2. Otherwise harvest the nearest unreserved BUSH_RIPE within 40 (reserve it for 1 h), repeating until full.
  3. If none is found and the bush count is below `maxBushes`, plant up to 3 bushes at `findPlantSite`.
  4. Otherwise wander.
- **Chandler:**
  1. With ≥ 3 berries and 1 peat, go adjacent to the nearest kettle and craft tablets (×2 if the inputs allow).
  2. Else, if `P̄lantern ≥ 1.25·(P̄amber + P̄quartz + P̄tablet)` and the inputs are held, craft a lantern.
  3. Else, if a WAX_PUDDLE lies within 25, `scrape` it: goto adjacent, then `digBlock` (the registry yield is null) plus `addItem(agent, 'tablet', puddleTablets)`.
  4. Otherwise go to market to sell surplus tablets and lanterns and bid for inputs: 2 batches, plus lantern inputs if the lantern condition holds.
- **Delver:**
  1. If full, sell quartz, stone and amber.
  2. Otherwise gather candidates with `findNearestK(QUARTZ, 4, 40) ∪ findNearestK(AMBER, 2, 40)`, dropping reserved and blacklisted ones.
  3. Score them as `b_good/(10 + dist)` and take the best.
  4. Goto adjacentTo it with allowDig, then `dig` it. This carves 2-high tunnels, and the basalt dug along the way yields stone.
- **Woodwarden:**
  1. If full, sell.
  2. Otherwise choose the product with the higher `b/ref`, using the other one with probability 0.2.
  3. For logs: nearest mature tree → goto adjacent to the trunk base → fell (`fellPerLog`·height seconds).
  4. For peat: nearest exposed PEAT → dig it, repeating until full.
- **Mason:**
  1. Take a project from `claimProject` (or idle).
  2. Buy any missing stone and logs at the market nearest the site.
  3. Goto the site approach cell (radius 1) and `deliver`.
  4. Then `build` repeatedly, one block per `build` seconds, placing any block within `reach` (3). A house is 23 blocks and a tower is 4.
- **Lenswright:**
  1. Get a tower with `towerOf` or `claimTower`. If none is available: when glim ≥ 1.2·`towerBudget()` and the tower count is below max, `commissionTower`; otherwise the plan is infeasible.
  2. With no lens installed: install one if held; else craft a lens at the tower from 2 quartz; else buy 2 quartz.
  3. With a lens in daylight: goto the stand and `tend` (setting `agent.tending`) until sunset, the lens cracks or an interrupt.
  4. At night with quartz: craft a spare lens.
  5. Every dawn, if the tower is eclipsed and another tower is free, re-claim.
- **Porter:**
  1. With cargo: goto the `porter.to` market with **allowDig** (so porters tunnel when detours are long or panes block), then consign at `ask = max(0.98·P_to, 1.02·cost)`.
  2. Otherwise evaluate every (good, a→b) pair: `profit = cap·((1−fee)·P_b − 1.05·P_a)`. If the best exceeds `porterMinProfit`, goto a and buy up to cap, setting `agent.porter`. Otherwise idle near the market.

### D.8 Capital: cottages and towers
**Budgets:**
- `houseBudget = house.markup·(stone·P̄stone + log·P̄log) + house.laborDays·meanY`, about 61 glim at the start.
- `towerBudget` uses the same formula with the tower materials.

**Commissions:**
- **Who commissions a cottage.** At dawn, an unhoused agent with no vacancy available and `glim ≥ 1.2·houseBudget + 15` pays the budget into escrow, as long as there are fewer than `maxOpen` open projects.
- **Towers.** Lenswrights commission towers under the rule in §D.7b.
- **Payment.** The mason receives the full price on completion. The mason's profit is the price minus the materials it bought.
- **Completion.** Unhoused owners move in, and any spare bed becomes a vacancy. Vacant beds are free and go to the richest unhoused first. The owner of a tower becomes its operator.

### D.9 Life cycle
- **Births.** A birth is possible at dawn when the parent:
  - has tallow > 70, lustre > 55 and glim ≥ 60
  - is housed and older than 2 days
  
  The chance is `birthChance·(1 − pop/max)`. The child spawns at the home door and receives 30% of the parent's glim (a transfer). It starts with one profession review, and the parent gains +15 lustre.
- **Deaths:**
  - by age, when `ageDays ≥ lifespan` (9–12 days)
  - by starvation, after 1 day at tallow 0

  The body becomes a WAX_PUDDLE, which is recycled into 2 tablets by chandlers.
- **Emigration.** An agent emigrates after `lowDays ≥ emigrateDays` (3 dawns with lustre < 20 and glim < 15). It rides a moth out.
- **Immigration:**
  - If pop < `floor`: one immigrant every `floorEveryHours` (stabilizer, grey ticker line).
  - If the median real wage (net/P̄tablet) is ≥ 3, vacant beds ≥ 2 and pop < max: one immigrant every `prosperityEveryHours`.
  - Immigrants drop by moth onto a random plaza with `immigrantGlim`.

### D.10 Indices
- **Wax Index (CPI):** `100·Σw·P̄/Σw·ref`, with weights:

  | berry | tablet | peat | log | stone | quartz | amber | lantern |
  |---|---|---|---|---|---|---|---|
  | 3 | 1 | 0.3 | 0.2 | 0.3 | 0.2 | 0.05 | 0.1 |

- **Gini:** computed over glim + escrow.
- **Real wage:** median net income / P̄tablet.

### D.11 Stabilizers (all visible in the Gazette in grey and on the Lives tab's "stabilizers today" line)
| Stabilizer | Rule |
|---|---|
| Immigration floor | pop < 30 |
| Subsistence foraging | from wild bushes |
| Bush regrowth | 36 h, ×1.5 near water |
| Wild saplings | when trees < 18 |
| Bog accretion | 3 peat/day |
| Moss spread | exposed loam |
| Haze | η, with a floor of `hazeMin` |
| Price clamps | [0.2, 15]×ref |
| Belief clamps | [0.1, 20]×ref |
| Birth damping | `1 − pop/max` |
| Population cap | 110 |

The economics stays visible: none of these sets prices or professions directly.

### D.12 Emergent phenomena (causal chains QA should look for)
1. **Lens Rush and Haze Bust** (money cycle, about 5–8 days).
   - Low M → η high → lenswright Ŷ high.
   - → Agents switch, quartz bids rise and delvers join. Towers light up (beams), and new towers are commissioned on the ridge.
   - → M climbs, and the haze fog thickens.
   - → η falls, so lens income drops below other trades → lenswrights leave and towers go dark.
   - → Demurrage burns M down → repeat.
   - Visible in the Light chart (M against the dashed M*), the Labor chart and the ridge beams.
2. **Two-market spread and porters.**
   - Berries are cheap at Dewside (the farms) and quartz and stone are cheap at Sunward (the quarries).
   - → Porters haul both ways → the spread narrows toward travel cost.
   - A Glass Pane re-opens the spread → porters dig **smuggler tunnels** under it → the spread closes again.
3. **Dawn wax premium.** Tallow is lowest after the night → food bids spike at the first Chimes after 06:00 → an intraday price wave that chandlers' inventories damp.
4. **Berry hog cycle.** A high berry price draws tenders → harvests deplete ripe bushes and prices fall → tenders leave → bushes all re-ripen (visibly speckled flats) → shortage → price up. The period is about 3–4 days because bushes take 36 h to regrow.
5. **Housing ratchet and the lantern district.**
   - The unhoused pay double demurrage and rest slowly, so the poor get poorer.
   - The rich commission cottages → stone and log demand rises → wealthy cottages cluster near the markets and hang glowing lanterns.
   - Night makes the inequality visible, and the Gini rises.
   - Deaths free beds, and emigration of the poor lowers the Gini "for a bad reason". The emigration counter is shown beside the Lorenz curve.
6. **Luxury baby boom.** Cheap amber (from a Geode, or felling) → cheap lanterns → Lustre up → births → food demand up → berry price up → more tenders.
7. **Desire lines.** Footfall turns moss into PATH, which is faster → A* prefers it → more footfall. Roads emerge between homes, plazas, quarries and towers, and fade when abandoned.
8. **Rumour bubbles** (see §E.5). They are self-fulfilling in dense Chime crowds and bust when believers' cash runs out and the rumour's strength decays.

---

## E. Player interventions (the desk tools)
All tools:
- emit `PLAYER_TOOL {tool, label, glyph, pos, params}`, which the ledger stamps as a chart marker and the Gazette prints in gold
- use `fx.setPreview` while hovering
- use Shift+wheel to adjust brush size where applicable
- let Ctrl+click remove the tool's own effect (eclipse, pane, seal) at the cursor

| # | Tool (glyph) | Gesture | Exact state changes | Feedback | Expected adaptation |
|---|---|---|---|---|---|
| 1 | **Cupped Hand** (✋) | click terrain; Shift+wheel sets r 6–20 | push `effects.eclipses {x,z,r,untilTick: +1 day}` (max 3) → `production.isEclipsed` zeroes minting and pauses bush ripening under the disc | shadow disc on the terrain (shader), a hand silhouette above the jar, beams vanish | mint/hour drops → M falls below M* → deflation; lenswrights re-claim unshaded towers or switch; tenders harvest elsewhere |
| 2 | **Geode** (◆) | click terrain (cooldown `geode.cooldownSec`) | sphere r=2.6 centred 2 below the hit: QUARTZ (80%) or AMBER (20%), except for unbreakable, structure and water cells; `population.relocateInBox` | glint burst, "Geode!" text | quartz price down ≥ 30% at Sunward → cheap lenses and lanterns → Lustre and births up; delvers converge on the geode |
| 3 | **Glass Pane** (▮) | drag a line (max 64 cells); Shift = deep pane | for each Bresenham cell, set GLASS_WALL from `max(1, surfaceY−below)` (deep: y=1) up to `surfaceY+above`; store `prev` ids in `effects.panes`; `relocateInBox` | glass wall; cyan outline; "The jar is divided" | the regions split → agents trade at their own side's market → prices diverge. Porters' allowDig paths tunnel beneath (not for deep panes). On the first `AGENT_DUG` within 1 cell below or beside a pane's bottom, tools emit `SMUGGLE_BREACH` (once per pane) → "SMUGGLERS BREACH THE PANE" → the spread narrows. Ctrl+click restores the `prev` blocks. |
| 4 | **Wax Seal** (●) | click a plaza → popover: good, Ceiling/Floor, price slider `minMul`–`maxMul` × P | replace or push `effects.seals` (1 day) | red seal over the pad; board cell marked | a ceiling means shortages: unfilled bids, empty pads and porters diverting supply to the other market, and producers of that good lose income and switch. A floor means piles tower and bidders leave. |
| 5 | **Whisper** (❝) | click an agent → popover: good + Rising/Falling | `population.startRumor(agent, good, ±1)` | lilac flame; `RUMOR` headline | **Spread:** each sim-second, every believer with strength > `minStrength` converts non-believers within `spreadRadius` with probability `spreadChancePerSec·strength·(1−skepticism)`. The convert gets strength ×0.9 and its belief moves halfway to the believer's. **Behaviour:** bulls speculate (buy with `hoardFraction` of glim); bears dump and delay buying. **Decay:** strength falls by `decayPerDay`, and by `stallPenaltyPerDay` more if P̄ moved against the rumour over the last 6 h. The result is a bubble and bust. |
| 6 | **Tap the Glass** (≋) | press-hold on terrain; the radius grows from `minR` to `maxR` over `holdMin`–`holdMax` s; release | panic centre = the terrain hit's xz: `population.panic({x,z}, R)`; `renderer.shake(0.4)`; `fx.ripple` at that point projected radially onto the jar wall (r 57, hit y + 10) | ripple, Wicklings curl and roll downhill, dropped cargo | about a day of fear: food bids ×(1+0.5·fright), lanterns shunned, larger food stocks (hoarding). Staples up, luxuries down, and trade volume dips. |
| 7 | **Magnifier** (◎) | hold LMB | on an agent: `population.gift(agent, glimPerSec·dt)`; on a lens mount: `production.boostTower(id, boostHours)`; on terrain: scorch `scorchPerSec` random cells within `scorchRadius`, turning BUSH/SAPLING/NEEDLES to AIR and MOSS to LOAM | swelling flame / hot white dot, smoke | a gift is new money, so the favoured agent buys lanterns and a cottage and M rises; a boost gives a mint spike; scorching is a berry supply shock |
| 8 | **Dew Pipette** (💧) | click; Shift+wheel sets r 2–5 | for columns within r with `surfaceY ≤ hitSurfaceY`, bushes at the top become AIR, then WATER fills 1 layer at the surface; `relocateInBox` | ripples, drip particles | new wet zone: nearby bushes regrow ×1.5 and tenders plant there; a flooded path forces reroutes |
| 9 | **Trowel** (⛏) | LMB digs the hit block (repeat every `repeatSec`); Shift+LMB places LOAM on the hit face | `world.set`; forbidden on BEDROCK, KETTLE, LENS_MOUNT and GLASS_WALL, and placing into agents; `relocateInBox` | dust | agents repath and dig as needed; you can dam, bridge or isolate areas |

Tools do not tick sim state. Eclipse expiry is handled in production and seal expiry in market.

---

## F. UI layout and camera
```
┌──────────────────────────── #topbar (44px) ─────────────────────────────┐
│#tool│                                                  │ #marketboard   │
│tray │                3D canvas                         │ (320px)        │
│56px │                                                  ├────────────────┤
│     │ #gazette (bottom-left, 380px, 7 lines)           │ #inspector     │
├─────┴──────────────────────────────────────────────────┴────────────────┤
│ #drawer (210px, collapsible with G): tabs Prices · Labor · Light · Lives · Wealth │
└─────────────────────────────────────────────────────────────────────────┘
```
**Look.** The UI uses parchment #EFE6D2 cards with ink #1B1712 text and 1px brass #C9A45C rules. Headings use Google Font "IM Fell English SC" and numbers use "JetBrains Mono". There are small drop shadows. `H` hides the UI.

- **Topbar (hud).** Left to right:
  - a brass seed plate "Specimen No. 5A1F", with ⟳ (random re-roll) and an editable seed input (Enter emits `REROLL`)
  - the day dial: "Day 3 · 14:20" with a sun or moon glyph and the next-Chime countdown
  - speed buttons ⏸ 1× 2× 4× 8×, with the "lagging" badge when `sim.lagging` is set
  - stats:
    - Pop (housed/total)
    - Light M with a haze bar (1−η)
    - Wax Index
    - Gini
    - Towers lit (x/y)
  - toggles for mute, cutaway (C) and help (?)
- **Tool tray (hud).** Nine glyph buttons plus Inspect. Each has its hotkey badge and a tooltip in `#tooltip` built from `blurb`, naming what the tool stresses. The active tool is highlighted on `TOOL_CHANGED`.
- **Market board (hud).**
  - One row per good: swatch and name, Sunward P, Dewside P, Δ24h of P̄, a 24h sparkline (canvas), and pile qty S/D.
  - Each price cell is tinted on the scarcity scale by P/ref (≤ 0.7 glut, 1 balanced, ≥ 1.5 scarce, interpolated). Sealed cells show a red ●.
  - Clicking a row emits `SELECT_GOOD` and switches the drawer to Prices.
- **Charts (charts.js)** are hand-rolled canvases. They use DPR scaling, a time axis in days, a hover crosshair with values, a window selector (1d / 5d / all), and player-marker vertical lines with glyphs from `ledger.markers` on every tab.
  - **Prices:** `P:0:good` and `P:1:good` (log y, Sunward brass, Dewside teal #3E7C8C), volume bars `V:good` along the bottom, and a gap shading between the lines.
  - **Labor:** a stacked area of `prof:*` in apron colours.
  - **Light:** `M` (gold), dashed `Mstar`, `haze` on the right axis, and hourly `mintH` against `burnH` bars.
  - **Lives:** `pop` and `housed` lines; daily bars for births, deaths (starved hatched), immigrants and emigrants; plus a stabilizers-today line of text.
  - **Wealth:** the Lorenz curve (current), a `gini` line over time, a flame histogram (10 bins), and an emigrant count.
- **Inspector (inspector.js).**
  - **Agent view** (on `SELECT_AGENT`):
    - identity: name, apron chip, profession, age/lifespan, generation, "housed"/"unhoused"
    - money: glim (flame icon sized by wealth), escrow
    - needs: bars for tallow, rest and lustre
    - inventory chips and lit lanterns
    - skills (mini bars)
    - decision state: goal, the current step label and `thought`
    - the top-3 utilities as bars
    - a beliefs table: good, my belief, Sunward P, Dewside P, with ▲▼ colouring
    - earned today, and net for the last 3 days
    - rumour and fright badges
    - buttons: Follow (emits `FOLLOW`), Show path (`fx.setPathLine(agent.path)`, refreshed at 4 Hz) and Fly to
    
    If the agent dies, the panel shows its epitaph ("Guttered out, aged 10.2 days") and closes after 4 s.
  - **Market view** (on `SELECT_MARKET`): for each good, the depth ladder (top 5 bids and lots), the last clear, the seal, and a 24-Chime price strip.
- **Gazette (ticker.js).** Newest message on top, with `tickerVisible` visible and older lines fading. Each line has a day/time stamp and a colour by kind. Clicking a message with `pos` emits `FLY_TO`. The rules:
  - **Price move.** Hourly: if `|P̄/P̄_24h − 1| ≥ 0.30` (at most one per good per 12 h), print "Quartz rises to 11.4 (+62% in a day)". Add the cause: the largest profession-count change in 24 h ("— 4 Delvers left the ridge") or a player marker in the last 24 h ("— after the Geode").
  - **Labour.** When 3 or more `AGENT_PROFESSION` events into the same profession happen in one hour: "Three Tenders take up the chisel — delving pays 1.6× more".
  - **Dawn summary.** "Dawn, day 5: 2 kindled, 1 guttered out, 3 left on the moth".
  - **Projects.** `PROJECT_DONE`: "A cottage rises near Dewside for Tallowby Fenn". Towers get their own line.
  - **Towers.** When lit towers cross ≥ 5 to ≤ 2: "The ridge goes dark — lenses can't beat the haze". The reverse prints "Lens rush on the ridge".
  - **Smugglers.** `SMUGGLE_BREACH` prints as an alert: "SMUGGLERS BREACH THE PANE".
  - **Seals.** If a sealed good has unfilled qty ≥ 10: "Queues under the Wax Seal at Sunward: 14 leave empty-handed".
  - **Rumour.** `RUMOR` every 6 h while believers ≥ 5: "Whispers of rising Amber: 14 believers".
  - **Panic.** "PANIC! n Wicklings curl up near …".
  - **Stabilizers.** Grey lines from `STABILIZER`, aggregated per kind and printed at most once per 6 in-game hours with the summed amount (e.g. "Moss reclaimed 14 bare cells").
  - **Player actions.** Gold lines from `PLAYER_TOOL`.
- **Camera.** OrbitControls with damping.
  - Inspect mode: LMB orbits, RMB pans, the wheel zooms.
  - Tool mode: RMB orbits, Shift+RMB pans.
  - WASD pans and Q/E rotates.
  - `F` toggles following the selected agent. The camera target lerps to the agent at 6/s, and orbit keeps working.
  - Double-clicking an agent selects and follows it.
  - Gazette clicks fly the camera to the event.
  - `C` toggles the cutaway at the current target y.
- **Global keys (hud):**

  | Key | Action |
  |---|---|
  | Space | pause |
  | `[` `]` | speed down / up |
  | G | drawer |
  | H | hide UI |
  | M | mute |
  | C | cutaway |
  | F | follow |
  | P | debug (renderer) |

---

## G. Performance budgets and self-sustainability

**Performance budgets** (mid-range iGPU, 1080p, 60 fps target):
| Item | Budget / rule |
|---|---|
| Chunks | 16³, 196 total, 2 meshes each (opaque, transparent); empty meshes skipped; frustum culled by bounding sphere |
| Remesh | ≤ `remeshPerFrame` (3) per frame; a typical chunk ≤ 1.5 ms; `set()` marks neighbours only on borders |
| Initial meshing | ≤ 3 s total, with a progress bar |
| Sim ticks | 10 Hz fixed; ≤ `maxTicksPerFrame` (12) and ≤ `simBudgetMs` (10 ms) per frame, else `lagging` |
| Sim cost | ≤ 0.6 ms per tick at 110 agents, excluding pathfinding |
| Decisions | ≤ 12 `decide()` calls per tick |
| Pathfinding | ≤ 3 requests per tick and ≤ 3 ms per frame; node caps 4k / 12k; weighted A*; regions refresh ≤ every 2 sim-s |
| Market | clears only on Chime ticks; ≤ 1 ms per Chime |
| Agents | ≤ 110; 4 InstancedMeshes plus 2 Points = 6 draw calls total |
| Fx | pooled; 0 allocations per frame in steady state |
| Glowmap | 128², CPU splat ≤ 0.3 ms per frame |
| DOM | HUD and inspector 4 Hz; charts 1 Hz; sparklines only on the Chime |
| Draw calls | ≤ 450; shadow map 1024, auto-disabled by adaptive quality |
| Memory | world 800 KB plus regions 3.2 MB; no per-tick object churn in hot loops (use typed arrays and reuse vectors) |

**Self-sustainability safeguards:**
- **Stabilizers.** Everything in §D.11.
- **Stuck agents.** The watchdog repaths, then blacklists the target, then calls `population.relocate`.
- **Agents with no market.** If both markets are blocked for an agent, it forages and keeps working.
- **No tower operators.** Towers never hold glim themselves. If no one operates towers, lens income estimates rise until someone switches, and immigrants still bring glim.
- **Headless invariants.** Over 30 days at seed 5a1f plus 4 random seeds, all of these must hold:
  - `30 ≤ pop ≤ 110`
  - `M ≥ 10·pop`
  - no good's P̄ sits at a clamp for 24 consecutive hours
  - each of berry, tablet and quartz trades on ≥ 20 of the Chimes per day
  - the daily money-audit drift is < 1%
  - no agent has glim < 0 or negative inventory

  Tuning is done only in `CONFIG`.

---

## H. Acceptance checklist (QA, in the browser)
1. `node serve.mjs` and then opening the page loads with no console errors. A loading bar appears and the jar is visible within about 5 s.
2. The seed shows on the plinth plate and in the top bar. Reloading the same `?seed` gives identical terrain. ⟳ produces a new world and updates the URL.
3. A debug overlay (`P`) shows about 60 fps at 1× with 60+ agents on an integrated GPU. 8× runs smoothly, or shows the "lagging" badge.
4. Terrain has per-vertex AO (darker creases), vertex-coloured blocks, transparent water and glass, and glowing quartz and amber.
5. One day lasts 4 minutes at 1×. The sun sweeps east to west, and the glass flushes amber at dusk. At night the ground around Wicklings is lit by their flames, rich flames are larger and whiter, and lantern cottages glow.
6. Pause freezes all motion. 1×, 2×, 4× and 8× visibly accelerate the clock and agents.
7. Wicklings walk on the surface, step up and down one block, and never float or clip. No agent stays motionless in a `goto` for more than 60 s.
8. Delvers carve visible 2-high tunnels into the Sunward Ridge, and the cutaway (C) shows them.
9. Woodwardens fell trees, leaving saplings that regrow into trees in about 3 days. Tenders strip speckled bushes, which re-ripen, and plant new bushes near water.
10. Masons raise cottages block by block near the plazas within the first 2 in-game days. New towers can appear on the ridge.
11. On every in-game hour, arcs of light fly between buyers and sellers at both plazas. The market board updates. Pads visibly pile up with unsold goods and shrink when they sell.
12. Sunward and Dewside prices differ for berries and quartz. Purple-aproned porters haul between them, and the spread narrows over the following days.
13. Apron colours change over time. The Labor chart shows shifts, and the Gazette explains them with incomes.
14. Light chart: M, the dashed M*, and minted against burned amounts are visible. The haze fog thickens when M is high, and towers light and dim over days.
15. Left unattended for 30+ minutes at 8×, the population stays within 30–110 and M stays within 0.3–3× its initial value. Prices keep moving (not flat and not pinned), and there are no errors.
16. Cupped Hand over the ridge: beams under the disc die immediately and mint/h drops. Within 2 in-game days, lenswrights move to unshaded towers or switch, and the Gazette reports it.
17. Geode near Sunward: the Sunward quartz price falls at least 30% within an in-game day, delvers converge on the geode, and lantern prices soften.
18. A Glass Pane across the island makes the two price lines diverge within a day (the shaded gap). A porter tunnels under it and the "SMUGGLERS BREACH THE PANE" alert appears, after which the gap narrows. A deep pane (Shift) is never breached.
19. A Wax Seal ceiling on tablets at Dewside at 0.5× P produces unfilled-bid queues, an empty tablet pad and porters diverting tablets. The seal expires after one day.
20. Whisper "Rising amber" produces lilac flames that spread through Chime crowds. Amber rises at least 25% and then falls back as the rumour decays.
21. Tap the Glass: Wicklings in the radius curl, roll downhill and drop cargo. The glass ripples and the camera shakes. Staple prices rise and lantern purchases stop for about a day.
22. Magnifier on a Wickling swells its flame and raises M. The Pipette makes a pool that tenders farm around. The Trowel digs and places, and agents repath around the edits.
23. Clicking a Wickling opens the inspector with needs, glim, inventory, beliefs against both prices, the top-3 utilities, a thought sentence and path drawing. Follow keeps the camera on it. Clicking a plaza shows the depth ladders.
24. At least one causal Gazette headline appears per in-game day, and clicking one that has a location flies the camera there. Every player action appears as a marker on every chart tab.
25. `?headless=1&days=30` completes, prints 30 CSV lines and reports all invariants as passed.

---

## Appendix: `src/core/config.js` (exact starting values)
```js
export const TICKS = { PER_SEC: 10, PER_HOUR: 100, PER_DAY: 2400 };
export const GOODS = ['berry', 'tablet', 'peat', 'log', 'stone', 'quartz', 'amber', 'lantern'];
export const ITEMS = [...GOODS, 'lens'];
export const PROFESSIONS = ['tender', 'chandler', 'delver', 'woodwarden', 'mason', 'lenswright', 'porter'];
export const CONFIG = {
  world: { SX: 112, SY: 64, SZ: 112, CHUNK: 16, CX: 56, CZ: 56, RADIUS: 54, WATER_LEVEL: 12 },
  time: { startHour: 7, speeds: [0, 1, 2, 4, 8], maxTicksPerFrame: 12, simBudgetMs: 10 },
  worldgen: { baseHeight: 16, hillAmp: 7, ridgeAmp: 16, ridgeStartX: 74, pond: { x: 26, z: 62, r: 11, depth: 6 },
    bogRing: [2, 8], marketSites: [{ x: 76, z: 58 }, { x: 40, z: 52 }], siteJitter: 4, plazaHalf: 4,
    towers: 6, houses: 16, trees: 34, bushes: 90, quartzVein: 0.64, amberChance: 0.004, rimStart: 50,
    maxSlope: 1, loamDepth: [3, 5] },
  goods: {
    berry:   { name: 'Waxberry',      color: '#F2E6C8', ref: 2,  tallow: 12, lotSpoilHours: 36, invSpoilPerDay: 0.15 },
    tablet:  { name: 'Wax Tablet',    color: '#F4D58D', ref: 7,  tallow: 40, lotSpoilHours: 96, invSpoilPerDay: 0.03 },
    peat:    { name: 'Peat',          color: '#2B1E18', ref: 3 },
    log:     { name: 'Resinpine Log', color: '#5A3B2A', ref: 5 },
    stone:   { name: 'Basalt Stone',  color: '#7A7684', ref: 3 },
    quartz:  { name: 'Quartz',        color: '#DDEFF5', ref: 6 },
    amber:   { name: 'Amber',         color: '#E8961E', ref: 12 },
    lantern: { name: 'Amber Lantern', color: '#F2A93B', ref: 34 } },
  professions: {
    tender: { name: 'Tender', color: '#6FA35A', carry: 6 },  chandler: { name: 'Chandler', color: '#D9A441', carry: 6 },
    delver: { name: 'Delver', color: '#5B6477', carry: 6 },  woodwarden: { name: 'Woodwarden', color: '#4E6B3A', carry: 8 },
    mason: { name: 'Mason', color: '#B5654A', carry: 12 },   lenswright: { name: 'Lenswright', color: '#6FD3E8', carry: 6 },
    porter: { name: 'Porter', color: '#8A5A9E', carry: 12 } },
  agent: { speed: 2.6, fastFloorMul: 1.3, hungryMul: 0.6, loadedMul: 0.85, climbSec: 0.15, fallSpeed: 8,
    tallowPerDay: 35, tallowSleepPerDay: 20, restPerDay: 60, restPerHourHoused: 15, restPerHourUnhoused: 9,
    lustrePerDay: 10, lustreHousedPerDay: 5, lustrePerLanternPerDay: 4, maxLanterns: 3, lanternLifeDays: 8,
    hungry: 25, eatBelow: 55, starveDays: 1, foodTarget: 45, lifespanDays: [9, 12], initialAgeDays: [0, 7],
    childScaleDays: 0.5, reach: 3, panicSec: 15, rollSteps: 8, frightDecayPerDay: 1, stuckSec: 20, maxRepaths: 3,
    act: { harvest: 2, plant: 2, fellPerLog: 1.2, build: 0.8, installLens: 2, eat: 1, scrape: 3 },
    skill: { min: 0.6, max: 1.5, gainPerDay: 0.03, lossPerDay: 0.01 } },
  brain: { decisionsPerTick: 12, hysteresis: 0.15, wSleep: 1.0, nightSleep: 0.45, wFood: 1.3, foodStockW: 0.35,
    workBase: 0.3, workGain: 0.35, nightWork: 0.25, noJobPenalty: 0.3, wLantern: 0.8, lanternBase: 0.1,
    lanternCashMul: 2.5, speculateBase: 0.35, speculateGain: 0.4, dump: 0.5, sell: 0.6, idle: 0.05,
    lambdaK: 60, lambdaOff: 20, forageCashMul: 3, porterMinProfit: 6, blacklistHours: 24 },
  market: { plazaRadius: 4, fee: 0.02, smoothing: 0.4, noBidDecay: 0.98, noAskRise: 1.04, crossPull: 0.2,
    clamp: [0.2, 15], lotAskDecay: 0.96, maxLotQty: 20, bidCashFrac: 0.4, starvingCashFrac: 0.8,
    urgencyGain: 0.8, frightGain: 0.5, learnFill: 0.3, unfilledBidMul: 1.08, unsoldAskMul: 0.98, soldOutMul: 1.02,
    visitPull: 0.05, beliefClamp: [0.1, 20], askMarkup: 1.1, askSurplusCut: 0.25, rawFloorFrac: 0.25,
    craftFloorFrac: 0.9, maxRebids: 2, maxArcs: 60 },
  money: { demurrageHoused: 0.02, demurrageUnhoused: 0.04, mintPerHour: 4.0, hazeK: 120, hazeMin: 0.1,
    lensLifeDays: 4, deathBurn: 0.5, startGlim: [40, 100], immigrantGlim: 25 },
  production: { bushRegrowHours: 36, waterMul: 1.5, waterRadius: 3, maxBushes: 240, harvestYield: 2, forageYield: 2,
    saplingDays: 3, treeHeight: [4, 7], treeAmberChance: 0.3, minTrees: 18, wildSaplings: 2, peatAccretion: 3,
    mossSamplesPerHour: 150, mossChance: 0.15, pathFootfall: 25, pathDecayDays: 3, basaltStoneChance: 0.5,
    puddleTablets: 2,
    house: { stone: 8, log: 4, markup: 1.25, laborDays: 0.5, maxOpen: 6, siteR: [5, 30], capacity: 2 },
    tower: { stone: 8, log: 1, markup: 1.25, laborDays: 0.3, max: 12, minSpacing: 4, minX: 66 },
    est: { tenderBerries: 18, chandlerBatches: 4, delverQuartz: 6, delverStone: 5, delverAmber: 0.4,
      wardenLogs: 9, wardenPeat: 10, masonProjects: 1, porterTrips: 3 },
    recipes: {
      tablet:  { in: { berry: 3, peat: 1 }, out: { tablet: 2 }, sec: 8, station: 'kettle', prof: 'chandler' },
      lantern: { in: { amber: 1, quartz: 1, tablet: 1 }, out: { lantern: 1 }, sec: 5, station: 'kettle', prof: 'chandler' },
      lens:    { in: { quartz: 2 }, out: { lens: 1 }, sec: 10, station: 'tower', prof: 'lenswright' } } },
  population: { initial: 60, max: 110, floor: 30, floorEveryHours: 2, prosperityEveryHours: 6,
    prosperityRealWage: 3, prosperityVacancy: 2, birthChance: 0.35, birthTallow: 70, birthLustre: 55,
    birthGlim: 60, birthGlimShare: 0.3, birthLustreBonus: 15, birthMinAgeDays: 2, emigrateLustre: 20,
    emigrateGlim: 15, emigrateDays: 3, reviewFrac: 0.25, switchCostMul: 1.0, softmaxTemp: 0.15,
    maxSwitchFrac: 0.1,
    initialProf: { tender: 17, chandler: 9, delver: 9, woodwarden: 8, mason: 5, lenswright: 6, porter: 6 } },
  path: { requestsPerTick: 3, frameBudgetMs: 3, maxNodes: 4000, maxNodesDig: 12000, wNormal: 1.2, wDig: 2.0,
    fastFloorCost: 0.75, climbCost: 0.3, digPenalty: { delver: 3, porter: 6, default: 8 }, detourFactor: 2.5,
    regionRefreshSec: 2, resultTTLTicks: 600 },
  render: { remeshPerFrame: 3, shadowMap: 1024, maxPixelRatio: 1.5, fov: 50, glowmapSize: 128, glowRadius: 4,
    flameBase: 0.12, flameK: 0.07, fog: [0.0012, 0.006], adaptiveSlowMs: 20, adaptiveSec: 2, arcSec: 1.2,
    jar: { radius: 57, height: 50 },
    camera: { target: [56, 18, 56], pos: [140, 75, 140], minDist: 10, maxDist: 190 } },
  ui: { hudHz: 4, chartsHz: 1, tickerMax: 40, tickerVisible: 7, drawerHeight: 210 },
  tools: {
    eclipse: { radius: 12, minR: 6, maxR: 20, durationDays: 1, max: 3 },
    geode: { radius: 2.6, quartzFrac: 0.8, depth: 2, cooldownSec: 20 },
    pane: { maxLen: 64, above: 5, below: 5, max: 4 },
    seal: { durationDays: 1, minMul: 0.25, maxMul: 4 },
    whisper: { bull: 2.5, bear: 0.4, spreadRadius: 3, spreadChancePerSec: 0.05, decayPerDay: 0.3,
      stallPenaltyPerDay: 0.2, minStrength: 0.15, hoardFraction: 0.4 },
    tap: { minR: 15, maxR: 60, holdMin: 0.2, holdMax: 1.5, cargoLoss: 0.5 },
    magnifier: { glimPerSec: 20, scorchRadius: 2, scorchPerSec: 4, boostMul: 3, boostHours: 1 },
    pipette: { radius: 3, minR: 2, maxR: 5 },
    trowel: { repeatSec: 0.15 } } };
```
