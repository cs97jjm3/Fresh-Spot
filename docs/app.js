// ======= Config & guards =======
const CONFIG = (window.FRESHSTOP_CONFIG || {});
const OWM_KEY = CONFIG.OWM_KEY;
const ORS_KEY = CONFIG.ORS_KEY;
const TP_APP_ID  = CONFIG.TP_APP_ID;  // TransportAPI (optional for live times)
const TP_APP_KEY = CONFIG.TP_APP_KEY; // TransportAPI (optional)

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
const elBtnRouteHome = document.getElementById("btn-route-home");
const elBtnClearRoute = document.getElementById("btn-clear-route");
const elRouteSummary = document.getElementById("route-summary");

// Route-from toggle
const elRFMy = document.getElementById("rf-myloc");
const elRFSel = document.getElementById("rf-selected");

// Home controls (search-like)
const elHomeInput   = document.getElementById("home-input");
const elHomeResults = document.getElementById("home-results");
const elHomePill    = document.getElementById("home-pill");
const elHomeEdit    = document.getElementById("home-edit");
const elHomeOnlyWrap= document.getElementById("home-only-wrap");
const elHomeOnly    = document.getElementById("home-only");

// ======= Map setup =======
const map = L.map("map");
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);
map.setView([52.2053, 0.1218], 13);

let myLocation = null;
let selectedPoint = null;
let selectedMarker = null;
let routeLine = null;
let stopLayers = [];

const wxNowCache = new Map();  // key: "lat,lon" ~ tile -> { temp, icon }
const hourlyCache = new Map(); // key: tile -> [{ts,t,icon,tz},...]

// ======= Units: miles & mph =======
function miles(meters) { return (meters / 1609.344).toFixed(2); }
function mph(ms)      { return Math.round(ms * 2.236936); }

// ======= Home storage =======
const HOME_KEY = "freshstop_home";
function getHome() { try { return JSON.parse(localStorage.getItem(HOME_KEY) || "null"); } catch { return null; } }
function setHome(obj) { localStorage.setItem(HOME_KEY, JSON.stringify(obj)); renderHomeUI(); }
function clearHome() { localStorage.removeItem(HOME_KEY); renderHomeUI(); }
function isHomeOnly() { return !!elHomeOnly?.checked; }

function renderHomeUI() {
  const home = getHome();
  if (!elHomeInput || !elHomePill || !elHomeEdit) return;

  if (home) {
    elHomeInput.style.display = "none";
    elHomePill.style.display = "";
    elHomeEdit.style.display = "";
    elHomePill.textContent = "Home";
    if (elHomeResults) { elHomeResults.style.display = "none"; elHomeResults.innerHTML = ""; }
    if (elHomeOnlyWrap) elHomeOnlyWrap.style.display = "";
    if (elHomeOnly) elHomeOnly.checked = true; // default ON
  } else {
    elHomeInput.style.display = "";
    elHomePill.style.display = "none";
    elHomeEdit.style.display = "none";
    if (elHomeOnlyWrap) elHomeOnlyWrap.style.display = "none";
    if (elHomeOnly) elHomeOnly.checked = false;
  }
}
renderHomeUI();

elHomeEdit && (elHomeEdit.onclick = () => {
  clearHome();
  elHomeInput.value = "";
  elHomeInput.focus();
});
elHomeOnly && elHomeOnly.addEventListener("change", () => {
  if (selectedPoint) loadStops(selectedPoint[0], selectedPoint[1], 800);
});

// ======= Map interactions =======
map.on("click", (e) => setSelected([e.latlng.lat, e.latlng.lng], "(map click)"));
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

// ======= Helpers =======
function show(el){ if(el) el.style.display=""; }
function hide(el){ if(el) el.style.display="none"; }
function setHTML(el,h){ if(el) el.innerHTML=h; }
function km(m){ return (m/1000).toFixed(2); } // retained if ever needed
function minutes(s){ return Math.round(s/60); }
function roundKey(lat,lon){ return `${lat.toFixed(2)},${lon.toFixed(2)}`; }
function escapeHtml(s=""){ return s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }
function iconUrl(c){ return `https://openweathermap.org/img/wn/${c}@2x.png`; }
function hourStr(ts,tz=0){ const d=new Date((ts+tz)*1000); return d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}); }
function haversine(a,b){const R=6371000,toRad=d=>d*Math.PI/180;const dLat=toRad(b[0]-a[0]),dLon=toRad(b[1]-a[1]);const lat1=toRad(a[0]),lat2=toRad(b[0]);const h=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(h));}

