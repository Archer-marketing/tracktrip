let adminPass = sessionStorage.getItem('adminPass');
let map, driverMarkers = {}, stopMarkers = [];
let selectedStops = new Set();
let lastStops = [];
let driversById = {};
let startPin = null, endPin = null;
let startPinMarker = null, endPinMarker = null;
let previewMarkers = [], previewLine = null, previewOrder = null, previewDriverId = null;
let previewStart = null, previewEnd = null;
let previewStartMarker = null, previewEndMarker = null;
let activeTab = 'pending'; // 'pending' o el id de un repartidor
let defaultStartPoint = null;

function enter() {
  adminPass = document.getElementById('pass').value;
  sessionStorage.setItem('adminPass', adminPass);
  init();
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-password': adminPass,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    sessionStorage.removeItem('adminPass');
    document.getElementById('gate').style.display = 'flex';
    document.getElementById('layout').style.display = 'none';
    throw new Error('No autorizado');
  }
  return res.json();
}

async function init() {
  document.getElementById('gate').style.display = 'none';
  document.getElementById('layout').style.display = 'flex';

  map = L.map('map').setView([20.9674, -89.5926], 12); // default Merida, se ajusta con geolocalizacion si se puede
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 13),
      () => {}, // si el usuario niega el permiso o falla, se queda en Merida
      { timeout: 5000 }
    );
  }

  await loadDrivers();
  await loadDefaultStartPoint();
  await loadStops();
  await loadKommoPipelines();
  await loadKommoFields();
  await loadMonitorLink();

  const socket = io();
  socket.on('admin:driverUpdate', ({ driver_id, lat, lng }) => {
    updateDriverMarker(driver_id, lat, lng);
  });

  setInterval(loadStops, 20000);
  // Estado de conexion/detenido de cada repartidor: se revisa mas seguido
  // que el resto (solo consulta la tabla de ubicaciones, es liviana).
  setInterval(loadDrivers, 5000);
}

// Un repartidor se considera "en linea" si mando su ubicacion hace poco
// (deja margen para el intervalo normal de envio del GPS del celular).
const ONLINE_THRESHOLD_MS = 15000;

function timeAgo(isoString) {
  if (!isoString) return '';
  // SQLite guarda datetime('now') en UTC sin sufijo de zona - hay que
  // agregarle "Z" para que Date lo interprete como UTC y no como hora local.
  const then = new Date(isoString.replace(' ', 'T') + (isoString.endsWith('Z') ? '' : 'Z'));
  const diffMs = Date.now() - then.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'unos segundos';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return `${hours} h ${mins % 60} min`;
}

function formatDeliveredTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString.replace(' ', 'T') + (isoString.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
}

async function loadDrivers() {
  const drivers = await api('/api/admin/drivers');
  driversById = Object.fromEntries(drivers.map((d) => [String(d.id), d]));
  const list = document.getElementById('drivers');
  const select = document.getElementById('driverSelect');
  // El select se reconstruye cada 5s (poll de conexion): sin esto, perdia
  // el repartidor elegido a medio armar una ruta y saltaba al primero de
  // la lista en cuanto se le daba "Vista previa".
  const prevSelected = select.value;
  list.innerHTML = '';
  select.innerHTML = '';

  drivers.forEach((d) => {
    const color = colorForDriver(d.id);
    const online = d.updated_at && Date.now() - new Date(d.updated_at.replace(' ', 'T') + 'Z').getTime() < ONLINE_THRESHOLD_MS;
    const connBadge = d.lat != null
      ? `<span class="conn-badge ${online ? 'online' : 'offline'}">${online ? '🟢 En línea' : '🔴 Última señal hace ' + timeAgo(d.updated_at)}</span>`
      : `<span class="conn-badge offline">⚪ Sin ubicación aun</span>`;
    const stationaryNote = d.stationary_since
      ? `<div class="stationary-note">⏱ Detenido en el mismo punto hace ${timeAgo(d.stationary_since)}</div>`
      : '';

    const div = document.createElement('div');
    div.className = 'driver-card' + (d.active ? '' : ' inactive');
    div.innerHTML = `
      <div class="driver-card-head">
        <span class="driver-dot" style="background:${color}"></span>
        <b>${d.name}</b>
        ${connBadge}
      </div>
      <small>código: ${d.login_code}</small>
      ${stationaryNote}
      <button class="mini-btn" onclick="toggleDriverActive(${d.id}, ${d.active ? 0 : 1})">
        ${d.active ? '🚫 Desactivar' : '✅ Activar'}
      </button>
      <button class="mini-btn remove" onclick="deleteDriver(${d.id}, '${d.name.replace(/'/g, "\\'")}')">🗑️ Eliminar</button>
    `;
    list.appendChild(div);

    if (d.active) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      select.appendChild(opt);
    }

    if (d.lat && d.lng) updateDriverMarker(d.id, d.lat, d.lng, d.name);
  });

  if (prevSelected && [...select.options].some((o) => o.value === prevSelected)) {
    select.value = prevSelected;
  }
}

