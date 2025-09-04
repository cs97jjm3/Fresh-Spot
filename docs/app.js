/* global L */

(() => {
  // ---------------- Config ----------------
  const CFG = window.CONFIG || {};
  const OSRM_BASE = CFG.OSRM_BASE || "https://router.project-osrm.org/route/v1/walking";
  const OVERPASS_URL = CFG.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
  const SEARCH_RADIUS_METERS = CFG.SEARCH_RADIUS_METERS || 800;

  // -------------- DOM shortcuts --------------
  const $ = (s) => document.querySelector(s);

  // Map + layers
  const map = L.map("map", { zoomControl: true }).setView([51.5074, -0.1278], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap",
  }).addTo(map);

  const routeColor = "#0ea5e9";
  let routeLayer = null;

  // Icons
  const REGULAR_STOP_ICON = L.divIcon({
    className: "",
    html: `<div style="width:18px;height:18px;background:#0ea5e9;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.25)"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  const DEST_ICON = L.divIcon({
    className: "",
    html: `<div style="width:18px;height:18px;background:#ef4444;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.25)"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });

  // Pulsing suggestion (best stop before selection)
  const BEST_PULSE_ICON = L.divIcon({
    className: "",
    html: `<div style="position:relative;width:18px;height:18px;border-radius:50%;background:#3b82f6;border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.35)">
      <div style="position:absolute;left:50%;top:50%;width:18px;height:18px;transform:translate(-50%,-50%);border-radius:50%;border:2px solid rgba(59,130,246,.65);animation:pulse 1.6s ease-out infinite"></div>
    </div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  // Selected best (golden)
  const BEST_SELECTED_ICON = L.divIcon({
    className: "",
    html: `<div style="width:22px;height:22px;background:#f59e0b;border:3px solid #fff;border-radius:50%;box-shadow:0 3px 12px rgba(0,0,0,.35)"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });

  // Inject pulse keyframes once
  (function injectPulseCSS() {
    const style = document.createElement("style");
    style.textContent = `
      @keyframes pulse { 0%{transform:translate(-50%,-50%) scale(1);opacity:.85}
        70%{transform:translate(-50%,-50%) scale(2.3);opacity:0} 100%{transform:translate(-50%,-50%) scale(2.3);opacity:0} }
    `;
    document.head.appendChild(style);
  })();

  // -------------- State --------------
  let home = null;     // { lat, lon, display }
  let origin = null;   // { lat, lon, label }
  let originMarker = null;
  let homeMarker = null;

  let stopMarkers = new Map(); // id -> marker
  let bestStopId = null;
  let bestStopMarker = null;   // marker instance for best suggestion (for icon swap)
  let selectedStopMarker = null; // extra selected marker for non-best picks

  // -------------- UI els --------------
  const elSearch = $("#search");
  const elResults = $("#results");
  const elHomeInput = $("#home-input");
  const elHomeResults = $("#home-results");
  const elHomePill = $("#home-pill");
  const elSelection = $("#selection");
  const elStops = $("#stops");
  const elStopsList = $("#stops-list");
  const elBestLabel = $("#best-label");
  const elErrors = $("#errors");

  // -------------- Helpers --------------
  function showError(msg) {
    elErrors.textContent = msg || "";
    elErrors.style.display = msg ? "block" : "none";
  }
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
    inputEl.addEventListener("input", async () => {
      const q = inputEl.value.trim();
      if (!q) { resultsEl.style.display = "none"; resultsEl.innerHTML = ""; return; }
      try {
        if (aborter) aborter.abort();
        aborter = new AbortController();
        const items = await geocode(q);
        resultsEl.innerHTML = items.map(it => {
          const name = it.display_name.replace(/,? United Kingdom$/, "");
          return `<button data-lat="${it.lat}" data-lon="${it.lon}" title="${name}">${name}</button>`;
        }).join("");
        resultsEl.style.display = "block";
      } catch { /* ignore */ }
    });
    resultsEl.addEventListener("click", (e) => {
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

  // Origin handling
  function setOrigin(o) {
    origin = o;
    if (originMarker) map.removeLayer(originMarker);
    originMarker = L.marker([o.lat, o.lon]).addTo(map).bindPopup(`<b>Origin</b><br>${o.label}`).openPopup();
    map.setView([o.lat, o.lon], 15);
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

  // Home handling
  async function setHome(lat, lon, title) {
    const rev = await reverseGeocode(lat, lon);
    const display = formatTownPostcode(rev) || title || "Home";
    home = { lat, lon, display };
    // pill text + click to edit
    elHomePill.textContent = `Home: ${display}`;
    elHomePill.style.display = "inline-block";
    elHomeInput.style.display = "none";
    // marker
    if (homeMarker) map.removeLayer(homeMarker);
    homeMarker = L.marker([lat, lon], { icon: DEST_ICON }).addTo(map).bindPopup(`<b>Home</b><br>${display}`);
  }

  // Make Home pill reopen the input
  elHomePill.addEventListener("click", () => {
    elHomeInput.value = "";
    elHomeInput.style.display = "block";
    elHomeInput.focus();
  });

  // Attach search UIs
  attachDropdown($("#search"), $("#results"), ({ lat, lon, title }) => setOrigin({ lat, lon, label: title }));
  attachDropdown(elHomeInput, elHomeResults, async ({ lat, lon, title }) => {
    await setHome(lat, lon, title);
    elHomeResults.style.display = "none";
  });

  // Use my location
  $("#btn-my-location").addEventListener("click", () => {
    if (!navigator.geolocation) { showError("Geolocation not supported."); return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      setOrigin({ lat, lon, label: "My location" });
    }, () => showError("Could not get your location."));
  });

  // Tap map to set origin
  map.on("click", async (e) => {
    const { lat, lng } = e.latlng;
    const rev = await reverseGeocode(lat, lng);
    const label = rev?.display_name?.replace(/,? United Kingdom$/, "") || "Selected point";
    setOrigin({ lat, lon: lng, label });
  });

  // ---------------- Stops + routing ----------------
  async function fetchStops(lat, lon, radiusM) {
    const q = `
      [out:json][timeout:25];
      (
        node(around:${radiusM},${lat},${lon})["highway"="bus_stop"];
        node(around:${radiusM},${lat},${lon})["public_transport"="platform"]["bus"="yes"];
      );
      out tags center;
    `;
    const r = await fetch(OVERPASS_URL, {
      method: "POST",
      body: "data=" + encodeURIComponent(q),
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    if (!r.ok) throw new Error("Stop lookup failed");
    const j = await r.json();
    return (j.elements || [])
      .map(n => ({
        id: n.id,
        lat: n.lat || n.center?.lat,
        lon: n.lon || n.center?.lon,
        name: n.tags?.name || "Bus stop",
        naptan: n.tags?.["ref:GB:Naptan"] || null
      }))
      .filter(s => s.lat && s.lon);
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
    // remove markers
    stopMarkers.forEach((m) => map.removeLayer(m));
    stopMarkers.clear();
    if (bestStopMarker) { map.removeLayer(bestStopMarker); bestStopMarker = null; }
    if (selectedStopMarker) { map.removeLayer(selectedStopMarker); selectedStopMarker = null; }
    bestStopId = null;
    // sidebar
    elStops.style.display = "none";
    elStopsList.innerHTML = "";
    elBestLabel.style.display = "none";
  }

  function clearRoute() {
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    $("#directions").style.display = "none";
    $("#directions-steps").innerHTML = "";
  }
  $("#btn-clear-route").addEventListener("click", clearRoute);

  function isTfLStop(naptanId) { return !!naptanId && /^4900/i.test(naptanId); }
  function tflAuthParams() {
    const id = CFG?.TFL?.APP_ID, key = CFG?.TFL?.APP_KEY;
    if (id && key) return `?app_id=${encodeURIComponent(id)}&app_key=${encodeURIComponent(key)}`;
    return "";
  }
  async function tflArrivals(naptanId) {
    try {
      const url = `https://api.tfl.gov.uk/StopPoint/${encodeURIComponent(naptanId)}/arrivals${tflAuthParams()}`;
      const r = await fetch(url);
      if (!r.ok) return [];
      const j = await r.json();
      j.sort((a,b)=>a.timeToStation-b.timeToStation);
      return j.slice(0,5).map(a => ({
        line: a.lineName || a.lineId,
        dest: a.destinationName,
        etaMin: Math.max(0, Math.round((a.timeToStation || 0)/60)),
      }));
    } catch { return []; }
  }

  function renderStopPopup(stop, isBest=false) {
    const hdr = isBest ? `<div class="pill" style="background:#f59e0b;color:#fff;margin-bottom:6px;">Best stop</div>` : "";
    const nap = stop.naptan ? `<div class="muted">NaPTAN ${stop.naptan}</div>` : "";
    return `${hdr}<div style="font-weight:700">${stop.name}</div>${nap}
      <div id="arrivals" class="muted" style="margin-top:6px;">${isTfLStop(stop.naptan) ? "Loading arrivals…" : "Live arrivals not available here"}</div>`;
  }

  async function enhanceStopPopup(stop) {
    if (isTfLStop(stop.naptan)) {
      const arr = await tflArrivals(stop.naptan);
      const el = document.querySelector("#arrivals");
      if (el) {
        el.innerHTML = arr.length
          ? `<ul style="margin:4px 0 0 16px;">${arr.map(a=>`<li>${a.line} → ${a.dest} · ${a.etaMin} min</li>`).join("")}</ul>`
          : "No live arrivals";
      }
    }
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
        ...(j2.routes?.[0]?.geometry?.coordinates || []),
      ].map(([x,y])=>[y,x]);
      if (coords.length) {
        if (routeLayer) map.removeLayer(routeLayer);
        routeLayer = L.polyline(coords, { color: routeColor, weight: 5, opacity: 0.85 }).addTo(map);
        $("#directions").style.display = "block";
        $("#directions-steps").innerHTML = `
          <div class="dir-step">Walk to <b>${stop.name}</b>${stop.id===bestStopId ? " (best stop)" : ""}</div>
          <div class="dir-step">Then continue on to <b>Home</b></div>
        `;
      }
      await enhanceStopPopup(stop);
    } catch {/* ignore */}
  }

  async function chooseStopAndRoute(stop) {
    // Update selection card
    elSelection.style.display = "block";
    elSelection.innerHTML = `
      <div class="kv">
        <div><strong>${stop.name}</strong> ${stop.id===bestStopId ? `<span class="pill" style="background:#f59e0b;color:#fff;margin-left:6px;">Best stop</span>` : ""}</div>
        <div class="muted">${toFixed(stop.lat)}, ${toFixed(stop.lon)}</div>
      </div>
    `;

    // Switch icons:
    //  - If this is the BEST stop: change its pulsing icon -> golden selected icon
    //  - If another stop is selected: show a temporary selected marker (so we don't disturb the best marker)
    if (stop.id === bestStopId && bestStopMarker) {
      bestStopMarker.setIcon(BEST_SELECTED_ICON);
    } else {
      if (selectedStopMarker) { map.removeLayer(selectedStopMarker); selectedStopMarker = null; }
      selectedStopMarker = L.marker([stop.lat, stop.lon], { icon: REGULAR_STOP_ICON }).addTo(map);
    }

    await drawRouteVia(stop);
  }

  function addStopMarker(stop, isBest=false) {
    const icon = isBest ? BEST_PULSE_ICON : REGULAR_STOP_ICON;
    const m = L.marker([stop.lat, stop.lon], { icon, zIndexOffset: isBest ? 400 : 0 })
      .addTo(map)
      .bindPopup(renderStopPopup(stop, isBest));
    m.on("popupopen", () => enhanceStopPopup(stop));
    m.on("click", () => chooseStopAndRoute(stop));
    stopMarkers.set(stop.id, m);
    if (isBest) { bestStopMarker = m; }
  }

  async function findBestStop() {
    showError("");
    if (!origin) { showError("Pick an origin first."); return; }
    if (!home) { showError("Set your Home first."); return; }

    // reset UI
    clearStopsUI();
    clearRoute();

    // Load nearby stops
    let stops = [];
    try { stops = await fetchStops(origin.lat, origin.lon, SEARCH_RADIUS_METERS); }
    catch { showError("Could not load nearby stops."); return; }
    if (!stops.length) { showError("No stops found nearby."); return; }

    // Pre-pick closest N to limit routing calls
    const N = Math.min(8, stops.length);
    const subset = stops
      .map(s => ({ ...s, _d2: (s.lat-origin.lat)**2 + (s.lon-origin.lon)**2 }))
      .sort((a,b)=>a._d2 - b._d2)
      .slice(0, N);

    // Score by walking time origin->stop + stop->home
    let best = null;
    for (const s of subset) {
      const d1 = await routeDurationSec({lat:origin.lat,lon:origin.lon},{lat:s.lat,lon:s.lon});
      const d2 = await routeDurationSec({lat:s.lat,lon:s.lon},{lat:home.lat,lon:home.lon});
      s.walkToStopSec = d1;
      s.walkToHomeSec = d2;
      s.totalSec = d1 + d2;
      if (!best || s.totalSec < best.totalSec) best = s;
    }
    bestStopId = best?.id || null;

    // Plot all stops (best pulses)
    stops.forEach(s => addStopMarker(s, s.id === bestStopId));
    if (best) {
      elBestLabel.style.display = "inline-block";
      map.panTo([best.lat, best.lon], { animate: true });
      // Open popup of best
      if (bestStopMarker) bestStopMarker.openPopup();
    }

    // Sidebar list
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

    // Click in list selects & routes
    elStopsList.querySelectorAll(".stop-item").forEach(row => {
      row.addEventListener("click", () => {
        const id = row.getAttribute("data-stop-id");
        const s = subset.find(x => String(x.id) === String(id)) || stops.find(x => String(x.id) === String(id));
        if (s) chooseStopAndRoute(s);
      });
    });

    // Auto-route to best
    if (best) await chooseStopAndRoute(best);
  }

  // Button
  $("#btn-best-stop").addEventListener("click", findBestStop);

  // Restore saved Home if present (optional)
  // (If you’d like persistence, uncomment the lines below and pair with localStorage set.)
  /*
  try {
    const saved = JSON.parse(localStorage.getItem("freshstop.home") || "null");
    if (saved && saved.lat && saved.lon && saved.display) {
      home = saved;
      elHomePill.textContent = `Home: ${home.display}`;
      elHomePill.style.display = "inline-block";
      homeMarker = L.marker([home.lat, home.lon], { icon: DEST_ICON }).addTo(map).bindPopup(`<b>Home</b><br>${home.display}`);
      elHomeInput.style.display = "none";
    }
  } catch {}
  */

})();
