// All GLSL lives here, split into composable chunks. Everything is analytic / procedural.
// Conventions: Y up, metres, linear-HDR radiance. `uSunCol` is "E/pi" (so diffuse = albedo * uSunCol * N.L).

/* ------------------------------------------------------------------------------------------------
 * COMMON: uniforms, integer hashing, terrain, wind field, sky + height-fog. Safe in VS and FS.
 * ---------------------------------------------------------------------------------------------- */
export const COMMON = /* glsl */`
uniform float uTime;
uniform vec3  uSunDir;      // unit vector pointing TOWARD the sun
uniform vec3  uSunCol;
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uSunHalo;
uniform vec3  uAmbUp;
uniform vec3  uAmbHor;
uniform vec3  uAmbDown;
uniform vec3  uAmbSun;
uniform vec2  uWindDir;
uniform float uWindAmt;
uniform float uDew;
uniform vec2  uRes;         // drawing-buffer size in pixels
uniform vec2  uFog;         // x: ground-level extinction (1/m), y: height falloff (1/m)
uniform float uFieldScale;  // 1 / tile size (m) of the baked meadow-ecology map
uniform sampler2D uField;   // R tall-stand, G clover, B dry/thatch, A lushness
uniform sampler2D uNoise;   // tileable fbm, 4 independent channels

#define PI 3.14159265359
const vec2 FIELD_OFS = vec2(456.0, 344.0);   // chosen so the default view mixes sward, tall stands, clover and thatch
vec2 fieldUV(vec2 p){ return (p + FIELD_OFS) * uFieldScale; }

// ---- PCG integer hash ---------------------------------------------------------------------------
uint pcg(uint v){
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float u01(uint h){ return float(h >> 8u) * 5.9604645e-8; }
uint  ihash(ivec2 c, uint salt){ return pcg(uint(c.x) * 1664525u + pcg(uint(c.y) + salt * 2654435761u)); }
float rnd(uint s, uint k){ return u01(pcg(s + k * 2654435769u)); }

// ---- Tussocks: a world-aligned jittered grid shared by the blade VS and the soil FS --------------
const float TS = 0.5;
vec2  tussockCenter(ivec2 id){
  uint h = ihash(id, 7u);
  return (vec2(id) + vec2(0.2 + 0.6 * u01(h), 0.2 + 0.6 * u01(pcg(h ^ 0xA511E9B3u)))) * TS;
}
float tussockVigor(ivec2 id){ return u01(ihash(id, 13u)); }

// ---- Terrain: analytic sum of sines; returns (height, dh/dx, dh/dz). Mirrored in JS. ---------------
vec3 terrain(vec2 p){
  float a1x = 0.0171 * p.x + 0.6, a1z = 0.0137 * p.y + 1.9;
  float s1x = sin(a1x), c1x = cos(a1x), s1z = sin(a1z), c1z = cos(a1z);
  float h  = 1.1 * s1x * s1z;
  float dx = 1.1 * 0.0171 * c1x * s1z;
  float dz = 1.1 * 0.0137 * s1x * c1z;
  float a2 = 0.0399 * p.x - 0.0283 * p.y + 2.2;
  h += 0.6 * sin(a2); dx += 0.6 * 0.0399 * cos(a2); dz -= 0.6 * 0.0283 * cos(a2);
  float a3x = 0.131 * p.x + 0.4, a3z = 0.097 * p.y;
  h  += 0.18 * sin(a3x) * cos(a3z);
  dx += 0.18 * 0.131 * cos(a3x) * cos(a3z);
  dz -= 0.18 * 0.097 * sin(a3x) * sin(a3z);
  float a4 = 0.73 * p.x + 0.61 * p.y;
  h += 0.035 * sin(a4); dx += 0.035 * 0.73 * cos(a4); dz += 0.035 * 0.61 * cos(a4);
  return vec3(h, dx, dz);
}

// ---- Wind: rolling gust fronts + advected turbulence, 0..~1.6 --------------------------------------
float windGust(vec2 p){
  vec2 wd = normalize(uWindDir);
  float n1 = textureLod(uNoise, p * 0.0105 - wd * uTime * 0.028,       0.0).r;
  float n2 = textureLod(uNoise, p * 0.0410 - wd * uTime * 0.095 + 0.37, 0.0).g;
  float n3 = textureLod(uNoise, p * 0.1700 - wd * uTime * 0.300 + 0.71, 0.0).b;
  float band = 0.5 + 0.5 * sin(dot(p, wd) * 0.075 - uTime * 1.15 + n1 * 6.0);   // travelling swell fronts
  band = band * band * (3.0 - 2.0 * band);
  float g = 0.22 + 0.62 * band * (0.55 + 0.9 * n1) + 0.55 * (n2 - 0.5) + 0.25 * (n3 - 0.5);
  return clamp(g, 0.0, 1.6);
}

// ---- Sky (analytic, uniform-driven so JS owns the atmosphere state) --------------------------------
vec3 skyRadiance(vec3 d){
  float h  = max(d.y, 0.0);
  float mu = dot(d, uSunDir);
  float hz = pow(1.0 - h, 5.0);
  vec2  dh = normalize(d.xz + vec2(1e-5)), sh = normalize(uSunDir.xz + vec2(1e-5));
  float az = 0.5 + 0.5 * dot(dh, sh);
  vec3  hor = mix(uHorizon * vec3(0.62, 0.55, 0.70), uHorizon, pow(az, 1.6));   // cooler anti-solar horizon
  vec3  col = mix(uZenith, hor, hz);
  float g = 0.78;
  float phase = (1.0 - g * g) / (4.0 * PI * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-3), 1.5));
  col += uSunHalo * phase * (0.35 + 1.4 * hz);
  return col;
}
vec3 skyAmbient(vec3 n){
  float y = n.y;
  vec3 c = y > 0.0 ? mix(uAmbHor, uAmbUp, pow(y, 0.65)) : mix(uAmbHor, uAmbDown, pow(-y, 0.65));
  vec3 sh = normalize(vec3(uSunDir.x, 0.15, uSunDir.z));
  c += uAmbSun * pow(max(dot(n, sh), 0.0), 2.0);
  return c;
}

// ---- Analytic exponential-height fog with sky-matched in-scatter (seamless horizon) ------------------
float fogOD(vec3 ro, vec3 rd, float t){
  float a = uFog.x, b = uFog.y;
  float k = b * rd.y;
  float f = abs(k * t) < 1e-3 ? t : (1.0 - exp(-k * t)) / k;
  return a * exp(-b * ro.y) * f;
}
vec3 applyFog(vec3 col, vec3 P){
  vec3 d = P - cameraPosition;
  float t = length(d);
  vec3 rd = d / max(t, 1e-4);
  float fe = exp(-fogOD(cameraPosition, rd, t));
  vec3 fdir = normalize(vec3(rd.x, max(rd.y, 0.0) * 0.6 + 0.02, rd.z));
  return mix(skyRadiance(fdir), col, fe);
}
`;

/* ------------------------------------------------------------------------------------------------
 * LEAF LIGHTING: thin-slab translucency (Beer-Lambert through chlorophyll), wrap-diffuse, GGX cuticle,
 * Kajiya-Kay rib sheen, dew beads, canopy self-shadowing. Shared by blades, stalks and clover.
 * ---------------------------------------------------------------------------------------------- */
