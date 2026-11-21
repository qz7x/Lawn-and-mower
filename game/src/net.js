/* Multiplayer: three interchangeable transports under one session protocol.
 *   RoomTransport  - Claude artifact `room` capability (realtime, no server; only where the artifact exposes it)
 *   LocalTransport - BroadcastChannel (other tabs of the same browser)
 *   P2PHost/Guest  - WebRTC data channels, signalled by copy/pasting two codes (works in a normal browser tab)
 */
import { angDiff, clamp } from './util.js';

/* ---------------------------------------------------------------- transports */
export class LocalTransport {
  constructor(room) { this.kind = 'local'; this.bc = new BroadcastChannel('bnb-' + room); this.bc.onmessage = e => this.onmsg && this.onmsg(e.data); }
  async open() { }
  send(m) { this.bc.postMessage(m); }
  close() { this.bc.close(); }
}

export class RoomTransport {
  constructor(api) { this.kind = 'room'; this.api = api; }
  static async probe() {
    try { if (!window.claude || !window.claude.use) return null; return await window.claude.use('room'); } catch (e) { return null; }
  }
  async open(code) {
    this.room = await this.api.join('bnb-' + String(code).toLowerCase().replace(/[^a-z0-9]/g, ''));
    this.off = this.room.on('g', msg => { if (msg.sameTab) return; if (this.onmsg) this.onmsg(msg.data); }, e => this.onerror && this.onerror(e));
  }
  send(m) { try { this.room.emit('g', m).catch(() => { }); } catch (e) { } }
  close() { try { this.off && this.off(); this.room && this.room.leave(); } catch (e) { } }
}

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const enc = o => 'BNB1:' + btoa(unescape(encodeURIComponent(JSON.stringify({ type: o.type, sdp: o.sdp }))));
const dec = s => JSON.parse(decodeURIComponent(escape(atob(String(s).trim().replace(/^BNB1:/, '').replace(/\s+/g, '')))));
function gathered(pc, ms = 4000) {
  return new Promise(res => {
    if (pc.iceGatheringState === 'complete') return res();
    const t = setTimeout(res, ms);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
  });
}

export class P2PHost {
  constructor() { this.kind = 'p2p-host'; this.chans = new Set(); this.pending = 0; }
  async open() { }
  /** Create an invite for one friend. Returns { code, accept(answerCode) }. */
  async invite() {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const dc = pc.createDataChannel('g', { ordered: false, maxRetransmits: 0 });
    const hook = () => {
      dc.onopen = () => { this.chans.add(dc); this.onpeer && this.onpeer(true); };
      dc.onclose = () => { this.chans.delete(dc); this.onpeer && this.onpeer(false); };
      dc.onmessage = e => {
        let m; try { m = JSON.parse(e.data); } catch (x) { return; }
        if (this.onmsg) this.onmsg(m);
        for (const c of this.chans) if (c !== dc && c.readyState === 'open') c.send(e.data);     // star relay
      };
    }; hook();
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    return { code: enc(pc.localDescription), accept: async answer => { await pc.setRemoteDescription(dec(answer)); } };
  }
  send(m) { const s = JSON.stringify(m); for (const c of this.chans) if (c.readyState === 'open') c.send(s); }
  close() { for (const c of this.chans) c.close(); }
}

export class P2PGuest {
  constructor() { this.kind = 'p2p-guest'; this.dc = null; }
  async open() { }
  /** Takes the host's invite code, returns the answer code to send back. */
  async join(offerCode) {
    const pc = this.pc = new RTCPeerConnection({ iceServers: ICE });
    pc.ondatachannel = e => {
      const dc = this.dc = e.channel;
      dc.onopen = () => this.onopen && this.onopen();
      dc.onclose = () => this.onclose && this.onclose();
      dc.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (x) { return; } this.onmsg && this.onmsg(m); };
    };
    await pc.setRemoteDescription(dec(offerCode));
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    return enc(pc.localDescription);
  }
  send(m) { if (this.dc && this.dc.readyState === 'open') this.dc.send(JSON.stringify(m)); }
  close() { try { this.pc && this.pc.close(); } catch (e) { } }
}

/* ---------------------------------------------------------------- session protocol */
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };

