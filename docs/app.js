/* global L */

// -----------------------------
// Config / Globals
// -----------------------------
const OWM_KEY = window.OWM_KEY;          // from config.js
const ORS_KEY = window.ORS_KEY || null;  // optional fallback
const STATE = {
  map: null,
  layerStops: null,
  layerRoute: null,
  meMarker: null,
  homeMarker: null,
  selectedStopMarker: null,
  me: null,        // {lat, lon}
  home: null,      // {lat, lon, label}
  lastSearchResults: [],
  lastHomeResults: [],
};

// Tunables
const STOPS_RADIUS_M = 800;           // default search radius
const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OSRM = "https://router.project-osrm.org";
const ORS = "https://api.openrouteservice.org/v2/directions/foot-walking";

// UI
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const elSearch = $("#search");
const elResults = $("#results");
const elHomeInput = $("#home-input");
const elHomeResults = $("#home-results");
const elHomePill = $("#home-pill");
const elHomeEdit = $("#home-edit");
const elStops = $("#stops");
const elStopsList = $("#stops-list");
const elStopsRadius = $("#stops-radius");
const elBtnMyLoc = $("#btn-my-location");
const elBtnBestHome = $("#btn-best-home");
const elSelection = $("#selection");
const elWeather = $("#weather");
const elAir = $("#air");
const elDirections = $("#directions");
const elDirSteps = $("#directions-steps");
const elErrors = $("#errors");

// -----------------------------
// Helpers
// -----------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function toFixed(n, d = 5) { return Number.parseFloat(n).toFixed(d); }

function haversine(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDlat = Math.sin(dLat / 2);
  const sinDlon = Math.sin(dLon / 2);
  const h = sinDlat * sinDlat + Math.cos(lat1) * Math.cos(lat2) * sinDlon * sinDlon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearing(from, to) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const φ1 = toRad(from.lat);
  const φ2 = toRad(to.lat);
  const λ1 = toRad(from.lon);
  const λ2 = toRad(to.lon);
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  let θ = toDeg(Math.atan2(y, x));
  return (θ + 360) % 360;
}

function angleDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function fmtDist(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function setError(msg) {
  elErrors.style.display = msg ? "block" : "none";
  elErrors.textContent = msg || "";
}

// -----------------------------
// Map init
// -----------------------------
function initMap() {
  STATE.map = L.map("map", { zoomControl: true }).setView([52.5, -1.9], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(STATE.map);

  STATE.layerStops = L.layerGroup().addTo(STATE.map);
  STATE.layerRoute = L.layerGroup().addTo(STATE.map);

  // Restore Home if set
  const savedHome = localStorage.getItem("freshstop.home");
  if (savedHome) {
    try {
      STATE.home = JSON.parse(savedHome);
      showHomePill(STATE.home.label);
      placeHomeMarker(STATE.home);
    } catch { /* ignore */ }
  }

  // Wire map click for “selection” card (optional UX nicety)
  STATE.map.on("click", (e) => {
    const { lat, lng } = e.latlng;
    showSelection({ lat, lon: lng }, "Selected point");
  });
}

function placeHomeMarker(home) {
  if (STATE.homeMarker) STATE.map.removeLayer(STATE.homeMarker);
  STATE.homeMarker = L.marker([home.lat, home.lon], { title: "Home" })
    .addTo(STATE.map)
    .bindPopup("Home")
    .openPopup();
}

function placeMeMarker(me) {
  if (STATE.meMarker) STATE.map.removeLayer(STATE.meMarker);
  STATE.meMarker = L.circleMarker([me.lat, me.lon], {
    radius: 7, color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 0.9,
  }).addTo(STATE.map).bindPopup("You are here");
}

// -----------------------------
// Geocoding (Nominatim) with debounce
// -----------------------------
function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function geocode(q) {
  const url = `${NOMINATIM}?format=jsonv2&q=${encodeURIComponent(q)}&addressdetails=0&limit=5&countrycodes=gb`;
  const res = await fetch(url, { headers: { "Accept-Language": "en-GB" } });
  if (!res.ok) throw new Error("Geocoding failed");
  const data = await res.json();
  return data.map((r) => ({
    label: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
  }));
}

function showDropdown(el, items, onPick) {
  el.innerHTML = "";
  if (!items.length) { el.style.display = "none"; return; }
  items.forEach((it) => {
    const btn = document.createElement("button");
    btn.textContent = it.label;
    btn.addEventListener("click", () => { el.style.display = "none"; onPick(it); });
    el.appendChild(btn);
  });
  el.style.display = "block";
}

const handleSearchInput = debounce(async (e) => {
  const q = e.target.value.trim();
  if (!q) { elResults.style.display = "none"; return; }
  try {
    STATE.lastSearchResults = await geocode(q);
    showDropdown(elResults, STATE.lastSearchResults, (pick) => {
      STATE.map.setView([pick.lat, pick.lon], 15);
      showSelection(pick, pick.label);
    });
  } catch (err) {
    setError(err.message);
  }
}, 300);

const handleHomeInput = debounce(async (e) => {
  const q = e.target.value.trim();
  if (!q) { elHomeResults.style.display = "none"; return; }
  try {
    STATE.lastHomeResults = await geocode(q);
    showDropdown(elHomeResults, STATE.lastHomeResults, (pick) => {
      STATE.home = { lat: pick.lat, lon: pick.lon, label: pick.label };
      localStorage.setItem("freshstop.home", JSON.stringify(STATE.home));
      showHomePill(pick.label);
      placeHomeMarker(STATE.home);
      elHomeInput.value = "";
    });
  } catch (err) {
    setError(err.message);
  }
}, 300);

function showHomePill(label) {
  elHomePill.textContent = `Home: ${label}`;
  elHomePill.style.display = "inline-block";
  elHomeEdit.style.display = "inline-block";
}

// -----------------------------
// Weather & Air (OpenWeatherMap)
// -----------------------------
async function getWeather(lat, lon) {
  if (!OWM_KEY) return null;
  const u = `https://api.openweathermap.org/data/2.5/onecall?lat=${lat}&lon=${lon}&units=metric&appid=${OWM_KEY}&exclude=minutely,daily,alerts`;
  const res = await fetch(u);
  if (!res.ok) throw new Error("Weather fetch failed");
  return res.json();
}

async function getAir(lat, lon) {
  if (!OWM_KEY) return null;
  const u = `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${OWM_KEY}`;
  const res = await fetch(u);
  if (!res.ok) throw new Error("Air quality fetch failed");
  return res.json();
}

function aqiLabel(aqi) {
  // OWM AQI: 1 Good, 2 Fair, 3 Moderate, 4 Poor, 5 Very Poor
  return ["", "Good", "Fair", "Moderate", "Poor", "Very Poor"][aqi] || "n/a";
}

function renderWeatherCard(whereLabel, wx, coords) {
  if (!wx) return "";
  const iconNow = wx.current.weather?.[0]?.icon;
  const descNow = wx.current.weather?.[0]?.description || "—";
  const tNow = Math.round(wx.current.temp);

  // Next 3 hours (from hourly)
  const hours = (wx.hourly || []).slice(1, 4).map(h => ({
    t: new Date(h.dt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    temp: Math.round(h.temp),
    icon: h.weather?.[0]?.icon,
  }));

  const hourHtml = hours.map(h => `
    <div class="wx-hour">
      <div class="t">${h.t}</div>
      <img alt="" src="https://openweathermap.org/img/wn/${h.icon || "01d"}@2x.png">
      <div>${h.temp}°</div>
    </div>
  `).join("");

  return `
    <div class="wx-card">
      <div class="wx-main">
        <img alt="" src="https://openweathermap.org/img/wn/${iconNow || "01d"}@2x.png" width="64" height="64">
        <div>
          <div class="pill">${whereLabel}</div>
          <div class="wx-temp">${tNow}°C</div>
          <div class="wx-desc">${descNow}</div>
          <div class="muted" style="margin-top:2px;">${toFixed(coords.lat, 4)}, ${toFixed(coords.lon, 4)}</div>
        </div>
      </div>
      <div class="wx-hours">${hourHtml}</div>
    </div>
  `;
}

function renderAirCard(whereLabel, air) {
  if (!air || !air.list || !air.list.length) return "";
  const a = air.list[0];
  const aqi = a.main.aqi;
  const klass = ["", "aqi-good", "aqi-fair", "aqi-moderate", "aqi-poor", "aqi-vpoor"][aqi] || "aqi-moderate";
  return `
    <div class="kv"><div><strong>${whereLabel}</strong> Air Quality</div><span class="aqi-badge ${klass}">${aqiLabel(aqi)}</span></div>
    <div class="bar" style="margin-top:8px;"><span style="width:${(aqi/5)*100}%"></span></div>
    <div class="muted" style="margin-top:6px;">PM2.5 ${a.components.pm2_5?.toFixed(1)} μg/m³ • PM10 ${a.components.pm10?.toFixed(1)} μg/m³ • NO₂ ${a.components.no2?.toFixed(0)} μg/m³</div>
  `;
}

async function showWeatherAndAir(me, stop) {
  try {
    elWeather.style.display = "block";
    elAir.style.display = "block";
    elWeather.innerHTML = `<div class="muted">Loading weather…</div>`;
    elAir.innerHTML = `<div class="muted">Loading air quality…</div>`;

    const [wxMe, wxStop, airMe, airStop] = await Promise.all([
      getWeather(me.lat, me.lon),
      getWeather(stop.lat, stop.lon),
      getAir(me.lat, me.lon),
      getAir(stop.lat, stop.lon),
    ]);

    elWeather.innerHTML = `
      ${renderWeatherCard("You", wxMe, me)}
      <div style="height:10px"></div>
      ${renderWeatherCard("Chosen stop", wxStop, stop)}
    `;

    elAir.innerHTML = `
      <div class="card" style="border:none;padding:0">
        ${renderAirCard("You", airMe)}
        <div style="height:10px"></div>
        ${renderAirCard("Chosen stop", airStop)}
      </div>
    `;
  } catch (err) {
    setError(err.message);
  }
}

// -----------------------------
// Stops (Overpass)
// -----------------------------
async function fetchNearbyStops(center, radiusM = STOPS_RADIUS_M) {
  // highway=bus_stop and public_transport=platform (bus) + railway=station (optional)
  const around = `${radiusM},${center.lat},${center.lon}`;
  const query = `
    [out:json][timeout:25];
    (
      node["highway"="bus_stop"](around:${around});
      node["public_transport"="platform"]["bus"="yes"](around:${around});
    );
    out body;
  `;
  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: query
  });
  if (!res.ok) throw new Error("Stops fetch failed");
  const data = await res.json();
  return (data.elements || []).map(n => ({
    id: n.id,
    lat: n.lat,
    lon: n.lon,
    name: n.tags?.name || n.tags?.ref || "Bus stop",
    tags: n.tags || {},
    dist: haversine(center, { lat: n.lat, lon: n.lon }),
  })).sort((a,b)=>a.dist-b.dist);
}

// Heuristic: prefer stops that are "on the way" to Home.
// If angle between (me -> stop) and (me -> home) is <= 75°, it’s roughly aligned towards home.
// Otherwise we still consider the nearest as fallback.
function pickBestStop(me, home, stops) {
  if (!stops.length) return null;
  const bh = bearing(me, home);
  const scored = stops.map(s => {
    const bs = bearing(me, { lat: s.lat, lon: s.lon });
    const ang = angleDiff(bh, bs);
    const alignScore = Math.max(0, 1 - (ang / 90)); // 0..1 (good if <=90°)
    // Composite: closeness + alignment (weight alignment a bit higher)
    const score = (0.4 * (1 / (1 + s.dist))) + (0.6 * alignScore);
    return { ...s, ang, score };
  }).sort((a,b)=>b.score - a.score);

  // Prefer strongly aligned within 75°; else first in list (best by score anyway)
  const bestAligned = scored.find(s => s.ang <= 75);
  return bestAligned || scored[0];
}

function renderStopsList(me, home, stops, best) {
  elStopsRadius.textContent = STOPS_RADIUS_M.toString();
  elStops.style.display = "block";
  elStopsList.innerHTML = "";
  stops.slice(0, 12).forEach((s) => {
    const row = document.createElement("div");
    row.className = "stop-item";
    row.innerHTML = `
      <div class="stop-left">
        <div class="stop-kind kind-bus">BUS</div>
        <div>
          <div class="stop-name">${s.name}</div>
          <div class="muted">${fmtDist(s.dist)} • bearing to stop ${Math.round(s.ang)}°</div>
        </div>
      </div>
      <div class="stop-wx">
        ${best?.id === s.id ? `<span class="pill">Best</span>` : ""}
        <button class="btn" data-stop-id="${s.id}">Route</button>
      </div>
    `;
    const btn = row.querySelector("button[data-stop-id]");
    btn.addEventListener("click", () => chooseStopAndRoute(me, s));
    elStopsList.appendChild(row);
  });
}

// -----------------------------
// Routing (OSRM with ORS fallback)
// -----------------------------
async function routeFoot(from, to) {
  // Try OSRM first
  try {
    const u = `${OSRM}/route/v1/foot/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(u);
    if (res.ok) {
      const data = await res.json();
      if (data.code === "Ok" && data.routes?.length) {
        const r = data.routes[0];
        return {
          geometry: r.geometry,
          distance: r.distance,
          duration: r.duration,
          steps: r.legs?.[0]?.steps?.map(s => s.maneuver.instruction || s.name || "Continue") || [],
        };
      }
    }
  } catch { /* fall through */ }

  // Fallback to ORS if key exists
  if (ORS_KEY) {
    const res = await fetc