function getRouteFromMode(){ if(!elRFMy||!elRFSel) return "myloc"; return elRFSel.checked?"selected":"myloc"; }
async function getOrigin(){
  const mode=getRouteFromMode();
  if(mode==="selected"){ if(!selectedPoint) throw new Error("Pick a point first."); return selectedPoint; }
  if(myLocation) return myLocation;
  const pos=await getCurrentPosition(); myLocation=[pos.coords.latitude,pos.coords.longitude];
  L.circle(myLocation,{radius:6,color:"#0ea5e9",fillColor:"#0ea5e9",fillOpacity:0.7}).addTo(map); return myLocation;
}

// Remove all stop markers from the map
function clearStops() {
  for (const layer of stopLayers) {
    try { layer.remove(); } catch {}
  }
  stopLayers = [];
}

// ======= Reverse geocode =======
async function reverseGeocode(lat,lon){
  const url=`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&addressdetails=1`;
  const d=await getJSON(url,{"Accept-Language":"en"});
  const a=d?.address||{};
  const parts=[[a.road,a.pedestrian,a.footway,a.cycleway,a.path].find(Boolean),a.suburb||a.village||a.neighbourhood||a.hamlet,a.town||a.city||a.county,a.postcode].filter(Boolean);
  return {line:parts.join(", ")};
}

// ======= Selection =======
async function setSelected([lat,lng],source=""){
  selectedPoint=[lat,lng];
  if(selectedMarker) selectedMarker.remove();
  selectedMarker=L.circleMarker(selectedPoint,{radius:7,color:"#ef4444",fillColor:"#ef4444",fillOpacity:0.8}).addTo(map);
  map.panTo(selectedPoint);

  // reset panels
  hide(elErrors); hide(elWeather); hide(elAir); hide(elStops); hide(elDirections);
  setHTML(elWeather,""); setHTML(elAir,""); setHTML(elStopsList,""); setHTML(elDirSteps,"");
  hide(elRouteSummary); clearStops(); clearRoute();

  const latTxt=lat.toFixed(5), lngTxt=lng.toFixed(5);
  setHTML(elSelection,`<div><div style="font-weight:700;">Selected location</div><div class="muted">${latTxt}, ${lngTxt}</div></div>`);
  show(elSelection);

  try { const rev=await reverseGeocode(lat,lng); if(rev.line) setHTML(elSelection,`<div><div style="font-weight:700;">Selected location</div><div>${escapeHtml(rev.line)}${source?` • <span class="muted">${escapeHtml(source)}</span>`:""}</div><div class="muted">${latTxt}, ${lngTxt}</div></div>`); } catch {}

  try {
    await Promise.all([
      loadWeatherAndForecast(lat,lng),
      loadAir(lat,lng),
      loadStops(lat,lng,800)
    ]);
  } catch(e) { showError(e.message || "Couldn’t load."); }
}

