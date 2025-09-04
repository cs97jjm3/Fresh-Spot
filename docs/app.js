/* global L */

// =============================
// Config / Globals
// =============================
const OWM_KEY = window.OWM_KEY;          // from config.js (required for weather/air)
const ORS_KEY = window.ORS_KEY || null;  // optional (fallback router if OSRM is down)

const STATE = {
  map: null,
  layerStops: null,
  layerRoute: null,
  meMarker: null,
  homeMarker: null,
  selectedStopMarker: null, // current chosen stop marker
  me: null,                  // {lat, lon}
  home: null,                // {lat, lon, label}
  lastSearchResults: [],
  lastHomeResults: [],
};

// Tunables
const STOPS_RADIUS_M = 800;
const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OSRM = "https://router.project-osrm.org";
const ORS = "https://api.openrouteservice.org/v2/directions/foot-walking";

// =============================
// DOM shortcuts
// =============================
const $  = (sel) => document.querySelector(sel);
const elSearch      = $("#search");
const elResults     = $("#results");
const elHomeInput   = $("#home-input");
const elHomeResults = $("#home-results");
const elHomePill    = $("#home-pill");
const elHomeEdit    = $("#home-edit");
const elStops       = $("#stops");
const elStopsList   = $("#stops-list");
const elStopsRadius = $("#stops-radius");
const elBtnMyLoc    = $("#btn-my-location");
const elBtnBestHome = $("#btn-best-home");
const elSelection   = $("#selection");
const elWeather     = $("#weather");
const elAir         = $("#air");
const elDirections  = $("#directions");
const elDirSteps    = $("#directions-steps");
const elErrors      = $("#errors");

// =============================
// Utilities
// =============================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
function fmtDist(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`; }

function setError(msg) {
  elErrors.style.display = msg ? "block" : "none";
  elErrors.textContent = msg || "";
}

// =============================
// Inject minimal CSS for pulse
// =============================
function injectPulseCSS() {
  const css = `
  @keyframes pulse-wave {
    0%   { transform: scale(0.6); opacity: 0.8; }
    70%  { transform: scale(1.6); opacity: 0; }
    100% { transform: scale(1.6); opacity: 0; }
  }
  .pulse-pin {
    position: relative;
    width: 46px; height: 46px;
    transform: translate(-50%, -100%); /* anchor bottom-center */
  }
  .pulse-dot {
    position: absolute; left: 50%; top: 50%;
    width: 16px; height: 16px; margin-left: -8px; margin-top: -24px;
    background: #f43f5e; border-radius: 50%; box-shadow: 0 0 0 3px #fff, 0 4px 14px rgba(0,0,0,.35);
  }
  .pulse-wave {
    position: absolute; left: 50%; top: 50%;
    width: 18px; height: 18px; margin-left: -9px; margin-top: -25px;
    border: 2px solid #fda4af; border-radius: 50%;
    animation: pulse-wave 1.8s ease-out infinite;
  }
  .pulse-star {
    position: absolute; left: 50%; top: 50%;
    width: 22px; height: 22px; margin-left: -11px; margin-top: -38px;
    background: #f43f5e; color: #fff; font-weight: 900; line-height: 22px; text-align: center;
    border-radius: 6px; transform: rotate(-8deg);
    box-shadow: 0 2px 8px rgba(0,0,0,.35);
  }`;
  const style = document.createElement("style");
  style.setAttribute("data-freshstop", "pulse-css");
  style.textContent = css;
  document.head.appendChild(style);
}

// =============================
// Icons
// =============================
const NORMAL_STOP_ICON = L.icon({
  iconUrl:
    "data:image/svg+xml;utf8," +
    encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">
        <defs>
          <filter id="s" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="1.5" flood-color="rgba(0,0,0,.35)"/>
          </filter>
        </defs>
        <g filter="url(#s)">
          <path d="M14 39c6-9 12-14 12-23A12 12 0 1 0 2 16c0 9 6 14 12 23z" fill="#0ea5e9"/>
          <circle cx="14" cy="16" r="5.5" fill="#fff"/>
        </g>
      </svg>`),
  iconSize: [28, 40],
  iconAnchor: [14, 36],
  popupAnchor: [0, -30],
});

