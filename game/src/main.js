import * as THREE from 'three';
import {
  COMMON, LEAF_LIGHTING, CANOPY, GRASS_VS, GRASS_FS, CLOVER_VS, CLOVER_FS, GROUND_VS, GROUND_FS, SKY_VS, SKY_FS,
  BAKE_VS, BAKE_FS, STAMP_VS, STAMP_FS, WATER_VS, WATER_FS, PARTICLE_VS, PARTICLE_FS,
} from './glsl.js';
import { buildBladeGeometry, buildStalkGeometry, buildCloverGeometry, buildGroundGeometry } from './geometry.js';
import { terrainH, terrainGrad, clamp, lerp, mulberry32, hashStr, rid, store, safe, angDiff } from './util.js';
import { YARD_HALF, GRID, CELL, buildYard, bakeYardMap, Coverage, makeCutLayer, buildYardMeshes } from './world.js';
import { COLORS, createMower, MowerSim, makeCan, makeCigar } from './mower.js';
import { Particles } from './particles.js';
import { GameAudio } from './audio.js';
import { Session, LocalTransport, RoomTransport, P2PHost, P2PGuest } from './net.js';

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const TIERS = { low: 0.3, med: 0.55, high: 1.0, ultra: 1.5 };
const TIMES = { golden: { el: 12, az: 22, exp: 0.95, name: 'Golden hour' }, midday: { el: 52, az: 160, exp: 0.78, name: 'Midday' }, dusk: { el: 4.5, az: 300, exp: 1.2, name: 'Dusk' } };
const BAG_CAP = 100, BAG_PER_CELL = 0.0125;

/* ================================================================================================
 * Renderer, scene, shared uniforms
 * ============================================================================================== */
const canvas = $('c');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  $('menu').hidden = false; $('menu').innerHTML = '<div class="card"><h1 class="title">Blade <span>&amp;</span> Brew</h1><p class="bad">WebGL 2 is not available in this browser, so the lawn cannot grow. Try a recent Chrome, Edge or Firefox with hardware acceleration on.</p></div>';
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 6000); camera.rotation.order = 'YXZ'; scene.add(camera);

const U = {
  uTime: { value: 0 }, uSunDir: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Vector3() }, uZenith: { value: new THREE.Vector3() },
  uHorizon: { value: new THREE.Vector3() }, uSunHalo: { value: new THREE.Vector3() }, uAmbUp: { value: new THREE.Vector3() }, uAmbHor: { value: new THREE.Vector3() },
  uAmbDown: { value: new THREE.Vector3() }, uAmbSun: { value: new THREE.Vector3() }, uWindDir: { value: new THREE.Vector2(0.72, -0.69) }, uWindAmt: { value: 0.8 },
  uDew: { value: 0.35 }, uRes: { value: new THREE.Vector2(1, 1) }, uFog: { value: new THREE.Vector2(0.004, 0.1) }, uFieldScale: { value: 1 / 512 },
  uField: { value: null }, uNoise: { value: null }, uCut: { value: null }, uYard: { value: null }, uYardRect: { value: new THREE.Vector4(0, 0, YARD_HALF, 0) },
  uBlob: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 1, 0)) },
};

function updateAtmosphere(elDeg, azDeg) {
  const el = THREE.MathUtils.degToRad(elDeg), az = THREE.MathUtils.degToRad(azDeg);
  U.uSunDir.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
  const air = 1 / (Math.sin(el) + 0.50572 * Math.pow(Math.max(elDeg, -1) + 6.07995, -1.6364));
  const tau = [0.154, 0.208, 0.36], T = tau.map(t => Math.exp(-t * air));
  const day = THREE.MathUtils.smoothstep(elDeg, 2, 40), sunI = 3.4;
  U.uSunCol.value.set(T[0] * sunI, T[1] * sunI, T[2] * sunI);
  const zen = new THREE.Vector3(0.10, 0.24, 0.62).multiplyScalar(0.22 + 0.78 * day);
  const hor = new THREE.Vector3(1.0, 0.52, 0.22).multiplyScalar(0.95).lerp(new THREE.Vector3(0.62, 0.74, 0.92), day).multiplyScalar(0.45 + 0.55 * day + 0.25 * (1 - day));
  U.uZenith.value.copy(zen); U.uHorizon.value.copy(hor);
  U.uSunHalo.value.set(T[0], T[1] * 0.85, T[2] * 0.6).multiplyScalar(0.55);
  U.uAmbUp.value.copy(zen).multiplyScalar(0.85).add(hor.clone().multiplyScalar(0.12));
  U.uAmbHor.value.copy(hor).multiplyScalar(0.40);
  U.uAmbDown.value.set(0.07, 0.062, 0.035).add(U.uSunCol.value.clone().multiplyScalar(0.05 * Math.max(Math.sin(el), 0.1)));
  U.uAmbSun.value.copy(U.uSunCol.value).multiplyScalar(0.10 * (1 - day * 0.7));
  U.uFog.value.set(0.0030 + 0.0042 * (1 - day), 0.10);
}

/* GPU bake of the meadow-ecology map + noise (same as the grass demo) */
function bake() {
  const mat = new THREE.ShaderMaterial({ vertexShader: BAKE_VS, fragmentShader: BAKE_FS, uniforms: { uMode: { value: 0 } }, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); quad.frustumCulled = false;
  const s = new THREE.Scene(); s.add(quad); const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mk = (size, mips) => new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    magFilter: THREE.LinearFilter, minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, generateMipmaps: mips,
  });
  const fieldRT = mk(1024, true), noiseRT = mk(512, false), prev = renderer.getRenderTarget();
  mat.uniforms.uMode.value = 0; renderer.setRenderTarget(fieldRT); renderer.render(s, cam);
  mat.uniforms.uMode.value = 1; renderer.setRenderTarget(noiseRT); renderer.render(s, cam);
  renderer.setRenderTarget(prev);
  fieldRT.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  U.uField.value = fieldRT.texture; U.uNoise.value = noiseRT.texture;
  mat.dispose(); quad.geometry.dispose();
}
bake();

/* Cut mask (render target) -- created once, cleared per yard */
const cutLayer = makeCutLayer(renderer, STAMP_VS, STAMP_FS, 256, qs.get('mask') ? +qs.get('mask') : 2048);
cutLayer.clear(); U.uCut.value = cutLayer.texture;
U.uYard.value = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat); U.uYard.value.needsUpdate = true;

/* Lighting for props: sun with shadows + IBL from the same analytic sky */
const sun = new THREE.DirectionalLight(0xffffff, Math.PI);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -46, right: 46, top: 46, bottom: -46, near: 1, far: 220 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.06;
scene.add(sun, sun.target);
let envRT = null;
function buildEnv() {
  const pm = new THREE.PMREMGenerator(renderer), s = new THREE.Scene();
  const m = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), new THREE.ShaderMaterial({
    vertexShader: COMMON + SKY_VS, fragmentShader: COMMON + SKY_FS, defines: { NO_SUN: '' }, uniforms: { ...U }, side: THREE.BackSide, depthWrite: false, depthTest: false,
  }));
  s.add(m);
  const rt = pm.fromScene(s, 0, 0.1, 100);
  if (envRT) envRT.dispose();
  envRT = rt; scene.environment = rt.texture; scene.environmentIntensity = 1.0;
  pm.dispose(); m.geometry.dispose(); m.material.dispose();
}
function applySun() {
  const c = U.uSunCol.value, mx = Math.max(c.x, c.y, c.z);
  sun.color.setRGB(c.x / mx, c.y / mx, c.z / mx); sun.intensity = Math.PI * mx;
  sun.position.copy(U.uSunDir.value).multiplyScalar(90); sun.target.position.set(0, 0, 0);
}

