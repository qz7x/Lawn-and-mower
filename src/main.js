import * as THREE from 'three';
import {
  COMMON, LEAF_LIGHTING, CANOPY, GRASS_VS, GRASS_FS, CLOVER_VS, CLOVER_FS,
  GROUND_VS, GROUND_FS, SKY_VS, SKY_FS, BAKE_VS, BAKE_FS,
} from './glsl.js';
import { buildBladeGeometry, buildStalkGeometry, buildCloverGeometry, buildGroundGeometry } from './geometry.js';

/* ============================================================================================
 * Parameters (URL overridable: ?q=low|med|high|ultra &el=9 &az=25 &wind=1 &dew=0.8 &still=12.5
 *                              &cam=x,z,eyeHeight,yawDeg,pitchDeg &ui=0)
 * ========================================================================================== */
const qs = new URLSearchParams(location.search);
const P = {
  quality: qs.get('q') || 'high',
  sunEl: parseFloat(qs.get('el') ?? '9'),
  sunAz: parseFloat(qs.get('az') ?? '28'),
  wind: parseFloat(qs.get('wind') ?? '1'),
  dew: parseFloat(qs.get('dew') ?? '0.8'),
  exposure: parseFloat(qs.get('exp') ?? '0.9'),
  still: qs.has('still') ? parseFloat(qs.get('still')) : null,
};
const TIERS = { low: 0.30, med: 0.55, high: 1.0, ultra: 1.5 };

/* JS mirror of GLSL terrain() so the camera can stay above the ground */
function terrainHeight(x, z) {
  let h = 1.1 * Math.sin(0.0171 * x + 0.6) * Math.sin(0.0137 * z + 1.9);
  h += 0.6 * Math.sin(0.0399 * x - 0.0283 * z + 2.2);
  h += 0.18 * Math.sin(0.131 * x + 0.4) * Math.cos(0.097 * z);
  h += 0.035 * Math.sin(0.73 * x + 0.61 * z);
  return h;
}

/* ============================================================================================
 * Renderer / scene
 * ========================================================================================== */
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = P.exposure;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, 1, 0.03, 6000);
camera.rotation.order = 'YXZ';

/* ============================================================================================
 * Shared uniforms (every material references the SAME objects -> one update drives all passes)
 * ========================================================================================== */
const U = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3() },
  uSunCol: { value: new THREE.Vector3() },
  uZenith: { value: new THREE.Vector3() },
  uHorizon: { value: new THREE.Vector3() },
  uSunHalo: { value: new THREE.Vector3() },
  uAmbUp: { value: new THREE.Vector3() },
  uAmbHor: { value: new THREE.Vector3() },
  uAmbDown: { value: new THREE.Vector3() },
  uAmbSun: { value: new THREE.Vector3() },
  uWindDir: { value: new THREE.Vector2(0.72, -0.69) },
  uWindAmt: { value: P.wind },
  uDew: { value: P.dew },
  uRes: { value: new THREE.Vector2(1, 1) },
  uFog: { value: new THREE.Vector2(0.004, 0.1) },
  uFieldScale: { value: 1 / 512 },
  uField: { value: null },
  uNoise: { value: null },
};

/* Atmosphere: single-scatter-flavoured colours derived from solar elevation (JS owns state, GLSL consumes) */
function updateAtmosphere(elDeg, azDeg) {
  const el = THREE.MathUtils.degToRad(elDeg), az = THREE.MathUtils.degToRad(azDeg);
  U.uSunDir.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();

  const air = 1 / (Math.sin(el) + 0.50572 * Math.pow(Math.max(elDeg, -1) + 6.07995, -1.6364));
  const tau = [0.044 + 0.11, 0.098 + 0.11, 0.25 + 0.11];            // Rayleigh + aerosol optical depth at zenith
  const T = tau.map(t => Math.exp(-t * air));                       // sun-path transmittance (turns orange near horizon)
  const day = THREE.MathUtils.smoothstep(elDeg, 2, 40);
  const sunI = 3.4;
  U.uSunCol.value.set(T[0] * sunI, T[1] * sunI, T[2] * sunI);

  const zen = new THREE.Vector3(0.10, 0.24, 0.62).multiplyScalar(0.22 + 0.78 * day);
  const dayHor = new THREE.Vector3(0.62, 0.74, 0.92);
  const goldHor = new THREE.Vector3(1.0, 0.52, 0.22).multiplyScalar(0.95);
  const hor = goldHor.clone().lerp(dayHor, day).multiplyScalar(0.45 + 0.55 * day + 0.25 * (1 - day));
  U.uZenith.value.copy(zen);
  U.uHorizon.value.copy(hor);
  U.uSunHalo.value.set(T[0], T[1] * 0.85, T[2] * 0.6).multiplyScalar(0.55);
  U.uAmbUp.value.copy(zen).multiplyScalar(0.85).add(hor.clone().multiplyScalar(0.12));
  U.uAmbHor.value.copy(hor).multiplyScalar(0.40);
  U.uAmbDown.value.set(0.070, 0.062, 0.035).add(U.uSunCol.value.clone().multiplyScalar(0.05 * Math.max(Math.sin(el), 0.1)));
  U.uAmbSun.value.copy(U.uSunCol.value).multiplyScalar(0.10 * (1 - day * 0.7));
  U.uFog.value.set(0.0030 + 0.0042 * (1 - day), 0.10);
}

