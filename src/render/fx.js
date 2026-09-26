// Wickmarket effects layer (SPEC §C.4 G2 "fx.js").
// Transient effects (pooled particles, floating labels, payment arcs, glass ripples, moths, bell) and the
// persistent overlays (market piles, tower beams, eclipse hands, wax seals, pane outlines, tool previews,
// path line). The class subscribes to the sim's event bus itself; update(realDt, sim) runs once per frame
// and allocates nothing in its per-element loops.
import * as THREE from 'three';
import { CONFIG, GOODS } from '../core/config.js';
import { EV } from '../core/events.js';
import * as Blocks from '../world/blocks.js';
import { t, goodWord } from '../core/i18n.js';

const RCFG = CONFIG.render || {};
const W = CONFIG.world || { SX: 112, SZ: 112, CX: 56, CZ: 56 };
const JAR_CX = Number.isFinite(W.CX) ? W.CX : 56;
const JAR_CZ = Number.isFinite(W.CZ) ? W.CZ : 56;
const ARC_SEC = Number.isFinite(RCFG.arcSec) ? RCFG.arcSec : 1.2;
const MAX_ARCS = Math.max(1, (CONFIG.market && CONFIG.market.maxArcs) || 60);
const PLAZA_R = (CONFIG.market && CONFIG.market.plazaRadius) || 4;
const TWO_PI = Math.PI * 2;

const PARTICLES = 2000;
const ADD_PARTICLES = 1100;                   // sparks, glints (additive)
const NORM_PARTICLES = PARTICLES - ADD_PARTICLES; // dust, smoke, leaves (alpha blended)
const TEXT_POOL = 24;
const ARC_POOL = 64;
const ARC_SEG = 40;                           // trail line segments per arc
const ARC_TAIL = 22;                          // comet tail sprites per arc (plus one head)
const ARC_TAIL_WORLD = 13;                    // comet tail length in world units
const ARC_FADE = 0.65;                        // seconds the thread lingers after the head lands
const PAIR_MAX = 512;
const RIPPLE_POOL = 12;
const MOTH_POOL = 12;
const MOTH_SEC = 1.5;
const MOTH_Y = 85;
const PILE_CUBE = 0.45;
const PILE_MAX_CUBES = 32;
const PILE_REFRESH = 1.0;                     // seconds between pile refreshes between Chimes
const BEAM_MAX = 32;
const BEAM_LEN = 30;
const HAND_MAX = 4;
const HAND_Y = 78;
const SEAL_MAX = 16;
const PANE_MAX = 16;
const PANE_SEGS = 72;                         // per pane: ≤ 64 top segments + end posts
const PATH_MAX = 1024;
const PREVIEW_CELLS = 128;
const DISC_RINGS = 10;
const DISC_SEGS = 48;
const OUTLINE_SEGS = 96;
const TEXT_RANGE = 90;                        // harvest labels only near the camera

