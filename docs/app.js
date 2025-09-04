// ======= Config & guards =======
const CONFIG = (window.FRESHSTOP_CONFIG || {});
const OWM_KEY = CONFIG.OWM_KEY;
const ORS_KEY = CONFIG.ORS_KEY;

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

// Home controls
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

const wxNowCache = new Map();
const hourlyCache = new Map();

// ======= Home storage =======
const HOME_KEY = "freshstop_home";
function getHome() {
  try { return JSON.parse(localStorage.getItem(HOME_KEY) || "null"); } catch { return null; }
}
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
    if (elHomeOnly) elHomeOnly.checked = true;
  } else {
    elHomeInput.style.display = "";
    elHomePill.style.display = "none";
    elHomeEdit.style.display = "none";
    if (elHomeOnlyWrap) elHomeOnlyWrap.style.display = "none";
    if (elHomeOnly) elHomeOnly.checked = false;
  }
}
renderHomeUI();
elHomeEdit && (elHomeEdit.onclick = () => { clearHome(); elHomeInput.value = ""; elHomeInput.focus(); });
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
    }, () => {}
  );
}

// ======= Helpers =======
function show(el){ if(el) el.style.display=""; }
function hide(el){ if(el) el.style.display="none"; }
function setHTML(el,h){ if(el) el.innerHTML=h; }
function km(m){ return (m/1000).toFixed(2); }
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

// ======= Reverse geocode =======
async function reverseGeocode(lat,lon){
  const url=`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&addressdetails=1`;
  const d=await getJSON(url,{"Accept-Language":"en"});
  const a=d?.address||{};
  const parts=[[a.road,a.pedestrian,a.footway,a.cycleway,a.path].find(Boolean),a.suburb||a.village,a.town||a.city,a.postcode].filter(Boolean);
  return {line:parts.join(", ")};
}

// ======= Selection =======
async function setSelected([lat,lng],source=""){
  selectedPoint=[lat,lng];
  if(selectedMarker) selectedMarker.remove();
  selectedMarker=L.circleMarker(selectedPoint,{radius:7,color:"#ef4444",fillColor:"#ef4444",fillOpacity:0.8}).addTo(map);
  map.panTo(selectedPoint);
  hide(elErrors); hide(elWeather); hide(elAir); hide(elStops); hide(elDirections);
  setHTML(elWeather,"");setHTML(elAir,"");setHTML(elStopsList,"");setHTML(elDirSteps,"");
  hide(elRouteSummary);clearStops();clearRoute();

  const latTxt=lat.toFixed(5),lngTxt=lng.toFixed(5);
  setHTML(elSelection,`<div><div style="font-weight:700;">Selected location</div><div class="muted">${latTxt}, ${lngTxt}</div></div>`);
  show(elSelection);

  try{const rev=await reverseGeocode(lat,lng);if(rev.line) setHTML(elSelection,`<div><div style="font-weight:700;">Selected location</div><div>${escapeHtml(rev.line)}</div><div class="muted">${latTxt}, ${lngTxt}</div></div>`);}catch{}

  try{await Promise.all([loadWeatherAndForecast(lat,lng),loadAir(lat,lng),loadStops(lat,lng,800)]);}catch(e){showError(e.message||"Couldn’t load.");}
}

