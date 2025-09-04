// ======= Config & guards =======
const CONFIG = (window.FRESHSTOP_CONFIG || {});
const OWM_KEY    = CONFIG.OWM_KEY;
const ORS_KEY    = CONFIG.ORS_KEY;
const TP_APP_ID  = CONFIG.TP_APP_ID;   // optional for live times (TransportAPI)
const TP_APP_KEY = CONFIG.TP_APP_KEY;  // optional

if (!OWM_KEY) console.warn("Missing OWM_KEY. Create config.js with window.FRESHSTOP_CONFIG.");

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
const elBtnRoute = document.getElementById("btn-route");
const elBtnRouteHome = document.getElementById("btn-route-home");
const elBtnClearRoute = document.getElementById("btn-clear-route");
const elRouteSummary = document.getElementById("route-summary");

// Route-from toggle
const elRFMy = document.getElementById("rf-myloc");
const elRFSel = document.getElementById("rf-selected");

// Home controls
const elHomeInput    = document.getElementById("home-input");
const elHomeResults  = document.getElementById("home-results");
const elHomePill     = document.getElementById("home-pill");
const elHomeEdit     = document.getElementById("home-edit");
const elHomeOnlyWrap = document.getElementById("home-only-wrap");
const elHomeOnly     = document.getElementById("home-only");

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

const wxNowCache = new Map();   // tile -> {temp, icon}
const hourlyCache = new Map();  // key "h3:lat,lon" -> [{ts,t,icon,tz},..]
// Ordered relation member cache (for direction)
const relMembersCache = new Map(); // relationId -> [nodeId,...]

// ======= Units: miles & mph =======
function miles(m) { return (m / 1609.344).toFixed(2); }
function mph(ms)  { return Math.round(ms * 2.236936); }

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
    if (elHomeOnly) elHomeOnly.checked = true; // default ON when home exists
  } else {
    elHomeInput.style.display = "";
    elHomePill.style.display = "none";
    elHomeEdit.style.display = "none";
    if (elHomeOnlyWrap) elHomeOnlyWrap.style.display = "none";
    if (elHomeOnly) elHomeOnly.checked = false;
  }
}
renderHomeUI();

if (elHomeEdit) {
  elHomeEdit.onclick = () => {
    clearHome();
    elHomeInput.value = "";
    elHomeInput.focus();
  };
}
if (elHomeOnly) {
  elHomeOnly.addEventListener("change", () => {
    if (selectedPoint) loadStops(selectedPoint[0], selectedPoint[1], 800);
  });
}

// ======= Map interactions =======
map.on("click", (e) => setSelected([e.latlng.lat, e.latlng.lng], "(map click)"));

// Auto-select device location on load and force home filter if set
if ("geolocation" in navigator) {
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      myLocation = [pos.coords.latitude, pos.coords.longitude];
      const home = getHome();
      if (home && elHomeOnly) elHomeOnly.checked = true; // show only heading-home on load
      setSelected(myLocation, "My location");
      L.circle(myLocation, { radius: 6, color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 0.7 }).addTo(map);
    },
    () => {},
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ======= Helpers =======
function show(el){ if(el) el.style.display=""; }
function hide(el){ if(el) el.style.display="none"; }
function setHTML(el,h){ if(el) el.innerHTML=h; }
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

// Remove all stop markers
function clearStops() { for (const l of stopLayers){ try{ l.remove(); }catch{} } stopLayers = []; }

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