async function toggleDriverActive(id, active) {
  await api(`/api/admin/drivers/${id}/active`, {
    method: 'POST',
    body: JSON.stringify({ active }),
  });
  await loadDrivers();
}

async function deleteDriver(id, name) {
  if (!confirm(`¿Eliminar a ${name}? Esta acción no se puede deshacer. Lo que le quedaba sin entregar regresa a Pendientes.`)) return;
  await api(`/api/admin/drivers/${id}`, { method: 'DELETE' });
  if (String(activeTab) === String(id)) activeTab = 'pending';
  await loadDrivers();
  await loadStops();
}

async function addDriver() {
  const nameInput = document.getElementById('newDriverName');
  const codeInput = document.getElementById('newDriverCode');
  const name = nameInput.value.trim();
  const login_code = codeInput.value.trim();
  if (!name || !login_code) return alert('Pon nombre y código de acceso');

  const result = await api('/api/admin/drivers', {
    method: 'POST',
    body: JSON.stringify({ name, login_code }),
  });
  if (result.error) return alert(result.error);

  nameInput.value = '';
  codeInput.value = '';
  await loadDrivers();
}

// Cada repartidor lleva su color (el mismo que su tarjeta y el de las
// paradas de su ruta) mas su inicial, para poder distinguirlos en el mapa
// de un vistazo cuando hay varios repartidores activos a la vez.
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

function updateDriverMarker(driverId, lat, lng, name) {
  if (driverMarkers[driverId]) {
    driverMarkers[driverId].setLatLng([lat, lng]);
    if (name) driverMarkers[driverId].setPopupContent(name);
  } else {
    driverMarkers[driverId] = L.marker([lat, lng], { icon: driverMarkerIcon(driverId, name) })
      .addTo(map)
      .bindPopup(name || `Repartidor ${driverId}`);
  }
}

// Color estable a partir de un id (angulo dorado -> tonos bien distribuidos).
// `offset` separa la paleta de clientes de la de repartidores para que no
// coincidan visualmente por casualidad.
function hslColor(id, offset = 0) {
  const hue = ((Number(id) + offset) * 137.508) % 360;
  return `hsl(${hue}, 70%, 45%)`;
}
function colorForCustomer(customerId) {
  return hslColor(customerId);
}
function colorForDriver(driverId) {
  return hslColor(driverId, 1000);
}

function dotIcon(color, size) {
  return L.divIcon({
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 3px rgba(0,0,0,.6)"></div>`,
    iconSize: [size, size],
    className: '',
  });
}

