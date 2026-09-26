// Save files: the whole simulation as one JSON document (optionally gzipped), and back.
// Sim-side only (no DOM): the browser's save slots (src/ui/saves.js) and the headless tests use it.
//
// What is kept: the voxels, the clock and random stream, every agent, the markets' prices and
// lots, buildings and building sites, nature timers, the books and chart histories, the clans'
// walls, laws and relations, and the player's lasting effects (hands, seals, panes).
// What is not: what each Wickling is doing this very second (task, path, open bids). On load
// every Wickling decides afresh; open bids' escrow goes back to glim, so no light is lost.
import { CONFIG } from './config.js';
import { bytesToB64, b64ToBytes, rleEncode, rleDecode, typedToB64, b64ToTyped, gzipText, gunzipText } from './codec.js';
import { World } from '../world/world.js';
import { Pathfinder } from '../agents/pathfinding.js';
import { Population } from '../agents/population.js';
import { Market } from '../economy/market.js';
import { Ledger } from '../economy/ledger.js';
import { Production } from '../economy/production.js';
import { Clans, normalizeSetup } from '../economy/clans.js';
import { simShell } from '../sim.js';

export const SAVE_FORMAT = 'wickmarket-save';
export const SAVE_VERSION = 1;

/** Raised for files that are not saves of this game (or of a newer version). */
export class SaveError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const packBytes = (u8) => bytesToB64(rleEncode(u8));
const unpackBytes = (s, n) => rleDecode(b64ToBytes(s), n);
const packTyped = (arr) => packBytes(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
function unpackTyped(s, Ctor, n) {
  const bytes = unpackBytes(s, n * Ctor.BYTES_PER_ELEMENT);
  return new Ctor(bytes.buffer, 0, n);
}

/** Headline numbers shown in the load menu without opening the whole file. */
export function saveSummary(sim) {
  const clans = sim.clans;
  return {
    day: sim.clock.day + 1,
    hour: sim.clock.hour,
    pop: sim.population.count(),
    money: Math.round(sim.ledger.moneySupply()),
    clans: clans ? clans.count : 1,
    walls: clans && clans.walls.length ? clans.walls.filter((w) => w.up).length : 0,
    wallsTotal: clans ? clans.walls.length : 0,
    seed: (sim.seed >>> 0).toString(16),
  };
}

function serializeWorldInfo(info) {
  const flat = (cells) => {
    const out = [];
    for (const c of cells || []) out.push(c.x, c.y, c.z);
    return out;
  };
  return {
    seed: info.seed >>> 0,
    clanCount: info.clanCount ?? 1,
    markets: JSON.parse(JSON.stringify(info.markets || [])),
    pond: info.pond ? { ...info.pond } : null,
    ponds: (info.ponds || []).map((p) => ({ ...p })),
    spawnByClan: (info.spawnByClan || [info.spawnCells || []]).map(flat),
    sectorMap: info.sectorMap instanceof Uint8Array ? packBytes(info.sectorMap) : null,
    wallLines: (info.wallLines || []).map((w) => ({ id: w.id, a: w.a, b: w.b, cols: Array.from(w.cols) })),
    theta0: info.theta0 ?? null,
  };
}

function restoreWorldInfo(s, world) {
  const cells = (flat) => {
    const out = [];
    for (let i = 0; i + 2 < flat.length; i += 3) out.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2] });
    return out;
  };
  const spawnByClan = (Array.isArray(s.spawnByClan) ? s.spawnByClan : []).map((f) => cells(Array.isArray(f) ? f : []));
  const ponds = Array.isArray(s.ponds) ? s.ponds : (s.pond ? [s.pond] : []);
  return {
    seed: s.seed >>> 0,
    clanCount: s.clanCount ?? 1,
    markets: Array.isArray(s.markets) ? s.markets : [],
    // Towers, houses, trees and bushes live in production's own save data.
    towers: [], houses: [], trees: [], bushes: [],
    pond: s.pond || ponds[0] || null,
    ponds,
    spawnCells: spawnByClan.flat(),
    spawnByClan,
    sectorMap: typeof s.sectorMap === 'string' ? unpackBytes(s.sectorMap, world.SX * world.SZ) : null,
    wallLines: Array.isArray(s.wallLines) ? s.wallLines : [],
    theta0: s.theta0 ?? undefined,
  };
}

/**
 * The whole simulation as plain data. It shares nothing with the live sim once stringified, but
 * parts of it do until then: call JSON.stringify before the sim ticks again (saveText does).
 * @param {object} sim
 * @param {object} [extra] more top-level fields (the UI adds its camera, ticker and tool state)
 */
