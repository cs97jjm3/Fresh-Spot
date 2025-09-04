// ======= Config & guards =======
const CONFIG = (window.FRESHSTOP_CONFIG || {});
const OWM_KEY = CONFIG.OWM_KEY; // OpenWeatherMap key (required)
const ORS_KEY = CONFIG.ORS_KEY; // OpenRouteService key (optional fallback)

if (!OWM_KEY) {
  console.warn("Missing OWM_KEY. Create config.js with window.FRESHSTOP_CONFIG. See instructions.");
}

// ======= Elements =======
const elSearch = document.getElementById("search");
const elResults = document.getElementById("results");
const elSelection = document.getElementById("selection");
const elWeather = document.getElementById("weather");
const elAir = document.getElementById("air");
const elStops = document.getElementById("stops");
const elStopsList = document.getElementById("stops-list");
const elStopsRadius = document.getElementById("stops-radius");
const elDirections = document.getElementById("directions");
const elDirSteps = document.getElementById("directions-steps");
const elErrors = document.getElementById("errors");
const elBtnMyLoc = document.getElementById("btn-my-location");
const elBtnRoute = document.getElementById("btn-route");
const elBtnClearRoute = document.getElementById("btn-clear-route");
const elRouteSummary = document.getElementById("route-summary");

// Route-from toggle (optional, but recommended in index.html)
const elRFMy = document.getElementById("rf-myloc");
const elRFSel = document.getElementById("rf-selected");

// ======= Map setup =======
const map = L.map("map");
const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors"
});
osm.addTo(map);

// default start (UK-ish); try geolocation after
map.setView([52.2053, 0.1218], 13);

let myLocation = null;       // [lat, lng]
let selectedPoint = null;    // [lat, lng]
let selectedMarker = null;
let routeLine = null;
let stopLayers = [];         // circle markers for stops

// Simple in-memory caches to avoid hammering OWM
const wxNowCache = new Map();     // key: "lat,lon" rounded -> { temp, icon, desc, name, country }
const hourlyCache = new Map();    // key: "lat,lon" rounded -> [hourly items]

// click to select point
map.on("click", (e) => {
  setSelected([e.latlng.lat, e.latlng.lng], "(map click)");
});

// try geolocation once
if ("geolocation" in navigator) {
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      myLocation = [pos.coords.latitude, pos.coords.longitude];
      map.setView(myLocation, 14);
      L.circle(myLocation, { radius: 6, color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 0.7 }).addTo(map);
    },
    () => {}
  );
}

