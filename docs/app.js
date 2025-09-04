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
