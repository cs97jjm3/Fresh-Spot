/* ===========================
   FreshStop - app.js (browser)
   ===========================

   Hooks to your HTML controls:
   - Search + Set Home (input hides after first set; pill shows; click pill to edit)
   - Use my location
   - Nearby stops (with inline weather + arrivals via proxy)
   - Best stop to get home? (pulsing marker + OSRM walking legs + directions)
   - Clear
   - Weather: Open-Meteo (no key)
   - Arrivals: BODS via Cloudflare Worker (CONFIG.PROXY_BASE)
*/

// ---- Config defaults (override in config.js) ----
window.CONFIG = Object.assign({
  HOME: { name: "Home", lat: 52.6755, lon: 0.1361 },
  OVERPASS_URL: "https://overpass-api.de/api/interpreter",
  OSRM_URL: "https://router.project-osrm.org",
  PROXY_BASE: null,            // set in config.js
  SEARCH_RADIUS_M: 800,
  MAX_STOPS: 50,
  WALK_SPEED_MPS: 1.3
}, window.CONFIG || {});

// ---- Helpers ----
const el  = sel => document.querySelector(sel);
const els = sel => Array.from(document.querySelectorAll(sel));
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

// ---- Map / State ----
let map, userMarker, homeMarker, stopsLayer, routeLayer, bestPulsePin;
let currentSelection = null; // {lat, lon, label?}
let home = {...CONFIG.HOME};

function initMap(center){
  if (map) return;
  map = L.map('map').setView([center.lat, center.lon], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  homeMarker = L.marker([home.lat, home.lon], { title: 'Home' }).addTo(map).bindPopup('Home');
  stopsLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);

  // Map click to select a point
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
    45:{label:"Fog",icon:"🌫️"},48:{label:"Rime fog",icon:"🌫️"},
    51:{label:"Drizzle light",icon:"🌦️"},53:{label:"Drizzle",icon:"🌦️"},55:{label:"Drizzle heavy",icon:"🌧️"},
    61:{label:"Rain light",icon:"🌦️"},63:{label:"Rain",icon:"🌧️"},65:{label:"Rain heavy",icon:"🌧️"},
    80:{label:"Showers light",icon:"🌦️"},81:{label:"Showers",icon:"🌧️"},82:{label:"Showers heavy",icon:"🌧️"},
    95:{label:"Thunderstorm",icon:"⛈️"}
  };
  const now=j.current_weather, idx=j.hourly.time.indexOf(now.time);
  const next3=[]; for(let k=1;k<=3;k++){const i=idx+k; if(i<j.hourly.time.length){const code=j.hourly.weathercode[i];
    next3.push({time:j.hourly.time[i],temp:j.hourly.temperature_2m[i],pop:j.hourly.precipitation_probability?.[i]??null,...(W[code]||{label:"—",icon:"🌡️"})});
  }}
  return { now:{ time: now.time, temp: now.temperature, ...(W[now.weathercode]||{label:"—",icon:"🌡️"}) }, next3 };
}
async function renderWeather(container, lat, lon){
  try{
    const w = await getWeather(lat, lon);
    container.innerHTML = `
      <div class="stop-wx"><span>${w.now.icon}</span>
        <span><strong>${w.now.temp}°C</strong> • ${w.now.label}</span>
      </div>
      <div class="muted" style="margin-top:2px;font-size:12px">
        Next 3h: ${w.next3.map(h=>`${new Date(h.time).toLocaleTimeString([], {hour:'2-digit'})} ${Math.round(h.temp)}°${h.pop!=null?` ${h.pop}%`:''}`).join(' · ')}
      </div>`;
  }catch{ container.textContent="Weather unavailable."; }
}

// ---- Overpass (nearby bus stops) ----
async function fetchStopsAround(lat, lon, radiusM=CONFIG.SEARCH_RADIUS_M){
  const q=`[out:json][timeout:25];
    (node(around:${radiusM},${lat},${lon})["highway"="bus_stop"];
     node(around:${radiusM},${lat},${lon})["public_transport"="platform"]["bus"="yes"];);
    out body ${Math.min(CONFIG.MAX_STOPS,200)};`;
  const r=await fetch(CONFIG.OVERPASS_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},body:"data="+encodeURIComponent(q)});
  if(!r.ok) throw new Error(`Overpass ${r.status}`); const j=await r.json();
  return (j.elements||[]).map(n=>({id:n.id,name:n.tags?.name||"Bus stop",lat:n.lat,lon:n.lon,ref:n.tags?.ref||n.tags?.naptan||n.tags?.naptan_code||null}));
}

