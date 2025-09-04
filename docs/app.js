/* global L */

// =====================================================
// Config / Globals (read from config.js)
// =====================================================
const OWM_KEY        = window.OWM_KEY        || null;
const METOFFICE_KEY  = window.METOFFICE_KEY  || null;
const TFL_APP_KEY    = window.TFL_APP_KEY    || null;
const ORS_KEY        = window.ORS_KEY        || null;

const BODS_SIRI_VM_URL = window.BODS_SIRI_VM_URL || "";  // operator VM endpoint (XML)
const BODS_API_KEY     = window.BODS_API_KEY     || "";

// Tunables
const STOPS_RADIUS_M = 800;
const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";
const OSRM = "https://router.project-osrm.org";
const ORS  = "https://api.openrouteservice.org/v2/directions/foot-walking";
const LOCAL_NAPTAN_URL = "/data/naptan-stops.geojson";   // optional static file

const STATE = {
  map: null,
  layerStops: null,
  layerRoute: null,
  meMarker: null,
  homeMarker: null,
  selectedStopMarker: null,
  me: null,     // { lat, lon }
  home: null,   // { lat, lon, label, labelShort }
  lastSearchResults: [],
  lastHomeResults: [],
  localNaPTAN: null, // GeoJSON FeatureCollection | null
};

const $  = (s) => document.querySelector(s);
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