const C_ARC = new THREE.Color('#FFC247');
const C_ARC_ESTATE = new THREE.Color('#FFE2B0');
const C_WHITE_HOT = new THREE.Color('#FFF4D6');
const C_POOR = new THREE.Color('#FF7A2E');
const C_MID = new THREE.Color('#FFC247');
const C_RICH = new THREE.Color('#FFF4D6');
const C_BEAM = new THREE.Color('#FFF4D6');
const C_GLASS = new THREE.Color('#CFE8EC');
const C_PANE = new THREE.Color('#6FD3E8');
const C_BREACH = new THREE.Color('#E0483A');
const C_HAND = new THREE.Color('#1B1712');
const C_PATH = new THREE.Color('#FFE2B0');
const C_BRASS = new THREE.Color('#B08D57');
const GOOD_COL = GOODS.map(g => new THREE.Color((CONFIG.goods && CONFIG.goods[g] && CONFIG.goods[g].color) || '#EFE6D2'));
const GOOD_INDEX = Object.fromEntries(GOODS.map((g, i) => [g, i]));
const UP = new THREE.Vector3(0, 1, 0);

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const hash01 = (a, b, c) => {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9E3779B1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

/** Particle burst presets (world units, seconds). */
const KINDS = {
  dust:  { add: false, spd: [1.2, 3.2], up: 1.6, grav: -11, drag: 1.4, ttl: [0.45, 0.9], s0: 0.17, s1: 0.08, a0: 0.95, flags: 0, spread: 0.25, jitter: 0.12 },
  spark: { add: true, spd: [2.5, 6.5], up: 1.5, grav: -9, drag: 0.9, ttl: [0.35, 0.8], s0: 0.22, s1: 0.04, a0: 1, flags: 0, spread: 0.1, jitter: 0.08 },
  smoke: { add: false, spd: [0.2, 0.8], up: 0.9, grav: 0.8, drag: 1.6, ttl: [1.4, 2.4], s0: 0.35, s1: 1.15, a0: 0.42, flags: 4, spread: 0.3, jitter: 0.08 },
  glint: { add: true, spd: [0.3, 1.5], up: 0.8, grav: 0.5, drag: 2.0, ttl: [0.5, 1.0], s0: 0.4, s1: 0.1, a0: 1, flags: 1, spread: 0.35, jitter: 0.05 },
  leaf:  { add: false, spd: [0.8, 2.6], up: 2.0, grav: -2.0, drag: 2.3, ttl: [1.6, 2.6], s0: 0.2, s1: 0.16, a0: 1, flags: 2, spread: 0.6, jitter: 0.2 },
};

const PARTICLE_VERT = /* glsl */`
uniform float uScale;
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(0.05, -mv.z), 1.0, 128.0);
}`;

const PARTICLE_FRAG_ADD = /* glsl */`
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0 || vAlpha <= 0.0) discard;
  float a = exp(-r2 * 3.5) * (1.0 - r2) * vAlpha;
  vec3 col = vColor * (1.0 + 1.6 * exp(-r2 * 18.0));
  gl_FragColor = vec4(col * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const PARTICLE_FRAG_NORM = /* glsl */`
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  float a = (1.0 - smoothstep(0.45, 1.0, r)) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}`;

const BEAM_VERT = /* glsl */`
varying vec3 vCol;
varying float vV;
varying vec3 vN;
varying vec3 vView;
void main() {
  mat4 im = modelMatrix;
  #ifdef USE_INSTANCING
  im = modelMatrix * instanceMatrix;
  #endif
  vec4 wp = im * vec4(position, 1.0);
  vN = normalize(mat3(im) * normal);
  vView = cameraPosition - wp.xyz;
  vV = uv.y;
  #ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
  #else
  vCol = vec3(1.0);
  #endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const BEAM_FRAG = /* glsl */`
varying vec3 vCol;
varying float vV;
varying vec3 vN;
varying vec3 vView;
void main() {
  float f = abs(dot(normalize(vN), normalize(vView)));
  float a = pow(f, 1.6) * smoothstep(1.0, 0.55, vV) * (0.55 + 0.45 * (1.0 - vV)) * smoothstep(0.0, 0.03, vV);
  gl_FragColor = vec4(vCol * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Accepts '#hex', 0xhex, THREE.Color or {r,g,b}; falls back on anything else. */
function setColor(out, c, fallback) {
  if (c == null || c === '') return out.set(fallback);
  if (c.isColor) return out.copy(c);
  if (typeof c === 'number' || typeof c === 'string') return out.set(c);
  if (typeof c === 'object' && Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b)) return out.setRGB(c.r, c.g, c.b);
  return out.set(fallback);
}

/** CSS colour string for a DOM label. */
function cssColor(c, fallback) {
  if (typeof c === 'string' && c) return c;
  if (typeof c === 'number' && Number.isFinite(c)) return '#' + (c >>> 0 & 0xffffff).toString(16).padStart(6, '0');
  if (c && c.isColor) return '#' + c.getHexString();
  return fallback;
}

/** Warm self-illumination so pile cubes stay legible after dark. */
function addSelfGlow(material, uniform, key) {
  material.onBeforeCompile = shader => {
    shader.uniforms.uSelfGlow = uniform;
    shader.fragmentShader = 'uniform float uSelfGlow;\n' + shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * uSelfGlow;');
  };
  material.customProgramCacheKey = () => key;
}

/** Pixels per world unit at depth 1 for the drawing buffer and camera. */
function pixelScale(renderer, camera, v2) {
  let h = 800;
  if (renderer && typeof renderer.getDrawingBufferSize === 'function') {
    renderer.getDrawingBufferSize(v2);
    h = v2.y || h;
  }
  const fov = camera && camera.isPerspectiveCamera ? camera.fov : (RCFG.fov || 50);
  return h / (2 * Math.tan((fov * Math.PI) / 360));
}

/**
 * A fixed-capacity particle system (structure of arrays, swap-remove compaction).
 * Rendered as one THREE.Points with per-particle colour, size and alpha.
 */
class ParticlePool {
  constructor(max, material) {
    this.max = max;
    this.n = 0;
    this._ring = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.ttl = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.flags = new Uint8Array(max);
    const geo = new THREE.BufferGeometry();
    const dyn = (arr, k) => new THREE.BufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', dyn(this.pos, 3));
    geo.setAttribute('aColor', dyn(this.col, 3));
    geo.setAttribute('aSize', dyn(this.size, 1));
    geo.setAttribute('aAlpha', dyn(this.alpha, 1));
    geo.setDrawRange(0, 0);
    this.points = new THREE.Points(geo, material);
    this.points.frustumCulled = false;
  }

  emit(x, y, z, vx, vy, vz, r, g, b, ttl, s0, s1, grav, drag, a0, flags) {
    let i;
    if (this.n < this.max) i = this.n++;
    else { i = this._ring; this._ring = (this._ring + 1) % this.max; }
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    this.life[i] = 0;
    this.ttl[i] = ttl > 0.01 ? ttl : 0.01;
    this.s0[i] = s0; this.s1[i] = s1; this.size[i] = s0;
    this.grav[i] = grav; this.drag[i] = drag;
    this.a0[i] = a0; this.alpha[i] = (flags & 4) ? 0 : a0;
    this.flags[i] = flags;
  }

  _move(from, to) {
    const f3 = from * 3;
    const t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[t3 + k] = this.pos[f3 + k];
      this.vel[t3 + k] = this.vel[f3 + k];
      this.col[t3 + k] = this.col[f3 + k];
    }
    this.size[to] = this.size[from]; this.alpha[to] = this.alpha[from];
    this.life[to] = this.life[from]; this.ttl[to] = this.ttl[from];
    this.s0[to] = this.s0[from]; this.s1[to] = this.s1[from];
    this.grav[to] = this.grav[from]; this.drag[to] = this.drag[from];
    this.a0[to] = this.a0[from]; this.flags[to] = this.flags[from];
  }

  update(dt, time) {
    let n = this.n;
    for (let i = 0; i < n;) {
      const life = this.life[i] + dt;
      if (life >= this.ttl[i]) {
        n--;
        if (i !== n) this._move(n, i);
        continue;
      }
      this.life[i] = life;
      const i3 = i * 3;
      const k = Math.max(0, 1 - this.drag[i] * dt);
      const vx = this.vel[i3] * k;
      const vy = this.vel[i3 + 1] * k + this.grav[i] * dt;
      const vz = this.vel[i3 + 2] * k;
      this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
      this.pos[i3] += vx * dt;
      this.pos[i3 + 1] += vy * dt;
      this.pos[i3 + 2] += vz * dt;
      const fl = this.flags[i];
      if (fl & 2) {
        this.pos[i3] += Math.sin(time * 3.1 + i * 1.3) * 0.9 * dt;
        this.pos[i3 + 2] += Math.cos(time * 2.7 + i * 0.7) * 0.9 * dt;
      }
      const u = life / this.ttl[i];
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * u;
      let a = (fl & 4) ? this.a0[i] * Math.sin(Math.PI * u) : this.a0[i] * (1 - u * u);
      if (fl & 1) a *= 0.55 + 0.45 * Math.sin(time * 28 + i * 2.1);
      this.alpha[i] = a;
      i++;
    }
    this.n = n;
    if (this._ring >= this.max) this._ring = 0;
    const geo = this.points.geometry;
    geo.setDrawRange(0, n);
    if (n > 0 || this._wasActive) {
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aColor.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true;
    }
    this._wasActive = n > 0;
  }
}

/** Procedural moth sprite (pale wings, eyespots, dark body). */
function makeMothTexture() {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 64;
  const g = cv.getContext('2d');
  g.translate(32, 34);
  const wing = (x, y, rx, ry, rot) => {
    g.save(); g.translate(x, y); g.rotate(rot);
    g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, TWO_PI);
    g.fillStyle = '#EFE6D2'; g.fill();
    g.lineWidth = 2; g.strokeStyle = '#8C8577'; g.stroke();
    g.restore();
  };
  for (const s of [-1, 1]) {
    wing(s * 13, -7, 14, 9, s * 0.45);
    wing(s * 9, 9, 9, 7, -s * 0.5);
    g.beginPath(); g.arc(s * 15, -8, 3.2, 0, TWO_PI); g.fillStyle = '#C9A45C'; g.fill();
    g.beginPath(); g.moveTo(s * 1.5, -12); g.quadraticCurveTo(s * 6, -24, s * 10, -26);
    g.strokeStyle = '#4A3526'; g.lineWidth = 1.5; g.stroke();
  }
  g.beginPath(); g.ellipse(0, 0, 3.4, 13, 0, 0, TWO_PI); g.fillStyle = '#4A3526'; g.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Red wax seal face with an embossed ▼ (ceiling) or ▲ (floor). */
function makeSealTexture(kind) {
  if (typeof document === 'undefined') return null;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d');
  g.translate(S / 2, S / 2);
  g.beginPath();
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * TWO_PI;
    const r = 60 - (k % 2 ? 3 : 0) - 2 * Math.sin(a * 5);
    if (k === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r); else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  const grad = g.createRadialGradient(-14, -16, 6, 0, 0, 62);
  grad.addColorStop(0, '#E4604C');
  grad.addColorStop(0.55, '#C0392B');
  grad.addColorStop(1, '#7E2119');
  g.fillStyle = grad; g.fill();
  g.beginPath(); g.arc(0, 0, 40, 0, TWO_PI);
  g.lineWidth = 5; g.strokeStyle = 'rgba(90,20,14,0.75)'; g.stroke();
  g.beginPath();
  if (kind === 'floor') { g.moveTo(0, -24); g.lineTo(22, 16); g.lineTo(-22, 16); } else { g.moveTo(0, 24); g.lineTo(22, -16); g.lineTo(-22, -16); }
  g.closePath();
  g.fillStyle = 'rgba(90,20,14,0.85)'; g.fill();
  g.lineWidth = 2; g.strokeStyle = 'rgba(255,190,170,0.55)'; g.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Effects layer. Constructed by main.js as `new Fx(renderer.scene, sim)`; subscribes to the event bus itself.
 */
export class Fx {
  /**
   * @param {THREE.Scene} scene scene to add the effect layers to
   * @param {object} sim shared sim context (SPEC §C.1)
   */
  constructor(scene, sim) {
    this.sim = sim;
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'fx';
    if (scene) scene.add(this.root);

    this._time = 0;
    this._errs = new Set();
    this._unsubs = [];
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._vp = new THREE.Vector2();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this._c2 = new THREE.Color();
    this._sunDir = new THREE.Vector3(0, 1, 0);
    this._bez = new Float32Array(9);
    this._selfGlow = { value: 0.1 };

    this._blockCol = new Float32Array(256 * 3).fill(0.45);
    const BL = Blocks && Blocks.BLOCKS;
    if (BL && typeof BL.length === 'number') {
      for (let id = 0; id < Math.min(256, BL.length); id++) {
        const def = BL[id];
        if (!def || !def.color) continue;
        this._c.set(def.color);
        this._blockCol[id * 3] = this._c.r; this._blockCol[id * 3 + 1] = this._c.g; this._blockCol[id * 3 + 2] = this._c.b;
      }
    }

    this._buildParticles();
    this._buildTexts();
    this._buildArcs();
    this._buildRipples();
    this._buildMoths();
    this._buildPiles();
    this._buildBeams();
    this._buildHands();
    this._buildSeals();
    this._buildPanes();
    this._buildPreview();
    this._buildPath();
    this._subscribe();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Construction
  // ─────────────────────────────────────────────────────────────────────────

  _buildParticles() {
    this._addMat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG_ADD,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    });
    this._normMat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG_NORM,
      transparent: true, depthWrite: false,
    });
    this._addPool = new ParticlePool(ADD_PARTICLES, this._addMat);
    this._normPool = new ParticlePool(NORM_PARTICLES, this._normMat);
    this._addPool.points.renderOrder = 7;
    this._normPool.points.renderOrder = 6;
    const setScale = mat => (renderer, scene, camera) => { mat.uniforms.uScale.value = pixelScale(renderer, camera, this._vp); };
    this._addPool.points.onBeforeRender = setScale(this._addMat);
    this._normPool.points.onBeforeRender = setScale(this._normMat);
    this.root.add(this._addPool.points, this._normPool.points);
  }

  _buildTexts() {
    this._texts = [];
    if (typeof document === 'undefined') return;
    let layer = document.getElementById('fxlayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'fxlayer';
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
      (document.getElementById('app') || document.body).appendChild(layer);
    }
    this._layer = layer;
    for (let i = 0; i < TEXT_POOL; i++) {
      const el = document.createElement('span');
      el.className = 'fx-float';
      el.style.cssText = 'position:absolute;left:0;top:0;display:none;white-space:nowrap;pointer-events:none;'
        + "font:600 15px 'IM Fell English SC',Georgia,serif;letter-spacing:.03em;will-change:transform,opacity;"
        + 'text-shadow:0 0 4px rgba(0,0,0,.9),0 0 10px rgba(0,0,0,.6),0 0 14px rgba(255,194,71,.35);';
      layer.appendChild(el);
      this._texts.push({ el, active: false, x: 0, y: 0, z: 0, t: 0, life: 1, op: -1 });
    }
  }

  _buildArcs() {
    this._arcActive = new Uint8Array(ARC_POOL);
    this._arcLanded = new Uint8Array(ARC_POOL);
    this._arcT = new Float32Array(ARC_POOL);
    this._arcDur = new Float32Array(ARC_POOL);
    this._arcP = new Float32Array(ARC_POOL * 6);            // p0 xyz, p2 xyz
    this._arcCol = new Float32Array(ARC_POOL * 3);
    this._arcW = new Float32Array(ARC_POOL);
    this._arcBuyer = new Int32Array(ARC_POOL).fill(-1);
    this._arcSeller = new Int32Array(ARC_POOL).fill(-1);

    // Threads of light (additive line segments; black = invisible).
    const lv = ARC_POOL * ARC_SEG * 2;
    this._arcLinePos = new Float32Array(lv * 3);
    this._arcLineCol = new Float32Array(lv * 3);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this._arcLinePos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('color', new THREE.BufferAttribute(this._arcLineCol, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setDrawRange(0, 0);
    this._arcLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({
      vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    }));
    this._arcLines.frustumCulled = false;
    this._arcLines.renderOrder = 8;

    // Comets (head + tail sprites) share the additive particle shader.
    const pc = ARC_POOL * (ARC_TAIL + 1 + ARC_SEG);   // tail + head + glow beads along the thread
    this._cometPos = new Float32Array(pc * 3);
    this._cometCol = new Float32Array(pc * 3);
    this._cometSize = new Float32Array(pc);
    this._cometAlpha = new Float32Array(pc);
    const cg = new THREE.BufferGeometry();
    const dyn = (arr, k) => new THREE.BufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage);
    cg.setAttribute('position', dyn(this._cometPos, 3));
    cg.setAttribute('aColor', dyn(this._cometCol, 3));
    cg.setAttribute('aSize', dyn(this._cometSize, 1));
    cg.setAttribute('aAlpha', dyn(this._cometAlpha, 1));
    cg.setDrawRange(0, 0);
    this._comets = new THREE.Points(cg, this._addMat);
    this._comets.frustumCulled = false;
    this._comets.renderOrder = 9;
    this._comets.onBeforeRender = (renderer, scene, camera) => {
      this._addMat.uniforms.uScale.value = pixelScale(renderer, camera, this._vp);
    };
    this.root.add(this._arcLines, this._comets);

    // Chime aggregation scratch.
    this._pairIdx = new Map();
    this._pairBuyer = new Int32Array(PAIR_MAX);
    this._pairSeller = new Int32Array(PAIR_MAX);
    this._pairGood = new Int32Array(PAIR_MAX);
    this._pairVal = new Float64Array(PAIR_MAX);
    this._pairOrder = new Int32Array(PAIR_MAX);
    this._pairCmp = (a, b) => this._pairVal[b] - this._pairVal[a];
  }

  _buildRipples() {
    const geo = new THREE.RingGeometry(0.9, 1.0, 64);
    this._ripples = [];
    for (let i = 0; i < RIPPLE_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: C_GLASS, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 11;
      this.root.add(mesh);
      this._ripples.push({ mesh, mat, active: false, t: 0, delay: 0, dur: 1.6, maxR: 8, gain: 1 });
    }
  }

  _buildMoths() {
    this._mothTex = makeMothTexture();
    this._moths = [];
    for (let i = 0; i < MOTH_POOL; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this._mothTex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, fog: false,
      });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      sp.frustumCulled = false;
      sp.renderOrder = 12;
      this.root.add(sp);
      this._moths.push({
        sprite: sp, mat, active: false, t: 0, dir: 1, agentId: -1,
        x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, trail: 0, r: 1, g: 0.8, b: 0.4,
      });
    }
  }

  _buildPiles() {
    const nm = Math.max(2, (this.sim && this.sim.worldInfo && this.sim.worldInfo.markets && this.sim.worldInfo.markets.length) || 2);
    this._pileMarkets = nm;
    this._pileTop = new Float32Array(nm * GOODS.length);
    const cap = nm * GOODS.length * (PILE_MAX_CUBES + 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    addSelfGlow(mat, this._selfGlow, 'fx-pile-selfglow');
    this._piles = new THREE.InstancedMesh(new THREE.BoxGeometry(PILE_CUBE, PILE_CUBE, PILE_CUBE), mat, cap);
    this._piles.name = 'market-piles';
    this._piles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < cap; i++) this._piles.setColorAt(i, C_WHITE_HOT);
    this._piles.count = 0;
    this._piles.frustumCulled = false;
    this._piles.castShadow = true;
    this._piles.receiveShadow = true;
    this.root.add(this._piles);
    this._pilesDirty = true;
    this._pileTimer = 0;
  }

  _buildBeams() {
    const geo = new THREE.CylinderGeometry(0.15, 0.15, BEAM_LEN, 12, 1, true);
    geo.translate(0, BEAM_LEN / 2, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const mk = name => {
      const m = new THREE.InstancedMesh(geo, mat, BEAM_MAX);
      m.name = name;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < BEAM_MAX; i++) m.setColorAt(i, C_BEAM);
      m.count = 0;
      m.frustumCulled = false;
      m.renderOrder = 9;
      this.root.add(m);
      return m;
    };
    this._beamCore = mk('tower-beams');
    this._beamGlow = mk('tower-beam-glow');
    this._glintTimer = 0;
  }

  _buildHands() {
    const sphere = new THREE.SphereGeometry(1, 24, 14);
    this._hands = [];
    for (let i = 0; i < HAND_MAX; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: C_HAND, transparent: true, opacity: 0, depthWrite: false, fog: false });
      const g = new THREE.Group();
      const palm = new THREE.Mesh(sphere, mat);
      palm.scale.set(1, 0.3, 1.2);
      g.add(palm);
      for (let f = 0; f < 4; f++) {
        const off = Math.abs(f - 1.5);
        const fm = new THREE.Mesh(sphere, mat);
        fm.scale.set(0.19, 0.14, 0.62 - off * 0.09);
        fm.position.set(-0.6 + f * 0.4, -0.04, 1.62 - off * 0.14);
        fm.rotation.set(0.22, (f - 1.5) * 0.07, 0);
        g.add(fm);
      }
      const thumb = new THREE.Mesh(sphere, mat);
      thumb.scale.set(0.2, 0.15, 0.55);
      thumb.position.set(1.05, -0.02, 0.35);
      thumb.rotation.y = 0.75;
      g.add(thumb);
      g.rotation.y = Math.PI / 2;                      // fingers toward the window (+X), the sun it blocks
      g.visible = false;
      g.renderOrder = 12;
      this.root.add(g);
      this._hands.push({ group: g, mat, id: null, fade: 0 });
    }
  }

  _buildSeals() {
    const geo = new THREE.CylinderGeometry(0.55, 0.55, 0.14, 28);
    geo.rotateX(Math.PI / 2);
    const side = new THREE.MeshBasicMaterial({ color: '#8E2A20' });
    const faceMat = kind => {
      const tex = makeSealTexture(kind);
      return new THREE.MeshBasicMaterial(tex ? { map: tex } : { color: '#C0392B' });
    };
    this._sealMats = { ceiling: [side, faceMat('ceiling'), null], floor: [side, faceMat('floor'), null] };
    this._sealMats.ceiling[2] = this._sealMats.ceiling[1];
    this._sealMats.floor[2] = this._sealMats.floor[1];
    this._seals = [];
    for (let i = 0; i < SEAL_MAX; i++) {
      const mesh = new THREE.Mesh(geo, this._sealMats.ceiling);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this._seals.push(mesh);
    }
  }

  _buildPanes() {
    const nv = PANE_MAX * PANE_SEGS * 2;
    this._panePos = new Float32Array(nv * 3);
    this._paneCol = new Float32Array(nv * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._panePos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this._paneCol, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this._paneMat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._paneLines = new THREE.LineSegments(geo, this._paneMat);
    this._paneLines.frustumCulled = false;
    this._paneLines.renderOrder = 8;
    this.root.add(this._paneLines);
    this._paneSig = 0;
  }

  _buildPreview() {
    const g = new THREE.Group();
    g.name = 'tool-preview';
    this.root.add(g);
    this._pvGroup = g;
    this._pvKind = null;
    this._pvColor = new THREE.Color('#C9A45C');
    this._pvX = 0; this._pvY = 0; this._pvZ = 0; this._pvR = 1;
    const mkMat = (opacity, Base = THREE.MeshBasicMaterial) => new Base({
      color: 0xffffff, transparent: true, opacity, depthTest: false, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false, fog: false,
    });

    // Draped disc: polar grid (centre + rings × segments).
    const nv = 1 + DISC_RINGS * DISC_SEGS;
    this._discUnit = new Float32Array(nv * 2);
    for (let r = 1; r <= DISC_RINGS; r++) {
      for (let s = 0; s < DISC_SEGS; s++) {
        const k = 1 + (r - 1) * DISC_SEGS + s;
        const a = (s / DISC_SEGS) * TWO_PI;
        this._discUnit[k * 2] = Math.cos(a) * (r / DISC_RINGS);
        this._discUnit[k * 2 + 1] = Math.sin(a) * (r / DISC_RINGS);
      }
    }
    const idx = [];
    for (let s = 0; s < DISC_SEGS; s++) idx.push(0, 1 + s, 1 + ((s + 1) % DISC_SEGS));
    for (let r = 1; r < DISC_RINGS; r++) {
      for (let s = 0; s < DISC_SEGS; s++) {
        const a = 1 + (r - 1) * DISC_SEGS + s;
        const b = 1 + (r - 1) * DISC_SEGS + ((s + 1) % DISC_SEGS);
        const c = 1 + r * DISC_SEGS + s;
        const d = 1 + r * DISC_SEGS + ((s + 1) % DISC_SEGS);
        idx.push(a, c, b, b, c, d);
      }
    }
    this._discPos = new Float32Array(nv * 3);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(this._discPos, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setIndex(idx);
    this._discFill = new THREE.Mesh(dg, mkMat(0.2));
    this._outPos = new Float32Array(OUTLINE_SEGS * 3);
    const og = new THREE.BufferGeometry();
    og.setAttribute('position', new THREE.BufferAttribute(this._outPos, 3).setUsage(THREE.DynamicDrawUsage));
    this._outline = new THREE.LineLoop(og, new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    }));

    // Box (one voxel).
    this._boxFill = new THREE.Mesh(new THREE.BoxGeometry(1.02, 1.02, 1.02), mkMat(0.18));
    this._boxEdges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 1.04, 1.04)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false, fog: false }));

    // Line of cells (glass pane).
    this._cellFill = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mkMat(0.28), PREVIEW_CELLS);
    this._cellFill.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._cellFill.count = 0;
    this._cellTopPos = new Float32Array(PREVIEW_CELLS * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this._cellTopPos, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setDrawRange(0, 0);
    this._cellTop = new THREE.Line(tg, new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    }));

    for (const o of [this._discFill, this._outline, this._boxFill, this._boxEdges, this._cellFill, this._cellTop]) {
      o.visible = false;
      o.frustumCulled = false;
      o.renderOrder = 30;
      g.add(o);
    }
  }

  _buildPath() {
    this._pathPos = new Float32Array(PATH_MAX * 3);
    this._pathCol = new Float32Array(PATH_MAX * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._pathPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this._pathCol, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this._path = new THREE.Line(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    }));
    this._path.visible = false;
    this._path.frustumCulled = false;
    this._path.renderOrder = 29;
    const ringGeo = new THREE.RingGeometry(0.3, 0.42, 24);
    ringGeo.rotateX(-Math.PI / 2);
    this._pathGoal = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: C_BRASS, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false,
    }));
    this._pathGoal.visible = false;
    this._pathGoal.renderOrder = 29;
    this._pathN = 0;
    this.root.add(this._path, this._pathGoal);
  }

  _subscribe() {
    const bus = this.sim && this.sim.events;
    if (!bus || typeof bus.on !== 'function' || !EV) return;
    const on = (key, fn) => {
      const name = EV[key];
      if (typeof name !== 'string') return;
      const wrapped = payload => {
        try { fn(payload || {}); } catch (err) { this._err(key, err); }
      };
      const off = bus.on(name, wrapped);
      this._unsubs.push(typeof off === 'function' ? off : () => { if (typeof bus.off === 'function') bus.off(name, wrapped); });
    };
    on('MARKET_CHIME', p => this._onChime(p));
    on('AGENT_DUG', p => {
      if (!Number.isFinite(p.x)) return;
      const id = (p.blockId | 0) & 255;
      const c = this._c.setRGB(this._blockCol[id * 3], this._blockCol[id * 3 + 1], this._blockCol[id * 3 + 2]);
      this.burst(p.x + 0.5, p.y + 0.5, p.z + 0.5, c, 10, 'dust');
      if (p.item === 'quartz' || p.item === 'amber') this.burst(p.x + 0.5, p.y + 0.6, p.z + 0.5, GOOD_COL[GOOD_INDEX[p.item]], 6, 'glint');
    });
    on('AGENT_PLACED', p => {
      if (!Number.isFinite(p.x)) return;
      const id = (p.blockId | 0) & 255;
      const c = this._c.setRGB(this._blockCol[id * 3], this._blockCol[id * 3 + 1], this._blockCol[id * 3 + 2]);
      this.burst(p.x + 0.5, p.y + 0.3, p.z + 0.5, '#EFE6D2', 5, 'smoke');
      this.burst(p.x + 0.5, p.y + 0.2, p.z + 0.5, c, 4, 'dust');
    });
    on('AGENT_HARVEST', p => {
      if (!Number.isFinite(p.x)) return;
      const item = typeof p.item === 'string' ? p.item : 'berry';
      const col = (CONFIG.goods && CONFIG.goods[item] && CONFIG.goods[item].color) || '#FFE2B0';
      this.burst(p.x + 0.5, p.y + 0.7, p.z + 0.5, col, 6, 'glint');
      if (this._nearCamera(p.x, p.y, p.z, TEXT_RANGE)) {
        const qty = Number.isFinite(p.qty) ? p.qty : 0;
        this.floatText(p.x + 0.5, p.y + 1.4, p.z + 0.5, `+${qty} ${goodWord(item, qty)}`, col, 1.4);
      }
    });
    on('AGENT_BORN', p => {
      const a = this._agent(p.agentId);
      if (!a) return;
      this.burst(a.pos.x, a.pos.y + 1.0, a.pos.z, '#FFF4D6', 18, 'glint');
      this.burst(a.pos.x, a.pos.y + 1.0, a.pos.z, '#FFC247', 8, 'spark');
    });
    on('AGENT_DIED', p => {
      const pos = p.pos || (this._agent(p.agentId) || {}).pos;
      if (!pos || !Number.isFinite(pos.x)) return;
      this.burst(pos.x, pos.y + 0.6, pos.z, '#6E665C', 16, 'smoke');
      this.burst(pos.x, pos.y + 1.0, pos.z, '#FF7A2E', 5, 'spark');
    });
    on('AGENT_EMIGRATED', p => {
      const pos = p.pos || (this._agent(p.agentId) || {}).pos;
      if (!pos || !Number.isFinite(pos.x)) return;
      this._spawnMoth(1, pos.x, pos.y, pos.z, -1, Number(p.glim) || 0);
    });
    on('AGENT_IMMIGRATED', p => {
      const a = this._agent(p.agentId);
      if (!a || !a.pos) return;
      this._spawnMoth(-1, a.pos.x, a.pos.y, a.pos.z, a.id, (Number(a.glim) || 0) + (Number(a.escrow) || 0));
    });
    on('PROJECT_DONE', p => {
      const s = p.site;
      if (!s || !Number.isFinite(s.x)) return;
      const house = p.kind !== 'tower';
      const cx = s.x + (house ? 1.5 : 0.5);
      const cz = s.z + (house ? 1.5 : 0.5);
      this.burst(cx, s.y + 2, cz, '#FFF4D6', 26, 'glint');
      this.burst(cx, s.y + 1, cz, '#EFE6D2', 10, 'smoke');
      this.floatText(cx, s.y + (house ? 3.6 : 4.8), cz, t(house ? 'fx.house' : 'fx.tower'), '#FFE2B0', 2.2);
    });
    on('TOWER_LENS', p => {
      const t = this._tower(p.towerId);
      if (!t || !t.lens) return;
      const x = t.lens.x + 0.5;
      const y = t.lens.y + 0.5;
      const z = t.lens.z + 0.5;
      if (p.what === 'cracked') {
        this.burst(x, y, z, '#DDEFF5', 14, 'spark');
        this.burst(x, y, z, '#8C8577', 6, 'smoke');
      } else {
        this.burst(x, y, z, '#6FD3E8', 18, 'glint');
        this.burst(x, y, z, '#FFF4D6', 8, 'spark');
      }
    });
    on('TREE_FELLED', p => {
      if (!Number.isFinite(p.x)) return;
      this.burst(p.x + 0.5, p.y + 3, p.z + 0.5, '#2F5A3E', 24, 'leaf');
      this.burst(p.x + 0.5, p.y + 0.5, p.z + 0.5, '#5A3B2A', 10, 'dust');
    });
    on('SMUGGLE_BREACH', p => {
      if (!Number.isFinite(p.x)) return;
      this.burst(p.x + 0.5, p.y + 0.5, p.z + 0.5, '#6FD3E8', 40, 'spark');
      this.burst(p.x + 0.5, p.y + 0.5, p.z + 0.5, '#FFC247', 30, 'spark');
      this.burst(p.x + 0.5, p.y + 0.5, p.z + 0.5, '#4A3526', 14, 'dust');
      this.floatText(p.x + 0.5, p.y + 2.5, p.z + 0.5, t('fx.breach'), '#E0483A', 2);
    });
    // Fights between clans: a flurry of sparks when they start, smoke when one is snuffed out.
    on('FIGHT', p => {
      if (!Number.isFinite(p.x)) return;
      if (p.phase === 'start') {
        this.burst(p.x, p.y + 1.0, p.z, '#FFC247', 10, 'spark');
        if (this._nearCamera(p.x, p.y, p.z, TEXT_RANGE)) this.floatText(p.x, p.y + 2.2, p.z, '⚔', '#E0483A', 1.2);
      } else if (p.killed) {
        this.burst(p.x, p.y + 0.6, p.z, '#6E665C', 22, 'smoke');
        this.burst(p.x, p.y + 1.0, p.z, '#FF7A2E', 8, 'spark');
      } else if (p.stolen > 0.5) {
        this.burst(p.x, p.y + 1.2, p.z, '#FFE2B0', 8, 'glint');
      }
    });
    on('WALL', () => {
      const c = this.sim && this.sim.clans;
      if (!c || !Array.isArray(c.walls)) return;
      for (const w of c.walls) {
        const col = w.cols[w.cols.length >> 1];
        if (col == null) continue;
        const x = (col % W.SX) + 0.5;
        const z = Math.floor(col / W.SX) + 0.5;
        const y = this.sim.world ? this.sim.world.surfaceY(Math.floor(x), Math.floor(z)) : 20;
        this.burst(x, y + 3, z, w.up ? '#F3E6C8' : '#FFF4D6', 24, 'glint');
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Emit a burst of pooled particles.
   * @param {number} x world x
   * @param {number} y world y
   * @param {number} z world z
   * @param {string|number|THREE.Color} [color] particle colour
   * @param {number} [n=12] particle count (capped at 200)
   * @param {'dust'|'spark'|'smoke'|'glint'|'leaf'} [kind='dust'] preset
   */
  burst(x, y, z, color, n = 12, kind = 'dust') {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const K = KINDS[kind] || KINDS.dust;
    const pool = K.add ? this._addPool : this._normPool;
    const c = setColor(this._c2, color, kind === 'smoke' ? '#8C8577' : '#EFE6D2');
    const count = Math.max(0, Math.min(200, Math.round(Number.isFinite(n) ? n : 12)));
    for (let i = 0; i < count; i++) {
      // Uniform direction on the sphere (Marsaglia).
      let u;
      let v;
      let s;
      do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
      const f = 2 * Math.sqrt(1 - s);
      const dx = u * f;
      const dz = v * f;
      const dy = 1 - 2 * s;
      const spd = rand(K.spd[0], K.spd[1]);
      const j = K.jitter;
      pool.emit(
        x + (Math.random() - 0.5) * K.spread, y + (Math.random() - 0.5) * K.spread, z + (Math.random() - 0.5) * K.spread,
        dx * spd, Math.abs(dy) * spd * 0.6 + K.up * (0.6 + Math.random() * 0.8), dz * spd,
        c.r * (1 + (Math.random() - 0.5) * 2 * j), c.g * (1 + (Math.random() - 0.5) * 2 * j), c.b * (1 + (Math.random() - 0.5) * 2 * j),
        rand(K.ttl[0], K.ttl[1]), K.s0 * (0.8 + Math.random() * 0.4), K.s1, K.grav, K.drag, K.a0, K.flags,
      );
    }
  }

  /**
   * Show a floating label projected from a world position (24 pooled spans in #fxlayer).
   * @param {number} x world x
   * @param {number} y world y
   * @param {number} z world z
   * @param {string} text label text
   * @param {string|number|THREE.Color} [color='#FFE2B0'] CSS colour
   * @param {number} [sec=1.5] lifetime in seconds
   */
  floatText(x, y, z, text, color = '#FFE2B0', sec = 1.5) {
    if (!this._texts.length || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    let slot = null;
    let oldest = -1;
    for (let i = 0; i < this._texts.length; i++) {
      const t = this._texts[i];
      if (!t.active) { slot = t; break; }
      const age = t.t / t.life;
      if (age > oldest) { oldest = age; slot = t; }
    }
    if (!slot) return;
    slot.active = true;
    slot.x = x; slot.y = y; slot.z = z;
    slot.t = 0;
    slot.life = Math.max(0.3, Number.isFinite(sec) ? sec : 1.5);
    slot.op = -1;
    slot.el.textContent = String(text);
    slot.el.style.color = cssColor(color, '#FFE2B0');
    slot.el.style.opacity = '0';
    slot.el.style.display = 'block';
  }

  /**
   * Fire a payment arc of light: a quadratic Bézier (height 4 + 0.3·dist) with a moving bright head.
   * @param {{x:number,y:number,z:number}} from start (world)
   * @param {{x:number,y:number,z:number}} to end (world)
   * @param {string|number|THREE.Color} [color='#FFC247'] arc colour
   * @param {number} [sec=CONFIG.render.arcSec] flight time of the head
   * @returns {boolean} true when an arc was started
   */
  arc(from, to, color = '#FFC247', sec = ARC_SEC) {
    if (!from || !to) return false;
    setColor(this._c2, color, '#FFC247');
    return this._spawnArc(from.x, from.y, from.z, to.x, to.y, to.z, this._c2, sec, 0, -1, -1, 0.6) >= 0;
  }

  /**
   * An expanding ring on the jar glass at (x, y, z), facing radially outward.
   * @param {number} x world x (on or near the jar wall)
   * @param {number} y world y
   * @param {number} z world z
   */
  ripple(x, y, z) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    for (let k = 0; k < 3; k++) this._spawnRing(x, y, z, false, C_GLASS, k * 0.18, 1.6 - k * 0.15, 10 - k * 2, 1 - k * 0.2);
    this.burst(x, y, z, '#CFE8EC', 10, 'glint');
  }

  /**
   * Synthesized bell (partials 1, 2.76, 5.4 with exponential decay). Silent when muted or above 2× speed.
   * @param {number} [strength=1] loudness 0..1
   */
  bell(strength = 1) {
    const sim = this.sim;
    if (!sim || (sim.ui && sim.ui.muted) || (Number(sim.speed) > 2)) return;
    if (!this._audio) this.resumeAudio();
    const ctx = this._audio;
    if (!ctx || ctx.state !== 'running' || !this._master) return;
    try {
      const s = clamp01(Number.isFinite(strength) ? strength : 1);
      const dusk = sim.clock && sim.clock.hour === 18;
      const base = dusk ? 392 : 523.25;
      const t0 = ctx.currentTime + 0.01;
      const partials = [1, 2.76, 5.4];
      const amps = [0.55, 0.28, 0.14];
      const decays = dusk ? [4.2, 2.2, 1.0] : [2.8, 1.4, 0.7];
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(base * partials[i] * (1 + (Math.random() - 0.5) * 0.004), t0);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(Math.max(0.0002, amps[i] * (0.35 + 0.65 * s)), t0 + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + decays[i]);
        osc.connect(g);
        g.connect(this._master);
        osc.start(t0);
        osc.stop(t0 + decays[i] + 0.05);
      }
    } catch (err) {
      this._err('bell', err);
    }
  }

  /** Create or resume the WebAudio context (call from a user gesture). */
  resumeAudio() {
    try {
      if (!this._audio) {
        const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
        if (!AC) return;
        this._audio = new AC();
        const lp = this._audio.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 5200;
        this._master = this._audio.createGain();
        this._master.gain.value = 0.22;
        this._master.connect(lp);
        lp.connect(this._audio.destination);
      }
      if (this._audio.state === 'suspended' && typeof this._audio.resume === 'function') {
        const p = this._audio.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (err) {
      this._err('audio', err);
    }
  }

  /**
   * Tool hover preview. 'disc' and 'ring' take world-space centres {x,y,z,r,color} and drape over the terrain;
   * 'box' takes an integer voxel {x,y,z,color}; 'line' takes {cells:[{x,y,z}], color} in voxel coordinates.
   * @param {'disc'|'line'|'box'|'ring'|null} kind preview shape, or null to hide
   * @param {object} [params] shape parameters (copied; the caller may reuse the object)
   */
  setPreview(kind, params) {
    this._discFill.visible = false;
    this._outline.visible = false;
    this._boxFill.visible = false;
    this._boxEdges.visible = false;
    this._cellFill.visible = false;
    this._cellTop.visible = false;
    this._pvKind = null;
    if (!kind || !params) return;
    setColor(this._pvColor, params.color, '#C9A45C');
    const col = this._pvColor;
    if (kind === 'disc' || kind === 'ring') {
      const x = Number(params.x);
      const y = Number(params.y);
      const z = Number(params.z);
      const r = Math.max(0.25, Number(params.r) || 1);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      this._pvX = x; this._pvY = y; this._pvZ = z; this._pvR = r;
      this._drape(x, y, z, r, kind === 'disc');
      this._outline.material.color.copy(col);
      this._outline.visible = true;
      if (kind === 'disc') {
        this._discFill.material.color.copy(col);
        this._discFill.visible = true;
      }
    } else if (kind === 'box') {
      const x = Number(params.x);
      const y = Number(params.y);
      const z = Number(params.z);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      this._boxFill.position.set(Math.floor(x) + 0.5, Math.floor(y) + 0.5, Math.floor(z) + 0.5);
      this._boxEdges.position.copy(this._boxFill.position);
      this._boxFill.material.color.copy(col);
      this._boxEdges.material.color.copy(col);
      this._boxFill.visible = true;
      this._boxEdges.visible = true;
    } else if (kind === 'line') {
      const cells = params.cells;
      if (!cells || !cells.length) return;
      let n = 0;
      for (let i = 0; i < cells.length && n < PREVIEW_CELLS; i++) {
        const c = cells[i];
        if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) continue;
        const cx = Math.floor(c.x) + 0.5;
        const cy = Math.floor(c.y) + 0.5;
        const cz = Math.floor(c.z) + 0.5;
        this._m.makeTranslation(cx, cy, cz);
        this._cellFill.setMatrixAt(n, this._m);
        this._cellTopPos[n * 3] = cx;
        this._cellTopPos[n * 3 + 1] = cy + 0.52;
        this._cellTopPos[n * 3 + 2] = cz;
        n++;
      }
      if (n === 0) return;
      this._cellFill.count = n;
      this._cellFill.instanceMatrix.needsUpdate = true;
      this._cellFill.material.color.copy(col);
      this._cellTop.material.color.copy(col);
      const tg = this._cellTop.geometry;
      tg.setDrawRange(0, n);
      tg.attributes.position.needsUpdate = true;
      this._cellFill.visible = true;
      this._cellTop.visible = n > 1;
    } else {
      return;
    }
    this._pvKind = kind;
  }

  /**
   * Draw a path polyline at feet + 0.1 (integer PathNode cells are centred; float positions used as-is).
   * @param {Array<{x:number,y:number,z:number}>|null} points path points, or null to hide
   */
  setPathLine(points) {
    if (!points || !points.length) {
      this._pathN = 0;
      this._path.visible = false;
      this._pathGoal.visible = false;
      return;
    }
    let n = 0;
    for (let i = 0; i < points.length && n < PATH_MAX; i++) {
      const p = points[i];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
      // SPEC-GAP: setPathLine does not fix the point units; integer cells (PathNode) are shifted to cell centres.
      const cell = Number.isInteger(p.x) && Number.isInteger(p.z);
      this._pathPos[n * 3] = p.x + (cell ? 0.5 : 0);
      this._pathPos[n * 3 + 1] = p.y + 0.1;
      this._pathPos[n * 3 + 2] = p.z + (cell ? 0.5 : 0);
      n++;
    }
    this._pathN = n;
    if (n < 2) {
      this._path.visible = false;
      this._pathGoal.visible = false;
      return;
    }
    const geo = this._path.geometry;
    geo.setDrawRange(0, n);
    geo.attributes.position.needsUpdate = true;
    this._path.visible = true;
    const l3 = (n - 1) * 3;
    this._pathGoal.position.set(this._pathPos[l3], this._pathPos[l3 + 1] + 0.02, this._pathPos[l3 + 2]);
    this._pathGoal.visible = true;
  }

  /**
   * Advance every effect and redraw the persistent layers.
   * @param {number} realDt real seconds since the last frame
   * @param {object} [sim] shared sim context
   */
  update(realDt, sim) {
    if (sim) this.sim = sim;
    sim = this.sim;
    const dt = Number.isFinite(realDt) ? Math.min(0.1, Math.max(0, realDt)) : 1 / 60;
    this._time = (this._time + dt) % 3600;
    const camera = (sim && sim.renderer && sim.renderer.camera) || null;
    const daylight = sim && sim.clock && Number.isFinite(sim.clock.daylight) ? clamp01(sim.clock.daylight) : 1;
    this._selfGlow.value = 0.06 + 0.16 * (1 - daylight);

    try { this._addPool.update(dt, this._time); this._normPool.update(dt, this._time); } catch (e) { this._err('particles', e); }
    try { this._updateArcs(dt, sim); } catch (e) { this._err('arcs', e); }
    try { this._updateRipples(dt); } catch (e) { this._err('ripples', e); }
    try { this._updateMoths(dt, sim); } catch (e) { this._err('moths', e); }
    try { this._updateTexts(dt, camera); } catch (e) { this._err('texts', e); }
    try {
      this._pileTimer += dt;
      if (this._pilesDirty || this._pileTimer >= PILE_REFRESH) this._rebuildPiles(sim);
    } catch (e) { this._err('piles', e); }
    try { this._updateBeams(dt, sim); } catch (e) { this._err('beams', e); }
    try { this._updateHands(dt, sim); } catch (e) { this._err('hands', e); }
    try { this._updateSeals(sim); } catch (e) { this._err('seals', e); }
    try { this._updatePanes(sim); } catch (e) { this._err('panes', e); }
    try { this._animatePreview(); } catch (e) { this._err('preview', e); }
  }

  /** Unsubscribe from the bus and free every layer. */
  dispose() {
    for (const off of this._unsubs) { try { off(); } catch (e) { /* bus already gone */ } }
    this._unsubs.length = 0;
    if (this.root.parent) this.root.parent.remove(this.root);
    const seen = new Set();
    const free = x => { if (x && !seen.has(x) && typeof x.dispose === 'function') { seen.add(x); x.dispose(); } };
    this.root.traverse(o => {
      free(o.geometry);
      if (Array.isArray(o.material)) o.material.forEach(m => { free(m && m.map); free(m); });
      else if (o.material) { free(o.material.map); free(o.material); }
    });
    for (const t of this._texts) if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
    this._texts.length = 0;
    if (this._audio && typeof this._audio.close === 'function') { try { this._audio.close(); } catch (e) { /* closed */ } }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  _err(name, err) {
    if (this._errs.has(name)) return;
    this._errs.add(name);
    console.error(`[fx:${name}]`, err);
  }

  _agent(id) {
    if (id == null) return null;
    const pop = this.sim && this.sim.population;
    if (!pop) return null;
    const a = typeof pop.get === 'function' ? pop.get(id) : (pop.byId && pop.byId.get(id));
    return a && a.alive !== false && a.pos ? a : null;
  }

  _tower(id) {
    const towers = this.sim && this.sim.production && this.sim.production.towers;
    if (!towers) return null;
    for (let i = 0; i < towers.length; i++) if (towers[i] && towers[i].id === id) return towers[i];
    return null;
  }

  _nearCamera(x, y, z, range) {
    const cam = this.sim && this.sim.renderer && this.sim.renderer.camera;
    if (!cam) return true;
    const dx = x - cam.position.x;
    const dy = y - cam.position.y;
    const dz = z - cam.position.z;
    return dx * dx + dy * dy + dz * dz <= range * range;
  }

  /** Flame position of a live agent into `out` (the rendered flame when available). */
  _flameOf(id, out) {
    const ar = this.sim && this.sim.agentRenderer;
    if (ar && typeof ar.flamePosition === 'function' && ar.flamePosition(id, out)) return true;
    const a = this._agent(id);
    if (!a) return false;
    out.set(a.pos.x, a.pos.y + 1.2, a.pos.z);
    return true;
  }

  /** Top of the pile on a market pad into `out`; false when the pad is unknown. */
  _padTop(m, good, out) {
    const mk = this.sim && this.sim.worldInfo && this.sim.worldInfo.markets && this.sim.worldInfo.markets[m];
    if (!mk) return false;
    const pad = mk.pads && mk.pads[good];
    const gi = GOOD_INDEX[good];
    if (pad && Number.isFinite(pad.x)) {
      const top = gi != null && m < this._pileMarkets ? this._pileTop[m * GOODS.length + gi] : 0;
      out.set(pad.x + 0.5, Math.max(pad.y + 0.3, top + 0.25), pad.z + 0.5);
      return true;
    }
    if (mk.center && Number.isFinite(mk.center.x)) { out.set(mk.center.x, mk.center.y + 1, mk.center.z); return true; }
    return false;
  }

  /** Column top near the reference height (canopies and cliffs are clamped so previews stay smooth). */
  _columnY(world, ix, iz, ref) {
    const SX = world.SX || W.SX;
    const SZ = world.SZ || W.SZ;
    if (ix < 0 || iz < 0 || ix >= SX || iz >= SZ) return ref;
    const s = world.surfaceY(ix, iz);
    if (!Number.isFinite(s) || s <= 0) return ref;
    return Math.min(ref + 1.5, Math.max(ref - 6, s));
  }

  /** Terrain height under a world point for draping previews: bilinear over the four nearest columns. */
  _groundY(wx, wz, ref) {
    const world = this.sim && this.sim.world;
    if (!world || typeof world.surfaceY !== 'function') return ref;
    const fx = wx - 0.5;
    const fz = wz - 0.5;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const h00 = this._columnY(world, ix, iz, ref);
    const h10 = this._columnY(world, ix + 1, iz, ref);
    const h01 = this._columnY(world, ix, iz + 1, ref);
    const h11 = this._columnY(world, ix + 1, iz + 1, ref);
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  _drape(x, y, z, r, fill) {
    for (let k = 0; k < OUTLINE_SEGS; k++) {
      const a = (k / OUTLINE_SEGS) * TWO_PI;
      const wx = x + Math.cos(a) * r;
      const wz = z + Math.sin(a) * r;
      this._outPos[k * 3] = wx;
      this._outPos[k * 3 + 1] = this._groundY(wx, wz, y) + 0.18;
      this._outPos[k * 3 + 2] = wz;
    }
    this._outline.geometry.attributes.position.needsUpdate = true;
    if (!fill) return;
    const nv = 1 + DISC_RINGS * DISC_SEGS;
    for (let k = 0; k < nv; k++) {
      const wx = x + this._discUnit[k * 2] * r;
      const wz = z + this._discUnit[k * 2 + 1] * r;
      this._discPos[k * 3] = wx;
      this._discPos[k * 3 + 1] = this._groundY(wx, wz, y) + 0.12;
      this._discPos[k * 3 + 2] = wz;
    }
    this._discFill.geometry.attributes.position.needsUpdate = true;
  }

  _animatePreview() {
    const t = this._time;
    if (this._pvKind === 'disc') this._discFill.material.opacity = 0.16 + 0.05 * Math.sin(t * 3);
    else if (this._pvKind === 'ring') this._outline.material.opacity = 0.75 + 0.25 * Math.sin(t * 6);
    else if (this._pvKind === 'box') this._boxFill.material.opacity = 0.14 + 0.08 * Math.sin(t * 5);
    else if (this._pvKind === 'line') this._cellFill.material.opacity = 0.22 + 0.08 * Math.sin(t * 4);
    const n = this._pathN;
    if (n >= 2 && this._path.visible) {
      for (let i = 0; i < n; i++) {
        const k = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(i * 0.8 - t * 6));
        this._pathCol[i * 3] = C_PATH.r * k;
        this._pathCol[i * 3 + 1] = C_PATH.g * k;
        this._pathCol[i * 3 + 2] = C_PATH.b * k;
      }
      this._path.geometry.attributes.color.needsUpdate = true;
      this._pathGoal.rotation.y = t * 1.5;
      this._pathGoal.scale.setScalar(1 + 0.15 * Math.sin(t * 4));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Market Chime: the signature arcs
  // ─────────────────────────────────────────────────────────────────────────

  _onChime(p) {
    const m = p.marketId | 0;
    this._pilesDirty = true;
    const trades = Array.isArray(p.trades) ? p.trades : null;
    if (m === 0) this.bell(Math.min(1, 0.45 + (trades ? trades.length : 0) / 40));
    const mk = this.sim && this.sim.worldInfo && this.sim.worldInfo.markets && this.sim.worldInfo.markets[m];
    if (mk && mk.center && Number.isFinite(mk.center.x)) {
      const c = mk.center;
      const strong = trades && trades.length > 0;
      this._spawnRing(c.x, c.y + 0.12, c.z, true, C_ARC, 0, 1.4, PLAZA_R + 3, strong ? 1 : 0.4);
      if (strong) this._spawnRing(c.x, c.y + 0.12, c.z, true, C_WHITE_HOT, 0.2, 1.2, PLAZA_R + 1.5, 0.6);
    }
    if (!trades || trades.length === 0) return;

    // Aggregate trades per (buyer, seller) pair.
    const idx = this._pairIdx;
    idx.clear();
    let np = 0;
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      if (!t) continue;
      const b = Number.isInteger(t.buyerId) ? t.buyerId : -1;
      const s = Number.isInteger(t.sellerId) ? t.sellerId : -1;
      if (b === s) continue;
      const key = (b + 2) * 4194304 + (s + 2);
      let k = idx.get(key);
      if (k === undefined) {
        if (np >= PAIR_MAX) continue;
        k = np++;
        idx.set(key, k);
        this._pairBuyer[k] = b;
        this._pairSeller[k] = s;
        this._pairGood[k] = GOOD_INDEX[t.good] != null ? GOOD_INDEX[t.good] : -1;
        this._pairVal[k] = 0;
      }
      const qty = Number(t.qty) || 0;
      const price = Number(t.price) || 0;
      this._pairVal[k] += Math.max(0, qty * price);
    }
    if (np === 0) return;
    for (let k = 0; k < np; k++) this._pairOrder[k] = k;
    const order = this._pairOrder.subarray(0, np);
    order.sort(this._pairCmp);

    const limit = Math.min(np, MAX_ARCS, ARC_POOL);
    const from = this._v;
    const to = this._v2;
    for (let r = 0; r < limit; r++) {
      const k = order[r];
      const b = this._pairBuyer[k];
      const s = this._pairSeller[k];
      const good = this._pairGood[k] >= 0 ? GOODS[this._pairGood[k]] : null;
      const okFrom = b >= 0 ? this._flameOf(b, from) : (good ? this._padTop(m, good, from) : false);
      const okTo = s >= 0 ? this._flameOf(s, to) : (good ? this._padTop(m, good, to) : false);
      if (!okFrom || !okTo) continue;
      const w = 0.2 + 0.8 * clamp01(Math.log2(1 + this._pairVal[k] / 4) / 5);
      const delay = r * 0.012 + Math.random() * 0.3;
      const dist = from.distanceTo(to);
      const dur = ARC_SEC * (0.85 + 0.35 * Math.min(1, dist / 60));
      this._spawnArc(from.x, from.y, from.z, to.x, to.y, to.z, s < 0 ? C_ARC_ESTATE : C_ARC, dur, delay, b, s, w);
    }
  }

  _spawnArc(x0, y0, z0, x1, y1, z1, col, dur, delay, buyerId, sellerId, weight) {
    if (!Number.isFinite(x0 + y0 + z0 + x1 + y1 + z1)) return -1;
    let slot = -1;
    let most = -Infinity;
    for (let i = 0; i < ARC_POOL; i++) {
      if (!this._arcActive[i]) { slot = i; break; }
      const prog = this._arcT[i] - this._arcDur[i];
      if (prog > most) { most = prog; slot = i; }
    }
    if (slot < 0) return -1;
    const i6 = slot * 6;
    this._arcP[i6] = x0; this._arcP[i6 + 1] = y0; this._arcP[i6 + 2] = z0;
    this._arcP[i6 + 3] = x1; this._arcP[i6 + 4] = y1; this._arcP[i6 + 5] = z1;
    this._arcCol[slot * 3] = col.r; this._arcCol[slot * 3 + 1] = col.g; this._arcCol[slot * 3 + 2] = col.b;
    this._arcActive[slot] = 1;
    this._arcLanded[slot] = 0;
    this._arcT[slot] = -Math.max(0, delay || 0);
    this._arcDur[slot] = Math.max(0.2, Number.isFinite(dur) ? dur : ARC_SEC);
    this._arcW[slot] = clamp01(Number.isFinite(weight) ? weight : 0.6);
    this._arcBuyer[slot] = Number.isInteger(buyerId) ? buyerId : -1;
    this._arcSeller[slot] = Number.isInteger(sellerId) ? sellerId : -1;
    return slot;
  }

  /** Quadratic Bézier control points of arc i into this._bez; returns an arc-length estimate. */
  _arcCurve(i) {
    const P = this._arcP;
    const B = this._bez;
    const i6 = i * 6;
    const x0 = P[i6];
    const y0 = P[i6 + 1];
    const z0 = P[i6 + 2];
    const x2 = P[i6 + 3];
    const y2 = P[i6 + 4];
    const z2 = P[i6 + 5];
    const dx = x2 - x0;
    const dy = y2 - y0;
    const dz = z2 - z0;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const h = 4 + 0.3 * dist;
    B[0] = x0; B[1] = y0; B[2] = z0;
    B[3] = (x0 + x2) * 0.5; B[4] = Math.max(y0, y2) + 2 * h - Math.abs(dy) * 0.5; B[5] = (z0 + z2) * 0.5;
    B[6] = x2; B[7] = y2; B[8] = z2;
    return Math.sqrt(dist * dist + (16 / 3) * h * h);
  }

  _bezX(t) { const u = 1 - t; const B = this._bez; return u * u * B[0] + 2 * u * t * B[3] + t * t * B[6]; }
  _bezY(t) { const u = 1 - t; const B = this._bez; return u * u * B[1] + 2 * u * t * B[4] + t * t * B[7]; }
  _bezZ(t) { const u = 1 - t; const B = this._bez; return u * u * B[2] + 2 * u * t * B[5] + t * t * B[8]; }

  _updateArcs(dt) {
    const LP = this._arcLinePos;
    const LC = this._arcLineCol;
    const CP = this._cometPos;
    const CC = this._cometCol;
    const CS = this._cometSize;
    const CA = this._cometAlpha;
    const tmp = this._p;
    let lv = 0;
    let pc = 0;
    for (let i = 0; i < ARC_POOL; i++) {
      if (!this._arcActive[i]) continue;
      const t = this._arcT[i] + dt;
      this._arcT[i] = t;
      if (t < 0) continue;
      const dur = this._arcDur[i];
      const u = t / dur;
      const fade = u <= 1 ? 1 : 1 - (t - dur) / ARC_FADE;
      if (fade <= 0) { this._arcActive[i] = 0; continue; }

      // Endpoints follow their flames while the agents live.
      const i6 = i * 6;
      if (this._arcBuyer[i] >= 0 && this._flameOf(this._arcBuyer[i], tmp)) {
        this._arcP[i6] = tmp.x; this._arcP[i6 + 1] = tmp.y; this._arcP[i6 + 2] = tmp.z;
      }
      if (this._arcSeller[i] >= 0 && this._flameOf(this._arcSeller[i], tmp)) {
        this._arcP[i6 + 3] = tmp.x; this._arcP[i6 + 4] = tmp.y; this._arcP[i6 + 5] = tmp.z;
      }
      const len = this._arcCurve(i);
      const w = this._arcW[i];
      const cr = this._arcCol[i * 3];
      const cg = this._arcCol[i * 3 + 1];
      const cb = this._arcCol[i * 3 + 2];
      const head = u >= 1 ? 1 : u * u * (3 - 2 * u);

      if (u >= 1 && !this._arcLanded[i]) {
        this._arcLanded[i] = 1;
        const x = this._arcP[i6 + 3];
        const y = this._arcP[i6 + 4];
        const z = this._arcP[i6 + 5];
        this._c.setRGB(cr, cg, cb);
        this.burst(x, y, z, this._c, 3 + Math.round(5 * w), 'glint');
        if (w > 0.55) this.burst(x, y, z, C_WHITE_HOT, 3, 'spark');
      }

      // Thread of light behind the head.
      const gain = (0.55 + 0.45 * w) * fade;
      for (let s = 0; s < ARC_SEG; s++) {
        const ta = s / ARC_SEG;
        if (ta >= head) break;
        const tb = Math.min(head, (s + 1) / ARC_SEG);
        const ia = (0.16 + 0.84 * Math.exp(-(head - ta) * 7)) * gain;
        const ib = (0.16 + 0.84 * Math.exp(-(head - tb) * 7)) * gain;
        const v3 = lv * 3;
        LP[v3] = this._bezX(ta); LP[v3 + 1] = this._bezY(ta); LP[v3 + 2] = this._bezZ(ta);
        LP[v3 + 3] = this._bezX(tb); LP[v3 + 4] = this._bezY(tb); LP[v3 + 5] = this._bezZ(tb);
        LC[v3] = cr * ia; LC[v3 + 1] = cg * ia; LC[v3 + 2] = cb * ia;
        LC[v3 + 3] = cr * ib; LC[v3 + 4] = cg * ib; LC[v3 + 5] = cb * ib;
        lv += 2;
        // Soft glow bead: turns the hairline into a luminous ribbon.
        const b3 = pc * 3;
        CP[b3] = LP[v3]; CP[b3 + 1] = LP[v3 + 1]; CP[b3 + 2] = LP[v3 + 2];
        CC[b3] = cr; CC[b3 + 1] = cg; CC[b3 + 2] = cb;
        CS[pc] = 0.55 + 0.55 * w;
        CA[pc] = ia * 0.3;
        pc++;
      }

      // Comet: tail sprites plus the bright head.
      const span = Math.min(0.45, ARC_TAIL_WORLD / Math.max(1, len));
      const tailFade = u < 1 ? 1 : fade * 0.6;
      for (let k = 1; k <= ARC_TAIL; k++) {
        const tk = head - (k / ARC_TAIL) * span;
        if (tk < 0) break;
        const f = 1 - k / (ARC_TAIL + 1);
        const p3 = pc * 3;
        CP[p3] = this._bezX(tk); CP[p3 + 1] = this._bezY(tk); CP[p3 + 2] = this._bezZ(tk);
        const whiten = f * 0.45;
        CC[p3] = cr + (C_WHITE_HOT.r - cr) * whiten;
        CC[p3 + 1] = cg + (C_WHITE_HOT.g - cg) * whiten;
        CC[p3 + 2] = cb + (C_WHITE_HOT.b - cb) * whiten;
        CS[pc] = (0.45 + 0.6 * w) * (0.35 + 0.65 * f);
        CA[pc] = Math.pow(f, 1.6) * tailFade;
        pc++;
      }
      const p3 = pc * 3;
      CP[p3] = this._bezX(head); CP[p3 + 1] = this._bezY(head); CP[p3 + 2] = this._bezZ(head);
      CC[p3] = (cr * 0.4 + C_WHITE_HOT.r * 0.6) * 1.6;
      CC[p3 + 1] = (cg * 0.4 + C_WHITE_HOT.g * 0.6) * 1.6;
      CC[p3 + 2] = (cb * 0.4 + C_WHITE_HOT.b * 0.6) * 1.6;
      CS[pc] = (1.4 + 1.0 * w) * (0.88 + 0.12 * Math.sin(t * 40 + i)) * (u < 1 ? 1 : fade);
      CA[pc] = u < 1 ? 1 : fade;
      pc++;
    }
    const lg = this._arcLines.geometry;
    const cg2 = this._comets.geometry;
    lg.setDrawRange(0, lv);
    cg2.setDrawRange(0, pc);
    // Upload only the used prefix, and nothing at all while no arc is in flight (~250 KB/frame).
    if (lv === 0 && pc === 0 && !this._arcsWereActive) return;
    this._arcsWereActive = lv > 0 || pc > 0;
    const upload = (attr, n) => {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(1, n) * attr.itemSize);
      attr.needsUpdate = true;
    };
    upload(lg.attributes.position, lv);
    upload(lg.attributes.color, lv);
    upload(cg2.attributes.position, pc);
    upload(cg2.attributes.aColor, pc);
    upload(cg2.attributes.aSize, pc);
    upload(cg2.attributes.aAlpha, pc);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rings, moths, labels
  // ─────────────────────────────────────────────────────────────────────────

  _spawnRing(x, y, z, horizontal, color, delay, dur, maxR, gain) {
    let slot = null;
    let oldest = -Infinity;
    for (let i = 0; i < this._ripples.length; i++) {
      const r = this._ripples[i];
      if (!r.active) { slot = r; break; }
      const age = r.t / r.dur;
      if (age > oldest) { oldest = age; slot = r; }
    }
    if (!slot) return;
    const mesh = slot.mesh;
    mesh.position.set(x, y, z);
    if (horizontal) {
      mesh.rotation.set(-Math.PI / 2, 0, 0);
    } else {
      let nx = x - JAR_CX;
      let nz = z - JAR_CZ;
      const l = Math.sqrt(nx * nx + nz * nz);
      if (l > 1e-6) { nx /= l; nz /= l; } else { nx = 1; nz = 0; }
      mesh.rotation.set(0, 0, 0);
      mesh.lookAt(x + nx, y, z + nz);
    }
    slot.mat.color.copy(color);
    slot.active = true;
    slot.t = -Math.max(0, delay);
    slot.dur = Math.max(0.2, dur);
    slot.maxR = Math.max(0.5, maxR);
    slot.gain = gain;
    mesh.scale.setScalar(0.01);
    slot.mat.opacity = 0;
    mesh.visible = false;
  }

  _updateRipples(dt) {
    for (let i = 0; i < this._ripples.length; i++) {
      const r = this._ripples[i];
      if (!r.active) continue;
      r.t += dt;
      if (r.t < 0) continue;
      const u = r.t / r.dur;
      if (u >= 1) { r.active = false; r.mesh.visible = false; continue; }
      const e = 1 - Math.pow(1 - u, 2.2);
      r.mesh.scale.setScalar(0.3 + e * r.maxR);
      r.mat.opacity = 0.85 * r.gain * (1 - u) * Math.min(1, u * 8);
      r.mesh.visible = true;
    }
  }

  _spawnMoth(dir, x, y, z, agentId, wealth) {
    let slot = null;
    let oldest = -1;
    for (let i = 0; i < this._moths.length; i++) {
      const m = this._moths[i];
      if (!m.active) { slot = m; break; }
      if (m.t > oldest) { oldest = m.t; slot = m; }
    }
    if (!slot || !this._mothTex) return;
    const sway = rand(-4, 4);
    slot.active = true;
    slot.t = 0;
    slot.dir = dir;
    slot.agentId = agentId;
    if (dir > 0) {
      slot.x0 = x; slot.y0 = y + 1.1; slot.z0 = z;
      slot.x1 = x + sway; slot.y1 = MOTH_Y; slot.z1 = z + rand(-4, 4);
    } else {
      slot.x0 = x + sway; slot.y0 = MOTH_Y; slot.z0 = z + rand(-4, 4);
      slot.x1 = x; slot.y1 = y + 1.2; slot.z1 = z;
    }
    const w = clamp01(Math.log2(1 + Math.max(0, wealth) / 10) / 4);
    if (w < 0.5) this._c.copy(C_POOR).lerp(C_MID, w * 2); else this._c.copy(C_MID).lerp(C_RICH, (w - 0.5) * 2);
    slot.r = this._c.r; slot.g = this._c.g; slot.b = this._c.b;
    slot.trail = 0;
    slot.sprite.visible = true;
    slot.mat.opacity = 0;
  }

  _updateMoths(dt) {
    for (let i = 0; i < this._moths.length; i++) {
      const m = this._moths[i];
      if (!m.active) continue;
      m.t += dt;
      const u = m.t / MOTH_SEC;
      if (u >= 1) {
        m.active = false;
        m.sprite.visible = false;
        if (m.dir < 0) {
          this._c.setRGB(m.r, m.g, m.b);
          this.burst(m.x1, m.y1, m.z1, this._c, 8, 'glint');
        }
        continue;
      }
      if (m.dir < 0 && m.agentId >= 0) {
        const a = this._agent(m.agentId);
        if (a) { m.x1 = a.pos.x; m.y1 = a.pos.y + 1.2; m.z1 = a.pos.z; }
      }
      const e = m.dir > 0 ? u * u : 1 - (1 - u) * (1 - u);
      const flutter = Math.sin(this._time * 7 + i) * 0.6 * (1 - Math.abs(2 * u - 1));
      const x = m.x0 + (m.x1 - m.x0) * e + flutter;
      const y = m.y0 + (m.y1 - m.y0) * e;
      const z = m.z0 + (m.z1 - m.z0) * e + flutter * 0.5;
      m.sprite.position.set(x, y, z);
      const flap = 0.3 + 0.7 * Math.abs(Math.cos(this._time * 19 + i * 1.7));
      m.sprite.scale.set(1.7 * flap, 1.35, 1);
      m.mat.opacity = Math.min(1, u / 0.15, (1 - u) / 0.15);
      m.trail += dt;
      if (m.trail >= 0.06) {
        m.trail = 0;
        this._c.setRGB(m.r, m.g, m.b);
        this._addPool.emit(x, y - 0.4, z, rand(-0.3, 0.3), rand(-0.4, 0.2), rand(-0.3, 0.3),
          this._c.r, this._c.g, this._c.b, rand(0.5, 0.9), 0.35, 0.08, 0, 1.5, 0.9, 1);
      }
    }
  }

  _updateTexts(dt, camera) {
    if (!this._texts.length) return;
    camera?.updateMatrixWorld?.();              // project with this frame's orbit, not last frame's
    const Wd = (typeof window !== 'undefined' && window.innerWidth) || 1;
    const Hd = (typeof window !== 'undefined' && window.innerHeight) || 1;
    const v = this._v;
    for (let i = 0; i < this._texts.length; i++) {
      const t = this._texts[i];
      if (!t.active) continue;
      t.t += dt;
      const u = t.t / t.life;
      if (u >= 1 || !camera) {
        t.active = false;
        t.el.style.display = 'none';
        continue;
      }
      v.set(t.x, t.y + 1.2 * (1 - (1 - u) * (1 - u)), t.z).project(camera);
      let op = 0;
      if (v.z > -1 && v.z < 1) op = u < 0.12 ? u / 0.12 : u > 0.6 ? 1 - (u - 0.6) / 0.4 : 1;
      const sx = Math.round((v.x * 0.5 + 0.5) * Wd);
      const sy = Math.round((0.5 - v.y * 0.5) * Hd);
      t.el.style.transform = 'translate(' + sx + 'px,' + sy + 'px) translate(-50%,-100%)';
      const q = Math.round(op * 50) / 50;
      if (q !== t.op) { t.op = q; t.el.style.opacity = String(q); }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Persistent layers
  // ─────────────────────────────────────────────────────────────────────────

  _rebuildPiles(sim) {
    this._pilesDirty = false;
    this._pileTimer = 0;
    const market = sim && sim.market;
    const markets = sim && sim.worldInfo && sim.worldInfo.markets;
    const mesh = this._piles;
    const cap = mesh.instanceMatrix.count;
    const G = GOODS.length;
    let n = 0;
    if (market && typeof market.getPiles === 'function' && markets) {
      const nm = Math.min(markets.length, this._pileMarkets);
      for (let m = 0; m < nm; m++) {
        const mk = markets[m];
        const pads = mk && mk.pads;
        const piles = market.getPiles(m);
        for (let g = 0; g < G; g++) {
          const good = GOODS[g];
          const pad = pads && pads[good];
          if (!pad || !Number.isFinite(pad.x)) { this._pileTop[m * G + g] = 0; continue; }
          const units = piles ? Math.max(0, Math.floor(Number(piles[good]) || 0)) : 0;
          const cubes = Math.min(units, PILE_MAX_CUBES);
          const bx = pad.x + 0.5;
          const bz = pad.z + 0.5;
          let top = pad.y;
          for (let k = 0; k < cubes && n < cap; k++) {
            const layer = k >> 2;
            const qd = k & 3;
            const h = hash01(m * 16 + g, k, 7);
            const off = PILE_CUBE * 0.5 + 0.01;
            this._p.set(
              bx + ((qd & 1) ? off : -off) + (h - 0.5) * 0.05,
              pad.y + PILE_CUBE * 0.5 + layer * PILE_CUBE,
              bz + ((qd & 2) ? off : -off) + (hash01(k, g, m) - 0.5) * 0.05);
            this._q.setFromAxisAngle(UP, (h - 0.5) * 0.3);
            this._s.set(1, 1, 1);
            this._m.compose(this._p, this._q, this._s);
            mesh.setMatrixAt(n, this._m);
            this._c.copy(GOOD_COL[g]).multiplyScalar(0.88 + 0.24 * h);
            mesh.setColorAt(n, this._c);
            n++;
            top = pad.y + (layer + 1) * PILE_CUBE;
          }
          if (units > PILE_MAX_CUBES && n < cap) {
            const sc = Math.min(2.2, 1 + 0.35 * Math.log2(units / PILE_MAX_CUBES));
            const layers = PILE_MAX_CUBES >> 2;
            this._p.set(bx, pad.y + layers * PILE_CUBE + PILE_CUBE * 0.5 * sc, bz);
            this._q.setFromAxisAngle(UP, 0.35);
            this._s.set(sc, sc, sc);
            this._m.compose(this._p, this._q, this._s);
            mesh.setMatrixAt(n, this._m);
            this._c.copy(GOOD_COL[g]).multiplyScalar(1.08);
            mesh.setColorAt(n, this._c);
            n++;
            top = pad.y + layers * PILE_CUBE + PILE_CUBE * sc;
          }
          this._pileTop[m * G + g] = top;
        }
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** Direction toward the sun: renderer.sunDir, else the renderer's sun light, else §F.4 geometry. */
  _computeSunDir(sim, out) {
    const r = sim && sim.renderer;
    const sd = r && r.sunDir;
    if (sd && Number.isFinite(sd.x) && Number.isFinite(sd.y) && Number.isFinite(sd.z)) {
      out.set(sd.x, sd.y, sd.z);
      if (out.lengthSq() > 1e-8) return out.normalize();
    }
    const light = r && r.sun;
    if (light && light.isDirectionalLight && light.target) {
      out.subVectors(light.position, light.target.position);
      if (out.lengthSq() > 1e-8) return out.normalize();
    }
    const clock = sim && sim.clock;
    let h = clock && Number.isFinite(clock.hourFloat) ? clock.hourFloat : NaN;
    if (!Number.isFinite(h)) h = clock && Number.isFinite(clock.tick) ? (clock.tick % 2400) / 100 : 12;
    // Azimuth east (+X) → west (−X) over 06–18, maximum elevation 60° at noon; the same arc (and the
    // same −0.55 z tilt toward the window side) as renderer.js uses for its uSunDir.
    const t = clamp01((h - 6) / 12);
    const az = Math.PI * t;
    const el = (Math.PI / 3) * Math.sin(Math.PI * t);
    out.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el) * -0.55);
    return out.normalize();
  }

  _updateBeams(dt, sim) {
    const towers = sim && sim.production && sim.production.towers;
    const clock = sim && sim.clock;
    const sun = clock && Number.isFinite(clock.sun) ? clock.sun : 0;
    const tick = clock && Number.isFinite(clock.tick) ? clock.tick : 0;
    const haze = sim && sim.ledger ? sim.ledger.haze : 1;
    const eta = Number.isFinite(haze) ? clamp01(haze) : 1;
    let n = 0;
    this._glintTimer += dt;
    const glint = this._glintTimer >= 0.7;
    if (glint) this._glintTimer = 0;
    if (towers && towers.length && sun > 0.001) {
      const dir = this._computeSunDir(sim, this._sunDir);
      if (dir.y > 0.02) {
        this._q.setFromUnitVectors(UP, dir);
        for (let i = 0; i < towers.length && n < BEAM_MAX; i++) {
          const t = towers[i];
          if (!t || !t.active || !t.lens || !Number.isFinite(t.lens.x)) continue;
          const boosted = Number.isFinite(t.boostUntil) && t.boostUntil > tick;
          let op = 0.6 * sun * eta * (boosted ? 2 : 1);
          op *= 0.9 + 0.1 * Math.sin(this._time * 3 + i * 1.7);
          if (op <= 0.004) continue;
          const x = t.lens.x + 0.5;
          const y = t.lens.y + 0.5;
          const z = t.lens.z + 0.5;
          this._p.set(x, y, z);
          this._s.set(1, 1, 1);
          this._m.compose(this._p, this._q, this._s);
          this._beamCore.setMatrixAt(n, this._m);
          this._c.copy(C_BEAM).multiplyScalar(op * 1.6);
          this._beamCore.setColorAt(n, this._c);
          this._s.set(boosted ? 5 : 3.5, 1, boosted ? 5 : 3.5);
          this._m.compose(this._p, this._q, this._s);
          this._beamGlow.setMatrixAt(n, this._m);
          this._c.copy(C_BEAM).multiplyScalar(op * 0.35);
          this._beamGlow.setColorAt(n, this._c);
          if (glint) this.burst(x, y, z, boosted ? '#FFFFFF' : '#FFF4D6', boosted ? 3 : 1, 'glint');
          n++;
        }
      }
    }
    this._beamCore.count = n;
    this._beamGlow.count = n;
    if (n > 0) {
      this._beamCore.instanceMatrix.needsUpdate = true;
      this._beamCore.instanceColor.needsUpdate = true;
      this._beamGlow.instanceMatrix.needsUpdate = true;
      this._beamGlow.instanceColor.needsUpdate = true;
    }
  }

  _updateHands(dt, sim) {
    const list = sim && sim.effects && sim.effects.eclipses;
    const tick = sim && sim.clock && Number.isFinite(sim.clock.tick) ? sim.clock.tick : 0;
    let e = 0;
    for (let h = 0; h < this._hands.length; h++) {
      const hand = this._hands[h];
      let ecl = null;
      if (list) {
        while (e < list.length) {
          const c = list[e++];
          if (c && Number.isFinite(c.x) && Number.isFinite(c.z) && !(c.untilTick <= tick)) { ecl = c; break; }
        }
      }
      if (ecl) {
        const key = ecl.id != null ? ecl.id : -(Math.round(ecl.x * 1000) * 1000 + Math.round(ecl.z) + 1);
        if (hand.id !== key) { hand.id = key; hand.fade = 0; }
        hand.fade = Math.min(1, hand.fade + dt / 0.6);
        const r = Math.max(1, Number(ecl.r) || 12);
        const g = hand.group;
        g.position.set(ecl.x, HAND_Y + 0.6 * Math.sin(this._time * 0.7 + h * 2), ecl.z);
        g.scale.setScalar(r * (0.92 + 0.08 * hand.fade));
        g.visible = true;
        hand.mat.opacity = 0.5 * hand.fade;
      } else if (hand.group.visible) {
        hand.fade = Math.max(0, hand.fade - dt / 0.4);
        hand.mat.opacity = 0.5 * hand.fade;
        if (hand.fade <= 0) { hand.group.visible = false; hand.id = null; }
      }
    }
  }

  _updateSeals(sim) {
    const list = sim && sim.effects && sim.effects.seals;
    const tick = sim && sim.clock && Number.isFinite(sim.clock.tick) ? sim.clock.tick : 0;
    let n = 0;
    if (list) {
      for (let i = 0; i < list.length && n < SEAL_MAX; i++) {
        const s = list[i];
        if (!s || s.untilTick <= tick) continue;
        const m = s.marketId | 0;
        if (!this._padTop(m, s.good, this._p)) continue;
        const mesh = this._seals[n];
        const mats = s.kind === 'floor' ? this._sealMats.floor : this._sealMats.ceiling;
        if (mesh.material !== mats) mesh.material = mats;
        mesh.position.set(this._p.x, this._p.y + 1.3 + 0.15 * Math.sin(this._time * 2 + i), this._p.z);
        mesh.rotation.set(0, this._time * 1.1 + i, 0);
        mesh.visible = true;
        n++;
      }
    }
    for (let i = n; i < SEAL_MAX; i++) if (this._seals[i].visible) this._seals[i].visible = false;
  }

  _updatePanes(sim) {
    const panes = sim && sim.effects && sim.effects.panes;
    let sig = 17;
    if (panes) {
      for (let i = 0; i < panes.length; i++) {
        const p = panes[i];
        if (!p) continue;
        const cells = p.cells;
        sig = (Math.imul(sig, 31) + ((p.id | 0) * 7 + (cells ? cells.length : 0) * 13 + (p.breached ? 3 : 0) + (p.deep ? 1 : 0))) | 0;
      }
      sig = (Math.imul(sig, 31) + panes.length) | 0;
    }
    this._paneMat.opacity = 0.62 + 0.18 * Math.sin(this._time * 2.2);
    if (sig === this._paneSig) return;
    this._paneSig = sig;
    const P = this._panePos;
    const C = this._paneCol;
    let v = 0;
    const seg = (x0, y0, z0, x1, y1, z1, col, k) => {
      const v3 = v * 3;
      P[v3] = x0; P[v3 + 1] = y0; P[v3 + 2] = z0;
      P[v3 + 3] = x1; P[v3 + 4] = y1; P[v3 + 5] = z1;
      C[v3] = col.r * k; C[v3 + 1] = col.g * k; C[v3 + 2] = col.b * k;
      C[v3 + 3] = col.r * k; C[v3 + 4] = col.g * k; C[v3 + 5] = col.b * k;
      v += 2;
    };
    if (panes) {
      for (let i = 0, used = 0; i < panes.length && used < PANE_MAX; i++) {
        const p = panes[i];
        const cells = p && p.cells;
        if (!cells || !cells.length) continue;
        used++;
        const col = p.breached ? C_BREACH : C_PANE;
        let segs = 0;
        let px = 0;
        let py = 0;
        let pz = 0;
        let have = false;
        for (let c = 0; c < cells.length && segs < PANE_SEGS - 2; c++) {
          const cell = cells[c];
          if (!cell || !Number.isFinite(cell.x) || !Number.isFinite(cell.y1)) continue;
          const x = cell.x + 0.5;
          const y = cell.y1 + 1.03;
          const z = cell.z + 0.5;
          if (have) { seg(px, py, pz, x, y, z, col, 0.9); segs++; }
          else if (Number.isFinite(cell.y0)) { seg(x, cell.y0, z, x, y, z, col, 0.45); segs++; }
          px = x; py = y; pz = z; have = true;
        }
        const last = cells[cells.length - 1];
        if (have && last && Number.isFinite(last.y0) && cells.length > 1) seg(px, last.y0, pz, px, py, pz, col, 0.45);
      }
    }
    const geo = this._paneLines.geometry;
    geo.setDrawRange(0, v);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }
}