// ======= Weather (now + next 2 hours) =======
async function loadWeatherAndForecast(lat,lng){
  if(!OWM_KEY) throw new Error("Missing OpenWeatherMap key.");

  const wx=await getJSON(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=metric&appid=${OWM_KEY}`);
  const t=Math.round(wx?.main?.temp??0);
  const feels=Math.round(wx?.main?.feels_like??0);
  const windMs=(wx?.wind?.speed??0);
  const wind = mph(windMs); // mph
  const desc=(wx?.weather?.[0]?.description||"").replace(/^\w/,c=>c.toUpperCase());
  const place=[wx?.name,wx?.sys?.country].filter(Boolean).join(", ");
  const icon=wx?.weather?.[0]?.icon;

  wxNowCache.set(roundKey(lat,lng),{temp:t,icon});

  let hours=[];
  try {
    const one=await getJSON(`https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lng}&exclude=minutely,daily,alerts&units=metric&appid=${OWM_KEY}`);
    const tz = one?.timezone_offset || 0;
    hours=(one?.hourly||[]).slice(0,3).map(h=>({ts:h.dt,t:Math.round(h.temp),icon:h.weather?.[0]?.icon,tz}));
  } catch {}

  setHTML(elWeather, `
    <div class="wx-top">
      <div class="wx-main">
        ${icon ? `<img src="${iconUrl(icon)}" width="64" height="64" alt="${escapeHtml(desc)}" />` : ""}
        <div>
          <div class="wx-temp">${t}°C</div>
          <div class="wx-desc">${escapeHtml(desc)} ${place ? `• <span class="pill">${escapeHtml(place)}</span>` : ""}</div>
          <div class="muted">Feels like ${feels}°C • Wind ${wind} mph</div>
        </div>
      </div>
    </div>
    <div style="margin-top:10px; font-weight:700;">Next 2 hours</div>
    <div class="wx-hours">
      ${hours.map(h=>`
        <div class="wx-hour">
          <div>${hourStr(h.ts,h.tz)}</div>
          ${h.icon?`<img src="${iconUrl(h.icon)}" alt="" />`:""}
          <div class="t">${h.t}°C</div>
        </div>
      `).join("")}
    </div>
  `);
  show(elWeather);
}

// ======= Air (WOW-ish badges/bars) =======
function aqiClass(n){switch(n){case 1:return["Good","aqi-good"];case 2:return["Fair","aqi-fair"];case 3:return["Moderate","aqi-moderate"];case 4:return["Poor","aqi-poor"];case 5:return["Very Poor","aqi-vpoor"];default:return["Unknown","aqi-moderate"];}}
function pct(value,max){return Math.max(0,Math.min(100,Math.round((value/max)*100)));}
async function loadAir(lat,lng){
  if(!OWM_KEY) throw new Error("Missing OpenWeatherMap key.");
  const air=await getJSON(`https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lng}&appid=${OWM_KEY}`);
  const main=air?.list?.[0]?.main||{}, comp=air?.list?.[0]?.components||{};
  const [label,cls]=aqiClass(main.aqi||0);
  const scales={pm2_5:75,pm10:150,no2:200,o3:180};

  setHTML(elAir, `
    <div style="display:flex; align-items:center; justify-content:space-between;">
      <div>
        <div style="font-weight:700; margin-bottom:4px;">Air quality</div>
        <div class="muted" style="font-size:12px;">OpenWeatherMap AQI (1–5)</div>
      </div>
      <div class="aqi-badge ${cls}">AQI ${main.aqi ?? "?"} • ${label}</div>
    </div>

    <div style="margin-top:10px; display:grid; gap:10px;">
      ${["pm2_5","pm10","no2","o3"].map(k=>{
        const v=comp[k]; const percentage=pct(v??0, scales[k]);
        return `
          <div>
            <div class="kv"><span>${k.toUpperCase()}</span><span>${v!=null?v:"—"} μg/m³</span></div>
            <div class="bar"><span style="width:${percentage}%;"></span></div>
          </div>
        `;
      }).join("")}
    </div>
  `);
  show(elAir);
}

// ======= Overpass helpers =======
async function overpass(query){
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({ data: query })
  });
  if (!res.ok) throw new Error("Overpass busy/unavailable");
  return await res.json();
}
async function fetchStopRoutes(nodeId){
  const q = `
[out:json][timeout:25];
node(${nodeId});
rel(bn)->.r;
.r[route~"bus|tram|train|subway|light_rail"] out tags;
`.trim();
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({ data: q })
  });
  if (!res.ok) throw new Error("Overpass error");
  const json = await res.json();
  return (json.elements || []).filter(e => e.type === "relation");
}

// Read route relations that serve a stop and return short labels
async function getStopRouteLabels(nodeId) {
  const rels = await fetchStopRoutes(nodeId);
  const labels = rels.map(r => {
    const t = r.tags || {};
    return t.ref || t.name || t["name:en"] || t.to || t.destination || "";
  }).filter(Boolean);
  return [...new Set(labels)].sort((a, b) => a.length - b.length).slice(0, 8);
}

// Home vicinity stops (for route intersection)
async function fetchHomeAreaStops(home, radiusMeters = 600) {
  const q = `
