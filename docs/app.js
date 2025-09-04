// ======= Config & guards =======
const CONFIG = (window.FRESHSTOP_CONFIG || {});
const OWM_KEY = CONFIG.OWM_KEY; // OpenWeatherMap key (required)
const ORS_KEY = CONFIG.ORS_KEY; // OpenRouteService key (optional fallback for routing)

if (!OWM_KEY) {
  console.warn("Missing OWM_KEY. Create config.js with window.FRESHSTOP_CONFIG. See instructions below.");
}

// ======= Elements =======
const elSearch = document.getElementById("search");
const elResults = document.getElementById("results");
const elSelection = document.getElementById("selection");
const elWeather = document.getElementById("weather");
const elAir = document.getElementById("air");
const elErrors = document.getElementById("errors");
const elBtnMyLoc = document.getElementById("btn-my-location");
const elBtnRoute = document.getElementById("btn-route");
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
      // do not drop a marker for my location by default
    },
    () => {}
  );
}

// ======= UI helpers =======
function fmt(n) { return Intl.NumberFormat().format(n); }
function show(el) { el.style.display = ""; }
function hide(el) { el.style.display = "none"; }
function setText(el, html) { el.innerHTML = html; }

function km(meters) { return (meters / 1000).toFixed(2); }
function minutes(seconds) { return Math.round(seconds / 60); }

