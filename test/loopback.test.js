// Run: node test/loopback.test.js
const Modem = require('../modem.js');
const SR = 48000;
let fail = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fail++; };

// unit: crc + hamming
check('crc16 known vector', Modem.crc16(Array.from(Buffer.from('123456789'))) === 0x29B1);
let hamOk = true;
for (let n = 0; n < 16; n++) for (let e = -1; e < 7; e++) {
  const c = Modem.hammingEncode(n); if (e >= 0) c[e] ^= 1;
  if (Modem.hammingDecode(c).nibble !== n) hamOk = false;
}
check('hamming corrects every single-bit error', hamOk);

// bits round trip (no audio)
const msg = 'Hello, Bits2Wave! नमस्ते';
const bytes = Modem.utf8(msg);
const r0 = Modem.decodeBits(Modem.encodeBits(bytes));
check('bit-level round trip incl. UTF-8', r0.ok && Modem.fromUtf8(r0.payload) === msg);

// burst error in coded bits gets fixed by interleaver
const cb = Modem.encodeBits(bytes);
for (let i = 40; i < 40 + bytes.length; i++) cb[i] ^= 1; // burst
const r1 = Modem.decodeBits(cb);
check('interleaver fixes burst of ' + bytes.length + ' bits', r1.ok, 'fixed=' + r1.fixed);

// audio loopback, every mode, several channel conditions
const text = 'Hello, Bits2Wave!';
const trials = { robust: [20, 10, 3], fast: [20, 10, 5], turbo: [20, 10, 6], max: [25, 15] };
for (const mode in trials) {
  for (const snr of trials[mode]) {
    let okCount = 0, N = 6, fixed = 0;
    for (let t = 0; t < N; t++) {
      const tx = Modem.modulate(text, mode, SR);
      const rxs = Modem.channel(tx.samples, SR, { snrDb: snr, delaySec: 0.2 + Math.random() * 1.3, echo: 0.3, gain: 0.05 + Math.random() * 0.3 });
      const f = Modem.decode(rxs, SR, mode);
      if (f.type === 'frame' && f.ok && f.text === text) { okCount++; fixed += f.fixed; }
    }
    const dur = Modem.messageDuration(Modem.utf8(text).length, mode).toFixed(1);
    check(`${mode.padEnd(6)} SNR ${String(snr).padStart(2)} dB  ${okCount}/${N}  (${dur}s, fec fixes ${fixed})`, okCount >= N - (snr <= 5 ? 2 : 0));
  }
}

// silence / random noise must not produce a frame
const noise = new Float32Array(SR * 6).map(() => (Math.random() - 0.5) * 0.2);
const f = Modem.decode(noise, SR, 'robust');
check('pure noise yields no frame', f.type !== 'frame');

// two back-to-back messages in one stream
const a = Modem.modulate('one', 'fast', SR).samples, b = Modem.modulate('two', 'fast', SR).samples;
const both = new Float32Array(a.length + b.length); both.set(a); both.set(b, a.length);
const got = [];
const rx = new Modem.Receiver('fast', SR, e => { if (e.type === 'frame') got.push(e.text); });
for (let i = 0; i < both.length; i += 4096) rx.push(both.subarray(i, i + 4096));
check('two consecutive frames', got.join(',') === 'one,two', got.join(','));

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
