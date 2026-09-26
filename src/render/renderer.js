/**
 * Wickmarket: renderer (G2).
 *
 * Owns the three.js scene around the terrarium: the walnut desk, the plinth with its brass rings and
 * seed plate, the study backdrop, the fresnel bell jar, the sun/moon and ambient light cycle, haze fog,
 * the chunked voxel terrain (patched Lambert with emissive blocks, eclipse discs, cutaway and the
 * night-time flame glowmap), the orbit camera with follow / fly-to / shake, adaptive quality and the
 * 'P' debug overlay.
 *
 * Colour: renderer output is sRGB with ACES tone mapping; every colour here is set through THREE.Color
 * (linear working space). Light intensities are expressed in r155+ physical units, where the SPEC's
 * legacy numbers (e.g. moonlight 0.12) are multiplied by π.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG, TICKS } from '../core/config.js';
import { EV } from '../core/events.js';
import { meshChunk } from './chunkMesher.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const PI = Math.PI;
const WCFG = CONFIG.world || {};
const RCFG = CONFIG.render || {};
const WORLD_X = WCFG.SX ?? 112;
const WORLD_Y = WCFG.SY ?? 64;
const WORLD_Z = WCFG.SZ ?? 112;
const CHUNK = WCFG.CHUNK ?? 16;
const CX = WCFG.CX ?? WORLD_X / 2;
const CZ = WCFG.CZ ?? WORLD_Z / 2;
const JAR_R = RCFG.jar?.radius ?? 57;
const JAR_H = RCFG.jar?.height ?? 50;
const PLINTH_R = 60;
const DESK_Y = -4;
const TICKS_PER_DAY = TICKS?.PER_DAY ?? 2400;
const TICKS_PER_HOUR = TICKS?.PER_HOUR ?? 100;

const PALETTE = Object.freeze({
  desk: '#2A1C14', brass: '#B08D57', glassRim: '#CFE8EC', glassTint: '#9CC8C0',
  dayKey: '#FFE2B0', sky: '#A8CFE0', bounce: '#4A3526', dusk: '#F2A65A',
  nightAmbient: '#141A30', moon: '#5B6FA8',
  flamePoor: '#FF7A2E', flameMid: '#FFC247', flameRich: '#FFF4D6', rumour: '#B388FF',
  backdropDay: '#D8C7A8', backdropNight: '#141A30', backdropBottom: '#2A1C14',
  fogDay: '#FFE2B0', fogNight: '#141A30', lantern: '#F2A93B', nightGround: '#0B0A10',
  cap: '#5A4636', cutEdge: '#E4B064',
});

// Light levels (physical units; SPEC legacy values × π where the SPEC gives one).
const SUN_PEAK = 1.05 * PI;
const MOON_I = 0.12 * PI;
const HEMI_DAY = 0.55 * PI;
const HEMI_NIGHT = 1.8 * PI;          // tinted #141A30, so the absolute light stays very dim
const SUN_MAX_EL = 60 * PI / 180;
const MOON_MAX_EL = 45 * PI / 180;
const MIN_LIGHT_EL = 5 * PI / 180;
const LIGHT_DIST = 180;
const SHADOW_HALF = 72;

// Glowmap (flame light on the ground).
const GLOW_MAX = 4.0;                  // decoded range; bytes store sqrt(v / GLOW_MAX)
const GLOW_GAIN = 1.1;
const GLOW_LUT_N = 2048;
const GLOW_KSUB = 4;                   // sub-texel kernel offsets per axis
const RAMP_N = 64;
const LANTERN_GLOW = 0.6;
const FLAME_LIFT = 0.6;                // splat height reference above the feet

// Camera.
const FOLLOW_RATE = 6;                 // SPEC §F: target lerps to the agent at 6/s
const FLY_SEC = 1;
const KEY_ORBIT_RATE = 1.6;            // rad/s for Q/E
const TARGET_MAX_R = 64;
const TARGET_Y = [-2, 70];
const SHAKE_DECAY = 1.6;
const DEBUG_HZ = 4;
const YIELD_EVERY = 12;
const CUT_OFF = 1e5;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function smoothstep(e0, e1, x) { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
function finiteOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function col(hex) { return new THREE.Color().set(hex); }

/** Fallback daylight curve (SPEC C.4 SimClock): 0→1 over 05:15–06:45 and back over 17:15–18:45. */
function daylightAt(h) {
  return smoothstep(5.25, 6.75, h) * (1 - smoothstep(17.25, 18.75, h));
}

/** Resolves on the next animation frame (or after 100 ms if frames are throttled in a hidden tab). */
function nextFrame() {
  return new Promise(resolve => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
    setTimeout(go, 100);
  });
}

