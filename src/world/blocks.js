// Block registry, lookup tables and structure templates (SPEC §C.4 G1 blocks.js).
import { CONFIG } from '../core/config.js';

/**
 * @typedef {object} BlockDef
 * @property {number} id
 * @property {string} key
 * @property {string} name
 * @property {string} color      '#hex' (sRGB)
 * @property {boolean} solid
 * @property {boolean} opaque
 * @property {boolean} transparent
 * @property {number} alpha
 * @property {number} emissive   0..1
 * @property {number} hardness   dig seconds at skill 1 (Infinity = unbreakable)
 * @property {boolean} agentDiggable  pathfinding may tunnel through it
 * @property {string|null} yields GoodId dropped when dug
 * @property {number} yieldChance
 */

const DEFAULTS = {
  solid: true, opaque: true, transparent: false, alpha: 1, emissive: 0,
  hardness: 1, agentDiggable: false, yields: null, yieldChance: 1,
};

const DEFS = [
  { key: 'AIR', name: 'Air', color: '#000000', solid: false, opaque: false, hardness: 0 },
  { key: 'BEDROCK', name: 'Bedrock', color: '#1E1B22', hardness: Infinity },
  { key: 'BASALT', name: 'Basalt', color: '#34343F', hardness: 2.5, agentDiggable: true, yields: 'stone', yieldChance: CONFIG.production.basaltStoneChance },
  { key: 'LOAM', name: 'Loam', color: '#4A3526', hardness: 0.8, agentDiggable: true },
  { key: 'MOSS', name: 'Moss', color: '#7FA650', sideColor: '#6B7A45', hardness: 0.8, agentDiggable: true },
  { key: 'PATH', name: 'Trodden Path', color: '#9C8763', hardness: 0.8, agentDiggable: true, fastFloor: true },
  { key: 'PEAT', name: 'Peat', color: '#2B1E18', hardness: 1.2, agentDiggable: true, yields: 'peat' },
  { key: 'QUARTZ', name: 'Quartz', color: '#DDEFF5', emissive: 0.35, hardness: 3.0, agentDiggable: true, yields: 'quartz' },
  { key: 'AMBER', name: 'Amber', color: '#E8961E', emissive: 0.6, hardness: 3.0, agentDiggable: true, yields: 'amber' },
  { key: 'LOG', name: 'Resinpine Log', color: '#5A3B2A', hardness: 1.2 },
  { key: 'NEEDLES', name: 'Pine Needles', color: '#2F5A3E', hardness: 0.3, agentDiggable: true },
  { key: 'BUSH_BARE', name: 'Waxberry Bush (bare)', color: '#3E6B4B', hardness: 0.5 },
  { key: 'BUSH_RIPE', name: 'Waxberry Bush (ripe)', color: '#3E6B4B', speckle: '#F2E6C8', hardness: 0.5 },
  { key: 'SAPLING', name: 'Resinpine Sapling', color: '#7BAF5A', hardness: 0.5 },
  { key: 'WATER', name: 'Dew Water', color: '#6FB7C9', solid: false, opaque: false, transparent: true, alpha: 0.6, hardness: Infinity },
  { key: 'CUT_STONE', name: 'Cut Stone', color: '#7A7684', hardness: 3.0 },
  { key: 'THATCH', name: 'Thatch', color: '#8A5A3A', hardness: 1.0 },
  { key: 'PAVING', name: 'Paving', color: '#B8A98A', hardness: 2.0, fastFloor: true },
  { key: 'KETTLE', name: 'Wax Kettle', color: '#6B4F3A', emissive: 0.25, hardness: Infinity },
  { key: 'LENS_MOUNT', name: 'Lens Mount', color: '#B08D57', emissive: 0.3, hardness: Infinity },
  { key: 'LANTERN', name: 'Amber Lantern', color: '#F2A93B', emissive: 1.0, hardness: 1.0 },
  { key: 'GLASS_WALL', name: 'Glass Pane', color: '#CFE8EF', opaque: false, transparent: true, alpha: 0.35, hardness: Infinity },
  { key: 'WAX_PUDDLE', name: 'Wax Puddle', color: '#E9D9B0', hardness: 1.0 },
  // The unbreakable glass between clans (economy/clans.js). Appended so older ids never shift.
  { key: 'CLAN_WALL', name: 'Clan Wall', color: '#F3E6C8', opaque: false, transparent: true, alpha: 0.42, emissive: 0.12, hardness: Infinity },
];

