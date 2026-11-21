import * as THREE from 'three';
import { mulberry32, terrainH, clamp } from './util.js';

export const YARD_HALF = 32;
export const GRID = 256;                       // scoring grid (25 cm cells)
export const CELL = (2 * YARD_HALF) / GRID;
export const MAP_RES = 1024;                   // baked yard-map resolution (6 cm texels)

/* ================================================================================================
 * Deterministic yard generator: everything derives from `seed`, so every player in a room gets the same yard.
 * ============================================================================================== */
export function buildYard(seed, sunDir) {
  const rng = mulberry32(seed >>> 0);
  const R = (a, b) => a + (b - a) * rng();
  const H = YARD_HALF;
  const Y = {
    seed, half: H, trees: [], bushes: [], beds: [], rings: [], gnomes: [], circles: [], boxes: [], flowers: [],
    stations: {}, spawns: [], pond: null, patio: null, path: null, house: null, sun: sunDir,
  };
  const far = (x, z, r, list) => list.every(o => Math.hypot(o.x - x, o.z - z) > r + (o.r || 0));

  // House + paved patio along the north fence, stone apron at the south gate.
  Y.house = { x: R(-3, 3), z: -H + 3.7, hw: 12.5, hd: 3.7, h: 4.4 };
  Y.patio = { x: 0, z: -H + 5.2, hw: 15, hd: 5.2 };               // z -32 .. -21.6
  Y.path = { x: 0, z: H - 3.2, hw: 1.5, hd: 3.4 };
  Y.boxes.push({ x: Y.house.x, z: Y.house.z, hw: Y.house.hw, hd: Y.house.hd });

  // Perimeter beds (non-mowable strips against the east and west fences).
  Y.beds.push({ x: -H + 1.1, z: 4, hw: 1.1, hd: 20 }, { x: H - 1.1, z: 4, hw: 1.1, hd: 20 });

  // Stations.
  const st = Y.stations;
  st.cooler = { x: R(-10, -6), z: -H + 13.5, r: 2.2, label: 'COOLER' };
  st.pump = { x: H - 3.2, z: R(-14, -8), r: 2.2, label: 'FUEL' };
  st.compost = { x: -H + 3.5, z: R(16, 22), r: 2.4, label: 'COMPOST' };
  for (const s of Object.values(st)) Y.circles.push({ x: s.x, z: s.z, r: 0.95, kind: 'prop' });

  // Pond in the south-east quarter.
  Y.pond = { x: R(10, 18), z: R(10, 17), r: R(2.8, 3.6) };
  Y.circles.push({ x: Y.pond.x, z: Y.pond.z, r: Y.pond.r + 0.5, kind: 'pond' });

  // Trees (with mulch rings).
  for (let tries = 0; tries < 200 && Y.trees.length < 5; tries++) {
    const x = R(-24, 24), z = R(-16, 24);
    if (!far(x, z, 7.5, Y.trees)) continue;
    if (Math.hypot(x - Y.pond.x, z - Y.pond.z) < Y.pond.r + 4) continue;
    if (Object.values(st).some(s => Math.hypot(s.x - x, s.z - z) < 6)) continue;
    if (Math.abs(x) > 26 || Math.hypot(x - Y.path.x, z - Y.path.z) < 4) continue;
    Y.trees.push({ x, z, r: R(0.35, 0.5), h: R(5.5, 8), kind: rng() < 0.5 ? 'oak' : 'maple', seed: (rng() * 1e9) | 0 });
  }
  for (const t of Y.trees) { Y.circles.push({ x: t.x, z: t.z, r: t.r + 0.2, kind: 'tree' }); Y.rings.push({ x: t.x, z: t.z, r: 1.5 }); }

  // Island flower beds with a shrub.
  for (let tries = 0; tries < 100 && Y.rings.length < 8; tries++) {
    const x = R(-20, 20), z = R(-14, 22), r = R(2, 2.8);
    if (Y.trees.some(t => Math.hypot(t.x - x, t.z - z) < r + 5)) continue;
    if (Math.hypot(x - Y.pond.x, z - Y.pond.z) < Y.pond.r + r + 3) continue;
    if (Object.values(st).some(s => Math.hypot(s.x - x, s.z - z) < r + 4)) continue;
    if (Y.rings.some(o => Math.hypot(o.x - x, o.z - z) < o.r + r + 4)) continue;
    Y.rings.push({ x, z, r, island: true });
    Y.bushes.push({ x, z, r: 0.75, s: R(0.8, 1.2) });
    Y.circles.push({ x, z, r: 0.8, kind: 'bush' });
  }
  // Hedge bushes inside the perimeter beds and along the house.
  for (let z = -16; z <= 24; z += R(3.6, 5)) {
    for (const sx of [-1, 1]) {
      const x = sx * (H - 1.1);
      Y.bushes.push({ x, z, r: 0.7, s: R(0.8, 1.3) });
    }
  }
  for (let x = -Y.house.hw; x <= Y.house.hw; x += R(3.5, 5)) Y.bushes.push({ x: Y.house.x + x, z: -H + 7.6, r: 0.6, s: R(0.6, 0.9) });

  // Gnomes: placed on open lawn.
  for (let tries = 0; tries < 300 && Y.gnomes.length < 7; tries++) {
    const x = R(-27, 27), z = R(-17, 28);
    if (!isMowable0(x, z, Y)) continue;
    if (Y.gnomes.some(g => Math.hypot(g.x - x, g.z - z) < 8)) continue;
    Y.gnomes.push({ x, z, hat: (rng() * 4) | 0, yaw: rng() * 6.28 });
  }
  for (const g of Y.gnomes) Y.circles.push({ x: g.x, z: g.z, r: 0.3, kind: 'gnome', gi: Y.gnomes.indexOf(g) });

  // Spawns near the gate.
  for (let i = 0; i < 6; i++) Y.spawns.push({ x: -7.5 + i * 3, z: H - 7.5 - (i % 2) * 2.2, h: Math.PI });

  Y.isMowable = (x, z) => isMowable0(x, z, Y);
  return Y;
}