function seqIcon(num, color) {
  return L.divIcon({
    html: `<div style="width:30px;height:30px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 0 4px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:14px;">${num}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    className: '',
  });
}

async function loadStops() {
  const stops = await api('/api/admin/stops');
  lastStops = stops;

  renderStopTabs(stops);
  renderStopsList(stops);

  const pending = stops.filter((s) => s.status === 'pending');
  populateStartEndSelects(pending.filter((s) => s.lat != null && s.lng != null));
}

// Una pestaña "Pendientes" (para armar rutas nuevas) + una por cada
// repartidor que tenga algo asignado/entregado hoy, asi no se mezclan
// las rutas de varios repartidores en una sola lista larga.
function renderStopTabs(stops) {
  const tabs = document.getElementById('stopTabs');
  const pendingCount = stops.filter((s) => s.status === 'pending').length;

  const driverIds = [...new Set(
    stops.filter((s) => s.status !== 'pending').map((s) => s.driver_id)
  )];

  // Si el repartidor de la pestana activa ya no tiene nada, regresa a Pendientes.
  if (activeTab !== 'pending' && !driverIds.some((id) => String(id) === String(activeTab))) {
    activeTab = 'pending';
  }

  let html = `<button class="tab-btn ${activeTab === 'pending' ? 'active' : ''}" onclick="setActiveTab('pending')">📋 Pendientes (${pendingCount})</button>`;

  driverIds.forEach((driverId) => {
    const driver = driversById[String(driverId)];
    const count = stops.filter((s) => s.driver_id === driverId && s.status === 'assigned').length;
    const isActive = String(activeTab) === String(driverId);
    html += `<button class="tab-btn ${isActive ? 'active' : ''}" onclick="setActiveTab(${driverId})">🚚 ${driver ? driver.name : 'Repartidor ' + driverId} (${count})</button>`;
  });

  tabs.innerHTML = html;
}

function setActiveTab(tab) {
  activeTab = tab;
  renderStopsList(lastStops);
}

// Dibuja la lista + los marcadores del mapa segun la pestana activa:
// "pending" muestra los pendientes seleccionables (para armar una ruta);
// un repartidor muestra solo su ruta (asignados + entregados hoy).
// Un checkbox por cada alerta (no una sola "alertas" general): "marcado"
// significa que esa alerta todavia esta armada (no se ha mandado, o se
// volvio a activar a mano); en cuanto se dispara, se desmarca sola y se
// queda asi para siempre (no se repite) salvo que el admin la reactive
// aqui mismo. Se ponen FUERA del <label> del pedido (no anidados) porque
// un <label> dentro de otro <label> es invalido en HTML.
function alertCheckboxesHtml(s) {
  const armed3Away = !s.notified_3_away;
  const armedNext = !s.notified_next;
  return `
    <div class="stop-alerts">
      <label class="stop-alerts-label">
        <input type="checkbox" ${armed3Away ? 'checked' : ''} onchange="toggleAlert(${s.id}, '3_away', this.checked)" />
        🔔 Faltan 3
      </label>
      <label class="stop-alerts-label">
        <input type="checkbox" ${armedNext ? 'checked' : ''} onchange="toggleAlert(${s.id}, 'next', this.checked)" />
        🔔 Es el siguiente
      </label>
    </div>
  `;
}

function renderStopsList(stops) {
  const container = document.getElementById('stops');
  container.innerHTML = '';

  stopMarkers.forEach((m) => map.removeLayer(m));
  stopMarkers = [];

  document.getElementById('assignControls').style.display = activeTab === 'pending' ? 'block' : 'none';

  const routeActions = document.getElementById('routeActions');
  if (activeTab === 'pending') {
    const selectableCount = stops.filter(
      (s) => s.status === 'pending' && s.lat != null && s.lng != null
    ).length;
    routeActions.innerHTML = selectableCount
      ? `<button onclick="toggleSelectAllPending()">☑️ Seleccionar/deseleccionar todos</button>`
      : '';
  } else {
    const activeAssignedCount = stops.filter(
      (s) => String(s.driver_id) === String(activeTab) && s.status === 'assigned'
    ).length;
    routeActions.innerHTML = activeAssignedCount
      ? `<button class="btn-danger" onclick="finishRoute(${activeTab})">✅ Marcar ruta como terminada</button>`
      : '';
  }

  if (activeTab === 'pending') {
    stops
      .filter((s) => s.status === 'pending')
      .forEach((s) => {
        const color = colorForCustomer(s.customer_id);
        const hasLocation = s.lat != null && s.lng != null;

        const div = document.createElement('div');
        div.className = 'stop' + (hasLocation ? '' : ' stop-missing');
        div.innerHTML = `
          <label>
            <input type="checkbox" data-id="${s.id}" onchange="toggleStop(${s.id}, this.checked)" ${selectedStops.has(s.id) ? 'checked' : ''} ${hasLocation ? '' : 'disabled'} />
            <span class="stop-color" style="background:${color}"></span>
            <span>
              ${s.name}<br>
              <small>${s.address || ''}</small><br>
              ${hasLocation ? '' : '<small class="stop-warn">⚠️ Sin ubicación — corrige el lead en Kommo y vuelve a sincronizar</small><br>'}
              ${s.kommo_url ? `<a href="${s.kommo_url}" target="_blank" rel="noopener">Ver en Kommo →</a>` : ''}
            </span>
          </label>
          ${alertCheckboxesHtml(s)}
        `;
        container.appendChild(div);

        if (hasLocation) {
          const marker = L.marker([s.lat, s.lng], { icon: dotIcon(color, 16) }).addTo(map).bindPopup(s.name);
          stopMarkers.push(marker);
        }
      });
    return;
  }

  // Pestana de un repartidor: solo su ruta (asignados + entregados hoy).
  const driver = driversById[String(activeTab)];
  const driverStops = stops.filter((s) => String(s.driver_id) === String(activeTab));
  const color = colorForDriver(activeTab);

  if (!driverStops.length) {
    container.innerHTML = '<div class="stop">Sin pedidos en esta ruta.</div>';
    return;
  }

  driverStops.forEach((s) => {
    const hasLocation = s.lat != null && s.lng != null;
    const done = s.status === 'delivered';

    // Solo se puede reordenar/quitar entre pedidos todavia sin entregar,
    // asi que los limites de "subir"/"bajar" se calculan solo entre esos.
    const assignedNeighbors = driverStops.filter((x) => x.status === 'assigned');
    const posAmongAssigned = assignedNeighbors.findIndex((x) => x.id === s.id);
    const isFirst = posAmongAssigned <= 0;
    const isLast = posAmongAssigned === assignedNeighbors.length - 1;

    const otherDrivers = Object.values(driversById).filter(
      (d) => d.active && String(d.id) !== String(activeTab)
    );
    const reassignHtml = otherDrivers.length
      ? `
        <select class="reassign-select" onchange="if(this.value) reassignStop(${s.id}, this.value); this.value='';">
          <option value="">↔ Cambiar a...</option>
          ${otherDrivers.map((d) => `<option value="${d.id}">${d.name}</option>`).join('')}
        </select>
      `
      : '';

    const actionsHtml = done
      ? ''
      : `
        <span class="stop-actions">
          <button class="mini-btn" onclick="moveStop(${s.id}, 'up')" ${isFirst ? 'disabled' : ''}>▲</button>
          <button class="mini-btn" onclick="moveStop(${s.id}, 'down')" ${isLast ? 'disabled' : ''}>▼</button>
          <button class="mini-btn remove" onclick="unassignStop(${s.id})">✖</button>
          ${reassignHtml}
        </span>
      `;

    const div = document.createElement('div');
    div.className = 'stop ' + (done ? 'stop-delivered' : 'stop-assigned');
    div.innerHTML = `
      <label>
        <span class="stop-seq" style="background:${done ? '#16a34a' : color}">${done ? '✅' : s.sequence ?? '?'}</span>
        <span>
          ${s.name}<br>
          <small>${done ? `Entregado a las ${formatDeliveredTime(s.delivered_at)}` : `Parada ${s.sequence ?? '?'}`}</small><br>
          <small>${s.address || ''}</small><br>
          ${s.kommo_url ? `<a href="${s.kommo_url}" target="_blank" rel="noopener">Ver en Kommo →</a>` : ''}
        </span>
        ${actionsHtml}
      </label>
      ${done ? '' : alertCheckboxesHtml(s)}
    `;
    container.appendChild(div);

    if (hasLocation) {
      const icon = done
        ? L.divIcon({ html: '<div style="font-size:18px;opacity:.7">✅</div>', iconSize: [22, 22], className: '' })
        : seqIcon(s.sequence ?? '?', color);
      const marker = L.marker([s.lat, s.lng], { icon })
        .addTo(map)
        .bindPopup(done ? `Entregado a las ${formatDeliveredTime(s.delivered_at)} — ${s.name}` : `Siguiente parada ${s.sequence} — ${s.name} (${driver ? driver.name : 'repartidor ' + activeTab})`);
      stopMarkers.push(marker);
    }
  });
}

// Trae el punto de partida por defecto (ej. la oficina) y lo cachea en
// `defaultStartPoint`. Si no se pudo resolver la liga (Google no
// respondio, o cambio de formato), simplemente no aparece como opcion.
async function loadDefaultStartPoint() {
  try {
    const point = await api('/api/admin/default-start-point');
    defaultStartPoint = point && point.lat != null ? point : null;
  } catch (e) {
    defaultStartPoint = null;
    console.error('No se pudo cargar el punto de partida por defecto', e);
  }
}

// Llena los selects de "punto de partida" / "punto final" con los clientes
// que ya tienen ubicacion, sin perder lo que ya estaba elegido. La primera
// vez (sin nada elegido todavia), el punto de partida cae en el default
// configurado (ej. la oficina) si esta disponible.
function populateStartEndSelects(customers) {
  const options = customers
    .map((s) => `<option value="customer:${s.customer_id}">${s.name}</option>`)
    .join('');

  const startSelect = document.getElementById('startSelect');
  const prevStart = startSelect.value;
  const defaultOption = defaultStartPoint
    ? `<option value="default">${defaultStartPoint.label}</option>`
    : '';
  startSelect.innerHTML = `
    <option value="driver">Ubicación actual del repartidor</option>
    ${defaultOption}
    <option value="pin">📍 Elegir en el mapa</option>
    ${options}
  `;
  if (prevStart && [...startSelect.options].some((o) => o.value === prevStart)) {
    startSelect.value = prevStart;
  } else if (defaultStartPoint) {
    startSelect.value = 'default';
  }

  const endSelect = document.getElementById('endSelect');
  const prevEnd = endSelect.value;
  endSelect.innerHTML = `
    <option value="">(automático, sin punto fijo)</option>
    <option value="pin">🏁 Elegir en el mapa</option>
    ${options}
  `;
  if ([...endSelect.options].some((o) => o.value === prevEnd)) endSelect.value = prevEnd;
}

function onStartSelectChange() {
  clearPreview();
  if (document.getElementById('startSelect').value === 'pin') armPin('start');
}

function onEndSelectChange() {
  clearPreview();
  if (document.getElementById('endSelect').value === 'pin') armPin('end');
}

function armPin(which) {
  const label = document.getElementById(which === 'start' ? 'startPinLabel' : 'endPinLabel');
  label.textContent = 'Haz clic en el mapa para elegir el punto...';

  map.once('click', (e) => {
    if (which === 'start') {
      startPin = e.latlng;
      if (startPinMarker) map.removeLayer(startPinMarker);
      startPinMarker = L.marker(e.latlng, {
        icon: L.divIcon({ html: '<div style="font-size:32px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">📍</div>', iconSize: [40, 40], iconAnchor: [20, 38], className: '' }),
      }).addTo(map).bindPopup('Inicio de ruta');
    } else {
      endPin = e.latlng;
      if (endPinMarker) map.removeLayer(endPinMarker);
      endPinMarker = L.marker(e.latlng, {
        icon: L.divIcon({ html: '<div style="font-size:32px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">🏁</div>', iconSize: [40, 40], iconAnchor: [20, 38], className: '' }),
      }).addTo(map).bindPopup('Final de ruta');
    }
    label.textContent = `Elegido: ${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
    clearPreview();
  });
}

// Resuelve el valor de un select de inicio/fin a {lat,lng}, o null si no aplica.
function resolvePoint(selectValue, pin) {
  if (selectValue === 'default') {
    return defaultStartPoint ? { lat: defaultStartPoint.lat, lng: defaultStartPoint.lng } : null;
  }
  if (selectValue === 'pin') {
    return pin ? { lat: pin.lat, lng: pin.lng } : null;
  }
  if (selectValue && selectValue.startsWith('customer:')) {
    const customerId = selectValue.split(':')[1];
    const cust = lastStops.find((s) => String(s.customer_id) === customerId);
    return cust && cust.lat != null ? { lat: cust.lat, lng: cust.lng } : null;
  }
  return null;
}

function toggleStop(id, checked) {
  clearPreview();
  if (checked) selectedStops.add(id);
  else selectedStops.delete(id);
}

// Selecciona/deselecciona de un click todos los pendientes con ubicacion
// (los que no tienen no se pueden elegir de todas formas). Si ya estaban
// todos seleccionados, el mismo boton los deselecciona.
function toggleSelectAllPending() {
  const selectable = lastStops.filter((s) => s.status === 'pending' && s.lat != null && s.lng != null);
  const allSelected = selectable.length > 0 && selectable.every((s) => selectedStops.has(s.id));

  clearPreview();
  if (allSelected) {
    selectable.forEach((s) => selectedStops.delete(s.id));
  } else {
    selectable.forEach((s) => selectedStops.add(s.id));
  }
  renderStopsList(lastStops);
}

// --- Editar una ruta ya confirmada (pestana de un repartidor) ---

async function moveStop(stopId, direction) {
  const result = await api(`/api/admin/stops/${stopId}/move`, {
    method: 'POST',
    body: JSON.stringify({ direction }),
  });
  if (result.error) return alert(result.error);
  await loadStops();
}

async function reassignStop(stopId, newDriverId) {
  const result = await api(`/api/admin/stops/${stopId}/reassign`, {
    method: 'POST',
    body: JSON.stringify({ driver_id: newDriverId }),
  });
  if (result.error) return alert(result.error);
  await loadStops();
}

async function unassignStop(stopId) {
  if (!confirm('¿Quitar este pedido de la ruta? Regresa a "Pendientes" para reasignarlo.')) return;
  const result = await api(`/api/admin/stops/${stopId}/unassign`, { method: 'POST' });
  if (result.error) return alert(result.error);
  await loadStops();
}

async function finishRoute(driverId) {
  if (!confirm('¿Marcar esta ruta como terminada? Los pedidos que sigan sin entregar regresan a "Pendientes".')) return;
  const result = await api(`/api/admin/drivers/${driverId}/finish-route`, { method: 'POST' });
  if (result.error) return alert(result.error);
  activeTab = 'pending';
  await loadStops();
}

// --- Liga de monitoreo (vista de solo lectura para compartir con el equipo) ---
async function loadMonitorLink() {
  try {
    const result = await api('/api/admin/monitor-link');
    document.getElementById('monitorLinkInput').value = result.url;
  } catch (e) {
    console.error('No se pudo cargar la liga de monitoreo', e);
  }
}

function copyMonitorLink() {
  const input = document.getElementById('monitorLinkInput');
  input.select();
  navigator.clipboard?.writeText(input.value).then(
    () => alert('Liga copiada.'),
    () => document.execCommand('copy')
  );
}

let kommoPipelines = [];

async function loadKommoPipelines() {
  try {
    kommoPipelines = await api('/api/admin/kommo/pipelines');
    const current = await api('/api/admin/kommo/status-filter');

    const pipelineSelect = document.getElementById('pipelineSelect');
    pipelineSelect.innerHTML = kommoPipelines
      .map((p) => `<option value="${p.id}">${p.name}</option>`)
      .join('');

    if (current.pipeline_id) pipelineSelect.value = current.pipeline_id;
    renderStatusOptions(current.status_id);
  } catch (e) {
    console.error('No se pudieron cargar los embudos de Kommo', e);
  }
}

function renderStatusOptions(selectedStatusId) {
  const pipelineSelect = document.getElementById('pipelineSelect');
  const statusSelect = document.getElementById('statusSelect');
  const pipeline = kommoPipelines.find((p) => String(p.id) === String(pipelineSelect.value));
  const statuses = pipeline ? pipeline.statuses : [];
  statusSelect.innerHTML = statuses
    .map((s) => `<option value="${s.id}">${s.name}</option>`)
    .join('');
  if (selectedStatusId) statusSelect.value = selectedStatusId;
}

function onPipelineChange() {
  renderStatusOptions();
  saveKommoFilter(true);
}

async function saveKommoFilter(silent) {
  const pipeline_id = document.getElementById('pipelineSelect').value;
  const status_id = document.getElementById('statusSelect').value;
  if (!pipeline_id || !status_id) {
    if (!silent) alert('Elige un embudo y una etapa');
    return;
  }
  await api('/api/admin/kommo/status-filter', {
    method: 'POST',
    body: JSON.stringify({ pipeline_id, status_id }),
  });
  if (!silent) alert('Guardado. La proxima sincronizacion usara este embudo/etapa.');
}

// El campo de direccion/liga de Maps ya no se elige aqui (es fijo por
// variable de entorno) - esto solo llena el select de factura.
async function loadKommoFields() {
  try {
    const fields = await api('/api/admin/kommo/custom-fields');
    const currentInvoice = await api('/api/admin/kommo/invoice-field-config');

    const options = fields.map((f) => `<option value="${f.id}">${f.name} (${f.type})</option>`).join('');

    const invoiceSelect = document.getElementById('invoiceFieldSelect');
    invoiceSelect.innerHTML = '<option value="">(sin factura)</option>' + options;
    if (currentInvoice.invoice_field_id) invoiceSelect.value = currentInvoice.invoice_field_id;
  } catch (e) {
    console.error('No se pudieron cargar los campos de Kommo', e);
  }
}

async function saveInvoiceField(silent) {
  const invoice_field_id = document.getElementById('invoiceFieldSelect').value;
  await api('/api/admin/kommo/invoice-field-config', {
    method: 'POST',
    body: JSON.stringify({ invoice_field_id }),
  });
  if (!silent) alert('Guardado. La proxima sincronizacion usara este campo para la factura.');
}

// Una alerta especifica ("3_away" o "next") de un pedido. Desmarcarla la
// deja como "ya mandada" (no se repite); marcarla la vuelve a armar y el
// servidor revisa al toque si ya toca dispararla. No se recarga la lista
// entera para no perder el scroll ni el resto de checkboxes marcados.
async function toggleAlert(stopId, type, armed) {
  await api(`/api/admin/stops/${stopId}/alert`, {
    method: 'POST',
    body: JSON.stringify({ type, armed }),
  });
}

async function syncKommo() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Sincronizando...';
  try {
    const result = await api('/api/admin/sync-kommo', { method: 'POST' });
    let msg = `Sincronizados: ${result.synced}, geocodificados: ${result.geocoded}, con error: ${result.skipped}, quitados: ${result.removed || 0}`;
    if (result.errors && result.errors.length) {
      msg += `\n\nPrimeros errores:\n${result.errors.slice(0, 5).join('\n')}`;
    }
    alert(msg);
    await loadStops();
  } catch (e) {
    alert('Error al sincronizar: ' + e.message);
  }
  btn.disabled = false;
  btn.textContent = '🔄 Sincronizar pedidos desde Kommo';
}

