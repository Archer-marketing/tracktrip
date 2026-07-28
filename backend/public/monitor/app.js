const pathParts = location.pathname.split('/').filter(Boolean);
const token = pathParts.length > 1 ? pathParts[pathParts.length - 1] : null;

let map;
const driverMarkers = {};
const stopMarkers = {}; // driverId -> [markers]
const driverLines = {}; // driverId -> polyline

const ONLINE_THRESHOLD_MS = 15000;

function timeAgo(isoString) {
  if (!isoString) return '';
  const then = new Date(isoString.replace(' ', 'T') + (isoString.endsWith('Z') ? '' : 'Z'));
  const diffMs = Date.now() - then.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'unos segundos';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return `${hours} h ${mins % 60} min`;
}

// Mismo calculo de color que el panel de admin (angulo dorado con offset
// para repartidores), asi el color de cada quien es consistente entre
// las dos vistas.
function colorForDriver(driverId) {
  const hue = ((Number(driverId) + 1000) * 137.508) % 360;
  return `hsl(${hue}, 70%, 45%)`;
}

function driverMarkerIcon(driverId, name) {
  const color = colorForDriver(driverId);
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return L.divIcon({
    html: `
      <div style="position:relative;width:40px;height:40px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">
        <div style="width:36px;height:36px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${color};border:2px solid white;position:absolute;top:2px;left:2px;"></div>
        <div style="position:absolute;top:2px;left:2px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:15px;">${initial}</div>
      </div>
    `,
    iconSize: [40, 40],
    iconAnchor: [20, 38],
    className: '',
  });
}

function seqIcon(num, color) {
  return L.divIcon({
    html: `<div style="width:24px;height:24px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 4px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:11px;">${num}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    className: '',
  });
}

function ensureMap() {
  if (map) return;
  map = L.map('map').setView([20.9674, -89.5926], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);
}

function renderEmpty(icon, text) {
  document.getElementById('drivers').innerHTML = `
    <div class="empty-state"><div class="icon">${icon}</div><p>${text}</p></div>
  `;
}

function renderDrivers(drivers) {
  ensureMap();

  const list = document.getElementById('drivers');
  if (!drivers.length) {
    list.innerHTML = '<div class="empty-state"><div class="icon">🌿</div><p>Sin repartidores activos por ahora.</p></div>';
  } else {
    list.innerHTML = drivers
      .map((d) => {
        const color = colorForDriver(d.id);
        const online = d.updated_at && Date.now() - new Date(d.updated_at.replace(' ', 'T') + 'Z').getTime() < ONLINE_THRESHOLD_MS;
        const connBadge = d.lat != null
          ? `<span class="conn-badge ${online ? 'online' : 'offline'}">${online ? '🟢 En línea' : '🔴 Hace ' + timeAgo(d.updated_at)}</span>`
          : `<span class="conn-badge offline">⚪ Sin ubicación</span>`;
        const stationaryNote = d.stationary_since
          ? `<div class="stationary-note">⏱ Detenido hace ${timeAgo(d.stationary_since)}</div>`
          : '';
        return `
          <div class="driver-card">
            <div class="driver-card-head">
              <span class="driver-dot" style="background:${color}"></span>
              <span class="driver-name">${d.name}</span>
              ${connBadge}
            </div>
            <span class="delivered-badge">📦 ${d.delivered}/${d.total} entregados</span>
            ${stationaryNote}
          </div>
        `;
      })
      .join('');
  }

  const seenIds = new Set();
  const allBounds = [];

  drivers.forEach((d) => {
    seenIds.add(String(d.id));
    const color = colorForDriver(d.id);

    (stopMarkers[d.id] || []).forEach((m) => map.removeLayer(m));
    stopMarkers[d.id] = [];
    if (driverLines[d.id]) {
      map.removeLayer(driverLines[d.id]);
      driverLines[d.id] = null;
    }

    if (d.lat == null || d.lng == null) {
      if (driverMarkers[d.id]) {
        map.removeLayer(driverMarkers[d.id]);
        delete driverMarkers[d.id];
      }
      return;
    }

    const pos = [d.lat, d.lng];
    allBounds.push(pos);
    if (driverMarkers[d.id]) {
      driverMarkers[d.id].setLatLng(pos);
    } else {
      driverMarkers[d.id] = L.marker(pos, { icon: driverMarkerIcon(d.id, d.name) }).addTo(map).bindPopup(d.name);
    }

    // Linea punteada del repartidor hacia sus siguientes paradas, en orden.
    const linePath = [pos];
    d.remaining.forEach((s) => {
      const marker = L.marker([s.lat, s.lng], { icon: seqIcon(s.seq, color) }).addTo(map).bindPopup(`${d.name} — parada ${s.seq}: ${s.name}`);
      stopMarkers[d.id].push(marker);
      linePath.push([s.lat, s.lng]);
      allBounds.push([s.lat, s.lng]);
    });

    if (linePath.length > 1) {
      driverLines[d.id] = L.polyline(linePath, { color, weight: 3, dashArray: '6,8', opacity: 0.8 }).addTo(map);
    }
  });

  // Limpia marcadores/lineas de repartidores que ya no vienen en la respuesta
  // (ej. se desactivaron).
  Object.keys(driverMarkers).forEach((id) => {
    if (!seenIds.has(id)) {
      map.removeLayer(driverMarkers[id]);
      delete driverMarkers[id];
      (stopMarkers[id] || []).forEach((m) => map.removeLayer(m));
      delete stopMarkers[id];
      if (driverLines[id]) {
        map.removeLayer(driverLines[id]);
        delete driverLines[id];
      }
    }
  });

  if (!window.__monitorFitDone && allBounds.length) {
    window.__monitorFitDone = true;
    if (allBounds.length === 1) map.setView(allBounds[0], 14);
    else map.fitBounds(allBounds, { padding: [40, 40] });
  }
}

async function poll() {
  if (!token) {
    renderEmpty('🔗', 'Liga inválida.');
    return;
  }
  try {
    const res = await fetch(`/api/monitor/${token}/data`);
    if (res.status === 404) {
      renderEmpty('🔗', 'Esta liga de monitoreo no es válida. Pide una nueva desde el panel de admin.');
      return;
    }
    const data = await res.json();
    renderDrivers(data.drivers || []);
  } catch (e) {
    // red caida, se reintenta en el siguiente poll
  }
}

poll();
setInterval(poll, 5000);
