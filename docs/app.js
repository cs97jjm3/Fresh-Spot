// ======= Config & guards =======
const CONFIG = (window.FRESHSTOP_CONFIG || {});
const OWM_KEY = CONFIG.OWM_KEY; // OpenWeatherMap key (required)
const ORS_KEY = CONFIG.ORS_KEY; // OpenRouteService key (optional fallback for routing)

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
      // hint current position
      L.circle(myLocation, { radius: 6, color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 0.7 }).addTo(map);
    },
    () => {}
  );
}

// ======= UI helpers =======
function fmt(n) { return Intl.NumberFormat().format(n); }
function show(el) { el.style.display = ""; }
function hide(el) { el.style.display = "none"; }
function setHTML(el, html) { el.innerHTML = html; }
function km(meters) { return (meters / 1000).toFixed(2); }
function minutes(seconds) { return Math.round(seconds / 60); }
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

  // selection card
  const latTxt = lat.toFixed(5);
  const lngTxt = lng.toFixed(5);
  setHTML(elSelection, `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
      <div>
        <div style="font-weight:600; margin-bottom:4px;">Selected location</div>
        <div class="muted">${latTxt}, ${lngTxt}${source ? ` • <span title="How you picked this">${source}</span>` : ""}</div>
      </div>
      <button class="btn" id="btn-copy">Copy coords</button>
    </div>
  `);
  show(elSelection);
  document.getElementById("btn-copy").onclick = () => navigator.clipboard?.writeText(`${latTxt}, ${lngTxt}`);

  // load weather + air + stops (in parallel)
  try {
    await Promise.all([
      loadWeather(lat, lng),
      loadAir(lat, lng),
      loadStops(lat, lng, 800) // meters
    ]);
  } catch (err) {
    setHTML(elErrors, `⚠️ ${err.message || "Couldn’t load one of the panels."}`);
    show(elErrors);
  }
}

async function loadWeather(lat, lng) {
  if (!OWM_KEY) throw new Error("Missing OpenWeatherMap key.");
  const wx = await getJSON(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=metric&appid=${OWM_KEY}`);
  const t = Math.round(wx?.main?.temp ?? 0);
  const feels = Math.round(wx?.main?.feels_like ?? 0);
  const desc = (wx?.weather?.[0]?.description || "").replace(/^\w/, c => c.toUpperCase());
  const wind = Math.round(wx?.wind?.speed ?? 0);
  const place = [wx?.name, wx?.sys?.country].filter(Boolean).join(", ");
  setHTML(elWeather, `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
      <div>
        <div style="font-weight:600; margin-bottom:4px;">Weather ${place ? `<span class="pill">${place}</span>` : ""}</div>
        <div>${t}°C, ${desc}</div>
        <div class="muted">Feels like ${feels}°C • Wind ${wind} m/s</div>
      </div>
    </div>
  `);
  show(elWeather);
}

async function loadAir(lat, lng) {
  if (!OWM_KEY) throw new Error("Missing OpenWeatherMap key.");
  const air = await getJSON(`https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lng}&appid=${OWM_KEY}`);
  const c = air?.list?.[0]?.components || {};
  const pairs = Object.entries(c);
  const grid = pairs.length
    ? pairs.map(([k, v]) => `<div class="kv"><span>${k.toUpperCase()}</span><span>${v}</span></div>`).join("")
    : `<div class="muted">No air quality data.</div>`;
  setHTML(elAir, `
    <div style="font-weight:600; margin-bottom:6px;">Air quality (μg/m³)</div>
    <div class="grid2">${grid}</div>
    <div class="muted" style="margin-top:6px;">Source: OpenWeatherMap</div>
  `);
  show(elAir);
}

// ======= Stops (Overpass) =======
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
  const stops = (data.elements || [])
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
    .slice(0, 20);

  // render list
  if (!stops.length) {
    setHTML(elStopsList, `<div class="muted">No stops found within ${radiusMeters} m.</div>`);
  } else {
    setHTML(elStopsList, stops.map(s => `
      <div class="stop-item">
        <div>
          <div class="stop-name">${escapeHtml(s.name)}</div>
          <div class="muted" style="font-size:12px;">${s.kind === "bus" ? "Bus stop" : "Train/Tram"} • ${Math.round(s.dist)} m</div>
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          <span class="stop-kind ${s.kind === "bus" ? "kind-bus" : "kind-train"}">${s.kind}</span>
          <button class="btn" data-stop="${s.id}" title="Route from my location to this stop">Route</button>
        </div>
      </div>
    `).join(""));
  }

  // draw markers
  clearStops();
  for (const s of stops) {
    const color = s.kind === "bus" ? "#0ea5e9" : "#10b981";
    const m = L.circleMarker(s.pos, { radius: 6, color, fillColor: color, fillOpacity: 0.8 })
      .addTo(map)
      .bindTooltip(`${s.name} (${s.kind})`);
    stopLayers.push(m);
  }

  // wire route buttons
  [...elStopsList.querySelectorAll("button[data-stop]")].forEach(btn => {
    btn.onclick = async () => {
      if (!myLocation) {
        try {
          const pos = await getCurrentPosition();
          myLocation = [pos.coords.latitude, pos.coords.longitude];
          L.circle(myLocation, { radius: 6, color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 0.7 }).addTo(map);
        } catch {
          showError("Couldn’t read your location. Click ‘Use my location’ first.");
          return;
        }
      }
      const id = btn.getAttribute("data-stop");
      const s = stops.find(x => x.id.toString() === id);
      if (!s) return;
      routeBetween(myLocation, s.pos);
    };
  });

  show(elStops);
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

  if (!myLocation) {
    try {
      const pos = await getCurrentPosition();
      myLocation = [pos.coords.latitude, pos.coords.longitude];
      L.circle(myLocation, { radius: 6, color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 0.7 }).addTo(map);
    } catch {
      showError("Couldn’t read your location. Click ‘Use my location’ first.");
      return;
    }
  }
  if (!selectedPoint) {
    showError("Pick a destination on the map (or via search) first.");
    return;
  }

  routeBetween(myLocation, selectedPoint);
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

elBtnClearRoute.onclick = () => {
  clearRoute();
  hide(elDirections);
  hide(elRouteSummary);
};

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

  // directions panel
  if (steps && steps.length) {
    setHTML(elDirSteps, steps.map((s, i) => `<div class="dir-step">${i+1}. ${escapeHtml(s)}</div>`).join(""));
    show(elDirections);
  } else {
    hide(elDirections);
  }
}

// Basic translations for OSRM step to text
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

// ORS step to text
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
    // wire clicks
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

function escapeHtml(s="") {
  return s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
}