/** @type {BlockDef[]} indexed by id */
export const BLOCKS = DEFS.map((d, id) => Object.freeze({ id, ...DEFAULTS, ...d }));

/** Block ids by key, e.g. `B.QUARTZ === 7`. */
export const B = Object.freeze(Object.fromEntries(BLOCKS.map(b => [b.key, b.id])));

const table = (Ctor, fn) => {
  const t = new Ctor(256);
  for (const b of BLOCKS) t[b.id] = fn(b);
  return t;
};

export const SOLID = table(Uint8Array, b => (b.solid ? 1 : 0));
export const OPAQUE = table(Uint8Array, b => (b.opaque ? 1 : 0));
export const TRANSPARENT = table(Uint8Array, b => (b.transparent ? 1 : 0));
export const AGENT_DIGGABLE = table(Uint8Array, b => (b.agentDiggable ? 1 : 0));
export const EMISSIVE = table(Float32Array, b => b.emissive);
/** Floors that speed walking (PATH, PAVING). */
export const FAST_FLOOR = table(Uint8Array, b => (b.fastFloor ? 1 : 0));

export const isSolid = id => SOLID[id] === 1;
/** Walkable-through: not solid and not water. */
export const isPassable = id => SOLID[id] === 0 && id !== B.WATER;

// ---------------------------------------------------------------------------
// Structure templates. Each returns {blocks: [{x,y,z,id}], ...anchors}.
// ---------------------------------------------------------------------------

/**
 * A 3×3 cottage standing on the ground at y0−1: cut-stone walls (door gap at (x0+1, z0)), thatch roof.
 * @returns {{blocks:{x:number,y:number,z:number,id:number}[], origin, door, bed, approach, lanternSlots}}
 */
export function houseTemplate(x0, y0, z0) {
  const blocks = [];
  for (let dy = 0; dy < 2; dy++) {
    for (let dz = 0; dz < 3; dz++) {
      for (let dx = 0; dx < 3; dx++) {
        const rim = dx === 0 || dx === 2 || dz === 0 || dz === 2;
        const door = dx === 1 && dz === 0;
        if (rim && !door) blocks.push({ x: x0 + dx, y: y0 + dy, z: z0 + dz, id: B.CUT_STONE });
      }
    }
  }
  for (let dz = 0; dz < 3; dz++) {
    for (let dx = 0; dx < 3; dx++) blocks.push({ x: x0 + dx, y: y0 + 2, z: z0 + dz, id: B.THATCH });
  }
  return {
    blocks,
    origin: { x: x0, y: y0, z: z0 },
    door: { x: x0 + 1, y: y0, z: z0 },
    bed: { x: x0 + 1, y: y0, z: z0 + 1 },
    approach: { x: x0 + 1, y: y0, z: z0 - 1 },
    lanternSlots: [
      { x: x0, y: y0 + 1, z: z0 },
      { x: x0 + 2, y: y0 + 1, z: z0 },
      { x: x0 + 1, y: y0 + 2, z: z0 },
    ],
  };
}

/** A lens tower: three cut-stone blocks topped by a brass lens mount. */
export function towerTemplate(x, y, z) {
  return {
    blocks: [
      { x, y, z, id: B.CUT_STONE },
      { x, y: y + 1, z, id: B.CUT_STONE },
      { x, y: y + 2, z, id: B.CUT_STONE },
      { x, y: y + 3, z, id: B.LENS_MOUNT },
    ],
    base: { x, y, z },
    lens: { x, y: y + 3, z },
  };
}

/**
 * A resinpine: LOG trunk y..y+h−1 wrapped by a needle cone (radius 2 on layers h−3..h−2,
 * radius 1 on layers h−1..h), never overwriting trunk cells.
 */
export function treeTemplate(x, y, z, height) {
  const h = Math.max(3, height | 0);
  const blocks = [];
  for (let i = 0; i < h; i++) blocks.push({ x, y: y + i, z, id: B.LOG });
  const ring = (layer, r2) => {
    const r = r2 > 2 ? 2 : 1;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        if (dx === 0 && dz === 0 && layer < h) continue;       // trunk
        blocks.push({ x: x + dx, y: y + layer, z: z + dz, id: B.NEEDLES });
      }
    }
  };
  ring(h - 3, 5);
  ring(h - 2, 5);
  ring(h - 1, 2);
  ring(h, 1);
  return { blocks, base: { x, y, z }, height: h };
}