// ======= UI helpers =======
function show(el) { if (el) el.style.display = ""; }
function hide(el) { if (el) el.style.display = "none"; }
function setHTML(el, html) { if (el) el.innerHTML = html; }
function km(meters) { return (meters / 1000).toFixed(2); }
function minutes(seconds) { return Math.round(seconds / 60); }
function roundKey(lat, lon) { return `${lat.toFixed(2)},${lon.toFixed(2)}`; } // ~1-2km tile
function escapeHtml(s="") {
  return s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
}
function iconUrl(code) { return `https://openweathermap.org/img/wn/${code}@2x.png`; }
function hourStr(ts, tzOffsetSec = 0) {
  const d = new Date((ts + tzOffsetSec) * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function haversine(a, b) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}

// ======= Route-from toggle helpers =======
function getRouteFromMode() {
  // default to "myloc" if the radios aren't present
  if (!elRFMy || !elRFSel) return "myloc";
  return elRFSel.checked ? "selected" : "myloc";
}

async function getOrigin() {
  const mode = getRouteFromMode();

  if (mode === "selected") {
    if (!selectedPoint) throw new Error("Pick a point on the map first.");
    return selectedPoint;
  }

  // mode === "myloc"
  if (myLocation) return myLocation;

  const pos = await getCurrentPosition();
  myLocation = [pos.coords.latitude, pos.coords.longitude];
  L.circle(myLocation, { radius: 6, color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 0.7 }).addTo(map);
  return myLocation;
}

// ======= Reverse geocode (Nominatim) =======
async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&addressdetails=1`;
  const data = await getJSON(url, { "Accept-Language": "en" });
  const a = data?.address || {};
  const parts = [
    [a.road, a.pedestrian, a.footway, a.cycleway, a.path].find(Boolean),
    a.suburb || a.neighbourhood || a.village || a.hamlet,
    a.town || a.city || a.county,
    a.postcode
  ].filter(Boolean);
  return {
    line: parts.join(", "),
    display: data?.display_name || "",
    postcode: a.postcode || "",
  };
}

// ======= Selection workflow =======
async function setSelected([lat, lng], source = "") {
  selectedPoint = [lat, lng];

  // marker
  if (selectedMarker) selectedMarker.remove();
  selectedMarker = L.circleMarker(selectedPoint, {
    radius: 7, color: "#ef4444", fillColor: "#ef4444", fillOpacity: 0.8
  }).addTo(map);

  map.panTo(selectedPoint);

  // clear panels
  hide(elErrors);
  hide(elWeather); hide(elAir); hide(elStops); hide(elDirections);
  setHTML(elWeather, ""); setHTML(elAir, ""); setHTML(elStopsList, ""); setHTML(elDirSteps, "");
  hide(elRouteSummary);
  clearStops();
  clearRoute();

  // selection card (friendly address, keeps coords)
  const latTxt = lat.toFixed(5);
  const lngTxt = lng.toFixed(5);

  setHTML(elSelection, `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
      <div>
        <div style="font-weight:700; margin-bottom:4px;">Selected location</div>
        <div class="muted">Looking up address…</div>
      </div>
      <button class="btn" id="btn-copy">Copy coords</button>
    </div>
  `);
  show(elSelection);
  document.getElementById("btn-copy").onclick = () => navigator.clipboard?.writeText(`${latTxt}, ${lngTxt}`);

  try {
    const rev = await reverseGeocode(lat, lng);
    const pretty = rev.line || rev.display || `${latTxt}, ${lngTxt}`;
    setHTML(elSelection, `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
        <div>
          <div style="font-weight:700; margin-bottom:4px;">Selected location</div>
          <div>${escapeHtml(pretty)}${source ? ` • <span class="muted">${escapeHtml(source)}</span>` : ""}</div>
          <div class="muted" style="font-size:12px;">${latTxt}, ${lngTxt}</div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="btn" id="btn-copy">Copy coords</button>
          ${rev.postcode ? `<span class="pill" title="Postcode">${escapeHtml(rev.postcode)}</span>` : ""}
        </div>
      </div>
    `);
    document.getElementById("btn-copy").onclick = () => navigator.clipboard?.writeText(`${latTxt}, ${lngTxt}`);
  } catch {
    // keep default coords-only view if reverse fails
  }

  // load weather + air + stops (in parallel)
  try {
    await Promise.all([
      loadWeatherAndForecast(lat, lng),
      loadAir(lat, lng),
      loadStops(lat, lng, 800) // meters
    ]);
  } catch (err) {
    setHTML(elErrors, `⚠️ ${err.message || "Couldn’t load one of the panels."}`);
    show(elErrors);
  }
}

// ======= Weather + Next 2 hours =======
async function loadWeatherAndForecast(lat, lng) {
  if (!OWM_KEY) throw new Error("Missing OpenWeatherMap key.");

  // Current weather
  const wx = await getJSON(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=metric&appid=${OWM_KEY}`);
  const t = Math.round(wx?.main?.temp ?? 0);
  const feels = Math.round(wx?.main?.feels_like ?? 0);
  const desc = (wx?.weather?.[0]?.description || "").replace(/^\w/, c => c.toUpperCase());
  const wind = Math.round(wx?.wind?.speed ?? 0);
  const place = [wx?.name, wx?.sys?.country].filter(Boolean).join(", ");
  const icon = wx?.weather?.[0]?.icon;

  // Cache “now” for nearby stops reuse
  wxNowCache.set(roundKey(lat, lng), {
    temp: t, icon, desc, name: wx?.name, country: wx?.sys?.country
  });

  // Try OneCall hourly; fallback to /forecast 3-hourly
  let hours = [];
  try {
    const one = await getJSON(`https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lng}&exclude=minutely,daily,alerts&units=metric&appid=${OWM_KEY}`);
    const tz = one?.timezone_offset || 0;
    hours = (one?.hourly || []).slice(0, 3).map(h => ({
      ts: h.dt, t: Math.round(h.temp), icon: h.weather?.[0]?.icon, tz
    }));
  } catch {
    const fc = await getJSON(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lng}&units=metric&cnt=2&appid=${OWM_KEY}`);
    hours = (fc?.list || []).map(h => ({
      ts: Math.floor(new Date(h.dt_txt).getTime()/1000),
      t: Math.round(h.main?.temp),
      icon: h.weather?.[0]?.icon,
      tz: 0
    }));
  }
  hourlyCache.set(roundKey(lat, lng), hours);

  // Render WOW weather
 setHTML(elWeather, `
  <div class="wx-top">
    <div class="wx-main">
      ${icon ? `<img src="${iconUrl(icon)}" width="64" height="64" alt="${escapeHtml(desc)}" />` : ""}
      <div>
        <div class="wx-temp">${t}°C</div>
        <div class="wx-desc">${escapeHtml(desc)} ${place ? `• <span class="pill">${escapeHtml(place)}</span>` : ""}</div>
        <div class="muted">Feels like ${feels}°C • Wind ${wind} m/s</div>
      </div>
    </div>
  </div>

  <div style="margin-top:10px; font-weight:700;">Next 2 hours</div>
  <div class="wx-hours">
    ${hours.map(h => `
      <div class="wx-hour">
        <div>${hourStr(h.ts, h.tz)}</div>
        ${h.icon ? `<img src="${iconUrl(h.icon)}" alt="" />` : ""}
        <div class="t">${h.t}°C</div>
      </div>
    `).join("")}
  </div>
  `);
  show(elWeather);
}

// ======= Air Quality WOW =======
function aqiClass(n) {
  switch (n) {
    case 1: return ["Good","aqi-good"];
    case 2: return ["Fair","aqi-fair"];
    case 3: return ["Moderate","aqi-moderate"];
    case 4: return ["Poor","aqi-poor"];
    case 5: return ["Very Poor","aqi-vpoor"];
    default: return ["Unknown","aqi-moderate"];
  }
}
function pct(value, max) { return Math.max(0, Math.min(100, Math.round((value / max) * 100))); }

async function loadAir(lat, lng) {
  if (!OWM_KEY) throw new Error("Missing OpenWeatherMap key.");
  const air = await getJSON(`https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lng}&appid=${OWM_KEY}`);

  const main = air?.list?.[0]?.main || {};
  const comp = air?.list?.[0]?.components || {};
  const [label, cls] = aqiClass(main.aqi || 0);

  // Indicative scales for bar rendering (μg/m³)
  const scales = { pm2_5: 75, pm10: 150, no2: 200, o3: 180 };

  setHTML(elAir, `
    <div style="display:flex; align-items:center; justify-content:space-between;">
      <div>
        <div style="font-weight:700; margin-bottom:4px;">Air quality</div>
        <div class="muted" style="font-size:12px;">OpenWeatherMap AQI (1–5)</div>
      </div>
      <div class="aqi-badge ${cls}">AQI ${main.aqi ?? "?"} • ${label}</div>
    </div>

    <div style="margin-top:10px; display:grid; gap:10px;">
      ${["pm2_5","pm10","no2","o3"].map(k => {
        const v = comp[k];
        const max = scales[k];
        const percentage = pct(v ?? 0, max);
        return `
          <div>
            <div class="kv"><span>${k.toUpperCase()}</span><span>${v != null ? v : "—"} μg/m³</span></div>
            <div class="bar"><span style="width:${percentage}%;"></span></div>
          </div>
        `;
      }).join("")}
    </div>
  `);
  show(elAir);
}

// ======= Stops (Overpass) + Weather per stop =======
async function loadStops(lat, lng, radiusMeters = 800) {
  elStopsRadius.textContent = radiusMeters;
  const query = `