/* ---------------------------------------------------------------- grass rings (see the grass demo for the derivation) */
const MSAA = true;
function foliageMaterial(vs, fs, defines, own) {
  return new THREE.ShaderMaterial({ vertexShader: COMMON + vs, fragmentShader: COMMON + LEAF_LIGHTING + CANOPY + fs, defines, uniforms: { ...U, ...own }, side: THREE.DoubleSide, alphaToCoverage: MSAA });
}
const gridFor = (outer, band, cell, extra) => { const n = Math.ceil(2 * (outer + band + extra) / cell); return n + (n & 1); };
const BLADE_RINGS = [
  { inner: 0, outer: 6, band: 1.3, cell: 0.5, m: 1, bpc: 300, geo: { segs: 8, cols: 3 }, salt: 11 },
  { inner: 6, outer: 22, band: 3.5, cell: 1.5, m: 3, bpc: 340, geo: { segs: 4, cols: 3 }, salt: 23 },
  { inner: 22, outer: 78, band: 11, cell: 5.0, m: 10, bpc: 520, geo: { segs: 2, cols: 2 }, salt: 37 },
];
const STALK_RINGS = [{ inner: 0, outer: 13, band: 2.5, cell: 1.0, bpc: 9, salt: 51 }, { inner: 13, outer: 42, band: 7, cell: 2.0, bpc: 12, salt: 67 }];
const CLOVER = { outer: 8, band: 1.5, cell: 0.3, bpc: 22, salt: 83 };
const rings = [];
const meadow = new THREE.Group(); scene.add(meadow);
function addRing(kind, cfg, geo, mat, uRingB) {
  const gridN = gridFor(cfg.outer, cfg.band, cfg.cell, kind === 'clover' ? 0.5 : kind === 'stalk' ? 1.2 : 1.0);
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; meadow.add(mesh);
  rings.push({ geo, gridN, cell: cfg.cell, baseBpc: cfg.bpc, uRingB, kind, mesh });
}
for (const r of BLADE_RINGS) {
  const uRingB = { value: new THREE.Vector4(1, 1, r.m, 1) };
  addRing('blade', r, buildBladeGeometry(r.geo), foliageMaterial(GRASS_VS, GRASS_FS, {}, { uRing: { value: new THREE.Vector4(r.inner, r.outer, r.band, r.cell) }, uRingB, uSalt: { value: r.salt } }), uRingB);
}
for (const r of STALK_RINGS) {
  const uRingB = { value: new THREE.Vector4(1, 1, 1, 1) };
  addRing('stalk', r, buildStalkGeometry({ stemRows: 9, florets: 11, awns: true }), foliageMaterial(GRASS_VS, GRASS_FS, { STALK: '' }, { uRing: { value: new THREE.Vector4(r.inner, r.outer, r.band, r.cell) }, uRingB, uSalt: { value: r.salt } }), uRingB);
}
{
  const uRingB = { value: new THREE.Vector4(1, 1, 1, 1) };
  addRing('clover', CLOVER, buildCloverGeometry(), foliageMaterial(CLOVER_VS, CLOVER_FS, {}, { uRing: { value: new THREE.Vector4(0, CLOVER.outer, CLOVER.band, CLOVER.cell) }, uRingB, uSalt: { value: CLOVER.salt } }), uRingB);
}
let quality = TIERS[qs.get('q')] ? qs.get('q') : store.get('quality', 'high');
function applyQuality(name) {
  const k = TIERS[name] ?? 1; quality = name;
  const refDensity = (BLADE_RINGS[0].bpc * k) / (BLADE_RINGS[0].cell ** 2);
  for (const r of rings) {
    const bpc = Math.max(1, Math.round(r.baseBpc * k)), dens = bpc / (r.cell ** 2);
    r.uRingB.value.x = bpc; r.uRingB.value.y = r.gridN;
    if (r.kind === 'blade') r.uRingB.value.w = Math.max(1, refDensity / dens);
    r.geo.instanceCount = r.gridN * r.gridN * bpc;
  }
}
applyQuality(quality);

const ground = new THREE.Mesh(buildGroundGeometry(), new THREE.ShaderMaterial({ vertexShader: COMMON + GROUND_VS, fragmentShader: COMMON + CANOPY + GROUND_FS, uniforms: { ...U, uCenter: { value: new THREE.Vector2() } } }));
ground.frustumCulled = false; scene.add(ground);
const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({ vertexShader: COMMON + SKY_VS, fragmentShader: COMMON + SKY_FS, uniforms: { ...U }, side: THREE.BackSide, depthWrite: false, depthTest: false }));
sky.frustumCulled = false; sky.renderOrder = -10; scene.add(sky);
const parts = new Particles(2600, PARTICLE_VS, PARTICLE_FS); scene.add(parts.mesh);

/* ================================================================================================
 * Game state
 * ============================================================================================== */
const audio = new GameAudio();
const me = { id: rid(8), name: store.get('name', 'Player' + (Math.random() * 90 + 10 | 0)), color: store.get('color', 0) };
const G = {
  scene: 'menu', kind: 'relax', running: false, countdown: 0, timeLeft: 0, dur: 0, elapsed: 0, seed: 1, time: store.get('time', 'golden'),
  yard: null, cov: null, meshes: null, sim: null, model: null, points: 0, cells: 0, sips: 0, gnomes: 0, bagMode: false, camMode: 0, paused: false,
  beer: { level: 1, stock: 6, buzz: 0, sipT: -1, puffT: -1, ember: 0.35, cigarLen: 1 }, gnomeDown: [], gnomeAnim: [], remote: new Map(), mp: null,
  goggles: store.get('goggles', true), volume: store.get('volume', 0.8), over: false, lastStation: '', stationCool: 0, shownHint: 0, sent: 0,
};
let envDirty = true;

function setTime(key, reload = true) {
  const t = TIMES[key] || TIMES.golden; G.time = key; store.set('time', key);
  updateAtmosphere(t.el, t.az); renderer.toneMappingExposure = t.exp; applySun(); envDirty = true;
  if (reload && G.yard) newYard(G.seed);
}

function disposeObj(o) { o.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) { (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => { m.map && m.map.dispose(); m.dispose(); }); } }); }
function newYard(seed) {
  G.seed = seed >>> 0;
  if (G.meshes) { scene.remove(G.meshes.root); disposeObj(G.meshes.root); }
  if (U.uYard.value && U.uYard.value.isDataTexture) U.uYard.value.dispose();
  G.yard = buildYard(G.seed, U.uSunDir.value.clone());
  U.uYard.value = bakeYardMap(G.yard);
  G.cov = new Coverage(G.yard); cutLayer.clear();
  G.meshes = buildYardMeshes(G.yard);
  G.meshes.pondMesh.material = new THREE.ShaderMaterial({ vertexShader: COMMON + WATER_VS, fragmentShader: COMMON + WATER_FS, uniforms: { ...U, uPondC: { value: new THREE.Vector3(G.yard.pond.x, G.yard.pond.z, G.yard.pond.r) } } });
  scene.add(G.meshes.root);
  G.gnomeDown = G.yard.gnomes.map(() => false); G.gnomeAnim = G.yard.gnomes.map(() => null);
  buildMiniBase();
}

function spawnIndex() {
  const ids = [me.id, ...(G.mp ? [...G.mp.session.players.keys()] : [])].sort();
  return ids.indexOf(me.id);
}
function resetPlayer(full = true) {
  const sp = G.yard.spawns[spawnIndex() % G.yard.spawns.length];
  if (!G.sim) G.sim = new MowerSim(sp); else G.sim.reset(sp);
  if (full) { G.points = 0; G.cells = 0; G.sips = 0; G.gnomes = 0; G.elapsed = 0; G.over = false; G.beer.stock = 6; G.beer.level = 1; G.beer.buzz = 0; G.beer.cigarLen = 1; G.sim.bag = 0; }
}
function makeLocalModel() {
  if (G.model) { scene.remove(G.model.root); disposeObj(G.model.root); }
  G.model = createMower(COLORS[me.color % COLORS.length].hex);
  scene.add(G.model.root);
}

/* ================================================================================================
 * FP props (camera children): can in hand, cigar
 * ============================================================================================== */
const fp = new THREE.Group(); camera.add(fp); fp.visible = false;
const fpCan = makeCan(), fpCigar = makeCigar(), fpHandR = new THREE.Group(), fpHandL = new THREE.Group();
{
  const skin = new THREE.MeshStandardMaterial({ color: 0xdfae88, roughness: 0.7 });
  const rnd = (g, x, y, z, sx = 1, sy = 1, sz = 1) => { const o = new THREE.Mesh(g, skin); o.position.set(x, y, z); o.scale.set(sx, sy, sz); return o; };
  fpHandR.add(rnd(new THREE.SphereGeometry(0.03, 14, 10), 0, -0.012, 0.04, 1.05, 0.9, 1.15));              // palm gripping from behind the can
  for (let i = 0; i < 4; i++) fpHandR.add(rnd(new THREE.CapsuleGeometry(0.0075, 0.03, 4, 8), 0.027, -0.018 + i * 0.0155, -0.012, 1, 1, 1)).rotation.x = Math.PI / 2;   // fingers wrapping the can
  fpHandR.add(rnd(new THREE.CapsuleGeometry(0.009, 0.03, 4, 8), -0.026, 0.02, 0.02)).rotation.set(0.5, 0, 0.4);  // thumb
  const forearm = rnd(new THREE.CapsuleGeometry(0.029, 0.3, 6, 12), 0.03, -0.07, 0.24); forearm.rotation.x = Math.PI / 2 + 0.25; fpHandR.add(forearm);
  fpHandL.add(rnd(new THREE.SphereGeometry(0.026, 14, 10), 0, 0, 0.03, 1, 0.9, 1.1));
  for (let i = 0; i < 2; i++) fpHandL.add(rnd(new THREE.CapsuleGeometry(0.0075, 0.03, 4, 8), 0.02, -0.01 + i * 0.016, -0.02)).rotation.x = Math.PI / 2;
  const forearmL = rnd(new THREE.CapsuleGeometry(0.028, 0.3, 6, 12), -0.02, -0.07, 0.24); forearmL.rotation.x = Math.PI / 2 + 0.25; fpHandL.add(forearmL);
  fpCan.position.set(0, 0.045, -0.01); fpHandR.add(fpCan);
  fpCigar.scale.setScalar(0.95); fpCigar.rotation.set(0, 0.0, 0.5); fpCigar.position.set(0.02, 0.025, -0.01); fpHandL.add(fpCigar);
  fp.add(fpHandR, fpHandL);
  fp.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
}

/* ================================================================================================
 * Input
 * ============================================================================================== */
