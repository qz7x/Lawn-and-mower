import * as THREE from 'three';
import { clamp, terrainH, terrainGrad, lerp, smooth } from './util.js';
import { YARD_HALF } from './world.js';

export const COLORS = [
  { name: 'Barn Red', hex: 0xc62f22 }, { name: 'John-Deer Green', hex: 0x2f7d32 }, { name: 'Sunburst', hex: 0xf2a900 },
  { name: 'Ocean', hex: 0x1f6fb5 }, { name: 'Plum', hex: 0x7b3f9e }, { name: 'Chrome Ice', hex: 0xb9c3cc },
];

const M = (c, r = 0.6, m = 0, ex = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m, ...ex });

let canTex = null;
export function canTexture() {
  if (canTex) return canTex;
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 128); grd.addColorStop(0, '#f6d365'); grd.addColorStop(1, '#d99a12');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#7a1212'; g.fillRect(0, 40, 256, 52);
  g.fillStyle = '#f9e6a8'; g.font = 'bold 40px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let i = 0; i < 2; i++) g.fillText('BREW', 64 + i * 128, 66);
  g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(0, 0, 256, 10);
  canTex = new THREE.CanvasTexture(c); canTex.colorSpace = THREE.SRGBColorSpace; canTex.anisotropy = 4;
  return canTex;
}

export function makeCan() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 0.122, 20), new THREE.MeshStandardMaterial({ map: canTexture(), roughness: 0.28, metalness: 0.85 }));
  g.add(body);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.033, 0.01, 20), M(0xc9ced3, 0.25, 1)); top.position.y = 0.066; g.add(top);
  const tab = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.002, 0.012), M(0xe9edf0, 0.2, 1)); tab.position.set(0, 0.0725, 0); g.add(tab);
  return g;
}
export function makeCigar() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.0095, 0.0105, 0.15, 12), M(0x5b3a1e, 0.9));
  body.rotation.z = Math.PI / 2; g.add(body);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0108, 0.0108, 0.012, 12), M(0xc9a227, 0.4, 0.6)); band.rotation.z = Math.PI / 2; band.position.x = -0.02; g.add(band);
  const ash = new THREE.Mesh(new THREE.CylinderGeometry(0.0098, 0.0095, 0.02, 12), M(0x9a9a96, 1)); ash.rotation.z = Math.PI / 2; ash.position.x = 0.085; g.add(ash);
  const ember = new THREE.Mesh(new THREE.SphereGeometry(0.0095, 10, 8), new THREE.MeshStandardMaterial({ color: 0x331100, emissive: 0xff5a1a, emissiveIntensity: 1.5 }));
  ember.position.x = 0.097; ember.scale.x = 0.5; g.add(ember);
  g.userData = { ember, ash, body };
  return g;
}

