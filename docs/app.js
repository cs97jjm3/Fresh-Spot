/* ===========================
   FreshStop - app.js (browser)
   ===========================
   Features:
   - First-time Home prompt (UK & Ireland-only search)
   - Start at browser location (fallback: saved Home → London)
   - Nearby stops via Overpass (mirrors, timeout, session cache)
   - Weather: Open-Meteo (no key)
   - “Best stop”: board + alight + walking via OSRM
   - FULL ROUTE: draws bus polyline (OSM relation by shared ref) between stops, with 🚌 label
   - Route badges with “+ more” expander
   - Share links for selection and best board/alight
   - No live arrivals (no proxy required)
*/

// ---- Config defaults (override in config.js) ----
window.CONFIG = Object.assign({
  HOME: { name: "Home", lat: 51.5074, lon: -0.1278 },
  OVERPASS_MIRRORS: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
  ],
  OSRM_URL: "https://router.project-osrm.org",
  SEARCH_RADIUS_M: 900,
  MAX_STOPS: 60,
  WALK_SPEED_MPS: 1.3,
  OVERPASS_TIMEOUT_MS: 9000,
  CACHE_TTL_MS: 5 * 60 * 1000, // 5 min session cache
  NAPTAN_URL: null // optional: set in config.js if you host a NaPTAN mini JSON
}, window.CONFIG || {});

// ---- Helpers ----
const el  = sel => document.querySelector(sel);
const fmtMins = mins => `${Math.round(mins)} min`;
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;
function debounce(fn, wait=300){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), wait);} }
function haversineMeters(a, b){
  const R=6371000, dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const la1=toRad(a.lat), la2=toRad(b.lat);
  const s=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
function bearingDeg(from, to){
  const φ1=toRad(from.lat), φ2=toRad(to.lat), λ1=toRad(from.lon), λ2=toRad(to.lon);
  const y=Math.sin(λ2-λ1)*Math.cos(φ2);
  const x=Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
  return (toDeg(Math.atan2(y,x))+360)%360;
}
function angleDiff(a,b){let d=Math.abs(a-b)%360;return d>180?360-d:d;}
function showError(msg){const box=el('#errors');if(!box)return;box.style.display='block';box.textContent=msg;setTimeout(()=>{box.style.display='none';},6000);}
function fmtCoord(lat, lon){ return `${lat.toFixed(4)}, ${lon.toFixed(4)}`; }
function nowMs(){ return Date.now(); }

// Skeleton
function skel(width='100%', height=14, radius=8, style=''){
  return `<div style="width:${width};height:${height}px;border-radius:${radius}px;background:linear-gradient(90deg,#f3f4f6 25%,#e5e7eb 37%,#f3f4f6 63%);background-size:400% 100%;animation:skel 1.2s ease infinite;${style}"></div>`;
}
(function injectSkelCSS(){
  if (document.getElementById('skel-anim')) return;
  const s=document.createElement('style'); s.id='skel-anim';
  s.textContent='@keyframes skel{0%{background-position:100% 0}100%{background-position:-100% 0}}';
  document.head.appendChild(s);
})();

// ---- URL share helpers ----
function makeShareURL(lat, lon, zoom = map ? map.getZoom() : 15){
  const u = new URL(location.href);
  u.searchParams.set('lat', lat.toFixed(5));
  u.searchParams.set('lon', lon.toFixed(5));
  u.searchParams.set('z', zoom);
  return u.toString();
}
async function copyToClipboard(text){
  try{ await navigator.clipboard.writeText(text); return true; }
  catch{ return false; }
}
function parseURLCenter(){
  const p = new URLSearchParams(location.search);
  const lat = parseFloat(p.get('lat'));
  const lon = parseFloat(p.get('lon'));
  const z = parseInt(p.get('z') || '15', 10);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, z: Number.isFinite(z)?z:15 };
  return null;
}

