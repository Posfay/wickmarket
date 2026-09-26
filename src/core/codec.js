// Encoding helpers for save files: base64, run-length encoding of the voxel grid, typed arrays,
// and gzip where the platform has CompressionStream (all modern browsers, Node ≥ 18).
// Pure JS (no DOM): the same code runs in the browser and in the headless tests.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Uint8Array → base64 text. */
export function bytesToB64(bytes) {
  const n = bytes.length;
  const parts = [];
  let chunk = '';
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0, c = i + 2 < n ? bytes[i + 2] : 0;
    const v = (a << 16) | (b << 8) | c;
    chunk += B64[(v >> 18) & 63] + B64[(v >> 12) & 63]
      + (i + 1 < n ? B64[(v >> 6) & 63] : '=') + (i + 2 < n ? B64[v & 63] : '=');
    if (chunk.length >= 16384) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
  return parts.join('');
}

/** base64 text → Uint8Array. */
export function b64ToBytes(s) {
  const str = String(s || '').replace(/[^A-Za-z0-9+/=]/g, '');
  let pad = 0;
  if (str.endsWith('==')) pad = 2; else if (str.endsWith('=')) pad = 1;
  const len = (str.length / 4) * 3 - pad;
  const out = new Uint8Array(Math.max(0, len));
  let o = 0;
  for (let i = 0; i < str.length; i += 4) {
    const a = B64_INV[str.charCodeAt(i)], b = B64_INV[str.charCodeAt(i + 1)];
    const c = B64_INV[str.charCodeAt(i + 2)], d = B64_INV[str.charCodeAt(i + 3)];
    const v = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    if (o < len) out[o++] = (v >> 16) & 255;
    if (o < len) out[o++] = (v >> 8) & 255;
    if (o < len) out[o++] = v & 255;
  }
  return out;
}

/** Typed array → base64 of its raw bytes. */
export function typedToB64(arr) {
  return bytesToB64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
}

/** base64 → a new typed array of the given constructor (e.g. Float32Array). */
export function b64ToTyped(s, Ctor) {
  const bytes = b64ToBytes(s);
  const n = Math.floor(bytes.byteLength / Ctor.BYTES_PER_ELEMENT);
  const out = new Ctor(n);
  new Uint8Array(out.buffer).set(bytes.subarray(0, n * Ctor.BYTES_PER_ELEMENT));
  return out;
}

/**
 * Run-length encode a byte array as (value, run) pairs, the run as an unsigned LEB128 varint.
 * The voxel grid is mostly long runs of air and basalt, so this shrinks it ~20×.
 */
export function rleEncode(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const v = src[i];
    let j = i + 1;
    while (j < src.length && src[j] === v) j++;
    let run = j - i;
    out.push(v);
    while (run >= 0x80) { out.push((run & 0x7F) | 0x80); run >>>= 7; }
    out.push(run);
    i = j;
  }
  return Uint8Array.from(out);
}

/** Inverse of rleEncode into a new Uint8Array of `length` bytes. */
export function rleDecode(enc, length) {
  const out = new Uint8Array(length);
  let o = 0;
  let i = 0;
  while (i < enc.length && o < length) {
    const v = enc[i++];
    let run = 0, shift = 0, b;
    do { b = enc[i++]; run |= (b & 0x7F) << shift; shift += 7; } while (b & 0x80);
    const end = Math.min(length, o + run);
    out.fill(v, o, end);
    o = end;
  }
  return out;
}

const hasStreams = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
  && typeof Response === 'function' && typeof Blob === 'function';

/** UTF-8 text → gzip bytes (or plain UTF-8 bytes when the platform cannot compress). */
export async function gzipText(text) {
  const raw = new TextEncoder().encode(text);
  if (!hasStreams()) return raw;
  try {
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return raw;
  }
}

/** gzip or plain UTF-8 bytes → text. */
export async function gunzipText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 2 && b[0] === 0x1F && b[1] === 0x8B) {
    if (!hasStreams()) throw new Error('This browser cannot open compressed saves');
    const stream = new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  }
  return new TextDecoder().decode(b);
}