/** Procedural ride-on mower with a driver. Local +Z is forward, +Y up, driver's right is -X. */
export function createMower(colorHex, { tag = '' } = {}) {
  const root = new THREE.Group(); root.rotation.order = 'YXZ';
  const tilt = new THREE.Group(); tilt.rotation.order = 'YXZ'; root.add(tilt);
  const paint = M(colorHex, 0.32, 0.25, { envMapIntensity: 1 });
  const dark = M(0x1c1d20, 0.7, 0.2), rubber = M(0x151515, 0.95), steel = M(0xa8adb3, 0.3, 0.9), seatM = M(0x17181a, 0.85);
  const add = (geo, m, x, y, z, parent = tilt) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; parent.add(o); return o; };

  // Chassis, hood, fenders, deck
  add(new THREE.BoxGeometry(0.78, 0.2, 1.7), dark, 0, 0.42, 0.0);
  const hood = add(new THREE.BoxGeometry(0.66, 0.3, 0.8), paint, 0, 0.66, 0.62);
  hood.geometry.translate(0, 0, 0); const hp = hood.geometry.attributes.position; for (let i = 0; i < hp.count; i++) if (hp.getZ(i) > 0 && hp.getY(i) > 0) hp.setX(i, hp.getX(i) * 0.84); hood.geometry.computeVertexNormals();
  add(new THREE.BoxGeometry(0.52, 0.2, 0.05), dark, 0, 0.62, 1.03);                       // grille
  for (const sx of [-1, 1]) {
    const hl = add(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshStandardMaterial({ color: 0xfff4d0, emissive: 0xfff0b0, emissiveIntensity: 1.2 }), sx * 0.22, 0.7, 1.02);
    hl.castShadow = false; hl.scale.z = 0.5;
  }
  const deck = add(new THREE.BoxGeometry(1.2, 0.1, 1.0), paint, 0, 0.2, 0.2);
  add(new THREE.BoxGeometry(0.16, 0.12, 0.34), dark, -0.65, 0.22, 0.22);                  // discharge chute (driver's right)
  for (const sx of [-1, 1]) {
    const fender = add(new THREE.BoxGeometry(0.3, 0.05, 0.9), paint, sx * 0.62, 0.66, -0.5);
    add(new THREE.BoxGeometry(0.3, 0.2, 0.05), paint, sx * 0.62, 0.56, -0.93).rotation.x = 0.3;
    add(new THREE.BoxGeometry(0.3, 0.2, 0.05), paint, sx * 0.62, 0.56, -0.07).rotation.x = -0.3;
  }
  // Wheels
  const wheels = { rear: [], front: [] };
  const mkWheel = (r, w, x, y, z, lug) => {
    const g = new THREE.Group(); g.position.set(x, y, z);
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 28), rubber); tire.rotation.z = Math.PI / 2; tire.castShadow = true; g.add(tire);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w * 1.02, 16), steel); hub.rotation.z = Math.PI / 2; g.add(hub);
    for (let i = 0; i < lug; i++) { const l = new THREE.Mesh(new THREE.BoxGeometry(w * 1.04, r * 0.12, r * 0.22), rubber); l.position.y = r * 0.97; const p = new THREE.Group(); p.rotation.x = (i / lug) * 6.2832; p.add(l); g.add(p); }
    const spin = new THREE.Group(); spin.add(g); tilt.add(spin); return { outer: spin, spin: g, r };
  };
  for (const sx of [-1, 1]) { wheels.rear.push(mkWheel(0.3, 0.22, sx * 0.62, 0.3, -0.5, 14)); wheels.front.push(mkWheel(0.2, 0.15, sx * 0.5, 0.2, 0.62, 10)); }

  // Seat, rollbar, steering
  add(new THREE.BoxGeometry(0.46, 0.1, 0.44), seatM, 0, 0.58, -0.38);
  const back = add(new THREE.BoxGeometry(0.44, 0.52, 0.09), seatM, 0, 0.88, -0.6); back.rotation.x = -0.12;
  for (const sx of [-1, 1]) add(new THREE.CylinderGeometry(0.022, 0.022, 1.2, 8), steel, sx * 0.34, 1.12, -0.7);
  add(new THREE.BoxGeometry(0.72, 0.05, 0.05), steel, 0, 1.72, -0.7);
  const col = add(new THREE.CylinderGeometry(0.025, 0.03, 0.55, 8), dark, 0, 0.95, 0.22); col.rotation.x = -0.75;
  const steerRot = new THREE.Group(); steerRot.position.set(0, 1.18, 0.05); steerRot.rotation.x = -0.75; tilt.add(steerRot);
  const swheel = new THREE.Group(); steerRot.add(swheel);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.022, 10, 28), M(0x111111, 0.6)); rim.castShadow = true; swheel.add(rim);
  for (let i = 0; i < 3; i++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.018, 0.02), dark); sp.rotation.z = (i / 3) * Math.PI; swheel.add(sp); }
  // Exhaust
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.35, 10), M(0x55555a, 0.4, 0.9), 0.3, 0.95, 0.3);
  // Cup holder + can (driver's right = -X)
  add(new THREE.TorusGeometry(0.045, 0.008, 6, 16), steel, -0.43, 0.7, -0.25).rotation.x = Math.PI / 2;
  add(new THREE.BoxGeometry(0.16, 0.025, 0.16), dark, -0.43, 0.62, -0.25);
  const holderCan = makeCan(); holderCan.position.set(-0.43, 0.745, -0.25); holderCan.castShadow = true; tilt.add(holderCan);

  // Driver
  const driver = new THREE.Group(); tilt.add(driver);
  const skin = M(0xe0ac84, 0.7), shirt = M(0x2a4d7a, 0.85), jeans = M(0x2b3547, 0.9), capM = M(0xb71c1c, 0.7);
  const torso = add(new THREE.BoxGeometry(0.38, 0.5, 0.22), shirt, 0, 0.98 + 0.0, -0.4, driver); torso.rotation.x = 0.08;
  const belly = add(new THREE.SphereGeometry(0.2, 12, 10), shirt, 0, 0.82, -0.32, driver); belly.scale.set(1.05, 0.85, 0.9);
  const head = add(new THREE.SphereGeometry(0.115, 16, 12), skin, 0, 1.4, -0.38, driver);
  const cap = add(new THREE.SphereGeometry(0.12, 14, 8, 0, 6.28, 0, 1.2), capM, 0, 1.43, -0.38, driver);
  add(new THREE.BoxGeometry(0.16, 0.012, 0.12), capM, 0, 1.43, -0.27, driver);
  add(new THREE.CylinderGeometry(0.12, 0.12, 0.012, 14), M(0x181818), 0, 1.42, -0.37, driver).scale.set(1, 1, 1);
  const shades = add(new THREE.BoxGeometry(0.19, 0.035, 0.03), M(0x050505, 0.2, 0.3), 0, 1.4, -0.275, driver);
  const stache = add(new THREE.BoxGeometry(0.09, 0.02, 0.03), M(0x4a3020, 0.9), 0, 1.34, -0.275, driver);
  for (const sx of [-1, 1]) {
    const th = add(new THREE.BoxGeometry(0.15, 0.14, 0.5), jeans, sx * 0.1, 0.68, -0.2, driver);
    const sh = add(new THREE.BoxGeometry(0.14, 0.45, 0.14), jeans, sx * 0.1, 0.4, 0.06, driver); sh.rotation.x = 0.35;
  }
  // Left arm (+X) on the wheel
  const armL = new THREE.Group(); armL.position.set(0.22, 1.15, -0.4); driver.add(armL);
  const uaL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.34), shirt); uaL.position.set(0, -0.02, 0.17); uaL.castShadow = true; armL.add(uaL); armL.rotation.set(0.6, -0.1, 0);
  // Right arm (-X): shoulder pivot -> forearm pivot -> hand holding the can
  const armR = new THREE.Group(); armR.position.set(-0.22, 1.15, -0.4); driver.add(armR);
  const uaR = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.3), shirt); uaR.position.set(0, 0, 0.15); uaR.castShadow = true; armR.add(uaR);
  const foreR = new THREE.Group(); foreR.position.set(0, 0, 0.3); armR.add(foreR);
  const faR = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.085, 0.28), skin); faR.position.set(0, 0, 0.14); faR.castShadow = true; foreR.add(faR);
  const handCan = makeCan(); handCan.position.set(0, 0.03, 0.3); foreR.add(handCan); handCan.visible = false;
  // cigar in mouth
  const cigar = makeCigar(); cigar.position.set(0.045, 1.335, -0.28); cigar.rotation.set(0, 0.0, 0.1); cigar.scale.setScalar(0.9); driver.add(cigar);
  cigar.rotation.y = Math.PI / 2; cigar.position.set(0.04, 1.34, -0.2);

  // Name tag sprite (optional)
  let tagSprite = null;
  if (tag) { tagSprite = makeTag(tag); tagSprite.position.set(0, 2.15, 0); root.add(tagSprite); }

  const api = {
    root, tilt, wheels, swheel, armR, foreR, armL, head, cigar, holderCan, handCan, tagSprite, driver,
    sip: 0, puff: 0,
    setTag(name) {
      if (tagSprite) { tagSprite.removeFromParent(); tagSprite.material.map.dispose(); tagSprite.material.dispose(); }
      tagSprite = makeTag(name); tagSprite.position.set(0, 2.15, 0); root.add(tagSprite); api.tagSprite = tagSprite;
    },
    /** sipT/puffT in 0..1 (animation phases), steer in rad, wheelSpin distance in m */
    pose({ x, z, h, y, pitch, roll, steer, dist, sipT, puffT, hideDriver, ember }) {
      root.position.set(x, y, z); root.rotation.set(0, h, 0);
      tilt.rotation.set(pitch, 0, roll);
      for (const w of wheels.rear) w.spin.rotation.x = dist / w.r;
      for (const w of wheels.front) { w.spin.rotation.x = dist / w.r; w.outer.rotation.y = steer; }
      swheel.rotation.z = -steer * 2.2;
      // sip: right arm raises the can to the mouth, head tips back
      const s = sipT, e = s < 0.5 ? smooth(0, 0.5, s) : 1 - smooth(0.78, 1, s);
      handCan.visible = e > 0.04; holderCan.visible = e <= 0.04;
      armR.rotation.set(lerp(0.55, -1.1, e), lerp(0.18, 0.0, e), 0);
      foreR.rotation.set(lerp(0.2, -1.45, e), 0, 0);
      head.rotation.x = -0.35 * e * Math.sin(Math.min(1, s * 1.2) * Math.PI) * 1.0;
      // puff: cigar brightens
      const pe = Math.sin(clamp(puffT, 0, 1) * Math.PI);
      cigar.userData.ember.material.emissiveIntensity = 0.7 + ember * 0.8 + pe * 4;
      driver.visible = !hideDriver;
      cigar.userData.ash.visible = ember > 0.02;
    },
  };
  return api;
}

