/* ===========================
   FreshStop - app.js (browser)
   ===========================

   - Start at browser location (fallback: saved Home → London)
   - Only "Set Home" search (autocomplete)
   - Nearby stops (Overpass) with retry + timeout + mirrors
   - Weather: Open-Meteo (no key)
   - Arrivals: BODS via Cloudflare Worker (CONFIG.PROXY_BASE)
   - "Best stop to get home?" + pulsing marker + OSRM walking legs
   - NEW: Best Stop card above "Nearby stops" with rich details + arrivals + focus button
*/

// ---- Config defaults (override in config.js) ----
window.CONFIG = Object.assign({
  HOME: { name: "Home", lat: 51.5074, lon: -0.1278 }, // Central London fallback
  OVERPASS_MIRRORS: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
  ],
  OSRM_URL: "https://router.project-osrm.org",
  PROXY_BASE: null, // set in config.js
  SEARCH_RADIUS_M: 800,
  MAX_STOPS: 50,
  WALK_SPEED_MPS: 1.3,
  OVERPASS_TIMEOUT_MS: 9000
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
let lastBest = null; // { origin, board, alight, w1, w2 }

// ---- DOM helpers for Best card ----
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
function fmtCoord(lat, lon){ return `${lat.toFixed(4)}, ${lon.toFixed(4)}`; }

// ---- Build Best card HTML ----
async function renderBestCard(best){
  const card = ensureBestCard(); if (!card) return;
  if (!best) { card.style.display='none'; card.innerHTML=''; return; }

  const { origin, board, alight, w1, w2 } = best;

  // Get arrivals HTML for the board stop
  let arrivalsHTML = '<em>Loading live arrivals…</em>';
  try {
    arrivalsHTML = await safeArrivalsHTML({ lat: board.lat, lon: board.lon });
  } catch {
    arrivalsHTML = '<em>Arrivals unavailable.</em>';
  }

  const walkToStop = w1 ? fmtMins(w1.duration_s/60) : '—';
  const walkHome   = w2 ? fmtMins(w2.duration_s/60) : '—';

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <div style="font-weight:700;display:flex;align-items:center;gap:8px;">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:#22c55e;color:#fff;">★</span>
        Best stop to get home
      </div>
      <button class="btn" id="best-focus">Focus on map</button>
    </div>

    <div class="grid2" style="align-items:start;">
      <div>
        <div style="font-weight:600;margin-bottom:4px;">Board: ${board.name}</div>
        <div class="muted" style="font-size:12px;margin-bottom:6px;">${fmtCoord(board.lat, board.lon)}</div>
        <div class="kv"><span>Walk to stop</span><span><strong>${walkToStop}</strong></span></div>
        <div style="margin-top:6px;">${arrivalsHTML}</div>
      </div>

      <div>
        <div style="font-weight:600;margin-bottom:4px;">Alight near Home: ${alight.name}</div>
        <div class="muted" style="font-size:12px;margin-bottom:6px;">${fmtCoord(alight.lat, alight.lon)}</div>
        <div class="kv"><span>Walk home</span><span><strong>${walkHome}</strong></span></div>
        <div class="muted" style="font-size:12px;margin-top:6px;">(Bus travel time not included)</div>
      </div>
    </div>
  `;
  card.style.display = 'block';

  // Wire "Focus on map" button
  const focusBtn = el('#best-focus');
  if (focusBtn) {
    focusBtn.onclick = () => {
      if (!map) return;
      map.setView([board.lat, board.lon], 16);
      // open popup on the special marker or create one
      if (bestPulsePin) {
        bestPulsePin.openPopup();
      } else {
        const temp = L.marker([board.lat, board.lon]).addTo(map).bindPopup(popupTemplate(board));
        temp.openPopup();
        temp.on('popupopen', () => enhanceStopPopup(temp, board));
      }
    };
  }
}

// ---- Map init ----
function initMap(center){
  if (map) return;
  map = L.map('map').setView([center.lat, center.lon], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  homeMarker = L.marker([home.lat, home.lon], { title: 'Home' }).addTo(map).bindPopup('Home');
  stopsLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);

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
    61:{label:"Rain light",icon:"🌦️"},63:{label:"Rain",icon:"🌧️"},65:{label:"Rain heavy",icon:"🌧️"},
    80:{label:"Showers",icon:"🌦️"},95:{label:"Thunderstorm",icon:"⛈️"}
  };
  const now=j.current_weather, idx=j.hourly.time.indexOf(now.time);
  const next3=[]; for(let k=1;k<=3;k++){const i=idx+k; if(i<j.hourly.time.length){const code=j.hourly.weathercode[i];
    next3.push({time:j.hourly.time[i],temp:j.hourly.temperature_2m[i],pop:j.hourly.precipitation_probability?.[i]??null,...(W[code]||{label:"—",icon:"🌡️"})});
  }}
  return { now:{ time: now.time, temp: now.temperature, ...(W[now.weathercode]||{label:"—",icon:"🌡️"}) }, next3 };
}
async function renderWeather(container, lat, lon){
  try{
    const w=await getWeather(lat, lon);
    container.innerHTML = `<div class="stop-wx"><span>${w.now.icon}</span> <span><strong>${w.now.temp}°C</strong> • ${w.now.label}</span></div>`;
  }catch{ container.textContent="Weather unavailable."; }
}

// ---- Overpass (stops) with retries ----
async function fetchWithTimeout(url, opts={}, timeoutMs=CONFIG.OVERPASS_TIMEOUT_MS){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(), timeoutMs);
  try{ return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally{ clearTimeout(t); }
}
async function fetchStopsAround(lat, lon, radiusM=CONFIG.SEARCH_RADIUS_M){
  const q=`[out:json][timeout:25];
    (node(around:${radiusM},${lat},${lon})["highway"="bus_stop"];
     node(around:${radiusM},${lat},${lon})["public_transport"="platform"]["bus"="yes"];);
    out body ${Math.min(CONFIG.MAX_STOPS,200)};`;

  const body="data="+encodeURIComponent(q);
  const mirrors = CONFIG.OVERPASS_MIRRORS;
  let lastErr=null, json=null;

  for (const base of mirrors) {
    try{
      const r = await fetchWithTimeout(base, {
        method:"POST",
        headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},
        body
      });
      if (!r.ok) { lastErr = new Error(`Overpass ${r.status} at ${base}`); continue; }
      json = await r.json();
      break;
    }catch(e){
      lastErr = e; // try next
    }
  }
  if (!json) throw lastErr || new Error("Overpass failed");
  return (json.elements||[]).map(n=>({id:n.id,name:n.tags?.name||"Bus stop",lat:n.lat,lon:n.lon,ref:n.tags?.ref||n.tags?.naptan||n.tags?.naptan_code||null}));
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
  const r=await fetch(url,{cache:"no-store"});
  if(!r.ok) throw new Error(`BODS ${r.status}`);
  const ct=(r.headers.get("content-type")||"").toLowerCase();
  if(ct.includes("json")) {
    const j=await r.json();
    const items=Array.isArray(j?.results)?j.results:Array.isArray(j)?j:[];
    return normalizeArrivals(items);
  }
  const t=await r.text(); return normalizeArrivals(parseNdjson(t));
}
async function safeArrivalsHTML(center){
  try{
    const d=0.005;
    const bbox=`${center.lat-d},${center.lat+d},${center.lon-d},${center.lon+d}`;
    const items=await bodsArrivalsViaProxy(bbox);
    if(!items.length) return `<em>No arrivals found right now.</em>`;
    return `<ul class="arrivals">${items.slice(0,6).map(x=>`<li><strong>${x.line}</strong> → ${x.destination} • ${x.eta}</li>`).join('')}</ul>`;
  }catch(e){
    if(String(e.message).includes("NO_PROXY")) {
      return `<em>Live arrivals require a proxy. Add <code>CONFIG.PROXY_BASE</code> to enable.</em>`;
    }
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
  card.innerHTML=`<div><strong>${label||'Point'}</strong><br><span class="muted" style="font-size:12px">${lat.toFixed(5)}, ${lon.toFixed(5)}</span></div>`;
}
async function listNearbyStops(){
  const card=el('#stops'); const listEl=el('#stops-list'); const radiusEl=el('#stops-radius');
  if(!card || !listEl) return;
  const center=currentSelection || {lat:home.lat, lon:home.lon};
  card.style.display='block'; if(radiusEl) radiusEl.textContent=String(CONFIG.SEARCH_RADIUS_M);
  let stops=[];
  try{ stops=await fetchStopsAround(center.lat, center.lon); }
  catch(e){ showError("Couldn’t load stops (network busy). Try again in a moment."); }
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

// ---- Only: Set Home search (keep pill toggle) ----
async function geocode(text){
  const url=`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(text)}&addressdetails=1&limit=5`;
  const r=await fetch(url,{headers:{'Accept':'application/json'}}); if(!r.ok) throw new Error('Search failed');
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
        // If we already computed a best pair, refresh that card
        if (lastBest) await renderBestCard(lastBest);
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

    let stops=[];
    try { stops = await fetchStopsAround(origin.lat, origin.lon); }
    catch { showError('No stops found.'); return; }

    const pair = chooseStopsTowardsHome(origin, stops, home);
    if (!pair) { showError('No suitable stops.'); return; }
    const { board, alight } = pair;

    // Routes
    clearRoute();
    let w1=null, w2=null;
    try { w1 = await getWalkRoute(origin, board); drawGeoJSON(w1.geojson, { color:'#2a9d8f' }); } catch {}
    try { w2 = await getWalkRoute(alight, home); drawGeoJSON(w2.geojson, { color:'#e76f51' }); } catch {}
    writeWalkSummary(w1, w2, board, alight);

    // Save + render Best card
    lastBest = { origin, board, alight, w1, w2 };
    await renderBestCard(lastBest);

    // Remove any previous highlight marker
    if (bestPulsePin) { map.removeLayer(bestPulsePin); bestPulsePin = null; }

    // DISTINCTIVE pulsing marker + popup
    bestPulsePin = L.marker([board.lat, board.lon], {
      icon: L.divIcon({
        className: '',
        html: `
          <div class="pulse-pin" style="
            width:22px;height:22px;background:#22c55e;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 10px rgba(0,0,0,.25);
            position:relative;
          ">
            <div style="
              position:absolute;left:50%;top:50%;width:22px;height:22px;transform:translate(-50%,-50%);
              border-radius:50%;border:2px solid rgba(34,197,94,.6);animation:pulse 1.6s ease-out infinite;
            "></div>
          </div>
        `,
        iconSize: [22,22],
        iconAnchor: [11,11]
      })
    })
    .addTo(map)
    .bindPopup(popupTemplate(board));

    bestPulsePin.openPopup();
    bestPulsePin.on('popupopen', () => enhanceStopPopup(bestPulsePin, board));

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

  // Prefer browser location at startup
  let center;
  try { center = await getBrowserLocation(); }
  catch { center = (home && Number.isFinite(home.lat)) ? home : CONFIG.HOME; }

  initMap(center);
  updateHomeUI();

  currentSelection = { lat:center.lat, lon:center.lon, label:(center===home)?home.name:'My location' };
  if(center && currentSelection.label==='My location'){
    userMarker=L.marker([center.lat,center.lon]).addTo(map).bindPopup('You are here');
  }

  // Ensure Best card container exists (empty until you click Best)
  ensureBestCard();

  await refreshSelection();
  await listNearbyStops();

  wireButtons();
  wireHomeSearch();
}

// ---- Start ----
document.addEventListener('DOMContentLoaded', main);