function isTypingTarget() {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** Small seeded PRNG for procedural textures (visual only). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable smooth value noise on a px×py lattice (coordinates wrap). */
function makeTileNoise(rand, px, py) {
  const t = new Float32Array(px * py);
  for (let i = 0; i < t.length; i++) t[i] = rand();
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let fx = x - xi;
    let fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % px) + px) % px;
    const y0 = ((yi % py) + py) % py;
    const x1 = (x0 + 1) % px;
    const y1 = (y0 + 1) % py;
    const a = t[x0 + px * y0];
    const b = t[x1 + px * y0];
    const c = t[x0 + px * y1];
    const d = t[x1 + px * y1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

// Flame ramp (linear RGB), poor → mid → rich.
const RAMP = new Float32Array(RAMP_N * 3);
(() => {
  const a = col(PALETTE.flamePoor);
  const b = col(PALETTE.flameMid);
  const c = col(PALETTE.flameRich);
  const t = new THREE.Color();
  for (let i = 0; i < RAMP_N; i++) {
    const w = i / (RAMP_N - 1);
    if (w < 0.5) t.lerpColors(a, b, w * 2); else t.lerpColors(b, c, (w - 0.5) * 2);
    RAMP[i * 3] = t.r; RAMP[i * 3 + 1] = t.g; RAMP[i * 3 + 2] = t.b;
  }
})();
const RUMOUR_LIN = col(PALETTE.rumour);
const LANTERN_LIN = col(PALETTE.lantern);

// sqrt-encoding LUT: value v in [0, GLOW_MAX] → byte.
const GLOW_LUT = new Uint8Array(GLOW_LUT_N);
for (let i = 0; i < GLOW_LUT_N; i++) GLOW_LUT[i] = Math.round(Math.sqrt(i / (GLOW_LUT_N - 1)) * 255);
const GLOW_LUT_K = (GLOW_LUT_N - 1) / GLOW_MAX;

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

const TERRAIN_VERT_PARS = /* glsl */`
attribute float aEmit;
varying float vEmit;
varying vec3 vWorldPos;
varying vec3 vWorldN;
`;

const TERRAIN_VERT_MAIN = /* glsl */`
vEmit = aEmit;
vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWorldN = normalize(mat3(modelMatrix) * objectNormal);
`;

const TERRAIN_FRAG_PARS = /* glsl */`
uniform sampler2D uGlow;
uniform float uNight;
uniform vec4 uEclipse[3];
uniform float uCutY;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uCapCol;
uniform vec3 uCutCol;
varying float vEmit;
varying vec3 vWorldPos;
varying vec3 vWorldN;

float wkEclipse(vec2 p) {
  float s = 1.0;
  for (int i = 0; i < 3; i++) {
    vec4 e = uEclipse[i];
    if (e.w > 0.0) {
      float d = length(p - e.xy);
      float inside = 1.0 - smoothstep(e.z - 2.0, e.z, d);
      s = min(s, mix(1.0, 0.35, inside * e.w));
    }
  }
  return s;
}
`;

const TERRAIN_FRAG_CUT = /* glsl */`
if (vWorldPos.y > uCutY) discard;
`;

const TERRAIN_FRAG_LIGHT = /* glsl */`
{
  // Eclipse discs dim the diffuse light (x0.35 inside, 2-voxel soft edge).
  float wkShade = wkEclipse(vWorldPos.xz);
  outgoingLight = (reflectedLight.directDiffuse + reflectedLight.indirectDiffuse) * wkShade + totalEmissiveRadiance;
  float wkDark = max(uNight, (1.0 - wkShade) * 1.1);

  // Emissive blocks (quartz, amber, lanterns, kettles, lens mounts) bloom after dark.
  outgoingLight += vColor.rgb * vEmit * mix(0.25, 1.0, uNight) * 1.35;

  // Flame light: the glowmap holds sqrt-encoded RGB and the weighted flame height in alpha.
  vec3 wkN = normalize(vWorldN);
  vec4 gs = texture2D(uGlow, vWorldPos.xz * vec2(1.0 / ${WORLD_X.toFixed(1)}, 1.0 / ${WORLD_Z.toFixed(1)}));
  vec3 glow = gs.rgb * gs.rgb * ${GLOW_MAX.toFixed(1)};
  float dy = vWorldPos.y - gs.a * 63.75;
  float vert = exp(-dy * dy * 0.035);
  float facing = 0.4 + 0.6 * clamp(wkN.y * 0.5 + 0.5, 0.0, 1.0);
  outgoingLight += glow * (vert * facing * wkDark) * (diffuseColor.rgb * 2.0 + 0.035);

#ifdef WK_TRANSPARENT
  {
  #ifdef USE_COLOR_ALPHA
    float wkA = vColor.a;             // WATER alpha 0.6, GLASS_WALL 0.35 (blocks.js)
  #else
    float wkA = 0.6;
  #endif
    vec3 V = normalize(cameraPosition - vWorldPos);
    float water = step(0.5, wkA) * step(0.5, wkN.y);
    vec2 q = vWorldPos.xz * 0.9 + vec2(uTime * 0.6, uTime * 0.45);
    vec3 Nw = normalize(vec3(sin(q.x * 1.7 + sin(q.y * 1.3)) * 0.07, 1.0, cos(q.y * 1.9 + sin(q.x * 1.1)) * 0.07));
    float fres = pow(1.0 - max(dot(V, Nw), 0.0), 4.0);
    vec3 Rw = reflect(-V, Nw);
    float glint = pow(max(dot(Rw, uSunDir), 0.0), 180.0);
    outgoingLight += water * (uSkyCol * fres * 0.9 + uSunCol * glint * 3.0 + glow * vert * 0.25 * uNight);
    diffuseColor.a = mix(diffuseColor.a, min(1.0, diffuseColor.a + 0.3), water * fres);
    float pane = 1.0 - step(0.5, wkA);
    float rim = pow(1.0 - abs(dot(V, wkN)), 3.0);
    outgoingLight += pane * uSkyCol * rim * 0.35;
    diffuseColor.a = min(1.0, diffuseColor.a + pane * rim * 0.25);
  }
#endif

#ifdef DOUBLE_SIDED
  // Cutaway: interior back faces read as a hatched section cap, like a naturalist's drawing.
  if (!gl_FrontFacing) {
    float hatch = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) * 0.125));
    outgoingLight = uCapCol * mix(0.8, 1.0, hatch) * (1.0 - 0.6 * uNight);
  }
#endif

  if (uCutY < 9999.0) {
    float edge = 1.0 - smoothstep(0.0, 0.35, uCutY - vWorldPos.y);
    outgoingLight = mix(outgoingLight, uCutCol, edge * 0.45);
  }
}
`;

const JAR_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vWP;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWP = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const JAR_FRAG = /* glsl */`
uniform vec3 uRim;
uniform vec3 uTint;
uniform vec3 uDusk;
uniform vec3 uNightTint;
uniform vec3 uHazeCol;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uWinCol;
uniform float uFlush;
uniform float uNight;
uniform float uHaze;
uniform float uSun;
uniform float uDay;
varying vec3 vN;
varying vec3 vWP;
void main() {
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vWP);
  float fres = 1.0 - abs(dot(N, V));
  float f3 = fres * fres * fres;
  float alpha = 0.03 + 0.35 * f3;
  vec3 c = mix(uTint, uRim, clamp(f3 * 1.6, 0.0, 1.0));
  // The glass only reflects what the study offers: after dark it dims to an indigo sheen.
  c = mix(c, uNightTint, uNight * 0.55) * mix(0.2, 1.0, uDay);
  c = mix(c, uDusk, uFlush * 0.85);
  alpha += uFlush * 0.05 + uHaze * 0.03;
  c = mix(c, uHazeCol * mix(0.3, 1.0, uDay), uHaze * 0.2);

  // Sun highlight and broad sheen.
  vec3 R = reflect(-V, N);
  float rl = max(dot(R, uSunDir), 0.0);
  float spec = pow(rl, 90.0) * uSun;
  float sheen = pow(rl, 10.0) * 0.08 * uSun;

  // Reflection of the study's east window (+X): a mullioned pane.
  float win = 0.0;
  if (R.x > 0.2) {
    vec2 p = vec2(R.z, R.y) / R.x;
    vec2 w = (p - vec2(0.0, 0.36)) / vec2(0.42, 0.34);
    float inWin = (1.0 - smoothstep(0.9, 1.0, abs(w.x))) * (1.0 - smoothstep(0.9, 1.0, abs(w.y)));
    float mull = smoothstep(0.025, 0.06, abs(w.x)) * smoothstep(0.025, 0.06, abs(w.y - 0.1));
    win = inWin * mull;
  }
  c += uSunCol * (spec * 2.0 + sheen) + uWinCol * win * (0.08 + 0.5 * uDay);
  alpha = clamp(alpha + spec * 0.8 + sheen * 0.5 + win * (0.03 + 0.12 * uDay), 0.0, 0.95);
  gl_FragColor = vec4(c, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const BACKDROP_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BACKDROP_FRAG = /* glsl */`
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uDay;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  // The floor band (d.y < 0.1) is exactly uBottom, matching the desk vignette's far colour.
  vec3 c = mix(uBottom, uTop, smoothstep(0.1, 0.85, d.y));
  float s = max(dot(d, uSunDir), 0.0);
  c += uSunCol * (pow(s, 6.0) * 0.28 + pow(s, 48.0) * 0.22) * uDay;
  c *= 1.0 - 0.35 * smoothstep(0.55, 1.0, abs(d.y));
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor.rgb += (n - 0.5) / 255.0;
}
`;

// ---------------------------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------------------------

/**
 * The terrarium renderer. Constructed once by main.js as `new Renderer(canvas, sim)`.
 * Exposes `scene`, `camera`, `controls` and `gl` (the THREE.WebGLRenderer).
 */
export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas the #view canvas
   * @param {object} sim the shared sim context (SPEC §C.1)
   */
  constructor(canvas, sim) {
    this.canvas = canvas;
    this.sim = sim;
    this.world = sim?.world ?? null;

    this.remeshPerFrame = Math.max(1, RCFG.remeshPerFrame ?? 3);
    this.maxPixelRatio = RCFG.maxPixelRatio ?? 1.5;
    this.quality = 0;                 // 0 full, 1 no shadows, 2 pixelRatio 1, 3 glowmap 64²
    this._time = 0;
    this._errors = new Map();

    // --- WebGL renderer -------------------------------------------------------------------
    const gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.0;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.localClippingEnabled = true;
    gl.setClearColor(col(PALETTE.desk), 1);
    this.gl = gl;
    /** Alias of `gl` for modules that expect the three.js renderer under a descriptive name. */
    this.webgl = gl;
    this.pixelRatio = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, this.maxPixelRatio);
    gl.setPixelRatio(this.pixelRatio);

    // --- Scene, camera, controls ----------------------------------------------------------
    this.scene = new THREE.Scene();
    this.scene.background = null;
    const camCfg = RCFG.camera || {};
    const tgt = camCfg.target || [56, 18, 56];
    const pos = camCfg.pos || [140, 75, 140];
    this.camera = new THREE.PerspectiveCamera(RCFG.fov ?? 50, 1, 0.5, 3000);
    this.camera.position.set(pos[0], pos[1], pos[2]);

    this.controls = new OrbitControls(this.camera, canvas);
    const c = this.controls;
    c.target.set(tgt[0], tgt[1], tgt[2]);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.minDistance = camCfg.minDist ?? 10;
    c.maxDistance = camCfg.maxDist ?? 190;
    c.maxPolarAngle = 0.49 * PI;
    c.screenSpacePanning = false;
    c.rotateSpeed = 0.6;
    c.panSpeed = 0.9;
    c.zoomSpeed = 1.0;
    this.orbitMode = 'inspect';
    this.setOrbitMode('inspect');
    c.update();
    this._onControlsStart = () => { this._fly = null; };
    c.addEventListener('start', this._onControlsStart);

    // --- Shared terrain uniforms ----------------------------------------------------------
    this.cutY = null;
    this.cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), CUT_OFF);
    this.uniforms = {
      uGlow: { value: null },
      uNight: { value: 0 },
      uEclipse: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      uCutY: { value: CUT_OFF },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color(0, 0, 0) },
      uSkyCol: { value: col(PALETTE.sky) },
      uCapCol: { value: col(PALETTE.cap) },
      uCutCol: { value: col(PALETTE.cutEdge) },
    };
    this._eclSeen = new Map();
    this._eclGen = 0;
    this._eclActive = false;
    this._eclPrune = (seen, key, map) => { if (seen.gen !== this._eclGen) map.delete(key); };

    this._initGlow(RCFG.glowmapSize ?? 128);
    this._initMaterials();
    this._initLights();
    this._initEnvironment();
    this._initScenery();
    this._initJar();

    this.terrain = new THREE.Group();
    this.terrain.name = 'terrain';
    this.scene.add(this.terrain);
    /** chunkKey → {opaque: Mesh|null, transparent: Mesh|null} */
    this.chunks = new Map();

    // --- Camera motion state ---------------------------------------------------------------
    this.followId = null;
    this._fly = null;
    this._flyFromT = new THREE.Vector3();
    this._flyToT = new THREE.Vector3();
    this._flyFromC = new THREE.Vector3();
    this._flyToC = new THREE.Vector3();
    this._trauma = 0;
    this._keys = { w: false, a: false, s: false, d: false, q: false, e: false };
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    // --- Adaptive quality & debug ---------------------------------------------------------
    this._frameMs = 16.7;
    this._slowT = 0;
    this._warmT = 3;
    this._fps = 60;
    this._remeshMs = 0;
    this._dbgT = 0;
    this._dbgEl = null;
    this._initDebugOverlay();

    // --- Input -----------------------------------------------------------------------------
    this._onKeyDown = e => this._handleKey(e, true);
    this._onKeyUp = e => this._handleKey(e, false);
    this._onBlur = () => { const k = this._keys; k.w = k.a = k.s = k.d = k.q = k.e = false; };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('blur', this._onBlur);
    }

    this.daylight = 1;
    this.night = 0;
    this.hourFloat = 7;
    this.sunDir = this.uniforms.uSunDir.value;
    this._fogDensity = RCFG.fog?.[0] ?? 0.0012;

    this.resize();
    try { this._updateSky(this.sim, 0, 0); } catch (err) { this._warn('sky', err); }
  }

  // ===========================================================================================
  // Public API
  // ===========================================================================================

  /**
   * Meshes every chunk of the world, yielding to the browser every 12 chunks.
   * @param {(frac:number)=>void} [onProgress] called with 0..1
   * @returns {Promise<void>}
   */
  async buildAllChunks(onProgress) {
    const w = this.world || this.sim?.world;
    this.world = w;
    const report = f => { try { if (typeof onProgress === 'function') onProgress(f); } catch (err) { this._warn('progress', err); } };
    if (!w) { report(1); return; }
    // Everything is about to be meshed: drop the worldgen dirty marks.
    if (w.dirty && typeof w.dirty.clear === 'function') w.dirty.clear();
    const { nx, ny, nz } = this._chunkDims();
    const total = nx * ny * nz;
    for (let key = 0; key < total; key++) {
      this._remeshChunk(key);
      if ((key + 1) % YIELD_EVERY === 0) {
        report((key + 1) / total);
        await nextFrame();
      }
    }
    report(1);
    try { this.gl.compile(this.scene, this.camera); } catch (err) { this._warn('compile', err); }
  }

  /**
   * Per-frame update: remeshing, sky and lights, glowmap, eclipses, camera, adaptive quality.
   * Never throws because a sim field is missing.
   * @param {number} realDt real seconds since the last frame
   * @param {object} [sim] the sim context
   * @param {number} [alpha] fraction (0..1) of the way to the next sim tick, for interpolation
   */
  update(realDt, sim, alpha) {
    const dt = Number.isFinite(realDt) ? clamp(realDt, 0, 0.25) : 1 / 60;
    if (sim) this.sim = sim;
    const s = this.sim;
    if (s?.world && this.world !== s.world) this.world = s.world;
    const a = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 0;
    this._time += dt;
    this.uniforms.uTime.value = this._time % 1000;

    const t0 = performance.now();
    try { this._remeshDirty(); } catch (err) { this._warn('remesh', err); }
    this._remeshMs = performance.now() - t0;
    try { this._updateSky(s, dt, a); } catch (err) { this._warn('sky', err); }
    try { this._updateEclipses(s); } catch (err) { this._warn('eclipse', err); }
    try { this._updateGlow(s, a); } catch (err) { this._warn('glow', err); }
    try { this._updateCamera(dt, s, a); } catch (err) { this._warn('camera', err); }
    this._trauma = Math.max(0, this._trauma - dt * SHAKE_DECAY);
    try { this._adaptQuality(dt); } catch (err) { this._warn('quality', err); }
    try { this._updateDebug(dt, s); } catch (err) { this._warn('debug', err); }
  }

  /** Draws the frame (with camera shake applied only for the draw). */
  render() {
    const cam = this.camera;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    if (this._trauma > 0.001) {
      const t = this._time;
      const dist = cam.position.distanceTo(this.controls.target);
      const amp = this._trauma * this._trauma * (0.6 + dist * 0.012);
      sx = amp * (Math.sin(t * 37.1) * 0.6 + Math.sin(t * 23.7 + 1.3) * 0.4);
      sy = amp * (Math.sin(t * 41.3 + 2.1) * 0.6 + Math.sin(t * 19.1 + 0.4) * 0.4);
      sz = amp * (Math.sin(t * 29.9 + 4.2) * 0.6 + Math.sin(t * 31.7 + 3.3) * 0.4);
      cam.position.x += sx; cam.position.y += sy; cam.position.z += sz;
    }
    this.gl.render(this.scene, cam);
    if (sx !== 0 || sy !== 0 || sz !== 0) {
      cam.position.x -= sx; cam.position.y -= sy; cam.position.z -= sz;
      cam.updateMatrixWorld();
    }
  }

  /** Matches the drawing buffer and camera to the canvas' CSS size. */
  resize() {
    const cv = this.canvas;
    const w = Math.max(1, (cv && cv.clientWidth) || (typeof window !== 'undefined' ? window.innerWidth : 1) || 1);
    const h = Math.max(1, (cv && cv.clientHeight) || (typeof window !== 'undefined' ? window.innerHeight : 1) || 1);
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.pixelRatio = this.quality >= 2 ? 1 : Math.min(dpr, this.maxPixelRatio);
    this.gl.setPixelRatio(this.pixelRatio);
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * World-space picking ray through a client (CSS pixel) point.
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{origin:{x:number,y:number,z:number}, dir:{x:number,y:number,z:number}}}
   */
  pickRay(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || 1;
    const h = rect.height || 1;
    this._ndc.set(((clientX - rect.left) / w) * 2 - 1, -((clientY - rect.top) / h) * 2 + 1);
    this.camera.updateMatrixWorld();
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const o = this._raycaster.ray.origin;
    const d = this._raycaster.ray.direction;
    return { origin: { x: o.x, y: o.y, z: o.z }, dir: { x: d.x, y: d.y, z: d.z } };
  }

  /**
   * Follow an agent (camera target lerps to it at 6/s; orbiting keeps working), or stop with null.
   * @param {number|null} agentId
   */
  setFollowTarget(agentId) {
    this.followId = agentId == null ? null : agentId;
    if (this.followId != null) this._fly = null;
  }

  /**
   * 1 s eased flight of the target to `pos`, keeping the current viewing direction.
   * @param {{x:number,y:number,z:number}} pos
   * @param {number} [dist=40] camera distance at arrival
   */
  flyTo(pos, dist = 40) {
    if (!pos) return;
    const x = Number(pos.x);
    const z = Number(pos.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    let y = Number(pos.y);
    if (!Number.isFinite(y)) y = this._groundY(x, z);
    if (this.followId != null) this._stopFollow();
    const c = this.controls;
    const d = clamp(Number.isFinite(dist) ? dist : 40, c.minDistance, c.maxDistance);
    const dir = _v1.subVectors(this.camera.position, c.target);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.7, 1);
    dir.normalize();
    if (dir.y < 0.3) { dir.y = 0.3; dir.normalize(); }
    this._flyFromT.copy(c.target);
    this._flyFromC.copy(this.camera.position);
    this._flyToT.set(x, y, z);
    this._clampTargetVec(this._flyToT);
    this._flyToC.copy(this._flyToT).addScaledVector(dir, d);
    this._fly = { t: 0 };
  }

  /**
   * Adds camera-shake trauma (0..1). Tap the Glass uses 0.4.
   * @param {number} amount
   */
  shake(amount) {
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) return;
    this._trauma = Math.min(1, this._trauma + a);
  }

  /**
   * Cutaway: hides terrain above voxel level `y` (the level itself stays), or restores it with null.
   * @param {number|null} y
   */
  setCutaway(y) {
    const n = y == null ? NaN : Number(y);
    const on = Number.isFinite(n);
    this.cutY = on ? n : null;
    const cut = on ? n + 1.02 : CUT_OFF;
    this.uniforms.uCutY.value = cut;
    this.cutPlane.constant = cut;
    const side = on ? THREE.DoubleSide : THREE.FrontSide;
    if (this.terrainMat.side !== side) {
      this.terrainMat.side = side;
      this.terrainMat.needsUpdate = true;
    }
  }

  /**
   * Maps mouse buttons for the active tool.
   * 'inspect': LMB orbits, RMB pans, wheel zooms. 'tool': LMB free for the tool, RMB orbits,
   * Shift+RMB pans (OrbitControls' modifier rule), wheel zooms.
   * @param {'inspect'|'tool'} mode
   */
  setOrbitMode(mode) {
    const c = this.controls;
    const tool = mode === 'tool';
    this.orbitMode = tool ? 'tool' : 'inspect';
    if (tool) {
      c.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
      c.touches = { ONE: -1, TWO: THREE.TOUCH.DOLLY_ROTATE };
    } else {
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    }
  }

  /** Releases GPU resources and listeners (not needed in normal play; the page reloads on reroll). */
  dispose() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('blur', this._onBlur);
    }
    this.controls.removeEventListener('start', this._onControlsStart);
    this.controls.dispose();
    for (const entry of this.chunks.values()) {
      if (entry.opaque) entry.opaque.geometry.dispose();
      if (entry.transparent) entry.transparent.geometry.dispose();
    }
    this.chunks.clear();
    this.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      if (Array.isArray(m)) m.forEach(x => x.dispose()); else if (m) m.dispose();
    });
    this.glowTex?.dispose();
    this.envMap?.dispose();
    this._dbgEl?.remove();
    this.gl.dispose();
  }

  // ===========================================================================================
  // Chunks
  // ===========================================================================================

  _chunkDims() {
    const w = this.world;
    const S = w?.CHUNK ?? CHUNK;
    return {
      S,
      nx: w?.NCX ?? Math.ceil((w?.SX ?? WORLD_X) / S),
      ny: w?.NCY ?? Math.ceil((w?.SY ?? WORLD_Y) / S),
      nz: w?.NCZ ?? Math.ceil((w?.SZ ?? WORLD_Z) / S),
    };
  }

  _remeshDirty() {
    const w = this.world;
    if (!w || !w.dirty || w.dirty.size === 0 || typeof w.takeDirty !== 'function') return;
    const keys = w.takeDirty(this.remeshPerFrame);
    if (!keys) return;
    for (let i = 0; i < keys.length; i++) this._remeshChunk(keys[i]);
  }

  _remeshChunk(key) {
    const w = this.world;
    if (!w) return;
    const { S, nx, nz } = this._chunkDims();
    let cx;
    let cy;
    let cz;
    if (typeof w.chunkCoords === 'function') {
      const cc = w.chunkCoords(key);
      if (!cc) return;
      cx = cc.cx; cy = cc.cy; cz = cc.cz;
    } else {
      cx = key % nx;
      cz = Math.floor(key / nx) % nz;
      cy = Math.floor(key / (nx * nz));
    }
    let data;
    try {
      data = meshChunk(w, cx, cy, cz);
    } catch (err) {
      this._warn('mesher', err);
      return;
    }
    let entry = this.chunks.get(key);
    if (!entry) {
      entry = { opaque: null, transparent: null };
      this.chunks.set(key, entry);
    }
    const ccx = cx * S + S / 2;
    const ccy = cy * S + S / 2;
    const ccz = cz * S + S / 2;
    const rad = S * 0.8660254 + 1;
    entry.opaque = this._applyMesh(entry.opaque, data?.opaque, false, ccx, ccy, ccz, rad);
    entry.transparent = this._applyMesh(entry.transparent, data?.transparent, true, ccx, ccy, ccz, rad);
    if (!entry.opaque && !entry.transparent) this.chunks.delete(key);
  }

  _applyMesh(mesh, md, transparent, cx, cy, cz, rad) {
    const vc = md ? md.vertexCount | 0 : 0;
    if (!md || vc === 0 || !md.indices || md.indices.length === 0) {
      if (mesh) {
        this.terrain.remove(mesh);
        mesh.geometry.dispose();
      }
      return null;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(md.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(md.normals, 3));
    const stride = md.colors.length >= vc * 4 ? 4 : 3;
    g.setAttribute('color', new THREE.BufferAttribute(md.colors, stride));
    g.setAttribute('aEmit', new THREE.BufferAttribute(md.emit, 1));
    const idx = vc <= 65535 ? new Uint16Array(md.indices) : md.indices;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), rad);
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(cx - rad, cy - rad, cz - rad), new THREE.Vector3(cx + rad, cy + rad, cz + rad));
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = g;
      return mesh;
    }
    const m = new THREE.Mesh(g, transparent ? this.transparentMat : this.terrainMat);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.castShadow = !transparent;
    m.receiveShadow = true;
    if (transparent) m.renderOrder = 2;
    m.name = transparent ? 'chunk-t' : 'chunk-o';
    this.terrain.add(m);
    return m;
  }

  // ===========================================================================================
  // Materials, lights, scenery
  // ===========================================================================================

  _patchTerrain(material, transparent) {
    const uniforms = this.uniforms;
    material.onBeforeCompile = shader => {
      for (const k in uniforms) shader.uniforms[k] = uniforms[k];
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${TERRAIN_VERT_PARS}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${TERRAIN_VERT_MAIN}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${TERRAIN_FRAG_PARS}`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${TERRAIN_FRAG_CUT}`)
        .replace('#include <opaque_fragment>', `${TERRAIN_FRAG_LIGHT}\n#include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => (transparent ? 'wk-terrain-t1' : 'wk-terrain-o1');
  }

  _initMaterials() {
    this.terrainMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      clippingPlanes: [this.cutPlane],
      clipShadows: true,
    });
    this.terrainMat.shadowSide = THREE.BackSide;
    this._patchTerrain(this.terrainMat, false);

    this.transparentMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      clippingPlanes: [this.cutPlane],
      clipShadows: true,
    });
    this.transparentMat.defines = { WK_TRANSPARENT: '' };
    this._patchTerrain(this.transparentMat, true);
  }

  _initLights() {
    const sun = new THREE.DirectionalLight(col(PALETTE.dayKey), SUN_PEAK);
    sun.castShadow = true;
    const ms = RCFG.shadowMap ?? 1024;
    sun.shadow.mapSize.set(ms, ms);
    const sc = sun.shadow.camera;
    sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF;
    sc.near = 1; sc.far = LIGHT_DIST + 140;
    sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.05;
    sun.target.position.set(CX, 14, CZ);
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    this.hemi = new THREE.HemisphereLight(col(PALETTE.sky), col(PALETTE.bounce), HEMI_DAY);
    this.scene.add(this.hemi);

    this.scene.fog = new THREE.FogExp2(col(PALETTE.fogDay), RCFG.fog?.[0] ?? 0.0012);

    // Reused colours (linear).
    this._c = {
      dayKey: col(PALETTE.dayKey), dusk: col(PALETTE.dusk), moon: col(PALETTE.moon),
      sky: col(PALETTE.sky), bounce: col(PALETTE.bounce), night: col(PALETTE.nightAmbient),
      nightGround: col(PALETTE.nightGround), fogDay: col(PALETTE.fogDay), fogNight: col(PALETTE.fogNight),
      bdDay: col(PALETTE.backdropDay), bdNight: col(PALETTE.backdropNight), bdBottom: col(PALETTE.backdropBottom),
      duskSky: new THREE.Color().lerpColors(col(PALETTE.sky), col(PALETTE.dusk), 0.55),
      t1: new THREE.Color(),
    };
  }

  _initEnvironment() {
    this.envMap = null;
    try {
      const pmrem = new THREE.PMREMGenerator(this.gl);
      const room = new RoomEnvironment();
      this.envMap = pmrem.fromScene(room, 0.04).texture;
      if (typeof room.dispose === 'function') room.dispose();
      pmrem.dispose();
    } catch (err) {
      this._warn('environment', err);
    }
  }

  _initScenery() {
    const seed = (this.sim?.seed ?? 0) >>> 0;
    const maxAniso = Math.min(8, this.gl.capabilities.getMaxAnisotropy?.() || 1);

    // Study backdrop: inverted sphere with a daylight-lerped vertical gradient.
    this.backdropMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: col(PALETTE.backdropDay) },
        uBottom: { value: col(PALETTE.backdropBottom) },
        uSunDir: this.uniforms.uSunDir,
        uSunCol: { value: new THREE.Color(0, 0, 0) },
        uDay: { value: 1 },
      },
      vertexShader: BACKDROP_VERT,
      fragmentShader: BACKDROP_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    const backdrop = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), this.backdropMat);
    backdrop.position.set(CX, 0, CZ);
    backdrop.renderOrder = -10;
    backdrop.frustumCulled = false;
    this.scene.add(backdrop);
    this.backdrop = backdrop;

    // Walnut desk.
    const grain = this._makeWalnutTexture(seed);
    grain.anisotropy = maxAniso;
    grain.repeat.set(3, 3);
    this.deskMat = new THREE.MeshStandardMaterial({
      map: grain, roughness: 0.52, metalness: 0, envMap: this.envMap, envMapIntensity: 0.25, fog: false,
    });
    const desk = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.deskMat);
    desk.rotation.x = -PI / 2;
    desk.position.set(CX, DESK_Y, CZ);
    desk.receiveShadow = true;
    this.scene.add(desk);

    // Desk edge vignette: fades the far desk into exactly the backdrop's floor colour (both untonemapped,
    // colour synced each frame), so the desk's square edge never shows against the study wall.
    this.vigMat = new THREE.MeshBasicMaterial({
      map: this._makeRadialAlphaTexture([[0, 0], [0.55, 0], [0.8, 0.62], [0.96, 1], [1, 1]]),
      color: col(PALETTE.backdropBottom), transparent: true, depthWrite: false, fog: false, toneMapped: false,
    });
    const vig = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.vigMat);
    vig.rotation.x = -PI / 2;
    vig.position.set(CX, DESK_Y + 0.05, CZ);
    vig.renderOrder = -5;
    this.scene.add(vig);

    // Soft contact shadow of the plinth on the desk.
    const contact = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.MeshBasicMaterial({
      map: this._makeRadialAlphaTexture([[0, 0.7], [0.74, 0.62], [0.78, 0.4], [0.9, 0.08], [1, 0]]),
      color: col('#0A0604'), transparent: true, depthWrite: false, fog: false,
    }));
    contact.rotation.x = -PI / 2;
    contact.position.set(CX, DESK_Y + 0.03, CZ);
    contact.renderOrder = -6;
    this.scene.add(contact);

    // Plinth: ebonised walnut drum under the island, brass rings, engraved seed plate.
    const sideTex = grain.clone();
    sideTex.repeat.set(3, 0.03);
    sideTex.needsUpdate = true;
    this.plinthMats = [
      new THREE.MeshStandardMaterial({ map: sideTex, color: col('#B09682'), roughness: 0.45, metalness: 0, envMap: this.envMap, envMapIntensity: 0.3, fog: false }),
      new THREE.MeshStandardMaterial({ color: col('#1C130D'), roughness: 0.55, metalness: 0, envMap: this.envMap, envMapIntensity: 0.2, fog: false }),
    ];
    // The top sits a hair below y=0 so the cutaway's section caps (island underside at y=0) never z-fight it.
    const plinthH = -DESK_Y - 0.03;
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(PLINTH_R, PLINTH_R, plinthH, 160, 1, false),
      [this.plinthMats[0], this.plinthMats[1], this.plinthMats[1]]);
    plinth.position.set(CX, DESK_Y + plinthH / 2, CZ);
    plinth.receiveShadow = true;
    plinth.castShadow = true;
    this.scene.add(plinth);

    this.brassMat = new THREE.MeshStandardMaterial({
      color: col(PALETTE.brass), metalness: 0.88, roughness: 0.3, envMap: this.envMap, envMapIntensity: 0.9, fog: false,
    });
    const ring = (r, tube, y) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 14, 200), this.brassMat);
      m.rotation.x = PI / 2;
      m.position.set(CX, y, CZ);
      m.receiveShadow = true;
      this.scene.add(m);
      return m;
    };
    ring(PLINTH_R + 0.05, 0.55, 0);                 // brass ring at the plinth's top edge
    ring(PLINTH_R + 0.1, 0.4, DESK_Y + 0.45);       // foot moulding
    ring(JAR_R + 0.3, 0.75, 0.45);                  // collar where the glass meets the plinth

    // Seed plate, curved to sit flush on the plinth, facing the default camera (+X+Z).
    const plateH = 2.3;
    const plateW = plateH * 8;
    const plateR = PLINTH_R + 0.08;
    const thetaLen = plateW / plateR;
    const plateTex = new THREE.CanvasTexture(document.createElement('canvas'));
    plateTex.colorSpace = THREE.SRGBColorSpace;
    plateTex.anisotropy = maxAniso;
    const hex = seed.toString(16).toUpperCase();
    const drawPlate = () => { this._drawPlate(plateTex.image, hex); plateTex.needsUpdate = true; };
    drawPlate();
    if (typeof document !== 'undefined' && document.fonts && typeof document.fonts.load === 'function') {
      document.fonts.load('96px "IM Fell English SC"').then(drawPlate, () => {});
    }
    this.plateMat = new THREE.MeshStandardMaterial({
      map: plateTex, metalness: 0.7, roughness: 0.38, envMap: this.envMap, envMapIntensity: 0.9, fog: false,
    });
    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(plateR, plateR, plateH, 48, 1, true, PI / 4 - thetaLen / 2, thetaLen), this.plateMat);
    plate.position.set(CX, DESK_Y + 2.2, CZ);
    this.scene.add(plate);
  }

  _initJar() {
    const domeH = JAR_R * 0.42;
    const parts = [];
    const cyl = new THREE.CylinderGeometry(JAR_R, JAR_R, JAR_H, 128, 1, true);
    cyl.translate(0, JAR_H / 2, 0);
    parts.push(cyl);
    const dome = new THREE.SphereGeometry(JAR_R, 128, 24, 0, PI * 2, 0, PI / 2);
    dome.scale(1, domeH / JAR_R, 1);
    dome.translate(0, JAR_H, 0);
    parts.push(dome);
    const neck = new THREE.CylinderGeometry(1.1, 1.6, 2.4, 24, 1, true);
    neck.translate(0, JAR_H + domeH + 1.0, 0);
    parts.push(neck);
    const knob = new THREE.SphereGeometry(2.5, 32, 16);
    knob.translate(0, JAR_H + domeH + 3.6, 0);
    parts.push(knob);
    let geo = null;
    try { geo = mergeGeometries(parts, false); } catch (err) { this._warn('jar', err); }
    this.jarUniforms = {
      uRim: { value: col(PALETTE.glassRim) },
      uTint: { value: col(PALETTE.glassTint) },
      uDusk: { value: col(PALETTE.dusk) },
      uNightTint: { value: col(PALETTE.moon) },
      uHazeCol: { value: col(PALETTE.dayKey) },
      uSunDir: this.uniforms.uSunDir,
      uSunCol: { value: new THREE.Color(1, 1, 1) },
      uWinCol: { value: new THREE.Color(1, 1, 1) },
      uFlush: { value: 0 },
      uNight: { value: 0 },
      uHaze: { value: 0 },
      uSun: { value: 1 },
      uDay: { value: 1 },
    };
    this.jarMat = new THREE.ShaderMaterial({
      uniforms: this.jarUniforms,
      vertexShader: JAR_VERT,
      fragmentShader: JAR_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const group = new THREE.Group();
    group.name = 'belljar';
    if (geo) {
      const m = new THREE.Mesh(geo, this.jarMat);
      m.renderOrder = 10;
      group.add(m);
      for (const p of parts) p.dispose();
    } else {
      for (const p of parts) {
        const m = new THREE.Mesh(p, this.jarMat);
        m.renderOrder = 10;
        group.add(m);
      }
    }
    group.position.set(CX, 0, CZ);
    this.scene.add(group);
    this.jar = group;
  }

  _makeWalnutTexture(seed) {
    const W = 1024;
    const H = 512;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const rand = mulberry32(seed ^ 0x57A1D0);
    const figure = makeTileNoise(rand, 4, 3);
    const figure2 = makeTileNoise(rand, 8, 6);
    const fibre = makeTileNoise(rand, 6, 300);
    const pore = makeTileNoise(rand, 96, 480);
    // sRGB endpoints of the walnut: deep heartwood → warm highlight.
    const dk = [24, 15, 10];
    const lt = [104, 70, 44];
    const rd = [92, 50, 30];
    for (let y = 0; y < H; y++) {
      const v = y / H;
      for (let x = 0; x < W; x++) {
        const u = x / W;
        const n1 = figure(u * 4, v * 3) * 0.7 + figure2(u * 8, v * 6) * 0.3;
        const ringC = v * 18 + n1 * 3.2 + 0.55 * Math.sin(2 * PI * (u * 2 + n1));
        const fr = ringC - Math.floor(ringC);
        const dd = fr < 0.5 ? fr : 1 - fr;
        const line = Math.exp(-dd * dd * 160);
        const late = smoothstep(0.15, 0.6, fr) * 0.25;
        const fib = fibre(u * 6, v * 300);
        const pr = pore(u * 96, v * 480);
        let lum = 0.5 + 0.28 * (n1 - 0.5) + 0.2 * (fib - 0.5) - 0.34 * line - late * 0.4;
        if (pr > 0.86) lum -= (pr - 0.86) * 1.6;
        lum = clamp(lum, 0, 1);
        const red = clamp((n1 - 0.45) * 1.6, 0, 1) * 0.35;
        const o = (x + W * y) * 4;
        for (let k = 0; k < 3; k++) {
          const base = dk[k] + (lt[k] - dk[k]) * lum;
          d[o + k] = base + (rd[k] - base) * red * lum;
        }
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  /**
   * White radial gradient texture whose alpha follows `stops` ([t, alpha], t = radius fraction);
   * the corners beyond the circle keep the last alpha. The material colour tints it.
   */
  _makeRadialAlphaTexture(stops) {
    const S = 512;
    const cv = document.createElement('canvas');
    cv.width = S;
    cv.height = S;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    for (const [t, a] of stops) g.addColorStop(t, `rgba(255,255,255,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _drawPlate(cv, hex) {
    const W = 2048;
    const H = 256;
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#E4C88F');
    g.addColorStop(0.35, '#C9A45C');
    g.addColorStop(0.7, '#B08D57');
    g.addColorStop(1, '#8A6A34');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Brushed metal.
    const rand = mulberry32(0xB2A55 ^ W);
    for (let i = 0; i < 420; i++) {
      const y = rand() * H;
      ctx.fillStyle = rand() < 0.5 ? 'rgba(255,240,200,0.07)' : 'rgba(60,40,15,0.07)';
      ctx.fillRect(rand() * W * 0.2, y, W * (0.4 + rand() * 0.6), 1 + rand() * 1.5);
    }
    // Bevelled double border.
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(70,48,20,0.85)';
    ctx.strokeRect(10, 10, W - 20, H - 20);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,238,196,0.7)';
    ctx.strokeRect(15, 15, W - 30, H - 30);
    ctx.strokeStyle = 'rgba(70,48,20,0.7)';
    ctx.strokeRect(30, 30, W - 60, H - 60);
    // Screws.
    for (const sx of [58, W - 58]) {
      const sg = ctx.createRadialGradient(sx - 6, H / 2 - 6, 2, sx, H / 2, 22);
      sg.addColorStop(0, '#F3DDA8');
      sg.addColorStop(0.6, '#A5824B');
      sg.addColorStop(1, '#5E4420');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(sx, H / 2, 20, 0, PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(40,26,10,0.9)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(sx - 13, H / 2 + 5);
      ctx.lineTo(sx + 13, H / 2 - 5);
      ctx.stroke();
    }
    // Engraved legend.
    const text = `WICKMARKET · No. ${hex}`;
    let size = 120;
    const family = '"IM Fell English SC", Georgia, "Times New Roman", serif';
    ctx.font = `${size}px ${family}`;
    const maxW = W - 240;
    const tw = ctx.measureText(text).width;
    if (tw > maxW) {
      size = Math.floor(size * maxW / tw);
      ctx.font = `${size}px ${family}`;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,240,205,0.75)';
    ctx.fillText(text, W / 2, H / 2 + 5);
    ctx.fillStyle = '#2A1C10';
    ctx.fillText(text, W / 2, H / 2 + 2);
    ctx.fillStyle = 'rgba(10,6,2,0.55)';
    ctx.fillText(text, W / 2, H / 2);
  }

  // ===========================================================================================
  // Time of day: sun / moon, ambient, fog, backdrop, jar
  // ===========================================================================================

  _updateSky(sim, dt, alpha) {
    const clock = sim?.clock;
    const tick = finiteOr(clock?.tick, (CONFIG.time?.startHour ?? 7) * TICKS_PER_HOUR);
    const hf = ((((tick + alpha) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY) / TICKS_PER_HOUR;
    const daylight = clamp(finiteOr(clock?.daylight, daylightAt(hf)), 0, 1);
    const night = 1 - daylight;
    this.hourFloat = hf;
    this.daylight = daylight;
    this.night = night;
    const C = this._c;

    const sunW = smoothstep(0.35, 1, daylight);
    const moonW = 1 - smoothstep(0, 0.35, daylight);
    const isSun = daylight >= 0.35;
    let s;
    let maxEl;
    let tilt;
    if (isSun) { s = clamp((hf - 6) / 12, 0, 1); maxEl = SUN_MAX_EL; tilt = -0.55; } else {
      s = clamp((((hf - 18) % 24) + 24) % 24 / 12, 0, 1); maxEl = MOON_MAX_EL; tilt = 0.35;
    }
    const trueEl = maxEl * Math.sin(PI * s);
    const el = Math.max(MIN_LIGHT_EL, trueEl);
    const az = PI * s;
    const ce = Math.cos(el);
    const dir = this.uniforms.uSunDir.value;
    dir.set(Math.cos(az) * ce, Math.sin(el), Math.sin(az) * ce * tilt).normalize();
    const sun = this.sun;
    sun.position.set(CX + dir.x * LIGHT_DIST, 14 + dir.y * LIGHT_DIST, CZ + dir.z * LIGHT_DIST);

    const high = smoothstep(0, 0.5, Math.sin(Math.max(0, trueEl)));
    if (isSun) {
      sun.color.lerpColors(C.dusk, C.dayKey, high);
      sun.intensity = SUN_PEAK * sunW * (0.3 + 0.7 * high);
    } else {
      sun.color.copy(C.moon);
      sun.intensity = MOON_I * moonW;
    }

    // Dusk flush peaks at 18:00 (±1 h); a softer one greets the dawn.
    const flush = Math.max(1 - smoothstep(0, 1, Math.abs(hf - 18)), 0.4 * (1 - smoothstep(0, 1, Math.abs(hf - 6))));

    // Hemisphere: sky/bounce by day, night ambient after dark.
    C.t1.lerpColors(C.duskSky, C.sky, high);
    this.hemi.color.lerpColors(C.night, C.t1, daylight);
    this.hemi.groundColor.lerpColors(C.nightGround, C.bounce, daylight);
    this.hemi.intensity = HEMI_NIGHT + (HEMI_DAY - HEMI_NIGHT) * daylight;

    // Fog: colour by daylight (warmed at dusk), density by haze 1 − η.
    const fog = this.scene.fog;
    fog.color.lerpColors(C.fogNight, C.fogDay, daylight).lerp(C.dusk, flush * 0.45);
    const etaRaw = Number(sim?.ledger?.haze);
    const eta = Number.isFinite(etaRaw) ? clamp(etaRaw, 0, 1) : 1;
    const haze = 1 - eta;
    const f0 = RCFG.fog?.[0] ?? 0.0012;
    const f1 = RCFG.fog?.[1] ?? 0.006;
    const targetD = f0 + (f1 - f0) * haze;
    this._fogDensity += (targetD - this._fogDensity) * Math.min(1, dt * 1.5 + (dt === 0 ? 1 : 0));
    fog.density = this._fogDensity;

    // Exposure opens a little at night so the flame pools read.
    this.gl.toneMappingExposure = 1.0 + 0.25 * night;

    // Backdrop.
    const bu = this.backdropMat.uniforms;
    bu.uTop.value.lerpColors(C.bdNight, C.bdDay, daylight).lerp(C.dusk, flush * 0.3);
    // SPEC bottom #2A1C14 by day; it sinks toward half that at night so the unlit desk stays darkest.
    bu.uBottom.value.copy(C.bdBottom).multiplyScalar(0.45 + 0.55 * daylight);
    this.vigMat.color.copy(bu.uBottom.value);
    bu.uSunCol.value.copy(sun.color).multiplyScalar(isSun ? sunW : 0.25 * moonW);
    bu.uDay.value = isSun ? 1 : 0.5;

    // Jar.
    const ju = this.jarUniforms;
    ju.uFlush.value = flush;
    ju.uNight.value = night;
    ju.uHaze.value = haze;
    ju.uSun.value = isSun ? sunW * (0.3 + 0.7 * high) : 0.35 * moonW;
    ju.uDay.value = daylight;
    ju.uSunCol.value.copy(sun.color);
    ju.uWinCol.value.lerpColors(C.moon, C.dayKey, daylight);

    // Terrain uniforms.
    this.uniforms.uNight.value = night;
    this.uniforms.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity / PI);
    this.uniforms.uSkyCol.value.copy(this.hemi.color).multiplyScalar(0.25 + 0.35 * daylight);

    // Brass and varnish reflections dim with the room.
    const env = 0.08 + 0.82 * daylight;
    this.brassMat.envMapIntensity = env;
    this.plateMat.envMapIntensity = env;
    this.deskMat.envMapIntensity = 0.05 + 0.2 * daylight;
    this.plinthMats[0].envMapIntensity = 0.05 + 0.25 * daylight;
  }

  // ===========================================================================================
  // Eclipses
  // ===========================================================================================

  _updateEclipses(sim) {
    const u = this.uniforms.uEclipse.value;
    const list = sim?.effects?.eclipses;
    const tick = finiteOr(sim?.clock?.tick, 0);
    const gen = ++this._eclGen;
    const now = this._time;
    let n = 0;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length && n < 3; i++) {
        const e = list[i];
        if (!e) continue;
        const until = Number(e.untilTick);
        const x = Number(e.x);
        const z = Number(e.z);
        const r = Number(e.r);
        if (!(until > tick) || !Number.isFinite(x) || !Number.isFinite(z) || !(r > 0)) continue;
        const key = e.id ?? i;
        let seen = this._eclSeen.get(key);
        if (!seen) { seen = { t0: now, gen }; this._eclSeen.set(key, seen); }
        seen.gen = gen;
        const fadeIn = clamp((now - seen.t0) / 0.6, 0, 1);
        const fadeOut = clamp((until - tick) / 30, 0, 1);
        u[n].set(x, z, r, fadeIn * fadeOut);
        n++;
      }
    }
    for (; n < 3; n++) u[n].set(0, 0, 0, 0);
    if (this._eclSeen.size > 0) this._eclSeen.forEach(this._eclPrune);
    this._eclActive = this._eclSeen.size > 0;
  }

  // ===========================================================================================
  // Glowmap
  // ===========================================================================================

  _initGlow(size) {
    const N = Math.max(16, size | 0);
    this.glowN = N;
    const data = new Uint8Array(N * N * 4);
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    const old = this.glowTex;
    this.glowTex = tex;
    this._glowData = data;
    this._glowAcc = new Float32Array(N * N * 5);
    this._glowScale = N / WORLD_X;
    this._glowDirty = true;
    // Rows of the accumulator touched by last frame's splats (cleared lazily) and by this frame's.
    this._accLo = 0;
    this._accHi = N - 1;
    this._curLo = N;
    this._curHi = -1;
    this.uniforms.uGlow.value = tex;
    if (old) old.dispose();

    // Precomputed sub-texel kernels: a broad pool plus a hot core, reaching exactly 0 at the rim.
    const texel = WORLD_X / N;
    const rad = Math.max(1, RCFG.glowRadius ?? 4);
    const sigma = rad * 0.5;
    const sigmaCore = rad * 0.18;
    const reach = rad * 1.3;
    const profile = d => 0.72 * Math.exp(-(d * d) / (2 * sigma * sigma)) + 0.28 * Math.exp(-(d * d) / (2 * sigmaCore * sigmaCore));
    const edge = profile(reach);
    const Rt = Math.ceil(reach / texel);
    const D = 2 * Rt + 1;
    const K = new Float32Array(GLOW_KSUB * GLOW_KSUB * D * D);
    for (let qz = 0; qz < GLOW_KSUB; qz++) {
      for (let qx = 0; qx < GLOW_KSUB; qx++) {
        const base = (qz * GLOW_KSUB + qx) * D * D;
        const fx = qx / GLOW_KSUB;
        const fz = qz / GLOW_KSUB;
        for (let dz = -Rt; dz <= Rt; dz++) {
          for (let dx = -Rt; dx <= Rt; dx++) {
            const wx = (dx - fx) * texel;
            const wz = (dz - fz) * texel;
            const dist = Math.sqrt(wx * wx + wz * wz);
            const v = dist >= reach ? 0 : (profile(dist) - edge) / (1 - edge);
            K[base + (dz + Rt) * D + (dx + Rt)] = v > 0 ? v : 0;
          }
        }
      }
    }
    this._kR = Rt;
    this._kD = D;
    this._kernels = K;
  }

  _splat(x, z, y, I, r, g, b) {
    const N = this.glowN;
    const acc = this._glowAcc;
    const K = this._kernels;
    const R = this._kR;
    const D = this._kD;
    const tx = x * this._glowScale - 0.5;
    const tz = z * this._glowScale - 0.5;
    let ix = Math.floor(tx);
    let iz = Math.floor(tz);
    let qx = ((tx - ix) * GLOW_KSUB + 0.5) | 0;
    let qz = ((tz - iz) * GLOW_KSUB + 0.5) | 0;
    if (qx >= GLOW_KSUB) { qx = 0; ix++; }
    if (qz >= GLOW_KSUB) { qz = 0; iz++; }
    if (ix + R < 0 || iz + R < 0 || ix - R >= N || iz - R >= N) return;
    const lo = iz - R < 0 ? 0 : iz - R;
    const hi = iz + R >= N ? N - 1 : iz + R;
    if (lo < this._curLo) this._curLo = lo;
    if (hi > this._curHi) this._curHi = hi;
    const base = (qz * GLOW_KSUB + qx) * D * D;
    const ir = I * r;
    const ig = I * g;
    const ib = I * b;
    const iy = I * y;
    for (let dz = -R; dz <= R; dz++) {
      const zz = iz + dz;
      if (zz < 0 || zz >= N) continue;
      const krow = base + (dz + R) * D + R;
      const row = zz * N;
      for (let dx = -R; dx <= R; dx++) {
        const xx = ix + dx;
        if (xx < 0 || xx >= N) continue;
        const k = K[krow + dx];
        if (k <= 0) continue;
        const o = (row + xx) * 5;
        acc[o] += k * ir;
        acc[o + 1] += k * ig;
        acc[o + 2] += k * ib;
        acc[o + 3] += k * I;
        acc[o + 4] += k * iy;
      }
    }
  }

  _updateGlow(sim, alpha) {
    // Flame light only shows at night or inside an eclipse; skip the splat when it cannot be seen.
    const visible = this.night > 0.002 || this._eclActive;
    if (!visible) {
      if (this._glowDirty) {
        this._glowData.fill(0);
        this.glowTex.needsUpdate = true;
        this._glowDirty = false;
      }
      return;
    }
    const acc = this._glowAcc;
    const N = this.glowN;
    if (this._accHi >= this._accLo) acc.fill(0, this._accLo * N * 5, (this._accHi + 1) * N * 5);
    this._curLo = N;
    this._curHi = -1;
    const now = this._time;
    const agents = sim?.population?.agents;
    if (Array.isArray(agents)) {
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        if (!a || a.alive === false) continue;
        const p = a.pos;
        if (!p) continue;
        let x = p.x;
        let y = p.y;
        let z = p.z;
        const q = a.prevPos;
        if (q && alpha > 0 && alpha < 1) {
          x = q.x + (x - q.x) * alpha;
          y = q.y + (y - q.y) * alpha;
          z = q.z + (z - q.z) * alpha;
        }
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        const money = (Number(a.glim) || 0) + (Number(a.escrow) || 0);
        const w = money > 0 ? Math.min(1, Math.log2(1 + money / 10) / 4) : 0;
        let I = 0.25 + 0.75 * w;
        const id = a.id | 0;
        I *= 0.93 + 0.04 * Math.sin(now * 11.3 + id * 1.93) + 0.03 * Math.sin(now * 17.9 + id * 0.71);
        if (a.asleep) I *= 0.6;
        const ri = ((w * (RAMP_N - 1) + 0.5) | 0) * 3;
        let r = RAMP[ri];
        let g = RAMP[ri + 1];
        let b = RAMP[ri + 2];
        const rs = a.rumor && Number.isFinite(a.rumor.strength) ? Math.min(1, Math.max(0, a.rumor.strength)) : 0;
        if (rs > 0) {                            // tint by conviction, matching the flame
          const k = 0.35 * rs;
          r += (RUMOUR_LIN.r - r) * k;
          g += (RUMOUR_LIN.g - g) * k;
          b += (RUMOUR_LIN.b - b) * k;
        }
        this._splat(x, z, y + FLAME_LIFT, I * GLOW_GAIN, r, g, b);
      }
    }
    const prod = sim?.production;
    if (prod && typeof prod.litLanterns === 'function') {
      const L = prod.litLanterns();
      if (Array.isArray(L)) {
        for (let i = 0; i < L.length; i++) {
          const l = L[i];
          if (!l) continue;
          const x = Number(l.x) + 0.5;
          const y = Number(l.y) + 0.5;
          const z = Number(l.z) + 0.5;
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
          const I = LANTERN_GLOW * GLOW_GAIN * (0.95 + 0.05 * Math.sin(now * 3.1 + i * 2.3));
          this._splat(x, z, y, I, LANTERN_LIN.r, LANTERN_LIN.g, LANTERN_LIN.b);
        }
      }
    }

    // Pack rows touched this frame or last (all others are already zero): sqrt-encoded RGB,
    // weighted flame height (×4) in alpha.
    const data = this._glowData;
    const rowLo = Math.min(this._accLo, this._curLo);
    const rowHi = Math.max(this._accHi, this._curHi);
    this._accLo = this._curLo;
    this._accHi = this._curHi;
    const last = GLOW_LUT_N - 1;
    const i0 = rowLo * N;
    const i1 = (rowHi + 1) * N;
    for (let i = i0, o = i0 * 5, d = i0 * 4; i < i1; i++, o += 5, d += 4) {
      const wsum = acc[o + 3];
      if (wsum <= 1e-6) {
        data[d] = 0; data[d + 1] = 0; data[d + 2] = 0; data[d + 3] = 0;
        continue;
      }
      let k = acc[o] * GLOW_LUT_K;
      data[d] = k >= last ? 255 : GLOW_LUT[k | 0];
      k = acc[o + 1] * GLOW_LUT_K;
      data[d + 1] = k >= last ? 255 : GLOW_LUT[k | 0];
      k = acc[o + 2] * GLOW_LUT_K;
      data[d + 2] = k >= last ? 255 : GLOW_LUT[k | 0];
      const hy = (acc[o + 4] / wsum) * 4 + 0.5;
      data[d + 3] = hy <= 0 ? 0 : hy >= 255 ? 255 : hy | 0;
    }
    this.glowTex.needsUpdate = true;
    this._glowDirty = true;
  }

  // ===========================================================================================
  // Camera
  // ===========================================================================================

  _handleKey(e, down) {
    if (down && isTypingTarget()) return;
    const k = this._keys;
    let key = null;
    switch (e.code) {
      case 'KeyW': key = 'w'; break;
      case 'KeyA': key = 'a'; break;
      case 'KeyS': key = 's'; break;
      case 'KeyD': key = 'd'; break;
      case 'KeyQ': key = 'q'; break;
      case 'KeyE': key = 'e'; break;
      case 'KeyP':
        if (down && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) this._toggleDebug();
        return;
      default: return;
    }
    if (!down) { k[key] = false; return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    k[key] = true;
    if ((key === 'w' || key === 'a' || key === 's' || key === 'd') && this.followId != null) this._stopFollow();
  }

  _stopFollow() {
    this.followId = null;
    const sim = this.sim;
    const bus = sim?.events;
    if (bus && typeof bus.emit === 'function' && EV?.FOLLOW) {
      bus.emit(EV.FOLLOW, { agentId: null });
    } else if (sim?.ui) {
      sim.ui.followAgentId = null;
    }
  }

  _groundY(x, z) {
    const w = this.world;
    if (w && typeof w.surfaceY === 'function') {
      const y = Number(w.surfaceY(Math.floor(x), Math.floor(z)));
      if (Number.isFinite(y) && y > 0) return y;
    }
    return this.controls.target.y;
  }

  _clampTargetVec(v) {
    const dx = v.x - CX;
    const dz = v.z - CZ;
    const r = Math.sqrt(dx * dx + dz * dz);
    if (r > TARGET_MAX_R) {
      const k = TARGET_MAX_R / r;
      v.x = CX + dx * k;
      v.z = CZ + dz * k;
    }
    v.y = clamp(v.y, TARGET_Y[0], TARGET_Y[1]);
    return v;
  }

  _updateCamera(dt, sim, alpha) {
    const c = this.controls;
    const cam = this.camera;
    const target = c.target;
    const k = this._keys;

    // Keyboard pan (WASD, in the camera's ground plane) and orbit (Q/E).
    if (k.w || k.a || k.s || k.d || k.q || k.e) {
      this._fly = null;
      const fwd = _v1.subVectors(target, cam.position);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
      fwd.normalize();
      const right = _v2.set(-fwd.z, 0, fwd.x);
      const dist = cam.position.distanceTo(target);
      const speed = clamp(dist * 0.9, 8, 140) * dt;
      const mf = (k.w ? 1 : 0) - (k.s ? 1 : 0);
      const mr = (k.d ? 1 : 0) - (k.a ? 1 : 0);
      if (mf !== 0 || mr !== 0) {
        const px = (fwd.x * mf + right.x * mr) * speed;
        const pz = (fwd.z * mf + right.z * mr) * speed;
        target.x += px; target.z += pz;
        cam.position.x += px; cam.position.z += pz;
      }
      const orbit = ((k.q ? 1 : 0) - (k.e ? 1 : 0)) * KEY_ORBIT_RATE * dt;
      if (orbit !== 0) {
        const ox = cam.position.x - target.x;
        const oz = cam.position.z - target.z;
        const cs = Math.cos(orbit);
        const sn = Math.sin(orbit);
        cam.position.x = target.x + ox * cs - oz * sn;
        cam.position.z = target.z + ox * sn + oz * cs;
      }
    }

    // Fly-to.
    if (this._fly) {
      const f = this._fly;
      f.t = Math.min(1, f.t + dt / FLY_SEC);
      const e = easeInOutCubic(f.t);
      target.lerpVectors(this._flyFromT, this._flyToT, e);
      cam.position.lerpVectors(this._flyFromC, this._flyToC, e);
      if (f.t >= 1) this._fly = null;
    } else if (this.followId != null) {
      // Follow: the target (and the camera with it) lerps to the agent at 6/s.
      const pop = sim?.population;
      const a = pop && typeof pop.get === 'function' ? pop.get(this.followId) : null;
      if (!a || a.alive === false || !a.pos) {
        this._stopFollow();
      } else {
        let x = a.pos.x;
        let y = a.pos.y;
        let z = a.pos.z;
        const q = a.prevPos;
        if (q && alpha > 0 && alpha < 1) {
          x = q.x + (x - q.x) * alpha;
          y = q.y + (y - q.y) * alpha;
          z = q.z + (z - q.z) * alpha;
        }
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          const kf = 1 - Math.exp(-FOLLOW_RATE * dt);
          const dx = (x - target.x) * kf;
          const dy = (y + 1 - target.y) * kf;
          const dz = (z - target.z) * kf;
          target.x += dx; target.y += dy; target.z += dz;
          cam.position.x += dx; cam.position.y += dy; cam.position.z += dz;
        }
      }
    }

    c.update();

    // Keep the target inside the jar; move the camera with it so the view does not swing.
    const bx = target.x;
    const by = target.y;
    const bz = target.z;
    this._clampTargetVec(target);
    const ddx = target.x - bx;
    const ddy = target.y - by;
    const ddz = target.z - bz;
    if (ddx !== 0 || ddy !== 0 || ddz !== 0) {
      cam.position.x += ddx; cam.position.y += ddy; cam.position.z += ddz;
    }
  }

  // ===========================================================================================
  // Adaptive quality & debug overlay
  // ===========================================================================================

  _adaptQuality(dt) {
    if (dt <= 0) return;
    const ms = dt * 1000;
    this._frameMs += (ms - this._frameMs) * 0.1;
    this._fps += (1 / Math.max(dt, 1e-3) - this._fps) * 0.1;
    // Judge load by the CPU work of a frame (main.js stamps sim.frameWorkMs), not the rAF interval:
    // a 30 fps battery cap or a 50 Hz panel is not a slow machine. Only a truly slow interval
    // (> 45 ms) counts on its own, which still catches heavily GPU-bound frames.
    const work = Number.isFinite(this.sim?.frameWorkMs) ? this.sim.frameWorkMs : ms;
    const load = ms > 45 ? Math.max(work, ms) : work;
    this._workMs = (this._workMs ?? load) + (load - (this._workMs ?? load)) * 0.1;
    if (this._warmT > 0) { this._warmT -= dt; return; }
    const slowMs = RCFG.adaptiveSlowMs ?? 20;
    if (this._workMs > slowMs && this.quality < 3) {
      this._slowT += dt;
      this._fastT = 0;
      if (this._slowT >= (RCFG.adaptiveSec ?? 2)) {
        this._stepDownQuality();
        this._slowT = 0;
        this._warmT = 1;
      }
    } else {
      this._slowT = Math.max(0, this._slowT - dt);
      // Hysteresis: after ~10 s of comfortable frames, restore the last quality step.
      this._fastT = this._workMs < 0.5 * slowMs ? (this._fastT ?? 0) + dt : 0;
      if (this.quality > 0 && this._fastT > 10) {
        this._stepUpQuality();
        this._fastT = 0;
        this._warmT = 2;
      }
    }
  }

  _stepUpQuality() {
    const q = this.quality;
    this.quality--;
    if (q === 3 && this.glowN < 128) this._initGlow(RCFG.glowmapSize ?? 128);
    else if (q === 2) this.resize();
    else if (q === 1) this.sun.castShadow = true;
  }

  _stepDownQuality() {
    let changed = false;
    while (!changed && this.quality < 3) {
      this.quality++;
      if (this.quality === 1) {
        changed = this.sun.castShadow;
        this.sun.castShadow = false;
      } else if (this.quality === 2) {
        changed = this.pixelRatio > 1;
        this.resize();
      } else if (this.quality === 3) {
        changed = this.glowN > 64;
        if (changed) this._initGlow(64);
      }
    }
  }

  _initDebugOverlay() {
    if (typeof document === 'undefined') return;
    const el = document.createElement('pre');
    el.id = 'debug-overlay';
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    (document.getElementById('app') || document.body).appendChild(el);
    this._dbgEl = el;
  }

  _toggleDebug() {
    if (!this._dbgEl) return;
    this._dbgEl.hidden = !this._dbgEl.hidden;
    this._dbgT = 1;
  }

  _updateDebug(dt, sim) {
    const el = this._dbgEl;
    if (!el || el.hidden) return;
    this._dbgT += dt;
    if (this._dbgT < 1 / DEBUG_HZ) return;
    this._dbgT = 0;
    const info = this.gl.info.render;
    const simMs = finiteOr(sim?.simMs, 0);
    const pathMs = finiteOr(sim?.pathfinder?.stats?.msThisFrame, 0);
    const queue = this.world?.dirty?.size ?? 0;
    const q = ['full', 'no shadows', 'pixel ratio 1', 'glowmap 64²'][this.quality] || 'full';
    const h = this.hourFloat;
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    el.textContent =
      `fps        ${this._fps.toFixed(0).padStart(4)}   ${this._frameMs.toFixed(1)} ms\n` +
      `draw calls ${String(info.calls).padStart(4)}   ${(info.triangles / 1000).toFixed(0)}k tris\n` +
      `sim        ${simMs.toFixed(2).padStart(6)} ms/frame${sim?.lagging ? '  (lagging)' : ''}\n` +
      `path       ${pathMs.toFixed(2).padStart(6)} ms/frame\n` +
      `remesh q   ${String(queue).padStart(4)}   ${this._remeshMs.toFixed(2)} ms · ${this.chunks.size} chunks\n` +
      `quality    ${q} · pr ${this.pixelRatio.toFixed(2)} · glow ${this.glowN}²\n` +
      `clock      ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} · day ${(this.daylight * 100).toFixed(0)}% · fog ${(this._fogDensity * 1000).toFixed(2)}‰`;
  }

  _warn(name, err) {
    const n = (this._errors.get(name) || 0) + 1;
    this._errors.set(name, n);
    if (n <= 2) console.warn(`[renderer:${name}]`, err);
  }
}
