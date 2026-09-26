# Wickmarket — A Candlelight Economy Under Glass

A self-running voxel world in your browser. Little wax people called **Wicklings** — their heads are burning wicks — live on an island inside a glass jar on a desk. They farm, mine, cut wood, build and trade in an economy where **money is light**: a Wickling's flame *is* its wallet, so at night the island is lit only by its wealth.

You watch from outside the glass. Ten tools let you shade the sun, spread rumors, limit prices, split the jar with glass walls or knock on it to start a panic — and then see how the Wicklings adapt. With **clans**, several kinds of Wicklings share the jar: tear down the walls between them and they trade, make friends — or go to war.

The game speaks **English** and **Hungarian (Magyar)**; switch any time with the **EN/HU** button.

## Run it

**Play online:** <https://posfay.github.io/wickmarket/>

**Easiest — one file, no install:** open `dist/wickmarket.html` in Chrome, Edge or Firefox (double-click it).
It needs an internet connection the first time, for Three.js (jsDelivr CDN) and the fonts.

**From source (for hacking):**

```bash
node serve.mjs
```

then open <http://localhost:5173/>. (ES modules need `http://`, so opening `index.html` directly will not work — use the dist file for that.)
Any Node ≥ 18 works; there are no npm dependencies. `node scripts/build-standalone.mjs` rebuilds `dist/wickmarket.html` after you change the source.

The page opens on a **title screen**: *Continue* your last game, start a *New world* (choose the clans), a *Quick start* (the classic one-clan jar), or open a save file.