[out:json][timeout:25];
(
  node(around:${radiusMeters},${home.lat},${home.lon})["highway"="bus_stop"];
  node(around:${radiusMeters},${home.lat},${home.lon})["public_transport"="platform"]["bus"="yes"];
  node(around:${radiusMeters},${home.lat},${home.lon})["railway"~"^(station|halt|stop|tram_stop)$"];
);
out body;
>;
out skel qt;
`.trim();
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({ data: q })
  });
  if (!res.ok) throw new Error("Overpass home-stops error");
  const json = await res.json();
  return (json.elements || []).filter(e => e.type === "node");
}
async function fetchRouteRelationsByNodes(nodeIds) {
  if (!nodeIds.length) return [];
  const idList = nodeIds.join(",");
  const q = `
[out:json][timeout:25];
node(id:${idList});
rel(bn)->.r;
.r[route~"bus|tram|train|subway|light_rail"] out tags;
`.trim();
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({ data: q })
  });
  if (!res.ok) throw new Error("Overpass route-relations error");
  const json = await res.json();
  return (json.elements || []).filter(e => e.type === "relation");
}

// Robust: stops whose routes also serve Home area (fallback: name heuristic)
async function getStopsTowardHomeSet(stopsNearYou, home) {
  const homeStops = await fetchHomeAreaStops(home, 600);
  if (!homeStops.length) return await nameHeuristicHomeSet(stopsNearYou, home);

  const homeRelObjs = await fetchRouteRelationsByNodes(homeStops.map(s => s.id));
  const homeRelIds = new Set(homeRelObjs.map(r => r.id));
  if (!homeRelIds.size) return await nameHeuristicHomeSet(stopsNearYou, home);

  const hitIds = new Set();
  for (const s of stopsNearYou) {
    try {
      const rels = await fetchStopRoutes(s.id);
      if (rels.some(r => homeRelIds.has(r.id))) hitIds.add(s.id);
    } catch {}
  }
  if (hitIds.size) return hitIds;
  return await nameHeuristicHomeSet(stopsNearYou, home);
}
async function nameHeuristicHomeSet(stops, home) {
  const tokens = (home.label || home.postcode || "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(x => x.length > 2);
  const out = new Set();
  for (const s of stops) {
    try {
      const rels = await fetchStopRoutes(s.id);
      const hay = rels.map(r => {
        const t = r.tags || {};
        return [t.to, t.name, t.destination, t.via, t["name:en"]]
          .filter(Boolean).join(" • ").toLowerCase();
      }).join(" | ");
      if (tokens.some(tok => hay.includes(tok))) out.add(s.id);
    } catch {}
  }
  return out;
}

// ======= Stops (with filter to Home, routes, live times) =======
async function loadStops(lat,lng,radius=800){
  elStopsRadius.textContent = radius;
  const q = `