// =====================================================
// Utilities
// =====================================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function toFixed(n, d = 5) { return Number.parseFloat(n).toFixed(d); }
function fmtDist(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m/1000).toFixed(1)} km`; }

function setError(msg) {
  elErrors.style.display = msg ? "block" : "none";
  elErrors.textContent = msg || "";
}

function haversine(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const lat1 = rad(a.lat);
  const lat2 = rad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearing(from, to) {
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const φ1 = rad(from.lat), φ2 = rad(to.lat);
  const λ1 = rad(from.lon), λ2 = rad(to.lon);
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2 - λ1);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
function angleDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// =====================================================
// Inject CSS for pulsing “best stop” pin
// =====================================================
function injectPulseCSS() {
  const css = `
  @keyframes pulse-wave { 0%{transform:scale(0.6);opacity:.8} 70%{transform:scale(1.6);opacity:0} 100%{transform:scale(1.6);opacity:0} }
  .pulse-pin { position:relative;width:46px;height:46px;transform:translate(-50%,-100%) }
  .pulse-dot { position:absolute;left:50%;top:50%;width:16px;height:16px;margin-left:-8px;margin-top:-24px;background:#f43f5e;border-radius:50%;box-shadow:0 0 0 3px #fff,0 4px 14px rgba(0,0,0,.35) }
  .pulse-wave { position:absolute;left:50%;top:50%;width:18px;height:18px;margin-left:-9px;margin-top:-25px;border:2px solid #fda4af;border-radius:50%;animation:pulse-wave 1.8s ease-out infinite }
  .pulse-star { position:absolute;left:50%;top:50%;width:22px;height:22px;margin-left:-11px;margin-top:-38px;background:#f43f5e;color:#fff;font-weight:900;line-height:22px;text-align:center;border-radius:6px;transform:rotate(-8deg);box-shadow:0 2px 8px rgba(0,0,0,.35) }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

const NORMAL_STOP_ICON = L.icon({
  iconUrl:
    "data:image/svg+xml;utf8," +
    encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">
      <defs><filter id="s" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="1.5" stdDeviation="1.5" flood-color="rgba(0,0,0,.35)"/></filter></defs>
      <g filter="url(#s)"><path d="M14 39c6-9 12-14 12-23A12 12 0 1 0 2 16c0 9 6 14 12 23z" fill="#0ea5e9"/>
      <circle cx="14" cy="16" r="5.5" fill="#fff"/></g></svg>`),
  iconSize: [28, 40],
  iconAnchor: [14, 36],
  popupAnchor: [0, -30],
});
function createBestPulseIcon() {
  return L.divIcon({
    className: "",
    iconSize: [46, 46],
    iconAnchor: [23, 38],
    html: `<div class="pulse-pin"><div class="pulse-wave"></div><div class="pulse-dot"></div><div class="pulse-star">★</div></div>`,
  });
}

// =====================================================
// Map init
// =====================================================
function initMap() {
  injectPulseCSS();
  STATE.map = L.map("map", { zoomControl: true }).setView([52.5, -1.9], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
  }).addTo(STATE.map);

  STATE.layerStops = L.layerGroup().addTo(STATE.map);
  STATE.layerRoute = L.layerGroup().addTo(STATE.map);

  // Restore Home
  const saved = localStorage.getItem("freshstop.home");
  if (saved) {
    try {
      STATE.home = JSON.parse(saved);
      if (!STATE.home.labelShort) {
        reverseGeocode(STATE.home.lat, STATE.home.lon)
          .then(r => {
            STATE.home.labelShort = shortTownPostcode(r.address || {});
            localStorage.setItem("freshstop.home", JSON.stringify(STATE.home));
            showHomePill(STATE.home.labelShort);
          })
          .catch(() => showHomePill(STATE.home.label || "Home"));
      } else {
        showHomePill(STATE.home.labelShort);
      }
      placeHomeMarker(STATE.home);
    } catch { /* ignore */ }
  }

  STATE.map.on("click", (e) => {
    const { lat, lng } = e.latlng;
    showSelection({ lat, lon: lng }, "Selected point");
  });
}

function placeHomeMarker(home) {
  if (STATE.homeMarker) STATE.map.removeLayer(STATE.homeMarker);
  STATE.homeMarker = L.marker([home.lat, home.lon], { title: "Home" }).addTo(STATE.map).bindPopup("Home");
}
function placeMeMarker(me) {
  if (STATE.meMarker) STATE.map.removeLayer(STATE.meMarker);
  STATE.meMarker = L.circleMarker([me.lat, me.lon], {
    radius: 7, color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 0.9,
  }).addTo(STATE.map).bindPopup("You are here");
}

// =====================================================
// Geocoding / Reverse geocoding (Nominatim)
// =====================================================
function debounce(fn, ms=250){ let t; return (...a)=>{clearTimeout(t); t=setTimeout(()=>fn(...a),ms);} }

async function geocode(q) {
  const url = `${NOMINATIM}?format=jsonv2&q=${encodeURIComponent(q)}&addressdetails=0&limit=5&countrycodes=gb`;
  const res = await fetch(url, { headers: { "Accept-Language": "en-GB" } });
  if (!res.ok) throw new Error("Geocoding failed");
  const data = await res.json();
  return data.map(r => ({ label: r.display_name, lat: +r.lat, lon: +r.lon }));
}
async function reverseGeocode(lat, lon) {
  const url = `${NOMINATIM_REVERSE}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`;
  const res = await fetch(url, { headers: { "Accept-Language": "en-GB" } });
  if (!res.ok) throw new Error("Reverse geocode failed");
  return res.json();
}
function shortTownPostcode(addr) {
  const town = addr.town || addr.city || addr.village || addr.hamlet || addr.suburb || addr.county || "Home";
  const pc = addr.postcode || "";
  return pc ? `${town}, ${pc}` : town;
}

function showDropdown(el, items, onPick) {
  el.innerHTML = "";
  if (!items.length) { el.style.display = "none"; return; }
  items.forEach((it) => {
    const b = document.createElement("button");
    b.textContent = it.label;
    b.addEventListener("click", () => { el.style.display = "none"; onPick(it);});
    el.appendChild(b);
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
  } catch (err) { setError(err.message); }
}, 300);

const handleHomeInput = debounce(async (e) => {
  const q = e.target.value.trim();
  if (!q) { elHomeResults.style.display = "none"; return; }
  try {
    STATE.lastHomeResults = await geocode(q);
    showDropdown(elHomeResults, STATE.lastHomeResults, async (pick) => {
      try {
        const rev = await reverseGeocode(pick.lat, pick.lon);
        const labelShort = shortTownPostcode(rev.address || {});
        STATE.home = { lat: pick.lat, lon: pick.lon, label: pick.label, labelShort };
      } catch {
        STATE.home = { lat: pick.lat, lon: pick.lon, label: pick.label, labelShort: pick.label };
      }
      localStorage.setItem("freshstop.home", JSON.stringify(STATE.home));
      showHomePill(STATE.home.labelShort);
      placeHomeMarker(STATE.home);
      elHomeInput.value = "";
    });
  } catch (err) { setError(err.message); }
}, 300);

function showHomePill(text) {
  elHomePill.textContent = `Home: ${text}`;
  elHomePill.style.display = "inline-block";
  elHomeEdit.style.display = "inline-block";
}

// =====================================================
// Weather providers (OWM → Met Office → Open-Meteo)
// =====================================================

// ---- OpenWeather One Call (native) ----
async function getWeatherOWM(lat, lon) {
  if (!OWM_KEY) throw new Error("OWM key missing");
  const u = `https://api.openweathermap.org/data/2.5/onecall?lat=${lat}&lon=${lon}&units=metric&appid=${OWM_KEY}&exclude=minutely,daily,alerts`;
  const res = await fetch(u);
  if (!res.ok) throw new Error("OWM failed");
  return res.json();
}

// ---- Met Office DataHub Site-specific (GeoJSON) → adapt ----
// NOTE: Requires account/key and choosing the site-specific product (OGC API Features).
// We sample temperature and weather code from nearest time step.
async function getWeatherMetOffice(lat, lon) {
  if (!METOFFICE_KEY) throw new Error("Met Office key missing");
  // Site-specific “/collections/{collectionId}/items?coords=POINT(lon lat)&time=now” pattern varies by product
  // Example using "site-specific" collection id "forecast" (you will need to confirm product/collection):
  const base = "https://datahub.metoffice.gov.uk/1.0.0/collections/forecast/observations"; // adjust if needed
  const url = `${base}?coords=POINT(${lon}%20${lat})&limit=1`;
  const res = await fetch(url, { headers: { apikey: METOFFICE_KEY } });
  if (!res.ok) throw new Error("Met Office failed");
  const data = await res.json();

  // Build a minimal OneCall-like shape
  const temp = data?.features?.[0]?.properties?.air_temperature ?? null;
  const now = Math.floor(Date.now()/1000);
  return {
    current: {
      dt: now,
      temp: temp ?? 0,
      weather: [{ id: 0, description: "", icon: "03d" }],
    },
    hourly: [], // we keep it minimal; you can extend with additional properties once subscribed
  };
}

// ---- Open-Meteo (no key) → adapt to OneCall-like ----
function wmCodeToOwmIcon(code, isDay = true) {
  const d = isDay ? "d" : "n";
  if (code === 0) return `01${d}`;
  if (code === 1) return `02${d}`;
  if (code === 2) return `03${d}`;
  if (code === 3) return `04${d}`;
  if ([45,48].includes(code)) return `50${d}`;
  if ([51,53,55,56,57].includes(code)) return `09${d}`;
  if ([61,63,65].includes(code)) return `10${d}`;
  if ([66,67].includes(code)) return `13${d}`;
  if ([71,73,75,77].includes(code)) return `13${d}`;
  if ([80,81,82].includes(code)) return `09${d}`;
  if ([95,96,99].includes(code)) return `11${d}`;
  return `03${d}`;
}
async function getWeatherOpenMeteo(lat, lon) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day&hourly=temperature_2m,weather_code&timezone=auto`;
  const res = await fetch(u);
  if (!res.ok) throw new Error("Open-Meteo failed");
  const data = await res.json();
  const now = Date.now();
  const current = {
    dt: Math.floor(now/1000),
    temp: data.current?.temperature_2m ?? 0,
    weather: [{
      id: data.current?.weather_code ?? 0,
      main: "Weather",
      description: "",
      icon: wmCodeToOwmIcon(data.current?.weather_code ?? 0, (data.current?.is_day ?? 1) === 1),
    }],
  };
  const hourly = [];
  const times = data.hourly?.time || [];
  const temps = data.hourly?.temperature_2m || [];
  const codes = data.hourly?.weather_code || [];
  for (let i=0; i<times.length; i++) {
    const ts = new Date(times[i]).getTime()/1000;
    hourly.push({
      dt: ts,
      temp: temps[i],
      weather: [{ id: codes[i], description: "", icon: wmCodeToOwmIcon(codes[i], true) }],
    });
  }
  return { current, hourly };
}

// Composite weather fetch
async function getWeatherAny(lat, lon) {
  // Try OWM -> Met Office -> Open-Meteo
  try { return await getWeatherOWM(lat, lon); } catch {}
  try { return await getWeatherMetOffice(lat, lon); } catch {}
  return await getWeatherOpenMeteo(lat, lon);
}

// =====================================================
// Air Quality providers (OWM → Open-Meteo AQ)
// =====================================================
async function getAirOWM(lat, lon) {
  if (!OWM_KEY) throw new Error("OWM key missing");
  const u = `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${OWM_KEY}`;
  const res = await fetch(u);
  if (!res.ok) throw new Error("OWM AQ failed");
  return res.json(); // { list: [ { main: { aqi }, components: { pm2_5, pm10, no2, ... } } ] }
}

// Open-Meteo Air Quality (CAMS) – no key, adapt to similar shape
async function getAirOpenMeteo(lat, lon) {
  const u = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=pm2_5,pm10,nitrogen_dioxide&current=pm2_5,pm10,nitrogen_dioxide&timezone=auto`;
  const res = await fetch(u);
  if (!res.ok) throw new Error("Open-Meteo AQ failed");
  const data = await res.json();
  // Simple “aqi” proxy: map PM2.5 concentration to a 1..5 scale (approx.)
  const pm25 = data.current?.pm2_5 ?? null;
  const pm10 = data.current?.pm10 ?? null;
  const no2  = data.current?.nitrogen_dioxide ?? null;
  let aqi = 3;
  if (pm25 != null) {
    if (pm25 <= 12) aqi = 1;
    else if (pm25 <= 20) aqi = 2;
    else if (pm25 <= 35) aqi = 3;
    else if (pm25 <= 55) aqi = 4;
    else aqi = 5;
  }
  return {
    list: [{
      main: { aqi },
      components: { pm2_5: pm25 ?? 0, pm10: pm10 ?? 0, no2: no2 ?? 0 }
    }]
  };
}

async function getAirAny(lat, lon) {
  try { return await getAirOWM(lat, lon); } catch {}
  return await getAirOpenMeteo(lat, lon);
}

function aqiLabel(aqi) { return ["", "Good", "Fair", "Moderate", "Poor", "Very Poor"][aqi] || "n/a"; }

function renderWeatherCard(whereLabel, wx, coords) {
  if (!wx) return "";
  const iconNow = wx.current?.weather?.[0]?.icon || "01d";
  const descNow = wx.current?.weather?.[0]?.description || "";
  const tNow = Math.round(wx.current?.temp ?? 0);
  const hours = (wx.hourly || []).slice(1, 4).map(h => ({
    t: new Date(h.dt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    temp: Math.round(h.temp ?? 0),
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
          <div class="muted" style="margin-top:2px;">${toFixed(coords.lat,4)}, ${toFixed(coords.lon,4)}</div>
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

    const [wxMe, wxStop] = await Promise.all([
      getWeatherAny(me.lat, me.lon),
      getWeatherAny(stop.lat, stop.lon),
    ]);

    let airMe=null, airStop=null;
    try { airMe  = await getAirAny(me.lat, me.lon); } catch {}
    try { airStop = await getAirAny(stop.lat, stop.lon);} catch {}

    if (!wxMe && !wxStop) {
      elWeather.innerHTML = `<div class="muted">No weather data available right now.</div>`;
    } else {
      elWeather.innerHTML = `
        ${renderWeatherCard("You", wxMe, me)}
        <div style="height:10px"></div>
        ${renderWeatherCard("Chosen stop", wxStop, stop)}
      `;
    }

    if (!airMe && !airStop) {
      elAir.innerHTML = `<div class="muted">No air quality data available right now.</div>`;
    } else {
      elAir.innerHTML = `
        <div class="card" style="border:none;padding:0">
          ${renderAirCard("You", airMe)}
          <div style="height:10px"></div>
          ${renderAirCard("Chosen stop", airStop)}
        </div>
      `;
    }
  } catch (err) { setError(err.message); }
}

// =====================================================
// Stops: NaPTAN static → Overpass
// =====================================================
async function tryLoadLocalNaPTAN() {
  try {
    const res = await fetch(LOCAL_NAPTAN_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("no local NaPTAN");
    const gj = await res.json();
    if (gj && gj.type === "FeatureCollection") {
      STATE.localNaPTAN = gj;
    }
  } catch { STATE.localNaPTAN = null; }
}

function stopsFromNaPTANWithin(center, radiusM) {
  if (!STATE.localNaPTAN) return [];
  const out = [];
  for (const f of STATE.localNaPTAN.features) {
    if (!f.geometry || f.geometry.type !== "Point") continue;
    const [lon, lat] = f.geometry.coordinates;
    const dist = haversine(center, { lat, lon });
    if (dist <= radiusM) {
      const props = f.properties || {};
      out.push({
        id: props.AtcoCode || props.NaptanCode || `${lat},${lon}`,
        lat, lon,
        name: props.CommonName || props.Indicator || "Bus stop",
        tags: {
          operator: props.StopType || "",
          ref: props.AtcoCode || "",
          naptan: props.NaptanCode || "",
          shelter: props.ShelterIndicator ? "yes" : "",
        },
        dist,
      });
    }
  }
  out.sort((a,b)=>a.dist-b.dist);
  return out;
}

async function fetchNearbyStopsOverpass(center, radiusM = STOPS_RADIUS_M) {
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

async function fetchNearbyStops(center, radiusM=STOPS_RADIUS_M) {
  // Prefer local NaPTAN static if present
  const naptan = stopsFromNaPTANWithin(center, radiusM);
  if (naptan.length) return naptan;
  // Fallback to Overpass
  return await fetchNearbyStopsOverpass(center, radiusM);
}

// Choose stop aligned “towards home”
function pickBestStop(me, home, stops) {
  if (!stops.length) return null;
  const bh = bearing(me, home);
  const scored = stops.map(s=>{
    const bs = bearing(me, { lat:s.lat, lon:s.lon });
    const ang = angleDiff(bh, bs);
    const alignScore = Math.max(0, 1 - (ang / 90)); // <=90° good
    const score = (0.4 * (1 / (1 + s.dist))) + (0.6 * alignScore);
    return { ...s, ang, score };
  }).sort((a,b)=>b.score-a.score);
  return scored.find(s=>s.ang<=75) || scored[0];
}

// =====================================================
// Live arrivals: TfL → BODS (SIRI-VM XML) – optional
// =====================================================
function isLikelyLondonATCO(stop) {
  // London Buses ATCOCode typically starts with "490"
  const ref = stop.tags?.ref || stop.tags?.AtcoCode || stop.id?.toString() || "";
  return /^490/.test(ref);
}

async function getTflArrivals(stop) {
  const atco = stop.tags?.ref || stop.tags?.AtcoCode || stop.tags?.NaptanCode || null;
  if (!atco) throw new Error("No ATCO code for TfL request");
  let url = `https://api.tfl.gov.uk/StopPoint/${encodeURIComponent(atco)}/Arrivals`;
  if (TFL_APP_KEY) {
    const sep = url.includes("?") ? "&" : "?";
    url += `${sep}app_key=${encodeURIComponent(TFL_APP_KEY)}`;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error("TfL arrivals failed");
  const arr = await res.json();
  // Simplify: next three arrivals by line & destination, soonest first
  arr.sort((a,b)=> (a.timeToStation||0)-(b.timeToStation||0));
  return arr.slice(0,3).map(a=>({
    line: a.lineName,
    dest: a.destinationName,
    eta_min: Math.max(0, Math.round((a.timeToStation || 0)/60)),
  }));
}

// Very generic SIRI-VM parser (XML) for BODS operator feeds
async function getBodsArrivals(stop) {
  if (!BODS_SIRI_VM_URL) throw new Error("No BODS SIRI-VM URL configured");
  // Many operators expose all vehicles; we filter for vehicles whose MonitoredCall StopPointRef matches this stop’s ATCO/Naptan
  const atco = stop.tags?.ref || stop.tags?.AtcoCode || stop.tags?.NaptanCode || null;
  if (!atco) throw new Error("No ATCO code for BODS");
  let url = BODS_SIRI_VM_URL;
  if (BODS_API_KEY && !url.includes("api_key=")) {
    const sep = url.includes("?") ? "&" : "?";
    url += `${sep}api_key=${encodeURIComponent(BODS_API_KEY)}`;
  }
  const res = await fetch(url, {
    headers: BODS_API_KEY ? { "x-api-key": BODS_API_KEY } : {},
  });
  if (!res.ok) throw new Error("BODS VM failed");
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const calls = [...doc.getElementsByTagName("MonitoredCall")];
  const matches = calls
    .filter(c => (c.getElementsByTagName("StopPointRef")[0]?.textContent || "").includes(atco))
    .map(c => {
      const line = c.getElementsByTagName("LineRef")[0]?.textContent || "";
      const dest = c.getElementsByTagName("DestinationDisplay")[0]?.textContent || "";
      const aimed = c.getElementsByTagName("AimedDepartureTime")[0]?.textContent ||
                    c.getElementsByTagName("AimedArrivalTime")[0]?.textContent || "";
      let etaMin = null;
      if (aimed) {
        const t = new Date(aimed).getTime();
        etaMin = Math.max(0, Math.round((t - Date.now())/60000));
      }
      return { line, dest, eta_min: etaMin };
    })
    .filter(x => x.eta_min !== null)
    .sort((a,b)=>a.eta_min-b.eta_min)
    .slice(0,3);
  return matches;
}

async function getArrivals(stop) {
  // If London stop, prefer TfL
  if (isLikelyLondonATCO(stop)) {
    try { return await getTflArrivals(stop); } catch (e) { /* fall through */ }
  }
  // Otherwise try BODS SIRI-VM if configured
  if (BODS_SIRI_VM_URL) {
    try { return await getBodsArrivals(stop); } catch (e) { /* fall through */ }
  }
  return []; // none available
}

// =====================================================
// Routing (OSRM → ORS)
// =====================================================
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
  } catch { /* fall through */ }
  if (ORS_KEY) {
    const res = await fetch(ORS, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": ORS_KEY },
      body: JSON.stringify({ coordinates: [[from.lon, from.lat],[to.lon,to.lat]], instructions: true })
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
  STATE.map.fitBounds(L.latLngBounds([[from.lat, from.lon],[to.lat, to.lon]]));

  elDirections.style.display = "block";
  const mins = Math.round(route.duration/60);
  const dist = fmtDist(route.distance);
  const header = document.createElement("div");
  header.className = "muted";
  header.textContent = `~${mins} min • ${dist}`;
  elDirSteps.innerHTML = "";
  elDirSteps.appendChild(header);
  route.steps.forEach((t)=>{
    const p = document.createElement("div");
    p.className = "dir-step";
    p.textContent = t;
    elDirSteps.appendChild(p);
  });
}

// =====================================================
// UI: Stops & Selection
// =====================================================
function drawStopsOnMap(me, stops, best) {
  STATE.layerStops.clearLayers();
  stops.forEach((s)=>{
    const isBest = best && s.id === best.id;
    const marker = L.marker([s.lat, s.lon], { title: s.name, icon: isBest ? createBestPulseIcon() : NORMAL_STOP_ICON })
      .addTo(STATE.layerStops);
    const popupHtml = `
      <div style="min-width:200px">
        <div style="font-weight:700;margin-bottom:4px;">${isBest ? "⭐ Best stop to get home<br/>" : ""}${s.name}</div>
        <div class="muted" style="font-size:12px;margin-bottom:6px;">${fmtDist(s.dist)} away${typeof s.ang==="number" ? ` • ${Math.round(s.ang)}°` : ""}</div>
        <button data-stop-id="${s.id}" class="btn" style="padding:6px 8px;">Route here</button>
      </div>`;
    marker.bindPopup(popupHtml);
    marker.on("popupopen",(e)=>{
      const btn = e.popup.getElement().querySelector(`button[data-stop-id="${s.id}"]`);
      if (btn) btn.addEventListener("click", ()=> chooseStopAndRoute(STATE.me, s));
    });
    marker.on("click", ()=>{ marker.openPopup(); chooseStopAndRoute(STATE.me, s); });
  });
}

function renderStopsList(me, home, stops, best) {
  elStopsRadius.textContent = STOPS_RADIUS_M.toString();
  elStops.style.display = "block";
  elStopsList.innerHTML = "";
  stops.slice(0,12).forEach((s)=>{
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
        ${best?.id===s.id ? `<span class="pill">Best</span>` : ""}
        <button class="btn" data-stop-id="${s.id}">Route</button>
      </div>`;
    const btn = row.querySelector("button[data-stop-id]");
    btn.addEventListener("click", ()=> chooseStopAndRoute(me, s));
    elStopsList.appendChild(row);
  });
}

function transportInfoHtml(stop, arrivals) {
  const t = stop.tags || {};
  const operator = t.operator || t.network || "—";
  const code = t.ref || t.AtcoCode || t.local_ref || t.naptan || "—";
  const shelter = t.shelter ? "Shelter" : "—";
  const bench = t.bench ? "Bench" : "—";
  const lit = t.lit ? "Lit" : "—";
  const arrHtml = arrivals && arrivals.length ? `
    <div style="margin-top:8px">
      <div style="font-weight:600;margin-bottom:4px;">Next buses</div>
      ${arrivals.map(a=>`<div class="muted">${a.line} → ${a.dest} • ${a.eta_min} min</div>`).join("")}
    </div>` : `<div class="muted" style="margin-top:8px;">No live arrivals.</div>`;

  return `
    <div class="grid2" style="margin-top:6px;">
      <div><span class="muted">Operator:</span> ${operator}</div>
      <div><span class="muted">Stop code:</span> ${code}</div>
      <div><span class="muted">Amenities:</span> ${shelter}${bench !== "—" ? " • "+bench : ""}${lit !== "—" ? " • "+lit : ""}</div>
      <div><a class="muted" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.name)}%20@${stop.lat},${stop.lon}" target="_blank" rel="noopener">Open in Maps</a></div>
    </div>
    ${arrHtml}
  `;
}

function showSelection(point, label) {
  elSelection.style.display = "block";
  elSelection.innerHTML = `
    <div class="kv"><div><strong>${label}</strong></div>
    <div class="muted">${toFixed(point.lat,4)}, ${toFixed(point.lon,4)}</div></div>`;
}

async function chooseStopAndRoute(me, stop) {
  if (STATE.selectedStopMarker) STATE.map.removeLayer(STATE.selectedStopMarker);
  STATE.selectedStopMarker = L.marker([stop.lat, stop.lon], { title: stop.name, icon: createBestPulseIcon() })
    .addTo(STATE.map).bindPopup(stop.name);

  // Live arrivals (TfL/BODS)
  let arrivals = [];
  try { arrivals = await getArrivals(stop); } catch { arrivals = []; }

  elSelection.style.display = "block";
  elSelection.innerHTML = `
    <div class="kv">
      <div><strong>${stop.name}</strong></div>
      <div class="muted">${toFixed(stop.lat,4)}, ${toFixed(stop.lon,4)}</div>
    </div>
    ${transportInfoHtml(stop, arrivals)}
  `;

  showWeatherAndAir(me, stop).catch(e=>setError(e.message));

  try {
    const r = await routeFoot(me, { lat:stop.lat, lon:stop.lon });
    showRoute(r, me, { lat:stop.lat, lon:stop.lon });
  } catch (err) { setError(err.message); }
}

async function computeBestStopToHome() {
  setError("");
  if (!STATE.home) { setError("Please set your Home first."); return; }
  if (!STATE.me) {
    await locateMe();
    if (!STATE.me) { setError("Couldn’t get your location."); return; }
  }
  // Try load local NaPTAN once
  if (STATE.localNaPTAN === null) await tryLoadLocalNaPTAN();

  let stops = [];
  try { stops = await fetchNearbyStops(STATE.me, STOPS_RADIUS_M); }
  catch (err) { setError(err.message); return; }

  if (!stops.length) { setError("No stops found nearby."); return; }

  const best = pickBestStop(STATE.me, STATE.home, stops);
  drawStopsOnMap(STATE.me, stops, best);
  renderStopsList(STATE.me, STATE.home, stops, best);
  await chooseStopAndRoute(STATE.me, best);
}

// =====================================================
// Geolocation & Wiring
// =====================================================
async function locateMe() {
  return new Promise((resolve)=>{
    if (!navigator.geolocation) { setError("Geolocation not supported."); resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos)=>{
        const { latitude, longitude } = pos.coords;
        STATE.me = { lat: latitude, lon: longitude };
        placeMeMarker(STATE.me);
        const z = STATE.map.getZoom();
        STATE.map.setView([latitude, longitude], Math.max(z, 15));
        resolve(STATE.me);
      },
      (err)=>{ setError(err.message || "Couldn’t get location."); resolve(null); },
      { enableHighAccuracy:true, timeout:10000, maximumAge:30000 }
    );
  });
}

function wireUI() {
  elSearch.addEventListener("input", handleSearchInput);
  elHomeInput.addEventListener("input", handleHomeInput);
  elHomeEdit.addEventListener("click", ()=> elHomeInput.focus());
  elBtnMyLoc.addEventListener("click", locateMe);
  elBtnBestHome.addEventListener("click", computeBestStopToHome);
  const elClear = $("#btn-clear-route");
  if (elClear) elClear.addEventListener("click", clearRoute);
}

// Boot
(async function boot() {
  initMap();
  wireUI();
  try { await locateMe(); } catch {}
})();
