// Procedural geometry builders. No external assets.
//
// Foliage vertices use a *local frame* encoding that the vertex shader expands
// along an analytically bent centre-line:
//   position = (x, y, z) offset in the moving frame (A = lateral, N = face normal, T = tangent),
//              multiplied in the shader by the instance's half-width `w`
//   normal   = shading normal in the same frame (V-fold profile baked in)
//   uv       = (t along the centre-line 0..1, s lateral coordinate -1..1  |  part id for stalks)
import * as THREE from 'three';

/** Accumulates vertices/triangles; auto-fixes winding so geometric normal agrees with the shading normal. */
class MeshBuilder {
  constructor() { this.p = []; this.q = []; this.n = []; this.uv = []; this.idx = []; }
  /** `vz` is a virtual along-centre-line coordinate used only to orient triangles (blade rows share local z = 0). */
  vert(px, py, pz, nx, ny, nz, u, v, vz = pz) {
    this.p.push(px, py, pz); this.q.push(px, py, vz); this.n.push(nx, ny, nz); this.uv.push(u, v);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) {
    const P = this.q, N = this.n;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const e1 = [P[b * 3] - ax, P[b * 3 + 1] - ay, P[b * 3 + 2] - az];
    const e2 = [P[c * 3] - ax, P[c * 3 + 1] - ay, P[c * 3 + 2] - az];
    const gx = e1[1] * e2[2] - e1[2] * e2[1];
    const gy = e1[2] * e2[0] - e1[0] * e2[2];
    const gz = e1[0] * e2[1] - e1[1] * e2[0];
    const nx = N[a * 3] + N[b * 3] + N[c * 3];
    const ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1];
    const nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    if (gx * gx + gy * gy + gz * gz < 1e-14) return; // degenerate
    if (gx * nx + gy * ny + gz * nz < 0) this.idx.push(a, c, b); else this.idx.push(a, b, c);
  }
  build() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    return g;
  }
}

const norm3 = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };

/** Leaf-blade outline: broad shoulder, long acuminate tip (grass-like). */
export function bladeTaper(t) {
  const sheath = 0.62 + 0.38 * smooth(0.0, 0.18, t);          // narrow where it leaves the sheath
  const tip = t < 0.28 ? 1 : Math.pow(Math.max(1 - t, 0) / 0.72, 0.8);
  return sheath * tip;
}
function smooth(a, b, x) { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); }

/**
 * Tapered, multi-segment blade with a V-fold cross-section.
 * @param segs number of segments along the blade (rows = segs, plus a single apex vertex)
 * @param cols 3 -> left/rib/right (V-fold), 2 -> flat ribbon (far LODs)
 */
export function buildBladeGeometry({ segs = 7, cols = 3, fold = 0.42 } = {}) {
  const b = new MeshBuilder();
  const rows = [];
  for (let i = 0; i < segs; i++) {
    const u = i / segs;
    const t = u;
    const tp = bladeTaper(t);
    const row = [];
    const ss = cols === 3 ? [-1, 0, 1] : [-1, 1];
    for (const s of ss) {
      const x = s * tp;
      const y = fold * Math.abs(s) * tp;                 // edges curl toward the adaxial face
      // profile slope dy/dx = fold*sign(s) -> normal in the (A,N) plane
      const slope = cols === 3 ? fold * Math.sign(s) : 0;
      let nn = norm3(-slope, 1, 0);
      if (cols === 3 && s === 0) nn = [0, 1, 0];          // rib: averaged normal
      row.push(b.vert(x, y, 0, nn[0], nn[1], nn[2], t, s, t));
    }
    rows.push(row);
  }
  const apex = b.vert(0, 0, 0, 0, 1, 0, 1, 0, 1);
  for (let i = 0; i < rows.length - 1; i++) {
    for (let c = 0; c < rows[i].length - 1; c++) {
      const a = rows[i][c], bb = rows[i][c + 1], cc = rows[i + 1][c], d = rows[i + 1][c + 1];
      b.tri(a, cc, bb); b.tri(bb, cc, d);
    }
  }
  const last = rows[rows.length - 1];
  for (let c = 0; c < last.length - 1; c++) b.tri(last[c], apex, last[c + 1]);
  return b.build();
}

