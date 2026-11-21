/*
 * Acoustic Data Link — modem core (SW-41, CyberNomads)
 * Pure DSP, no DOM. Works in the browser (window.Modem) and Node (require).
 *
 * Frame on the air:
 *   [ silence ][ SYNC tone x8 ][ MARKER x4 (lo,hi,lo,hi) ][ HEADER ][ BODY ][ silence ]
 *   HEADER = payload length byte, Hamming(7,4) coded (14 bits)
 *   BODY   = payload + CRC-16, Hamming(7,4) coded, block-interleaved
 * Bits are packed k bits per symbol (k = log2(#tones)) and sent as M-FSK.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Modem = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PRE_SYNC = 8;   // sync-tone symbols
  const MARKER = 4;     // known alignment symbols after sync
  const HDR_BITS = 14;  // length byte, Hamming coded
  const MAX_LEN = 255;

  const MODES = {
    robust: { label: 'Robust · 2-FSK · 60 ms',  tones: [1000, 2000], sync: 1500, symT: 0.060 },
    fast:   { label: 'Fast · 4-FSK · 40 ms',    tones: [1000, 1400, 1800, 2200], sync: 2600, symT: 0.040 },
    turbo:  { label: 'Turbo · 4-FSK · 25 ms',   tones: [1000, 1400, 1800, 2200], sync: 2600, symT: 0.025 },
    max:    { label: 'Max · 8-FSK · 20 ms (experimental)',
              tones: [1000, 1350, 1700, 2050, 2400, 2750, 3100, 3450], sync: 3800, symT: 0.020 },
  };
  for (const k in MODES) {
    const m = MODES[k];
    m.key = k;
    m.bitsPerSym = Math.round(Math.log2(m.tones.length));
    m.rawBps = m.bitsPerSym / m.symT;
  }

  // ---------- bit helpers ----------
  function bytesToBits(bytes) {
    const out = [];
    for (const b of bytes) for (let i = 7; i >= 0; i--) out.push((b >> i) & 1);
    return out;
  }
  function crc16(bytes) { // CRC-16/CCITT-FALSE
    let crc = 0xFFFF;
    for (const b of bytes) {
      crc ^= b << 8;
      for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc;
  }

  // ---------- Hamming(7,4): corrects any single bit error per codeword ----------
  function hammingEncode(n) { // n = 4-bit nibble -> 7 bits [p1 p2 d1 p3 d2 d3 d4]
    const d1 = (n >> 3) & 1, d2 = (n >> 2) & 1, d3 = (n >> 1) & 1, d4 = n & 1;
    return [d1 ^ d2 ^ d4, d1 ^ d3 ^ d4, d1, d2 ^ d3 ^ d4, d2, d3, d4];
  }
  function hammingDecode(c) { // returns {nibble, fixed}
    const s = (c[0] ^ c[2] ^ c[4] ^ c[6]) | ((c[1] ^ c[2] ^ c[5] ^ c[6]) << 1) | ((c[3] ^ c[4] ^ c[5] ^ c[6]) << 2);
    const w = c.slice();
    if (s) w[s - 1] ^= 1;
    return { nibble: (w[2] << 3) | (w[4] << 2) | (w[5] << 1) | w[6], fixed: s ? 1 : 0 };
  }

  // ---------- framing ----------
  function utf8(str) { return Array.from(new TextEncoder().encode(str)); }
  function fromUtf8(bytes) { return new TextDecoder().decode(Uint8Array.from(bytes)); }

  /** payload bytes -> coded bit array (header + interleaved body) */
  function encodeBits(payload) {
    if (payload.length > MAX_LEN) throw new Error('Payload too long (max ' + MAX_LEN + ' bytes)');
    const L = payload.length;
    const hdr = [];
    for (const nib of [L >> 4, L & 15]) hdr.push(...hammingEncode(nib));
    const crc = crc16([L, ...payload]);
    const body = [...payload, crc >> 8, crc & 255];
    const cws = [];
    for (const b of body) { cws.push(hammingEncode(b >> 4)); cws.push(hammingEncode(b & 15)); }
    const n = cws.length, bits = new Array(n * 7);
    for (let r = 0; r < n; r++) for (let c = 0; c < 7; c++) bits[c * n + r] = cws[r][c]; // interleave
    return hdr.concat(bits);
  }

  function bitsToSymbols(bits, k) {
    const out = [];
    for (let i = 0; i < bits.length; i += k) {
      let v = 0;
      for (let j = 0; j < k; j++) v = (v << 1) | (bits[i + j] || 0);
      out.push(v);
    }
    return out;
  }
  function symbolsToBits(syms, k) {
    const out = [];
    for (const s of syms) for (let j = k - 1; j >= 0; j--) out.push((s >> j) & 1);
    return out;
  }

  function totalSymbols(L, k) { return Math.ceil((HDR_BITS + 14 * (L + 2)) / k); }
  function messageDuration(L, modeKey) {
    const m = MODES[modeKey];
    return (0.3 + (PRE_SYNC + MARKER + totalSymbols(L, m.bitsPerSym)) * m.symT);
  }

  /** coded bits -> payload, or null. Returns {ok, payload, crcOk, fixed} */
  function decodeBits(bits) {
    const hn = [];
    let fixed = 0;
    for (let i = 0; i < 2; i++) {
      const r = hammingDecode(bits.slice(i * 7, i * 7 + 7)); hn.push(r.nibble); fixed += r.fixed;
    }
    const L = (hn[0] << 4) | hn[1];
    const n = 2 * (L + 2);
    const body = bits.slice(HDR_BITS, HDR_BITS + 7 * n);
    if (body.length < 7 * n) return { ok: false, reason: 'truncated', length: L, fixed };
    const nibs = [];
    for (let r = 0; r < n; r++) {
      const cw = [];
      for (let c = 0; c < 7; c++) cw.push(body[c * n + r]);
      const d = hammingDecode(cw); nibs.push(d.nibble); fixed += d.fixed;
    }
    const bytes = [];
    for (let i = 0; i < nibs.length; i += 2) bytes.push((nibs[i] << 4) | nibs[i + 1]);
    const payload = bytes.slice(0, L), got = (bytes[L] << 8) | bytes[L + 1];
    const crcOk = crc16([L, ...payload]) === got;
    return { ok: crcOk, crcOk, payload, length: L, fixed };
  }

  // ---------- transmitter ----------
  /** Build audio for a text/bytes payload. Returns {samples, symbols, dataSymbols, duration, ...} */
  function modulate(payload, modeKey, sr, opts) {
    opts = opts || {};
    const m = MODES[modeKey], M = m.tones.length, k = m.bitsPerSym;
    const amp = opts.amp == null ? 0.6 : opts.amp;
    const bytes = typeof payload === 'string' ? utf8(payload) : payload;
    const bits = encodeBits(bytes);
    const dataSyms = bitsToSymbols(bits, k);
    const freqSeq = [];
    const symSeq = []; // for display: index into tones, M = sync
    for (let i = 0; i < PRE_SYNC; i++) { freqSeq.push(m.sync); symSeq.push(M); }
    [0, M - 1, 0, M - 1].forEach(s => { freqSeq.push(m.tones[s]); symSeq.push(s); });
    for (const s of dataSyms) { freqSeq.push(m.tones[s]); symSeq.push(s); }

    const lead = Math.round(sr * 0.15), symN = sr * m.symT;
    const body = Math.round(symN * freqSeq.length);
    const out = new Float32Array(lead * 2 + body);
    let phase = 0;
    for (let i = 0; i < body; i++) {
      const f = freqSeq[Math.min(freqSeq.length - 1, Math.floor(i / symN))];
      phase += 2 * Math.PI * f / sr;               // phase-continuous FSK
      let a = amp;
      const fade = Math.round(sr * 0.006);          // 6 ms fade at both ends
      if (i < fade) a *= i / fade; else if (body - i < fade) a *= (body - i) / fade;
      out[lead + i] = a * Math.sin(phase);
    }
    return {
      samples: out, sr, mode: m, bytes, bits, dataSymbols: dataSyms, symbolSeq: symSeq,
      headerSyms: PRE_SYNC + MARKER, duration: out.length / sr, leadSamples: lead,
    };
  }

  // ---------- DSP ----------
  const hannCache = {};
  function hann(n) {
    if (hannCache[n]) return hannCache[n];
    const w = new Float32Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) { w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / n); s += w[i]; }
    return (hannCache[n] = { w, sum: s });
  }
  /** Goertzel amplitude of `freq` in buf[start .. start+len), Hann windowed. ~= sine amplitude. */
  function toneAmp(buf, start, len, freq, sr) {
    const { w, sum } = hann(len);
    const om = 2 * Math.PI * freq / sr, co = Math.cos(om), coeff = 2 * co;
    let s1 = 0, s2 = 0;
    for (let i = 0; i < len; i++) {
      const s = buf[start + i] * w[i] + coeff * s1 - s2; s2 = s1; s1 = s;
    }
    const re = s1 - s2 * co, im = s2 * Math.sin(om);
    return 2 * Math.hypot(re, im) / sum;
  }

  // ---------- receiver (streaming) ----------
  class Receiver {
    /** onEvent({type:'sync'|'header'|'progress'|'frame'|'fail'|'level', ...}) */
    constructor(modeKey, sr, onEvent, opts) {
      opts = opts || {};
      this.m = MODES[modeKey]; this.sr = sr; this.cb = onEvent || function () {};
      this.M = this.m.tones.length; this.k = this.m.bitsPerSym;
      this.freqs = this.m.tones.concat([this.m.sync]);
      this.symS = sr * this.m.symT;
      this.W = Math.round(this.symS * 0.5);
      this.hop = Math.max(1, Math.round(this.symS / 8));
      this.minAmp = opts.minAmp == null ? 0.003 : opts.minAmp;
      this.ratio = opts.ratio == null ? 2.5 : opts.ratio;
      this.maxLen = opts.maxLen || MAX_LEN;
      this.buf = new Float32Array(Math.round(sr * 30)); this.len = 0; this.base = 0;
      this.pos = 0; this._resetRun(); this.state = 'search';
    }
    _resetRun() { this.runStart = -1; this.runHops = 0; this.miss = 0; this.runLast = 0; }
    reset() { this.state = 'search'; this._resetRun(); this.pos = this.base + this.len; }

    push(chunk) {
      if (this.len + chunk.length > this.buf.length) {
        const nb = new Float32Array(Math.max(this.buf.length * 2, this.len + chunk.length));
        nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
      }
      this.buf.set(chunk, this.len); this.len += chunk.length;
      this._process();
      this._trim();
    }
    _keepFrom() {
      if (this.state === 'search') return (this.runStart >= 0 ? this.runStart : this.pos) - Math.round(this.symS * 2);
      return this.lockKeep;
    }
    _trim() {
      const keep = Math.max(this.base, Math.floor(this._keepFrom()));
      if (keep - this.base > this.sr * 2) {
        this.buf.copyWithin(0, keep - this.base, this.len); this.len -= keep - this.base; this.base = keep;
      }
    }
    _amps(abs, len) {
      const s = Math.round(abs) - this.base, a = new Array(this.freqs.length);
      for (let i = 0; i < a.length; i++) a[i] = toneAmp(this.buf, s, len, this.freqs[i], this.sr);
      return a;
    }
    _end() { return this.base + this.len; }

    _process() {
      for (let guard = 0; guard < 8; guard++) {
        const before = this.state + this.pos;
        if (this.state === 'search') this._search();
        else if (this.state === 'align') this._align();
        else if (this.state === 'header') this._header();
        else if (this.state === 'body') this._body();
        if (before === this.state + this.pos && this.state === 'search') break;
        if (this.state === 'search' && this._end() < this.pos + this.W) break;
        if (this.waiting) { this.waiting = false; break; }
      }
    }

    _search() {
      const M = this.M, end = this._end();
      while (this.pos + this.W <= end) {
        const a = this._amps(this.pos, this.W);
        let other = 0; for (let i = 0; i < M; i++) if (a[i] > other) other = a[i];
        const as = a[M];
        const isSync = as > this.minAmp && as > this.ratio * other;
        if (isSync) {
          if (this.runStart < 0) { this.runStart = this.pos; this.runHops = 0; }
          this.runHops++; this.runLast = this.pos; this.miss = 0;
        } else if (this.runStart >= 0 && ++this.miss >= 3) {
          if (this.runHops >= 0.6 * (PRE_SYNC * 8 - 3)) {
            this.est = this.runLast + 0.7 * this.W;       // approx. end of sync tone
            this.lockKeep = this.est - this.symS * 3;
            this.state = 'align'; this.cb({ type: 'sync', amp: as }); return;
          }
          this._resetRun();
        }
        this.pos += this.hop;
      }
    }

    _symScore(center, want) { // contrast of wanted tone vs the rest, -1..1
      const len = Math.round(this.symS * 0.7);
      const a = this._amps(center - len / 2, len);
      let other = 0; for (let i = 0; i < a.length; i++) if (i !== want && a[i] > other) other = a[i];
      return (a[want] - other) / (a[want] + other + 1e-9);
    }

    _align() {
      const need = this.est + this.symS * 5.4;
      if (this._end() < need) { this.waiting = true; return; }
      const M = this.M, expect = [0, M - 1, 0, M - 1];
      let best = -9, bestTau = this.est;
      const step = this.symS / 32;
      for (let t = this.est - this.symS * 0.75; t <= this.est + this.symS * 0.75; t += step) {
        let s = this._symScore(t - this.symS * 0.5, M);
        for (let j = 0; j < MARKER; j++) s += this._symScore(t + (j + 0.5) * this.symS, expect[j]);
        if (s > best) { best = s; bestTau = t; }
      }
      if (best / (MARKER + 1) < 0.35) { this._fail('marker not found', this.est + this.symS); return; }
      this.dataStart = bestTau + MARKER * this.symS;
      this.lockKeep = bestTau - this.symS * 2;
      this.syncScore = best / (MARKER + 1);
      this.state = 'header';
    }

    _demod(i) { // symbol i of data -> {idx, conf}
      const len = Math.round(this.symS * 0.8);
      const c = this.dataStart + (i + 0.5) * this.symS;
      const a = this._amps(c - len / 2, len);
      let b = 0, sec = 0, bi = 0;
      for (let j = 0; j < this.M; j++) {
        if (a[j] > b) { sec = b; b = a[j]; bi = j; } else if (a[j] > sec) sec = a[j];
      }
      return { idx: bi, conf: b > 0 ? 1 - sec / b : 0, amp: b };
    }

    _header() {
      const hs = Math.ceil(HDR_BITS / this.k);
      if (this._end() < this.dataStart + (hs + 0.5) * this.symS) { this.waiting = true; return; }
      const syms = []; for (let i = 0; i < hs; i++) syms.push(this._demod(i).idx);
      const bits = symbolsToBits(syms, this.k).slice(0, HDR_BITS);
      const a = hammingDecode(bits.slice(0, 7)), b = hammingDecode(bits.slice(7, 14));
      const L = (a.nibble << 4) | b.nibble;
      if (L > this.maxLen) { this._fail('bad header', this.dataStart); return; }
      this.L = L; this.nSyms = totalSymbols(L, this.k);
      this.lockKeep = this.dataStart - this.symS * 2;
      this.state = 'body';
      this.cb({ type: 'header', length: L, symbols: this.nSyms });
    }

    _body() {
      const need = this.dataStart + (this.nSyms + 0.5) * this.symS;
      const end = this._end();
      if (end < need) {
        this.cb({ type: 'progress', frac: Math.max(0, Math.min(1, (end - this.dataStart) / (this.nSyms * this.symS))) });
        this.waiting = true; return;
      }
      const syms = [], confs = [];
      for (let i = 0; i < this.nSyms; i++) { const d = this._demod(i); syms.push(d.idx); confs.push(d.conf); }
      const bits = symbolsToBits(syms, this.k);
      const r = decodeBits(bits);
      const quality = confs.reduce((x, y) => x + y, 0) / confs.length;
      this.cb({
        type: 'frame', ok: !!r.ok, text: r.payload ? fromUtf8(r.payload) : '', bytes: r.payload || [],
        length: this.L, fixed: r.fixed, quality, symbols: syms, bits: bits,
        reason: r.ok ? '' : 'CRC mismatch',
      });
      this.pos = this.dataStart + this.nSyms * this.symS;
      this.state = 'search'; this._resetRun();
    }

    _fail(reason, resumeAt) {
      this.cb({ type: 'fail', reason });
      this.pos = Math.max(this.pos, Math.round(resumeAt));
      this.state = 'search'; this._resetRun();
    }
  }

  /** Convenience: decode a full recording in one go. Returns the last 'frame' event or null. */
  function decode(samples, sr, modeKey, opts) {
    let frame = null, last = null;
    const rx = new Receiver(modeKey, sr, e => { last = e; if (e.type === 'frame') frame = e; }, opts);
    for (let i = 0; i < samples.length; i += 4096) rx.push(samples.subarray(i, Math.min(samples.length, i + 4096)));
    return frame || { type: 'none', last };
  }

  // ---------- channel simulation (for the Simulate button and tests) ----------
  function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  /** Add noise at snrDb (vs signal RMS), echo, gain, and leading silence. */
  function channel(samples, sr, o) {
    o = o || {};
    const snr = o.snrDb == null ? 10 : o.snrDb, gain = o.gain == null ? 0.3 : o.gain;
    const delay = Math.round(sr * (o.delaySec == null ? 0.37 : o.delaySec));
    const echoD = Math.round(sr * 0.035), echoG = o.echo == null ? 0.35 : o.echo;
    const n = samples.length + delay + Math.round(sr * 0.6);
    const out = new Float32Array(n);
    let pw = 0, c = 0;
    for (let i = 0; i < samples.length; i++) if (samples[i] !== 0) { pw += samples[i] * samples[i]; c++; }
    const sig = Math.sqrt(pw / Math.max(1, c)) * gain;
    const sigma = sig / Math.pow(10, snr / 20);
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i] * gain;
      out[i + delay] += x;
      if (i + delay + echoD < n) out[i + delay + echoD] += x * echoG;
    }
    for (let i = 0; i < n; i++) out[i] += gauss() * sigma;
    return out;
  }

  function toWav(samples, sr) {
    const n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
    return buf;
  }

  return {
    MODES, PRE_SYNC, MARKER, HDR_BITS, MAX_LEN,
    crc16, hammingEncode, hammingDecode, encodeBits, decodeBits, bitsToSymbols, symbolsToBits,
    utf8, fromUtf8, modulate, Receiver, decode, channel, toWav, toneAmp, messageDuration, totalSymbols,
  };
});