const inRect = (r, x, z, m = 0) => Math.abs(x - r.x) < r.hw + m && Math.abs(z - r.z) < r.hd + m;
export function isMowable0(x, z, Y) {
  const H = YARD_HALF;
  if (Math.abs(x) > H - 0.9 || Math.abs(z) > H - 0.9) return false;
  if (Y.patio && inRect(Y.patio, x, z, 0.1)) return false;
  if (Y.path && inRect(Y.path, x, z, 0.1)) return false;
  for (const b of Y.beds) if (inRect(b, x, z, 0.1)) return false;
  for (const r of Y.rings) if (Math.hypot(r.x - x, r.z - z) < r.r + 0.1) return false;
  if (Y.pond && Math.hypot(Y.pond.x - x, Y.pond.z - z) < Y.pond.r + 0.6) return false;
  for (const s of Object.values(Y.stations)) if (Math.hypot(s.x - x, s.z - z) < 1.0) return false;
  return true;
}

/* ================================================================================================
 * Baked yard map: R bed, G paving, B water, A static shade. Painted with Canvas2D, packed into a DataTexture.
 * ============================================================================================== */
export function bakeYardMap(Y) {
  const S = MAP_RES, H = YARD_HALF;
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#000'; x.fillRect(0, 0, S, S); x.fillStyle = '#fff'; return [c, x]; };
  const P = v => ((v + H) / (2 * H)) * S;
  const L = v => (v / (2 * H)) * S;
  const [cBed, xBed] = mk(), [cPave, xPave] = mk(), [cWater, xWater] = mk(), [cShade, xShade] = mk();
  const rect = (ctx, r, m = 0) => ctx.fillRect(P(r.x - r.hw - m), P(r.z - r.hd - m), L(2 * (r.hw + m)), L(2 * (r.hd + m)));
  const disc = (ctx, x, z, r) => { ctx.beginPath(); ctx.arc(P(x), P(z), L(r), 0, 6.2832); ctx.fill(); };
  for (const b of Y.beds) rect(xBed, b);
  for (const r of Y.rings) disc(xBed, r.x, r.z, r.r);
  rect(xPave, Y.patio); rect(xPave, Y.path);
  // Stone pad under each station.
  for (const s of Object.values(Y.stations)) disc(xPave, s.x, s.z, 1.5);
  // Pond bank is bare mud (bed channel), water in blue channel.
  disc(xBed, Y.pond.x, Y.pond.z, Y.pond.r + 0.5);
  disc(xWater, Y.pond.x, Y.pond.z, Y.pond.r);

  // Static shadows from trees and the house, stretched away from the sun (artistically shortened).
  const sd = Y.sun; const dl = Math.hypot(sd.x, sd.z) || 1; const dx = -sd.x / dl, dz = -sd.z / dl;
  const tanEl = Math.max(Math.tan(Math.asin(clamp(sd.y, 0.05, 0.99))), 0.12);
  const k = 0.55 / tanEl;
  xShade.filter = 'blur(' + Math.round(S * 0.006) + 'px)';
  for (const t of Y.trees) {
    const len = Math.min(t.h * k, 16);
    xShade.save(); xShade.translate(P(t.x + dx * len * 0.5), P(t.z + dz * len * 0.5)); xShade.rotate(Math.atan2(dz, dx));
    xShade.beginPath(); xShade.ellipse(0, 0, L(len * 0.5 + 1.6), L(2.3), 0, 0, 6.2832); xShade.fill(); xShade.restore();
  }
  { // house: swept footprint
    const h = Y.house, len = Math.min(h.h * k, 9);
    const c = [[h.x - h.hw, h.z - h.hd], [h.x + h.hw, h.z - h.hd], [h.x + h.hw, h.z + h.hd], [h.x - h.hw, h.z + h.hd]];
    xShade.beginPath();
    const pts = [...c, ...c.map(([x, z]) => [x + dx * len, z + dz * len])];
    // convex hull of the sweep (cheap monotone chain)
    const sorted = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = []; for (const p of sorted) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    const up = []; for (const p of sorted.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    const hull = lo.slice(0, -1).concat(up.slice(0, -1));
    hull.forEach(([x, z], i) => (i ? xShade.lineTo(P(x), P(z)) : xShade.moveTo(P(x), P(z)))); xShade.closePath(); xShade.fill();
  }
  const grab = c => c.getContext('2d').getImageData(0, 0, S, S).data;
  const dB = grab(cBed), dP = grab(cPave), dW = grab(cWater), dS = grab(cShade);
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) { data[i * 4] = dB[i * 4]; data[i * 4 + 1] = dP[i * 4]; data[i * 4 + 2] = dW[i * 4]; data[i * 4 + 3] = Math.min(255, dS[i * 4] * 0.85); }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.needsUpdate = true;
  return tex;
}

