/** Fully procedural WebAudio: engine, blades, foley, ambience. No samples. */
export class GameAudio {
  constructor() { this.ctx = null; this.vol = 0.8; this.remote = new Map(); }
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    const ctx = this.ctx = new C();
    this.master = ctx.createGain(); this.master.gain.value = this.vol;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 5;
    this.master.connect(comp); comp.connect(ctx.destination);
    // noise buffer
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = nb;
    // engine: two saws + sub square -> shaper -> lowpass, with a firing-rate chug LFO
    const eg = this.engGain = ctx.createGain(); eg.gain.value = 0;
    const lp = this.engLP = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500; lp.Q.value = 2;
    const shaper = ctx.createWaveShaper(); const curve = new Float32Array(256); for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 2.2); } shaper.curve = curve;
    this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth'; this.o2 = ctx.createOscillator(); this.o2.type = 'sawtooth'; this.o3 = ctx.createOscillator(); this.o3.type = 'square';
    this.o1.connect(shaper); this.o2.connect(shaper); const sub = ctx.createGain(); sub.gain.value = 0.5; this.o3.connect(sub); sub.connect(shaper);
    shaper.connect(lp); lp.connect(eg);
    const chug = ctx.createGain(); chug.gain.value = 1; this.chugLFO = ctx.createOscillator(); const chugDepth = this.chugDepth = ctx.createGain(); chugDepth.gain.value = 0.25;
    this.chugLFO.connect(chugDepth); chugDepth.connect(eg.gain);
    eg.connect(this.master);
    [this.o1, this.o2, this.o3, this.chugLFO].forEach(o => o.start());
    // blades: bandpassed noise
    this.bladeSrc = ctx.createBufferSource(); this.bladeSrc.buffer = nb; this.bladeSrc.loop = true;
    this.bladeBP = ctx.createBiquadFilter(); this.bladeBP.type = 'bandpass'; this.bladeBP.frequency.value = 900; this.bladeBP.Q.value = 1.2;
    this.bladeGain = ctx.createGain(); this.bladeGain.gain.value = 0;
    this.bladeSrc.connect(this.bladeBP); this.bladeBP.connect(this.bladeGain); this.bladeGain.connect(this.master); this.bladeSrc.start();
    // wind bed
    this.windSrc = ctx.createBufferSource(); this.windSrc.buffer = nb; this.windSrc.loop = true;
    const wlp = ctx.createBiquadFilter(); wlp.type = 'lowpass'; wlp.frequency.value = 500; const wg = this.windGain = ctx.createGain(); wg.gain.value = 0.02;
    this.windSrc.connect(wlp); wlp.connect(wg); wg.connect(this.master); this.windSrc.start();
    this.ambTimer = setInterval(() => this.ambience(), 140);
  }
  setVolume(v) { this.vol = v; if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
  engine({ rpm, load, blades, on, speed, bagFull }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, f = 24 + rpm * 62;
    this.o1.frequency.setTargetAtTime(f, t, 0.05); this.o2.frequency.setTargetAtTime(f * 1.012, t, 0.05); this.o3.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.chugLFO.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.engLP.frequency.setTargetAtTime(260 + rpm * 1100, t, 0.08);
    this.engGain.gain.setTargetAtTime(on ? 0.16 + rpm * 0.12 : 0, t, 0.1);
    this.bladeGain.gain.setTargetAtTime(on && blades ? 0.05 + rpm * 0.08 + load * 0.05 : 0, t, 0.12);
    this.bladeBP.frequency.setTargetAtTime(700 + rpm * 1500 + load * 500, t, 0.1);
    this.windGain.gain.setTargetAtTime(0.012 + Math.min(Math.abs(speed), 9) * 0.004, t, 0.2);
  }
  /** Distant mowers: one lightweight voice each. */
  remoteVoice(id, { dist, pan, rpm, on }) {
    if (!this.ctx) return;
    let v = this.remote.get(id);
    if (!v) {
      const ctx = this.ctx, o = ctx.createOscillator(); o.type = 'sawtooth';
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
      const g = ctx.createGain(); g.gain.value = 0; const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      o.connect(lp); lp.connect(g); if (p) { g.connect(p); p.connect(this.master); } else g.connect(this.master); o.start();
      v = { o, g, p, lp }; this.remote.set(id, v);
    }
    const t = this.ctx.currentTime;
    v.o.frequency.setTargetAtTime(26 + rpm * 55, t, 0.1);
    v.lp.frequency.setTargetAtTime(260 + rpm * 500 - Math.min(dist, 40) * 6, t, 0.1);
    v.g.gain.setTargetAtTime(on ? 0.22 / (1 + dist * 0.28) : 0, t, 0.15);
    if (v.p) v.p.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.1);
  }
  dropRemote(id) { const v = this.remote.get(id); if (v) { v.g.gain.value = 0; try { v.o.stop(); } catch (e) { } this.remote.delete(id); } }

  noise(dur, { f = 1000, q = 1, type = 'bandpass', g = 0.2, f2 = null, delay = 0, attack = 0.005 } = {}) {
    if (!this.ctx) return; const ctx = this.ctx, t = ctx.currentTime + delay;
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf; const bp = ctx.createBiquadFilter(); bp.type = type; bp.frequency.setValueAtTime(f, t); if (f2) bp.frequency.exponentialRampToValueAtTime(f2, t + dur); bp.Q.value = q;
    const gg = ctx.createGain(); gg.gain.setValueAtTime(0, t); gg.gain.linearRampToValueAtTime(g, t + attack); gg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(bp); bp.connect(gg); gg.connect(this.master); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }
  tone(f0, f1, dur, { type = 'sine', g = 0.2, delay = 0, attack = 0.005 } = {}) {
    if (!this.ctx) return; const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const gg = ctx.createGain(); gg.gain.setValueAtTime(0, t); gg.gain.linearRampToValueAtTime(g, t + attack); gg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(gg); gg.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  sip() { this.noise(0.14, { f: 7000, q: 0.6, type: 'highpass', g: 0.25 }); this.noise(0.5, { f: 3200, f2: 1500, q: 0.7, g: 0.05, delay: 0.03 }); for (let i = 0; i < 3; i++) this.tone(190, 85, 0.14, { g: 0.18, delay: 0.55 + i * 0.2, type: 'triangle' }); this.noise(0.4, { f: 600, q: 2, g: 0.05, delay: 1.3 }); this.tone(130, 100, 0.25, { g: 0.08, delay: 1.35, type: 'sawtooth' }); }
  puff() { this.noise(0.55, { f: 800, f2: 2400, q: 1.5, g: 0.06 }); this.noise(0.9, { f: 3000, q: 0.8, g: 0.02, delay: 0.5 }); }
  clink() { this.tone(3200, 2600, 0.25, { g: 0.1, type: 'triangle' }); this.tone(4700, 4000, 0.18, { g: 0.06, delay: 0.04, type: 'triangle' }); }
  pop() { this.tone(520, 150, 0.09, { g: 0.2 }); this.noise(0.12, { f: 6500, type: 'highpass', g: 0.15 }); }
  horn() { this.tone(392, 380, 0.55, { type: 'square', g: 0.09 }); this.tone(494, 480, 0.55, { type: 'square', g: 0.08 }); }
  bump(v) { this.tone(110, 40, 0.18, { g: 0.2 * v }); this.noise(0.12, { f: 700, q: 0.8, g: 0.12 * v }); }
  boop() { this.tone(900, 400, 0.16, { g: 0.14, type: 'triangle' }); this.tone(500, 260, 0.2, { g: 0.1, delay: 0.1, type: 'square' }); }
  pump() { this.noise(1.0, { f: 500, q: 0.7, g: 0.12, type: 'lowpass' }); this.tone(220, 330, 0.9, { g: 0.03, type: 'sawtooth' }); }
  dump() { this.noise(0.9, { f: 900, f2: 250, q: 0.6, g: 0.18 }); }
  click() { this.tone(900, 700, 0.04, { g: 0.06, type: 'square' }); }
  countdown(final) { this.tone(final ? 880 : 520, final ? 880 : 520, final ? 0.5 : 0.18, { g: 0.14, type: 'sine' }); }
  fanfare() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, f, 0.35, { g: 0.12, delay: i * 0.13, type: 'triangle' })); }
  ambience() {
    if (!this.ctx) return;
    if (Math.random() < 0.55) { // crickets
      const base = 4200 + Math.random() * 500, n = 3 + (Math.random() * 3 | 0);
      for (let i = 0; i < n; i++) this.tone(base, base * 0.99, 0.04, { g: 0.012, delay: i * 0.055, type: 'sine' });
    }
    if (Math.random() < 0.025) { // distant bird
      const f = 2200 + Math.random() * 1200;
      this.tone(f, f * 1.5, 0.12, { g: 0.03 }); this.tone(f * 1.5, f * 0.8, 0.18, { g: 0.03, delay: 0.12 });
    }
  }
}