[out:json][timeout:25];
(
  node(around:${radiusMeters},${lat},${lng})["highway"="bus_stop"];
  node(around:${radiusMeters},${lat},${lng})["public_transport"="platform"]["bus"="yes"];
  node(around:${radiusMeters},${lat},${lng})["railway"~"^(station|halt|stop|tram_stop)$"];
);
out body;
>;
out skel qt;
`.trim();

  const data = await overpass(query);
  let stops = (data.elements || [])
    .filter(el => el.type === "node")
    .map(el => {
      const tags = el.tags || {};
      const isBus = tags.highway === "bus_stop" || tags.bus === "yes";
      const isTrain = /^station|halt|stop|tram_stop$/.test(tags.railway || "");
      const kind = isTrain ? "train" : "bus";
      const name = tags.name || (isBus ? "Bus stop" : "Station");
      const pos = [el.lat, el.lon];
      const dist = selectedPoint ? haversine(selectedPoint, pos) : 0;
      return { id: el.id, kind, name, pos, dist, tags };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 12); // cap list for clarity + fewer API calls

  // Draw markers
  clearStops();
  for (const s of stops) {
    const color = s.kind === "bus" ? "#0ea5e9" : "#10b981";
    const m = L.circleMarker(s.pos, { radius: 6, color, fillColor: color, fillOpacity: 0.85 })
      .addTo(map)
      .bindTooltip(`${s.name} (${s.kind})`);
    stopLayers.push(m);
  }

  // Render list (placeholders for weather)
  setHTML(elStopsList, stops.map(s => `
    <div class="stop-item" data-stop="${s.id}">
      <div class="stop-left">
        <div class="stop-wx" id="wx-${s.id}"><span class="muted">…</span></div>
        <div>
          <div class="stop-name">${escapeHtml(s.name)}</div>
          <div class="muted" style="font-size:12px;">${s.kind === "bus" ? "Bus stop" : "Train/Tram"} • ${Math.round(s.dist)} m</div>
        </div>
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        <span class="stop-kind ${s.kind === "bus" ? "kind-bus" : "kind-train"}">${s.kind}</span>
        <button class="btn" data-route="${s.id}" title="Route from chosen origin to this stop">Route</button>
      </div>
    </div>
  `).join(""));
  show(elStops);

  // Fill weather for each stop (cached + limited)
  await fillStopsWeather(stops);

  // Wire route buttons – use origin based on toggle
  [...elStopsList.querySelectorAll("button[data-route]")].forEach(btn => {
    btn.onclick = async () => {
      hide(elErrors);
      try {
        const origin = await getOrigin();
        const id = btn.getAttribute("data-route");
        const s = stops.find(x => x.id.toString() === id);
        if (!s) return;
        routeBetween(origin, s.pos);
      } catch (err) {
        showError(err.message || "Couldn’t start routing.");
      }
    };
  });
}

async function fillStopsWeather(stops) {
  // Limit requests: only first 8 will fetch; the rest reuse nearest cached tile
  const MAX_FETCH = 8;
  let remaining = MAX_FETCH;

  for (const s of stops) {
    const key = roundKey(s.pos[0], s.pos[1]);
    let wx = wxNowCache.get(key);
    if (!wx && remaining > 0) {
      try {
        const w = await getJSON(`https://api.openweathermap.org/data/2.5/weather?lat=${s.pos[0]}&lon=${s.pos[1]}&units=metric&appid=${OWM_KEY}`);
        wx = {
          temp: Math.round(w?.main?.temp ?? 0),
          icon: w?.weather?.[0]?.icon,
          desc: w?.weather?.[0]?.description || "",
          name: w?.name, country: w?.sys?.country
        };
        wxNowCache.set(key, wx);
        remaining--;
      } catch {
        // ignore
      }
    }
    const el = document.getElementById(`wx-${s.id}`);
    if (!el) continue;
    if (wx && wx.icon != null) {
      el.innerHTML = `<img src="${iconUrl(wx.icon)}" alt="" /><strong>${wx.temp}°C</strong>`;
    } else {
      el.innerHTML = `<span class="pill">n/a</span>`;
    }
  }
}