/* ================================================================================================
 * Mowing coverage grid (CPU): authoritative score source and minimap.
 * ============================================================================================== */
export class Coverage {
  constructor(Y) { this.reset(Y); }
  reset(Y) {
    this.Y = Y;
    this.owner = new Uint8Array(GRID * GRID);         // 0 uncut, else playerIndex+1
    this.mowable = new Uint8Array(GRID * GRID);
    let n = 0;
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      const x = -YARD_HALF + (i + 0.5) * CELL, z = -YARD_HALF + (j + 0.5) * CELL;
      if (Y.isMowable(x, z)) { this.mowable[j * GRID + i] = 1; n++; }
    }
    this.total = n; this.cut = 0;
  }
  /** Stamp an oriented rectangle; returns the number of newly cut mowable cells. */
  stamp(cx, cz, fx, fz, hw, hl, owner) {
    const rx = fz, rz = -fx;
    const ext = Math.abs(rx) * hw + Math.abs(fx) * hl, extz = Math.abs(rz) * hw + Math.abs(fz) * hl;
    const i0 = Math.max(0, Math.floor((cx - ext + YARD_HALF) / CELL)), i1 = Math.min(GRID - 1, Math.floor((cx + ext + YARD_HALF) / CELL));
    const j0 = Math.max(0, Math.floor((cz - extz + YARD_HALF) / CELL)), j1 = Math.min(GRID - 1, Math.floor((cz + extz + YARD_HALF) / CELL));
    let gained = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = -YARD_HALF + (i + 0.5) * CELL - cx, z = -YARD_HALF + (j + 0.5) * CELL - cz;
      if (Math.abs(x * rx + z * rz) > hw || Math.abs(x * fx + z * fz) > hl) continue;
      const k = j * GRID + i;
      if (this.mowable[k] && !this.owner[k]) { this.owner[k] = owner + 1; gained++; }
    }
    this.cut += gained;
    return gained;
  }
  at(x, z) {
    const i = Math.floor((x + YARD_HALF) / CELL), j = Math.floor((z + YARD_HALF) / CELL);
    if (i < 0 || j < 0 || i >= GRID || j >= GRID) return 1;
    return this.owner[j * GRID + i];
  }
  get fraction() { return this.total ? this.cut / this.total : 0; }
  /** Pack "is cut" as a bitset (for late joiners). */
  toBits() {
    const out = new Uint8Array((GRID * GRID) >> 3);
    for (let k = 0; k < GRID * GRID; k++) if (this.owner[k]) out[k >> 3] |= 1 << (k & 7);
    return out;
  }
  fromBits(bits, ownerIdx) {
    let add = 0;
    for (let k = 0; k < GRID * GRID; k++) if ((bits[k >> 3] >> (k & 7)) & 1 && !this.owner[k] && this.mowable[k]) { this.owner[k] = ownerIdx + 1; add++; }
    this.cut += add;
  }
}