// ======= Weather =======
async function loadWeatherAndForecast(lat,lng){
  if(!OWM_KEY) throw new Error("Missing OpenWeatherMap key.");
  const wx=await getJSON(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=metric&appid=${OWM_KEY}`);
  const t=Math.round(wx?.main?.temp??0);const desc=(wx?.weather?.[0]?.description||"").replace(/^\w/,c=>c.toUpperCase());const icon=wx?.weather?.[0]?.icon;
  wxNowCache.set(roundKey(lat,lng),{temp:t,icon});
  let hours=[];try{const one=await getJSON(`https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lng}&exclude=minutely,daily,alerts&units=metric&appid=${OWM_KEY}`);hours=(one?.hourly||[]).slice(0,3).map(h=>({ts:h.dt,t:Math.round(h.temp),icon:h.weather?.[0]?.icon,tz:one.timezone_offset||0}));}catch{}
  setHTML(elWeather,`<div class="wx-main">${icon?`<img src="${iconUrl(icon)}" width="48">`:""}<div class="wx-temp">${t}°C</div></div><div class="wx-hours">${hours.map(h=>`<div>${hourStr(h.ts,h.tz)} ${h.t}°C</div>`).join("")}</div>`);show(elWeather);
}

// ======= Air =======
async function loadAir(lat,lng){
  if(!OWM_KEY) throw new Error("Missing OpenWeatherMap key.");
  const air=await getJSON(`https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lng}&appid=${OWM_KEY}`);
  const aqi=air?.list?.[0]?.main?.aqi||0;
  setHTML(elAir,`<div>Air Quality: AQI ${aqi}</div>`);show(elAir);
}

// ======= Stops =======
async function loadStops(lat,lng,radius=800){
  elStopsRadius.textContent=radius;
  const q=`[out:json][timeout:25];(node(around:${radius},${lat},${lng})["highway"="bus_stop"];node(around:${radius},${lat},${lng})["railway"~"^(station|halt|stop|tram_stop)$"];);out body;>;out skel qt;`;
  const data=await overpass(q);
  let stops=(data.elements||[]).filter(e=>e.type==="node").map(e=>({id:e.id,name:e.tags.name||"Stop",pos:[e.lat,e.lon],kind:e.tags.highway?"bus":"train",dist:selectedPoint?haversine(selectedPoint,[e.lat,e.lon]):0})).sort((a,b)=>a.dist-b.dist).slice(0,12);

  const home=getHome();let homeSet=null;
  if(home&&isHomeOnly()){homeSet=await getStopsTowardHomeSet(stops,home);stops=stops.filter(s=>homeSet.has(s.id));}
  if(!stops.length){setHTML(elStopsList,`<div class="muted">No nearby stops found to Home.</div>`);show(elStops);clearStops();return;}

  clearStops();stops.forEach(s=>{L.circleMarker(s.pos,{radius:6,color:s.kind==="bus"?"#0ea5e9":"#10b981",fillOpacity:.85}).addTo(map);});
  setHTML(elStopsList,stops.map(s=>`<div>${escapeHtml(s.name)} ${homeSet&&homeSet.has(s.id)?'<span class="pill">→ Home</span>':""} <button data-route="${s.id}">Route</button><div id="wx-${s.id}"></div></div>`).join(""));show(elStops);

  [...elStopsList.querySelectorAll("button[data-route]")].forEach(b=>b.onclick=async()=>{const origin=await getOrigin();const s=stops.find(x=>x.id==b.dataset.route);routeBetween(origin,s.pos);});
}

async function getStopsTowardHomeSet(stops,home){
  const tokens=(home.label||"").toLowerCase().split(/[, ]+/).filter(x=>x.length>2);
  const ids=new Set();
  for(const s of stops){try{const rels=await fetchStopRoutes(s.id);if(rels.some(r=>tokens.some(t=>(r.tags.name||"").toLowerCase().includes(t))))ids.add(s.id);}catch{}}
  return ids;
}
async function fetchStopRoutes(id){const q=`[out:json];node(${id});rel(bn)->.r;.r[route] out tags;`;const r=await fetch("https://overpass-api.de/api/interpreter",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({data:q})});const j=await r.json();return j.elements||[];}

function clearStops(){stopLayers.forEach(l=>l.remove());stopLayers=[];}
async function overpass(q){const r=await fetch("https://overpass-api.de/api/interpreter",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({data:q})});return await r.json();}

// ======= Routing =======
elBtnRoute.onclick=async()=>{if(!selectedPoint)return showError("Pick a destination.");const origin=await getOrigin();routeBetween(origin,selectedPoint);};
elBtnRouteHome&& (elBtnRouteHome.onclick=async()=>{const home=getHome();if(!home)return showError("Set Home first.");const origin=await getOrigin();routeBetween(origin,[home.lat,home.lon]);});
elBtnClearRoute&&(elBtnClearRoute.onclick=()=>{clearRoute();hide(elDirections);hide(elRouteSummary);});
function clearRoute(){if(routeLine)routeLine.remove();routeLine=null;setHTML(elDirSteps,"");}

async function routeBetween(from,to){try{const r=await routeOSRM(from,to);drawRoute(r);}catch{showError("Routing failed.");}}
async function routeOSRM(from,to){const u=`https://router.project-osrm.org/route/v1/foot/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson&steps=true`;const d=await getJSON(u);const r=d?.routes?.[0];return{coords:r.geometry.coordinates.map(([x,y])=>[y,x]),distance:r.distance,duration:r.duration,steps:[]};}
function drawRoute(r){if(routeLine)routeLine.remove();routeLine=L.polyline(r.coords,{weight:5}).addTo(map);map.fitBounds(L.latLngBounds(r.coords));elRouteSummary.textContent=`${km(r.distance)} km • ${minutes(r.duration)} min`;show(elRouteSummary);}

// ======= Search =======
let searchTimer;elSearch.addEventListener("input",()=>{clearTimeout(searchTimer);const q=elSearch.value.trim();if(q.length<3)return hide(elResults);searchTimer=setTimeout(()=>doSearch(q),350);});
async function doSearch(q){const u=`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`;const d=await getJSON(u,{"Accept-Language":"en"});if(!d.length)return hide(elResults);elResults.innerHTML=d.map(r=>`<button data-lat="${r.lat}" data-lon="${r.lon}">${r.display_name}</button>`).join("");show(elResults);[...elResults.querySelectorAll("button")].forEach(b=>b.onclick=()=>{setSelected([+b.dataset.lat,+b.dataset.lon],"search");hide(elResults);});}

// ======= Home search =======
let homeTimer;if(elHomeInput&&elHomeResults){elHomeInput.addEventListener("input",()=>{clearTimeout(homeTimer);const q=elHomeInput.value.trim();if(q.length<3)return elHomeResults.style.display="none";homeTimer=setTimeout(()=>doHomeSearch(q),350);});}
async function doHomeSearch(q){const u=`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`;const d=await getJSON(u,{"Accept-Language":"en"});if(!d.length)return elHomeResults.style.display="none";elHomeResults.innerHTML=d.map(r=>`<button data-lat="${r.lat}" data-lon="${r.lon}" data-display="${r.display_name}">${r.display_name}</button>`).join("");elHomeResults.style.display="";[...elHomeResults.querySelectorAll("button")].forEach(b=>b.onclick=()=>{setHome({lat:+b.dataset.lat,lon:+b.dataset.lon,label:b.dataset.display});elHomeInput.value="";elHomeResults.style.display="none";});}

// ======= Generic helpers =======
async function getJSON(u,h={}){const r=await fetch(u,{headers:{...h}});if(!r.ok)throw new Error(r.statusText);return await r.json();}
function getCurrentPosition(){return new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej));}
function showError(m){setHTML(elErrors,`⚠️ ${m}`);show(elErrors);}