// ---- Cache (sessionStorage) ----
function cacheKey(kind, obj){ return `fs:${kind}:${JSON.stringify(obj)}`; }
function cacheGet(kind, obj){
  try{
    const raw = sessionStorage.getItem(cacheKey(kind,obj));
    if(!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (nowMs() - t > CONFIG.CACHE_TTL_MS) { sessionStorage.removeItem(cacheKey(kind,obj)); return null; }
    return v;
  }catch{ return null; }
}
function cacheSet(kind, obj, value){
  try{
    sessionStorage.setItem(cacheKey(kind,obj), JSON.stringify({ t: nowMs(), v: value }));
  }catch{/* quota full */}
}

// ---- Map / State ----
let map, userMarker, homeMarker, stopsLayer, routeLayer, bestPulsePin, alightRingPin;
let busLayer, busLabelMarker; // for bus segment + its label
let currentSelection = null; // {lat, lon, label?}
let home = {...CONFIG.HOME};
let lastBest = null; // { origin, board, alight, w1, w2 }

// ---- Map init ----
function initMap(center){
  if (map) return;
  map = L.map('map').setView([center.lat, center.lon], center.z || 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  homeMarker = L.marker([home.lat, home.lon], { title: 'Home' })
    .addTo(map)
    .bindPopup('Home');

  stopsLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);

  // Click to pin & share
  map.on('click', async e=>{
    const {lat,lng}=e.latlng;
    currentSelection = { lat, lon: lng, label: 'Selected point' };
    map.setView([lat,lng], Math.max(map.getZoom(), 15));
    await refreshSelection();
    await listNearbyStops();
  });
}

// ---- Weather (Open-Meteo) ----
async function getWeather(lat, lon){
  const url=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=temperature_2m,precipitation_probability,weathercode,wind_speed_10m&timezone=auto`;
  const r=await fetch(url); if(!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const j=await r.json();
  const W={
    0:{label:"Clear",icon:"☀️"},1:{label:"Mainly clear",icon:"🌤️"},2:{label:"Partly cloudy",icon:"⛅"},3:{label:"Overcast",icon:"☁️"},
    45:{label:"Fog",icon:"🌫️"},51:{label:"Drizzle",icon:"🌦️"},61:{label:"Rain light",icon:"🌦️"},
    63:{label:"Rain",icon:"🌧️"},65:{label:"Rain heavy",icon:"🌧️"},80:{label:"Showers",icon:"🌦️"},95:{label:"Thunderstorm",icon:"⛈️"}
  };
  const now=j.current_weather, idx=j.hourly.time.indexOf(now.time);
  const next3=[];
  for(let k=1;k<=3;k++){
    const i=idx+k;
    if(i<j.hourly.time.length){
      const code=j.hourly.weathercode[i];
      next3.push({
        time:j.hourly.time[i],
        temp:j.hourly.temperature_2m[i],
        pop:j.hourly.precipitation_probability?.[i]??null,
        ...(W[code]||{label:"—",icon:"🌡️"})
      });
    }
  }
  return { now:{ time: now.time, temp: now.temperature, ...(W[now.weathercode]||{label:"—",icon:"🌡️"}) }, next3 };
}
async function renderWeather(container, lat, lon){
  try{
    const w=await getWeather(lat, lon);
    container.innerHTML = `<div class="stop-wx" style="display:flex;gap:.5rem;align-items:center;"><span>${w.now.icon}</span> <span><strong>${w.now.temp}°C</strong> • ${w.now.label}</span></div>`;
  }catch{ container.innerHTML=skel('80%',14,6); }
}
async function renderMiniForecast(container, lat, lon){
  try{
    const w=await getWeather(lat, lon);
    container.innerHTML = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;">
        ${w.next3.map(h=>`
          <div style="font-size:12px;display:flex;flex-direction:column;gap:2px;min-width:84px;">
            <div class="muted">${new Date(h.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
            <div>${h.icon} ${Math.round(h.temp)}°C${h.pop!=null?` • ${h.pop}%`:''}</div>
          </div>`).join('')}
      </div>`;
  }catch{ container.innerHTML = skel('90%',14,6); }
}

// ---- Overpass (with retries + cache) ----
async function fetchWithTimeout(url, opts={}, timeoutMs=CONFIG.OVERPASS_TIMEOUT_MS){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(), timeoutMs);
  try{ return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally{ clearTimeout(t); }
}
async function overpassJSON(query, cacheKind=null, cacheKeyObj=null){
  if (cacheKind && cacheKeyObj) {
    const c = cacheGet(cacheKind, cacheKeyObj);
    if (c) return c;
  }
  const body="data="+encodeURIComponent(query);
  let lastErr=null, json=null;
  for (const base of CONFIG.OVERPASS_MIRRORS) {
    try{
      const r = await fetchWithTimeout(base, {
        method:"POST",
        headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},
        body
      });
      if (!r.ok) { lastErr = new Error(`Overpass ${r.status} at ${base}`); continue; }
      json = await r.json();
      break;
    }catch(e){ lastErr = e; }
  }
  if (!json) throw lastErr || new Error("Overpass failed");
  if (cacheKind && cacheKeyObj) cacheSet(cacheKind, cacheKeyObj, json);
  return json;
}

// ---- Optional: NaPTAN mini JSON (if provided) ----
let NAPTAN_DATA = null;
async function loadNaPTAN() {
  if (NAPTAN_DATA || !CONFIG.NAPTAN_URL) return;
  const r = await fetch(CONFIG.NAPTAN_URL, { cache: "force-cache" });
  if (!r.ok) throw new Error("NaPTAN load failed");
  NAPTAN_DATA = await r.json();
}
function stopsInBbox(data, latMin, latMax, lonMin, lonMax, limit=CONFIG.MAX_STOPS) {
  const out = [];
  for (const s of data) {
    if (s.lat >= latMin && s.lat <= latMax && s.lon >= lonMin && s.lon <= lonMax) {
      out.push({
        id: s.atcoCode,
        name: s.name || "Bus stop",
        lat: s.lat, lon: s.lon,
        ref: s.atcoCode,
        indicator: s.indicator || null,
        area: s.stopAreaCode || null
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}
async function fetchStopsAroundNaPTAN(lat, lon, radiusM = CONFIG.SEARCH_RADIUS_M) {
  await loadNaPTAN();
  if (!NAPTAN_DATA) throw new Error("NaPTAN unavailable");
  const dLat = radiusM / 111000;
  const dLon = radiusM / (111000 * Math.cos(lat * Math.PI/180));
  const box = stopsInBbox(NAPTAN_DATA, lat - dLat, lat + dLat, lon - dLon, lon + dLon, CONFIG.MAX_STOPS);
  box.sort((a,b)=> haversineMeters({lat,lon},a) - haversineMeters({lat,lon},b));
  return box;
}

// ---- Stops via Overpass ----
async function fetchStopsAround(lat, lon, radiusM=CONFIG.SEARCH_RADIUS_M){
  const key = { lat: +lat.toFixed(4), lon: +lon.toFixed(4), r: radiusM };
  const q=`[out:json][timeout:25];
    (
      node(around:${radiusM},${lat},${lon})["highway"="bus_stop"];
      node(around:${radiusM},${lat},${lon})["public_transport"="platform"]["bus"="yes"];
    );
    out body ${Math.min(CONFIG.MAX_STOPS,200)};`;
  const j = await overpassJSON(q, 'stops', key);
  return (j.elements||[]).map(n=>({
    id:n.id,
    name:n.tags?.name||"Bus stop",
    lat:n.lat, lon:n.lon,
    ref:n.tags?.ref||n.tags?.naptan||n.tags?.naptan_code||null
  }));
}
async function fetchStopsAroundExtended(lat, lon, radiusM = CONFIG.SEARCH_RADIUS_M) {
  const key = { lat: +lat.toFixed(4), lon: +lon.toFixed(4), r: radiusM, ext:true };
  const q = `[out:json][timeout:25];
    (
      node(around:${radiusM},${lat},${lon})["highway"="bus_stop"];
      node(around:${radiusM},${lat},${lon})["public_transport"="platform"]["bus"="yes"];
      node(around:${radiusM},${lat},${lon})["amenity"="bus_station"];
    );
    out body ${Math.min(CONFIG.MAX_STOPS, 300)};`;
  const j = await overpassJSON(q, 'stops', key);
  return (j.elements || []).map(n => ({
    id: n.id,
    name: n.tags?.name || (n.tags?.amenity === 'bus_station' ? 'Bus Station' : 'Bus stop'),
    lat: n.lat, lon: n.lon,
    ref: n.tags?.ref || n.tags?.naptan || n.tags?.naptan_code || null,
    kind: n.tags?.amenity === 'bus_station' ? 'bus_station' : 'stop'
  }));
}

// ---- Lines for a stop (route relations via nearby PT members) ----
const LINES_MEMO = new Map(); // stopId -> lines[]
const MODE_ICON = m => ({
  bus:'🚌', trolleybus:'🚎', tram:'🚊', train:'🚆',
  light_rail:'🚈', subway:'🚇'
}[m] || '🚌');
function uniqBy(arr, key) { const s=new Set(), out=[]; for(const x of arr){const k=key(x); if(s.has(k))continue; s.add(k); out.push(x);} return out; }

async function fetchStopLines(stop){
  if (LINES_MEMO.has(stop.id)) return LINES_MEMO.get(stop.id);

  const q = `[out:json][timeout:25];
    node(${stop.id})->.s;
    (
      node(around.s:60)["public_transport"];
      way(around.s:60)["public_transport"];
    )->.pt;
    rel(bn.pt)["type"="route"]["route"~"bus|trolleybus|tram|train|light_rail|subway"];
    out tags;`;
  let j=null; 
  try { j = await overpassJSON(q, 'lines', { stop: stop.id }); }
  catch(e){ console.warn('lines fail', e); LINES_MEMO.set(stop.id, []); return []; }

  const items = (j.elements||[])
    .map(rel => {
      const t = rel.tags || {};
      const ref = t.ref || t['ref:short'] || '';
      const name = t.name || '';
      return {
        id: rel.id,
        mode: t.route || 'bus',
        ref: ref || (name ? name.split(' ')[0] : ''),
        name,
        network: t.network || ''
      };
    })
    .filter(x => x.ref || x.name);

  const clean = uniqBy(items, x => `${x.mode}|${x.ref || x.name}`);
  LINES_MEMO.set(stop.id, clean);
  return clean;
}

// ---- Lines badges with "+ more" expander ----
function linesBadgesHTML(lines, opts={}){
  const max = opts.max || 10;
  const id = opts.id || ('lnc_'+Math.random().toString(36).slice(2,8));
  if (!lines || !lines.length) return `<span class="muted">No routes listed</span>`;

  const collapsed = lines.slice(0, max);
  const hidden = lines.slice(max);

  const badge = l => `
    <span class="pill" title="${(l.name || l.network || '').replace(/"/g,'&quot;')}">
      ${MODE_ICON(l.mode)} ${l.ref || (l.name || '').split(' ')[0]}
    </span>`;

  if (!hidden.length) {
    return `<div id="${id}" class="lines-badges" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">
      ${collapsed.map(badge).join('')}
    </div>`;
  }
  return `
    <div id="${id}" class="lines-badges" data-collapsed="1" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">
      ${collapsed.map(badge).join('')}
      <button class="btn" style="padding:2px 8px;font-size:12px;border-radius:999px;" onclick="toggleLines('${id}', ${max})">+ ${hidden.length} more</button>
      <span class="more" style="display:none;">${hidden.map(badge).join('')}</span>
    </div>`;
}
window.toggleLines = function(id, max){
  const box = document.getElementById(id);
  if (!box) return;
  const collapsed = box.getAttribute('data-collapsed') !== '0';
  const btn = box.querySelector('button');
  const more = box.querySelector('.more');
  if (!btn || !more) return;
  if (collapsed) {
    more.style.display = 'contents';
    btn.textContent = 'Show less';
    box.setAttribute('data-collapsed','0');
  } else {
    more.style.display = 'none';
    btn.textContent = '+ more';
    box.setAttribute('data-collapsed','1');
  }
};

// ---- FULL ROUTE: bus polyline between stops by shared ref ----
function waysToFeatureCollection(ways){
  return {
    type: "FeatureCollection",
    features: ways.map(w => ({
      type: "Feature",
      properties: { osmid: w.id },
      geometry: {
        type: "LineString",
        coordinates: (w.geometry || []).map(p => [p.lon, p.lat])
      }
    }))
  };
}
async function fetchRelationWaysByRefNear(ref, board, alight){
  const around = 120; // meters
  const q = `[out:json][timeout:25];
    node(around:${around},${board.lat},${board.lon})->.B;
    node(around:${around},${alight.lat},${alight.lon})->.A;
    rel["type"="route"]["route"="bus"]["ref"="${ref}"](bn.B)->.RB;
    rel["type"="route"]["route"="bus"]["ref"="${ref}"](bn.A)->.RA;
    (.RB;.RA;)->.R;
    way(r.R);
    out geom;`;
  const j = await overpassJSON(q, 'busGeom', { ref, b:[board.lat,board.lon].map(n=>+n.toFixed(4)), a:[alight.lat,alight.lon].map(n=>+n.toFixed(4)) });
  return (j.elements || []).filter(e => e.type === 'way' && Array.isArray(e.geometry));
}
function clearBusLayer(){
  if (busLayer) { routeLayer.removeLayer(busLayer); busLayer = null; }
  if (busLabelMarker) { routeLayer.removeLayer(busLabelMarker); busLabelMarker = null; }
}
async function drawBusPolylineBetween(board, alight, ref){
  clearBusLayer();
  try{
    if (!ref) throw new Error('no ref');
    const ways = await fetchRelationWaysByRefNear(ref, board, alight);
    if (!ways.length) throw new Error('No geometry for this ref nearby');
    const fc = waysToFeatureCollection(ways);
    busLayer = L.geoJSON(fc, { color:'#3b82f6', weight:4, opacity:0.9, dashArray:'4 2' }).addTo(routeLayer);
    return true;
  }catch(e){
    console.warn('Bus polyline fallback:', e.message);
    const seg = {
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[board.lon,board.lat],[alight.lon,alight.lat]] }
    };
    busLayer = L.geoJSON(seg, { color:'#3b82f6', weight:4, opacity:0.8, dashArray:'6 6' }).addTo(routeLayer);
    return false;
  }
}
function addBusRefLabel(board, alight, ref){
  if (!ref) return;
  // Midpoint along straight line for a simple label placement
  const midLat = (board.lat + alight.lat)/2;
  const midLon = (board.lon + alight.lon)/2;
  busLabelMarker = L.marker([midLat, midLon], {
    interactive:false,
    icon: L.divIcon({
      className: '',
      html:`<div class="pill" style="background:#dbeafe;border:1px solid #bfdbfe;font-size:12px;">🚌 ${ref}</div>`
    })
  }).addTo(routeLayer);
}

// ---- Best stops logic (smart alight pref) ----
async function findBestPair(origin, home) {
  // prefer NaPTAN if available
  let nearOrigin = [];
  try {
    if (CONFIG.NAPTAN_URL) nearOrigin = await fetchStopsAroundNaPTAN(origin.lat, origin.lon);
  } catch {}
  if (!nearOrigin.length) nearOrigin = await fetchStopsAround(origin.lat, origin.lon);

  let nearHome0 = [];
  try {
    if (CONFIG.NAPTAN_URL) nearHome0 = await fetchStopsAroundNaPTAN(home.lat, home.lon);
  } catch {}
  if (!nearHome0.length) nearHome0 = await fetchStopsAroundExtended(home.lat, home.lon, CONFIG.SEARCH_RADIUS_M);

  // widen home search if sparse
  let nearHome = nearHome0;
  if (nearHome.length < 3) nearHome = await fetchStopsAroundExtended(home.lat, home.lon, CONFIG.SEARCH_RADIUS_M * 2);
  if (nearHome.length < 3) nearHome = await fetchStopsAroundExtended(home.lat, home.lon, CONFIG.SEARCH_RADIUS_M * 3.3);

  if (!nearOrigin.length) throw new Error("No stops near origin");
  if (!nearHome.length)   throw new Error("No stops near home");

  // Board: close + aligned toward home
  const homeBrng = bearingDeg(origin, home);
  const board = nearOrigin
    .map(s => ({
      s,
      score: haversineMeters(origin, s) + angleDiff(bearingDeg(s, home), homeBrng) * 3
    }))
    .sort((a,b)=> a.score - b.score)[0].s;

  // Alight: strong preference by name ("Horsefair", "Bus Station", "Interchange"), else nearest
  const nameBoost = (nm='') => {
    const n = nm.toLowerCase();
    if (n.includes('horsefair')) return -800;
    if (n.includes('bus station') || n.includes('interchange')) return -250;
    return 0;
  };
  let alight = nearHome
    .filter(s => s.id !== board.id)
    .map(s => ({ s, score: haversineMeters(home, s) + nameBoost(s.name) }))
    .sort((a,b)=> a.score - b.score)[0]?.s;

  if (!alight || (!/horsefair|bus station|interchange/i.test(alight.name) && haversineMeters(home, alight) > 250)) {
    const q = `[out:json][timeout:25];
      (
        node(around:${Math.round(CONFIG.SEARCH_RADIUS_M*3.3)},${home.lat},${home.lon})["name"~"(?i)horsefair|bus station|interchange"]["public_transport"];
        node(around:${Math.round(CONFIG.SEARCH_RADIUS_M*3.3)},${home.lat},${home.lon})["name"~"(?i)horsefair|bus station|interchange"]["amenity"="bus_station"];
      );
      out body 50;`;
    try {
      const j = await overpassJSON(q, 'nameTarget', { home: [home.lat,home.lon].map(n=>+n.toFixed(4)), r: Math.round(CONFIG.SEARCH_RADIUS_M*3.3) });
      const cand = (j.elements||[])
        .map(n => ({ id:n.id, name:n.tags?.name||'Stop', lat:n.lat, lon:n.lon, ref:n.tags?.ref||null }))
        .sort((a,b)=> haversineMeters(home,a) - haversineMeters(home,b))[0];
      if (cand) alight = cand;
    } catch(e){ /* ignore */ }
  }

  if (!alight) {
    alight = nearHome.sort((a,b)=>haversineMeters(home,a)-haversineMeters(home,b))[0];
  }

  return { board, alight };
}

// ---- OSRM ----
async function getWalkRoute(from, to){
  const u=`${CONFIG.OSRM_URL}/route/v1/foot/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=false`;
  const r=await fetch(u); if(!r.ok) throw new Error(`OSRM ${r.status}`); const j=await r.json();
  const route=j.routes?.[0]; if(!route) throw new Error("No route");
  return { geojson: route.geometry, distance_m: route.distance, duration_s: route.duration };
}
function clearRoute(){ routeLayer.clearLayers(); clearBusLayer(); }
function drawGeoJSON(geojson, style={}){ routeLayer.addLayer(L.geoJSON(geojson, Object.assign({weight:5, opacity:.85}, style))); }
function writeDirections(html){ const card=el('#directions'); if(!card)return; el('#directions-steps').innerHTML=html||''; card.style.display=html?'block':'none'; }
function writeWalkSummary(w1, w2, board, alight){
  const steps=[];
  if(board) steps.push(`<div class="dir-step"><strong>Board at:</strong> ${board.name}</div>`);
  if(w1) steps.push(`<div class="dir-step">Walk to stop: ${fmtMins(w1.duration_s/60)}</div>`);
  if(alight) steps.push(`<div class="dir-step"><strong>Alight at:</strong> ${alight.name}</div>`);
  if(w2) steps.push(`<div class="dir-step">Walk home: ${fmtMins(w2.duration_s/60)}</div>`);
  steps.push(`<div class="muted" style="font-size:12px;">(Live bus times removed; this shows walking only. Bus path is indicative.)</div>`);
  writeDirections(steps.join(''));
}

// ---- Popups (template + enhancer) ----
function popupTemplate(stop){
  return `
    <div class="popup">
      <div style="font-weight:600;margin-bottom:4px;">${stop.name}${stop.ref?` <small>(${stop.ref})</small>`:''}</div>
      <div class="weather">${skel('60%',14,6,'margin:4px 0')}</div>
      <div class="lines">${skel('90%',14,6)}</div>
    </div>`;
}
async function enhanceStopPopup(marker, stop){
  const p=marker.getPopup(); if(!p) return;
  const root=p.getElement(); if(!root) return;
  const wEl=root.querySelector('.weather'); if(wEl) renderWeather(wEl, stop.lat, stop.lon);

  const linesEl = root.querySelector('.lines');
  if (linesEl) {
    try {
      const lines = await fetchStopLines(stop);
      const id = 'pl_'+stop.id;
      linesEl.innerHTML = `<div><strong>Served by</strong></div>${linesBadgesHTML(lines, { id, max: 10 })}`;
    } catch {
      linesEl.innerHTML = `<em class="muted">Routes unavailable</em>`;
    }
  }
}
function bindPopupWithEnhancement(marker, stop){
  marker.bindPopup(popupTemplate(stop));
  marker.on('popupopen', () => enhanceStopPopup(marker, stop));
  return marker;
}

// ---- Selection + Stops list ----
async function refreshSelection(){
  const card=el('#selection'); if(!card) return;
  if(!currentSelection){ card.style.display='none'; card.innerHTML=''; return; }
  const {lat,lon,label}=currentSelection;
  const shareURL = makeShareURL(lat, lon);
  card.style.display='block';
  card.innerHTML=`
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
      <div>
        <strong>${label||'Point'}</strong><br>
        <span class="muted" style="font-size:12px">${lat.toFixed(5)}, ${lon.toFixed(5)}</span>
      </div>
      <button class="btn" id="btn-share-pin" title="Copy a link to this pin">Share</button>
    </div>`;
  const btn = el('#btn-share-pin');
  if (btn) btn.onclick = async ()=>{
    const ok = await copyToClipboard(shareURL);
    btn.textContent = ok ? 'Copied!' : 'Link ready';
    setTimeout(()=> btn.textContent='Share', 1700);
    history.replaceState({}, '', shareURL);
  };
}
async function listNearbyStops(){
  const card=el('#stops'); const listEl=el('#stops-list'); const radiusEl=el('#stops-radius');
  if(!card || !listEl) return;
  const center=currentSelection || {lat:home.lat, lon:home.lon};
  card.style.display='block'; if(radiusEl) radiusEl.textContent=String(CONFIG.SEARCH_RADIUS_M);
  let stops=[];
  try{
    if (CONFIG.NAPTAN_URL) {
      stops = await fetchStopsAroundNaPTAN(center.lat, center.lon);
    }
    if (!stops.length) {
      stops = await fetchStopsAround(center.lat, center.lon);
    }
  } catch(e){ showError("Couldn’t load stops (network busy). Try again in a moment."); }
  stopsLayer.clearLayers(); listEl.innerHTML='';
  for(const s of stops){
    bindPopupWithEnhancement(L.marker([s.lat,s.lon],{title:s.name}).addTo(stopsLayer), s);
    const item=document.createElement('div'); item.className='stop-item';
    const id = 'ln_'+s.id;
    item.innerHTML=`<div class="stop-left">
      <div class="stop-name">${s.name}</div>
      <span class="stop-kind kind-bus">Bus</span>
      ${s.ref?`<span class="pill">${s.ref}</span>`:''}
    </div>
    <div class="stop-wx" id="wx-${s.id}">${skel('80%',14,6)}</div>
    <div class="stop-lines" id="${id}" style="grid-column:1/-1;">${skel('95%',14,6,'margin-top:4px;')}</div>`;
    listEl.appendChild(item);

    const wxEl=item.querySelector(`#wx-${s.id}`); renderWeather(wxEl, s.lat, s.lon).catch(()=>{});
    fetchStopLines(s).then(lines=>{
      el('#'+id).innerHTML = `<div class="muted" style="font-size:12px;">Routes:</div>${linesBadgesHTML(lines, { id, max: 10 })}`;
    }).catch(()=> el('#'+id).innerHTML = `<span class="muted">Routes unavailable</span>`);
  }
  return stops;
}

// ---- Only: Set Home search (UK + Ireland) ----
async function geocode(text){
  const url=`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(text)}&addressdetails=1&limit=5&countrycodes=gb,ie`;
  const r=await fetch(url,{headers:{'Accept':'application/json','Accept-Language':'en-GB'}}); 
  if(!r.ok) throw new Error('Search failed');
  const j=await r.json(); return j.map(x=>({lat:+x.lat, lon:+x.lon, label:x.display_name}));
}
function wireHomeSearch(){
  const homeInput=el('#home-input'), homeDrop=el('#home-results');
  if(!homeInput || !homeDrop) return;

  const renderDrop=(root, items, onPick)=>{
    if(!items.length){ root.style.display='none'; root.innerHTML=''; return; }
    root.innerHTML = items.map((r,i)=>`<button data-i="${i}">${r.label}</button>`).join('');
    root.style.display='block';
    Array.from(root.querySelectorAll('button')).forEach(b=>{
      b.onclick=()=>onPick(items[+b.dataset.i]);
    });
  };

  homeInput.addEventListener('input', debounce(async ()=>{
    const q=homeInput.value.trim();
    if(q.length<2){ homeDrop.style.display='none'; return; }
    try{
      const res=await geocode(q);
      renderDrop(homeDrop, res, async pick=>{
        homeDrop.style.display='none';
        setHome({ name: pick.label, lat: pick.lat, lon: pick.lon });
        await listNearbyStops();
        if (lastBest) await renderBestCard(lastBest);
        hideHomeOverlay();
      });
    }catch{ showError('Home search failed.'); }
  }, 350));
}

// ---- Home persistence + pill (with input toggle) ----
function loadHome(){
  const raw=localStorage.getItem('freshstop.home');
  if(!raw) return;
  try{
    const h=JSON.parse(raw);
    home = {
      name: (typeof h?.name==='string' && h.name.trim()) ? h.name : 'Home',
      lat: Number(h?.lat) || CONFIG.HOME.lat,
      lon: Number(h?.lon) || CONFIG.HOME.lon
    };
  }catch{/* keep default */}
}
function setHome(h){
  home = {
    name: (h && typeof h.name==='string' && h.name.trim()) ? h.name : 'Home',
    lat: Number(h.lat),
    lon: Number(h.lon)
  };
  localStorage.setItem('freshstop.home', JSON.stringify(home));
  updateHomeUI();
}
function updateHomeUI(){
  const pill = el('#home-pill');
  const input = el('#home-input');

  const displayName = String(home?.name || 'Home');
  const first = displayName.split(',')[0];

  if (pill) {
    pill.textContent = `🏠 ${first} (${(home?.lat ?? 0).toFixed(3)}, ${(home?.lon ?? 0).toFixed(3)})`;
    pill.style.display = 'inline-block';
    pill.onclick = () => {
      pill.style.display = 'none';
      if (input) { input.style.display = 'inline-block'; input.focus(); }
    };
  }
  if (input) {
    input.style.display = (home && Number.isFinite(home.lat) && Number.isFinite(home.lon)) ? 'none' : 'inline-block';
  }

  if (homeMarker && Number.isFinite(home?.lat) && Number.isFinite(home?.lon)) {
    homeMarker.setLatLng([home.lat, home.lon]).setPopupContent('Home');
  }
}

// ---- Home overlay (first-time prompt) ----
function showHomeOverlay(){
  if (document.getElementById('home-overlay')) return;
  const d = document.createElement('div');
  d.id = 'home-overlay';
  d.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999;`;
  d.innerHTML = `
    <div class="card" style="max-width:520px;width:92%;padding:16px;border-radius:16px;">
      <div style="font-weight:700;font-size:18px;margin-bottom:6px;">Set your Home</div>
      <div class="muted" style="margin-bottom:10px;">To pick the best stop, tell us where “Home” is. (UK & Ireland only)</div>
      <div class="row" style="gap:8px;">
        <input id="home-overlay-input" type="text" placeholder="e.g. PE13 2PR or address" style="flex:1;padding:10px;border-radius:10px;border:1px solid #e5e7eb;"/>
        <button class="btn primary" id="home-overlay-close">Skip</button>
      </div>
      <div id="home-overlay-results" class="dropdown" style="display:none;margin-top:6px;"></div>
    </div>`;
  document.body.appendChild(d);

  const input = d.querySelector('#home-overlay-input');
  const drop = d.querySelector('#home-overlay-results');
  const close= d.querySelector('#home-overlay-close');
  const renderDrop=(root, items, onPick)=>{
    if(!items.length){ root.style.display='none'; root.innerHTML=''; return; }
    root.innerHTML = items.map((r,i)=>`<button data-i="${i}">${r.label}</button>`).join('');
    root.style.display='block';
    Array.from(root.querySelectorAll('button')).forEach(b=>{
      b.onclick=()=>onPick(items[+b.dataset.i]);
    });
  };
  input.addEventListener('input', debounce(async ()=>{
    const q=input.value.trim();
    if(q.length<2){ drop.style.display='none'; return; }
    try{
      const res=await geocode(q);
      renderDrop(drop, res, async pick=>{
        drop.style.display='none';
        setHome({ name: pick.label, lat: pick.lat, lon: pick.lon });
        if (map) { map.setView([pick.lat, pick.lon], 15); homeMarker.setLatLng([pick.lat, pick.lon]); }
        await listNearbyStops(); hideHomeOverlay();
      });
    }catch{/* ignore */}
  }, 300));
  close.onclick = ()=> hideHomeOverlay();
}
function hideHomeOverlay(){
  const d = document.getElementById('home-overlay');
  if (d) d.remove();
}

// ---- Best card (weather + forecast + routes + share) ----
function ensureBestCard(){
  if (el('#beststop')) return el('#beststop');
  const asideStack = document.querySelector('aside .stack');
  if (!asideStack) return null;
  const card = document.createElement('div');
  card.id = 'beststop';
  card.className = 'card';
  card.style.display = 'none';
  asideStack.insertBefore(card, el('#stops') || asideStack.firstChild);
  return card;
}
async function renderBestCard(best){
  const card = ensureBestCard(); if (!card) return;
  if (!best) { card.style.display='none'; card.innerHTML=''; return; }

  const { board, alight, w1, w2 } = best;
  const walkToStop = w1 ? fmtMins(w1.duration_s/60) : '—';
  const walkHome   = w2 ? fmtMins(w2.duration_s/60) : '—';

  const [boardLines, alightLines] = await Promise.all([
    fetchStopLines(board).catch(()=>[]),
    fetchStopLines(alight).catch(()=>[])
  ]);

  const boardShare = makeShareURL(board.lat, board.lon);
  const alightShare= makeShareURL(alight.lat, alight.lon);

  const idB = 'best-ln-b-'+board.id;
  const idA = 'best-ln-a-'+alight.id;

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <div style="font-weight:700;display:flex;align-items:center;gap:8px;">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:#22c55e;color:#fff;">★</span>
        Best stop to get home
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn" id="best-focus-board">Board on map</button>
        <button class="btn" id="best-focus-alight">Alight on map</button>
      </div>
    </div>

    <div class="grid2" style="align-items:start;">
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div style="font-weight:600;margin-bottom:4px;">Board: ${board.name}</div>
          <button class="btn" id="share-board" title="Copy link to Board">Share</button>
        </div>
        <div class="muted" style="font-size:12px;margin-bottom:6px;">${fmtCoord(board.lat, board.lon)}</div>
        <div id="best-wx-board" style="margin:2px 0">${skel('60%',14,6)}</div>
        <div class="mini-forecast" id="best-forecast-board">${skel('90%',14,6)}</div>
        <div style="margin-top:6px;">
          <div class="muted" style="font-size:12px;">Routes:</div>
          ${linesBadgesHTML(boardLines, { id: idB, max: 10 })}
        </div>
        <div class="kv" style="margin-top:8px;"><span>Walk to stop</span><span><strong>${walkToStop}</strong></span></div>
      </div>

      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div style="font-weight:600;margin-bottom:4px;">Alight: ${alight.name}</div>
          <button class="btn" id="share-alight" title="Copy link to Alight">Share</button>
        </div>
        <div class="muted" style="font-size:12px;margin-bottom:6px;">${fmtCoord(alight.lat, alight.lon)}</div>
        <div id="best-wx-alight" style="margin:2px 0">${skel('60%',14,6)}</div>
        <div class="mini-forecast" id="best-forecast-alight">${skel('90%',14,6)}</div>
        <div style="margin-top:6px;">
          <div class="muted" style="font-size:12px;">Routes:</div>
          ${linesBadgesHTML(alightLines, { id: idA, max: 10 })}
        </div>
        <div class="kv" style="margin-top:8px;"><span>Walk home</span><span><strong>${walkHome}</strong></span></div>
        <div class="muted" style="font-size:12px;margin-top:6px;">(Live bus times removed; walking only.)</div>
      </div>
    </div>
  `;
  card.style.display = 'block';

  const wxBoard = card.querySelector('#best-wx-board');
  const wxAlight = card.querySelector('#best-wx-alight');
  const fcBoard = card.querySelector('#best-forecast-board');
  const fcAlight= card.querySelector('#best-forecast-alight');
  if (wxBoard)  renderWeather(wxBoard,  board.lat,  board.lon).catch(()=>{});
  if (wxAlight) renderWeather(wxAlight, alight.lat, alight.lon).catch(()=>{});
  if (fcBoard)  renderMiniForecast(fcBoard,  board.lat,  board.lon).catch(()=>{});
  if (fcAlight) renderMiniForecast(fcAlight, alight.lat, alight.lon).catch(()=>{});

  const fb = el('#best-focus-board');
  const fa = el('#best-focus-alight');
  if (fb) fb.onclick = () => {
    map.setView([board.lat, board.lon], 16);
    if (bestPulsePin) bestPulsePin.openPopup();
  };
  if (fa) fa.onclick = () => {
    map.setView([alight.lat, alight.lon], 16);
    if (alightRingPin) alightRingPin.openPopup();
  };

  const sb = el('#share-board');
  const sa = el('#share-alight');
  if (sb) sb.onclick = async ()=>{
    const ok = await copyToClipboard(boardShare);
    sb.textContent = ok ? 'Copied!' : 'Link ready';
    setTimeout(()=> sb.textContent='Share', 1500);
  };
  if (sa) sa.onclick = async ()=>{
    const ok = await copyToClipboard(alightShare);
    sa.textContent = ok ? 'Copied!' : 'Link ready';
    setTimeout(()=> sa.textContent='Share', 1500);
  };
}

// ---- Buttons ----
function wireButtons(){
  const btnLoc = el('#btn-my-location');
  if (btnLoc) btnLoc.onclick = async ()=>{
    try {
      const pos = await getBrowserLocation();
      currentSelection = pos;
      map.setView([pos.lat, pos.lon], 15);
      if (!userMarker) userMarker = L.marker([pos.lat, pos.lon], { title:'You' }).addTo(map).bindPopup('You are here');
      else userMarker.setLatLng([pos.lat, pos.lon]);
      await refreshSelection();
      await listNearbyStops();
    } catch { showError('Could not get your location.'); }
  };

  const btnBest = el('#btn-best-stop'), bestLabel = el('#best-label');
  if (btnBest) btnBest.onclick = async ()=>{
    const origin = currentSelection
      || (userMarker ? { lat:userMarker.getLatLng().lat, lon:userMarker.getLatLng().lng } : null)
      || home;

    let pair;
    try { pair = await findBestPair(origin, home); }
    catch (e) { showError(e.message || 'Could not find suitable stops.'); return; }
    const { board, alight } = pair;

    // Draw walking legs
    clearRoute();
    let w1=null, w2=null;
    try { w1 = await getWalkRoute(origin, board); drawGeoJSON(w1.geojson, { color:'#22c55e' }); } catch {}
    try { w2 = await getWalkRoute(alight, home); drawGeoJSON(w2.geojson, { color:'#ef4444' }); } catch {}
    writeWalkSummary(w1, w2, board, alight);

    // Save + render Best card
    lastBest = { origin, board, alight, w1, w2 };
    await renderBestCard(lastBest);

    // Remove previous markers
    if (bestPulsePin) { map.removeLayer(bestPulsePin); bestPulsePin = null; }
    if (alightRingPin) { map.removeLayer(alightRingPin); alightRingPin = null; }

    // Board: green pulsing + popup
    bestPulsePin = bindPopupWithEnhancement(L.marker([board.lat, board.lon], {
      icon: L.divIcon({
        className: '',
        html: `
          <div style="width:22px;height:22px;background:#22c55e;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 10px rgba(0,0,0,.25);position:relative;">
            <div style="position:absolute;left:50%;top:50%;width:22px;height:22px;transform:translate(-50%,-50%);border-radius:50%;border:2px solid rgba(34,197,94,.6);animation:pulse 1.6s ease-out infinite;"></div>
          </div>
        `,
        iconSize: [22,22],
        iconAnchor: [11,11]
      })
    }).addTo(map), board);
    bestPulsePin.openPopup();

    // Alight: red ring + popup
    alightRingPin = bindPopupWithEnhancement(L.marker([alight.lat, alight.lon], {
      title: `Alight: ${alight.name}`,
      icon: L.divIcon({
        className: '',
        html: `<div style="width:22px;height:22px;border:3px solid #ef4444;border-radius:50%;background:rgba(239,68,68,0.12);box-shadow:0 2px 10px rgba(0,0,0,.15);"></div>`,
        iconSize: [22,22],
        iconAnchor: [11,11]
      })
    }).addTo(map), alight);

    // Try to find a shared bus route ref between board and alight
    let sharedRef = null;
    try {
      const [boardLines, alightLines] = await Promise.all([
        fetchStopLines(board),
        fetchStopLines(alight)
      ]);
      const boardBus = boardLines.filter(l => l.mode === 'bus' && l.ref);
      const alightBus= alightLines.filter(l => l.mode === 'bus' && l.ref);
      const alightSet = new Set(alightBus.map(l => `${l.ref}|${l.network||''}`));
      const hit = boardBus.find(l => alightSet.has(`${l.ref}|${l.network||''}`) || alightSet.has(`${l.ref}|`));
      if (hit) sharedRef = hit.ref;
    } catch (e) { console.warn('sharedRef failed', e); }

    // Draw the bus section + label
    const ok = await drawBusPolylineBetween(board, alight, sharedRef || '');
    if (sharedRef) addBusRefLabel(board, alight, sharedRef);
    if (!ok && sharedRef) showError(`Drew a simple link; couldn’t fetch the ${sharedRef} geometry here.`);
    if (!sharedRef) showError('Couldn’t match a common bus line; showing a simple link between stops.');

    if (bestLabel) {
      bestLabel.style.display = 'inline-block';
      setTimeout(()=> bestLabel.style.display='none', 6000);
    }

    map.setView([board.lat, board.lon], 16);
  };

  const btnClear = el('#btn-clear-route');
  if (btnClear) btnClear.onclick = ()=>{
    clearRoute();
    writeDirections('');
    if (bestPulsePin) { map.removeLayer(bestPulsePin); bestPulsePin = null; }
    if (alightRingPin) { map.removeLayer(alightRingPin); alightRingPin = null; }
    lastBest = null;
    renderBestCard(null);
  };
}

// ---- Browser geolocation helper ----
async function getBrowserLocation(){
  return new Promise((res,rej)=>{
    if(!navigator.geolocation) return rej(new Error("No geolocation"));
    navigator.geolocation.getCurrentPosition(
      p=>res({lat:p.coords.latitude,lon:p.coords.longitude}),
      err=>rej(err),
      {enableHighAccuracy:true,timeout:8000,maximumAge:10000}
    );
  });
}

// ---- MAIN ----
async function main(){
  loadHome();

  // Parse deep-link first
  const deeplink = parseURLCenter();

  // Prefer browser location, else deep-link, else saved home, else default
  let center;
  try { center = await getBrowserLocation(); }
  catch { center = deeplink || (home && Number.isFinite(home.lat) ? {...home, z: 15} : CONFIG.HOME); }

  initMap(center);
  updateHomeUI();

  if (deeplink) {
    currentSelection = { lat: deeplink.lat, lon: deeplink.lon, label: 'Shared pin' };
    map.setView([deeplink.lat, deeplink.lon], deeplink.z || 15);
  } else {
    currentSelection = { lat:center.lat, lon:center.lon, label:(center.lat===home.lat && center.lon===home.lon)?home.name:'My location' };
  }

  if(currentSelection.label==='My location'){
    userMarker=L.marker([currentSelection.lat,currentSelection.lon]).addTo(map).bindPopup('You are here');
  }

  ensureBestCard();

  await refreshSelection();
  await listNearbyStops();

  // If no saved Home and we failed geolocate (and no deeplink), prompt for Home
  const hasSavedHome = !!localStorage.getItem('freshstop.home');
  if (!hasSavedHome && !deeplink) {
    try { await getBrowserLocation(); /* ok, no overlay */ }
    catch { showHomeOverlay(); }
  }

  wireButtons();
  wireHomeSearch();
}

// ---- Start ----
document.addEventListener('DOMContentLoaded', main);