/* ================================================================================================
 * Cut-mask render target + instanced stamper
 * ============================================================================================== */
export function makeCutLayer(renderer, STAMP_VS, STAMP_FS, maxStamps = 192, res = 2048) {
  const rt = new THREE.WebGLRenderTarget(res, res, {
    type: THREE.UnsignedByteType, format: THREE.RedFormat, depthBuffer: false,
    magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(maxStamps * 2), 2).setUsage(THREE.DynamicDrawUsage);
  const iDir = new THREE.InstancedBufferAttribute(new Float32Array(maxStamps * 2), 2).setUsage(THREE.DynamicDrawUsage);
  const iHalf = new THREE.InstancedBufferAttribute(new Float32Array(maxStamps * 2), 2).setUsage(THREE.DynamicDrawUsage);
  const iVal = new THREE.InstancedBufferAttribute(new Float32Array(maxStamps), 1).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('iPos', iPos); g.setAttribute('iDir', iDir); g.setAttribute('iHalf', iHalf); g.setAttribute('iVal', iVal);
  g.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    vertexShader: STAMP_VS, fragmentShader: STAMP_FS, uniforms: { uRect: { value: new THREE.Vector3(0, 0, YARD_HALF) } },
    depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.MaxEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false;
  const scene = new THREE.Scene(); scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let n = 0;
  const api = {
    texture: rt.texture, rt,
    clear() {
      const prev = renderer.getRenderTarget(), pc = renderer.getClearColor(new THREE.Color()), pa = renderer.getClearAlpha();
      renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1); renderer.clear(true, false, false);
      renderer.setRenderTarget(prev); renderer.setClearColor(pc, pa);
    },
    add(x, z, fx, fz, hw, hl, val) {
      if (n >= maxStamps) return;
      iPos.setXY(n, x, z); iDir.setXY(n, fx, fz); iHalf.setXY(n, hw, hl); iVal.setX(n, val); n++;
    },
    flush() {
      if (!n) return;
      g.instanceCount = n;
      iPos.needsUpdate = iDir.needsUpdate = iHalf.needsUpdate = iVal.needsUpdate = true;
      const prev = renderer.getRenderTarget(), ac = renderer.autoClear;
      renderer.autoClear = false; renderer.setRenderTarget(rt); renderer.render(scene, cam);
      renderer.setRenderTarget(prev); renderer.autoClear = ac; n = 0;
    },
    /** Repaint from a coverage grid (late joiners / reset): one stamp per cut cell row-run. */
    paintFromCoverage(cov) {
      for (let j = 0; j < GRID; j++) {
        let i = 0;
        while (i < GRID) {
          if (!cov.owner[j * GRID + i]) { i++; continue; }
          let k = i; while (k < GRID && cov.owner[j * GRID + k]) k++;
          const x = -YARD_HALF + ((i + k) / 2) * CELL, z = -YARD_HALF + (j + 0.5) * CELL;
          api.add(x, z, 0, 1, ((k - i) * CELL) / 2 + 0.01, CELL / 2 + 0.01, (j & 8) ? 1.0 : 0.6);
          if (n >= maxStamps) api.flush();
          i = k;
        }
      }
      api.flush();
    },
  };
  return api;
}

