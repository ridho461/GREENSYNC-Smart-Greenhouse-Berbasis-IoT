/* =====================================================
   GREENSYNC – Smart Greenhouse Berbasis IoT
   Tim: Ridho Syahban, Irvan Dinata, Tika Juni Lestari,
        Putri Dawolo, Nur Nabillah

   MODE DATA
   - demo : data simulasi (default), tanpa perangkat
   - live : membaca data dari ESP32 melalui HTTP

   KONTRAK API ESP32 (mode live)
   GET  {url}/api/data
        -> {"temp":28.4,"hum":71,"soil":55,"light":62,"gas":12,
            "pump":false,"fan":false,"grow":false}
   POST {url}/api/control
        body JSON: {"device":"pump|fan|grow","state":true|false}
        atau       {"soil_th":40,"temp_th":32,"light_th":30,"gas_th":50}
        atau       {"mode":"auto|manual"}
   Catatan: ESP32 harus mengaktifkan CORS
   (header Access-Control-Allow-Origin: *).
   Jika website dibuka lewat https, browser dapat memblokir
   permintaan ke http://IP-ESP32 (mixed content). Buka website
   lewat file lokal atau http saat memakai mode live.
   ===================================================== */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAX_POINTS = 40;
  const RING_LEN = 326.7;

  /* ---------- State ---------- */
  const state = {
    source: 'demo',
    url: '',
    mode: 'auto',
    data: { temp: 28, hum: 70, soil: 55, light: 60, gas: 12 },
    dev: { pump: false, fan: false, grow: false },
    th: { soil: 40, temp: 32, light: 30, gas: 50 },
    hist: { temp: [], hum: [], soil: [], light: [], gas: [] },
    gasSpike: 0,
    tick: 0,
    timer: null
  };

  try {
    const saved = JSON.parse(localStorage.getItem('greensync-conn') || '{}');
    if (saved.source) state.source = saved.source;
    if (saved.url) state.url = saved.url;
  } catch (_) { /* abaikan */ }

  /* ---------- Util ---------- */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pad = (n) => String(n).padStart(2, '0');
  const nowStr = () => {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function log(msg) {
    const li = document.createElement('li');
    li.innerHTML = `<time>${nowStr()}</time><span>${msg}</span>`;
    const ul = $('logList');
    ul.prepend(li);
    while (ul.children.length > 30) ul.removeChild(ul.lastChild);
  }

  /* ---------- Navbar & hero ---------- */
  $('burger').addEventListener('click', () => $('navLinks').classList.toggle('open'));
  document.querySelectorAll('#navLinks a').forEach(a =>
    a.addEventListener('click', () => $('navLinks').classList.remove('open')));

  (function leaves() {
    const box = $('leaves');
    const icons = ['🍃', '🌿', '🌱', '🍀'];
    for (let i = 0; i < 16; i++) {
      const s = document.createElement('span');
      s.className = 'leaf';
      s.textContent = icons[i % icons.length];
      s.style.left = Math.random() * 100 + '%';
      s.style.animationDuration = 10 + Math.random() * 14 + 's';
      s.style.animationDelay = -Math.random() * 20 + 's';
      s.style.fontSize = 0.9 + Math.random() * 1.2 + 'rem';
      box.appendChild(s);
    }
  })();

  /* ---------- Sensor UI ---------- */
  function setRing(id, pct) {
    $(id).style.strokeDashoffset = RING_LEN * (1 - clamp(pct, 0, 100) / 100);
  }

  function setStatus(id, text, level) {
    const el = $(id);
    el.textContent = text;
    el.className = 's-status' + (level ? ' ' + level : '');
  }

  function renderSensors() {
    const { temp, hum, soil, light, gas } = state.data;

    $('valTemp').textContent = temp.toFixed(1);
    $('valHum').textContent = Math.round(hum);
    $('valSoil').textContent = Math.round(soil);
    $('valLight').textContent = Math.round(light);
    $('valGas').textContent = Math.round(gas);

    setRing('ringTemp', (temp / 50) * 100);
    setRing('ringHum', hum);
    setRing('ringSoil', soil);
    setRing('ringLight', light);
    setRing('ringGas', gas);

    if (temp > state.th.temp) setStatus('stTemp', 'Terlalu Panas', 'bad');
    else if (temp < 20) setStatus('stTemp', 'Dingin', 'warn');
    else setStatus('stTemp', 'Normal');

    if (hum < 40) setStatus('stHum', 'Terlalu Kering', 'warn');
    else if (hum > 90) setStatus('stHum', 'Terlalu Lembap', 'warn');
    else setStatus('stHum', 'Normal');

    if (soil < state.th.soil) setStatus('stSoil', 'Tanah Kering', 'bad');
    else if (soil > 85) setStatus('stSoil', 'Terlalu Basah', 'warn');
    else setStatus('stSoil', 'Lembap Cukup');

    if (light < state.th.light) setStatus('stLight', 'Kurang Cahaya', 'warn');
    else setStatus('stLight', 'Cukup');

    if (gas > state.th.gas) setStatus('stGas', 'BAHAYA', 'bad');
    else if (gas > state.th.gas * 0.6) setStatus('stGas', 'Waspada', 'warn');
    else setStatus('stGas', 'Aman');
    $('gasAlert').hidden = !(gas > state.th.gas);

    renderLcd();
    $('lastUpdate').textContent = nowStr();
  }

  /* ---------- LCD I2C 16x4 ---------- */
  function gasLabel() {
    const g = state.data.gas;
    if (g > state.th.gas) return 'BAHAYA';
    if (g > state.th.gas * 0.6) return 'WASPADA';
    return 'AMAN';
  }

  function renderLcd() {
    const { temp, hum, soil, light, gas } = state.data;
    const f = (b) => (b ? '1' : '0');
    const L = (t) => t.slice(0, 16).padEnd(16, ' ');
    $('lcd1').textContent = L(`T:${temp.toFixed(1)}C H:${pad(Math.round(hum))}%`);
    $('lcd2').textContent = L(`Soil:${pad(Math.round(soil))}% L:${pad(Math.round(light))}%`);
    $('lcd3').textContent = L(`Gas:${pad(Math.round(gas))}% ${gasLabel()}`);
    $('lcd4').textContent = L(`P:${f(state.dev.pump)} F:${f(state.dev.fan)} G:${f(state.dev.grow)} ${state.mode === 'auto' ? 'AUTO' : 'MAN'}`);
  }

  /* ---------- Device UI ---------- */
  const devMap = {
    pump: { sw: 'swPump', card: 'devPump', st: 'stPump', name: 'Pompa air' },
    fan:  { sw: 'swFan',  card: 'devFan',  st: 'stFan',  name: 'Kipas' },
    grow: { sw: 'swGrow', card: 'devGrow', st: 'stGrow', name: 'LED grow light' }
  };

  function renderDevices() {
    for (const k in devMap) {
      const m = devMap[k];
      const on = state.dev[k];
      $(m.sw).checked = on;
      $(m.sw).disabled = state.mode === 'auto';
      $(m.card).classList.toggle('on', on);
      $(m.st).textContent = on ? 'MENYALA' : 'MATI';
    }
    renderLcd();
  }

  function setDevice(k, on, reason) {
    if (state.dev[k] === on) return;
    state.dev[k] = on;
    log(`${devMap[k].name} ${on ? 'dinyalakan' : 'dimatikan'}${reason ? ' (' + reason + ')' : ''}`);
    renderDevices();
  }

  function autoLogic() {
    if (state.mode !== 'auto') return;
    const { temp, soil, light, gas } = state.data;
    setDevice('pump', soil < state.th.soil, soil < state.th.soil ? 'tanah kering' : 'tanah cukup lembap');
    const hot = temp > state.th.temp;
    const gasHigh = gas > state.th.gas;
    setDevice('fan', hot || gasHigh, gasHigh ? 'gas terdeteksi' : hot ? 'suhu tinggi' : 'kondisi normal');
    setDevice('grow', light < state.th.light, light < state.th.light ? 'cahaya kurang' : 'cahaya cukup');
  }

  /* ---------- Network (live mode) ---------- */
  async function sendControl(payload) {
    if (state.source !== 'live' || !state.url) return;
    try {
      await fetch(state.url.replace(/\/$/, '') + '/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      toast('Gagal mengirim perintah ke ESP32');
    }
  }

  async function fetchLive() {
    const res = await fetch(state.url.replace(/\/$/, '') + '/api/data', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  /* ---------- Demo data ---------- */
  function demoStep() {
    state.tick++;
    const t = state.tick;
    const d = state.data;
    // siklus siang-malam untuk cahaya dan suhu
    const day = (Math.sin(t / 18) + 1) / 2;
    d.light = clamp(8 + day * 85 + rand(-3, 3), 0, 100);
    d.temp = clamp(24 + day * 12 + rand(-0.4, 0.4), 18, 42);
    d.hum = clamp(82 - day * 28 + rand(-1.5, 1.5), 30, 98);
    // tanah mengering perlahan, naik saat pompa menyala
    d.soil = clamp(d.soil - 0.9 + (state.dev.pump ? 4.2 : 0) + rand(-0.2, 0.2), 8, 95);
    // gas MQ-2: nilai dasar rendah, sesekali muncul lonjakan; kipas mempercepat penurunan
    if (Math.random() < 0.015) state.gasSpike = rand(45, 85);
    state.gasSpike *= state.dev.fan ? 0.7 : 0.93;
    d.gas = clamp(10 + Math.sin(t / 9) * 2 + rand(-1, 1) + state.gasSpike, 0, 100);
    // efek kipas menurunkan suhu
    if (state.dev.fan) d.temp = clamp(d.temp - 1.5, 18, 42);
    if (state.dev.grow) d.light = clamp(d.light + 20, 0, 100);
  }

  /* ---------- Charts (canvas) ---------- */
  const colors = { temp: '#fb923c', hum: '#38bdf8', soil: '#a78bfa', light: '#facc15', gas: '#f472b6' };

  function drawChart(canvasId, series) {
    const cv = $(canvasId);
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = 260;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 36, padR = 10, padT = 10, padB = 24;
    const iw = w - padL - padR, ih = h - padT - padB;

    ctx.font = '11px Poppins, sans-serif';
    ctx.fillStyle = '#93b3a3';
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (ih / 4) * i;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(String(100 - i * 25), padL - 6, y + 4);
    }

    series.forEach(({ key, color }) => {
      const arr = state.hist[key];
      if (arr.length < 2) return;
      // skala suhu 0-50 dipetakan ke 0-100 agar satu sumbu
      const scale = key === 'temp' ? 2 : 1;
      ctx.beginPath();
      arr.forEach((v, i) => {
        const x = padL + (i / (MAX_POINTS - 1)) * iw;
        const y = padT + ih - (clamp(v * scale, 0, 100) / 100) * ih;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.4;
      ctx.lineJoin = 'round';
      ctx.stroke();

      const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
      grad.addColorStop(0, color + '33');
      grad.addColorStop(1, color + '00');
      const lastX = padL + ((arr.length - 1) / (MAX_POINTS - 1)) * iw;
      ctx.lineTo(lastX, padT + ih);
      ctx.lineTo(padL, padT + ih);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    });

    ctx.fillStyle = '#93b3a3';
    ctx.textAlign = 'left';
    ctx.fillText('lama', padL, h - 6);
    ctx.textAlign = 'right';
    ctx.fillText('sekarang', w - padR, h - 6);
  }

  function renderCharts() {
    drawChart('chartAir', [{ key: 'hum', color: colors.hum }, { key: 'temp', color: colors.temp }]);
    drawChart('chartSoil', [{ key: 'light', color: colors.light }, { key: 'soil', color: colors.soil }]);
    drawChart('chartGas', [{ key: 'gas', color: colors.gas }]);
  }

  function pushHistory() {
    for (const k of ['temp', 'hum', 'soil', 'light', 'gas']) {
      state.hist[k].push(state.data[k]);
      if (state.hist[k].length > MAX_POINTS) state.hist[k].shift();
    }
  }

  /* ---------- Main loop ---------- */
  function setBadge(kind, text) {
    const b = $('connBadge');
    b.className = 'conn-badge' + (kind ? ' ' + kind : '');
    $('connText').textContent = text;
  }

  async function update() {
    if (state.source === 'live' && state.url) {
      try {
        const j = await fetchLive();
        state.data.temp = Number(j.temp);
        state.data.hum = Number(j.hum);
        state.data.soil = Number(j.soil);
        state.data.light = Number(j.light);
        if (j.gas !== undefined) state.data.gas = Number(j.gas);
        // di mode live, status perangkat dibaca dari ESP32
        for (const k of ['pump', 'fan', 'grow']) {
          if (typeof j[k] === 'boolean') state.dev[k] = j[k];
        }
        setBadge('live', 'Terhubung ke ESP32');
        renderDevices();
      } catch (e) {
        setBadge('error', 'ESP32 tidak terjangkau');
        return;
      }
    } else {
      demoStep();
      autoLogic();
      setBadge('', 'Mode Demo');
    }
    pushHistory();
    renderSensors();
    renderCharts();
  }

  function startLoop() {
    clearInterval(state.timer);
    update();
    state.timer = setInterval(update, 2000);
  }

  /* ---------- Controls ---------- */
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderDevices();
      log(`Mode ${state.mode === 'auto' ? 'otomatis' : 'manual'} diaktifkan`);
      sendControl({ mode: state.mode });
    });
  });

  for (const k in devMap) {
    $(devMap[k].sw).addEventListener('change', (e) => {
      if (state.mode !== 'manual') return;
      setDevice(k, e.target.checked, 'manual');
      sendControl({ device: k, state: e.target.checked });
    });
  }

  function bindRange(id, lbId, key, apiKey) {
    let t;
    $(id).addEventListener('input', (e) => {
      state.th[key] = Number(e.target.value);
      $(lbId).textContent = e.target.value;
      renderSensors();
      autoLogic();
      // kirim ke ESP32 setelah slider berhenti digeser
      clearTimeout(t);
      t = setTimeout(() => sendControl({ [apiKey]: state.th[key] }), 400);
    });
  }
  bindRange('rgSoil', 'lbSoil', 'soil', 'soil_th');
  bindRange('rgTemp', 'lbTemp', 'temp', 'temp_th');
  bindRange('rgLight', 'lbLight', 'light', 'light_th');
  bindRange('rgGas', 'lbGas', 'gas', 'gas_th');

  /* ---------- Connection form ---------- */
  $('srcSelect').value = state.source;
  $('deviceUrl').value = state.url;

  $('saveConn').addEventListener('click', () => {
    const src = $('srcSelect').value;
    const url = $('deviceUrl').value.trim();
    if (src === 'live' && !/^https?:\/\//i.test(url)) {
      toast('Isi alamat ESP32, contoh: http://192.168.1.50');
      return;
    }
    state.source = src;
    state.url = url;
    try { localStorage.setItem('greensync-conn', JSON.stringify({ source: src, url })); } catch (_) {}
    toast(src === 'live' ? 'Menghubungkan ke ESP32…' : 'Beralih ke mode demo');
    log(src === 'live' ? `Mode live: ${url}` : 'Mode demo aktif');
    startLoop();
  });

  window.addEventListener('resize', renderCharts);

  /* ---------- Init ---------- */
  // isi riwayat awal agar grafik langsung terlihat
  for (let i = 0; i < 25; i++) { demoStep(); pushHistory(); }
  renderDevices();
  log('Sistem GREENSYNC dimulai');
  startLoop();
})();