URL parameters: `?seed=<hex or any word>[&setup=…]` makes a world at once (the menu's *Copy world link* builds these), `?load=<slot>` / `?resume` continue a saved game, `?lang=hu` starts in Hungarian, `?headless=1&days=30[&clans=3&walls=down]` runs the economy without graphics.

## Saving and loading

* **Autosave:** every 2 minutes, and whenever you close or leave the page. Opening the page again offers *Continue*; a page refresh continues right away.
* **Menu (☰):** save under a name, load or delete saves, **download a save file** (`.wmsave`) and **open a save file** — to keep a game or move it to another computer.
* **Quick save:** **Ctrl+S**.
* Saves live in the browser's own storage (IndexedDB, or localStorage when that is unavailable). Starting a new world never overwrites the last one: the previous world's autosave is kept as *Autosave (previous world)*.
* A save holds the whole world: every block, every Wickling (money, goods, needs, beliefs, family), the markets' prices and goods for sale, buildings and building sites, trees and bushes, the charts' history, the news, the clans' walls, laws and relations, your price limits, shades and glass walls, even the camera. Only what each Wickling is doing *this second* is not kept — after loading they all decide again (a second later everyone is back at work), and no light is lost.

## Clans

When you make a new world you choose **1 to 6 clans**. Each clan is its own kind of Wickling: its own color (wax and flag), names, land, market, towers and houses.

* **Walls.** *Apart*: glass walls divide the jar into one slice per clan, each with its own economy. *Together*: no walls. Tear down or rebuild any wall at any time — click it with **Look**, or use the **clan council (K)**.
* **Laws** (can change during the game, in the council): *Temper* (peaceful / normal / warlike), *Money fading* (slow / normal / fast), *Sharing* (every morning part of everyone's light is split equally), *Trade with others* (open / border tax / closed), *Family size*.
* **Traits** (fixed when the world is made): *Size*, *Starting money* (poor / normal / rich) and a *Talent* (the clan is born good at one job, and more of its members do it).
* **Friends and enemies.** Clans that can reach each other trade at each other's markets (trading makes them friends), compete for land (working on another clan's land makes them angry) and start to scuffle when angry. At **war** they fight on sight, rob the loser and may snuff them out; a warlike clan also works on enemy land. Walls and time cool things down, and the council's ☮ / ⚔ buttons let you push two clans toward peace or anger.
* The price board gets one column per clan market, the charts get a **Clans** tab (size, money, Gini and relations over time), and the news reports wars, peace, fights and first trades.

A one-clan world is the classic jar (the default); its laws can still be changed with **K**.

## What you are watching

| | |
|---|---|
| **Light is money** | New light is made only by **towers**, while a tower keeper works there in sunlight. Light fades (2 % a day, 4 % without a home), each sale costs a 2 % fee, and part of it is lost when a Wickling dies. The more light exists, the thicker the golden **haze** and the less light the towers make. |
| **The market bell** | Every in-game hour each market rings its bell and runs an auction for all 8 goods: everything that can be sold is sold at one fair price. Every trade fires an **arc of light** from buyer to seller. Unsold goods pile up at the market. |
| **Needs** | *Food* (berries or bread; hungry Wicklings look stubby), *Energy* (sleep, better in a home), *Happiness* (a home and lit lanterns). Happy Wicklings with a home have children; unhappy, poor ones leave. |
| **Goods** | Berries · Bread (3 berries + 1 fuel) · Fuel · Wood · Stone · Crystal · Amber · Lantern (amber + crystal + bread). Tower keepers make lenses from crystal. |
| **Seven jobs** | Farmers (berry bushes), Crafters (bread and lanterns at the market kettles), Miners (dig the rocky hill for crystal, amber and stone), Woodcutters (trees and fuel), Builders (houses and towers, block by block), Tower keepers (make light), Traders (carry goods to where they sell for more — and dig smuggler tunnels). |

### How the economy works

* **Prices are discovered, not set.** Every Wickling has its own idea of what each good is worth. It offers up to that (more when hungry or scared) and asks a bit more when it sells. After each bell, buyers and sellers who traded move their idea toward the price, unlucky buyers raise it, sellers with leftovers lower it.
* **Work follows money.** Every morning Wicklings look at what each job earns (the *Jobs* chart) and some switch, losing a little skill. The news tells you why ("mining pays 1.6× more").
* **Building.** Rich Wicklings without a home order a house; tower keepers without a tower order one. Builders buy stone and wood, carry them to the site and place every block.
* **Nothing is hidden.** Bushes regrow, cut trees leave saplings, the swamp makes new fuel, moss grows back, paths wear into the ground where Wicklings walk. Every safety net (newcomers when the jar gets empty, wild berries, price limits) prints a grey line in the news.

### Things to look for

* **Tower rush and haze bust** — little light → tower keeping pays → new towers → the haze thickens → towers make less → keepers quit (Money chart: light vs the dashed balance point).
* **Price gaps** — berries cheap at one market, crystal at the other; traders carry goods until the gap closes.
* **Gluts** — too much of a good piles up, its price sags, its makers change jobs.
* **Rumor bubbles and panics** — rumors spread at the markets; believers hoard, prices overshoot, then crash.
* **Clan politics** — tear a wall down and watch prices even out, then the first trades, then the first quarrel.

## Your tools

Pick with the tool tray or keys **1–9** (**0** / **Esc** = Look). Hover shows a preview; **Shift + wheel** changes brush size; **Ctrl + click** removes your own change.

| Key | Tool | Gesture | What happens |
|---|---|---|---|
| 0 | ⌕ **Look** | click | Details of a Wickling (needs, money, what it thinks and why), a market's offers, or a clan wall (tear it down / build it). |
| 1 | ✋ **Shade** | click the ground | Covers part of the island from the sun for a day: towers there make no light, bushes stop ripening. |
| 2 | ◆ **Crystals** | click the ground | Hides a ball of crystal and amber → crystal gets cheap, miners rush in, lanterns get cheap. |
| 3 | ▮ **Glass wall** | drag a line (Shift = deep) | Splits the island → two separate economies whose prices drift apart… until traders dig under it. Deep walls cannot be dug under. |
| 4 | ● **Price limit** | click a market → good, highest/lowest, price | Too low: long lines and empty stalls. Too high: goods pile up. Lasts a day. |
| 5 | ❝ **Rumor** | click a Wickling → good, expensive/cheap | Starts a rumor (purple flame) that spreads → bubble and crash. |
| 6 | ≋ **Knock** | press, hold, release | Panic: Wicklings curl up and roll away, drop what they carry, then hoard food for a day. |
| 7 | ◎ **Magnifier** | hold on a Wickling / tower / ground | Give light (new money), make a tower work faster, or burn plants. |
| 8 | 💧 **Water** | click | A pool: wet land for bushes, flooded paths to walk around. |
| 9 | ⛏ **Shovel** | click digs, Shift+click adds soil | Dams, bridges and detours — Wicklings find new ways and dig around your changes. |

Everything you do leaves a gold mark on every chart and a gold line in the news.

## Controls

* **Camera:** left-drag turns (Look) or right-drag (other tools) · right-drag / Shift+right-drag moves · wheel zooms · **WASD** move · **Q/E** turn · **C** cut view (see the tunnels) · **F** follow the selected Wickling.
* **Click a Wickling** for its details; double-click to follow. **Click a market** for its offers.
* **Space** pause · **[ ]** speed (1×–8×) · **G** charts · **H** hide everything · **M** bell sound · **K** clan council · **Ctrl+S** quick save · **☰** menu · **P** performance numbers · **?** help.
* **News:** click a line with ⌖ to fly there.

## Checks

```bash
node scripts/headless.mjs --days 30 --seeds 5a1f,1,2,3
node scripts/headless.mjs --days 25 --seeds 7 --clans 4 --tear 5 --temper warlike
node scripts/savetest.mjs --seeds 5a1f,2 --clans 1,3
node scripts/i18ncheck.mjs
```

* `headless.mjs` runs the full economy without graphics (~0.2 ms per tick) and checks each day that the population stays in bounds, money stays liquid, **the money audit balances** (every bit of light made, given, lost or carried out is recorded), the staple goods keep trading and no staple sits stuck at a price limit. With clans (`--clans N`, `--walls down`, `--tear <day>`, `--temper <t>`) it adds each clan's size, money, prices, relations and fights. The same seed always gives the same run.
* `savetest.mjs` saves a running world, loads it, saves it again (the two files must be identical), checks the money supply is unchanged and runs the loaded world on with the money audit checked.
* `i18ncheck.mjs` checks that English and Hungarian have the same texts, that every text the code uses exists, and that every text renders.

## Project layout

```
index.html, styles.css        page shell (Three.js r170 from CDN via import map)
src/main.js, src/sim.js        boot (title screen, new or saved world, autosave) + loop (10 ticks/s) / sim assembly
src/core/                      config.js (every tunable), rng.js, events.js, i18n.js + lang/en.js, lang/hu.js,
                               save.js (whole-world save files), codec.js (base64, run-length, gzip)
src/world/                     blocks.js, world.js (voxels, raycast), worldgen.js, worldgenClans.js (clan slices, walls)
src/agents/                    agent.js (body), brain.js (decisions + plans), population.js, pathfinding.js
src/economy/                   market.js (auctions), ledger.js (money, stats, history), production.js (towers, building,
                               nature), clans.js (clans, walls, laws, relations, fights)
src/render/                    renderer.js (jar, lights, glow), chunkMesher.js, agentRenderer.js, fx.js
src/player/tools.js            the ten tools
src/ui/                        hud.js, charts.js, inspector.js, ticker.js (news), menu.js (title, menu, new world),
                               council.js (clans), saves.js (save slots, files), place.js, ui.css
docs/SPEC.md                   the original design and module contract (uses the original names)
```

All tuning lives in `src/core/config.js`; all player-facing text lives in `src/core/lang/`.
