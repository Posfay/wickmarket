// Save slots in the browser.
//
// Saves are gzipped JSON documents (src/core/save.js). They live in IndexedDB (two stores: small
// `meta` records for the menu and the `data` bytes), or in localStorage as base64 when IndexedDB
// is unavailable. Slots:
//   auto       the latest autosave (every couple of minutes and when the page is hidden or closed)
//   auto-prev  the last autosave of the world played before the current one
//   quick      Ctrl+S
//   s-<time>   saves made from the menu
// Files can be exported (.wmsave, the same gzip bytes) and imported on another computer.
import { saveText, readSaveBytes, saveSummary, SaveError } from '../core/save.js';
import { gzipText, bytesToB64, b64ToBytes } from '../core/codec.js';

export const AUTO = 'auto';
export const AUTO_PREV = 'auto-prev';
export const QUICK = 'quick';

const DB_NAME = 'wickmarket';
const DB_VERSION = 1;
const META = 'meta';
const DATA = 'data';
const LS_INDEX = 'wm.saves';
const LS_PREFIX = 'wm.save.';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error || new Error('IndexedDB transaction failed'));
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
    out = fn(t);
  });
}

function reqValue(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------- localStorage fallback

function lsIndex() {
  try {
    const list = JSON.parse(localStorage.getItem(LS_INDEX) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function lsWriteIndex(list) {
  localStorage.setItem(LS_INDEX, JSON.stringify(list));
}

// ---------------------------------------------------------------- slots

/** Every saved game's menu record, newest first. */
export async function listSaves() {
  const db = await openDb();
  let list;
  if (db) {
    list = await tx(db, [META], 'readonly', (t) => reqValue(t.objectStore(META).getAll()));
    list = await list;
  } else {
    list = lsIndex();
  }
  return (Array.isArray(list) ? list : []).filter((m) => m && m.id).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

async function readMeta(id) {
  const db = await openDb();
  if (db) return (await tx(db, [META], 'readonly', (t) => reqValue(t.objectStore(META).get(id)))) || null;
  return lsIndex().find((m) => m.id === id) || null;
}

async function readBytes(id) {
  const db = await openDb();
  if (db) {
    const v = await tx(db, [DATA], 'readonly', (t) => reqValue(t.objectStore(DATA).get(id)));
    const bytes = await v;
    return bytes ? new Uint8Array(bytes) : null;
  }
  const s = localStorage.getItem(LS_PREFIX + id);
  return s ? b64ToBytes(s) : null;
}

async function writeSlot(meta, bytes) {
  const db = await openDb();
  if (db) {
    await tx(db, [META, DATA], 'readwrite', (t) => {
      t.objectStore(META).put(meta);
      t.objectStore(DATA).put(bytes, meta.id);
    });
    return meta;
  }
  try {
    localStorage.setItem(LS_PREFIX + meta.id, bytesToB64(bytes));
    const list = lsIndex().filter((m) => m.id !== meta.id);
    list.push(meta);
    lsWriteIndex(list);
  } catch (err) {
    throw new SaveError('storageFull', err && err.message);
  }
  return meta;
}

/** Remove a saved game. */
export async function deleteSave(id) {
  const db = await openDb();
  if (db) {
    await tx(db, [META, DATA], 'readwrite', (t) => {
      t.objectStore(META).delete(id);
      t.objectStore(DATA).delete(id);
    });
    return;
  }
  localStorage.removeItem(LS_PREFIX + id);
  lsWriteIndex(lsIndex().filter((m) => m.id !== id));
}

/** A saved game as a checked save object (ready for restoreSim). */
export async function loadSave(id) {
  const bytes = await readBytes(id);
  if (!bytes) throw new SaveError('missing', id);
  return readSaveBytes(bytes);
}

function metaFor(id, save, extra) {
  return {
    id,
    name: typeof extra.name === 'string' ? extra.name.slice(0, 60) : '',
    auto: !!extra.auto,
    savedAt: save.savedAt ?? Date.now(),
    worldId: save.worldId ?? null,
    seed: save.seed >>> 0,
    clans: Array.isArray(save.setup?.clans) ? save.setup.clans.length : 1,
    summary: save.summary ?? null,
    version: save.version ?? 1,
  };
}

/**
 * Save the running game into slot `id`.
 * @param {object} sim
 * @param {{id?:string, name?:string, auto?:boolean, extra?:object}} [opts] extra: UI state for the file
 * @returns {Promise<object>} the slot's menu record
 */
export async function saveGame(sim, opts = {}) {
  const id = opts.id || `s-${Date.now().toString(36)}`;
  const text = saveText(sim, opts.extra || {});
  const bytes = await gzipText(text);
  const meta = {
    id,
    name: typeof opts.name === 'string' ? opts.name.slice(0, 60) : '',
    auto: !!opts.auto,
    savedAt: Date.now(),
    worldId: sim.worldId,
    seed: sim.seed >>> 0,
    clans: sim.clans ? sim.clans.count : 1,
    summary: saveSummary(sim),
    version: 1,
    size: bytes.length,
  };
  return writeSlot(meta, bytes);
}

/**
 * The autosave. When the slot holds another world, that world's autosave moves to `auto-prev`
 * first, so starting a new world never loses the last one.
 */
export async function autosave(sim, extra) {
  const cur = await readMeta(AUTO);
  if (cur && cur.worldId && cur.worldId !== sim.worldId) {
    const bytes = await readBytes(AUTO);
    if (bytes) await writeSlot({ ...cur, id: AUTO_PREV }, bytes);
  }
  return saveGame(sim, { id: AUTO, auto: true, extra });
}

// ---------------------------------------------------------------- emergency snapshot

const LS_EMERGENCY = 'wm.emergency';

/**
 * A synchronous last-moment save for page close: IndexedDB writes are asynchronous and may not
 * finish while a page unloads, so the plain JSON goes to localStorage too. The next boot moves it
 * into the autosave slot (absorbEmergency).
 */
export function emergencySave(sim, extra) {
  try {
    localStorage.setItem(LS_EMERGENCY, saveText(sim, extra || {}));
    return true;
  } catch {
    return false;
  }
}

/** Move a leftover emergency snapshot into the autosave slot when it is newer. */
export async function absorbEmergency() {
  let text = null;
  try { text = localStorage.getItem(LS_EMERGENCY); } catch { return false; }
  if (!text) return false;
  try {
    const save = JSON.parse(text);
    if (!save || save.format !== 'wickmarket-save') throw new Error('bad snapshot');
    const cur = await readMeta(AUTO);
    if (!cur || !(cur.savedAt >= save.savedAt)) {
      if (cur && cur.worldId && cur.worldId !== save.worldId) {
        const bytes = await readBytes(AUTO);
        if (bytes) await writeSlot({ ...cur, id: AUTO_PREV }, bytes);
      }
      const bytes = await gzipText(text);
      const meta = metaFor(AUTO, save, { auto: true });
      meta.size = bytes.length;
      await writeSlot(meta, bytes);
    }
    localStorage.removeItem(LS_EMERGENCY);
    return true;
  } catch (err) {
    console.warn('[saves] emergency snapshot unusable', err);
    try { localStorage.removeItem(LS_EMERGENCY); } catch { /* ignore */ }
    return false;
  }
}

/** The newest save of any kind (for "Continue"), or null. */
export async function latestSave() {
  const list = await listSaves();
  return list.length ? list[0] : null;
}

// ---------------------------------------------------------------- files

function download(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function fileName(seed, day) {
  return `wickmarket-${(seed >>> 0).toString(16)}-day${day}.wmsave`;
}

/** Download the running game as a .wmsave file. */
export async function exportRunning(sim, extra) {
  const bytes = await gzipText(saveText(sim, extra || {}));
  download(bytes, fileName(sim.seed, sim.clock.day + 1));
}

/** Download a stored slot as a .wmsave file. */
export async function exportSlot(id) {
  const bytes = await readBytes(id);
  if (!bytes) throw new SaveError('missing', id);
  const meta = await readMeta(id);
  download(bytes, fileName(meta?.seed ?? 0, meta?.summary?.day ?? 0));
}

/**
 * Read a chosen file, check it is a save of this game, and store it as a new slot.
 * @param {File} file
 * @returns {Promise<{meta:object, save:object}>}
 */
export async function importFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const save = await readSaveBytes(buf);
  // Store the gzip bytes (re-compress a plain JSON file).
  const bytes = buf[0] === 0x1F && buf[1] === 0x8B ? buf : await gzipText(new TextDecoder().decode(buf));
  const name = String(file.name || '').replace(/\.(wmsave|json|gz)$/i, '');
  const meta = metaFor(`s-${Date.now().toString(36)}`, save, { name });
  meta.size = bytes.length;
  await writeSlot(meta, bytes);
  return { meta, save };
}

/** Ask the user for a file (resolves null when they cancel). */
export function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.wmsave,.json,.gz,application/octet-stream,application/json';
    input.style.display = 'none';
    let done = false;
    input.addEventListener('change', () => {
      done = true;
      resolve(input.files && input.files[0] ? input.files[0] : null);
      input.remove();
    });
    // No change event fires on cancel in every browser; focus returning is the usual hint.
    window.addEventListener('focus', () => setTimeout(() => { if (!done) { resolve(null); input.remove(); } }, 800), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}
