let driverId = localStorage.getItem('driverId');
let driverName = localStorage.getItem('driverName');
let socket;
let watchId;
let pollIntervalId;

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
}

function startTracking() {
  if (!navigator.geolocation) return alert('Este navegador no soporta geolocalización');
  socket = io();

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      setStatus(true);
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
  } catch (e) { /* red caida, se reintenta en el siguiente poll */ }
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

if (driverId) startApp();