export const LEAF_LIGHTING = /* glsl */`
float D_GGX(float NoH, float a){ float a2 = a * a; float d = NoH * NoH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d + 1e-7); }
float V_Smith(float NoV, float NoL, float a){
  float gv = NoL * (NoV * (1.0 - a) + a), gl = NoV * (NoL * (1.0 - a) + a);
  return 0.5 / (gv + gl + 1e-5);
}
float F_Schlick(float VoH, float f0){ return f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0); }

struct Leaf {
  vec3  albedo;
  vec3  N;        // shading normal, already facing the viewer
  vec3  T;        // centre-line tangent (world)
  vec3  sigma;    // per-channel absorption (1/thickness-unit)
  float thick;    // optical thickness at this point
  float rough;    // perceptual roughness
  float rib;      // 0..1 central-rib mask (wet film sits here)
  float ao;       // ambient occlusion
  float sunVis;   // canopy sun visibility
  float fp;       // pixel-footprint / blade-width (0 = resolved, >1 = sub-pixel)
  vec3  tint;     // colour of transmitted light
};

vec3 shadeLeaf(Leaf s, vec3 V){
  vec3  L   = uSunDir;
  vec3  N   = s.N;
  float NoL = dot(N, L);
  float NoV = clamp(dot(N, V), 1e-3, 1.0);
  float vis = 1.0 - smoothstep(0.15, 0.7, s.fp);              // detail that is still resolvable

  // Front-lit diffuse with wrap (leaf scatters light laterally inside the mesophyll).
  float wrap = 0.30;
  float lamb = max(NoL, 0.0);
  float wr   = clamp((NoL + wrap) / (1.0 + wrap), 0.0, 1.0);
  vec3  col  = s.albedo * uSunCol * s.sunVis * (lamb + (wr - lamb) * vec3(1.0, 0.72, 0.30));

  // Back-lit translucency: light enters the far face, is attenuated through the slab, exits toward the eye.
  float backCos = max(-NoL, 0.0);
  float path    = s.thick / max(abs(NoL), 0.28);
  vec3  Tr      = exp(-s.sigma * path);
  vec3  Ht      = normalize(L + N * 0.38);                     // distorted half-vector (Barre-Brisebois)
  float lobe    = pow(clamp(dot(V, -Ht), 0.0, 1.0), 5.0);
  float fwd     = pow(clamp(dot(V, -L), 0.0, 1.0), 2.5);       // Henyey-Greenstein-like forward peak
  float lobeF   = mix(lobe, 0.30, smoothstep(0.25, 1.0, s.fp));
  vec3  trans   = uSunCol * s.sunVis * Tr * s.tint * (0.60 * backCos + 1.35 * lobeF * (0.5 + 0.5 * fwd));
  col += trans;

  // Multi-bounce fill: light scattered by neighbouring blades fills canopy shadow.
  col += s.albedo * uSunCol * (1.0 - s.sunVis) * 0.075 * (0.4 + 0.6 * clamp(L.y * 3.0, 0.0, 1.0));

  // Sky irradiance on both faces (back face gets the transmitted share).
  vec3 amb = skyAmbient(N) + skyAmbient(-N) * Tr * 0.45;
  col += s.albedo * amb * s.ao;

  // Cuticle specular: GGX with a thin water film that smooths the rib.
  float r = mix(s.rough, 0.10, s.rib * uDew * vis);
  r = sqrt(r * r + s.fp * s.fp * 0.20);                         // footprint-widened roughness (Toksvig-style)
  float a = max(r * r, 0.02);
  vec3  H = normalize(L + V);
  float NoH = clamp(dot(N, H), 0.0, 1.0), VoH = clamp(dot(V, H), 0.0, 1.0);
  float NoLs = max(NoL, 0.0);
  float F = F_Schlick(VoH, 0.05);
  col += uSunCol * PI * D_GGX(NoH, a) * V_Smith(NoV, NoLs, a) * F * NoLs * s.sunVis * s.ao * (1.0 - 0.7 * smoothstep(0.3, 1.0, s.fp));

  // Kajiya-Kay streak along the rib (fibre-like highlight that races down the blade in the wind).
  float TH = dot(normalize(s.T), H);
  float sinTH = sqrt(max(1.0 - TH * TH, 0.0));
  col += uSunCol * s.sunVis * pow(sinTH, 120.0) * s.rib * uDew * vis * 1.4 * (0.3 + 0.7 * NoLs);

  // Sky reflection (picks up wind ripples through the recomputed normal).
  vec3  R   = reflect(-V, N);
  vec3  env = mix(skyRadiance(normalize(vec3(R.x, max(R.y, 0.03), R.z))), skyAmbient(R), clamp(r * 1.3, 0.0, 1.0));
  col += env * F_Schlick(NoV, 0.045) * pow(1.0 - r, 2.0) * 1.3 * s.ao * (1.0 - 0.9 * smoothstep(0.15, 0.9, s.fp));
  return col;
}

// Dew droplets: returns (mask, local offset x, local offset y) of a bead in a square lattice (cell ~ 3 mm).
vec3 dewBeads(vec2 q, float seed, float fp){
  ivec2 ci = ivec2(floor(q));
  uint h = ihash(ci, uint(seed * 977.0) + 5u);
  if (u01(h) > 0.16) return vec3(0.0);
  vec2 c = vec2(0.5 + 0.22 * (u01(pcg(h ^ 1u)) - 0.5), 0.5 + 0.40 * (u01(pcg(h ^ 2u)) - 0.5));
  float rr = 0.26 + 0.16 * u01(pcg(h ^ 3u));
  vec2 d = (fract(q) - c) / rr;
  float k = 1.0 - dot(d, d);
  float fade = 1.0 - smoothstep(0.03, 0.14, fp);
  return k > 0.0 ? vec3(fade, d) : vec3(0.0);
}
`;

/* ------------------------------------------------------------------------------------------------
 * CANOPY: analytic mean-colour model of the unresolved meadow (used for the far field of the soil and as the
 * convergence target for sub-pixel blades, so the grass -> ground handoff has no seam and no shimmer).
 * ---------------------------------------------------------------------------------------------- */
export const CANOPY = /* glsl */`
vec3 canopyAlbedo(vec4 f, float n){
  vec3 green = vec3(0.060, 0.185, 0.024);
  vec3 dryG  = vec3(0.30, 0.235, 0.075);
  vec3 clov  = vec3(0.040, 0.150, 0.038);
  vec3 tallC = vec3(0.20, 0.215, 0.065);
  vec3 c = mix(green, dryG, f.z * 0.9);
  c = mix(c, clov, f.y);
  c = mix(c, tallC, f.x * 0.6);
  c *= 0.78 + 0.44 * n;
  return mix(vec3(0.05, 0.036, 0.022), c, smoothstep(0.05, 0.5, f.w) * 0.85 + 0.15);
}
vec3 canopyShade(vec3 P, vec3 V, vec3 Ng, vec4 f){
  vec2  p  = P.xz;
  vec3  L  = uSunDir;
  vec2  wd = normalize(uWindDir);
  float sinEl   = max(uSunDir.y, 0.12);
  float canopyH = mix(0.24, 0.5, f.x) * mix(0.75, 1.15, f.w) * (1.0 - 0.6 * f.y);
  float gustF = windGust(p);
  vec3  canA  = canopyAlbedo(f, texture(uNoise, p * 0.17).b);
  // wind ripples tilt the mean canopy normal; the gust field is the same one that bends the blades
  vec3  Nc = normalize(vec3(Ng.x * 0.5, 1.0, Ng.z * 0.5) + vec3(wd.x, 0.0, wd.y) * (gustF - 0.55) * 0.55 * uWindAmt);
  float sunVisC = exp(-1.2 * canopyH / sinEl * 0.6);
  vec3  c = canA * (uSunCol * max(dot(Nc, L), 0.0) * sunVisC + skyAmbient(Nc));
  // backlit canopy glow (blades are translucent): peaks when looking toward the sun
  float glow = pow(clamp(dot(-V, vec3(L.x, 0.0, L.z) / max(length(L.xz), 1e-3)), 0.0, 1.0), 3.0);
  c += uSunCol * canA * vec3(1.0, 1.1, 0.35) * glow * 0.85 * (0.5 + 0.5 * clamp(gustF, 0.0, 1.0));
  // grazing sheen riding the wind ripples
  vec3  Rc = reflect(-V, Nc);
  float Fc = 0.04 + 0.96 * pow(1.0 - clamp(dot(Nc, V), 0.0, 1.0), 5.0);
  c += skyRadiance(normalize(vec3(Rc.x, max(Rc.y, 0.03), Rc.z))) * Fc * 0.55;
  return c;
}
`;