/* ============================================================================================
 * GPU bake: tileable ecology map (tall stands / clover / thatch / lushness) + wind & cloud noise
 * ========================================================================================== */
function bake() {
  const mat = new THREE.ShaderMaterial({ vertexShader: BAKE_VS, fragmentShader: BAKE_FS, uniforms: { uMode: { value: 0 } }, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const s = new THREE.Scene(); s.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mk = (size, mips) => new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    magFilter: THREE.LinearFilter, minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    generateMipmaps: mips,
  });
  const fieldRT = mk(1024, true), noiseRT = mk(512, false);
  const prev = renderer.getRenderTarget();
  mat.uniforms.uMode.value = 0; renderer.setRenderTarget(fieldRT); renderer.render(s, cam);
  mat.uniforms.uMode.value = 1; renderer.setRenderTarget(noiseRT); renderer.render(s, cam);
  renderer.setRenderTarget(prev);
  fieldRT.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  U.uField.value = fieldRT.texture;
  U.uNoise.value = noiseRT.texture;
  window.__fieldRT = fieldRT;
  mat.dispose(); quad.geometry.dispose();
}
bake();
updateAtmosphere(P.sunEl, P.sunAz);

/* ============================================================================================
 * Materials
 * ========================================================================================== */
const MSAA = true;      // WebGL2 only: coverage-preserving alpha rides the MSAA resolve

function foliageMaterial(vs, fs, defines, own) {
  return new THREE.ShaderMaterial({
    vertexShader: COMMON + vs,
    fragmentShader: COMMON + LEAF_LIGHTING + CANOPY + fs,
    defines,
    uniforms: { ...U, ...own },
    side: THREE.DoubleSide,
    alphaToCoverage: MSAA,            // coverage-preserving alpha rides MSAA (no blending, no sorting)
  });
}

/* ---------- ring configuration: blade LOD, density, tussock multiplier -------------------------- */
// bpc = blades per cell at "high"; gridN is chosen so the grid covers outer + band + blade reach.
const gridFor = (outer, band, cell, extra) => { const n = Math.ceil(2 * (outer + band + extra) / cell); return n + (n & 1); };
const BLADE_RINGS = [
  { inner: 0,  outer: 6,  band: 1.3, cell: 0.5, m: 1,  bpc: 300, geo: { segs: 8, cols: 3 }, salt: 11 },
  { inner: 6,  outer: 22, band: 3.5, cell: 1.5, m: 3,  bpc: 340, geo: { segs: 4, cols: 3 }, salt: 23 },
  { inner: 22, outer: 78, band: 11,  cell: 5.0, m: 10, bpc: 520, geo: { segs: 2, cols: 2 }, salt: 37 },
];
const STALK_RINGS = [
  { inner: 0,  outer: 13, band: 2.5, cell: 1.0, bpc: 9,  salt: 51 },
  { inner: 13, outer: 42, band: 7,   cell: 2.0, bpc: 12, salt: 67 },
];
const CLOVER = { outer: 8, band: 1.5, cell: 0.3, bpc: 22, salt: 83 };

const rings = [];     // { geo, gridN, cell, baseBpc, uRingB, kind }
const meadow = new THREE.Group(); scene.add(meadow);