function clearStops() {
  for (const l of stopLayers) l.remove();
  stopLayers = [];
}

async function overpass(query) {
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query })
  });
  if (!res.ok) throw new Error("Overpass busy/unavailable");
  return await res.json();
}

// ======= Routing (OSRM first, ORS fallback) + directions =======
elBtnRoute.onclick = async () => {
  hide(elErrors);
  hide(elRouteSummary);

  try {
    if (!selectedPoint) throw new Error("Pick a destination on the map (or via search) first.");
    const origin = await getOrigin();
    const dest = selectedPoint;
    if (origin[0] === dest[0] && origin[1] === dest[1]) {
      throw new Error("Origin and destination are the same. Switch the ‘Route from’ option or pick a different point.");
    }
    routeBetween(origin, dest);
  } catch (err) {
    showError(err.message || "Couldn’t start routing.");
  }
};

elBtnMyLoc.onclick = async () => {
  hide(elErrors);
  try {
    const pos = await getCurrentPosition();
    myLocation = [pos.coords.latitude, pos.coords.longitude];
    map.setView(myLocation, 15);
    L.circle(myLocation, { radius: 6, color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 0.7 }).addTo(map);
  } catch {
    showError("Couldn’t read your location (permission denied?).");
  }
};

elBtnClearRoute && (elBtnClearRoute.onclick = () => {
  clearRoute();
  hide(elDirections);
  hide(elRouteSummary);
});

function clearRoute() {
  if (routeLine) routeLine.remove();
  routeLine = null;
  setHTML(elDirSteps, "");
}

async function routeBetween(from, to) {
  try {
    const r = await routeOSRM(from, to);
    drawRoute(r);
  } catch (e1) {
    if (ORS_KEY) {
      try {
        const r = await routeORS(from, to, ORS_KEY);
        drawRoute(r);
      } catch (e2) {
        showError("Routing failed (OSRM & ORS).");
      }
    } else {
      showError("Routing failed (OSRM). You can add an ORS key for fallback.");
    }
  }
}