const keys = new Set(); const pad = { throttle: 0, steer: 0, boost: false };
let mouseYaw = 0, mousePitch = 0, lastLook = 0, dragging = false, lx = 0, ly = 0;
addEventListener('keydown', e => {
  if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && G.scene === 'play') e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (G.scene !== 'play' && e.code !== 'Escape') return;
  audio.start();
  switch (e.code) {
    case 'KeyB': doSip(); break;
    case 'KeyC': doPuff(); break;
    case 'KeyH': doHorn(); break;
    case 'KeyE': if (G.sim) { G.sim.blades = !G.sim.blades; toast(G.sim.blades ? 'Blades ON' : 'Blades OFF', 900); } break;
    case 'KeyG': G.bagMode = !G.bagMode; toast(G.bagMode ? 'Bagging ON  (+25% points)' : 'Mulching', 1200); break;
    case 'KeyV': G.camMode = (G.camMode + 1) % 3; toast(['Chase cam', 'Seat view', 'Drone view'][G.camMode], 900); break;
    case 'KeyR': recover(); break;
    case 'KeyM': G.volume = G.volume > 0 ? 0 : 0.8; audio.setVolume(G.volume); toast(G.volume ? 'Sound on' : 'Muted', 800); break;
    case 'Escape': togglePause(); break;
  }
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
canvas.addEventListener('pointerdown', e => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.focus(); audio.start(); if (G.scene === 'play' && !G.paused && e.pointerType === 'mouse') safe(() => canvas.requestPointerLock && canvas.requestPointerLock()); });
addEventListener('pointerup', () => { dragging = false; });
addEventListener('pointermove', e => {
  const locked = document.pointerLockElement === canvas;
  if (!dragging && !locked) return;
  const dx = locked ? e.movementX : e.clientX - lx, dy = locked ? e.movementY : e.clientY - ly; lx = e.clientX; ly = e.clientY;
  mouseYaw = clamp(mouseYaw - dx * 0.004, -2.6, 2.6); mousePitch = clamp(mousePitch - dy * 0.004, -0.9, 0.9); lastLook = performance.now();
});
function readInput() {
  let throttle = 0, steer = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) throttle += 1; if (keys.has('KeyS') || keys.has('ArrowDown')) throttle -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) steer += 1; if (keys.has('KeyA') || keys.has('ArrowLeft')) steer -= 1;
  const gp = safe(() => navigator.getGamepads && [...navigator.getGamepads()].find(g => g && g.connected));
  let boost = keys.has('ShiftLeft') || keys.has('ShiftRight'), brake = keys.has('Space');
  if (gp) {
    const dz = v => (Math.abs(v) < 0.12 ? 0 : v);
    steer += dz(gp.axes[0] || 0); throttle += (gp.buttons[7]?.value || 0) - (gp.buttons[6]?.value || 0) - dz(gp.axes[1] || 0) * (Math.abs(throttle) < 0.01 ? 1 : 0);
    boost = boost || !!gp.buttons[0]?.pressed; brake = brake || !!gp.buttons[2]?.pressed;
    const edge = (i, f) => { const p = !!gp.buttons[i]?.pressed; if (p && !pad['b' + i]) f(); pad['b' + i] = p; };
    edge(3, doSip); edge(1, doPuff); edge(4, doHorn); edge(5, () => { G.camMode = (G.camMode + 1) % 3; }); edge(9, togglePause);
  }
  return { throttle: clamp(throttle, -1, 1), steer: clamp(steer, -1, 1), boost, brake };
}

/* ================================================================================================
 * Beer + cigar + horn
 * ============================================================================================== */
function doSip() {
  const b = G.beer; if (b.sipT >= 0 || G.over) return;
  if (b.level <= 0.03) {
    if (b.stock > 0) { b.stock--; b.level = 1; audio.pop(); toast('Cracked a cold one', 1400); }
    else toast('Cooler is empty. Drive to the red picnic table.', 2200, 'warn');
    return;
  }
  b.sipT = 0; audio.sip(); G.sips++;
  setTimeout(() => { b.level = Math.max(0, b.level - 0.2); b.buzz = Math.min(1, b.buzz + 0.07); }, 700);
}
function doPuff() {
  const b = G.beer; if (b.puffT >= 0 || G.over) return;
  if (b.cigarLen <= 0.12) { b.cigarLen = 1; b.ember = 0.6; audio.pop(); toast('Lit a fresh maduro', 1500); return; }
  b.puffT = 0; audio.puff(); b.cigarLen = Math.max(0.1, b.cigarLen - 0.045);
}
function doHorn() { audio.horn(); G.hornAt = performance.now(); if (G.mp) G.mp.session.send({ k: 'hn' }); }
function recover() {
  if (!G.sim || G.scene !== 'play') return;
  const sp = G.yard.spawns[spawnIndex() % G.yard.spawns.length];
  G.sim.x = sp.x; G.sim.z = sp.z; G.sim.h = sp.h; G.sim.v = 0; toast('Back at the gate' + (G.kind === 'match' ? '  (-5 s)' : ''), 1500);
  if (G.kind === 'match' && G.running) G.timeLeft = Math.max(0, G.timeLeft - 5);
}

/* ================================================================================================
 * Toasts / HUD
 * ============================================================================================== */
let toastT = 0;
function toast(msg, ms = 1800, cls = '') {
  const el = $('toast'); el.textContent = msg; el.className = 'hud ' + cls; el.style.opacity = 1; el.style.color = cls === 'warn' ? 'var(--amber2)' : cls === 'bad' ? '#ff7a63' : 'var(--ink)';
  clearTimeout(toastT); toastT = setTimeout(() => { el.style.opacity = 0; }, ms);
}
const fmtTime = s => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

const mini = $('minic').getContext('2d'); let miniBase = null, miniImg = null;
function buildMiniBase() {
  const Y = G.yard, c = document.createElement('canvas'); c.width = c.height = GRID; const x = c.getContext('2d'), im = x.createImageData(GRID, GRID);
  const inR = (r, px, pz) => Math.abs(px - r.x) < r.hw && Math.abs(pz - r.z) < r.hd;
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const px = -YARD_HALF + (i + 0.5) * CELL, pz = -YARD_HALF + (j + 0.5) * CELL, k = (j * GRID + i) * 4;
    let col = [60, 104, 38];
    if (inR(Y.patio, px, pz) || inR(Y.path, px, pz)) col = [150, 146, 136];
    else if (Math.hypot(px - Y.pond.x, pz - Y.pond.z) < Y.pond.r) col = [40, 96, 120];
    else if (!G.cov.mowable[j * GRID + i]) col = [88, 62, 40];
    im.data[k] = col[0]; im.data[k + 1] = col[1]; im.data[k + 2] = col[2]; im.data[k + 3] = 255;
  }
  miniBase = im; miniImg = x.createImageData(GRID, GRID);
}
const PCOL = ['#c62f22', '#2f7d32', '#f2a900', '#1f6fb5', '#7b3f9e', '#b9c3cc'];
function drawMini() {
  if (!miniBase || !G.cov) return;
  const d = miniImg.data, b = miniBase.data, own = G.cov.owner;
  const cols = [[0, 0, 0], ...[...Array(8)].map((_, i) => { const h = PCOL[i % 6]; return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; })];
  for (let k = 0; k < GRID * GRID; k++) {
    const o = own[k], p = k * 4;
    if (o) { const c = cols[Math.min(o, 8)]; d[p] = 150 + c[0] * 0.25; d[p + 1] = 205 + c[1] * 0.1; d[p + 2] = 90 + c[2] * 0.2; d[p + 3] = 255; }
    else { d[p] = b[p]; d[p + 1] = b[p + 1]; d[p + 2] = b[p + 2]; d[p + 3] = 255; }
  }
  const tmp = drawMini.c || (drawMini.c = document.createElement('canvas')); tmp.width = tmp.height = GRID; tmp.getContext('2d').putImageData(miniImg, 0, 0);
  mini.imageSmoothingEnabled = false; mini.drawImage(tmp, 0, 0, 256, 256);
  const dot = (x, z, h, col) => {
    const px = ((x + YARD_HALF) / (2 * YARD_HALF)) * 256, pz = ((z + YARD_HALF) / (2 * YARD_HALF)) * 256;
    mini.save(); mini.translate(px, pz); mini.rotate(-h + Math.PI); mini.fillStyle = col; mini.strokeStyle = '#000'; mini.lineWidth = 2;
    mini.beginPath(); mini.moveTo(0, -9); mini.lineTo(6, 7); mini.lineTo(-6, 7); mini.closePath(); mini.stroke(); mini.fill(); mini.restore();
  };
  for (const [id, r] of G.remote) if (r.last) dot(r.last[0], r.last[1], r.last[2], PCOL[r.player.color % 6]);
  if (G.sim) dot(G.sim.x, G.sim.z, G.sim.h, PCOL[me.color % 6]);
  const st = G.yard.stations;
  mini.fillStyle = '#fff'; mini.font = 'bold 18px sans-serif'; mini.textAlign = 'center';
  mini.fillText('🍺', ((st.cooler.x + YARD_HALF) / 64) * 256, ((st.cooler.z + YARD_HALF) / 64) * 256 + 6);
  mini.fillText('⛽', ((st.pump.x + YARD_HALF) / 64) * 256, ((st.pump.z + YARD_HALF) / 64) * 256 + 6);
  mini.fillText('♻', ((st.compost.x + YARD_HALF) / 64) * 256, ((st.compost.z + YARD_HALF) / 64) * 256 + 6);
}

