// Wickmarket agent rendering (SPEC §C.4 G2 "agentRenderer.js").
// Wicklings are drawn with a handful of InstancedMeshes (wax body, profession apron, wick, cargo cubes)
// plus two THREE.Points layers: the additive flames (the purse made visible) and the status-icon glyphs.
// Everything is allocated once for CONFIG.population.max; update() writes the live agents into the
// instance buffers every frame without allocating.
import * as THREE from 'three';
import { CONFIG, GOODS } from '../core/config.js';

const MAX = Math.max(1, (CONFIG.population && CONFIG.population.max) || 110);
const RCFG = CONFIG.render || {};
const FLAME_BASE = Number.isFinite(RCFG.flameBase) ? RCFG.flameBase : 0.12;
const FLAME_K = Number.isFinite(RCFG.flameK) ? RCFG.flameK : 0.07;
const CHILD_DAYS = (CONFIG.agent && Number.isFinite(CONFIG.agent.childScaleDays)) ? CONFIG.agent.childScaleDays : 0.5;

const TWO_PI = Math.PI * 2;
const BODY_W = 0.5;
const BODY_H = 0.8;
const WICK_H = 0.18;
const CUBE = 0.55;                     // panic: the body curls into a 0.55 cube
const CARGO_PER = 4;
const CARGO_Z = -0.37;                 // just behind the back face (body half-depth 0.25 + cube half 0.11)
const CARGO_SLOTS = new Float32Array([-0.12, 0.30, 0.12, 0.30, -0.12, 0.53, 0.12, 0.53]); // (x, y) body units
const FLAME_SPRITE = 5.5;              // sprite diameter / flame radius: room for the core and the halo
const PICK_R = 0.6;
const PICK_LIFT = 0.6;
const ICON_RANGE = 70;
const ICON_FADE = 10;
const ICON_CELLS = 8;                  // atlas cells (7 used)
const ICON_LIFT = 1.1;
const ICON = { NONE: -1, PANIC: 0, SLEEP: 1, TRADE: 2, BUILD: 3, TEND: 4, HUNGRY: 5, FIGHT: 6 };
const HUNGRY = (CONFIG.agent && Number.isFinite(CONFIG.agent.hungry)) ? CONFIG.agent.hungry : 25;
const TELEPORT2 = 9;                   // interpolation is skipped when prevPos→pos jumps more than 3 units
const YAW_RATE = 14;                   // heading smoothing (1/s)

let HASH = 16;
while (HASH < MAX * 8) HASH <<= 1;
const HASH_MASK = HASH - 1;

// Palette (SPEC §A). THREE.Color.set converts the sRGB hex to linear (ADDENDUM §7).
const C_WAX = new THREE.Color('#F3E3C3');
const C_WICK = new THREE.Color('#2B2320');
const C_POOR = new THREE.Color('#FF7A2E');
const C_MID = new THREE.Color('#FFC247');
const C_RICH = new THREE.Color('#FFF4D6');
const C_RUMOR = new THREE.Color('#B388FF');
const C_PANIC = new THREE.Color('#FF3A1C');
const C_BRASS = new THREE.Color('#C9A45C');
const C_HOVER_RING = new THREE.Color('#EFE6D2');
const C_DEFAULT_APRON = new THREE.Color('#8C8577');

const PROF_COL = {};
for (const key of Object.keys(CONFIG.professions || {})) {
  PROF_COL[key] = new THREE.Color(CONFIG.professions[key].color || '#8C8577');
}
const GOOD_COL = GOODS.map(g => new THREE.Color((CONFIG.goods && CONFIG.goods[g] && CONFIG.goods[g].color) || '#EFE6D2'));

const UP = new THREE.Vector3(0, 1, 0);
const XAXIS = new THREE.Vector3(1, 0, 0);

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Stable per-agent phase in [0, 2π) from its id (golden-ratio hash). */
const idPhase = id => ((((id | 0) * 0.6180339887) % 1 + 1) % 1) * TWO_PI;
const idHash = id => (Math.imul((id | 0) ^ 0x5bd1e995, 0x9E3779B1) >>> 0);

/** Distance along a unit ray to a pick sphere (radius PICK_R), or Infinity on a miss. */
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz) {
  const lx = cx - ox;
  const ly = cy - oy;
  const lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const r2 = PICK_R * PICK_R;
  if (!(d2 <= r2)) return Infinity;
  const thc = Math.sqrt(r2 - d2);
  let t0 = tca - thc;
  if (t0 < 0) t0 = tca + thc;
  return t0 >= 0 ? t0 : Infinity;
}

