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
  const BEST_BOARD_ICON = L.divIcon({
    className: "",
    html: `<div style="position:relative;width:18px;height:18px;border-radius:50%;background:#3b82f6;border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.35)">
      <div style="position:absolute;left:50%;top:50%;width:18px;height:18px;transform:translate(-50%,-50%);border-radius:50%;border:2px solid rgba(59,130,246,.65);animation:pulse 1.6s ease-out infinite"></div>
    </div>`,
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
  const BEST_ALIGHT_ICON = L.divIcon({
    className: "",
    html: `<div style="width:22px;height:22px;background:#10b981;border:3px solid #fff;border-radius:50%;box-shadow:0 3px 12px rgba(0,0,0,.35)"></div>`,
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
    el.innerHTML = `<div class="box"><div class="spinner"></div><div class="muted">Finding best stops…</div></div>`;
    document.body.appendChild(el);
    return el;
  }
  function showLoading(msg = "Finding best stops…") {
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
  let bestBoard = null;          // best boarding stop (near origin)
  let bestAlight = null;         // best alighting stop (near home)
  let bestBoardMarker = null;
  let bestAlightMarker = null;

  let routeLayerGroup = null;    // FeatureGroup with both walking segments

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
    const thePc = a.postcode || "";
    return [town, thePc].filter(Boolean).join(", ");
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
    if (bestBoardMarker) { map.removeLayer(bestBoardMarker); bestBoardMarker = null; }
    if (bestAlightMarker) { map.removeLayer(bestAlightMarker); bestAlightMarker = null; }
    bestBoard = null; bestAlight = null;
    if (elStops) { elStops.style.display = "none"; elStopsList.innerHTML = ""; }
  }
  function clearRoute() {
    if (routeLayerGroup) { map.removeLayer(routeLayerGroup); routeLayerGroup = null; }
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

  // --- Weather w/ icon (Met Office → Open-Meteo fallback) ---
  function wxIconDataUri(kind){
    // small inline SVGs (monochrome; auto-invert in dark UIs)
    const base = (p)=>`data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><g fill='currentColor'>${p}</g></svg>`
    )}`;
    const sun = base("<circle cx='12' cy='12' r='4'/><g stroke='currentColor' stroke-width='2' stroke-linecap='round' fill='none'><path d='M12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1'/></g>");
    const cloud = base("<path d='M7 18h9a4 4 0 0 0 0-8 6 6 0 0 0-11 2 3 3 0 0 0 2 6z'/>");
    const cloudSun = base("<circle cx='6' cy='8' r='2.5'/><path d='M7 18h9a4 4 0 0 0 0-8 6 6 0 0 0-11 2 3 3 0 0 0 2 6z'/>");
    const rain = base("<path d='M7 18h9a4 4 0 0 0 0-8 6 6 0 0 0-11 2 3 3 0 0 0 2 6z'/><g stroke='currentColor' stroke-linecap='round'><path d='M9 20l-1 3'/><path d='M12 20l-1 3'/><path d='M15 20l-1 3'/></g>");
    const drizzle = base("<path d='M7 18h9a4 4 0 0 0 0-8 6 6 0 0 0-11 2 3 3 0 0 0 2 6z'/><g stroke='currentColor' stroke-linecap='round'><path d='M9 20v2'/><path d='M12 20v2'/><path d='M15 20v2'/></g>");
    const snow = base("<path d='M7 18h9a4 4 0 0 0 0-8 6 6 0 0 0-11 2 3 3 0 0 0 2 6z'/><g stroke='currentColor' stroke-linecap='round'><path d='M9 20l1 2M9 22l1-2'/><path d='M12 20l1 2M12 22l1-2'/><path d='M15 20l1 2M15 22l1-2'/></g>");
    const thunder = base("<path d='M7 18h9a4 4 0 0 0 0-8 6 6 0 0 0-11 2 3 3 0 0 0 2 6z'/><path d='M11 12l-2 4h3l-1 4 4-6h-3l1-2z'/>");
    const fog = base("<path d='M6 10h12M4 13h16M6 16h12'/>");
    const map = {
      clear: sun,
      "mostly clear": sun,
      "partly cloudy": cloudSun,
      overcast: cloud,
      fog,
      drizzle,
      rain,
      showers: rain,
      snow,
      thunderstorm: thunder,
      "thunder w/ hail": thunder
    };
    // default cloud
    return map[kind] || cloud;
  }
  function wmCodeToText(code){
    const MAP = {
      0:"clear", 1:"mostly clear", 2:"partly cloudy", 3:"overcast",
      45:"fog",48:"fog",51:"drizzle",53:"drizzle",55:"drizzle",
      61:"rain",63:"rain",65:"rain",66:"rain",
      71:"snow",73:"snow",75:"snow",77:"snow",
      80:"showers",81:"showers",82:"showers",
      95:"thunderstorm",96:"thunderstorm",99:"thunderstorm"
    };
    return MAP[code] || `code ${code}`;
  }
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
      return { tempC: t, kind: wmCodeToText(code) };
    } catch { return null; }
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
      return { tempC: t, kind: wmCodeToText(code) };
    }catch{ return null; }
  }
  async function getWeather(lat, lon){
    const mo = await metOfficeSpot(lat, lon);
    if (mo) return mo;
    const om = await openMeteoNow(lat, lon);
    if (om) return om;
    return null;
  }

  // --- Popups with weather icon ---
  function renderStopPopup(stop, role /* 'board' | 'alight' */) {
    const sid = `s${String(stop.id).replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const rolePill =
      role === "board" ? `<div class="pill" style="background:#3b82f6;color:#fff;margin-bottom:6px;">Board here</div>` :
      role === "alight" ? `<div class="pill" style="background:#10b981;color:#fff;margin-bottom:6px;">Alight here</div>` : "";

    const wxRow = `<div id="wxline-${sid}" class="stop-wx" style="margin-top:6px;">Loading weather…</div>`;

    let live = `<div class="muted" style="margin-top:6px;">Live arrivals not available here</div>`;
    if (role === "board" && (isTfLStop(stop.naptan) || (bodsEnabled() && stop.naptan))) {
      live = `<div id="arrivals-${sid}" class="muted" style="margin-top:6px;">Loading arrivals…</div>`;
    }

    return `${rolePill}<div style="font-weight:700">${stop.name}</div>${wxRow}${live}`;
  }

  async function enhanceStopPopup(stop, role) {
    const sid = `s${String(stop.id).replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const wxEl = document.getElementById(`wxline-${sid}`);
    try {
      const wx = await getWeather(stop.lat, stop.lon);
      if (wx && wxEl) {
        const icon = wxIconDataUri(wx.kind);
        wxEl.innerHTML = `<img alt="" src="${icon}" style="width:20px;height:20px;vertical-align:-4px;margin-right:6px;"> ${Math.round(wx.tempC)}°C · ${wx.kind}`;
      } else if (wxEl) {
        wxEl.textContent = "Weather unavailable";
      }
    } catch { if (wxEl) wxEl.textContent = "Weather unavailable"; }

    if (role !== "board") return; // live arrivals only for boarding stop

    const arrEl = document.getElementById(`arrivals-${sid}`);
    if (!arrEl) return;

    if (isTfLStop(stop.naptan)) {
      const arr = await tflArrivals(stop.naptan);
      arrEl.innerHTML = arr.length
        ? `<ul style="margin:4px 0 0 16px;">${arr.map(a=>`<li>${a.line} → ${a.dest} · ${a.etaMin} min</li>`).join("")}</ul>`
        : "No live arrivals";
      return;
    }

    if (bodsEnabled() && stop.naptan) {
      const res = await bodsArrivalsNear(stop.lat, stop.lon);
      if (res?.error) { arrEl.textContent = "Live arrivals unavailable (BODS error/CORS)."; return; }
      const rows = extractArrivalsForStop(res, stop.naptan);
      arrEl.innerHTML = rows.length
        ? `<ul style="margin:4px 0 0 16px;">${rows.map(a=>`<li>${a.line} → ${a.dest || "—"} · ${a.etaMin} min</li>`).join("")}</ul>`
        : "No live arrivals for this stop right now.";
    }
  }

  function addStopMarker(stop, role /* 'board'|'alight'|'regular' */) {
    const icon =
      role === "board"  ? BEST_BOARD_ICON :
      role === "alight" ? BEST_ALIGHT_ICON :
      REGULAR_STOP_ICON;

    const m = L.marker([stop.lat, stop.lon], { icon, zIndexOffset: role === "board" ? 400 : 0 })
      .addTo(map)
      .bindPopup(renderStopPopup(stop, role));
    m.on("popupopen", () => enhanceStopPopup(stop, role));

    stopMarkers.set(`${role}-${stop.id}`, m);
    if (role === "board") bestBoardMarker = m;
    if (role === "alight") bestAlightMarker = m;
    return m;
  }

  function drawWalkingSegment(a, b, color) {
    return L.polyline([[a.lat,a.lon],[b.lat,b.lon]].map(([y,x])=>[y,x]), {
      color, weight: 5, opacity: 0.9, dashArray: "4 6"
    });
  }

  async function drawRoutePair(board, alight) {
    // Get OSRM polylines for both walking segments
    try {
      const a = `${origin.lon},${origin.lat}`;
      const b = `${board.lon},${board.lat}`;
      const c = `${alight.lon},${alight.lat}`;
      const d = `${home.lon},${home.lat}`;

      const u1 = `${OSRM_BASE}/${a};${b}?overview=full&geometries=geojson`;
      const u2 = `${OSRM_BASE}/${c};${d}?overview=full&geometries=geojson`;
      const [r1, r2] = await Promise.all([fetch(u1), fetch(u2)]);
      if (!r1.ok || !r2.ok) return;

      const j1 = await r1.json(); const j2 = await r2.json();
      const coords1 = (j1.routes?.[0]?.geometry?.coordinates || []).map(([x,y])=>[y,x]);
      const coords2 = (j2.routes?.[0]?.geometry?.coordinates || []).map(([x,y])=>[y,x]);

      if (routeLayerGroup) { map.removeLayer(routeLayerGroup); routeLayerGroup = null; }
      routeLayerGroup = L.featureGroup().addTo(map);

      if (coords1.length) routeLayerGroup.addLayer(L.polyline(coords1, { color: "#0ea5e9", weight: 5, opacity: 0.9 }));
      if (coords2.length) routeLayerGroup.addLayer(L.polyline(coords2, { color: "#10b981", weight: 5, opacity: 0.9 }));

      const dEl = $("#directions"); const sEl = $("#directions-steps");
      if (dEl && sEl) {
        dEl.style.display = "block";
        sEl.innerHTML = `
          <div class="dir-step">Walk to <b>${board.name}</b> (boarding)</div>
          <div class="dir-step">Ride bus (time varies)</div>
          <div class="dir-step">Alight at <b>${alight.name}</b></div>
          <div class="dir-step">Walk to <b>Home</b></div>
        `;
      }

      const bounds = routeLayerGroup.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.25));
    } catch {/* ignore */}
  }

  function updateSelectionPanel(board, alight, toBoardSec, fromAlightSec) {
    if (!elSelection) return;
    elSelection.style.display = "block";
    elSelection.innerHTML = `
      <div class="stack">
        <div class="kv"><div><strong>${board.name}</strong> <span class="pill" style="background:#3b82f6;color:#fff;margin-left:6px;">Board</span></div><div class="muted">${toFixed(board.lat)}, ${toFixed(board.lon)}</div></div>
        <div class="kv"><div><strong>${alight.name}</strong> <span class="pill" style="background:#10b981;color:#fff;margin-left:6px;">Alight</span></div><div class="muted">${toFixed(alight.lat)}, ${toFixed(alight.lon)}</div></div>
        <div class="muted">Walking: to board <b>${fmtMin(toBoardSec)}</b> + from alight <b>${fmtMin(fromAlightSec)}</b> = <b>${fmtMin(toBoardSec + fromAlightSec)}</b></div>
      </div>
    `;
  }

  async function choosePairAndRoute(board, alight, toBoardSec, fromAlightSec) {
    bestBoard = board; bestAlight = alight;

    // Markers
    if (bestBoardMarker) { map.removeLayer(bestBoardMarker); bestBoardMarker = null; }
    if (bestAlightMarker) { map.removeLayer(bestAlightMarker); bestAlightMarker = null; }
    addStopMarker(board, "board");
    addStopMarker(alight, "alight");
    if (bestBoardMarker) { map.panTo([board.lat, board.lon], { animate: true }); bestBoardMarker.openPopup(); }

    updateSelectionPanel(board, alight, toBoardSec, fromAlightSec);
    await drawRoutePair(board, alight);
  }

  // ---------- Find best boarding + alighting pair ----------
  async function findBestStopsPair() {
    showLoading("Finding best stops…");
    try {
      showError("");
      if (!origin) {
        const ok = await autoLocate();
        if (!ok) { showError("Pick an origin (tap the map) or allow location."); return; }
      }
      if (!home) { showError("Set your Home first."); return; }

      clearStopsUI();
      clearRoute();

      // Fetch candidates around origin & home
      let originStops = await fetchStops(origin.lat, origin.lon, SEARCH_RADIUS_METERS);
      let homeStops   = await fetchStops(home.lat, home.lon, SEARCH_RADIUS_METERS);
      if (!originStops.length) { showError("No boarding stops found near origin."); return; }
      if (!homeStops.length)   { showError("No alighting stops found near Home."); return; }

      // Pre-pick closest N for each to reduce routing calls
      const N = 8;
      const byDist = (base) => (s) => ({ ...s, _d2: (s.lat-base.lat)**2 + (s.lon-base.lon)**2 });
      originStops = originStops.map(byDist(origin)).sort((a,b)=>a._d2-b._d2).slice(0, N);
      homeStops   = homeStops.map(byDist(home)).sort((a,b)=>a._d2-b._d2).slice(0, N);

      // Evaluate pairs by total walking (to board + from alight)
      let best = null;
      const rows = [];
      for (const b of originStops) {
        const toBoardSec = await routeDurationSec({lat:origin.lat,lon:origin.lon},{lat:b.lat,lon:b.lon});
        for (const a of homeStops) {
          const fromAlightSec = await routeDurationSec({lat:a.lat,lon:a.lon},{lat:home.lat,lon:home.lon});
          const totalSec = toBoardSec + fromAlightSec;
          rows.push({ board:b, alight:a, toBoardSec, fromAlightSec, totalSec });
          if (!best || totalSec < best.totalSec) best = { board:b, alight:a, toBoardSec, fromAlightSec, totalSec };
        }
      }

      // Render markers (regular for all, special for best pair)
      originStops.forEach(s => addStopMarker(s, "regular"));
      homeStops.forEach(s => addStopMarker(s, "regular"));

      // List top 6 pairs
      if (elStops && elStopsList) {
        elStops.style.display = "block";
        const top = rows.sort((a,b)=>a.totalSec - b.totalSec).slice(0, 6);
        elStopsList.innerHTML = top.map((r, idx) => `
            <div class="stop-item" data-idx="${idx}">
              <div class="stop-left">
                <div>
                  <div class="stop-name">Board: ${r.board.name}</div>
                  <div class="muted">Alight: ${r.alight.name}</div>
                </div>
                ${r === top[0] ? `<span class="pill" style="background:#f59e0b;color:#fff;margin-left:6px;">Best</span>` : ""}
              </div>
              <div class="muted">
                To board: ${fmtMin(r.toBoardSec)} · From alight: ${fmtMin(r.fromAlightSec)} = <b>${fmtMin(r.totalSec)}</b>
              </div>
            </div>
        `).join("");

        elStopsList.querySelectorAll(".stop-item").forEach(row => {
          row.addEventListener("click", () => {
            const idx = parseInt(row.getAttribute("data-idx"), 10);
            const chosen = rows.sort((a,b)=>a.totalSec - b.totalSec).slice(0,6)[idx];
            if (chosen) choosePairAndRoute(chosen.board, chosen.alight, chosen.toBoardSec, chosen.fromAlightSec);
          });
        });
      }

      if (best) await choosePairAndRoute(best.board, best.alight, best.toBoardSec, best.fromAlightSec);
    } finally {
      hideLoading();
    }
  }

  // Button
  $("#btn-best-stop")?.addEventListener("click", findBestStopsPair);

  // ----- Boot: restore Home then try auto-locate -----
  (function restoreHomeOnBoot(){
    const saved = loadHome();
    if (saved) applyHome(saved);
  })();
  (async () => { await autoLocate(); })();

})();