function addRing(kind, cfg, geo, mat, uRingB) {
  const gridN = gridFor(cfg.outer, cfg.band, cfg.cell, kind === 'clover' ? 0.5 : kind === 'stalk' ? 1.2 : 1.0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  meadow.add(mesh);
  rings.push({ geo, gridN, cell: cfg.cell, baseBpc: cfg.bpc, uRingB, kind, mesh });
}

for (const r of BLADE_RINGS) {
  const uRingB = { value: new THREE.Vector4(1, 1, r.m, 1) };
  const mat = foliageMaterial(GRASS_VS, GRASS_FS, {}, {
    uRing: { value: new THREE.Vector4(r.inner, r.outer, r.band, r.cell) }, uRingB, uSalt: { value: r.salt },
  });
  addRing('blade', r, buildBladeGeometry(r.geo), mat, uRingB);
}
for (const r of STALK_RINGS) {
  const uRingB = { value: new THREE.Vector4(1, 1, 1, 1) };
  const mat = foliageMaterial(GRASS_VS, GRASS_FS, { STALK: '' }, {
    uRing: { value: new THREE.Vector4(r.inner, r.outer, r.band, r.cell) }, uRingB, uSalt: { value: r.salt },
  });
  addRing('stalk', r, buildStalkGeometry({ stemRows: 9, florets: 11, awns: true }), mat, uRingB);
}
{
  const uRingB = { value: new THREE.Vector4(1, 1, 1, 1) };
  const mat = foliageMaterial(CLOVER_VS, CLOVER_FS, {}, {
    uRing: { value: new THREE.Vector4(0, CLOVER.outer, CLOVER.band, CLOVER.cell) }, uRingB, uSalt: { value: CLOVER.salt },
  });
  addRing('clover', CLOVER, buildCloverGeometry(), mat, uRingB);
}

function applyQuality(name) {
  const k = TIERS[name] ?? 1;
  P.quality = name;
  const refDensity = (BLADE_RINGS[0].bpc * k) / (BLADE_RINGS[0].cell ** 2);
  let tris = 0;
  for (const r of rings) {
    const bpc = Math.max(1, Math.round(r.baseBpc * k));
    const dens = bpc / (r.cell ** 2);
    r.uRingB.value.x = bpc;
    r.uRingB.value.y = r.gridN;
    // low-density rings keep coverage by widening blades (sub-linear so near rings don't look bloated)
    if (r.kind === 'blade') r.uRingB.value.w = Math.max(1, refDensity / dens);   // area ratio; the shader applies a distance-dependent exponent
    r.geo.instanceCount = r.gridN * r.gridN * bpc;
    tris += r.geo.instanceCount * (r.geo.index.count / 3);
  }
  document.getElementById('qsel') && (document.getElementById('qsel').value = name);
  return tris;
}
applyQuality(P.quality);

/* ---------- ground ------------------------------------------------------------------------------- */
const groundMat = new THREE.ShaderMaterial({
  vertexShader: COMMON + GROUND_VS,
  fragmentShader: COMMON + CANOPY + GROUND_FS,
  uniforms: { ...U, uCenter: { value: new THREE.Vector2() } },
});
const ground = new THREE.Mesh(buildGroundGeometry(), groundMat);
ground.frustumCulled = false;
scene.add(ground);

/* ---------- sky dome ----------------------------------------------------------------------------- */
const skyMat = new THREE.ShaderMaterial({
  vertexShader: COMMON + SKY_VS, fragmentShader: COMMON + SKY_FS, uniforms: { ...U },
  side: THREE.BackSide, depthWrite: false, depthTest: false,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), skyMat);
sky.frustumCulled = false; sky.renderOrder = -10;
scene.add(sky);

/* ============================================================================================
 * Camera controls
 * ========================================================================================== */
const cam = { x: 0, z: 0, eye: 0.55, yaw: 0, pitch: 0.05, auto: false };
if (qs.has('cam')) {
  const [x, z, eye, yaw, pitch] = qs.get('cam').split(',').map(Number);
  Object.assign(cam, { x, z, eye, yaw: THREE.MathUtils.degToRad(yaw), pitch: THREE.MathUtils.degToRad(pitch) });
}
const keys = new Set();
addEventListener('keydown', e => {
  keys.add(e.code);
  if (e.code === 'Space') { cam.auto = !cam.auto; e.preventDefault(); }
  if (e.code === 'KeyH') document.getElementById('ui')?.classList.toggle('hidden');
});
addEventListener('keyup', e => keys.delete(e.code));
let dragging = false, lx = 0, ly = 0;
canvas.addEventListener('pointerdown', e => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointermove', e => {
  if (!dragging) return;
  cam.yaw -= (e.clientX - lx) * 0.0032; cam.pitch -= (e.clientY - ly) * 0.0032;
  cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch)); lx = e.clientX; ly = e.clientY;
});
canvas.addEventListener('wheel', e => { cam.eye = Math.min(4, Math.max(0.06, cam.eye * Math.exp(e.deltaY * 0.001))); e.preventDefault(); }, { passive: false });