function updateHUD() {
  const s = G.sim; if (!s) return;
  $('spd').textContent = Math.round(Math.abs(s.v) * 3.6);
  $('fuelbar').style.width = (s.fuel * 100).toFixed(0) + '%'; $('fuelbar').style.background = s.fuel < 0.15 ? 'var(--red)' : 'var(--amber)'; $('fuelv').textContent = Math.round(s.fuel * 100);
  $('bagbar').style.width = clamp(s.bag / BAG_CAP, 0, 1) * 100 + '%'; $('bagv').textContent = G.bagMode ? Math.round(s.bag / BAG_CAP * 100) + '%' : '—';
  $('bagmode').innerHTML = (s.blades ? 'Blades <b>ON</b>' : 'Blades <b style="color:var(--red)">OFF</b>') + ' &nbsp;·&nbsp; ' + (G.bagMode ? 'Bagging <b>+25%</b>' : 'Mulching');
  $('beerN').textContent = G.beer.stock + (G.beer.level > 0.03 ? ' + 1' : '');
  $('canfill').style.height = (100 - G.beer.level * 100) + '%';
  $('cigar').style.width = (14 + 42 * G.beer.cigarLen) + 'px'; $('ember').style.opacity = 0.3 + G.beer.ember * 0.7;
  const pct = G.cov.fraction * 100;
  $('pctfill').style.width = pct.toFixed(1) + '%'; $('pcttxt').textContent = pct.toFixed(1) + '% mowed · ' + Math.round(G.points) + ' pts';
  $('timer').textContent = G.kind === 'relax' ? fmtTime(G.elapsed) : fmtTime(G.timeLeft);
  $('timer').style.color = G.kind !== 'relax' && G.timeLeft < 15 && G.running ? 'var(--red)' : '';
  $('warm').style.opacity = G.goggles ? clamp(G.beer.buzz * 0.9, 0, 0.8) : 0;
  if (G.mp) {
    const rows = [{ name: me.name + ' (you)', color: me.color, sc: Math.round(G.points) }, ...[...G.mp.session.players.values()].map(p => ({ name: p.name, color: p.color, sc: p.score }))].sort((a, b) => b.sc - a.sc);
    const b = $('board'); b.hidden = false;
    b.innerHTML = rows.map(r => `<div><i style="background:${PCOL[r.color % 6]}"></i>${esc(r.name)}<b>${r.sc}</b></div>`).join('');
    $('roomtag').hidden = false; $('roomtag').textContent = G.mp.label;
  } else { $('board').hidden = true; $('roomtag').hidden = true; }
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ================================================================================================
 * Mowing
 * ============================================================================================== */
function mow(x0, z0, x1, z1, h, owner) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.3)), fx = Math.sin(h), fz = Math.cos(h);
  const lane = (Math.abs(fz) >= Math.abs(fx) ? fz : fx) > 0 ? 1.0 : 0.6;
  let gained = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n, cx = lerp(x0, x1, t) + fx * 0.2, cz = lerp(z0, z1, t) + fz * 0.2;
    cutLayer.add(cx, cz, fx, fz, 0.58, 0.5, lane);
    gained += G.cov.stamp(cx, cz, fx, fz, 0.58, 0.5, owner);
  }
  return gained;
}
function spawnClippings(x, z, h, y, count, owner) {
  const fx = Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx;      // right = (-fz, fx)
  for (let i = 0; i < count; i++) {
    const s = 1.8 + Math.random() * 2.4, up = 1.2 + Math.random() * 1.6, jitter = (Math.random() - 0.5) * 0.9;
    const col = Math.random() < 0.7 ? [0.35, 0.62, 0.12, 0.9] : [0.55, 0.62, 0.15, 0.9];
    parts.spawn(x + rx * 0.62 + fx * 0.2, y + 0.25, z + rz * 0.62 + fz * 0.2, rx * s + fx * jitter * 1.4, up, rz * s + fz * jitter * 1.4, 0.7 + Math.random() * 0.5, 0.045, col, 0.2, 9.8, 0.2);
  }
}

function stationUpdate(dt) {
  const s = G.sim, st = G.yard.stations; let near = '';
  for (const [k, v] of Object.entries(st)) if (Math.hypot(s.x - v.x, s.z - v.z) < v.r + 0.6 && Math.abs(s.v) < 2.2) near = k;
  G.stationCool = Math.max(0, G.stationCool - dt);
  if (near !== G.lastStation) {
    if (near === 'cooler') { if (G.beer.stock < 6) { G.beer.stock = 6; audio.clink(); toast('Cooler restocked: 6 cold ones', 1800); } else toast('Cooler is full', 1000); }
    if (near === 'pump') toast('Refueling…', 1000);
    if (near === 'compost') { if (s.bag > 1) { s.bag = 0; audio.dump(); toast('Bag emptied', 1400); } }
    G.lastStation = near;
  }
  if (near === 'pump' && s.fuel < 1) { s.fuel = Math.min(1, s.fuel + 0.3 * dt); if (G.stationCool <= 0) { audio.pump(); G.stationCool = 1; } }
  if (near === 'compost' && s.bag > 1) { s.bag = 0; audio.dump(); }
}

/* ---------------------------------------------------------------- gnomes */
function tipGnome(i, byMe) {
  if (G.gnomeDown[i]) return; G.gnomeDown[i] = true;
  const dir = Math.random() * 6.28; G.gnomeAnim[i] = { t: 0, dir, vy: 2.5 + Math.random() * 2 };
  audio.boop();
  if (byMe) { G.gnomes++; G.points += 15; toast('Gnome boop!  +15', 1200, 'warn'); if (G.mp) G.mp.session.send({ k: 'g', gi: i }); }
  setTimeout(() => { G.gnomeDown[i] = false; const a = G.gnomeAnim[i]; if (a) a.reset = true; }, 9000);
}
function updateGnomes(dt) {
  const gs = G.meshes.gnomes;
  gs.forEach((g, i) => {
    const a = G.gnomeAnim[i], y0 = terrainH(G.yard.gnomes[i].x, G.yard.gnomes[i].z);
    if (!a) return;
    if (a.reset) { g.rotation.x = 0; g.rotation.z = 0; g.position.y = y0; G.gnomeAnim[i] = null; return; }
    a.t += dt; a.vy -= 9.8 * dt;
    const py = Math.max(0, (a.t < 0.6 ? Math.sin(a.t / 0.6 * Math.PI) * 0.6 : 0));
    g.position.y = y0 + py; g.rotation.x = Math.min(1.5, a.t * 4) * Math.cos(a.dir); g.rotation.z = Math.min(1.5, a.t * 4) * Math.sin(a.dir);
  });
}

/* ================================================================================================
 * Remote players
 * ============================================================================================== */
function addRemote(p) {
  const model = createMower(COLORS[p.color % COLORS.length].hex, { tag: p.name }); scene.add(model.root);
  G.remote.set(p.id, { player: p, model, sipT: -1, puffT: -1, fl: 0, prev: null, last: null, dist: 0, tag: p.name });
  toast(p.name + ' pulled in', 1400);
}
function removeRemote(p) {
  const r = G.remote.get(p.id); if (!r) return; scene.remove(r.model.root); disposeObj(r.model.root); G.remote.delete(p.id); audio.dropRemote(p.id); toast(p.name + ' left', 1200);
}
function updateRemotes(dt) {
  const sess = G.mp && G.mp.session; if (!sess) return;
  // two players, same paint: the one with the larger id repaints to the first free colour
  for (const r of G.remote.values()) if ((r.player.color % 6) === (me.color % 6) && me.id > r.player.id) {
    const used = new Set([...G.remote.values()].map(x => x.player.color % 6));
    const free = COLORS.findIndex((c, i) => !used.has(i)); if (free >= 0) { me.color = free; makeLocalModel(); }
    break;
  }
  const fx = 0; let blobN = 1;
  for (const [id, r] of G.remote) {
    const s = sess.sample(r.player); if (!s) continue;
    const [x, z, h, v, st, fl, rpm] = s;
    if (r.player.name !== r.tag) { r.model.setTag(r.player.name); r.tag = r.player.name; }
    const [gx, gz] = terrainGrad(x, z), f = [Math.sin(h), Math.cos(h)];
    r.dist += v * dt; r.last = s;
    if ((fl & 2) && !(r.fl & 2)) r.sipT = 0; if ((fl & 4) && !(r.fl & 4)) r.puffT = 0; r.fl = fl;
    if (r.sipT >= 0) { r.sipT += dt / 1.7; if (r.sipT >= 1) r.sipT = -1; }
    if (r.puffT >= 0) { r.puffT += dt / 1.4; if (r.puffT >= 1) r.puffT = -1; }
    const y = terrainH(x, z);
    r.model.pose({ x, z, h, y, pitch: -Math.atan(gx * f[0] + gz * f[1]), roll: Math.atan(gx * f[1] - gz * f[0]), steer: st, dist: r.dist, sipT: r.sipT < 0 ? 0 : r.sipT, puffT: r.puffT < 0 ? 0 : r.puffT, hideDriver: false, ember: 0.35 });
    if (r.puffT >= 0 && r.puffT < 0.7 && Math.random() < 0.5) parts.spawn(x + f[0] * 0.2, y + 1.38, z + f[1] * 0.2, (Math.random() - 0.5) * 0.15, 0.3, (Math.random() - 0.5) * 0.15, 2.2, 0.35, [0.78, 0.8, 0.88, 0.2], 2.5, -0.1, 0.9);
    // mow trail for remote
    if ((fl & 1) && (G.running || G.kind !== 'match') && r.prev && Math.hypot(x - r.prev[0], z - r.prev[1]) < 6) mow(r.prev[0], r.prev[1], x, z, h, r.player.idx || 1);
    else if ((fl & 1) && G.running !== false && !r.prev) { /* first sample */ }
    r.prev = [x, z];
    const ex = x - camera.position.x, ez = z - camera.position.z, d = Math.hypot(ex, ez);
    audio.remoteVoice(id, { dist: d, pan: Math.sin(Math.atan2(ex, -ez) - camera.rotation.y) , rpm: rpm || 0.3, on: !!(fl & 8) });
    if (blobN < 6) U.uBlob.value[blobN++].set(x, z, 1.9, 0.8);
    r.model.tagSprite && (r.model.tagSprite.visible = d < 45);
  }
  for (let i = blobN; i < 6; i++) U.uBlob.value[i].w = 0;
}

