// Wickmarket tunables (SPEC Appendix). Pure data: no imports, no logic.
// Every tunable number in the codebase is read from here. The Appendix literal is reproduced
// verbatim; keys added beyond it are grouped at the end of their section under "additions".

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
    maxSlope: 1, loamDepth: [3, 5],
    // additions (G1): worldgen shaping and robustness knobs
    pondBlend: 8,            // cells beyond pond.r over which the terrain eases down to the water level
    roadHalfWidth: 1,        // road = centre line ± this many cells
    ridgeSteepRidged: 0.7,   // ridged2 above this (x > ridgeStartX) allows slope 2 and exposes bare rock
    quartzMinX: 60,          // quartz only east of this x
    quartzNearDepth: 12,     // "near-surface" band used to guarantee diggable quartz
    quartzMinNear: 320,      // at least this many quartz cells inside the near-surface band
    quartzVeinFloor: 0.4,    // the vein threshold is never lowered below this
    amberMaxY: 14,           // amber only below this y
    houseR: [5, 18],         // house centre distance from its plaza centre
    houseRFallback: 26,      // widened search when a plaza has no room within houseR
    towerPlazaClear: 7,      // towers keep at least this far from plaza centres
    towerSpreadSpacing: 8,   // first-pass tower spacing (falls back to tower.minSpacing)
    treeSpacing: 4,          // Poisson spacing between trunks
    groveScale: 22,          // noise scale of resinpine groves
    bushPondBand: 14,        // "near the pond": within this many cells of the pond edge
    bushNearPondFrac: 0.7,   // share of bushes placed near the pond
    bushRipeFrac: 0.7,       // share of bushes that start ripe
    spawnR: 12 },            // spawn cells within this distance of a plaza centre
  goods: {
    berry:   { name: 'Waxberry',      color: '#F2E6C8', ref: 2,  tallow: 12, lotSpoilHours: 36, invSpoilPerDay: 0.15 },
    tablet:  { name: 'Wax Tablet',    color: '#F4D58D', ref: 7,  tallow: 40, lotSpoilHours: 96, invSpoilPerDay: 0.03 },
    peat:    { name: 'Peat',          color: '#2B1E18', ref: 3, lotSpoilHours: 72 },
    log:     { name: 'Resinpine Log', color: '#5A3B2A', ref: 5, lotSpoilHours: 120 },
    stone:   { name: 'Basalt Stone',  color: '#7A7684', ref: 3, lotSpoilHours: 144 },
    quartz:  { name: 'Quartz',        color: '#DDEFF5', ref: 6, lotSpoilHours: 144 },
    amber:   { name: 'Amber',         color: '#E8961E', ref: 12, lotSpoilHours: 192 },
    lantern: { name: 'Amber Lantern', color: '#F2A93B', ref: 34, lotSpoilHours: 240 } },
  professions: {
    tender: { name: 'Tender', color: '#6FA35A', carry: 6 },  chandler: { name: 'Chandler', color: '#D9A441', carry: 6 },
    delver: { name: 'Delver', color: '#5B6477', carry: 6 },  woodwarden: { name: 'Woodwarden', color: '#4E6B3A', carry: 8 },
    mason: { name: 'Mason', color: '#B5654A', carry: 12 },   lenswright: { name: 'Lenswright', color: '#6FD3E8', carry: 6 },
    porter: { name: 'Porter', color: '#8A5A9E', carry: 12 } },
  agent: { speed: 2.6, fastFloorMul: 1.3, hungryMul: 0.6, loadedMul: 0.85, climbSec: 0.15, fallSpeed: 8,
    tallowPerDay: 45, tallowSleepPerDay: 24, restPerDay: 60, restPerHourHoused: 15, restPerHourUnhoused: 9,
    lustrePerDay: 6, lustreHousedPerDay: 5, lustrePerLanternPerDay: 4, maxLanterns: 3, lanternLifeDays: 8,
    hungry: 25, eatBelow: 55, starveDays: 1, foodTarget: 45, lifespanDays: [12, 16], initialAgeDays: [0, 10],
    childScaleDays: 0.5, reach: 3, panicSec: 15, rollSteps: 8, frightDecayPerDay: 1, stuckSec: 20, maxRepaths: 3,
    act: { harvest: 2, plant: 2, fellPerLog: 1.2, build: 0.8, installLens: 2, eat: 1, scrape: 3 },
    skill: { min: 0.6, max: 1.5, gainPerDay: 0.03, lossPerDay: 0.01 } },
  brain: { decisionsPerTick: 12, hysteresis: 0.15, wSleep: 1.0, nightSleep: 0.45, wFood: 1.3, foodStockW: 0.35,
    workBase: 0.3, workGain: 0.35, nightWork: 0.25, noJobPenalty: 0.3, wLantern: 0.8, lanternBase: 0.1,
    lanternCashMul: 2.5, speculateBase: 0.35, speculateGain: 0.4, dump: 0.5, sell: 0.6, idle: 0.05,
    lambdaK: 60, lambdaOff: 20, forageCashMul: 3, porterMinProfit: 6, blacklistHours: 24,
    berryBulk: 1.3 },
  market: { plazaRadius: 4, fee: 0.02, smoothing: 0.4, noBidDecay: 0.98, noAskRise: 1.04, crossPull: 0.2,
    clamp: [0.2, 15], lotAskDecay: 0.96, maxLotQty: 20, bidCashFrac: 0.4, starvingCashFrac: 0.8,
    urgencyGain: 0.8, frightGain: 0.5, learnFill: 0.3, unfilledBidMul: 1.08, unsoldAskMul: 0.98, soldOutMul: 1.02,
    visitPull: 0.05, beliefClamp: [0.1, 20], askMarkup: 1.1, askSurplusCut: 0.25, rawFloorFrac: 0.25,
    craftFloorFrac: 0.9, maxRebids: 2, maxArcs: 60,
    // additions: estate starter lots per marketId (0 Sunward, 1 Dewside), SPEC §C.4 market table
    starterLots: [
      { tablet: 8, stone: 10, quartz: 8, log: 6, amber: 2, lantern: 2 },
      { berry: 20, tablet: 8, peat: 6 }] },
  money: { demurrageHoused: 0.02, demurrageUnhoused: 0.04, mintPerHour: 4.0, hazeK: 120, hazeMin: 0.1,
    lensLifeDays: 4, deathBurn: 0.5, startGlim: [40, 100], immigrantGlim: 25 },
  production: { bushRegrowHours: 36, waterMul: 1.5, waterRadius: 3, maxBushes: 240, harvestYield: 2, forageYield: 2,
    saplingDays: 3, treeHeight: [4, 7], treeAmberChance: 0.3, minTrees: 18, wildSaplings: 2, peatAccretion: 3,
    mossSamplesPerHour: 150, mossChance: 0.15, pathFootfall: 25, pathDecayDays: 3, basaltStoneChance: 0.25,
    puddleTablets: 2,
    house: { stone: 8, log: 4, markup: 1.25, laborDays: 0.5, maxOpen: 10, siteR: [5, 30], capacity: 2 },
    tower: { stone: 8, log: 1, markup: 1.25, laborDays: 0.3, max: 12, minSpacing: 4, minX: 66 },
    est: { tenderBerries: 18, chandlerBatches: 4, delverQuartz: 6, delverStone: 5, delverAmber: 0.4,
      wardenLogs: 9, wardenPeat: 10, masonProjects: 1, porterTrips: 3 },
    recipes: {
      tablet:  { in: { berry: 3, peat: 1 }, out: { tablet: 2 }, sec: 8, station: 'kettle', prof: 'chandler' },
      lantern: { in: { amber: 1, quartz: 1, tablet: 1 }, out: { lantern: 1 }, sec: 5, station: 'kettle', prof: 'chandler' },
      lens:    { in: { quartz: 2 }, out: { lens: 1 }, sec: 10, station: 'tower', prof: 'lenswright' } },
    // additions: project staleness, planting search radii (read by production.js with these defaults)
    projectStaleDays: 3, plantWaterR: 6, plantSearchR: 108 },
  population: { initial: 60, max: 110, floor: 30, floorEveryHours: 2, prosperityEveryHours: 6,
    prosperityRealWage: 3, prosperityVacancy: 2, birthChance: 0.5, birthTallow: 50, birthLustre: 40,
    birthGlim: 40, birthGlimShare: 0.3, birthLustreBonus: 15, birthMinAgeDays: 2, emigrateLustre: 20,
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
  // additions (clans): talent bonus, and the starter stock each clan market opens with (× clan size / 30)
  clans: { talentSkill: 0.3, talentGain: 1.5,
    starterLots: { berry: 16, tablet: 10, peat: 6, stone: 8, quartz: 5, log: 5, amber: 1, lantern: 1 } },
  tools: {
    eclipse: { radius: 12, minR: 6, maxR: 20, durationDays: 1, max: 3 },
    geode: { radius: 2.6, quartzFrac: 0.8, depth: 2, cooldownSec: 20 },
    pane: { maxLen: 64, above: 5, below: 5, max: 4 },
    seal: { durationDays: 1, minMul: 0.25, maxMul: 4 },
    whisper: { bull: 2.5, bear: 0.4, spreadRadius: 3, spreadChancePerSec: 0.05, decayPerDay: 0.22,
      stallPenaltyPerDay: 0.08, minStrength: 0.15, hoardFraction: 0.6 },
    tap: { minR: 15, maxR: 60, holdMin: 0.2, holdMax: 1.5, cargoLoss: 0.5 },
    magnifier: { glimPerSec: 20, scorchRadius: 2, scorchPerSec: 4, boostMul: 3, boostHours: 1 },
    pipette: { radius: 3, minR: 2, maxR: 5 },
    trowel: { repeatSec: 0.15 } } };