// Agrega un pedido a mano por el ID del lead de Kommo, sin esperar a que
// caiga en el embudo/etapa sincronizado normalmente (ej. un pedido urgente
// que quedo en otra etapa).
async function addLeadManually() {
  const input = document.getElementById('manualLeadId');
  const leadId = input.value.trim();
  if (!leadId) return alert('Pon el ID del lead de Kommo');

  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Agregando...';
  try {
    const result = await api(`/api/admin/leads/${encodeURIComponent(leadId)}/add`, { method: 'POST' });
    if (result.error) {
      alert(result.error);
    } else if (result.errors && result.errors.length) {
      alert(result.errors.join('\n'));
    } else {
      input.value = '';
      await loadStops();
    }
  } catch (e) {
    alert('Error al agregar el pedido: ' + e.message);
  }
  btn.disabled = false;
  btn.textContent = '➕ Agregar';
}

function clearPreview() {
  previewMarkers.forEach((m) => map.removeLayer(m));
  previewMarkers = [];
  if (previewLine) {
    map.removeLayer(previewLine);
    previewLine = null;
  }
  if (previewStartMarker) {
    map.removeLayer(previewStartMarker);
    previewStartMarker = null;
  }
  if (previewEndMarker) {
    map.removeLayer(previewEndMarker);
    previewEndMarker = null;
  }
  previewOrder = null;
  previewDriverId = null;
  previewStart = null;
  previewEnd = null;
  const btn = document.getElementById('confirmRouteBtn');
  if (btn) btn.style.display = 'none';
  const invertBtn = document.getElementById('invertRouteBtn');
  if (invertBtn) invertBtn.style.display = 'none';
  const list = document.getElementById('previewList');
  if (list) list.innerHTML = '';
}