/* ------------------------------------------------------------------------------------------------
 * GRASS VERTEX SHADER (blades and seed stalks via -D STALK)
 *   - GPU-hashed instancing in camera-snapped, world-aligned cells (no instance buffers)
 *   - tussock clumping, multi-species selection from the baked ecology field
 *   - analytic bent centre-line, Frenet-style frame => analytic normals under wind
 *   - pixel-footprint widening + coverage for distance anti-aliasing
 * ---------------------------------------------------------------------------------------------- */
export const GRASS_VS = /* glsl */`
uniform vec4  uRing;     // inner radius, outer radius, half crossfade band, cell size
uniform vec4  uRingB;    // blades per cell, grid cells per side, tussocks per cell side, width compensation
uniform float uSalt;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vFlat;
varying vec3  vTan;
varying vec2  vUv;
varying vec4  vTint;     // dry, hue jitter, species id, random
varying vec4  vCan;      // height above soil (m), canopy height (m), canopy density, tussock radius 0..1
varying float vCover;    // coverage-preserving alpha (blade thinner than a pixel)
varying float vFp;       // pixel footprint / blade width
#ifdef STALK
varying float vPart;
#endif

void cullIt(){
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vWorld = vec3(0.0); vNormal = vec3(0.0, 1.0, 0.0); vFlat = vNormal; vTan = vec3(0.0, 1.0, 0.0); vUv = vec2(0.0);
  vTint = vec4(0.0); vCan = vec4(0.0); vCover = 0.0; vFp = 0.0;
#ifdef STALK
  vPart = 0.0;
#endif
}

void main(){
  uint  id    = uint(gl_InstanceID);
  uint  bpc   = uint(uRingB.x + 0.5);
  uint  gN    = uint(uRingB.y + 0.5);
  uint  cellI = id / bpc;
  uint  k     = id - cellI * bpc;
  ivec2 cl    = ivec2(int(cellI % gN), int(cellI / gN)) - ivec2(int(gN) / 2);
  float cs    = uRing.w;
  ivec2 cell  = cl + ivec2(floor(cameraPosition.xz / cs));
  uint  cseed = ihash(cell, uint(uSalt));
  uint  bs    = pcg(cseed + k * 2654435769u + 0x85EBCA6Bu);

  // ---- placement -----------------------------------------------------------------------------
  vec2  root;
  float vig = 1.0;
  float radN = 1.0;
  vec2  outDir = vec2(cos(6.2831853 * rnd(bs, 3u)), sin(6.2831853 * rnd(bs, 3u)));
#ifdef STALK
  root = (vec2(cell) + vec2(rnd(bs, 6u), rnd(bs, 7u))) * cs;
#else
  int   m   = int(uRingB.z + 0.5);
  ivec2 tid = cell * m + ivec2(min(int(rnd(bs, 1u) * float(m)), m - 1), min(int(rnd(bs, 2u) * float(m)), m - 1));
  vec2  tc  = tussockCenter(tid);
  vig       = tussockVigor(tid);
  bool  filler = rnd(bs, 5u) < 0.20;
  float rad = 0.04 + 0.27 * pow(rnd(bs, 4u), 0.65);
  vec2  ofs = rad * outDir;
  root = filler ? (vec2(tid) + vec2(rnd(bs, 6u), rnd(bs, 7u))) * TS : tc + ofs;
  radN = filler ? 1.0 : rad / 0.31;
  outDir = filler ? outDir : normalize(ofs + vec2(1e-5));
#endif

  // ---- ring cross-fade (stochastic thinning) + frustum cull ----------------------------------------
  float d    = distance(root, cameraPosition.xz);
  float keep = 1.0 - smoothstep(uRing.y - uRing.z, uRing.y + uRing.z, d);
  if (uRing.x > 0.0) keep *= smoothstep(uRing.x - uRing.z, uRing.x + uRing.z, d);
  if (rnd(bs, 9u) > keep){ cullIt(); return; }

  float gy   = terrain(root).x;
  vec4  cr   = projectionMatrix * viewMatrix * vec4(root.x, gy, root.y, 1.0);
  if (cr.w < -1.5 || abs(cr.x) > cr.w * 1.3 + projectionMatrix[0][0] * 1.4){ cullIt(); return; }

  // ---- ecology: species / density from the baked field ---------------------------------------------
  vec4  f = textureLod(uField, fieldUV(root), 0.0);   // x tall, y clover, z dry, w lush
  float r1 = rnd(bs, 11u), r2 = rnd(bs, 12u), r3 = rnd(bs, 13u), r4 = rnd(bs, 14u);
  float ph = rnd(bs, 15u) * 6.2831853;

#ifdef STALK
  float acc = (0.05 + 0.95 * f.x * f.x) * mix(0.25, 1.0, smoothstep(0.05, 0.5, f.w));
  if (rnd(bs, 8u) > acc){ cullIt(); return; }
  float sp    = 4.0;
  float H     = (0.70 + 0.55 * r1) * mix(0.85, 1.15, f.w);
  float w0    = 0.00105 * (0.85 + 0.40 * r2);              // metres per geometry unit (mm)
  float hwMax = 1.35 * w0;
  float droop = 0.18 + 0.50 * r3;
  float flex  = 0.34;
  float flut  = 0.028;
  float lean0 = 0.05 + 0.20 * r4;
  float dry   = clamp(0.25 + 0.5 * f.z + 0.25 * r4, 0.0, 1.0);
  float cd    = 0.30;
  float dens  = 0.8;
  vec2  fwd   = outDir;
#else
  float dens = mix(0.30, 1.0, smoothstep(0.05, 0.55, f.w)) * (1.0 - 0.45 * f.y);
  float acc  = mix(0.55, 1.0, vig) * dens;
  if (rnd(bs, 8u) > acc){ cullIt(); return; }

  float rs      = rnd(bs, 10u);
  float pThatch = 0.03 + 0.40 * f.z + 0.18 * (1.0 - smoothstep(0.1, 0.5, f.w));
  float pTall   = 0.025 + 0.60 * f.x;
  float pFine   = 0.30 * (1.0 - 0.7 * f.x);
  float sp = 0.0;
  if (rs < pThatch) sp = 3.0;
  else if (rs < pThatch + pTall) sp = 2.0;
  else if (rs < pThatch + pTall + pFine) sp = 1.0;

  float lushH = mix(0.72, 1.18, f.w) * (1.0 - 0.55 * f.y);
  float H, hw, droop, flex, flut, dry;
  if (sp < 0.5){        // lush mid-height blade
    H = (0.17 + 0.23 * r1) * lushH;  hw = 0.0034 + 0.0026 * r2;  droop = 0.20 + 0.50 * r3;
    flex = 0.20; flut = 0.030; dry = clamp(f.z * 1.05 + 0.22 * (r4 - 0.5), 0.0, 1.0);
  } else if (sp < 1.5){ // fine fescue
    H = (0.11 + 0.20 * r1) * lushH;  hw = 0.0015 + 0.0014 * r2;  droop = 0.45 + 0.65 * r3;
    flex = 0.32; flut = 0.055; dry = clamp(f.z * 1.1 + 0.25 * (r4 - 0.5), 0.0, 1.0);
  } else if (sp < 2.5){ // tall leafy culm blades
    H = (0.50 + 0.55 * r1) * mix(0.9, 1.15, f.w);  hw = 0.0048 + 0.0034 * r2;  droop = 0.45 + 0.55 * r3;
    flex = 0.35; flut = 0.035; dry = clamp(f.z * 0.6 + 0.2 * (r4 - 0.3), 0.0, 1.0);
  } else {              // dead golden thatch lying low
    H = 0.045 + 0.11 * r1;  hw = 0.0028 + 0.0018 * r2;  droop = 0.90 + 0.40 * r3;
    flex = 0.08; flut = 0.010; dry = 0.9 + 0.1 * r4;
  }
  float lean0 = (0.04 + 0.35 * pow(radN, 1.2)) * (sp > 1.5 && sp < 2.5 ? 0.5 : 1.0);
  float cd    = mix(0.26, 0.55, f.x) * lushH;
  // Low-density rings preserve canopy coverage by widening blades. The exponent grows with distance: gently near
  // the ring's inner edge (blades stay blade-like), toward full area compensation (0.5) where they are sub-pixel.
  float covExp = mix(0.34, 0.52, smoothstep(max(uRing.x, 1.0), uRing.y, d));
  float w0    = hw * pow(uRingB.w, covExp);
  float hwMax = w0;
  vec2  fwd   = normalize(outDir + 0.7 * (vec2(r2, r3) - 0.5));
#endif
  float hj = (r2 - 0.5) * 2.0;

  // ---- pixel-footprint compensation ---------------------------------------------------------------
  float pxWorld = 2.0 * max(cr.w, 0.05) / (projectionMatrix[1][1] * uRes.y);
  float wMin    = 0.55 * pxWorld;
  float widen   = max(1.0, wMin / hwMax);
  float w       = w0 * widen;
  vCover = clamp(hwMax / wMin, 0.0, 1.0);
  vFp    = pxWorld / max(2.0 * hwMax, 1e-5);

  // ---- bent centre-line: parabolic droop + stiffness-weighted gust + high-frequency flutter ----------
  float t   = uv.x;
  vec2  wd  = normalize(uWindDir);
  vec2  wp  = vec2(-wd.y, wd.x);
  float gust = windGust(root);

  float S  = t * t * (1.4 - 0.4 * t);                         // locked root -> supple tip
  float dS = t * (2.8 - 1.2 * t);
  float ampG = flex * uWindAmt * gust;
  vec2  dd  = fwd * (lean0 * t + droop * t * t) + wd * (ampG * S);
  vec2  ddt = fwd * (lean0 + 2.0 * droop * t)   + wd * (ampG * dS);

  float w1 = 8.0 + 6.0 * r1, w2 = 11.0 + 5.0 * r2;
  float a1 = w1 * uTime + ph + 4.5 * t, a2 = w2 * uTime + ph * 1.7 + 6.5 * t;
  float t2 = t * t, t3 = t2 * t;
  float fa = flut * (0.25 + 0.75 * min(gust, 1.4)) * uWindAmt;
  dd  += fa * t3 * (wd * 0.7 * sin(a1) + wp * sin(a2));
  ddt += fa * (wd * 0.7 * (3.0 * t2 * sin(a1) + t3 * 4.5 * cos(a1)) + wp * (3.0 * t2 * sin(a2) + t3 * 6.5 * cos(a2)));

  // chord-preserving: |P(t)| = t, so the blade bends instead of stretching. A C1 soft-saturation keeps the
  // horizontal excursion below the chord (no kink) and its exact derivative keeps the tangent consistent.
  float tcl = max(t, 1e-3);
  float lim = 0.97 * tcl;
  float dl  = length(dd) + 1e-6;
  float q   = dl / lim, q3 = q * q * q, q4 = q3 * q;
  float sat = pow(1.0 + q4, -0.25);
  float dq  = (dot(dd, ddt) / dl - dl / tcl) / lim;
  ddt = ddt * sat + dd * (-pow(1.0 + q4, -1.25) * q3 * dq);
  dd *= sat;
  float yy  = sqrt(max(t * t - dot(dd, dd), 0.0));
  float yp  = yy > 0.004 ? (t - dot(dd, ddt)) / yy : 1.0;
  vec3  Tw  = normalize(vec3(ddt.x, yp, ddt.y));

  // Frenet-style frame: lateral axis follows yaw + twist, re-orthogonalised against the tangent.
  float psi = atan(-fwd.x, fwd.y) + (r3 - 0.5) * 1.8 * t;
  vec3  A0  = vec3(cos(psi), 0.0, sin(psi));
  vec3  Aw  = normalize(A0 - Tw * dot(A0, Tw));
  vec3  Nw  = cross(Tw, Aw);
  float roll = (0.25 * gust + 0.20 * sin(a1 * 0.5)) * t * uWindAmt;     // gusts roll the blade about its spine
  float cR = cos(roll), sR = sin(roll);
  vec3  A1 = Aw * cR + Nw * sR;
  vec3  N1 = Nw * cR - Aw * sR;

  vec3 P = vec3(root.x, gy, root.y) + H * vec3(dd.x, yy, dd.y) + (A1 * position.x + N1 * position.y + Tw * position.z) * w;
  vec4 wp4 = vec4(P, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp4;

  vWorld  = P;
  vNormal = A1 * normal.x + N1 * normal.y + Tw * normal.z;      // analytic normal of the *bent* blade
#ifdef STALK
  vFlat = vNormal; vPart = uv.y; vUv = vec2(t, 0.0);
#else
  vFlat = N1; vUv = uv;
#endif
  vTan  = Tw;
  vTint = vec4(dry, hj, sp, r4);
  vCan  = vec4(max(P.y - gy, 0.0), cd, dens * 1.5, radN);
}
`;

