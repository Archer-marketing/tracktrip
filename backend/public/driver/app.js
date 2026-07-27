let driverId = localStorage.getItem('driverId');
let driverName = localStorage.getItem('driverName');
let socket;
let watchId;
let pollIntervalId;
let routeMap, routeMarkers = [];
let routeVisible = false;
let myLat = null, myLng = null, myLocationMarker = null;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/driver/sw.js').catch(() => {});
}

// Wake Lock: evita que la pantalla se apague mientras la app esta activa
// (ayuda a que el navegador no "congele" la pestaña en segundo plano).
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* no critico */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

function setStatus(on) {
  const el = document.getElementById('statusBar');
  el.textContent = on ? 'Ubicación: activa ✅' : 'Ubicación: inactiva';
  el.className = 'status ' + (on ? 'on' : 'off');
}

async function login() {
  const code = document.getElementById('code').value.trim();
  if (!code) return;
  const res = await fetch('/api/driver/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) return alert('Código inválido');
  const data = await res.json();
  driverId = data.id;
  driverName = data.name;
  localStorage.setItem('driverId', driverId);
  localStorage.setItem('driverName', driverName);
  startApp();
}

function startApp() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('driverBadge').style.display = 'block';
  document.getElementById('driverNameLabel').textContent = driverName || '';
  requestWakeLock();
  startTracking();
  pollNextStop();
  if (pollIntervalId) clearInterval(pollIntervalId);
  pollIntervalId = setInterval(pollNextStop, 15000);
}

// Cierra la sesion de este repartidor en este dispositivo/navegador, para
// poder entrar con otro codigo sin que se quede pegado el anterior.
function logout() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
  localStorage.removeItem('driverId');
  localStorage.removeItem('driverName');
  driverId = null;
  driverName = null;

  document.getElementById('app').style.display = 'none';
  document.getElementById('driverBadge').style.display = 'none';
  document.getElementById('login').style.display = 'flex';
  document.getElementById('code').value = '';
  setStatus(false);

  routeVisible = false;
  document.getElementById('routeSection').style.display = 'none';
  document.getElementById('toggleRouteBtn').textContent = '🗺️ Ver ruta completa';
}

function startTracking() {
  if (!navigator.geolocation) return alert('Este navegador no soporta geolocalización');
  socket = io();

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      setStatus(true);
      myLat = latitude;
      myLng = longitude;
      if (routeVisible) updateMyLocationMarker();

      const payload = { driver_id: driverId, lat: latitude, lng: longitude };
      if (socket && socket.connected) {
        socket.emit('driver:location', payload);
      } else {
        fetch('/api/driver/location', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      }
    },
    (err) => {
      setStatus(false);
      console.error(err);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

async function pollNextStop() {
  try {
    const res = await fetch(`/api/driver/next-stop/${driverId}`);
    const data = await res.json();
    renderStop(data.stop, data.remaining);
    renderStartRouteBanner(data.stop, data.routeStarted);
    if (routeVisible) loadRouteView();
  } catch (e) { /* red caida, se reintenta en el siguiente poll */ }
}

// Mientras no toque "Iniciar ruta", no se manda ninguna alerta de Kommo
// para su ruta (el backend la bloquea) - esto solo es el aviso/boton, el
// repartidor puede seguir viendo/entregando pedidos normal mientras tanto.
function renderStartRouteBanner(stop, routeStarted) {
  const banner = document.getElementById('startRouteBanner');
  banner.style.display = stop && !routeStarted ? 'block' : 'none';
}

async function startRoute() {
  await fetch('/api/driver/start-route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driver_id: driverId }),
  });
  pollNextStop();
}

// La factura puede venir como liga (la mostramos como boton) o como texto
// plano (numero de factura, etc.) - se muestra distinto segun el caso.
function invoiceHtml(invoice) {
  if (!invoice) return '';
  if (/^https?:\/\//i.test(invoice)) {
    return `<a class="invoice-btn" href="${invoice}" target="_blank">🧾 Ver factura</a>`;
  }
  return `<p class="invoice-text">🧾 Factura: ${invoice}</p>`;
}

function renderStop(stop, remaining) {
  const card = document.getElementById('stopCard');
  const remEl = document.getElementById('remaining');
  if (!stop) {
    card.innerHTML = `<div class="empty">No tienes pedidos asignados por ahora 🎉</div>`;
    remEl.textContent = '';
    return;
  }
  card.innerHTML = `
    <div class="card">
      <h2>${stop.name}</h2>
      <p>${stop.address || 'Sin dirección registrada'}</p>
      ${invoiceHtml(stop.invoice)}
      <a class="maps-btn" style="display:block;text-align:center;text-decoration:none;color:white;border-radius:10px;padding:16px;font-weight:600;" href="${stop.mapsUrl}" target="_blank">📍 Abrir en Google Maps</a>
      <button class="done-btn" onclick="completeStop(${stop.id})">✅ Marcar como entregado</button>
    </div>
  `;
  remEl.textContent = `Paradas restantes: ${remaining}`;
}

async function completeStop(stopId) {
  await fetch('/api/driver/complete-stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stop_id: stopId }),
  });
  pollNextStop();
}