// ======= Selection workflow =======
async function setSelected([lat, lng], source = "") {
  selectedPoint = [lat, lng];

  // marker
  if (selectedMarker) selectedMarker.remove();
  selectedMarker = L.marker(selectedPoint).addTo(map);

  // centre lightly (avoid snapping zoom too much on mobile)
  map.panTo(selectedPoint);

  // clear old info
  hide(elErrors);
  setText(elWeather, "");
  setText(elAir, "");
  hide(elWeather);
  hide(elAir);
  hide(elRouteSummary);

  // show selection box
  const latTxt = lat.toFixed(5);
  const lngTxt = lng.toFixed(5);
  setText(elSelection, `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
      <div>
        <div style="font-weight:600; margin-bottom:4px;">Selected location</div>
        <div class="muted">${latTxt}, ${lngTxt}${source ? ` • <span title="How you picked this">${source}</span>` : ""}</div>
      </div>
      <button class="btn" id="btn-copy">Copy coords</button>
    </div>
  `);
  show(elSelection);

  // copy handler
  document.getElementById("btn-copy").onclick = () => {
    navigator.clipboard?.writeText(`${latTxt}, ${lngTxt}`);
  };

  // fetch weather + air
  try {
    if (!OWM_KEY) throw new Error("Missing OpenWeatherMap key.");
    const [wx, air] = await Promise.all([
      getJSON(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=metric&appid=${OWM_KEY}`),
      getJSON(`https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lng}&appid=${OWM_KEY}`)
    ]);

    // Weather card
    setText(elWeather, renderWeather(wx));
    show(elWeather);

    // Air quality card
    setText(elAir, renderAir(air));
    show(elAir);
  } catch (err) {
    setText(elErrors, `⚠️ ${err.message || "Couldn’t load weather/air quality."}`);
    show(elErrors);
  }
}

function renderWeather(wx) {
  const t = Math.round(wx?.main?.temp ?? 0);
  const feels = Math.round(wx?.main?.feels_like ?? 0);
  const desc = (wx?.weather?.[0]?.description || "").replace(/^\w/, c => c.toUpperCase());
  const wind = Math.round(wx?.wind?.speed ?? 0);
  const place = [wx?.name, wx?.sys?.country].filter(Boolean).join(", ");
  return `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
      <div>
        <div style="font-weight:600; margin-bottom:4px;">Weather ${place ? `<span class="pill" title="OpenWeatherMap">${place}</span>` : ""}</div>
        <div>${t}°C, ${desc}</div>
        <div class="muted">Feels like ${feels}°C • Wind ${wind} m/s</div>
      </div>
    </div>
  `;
}

function renderAir(air) {
  const c = air?.list?.[0]?.components || {};
  const pairs = Object.entries(c);
  if (!pairs.length) return `<div class="muted">No air quality data.</div>`;
  const grid = pairs.map(([k, v]) =>
    `<div class="kv"><span>${k.toUpperCase()}</span><span>${v}</span></div>`
  ).join("");
  return `
    <div style="font-weight:600; margin-bottom:6px;">Air quality (μg/m³)</div>
    <div class="grid2">${grid}</div>
    <div class="muted" style="margin-top:6px;">Source: OpenWeatherMap Air Pollution API</div>
  `;
}

// ======= Routing (OSRM first, ORS fallback) =======
elBtnRoute.onclick = async () => {
  hide(elErrors);
  hide(elRouteSummary);

  if (!myLocation) {
    // attempt to get it now if not set
    try {
      const pos = await getCurrentPosition();
      myLocation = [pos.coords.latitude, pos.coords.longitude];
    } catch {
      setText(elErrors, "⚠️ Couldn’t read your location. Click ‘Use my location’ first.");
      show(elErrors);
      return;
    }
  }
  if (!selectedPoint) {
    setText(elErrors, "⚠️ Pick a destination on the map (or via search) first.");
    show(elErrors);
    return;
  }

  try {
    const route = await routeOSRM(myLocation, selectedPoint);
    drawRoute(route);
  } catch (e1) {
    // optional fallback to ORS if key present
    if (ORS_KEY) {
      try {
        const route = await routeORS(myLocation, selectedPoint, ORS_KEY);
        drawRoute(route);
      } catch (e2) {
        setText(elErrors, `⚠️ Routing failed (OSRM & ORS).`);
        show(elErrors);
      }
    } else {
      setText(elErrors, `⚠️ Routing failed (OSRM). You can add an ORS key for fallback.`);
      show(elErrors);
    }
  }
};

elBtnMyLoc.onclick = async () => {
  hide(elErrors);
  try {
    const pos = await getCurrentPosition();
    myLocation = [pos.coords.latitude, pos.coords.longitude];
    map.setView(myLocation, 15);
    // drop a small circle to hint current position
    L.circle(myLocation, { radius: 8, color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 0.6 }).addTo(map);
  } catch {
    setText(elErrors, "⚠️ Couldn’t read your location (permission denied?).");
    show(elErrors);
  }
};

function drawRoute(route) {
  const { coords, distance, duration } = route;

  if (routeLine) routeLine.remove();
  routeLine = L.polyline(coords, { weight: 5 }).addTo(map);

  const bounds = L.latLngBounds(coords);
  map.fitBounds(bounds, { padding: [20, 20] });

  elRouteSummary.textContent = `Distance: ${km(distance)} km • Time: ${minutes(duration)} min`;
  show(elRouteSummary);
}

async function routeOSRM(from, to) {
  const url = `https://router.project-osrm.org/route/v1/foot/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
  const data = await getJSON(url);
  const r = data?.routes?.[0];
  if (!r) throw new Error("No OSRM route");
  const coords = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  return { coords, distance: r.distance, duration: r.duration };
}

async function routeORS(from, to, key) {
  const url = "https://api.openrouteservice.org/v2/directions/foot-walking/geojson";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": key, "Content-Type": "application/json" },
    body: JSON.stringify({ coordinates: [[from[1], from[0]], [to[1], to[0]]] })
  });
  if (!res.ok) throw new Error("ORS error");
  const data = await res.json();
  const feat = data?.features?.[0];
  const coords = feat?.geometry?.coordinates?.map(([lng, lat]) => [lat, lng]) || [];
  const sum = feat?.properties?.summary || {};
  if (!coords.length) throw new Error("No ORS route");
  return { coords, distance: sum.distance ?? 0, duration: sum.duration ?? 0 };
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
    // wire click handlers
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
  if (!elResults.contains(e.target) && e.target !== elSearch) {
    hide(elResults);
  }
});

// ======= Small fetch helpers =======
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