/* ------------------------------------------------------------------------------------------------
 * GRASS FRAGMENT SHADER
 * ---------------------------------------------------------------------------------------------- */
export const GRASS_FS = /* glsl */`
varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vFlat;
varying vec3  vTan;
varying vec2  vUv;
varying vec4  vTint;
varying vec4  vCan;
varying float vCover;
varying float vFp;
#ifdef STALK
varying float vPart;
#endif

void main(){
  vec3  V  = normalize(cameraPosition - vWorld);
  float t  = vUv.x, s = vUv.y;
  float fp = vFp;
  float vis = 1.0 - smoothstep(0.15, 0.7, fp);

  vec3 N  = normalize(vNormal);
  vec3 Nf = normalize(vFlat);
  if (!gl_FrontFacing){ N = -N; Nf = -Nf; }
  N = normalize(mix(N, Nf, smoothstep(0.2, 0.9, fp)));           // flatten V-fold once sub-pixel
  float nv = dot(N, V);
  if (nv < 0.02) N = normalize(N + V * (0.02 - nv));

  float dry = vTint.x, hj = vTint.y, sp = vTint.z, rr = vTint.w;

  // ---- albedo: damp earth root -> etiolated sheath -> chlorophyll -> sun-bleached tip ------------------
  vec3 green = vec3(0.055, 0.200, 0.020) * vec3(1.0 + 0.30 * hj, 1.0 - 0.05 * hj, 1.0 - 0.30 * abs(hj));
  vec3 root  = mix(vec3(0.040, 0.026, 0.012), vec3(0.20, 0.15, 0.05), dry);
  vec3 sheath = vec3(0.20, 0.22, 0.07);
  vec3 tipC  = mix(vec3(0.28, 0.29, 0.05), vec3(0.50, 0.40, 0.14), dry);
  vec3 c = mix(root, sheath, smoothstep(0.0, 0.07, t));
  c = mix(c, green, smoothstep(0.06, 0.28, t));
  c = mix(c, tipC, pow(smoothstep(0.50, 1.0, t), 1.4) * mix(0.55, 1.0, dry));
  vec3 straw = mix(vec3(0.40, 0.27, 0.085), vec3(0.58, 0.45, 0.18), rr);
  c = mix(c, straw * (0.75 + 0.25 * (1.0 - t)), smoothstep(0.25, 0.95, dry) * 0.9);
  float rib = 0.0;
  float thick = 0.34;
  vec3  sigma = mix(vec3(3.1, 1.05, 4.4), vec3(0.9, 1.2, 2.7), dry);
  float isStalk = 0.0;
#ifdef STALK
  isStalk = 1.0;
  float part = vPart;
  vec3 culm = mix(vec3(0.16, 0.20, 0.05), vec3(0.45, 0.34, 0.11), smoothstep(0.35, 0.9, t) * 0.7 + dry * 0.4);
  vec3 head = mix(vec3(0.40, 0.31, 0.10), vec3(0.56, 0.40, 0.18), rr) * (0.8 + 0.4 * hj);
  head = mix(head, vec3(0.30, 0.12, 0.16), 0.20 * step(0.7, rr));                     // occasional purple-tinged heads
  c = part < 0.5 ? culm : head;
  thick = part < 0.5 ? 0.30 : (part < 1.5 ? 0.14 : 0.05);
  rib = 0.0;
#else
  rib = exp(-s * s / 0.045) * vis;
  float veins = 0.5 + 0.5 * sin(s * 22.0 + rr * 30.0);
  c *= 1.0 + vis * 0.10 * (veins - 0.5);
  c = mix(c, c * vec3(1.30, 1.22, 0.85) + vec3(0.012, 0.012, 0.0), rib * 0.55);
  thick = 0.34 * (1.0 - 0.45 * s * s) * (1.0 - 0.55 * t) * (1.0 + 0.7 * rib);
  thick = mix(thick, 0.55, step(2.5, sp) * step(sp, 3.5));                           // thatch is thick & papery
#endif

  // ---- canopy occlusion: ambient AO + golden-hour grazing sun attenuation through the stand -------------
  float hy = vCan.x, cd = vCan.y, dens = vCan.z;
  float rel = clamp(hy / (cd * 0.85 + 0.03), 0.0, 1.0);
  float ao  = mix(0.10, 1.0, pow(rel, 0.75)) * mix(0.70, 1.0, clamp(vCan.w, 0.0, 1.0));
  float sinEl = max(uSunDir.y, 0.12);
  float sunVis = exp(-2.4 * dens * max(cd - hy, 0.0) / sinEl);
  sunVis = mix(sunVis, 1.0, isStalk);                                                   // stalks stand above the canopy

  Leaf L;
  L.albedo = c; L.N = N; L.T = vTan; L.sigma = sigma; L.thick = thick;
  L.rough = 0.42; L.rib = rib; L.ao = mix(ao, 1.0, isStalk * 0.7); L.sunVis = sunVis; L.fp = fp;
  L.tint = mix(vec3(1.0), c * 5.0, 0.35) * vec3(1.0, 1.0, 0.6);
  vec3 col = shadeLeaf(L, V);

#ifndef STALK
  // Dew: droplets strung along the blade; each is a tiny lens that mirrors the sky and flashes the sun.
  if (uDew > 0.01 && fp < 0.16){
    float hy2 = vCan.x;
    vec3 b = dewBeads(vec2(s * 0.85 + rr * 7.0, hy2 / 0.0050 + rr * 13.0), rr, fp);
    if (b.x > 0.0){
      vec3 lat = normalize(cross(N, vTan));
      vec2 e = b.yz * 0.85;
      vec3 Nb = normalize(N * sqrt(max(1.0 - dot(e, e), 0.05)) + lat * e.x + normalize(vTan) * e.y);
      vec3 H = normalize(uSunDir + V);
      float glint = pow(clamp(dot(Nb, H), 0.0, 1.0), 180.0) * 6.0;
      vec3 Rb = reflect(-V, Nb);
      vec3 env = skyRadiance(normalize(vec3(Rb.x, max(Rb.y, 0.03), Rb.z)));
      vec3 Tb = refract(-V, Nb, 0.75);                                   // lens: shows the (inverted) bright background
      vec3 bg = skyRadiance(normalize(vec3(-Tb.x, abs(Tb.y) + 0.05, -Tb.z))) * 0.9 + uSunCol * 0.10 * sunVis;
      float Fb = F_Schlick(clamp(dot(Nb, V), 0.0, 1.0), 0.02);
      float rim = smoothstep(0.55, 1.0, dot(b.yz, b.yz));               // dark refractive rim
      vec3 body = c * (skyAmbient(N) * 1.6 + uSunCol * sunVis * 0.5) + bg * 1.1;            // magnified leaf + background through water
      vec3 bead = mix(body, bg * 0.12 + c * 0.1, rim) + env * (0.10 + 1.8 * Fb) + uSunCol * glint * sunVis;
      col = mix(col, bead, clamp(uDew, 0.0, 1.0) * b.x * smoothstep(0.30, 0.75, rel) * 0.9);
    }
  }
#endif

#ifndef STALK
  // Distance anti-aliasing: once a blade is thinner than ~a pixel its per-blade luminance is noise, so converge
  // to the analytic canopy colour (identical to the soil's far field) instead of letting it glitter.
  float farK = smoothstep(0.35, 1.6, fp) * 0.9;
  if (farK > 0.001) col = mix(col, canopyShade(vWorld, V, vec3(0.0, 1.0, 0.0), texture(uField, fieldUV(vWorld.xz))), farK);
#endif

  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, vCover);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------------------------------------
 * CLOVER (trifoliate leaves) vertex + fragment. Jacobian normal correction: n' = n - y (a.n)
 * ---------------------------------------------------------------------------------------------- */
export const CLOVER_VS = /* glsl */`
uniform vec4 uRing;
uniform vec4 uRingB;
uniform float uSalt;
varying vec3  vWorld;
varying vec3  vNormal;
varying vec2  vUv;
varying vec4  vInfo;      // height above soil, dens, random, size