export function serializeSim(sim, extra = {}) {
  const w = sim.world;
  const effects = sim.effects || {};
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: Date.now(),
    worldId: sim.worldId,
    seed: sim.seed >>> 0,
    setup: sim.setup,
    tick: sim.clock.tick,
    rng: sim.rng.getState(),
    summary: saveSummary(sim),
    world: { size: [w.SX, w.SY, w.SZ], data: packBytes(w.data), footfall: packTyped(w.footfall) },
    info: serializeWorldInfo(sim.worldInfo),
    clans: sim.clans.serialize(),
    population: sim.population.serialize(),
    market: sim.market.serialize(),
    production: sim.production.serialize(),
    ledger: sim.ledger.serialize(),
    effects: JSON.parse(JSON.stringify({
      eclipses: effects.eclipses || [], seals: effects.seals || [], panes: effects.panes || [], nextId: effects.nextId || 1,
    })),
    ...extra,
  };
}

/** The save as JSON text. */
export function saveText(sim, extra) {
  return JSON.stringify(serializeSim(sim, extra));
}

/** The save as gzip bytes (plain UTF-8 where the platform cannot compress). */
export async function saveBytes(sim, extra) {
  return gzipText(saveText(sim, extra));
}

/** Parse save text (JSON) into a checked save object. */
export function parseSave(text) {
  let s;
  try {
    s = JSON.parse(text);
  } catch (err) {
    throw new SaveError('notASave', err && err.message);
  }
  if (!s || typeof s !== 'object' || s.format !== SAVE_FORMAT) throw new SaveError('notASave');
  if (!(s.version >= 1)) throw new SaveError('notASave');
  if (s.version > SAVE_VERSION) throw new SaveError('tooNew', String(s.version));
  return s;
}

/** Bytes (gzip or plain JSON) → a checked save object. */
export async function readSaveBytes(bytes) {
  let text;
  try {
    text = await gunzipText(bytes);
  } catch (err) {
    throw new SaveError('notASave', err && err.message);
  }
  return parseSave(text);
}

/**
 * Build a running simulation from a save object (parseSave / readSaveBytes).
 * @param {object} save
 * @param {boolean} [headless]
 * @returns {object} the sim context, ready to tick
 */
export function restoreSim(save, headless = false) {
  const s = save;
  if (!s || s.format !== SAVE_FORMAT) throw new SaveError('notASave');
  const setup = normalizeSetup(s.setup);
  const world = new World(CONFIG);
  const [SX, SY, SZ] = Array.isArray(s.world?.size) ? s.world.size : [];
  if (SX !== world.SX || SY !== world.SY || SZ !== world.SZ) throw new SaveError('worldSize', `${SX}×${SY}×${SZ}`);
  // Written in place: the pathfinder keeps a reference to world.data.
  world.data.set(unpackBytes(s.world.data, world.data.length));
  if (typeof s.world.footfall === 'string') world.footfall.set(unpackTyped(s.world.footfall, Uint16Array, world.footfall.length));
  world.recomputeDerived();
  world.markAllDirty();

  const info = restoreWorldInfo(s.info || {}, world);
  const sim = simShell(s.seed >>> 0, headless, setup, world, info);
  if (typeof s.worldId === 'string' && s.worldId) sim.worldId = s.worldId;
  sim.clock.tick = Math.max(0, Math.floor(Number(s.tick) || 0));
  sim.clock._compute();

  sim.pathfinder = new Pathfinder(world, CONFIG);
  sim.clans = new Clans(sim, setup, info);
  sim.clans.restore(s.clans);
  sim.ledger = new Ledger(sim);
  sim.market = new Market(sim, info.markets);
  sim.production = new Production(sim, info);
  sim.population = new Population(sim);
  sim.population.restore(s.population);
  sim.production.restore(s.production);
  sim.market.restore(s.market);
  sim.ledger.restore(s.ledger);
  const e = s.effects || {};
  sim.effects = {
    eclipses: Array.isArray(e.eclipses) ? e.eclipses : [],
    seals: Array.isArray(e.seals) ? e.seals : [],
    panes: Array.isArray(e.panes) ? e.panes : [],
    nextId: Number.isFinite(e.nextId) ? e.nextId : 1,
  };
  sim.rng.setState(s.rng);
  sim.pathfinder.refreshRegions(true);
  return sim;
}

export { typedToB64, b64ToTyped };
