// Where is (x, z)? A short place message ("near Pond market", "on the rocky hill", "on Frost land")
// for news lines and tool labels. Returns an i18n message ([key, params]); render it with tr().
import { CONFIG } from '../core/config.js';

const num = (v, d) => (Number.isFinite(v) ? v : d);

/**
 * @param {object} sim
 * @param {number} x world x
 * @param {number} z world z
 * @param {number} [near=12] distance that counts as "near a market"
 * @returns {Array} message
 */
export function placeOf(sim, x, z, near = 12) {
  const mk = sim.worldInfo?.markets ?? sim.market?.markets;
  if (Array.isArray(mk)) {
    let best = -1;
    let bestD = Infinity;
    mk.forEach((m, i) => {
      const c = m && m.center;
      if (!c) return;
      const d = Math.hypot(c.x + 0.5 - x, c.z + 0.5 - z);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0 && bestD < near) return ['place.market', { m: best }];
  }
  const clans = sim.clans;
  if (clans?.multi) {
    const s = clans.sectorAt(x, z);
    return s < clans.count ? ['place.land', { clan: s }] : ['place.wall'];
  }
  const pond = sim.worldInfo?.pond ?? CONFIG.worldgen?.pond;
  if (pond && Number.isFinite(pond.x)) {
    const d = Math.hypot(pond.x - x, pond.z - z);
    if (d < num(pond.r, 11) + 3) return ['place.pond'];
    if (d < num(pond.r, 11) + 9) return ['place.bog'];
  }
  const w = CONFIG.world || {};
  if (Math.hypot(x - num(w.CX, 56), z - num(w.CZ, 56)) > num(w.RADIUS, 54) - 5) return ['place.rim'];
  if (x >= num(CONFIG.worldgen?.ridgeStartX, 74)) return ['place.ridge'];
  if (x < 40) return ['place.west'];
  return ['place.middle'];
}