void cullIt(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vWorld = vec3(0.0); vNormal = vec3(0.0, 1.0, 0.0); vUv = vec2(0.0); vInfo = vec4(0.0); }

void main(){
  uint  id    = uint(gl_InstanceID);
  uint  bpc   = uint(uRingB.x + 0.5);
  uint  gN    = uint(uRingB.y + 0.5);
  uint  cellI = id / bpc;
  uint  k     = id - cellI * bpc;
  ivec2 cl    = ivec2(int(cellI % gN), int(cellI / gN)) - ivec2(int(gN) / 2);
  float cs    = uRing.w;
  ivec2 cell  = cl + ivec2(floor(cameraPosition.xz / cs));
  uint  bs    = pcg(ihash(cell, uint(uSalt)) + k * 2654435769u + 0x27D4EB2Fu);

  vec2 root = (vec2(cell) + vec2(rnd(bs, 1u), rnd(bs, 2u))) * cs;
  float d    = distance(root, cameraPosition.xz);
  float keep = 1.0 - smoothstep(uRing.y - uRing.z, uRing.y + uRing.z, d);
  if (rnd(bs, 9u) > keep){ cullIt(); return; }

  vec4  f  = textureLod(uField, fieldUV(root), 0.0);
  float pc = smoothstep(0.12, 0.85, f.y);
  if (rnd(bs, 3u) > pc){ cullIt(); return; }

  float gy = terrain(root).x;
  vec4  cr = projectionMatrix * viewMatrix * vec4(root.x, gy, root.y, 1.0);
  if (cr.w < -1.0 || abs(cr.x) > cr.w * 1.3 + projectionMatrix[0][0] * 0.6){ cullIt(); return; }

  float sz  = (0.034 + 0.034 * rnd(bs, 4u)) * (0.8 + 0.4 * f.w);
  float yaw = 6.2831853 * rnd(bs, 5u);
  float cy = cos(yaw), sy = sin(yaw);
  float tl = 0.45 * (rnd(bs, 8u) - 0.35), ct = cos(tl), st = sin(tl);
  mat3  R  = mat3(cy, 0.0, -sy,  0.0, 1.0, 0.0,  sy, 0.0, cy) * mat3(1.0, 0.0, 0.0,  0.0, ct, st,  0.0, -st, ct);

  float y01 = clamp(position.y, 0.0, 1.2);
  vec2  wd  = normalize(uWindDir);
  float gust = windGust(root);
  float S  = y01 * y01 * (1.4 - 0.4 * y01), dS = y01 * (2.8 - 1.2 * y01);
  float ph = rnd(bs, 6u) * 6.2831853;
  float fl = sin(9.0 * uTime + ph + 4.0 * y01), dfl = 4.0 * cos(9.0 * uTime + ph + 4.0 * y01);
  float amp = 0.30 * uWindAmt * gust;
  vec2  off = wd * (amp * S) + vec2(-wd.y, wd.x) * (0.05 * uWindAmt * (0.3 + gust) * y01 * y01 * fl);
  vec2  a   = wd * (amp * dS) + vec2(-wd.y, wd.x) * (0.05 * uWindAmt * (0.3 + gust) * (2.0 * y01 * fl + y01 * y01 * dfl));

  vec3 lp = R * position;
  vec3 P  = vec3(root.x, gy, root.y) + sz * (lp + vec3(off.x, 0.0, off.y));
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);

  vec3 n = R * normal;
  n -= vec3(0.0, 1.0, 0.0) * dot(vec3(a.x, 0.0, a.y), n);        // analytic J^-T n for d = d(y)
  vWorld = P; vNormal = n; vUv = uv;
  vInfo = vec4(P.y - gy, mix(0.6, 1.5, f.w), rnd(bs, 7u), sz);
}
`;

export const CLOVER_FS = /* glsl */`
varying vec3  vWorld;
varying vec3  vNormal;
varying vec2  vUv;
varying vec4  vInfo;