/* ================================================================================================
 * Update
 * ============================================================================================== */
let netAcc = 0, uiAcc = 0, miniAcc = 0, fpsAcc = 0, fpsN = 0, slow = 0, tAbs = 0;
function update(dt) {
  tAbs += dt; U.uTime.value = tAbs;
  const playing = G.scene === 'play', s = G.sim;
  if (!s) return;
  const inp = playing && !G.paused && G.running && !G.over ? readInput() : { throttle: 0, steer: 0, brake: true, boost: false };
  if (playing && !G.paused && G.running && !G.over) { G.elapsed += dt; if (G.kind !== 'relax') { G.timeLeft -= dt; if (G.timeLeft <= 0) endRound(); } }
  if (G.countdown > 0) {
    const n0 = Math.ceil(G.countdown); G.countdown -= dt; const n1 = Math.ceil(G.countdown);
    if (n1 !== n0 && n1 > 0) { audio.countdown(false); } const c = $('count');
    if (G.countdown <= 0) { G.countdown = 0; G.running = true; audio.countdown(true); c.textContent = 'MOW!'; c.style.opacity = 1; setTimeout(() => { c.style.opacity = 0; }, 900); }
    else { c.textContent = Math.ceil(G.countdown); c.style.opacity = 1; }
  }

  // physics
  const ox = s.x, oz = s.z;
  const deck = s.deck(), load = s.blades && G.cov.at(deck.x, deck.z) === 0 ? 0.72 : 1;
  const others = [...G.remote.values()].filter(r => r.last).map(r => ({ x: r.last[0], z: r.last[1] }));
  if (playing || G.scene === 'menu') s.step(inp, dt, { yard: G.yard, others, load, buzz: G.goggles ? G.beer.buzz : 0, gnomeDown: G.gnomeDown, onGnome: i => tipGnome(i, true) });
  if (s.bump > 0.2) { audio.bump(s.bump); s.bump = 0; }

  // mowing + score
  const canCut = s.blades && s.fuel > 0 && playing && G.running && !G.over && !(G.bagMode && s.bag >= BAG_CAP);
  let gained = 0;
  if (canCut) {
    gained = mow(ox, oz, s.x, s.z, s.h, 0);
    if (gained > 0) {
      G.cells += gained; G.points += gained * CELL * CELL * (G.bagMode ? 1.25 : 1);
      if (G.bagMode) { s.bag = Math.min(BAG_CAP, s.bag + gained * BAG_PER_CELL * 100 / 1.5); }
      spawnClippings(s.x, s.z, s.h, s.y, Math.min(5, 1 + gained / 6 | 0), 0);
    }
  }
  if (G.bagMode && s.bag >= BAG_CAP && G.lastBagWarn !== 1) { toast('Bag full. Empty it at the compost bin.', 2400, 'warn'); G.lastBagWarn = 1; }
  if (s.bag < BAG_CAP * 0.9) G.lastBagWarn = 0;
  if (playing && G.running && !G.over && G.kind === 'relax' && G.cov.fraction >= 0.985) endRound();
  stationUpdate(dt);

  // drink + smoke animation
  const b = G.beer;
  if (b.sipT >= 0) { b.sipT += dt / 1.7; if (b.sipT >= 1) b.sipT = -1; }
  if (b.puffT >= 0) { b.puffT += dt / 1.4; if (b.puffT >= 1) b.puffT = -1; }
  b.buzz = Math.max(0, b.buzz - dt * 0.004);
  b.ember = lerp(b.ember, b.puffT >= 0 ? 1 : 0.3, Math.min(1, dt * (b.puffT >= 0 ? 8 : 0.6)));

  // local model pose
  const [gx, gz] = terrainGrad(s.x, s.z);
  const fpv = G.camMode === 1 && playing;
  G.model.pose({ x: s.x, z: s.z, h: s.h, y: s.y, pitch: s.pitch, roll: s.roll, steer: s.steer, dist: s.dist, sipT: b.sipT < 0 ? 0 : b.sipT, puffT: b.puffT < 0 ? 0 : b.puffT, hideDriver: fpv, ember: b.ember });
  G.model.root.updateMatrixWorld(true);
  G.model.cigar.scale.x = 0.5 + 0.4 * b.cigarLen;
  if (b.puffT >= 0 && b.puffT < 0.7 && Math.random() < 0.7) {
    const p = new THREE.Vector3(); G.model.head.getWorldPosition(p);
    parts.spawn(p.x + Math.sin(s.h) * 0.16, p.y - 0.06, p.z + Math.cos(s.h) * 0.16, (Math.random() - 0.5) * 0.2, 0.35, (Math.random() - 0.5) * 0.2, 2.6, 0.3, [0.8, 0.82, 0.9, 0.22], 3, -0.08, 0.9);
  }
  if (b.puffT >= 0.7 && b.puffT < 0.78) { const p = new THREE.Vector3(); G.model.head.getWorldPosition(p); for (let i = 0; i < 3; i++) parts.spawn(p.x + Math.sin(s.h) * 0.2, p.y - 0.05, p.z + Math.cos(s.h) * 0.2, (Math.random() - 0.5) * 0.5 + Math.sin(s.h) * 0.4, 0.5 + Math.random() * 0.3, (Math.random() - 0.5) * 0.5 + Math.cos(s.h) * 0.4, 3.2, 0.55, [0.82, 0.84, 0.92, 0.22], 3.5, -0.1, 0.8); }
  if (s.rpm > 0 && (playing || G.scene === 'menu') && Math.random() < dt * 14) {   // exhaust
    const ex = s.x - Math.sin(s.h) * 0.9 + Math.cos(s.h) * -0.3, ez = s.z - Math.cos(s.h) * 0.9 - Math.sin(s.h) * -0.3;
    parts.spawn(s.x + Math.cos(s.h) * 0.3 + Math.sin(s.h) * 0.3, s.y + 1.25, s.z - Math.sin(s.h) * 0.3 + Math.cos(s.h) * 0.3, 0, 0.5, 0, 0.9, 0.12, [0.5, 0.5, 0.55, 0.18], 3, -0.2, 1.0);
  }
  if (Math.abs(s.v) > 2 && playing && Math.random() < dt * 8 * Math.min(1, Math.abs(s.v) / 6) && !s.blades) parts.spawn(s.x - Math.sin(s.h) * 0.6, s.y + 0.1, s.z - Math.cos(s.h) * 0.6, (Math.random() - 0.5), 0.6, (Math.random() - 0.5), 0.8, 0.2, [0.55, 0.45, 0.3, 0.3], 2, 1, 1);
  updateGnomes(dt);
  updateRemotes(dt);
  parts.update(dt, [U.uWindDir.value.x * 0.6, U.uWindDir.value.y * 0.6]);

  // blobs: local first
  U.uBlob.value[0].set(s.x, s.z, 1.9, 0.8);
  if (!G.mp) for (let i = 1; i < 6; i++) U.uBlob.value[i].w = 0;

  // audio
  audio.engine({ rpm: s.rpm, load: s.blades ? (load < 1 ? 1 : 0.2) : 0, blades: s.blades && canCut || (s.blades && G.scene !== 'menu'), on: G.scene === 'play' && !G.paused || G.scene === 'menu' ? G.scene === 'play' : false, speed: s.v });

  // networking
  if (G.mp) {
    G.mp.session.prune();
    netAcc += dt;
    if (netAcc >= 1 / 15) {
      netAcc = 0;
      const fl = (s.blades && canCut ? 1 : 0) | (b.sipT >= 0 ? 2 : 0) | (b.puffT >= 0 ? 4 : 0) | (G.scene === 'play' ? 8 : 0) | (s.boosting ? 16 : 0);
      G.mp.session.sendState([+s.x.toFixed(2), +s.z.toFixed(2), +s.h.toFixed(3), +s.v.toFixed(2), +s.steer.toFixed(2), fl, +s.rpm.toFixed(2)], Math.round(G.points));
    }
  }
  // HUD
  uiAcc += dt; miniAcc += dt;
  if (uiAcc > 0.1 && playing) { uiAcc = 0; updateHUD(); }
  if (miniAcc > 0.3 && playing) { miniAcc = 0; drawMini(); }
  if (G.shownHint < 16 && playing && G.running) { G.shownHint += dt; $('hint').style.opacity = G.shownHint > 14 ? 0 : 0.85; }
  // buzz presentation (tame by design)
  if (G.goggles && G.beer.buzz > 0.01) canvas.style.transform = `rotate(${(Math.sin(tAbs * 0.9) * G.beer.buzz * 0.9).toFixed(3)}deg) scale(1.02)`; else canvas.style.transform = '';
}