[out:json][timeout:25];
(
  node(around:${radius},${lat},${lng})["highway"="bus_stop"];
  node(around:${radius},${lat},${lng})["public_transport"="platform"]["bus"="yes"];
  node(around:${radius},${lat},${lng})["railway"~"^(station|halt|stop|tram_stop)$"];
);
out body;
>;
out skel qt;
`.trim();

  const data = await overpass(q);
  let stops = (data.elements || [])
    .filter(e => e.type === "node")
    .map(e => {
      const tags = e.tags || {};
      const isBus = tags.highway === "bus_stop" || tags.bus === "yes";
      const isTrain = /^station|halt|stop|tram_stop$/.test(tags.railway || "");
      const atco = tags["naptan:AtcoCode"] || tags["ref:NaPTAN"] || tags["atcocode"] || null;
      return {
        id: e.id,
        name: tags.name || (isBus ? "Bus stop" : "Station"),
        kind: isTrain ? "train" : "bus",
        pos: [e.lat, e.lon],
        dist: selectedPoint ? haversine(selectedPoint, [e.lat, e.lon]) : 0,
        atco
      };
    })
    .sort((a,b)=>a.dist-b.dist)
    .slice(0, 12);

  const home = getHome();
  let homeSet = null;
  if (home && isHomeOnly()) {
    homeSet = await getStopsTowardHomeSet(stops, home);
    stops = stops.filter(s => homeSet.has(s.id));
  }

  if (!stops.length) {
    setHTML(elStopsList, `
      <div class="muted" style="padding:8px;">
        No nearby stops found that clearly reach your Home area.
        Try turning off “Only stops to Home” or zooming out.
      </div>
    `);
    show(elStops);
    clearStops();
    return;
  }

  // Draw markers
  clearStops();
  for (const s of stops) {
    const color = s.kind === "bus" ? "#0ea5e9" : "#10b981";
    const m = L.circleMarker(s.pos, { radius: 6, color, fillColor: color, fillOpacity: 0.85 })
      .addTo(map)
      .bindTooltip(`${s.name} (${s.kind})`);
    stopLayers.push(m);
  }

  // Render list
  setHTML(elStopsList, stops.map(s => `
    <div class="stop-item" data-stop="${s.id}">
      <div class="stop-left">
        <div class="stop-wx" id="wx-${s.id}"><span class="muted">…</span></div>
        <div>
          <div class="stop-name">
            ${escapeHtml(s.name)}
            ${homeSet && homeSet.has(s.id) ? `<span class="pill" style="margin-left:6px;">→ Home</span>` : ""}
          </div>
          <div class="muted" style="font-size:12px;">
            ${s.kind === "bus" ? "Bus stop" : "Train/Tram"} • ${miles(s.dist)} mi
            <span id="routes-${s.id}" class="muted" style="margin-left:6px;"></span>
          </div>
          <div id="live-${s.id}" class="muted" style="font-size:12px;"></div>
        </div>
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        <span class="stop-kind ${s.kind === "bus" ? "kind-bus" : "kind-train"}">${s.kind}</span>
        <button class="btn" data-route="${s.id}" title="Route from chosen origin to this stop">Route</button>
      </div>
    </div>
  `).join(""));
  show(elStops);

  // Per-stop tiny weather
  await fillStopsWeather(stops);

  // Fill per-stop route labels & live times
  for (const s of stops) {
    // OSM route labels
    getStopRouteLabels(s.id).then(labels => {
      const el = document.getElementById(`routes-${s.id}`);
      if (el && labels.length) el.textContent = `• Routes: ${labels.join(", ")}`;
    }).catch(()=>{});

    // Live bus times (TransportAPI) - only for bus stops with ATCO and keys present
    const liveEl = document.getElementById(`live-${s.id}`);
    if (s.kind === "bus" && s.atco && TP_APP_ID && TP_APP_KEY) {
      fetchLiveBusTimes(s.atco).then(rows => {
        if (!liveEl) return;
        if (!rows.length) { liveEl.textContent = "Live: n/a"; return; }
        liveEl.textContent = "Live: " + rows.map(r => `${r.line} → ${r.dir} (${r.due})`).join(" • ");
      }).catch(()=>{ if (liveEl) liveEl.textContent = "Live: n/a"; });
    } else {
      if (liveEl) liveEl.textContent = "Live: n/a";
    }
  }

  // Wire route buttons
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
  const MAX_FETCH = 8;
  let remaining = MAX_FETCH;

  for (const s of stops) {
    const key = roundKey(s.pos[0], s.pos[1]);
    let wx = wxNowCache.get(key);
    if (!wx && remaining > 0) {
      try {
        const w = await getJSON(`https://api.openweathermap.org/data/2.5/weather?lat=${s.pos[0]}&lon=${s.pos[1]}&units=metric&appid=${OWM_KEY}`);
        wx = { temp: Math.round(w?.main?.temp ?? 0), icon: w?.weather?.[0]?.icon };
        wxNowCache.set(key, wx);
        remaining--;
      } catch { /* ignore */ }
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