// Best stop pulsing DivIcon
function createBestPulseIcon(label = "Best") {
  return L.divIcon({
    className: "", // we use inline HTML
    iconSize: [46, 46],
    iconAnchor: [23, 38],
    html: `
      <div class="pulse-pin">
        <div class="pulse-wave"></div>
        <div class="pulse-dot"></div>
        <div class="pulse-star">★</div>
      </div>
    `,
  });
}

// =============================
// Map init
// =============================
function initMap() {
  injectPulseCSS();

  STATE.map = L.map("map", { zoomControl: true }).setView([52.5, -1.9], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(STATE.map);

  STATE.layerStops = L.layerGroup().addTo(STATE.map);
  STATE.layerRoute = L.layerGroup().addTo(STATE.map);

  // Restore Home
  const savedHome = localStorage.getItem("freshstop.home");
  if (savedHome) {
    try {
      STATE.home = JSON.parse(savedHome);
      showHomePill(STATE.home.label);
      placeHomeMarker(STATE.home);
    } catch {
      // ignore
    }
  }

  // Optional: click map shows selection
  STATE.map.on("click", (e) => {
    const { lat, lng } = e.latlng;
    showSelection({ lat, lon: lng }, "Selected point");
  });
}

function placeHomeMarker(home) {
  if (STATE.homeMarker) STATE.map.removeLayer(STATE.homeMarker);
  STATE.homeMarker = L.marker([home.lat, home.lon], { title: "Home" })
    .addTo(STATE.map)
    .bindPopup("Home");
}

function placeMeMarker(me) {
  if (STATE.meMarker) STATE.map.removeLayer(STATE.meMarker);
  STATE.meMarker = L.circleMarker([me.lat, me.lon], {
    radius: 7, color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 0.9,
  }).addTo(STATE.map).bindPopup("You are here");
}

// =============================
// Geocoding (Nominatim) + debounce
// =============================
function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`;
  const res = await fetch(url, { headers: { "Accept-Language": "en-GB" } });
  if (!res.ok) throw new Error("Reverse geocode failed");
  return res.json();
}

function shortTownPostcode(addr) {
  // Prefer town/city/village/hamlet + postcode
  const town = addr.town || addr.city || addr.village || addr.hamlet || addr.suburb || addr.county || "Home";
  const pc = addr.postcode || "";
  return pc ? `${town}, ${pc}` : town;
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

// =============================
// Weather & Air (OWM)
// =============================
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

function aqiLabel(aqi) { return ["", "Good", "Fair", "Moderate", "Poor", "Very Poor"][aqi] || "n/a"; }

function renderWeatherCard(whereLabel, wx, coords) {
  if (!wx) return "";
  const iconNow = wx.current.weather?.[0]?.icon || "01d";
  const descNow = wx.current.weather?.[0]?.description || "—";
  const tNow = Math.round(wx.current.temp);
  const hours = (wx.hourly || []).slice(1, 4).map(h => ({
    t: new Date(h.dt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    temp: Math.round(h.temp),
    icon: h.weather?.[0]?.icon || "01d",
  }));
  const hourHtml = hours.map(h => `
    <div class="wx-hour">
      <div class="t">${h.t}</div>
      <img alt="" src="https://openweathermap.org/img/wn/${h.icon}@2x.png">
      <div>${h.temp}°</div>
    </div>`).join("");
  return `
    <div class="wx-card">
      <div class="wx-main">
        <img alt="" src="https://openweathermap.org/img/wn/${iconNow}@2x.png" width="64" height="64">
        <div>
          <div class="pill">${whereLabel}</div>
          <div class="wx-temp">${tNow}°C</div>
          <div class="wx-desc">${descNow}</div>
          <div class="muted" style="margin-top:2px;">${toFixed(coords.lat, 4)}, ${toFixed(coords.lon, 4)}</div>
        </div>
      </div>
      <div class="wx-hours">${hourHtml}</div>
    </div>`;
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

// =============================
// Stops (Overpass)
// =============================
async function fetchNearbyStops(center, radiusM = STOPS_RADIUS_M) {
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

// Prefer stops roughly along the direction home
function pickBestStop(me, home, stops) {
  if (!stops.length) return null;
  const bh = bearing(me, home);
  const scored = stops.map(s => {
    const bs = bearing(me, { lat: s.lat, lon: s.lon });
    const ang = angleDiff(bh, bs);
    const alignScore = Math.max(0, 1 - (ang / 90)); // 0..1 good if <=90°
    const score = (0.4 * (1 / (1 + s.dist))) + (0.6 * alignScore);
    return { ...s, ang, score };
  }).sort((a,b)=>b.score - a.score);
  const bestAligned = scored.find(s => s.ang <= 75);
  return bestAligned || scored[0];
}

// =============================
// Map rendering for stops
// =============================
function drawStopsOnMap(me, stops, best) {
  STATE.layerStops.clearLayers();

  stops.forEach((s) => {
    const isBest = !!(best && s.id === best.id);

    // Use pulse icon for the best stop
    const icon = isBest ? createBestPulseIcon() : NORMAL_STOP_ICON;

    const marker = L.marker([s.lat, s.lon], {
      title: s.name,
      icon,
    }).addTo(STATE.layerStops);

    const popupHtml = `
      <div style="min-width:180px">
        <div style="font-weight:700; margin-bottom:4px;">
          ${isBest ? "⭐ Best stop to get home<br/>" : ""}${s.name}
        </div>
        <div class="muted" style="font-size:12px; margin-bottom:6px;">
          ${fmtDist(s.dist)} away${typeof s.ang === "number" ? ` • ${Math.round(s.ang)}°` : ""}
        </div>
        <button data-stop-id="${s.id}" class="btn" style="padding:6px 8px;">Route here</button>
      </div>
    `;

    marker.bindPopup(popupHtml);

    marker.on("popupopen", (e) => {
      const btn = e.popup.getElement().querySelector(`button[data-stop-id="${s.id}"]`);
      if (btn) btn.addEventListener("click", () => chooseStopAndRoute(me, s));
    });

    marker.on("click", () => {
      marker.openPopup();
      chooseStopAndRoute(me, s);
    });
  });
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
          <div class="muted">${fmtDist(s.dist)} • bearing to stop ${Math.round(s.ang ?? 0)}°</div>
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

// =============================
// Routing (OSRM, fallback ORS)
// =============================
async function routeFoot(from, to) {
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
  } catch {
    // fall through
  }

  if (ORS_KEY) {
    const res = await fetch(ORS, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": ORS_KEY },
      body: JSON.stringify({ coordinates: [[from.lon, from.lat], [to.lon, to.lat]], instructions: true })
    });
    if (res.ok) {
      const data = await res.json();
      const feat = data.features?.[0];
      if (feat) {
        const seg = feat.properties.segments?.[0];
        return {
          geometry: feat.geometry,
          distance: seg.distance,
          duration: seg.duration,
          steps: seg.steps?.map(s => s.instruction) || [],
        };
      }
    }
  }

  throw new Error("Routing failed");
}

function clearRoute() {
  elDirections.style.display = "none";
  elDirSteps.innerHTML = "";
  if (STATE.layerRoute) STATE.layerRoute.clearLayers();
}

function showRoute(route, from, to) {
  clearRoute();
  const coords = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  L.polyline(coords, { color: "#0ea5e9", weight: 5, opacity: 0.9 }).addTo(STATE.layerRoute);

  STATE.map.fitBounds(L.latLngBounds([[from.lat, from.lon], [to.lat, to.lon]]));

  elDirections.style.display = "block";
  const mins = Math.round(route.duration / 60);
  const dist = fmtDist(route.distance);
  const header = document.createElement("div");
  header.className = "muted";
  header.textContent = `~${mins} min • ${dist}`;
  elDirSteps.innerHTML = "";
  elDirSteps.appendChild(header);

  route.steps.forEach((t) => {
    const p = document.createElement("div");
    p.className = "dir-step";
    p.textContent = t;
    elDirSteps.appendChild(p);
  });
}

// =============================
// Selection & flow
// =============================
function showSelection(point, label) {
  elSelection.style.display = "block";
  elSelection.innerHTML = `
    <div class="kv">
      <div><strong>${label}</strong></div>
      <div class="muted">${toFixed(point.lat,4)}, ${toFixed(point.lon,4)}</div>
    </div>
  `;
}

function transportInfoHtml(stop) {
  const t = stop.tags || {};
  const operator = t.operator || t.network || "—";
  const code = t.ref || t.local_ref || t.naptan || "—";
  const shelter = t.shelter ? "Shelter" : "No shelter";
  const bench = t.bench ? "Bench" : "—";
  const lit = t.lit ? "Lit" : "—";

  return `
    <div class="grid2" style="margin-top:6px;">
      <div><span class="muted">Operator:</span> ${operator}</div>
      <div><span class="muted">Stop code:</span> ${code}</div>
      <div><span class="muted">Amenities:</span> ${shelter}${bench !== "—" ? " • " + bench : ""}${lit !== "—" ? " • " + lit : ""}</div>
      <div><a class="muted" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.name)}%20@${stop.lat},${stop.lon}" target="_blank" rel="noopener">Open in Maps</a></div>
    </div>
  `;
}

async function chooseStopAndRoute(me, stop) {
  // Replace any previous selected marker with a pulsing one
  if (STATE.selectedStopMarker) STATE.map.removeLayer(STATE.selectedStopMarker);
  STATE.selectedStopMarker = L.marker([stop.lat, stop.lon], {
    title: stop.name,
    icon: createBestPulseIcon(),
  }).addTo(STATE.map).bindPopup(stop.name);

  // Selection card
  elSelection.style.display = "block";
  elSelection.innerHTML = `
    <div class="kv">
      <div><strong>${stop.name}</strong></div>
      <div class="muted">${toFixed(stop.lat, 4)}, ${toFixed(stop.lon, 4)}</div>
    </div>
    ${transportInfoHtml(stop)}
  `;

  // Weather & Air
  showWeatherAndAir(me, stop).catch((e) => setError(e.message));

  // Route
  try {
    const r = await routeFoot(me, { lat: stop.lat, lon: stop.lon });
    showRoute(r, me, { lat: stop.lat, lon: stop.lon });
  } catch (err) {
    setError(err.message);
  }
}

async function computeBestStopToHome() {
  setError("");
  if (!STATE.home) { setError("Please set your Home first."); return; }
  if (!STATE.me) {
    await locateMe();
    if (!STATE.me) { setError("Couldn’t get your location."); return; }
  }

  let stops = [];
  try {
    stops = await fetchNearbyStops(STATE.me, STOPS_RADIUS_M);
  } catch (err) {
    setError(err.message);
    return;
  }
  if (!stops.length) { setError("No stops found nearby."); return; }

  const best = pickBestStop(STATE.me, STATE.home, stops);

  // Draw on map, render list, auto-pick best
  drawStopsOnMap(STATE.me, stops, best);
  renderStopsList(STATE.me, STATE.home, stops, best);
  await chooseStopAndRoute(STATE.me, best);
}

// =============================
// Geolocation
// =============================
async function locateMe() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      setError("Geolocation not supported.");
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        STATE.me = { lat: latitude, lon: longitude };
        placeMeMarker(STATE.me);
        const z = STATE.map.getZoom();
        STATE.map.setView([latitude, longitude], Math.max(z, 15));
        resolve(STATE.me);
      },
      (err) => {
        setError(err.message || "Couldn’t get location.");
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });
}

// =============================
// Wire UI
// =============================
function wireUI() {
  elSearch.addEventListener("input", handleSearchInput);
  elHomeInput.addEventListener("input", handleHomeInput);
  elHomeEdit.addEventListener("click", () => elHomeInput.focus());
  elBtnMyLoc.addEventListener("click", locateMe);
  elBtnBestHome.addEventListener("click", computeBestStopToHome);

  const elClear = $("#btn-clear-route");
  if (elClear) elClear.addEventListener("click", clearRoute);
}

// =============================
// Boot
// =============================
(async function boot() {
  initMap();
  wireUI();
  try { await locateMe(); } catch { /* ignore */ }
})();