/* ================================================================================================
 * Camera
 * ============================================================================================== */
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(); let camInit = false, menuAng = 0;
function updateCamera(dt) {
  const s = G.sim; if (!s) return;
  const sp = Math.abs(s.v);
  if (performance.now() - lastLook > 1800 && !dragging) { mouseYaw *= Math.exp(-dt * 2.2); mousePitch *= Math.exp(-dt * 2.2); }
  let pos, look, fov = 60 + sp * 0.9;
  if (G.scene === 'menu') {
    menuAng += dt * 0.12;
    const a = menuAng + 2.6; pos = new THREE.Vector3(s.x + Math.sin(a) * 5.2, s.y + 1.7, s.z + Math.cos(a) * 5.2); look = new THREE.Vector3(s.x, s.y + 0.9, s.z); fov = 50;
  } else if (G.camMode === 0) {
    const yaw = s.h + Math.PI + mouseYaw, d = 4.6, up = 2.1 + mousePitch * 3 + sp * 0.05;
    pos = new THREE.Vector3(s.x + Math.sin(yaw) * d, s.y + up, s.z + Math.cos(yaw) * d);
    look = new THREE.Vector3(s.x + s.fx * 1.8, s.y + 0.95, s.z + s.fz * 1.8);
  } else if (G.camMode === 1) {
    const p = new THREE.Vector3(); G.model.head.getWorldPosition(p);
    pos = p.add(new THREE.Vector3(0, 0.02, 0)); const yaw = s.h + mouseYaw;
    look = null; camera.rotation.set(clamp(mousePitch - 0.04 + s.pitch * 0.5, -1.3, 1.3), yaw, s.roll * 0.4);
  } else {
    pos = new THREE.Vector3(s.x - s.fx * 3, s.y + 26, s.z - s.fz * 3 + 6); look = new THREE.Vector3(s.x + s.fx * 3, s.y, s.z + s.fz * 3); fov = 52;
  }
  if (!camInit || G.camMode === 1) { camPos.copy(pos); camInit = true; } else camPos.lerp(pos, 1 - Math.exp(-dt * 7));
  const gh = terrainH(camPos.x, camPos.z) + 0.45; if (camPos.y < gh) camPos.y = gh;
  camera.position.copy(camPos);
  if (look) { camLook.lerp(look, camInit ? 1 - Math.exp(-dt * 9) : 1); camera.lookAt(camLook); }
  const sh = s.shake * 0.05; if (sh > 0) camera.position.add(new THREE.Vector3((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh));
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 4); camera.updateProjectionMatrix(); }

  // first-person props
  fp.visible = G.camMode === 1 && G.scene === 'play';
  if (fp.visible) {
    const b = G.beer, e = b.sipT < 0 ? 0 : (b.sipT < 0.5 ? clamp(b.sipT / 0.5, 0, 1) : 1 - clamp((b.sipT - 0.78) / 0.22, 0, 1)), pe = b.puffT < 0 ? 0 : Math.sin(clamp(b.puffT, 0, 1) * Math.PI);
    const t = tAbs;
    fpHandR.position.set(lerp(0.21, 0.015, e), lerp(-0.2, -0.085, e), lerp(-0.46, -0.28, e));
    fpHandR.rotation.set(lerp(-0.2, 0.2, e), lerp(-0.15, 0, e), 0);
    fpCan.rotation.x = -1.05 * e; fpCan.visible = true;
    fpHandL.position.set(lerp(-0.2, -0.03, pe), lerp(-0.21, -0.09, pe), lerp(-0.46, -0.28, pe));
    fpHandL.rotation.set(lerp(-0.1, 0.25, pe), lerp(0.2, -0.6, pe), 0);
    fpCigar.userData.ember.material.emissiveIntensity = 0.7 + b.ember * 0.8 + pe * 4; fpCigar.scale.x = 0.55 + 0.5 * b.cigarLen;
  }
  sky.position.copy(camera.position);
  ground.material.uniforms.uCenter.value.set(camera.position.x, camera.position.z);
}

/* ================================================================================================
 * Round flow
 * ============================================================================================== */
function startRound(kind, dur, seed, { late = false, rem = 0 } = {}) {
  if (seed !== undefined && (seed >>> 0) !== G.seed || !G.yard) newYard(seed ?? G.seed);
  cutLayer.clear(); G.cov.reset(G.yard); buildMiniBase();
  makeLocalModelIfNeeded();
  G.kind = kind; G.dur = dur; G.timeLeft = dur; G.over = false; G.paused = false;
  resetPlayer(true);
  G.scene = 'play'; G.shownHint = 0; $('hint').textContent = 'W/S drive · A/D steer · Shift boost · Space brake · E blades · G bag · B beer · C cigar · H horn · V camera · Esc menu'; $('hint').style.opacity = 0.85;
  $('menu').hidden = true; $('hud').hidden = false; $('top').hidden = false;
  if (late) { G.running = true; G.countdown = 0; G.timeLeft = rem; }
  else if (kind === 'relax') { G.running = true; G.countdown = 0; }
  else { G.running = false; G.countdown = 3.2; }
  camInit = false; audio.start(); audio.setVolume(G.volume);
  if (document.pointerLockElement) document.exitPointerLock();
}
function makeLocalModelIfNeeded() { if (!G.model) makeLocalModel(); }
function endRound() {
  if (G.over) return; G.over = true; G.running = false; audio.fanfare();
  const solo = !G.mp, pct = G.cov.fraction;
  const rows = G.mp ? [{ name: me.name, color: me.color, sc: Math.round(G.points), you: true }, ...[...G.mp.session.players.values()].map(p => ({ name: p.name, color: p.color, sc: p.score }))].sort((a, b) => b.sc - a.sc) : null;
  setTimeout(() => showResults(rows, pct), 900);
}
function togglePause() {
  if (G.scene === 'menu') return;
  if (G.over) return;
  G.paused = !G.paused;
  if (G.paused) { if (document.pointerLockElement) document.exitPointerLock(); showPause(); } else $('menu').hidden = true;
}

/* ================================================================================================
 * Menus
 * ============================================================================================== */
function setMenu(html) { const m = $('menu'); m.innerHTML = html; m.hidden = false; return m; }
const titleBlock = '<h1 class="title">Blade <span>&amp;</span> Brew</h1><p class="sub">Lawn mower simulator · cold beer · cigar optional</p>';