// ---- Best stops ----
function chooseStopsTowardsHome(origin, stops, home){
  if(!stops.length) return null;
  const hb=bearingDeg(origin, home);
  const board = stops.map(s=>({s,score:haversineMeters(origin,s)+angleDiff(bearingDeg(s,home),hb)*3}))
                     .sort((a,b)=>a.score-b.score)[0].s;
  const alight = stops.map(s=>({s,d:haversineMeters(home,s)})).sort((a,b)=>a.d-b.d)[0].s;
  return { board, alight };
}

// ---- OSRM ----
async function getWalkRoute(from, to){
  const u=`${CONFIG.OSRM_URL}/route/v1/foot/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=false`;
  const r=await fetch(u); if(!r.ok) throw new Error(`OSRM ${r.status}`); const j=await r.json();
  const route=j.routes?.[0]; if(!route) throw new Error("No route");
  return { geojson: route.geometry, distance_m: route.distance, duration_s: route.duration };
}
function clearRoute(){ routeLayer.clearLayers(); }
function drawGeoJSON(geojson, style={}){ routeLayer.addLayer(L.geoJSON(geojson, Object.assign({weight:5, opacity:.85}, style))); }
function writeDirections(html){ const card=el('#directions'); if(!card)return; el('#directions-steps').innerHTML=html||''; card.style.display=html?'block':'none'; }
function writeWalkSummary(w1, w2, board, alight){
  const steps=[];
  if(board) steps.push(`<div class="dir-step"><strong>Board at:</strong> ${board.name}</div>`);
  if(w1) steps.push(`<div class="dir-step">Walk to stop: ${fmtMins(w1.duration_s/60)}</div>`);
  if(alight) steps.push(`<div class="dir-step"><strong>Alight at:</strong> ${alight.name}</div>`);
  if(w2) steps.push(`<div class="dir-step">Walk home: ${fmtMins(w2.duration_s/60)}</div>`);
  steps.push(`<div class="muted" style="font-size:12px;">Note: bus travel time not included.</div>`);
  writeDirections(steps.join(''));
}

// ---- Arrivals (BODS via Cloudflare Worker) ----
function parseNdjson(text){
  return text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean).filter(l=>l.startsWith("{"))
             .map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);
}
function normalizeArrivals(arr){
  return arr.map(x=>({
    line: x.lineName || x.line || x.service || x.operatorRef || "Bus",
    destination: x.destination || x.destinationName || x.direction || "—",
    eta: x.eta || x.expectedArrival || x.aimedArrivalTime || x.bestDepartureEstimate || x.arrivalTime || "—"
  }));
}
async function bodsArrivalsViaProxy(bbox){
  if(!CONFIG.PROXY_BASE) throw new Error("NO_PROXY");
  const url=`${CONFIG.PROXY_BASE}/bods?bbox=${encodeURIComponent(bbox)}`;
  const r=await fetch(url,{cache:"no-store"}); if(!r.ok) throw new Error(`BODS ${r.status}`);
  const ct=(r.headers.get("content-type")||"").toLowerCase();
  if(ct.includes("json")){ const j=await r.json(); const items=Array.isArray(j?.results)?j.results:Array.isArray(j)?j:[]; return normalizeArrivals(items); }
  const t=await r.text(); return normalizeArrivals(parseNdjson(t));
}
async function safeArrivalsHTML(center){
  try{
    const dLat=0.005,dLon=0.005;
    const bbox=`${center.lat-dLat},${center.lat+dLat},${center.lon-dLon},${center.lon+dLon}`;
    const items=await bodsArrivalsViaProxy(bbox);
    if(!items.length) return `<em>No arrivals found right now.</em>`;
    return `<ul class="arrivals">${items.slice(0,6).map(x=>`<li><strong>${x.line}</strong> → ${x.destination} • ${x.eta}</li>`).join('')}</ul>`;
  }catch(e){
    if(String(e.message).includes("NO_PROXY")) return `<em>Live arrivals require a proxy. Add <code>CONFIG.PROXY_BASE</code> to enable.</em>`;
    return `<em>Arrivals temporarily unavailable.</em>`;
  }
}

