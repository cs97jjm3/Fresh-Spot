/* global L */

(() => {
  // ---------------- Config ----------------
  const CFG = window.CONFIG || {};
  const OSRM_BASE = CFG.OSRM_BASE || "https://router.project-osrm.org/route/v1/walking";
  const OVERPASS_URL = CFG.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
  const SEARCH_RADIUS_METERS = CFG.SEARCH_RADIUS_METERS || 800;

  // -------------- DOM helpers --------------
  const $ = (s) => document.querySelector(s);

  // -------------- Map ----------------------
  const map = L.map("map", { zoomControl: true }).setView([51.5074, -0.1278], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap",
  }).addTo(map);

  // -------------- Icons & styles -----------
  const REGULAR_STOP_ICON = L.divIcon({
    className: "",
    html: `<div style="width:18px;height:18px;background:#0ea5e9;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.25)"></div>`,
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
  const DEST_ICON = L.divIcon({
    className: "",
    html: `<div style="width:18px;height:18px;background:#ef4444;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.25)"></div>`,
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
  const BEST_PULSE_ICON = L.divIcon({
    className: "",
    html: `<div style="position:relative;width:18px;height:18px;border-radius:50%;background:#3b82f6;border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.35)">
      <div style="position:absolute;left:50%;top:50%;width:18px;height:18px;transform:translate(-50%,-50%);border-radius:50%;border:2px solid rgba(59,130,246,.65);animation:pulse 1.6s ease-out infinite"></div>
    </div>`,
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
  const BEST_SELECTED_ICON = L.divIcon({
    className: "",
    html: `<div style="width:22px;height:22px;background:#f59e0b;border:3px solid #fff;border-radius:50%;box-shadow:0 3px 12px rgba(0,0,0,.35)"></div>`,
    iconSize: [22, 22], iconAnchor: [11, 11],
  });

  // Pulse + Spinner CSS
  (function injectCSS() {
    const style = document.createElement("style");
    style.textContent = `
      @keyframes pulse { 0%{transform:translate(-50%,-50%) scale(1);opacity:.85}
        70%{transform:translate(-50%,-50%) scale(2.3);opacity:0}
        100%{transform:translate(-50%,-50%) scale(2.3);opacity:0} }
      @keyframes spin { to { transform: rotate(360deg); } }
      #loading-overlay {
        position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
        background: rgba(255,255,255,0.6); backdrop-filter: blur(2px); z-index: 9999;
      }
      #loading-overlay .box {
        display:flex; flex-direction:column; align-items:center; gap:10px;
        padding: 14px 18px; border-radius: 12px; background:#fff; border:1px solid #e5e7eb;
        box-shadow: 0 6px 24px rgba(0,0,0,.12);
      }
      #loading-overlay .spinner {
        width: 42px; height: 42px; border: 4px solid rgba(14,165,233,.25);
        border-top-color: #0ea5e9; border-radius: 50%; animation: spin .9s linear infinite;
      }`;
    document.head.appendChild(style);
  })();

  // -------------- Loading overlay --------------
  function ensureOverlay() {
    let el = document.getElementById("loading-overlay");
    if (el) return el;
    el = document.createElement("div");
    el.id = "loading-overlay";
    el.innerHTML = `<div class="box"><div class="spinner"></div><div class="muted">Finding best stop…</div></div>`;
    document.body.appendChild(el);
    return el;
  }
  function showLoading(msg = "Finding best stop…") {
    const el = ensureOverlay();
    const text = el.querySelector(".muted");
    if (text) text.textContent = msg;
    el.style.display = "flex";
    const btn = $("#btn-best-stop");
    if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
  }
  function hideLoading() {
    const el = document.getElementById("loading-overlay");
    if (el) el.style.display = "none";
    const btn = $("#btn-best-stop");
    if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); }
  }

  // -------------- State --------------------
  let home = null;            // { lat, lon, display }
  let origin = null;          // { lat, lon, label }
  let originMarker = null;
  let homeMarker = null;

  const stopMarkers = new Map(); // id -> marker
  let bestStopId = null;
  let bestStopMarker = null;
  let selectedStopMarker = null;

  let routeLayer = null;
  const routeColor = "#0ea5e9";

  // -------------- UI elements --------------
  const elSearch = $("#search");
  const elResults = $("#results");
  const elHomeInput = $("#home-input");
  const elHomeResults = $("#home-results");
  const elHomePill = $("#home-pill");
  const elSelection = $("#selection");
  const elStops = $("#stops");
  const elStopsList = $("#stops-list");
  const elErrors = $("#errors");

  // -------------- Helpers ------------------
  function showError(msg) { if (elErrors) { elErrors.textContent = msg || ""; elErrors.style.display = msg ? "block" : "none"; } }
  function fmtMin(sec) { return `${Math.max(0, Math.round(sec/60))} min`; }
  const toFixed = (n, d=4) => Number.parseFloat(n).toFixed(d);

  async function reverseGeocode(lat, lon) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`, {
        headers: { "Accept-Language": "en-GB" },
      });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }
  function formatTownPostcode(rev) {
    if (!rev) return "";
    const a = rev.address || {};
    const town = a.town || a.city || a.village || a.hamlet || a.suburb || a.county || "";
    const pc = a.postcode || "";
    return [town, pc].filter(Boolean).join(", ");
  }
  async function geocode(q) {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`, {
      headers: { "Accept-Language": "en-GB" },
    });
    if (!r.ok) throw new Error("Search failed");
    return await r.json();
  }
  function attachDropdown(inputEl, resultsEl, onPick) {
    let aborter = null;
    inputEl?.addEventListener("input", async () => {
      const q = inputEl.value.trim();
      if (!q) { if(resultsEl){resultsEl.style.display="none"; resultsEl.innerHTML="";} return; }
      try {
        if (aborter) aborter.abort();
        aborter = new AbortController();
        const items = await geocode(q);
        if (!resultsEl) return;
        resultsEl.innerHTML = items.map(it => {
          const name = it.display_name.replace(/,? United Kingdom$/, "");
          return `<button data-lat="${it.lat}" data-lon="${it.lon}" title="${name}">${name}</button>`;
        }).join("");
        resultsEl.style.display = "block";
      } catch { /* ignore */ }
    });
    resultsEl?.addEventListener("click", (e) => {
      if (e.target.tagName !== "BUTTON") return;
      const lat = parseFloat(e.target.getAttribute("data-lat"));
      const lon = parseFloat(e.target.getAttribute("data-lon"));
      const title = e.target.getAttribute("title");
      resultsEl.style.display = "none";
      resultsEl.innerHTML = "";
      inputEl.value = title;
      onPick({ lat, lon, title });
    });
  }

  // ---------------- Home persistence ----------------
  const HOME_KEY = "freshstop.home.v1";
  function saveHome() { try { localStorage.setItem(HOME_KEY, JSON.stringify(home)); } catch {} }
  function loadHome() {
    try {
      const raw = localStorage.getItem(HOME_KEY);
      if (!raw) return null;
      const h = JSON.parse(raw);
      if (h && Number.isFinite(h.lat) && Number.isFinite(h.lon) && typeof h.display === "string") return h;
    } catch {}
    return null;
  }
  function applyHome(h) {
    home = { lat: h.lat, lon: h.lon, display: h.display };
    if (homeMarker) map.removeLayer(homeMarker);
    homeMarker = L.marker([home.lat, home.lon], { icon: DEST_ICON }).addTo(map)
      .bindPopup(`<b>Home</b><br>${home.display}`);
    if (elHomePill) { elHomePill.textContent = `Home: ${home.display}`; elHomePill.style.display = "inline-block"; }
    if (elHomeInput) elHomeInput.style.display = "none";
  }
  function clearHome() {
    home = null;
    try { localStorage.removeItem(HOME_KEY); } catch {}
    if (homeMarker) { map.removeLayer(homeMarker); homeMarker = null; }
    if (elHomePill) { elHomePill.textContent = ""; elHomePill.style.display = "none"; }
    if (elHomeInput) { elHomeInput.style.display = "block"; elHomeInput.value = ""; elHomeInput.focus(); }
  }

  // Origin handling
  function setOrigin(o) {
    origin = o;
    if (originMarker) map.removeLayer(originMarker);
    originMarker = L.marker([o.lat, o.lon]).addTo(map)
      .bindPopup(`<b>Origin</b><br>${o.label}`).openPopup();
    map.setView([o.lat, o.lon], 15);
    if (elSelection) {
      elSelection.style.display = "block";
      elSelection.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-weight:700;">Selected origin</div>
            <div class="muted">${o.label}</div>
          </div>
        </div>
      `;
    }
  }

  // Home handling
  async function setHome(lat, lon, title) {
    const rev = await reverseGeocode(lat, lon);
    const display = formatTownPostcode(rev) || title || "Home";
    home = { lat, lon, display };
    if (elHomePill) { elHomePill.textContent = `Home: ${display}`; elHomePill.style.display = "inline-block"; }
    if (elHomeInput) elHomeInput.style.display = "none";
    if (homeMarker) map.removeLayer(homeMarker);
    homeMarker = L.marker([lat, lon], { icon: DEST_ICON }).addTo(map)
      .bindPopup(`<b>Home</b><br>${display}`);
    saveHome(); // persist
  }
  elHomePill?.addEventListener("click", () => {
    if (!elHomeInput) return;
    elHomeInput.value = "";
    elHomeInput.style.display = "block";
    elHomeInput.focus();
  });
  elHomePill?.addEventListener("contextmenu", (e) => { e.preventDefault(); if (confirm("Clear Home?")) clearHome(); });

  // Attach search UIs
  attachDropdown(elSearch, elResults, ({ lat, lon, title }) => setOrigin({ lat, lon, label: title }));
  attachDropdown(elHomeInput, elHomeResults, async ({ lat, lon, title }) => {
    await setHome(lat, lon, title);
    if (elHomeResults) elHomeResults.style.display = "none";
  });

  // Auto-locate
  async function autoLocate() {
    if (!navigator.geolocation) return false;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => { const lat = pos.coords.latitude, lon = pos.coords.longitude; setOrigin({ lat, lon, label: "My location" }); resolve(true); },
        () => resolve(false),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
      );
    });
  }
  $("#btn-my-location")?.addEventListener("click", () => { autoLocate().then(ok => { if (!ok) showError("Could not get your location."); }); });
  map.on("click", async (e) => {
    const { lat, lng } = e.latlng;
    const rev = await reverseGeocode(lat, lng);
    const label = rev?.display_name?.replace(/,? United Kingdom$/, "") || "Selected point";
    setOrigin({ lat, lon: lng, label });
  });

  // ---------------- Stops + routing ----------------
  async function fetchStopsOverpass(lat, lon, radiusM) {
    const q = `
      [out:json][timeout:25];
      (
        node(around:${radiusM},${lat},${lon})["highway"="bus_stop"];
        node(around:${radiusM},${lat},${lon})["public_transport"="platform"]["bus"="yes"];
      );
      out tags center;`;
    try {
      const r = await fetch(OVERPASS_URL, {
        method: "POST",
        body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });
      if (!r.ok) return [];
      const j = await r.json();
      return (j.elements || [])
        .map(n => ({
          id: n.id,
          lat: n.lat || n.center?.lat,
          lon: n.lon || n.center?.lon,
          name: n.tags?.name || "Bus stop",
          // prefer official NaPTAN/ATCO where present
          naptan: n.tags?.["naptan:AtcoCode"] || n.tags?.["ref:GB:Naptan"] || null
        }))
        .filter(s => s.lat && s.lon);
    } catch { return []; }
  }
  function tflUnifiedParams() {
    const id = CFG?.TFL?.APP_ID, key = CFG?.TFL?.APP_KEY;
    if (key) { const idq = id ? `&app_id=${encodeURIComponent(id)}` : ""; return `&app_key=${encodeURIComponent(key)}${idq}`; }
    return "";
  }
  async function fetchStopsTfL(lat, lon, radiusM) {
    if (!CFG?.TFL?.ENABLED) return [];
    try {
      const url = `https://api.tfl.gov.uk/StopPoint?lat=${lat}&lon=${lon}&stopTypes=NaptanPublicBusCoachTram&radius=${radiusM}${tflUnifiedParams()}`;
      const r = await fetch(url);
      if (!r.ok) return [];
      const j = await r.json();
      const points = (j?.stopPoints || []).filter(sp => (sp.modes || []).includes("bus"));
      return points.map(sp => ({
        id: sp.id || sp.naptanId,
        lat: sp.lat, lon: sp.lon,
        name: sp.commonName || "Bus stop",
        naptan: sp.naptanId || null
      }));
    } catch { return []; }
  }
  async function fetchStops(lat, lon, radiusM) {
    let s = await fetchStopsOverpass(lat, lon, radiusM);
    if (!s.length) s = await fetchStopsTfL(lat, lon, radiusM);
    return s;
  }

  async function routeDurationSec(a, b) {
    try {
      const url = `${OSRM_BASE}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false&steps=false`;
      const r = await fetch(url);
      if (!r.ok) return Infinity;
      const j = await r.json();
      return j?.routes?.[0]?.duration ?? Infinity;
    } catch { return Infinity; }
  }

  function clearStopsUI() {
    stopMarkers.forEach((m) => map.removeLayer(m));
    stopMarkers.clear();
    if (bestStopMarker) { map.removeLayer(bestStopMarker); bestStopMarker = null; }
    if (selectedStopMarker) { map.removeLayer(selectedStopMarker); selectedStopMarker = null; }
    bestStopId = null;
    if (elStops) { elStops.style.display = "none"; elStopsList.innerHTML = ""; }
  }
  function clearRoute() {
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    $("#directions")?.style && ($("#directions").style.display = "none");
    const ds = $("#directions-steps"); if (ds) ds.innerHTML = "";
  }
  $("#btn-clear-route")?.addEventListener("click", clearRoute);

  // --------- TfL arrivals (London) ----------
  function isTfLStop(naptanId) { return !!naptanId && /^4900/i.test(naptanId); }
  function tflApimHeaders() { const k = CFG?.TFL?.SUBSCRIPTION_KEY; return k ? { "Ocp-Apim-Subscription-Key": k } : {}; }
  async function tflArrivals(naptanId) {
    try {
      const qp = tflUnifiedParams();
      const url = `https://api.tfl.gov.uk/StopPoint/${encodeURIComponent(naptanId)}/arrivals${qp ? '?' + qp.slice(1) : ''}`;
      const r = await fetch(url, { headers: tflApimHeaders() });
      if (!r.ok) return [];
      const j = await r.json();
      j.sort((a,b)=>a.timeToStation-b.timeToStation);
      return j.slice(0,6).map(a => ({
        line: a.lineName || a.lineId,
        dest: a.destinationName,
        etaMin: Math.max(0, Math.round((a.timeToStation || 0)/60)),
      }));
    } catch { return []; }
  }

  // --------- BODS (SIRI-VM) arrivals (outside London) ----------
  function bodsEnabled() { return !!(CFG?.BODS?.ENABLED && CFG?.BODS?.API_KEY); }

  async function bodsArrivalsNear(lat, lon) {
    if (!bodsEnabled()) return [];
    // ~1km bbox
    const d = 0.01;
    const minLat = (lat - d).toFixed(5);
    const maxLat = (lat + d).toFixed(5);
    const minLon = (lon - d).toFixed(5);
    const maxLon = (lon + d).toFixed(5);
    const url = `https://data.bus-data.dft.gov.uk/api/v1/datafeed?boundingBox=${minLat},${maxLat},${minLon},${maxLon}&api_key=${encodeURIComponent(CFG.BODS.API_KEY)}`;

    try {
      const r = await fetch(url, { headers: { "accept": "application/xml" } });
      if (!r.ok) throw new Error(`BODS ${r.status}`);
      const xml = await r.text();
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      return Array.from(doc.getElementsByTagName("VehicleActivity"));
    } catch (e) {
      console.warn("BODS fetch failed", e);
      return { error: (e?.message || "Fetch failed") };
    }
  }

  function extractArrivalsForStop(activities, stopRef) {
    if (!Array.isArray(activities)) return [];
    const now = Date.now();
    const norm = (s) => String(s || "").trim().toUpperCase();
    const want = norm(stopRef);

    const rows = [];
    for (const a of activities) {
      const mc = a.getElementsByTagName("MonitoredCall")[0];
      if (!mc) continue;

      const ref = mc.getElementsByTagName("StopPointRef")[0]?.textContent;
      if (!ref || norm(ref) !== want) continue;

      const line = a.getElementsByTagName("PublishedLineName")[0]?.textContent
                || a.getElementsByTagName("LineRef")[0]?.textContent
                || "Bus";
      const dest = mc.getElementsByTagName("DestinationDisplay")[0]?.textContent || "";
      const exp  = mc.getElementsByTagName("ExpectedArrivalTime")[0]?.textContent
                || mc.getElementsByTagName("ExpectedDepartureTime")[0]?.textContent
                || mc.getElementsByTagName("AimedArrivalTime")[0]?.textContent
                || mc.getElementsByTagName("AimedDepartureTime")[0]?.textContent
                || null;

      if (!exp) continue;
      const etaMin = Math.max(0, Math.round((new Date(exp).getTime() - now) / 60000));
      rows.push({ line, dest, etaMin });
    }
    return rows.sort((x,y)=>x.etaMin - y.etaMin).slice(0, 6);
  }

  // --- Weather (inline): Met Office → Open-Meteo fallback ---
  async function metOfficeSpot(lat, lon) {
    const MO = CFG.METOFFICE || {};
    if (!(MO.ENABLED && MO.API_KEY && MO.BASE)) return null;
    try {
      const headers = { 'accept': 'application/json', 'apikey': MO.API_KEY };
      const url = `${MO.BASE}/point/hourly?excludeParameterMetadata=true&latitude=${lat}&longitude=${lon}`;
      const r = await fetch(url, { headers });
      if (!r.ok) return null;
      const j = await r.json();
      const props = j?.features?.[0]?.properties || {};
      const t = Array.isArray(props.temperature) ? props.temperature[0] : null;
      const code = Array.isArray(props.significantWeatherCode) ? props.significantWeatherCode[0] : null;
      if (t == null && code == null) return null;
      return { tempC: t, code };
    } catch { return null; }
  }
  function wmCodeToText(code){
    const MAP = {
      0:"clear", 1:"mostly clear", 2:"partly cloudy", 3:"overcast",
      45:"fog",48:"rime fog",51:"drizzle",53:"drizzle",55:"drizzle",
      61:"rain",63:"rain",65:"rain",66:"freezing rain",67:"freezing rain",
      71:"snow",73:"snow",75:"snow",77:"snow grains",
      80:"showers",81:"showers",82:"heavy showers",
      95:"thunderstorm",96:"thunder w/ hail",99:"thunder w/ hail"
    };
    return MAP[code] || `code ${code}`;
  }
  async function openMeteoNow(lat, lon){
    try{
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`;
      const r = await fetch(u);
      if(!r.ok) return null;
      const j = await r.json();
      const t = j?.current?.temperature_2m;
      const code = j?.current?.weather_code;
      if (t==null && code==null) return null;
      return { tempC: t, codeText: wmCodeToText(code) };
    }catch{ return null; }
  }
  async function weatherLine(lat, lon){
    const mo = await metOfficeSpot(lat, lon);
    if (mo) return `${Math.round(mo.tempC)}°C · code ${mo.code}`;
    const om = await openMeteoNow(lat, lon);
    if (om) return `${Math.round(om.tempC)}°C · ${om.codeText}`;
    return "—";
  }

  // --- Popups with unique ids & reliable load ---
  function renderStopPopup(stop, isBest=false) {
    const sid = `s${String(stop.id).replace(/[^a-zA-Z0-9_-]/g, "")}`;

    // Weather: always for best stop; else respect SHOW_INLINE
    const wantWx = isBest || (CFG.METOFFICE?.SHOW_INLINE !== false);
    const wxRow = wantWx ? `<div id="wxline-${sid}" class="muted" style="margin-top:6px;">Loading weather…</div>` : "";

    // Live arrivals: TfL in London; BODS elsewhere (if enabled)
    let live = `<div class="muted" style="margin-top:6px;">Live arrivals not available here</div>`;
    if (isTfLStop(stop.naptan)) {
      live = `<div id="arrivals-${sid}" class="muted" style="margin-top:6px;">Loading arrivals…</div>`;
    } else if (bodsEnabled() && stop.naptan) {
      live = `<div id="arrivals-${sid}" class="muted" style="margin-top:6px;">Loading arrivals…</div>`;
    }

    const nap = stop.naptan ? `<div class="muted">NaPTAN ${stop.naptan}</div>` : "";
    const hdr = isBest ? `<div class="pill" style="background:#f59e0b;color:#fff;margin-bottom:6px;">Best stop</div>` : "";

    return `${hdr}<div style="font-weight:700">${stop.name}</div>${nap}${wxRow}${live}`;
  }

  async function enhanceStopPopup(stop) {
    const sid = `s${String(stop.id).replace(/[^a-zA-Z0-9_-]/g, "")}`;

    // Weather (best stop forced on)
    if (stop.id === bestStopId || CFG.METOFFICE?.SHOW_INLINE !== false) {
      try {
        const line = await weatherLine(stop.lat, stop.lon);
        const el = document.getElementById(`wxline-${sid}`);
        if (el) el.textContent = line;
      } catch {
        const el = document.getElementById(`wxline-${sid}`);
        if (el) el.textContent = "Weather unavailable";
      }
    }

    // Live arrivals
    const arrEl = document.getElementById(`arrivals-${sid}`);
    if (!arrEl) return;

    // London via TfL
    if (isTfLStop(stop.naptan)) {
      const arr = await tflArrivals(stop.naptan);
      arrEl.innerHTML = arr.length
        ? `<ul style="margin:4px 0 0 16px;">${arr.map(a=>`<li>${a.line} → ${a.dest} · ${a.etaMin} min</li>`).join("")}</ul>`
        : "No live arrivals";
      return;
    }

    // Elsewhere via BODS
    if (bodsEnabled() && stop.naptan) {
      const res = await bodsArrivalsNear(stop.lat, stop.lon);
      if (res?.error) { arrEl.textContent = "Live arrivals unavailable (BODS error/CORS)."; return; }
      const rows = extractArrivalsForStop(res, stop.naptan);
      arrEl.innerHTML = rows.length
        ? `<ul style="margin:4px 0 0 16px;">${rows.map(a=>`<li>${a.line} → ${a.dest || "—"} · ${a.etaMin} min</li>`).join("")}</ul>`
        : "No live arrivals for this stop right now.";
      return;
    }

    arrEl.textContent = "Live arrivals not available here";
  }

  function addStopMarker(stop, isBest=false) {
    const icon = isBest ? BEST_PULSE_ICON : REGULAR_STOP_ICON;
    const m = L.marker([stop.lat, stop.lon], { icon, zIndexOffset: isBest ? 400 : 0 })
      .addTo(map)
      .bindPopup(renderStopPopup(stop, isBest));
    m.on("popupopen", () => enhanceStopPopup(stop));
    m.on("click", () => chooseStopAndRoute(stop));
    stopMarkers.set(stop.id, m);
    if (isBest) bestStopMarker = m;
  }

  async function drawRouteVia(stop) {
    try {
      const a = `${origin.lon},${origin.lat}`;
      const b = `${stop.lon},${stop.lat}`;
      const c = `${home.lon},${home.lat}`;
      const u1 = `${OSRM_BASE}/${a};${b}?overview=full&geometries=geojson`;
      const u2 = `${OSRM_BASE}/${b};${c}?overview=full&geometries=geojson`;
      const [r1, r2] = await Promise.all([fetch(u1), fetch(u2)]);
      if (!r1.ok || !r2.ok) return;
      const j1 = await r1.json(); const j2 = await r2.json();
      const coords = [
        ...(j1.routes?.[0]?.geometry?.coordinates || []),
        ...(j2.routes?.[0]?.geometry?.coordinates || [])
      ].map(([x,y])=>[y,x]);
      if (coords.length) {
        if (routeLayer) map.removeLayer(routeLayer);
        routeLayer = L.polyline(coords, { color: routeColor, weight: 5, opacity: 0.85 }).addTo(map);
        const dEl = $("#directions"); const sEl = $("#directions-steps");
        if (dEl && sEl) {
          dEl.style.display = "block";
          sEl.innerHTML = `
            <div class="dir-step">Walk to <b>${stop.name}</b>${stop.id===bestStopId ? " (best stop)" : ""}</div>
            <div class="dir-step">Then continue on to <b>Home</b></div>
          `;
        }
      }
    } catch { /* ignore */ }
  }

  async function chooseStopAndRoute(stop) {
    if (elSelection) {
      elSelection.style.display = "block";
      elSelection.innerHTML = `
        <div class="kv">
          <div><strong>${stop.name}</strong> ${stop.id===bestStopId ? `<span class="pill" style="background:#f59e0b;color:#fff;margin-left:6px;">Best stop</span>` : ""}</div>
          <div class="muted">${toFixed(stop.lat)}, ${toFixed(stop.lon)}</div>
        </div>
      `;
    }

    // Ensure popup is open before dynamic loads
    if (stop.id === bestStopId && bestStopMarker) {
      bestStopMarker.setIcon(BEST_SELECTED_ICON);
      bestStopMarker.setPopupContent(renderStopPopup(stop, true));
      bestStopMarker.openPopup();
    } else {
      if (selectedStopMarker) { map.removeLayer(selectedStopMarker); selectedStopMarker = null; }
      selectedStopMarker = L.marker([stop.lat, stop.lon], { icon: REGULAR_STOP_ICON })
        .addTo(map)
        .bindPopup(renderStopPopup(stop, false));
      selectedStopMarker.on("popupopen", () => enhanceStopPopup(stop));
      selectedStopMarker.openPopup();
    }

    await drawRouteVia(stop);
  }

  async function findBestStop() {
    showLoading("Finding best stop…");
    try {
      showError("");
      if (!origin) {
        const ok = await autoLocate();
        if (!ok) { showError("Pick an origin (tap the map) or allow location."); return; }
      }
      if (!home) { showError("Set your Home first."); return; }

      clearStopsUI();
      clearRoute();

      let stops = await fetchStops(origin.lat, origin.lon, SEARCH_RADIUS_METERS);
      if (!stops.length) { showError("No stops found nearby."); return; }

      // Pre-pick closest N to reduce routing calls
      const N = Math.min(8, stops.length);
      const subset = stops
        .map(s => ({ ...s, _d2: (s.lat-origin.lat)**2 + (s.lon-origin.lon)**2 }))
        .sort((a,b)=>a._d2 - b._d2)
        .slice(0, N);

      let best = null;
      for (const s of subset) {
        const d1 = await routeDurationSec({lat:origin.lat,lon:origin.lon},{lat:s.lat,lon:s.lon});
        const d2 = await routeDurationSec({lat:s.lat,lon:s.lon},{lat:home.lat,lon:home.lon});
        s.walkToStopSec = d1; s.walkToHomeSec = d2; s.totalSec = d1 + d2;
        if (!best || s.totalSec < best.totalSec) best = s;
      }
      bestStopId = best?.id || null;

      stops.forEach(s => addStopMarker(s, s.id === bestStopId));
      if (best && bestStopMarker) {
        map.panTo([best.lat, best.lon], { animate: true });
        bestStopMarker.openPopup();
      }

      if (elStops && elStopsList) {
        elStops.style.display = "block";
        elStopsList.innerHTML = subset
          .sort((a,b)=>a.totalSec - b.totalSec)
          .map(s => `
            <div class="stop-item" data-stop-id="${s.id}">
              <div class="stop-left">
                <div class="stop-name">${s.name}</div>
                ${s.naptan ? `<span class="pill">NaPTAN ${s.naptan}</span>` : ""}
                ${s.id===bestStopId ? `<span class="pill" style="background:#f59e0b;color:#fff;">Best</span>` : ""}
              </div>
              <div class="muted">Walk: ${fmtMin(s.walkToStopSec)} + ${fmtMin(s.walkToHomeSec)} = <b>${fmtMin(s.totalSec)}</b></div>
            </div>
          `).join("");

        elStopsList.querySelectorAll(".stop-item").forEach(row => {
          row.addEventListener("click", () => {
            const id = row.getAttribute("data-stop-id");
            const s = subset.find(x => String(x.id) === String(id)) || stops.find(x => String(x.id) === String(id));
            if (s) chooseStopAndRoute(s);
          });
        });
      }

      if (best) await chooseStopAndRoute(best);
    } finally {
      hideLoading();
    }
  }

  // Button
  $("#btn-best-stop")?.addEventListener("click", findBestStop);

  // ----- Boot: restore Home then try auto-locate -----
  (function restoreHomeOnBoot(){ const saved = loadHome(); if (saved) applyHome(saved); })();
  (async () => { await autoLocate(); })();

})();