function updateCamera(dt) {
  const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1;
  const speed = 1.6 * fast;
  let f = 0, s = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) s += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) s -= 1;
  if (keys.has('KeyE')) cam.eye = Math.min(4, cam.eye + dt * 0.8);
  if (keys.has('KeyQ')) cam.eye = Math.max(0.06, cam.eye - dt * 0.8);
  if (cam.auto) { f = 0.5; cam.yaw += Math.sin(U.uTime.value * 0.11) * 0.02 * dt; }
  const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
  cam.x += (-sy * f + cy * s) * speed * dt;
  cam.z += (-cy * f - sy * s) * speed * dt;
  const g = terrainHeight(cam.x, cam.z);
  camera.position.set(cam.x, g + cam.eye, cam.z);
  camera.rotation.set(cam.pitch, cam.yaw, 0);
}

/* ============================================================================================
 * UI
 * ========================================================================================== */
const $ = id => document.getElementById(id);
function bindUI() {
  const ui = $('ui'); if (!ui) return;
  if (qs.get('ui') === '0') ui.classList.add('hidden');
  const hook = (id, fn, fmt = v => v) => {
    const el = $(id); if (!el) return;
    const out = $(id + 'v');
    const apply = () => { const v = parseFloat(el.value); fn(v); if (out) out.textContent = fmt(v); };
    el.addEventListener('input', apply); el.value = el.value; apply();
  };
  $('sunel').value = P.sunEl; $('wind').value = P.wind; $('dew').value = P.dew; $('exp').value = P.exposure;
  hook('sunel', v => { P.sunEl = v; updateAtmosphere(P.sunEl, P.sunAz); }, v => v.toFixed(0) + '°');
  hook('wind', v => { U.uWindAmt.value = v; }, v => v.toFixed(2));
  hook('dew', v => { U.uDew.value = v; }, v => v.toFixed(2));
  hook('exp', v => { renderer.toneMappingExposure = v; }, v => v.toFixed(2));
  $('qsel').value = P.quality;
  $('qsel').addEventListener('change', e => { autoQ = false; applyQuality(e.target.value); });
}
bindUI();

/* ============================================================================================
 * Loop
 * ========================================================================================== */
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const sz = renderer.getDrawingBufferSize(new THREE.Vector2());
  U.uRes.value.copy(sz);
}
addEventListener('resize', resize); resize();

let autoQ = !qs.has('q');
let last = performance.now(), tAcc = 0, frames = 0, fpsT = 0, slow = 0;
const hud = $('hud');
const order = ['low', 'med', 'high', 'ultra'];

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  tAcc += dt;
  U.uTime.value = P.still ?? tAcc;
  updateCamera(dt);
  ground.material.uniforms.uCenter.value.set(camera.position.x, camera.position.z);
  sky.position.copy(camera.position);
  renderer.render(scene, camera);

  frames++; fpsT += dt;
  if (fpsT > 0.5) {
    const fps = frames / fpsT;
    if (hud) hud.textContent = `${fps.toFixed(0)} fps · ${(renderer.info.render.triangles / 1e6).toFixed(2)} M tris · ${P.quality}`;
    // simple adaptive quality: step down once if the GPU can't hold ~24 fps
    if (autoQ && tAcc > 3) {
      slow = fps < 24 ? slow + 1 : 0;
      if (slow >= 4 && order.indexOf(P.quality) > 0) { applyQuality(order[order.indexOf(P.quality) - 1]); slow = 0; }
    }
    frames = 0; fpsT = 0;
  }
  window.__frames = (window.__frames || 0) + 1;
  requestAnimationFrame(frame);
}
const paused = qs.has('pause');           // test hook: no rAF loop, render on demand via window.__render()
if (!paused) requestAnimationFrame(frame);
window.__render = (t = 3) => {
  U.uTime.value = t; updateCamera(0);
  ground.material.uniforms.uCenter.value.set(camera.position.x, camera.position.z);
  sky.position.copy(camera.position);
  renderer.render(scene, camera);
  return canvas.toDataURL('image/png');
};
window.__meadow = { P, U, cam, applyQuality, renderer, rings, ground, sky, camera };
