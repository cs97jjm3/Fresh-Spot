(() => {
  const CFG = window.CONFIG || {};
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ----- Map -----
  const map = L.map('map', { zoomControl: true }).setView([51.5074, -0.1278], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  // Icons
  const busIcon = L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;background:#0ea5e9;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.25)"></div>`,
    iconSize: [18,18],
    iconAnchor: [9,9]
  });
  const bestIcon = L.divIcon({
    className: 'pulse-pin',
    html: `<div class="pulse-pin"></div>`,
    iconSize: [18,18],
    iconAnchor: [9,9]
  });
  const destIcon = L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;background:#ef4444;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.25)"></div>`,
    iconSize: [18,18],
    iconAnchor: [9,9]
  });

  // State
  let home = null; // {lat, lon, display:"Town, Postcode"}
  let origin = null; // current route origin (myloc or selected map tap)
  let selectedMarker = null;
  let stopMarkers = [];
  let bestStopMarker = null;
  let routeLayer = null;

  // UI els
  const elSearch = $('#search');
  const elResults = $('#results');
  const elHomeInput = $('#home-input');
  const elHomeResults = $('#home-results');
  const elHomePill = $('#home-pill');
  const elHomeEdit = $('#home-edit');
  const elStops = $('#stops');
  const elStopsList = $('#stops-list');
  const elSelection = $('#selection');
  const elErrors = $('#errors');
  const elBestLabel = $('#best-label');

  function showError(msg) {
    elErrors.style.display = 'block';
    elErrors.textContent = msg;
    setTimeout(() => { elErrors.style.display = 'none'; }, 5000);
  }

  function clearStops() {
    stopMarkers.forEach(m => map.removeLayer(m));
    stopMarkers = [];
    if (bestStopMarker) { map.removeLayer(bestStopMarker); bestStopMarker = null; }
    elStops.style.display = 'none';
    elStopsList.innerHTML = '';
    elBestLabel.style.display = 'none';
  }

  function clearRoute() {
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    $('#directions').style.display = 'none';
    $('#directions-steps').innerHTML = '';
  }

  // ----- Geocoding & reverse geocoding with Nominatim -----
  async function geocode(q) {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'Accept-Language': 'en' }});
    if (!r.ok) throw new Error('Search failed');
    return await r.json();
  }
  async function reverseGeocode(lat, lon) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
    const r = await fetch(url, { headers: { 'Accept-Language': 'en' }});
    if (!r.ok) return null;
    return await r.json();
  }
  function formatTownPostcode(nominatimAddress) {
    if (!nominatimAddress) return '';
    const a = nominatimAddress.address || {};
    const town = a.town || a.city || a.village || a.hamlet || a.suburb || a.county || '';
    const pc = a.postcode || '';
    return [town, pc].filter(Boolean).join(', ');
  }

  // ----- Search UI -----
  function attachDropdown(inputEl, resultsEl, onPick) {
    let lastController = null;
    inputEl.addEventListener('input', async () => {
      const q = inputEl.value.trim();
      if (!q) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; return; }
      try {
        if (lastController) lastController.abort();
        lastController = new AbortController();
        const items = await geocode(q);
        resultsEl.innerHTML = items.map(it => {
          const name = it.display_name.replace(/,? United Kingdom$/, '');
          return `<button data-lat="${it.lat}" data-lon="${it.lon}" title="${name}">${name}</button>`;
        }).join('');
        resultsEl.style.display = 'block';
      } catch (e) {
        // ignore typing aborts
      }
    });
    resultsEl.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') return;
      const lat = parseFloat(e.target.getAttribute('data-lat'));
      const lon = parseFloat(e.target.getAttribute('data-lon'));
      const title = e.target.getAttribute('title');
      resultsEl.style.display = 'none';
      resultsEl.innerHTML = '';
      inputEl.value = title;
      onPick({ lat, lon, title });
    });
  }

  // Place search controls selected origin
  attachDropdown(elSearch, elResults, ({ lat, lon, title }) => {
    setOrigin({ lat, lon, label: title });
  });

  // Home search – store + show as Town, Postcode
  attachDropdown(elHomeInput, elHomeResults, async ({ lat, lon, title }) => {
    const rev = await reverseGeocode(lat, lon);
    const label = formatTownPostcode(rev) || title;
    home = { lat, lon, display: label, raw: rev };
    elHomeInput.style.display = 'none';
    elHomeResults.style.display = 'none';
    elHomePill.textContent = `Home: ${label}`;
    elHomePill.style.display = 'inline-block';
    elHomeEdit.style.display = 'inline-block';
    // Drop a pin
    L.marker([lat, lon], { icon: destIcon }).addTo(map).bindPopup(`<b>Home</b><br>${label}`);
  });
  elHomeEdit.addEventListener('click', () => {
    elHomeInput.style.display = 'block';
    elHomeInput.focus();
  });

  // Use my location
  $('#btn-my-location').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showError('Geolocation not supported by your browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude;
      const rev = await reverseGeocode(lat, lon);
      setOrigin({ lat, lon, label: 'My location', rev });
    }, () => showError('Could not get your location.'));
  });

  // Tap map to set origin
  map.on('click', async (e) => {
    const { lat, lng } = e.latlng;
    const rev = await reverseGeocode(lat, lng);
    const label = rev?.display_name?.split(', United Kingdom')[0] || 'Selected point';
    setOrigin({ lat, lon: lng, label, rev });
  });

  function setOrigin(o) {
    origin = o;
    if (selectedMarker) map.removeLayer(selectedMarker);
    selectedMarker = L.marker([origin.lat, origin.lon], { draggable: false }).addTo(map)
      .bindPopup(`<b>Origin</b><br>${origin.label}`).openPopup();
    map.setView([origin.lat, origin.lon], 15);
    // Show selection card
    elSelection.style.display = 'block';
    elSelection.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div style="font-weight:700;">Selected origin</div>
          <div class="muted">${origin.label}</div>
        </div>
        <div>
          <span id="aq-chip" class="aqi-badge" style="display:none;"></span>
        </div>
      </div>
    `;
    // Fetch AQ inline for origin (optional visual)
    if (CFG.OPEN_METEO_AQ?.ENABLED) { loadAQBadge(origin.lat, origin.lon, '#aq-chip'); }
  }

  // ----- Open-Meteo AQ (no key) -----
  async function loadAQBadge(lat, lon, selector) {
    try {
      const url = `${CFG.OPEN_METEO_AQ.BASE}?latitude=${lat}&longitude=${lon}&hourly=pm2_5,pm10,us_aqi&current=us_aqi`;
      const r = await fetch(url);
      if (!r.ok) return;
      const j = await r.json();
      const aqi = j?.current?.us_aqi ?? null;
      const el = $(selector);
      if (aqi != null && el) {
        const cls = aqi<=50?'aqi-good':aqi<=100?'aqi-fair':aqi<=150?'aqi-moderate':aqi<=200?'aqi-poor':'aqi-vpoor';
        el.textContent = `US AQI ${aqi}`;
        el.classList.add('aqi-badge', cls);
        el.style.display = 'inline-block';
      }
    } catch (e) { /* ignore */ }
  }

  // ----- Overpass: get nearby public transport stops -----
  async function fetchStops(lat, lon, radiusMeters) {
    const q = `
      [out:json][timeout:25];
      (
        node(around:${radiusMeters},${lat},${lon})["highway"="bus_stop"];
        node(around:${radiusMeters},${lat},${lon})["public_transport"="platform"]["bus"="yes"];
      );
      out tags center;
    `;
    const r = await fetch(CFG.OVERPASS_URL, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (!r.ok) throw new Error('Stop lookup failed');
    const j = await r.json();
    return (j.elements || []).map(n => ({
      id: n.id,
      lat: n.lat || n.center?.lat,
      lon: n.lon || n.center?.lon,
      name: n.tags?.name || 'Bus stop',
      naptan: n.tags?.['ref:GB:Naptan'] || null
    })).filter(s => s.lat && s.lon);
  }

  // ----- OSRM quick walking route -----
  async function routeDurationSec(a, b) {
    const url = `${CFG.OSRM_BASE}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false&alternatives=false&geometries=polyline&steps=false`;
    const r = await fetch(url);
    if (!r.ok) return Infinity;
    const j = await r.json();
    return j?.routes?.[0]?.duration ?? Infinity;
  }

  // ----- TfL helpers -----
  function isTfLStop(naptanId) {
    // TfL NaPTAN IDs typically start with 4900...
    return !!naptanId && /^4900/i.test(naptanId);
  }
  function tflAuthParams() {
    const id = CFG.TFL.APP_ID, key = CFG.TFL.APP_KEY;
    if (id && key) return `?app_id=${encodeURIComponent(id)}&app_key=${encodeURIComponent(key)}`;
    return '';
  }
  async function tflArrivals(naptanId) {
    const base = 'https://api.tfl.gov.uk';
    const url = `${base}/StopPoint/${encodeURIComponent(naptanId)}/arrivals${tflAuthParams()}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('TfL arrivals failed');
    const j = await r.json();
    // sort by timeToStation ascending
    j.sort((a,b)=>a.timeToStation-b.timeToStation);
    return j.slice(0, 6).map(a => ({
      line: a.lineName || a.lineId,
      dest: a.destinationName,
      etaMin: Math.max(0, Math.round(a.timeToStation/60)),
      towards: a.towards
    }));
  }

  // ----- Met Office (inline tiny summary, optional) -----
  async function metOfficeSpot(lat, lon) {
    if (!CFG.METOFFICE?.ENABLED || !CFG.METOFFICE.API_KEY) return null;
    const headers = { 'accept': 'application/json', 'apikey': CFG.METOFFICE.API_KEY };
    // Hourly endpoint (Global Spot)
    const url = `${CFG.METOFFICE.BASE}/point/hourly?excludeParameterMetadata=true&latitude=${lat}&longitude=${lon}`;
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const j = await r.json();
    // The schema is GeoJSON FeatureCollection; properties contains arrays of hourly values.
    const feat = j?.features?.[0];
    const props = feat?.properties || {};
    const first = (arr) => Array.isArray(arr)&&arr.length?arr[0]:null;
    return {
      tempC: first(props?.temperature) ?? null,
      weatherCode: first(props?.significantWeatherCode) ?? null
    };
  }

  // ----- Best stop logic -----
  async function findBestStop() {
    clearStops();
    clearRoute();
    if (!origin) { showError('Pick an origin first.'); return; }
    if (!home) { showError('Set your Home first.'); return; }

    // 1) fetch nearby stops around origin
    const radius = CFG.SEARCH_RADIUS_METERS || 800;
    $('#stops-radius').textContent = radius;
    let stops = [];
    try {
      stops = await fetchStops(origin.lat, origin.lon, radius);
    } catch (e) {
      showError('Could not load nearby stops.');
      return;
    }
    if (!stops.length) { showError('No stops found nearby.'); return; }

    // 2) score each stop by (origin->stop walk) + (stop->home walk)
    // To limit API calls, pre-select closest N by beeline to origin
    const N = Math.min(8, stops.length);
    const byDist = stops.slice().sort((a,b)=>{
      const da = (a.lat-origin.lat)**2 + (a.lon-origin.lon)**2;
      const db = (b.lat-origin.lat)**2 + (b.lon-origin.lon)**2;
      return da-db;
    }).slice(0, N);

    const originPt = { lat: origin.lat, lon: origin.lon };
    const homePt = { lat: home.lat, lon: home.lon };

    let best = null;
    for (const s of byDist) {
      const stopPt = { lat: s.lat, lon: s.lon };
      const d1 = await routeDurationSec(originPt, stopPt);
      const d2 = await routeDurationSec(stopPt, homePt);
      const total = d1 + d2;
      s.walkToStopSec = d1;
      s.walkToHomeSec = d2;
      s.totalSec = total;
      if (!best || total < best.totalSec) best = s;
    }

    // 3) plot all stops; pulse the best
    stops.forEach(s => {
      const m = L.marker([s.lat, s.lon], { icon: busIcon }).addTo(map);
      m.bindPopup(`<b>${s.name}</b>${s.naptan?`<div class="muted">NaPTAN ${s.naptan}</div>`:''}`);
      stopMarkers.push(m);
    });
    if (best) {
      bestStopMarker = L.marker([best.lat, best.lon], { icon: bestIcon, zIndexOffset: 500 })
        .addTo(map)
        .bindPopup(renderStopPopup(best, /*isBest*/true));
      bestStopMarker.openPopup();
      elBestLabel.style.display = 'inline-block';
      map.panTo([best.lat, best.lon], { animate: true });
    }

    // 4) list in sidebar
    elStops.style.display = 'block';
    const fmt = (s)=> Math.round(s/60) + ' min';
    elStopsList.innerHTML = byDist.sort((a,b)=>a.totalSec-b.totalSec).map(s => `
      <div class="stop-item">
        <div class="stop-left">
          <div class="stop-name">${s.name}</div>
          ${s.naptan?`<span class="pill">NaPTAN ${s.naptan}</span>`:''}
        </div>
        <div class="muted">Walk: ${fmt(s.walkToStopSec)} + ${fmt(s.walkToHomeSec)} = <b>${fmt(s.totalSec)}</b></div>
      </div>
    `).join('');

    // 5) draw walking route origin → best stop → home
    if (best) { drawRouteVia(best); }
  }

  function renderStopPopup(stop, isBest=false) {
    const hdr = isBest ? `<div class="pill" style="background:#0ea5e9;color:#fff;">Best stop</div>` : '';
    const naptanLine = stop.naptan ? `<div class="muted">NaPTAN ${stop.naptan}</div>` : '';
    return `${hdr}<div style="font-weight:700;margin-top:4px;">${stop.name}</div>${naptanLine}
      <div id="arrivals" class="muted" style="margin-top:6px;">Loading arrivals…</div>
      ${CFG.METOFFICE.SHOW_INLINE ? `<div id="wxline" class="muted">Loading weather…</div>` : ''}`;
  }

  async function enhanceStopPopup(stop) {
    // TfL arrivals if London stop
    const isLondon = CFG.TFL.ENABLED && isTfLStop(stop.naptan);
    if (isLondon) {
      try {
        const arrivals = await tflArrivals(stop.naptan);
        const html = arrivals.length ? (`<ul style="padding-left:16px;margin:4px 0 0 0;">
          ${arrivals.map(a=>`<li>${a.line} → ${a.dest} · ${a.etaMin} min</li>`).join('')}
        </ul>`) : 'No live arrivals';
        const el = document.querySelector('#arrivals');
        if (el) el.innerHTML = html;
      } catch (e) {
        const el = document.querySelector('#arrivals');
        if (el) el.textContent = 'Arrivals unavailable';
      }
    } else {
      const el = document.querySelector('#arrivals');
      if (el) el.textContent = 'Live arrivals not available here';
    }

    // Optional tiny Met Office summary
    if (CFG.METOFFICE.SHOW_INLINE && CFG.METOFFICE.ENABLED && CFG.METOFFICE.API_KEY) {
      try {
        const mo = await metOfficeSpot(stop.lat, stop.lon);
        const el = document.querySelector('#wxline');
        if (el && mo) {
          const w = mo.weatherCode ?? '';
          const t = mo.tempC != null ? `${Math.round(mo.tempC)}°C` : '';
          el.textContent = [t, w ? `code ${w}` : ''].filter(Boolean).join(' · ');
        } else if (el) {
          el.textContent = '—';
        }
      } catch {
        const el = document.querySelector('#wxline');
        if (el) el.textContent = 'Weather unavailable';
      }
    }
  }

  async function drawRouteVia(stop) {
    try {
      const a = `${origin.lon},${origin.lat}`;
      const b = `${stop.lon},${stop.lat}`;
      const c = `${home.lon},${home.lat}`;
      const url1 = `${CFG.OSRM_BASE}/${a};${b}?overview=full&geometries=geojson`;
      const url2 = `${CFG.OSRM_BASE}/${b};${c}?overview=full&geometries=geojson`;
      const [r1, r2] = await Promise.all([fetch(url1), fetch(url2)]);
      if (!r1.ok || !r2.ok) return;
      const j1 = await r1.json(); const j2 = await r2.json();
      const coords = [
        ...(j1.routes?.[0]?.geometry?.coordinates || []),
        ...(j2.routes?.[0]?.geometry?.coordinates || [])
      ].map(([x,y])=>[y,x]);
      if (coords.length) {
        if (routeLayer) { map.removeLayer(routeLayer); }
        routeLayer = L.polyline(coords, { color:'#0ea5e9', weight:5, opacity:0.85 }).addTo(map);
        $('#directions').style.display = 'block';
        $('#directions-steps').innerHTML = `
          <div class="dir-step">Walk to <b>${stop.name}</b></div>
          <div class="dir-step">Then continue on to <b>Home</b></div>
        `;
      }
      // Enhance popup (arrivals, inline weather if enabled)
      await enhanceStopPopup(stop);
    } catch (e) {
      // ignore
    }
  }

  // Button: find best stop
  $('#btn-best-stop').addEventListener('click', findBestStop);
  // Clear route
  $('#btn-clear-route').addEventListener('click', () => { clearRoute(); });

  // If popup opens (best marker), enhance it
  map.on('popupopen', (e) => {
    // When we open the best stop popup, fill arrivals if needed
    // The best marker binds a popup with #arrivals/#wxline IDs
    // We'll try to detect corresponding stop by position match against stopMarkers/bestStopMarker
    // (already handled in drawRouteVia -> enhanceStopPopup)
  });
})();