async function previewRoute() {
  const driverId = document.getElementById('driverSelect').value;
  if (!driverId) return alert('Selecciona un repartidor');
  if (!selectedStops.size) return alert('Selecciona al menos un pedido');

  const startValue = document.getElementById('startSelect').value;
  const endValue = document.getElementById('endSelect').value;

  if (startValue === 'pin' && !startPin) return alert('Elige el punto de partida en el mapa');
  if (endValue === 'pin' && !endPin) return alert('Elige el punto final en el mapa');

  const start = resolvePoint(startValue, startPin);
  const end = resolvePoint(endValue, endPin);

  const result = await api('/api/admin/preview-route', {
    method: 'POST',
    body: JSON.stringify({ driver_id: driverId, stop_ids: [...selectedStops], start, end }),
  });
  if (result.error) return alert(result.error);

  clearPreview();
  previewOrder = result.order;
  previewDriverId = driverId;
  previewStart = result.start;
  previewEnd = result.end;

  redrawPreview();

  const path = [];
  if (previewStart) path.push([previewStart.lat, previewStart.lng]);
  previewOrder.forEach((s) => path.push([s.lat, s.lng]));
  if (previewEnd) path.push([previewEnd.lat, previewEnd.lng]);
  if (path.length > 1) {
    map.fitBounds(L.polyline(path).getBounds(), { padding: [40, 40] });
  }
}

