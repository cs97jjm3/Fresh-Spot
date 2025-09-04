/* ===========================
   FreshStop - app.js (browser)
   ===========================

   WHAT'S INSIDE
   - Config defaults (non-secret). Your secrets stay in config.js on your side.
   - Leaflet map init + geolocation (with fallback to CONFIG.HOME)
   - Overpass bus stops finder (CORS-friendly)
   - “Best stop towards home” chooser + “alight near home” chooser
   - Walking routes via OSRM demo (CORS-friendly)
   - Weather via Open-Meteo (no key, CORS-friendly)
   - Arrivals via BODS through optional proxy (if CONFIG.PROXY_BASE set)

   DOM expectations:
   - <div id="map"></div>  // required
   - <div id="walkOutput"></div> // optional

   NOTES:
   - Live arrivals are OFF by default unless CONFIG.PROXY_BASE is set.
   - You can later switch weather back to Met Office by using your proxy (/weather).
*/

// ---- Non-secret defaults (can be overridden by config.js) ----
window.CONFIG = Object.assign({
  HOME: { // default: Leverington Common (approx)
    name: "Home",
    lat: 52.6755,
    lon: 0.1361
  },
  OVERPASS_URL: "https://overpass-api.de/api/interpreter",
  OSRM_URL: "https://router.project-osrm.org",
  PROXY_BASE: null, // e.g. "https://your-worker.workers.dev" to enable live arrivals
  SEARCH_RADIUS_M: 1200, // how far to search for bus stops around user
  MAX_STOPS: 50, // cap to reduce clutter
  WALK_SPEED_MPS: 1.3 // ~4.7km/h average walk speed
}, window.CONFIG || {});

// ---- Shortcuts / DOM helpers ----
const el = sel => document.querySelector(sel);
const fmtMins = mins => `${Math.round(mins)} min`;
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function bearingDeg(from, to) {
  const φ1 = toRad(from.lat), φ2 = toRad(to.lat);
  const λ1 = toRad(from.lon), λ2 = toRad(to.lon);
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  let brng = toDeg(Math.atan2(y, x));
  return (brng + 360) % 360;
}
function angleDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ---- Leaflet map ----
let map, userMarker, homeMarker, routeLayer, stopsLayer;

