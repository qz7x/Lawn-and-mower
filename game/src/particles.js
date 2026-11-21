import * as THREE from 'three';

/** Single draw-call soft-sprite particle pool (smoke, grass clippings, dust). */
export class Particles {
  constructor(max, vs, fs) {
    this.max = max; this.i = 0;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.age = new Float32Array(max).fill(1e9); this.life = new Float32Array(max).fill(1);
    this.base = new Float32Array(max * 4); this.s0 = new Float32Array(max); this.grow = new Float32Array(max); this.grav = new Float32Array(max); this.drag = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.uniforms = { uScale: { value: 800 } };
    this.mesh = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms: this.uniforms, transparent: true, depthWrite: false }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 5;
  }
  spawn(x, y, z, vx, vy, vz, life, size, c, grow = 0, grav = 0, drag = 0.5) {
    const k = this.i; this.i = (this.i + 1) % this.max;
    this.pos[k * 3] = x; this.pos[k * 3 + 1] = y; this.pos[k * 3 + 2] = z;
    this.vel[k * 3] = vx; this.vel[k * 3 + 1] = vy; this.vel[k * 3 + 2] = vz;
    this.age[k] = 0; this.life[k] = life; this.s0[k] = size; this.grow[k] = grow; this.grav[k] = grav; this.drag[k] = drag;
    this.base[k * 4] = c[0]; this.base[k * 4 + 1] = c[1]; this.base[k * 4 + 2] = c[2]; this.base[k * 4 + 3] = c[3];
  }
  update(dt, wind) {
    for (let k = 0; k < this.max; k++) {
      const a = this.age[k];
      if (a >= this.life[k]) { this.col[k * 4 + 3] = 0; this.size[k] = 0; continue; }
      this.age[k] = a + dt;
      const d = Math.exp(-this.drag[k] * dt);
      this.vel[k * 3] = this.vel[k * 3] * d + (wind ? wind[0] : 0) * dt * 0.4;
      this.vel[k * 3 + 1] = this.vel[k * 3 + 1] * d - this.grav[k] * dt;
      this.vel[k * 3 + 2] = this.vel[k * 3 + 2] * d + (wind ? wind[1] : 0) * dt * 0.4;
      this.pos[k * 3] += this.vel[k * 3] * dt; this.pos[k * 3 + 1] += this.vel[k * 3 + 1] * dt; this.pos[k * 3 + 2] += this.vel[k * 3 + 2] * dt;
      const t = this.age[k] / this.life[k];
      this.col[k * 4] = this.base[k * 4]; this.col[k * 4 + 1] = this.base[k * 4 + 1]; this.col[k * 4 + 2] = this.base[k * 4 + 2];
      this.col[k * 4 + 3] = this.base[k * 4 + 3] * Math.min(1, t * 8) * (1 - t);
      this.size[k] = this.s0[k] * (1 + this.grow[k] * t);
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = g.attributes.aCol.needsUpdate = g.attributes.aSize.needsUpdate = true;
  }
}