// ======= TransportAPI: live bus times =======
async function fetchLiveBusTimes(atco) {
  if (!TP_APP_ID || !TP_APP_KEY) throw new Error("No TransportAPI keys");
  const url = `https://transportapi.com/v3/uk/bus/stop/${encodeURIComponent(atco)}/live.json?app_id=${encodeURIComponent(TP_APP_ID)}&app_key=${encodeURIComponent(TP_APP_KEY)}&group=route&nextbuses=yes`;
  const data = await getJSON(url);
  const departures = data?.departures || {};
  const lines = Object.keys(departures);
  let out = [];
  for (const line of lines) {
    const arr = departures[line] || [];
    for (const d of arr.slice(0, 2)) {
      out.push({
        line,
        dir: d.direction || d.destination || "",
        due: d.best_departure_estimate || d.best_departure_estimate_mins || d.aimed_departure_time || ""
      });
    }
  }
  const now = new Date();
  out = out.slice(0, 4).map(x => {
    const hhmm = /^(\d{2}):(\d{2})$/.exec(x.due || "");
    if (hhmm) {
      const t = new Date(now);
      t.setHours(+hhmm[1], +hhmm[2], 0, 0);
      let mins = Math.round((t - now) / 60000);
      if (mins < 0) mins = 0;
      return { ...x, due: `${mins} min` };
    }
    const n = parseInt(String(x.due).replace(/\D+/g, ""), 10);
    if (!isNaN(n)) return { ...x, due: `${n} min` };
    return x;
  });
  return out;
}

// ======= Routing =======
elBtnRoute.onclick = async () => {
  hide(elErrors); hide(elRouteSummary);
  try {
    if (!selectedPoint) throw new Error("Pick a destination on the map (or via search) first.");
    const origin = await getOrigin();
    routeBetween(origin, selectedPoint);
  } catch (err) { showError(err.message || "Couldn’t start routing."); }
};
elBtnRouteHome && (elBtnRouteHome.onclick = async () => {
  const home = getHome(); if (!home) return showError("Set Home first (top bar).");
  hide(elErrors); hide(elRouteSummary);
  try {
    const origin = await getOrigin();
    routeBetween(origin, [home.lat, home.lon]);
  } catch (e) { showError(e.message || "Couldn’t start routing to Home."); }
});
elBtnClearRoute && (elBtnClearRoute.onclick = () => { clearRoute(); hide(elDirections); hide(elRouteSummary); });

function clearRoute(){ if(routeLine) routeLine.remove(); routeLine=null; setHTML(elDirSteps,""); }

async function routeBetween(from,to){
  try {
    const r = await routeOSRM(from, to);
    drawRoute(r);
  } catch (e1) {
    if (ORS_KEY) {
      try { const r = await routeORS(from, to, ORS_KEY); drawRoute(r); }
      catch (e2) { showError("Routing failed (OSRM & ORS)."); }
    } else {
      showError("Routing failed (OSRM). You can add an ORS key for fallback.");
    }
  }
}