function initMap(center) {
  if (map) return;
  map = L.map('map').setView([center.lat, center.lon], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  homeMarker = L.marker([CONFIG.HOME.lat, CONFIG.HOME.lon], { title: 'Home' })
    .addTo(map).bindPopup('Home');

  stopsLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
}

// ---- Weather via Open-Meteo (no key) ----
async function getWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=temperature_2m,precipitation_probability,weathercode,wind_speed_10m&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo failed: ${r.status}`);
  const j = await r.json();

  const WMAP = {
    0:{label:"Clear",icon:"☀️"},1:{label:"Mainly clear",icon:"🌤️"},
    2:{label:"Partly cloudy",icon:"⛅"},3:{label:"Overcast",icon:"☁️"},
    45:{label:"Fog",icon:"🌫️"},48:{label:"Rime fog",icon:"🌫️"},
    51:{label:"Drizzle light",icon:"🌦️"},53:{label:"Drizzle",icon:"🌦️"},55:{label:"Drizzle heavy",icon:"🌧️"},
    61:{label:"Rain light",icon:"🌦️"},63:{label:"Rain",icon:"🌧️"},65:{label:"Rain heavy",icon:"🌧️"},
    66:{label:"Freezing rain light",icon:"❄️"},67:{label:"Freezing rain",icon:"❄️"},
    71:{label:"Snow light",icon:"🌨️"},73:{label:"Snow",icon:"🌨️"},75:{label:"Snow heavy",icon:"❄️"},
    77:{label:"Snow grains",icon:"🌨️"},
    80:{label:"Showers light",icon:"🌦️"},81:{label:"Showers",icon:"🌧️"},82:{label:"Showers heavy",icon:"🌧️"},
    85:{label:"Snow showers",icon:"🌨️"},86:{label:"Snow showers heavy",icon:"❄️"},
    95:{label:"Thunderstorm",icon:"⛈️"},96:{label:"Storm w/ hail",icon:"⛈️"},99:{label:"Severe storm",icon:"⛈️"}
  };

  const now = j.current_weather;
  const idxNow = j.hourly.time.indexOf(now.time);
  const next3 = [];
  for (let k=1; k<=3; k++){
    const i = idxNow + k;
    if (i < j.hourly.time.length) {
      const code = j.hourly.weathercode[i];
      next3.push({
        time: j.hourly.time[i],
        temp: j.hourly.temperature_2m[i],
        pop: j.hourly.precipitation_probability?.[i] ?? null,
        wind: j.hourly.wind_speed_10m?.[i] ?? null,
        ...(WMAP[code] || {label:"—",icon:"🌡️"})
      });
    }
  }
  const nowMeta = WMAP[now.weathercode] || {label:"—",icon:"🌡️"};
  return {
    now: { time: now.time, temp: now.temperature, wind: now.windspeed, ...nowMeta },
    next3
  };
}

async function renderWeather(el, lat, lon) {
  try {
    const w = await getWeather(lat, lon);
    el.innerHTML = `
      <div class="weather-now" style="display:flex;align-items:center;gap:.5rem">
        <span style="font-size:1.4rem">${w.now.icon}</span>
        <strong>${w.now.temp}°C</strong>
        <span>• ${w.now.label}</span>
      </div>
      <div class="weather-next" style="display:flex;gap:.75rem;margin-top:.25rem">
        ${w.next3.map(h=>`
          <div class="hour" style="font-size:.9rem">
            <div>${new Date(h.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
            <div>${h.icon} ${Math.round(h.temp)}°C${h.pop!=null?` • ${h.pop}%`:''}</div>
          </div>
        `).join('')}
      </div>
    `;
  } catch(e) {
    console.warn(e);
    el.textContent = "Weather unavailable.";
  }
}

// ---- Overpass: bus stops near (amenity=bus_stop; public_transport=platform/platform_edge) ----
async function fetchStopsAround(lat, lon, radiusM=CONFIG.SEARCH_RADIUS_M) {
  const [sLat, sLon] = [lat, lon];
  const query = `
    [out:json][timeout:25];
    (
      node(around:${radiusM},${sLat},${sLon})["highway"="bus_stop"];
      node(around:${radiusM},${sLat},${sLon})["public_transport"="platform"]["bus"="yes"];
    );
    out body ${Math.min(CONFIG.MAX_STOPS, 200)};
    `;
  const r = await fetch(CONFIG.OVERPASS_URL, {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},
    body: "data=" + encodeURIComponent(query)
  });
  if (!r.ok) throw new Error(`Overpass failed: ${r.status}`);
  const j = await r.json();
  return (j.elements || []).map(n => ({
    id: n.id,
    name: n.tags?.name || "Bus stop",
    lat: n.lat,
    lon: n.lon,
    ref: n.tags?.ref || n.tags?.naptan || n.tags?.naptan_code || null
  }));
}

// ---- Choose best boarding stop towards home + best alighting stop near home ----
function chooseStopsTowardsHome(origin, stops, home) {
  if (!stops.length) return null;

  // 1) Boarding stop: closest to origin BUT also roughly aligned towards home
  const homeBrng = bearingDeg(origin, home);
  const candidates = stops
    .map(s => ({
      stop: s,
      d: haversineMeters(origin, s),
      align: angleDiff(bearingDeg(s, home), homeBrng)
    }))
    .sort((a,b) => (a.d + a.align*3) - (b.d + b.align*3)); // weight distance + alignment

  const board = candidates[0].stop;

  // 2) Alighting stop: nearest to home
  const alight = stops
    .map(s => ({stop:s, d:haversineMeters(home, s)}))
    .sort((a,b)=>a.d-b.d)[0].stop;

  return { board, alight };
}

// ---- OSRM walking route + duration ----
async function getWalkRoute(from, to) {
  const url = `${CONFIG.OSRM_URL}/route/v1/foot/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=false`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OSRM failed: ${r.status}`);
  const j = await r.json();
  if (!j.routes?.length) throw new Error("No route");
  const route = j.routes[0];
  return {
    geojson: route.geometry,
    distance_m: route.distance,
    duration_s: route.duration
  };
}