void main(){
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  float nv = dot(N, V); if (nv < 0.02) N = normalize(N + V * (0.02 - nv));

  float u = vUv.x, v = vUv.y, rr = vInfo.z;
  bool petiole = u < -0.5;
  vec3 leaf = vec3(0.028, 0.135, 0.030) * (0.85 + 0.35 * rr);
  float q = u - 0.58 + 0.46 * abs(v);                      // pale chevron
  float chev = exp(-q * q / 0.0035) * smoothstep(0.1, 0.25, u);
  leaf = mix(leaf, vec3(0.11, 0.26, 0.09), chev * 0.8);
  leaf = mix(leaf, vec3(0.10, 0.16, 0.05), smoothstep(0.7, 1.0, u) * 0.4);     // paler apex
  vec3 c = petiole ? vec3(0.10, 0.18, 0.05) : leaf;

  float hy = vInfo.x;
  float ao = mix(0.25, 1.0, smoothstep(0.0, 0.08, hy)) ;
  float sinEl = max(uSunDir.y, 0.12);
  float sunVis = exp(-2.4 * vInfo.y * max(0.06 - hy, 0.0) / sinEl) ;
  // taller grass shades the clover at low sun
  Leaf L;
  L.albedo = c; L.N = N; L.T = vec3(0.0, 1.0, 0.0); L.sigma = vec3(3.0, 1.0, 4.2);
  L.thick = petiole ? 0.3 : 0.26 * (1.0 - 0.4 * abs(v));
  L.rough = 0.55; L.rib = 0.0; L.ao = ao; L.sunVis = sunVis; L.fp = 0.0;
  L.tint = vec3(1.0, 1.0, 0.6);
  vec3 col = shadeLeaf(L, V);
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------------------------------------
 * SOIL: layered PBR topsoil (loam / humus / sand), pebbles, straw + leaf litter, moisture & puddles,
 * analytic micro-relief normals with footprint-filtered octaves, tussock-root AO and distant canopy blend.
 * ---------------------------------------------------------------------------------------------- */
export const GROUND_VS = /* glsl */`
uniform vec2 uCenter;
varying vec3 vWorld;
varying vec3 vNg;
void main(){
  vec2 wp = position.xz + uCenter;
  vec3 th = terrain(wp);
  vWorld = vec3(wp.x, th.x, wp.y);
  vNg = normalize(vec3(-th.y, 1.0, -th.z));
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

export const GROUND_FS = /* glsl */`
varying vec3 vWorld;
varying vec3 vNg;

float h2f(vec2 i){ uvec2 q = uvec2(ivec2(i)); return u01(pcg(q.x + pcg(q.y))); }

// Value noise with analytic derivatives: (n, dn/dx, dn/dy)
vec3 vnoiseD(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u  = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = h2f(i), b = h2f(i + vec2(1.0, 0.0)), c = h2f(i + vec2(0.0, 1.0)), d = h2f(i + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du.x * (k1 + k4 * u.y), du.y * (k2 + k4 * u.x));
}
// Micro-relief fbm with octaves faded out by pixel footprint (no shimmer). returns (h, dh/dx, dh/dz), h~0..1
vec3 relief(vec2 p, float fw){
  float fq = 2.2, a = 0.5;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 7; i++){
    float fade = 1.0 - smoothstep(0.30, 0.85, fw * fq);
    vec3 n = vnoiseD(p * fq + float(i) * 17.3);
    acc += a * fade * vec3(n.x, n.y * fq, n.z * fq);
    fq *= 2.07; a *= 0.5;
  }
  return acc;
}
// Pebbles: one dome per cell, contained in its cell. Returns (height m, dh/dx, dh/dz, mask)
vec4 pebbles(vec2 p, float scale, float fw, float density, float seed){
  vec2 q = p * scale; ivec2 ci = ivec2(floor(q)); vec2 lp = fract(q);
  uint h = ihash(ci, uint(seed));
  float fade = 1.0 - smoothstep(0.05, 0.16, fw * scale);
  if (u01(h) > density || fade <= 0.0) return vec4(0.0);
  vec2 c = vec2(0.30 + 0.40 * u01(pcg(h ^ 1u)), 0.30 + 0.40 * u01(pcg(h ^ 2u)));
  float r = 0.11 + 0.12 * u01(pcg(h ^ 3u));
  vec2 dp = lp - c;
  float k = r * r - dot(dp, dp);
  if (k <= 0.0) return vec4(0.0);
  float hh = 0.5 * k / r / scale;
  vec2 g = -0.55 * dp / r;
  float mask = clamp(k / (r * max(fw * scale, 1e-3) * 1.2), 0.0, 1.0) * fade;
  return vec4(hh * fade, g * fade, mask);
}
// Straw slivers / leaf fragments: one oriented capsule per (rotated) cell, fully contained in the cell.
vec4 litter(vec2 p, float scale, float rot, float fw, float seed, float lenK, float widK){
  float cr = cos(rot), sr = sin(rot);
  vec2 pr = vec2(cr * p.x - sr * p.y, sr * p.x + cr * p.y) * scale;
  ivec2 ci = ivec2(floor(pr)); vec2 lp = fract(pr);
  uint h = ihash(ci, uint(seed));
  float fade = 1.0 - smoothstep(0.05, 0.18, fw * scale);
  if (u01(h) > 0.50 || fade <= 0.0) return vec4(0.0);
  float ang = 6.2831853 * u01(pcg(h ^ 1u));
  vec2  dir = vec2(cos(ang), sin(ang));
  vec2  c   = vec2(0.36 + 0.28 * u01(pcg(h ^ 2u)), 0.36 + 0.28 * u01(pcg(h ^ 3u)));
  float hl  = (0.14 + 0.14 * u01(pcg(h ^ 4u))) * lenK;
  float wd  = (0.012 + 0.020 * u01(pcg(h ^ 5u))) * widK;
  vec2  dp  = lp - c;
  float along = clamp(dot(dp, dir), -hl, hl);
  float dist = length(dp - dir * along) / scale;                 // metres
  float wm = wd / scale;
  float cov = clamp(0.5 + (wm - dist) / max(fw, 1e-4), 0.0, 1.0) * clamp(2.0 * wm / max(fw, 1e-4), 0.0, 1.0) * fade;
  float shadow = clamp(0.5 + (wm * 2.6 - dist) / max(fw, 1e-4), 0.0, 1.0) * fade;
  return vec4(cov, shadow, u01(pcg(h ^ 6u)), u01(pcg(h ^ 7u)));
}