function showMain() {
  G.scene = 'menu'; $('hud').hidden = true; G.mp && leaveRoom(false);
  const m = setMenu(`<div class="card">${titleBlock}
    <div class="col">
      <button class="btn" id="bSolo">Mow a yard<small>No clock. Take your time, finish the beer.</small></button>
      <button class="btn" id="bTimed">Five-minute challenge<small>Mow as much as you can. Three stars at 75%.</small></button>
      <button class="btn" id="bMP">Multiplayer<small>Race friends for the most lawn in four minutes.</small></button>
      <div class="row"><button class="btn alt" id="bSet" style="flex:1">Settings</button><button class="btn alt" id="bKeys" style="flex:1">Controls</button><button class="btn alt" id="bSave" style="flex:1">Save a copy<small>to share with friends</small></button></div>
    </div>
    <p class="muted" style="margin:14px 0 0">Drinking is for the mower's driver only. In real life, mow first, drink after.</p></div>`);
  $('bSolo').onclick = () => { audio.start(); startRound('relax', 0, (Math.random() * 1e9) | 0); };
  $('bTimed').onclick = () => { audio.start(); startRound('timed', 300, (Math.random() * 1e9) | 0); };
  $('bMP').onclick = () => { audio.start(); showMP(); };
  $('bSet').onclick = showSettings; $('bKeys').onclick = showKeys; $('bSave').onclick = saveCopy;
}
function showKeys(back = showMain) {
  const m = setMenu(`<div class="card"><h1 class="title" style="font-size:40px">Controls</h1><p class="sub">Keyboard + mouse · gamepad works too</p>
  <div class="keys"><b>W / S · ↑ / ↓</b><span>Throttle / reverse</span><b>A / D · ← / →</b><span>Steer</span><b>Shift</b><span>Boost (burns fuel)</span><b>Space</b><span>Brake</span>
  <b>E</b><span>Blades on / off</span><b>G</b><span>Bagging (+25% points) or mulching</span><b>B</b><span>Sip your beer (cooler on the red picnic table)</span><b>C</b><span>Puff the cigar</span>
  <b>H</b><span>Horn</span><b>V</b><span>Chase / seat / drone camera</span><b>R</b><span>Back to the gate</span><b>Mouse</b><span>Click to capture, look around</span><b>Esc</b><span>Menu</span><b>M</b><span>Mute</span></div>
  <p class="muted">Gnomes are fair game. Fuel pump on the east side, compost bin west, cooler by the patio.</p>
  <div class="row" style="margin-top:12px"><button class="btn alt" id="bBack">Back</button></div></div>`);
  $('bBack').onclick = typeof back === 'function' && back !== showKeys ? back : showMain;
}
function showSettings(back) {
  const m = setMenu(`<div class="card"><h1 class="title" style="font-size:40px">Settings</h1>
  <label class="f" for="sName">Driver name</label><input class="t" id="sName" maxlength="16" value="${esc(me.name)}">
  <label class="f">Mower paint</label><div class="sw" id="sCol">${COLORS.map((c, i) => `<button aria-label="${c.name}" aria-pressed="${i === me.color}" data-i="${i}" style="background:#${c.hex.toString(16).padStart(6, '0')}"></button>`).join('')}</div>
  <label class="f" for="sTime">Time of day</label><select class="t" id="sTime">${Object.entries(TIMES).map(([k, v]) => `<option value="${k}" ${k === G.time ? 'selected' : ''}>${v.name}</option>`).join('')}</select>
  <label class="f" for="sQ">Graphics</label><select class="t" id="sQ">${Object.keys(TIERS).map(k => `<option ${k === quality ? 'selected' : ''}>${k}</option>`).join('')}</select>
  <label class="f" for="sVol">Volume</label><input class="t" id="sVol" type="range" min="0" max="1" step="0.05" value="${G.volume}">
  <label class="f"><input type="checkbox" id="sGog" ${G.goggles ? 'checked' : ''}> Beer goggles (mild screen sway after a few sips)</label>
  <div class="row" style="margin-top:14px"><button class="btn" id="bOk">Done</button></div></div>`);
  $('sName').oninput = e => { me.name = e.target.value.slice(0, 16) || 'Driver'; store.set('name', me.name); };
  $('sCol').onclick = e => { const b = e.target.closest('button'); if (!b) return; me.color = +b.dataset.i; store.set('color', me.color); [...$('sCol').children].forEach(x => x.setAttribute('aria-pressed', x === b)); makeLocalModel(); };
  $('sTime').onchange = e => setTime(e.target.value, true);
  $('sQ').onchange = e => { applyQuality(e.target.value); store.set('quality', e.target.value); autoQ = false; };
  $('sVol').oninput = e => { G.volume = +e.target.value; store.set('volume', G.volume); audio.setVolume(G.volume); };
  $('sGog').onchange = e => { G.goggles = e.target.checked; store.set('goggles', G.goggles); };
  $('bOk').onclick = typeof back === 'function' && back !== showSettings ? back : showMain;
}
function showPause() {
  const m = setMenu(`<div class="card"><h1 class="title" style="font-size:44px">Paused</h1><p class="sub">${G.mp ? 'The yard keeps running for everyone else' : 'Yard on hold'}</p>
  <div class="col"><button class="btn" id="pRes">Back to mowing</button>
  ${G.mp ? `<button class="btn alt" id="pStart">Start a ${fmtTime(240)} match<small>Everyone in the room is pulled in with a 3-2-1 countdown.</small></button>${G.mp.host ? '<button class="btn alt" id="pInv">Invite another friend (code swap)</button>' : ''}` : '<button class="btn alt" id="pNew">New yard</button>'}
  <div class="row"><button class="btn alt" id="pSet" style="flex:1">Settings</button><button class="btn alt" id="pKeys" style="flex:1">Controls</button></div>
  <button class="btn alt" id="pQuit">Leave to main menu</button></div></div>`);
  $('pRes').onclick = () => { G.paused = false; m.hidden = true; };
  $('pSet').onclick = () => showSettings(showPause); $('pKeys').onclick = () => showKeys(showPause);
  $('pQuit').onclick = () => { G.paused = false; showMain(); };
  if ($('pNew')) $('pNew').onclick = () => { startRound(G.kind, G.dur, (Math.random() * 1e9) | 0); };
  if ($('pStart')) $('pStart').onclick = () => hostMatch();
  if ($('pInv')) $('pInv').onclick = () => showCodeHost(showPause);
}
function showResults(rows, pct) {
  const kind = G.kind, stars = pct >= 0.75 ? 3 : pct >= 0.55 ? 2 : pct >= 0.35 ? 1 : 0;
  const body = rows
    ? `<ul class="list">${rows.map((r, i) => `<li><span>${i + 1}.</span><i style="width:12px;height:12px;margin-top:8px;border-radius:3px;background:${PCOL[r.color % 6]}"></i><span>${esc(r.name)}${r.you ? ' (you)' : ''}</span><b>${r.sc}</b></li>`).join('')}</ul>`
    : `<ul class="list"><li><span>Mowed</span><b>${(pct * 100).toFixed(1)}%</b></li><li><span>Points</span><b>${Math.round(G.points)}</b></li><li><span>Time</span><b>${fmtTime(G.elapsed)}</b></li><li><span>Sips</span><b>${G.sips}</b></li><li><span>Gnomes booped</span><b>${G.gnomes}</b></li>${kind === 'timed' ? `<li><span>Stars</span><b>${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</b></li>` : ''}</ul>`;
  const win = rows && rows[0].you;
  setMenu(`<div class="card"><h1 class="title" style="font-size:46px">${rows ? (win ? 'You win' : 'Time') : kind === 'timed' ? 'Time' : 'Yard done'}</h1><p class="sub">${rows ? 'Final scores' : pct > 0.2 ? 'Nice stripes' : 'The lawn won this one'}</p>${body}
   <div class="row" style="margin-top:16px">${G.mp ? '<button class="btn" id="rAgain">Rematch</button>' : '<button class="btn" id="rAgain">Another yard</button>'}<button class="btn alt" id="rMenu">Main menu</button></div></div>`);
  $('rAgain').onclick = () => { if (G.mp) hostMatch(); else startRound(kind, kind === 'timed' ? 300 : 0, (Math.random() * 1e9) | 0); };
  $('rMenu').onclick = () => showMain();
}

/* ---------------------------------------------------------------- save a copy (standalone file to share) */
async function saveCopy() {
  const bundle = document.getElementById('bnb-bundle');
  if (typeof __SHELL__ === 'undefined' || !bundle) { toast('Standalone copy is only available in the built file', 2500, 'warn'); return; }
  const html = __SHELL__.replace('%%BUNDLE%%', () => bundle.textContent);
  try {
    const dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
    if (dl) { await dl.save({ filename: 'blade-and-brew.html', data: html }); return; }
  } catch (e) { if (e && e.code === 'declined') return; }
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' })), a = document.createElement('a');
  a.href = url; a.download = 'blade-and-brew.html'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ================================================================================================
 * Multiplayer UI + session wiring
 * ============================================================================================== */
let roomApi = null; RoomTransport.probe().then(a => { roomApi = a; });
function swatches() { return `<div class="sw" id="mCol">${COLORS.map((c, i) => `<button aria-label="${c.name}" aria-pressed="${i === me.color}" data-i="${i}" style="background:#${c.hex.toString(16).padStart(6, '0')}"></button>`).join('')}</div>`; }
function showMP(tab) {
  tab = tab || (roomApi ? 'room' : 'local');
  const tabs = [['room', 'Online room'], ['local', 'This browser'], ['code', 'Friend codes']].filter(t => t[0] !== 'room' || roomApi);
  const code = store.get('room', rid(4));
  const m = setMenu(`<div class="card"><h1 class="title" style="font-size:40px">Multiplayer</h1><p class="sub">Up to 6 mowers · shared yard · most lawn wins</p>
  <label class="f" for="mName">Driver name</label><input class="t" id="mName" maxlength="16" value="${esc(me.name)}"><label class="f">Mower paint</label>${swatches()}
  <div class="tabs" role="tablist">${tabs.map(t => `<button role="tab" aria-selected="${t[0] === tab}" data-t="${t[0]}">${t[1]}</button>`).join('')}</div>
  <div id="mBody"></div><div class="row" style="margin-top:14px"><button class="btn alt" id="mBack">Back</button></div></div>`);
  $('mName').oninput = e => { me.name = e.target.value.slice(0, 16) || 'Driver'; store.set('name', me.name); };
  $('mCol').onclick = e => { const b = e.target.closest('button'); if (!b) return; me.color = +b.dataset.i; store.set('color', me.color); [...$('mCol').children].forEach(x => x.setAttribute('aria-pressed', x === b)); };
  m.querySelector('.tabs').onclick = e => { const b = e.target.closest('button'); if (b) showMP(b.dataset.t); };
  $('mBack').onclick = showMain;
  const body = $('mBody');
  if (tab === 'room' || tab === 'local') {
    body.innerHTML = `<p class="muted">${tab === 'room' ? 'Everyone who has this artifact open and enters the same room code plays together, live. Friends need access to the artifact.' : 'Open this page in a second tab or window of the same browser and enter the same code. Handy for testing or couch play.'}</p>
    <label class="f" for="mCode">Room code</label><div class="row"><input class="t" id="mCode" maxlength="12" value="${code}" style="flex:1;text-transform:lowercase"><button class="btn" id="mGo">Join room</button></div><p class="muted" id="mErr"></p>`;
    $('mGo').onclick = async () => {
      const c = $('mCode').value.trim().toLowerCase().replace(/[^a-z0-9]/g, '') || rid(4); store.set('room', c);
      try {
        let tr; if (tab === 'room') { tr = new RoomTransport(roomApi); await tr.open(c); } else { tr = new LocalTransport(c); }
        joinSession(tr, (tab === 'room' ? 'Room ' : 'Tab room ') + c.toUpperCase(), hashStr(c));
      } catch (e) { $('mErr').className = 'bad'; $('mErr').textContent = 'Could not join: ' + (e && e.message || e); }
    };
  } else {
    body.innerHTML = `<p class="muted">No server: two codes get swapped by copy and paste (chat, text, anything). Works in a normal browser tab with this file.</p>
    <div class="row"><button class="btn" id="cHost" style="flex:1">I'm hosting<small>Create an invite code for each friend.</small></button><button class="btn alt" id="cJoin" style="flex:1">I have an invite<small>Paste your friend's code.</small></button></div>`;
    $('cHost').onclick = () => { const host = new P2PHost(); joinSession(host, 'Hosting', (Math.random() * 1e9) | 0, true); showCodeHost(() => { $('menu').hidden = true; }); };
    $('cJoin').onclick = showCodeJoin;
  }
}
function copyText(el, btn) { el.select(); safe(() => navigator.clipboard.writeText(el.value)).catch?.(() => { }); safe(() => document.execCommand('copy')); if (btn) { const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = t; }, 1200); } }
function showCodeHost(back) {
  const host = G.mp && G.mp.tr; if (!host || !host.invite) return;
  const m = setMenu(`<div class="card"><h1 class="title" style="font-size:36px">Invite a friend</h1><p class="sub">Step 1 of 2: send this code</p>
  <textarea class="t" id="hCode" readonly placeholder="Creating invite…"></textarea><div class="row" style="margin:8px 0"><button class="btn alt" id="hCopy">Copy invite</button></div>
  <label class="f" for="hAns">Step 2: paste the reply code they send back</label><textarea class="t" id="hAns" placeholder="BNB1:…"></textarea>
  <div class="row" style="margin-top:8px"><button class="btn" id="hGo">Connect friend</button><button class="btn alt" id="hDone">Enter the yard</button></div><p class="muted" id="hMsg"></p></div>`);
  let inv = null;
  host.invite().then(i => { inv = i; $('hCode').value = i.code; }).catch(e => { $('hMsg').className = 'bad'; $('hMsg').textContent = 'WebRTC is not available here: ' + e.message; });
  $('hCopy').onclick = () => copyText($('hCode'), $('hCopy'));
  $('hGo').onclick = async () => { try { await inv.accept($('hAns').value); $('hMsg').className = 'ok'; $('hMsg').textContent = 'Connecting… the friend appears in the yard in a moment. Need another friend? Reopen this from the pause menu.'; } catch (e) { $('hMsg').className = 'bad'; $('hMsg').textContent = 'That reply code did not work: ' + e.message; } };
  $('hDone').onclick = () => { typeof back === 'function' ? back() : ($('menu').hidden = true); G.paused = false; };
}
function showCodeJoin() {
  const m = setMenu(`<div class="card"><h1 class="title" style="font-size:36px">Join a friend</h1><p class="sub">Step 1 of 2: paste their invite</p>
  <textarea class="t" id="jIn" placeholder="BNB1:…"></textarea><div class="row" style="margin:8px 0"><button class="btn" id="jMake">Create my reply</button></div>
  <label class="f" for="jOut">Step 2: send this reply back to them</label><textarea class="t" id="jOut" readonly></textarea><div class="row" style="margin-top:8px"><button class="btn alt" id="jCopy">Copy reply</button><button class="btn alt" id="jBack">Back</button></div><p class="muted" id="jMsg">Once the host pastes it, you are dropped straight into their yard.</p></div>`);
  $('jBack').onclick = () => showMP('code'); $('jCopy').onclick = () => copyText($('jOut'), $('jCopy'));
  $('jMake').onclick = async () => {
    const g = new P2PGuest();
    try {
      $('jMsg').textContent = 'Working…'; const ans = await g.join($('jIn').value); $('jOut').value = ans; $('jMsg').textContent = 'Send the reply, then wait for the host to connect you.';
      g.onopen = () => joinSession(g, 'Friend room', 1);
    } catch (e) { $('jMsg').className = 'bad'; $('jMsg').textContent = 'That invite did not work: ' + e.message; }
  };
}