// Redibuja marcadores numerados + linea segun el orden actual de previewOrder
// (ya sea recien calculado, o despues de moverlo a mano con las flechas).
// El punto de partida/final SIEMPRE lleva su propio marcador, sea la
// oficina, un cliente, el repartidor, o un pin elegido en el mapa - antes
// solo se veia si elegias "Elegir en el mapa", y en los demas casos
// (ej. la oficina) no aparecia nada.
function redrawPreview() {
  previewMarkers.forEach((m) => map.removeLayer(m));
  previewMarkers = [];
  if (previewLine) {
    map.removeLayer(previewLine);
    previewLine = null;
  }
  if (previewStartMarker) {
    map.removeLayer(previewStartMarker);
    previewStartMarker = null;
  }
  if (previewEndMarker) {
    map.removeLayer(previewEndMarker);
    previewEndMarker = null;
  }

  const path = [];
  if (previewStart) {
    path.push([previewStart.lat, previewStart.lng]);
    previewStartMarker = L.marker([previewStart.lat, previewStart.lng], {
      icon: L.divIcon({
        html: '<div style="font-size:30px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">🚩</div>',
        iconSize: [36, 36],
        iconAnchor: [10, 32],
        className: '',
      }),
    }).addTo(map).bindPopup('Punto de partida');
  }

  previewOrder.forEach((s) => {
    const marker = L.marker([s.lat, s.lng], { icon: seqIcon(s.seq, '#111827') })
      .addTo(map)
      .bindPopup(`Siguiente parada ${s.seq} — ${s.name}`);
    previewMarkers.push(marker);
    path.push([s.lat, s.lng]);
  });

  if (previewEnd) {
    path.push([previewEnd.lat, previewEnd.lng]);
    previewEndMarker = L.marker([previewEnd.lat, previewEnd.lng], {
      icon: L.divIcon({
        html: '<div style="font-size:30px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">🏁</div>',
        iconSize: [36, 36],
        iconAnchor: [10, 32],
        className: '',
      }),
    }).addTo(map).bindPopup('Punto final');
  }

  if (path.length > 1) {
    previewLine = L.polyline(path, { color: '#111827', weight: 3, dashArray: '6,8' }).addTo(map);
  }

  renderPreviewList();
  document.getElementById('confirmRouteBtn').style.display = 'block';
  document.getElementById('invertRouteBtn').style.display = previewOrder.length > 1 ? 'block' : 'none';
}