float D_GGX(float NoH, float a){ float a2 = a * a; float d = NoH * NoH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d + 1e-7); }
float V_Smith(float NoV, float NoL, float a){
  float gv = NoL * (NoV * (1.0 - a) + a), gl = NoV * (NoL * (1.0 - a) + a);
  return 0.5 / (gv + gl + 1e-5);
}
float F_Schlick(float VoH, float f0){ return f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0); }

void main(){
  vec3  P = vWorld; vec2 p = P.xz;
  vec3  V = normalize(cameraPosition - P);
  float dist = length(cameraPosition - P);
  float fw = max(length(vec2(length(dFdx(p)), length(dFdy(p)))), 1e-4);
  vec4  f = texture(uField, fieldUV(p));
  vec3  L = uSunDir;
  vec2  wd = normalize(uWindDir);

  // ---------------- macro layers ----------------
  float mA = texture(uNoise, p * 0.0310 + 0.30).g;
  float mB = texture(uNoise, p * 0.0074 + 0.10).r;
  float mC = texture(uNoise, p * 0.0170 + 0.50).b;
  vec3 loam  = vec3(0.060, 0.040, 0.025);
  vec3 humus = vec3(0.028, 0.021, 0.014);
  vec3 sand  = vec3(0.165, 0.125, 0.082);
  vec3 soil  = mix(loam, humus, smoothstep(0.42, 0.68, mB));
  soil = mix(soil, sand, smoothstep(0.55, 0.72, mA) * 0.75);

  // ---------------- micro-relief (analytic gradient) ----------------
  vec3  rl = relief(p, fw);
  float relH = (rl.x - 0.5) * 0.075;
  vec2  grad = rl.yz * 0.075;
  vec4  pb1 = pebbles(p, 9.0, fw, 0.16, 3.0);
  vec4  pb2 = pebbles(p + 11.7, 24.0, fw, 0.26, 9.0);
  vec3  pebCol1 = mix(vec3(0.16, 0.14, 0.11), vec3(0.28, 0.22, 0.15), u01(ihash(ivec2(floor(p * 9.0)), 31u)));
  vec3  pebCol2 = mix(vec3(0.12, 0.11, 0.09), vec3(0.22, 0.19, 0.14), u01(ihash(ivec2(floor((p + 11.7) * 24.0)), 37u)));
  grad += pb1.yz * pb1.w + pb2.yz * pb2.w;
  float heightAll = relH + pb1.x * pb1.w + pb2.x * pb2.w;

  // grain / clods
  // crumb structure: each octave is faded by its own wavelength vs the pixel footprint (no aliasing / no sparkle)
  vec3  cr1 = vnoiseD(p * 38.0 + 3.1), cr2 = vnoiseD(p * 91.0 + 7.7);
  float cf1 = 1.0 - smoothstep(0.18, 0.55, fw * 38.0), cf2 = 1.0 - smoothstep(0.18, 0.55, fw * 91.0);
  float grain = (0.62 + 0.76 * rl.x) * (1.0 + ((cr1.x - 0.5) * cf1 + (cr2.x - 0.5) * cf2) * 0.7);
  grad += (cr1.yz * 38.0 * cf1 + cr2.yz * 91.0 * cf2) * 0.002;
  vec3 albedo = soil * grain;

  // ---------------- moisture ----------------
  float low  = smoothstep(0.3, -1.1, P.y);
  float wet  = clamp(low * 0.45 + (mC - 0.52) * 1.3 + 0.10 * f.w, 0.0, 1.0);
  wet = clamp(wet + clamp(-relH * 22.0, 0.0, 0.25) * wet, 0.0, 1.0);
  float puddle = smoothstep(0.80, 0.93, wet) * (1.0 - smoothstep(0.0, 0.02, relH + 0.0));
  float rough = mix(0.93, 0.42, wet);

  // moss / algae film in persistently damp soil
  float moss = smoothstep(0.55, 0.85, wet) * smoothstep(0.4, 0.7, texture(uNoise, p * 0.09).a);
  albedo = mix(albedo, vec3(0.030, 0.070, 0.016) * (0.7 + 0.6 * rl.x), moss * 0.7);

  // pebbles
  albedo = mix(albedo, pebCol1, pb1.w * step(0.0001, pb1.x));
  albedo = mix(albedo, pebCol2, pb2.w * step(0.0001, pb2.x));
  rough  = mix(rough, 0.55, max(pb1.w, pb2.w));

  // ---------------- organic litter ----------------
  vec4 lt1 = litter(p, 5.5, 0.4, fw, 21.0, 1.0, 1.0);                                    // straw slivers
  vec4 lt2 = litter(p, 3.1, 1.9, fw, 27.0, 1.0, 3.2);                                    // wider leaf fragments
  vec3 strawC = mix(vec3(0.20, 0.13, 0.045), vec3(0.40, 0.30, 0.11), lt1.z * lt1.z) * (0.75 + 0.5 * lt1.w);
  vec3 leafC  = mix(vec3(0.14, 0.075, 0.03), vec3(0.30, 0.19, 0.07), lt2.z) * (0.8 + 0.4 * lt2.w);
  float litAO = 1.0 - 0.35 * max(lt1.y - lt1.x, 0.0) - 0.35 * max(lt2.y - lt2.x, 0.0);
  albedo = mix(albedo, leafC, lt2.x * 0.85);
  albedo = mix(albedo, strawC, lt1.x * 0.85);
  rough = mix(rough, 0.82, max(lt1.x, lt2.x));
  float litAny = max(lt1.x, lt2.x);

  // thatch mat: dense fallen straw that covers the soil wherever grass has grown
  vec4 lt3 = litter(p, 13.0, 1.1, fw, 41.0, 1.0, 0.7);
  vec4 lt4 = litter(p, 9.0, 2.7, fw, 47.0, 1.3, 0.8);
  vec3 matC = mix(vec3(0.22, 0.15, 0.05), vec3(0.42, 0.32, 0.12), lt3.z * lt3.w) * (0.7 + 0.5 * lt4.w);
  float thatchCov = smoothstep(0.1, 0.6, f.w) * (0.45 + 0.5 * f.z);
  albedo = mix(albedo, matC, max(lt3.x, lt4.x * 0.9) * thatchCov * 0.9);
  rough = mix(rough, 0.85, max(lt3.x, lt4.x) * thatchCov);

  // clover carpet: leaf litter-green mat where clover grows (leaves themselves are instanced near the camera)
  float cloverMat = f.y * smoothstep(0.1, 0.6, 0.3 + rl.x * 0.9) * (1.0 - 0.5 * thatchCov * f.z);
  albedo = mix(albedo, vec3(0.030, 0.115, 0.030) * (0.6 + 0.9 * rl.x), cloverMat * 0.8);

  // wet darkening
  albedo *= mix(1.0, 0.42, wet * (1.0 - litAny * 0.6));

  // ---------------- normal ----------------
  vec3 N = normalize(vec3(vNg.x - grad.x, vNg.y, vNg.z - grad.y));
  float cav = clamp(0.62 + 7.0 * (heightAll - 0.012), 0.35, 1.0);                         // cavity AO from micro-height

  // ---------------- tussock root AO and canopy shadow ----------------
  float tuft = 0.0;
  if (dist < 60.0){
    ivec2 t0 = ivec2(floor(p / TS));
    float best = 1e3;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
      ivec2 id = t0 + ivec2(i, j);
      float dd = distance(p, tussockCenter(id)) / (0.14 + 0.20 * tussockVigor(id));
      best = min(best, dd);
    }
    tuft = (1.0 - smoothstep(0.0, 1.0, best)) * (1.0 - smoothstep(30.0, 60.0, dist));
  }
  float cover = smoothstep(0.05, 0.55, f.w);
  float sinEl = max(uSunDir.y, 0.12);
  float canopyH = mix(0.24, 0.5, f.x) * mix(0.75, 1.15, f.w) * (1.0 - 0.6 * f.y);
  float sunVisG = exp(-2.4 * cover * (0.35 + 0.65 * tuft) * 1.2 * canopyH / sinEl);
  float aoG = cav * litAO * mix(1.0, 0.16, cover * (0.45 + 0.55 * tuft));

  // ---------------- PBR shading ----------------
  float NoL = max(dot(N, L), 0.0);
  float NoV = clamp(dot(N, V), 1e-3, 1.0);
  vec3 Hh = normalize(L + V);
  float NoH = clamp(dot(N, Hh), 0.0, 1.0), VoH = clamp(dot(V, Hh), 0.0, 1.0);
  float rgh = mix(rough, 0.05, puddle);
  rgh = sqrt(rgh * rgh + fw * fw * 0.04);
  float a = max(rgh * rgh, 0.02);
  float f0 = mix(0.035, 0.02, puddle);
  float Fs = F_Schlick(VoH, f0);
  vec3  alb = mix(albedo, albedo * 0.25, puddle);
  vec3 col = alb * uSunCol * NoL * sunVisG;
  col += uSunCol * PI * D_GGX(NoH, a) * V_Smith(NoV, NoL, a) * Fs * NoL * sunVisG;
  col += alb * skyAmbient(N) * aoG;
  vec3 R = reflect(-V, N);
  vec3 env = skyRadiance(normalize(vec3(R.x, max(R.y, 0.02), R.z)));
  float wetSpec = mix(0.25, 1.0, puddle);
  col += env * F_Schlick(NoV, f0 + 0.015 * wet) * mix(0.15, 1.0, wetSpec) * (1.0 - rgh) * aoG;
  // grass shades & bounces: warm green bounce into the soil under the canopy
  col += alb * vec3(0.09, 0.15, 0.03) * uSunCol * cover * 0.25 * aoG;

  // ---------------- distance: blend to the analytic canopy ----------------
  vec3 canLit = canopyShade(P, V, vNg, f);

  float farMix = smoothstep(8.0, 48.0, dist) * mix(0.35, 1.0, cover);
  col = mix(col, canLit, farMix);

  col = applyFog(col, P);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------------------------------------
 * SKY DOME
 * ---------------------------------------------------------------------------------------------- */