/**
 * Wild seed stalk: three-sided culm + spiral foxtail-style spikelets + awns.
 * Units: millimetres (the shader multiplies by w = size * 1mm), uv.y = part id (0 stem, 1 floret, 2 awn).
 */
export function buildStalkGeometry({ stemRows = 9, florets = 11, awns = true } = {}) {
  const b = new MeshBuilder();
  const R = 1.35;                      // culm radius (mm)
  const headStart = 0.70, headEnd = 0.985;
  const rows = [];
  for (let i = 0; i < stemRows; i++) {
    const t = i / (stemRows - 1) * 0.995;
    const r = R * (1.0 - 0.45 * t) * (t > headStart ? 1.15 : 1.0);
    const row = [];
    for (let k = 0; k < 3; k++) {
      const a = Math.PI / 2 + k * 2 * Math.PI / 3;
      row.push(b.vert(Math.cos(a) * r, Math.sin(a) * r, 0, Math.cos(a), Math.sin(a), 0, t, 0));
    }
    rows.push(row);
  }
  for (let i = 0; i < rows.length - 1; i++) {
    for (let k = 0; k < 3; k++) {
      const k2 = (k + 1) % 3;
      b.tri(rows[i][k], rows[i + 1][k], rows[i][k2]); b.tri(rows[i][k2], rows[i + 1][k], rows[i + 1][k2]);
    }
  }
  // Spikelets: golden-angle spiral around the culm.
  const golden = 2.399963;
  for (let i = 0; i < florets; i++) {
    const f = i / (florets - 1);
    const t0 = headStart + (headEnd - headStart) * f;
    const phi = i * golden;
    const rx = Math.cos(phi), ry = Math.sin(phi);
    const len = 7.5 * (1.0 - 0.45 * f * f) * (0.85 + 0.15 * Math.sin(i * 12.9));     // mm
    const wid = 1.9 * (1.0 - 0.3 * f);
    // axis leans outward then up (z = along the culm tangent)
    const out = 0.55, up = 0.84;
    const ax = rx * out, ay = ry * out, az = up;
    // tangential direction in the x/y plane
    const tx = -ry, ty = rx;
    const base = [rx * R * 0.9, ry * R * 0.9, 0];
    const mid = [base[0] + ax * len * 0.45, base[1] + ay * len * 0.45, base[2] + az * len * 0.45];
    const tip = [base[0] + ax * len, base[1] + ay * len, base[2] + az * len];
    const nrm = norm3(rx * up - 0 , ry * up, -out);            // faces outward/down-ish
    const v0 = b.vert(base[0], base[1], base[2], nrm[0], nrm[1], nrm[2], t0, 1);
    const v1 = b.vert(mid[0] + tx * wid, mid[1] + ty * wid, mid[2], nrm[0], nrm[1], nrm[2], t0, 1);
    const v2 = b.vert(mid[0] - tx * wid, mid[1] - ty * wid, mid[2], nrm[0], nrm[1], nrm[2], t0, 1);
    const v3 = b.vert(tip[0], tip[1], tip[2], nrm[0], nrm[1], nrm[2], t0, 1);
    b.tri(v0, v1, v2); b.tri(v1, v3, v2);
    if (awns) {
      // bristle: very thin long triangle continuing the spikelet axis, splayed outward
      const al = 15 * (0.8 + 0.2 * Math.cos(i * 7.3));
      const dir = norm3(ax * 1.15, ay * 1.15, az * 0.8);
      const ab = tip;
      const at = [ab[0] + dir[0] * al, ab[1] + dir[1] * al, ab[2] + dir[2] * al];
      const aw = 0.28;
      const n2 = norm3(rx, ry, 0.2);
      const a0 = b.vert(ab[0] + tx * aw, ab[1] + ty * aw, ab[2], n2[0], n2[1], n2[2], t0, 2);
      const a1 = b.vert(ab[0] - tx * aw, ab[1] - ty * aw, ab[2], n2[0], n2[1], n2[2], t0, 2);
      const a2 = b.vert(at[0], at[1], at[2], n2[0], n2[1], n2[2], Math.min(t0 + 0.02, 1.0), 2);
      b.tri(a0, a2, a1);
    }
  }
  return b.build();
}