// ---- Popups ----
function popupTemplate(stop){
  return `
    <div class="popup">
      <div><strong>${stop.name}</strong>${stop.ref?` <small>(${stop.ref})</small>`:''}</div>
      <div class="weather" data-weather-for="${stop.lat},${stop.lon}">Loading weather…</div>
      <div class="arrivals">Loading arrivals…</div>
    </div>`;
}
async function enhanceStopPopup(marker, stop){
  const p=marker.getPopup(); if(!p) return;
  const root=p.getElement(); if(!root) return;
  const wEl=root.querySelector('.weather'); if(wEl) renderWeather(wEl, stop.lat, stop.lon);
  const aEl=root.querySelector('.arrivals'); if(aEl) aEl.innerHTML = await safeArrivalsHTML({lat:stop.lat, lon:stop.lon});
}

// ---- Selection + Stops list ----
async function refreshSelection(){
  const card=el('#selection'); if(!card) return;
  if(!currentSelection){ card.style.display='none'; card.innerHTML=''; return; }
  const {lat,lon,label}=currentSelection;
  card.style.display='block';
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="font-weight:600">${label||'Selected point'}</div>
        <div class="muted" style="font-size:12px">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
      </div>
      <button class="btn" id="sel-center">Center map</button>
    </div>`;
  el('#sel-center').onclick=()=>map.setView([lat,lon], Math.max(map.getZoom(),15));
}

async function listNearbyStops(){
  const card=el('#stops'); const listEl=el('#stops-list'); const radiusEl=el('#stops-radius');
  if(!card || !listEl) return;
  const center=currentSelection || {lat:home.lat, lon:home.lon};
  card.style.display='block'; if(radiusEl) radiusEl.textContent=String(CONFIG.SEARCH_RADIUS_M);
  let stops=[];
  try{ stops=await fetchStopsAround(center.lat, center.lon); }catch{ showError("Couldn’t load stops."); }
  stopsLayer.clearLayers(); listEl.innerHTML='';
  for(const s of stops){
    const m=L.marker([s.lat,s.lon],{title:s.name}).addTo(stopsLayer).bindPopup(popupTemplate(s));
    m.on('popupopen',()=>enhanceStopPopup(m,s));
    const item=document.createElement('div'); item.className='stop-item';
    item.innerHTML=`<div class="stop-left">
      <div class="stop-name">${s.name}</div>
      <span class="stop-kind kind-bus">Bus</span>
      ${s.ref?`<span class="pill">${s.ref}</span>`:''}
    </div>
    <div class="stop-wx" id="wx-${s.id}">Loading…</div>`;
    listEl.appendChild(item);
    const wxEl=item.querySelector(`#wx-${s.id}`); renderWeather(wxEl, s.lat, s.lon).catch(()=>{});
    const arrDiv=document.createElement('div'); arrDiv.className='muted'; arrDiv.style.fontSize='12px'; arrDiv.innerHTML='Loading arrivals…';
    item.appendChild(arrDiv);
    safeArrivalsHTML({lat:s.lat, lon:s.lon}).then(html=>arrDiv.innerHTML=html);
  }
  return stops;
}

// ---- Search + Set Home ----
async function geocode(text){
  const url=`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(text)}&addressdetails=1&limit=5`;
  const r=await fetch(url,{headers:{'Accept':'application/json'}}); if(!r.ok) throw new Error('Search failed');
  const j=await r.json(); return j.map(x=>({lat:+x.lat, lon:+x.lon, label:x.display_name}));
}
function wireSearchBoxes(){
  const search=el('#search'), drop=el('#results');
  const homeInput=el('#home-input'), homeDrop=el('#home-results');

  const renderDrop=(root, items, onPick)=>{
    if(!items.length){ root.style.display='none'; root.innerHTML=''; return; }
    root.innerHTML = items.map((r,i)=>`<button data-i="${i}">${r.label}</button>`).join('');
    root.style.display='block';
    Array.from(root.querySelectorAll('button')).forEach(b=>{
      b.onclick=()=>onPick(items[+b.dataset.i]);
    });
  };

  if(search && drop){
    search.addEventListener('input', debounce(async ()=>{
      const q=search.value.trim();
      if(q.length<2){ drop.style.display='none'; return; }
      try{
        const res=await geocode(q);
        renderDrop(drop, res, async pick=>{
          drop.style.display='none';
          currentSelection={lat:pick.lat, lon:pick.lon, label:pick.label};
          map.setView([pick.lat, pick.lon], 15);
          await refreshSelection(); await listNearbyStops();
        });
      }catch{ showError('Search failed.'); }
    }, 350));
  }

  if(homeInput && homeDrop){
    homeInput.addEventListener('input', debounce(async ()=>{
      const q=homeInput.value.trim();
      if(q.length<2){ homeDrop.style.display='none'; return; }
      try{
        const res=await geocode(q);
        renderDrop(homeDrop, res, async pick=>{
          homeDrop.style.display='none';
          setHome({ name: pick.label, lat: pick.lat, lon: pick.lon });
          await listNearbyStops();
        });
      }catch{ showError('Home search failed.'); }
    }, 350));
  }
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
      // Switch back to input so user can change Home
      pill.style.display = 'none';
      if (input) { input.style.display = 'inline-block'; input.focus(); }
    };
  }
  if (input) {
    // Hide input if we have a saved home
    input.style.display = (home && Number.isFinite(home.lat) && Number.isFinite(home.lon)) ? 'none' : 'inline-block';
  }

  if (homeMarker && Number.isFinite(home?.lat) && Number.isFinite(home?.lon)) {
    homeMarker.setLatLng([home.lat, home.lon]).setPopupContent('Home');
  }
}