// ======= Weather (colourful; hide hours if absent) =======
function renderHourly3Block(hours){
  if (!hours || !hours.length) return "";
  return `
    <div class="wx-hours">
      ${hours.map(h=>`
        <div class="wx-hour" style="min-width:70px;">
          <div>${hourStr(h.ts,h.tz)}</div>
          ${h.icon?`<img src="${iconUrl(h.icon)}" alt="" />`:""}
          <div class="t">${h.t}°C</div>
        </div>
      `).join("")}
    </div>
  `;
}
async function fetchHourly3(lat, lon){
  const key = `h3:${roundKey(lat,lon)}`;
  if (hourlyCache.has(key)) return hourlyCache.get(key);
  let hours = [];
  try {
    const one = await getJSON(`https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,daily,alerts,current&units=metric&appid=${OWM_KEY}`);
    const tz = one?.timezone_offset || 0;
    hours = (one?.hourly||[]).slice(0,3).map(h => ({ ts:h.dt, t:Math.round(h.temp), icon:h.weather?.[0]?.icon, tz }));
  } catch {
    try {
      const old = await getJSON(`https://api.openweathermap.org/data/2.5/onecall?lat=${lat}&lon=${lon}&exclude=minutely,daily,alerts,current&units=metric&appid=${OWM_KEY}`);
      const tz = old?.timezone_offset || 0;
      hours = (old?.hourly||[]).slice(0,3).map(h => ({ ts:h.dt, t:Math.round(h.temp), icon:h.weather?.[0]?.icon, tz }));
    } catch {}
  }
  hourlyCache.set(key, hours);
  return hours;
}

