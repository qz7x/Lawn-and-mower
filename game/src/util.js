export const TSCALE = 0.2;
/** JS mirror of GLSL terrain(): keeps the mower, camera and blades on the same surface. */
export function terrainH(x, z) {
  let h = 1.1 * Math.sin(0.0171 * x + 0.6) * Math.sin(0.0137 * z + 1.9);
  h += 0.6 * Math.sin(0.0399 * x - 0.0283 * z + 2.2);
  h += 0.18 * Math.sin(0.131 * x + 0.4) * Math.cos(0.097 * z);
  h += 0.035 * Math.sin(0.73 * x + 0.61 * z);
  return h * TSCALE;
}
export function terrainGrad(x, z) {
  const e = 0.3;
  return [(terrainH(x + e, z) - terrainH(x - e, z)) / (2 * e), (terrainH(x, z + e) - terrainH(x, z - e)) / (2 * e)];
}
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const rid = (n = 8) => Array.from({ length: n }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[(Math.random() * 31) | 0]).join('');
export function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
export function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
export const store = {
  get(k, d) { return safe(() => { const v = localStorage.getItem('bnb.' + k); return v == null ? d : JSON.parse(v); }, d); },
  set(k, v) { safe(() => localStorage.setItem('bnb.' + k, JSON.stringify(v))); },
};