function makeTag(name) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d'); g.font = 'bold 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(0,0,0,.45)'; const w = Math.min(250, g.measureText(name).width + 28); g.beginPath(); g.roundRect ? g.roundRect(128 - w / 2, 10, w, 44, 14) : g.rect(128 - w / 2, 10, w, 44); g.fill();
  g.fillStyle = '#fff'; g.fillText(name.slice(0, 16), 128, 33);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, transparent: true }));
  s.scale.set(1.6, 0.4, 1); return s;
}

/* ================================================================================================
 * Vehicle physics
 * ============================================================================================== */
export class MowerSim {
  constructor(spawn) { this.reset(spawn); }
  reset(sp) {
    this.x = sp.x; this.z = sp.z; this.h = sp.h; this.v = 0; this.steer = 0; this.y = terrainH(this.x, this.z);
    this.pitch = 0; this.roll = 0; this.pitchV = 0; this.dist = 0; this.fuel = 1; this.bag = 0; this.blades = true;
    this.rpm = 0.2; this.bump = 0; this.shake = 0; this.cutPending = 0; this.limp = false;
  }
  get fx() { return Math.sin(this.h); }
  get fz() { return Math.cos(this.h); }
  deck() { return { x: this.x + this.fx * 0.2, z: this.z + this.fz * 0.2 }; }
  /** inp: {throttle -1..1, steer -1..1 (right +), brake, boost}; ctx: {yard, others:[{x,z}], load, buzz, onGnome(i)} */
  step(inp, dt, ctx) {
    const wasV = this.v;
    this.limp = this.fuel <= 0.004;
    const boost = inp.boost && !this.limp && this.fuel > 0.02;
    const cap = (boost ? 9.0 : 6.2) * (this.limp ? 0.4 : 1);
    const load = ctx.load ?? 1;
    const target = inp.throttle > 0 ? inp.throttle * cap * load : inp.throttle * 2.8;
    let a;
    if (inp.brake) a = -Math.sign(this.v) * Math.min(Math.abs(this.v) / dt, 11);
    else a = clamp((target - this.v) * (boost ? 3.0 : 2.2), -6.5, boost ? 5.0 : 3.4);
    const [gx, gz] = terrainGrad(this.x, this.z);
    a -= 9.8 * (gx * this.fx + gz * this.fz) * 0.8;
    this.v += a * dt; this.v *= 1 - 0.04 * dt;

    const buzzWobble = (ctx.buzz || 0) * 0.16 * Math.sin(performance.now() * 0.0021) ;
    const steerT = (inp.steer + buzzWobble) * (0.66 - 0.3 * clamp(Math.abs(this.v) / 9, 0, 1));
    this.steer += (steerT - this.steer) * Math.min(1, dt * 8);
    const L = 1.25;
    let yaw = -(this.v / L) * Math.tan(this.steer);
    if (Math.abs(this.v) < 0.6) yaw += -inp.steer * 0.9 * (1 - Math.abs(this.v) / 0.6) * Math.min(1, Math.abs(inp.throttle) * 2);   // tight pivot at crawl
    this.h += yaw * dt;
    this.dist += this.v * dt;
    this.x += this.fx * this.v * dt; this.z += this.fz * this.v * dt;

    // Collisions: two circles along the body vs props, pond, house, bounds, other mowers
    this.bump = 0;
    const R = 0.62, offs = [0.6, -0.5];
    const Y = ctx.yard, H = YARD_HALF - 0.95;
    for (let pass = 0; pass < 2; pass++) {
      for (const off of offs) {
        const cx = this.x + this.fx * off, cz = this.z + this.fz * off;
        for (const c of Y.circles) {
          if (c.kind === 'gnome') {
            if (!ctx.gnomeDown?.[c.gi] && Math.hypot(c.x - cx, c.z - cz) < R + c.r && Math.abs(this.v) > 0.6) ctx.onGnome?.(c.gi);
            continue;
          }
          const dx = cx - c.x, dz = cz - c.z, d = Math.hypot(dx, dz), m = R + c.r;
          if (d < m && d > 1e-4) this.push(dx / d, dz / d, m - d);
        }
        for (const b of Y.boxes) {
          const qx = clamp(cx, b.x - b.hw, b.x + b.hw), qz = clamp(cz, b.z - b.hd, b.z + b.hd);
          const dx = cx - qx, dz = cz - qz, d = Math.hypot(dx, dz);
          if (d < R && d > 1e-4) this.push(dx / d, dz / d, R - d);
          else if (d <= 1e-4) this.push(0, 1, R);
        }
        for (const o of ctx.others || []) {
          const dx = cx - o.x, dz = cz - o.z, d = Math.hypot(dx, dz), m = R + 0.8;
          if (d < m && d > 1e-4) this.push(dx / d, dz / d, (m - d) * 0.6);
        }
        if (Math.abs(cx) > H) { this.x -= Math.sign(cx) * (Math.abs(cx) - H); this.hit(Math.sign(cx), 0); }
        if (Math.abs(cz) > H) { this.z -= Math.sign(cz) * (Math.abs(cz) - H); this.hit(0, Math.sign(cz)); }
      }
    }
    // Ground following + suspension
    const ty = terrainH(this.x, this.z);
    this.y += (ty - this.y) * Math.min(1, dt * 25);
    const slopeF = gx * this.fx + gz * this.fz;
    const lx = this.fz, lz = -this.fx;
    const slopeL = gx * lx + gz * lz;
    const accel = (this.v - wasV) / Math.max(dt, 1e-4);
    const pitchT = -Math.atan(slopeF) - clamp(accel, -8, 8) * 0.006 + this.shake * 0.02 * Math.sin(performance.now() * 0.05);
    this.pitchV += ((pitchT - this.pitch) * 60 - this.pitchV * 9) * dt; this.pitch += this.pitchV * dt;
    const rollT = Math.atan(slopeL) + (-yaw * this.v * 0.012);
    this.roll += (rollT - this.roll) * Math.min(1, dt * 8);
    this.shake = Math.max(0, this.shake - dt * 3);

    // Fuel + rpm
    const burn = 0.0042 + 0.007 * Math.abs(inp.throttle) + (this.blades ? 0.0025 : 0) + (boost ? 0.012 : 0);
    this.fuel = Math.max(0, this.fuel - burn * dt * (this.limp ? 0 : 1));
    const rpmT = 0.22 + 0.5 * clamp(Math.abs(this.v) / 8, 0, 1) + 0.15 * Math.abs(inp.throttle) + (this.blades ? 0.08 : 0) + (boost ? 0.1 : 0);
    this.rpm += (rpmT - this.rpm) * Math.min(1, dt * 4);
    this.boosting = boost;
  }
  push(nx, nz, depth) {
    this.x += nx * depth; this.z += nz * depth;
    const vn = (this.fx * nx + this.fz * nz) * this.v;
    if (vn < 0) { this.bump = Math.max(this.bump, Math.min(1, -vn / 5)); this.shake = Math.max(this.shake, Math.min(1, -vn / 4)); this.v *= 0.35; }
  }
  hit(nx, nz) { this.bump = Math.max(this.bump, Math.min(1, Math.abs(this.v) / 5)); this.shake = Math.max(this.shake, 0.4); this.v *= 0.4; }
}
