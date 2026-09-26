// Event bus, event names and the sim clock (SPEC §C.3, §C.4 G1 events.js).
import { TICKS } from './config.js';

/** Event names (SPEC §C.3). */
export const EV = Object.freeze({
  CLOCK_NEWDAY: 'clock:newday',
  CLOCK_HOUR: 'clock:hour',
  CLOCK_DAWN: 'clock:dawn',
  CLOCK_DUSK: 'clock:dusk',
  MARKET_CHIME: 'market:chime',
  AGENT_BORN: 'agent:born',
  AGENT_IMMIGRATED: 'agent:immigrated',
  AGENT_DIED: 'agent:died',
  AGENT_EMIGRATED: 'agent:emigrated',
  AGENT_PROFESSION: 'agent:profession',
  AGENT_DUG: 'agent:dug',
  AGENT_PLACED: 'agent:placed',
  AGENT_HARVEST: 'agent:harvest',
  PANIC: 'agent:panic',
  RUMOR: 'rumor:update',
  PROJECT_COMMISSIONED: 'project:commissioned',
  PROJECT_DONE: 'project:done',
  TOWER_LENS: 'tower:lens',
  TREE_FELLED: 'tree:felled',
  SMUGGLE_BREACH: 'smuggle:breach',
  STABILIZER: 'stabilizer',
  FIGHT: 'clan:fight',
  RELATION: 'clan:relation',
  WALL: 'clan:wall',
  POLICY: 'clan:policy',
  LANG: 'ui:lang',
  PLAYER_TOOL: 'player:tool',
  TOOL_CHANGED: 'tool:changed',
  SELECT_AGENT: 'ui:selectAgent',
  SELECT_MARKET: 'ui:selectMarket',
  SELECT_GOOD: 'ui:selectGood',
  FOLLOW: 'ui:follow',
  FLY_TO: 'ui:flyTo',
  SPEED: 'ui:speed',
  REROLL: 'ui:reroll',
  TICKER: 'ticker:post',
});

/**
 * Synchronous pub/sub. Listener lists are copy-on-write, so handlers may subscribe or
 * unsubscribe during an emit without affecting the in-flight dispatch and without per-emit allocation.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();
  }

  /** @returns {() => void} unsubscribe */
  on(name, fn) {
    const list = this._listeners.get(name);
    this._listeners.set(name, list ? [...list, fn] : [fn]);
    return () => this.off(name, fn);
  }

  off(name, fn) {
    const list = this._listeners.get(name);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i < 0) return;
    const next = list.slice();
    next.splice(i, 1);
    if (next.length) this._listeners.set(name, next); else this._listeners.delete(name);
  }

  once(name, fn) {
    const off = this.on(name, payload => { off(); fn(payload); });
    return off;
  }

  emit(name, payload) {
    const list = this._listeners.get(name);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (err) { console.error(`[events] listener for "${name}" threw`, err); }
    }
  }
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The in-game clock: 100 ticks per hour, 2400 per day (SPEC §C.0 Time). */
export class SimClock {
  constructor(config) {
    this.tick = Math.round((config?.time?.startHour ?? 7) * TICKS.PER_HOUR);
    this._compute();
  }

  _compute() {
    const t = this.tick;
    const inDay = ((t % TICKS.PER_DAY) + TICKS.PER_DAY) % TICKS.PER_DAY;
    this.day = Math.floor(t / TICKS.PER_DAY);
    this.hourFloat = inDay / TICKS.PER_HOUR;
    this.hour = Math.floor(this.hourFloat);
    const h = this.hourFloat;
    this.sun = Math.max(0, Math.sin((Math.PI * (h - 6)) / 12));
    this.daylight = h < 12 ? smoothstep(5.25, 6.75, h) : 1 - smoothstep(17.25, 18.75, h);
    this.isNight = h < 6 || h >= 18;
    this.isHourTick = inDay % TICKS.PER_HOUR === 0;
    this.isNewDayTick = inDay === 0;
    this.isDawnTick = inDay === 6 * TICKS.PER_HOUR;
    this.isDuskTick = inDay === 18 * TICKS.PER_HOUR;
  }

  /** Advance one tick and emit NEWDAY → HOUR → DAWN/DUSK as appropriate. */
  advance(events) {
    this.tick++;
    this._compute();
    if (!events) return;
    const payload = { day: this.day, tick: this.tick };
    if (this.isNewDayTick) events.emit(EV.CLOCK_NEWDAY, payload);
    if (this.isHourTick) events.emit(EV.CLOCK_HOUR, { day: this.day, hour: this.hour, tick: this.tick });
    if (this.isDawnTick) events.emit(EV.CLOCK_DAWN, payload);
    if (this.isDuskTick) events.emit(EV.CLOCK_DUSK, payload);
  }

  /** @returns {number} ticks in `h` hours */
  hours(h) { return Math.round(h * TICKS.PER_HOUR); }

  /** @returns {number} ticks in `d` days */
  days(d) { return Math.round(d * TICKS.PER_DAY); }
}