async function routeOSRM(from,to){
  const url=`https://router.project-osrm.org/route/v1/foot/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson&steps=true`;
  const data=await getJSON(url);
  const r=data?.routes?.[0]; if(!r) throw new Error("No OSRM route");
  const coords=r.geometry.coordinates.map(([lng,lat])=>[lat,lng]);
  const steps=(r.legs?.[0]?.steps||[]).map(osrmStepToText);
  return { coords, distance:r.distance, duration:r.duration, steps };
}
function osrmStepToText(step){
  const m=step.maneuver||{}; const type=m.type||"continue";
  const mod=m.modifier?` ${m.modifier}`:"";
  const road=step.name?` onto ${step.name}`:"";
  const dist=step.distance?` (${Math.round(step.distance)} m)`:"";
  switch(type){
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
async function routeORS(from,to,key){
  const url="https://api.openrouteservice.org/v2/directions/foot-walking/geojson";
  const res=await fetch(url,{method:"POST",headers:{"Authorization":key,"Content-Type":"application/json"},body:JSON.stringify({coordinates:[[from[1],from[0]],[to[1],to[0]]],instructions:true})});
  if(!res.ok) throw new Error("ORS error");
  const data=await res.json();
  const feat=data?.features?.[0];
  const coords=feat?.geometry?.coordinates?.map(([lng,lat])=>[lat,lng])||[];
  const sum=feat?.properties?.summary||{};
  const raw=feat?.properties?.segments?.[0]?.steps||[];
  const steps=raw.map(orsStepToText);
  if(!coords.length) throw new Error("No ORS route");
  return { coords, distance:sum.distance??0, duration:sum.duration??0, steps };
}
function orsStepToText(step){
  const name=step.name?` onto ${step.name}`:"";
  const dist=step.distance?` (${Math.round(step.distance)} m)`:"";
  const text=step.instruction||step.type||"Continue";
  return `${text}${name}${dist}`;
}
function drawRoute(route){
  const { coords, distance, duration, steps } = route;
  if(routeLine) routeLine.remove();
  routeLine=L.polyline(coords,{weight:5}).addTo(map);
  map.fitBounds(L.latLngBounds(coords),{padding:[20,20]});
  // miles + minutes
  elRouteSummary.textContent=`Distance: ${miles(distance)} mi • Time: ${minutes(duration)} min`;
  show(elRouteSummary);
  if(steps && steps.length){
    setHTML(elDirSteps, steps.map((s,i)=>`<div class="dir-step">${i+1}. ${escapeHtml(s)}</div>`).join(""));
    show(elDirections);
  } else {
    hide(elDirections);
  }
}

// ======= Search (places) =======
let searchTimer;
elSearch.addEventListener("input",()=>{
  clearTimeout(searchTimer);
  const q=elSearch.value.trim();
  if(q.length<3){ hide(elResults); elResults.innerHTML=""; return; }
  searchTimer=setTimeout(()=>doSearch(q),350);
});
async function doSearch(q){
  const url=`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`;
  try{
    const data=await getJSON(url,{"Accept-Language":"en"});
    if(!Array.isArray(data)||!data.length){ hide(elResults); elResults.innerHTML=""; return; }
    elResults.innerHTML=data.map(row=>`
      <button data-lat="${row.lat}" data-lon="${row.lon}">
        ${row.display_name.replaceAll("&","&amp;")}
      </button>
    `).join("");
    show(elResults);
    [...elResults.querySelectorAll("button")].forEach(btn=>{
      btn.onclick=()=>{
        const lat=parseFloat(btn.dataset.lat);
        const lon=parseFloat(btn.dataset.lon);
        setSelected([lat,lon],"search");
        hide(elResults); elResults.innerHTML="";
      };
    });
  }catch{ hide(elResults); }
}
// close results when clicking outside
document.addEventListener("click",(e)=>{ if(!elResults.contains(e.target) && e.target!==elSearch) hide(elResults); });

// ======= Home autocomplete =======
let homeTimer;
if(elHomeInput && elHomeResults){
  elHomeInput.addEventListener("input",()=>{
    clearTimeout(homeTimer);
    const q=elHomeInput.value.trim();
    if(!q || q.length<3){ elHomeResults.style.display="none"; elHomeResults.innerHTML=""; return; }
    homeTimer=setTimeout(()=>doHomeSearch(q),350);
  });
  document.addEventListener("click",(e)=>{ if(!elHomeResults.contains(e.target) && e.target!==elHomeInput){ elHomeResults.style.display="none"; } });
}
async function doHomeSearch(q){
  const url=`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`;
  try{
    const data=await getJSON(url,{"Accept-Language":"en"});
    if(!Array.isArray(data)||!data.length){ elHomeResults.style.display="none"; elHomeResults.innerHTML=""; return; }
    elHomeResults.innerHTML=data.map(row=>`
      <button data-lat="${row.lat}" data-lon="${row.lon}" data-display="${(row.display_name||"").replaceAll('"',"&quot;")}">
        ${row.display_name.replaceAll("&","&amp;")}
      </button>
    `).join("");
    elHomeResults.style.display="";
    [...elHomeResults.querySelectorAll("button")].forEach(btn=>{
      btn.onclick=()=>{
        const lat=+btn.dataset.lat, lon=+btn.dataset.lon;
        const display=btn.dataset.display || "";
        setHome({ lat, lon, label: display });
        elHomeInput.value="";
        elHomeResults.style.display="none"; elHomeResults.innerHTML="";
        if (selectedPoint) loadStops(selectedPoint[0], selectedPoint[1], 800);
      };
    });
  }catch{ elHomeResults.style.display="none"; }
}

// ======= Generic helpers =======
async function getJSON(u,h={}){ const r=await fetch(u,{headers:{...h}}); if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return await r.json(); }
function getCurrentPosition(){ return new Promise((resolve,reject)=>{ if(!navigator.geolocation) return reject(new Error("Geolocation unsupported")); navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:10000}); }); }
function showError(m){ setHTML(elErrors,`⚠️ ${m}`); show(elErrors); }