/** Warm self-illumination for the wax: the wick's own flame lights its body after dark. */
function addSelfGlow(material, uniform, key) {
  material.onBeforeCompile = shader => {
    shader.uniforms.uSelfGlow = uniform;
    shader.fragmentShader = 'uniform float uSelfGlow;\n' + shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * uSelfGlow;');
  };
  material.customProgramCacheKey = () => key;
}

const FLAME_VERT = /* glsl */`
uniform float uTime;
uniform float uScale;
attribute vec3 aColor;
attribute float aSize;
attribute vec3 aParams;      // x: phase, y: flicker speed (panic = fast), z: intensity
varying vec3 vColor;
varying float vInt;
varying float vSway;
varying float vFlick;
void main() {
  float ph = aParams.x;
  float sp = aParams.y;
  float fl = 1.0 + 0.10 * sin(uTime * 7.3 * sp + ph)
                 + 0.06 * sin(uTime * 17.1 * sp + ph * 1.7)
                 + 0.035 * sin(uTime * 31.3 * sp + ph * 3.1);
  vFlick = fl;
  vColor = aColor;
  vInt = aParams.z * (0.9 + 0.1 * fl);
  vSway = sin(uTime * 3.1 * sp + ph * 2.0) + 0.35 * sin(uTime * 8.7 * sp + ph);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * fl * uScale / max(0.05, -mv.z), 2.0, 180.0);
}`;

const FLAME_FRAG = /* glsl */`
uniform float uBoost;
varying vec3 vColor;
varying float vInt;
varying float vSway;
varying float vFlick;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  p.y = -p.y;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float halo = exp(-r2 * 4.5) * 0.42;
  float yy = p.y + 0.12;
  float sway = vSway * 0.10 * clamp(yy + 0.35, 0.0, 1.2);
  float wx = mix(0.30, 0.09, clamp(yy * 0.9 + 0.45, 0.0, 1.0));
  float hy = 0.40 * vFlick;
  float cx = (p.x - sway) / wx;
  float cy = yy / hy;
  float core = exp(-(cx * cx) - (cy * cy));
  float hx = (p.x - sway * 0.5) / (wx * 0.45);
  float hy2 = (yy + 0.08) / 0.2;
  float hot = exp(-(hx * hx) - (hy2 * hy2));
  vec3 col = vColor * (halo + core * 1.25) + vec3(1.0, 0.96, 0.86) * hot * 0.85;
  float edge = 1.0 - smoothstep(0.72, 1.0, sqrt(r2));
  gl_FragColor = vec4(col * vInt * uBoost * edge, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const ICON_VERT = /* glsl */`