async function routeOSRM(from, to) {
  const url = `https://router.project-osrm.org/route/v1/foot/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson&steps=true`;
  const data = await getJSON(url);
  const r = data?.routes?.[0];
  if (!r) throw new Error("No OSRM route");
  const coords = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  const steps = (r.legs?.[0]?.steps || []).map(osrmStepToText);
  return { coords, distance: r.distance, duration: r.duration, steps };
}

async function routeORS(from, to, key) {
  const url = "https://api.openrouteservice.org/v2/directions/foot-walking/geojson";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": key, "Content-Type": "application/json" },
    body: JSON.stringify({ coordinates: [[from[1], from[0]], [to[1], to[0]]], instructions: true })
  });
  if (!res.ok) throw new Error("ORS error");
  const data = await res.json();
  const feat = data?.features?.[0];
  const coords = feat?.geometry?.coordinates?.map(([lng, lat]) => [lat, lng]) || [];
  const sum = feat?.properties?.summary || {};
  const raw = feat?.properties?.segments?.[0]?.steps || [];
  const steps = raw.map(orsStepToText);
  if (!coords.length) throw new Error("No ORS route");
  return { coords, distance: sum.distance ?? 0, duration: sum.duration ?? 0, steps };
}

function drawRoute(route) {
  const { coords, distance, duration, steps } = route;

  if (routeLine) routeLine.remove();
  routeLine = L.polyline(coords, { weight: 5 }).addTo(map);

  map.fitBounds(L.latLngBounds(coords), { padding: [20, 20] });

  elRouteSummary.textContent = `Distance: ${km(distance)} km • Time: ${minutes(duration)} min`;
  show(elRouteSummary);

  if (steps && steps.length) {
    setHTML(elDirSteps, steps.map((s, i) => `<div class="dir-step">${i+1}. ${escapeHtml(s)}</div>`).join(""));
    show(elDirections);
  } else {
    hide(elDirections);
  }
}

function osrmStepToText(step) {
  const m = step.maneuver || {};
  const type = m.type || "continue";
  const mod = m.modifier ? ` ${m.modifier}` : "";
  const road = step.name ? ` onto ${step.name}` : "";
  const dist = step.distance ? ` (${Math.round(step.distance)} m)` : "";
  switch (type) {
    case "depart": return `Start${road}${dist}`;
    case "arrive": return `Arrive at destination${dist}`;
    case "roundabout": return `Enter roundabout and take exit${dist}`;
    case "fork": return `Keep${mod}${road}${dist}`;
    case "turn": return `Turn${mod}${road}${dist}`;
    case "new name": return `Continue${road}${dist}`;
    case "merge": return `Merge${road}${dist}`;
    case "end of road": return `End of road, turn${mod}${road}${dist}`;
    default: return `Continue${road}${dist}`;
  }
}
function orsStepToText(step) {
  const name = step.name ? ` onto ${step.name}` : "";
  const dist = step.distance ? ` (${Math.round(step.distance)} m)` : "";
  const text = step.instruction || step.type || "Continue";
  return `${text}${name}${dist}`;
}

// ======= Search (Nominatim) =======
let searchTimer;
elSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = elSearch.value.trim();
  if (q.length < 3) { hide(elResults); elResults.innerHTML = ""; return; }
  searchTimer = setTimeout(() => doSearch(q), 350);
});

async function doSearch(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`;
  try {
    const data = await getJSON(url, { "Accept-Language": "en" });
    if (!Array.isArray(data) || !data.length) { hide(elResults); elResults.innerHTML = ""; return; }
    elResults.innerHTML = data.map(row => `
      <button data-lat="${row.lat}" data-lon="${row.lon}">
        ${row.display_name.replaceAll("&", "&amp;")}
      </button>
    `).join("");
    show(elResults);
    [...elResults.querySelectorAll("button")].forEach(btn => {
      btn.onclick = () => {
        const lat = parseFloat(btn.dataset.lat);
        const lon = parseFloat(btn.dataset.lon);
        setSelected([lat, lon], "search");
        hide(elResults);
        elResults.innerHTML = "";
      };
    });
  } catch {
    hide(elResults);
  }
}

// close results when clicking outside
document.addEventListener("click", (e) => {
  if (!elResults.contains(e.target) && e.target !== elSearch) hide(elResults);
});

// ======= Small helpers =======
async function getJSON(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...extraHeaders } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.json();
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation unsupported"));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 });
  });
}

function showError(msg) { setHTML(elErrors, `⚠️ ${msg}`); show(elErrors); }