export class Session {
  constructor(me) { this.me = me; this.players = new Map(); this.tr = null; this.on = {}; this.matchSeq = 0; this.snapParts = null; this.lastPrune = 0; }
  attach(tr) {
    this.tr = tr; tr.onmsg = m => this.recv(m);
    this.send({ k: 'h', n: this.me.name, c: this.me.color });
  }
  get connected() { return !!this.tr; }
  send(m) { if (!this.tr) return; m.i = this.me.id; this.tr.send(m); }
  sendState(p, score, extra) { this.send({ k: 's', n: this.me.name, c: this.me.color, p, sc: score, ...extra }); }
  sendMatch(st, mode, seed, dur) { this.matchSeq += 1; this.matchKey = this.matchSeq + ':' + this.me.id; const m = { k: 'm', q: this.matchSeq, st, mode, seed, dur }; this.send(m); return m; }
  recv(m) {
    if (!m || typeof m !== 'object' || m.i === this.me.id) return;
    const now = performance.now();
    switch (m.k) {
      case 's': {
        let p = this.players.get(m.i);
        if (!p) { p = { id: m.i, name: '?', color: 0, snaps: [], score: 0, idx: this.players.size + 1, last: now }; this.players.set(m.i, p); this.on.join && this.on.join(p); }
        p.name = String(m.n || '?').slice(0, 16); p.color = (m.c | 0) % 6; p.score = m.sc | 0; p.last = now; p.extra = m;
        if (Array.isArray(m.p)) { p.snaps.push({ t: now, p: m.p }); if (p.snaps.length > 8) p.snaps.shift(); }
        break;
      }
      case 'h': {
        // A newcomer: the lowest id among everyone else answers with match state + a coverage snapshot.
        const ids = [this.me.id, ...[...this.players.keys()].filter(i => i !== m.i)].sort();
        if (ids[0] === this.me.id) this.on.hello && this.on.hello(m);
        break;
      }
      case 'm': {
        // newest wins; equal sequence numbers (two simultaneous starts) resolve to the lowest player id
        const key = m.q + ':' + m.i;
        if (key !== this.matchKey && (m.q > this.matchSeq || (m.q === this.matchSeq && m.i < (this.matchKey || '0:~').split(':')[1]))) { this.matchSeq = m.q; this.matchKey = key; this.on.match && this.on.match(m); }
        break;
      }
      case 'sn': if (m.to === this.me.id) this.gotSnap(m); break;
      case 'g': this.on.gnome && this.on.gnome(m); break;
      case 'hn': this.on.horn && this.on.horn(m); break;
      case 'b': this.drop(m.i); break;
    }
  }
  drop(id) { const p = this.players.get(id); if (p) { this.players.delete(id); this.on.leave && this.on.leave(p); } }
  prune() {
    const now = performance.now();
    if (now - this.lastPrune < 1000) return; this.lastPrune = now;
    for (const p of [...this.players.values()]) if (now - p.last > 5000) this.drop(p.id);
  }
  sendSnapshot(to, bits) {
    const CH = 2400, n = Math.ceil(bits.length / CH);
    for (let a = 0; a < n; a++) this.send({ k: 'sn', to, a, n, d: b64(bits.subarray(a * CH, (a + 1) * CH)) });
  }
  gotSnap(m) {
    if (!this.snapParts || this.snapParts.n !== m.n) this.snapParts = { n: m.n, got: new Map() };
    this.snapParts.got.set(m.a, unb64(m.d));
    if (this.snapParts.got.size === m.n) {
      const total = [...this.snapParts.got.values()].reduce((s, u) => s + u.length, 0), out = new Uint8Array(total);
      let o = 0; for (let a = 0; a < m.n; a++) { const u = this.snapParts.got.get(a); out.set(u, o); o += u.length; }
      this.snapParts = null; this.on.snapshot && this.on.snapshot(out);
    }
  }
  /** Interpolated state of a remote player ~110 ms in the past. p = [x, z, h, v, steer, flags, rpm] */
  sample(pl, delay = 110) {
    const s = pl.snaps; if (!s.length) return null;
    const t = performance.now() - delay;
    let a = s[0], b = s[s.length - 1];
    if (t >= b.t) {
      const dt = Math.min((t - b.t) / 1000, 0.35), v = b.p[3], h = b.p[2];
      return [b.p[0] + Math.sin(h) * v * dt, b.p[1] + Math.cos(h) * v * dt, h, v, b.p[4], b.p[5], b.p[6]];
    }
    for (let i = s.length - 1; i > 0; i--) if (s[i - 1].t <= t) { a = s[i - 1]; b = s[i]; break; }
    if (t <= a.t) return a.p.slice();
    const k = clamp((t - a.t) / Math.max(b.t - a.t, 1), 0, 1);
    const L = (x, y) => x + (y - x) * k;
    return [L(a.p[0], b.p[0]), L(a.p[1], b.p[1]), a.p[2] + angDiff(b.p[2], a.p[2]) * k, L(a.p[3], b.p[3]), L(a.p[4], b.p[4]), b.p[5], L(a.p[6], b.p[6])];
  }
  close() { try { this.send({ k: 'b' }); this.tr && this.tr.close(); } catch (e) { } this.tr = null; this.players.clear(); }
}