/**
 * Trifoliate clover leaf. Unit space: petiole rises along +Y to y=1, three leaflets fan out horizontally.
 * uv = (u along leaflet 0..1, v across -1..1); wind stiffness derives from position.y in the shader.
 */
export function buildCloverGeometry() {
  const b = new MeshBuilder();
  // petiole: thin 3-prism, 4 rows
  const rows = [];
  const R = 0.018;
  for (let i = 0; i <= 4; i++) {
    const y = i / 4;
    const row = [];
    for (let k = 0; k < 3; k++) {
      const a = k * 2 * Math.PI / 3 + 0.5;
      row.push(b.vert(Math.cos(a) * R, y, Math.sin(a) * R, Math.cos(a), 0, Math.sin(a), -1.0, 0));
    }
    rows.push(row);
  }
  for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) {
    const k2 = (k + 1) % 3;
    b.tri(rows[i][k], rows[i + 1][k], rows[i][k2]); b.tri(rows[i][k2], rows[i + 1][k], rows[i + 1][k2]);
  }
  // leaflets
  const L = 0.42, fold = 0.14;
  const URows = [0, 0.30, 0.62, 0.88, 1.0];                  // rows concentrate where the outline curves
  const rowsU = URows.length - 1;
  const outline = u => 0.37 * Math.sin(Math.PI * Math.pow(u, 0.72)) * (1.0 - 0.18 * u);   // obovate-ish
  for (let leaf = 0; leaf < 3; leaf++) {
    const phi = leaf * 2 * Math.PI / 3 + 0.35;
    const lat = [-Math.sin(phi), 0, Math.cos(phi)];
    const ax0 = norm3(Math.cos(phi), 0.30, Math.sin(phi));
    const nrm0 = norm3(...cross(lat, ax0));
    const point = (u, v) => {
      const w = outline(u);
      const s = u * L;
      const droop = -0.55 * s * s;
      return [
        ax0[0] * s + lat[0] * v * w + nrm0[0] * (fold * Math.abs(v) * w + droop),
        1.0 + ax0[1] * s + lat[1] * v * w + nrm0[1] * (fold * Math.abs(v) * w + droop),
        ax0[2] * s + lat[2] * v * w + nrm0[2] * (fold * Math.abs(v) * w + droop),
      ];
    };
    const grid = [];
    for (let j = 0; j <= rowsU; j++) {
      const u = URows[j]; const r = [];
      for (const v of [-1, 0, 1]) {
        const p = point(u, v);
        const e = 1e-3;
        const du = sub(point(Math.min(u + e, 1), v), point(Math.max(u - e, 0), v));
        const dv = sub(point(u, Math.min(v + e, 1)), point(u, Math.max(v - e, -1)));
        let n = cross(du, dv);
        if (Math.hypot(...n) < 1e-9) n = nrm0;
        n = norm3(...n); if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
        r.push(b.vert(p[0], p[1], p[2], n[0], n[1], n[2], u, v));
      }
      grid.push(r);
    }
    for (let j = 0; j < rowsU; j++) for (let c = 0; c < 2; c++) {
      b.tri(grid[j][c], grid[j + 1][c], grid[j][c + 1]); b.tri(grid[j][c + 1], grid[j + 1][c], grid[j + 1][c + 1]);
    }
  }
  return b.build();
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Log-spaced polar grid following the camera: fine near the viewer, reaching the horizon. */
export function buildGroundGeometry({ rings = 140, segs = 176, r0 = 0.4, growth = 1.045 } = {}) {
  const pos = [];
  pos.push(0, 0, 0);
  let r = 0, step = r0;
  for (let i = 1; i <= rings; i++) {
    r += step; step *= growth;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  const idx = [];
  for (let s = 0; s < segs; s++) idx.push(0, 1 + (s + 1) % segs, 1 + s);          // centre fan (faces +Y)
  for (let i = 0; i < rings - 1; i++) {
    const a0 = 1 + i * segs, a1 = 1 + (i + 1) * segs;
    for (let s = 0; s < segs; s++) {
      const s2 = (s + 1) % segs;
      idx.push(a0 + s, a0 + s2, a1 + s); idx.push(a0 + s2, a1 + s2, a1 + s);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return g;
}