async function loadWeatherAndForecast(lat,lng){
  if(!OWM_KEY) throw new Error("Missing OpenWeatherMap key.");

  let t = 0, feels = 0, wind = 0, desc = "", place = "", icon = "";
  try {
    const wx=await getJSON(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=metric&appid=${OWM_KEY}`);
    t=Math.round(wx?.main?.temp??0);
    feels=Math.round(wx?.main?.feels_like??0);
    wind = mph(wx?.wind?.speed??0);
    desc=(wx?.weather?.[0]?.description||"").replace(/^\w/,c=>c.toUpperCase());
    place=[wx?.name,wx?.sys?.country].filter(Boolean).join(", ");
    icon=wx?.weather?.[0]?.icon;
    wxNowCache.set(roundKey(lat,lng),{temp:t,icon});
  } catch (e) {
    setHTML(elWeather, `<div class="wx-card"><div class="muted">Weather unavailable • ${escapeHtml(e.message||"")}</div></div>`);
    show(elWeather);
    return;
  }

  // Hourly 3 for current location
  let hours=[];
  try { hours = await fetchHourly3(lat, lng); } catch {}

  const hoursBlock = (hours && hours.length)
    ? `
      <div style="margin-top:10px; font-weight:700;">Next 3 hours</div>
      ${renderHourly3Block(hours)}
    ` : "";

  setHTML(elWeather, `
    <div class="wx-card">
      <div class="wx-main">
        ${icon ? `<img src="${iconUrl(icon)}" width="64" height="64" alt="${escapeHtml(desc)}" />` : ""}
        <div>
          <div class="wx-temp">${t}°C</div>
          <div class="wx-desc">${escapeHtml(desc)} ${place ? `• <span class="pill">${escapeHtml(place)}</span>` : ""}</div>
          <div class="muted">Feels like ${feels}°C • Wind ${wind} mph</div>
        </div>
      </div>
      ${hoursBlock}
    </div>
  `);
  show(elWeather);
}

// ======= Air (WOW-ish) =======
function aqiClass(n){switch(n){case 1:return["Good","aqi-good"];case 2:return["Fair","aqi-fair"];case 3:return["Moderate","aqi-moderate"];case 4:return["Poor","aqi-poor"];case 5:return["Very Poor","aqi-vpoor"];default:return["Unknown","aqi-moderate"];}}
function pct(value,max){return Math.max(0,Math.min(100,Math.round((value/max)*100)));}
async function loadAir(lat,lng){
  if(!OWM_KEY) throw new Error("Missing OpenWeatherMap key.");
  try {
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
  } catch (e) {
    setHTML(elAir, `<div class="muted">Air quality unavailable • ${escapeHtml(e.message||"")}</div>`);
  }
  show(elAir);
}

// ======= Overpass: rotation, chunking, soft-fail =======
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter"
];

async function overpass(query){
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {"Content-Type":"application/x-www-form-urlencoded"},
        body: new URLSearchParams({ data: query })
      });
      if (!res.ok) continue;
      return await res.json();
    } catch { }
  }
  throw new Error("Overpass busy/unavailable");
}

async function fetchStopRoutes(nodeId){
  const q = `
[out:json][timeout:30];
node(${nodeId});
rel(bn)->.r;
.r[route~"bus|tram|train|subway|light_rail"] out tags;
`.trim();
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:new URLSearchParams({ data:q }) });
      if (!res.ok) continue;
      const json = await res.json();
      return (json.elements || []).filter(e => e.type === "relation");
    } catch {}
  }
  return []; // soft-fail
}

// Relation members (ordered) for direction check
async function fetchRelationMembersOrdered(relationId) {
  if (relMembersCache.has(relationId)) return relMembersCache.get(relationId);
  const q = `
[out:json][timeout:30];
rel(${relationId});
out body;
`.trim();
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:new URLSearchParams({ data:q }) });
      if (!res.ok) continue;
      const json = await res.json();
      const rel = (json.elements || []).find(e => e.type === "relation");
      const members = (rel?.members || []);
      const nodeIds = members
        .filter(m => m.type === "node" && (!m.role || /platform|stop/i.test(m.role)))
        .map(m => m.ref);
      relMembersCache.set(relationId, nodeIds);
      return nodeIds;
    } catch {}
  }
  relMembersCache.set(relationId, []);
  return [];
}

// Chunked relations by nodes
async function fetchRouteRelationsByNodes(nodeIds) {
  if (!nodeIds.length) return [];
  const CHUNK = 40;
  const all = [];
  for (let i = 0; i < nodeIds.length; i += CHUNK) {
    const idList = nodeIds.slice(i, i + CHUNK).join(",");
    const q = `
[out:json][timeout:30];
node(id:${idList});
rel(bn)->.r;
.r[route~"bus|tram|train|subway|light_rail"] out tags;
`.trim();
    let ok = false;
    for (const url of OVERPASS_URLS) {
      try {
        const res = await fetch(url, { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:new URLSearchParams({ data:q }) });
        if (!res.ok) continue;
        const json = await res.json();
        all.push(...(json.elements || []).filter(e => e.type === "relation"));
        ok = true; break;
      } catch {}
    }
    if (!ok) { /* skip softly */ }
  }
  return all;
}

// Route labels for UI
async function getStopRouteLabels(nodeId) {
  const rels = await fetchStopRoutes(nodeId);
  const labels = rels.map(r => {
    const t = r.tags || {};
    return t.ref || t.name || t["name:en"] || t.to || t.destination || "";
  }).filter(Boolean);
  return [...new Set(labels)].sort((a, b) => a.length - b.length).slice(0, 8);
}

// Home vicinity stops (soft, capped)
async function fetchHomeAreaStops(home, radiusMeters = 600) {
  const q = `
[out:json][timeout:25];
(
  node(around:${radiusMeters},${home.lat},${home.lon})["highway"="bus_stop"];
  node(around:${radiusMeters},${home.lat},${home.lon})["public_transport"="platform"]["bus"="yes"];
  node(around:${radiusMeters},${home.lat},${home.lon})["railway"~"^(station|halt|stop|tram_stop)$"];
);
out body 20;
`.trim();
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:new URLSearchParams({ data:q }) });
      if (!res.ok) continue;
      const json = await res.json();
      return (json.elements || []).filter(e => e.type === "node");
    } catch {}
  }
  return [];
}

// ======= Direction-aware: Only stops heading toward Home =======
async function getStopsTowardHomeSet(stopsNearYou, home) {
  const homeStops = await fetchHomeAreaStops(home, 1609); // ~1 mile
  if (!homeStops.length) return await nameHeuristicHomeSet(stopsNearYou, home);
  const homeIds = new Set(homeStops.map(s => s.id));

  const hitIds = new Set();
  for (const s of stopsNearYou) {
    try {
      let rels = await fetchStopRoutes(s.id);
      rels = rels.filter(r => /bus|tram|train|subway|light_rail/.test(r.tags?.route || "")).slice(0, 8);

      let towardsHome = false;
      for (const r of rels) {
        const orderedNodes = await fetchRelationMembersOrdered(r.id);
        if (!orderedNodes.length) continue;

        const idxS = orderedNodes.indexOf(s.id);
        if (idxS === -1) continue; // relation might not include this exact stop node

        for (let i = idxS + 1; i < orderedNodes.length; i++) {
          if (homeIds.has(orderedNodes[i])) { towardsHome = true; break; }
        }
        if (towardsHome) break;
      }
      if (towardsHome) hitIds.add(s.id);
    } catch {}
  }
  if (!hitIds.size) return await nameHeuristicHomeSet(stopsNearYou, home);
  return hitIds;
}

// Fallback name heuristic
async function nameHeuristicHomeSet(stops, home) {
  const tokens = (home.label || home.postcode || "")
    .toLowerCase().split(/[\s,]+/).filter(x => x.length > 2);
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

// ======= Stops (filter, routes, live times, best stop banner) =======
async function loadStops(lat,lng,radius=800){
  if (elStopsRadius) elStopsRadius.textContent = radius;
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

  let data;
  try { data = await overpass(q); }
  catch (e) {
    setHTML(elStopsList, `<div class="muted">Stops unavailable • ${escapeHtml(e.message||"")}</div>`);
    show(elStops); return;
  }

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

  // Clear any previous banner
  const bannerExisting = document.getElementById("best-stop-banner");
  if (bannerExisting) bannerExisting.remove();

  if (!stops.length) {
    setHTML(elStopsList, `
      <div class="muted" style="padding:8px;">
        No nearby stops found that are clearly heading toward Home.
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

  // Best stop banner (nearest)
  const best = stops[0];
  const banner = document.createElement("div");
  banner.id = "best-stop-banner";
  banner.style.cssText = "padding:10px; border:1px solid #e5e7eb; border-radius:12px; margin:8px 0 12px 0; box-shadow:0 6px 16px rgba(0,0,0,.06); background:linear-gradient(135deg,#0ea5e91a,#10b9811a);";

  // Next bus (live with fallback)
  let nextText = "n/a";
  try {
    const rows = await fetchLiveBusTimes(best.atco, best.kind);
    if (rows && rows.length) {
      const mins = rows.map(r => parseInt(String(r.due).replace(/\D+/g,""),10)).filter(n => !isNaN(n));
      if (mins.length) nextText = `${Math.min(...mins)} min`;
      else nextText = rows[0].due || "n/a";
    }
  } catch {}

  // Hourly 3 for best stop
  let hoursHTML = "";
  try { hoursHTML = renderHourly3Block(await fetchHourly3(best.pos[0], best.pos[1])); } catch {}

  banner.innerHTML = `
    <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
      <div>
        <div style="font-weight:800;">Best stop to get home</div>
        <div class="muted" style="font-size:12px;">${escapeHtml(best.name)} • ${miles(best.dist)} mi • ${best.kind === "bus" ? "Bus" : "Rail/Tram"}</div>
        <div style="margin-top:6px; font-weight:600;">Next bus: <span class="pill" style="background:#10b981; color:#fff;">${nextText}</span></div>
      </div>
      <div>
        <button class="btn" id="btn-route-best">Route</button>
      </div>
    </div>
    <div style="margin-top:8px;">${hoursHTML}</div>
  `;
  // Insert banner before the list
  elStopsList.parentNode.insertBefore(banner, elStopsList);

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

  // Per-stop tiny weather + hourly (throttled)
  await fillStopsWeather(stops);

  // OSM route labels + live times
  for (const s of stops) {
    getStopRouteLabels(s.id).then(labels => {
      const el = document.getElementById(`routes-${s.id}`);
      if (el && labels.length) el.textContent = `• Routes: ${labels.join(", ")}`;
    }).catch(()=>{});

    const liveEl = document.getElementById(`live-${s.id}`);
    fetchLiveBusTimes(s.atco, s.kind).then(rows => {
      if (!liveEl) return;
      if (!rows || !rows.length) { liveEl.textContent = "Live: n/a"; return; }
      liveEl.textContent = "Live: " + rows.map(r => `${r.line} → ${r.dir} (${r.due})`).join(" • ");
    }).catch(()=>{ if (liveEl) liveEl.textContent = "Live: n/a"; });
  }

  // Wire banner route button
  const btnBest = document.getElementById("btn-route-best");
  if (btnBest) {
    btnBest.onclick = async () => {
      hide(elErrors);
      try {
        const origin = await getOrigin();
        routeBetween(origin, best.pos);
      } catch (err) { showError(err.message || "Couldn’t start routing."); }
    };
  }

  // Wire route buttons per item
  [...elStopsList.querySelectorAll("button[data-route]")].forEach(btn => {
    btn.onclick = async () => {
      hide(elErrors);
      try {
        const origin = await getOrigin();
        const id = btn.getAttribute("data-route");
        const s = stops.find(x => x.id.toString() === id);
        if (!s) return;
        routeBetween(origin, s.pos);
      } catch (err) { showError(err.message || "Couldn’t start routing."); }
    };
  });
}

// Per-stop weather (current for many, hourly for nearest few)
async function fillStopsWeather(stops) {
  if (!OWM_KEY) {
    for (const s of stops) {
      const el = document.getElementById(`wx-${s.id}`);
      if (el) el.innerHTML = `<span class="pill">n/a</span>`;
    }
    return;
  }
  const MAX_CUR_FETCH = 10; // current wx
  const MAX_HOURLY3   = 5;  // hourly for nearest few
  let curRemaining = MAX_CUR_FETCH;
  let h3Remaining  = MAX_HOURLY3;

  for (const s of stops) {
    const el = document.getElementById(`wx-${s.id}`);
    if (!el) continue;

    let wx = wxNowCache.get(roundKey(s.pos[0], s.pos[1]));
    if (!wx && curRemaining > 0) {
      try {
        const w = await getJSON(`https://api.openweathermap.org/data/2.5/weather?lat=${s.pos[0]}&lon=${s.pos[1]}&units=metric&appid=${OWM_KEY}`);
        wx = { temp: Math.round(w?.main?.temp ?? 0), icon: w?.weather?.[0]?.icon };
        wxNowCache.set(roundKey(s.pos[0], s.pos[1]), wx);
        curRemaining--;
      } catch {}
    }

    let hoursBlock = "";
    if (h3Remaining > 0) {
      try {
        const hours = await fetchHourly3(s.pos[0], s.pos[1]);
        hoursBlock = renderHourly3Block(hours);
        h3Remaining--;
      } catch {}
    }

    if (wx && wx.icon != null) {
      el.innerHTML = `
        <div style="display:flex; gap:6px; align-items:center;">
          <img src="${iconUrl(wx.icon)}" alt="" width="32" height="32"/>
          <strong>${wx.temp}°C</strong>
        </div>
        ${hoursBlock}
      `;
    } else {
      el.innerHTML = `<span class="pill">n/a</span>${hoursBlock}`;
    }
  }
}

// ======= Live times with fallback: TransportAPI -> TfL =======
function looksLikeTflAtco(atco){ return typeof atco === "string" && /^490/.test(atco); }

// Returns array of { line, dir, due } (due in "X min" or "HH:MM" or "n/a")
async function fetchLiveBusTimes(atco, kind="bus") {
  if (!atco || kind !== "bus") return [];

  // Primary: TransportAPI if keys present
  if (TP_APP_ID && TP_APP_KEY) {
    try {
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
      out = out.slice(0, 6).map(x => {
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
        return { ...x, due: String(x.due || "n/a") };
      });
      if (out.length) return out;
    } catch { /* fall through to TfL */ }
  }

  // Fallback: TfL Unified API (London only; no key required)
  if (looksLikeTflAtco(atco)) {
    try {
      const url = `https://api.tfl.gov.uk/StopPoint/${encodeURIComponent(atco)}/Arrivals`;
      const arr = await getJSON(url);
      const sorted = (arr || []).sort((a,b) => (a.timeToStation||0) - (b.timeToStation||0));
      return sorted.slice(0, 6).map(x => ({
        line: x.lineName || x.lineId || "",
        dir: x.destinationName || "",
        due: (typeof x.timeToStation === "number") ? `${Math.max(0, Math.round(x.timeToStation/60))} min` : "n/a"
      }));
    } catch { /* no luck */ }
  }

  // No source available
  return [];
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
if (elBtnRouteHome) {
  elBtnRouteHome.onclick = async () => {
    const home = getHome(); if (!home) return showError("Set Home first (top bar).");
    hide(elErrors); hide(elRouteSummary);
    try {
      const origin = await getOrigin();
      routeBetween(origin, [home.lat, home.lon]);
    } catch (e) { showError(e.message || "Couldn’t start routing to Home."); }
  };
}
if (elBtnClearRoute) {
  elBtnClearRoute.onclick = () => { clearRoute(); hide(elDirections); hide(elRouteSummary); };
}

function clearRoute(){ if(routeLine) routeLine.remove(); routeLine=null; setHTML(elDirSteps,""); }

async function routeBetween(from,to){
  try { drawRoute(await routeOSRM(from, to)); }
  catch (e1) {
    if (ORS_KEY) {
      try { drawRoute(await routeORS(from, to, ORS_KEY)); }
      catch { showError("Routing failed (OSRM & ORS)."); }
    } else showError("Routing failed (OSRM). You can add an ORS key for fallback.");
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
    case "end of road": return `End of road, turn${mod}${dist}`;
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
if (elSearch) {
  elSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = elSearch.value.trim();
    if (q.length < 3) {
      hide(elResults);
      if (elResults) elResults.innerHTML = "";
      return;
    }
    searchTimer = setTimeout(() => doSearch(q), 350);
  });
}

async function doSearch(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`;
  try {
    const data = await getJSON(url, { "Accept-Language": "en" });
    if (!Array.isArray(data) || !data.length) {
      hide(elResults);
      if (elResults) elResults.innerHTML = "";
      return;
    }
    elResults.innerHTML = data.map(row => `
      <button data-lat="${row.lat}" data-lon="${row.lon}">
        ${row.display_name.replaceAll("&","&amp;")}
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

// Close results when clicking outside
document.addEventListener("click", (e) => {
  if (!elResults) return;
  if (!elResults.contains(e.target) && e.target !== elSearch) {
    hide(elResults);
  }
});

// ======= Home autocomplete =======
let homeTimer;
if (elHomeInput && elHomeResults) {
  elHomeInput.addEventListener("input", () => {
    clearTimeout(homeTimer);
    const q = elHomeInput.value.trim();
    if (!q || q.length < 3) {
      elHomeResults.style.display = "none";
      elHomeResults.innerHTML = "";
      return;
    }
    homeTimer = setTimeout(() => doHomeSearch(q), 350);
  });

  document.addEventListener("click", (e) => {
    if (!elHomeResults.contains(e.target) && e.target !== elHomeInput) {
      elHomeResults.style.display = "none";
    }
  });
}

async function doHomeSearch(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`;
  try {
    const data = await getJSON(url, { "Accept-Language": "en" });
    if (!Array.isArray(data) || !data.length) {
      elHomeResults.style.display = "none";
      elHomeResults.innerHTML = "";
      return;
    }
    elHomeResults.innerHTML = data.map(row => `
      <button data-lat="${row.lat}" data-lon="${row.lon}" data-display="${(row.display_name || "").replaceAll('"', "&quot;")}">
        ${row.display_name.replaceAll("&","&amp;")}
      </button>
    `).join("");
    elHomeResults.style.display = "";
    [...elHomeResults.querySelectorAll("button")].forEach(btn => {
      btn.onclick = () => {
        const lat = +btn.dataset.lat;
        const lon = +btn.dataset.lon;
        const display = btn.dataset.display || "";
        setHome({ lat, lon, label: display });
        elHomeInput.value = "";
        elHomeResults.style.display = "none";
        elHomeResults.innerHTML = "";
        if (selectedPoint) loadStops(selectedPoint[0], selectedPoint[1], 800);
      };
    });
  } catch {
    elHomeResults.style.display = "none";
  }
}

// ======= Generic helpers (bottom) =======
async function getJSON(u, h = {}) {
  const r = await fetch(u, { headers: { ...h } });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body && (body.message || body.cod)) {
        msg += ` — ${body.cod || ""} ${body.message || ""}`;
      }
    } catch {}
    throw new Error(msg);
  }
  return await r.json();
}
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation unsupported"));
    navigator.geolocation.getCurrentPosition(
      resolve,
      reject,
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}
function showError(m) {
  setHTML(elErrors, `⚠️ ${m}`);
  show(elErrors);
}