/* ================================================================================================
 * 3D props: house, fence, trees, bushes, flowers, stations, gnomes, pond
 * ============================================================================================== */
function mat(color, rough = 0.8, metal = 0, extra = {}) { return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra }); }
function shadowAll(o, cast = true, recv = true) { o.traverse(c => { if (c.isMesh) { c.castShadow = cast; c.receiveShadow = recv; } }); return o; }

function treeMesh(t) {
  const rng = mulberry32(t.seed), g = new THREE.Group();
  const trunkH = t.h * 0.42;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(t.r * 0.7, t.r * 1.15, trunkH, 10, 3), mat(0x4b3626, 0.95));
  trunk.position.y = trunkH / 2; g.add(trunk);
  // a couple of limbs
  for (let i = 0; i < 3; i++) {
    const limb = new THREE.Mesh(new THREE.CylinderGeometry(t.r * 0.22, t.r * 0.4, t.h * 0.3, 6), mat(0x4b3626, 0.95));
    const a = rng() * 6.28; limb.position.set(Math.cos(a) * t.r * 1.1, trunkH * 0.9, Math.sin(a) * t.r * 1.1);
    limb.rotation.set(Math.sin(a) * 0.7, 0, -Math.cos(a) * 0.7); g.add(limb);
  }
  const base = t.kind === 'oak' ? new THREE.Color(0x5d8c2c) : new THREE.Color(0xc2561f);
  const blobs = t.kind === 'oak' ? 7 : 6;
  for (let i = 0; i < blobs; i++) {
    const r = t.h * (0.2 + rng() * 0.1);
    const geo = new THREE.SphereGeometry(r, 28, 20);
    const pos = geo.attributes.position, col = [];
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      const n = 1 + 0.18 * Math.sin(x * 3.1 + i) * Math.sin(y * 2.7 + 2 * i) * Math.sin(z * 3.3 + i * 0.5) + 0.07 * Math.sin(x * 9 + z * 8);
      pos.setXYZ(v, x * n, y * n * 0.82, z * n);
      const shade = 0.75 + 0.5 * (y / r * 0.5 + 0.5) * (0.8 + 0.4 * Math.sin(x * 7 + z * 5));
      const c = base.clone().multiplyScalar(shade); col.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat(0xffffff, 0.9, 0, { vertexColors: true }));
    const a = rng() * 6.28, d = rng() * t.h * 0.22;
    m.position.set(Math.cos(a) * d, trunkH + t.h * 0.3 + rng() * t.h * 0.22, Math.sin(a) * d); g.add(m);
  }
  g.position.set(t.x, terrainH(t.x, t.z), t.z);
  return shadowAll(g);
}

function gnomeMesh(gn) {
  const g = new THREE.Group();
  const coat = [0x2563a8, 0x2e7d32, 0x8e24aa, 0xc62828][gn.hat % 4];
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 0.26, 12), mat(coat, 0.7)); body.position.y = 0.13; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 10), mat(0xf0c8a0, 0.7)); head.position.y = 0.32; g.add(head);
  const beard = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.16, 12), mat(0xf4f4f4, 0.9)); beard.position.set(0, 0.25, 0.04); beard.rotation.x = Math.PI; g.add(beard);
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 12), mat(0xd32f2f, 0.6)); hat.position.y = 0.5; g.add(hat);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), mat(0xe8a080, 0.6)); nose.position.set(0, 0.32, 0.085); g.add(nose);
  const pivot = new THREE.Group(); pivot.add(g);
  pivot.position.set(gn.x, terrainH(gn.x, gn.z), gn.z); pivot.rotation.y = gn.yaw; pivot.userData.inner = g;
  return shadowAll(pivot);
}

