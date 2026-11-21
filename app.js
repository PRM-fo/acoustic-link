/* UI glue: Web Audio I/O, live spectrum, bitstream view. DSP lives in modem.js. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const MODES = Modem.MODES;

  let ctx = null;              // shared AudioContext
  let txAnalyser = null, micAnalyser = null;
  let micStream = null, micNode = null, proc = null, receiver = null, listening = false;
  let lastTx = null, txStart = 0, txPlaying = false, txSource = null;
  let boost = 1;

  // ---------- helpers ----------
  const log = s => { const el = $('log'); el.textContent += new Date().toLocaleTimeString() + '  ' + s + '\n'; el.scrollTop = el.scrollHeight; };
  function setStatus(kind, text) { const p = $('status'); p.className = 'pill ' + (kind || ''); $('statusText').textContent = text; }
  function symColor(idx, M) { // sync = violet; tones fan from cyan to amber
    if (idx >= M) return '#a78bfa';
    if (M === 2) return idx ? '#fbbf24' : '#38bdf8';
    return 'hsl(' + Math.round(195 - idx * (150 / (M - 1))) + ' 85% 60%)';
  }
  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  const mode = () => MODES[$('mode').value];
  const fmtRate = bps => bps.toFixed(bps < 100 ? 1 : 0) + ' bps';

  // ---------- init UI ----------
  for (const k in MODES) { const o = document.createElement('option'); o.value = k; o.textContent = MODES[k].label; $('mode').appendChild(o); }
  $('mode').value = 'fast';
  function refreshEta() {
    const m = mode(), L = Modem.utf8($('msg').value).length;
    $('eta').textContent = L + ' bytes · ≈ ' + Modem.messageDuration(L, m.key).toFixed(1) + ' s on air · raw ' + fmtRate(m.rawBps) +
      ' · tones ' + m.tones.join('/') + ' Hz, sync ' + m.sync + ' Hz';
    $('sRate').textContent = fmtRate(m.rawBps);
    const lg = $('legend'); lg.innerHTML = '';
    m.tones.forEach((f, i) => { const s = document.createElement('span'); s.style.setProperty('--c', symColor(i, m.tones.length)); s.textContent = (m.tones.length === 2 ? 'Bit ' + i + ' · ' : 'Sym ' + i + ' · ') + f + ' Hz'; lg.appendChild(s); });
    const s = document.createElement('span'); s.style.setProperty('--c', '#a78bfa'); s.textContent = 'Sync · ' + m.sync + ' Hz'; lg.appendChild(s);
  }
  $('mode').onchange = () => { refreshEta(); if (listening) { stopListen(); startListen(); } };
  $('msg').oninput = refreshEta;
  $('vol').oninput = e => $('volOut').textContent = e.target.value + '%';
  $('snr').oninput = e => $('snrOut').textContent = e.target.value + ' dB';
  $('boost').oninput = e => { boost = +e.target.value; $('boostOut').textContent = '×' + boost; };
  refreshEta();

  // ---------- bitstream cells ----------
  function drawCells(el, syms, M, cls) {
    el.innerHTML = '';
    const frag = document.createDocumentFragment();
    syms.forEach(s => { const i = document.createElement('i'); i.style.setProperty('--c', symColor(s, M)); if (cls) i.className = cls; frag.appendChild(i); });
    el.appendChild(frag);
  }

  // ---------- transmit ----------
  async function transmit() {
    if (txPlaying) return;
    const text = $('msg').value; if (!text) return;
    const c = getCtx(), m = mode();
    let tx;
    try { tx = Modem.modulate(text, m.key, c.sampleRate, { amp: 0.9 }); } catch (e) { log('TX error: ' + e.message); return; }
    lastTx = tx;
    const buf = c.createBuffer(1, tx.samples.length, c.sampleRate); buf.copyToChannel(tx.samples, 0);
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain(); g.gain.value = $('vol').value / 100;
    if (!txAnalyser) { txAnalyser = c.createAnalyser(); txAnalyser.fftSize = 4096; txAnalyser.smoothingTimeConstant = 0.5; }
    src.connect(g); g.connect(txAnalyser); txAnalyser.connect(c.destination);
    // symbol view
    drawCells($('txBits'), tx.symbolSeq, m.tones.length);
    $('sBits').textContent = '0/' + (tx.dataSymbols.length * m.bitsPerSym);
    txStart = c.currentTime + 0.05; txPlaying = true; txSource = src;
    src.start(txStart);
    setStatus('tx', 'Transmitting'); $('btnTx').disabled = true;
    log('TX ' + m.key + ': "' + text + '" · ' + tx.bytes.length + ' B · ' + tx.symbolSeq.length + ' symbols · ' + tx.duration.toFixed(1) + ' s');
    src.onended = () => {
      txPlaying = false; $('btnTx').disabled = false;
      setStatus(listening ? 'rx' : '', listening ? 'Listening' : 'Idle');
      $('sBits').textContent = (tx.dataSymbols.length * m.bitsPerSym) + '/' + (tx.dataSymbols.length * m.bitsPerSym);
      $('sThru').textContent = fmtRate(tx.bytes.length * 8 / (tx.duration - 0.3));
      log('TX done');
    };
  }

  // ---------- receive events (shared by mic + simulation) ----------
  function onRx(e) {
    const m = mode(), M = m.tones.length;
    if (e.type === 'sync') { setStatus('sync', 'Sync locked'); log('RX sync preamble detected'); }
    else if (e.type === 'header') { log('RX header: ' + e.length + ' bytes, ' + e.symbols + ' symbols'); setStatus('sync', 'Receiving ' + e.length + ' B'); }
    else if (e.type === 'progress') { $('prog').style.width = (e.frac * 100).toFixed(0) + '%'; }
    else if (e.type === 'fail') { log('RX false start (' + e.reason + ')'); setStatus(listening ? 'rx' : '', listening ? 'Listening' : 'Idle'); }
    else if (e.type === 'frame') {
      $('prog').style.width = '100%';
      const box = $('rxMsg');
      box.className = 'rxmsg ' + (e.ok ? 'ok' : 'bad');
      box.textContent = '';
      const t = document.createElement('div'); t.textContent = e.ok ? e.text : (e.text || '(unreadable)'); box.appendChild(t);
      const s = document.createElement('small');
      s.style.color = e.ok ? 'var(--ok)' : 'var(--bad)';
      s.textContent = e.ok ? '● Message received, CRC OK' : '● ' + e.reason + ' — packet rejected';
      box.appendChild(s);
      const crc = $('sCrc'); crc.textContent = e.ok ? 'PASS' : 'FAIL'; crc.className = e.ok ? 'ok' : 'bad';
      $('sFec').textContent = e.fixed + ' bit' + (e.fixed === 1 ? '' : 's');
      $('sQual').textContent = Math.round(e.quality * 100) + '%';
      $('sBits').textContent = e.bits.length + '/' + e.bits.length;
      // compare with last TX if we have it (same device / simulation)
      let cls = 'done', errs = 0, cmp = '';
      const rows = document.createElement('div');
      drawCells($('rxBits'), e.symbols, M, 'done');
      if (lastTx && lastTx.dataSymbols.length === e.symbols.length) {
        const cells = $('rxBits').children;
        e.symbols.forEach((s, i) => { if (s !== lastTx.dataSymbols[i]) { cells[i].className = 'err'; errs++; } });
        cmp = errs + ' of ' + e.symbols.length + ' symbols wrong before FEC';
      }
      $('ber').textContent = cmp ? ' · ' + cmp : '';
      log('RX ' + (e.ok ? 'OK' : 'REJECTED') + ': "' + e.text + '" · FEC fixed ' + e.fixed + ' · quality ' + Math.round(e.quality * 100) + '%' + (cmp ? ' · ' + cmp : ''));
      const dur = (e.symbols.length * m.symT);
      if (e.ok) $('sThru').textContent = fmtRate(e.bytes.length * 8 / dur);
      setTimeout(() => { $('prog').style.width = '0'; }, 1500);
      setStatus(listening ? 'rx' : '', listening ? 'Listening' : 'Idle');
    }
  }

  // ---------- listen (microphone) ----------
  async function startListen() {
    if (listening) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { log('Microphone API unavailable — use HTTPS or localhost.'); return; }
    const c = getCtx();
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    } catch (e) { log('Mic permission failed: ' + e.message); return; }
    const track = micStream.getAudioTracks()[0], st = track.getSettings ? track.getSettings() : {};
    log('Mic open · echoCancellation=' + st.echoCancellation + ' noiseSuppression=' + st.noiseSuppression + ' autoGain=' + st.autoGainControl + ' · ' + c.sampleRate + ' Hz');
    micNode = c.createMediaStreamSource(micStream);
    micAnalyser = c.createAnalyser(); micAnalyser.fftSize = 4096; micAnalyser.smoothingTimeConstant = 0.5;
    receiver = new Modem.Receiver($('mode').value, c.sampleRate, onRx);
    proc = c.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = ev => {
      const inp = ev.inputBuffer.getChannelData(0), buf = new Float32Array(inp.length);
      let pk = 0;
      for (let i = 0; i < inp.length; i++) { const v = inp[i] * boost; buf[i] = v; const a = Math.abs(v); if (a > pk) pk = a; }
      $('level').style.width = Math.min(100, pk * 100 * 2) + '%';
      receiver.push(buf);
    };
    const mute = c.createGain(); mute.gain.value = 0;
    micNode.connect(micAnalyser); micNode.connect(proc); proc.connect(mute); mute.connect(c.destination);
    listening = true; $('btnListen').classList.add('on'); $('btnListen').textContent = '■ Stop listening';
    setStatus('rx', 'Listening'); log('Listening in ' + $('mode').value + ' mode');
  }
  function stopListen() {
    if (!listening) return;
    try { proc.disconnect(); micNode.disconnect(); } catch (e) {}
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    micStream = micNode = proc = receiver = micAnalyser = null; listening = false;
    $('btnListen').classList.remove('on'); $('btnListen').textContent = '🎙 Listen';
    $('level').style.width = '0'; setStatus('', 'Idle'); log('Stopped listening');
  }

  // ---------- simulate (no audio hardware needed) ----------
  function simulate() {
    const text = $('msg').value; if (!text) return;
    const m = mode(), sr = ctx ? ctx.sampleRate : 48000, snr = +$('snr').value;
    const tx = Modem.modulate(text, m.key, sr);
    lastTx = tx;
    drawCells($('txBits'), tx.symbolSeq, m.tones.length);
    const noisy = Modem.channel(tx.samples, sr, { snrDb: snr, echo: 0.35, gain: 0.25 });
    log('SIM ' + m.key + ' · SNR ' + snr + ' dB · echo 35 % @ 35 ms · random start delay');
    $('rxMsg').className = 'rxmsg empty'; $('rxMsg').textContent = 'Decoding simulated channel…';
    let got = false;
    const wrapped = new Modem.Receiver(m.key, sr, e => { if (e.type === 'frame') got = true; onRx(e); });
    for (let i = 0; i < noisy.length; i += 4096) wrapped.push(noisy.subarray(i, Math.min(noisy.length, i + 4096)));
    if (!got) {
      $('rxMsg').className = 'rxmsg bad'; $('rxMsg').textContent = 'No packet recovered at this SNR.';
      $('sCrc').textContent = 'FAIL'; $('sCrc').className = 'bad'; log('SIM: no frame recovered');
    }
    $('sBits').textContent = (tx.dataSymbols.length * m.bitsPerSym) + '/' + (tx.dataSymbols.length * m.bitsPerSym);
  }

  // ---------- spectrum + waterfall ----------
  const spec = $('spec'), fall = $('fall');
  const sg = spec.getContext('2d'), fg = fall.getContext('2d');
  let fftBuf = null;
  function fit(c) { const r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1; const w = Math.round(r.width * d), h = Math.round(parseInt(c.getAttribute('height')) * d); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } }
  function draw() {
    requestAnimationFrame(draw);
    fit(spec); fit(fall);
    const m = mode(), W = spec.width, H = spec.height;
    const an = txPlaying ? txAnalyser : micAnalyser;
    sg.clearRect(0, 0, W, H);
    // tone markers
    const fx = f => f / 4000 * W;
    sg.font = (11 * (window.devicePixelRatio || 1)) + 'px system-ui'; sg.textBaseline = 'top';
    m.tones.concat([m.sync]).forEach((f, i) => {
      sg.strokeStyle = symColor(i, m.tones.length) + '66'; sg.fillStyle = symColor(i, m.tones.length);
      sg.setLineDash([4, 4]); sg.beginPath(); sg.moveTo(fx(f), 0); sg.lineTo(fx(f), H); sg.stroke(); sg.setLineDash([]);
      sg.fillText(i === m.tones.length ? 'SYNC' : String(f), fx(f) + 4, 4);
    });
    let col = null;
    if (an) {
      if (!fftBuf || fftBuf.length !== an.frequencyBinCount) fftBuf = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(fftBuf);
      const sr = an.context.sampleRate, binHz = sr / an.fftSize, n = Math.floor(4000 / binHz);
      col = new Array(n);
      sg.beginPath(); sg.moveTo(0, H);
      for (let i = 0; i < n; i++) {
        const v = Math.max(0, Math.min(1, (fftBuf[i] + 110) / 80)); col[i] = v;
        sg.lineTo(i * binHz / 4000 * W, H - v * H);
      }
      sg.lineTo(W, H); sg.closePath();
      const gr = sg.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#38bdf8cc'); gr.addColorStop(1, '#38bdf811');
      sg.fillStyle = gr; sg.fill();
    }
    // waterfall: scroll left 2px and add a column
    const fw = fall.width, fh = fall.height, d = window.devicePixelRatio || 1, step = Math.max(1, Math.round(2 * d));
    fg.drawImage(fall, step, 0, fw - step, fh, 0, 0, fw - step, fh);
    fg.fillStyle = '#080e1b'; fg.fillRect(fw - step, 0, step, fh);
    if (col) {
      for (let y = 0; y < fh; y++) {
        const v = Math.max(0, (col[Math.min(col.length - 1, Math.floor((1 - y / fh) * col.length))] - 0.35) / 0.65);
        fg.fillStyle = 'hsl(' + (240 - v * 200) + ' 90% ' + (8 + v * 52) + '%)';
        fg.fillRect(fw - step, y, step, 1);
      }
    }
    // TX playback cursor in the symbol strip
    if (txPlaying && lastTx) {
      const t = ctx.currentTime - txStart - 0.15, idx = Math.floor(t / lastTx.mode.symT);
      const cells = $('txBits').children;
      for (let i = 0; i < cells.length; i++) cells[i].className = i < idx ? 'done' : (i === idx ? 'cur' : '');
      const dataBits = lastTx.dataSymbols.length * lastTx.mode.bitsPerSym;
      const sent = Math.max(0, Math.min(dataBits, (idx - lastTx.headerSyms) * lastTx.mode.bitsPerSym));
      $('sBits').textContent = sent + '/' + dataBits;
    }
  }
  draw();

  // ---------- buttons ----------
  $('btnTx').onclick = transmit;
  $('btnListen').onclick = () => listening ? stopListen() : startListen();
  $('btnSim').onclick = simulate;
  $('btnWav').onclick = () => {
    if (!lastTx) { log('Transmit or simulate once first.'); return; }
    const url = URL.createObjectURL(new Blob([Modem.toWav(lastTx.samples, lastTx.sr)], { type: 'audio/wav' }));
    const a = document.createElement('a'); a.href = url; a.download = 'acoustic-link-' + lastTx.mode.key + '.wav'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  window.addEventListener('beforeunload', stopListen);
  log('Ready. Simulate works without audio hardware; Listen + Transmit on two devices is the real thing.');
})();