// ---- BODS arrivals via optional proxy ----
async function bodsArrivalsViaProxy(bbox) {
  if (!CONFIG.PROXY_BASE) throw new Error("No proxy configured");
  const url = `${CONFIG.PROXY_BASE}/bods?bbox=${encodeURIComponent(bbox)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`BODS via proxy failed: ${r.status}`);
  return r.json();
}

async function safeArrivalsHTML(center) {
  if (!CONFIG.PROXY_BASE) {
    return `<em>Live arrivals require a proxy. Add <code>CONFIG.PROXY_BASE</code> to enable.</em>`;
  }
  try {
    const dLat = 0.005, dLon = 0.005;
    const bbox = `${center.lat - dLat},${center.lat + dLat},${center.lon - dLon},${center.lon + dLon}`;
    const data = await bodsArrivalsViaProxy(bbox);
    // Render a tiny summary (data format depends on your proxy’s pass-through)
    const items = Array.isArray(data?.results) ? data.results.slice(0,5) : [];
    if (!items.length) return `<em>No arrivals found.</em>`;
    return `
      <ul class="arrivals">
        ${items.map(x => `<li>${x.lineName || x.line || x.service || 'Bus'} → ${x.destination || '—'} • ${x.eta || x.expectedArrival || '—'}</li>`).join('')}
      </ul>
    `;
  } catch (e) {
    console.warn("Arrivals failed:", e);
    return `<em>Arrivals temporarily unavailable.</em>`;
  }
}

// ---- Popup builder for a stop ----
function popupTemplate(stop) {
  return `
    <div class="popup">
      <div><strong>${stop.name}</strong>${stop.ref ? ` <small>(${stop.ref})</small>`:''}</div>
      <div class="weather" data-weather-for="${stop.lat},${stop.lon}">Loading weather…</div>
      <div class="arrivals">Loading arrivals…</div>
    </div>
  `;
}

async function enhanceStopPopup(marker, stop) {
  const p = marker.getPopup();
  if (!p) return;
  const div = p.getElement();
  if (!div) return;

  // WEATHER
  const wEl = div.querySelector('.weather');
  if (wEl) {
    await renderWeather(wEl, stop.lat, stop.lon);
  }

  // ARRIVALS (optional via proxy)
  const aEl = div.querySelector('.arrivals');
  if (aEl) {
    aEl.innerHTML = await safeArrivalsHTML({lat: stop.lat, lon: stop.lon});
  }
}

// ---- Draw route and write summary ----
function clearRoute() {
  routeLayer.clearLayers();
}
function drawGeoJSON(geojson, style={}) {
  const layer = L.geoJSON(geojson, Object.assign({ weight: 5, opacity: 0.8 }, style));
  routeLayer.addLayer(layer);
  return layer;
}
function writeWalkSummary(originToStop, stopToHome, board, alight) {
  const box = el('#walkOutput');
  if (!box) return;
  const mins1 = originToStop ? fmtMins(originToStop.duration_s/60) : '—';
  const mins2 = stopToHome ? fmtMins(stopToHome.duration_s/60) : '—';
  box.innerHTML = `
    <div class="walk-summary">
      <div><strong>Board at:</strong> ${board?.name || '—'}</div>
      <div><strong>Alight at:</strong> ${alight?.name || '—'}</div>
      <div>Walk to stop: ${mins1}</div>
      <div>Walk home after bus: ${mins2}</div>
      <small>Note: bus travel time not included (live arrivals require proxy).</small>
    </div>
  `;
}

// ---- Main flow ----
async function main() {
  const defaultCenter = { lat: CONFIG.HOME.lat, lon: CONFIG.HOME.lon };
  initMap(defaultCenter);

  // Try to get device location
  let here = null;
  try {
    here = await new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("No geolocation"));
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        err => reject(err),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
      );
    });
  } catch {
    here = defaultCenter;
  }

  // Show user marker and recenter
  if (!userMarker) {
    userMarker = L.marker([here.lat, here.lon], { title: 'You' })
      .addTo(map).bindPopup('You are here');
  } else {
    userMarker.setLatLng([here.lat, here.lon]);
  }
  map.setView([here.lat, here.lon], 15);

  // Fetch stops and plot
  let stops = [];
  try {
    stops = await fetchStopsAround(here.lat, here.lon);
  } catch (e) {
    console.error(e);
  }
  stopsLayer.clearLayers();
  const markers = stops.map(s => {
    const m = L.marker([s.lat, s.lon], { title: s.name })
      .addTo(stopsLayer)
      .bindPopup(popupTemplate(s));
    m.on('popupopen', () => enhanceStopPopup(m, s));
    return { stop: s, marker: m };
  });

  // Choose best pair (board towards home, alight nearest home)
  const pair = chooseStopsTowardsHome(here, stops, CONFIG.HOME);
  if (!pair) {
    writeWalkSummary(null, null, null, null);
    return;
  }
  const { board, alight } = pair;

  // Highlight chosen stops
  const boardM = markers.find(x => x.stop.id === board.id)?.marker;
  const alightM = markers.find(x => x.stop.id === alight.id)?.marker;
  if (boardM) boardM.setIcon(L.icon({
    iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    iconAnchor: [12,41], popupAnchor: [1,-34],
    className: 'board-stop'
  })).bindPopup(popupTemplate(board));
  if (alightM) alightM.bindPopup(popupTemplate(alight));

  // Walking routes: you -> board, alight -> home
  clearRoute();
  let walk1=null, walk2=null;
  try {
    walk1 = await getWalkRoute(here, board);
    drawGeoJSON(walk1.geojson, { color: '#2a9d8f' });
  } catch (e) {
    console.warn("Walk to stop failed:", e);
  }
  try {
    walk2 = await getWalkRoute(alight, CONFIG.HOME);
    drawGeoJSON(walk2.geojson, { color: '#e76f51' });
  } catch (e) {
    console.warn("Walk home after bus failed:", e);
  }

  writeWalkSummary(walk1, walk2, board, alight);

  // Auto open popup for boarding stop to show weather/arrivals
  if (boardM) boardM.openPopup();
}

// ---- Kickoff ----
document.addEventListener('DOMContentLoaded', main);