// ---- Buttons ----
function wireButtons(){
  const btnLoc = el('#btn-my-location');
  if (btnLoc) btnLoc.onclick = async ()=>{
    try {
      const pos = await new Promise((res, rej)=>{
        if (!navigator.geolocation) return rej(new Error('No geolocation'));
        navigator.geolocation.getCurrentPosition(
          p=>res({lat:p.coords.latitude, lon:p.coords.longitude}),
          e=>rej(e),
          { enableHighAccuracy:true, timeout:8000, maximumAge:10000 }
        );
      });
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

    let stops=[];
    try { stops = await fetchStopsAround(origin.lat, origin.lon); }
    catch { showError('No stops found.'); return; }

    const pair = chooseStopsTowardsHome(origin, stops, home);
    if (!pair) { showError('No suitable stops.'); return; }
    const { board, alight } = pair;

    // Pulse marker at board
    if (bestPulsePin) { map.removeLayer(bestPulsePin); bestPulsePin = null; }
    bestPulsePin = L.marker([board.lat, board.lon], {
      icon: L.divIcon({ className: '', html: '<div class="pulse-pin"></div>', iconSize: [18,18], iconAnchor: [9,9] })
    }).addTo(map);
    if (bestLabel) {
      bestLabel.style.display = 'inline-block';
      setTimeout(()=> bestLabel.style.display='none', 6000);
    }

    // Routes
    clearRoute();
    let w1=null, w2=null;
    try { w1 = await getWalkRoute(origin, board); drawGeoJSON(w1.geojson, { color:'#2a9d8f' }); } catch {}
    try { w2 = await getWalkRoute(alight, home); drawGeoJSON(w2.geojson, { color:'#e76f51' }); } catch {}
    writeWalkSummary(w1, w2, board, alight);

    map.setView([board.lat, board.lon], 16);
  };

  const btnClear = el('#btn-clear-route');
  if (btnClear) btnClear.onclick = ()=>{
    clearRoute();
    writeDirections('');
    if (bestPulsePin) { map.removeLayer(bestPulsePin); bestPulsePin = null; }
  };
}

// ---- MAIN ----
async function main(){
  loadHome();
  initMap(home);
  updateHomeUI();

  // Put Home into selection initially
  currentSelection = { lat: home.lat, lon: home.lon, label: home.name };
  await refreshSelection();
  await listNearbyStops();

  // Try geolocate silently
  try {
    const pos = await new Promise((res, rej)=>{
      if (!navigator.geolocation) return rej(new Error("No geolocation"));
      navigator.geolocation.getCurrentPosition(
        p=>res({ lat:p.coords.latitude, lon:p.coords.longitude }),
        e=>rej(e),
        { enableHighAccuracy:true, timeout:5000, maximumAge:10000 }
      );
    });
    currentSelection = pos;
    map.setView([pos.lat, pos.lon], 15);
    if (!userMarker) {
      userMarker = L.marker([pos.lat, pos.lon], { title:'You' })
        .addTo(map).bindPopup('You are here');
    } else {
      userMarker.setLatLng([pos.lat, pos.lon]);
    }
    await refreshSelection();
    await listNearbyStops();
  } catch { /* ignore if blocked */ }

  wireButtons();
  wireSearchBoxes();
}

// ---- Start ----
document.addEventListener('DOMContentLoaded', main);