export function buildYardMeshes(Y, canvasLabel) {
  const root = new THREE.Group();
  const H = YARD_HALF;

  // House
  const h = Y.house, house = new THREE.Group();
  const walls = new THREE.Mesh(new THREE.BoxGeometry(h.hw * 2, h.h, h.hd * 2), mat(0xcfc6b4, 0.9));
  walls.position.set(h.x, terrainH(h.x, h.z) + h.h / 2, h.z); house.add(walls);
  const roofW = h.hw + 0.9, roofD = h.hd + 0.9, roofH = 2.2;
  // Gable roof (prism along x)
  const roofGeo = new THREE.BufferGeometry();
  const A = [-roofW, 0, -roofD], B = [roofW, 0, -roofD], C = [roofW, 0, roofD], D = [-roofW, 0, roofD], E = [-roofW, roofH, 0], F = [roofW, roofH, 0];
  const tris = [A, B, F, A, F, E, D, E, F, D, F, C, A, E, D, B, C, F];
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3)); roofGeo.computeVertexNormals();
  const roof = new THREE.Mesh(roofGeo, mat(0x4a3b36, 0.85, 0, { side: THREE.DoubleSide }));
  roof.position.set(h.x, terrainH(h.x, h.z) + h.h, h.z); house.add(roof);
  // windows (warm, emissive) + door on the lawn-facing (south) wall
  const winMat = new THREE.MeshStandardMaterial({ color: 0x1b2430, emissive: 0xffb45c, emissiveIntensity: 0.9, roughness: 0.2, metalness: 0.2 });
  for (let i = -3; i <= 3; i++) {
    if (i === 0) continue;
    const w = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.4, 0.12), winMat);
    w.position.set(h.x + i * 3.4, terrainH(h.x, h.z) + 2.1, h.z + h.hd + 0.03); house.add(w);
    const sill = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.3), mat(0xeeeeee, 0.6)); sill.position.set(w.position.x, w.position.y - 0.75, w.position.z + 0.08); house.add(sill);
  }
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.3, 2.3, 0.14), mat(0x7a2e22, 0.6)); door.position.set(h.x, terrainH(h.x, h.z) + 1.15, h.z + h.hd + 0.05); house.add(door);
  const chim = new THREE.Mesh(new THREE.BoxGeometry(1, 2.6, 1), mat(0x8a5a48, 0.95)); chim.position.set(h.x + 6, terrainH(h.x, h.z) + h.h + 1.4, h.z); house.add(chim);
  root.add(shadowAll(house));

  // Fence: instanced boards + posts + rails; gate gap at the south wall.
  const boards = [], BW = 0.14, GAP = 0.02;
  const gate = 1.9;
  const addSide = (ax, az, bx, bz) => {
    const len = Math.hypot(bx - ax, bz - az), n = Math.floor(len / (BW + GAP));
    const dx = (bx - ax) / len, dz = (bz - az) / len, yaw = Math.atan2(dx, dz);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) * (BW + GAP);
      const x = ax + dx * t, z = az + dz * t;
      if (z > H - 0.5 && Math.abs(x) < gate) continue;
      boards.push([x, z, yaw, 1.5 + ((i * 37) % 7) * 0.02]);
    }
  };
  addSide(-H, H, H, H);            // south (with gate)
  addSide(-H, -H, -H, H);          // west
  addSide(H, -H, H, H);            // east
  const bgeo = new THREE.BoxGeometry(BW, 1, 0.025);
  const bm = new THREE.InstancedMesh(bgeo, mat(0xffffff, 0.9), boards.length);
  const tmp = new THREE.Object3D(), col = new THREE.Color();
  boards.forEach(([x, z, yaw, hh], i) => {
    tmp.position.set(x, terrainH(x, z) + hh / 2 - 0.05, z); tmp.rotation.set(0, yaw, 0); tmp.scale.set(1, hh, 1); tmp.updateMatrix(); bm.setMatrixAt(i, tmp.matrix);
    col.setHSL(0.075 + ((i * 13) % 9) * 0.003, 0.35, 0.34 + ((i * 7) % 11) * 0.01); bm.setColorAt(i, col);
  });
  bm.castShadow = true; bm.receiveShadow = true; root.add(bm);
  // posts + rails
  const postM = mat(0x5a4330, 0.9);
  for (let t = -H; t <= H; t += 2.4) for (const [x, z] of [[t, H], [t, -H], [-H, t], [H, t]]) {
    if (z > H - 0.5 && Math.abs(x) < gate + 0.2) continue;
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.7, 0.14), postM); p.position.set(x, terrainH(x, z) + 0.8, z); p.castShadow = true; root.add(p);
  }
  for (const [x, z, w, d] of [[0, H - 0.03, 2 * H, 0.05], [0, -H + 0.03, 2 * H, 0.05], [-H + 0.03, 0, 0.05, 2 * H], [H - 0.03, 0, 0.05, 2 * H]]) {
    for (const y of [0.45, 1.15]) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(w, 0.07, d + 0.03), postM); r.position.set(x, y, z); root.add(r);
    }
  }
  // gate posts
  for (const sx of [-1, 1]) { const gp = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2, 0.22), mat(0x4a3826, 0.9)); gp.position.set(sx * (gate + 0.1), 1, H); gp.castShadow = true; root.add(gp); }

  // Trees, bushes, gnomes
  for (const t of Y.trees) root.add(treeMesh(t));
  const bushGeo = new THREE.SphereGeometry(1, 20, 14);
  { const p = bushGeo.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i); const n = 1 + 0.15 * Math.sin(x * 5 + z * 4) * Math.sin(y * 6); p.setXYZ(i, x * n, y * n * 0.8, z * n); } bushGeo.computeVertexNormals(); }
  const bush = new THREE.InstancedMesh(bushGeo, mat(0xffffff, 0.85), Y.bushes.length);
  Y.bushes.forEach((b, i) => {
    tmp.position.set(b.x, terrainH(b.x, b.z) + b.r * 0.55, b.z); tmp.rotation.set(0, i, 0); tmp.scale.set(b.r * b.s * 1.2, b.r * b.s, b.r * b.s * 1.2); tmp.updateMatrix();
    bush.setMatrixAt(i, tmp.matrix); col.setHSL(0.27 + (i % 5) * 0.01, 0.5, 0.17 + (i % 4) * 0.02); bush.setColorAt(i, col);
  });
  bush.castShadow = bush.receiveShadow = true; root.add(bush);

  // Flowers (instanced spheres + stems) inside beds and rings
  const flowerSpots = [];
  const rng = mulberry32(Y.seed ^ 0xBEEF);
  for (const b of Y.beds) for (let i = 0; i < 90; i++) flowerSpots.push([b.x + (rng() - 0.5) * 2 * b.hw * 0.9, b.z + (rng() - 0.5) * 2 * b.hd * 0.95]);
  for (const r of Y.rings) if (r.island) for (let i = 0; i < 70; i++) { const a = rng() * 6.28, d = Math.sqrt(rng()) * r.r * 0.92; flowerSpots.push([r.x + Math.cos(a) * d, r.z + Math.sin(a) * d]); }
  const fl = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 8, 6), mat(0xffffff, 0.6), flowerSpots.length);
  const pal = [0xe53935, 0xffd54f, 0xf48fb1, 0xab47bc, 0xffffff, 0xff8a65];
  flowerSpots.forEach(([x, z], i) => {
    const hgt = 0.28 + rng() * 0.3;
    tmp.position.set(x, terrainH(x, z) + hgt, z); tmp.rotation.set(0, 0, 0); tmp.scale.setScalar(0.7 + rng() * 0.8); tmp.updateMatrix();
    fl.setMatrixAt(i, tmp.matrix); col.setHex(pal[(rng() * pal.length) | 0]); fl.setColorAt(i, col);
  });
  fl.castShadow = false; root.add(fl);
  const stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.008, 0.01, 0.4, 4), mat(0x3e7d32, 0.8), flowerSpots.length);
  flowerSpots.forEach(([x, z], i) => { tmp.position.set(x, terrainH(x, z) + 0.2, z); tmp.rotation.set(0, 0, 0); tmp.scale.set(1, 1, 1); tmp.updateMatrix(); stems.setMatrixAt(i, tmp.matrix); });
  root.add(stems);

  const gnomes = Y.gnomes.map(gnomeMesh); gnomes.forEach(g => root.add(g));

  // Pond: water disc + stones
  const pg = new THREE.CircleGeometry(Y.pond.r, 48); pg.rotateX(-Math.PI / 2);
  const pondMesh = new THREE.Mesh(pg, null); pondMesh.position.set(Y.pond.x, terrainH(Y.pond.x, Y.pond.z) + 0.02, Y.pond.z);
  pondMesh.renderOrder = 2;
  root.add(pondMesh);
  const stoneM = mat(0x77736b, 0.85);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * 6.2832 + rng() * 0.2, rr = Y.pond.r + 0.25 + rng() * 0.2;
    const s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.2 + rng() * 0.18, 0), stoneM);
    const x = Y.pond.x + Math.cos(a) * rr, z = Y.pond.z + Math.sin(a) * rr;
    s.position.set(x, terrainH(x, z) + 0.08, z); s.rotation.set(rng() * 3, rng() * 3, rng() * 3); s.scale.y = 0.6; s.castShadow = true; root.add(s);
  }

  // Stations
  const { cooler, pump, compost } = Y.stations;
  { // cooler on a picnic table
    const g = new THREE.Group();
    const top = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.07, 0.9), mat(0x8b6b45, 0.85)); top.position.y = 0.78; g.add(top);
    for (const sx of [-1, 1]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.78, 0.9), mat(0x6e5435, 0.9)); leg.position.set(sx * 0.8, 0.39, 0); g.add(leg); }
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.42, 0.45), mat(0xd32f2f, 0.4, 0.1)); box.position.set(0.3, 1.03, 0); g.add(box);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.07, 0.48), mat(0xf5f5f5, 0.35)); lid.position.set(0.3, 1.27, 0); g.add(lid);
    for (let i = 0; i < 4; i++) { const can = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 0.12, 12), mat(0xe0b020, 0.3, 0.9)); can.position.set(-0.5 + i * 0.1, 0.875, 0.1); g.add(can); }
    g.position.set(cooler.x, terrainH(cooler.x, cooler.z), cooler.z); g.rotation.y = 0.4; root.add(shadowAll(g));
  }
  { // fuel pump
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.5, 0.5), mat(0xd9382b, 0.45, 0.2)); body.position.y = 0.75; g.add(body);
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.02), new THREE.MeshStandardMaterial({ color: 0x102018, emissive: 0x3cff88, emissiveIntensity: 0.6 })); screen.position.set(0, 1.15, 0.26); g.add(screen);
    const hose = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.025, 8, 24, Math.PI * 1.4), mat(0x111111, 0.7)); hose.position.set(0.45, 0.8, 0); hose.rotation.y = Math.PI / 2; g.add(hose);
    g.position.set(pump.x, terrainH(pump.x, pump.z), pump.z); g.rotation.y = -Math.PI / 2; root.add(shadowAll(g));
    const jerry = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.15), mat(0xd32f2f, 0.5)); jerry.position.set(pump.x - 0.9, terrainH(pump.x, pump.z) + 0.2, pump.z + 0.7); jerry.castShadow = true; root.add(jerry);
  }
  { // compost bin
    const g = new THREE.Group();
    const bin = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.62, 1.05, 18, 1, true), mat(0x2f5d3a, 0.7)); bin.position.y = 0.52; g.add(bin);
    const fill = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.05, 18), mat(0x2d2418, 1)); fill.position.y = 0.9; g.add(fill);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.06, 18), mat(0x1f3f27, 0.6)); lid.position.set(0.8, 0.8, 0.5); lid.rotation.z = 0.9; g.add(lid);
    g.position.set(compost.x, terrainH(compost.x, compost.z), compost.z); root.add(shadowAll(g));
  }
  // Mailbox + sprinkler heads for set dressing
  const mb = new THREE.Group();
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.1, 0.1), mat(0x4a3826)); post.position.y = 0.55; mb.add(post);
  const bx = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.24, 0.5), mat(0x2457a6, 0.4, 0.3)); bx.position.y = 1.15; mb.add(bx);
  mb.position.set(4.6, terrainH(4.6, H - 0.6), H - 0.6); root.add(shadowAll(mb));

  return { root, gnomes, pondMesh, bushes: bush };
}
