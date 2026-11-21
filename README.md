# Acoustic Data Link (SW-41) — CyberNomads

Browser-based acoustic modem: text → FSK tones → speaker → air → microphone → text.
No build step, no dependencies. Open `index.html` (mic needs **HTTPS or localhost**).

```
python3 -m http.server 8000        # then open http://localhost:8000 (laptop)
# for a 2nd device: deploy to GitHub Pages / Netlify Drop / Vercel (all HTTPS)
node test/loopback.test.js         # DSP test-suite, no browser needed
```

## Files
| File | What | 
|---|---|
| `modem.js` | All DSP: framing, CRC-16, Hamming(7,4)+interleaver, M-FSK modulator, Goertzel receiver, channel simulator. Runs in browser and Node. |
| `app.js` | Web Audio I/O, spectrum + waterfall, bitstream view, buttons |
| `index.html`, `style.css` | UI |
| `test/loopback.test.js` | CRC, FEC, burst errors, noise/echo per mode, false-alarm, back-to-back frames |

## Frame format (matches the deck, plus FEC)
`silence | 8x sync tone | 4x alignment marker | header (length, Hamming) | payload+CRC16 (Hamming, interleaved) | silence`

| Mode | Tones | Symbol | Raw rate | "Hello, Bits2Wave!" |
|---|---|---|---|---|
| robust | 1k / 2k (sync 1.5k) | 60 ms | 16.7 bps | ~18 s |
| fast | 4 tones 1–2.2k | 40 ms | 50 bps | ~6.4 s |
| turbo | 4 tones 1–2.2k | 25 ms | 80 bps | ~4.1 s |
| max (experimental) | 8 tones 1–3.45k | 20 ms | 150 bps | ~2.4 s |

Hamming(7,4) costs 43 % of throughput; payload throughput is ≈ 4/7 of raw. Hitting "100+ bps" honestly = `max` mode working over the air.

## 24-hour plan for 4 people
| Who | Owns | Hours |
|---|---|---|
| **A · DSP lead** | `modem.js`: over-the-air tuning (thresholds `minAmp`/`ratio`, window sizes, per-device calibration), auto-detect mode from sync tone, soft-decision FEC / Reed-Solomon | 0–18 |
| **B · Field tester** | Over-the-air tests: 2+ laptops/phones, distances 0.5/1/2 m, noisy room. Fill the results table (BER, success %, range) — this is your "validated metrics" slide | 2–20 |
| **C · Frontend/UX** | Polish UI, mobile layout, PWA/offline install, QR link to the page, send file/small image (chunking) | 0–16 |
| **D · Security feature + pitch** | AES-GCM encrypted payload with passphrase (WebCrypto) → "key & token exchange" use case; demo script; slides; deploy on HTTPS | 4–24 |

Milestones: **H4** two devices decode in a quiet room · **H10** noise tests logged · **H16** feature freeze · **H20** deploy + rehearse demo · **H22** record a backup demo video.

## Known limits / next steps
- Receiver and sender must pick the same mode (auto-detect is a good stretch goal).
- `ScriptProcessorNode` is deprecated but universal; swap for an AudioWorklet if time allows.
- Clock drift is not tracked (fine for messages under ~15 s).
- Tested: simulated noise + echo + random delay, plus Chromium with a fake microphone. **Not yet tested speaker→air→mic on real hardware**; that is the first thing to do.