export const SKY_VS = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
  gl_Position = p.xyww;       // push to the far plane
}
`;
export const SKY_FS = /* glsl */`
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  vec3 col = skyRadiance(d);
  float mu = dot(d, uSunDir);

  // stratocumulus deck: planar projection, density gradient toward the sun gives silver/orange lining
  float cy = max(d.y, 0.0);
  vec2 cp = d.xz / (cy + 0.12) * 0.55 + uWindDir * uTime * 0.0035;
  float c0 = dot(vec3(texture(uNoise, cp * 0.35).r, texture(uNoise, cp * 0.9).g, texture(uNoise, cp * 2.4).b), vec3(0.55, 0.30, 0.15));
  vec2 cs = cp + normalize(uSunDir.xz + vec2(1e-4)) * 0.05;
  float c1 = dot(vec3(texture(uNoise, cs * 0.35).r, texture(uNoise, cs * 0.9).g, texture(uNoise, cs * 2.4).b), vec3(0.55, 0.30, 0.15));
  float cov = smoothstep(0.50, 0.70, c0) * smoothstep(0.015, 0.20, d.y);
  float lit = clamp(0.55 + (c0 - c1) * 7.0, 0.0, 1.0);
  float sunSide = pow(clamp(mu * 0.5 + 0.5, 0.0, 1.0), 4.0);
  vec3 cloudShadow = mix(uZenith * 0.9, uHorizon * 0.55, 0.45);
  vec3 cloudLit = uSunCol * (0.30 + 0.9 * sunSide) + uHorizon * 0.5;
  vec3 cloud = mix(cloudShadow, cloudLit, lit);
  cloud += uSunCol * 0.35 * pow(clamp(mu, 0.0, 1.0), 12.0) * (1.0 - cov * 0.5);
  col = mix(col, cloud, cov * 0.92);

  // sun disc + corona
  float disc = smoothstep(cos(0.0056), cos(0.0044), mu);
  col += uSunCol * (disc * 260.0 + pow(clamp(mu, 0.0, 1.0), 900.0) * 6.0) * (1.0 - cov * 0.85);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------------------------------------
 * BAKE: tileable (periodic) fbm -> meadow ecology field (mode 0) and wind/cloud noise (mode 1).
 * ---------------------------------------------------------------------------------------------- */
export const BAKE_VS = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
export const BAKE_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform int uMode;

uint pcg(uint v){
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float u01(uint h){ return float(h >> 8u) * 5.9604645e-8; }
float hp(vec2 i, float per, float seed){
  vec2 m = mod(i, per);
  uvec2 q = uvec2(ivec2(m));
  return u01(pcg(q.x * 1664525u + pcg(q.y + uint(seed) * 2654435761u)));
}
float pn(vec2 p, float per, float seed){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(hp(i, per, seed), hp(i + vec2(1.0, 0.0), per, seed), u.x),
             mix(hp(i + vec2(0.0, 1.0), per, seed), hp(i + vec2(1.0, 1.0), per, seed), u.x), u.y);
}
float pfbm(vec2 uv, float cells, float seed, int oct){
  float s = 0.0, a = 0.5, tot = 0.0;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    s += a * pn(uv * cells, cells, seed + float(i));
    tot += a; cells *= 2.0; a *= 0.5;
  }
  return s / tot;
}
void main(){
  vec2 uv = vUv;
  if (uMode == 0){
    vec2 w = vec2(pfbm(uv, 3.0, 101.0, 3), pfbm(uv, 3.0, 131.0, 3)) - 0.5;
    vec2 q = uv + w * 0.07;                                   // gentle domain warp: organic, non-blobby patch edges
    float tall   = smoothstep(0.54, 0.64, pfbm(q, 6.0, 3.0, 4));
    float clover = smoothstep(0.53, 0.62, pfbm(q, 12.0, 41.0, 4)) * (1.0 - 0.85 * tall);
    float dry    = smoothstep(0.52, 0.64, pfbm(q, 9.0, 59.0, 4));
    float lush   = smoothstep(0.22, 0.42, pfbm(q, 14.0, 71.0, 3));
    gl_FragColor = vec4(tall, clover, dry, lush);
  } else {
    gl_FragColor = vec4(pfbm(uv, 3.0, 201.0, 4), pfbm(uv, 8.0, 211.0, 4), pfbm(uv, 20.0, 223.0, 3), pfbm(uv, 48.0, 227.0, 2));
  }
}
`;