uniform float uScale;
uniform float uSize;
attribute float aIcon;
attribute float aAlpha;
varying float vIcon;
varying float vAlpha;
void main() {
  vIcon = aIcon;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uSize * uScale / max(0.05, -mv.z), 11.0, 34.0);
}`;

const ICON_FRAG = /* glsl */`
uniform sampler2D uAtlas;
varying float vIcon;
varying float vAlpha;
void main() {
  vec2 uv = vec2((vIcon + gl_PointCoord.x) / ${ICON_CELLS.toFixed(1)}, 1.0 - gl_PointCoord.y);
  vec4 t = texture2D(uAtlas, uv);
  float a = t.a * vAlpha;
  if (a < 0.02) discard;
  gl_FragColor = vec4(t.rgb, a);
  #include <colorspace_fragment>
}`;

/** Draws the six status glyphs procedurally (no font dependency) into a 1×8 atlas. */
function makeIconAtlas() {
  if (typeof document === 'undefined') {
    const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    tex.needsUpdate = true;
    return tex;
  }
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = S * ICON_CELLS;
  cv.height = S;
  const g = cv.getContext('2d');
  const ink = '#1B1712';
  const cell = (i, draw) => {
    g.save();
    g.translate(i * S + S / 2, S / 2);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    draw();
    g.restore();
  };
  const outlineFill = (fill, lw = 7) => {
    g.strokeStyle = ink; g.lineWidth = lw; g.stroke();
    g.fillStyle = fill; g.fill();
  };
  // 0: panic "!" in alert red
  cell(ICON.PANIC, () => {
    g.beginPath();
    g.moveTo(-6, -24); g.lineTo(6, -24); g.lineTo(3.5, 8); g.lineTo(-3.5, 8); g.closePath();
    g.moveTo(7, 19); g.arc(0, 19, 7, 0, TWO_PI);
    outlineFill('#E0483A');
  });
  // 1: sleep "z"
  cell(ICON.SLEEP, () => {
    g.beginPath();
    g.moveTo(-15, -17); g.lineTo(15, -17); g.lineTo(15, -10); g.lineTo(-4, 11); g.lineTo(15, 11);
    g.lineTo(15, 18); g.lineTo(-15, 18); g.lineTo(-15, 11); g.lineTo(4, -10); g.lineTo(-15, -10); g.closePath();
    outlineFill('#A8CFE0', 6);
  });
  // 2: trade "◆" gold
  cell(ICON.TRADE, () => {
    g.beginPath();
    g.moveTo(0, -24); g.lineTo(18, 0); g.lineTo(0, 24); g.lineTo(-18, 0); g.closePath();
    outlineFill('#FFC247');
    g.beginPath(); g.moveTo(0, -14); g.lineTo(7, 0); g.lineTo(0, -2); g.lineTo(-7, 0); g.closePath();
    g.fillStyle = 'rgba(255,244,214,0.85)'; g.fill();
  });
  // 3: build "▲"
  cell(ICON.BUILD, () => {
    g.beginPath();
    g.moveTo(0, -22); g.lineTo(22, 18); g.lineTo(-22, 18); g.closePath();
    outlineFill('#EFE6D2');
    g.beginPath(); g.moveTo(-11, 8); g.lineTo(11, 8); g.strokeStyle = '#B5654A'; g.lineWidth = 4; g.stroke();
  });
  // 4: tend "✦" cyan
  cell(ICON.TEND, () => {
    g.beginPath();
    for (let k = 0; k < 8; k++) {
      const ang = -Math.PI / 2 + k * Math.PI / 4;
      const r = k % 2 === 0 ? 25 : 7;
      const x = Math.cos(ang) * r;
      const y = Math.sin(ang) * r;
      if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    outlineFill('#6FD3E8', 6);
  });
  // 5: hungry "○"
  cell(ICON.HUNGRY, () => {
    g.beginPath(); g.arc(0, 0, 17, 0, TWO_PI);
    g.strokeStyle = ink; g.lineWidth = 13; g.stroke();
    g.strokeStyle = '#F2A65A'; g.lineWidth = 6; g.stroke();
  });
  // 6: fight — two crossed blades in alert red
  cell(ICON.FIGHT, () => {
    const blade = (sgn) => {
      g.save();
      g.rotate(sgn * Math.PI / 4);
      g.beginPath();
      g.moveTo(-4, -26); g.lineTo(4, -26); g.lineTo(4, 10); g.lineTo(-4, 10); g.closePath();
      outlineFill('#EFE6D2', 5);
      g.beginPath();
      g.moveTo(-11, 10); g.lineTo(11, 10); g.lineTo(11, 16); g.lineTo(-11, 16); g.closePath();
      outlineFill('#E0483A', 5);
      g.restore();
    };
    blade(1);
    blade(-1);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Renders every live Wickling: wax body, apron, wick, cargo, flame purse and status glyph.
 * Constructed by main.js as `new AgentRenderer(renderer.scene, sim)`; `update(sim, alpha, camera)` runs each frame.
 */
export class AgentRenderer {
  /**
   * @param {THREE.Scene} scene scene to add the agent layers to
   * @param {object} sim shared sim context (SPEC §C.1)
   */
  constructor(scene, sim) {
    this.sim = sim;
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'wicklings';
    if (scene) scene.add(this.root);

    /** @type {number|null} */ this.selectedId = null;
    /** @type {number|null} */ this.hoveredId = null;
    // Body wax per clan (clan 0 keeps the classic honey wax).
    const clanList = sim && sim.clans && sim.clans.multi ? sim.clans.list : null;
    this._clanBody = clanList ? clanList.map(cl => new THREE.Color(cl.body || '#F3E3C3')) : null;

    this._selfGlow = { value: 0.12 };
    this._count = 0;
    this._time = 0;
    this._animClock = 0;
    this._lastNow = (typeof performance !== 'undefined' ? performance.now() : 0);

    // Per-slot caches (slot = index into this frame's live list).
    this._ids = new Int32Array(MAX).fill(-1);
    this._feet = new Float32Array(MAX * 3);
    this._flame = new Float32Array(MAX * 3);
    this._keys = new Int32Array(HASH).fill(-1);
    this._slots = new Int32Array(HASH);
    // Display-heading smoothing, hashed by id (collisions only reset the smoothing).
    this._yawId = new Int32Array(HASH).fill(-1);
    this._yaw = new Float32Array(HASH);

    // Scratch (never reallocated).
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._c = new THREE.Color();
    this._c2 = new THREE.Color();
    this._vp = new THREE.Vector2();

    this._buildMeshes();
    this._buildFlames();
    this._buildIcons();
    this._buildRings();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Construction
  // ─────────────────────────────────────────────────────────────────────────

  _buildMeshes() {
    const bodyGeo = new THREE.BoxGeometry(BODY_W, BODY_H, BODY_W);
    bodyGeo.translate(0, BODY_H / 2, 0);                         // origin at the feet: scales/pitches from the ground
    const apronGeo = new THREE.BoxGeometry(0.54, 0.34, 0.54);
    apronGeo.translate(0, 0.05 + 0.17, 0);                       // lower body band
    const wickGeo = new THREE.BoxGeometry(0.06, WICK_H, 0.06);
    wickGeo.translate(0, WICK_H / 2, 0);
    const cargoGeo = new THREE.BoxGeometry(0.22, 0.22, 0.22);

    const bodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    addSelfGlow(bodyMat, this._selfGlow, 'wick-selfglow');
    const apronMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    addSelfGlow(apronMat, this._selfGlow, 'wick-selfglow');
    const wickMat = new THREE.MeshLambertMaterial({ color: C_WICK });
    const cargoMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    addSelfGlow(cargoMat, this._selfGlow, 'wick-selfglow');

    const mk = (geo, mat, count, name) => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.name = name;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;                                   // instances move; the cached bounds would be stale
      m.count = 0;
      this.root.add(m);
      return m;
    };
    this.body = mk(bodyGeo, bodyMat, MAX, 'wickling-body');
    this.apron = mk(apronGeo, apronMat, MAX, 'wickling-apron');
    this.wick = mk(wickGeo, wickMat, MAX, 'wickling-wick');
    this.cargo = mk(cargoGeo, cargoMat, MAX * CARGO_PER, 'wickling-cargo');
    this.body.castShadow = true;
    this.cargo.castShadow = true;
    // Create the colour buffers up front so USE_INSTANCING_COLOR is set on first compile.
    for (let i = 0; i < MAX; i++) { this.body.setColorAt(i, C_WAX); this.apron.setColorAt(i, C_DEFAULT_APRON); }
    for (let i = 0; i < MAX * CARGO_PER; i++) this.cargo.setColorAt(i, C_WAX);
    this.body.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.apron.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.cargo.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  _buildFlames() {
    const geo = new THREE.BufferGeometry();
    this._fPos = new Float32Array(MAX * 3);
    this._fCol = new Float32Array(MAX * 3);
    this._fSize = new Float32Array(MAX);
    this._fPar = new Float32Array(MAX * 3);
    const attr = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr(this._fPos, 3));
    geo.setAttribute('aColor', attr(this._fCol, 3));
    geo.setAttribute('aSize', attr(this._fSize, 1));
    geo.setAttribute('aParams', attr(this._fPar, 3));
    geo.setDrawRange(0, 0);
    this.flameMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 600 }, uBoost: { value: 1 } },
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.flames = new THREE.Points(geo, this.flameMat);
    this.flames.name = 'wickling-flames';
    this.flames.frustumCulled = false;
    this.flames.renderOrder = 5;
    this.flames.onBeforeRender = (renderer, scene, camera) => {
      this.flameMat.uniforms.uScale.value = this._pixelScale(renderer, camera);
    };
    this.root.add(this.flames);
  }

  _buildIcons() {
    const geo = new THREE.BufferGeometry();
    this._iPos = new Float32Array(MAX * 3);
    this._iIcon = new Float32Array(MAX);
    this._iAlpha = new Float32Array(MAX);
    const attr = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr(this._iPos, 3));
    geo.setAttribute('aIcon', attr(this._iIcon, 1));
    geo.setAttribute('aAlpha', attr(this._iAlpha, 1));
    geo.setDrawRange(0, 0);
    this._atlas = makeIconAtlas();
    this.iconMat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uSize: { value: 0.55 }, uAtlas: { value: this._atlas } },
      vertexShader: ICON_VERT,
      fragmentShader: ICON_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.icons = new THREE.Points(geo, this.iconMat);
    this.icons.name = 'wickling-status';
    this.icons.frustumCulled = false;
    this.icons.renderOrder = 6;
    this.icons.onBeforeRender = (renderer, scene, camera) => {
      this.iconMat.uniforms.uScale.value = this._pixelScale(renderer, camera);
    };
    this.root.add(this.icons);
  }

  _buildRings() {
    const ringGeo = new THREE.TorusGeometry(0.58, 0.05, 6, 40);
    ringGeo.rotateX(Math.PI / 2);
    const haloGeo = new THREE.RingGeometry(0.62, 0.95, 40);
    haloGeo.rotateX(-Math.PI / 2);
    this.selRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: C_BRASS }));
    this.selHalo = new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({
      color: C_BRASS, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    this.hovRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: C_HOVER_RING, transparent: true, opacity: 0.55, depthWrite: false,
    }));
    this.selRing.name = 'selection-ring';
    this.hovRing.name = 'hover-ring';
    this.selHalo.renderOrder = 4;
    for (const r of [this.selRing, this.selHalo, this.hovRing]) {
      r.visible = false;
      r.frustumCulled = false;
      this.root.add(r);
    }
  }

  /** Pixels per world unit at depth 1 for the current drawing buffer and camera. */
  _pixelScale(renderer, camera) {
    let h = 800;
    if (renderer && typeof renderer.getDrawingBufferSize === 'function') {
      renderer.getDrawingBufferSize(this._vp);
      h = this._vp.y || h;
    }
    const fov = camera && camera.isPerspectiveCamera ? camera.fov : (RCFG.fov || 50);
    return h / (2 * Math.tan((fov * Math.PI) / 360));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Per-frame
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Write every live agent into the instance buffers.
   * @param {object} sim shared sim context
   * @param {number} alpha interpolation factor between prevPos and pos (0..1)
   * @param {THREE.Camera} [camera] used for the status-icon range test
   */
  update(sim, alpha, camera) {
    sim = sim || this.sim;
    const now = typeof performance !== 'undefined' ? performance.now() : this._lastNow + 16;
    let dt = (now - this._lastNow) / 1000;
    this._lastNow = now;
    if (!(dt >= 0 && dt < 0.25)) dt = 1 / 60;
    this._time = (this._time + dt) % 3600;
    const speed = sim && !sim.paused ? Math.min(3, Math.max(0.25, Number(sim.speed) || 1)) : 0;
    this._animClock = (this._animClock + dt * speed) % 3600;
    const a01 = Number.isFinite(alpha) ? clamp01(alpha) : 1;
    if (!camera) camera = (sim && sim.renderer && sim.renderer.camera) || null;

    const clock = sim && sim.clock;
    const tick = clock && Number.isFinite(clock.tick) ? clock.tick : 0;
    const daylight = clock && Number.isFinite(clock.daylight) ? clamp01(clock.daylight) : 1;
    this._selfGlow.value = 0.07 + 0.2 * (1 - daylight);
    this.flameMat.uniforms.uTime.value = this._time;
    this.flameMat.uniforms.uBoost.value = 0.85 + 0.45 * (1 - daylight);

    this._keys.fill(-1);
    const agents = sim && sim.population && sim.population.agents;
    let n = 0;
    let nc = 0;
    let ni = 0;
    const camPos = camera ? camera.position : null;
    const yawK = 1 - Math.exp(-YAW_RATE * dt);

    if (agents && agents.length) {
      for (let i = 0; i < agents.length && n < MAX; i++) {
        const a = agents[i];
        if (!a || a.alive === false || !a.pos) continue;
        const res = this._writeAgent(a, n, nc, ni, a01, tick, camPos, yawK);
        if (res < 0) continue;
        nc = res & 0xffff;
        ni = res >>> 16;
        n++;
      }
    }
    this._count = n;

    this.body.count = n;
    this.apron.count = n;
    this.wick.count = n;
    this.cargo.count = nc;
    this.body.instanceMatrix.needsUpdate = true;
    this.apron.instanceMatrix.needsUpdate = true;
    this.wick.instanceMatrix.needsUpdate = true;
    this.cargo.instanceMatrix.needsUpdate = true;
    this.body.instanceColor.needsUpdate = true;
    this.apron.instanceColor.needsUpdate = true;
    this.cargo.instanceColor.needsUpdate = true;

    const fg = this.flames.geometry;
    fg.setDrawRange(0, n);
    fg.attributes.position.needsUpdate = true;
    fg.attributes.aColor.needsUpdate = true;
    fg.attributes.aSize.needsUpdate = true;
    fg.attributes.aParams.needsUpdate = true;
    const ig = this.icons.geometry;
    ig.setDrawRange(0, ni);
    ig.attributes.position.needsUpdate = true;
    ig.attributes.aIcon.needsUpdate = true;
    ig.attributes.aAlpha.needsUpdate = true;

    this._placeRings();
  }

  /**
   * Writes one agent at slot n. Returns (cargoCount | iconCount << 16) after this agent, or -1 to skip.
   */
  _writeAgent(a, n, nc, ni, alpha, tick, camPos, yawK) {
    const p = a.pos;
    const pp = a.prevPos || p;
    let x = p.x;
    let y = p.y;
    let z = p.z;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return -1;
    if (Number.isFinite(pp.x) && Number.isFinite(pp.y) && Number.isFinite(pp.z)) {
      const dx = p.x - pp.x;
      const dy = p.y - pp.y;
      const dz = p.z - pp.z;
      if (dx * dx + dy * dy + dz * dz < TELEPORT2) {
        x = pp.x + dx * alpha;
        y = pp.y + dy * alpha;
        z = pp.z + dz * alpha;
      }
    }
    const id = a.id | 0;
    const ph = idPhase(id);
    const anim = a.anim;
    const panic = (Number.isFinite(a.panicUntil) && a.panicUntil > tick) || anim === 'panic';
    const asleep = !!a.asleep || anim === 'sleep';
    const child = Number.isFinite(a.ageDays) && a.ageDays < CHILD_DAYS;
    const cs = child ? 0.8 : 1;
    const tallow = a.needs && Number.isFinite(a.needs.tallow) ? Math.min(100, Math.max(0, a.needs.tallow)) : 100;
    let sy = (0.6 + 0.4 * tallow / 100) * (child ? 0.7 : 1);
    if (asleep) sy *= 0.94;

    // Smoothed display heading.
    const target = Number.isFinite(a.heading) ? a.heading : 0;
    const hk = (Math.imul(id, 0x9E3779B1) >>> 0) & HASH_MASK;
    let yaw;
    if (this._yawId[hk] !== id) { this._yawId[hk] = id; yaw = target; } else {
      yaw = this._yaw[hk];
      let d = (target - yaw) % TWO_PI;
      if (d > Math.PI) d -= TWO_PI; else if (d < -Math.PI) d += TWO_PI;
      yaw += d * yawK;
    }
    this._yaw[hk] = yaw;

    const ac = this._animClock;
    let pitch = 0;
    let bob = 0;
    if (!panic) {
      if (anim === 'walk') bob = 0.06 * Math.abs(Math.sin(ac * TWO_PI * 2.2 + ph));
      else if (anim === 'dig' || anim === 'harvest' || anim === 'build') pitch = 0.32 * Math.sin(ac * TWO_PI * 3 + ph);
      else if (anim === 'craft' || anim === 'scrape') pitch = 0.1 * Math.sin(ac * TWO_PI * 2 + ph);
      else if (anim === 'eat') bob = 0.03 * Math.abs(Math.sin(ac * TWO_PI * 3 + ph));
      else if (anim === 'tend') pitch = 0.06 * Math.sin(ac * TWO_PI * 0.8 + ph);
    }

    const q = this._q;
    q.setFromAxisAngle(UP, yaw);
    let ox;
    let oy;
    let oz;
    let sx;
    let syy;
    if (panic) {
      // Curled into a 0.55 cube, rolling along the heading about its own centre.
      this._q2.setFromAxisAngle(XAXIS, ac * 9 + ph);
      q.multiply(this._q2);
      sx = CUBE / BODY_W;
      syy = CUBE / BODY_H;
      this._v.set(0, CUBE / 2, 0).applyQuaternion(q);
      ox = x - this._v.x;
      oy = y + CUBE / 2 - this._v.y;
      oz = z - this._v.z;
    } else {
      if (pitch !== 0) { this._q2.setFromAxisAngle(XAXIS, pitch); q.multiply(this._q2); }
      sx = cs;
      syy = sy;
      ox = x;
      oy = y + bob;
      oz = z;
    }

    const m = this._m;
    this._p.set(ox, oy, oz);
    this._s.set(sx, syy, sx);
    m.compose(this._p, q, this._s);
    this.body.setMatrixAt(n, m);
    this.apron.setMatrixAt(n, m);

    // Wick on top of the body (not squashed by the tallow scale).
    this._v.set(0, BODY_H * syy, 0).applyQuaternion(q);
    const tx = ox + this._v.x;
    const ty = oy + this._v.y;
    const tz = oz + this._v.z;
    this._p.set(tx, ty, tz);
    this._s.set(cs, cs, cs);
    m.compose(this._p, q, this._s);
    this.wick.setMatrixAt(n, m);

    // Colours: wax body (hover/selection brighten), profession apron.
    const hovered = this.hoveredId != null && id === this.hoveredId;
    const selected = this.selectedId != null && id === this.selectedId;
    const hl = hovered ? 1.55 : selected ? 1.25 : 1;
    const jitter = 0.95 + 0.08 * ((idHash(id) & 1023) / 1023);
    this._c.copy((this._clanBody && this._clanBody[a.clan | 0]) || C_WAX).multiplyScalar(jitter * hl);
    this.body.setColorAt(n, this._c);
    this._c.copy(PROF_COL[a.profession] || C_DEFAULT_APRON).multiplyScalar(hl);
    this.apron.setColorAt(n, this._c);

    // Flame: the purse.
    const wealth = Math.max(0, (Number(a.glim) || 0) + (Number(a.escrow) || 0));
    const lw = Math.log2(1 + wealth / 10);
    const w = clamp01(lw / 4);
    let fsize = FLAME_BASE + FLAME_K * lw;
    if (asleep) fsize *= 0.6;
    const c = this._c;
    if (w < 0.5) c.copy(C_POOR).lerp(C_MID, w * 2); else c.copy(C_MID).lerp(C_RICH, (w - 0.5) * 2);
    const rs = a.rumor && Number.isFinite(a.rumor.strength) ? clamp01(a.rumor.strength) : 0;
    if (rs > 0) c.lerp(C_RUMOR, rs);
    if (panic) c.lerp(C_PANIC, 0.55);
    let fx;
    let fy;
    let fz;
    if (panic) {
      fx = x; fy = y + CUBE + 0.08 + fsize * 0.45; fz = z;
    } else {
      this._v.set(0, WICK_H * cs + fsize * 0.45, 0).applyQuaternion(q);
      fx = tx + this._v.x; fy = ty + this._v.y; fz = tz + this._v.z;
    }
    const n3 = n * 3;
    this._fPos[n3] = fx; this._fPos[n3 + 1] = fy; this._fPos[n3 + 2] = fz;
    this._fCol[n3] = c.r; this._fCol[n3 + 1] = c.g; this._fCol[n3 + 2] = c.b;
    this._fSize[n] = fsize * FLAME_SPRITE;
    this._fPar[n3] = ph;
    this._fPar[n3 + 1] = panic ? 3.4 : 1;
    this._fPar[n3 + 2] = (asleep ? 0.7 : 1) * (hovered ? 1.3 : 1);
    this._flame[n3] = fx; this._flame[n3 + 1] = fy; this._flame[n3 + 2] = fz;
    this._feet[n3] = x; this._feet[n3 + 1] = y; this._feet[n3 + 2] = z;
    this._ids[n] = id;
    let hs = hk;
    for (let probe = 0; probe < HASH; probe++) {
      if (this._keys[hs] === -1 || this._keys[hs] === id) { this._keys[hs] = id; this._slots[hs] = n; break; }
      hs = (hs + 1) & HASH_MASK;
    }

    // Cargo cubes on the back: one per unit, GOODS order, lens skipped, at most 4.
    const inv = a.inv;
    if (!panic && inv) {
      let k = 0;
      for (let g = 0; g < GOODS.length && k < CARGO_PER; g++) {
        let units = inv[GOODS[g]] | 0;
        while (units > 0 && k < CARGO_PER) {
          this._v.set(CARGO_SLOTS[k * 2] * cs, CARGO_SLOTS[k * 2 + 1] * syy, CARGO_Z * cs).applyQuaternion(q);
          this._p.set(ox + this._v.x, oy + this._v.y, oz + this._v.z);
          this._s.set(cs, cs, cs);
          m.compose(this._p, q, this._s);
          this.cargo.setMatrixAt(nc, m);
          this.cargo.setColorAt(nc, GOOD_COL[g]);
          nc++;
          k++;
          units--;
        }
      }
    }

    // Status icon (only near the camera).
    if (camPos) {
      const dx = x - camPos.x;
      const dy = y - camPos.y;
      const dz = z - camPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= ICON_RANGE * ICON_RANGE) {
        let icon = ICON.NONE;
        if (panic) icon = ICON.PANIC;
        else if (Number.isFinite(a.fightUntil) && a.fightUntil > tick) icon = ICON.FIGHT;
        else if (asleep) icon = ICON.SLEEP;
        else if (anim === 'trade') icon = ICON.TRADE;
        else if (anim === 'build') icon = ICON.BUILD;
        else if (anim === 'tend') icon = ICON.TEND;
        else if (tallow < HUNGRY) icon = ICON.HUNGRY;
        if (icon !== ICON.NONE) {
          const d = Math.sqrt(d2);
          let al = clamp01((ICON_RANGE - d) / ICON_FADE);
          if (icon === ICON.PANIC) al *= 0.65 + 0.35 * Math.abs(Math.sin(this._time * 9 + ph));
          const i3 = ni * 3;
          this._iPos[i3] = x;
          this._iPos[i3 + 1] = y + BODY_H * syy + ICON_LIFT + 0.06 * Math.sin(this._time * 2.2 + ph);
          this._iPos[i3 + 2] = z;
          this._iIcon[ni] = icon;
          this._iAlpha[ni] = al;
          ni++;
        }
      }
    }
    return nc | (ni << 16);
  }

  _slotOf(id) {
    if (id == null || this._count === 0) return -1;
    const key = id | 0;
    let hs = (Math.imul(key, 0x9E3779B1) >>> 0) & HASH_MASK;
    for (let probe = 0; probe < HASH; probe++) {
      const k = this._keys[hs];
      if (k === -1) return -1;
      if (k === key) return this._slots[hs];
      hs = (hs + 1) & HASH_MASK;
    }
    return -1;
  }

  _placeRings() {
    const t = this._time;
    const s = this._slotOf(this.selectedId);
    if (s >= 0) {
      const s3 = s * 3;
      const pulse = 1 + 0.06 * Math.sin(t * 4);
      this.selRing.visible = true;
      this.selRing.position.set(this._feet[s3], this._feet[s3 + 1] + 0.05, this._feet[s3 + 2]);
      this.selRing.rotation.y = t * 0.8;
      this.selRing.scale.setScalar(pulse);
      this.selHalo.visible = true;
      this.selHalo.position.set(this._feet[s3], this._feet[s3 + 1] + 0.03, this._feet[s3 + 2]);
      this.selHalo.scale.setScalar(1 + 0.25 * ((t * 0.9) % 1));
      this.selHalo.material.opacity = 0.35 * (1 - ((t * 0.9) % 1));
    } else {
      this.selRing.visible = false;
      this.selHalo.visible = false;
    }
    const h = this.hoveredId !== this.selectedId ? this._slotOf(this.hoveredId) : -1;
    if (h >= 0) {
      const h3 = h * 3;
      this.hovRing.visible = true;
      this.hovRing.position.set(this._feet[h3], this._feet[h3 + 1] + 0.05, this._feet[h3 + 2]);
      this.hovRing.rotation.y = -t * 1.2;
      this.hovRing.scale.setScalar(0.92);
    } else {
      this.hovRing.visible = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Queries and selection
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Nearest agent hit by a ray, tested against spheres of radius 0.6 centred at pos + 0.6y.
   * @param {{origin:{x:number,y:number,z:number}, dir:{x:number,y:number,z:number}}} ray world-space ray
   * @returns {number|null} agent id, or null when nothing is hit
   */
  pick(ray) {
    if (!ray || !ray.origin || !ray.dir) return null;
    const ox = +ray.origin.x;
    const oy = +ray.origin.y;
    const oz = +ray.origin.z;
    let dx = +ray.dir.x;
    let dy = +ray.dir.y;
    let dz = +ray.dir.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 1e-9) || !Number.isFinite(ox + oy + oz)) return null;
    dx /= len; dy /= len; dz /= len;
    let best = Infinity;
    let bestId = null;
    if (this._count > 0) {
      for (let i = 0; i < this._count; i++) {
        const i3 = i * 3;
        const t = raySphere(ox, oy, oz, dx, dy, dz, this._feet[i3], this._feet[i3 + 1] + PICK_LIFT, this._feet[i3 + 2]);
        if (t < best) { best = t; bestId = this._ids[i]; }
      }
    } else {
      const agents = this.sim && this.sim.population && this.sim.population.agents;
      if (agents) {
        for (let i = 0; i < agents.length; i++) {
          const a = agents[i];
          if (!a || a.alive === false || !a.pos) continue;
          const t = raySphere(ox, oy, oz, dx, dy, dz, a.pos.x, a.pos.y + PICK_LIFT, a.pos.z);
          if (t < best) { best = t; bestId = a.id; }
        }
      }
    }
    return bestId;
  }

  /**
   * Draw the brass selection ring under an agent.
   * @param {number|null} id agent id, or null to clear
   */
  setSelected(id) {
    this.selectedId = id == null ? null : id;
  }

  /**
   * Highlight the agent under the cursor.
   * @param {number|null} id agent id, or null to clear
   */
  setHovered(id) {
    this.hoveredId = id == null ? null : id;
  }

  /**
   * Rendered flame position of an agent in the last update (used by fx for trade arcs).
   * @param {number} id agent id
   * @param {{x:number,y:number,z:number}} out receives the position (e.g. a THREE.Vector3)
   * @returns {boolean} false when the agent was not drawn last frame
   */
  flamePosition(id, out) {
    const s = this._slotOf(id);
    if (s < 0 || !out) return false;
    const s3 = s * 3;
    out.x = this._flame[s3];
    out.y = this._flame[s3 + 1];
    out.z = this._flame[s3 + 2];
    return true;
  }

  /** Remove every layer from the scene and free GPU resources. */
  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    const seen = new Set();
    this.root.traverse(o => {
      if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
      if (o.material && !seen.has(o.material)) { seen.add(o.material); o.material.dispose(); }
      if (o.isInstancedMesh && typeof o.dispose === 'function') o.dispose();
    });
    if (this._atlas) this._atlas.dispose();
  }
}