// Vista de "ruta completa": util cuando un cliente no esta y el repartidor
// quiere ver que mas le falta / saltarse uno mentalmente antes de volver.
async function toggleRoute() {
  routeVisible = !routeVisible;
  document.getElementById('routeSection').style.display = routeVisible ? 'block' : 'none';
  document.getElementById('toggleRouteBtn').textContent = routeVisible
    ? '🔽 Ocultar ruta completa'
    : '🗺️ Ver ruta completa';

  if (routeVisible) {
    await loadRouteView();
    // Leaflet necesita medir el contenedor ya visible para dibujar bien.
    setTimeout(() => routeMap && routeMap.invalidateSize(), 100);
  }
}

async function loadRouteView() {
  try {
    const res = await fetch(`/api/driver/route/${driverId}`);
    const data = await res.json();
    renderRouteList(data.stops);
    renderRouteMap(data.stops);
  } catch (e) { /* red caida, se reintenta en el siguiente poll */ }
}

function renderRouteList(stops) {
  const list = document.getElementById('routeList');
  if (!stops.length) {
    list.innerHTML = '<div class="empty">No tienes pedidos asignados por ahora 🎉</div>';
    return;
  }
  list.innerHTML = stops
    .map((s) => {
      const done = s.status === 'delivered';
      const invoiceIsLink = s.invoice && /^https?:\/\//i.test(s.invoice);
      return `
        <div class="route-item ${done ? 'done' : ''}">
          <span class="route-seq">${done ? '✅' : s.sequence}</span>
          <span class="route-info">
            <b>${s.name}</b><br>
            <small>${s.address || ''}</small>
            ${s.invoice && !invoiceIsLink ? `<br><small>🧾 ${s.invoice}</small>` : ''}
          </span>
          ${invoiceIsLink ? `<a class="route-link" href="${s.invoice}" target="_blank">🧾</a>` : ''}
          <a class="route-link" href="${s.mapsUrl}" target="_blank">📍</a>
        </div>
      `;
    })
    .join('');
}

// Marcador de "aqui estoy yo" en el mapa de ruta completa, actualizado en
// vivo cada vez que llega una posicion nueva del GPS (no solo al recargar
// la ruta), asi el repartidor se ve moverse en el mapa igual que en admin.
function updateMyLocationMarker() {
  if (!routeMap || myLat == null || myLng == null) return;
  const pos = [myLat, myLng];
  if (myLocationMarker) {
    myLocationMarker.setLatLng(pos);
  } else {
    myLocationMarker = L.marker(pos, {
      icon: L.divIcon({
        html: '<div style="font-size:30px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">🚚</div>',
        iconSize: [36, 36],
        iconAnchor: [18, 18],
        className: '',
      }),
      zIndexOffset: 1000,
    }).addTo(routeMap).bindPopup('Tú estás aquí');
  }
}

function renderRouteMap(stops) {
  if (!routeMap) {
    routeMap = L.map('routeMap');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
    }).addTo(routeMap);
  }

  routeMarkers.forEach((m) => routeMap.removeLayer(m));
  routeMarkers = [];

  const bounds = [];
  stops.forEach((s) => {
    const done = s.status === 'delivered';
    const color = done ? '#16a34a' : '#2563eb';
    const label = done ? '✅' : s.sequence;
    const icon = L.divIcon({
      html: `<div style="width:26px;height:26px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 0 4px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:12px;">${label}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      className: '',
    });
    const marker = L.marker([s.lat, s.lng], { icon }).addTo(routeMap).bindPopup(s.name);
    routeMarkers.push(marker);
    bounds.push([s.lat, s.lng]);
  });

  updateMyLocationMarker();
  if (myLat != null && myLng != null) bounds.push([myLat, myLng]);

  if (bounds.length) {
    routeMap.fitBounds(bounds, { padding: [30, 30] });
  } else {
    routeMap.setView([20.9674, -89.5926], 12);
  }
}

if (driverId) startApp();