function joinSession(tr, label, seed, host = false) {
  if (G.mp) leaveRoom(false);
  const session = new Session(me);
  G.mp = { session, tr, label, host, matchState: 'lobby' };
  session.on.join = p => addRemote(p); session.on.leave = p => removeRemote(p);
  session.on.match = m => applyMatch(m);
  session.on.gnome = m => tipGnome(m.gi, false);
  session.on.horn = m => { const r = G.remote.get(m.i); audio.horn(); };
  session.on.hello = m => {
    session.send({ k: 'm', q: session.matchSeq, st: G.mp.matchState, mode: G.kind, seed: G.seed, dur: G.dur, rem: G.running ? Math.max(1, G.timeLeft) : 0 });
    if (G.cov && G.cov.cut > 0) session.sendSnapshot(m.i, G.cov.toBits());
  };
  session.on.snapshot = bits => { G.cov.fromBits(bits, 7); cutLayer.paintFromCoverage(G.cov); };
  // Enter the yard right away; if somebody answers the hello with the room's state we adopt it, else we create the lobby.
  startRound('relax', 0, seed);
  G.mp.pendingLobby = setTimeout(() => { if (G.mp && G.mp.session === session && session.matchSeq === 0) { session.sendMatch('lobby', 'relax', G.seed, 0); } }, 1500);
  session.attach(tr);
  tr.onpeer = () => { };
  toast(host ? 'Hosting. Invite friends from the pause menu.' : 'Joined ' + label, 2400);
  $('top').hidden = false;
}
function leaveRoom(toMenu = true) {
  if (!G.mp) return;
  clearTimeout(G.mp.pendingLobby); G.mp.session.close();
  for (const [id, r] of G.remote) { scene.remove(r.model.root); disposeObj(r.model.root); audio.dropRemote(id); }
  G.remote.clear(); G.mp = null;
}
function hostMatch() {
  if (!G.mp) return; $('menu').hidden = true; G.paused = false;
  const seed = (Math.random() * 1e9) | 0, m = G.mp.session.sendMatch('play', 'match', seed, 240);
  applyMatch(m, true);
}
function applyMatch(m, mine) {
  if (!G.mp) return;
  G.mp.matchState = m.st;
  if (m.st === 'play') {
    $('menu').hidden = true; G.paused = false;
    if (m.rem) startRound('match', m.dur, m.seed, { late: true, rem: m.rem });
    else startRound('match', m.dur || 240, m.seed);
  } else if (m.st === 'lobby') {
    if ((m.seed >>> 0) !== G.seed) { startRound('relax', 0, m.seed); } else if (G.kind === 'match' && G.over) { /* stay on results */ }
  }
}

/* ================================================================================================
 * Boot + loop
 * ============================================================================================== */
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  camera.aspect = w / h; camera.updateProjectionMatrix();
  U.uRes.value.copy(renderer.getDrawingBufferSize(new THREE.Vector2()));
  parts.uniforms.uScale.value = U.uRes.value.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}
addEventListener('resize', resize); resize();

let autoQ = !qs.has('q'), last = performance.now();
function render() {
  if (envDirty) { buildEnv(); envDirty = false; }
  parts.uniforms.uScale.value = U.uRes.value.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  cutLayer.flush();
  renderer.render(scene, camera);
}
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  update(dt); updateCamera(dt); render();
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 1) {
    const fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
    if (autoQ && tAbs > 4) {
      slow = fps < 24 ? slow + 1 : 0; const order = Object.keys(TIERS), i = order.indexOf(quality);
      if (slow >= 3 && i > 0) { applyQuality(order[i - 1]); slow = 0; }
      else if (slow >= 3 && renderer.getPixelRatio() > 0.7) { renderer.setPixelRatio(Math.max(0.65, renderer.getPixelRatio() - 0.25)); resize(); slow = 0; }   // last resort: render fewer pixels
    }
  }
  window.__frames = (window.__frames || 0) + 1;
  requestAnimationFrame(frame);
}

setTime(G.time, false);
newYard(qs.has('seed') ? +qs.get('seed') : 20240611);
makeLocalModel();
G.sim = new MowerSim(G.yard.spawns[0]);
camPos.set(0, 3, 0);
if (qs.has('play')) startRound(qs.get('play') === 'timed' ? 'timed' : 'relax', qs.get('play') === 'timed' ? 300 : 0, G.seed);
else showMain();
if (!qs.has('pause')) requestAnimationFrame(frame);

window.__bnb = {
  G, U, me, keys, THREE, scene, camera, renderer, parts, cutLayer, audio, applyQuality, startRound, newYard, setTime,
  advance(n = 1, dt = 1 / 60, doRender = true) { for (let i = 0; i < n; i++) { update(dt); updateCamera(dt); } if (doRender) render(); },
  hostMatch, applyMatch, showMain, showPause, showResults, endRound,
  shot() { render(); return canvas.toDataURL('image/png'); },
  joinLocal(code) { joinSession(new LocalTransport(code), 'Tab room ' + code.toUpperCase(), hashStr(code)); },
};