function renderPreviewList() {
  const container = document.getElementById('previewList');
  if (!previewOrder) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = previewOrder
    .map(
      (s, idx) => `
      <div class="preview-item">
        <span class="stop-seq" style="background:#111827">${s.seq}</span>
        <span class="name">${s.name}</span>
        <button class="mini-btn" onclick="movePreviewStop(${idx}, -1)" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button class="mini-btn" onclick="movePreviewStop(${idx}, 1)" ${idx === previewOrder.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
    `
    )
    .join('');
}

// Mueve manualmente una parada de la vista previa (sube/baja), por si el
// admin conoce el terreno mejor que el algoritmo (calles cerradas, trafico, etc).
function movePreviewStop(idx, dir) {
  const target = idx + dir;
  if (!previewOrder || target < 0 || target >= previewOrder.length) return;
  [previewOrder[idx], previewOrder[target]] = [previewOrder[target], previewOrder[idx]];
  previewOrder.forEach((s, i) => (s.seq = i + 1));
  redrawPreview();
}

// Da la vuelta al orden calculado (el mismo circuito, pero al reves), sin
// tocar el punto de partida ni el final - util cuando el algoritmo elige un
// sentido y el admin prefiere el contrario.
function invertPreviewOrder() {
  if (!previewOrder) return;
  previewOrder.reverse();
  previewOrder.forEach((s, i) => (s.seq = i + 1));
  redrawPreview();
}

async function confirmRoute() {
  if (!previewOrder || !previewDriverId) return;

  const result = await api('/api/admin/assign-route', {
    method: 'POST',
    body: JSON.stringify({
      driver_id: previewDriverId,
      ordered_stop_ids: previewOrder.map((s) => s.stop_id),
    }),
  });

  if (result.error) return alert(result.error);
  alert('Ruta asignada.');
  selectedStops.clear();
  activeTab = previewDriverId; // salta directo a la pestana del repartidor recien asignado
  clearPreview();
  await loadStops();
}

if (adminPass) init();
