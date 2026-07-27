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
  await loadAlertsEnabled();

  const socket = io();
  socket.on('admin:driverUpdate', ({ driver_id, lat, lng }) => {
    updateDriverMarker(driver_id, lat, lng);
  });

  setInterval(loadStops, 20000);
}

async function loadDrivers() {
  const drivers = await api('/api/admin/drivers');
  driversById = Object.fromEntries(drivers.map((d) => [String(d.id), d]));
  const list = document.getElementById('drivers');
  const select = document.getElementById('driverSelect');
  list.innerHTML = '';
  select.innerHTML = '';

  drivers.forEach((d) => {
    const div = document.createElement('div');
    div.className = 'stop' + (d.active ? '' : ' stop-missing');
    div.innerHTML = `
      <b>${d.name}</b> <span class="driver-tag">${d.lat ? 'en línea' : 'sin ubicación'}</span><br>
      <small>código: ${d.login_code}</small><br>
      <button class="mini-btn" style="width:auto" onclick="toggleDriverActive(${d.id}, ${d.active ? 0 : 1})">
        ${d.active ? '🚫 Desactivar' : '✅ Activar'}
      </button>
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
}

async function toggleDriverActive(id, active) {
  await api(`/api/admin/drivers/${id}/active`, {
    method: 'POST',
    body: JSON.stringify({ active }),
  });
  await loadDrivers();
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

function updateDriverMarker(driverId, lat, lng, name) {
  if (driverMarkers[driverId]) {
    driverMarkers[driverId].setLatLng([lat, lng]);
  } else {
    const icon = L.divIcon({
      html: '<div style="font-size:34px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">🚚</div>',
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      className: '',
    });
    driverMarkers[driverId] = L.marker([lat, lng], { icon }).addTo(map).bindPopup(name || `Repartidor ${driverId}`);
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
function renderStopsList(stops) {
  const container = document.getElementById('stops');
  container.innerHTML = '';

  stopMarkers.forEach((m) => map.removeLayer(m));
  stopMarkers = [];

  document.getElementById('assignControls').style.display = activeTab === 'pending' ? 'block' : 'none';

  const routeActions = document.getElementById('routeActions');
  const activeAssignedCount =
    activeTab !== 'pending'
      ? stops.filter((s) => String(s.driver_id) === String(activeTab) && s.status === 'assigned').length
      : 0;
  routeActions.innerHTML = activeAssignedCount
    ? `<button class="btn-danger" onclick="finishRoute(${activeTab})">✅ Marcar ruta como terminada</button>`
    : '';

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
            <input type="checkbox" data-id="${s.id}" onchange="toggleStop(${s.id}, this.checked)" ${hasLocation ? '' : 'disabled'} />
            <span class="stop-color" style="background:${color}"></span>
            <span>
              ${s.name}<br>
              <small>${s.address || ''}</small><br>
              ${hasLocation ? '' : '<small class="stop-warn">⚠️ Sin ubicación — corrige el lead en Kommo y vuelve a sincronizar</small><br>'}
              ${s.kommo_url ? `<a href="${s.kommo_url}" target="_blank" rel="noopener">Ver en Kommo →</a>` : ''}
            </span>
          </label>
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

    const actionsHtml = done
      ? ''
      : `
        <span class="stop-actions">
          <button class="mini-btn" onclick="moveStop(${s.id}, 'up')" ${isFirst ? 'disabled' : ''}>▲</button>
          <button class="mini-btn" onclick="moveStop(${s.id}, 'down')" ${isLast ? 'disabled' : ''}>▼</button>
          <button class="mini-btn remove" onclick="unassignStop(${s.id})">✖</button>
        </span>
      `;

    const div = document.createElement('div');
    div.className = 'stop ' + (done ? 'stop-delivered' : 'stop-assigned');
    div.innerHTML = `
      <label>
        <span class="stop-seq" style="background:${done ? '#16a34a' : color}">${done ? '✅' : s.sequence ?? '?'}</span>
        <span>
          ${s.name}<br>
          <small>${done ? 'Entregado' : `Parada ${s.sequence ?? '?'}`}</small><br>
          <small>${s.address || ''}</small><br>
          ${s.kommo_url ? `<a href="${s.kommo_url}" target="_blank" rel="noopener">Ver en Kommo →</a>` : ''}
        </span>
        ${actionsHtml}
      </label>
    `;
    container.appendChild(div);

    if (hasLocation) {
      const icon = done
        ? L.divIcon({ html: '<div style="font-size:18px;opacity:.7">✅</div>', iconSize: [22, 22], className: '' })
        : seqIcon(s.sequence ?? '?', color);
      const marker = L.marker([s.lat, s.lng], { icon })
        .addTo(map)
        .bindPopup(done ? `Entregado — ${s.name}` : `Siguiente parada ${s.sequence} — ${s.name} (${driver ? driver.name : 'repartidor ' + activeTab})`);
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

// --- Editar una ruta ya confirmada (pestana de un repartidor) ---

async function moveStop(stopId, direction) {
  const result = await api(`/api/admin/stops/${stopId}/move`, {
    method: 'POST',
    body: JSON.stringify({ direction }),
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

async function loadKommoFields() {
  try {
    const fields = await api('/api/admin/kommo/custom-fields');
    const current = await api('/api/admin/kommo/field-config');
    const currentInvoice = await api('/api/admin/kommo/invoice-field-config');

    const options = fields.map((f) => `<option value="${f.id}">${f.name} (${f.type})</option>`).join('');

    const fieldSelect = document.getElementById('fieldSelect');
    fieldSelect.innerHTML = options;
    if (current.field_id) fieldSelect.value = current.field_id;

    const invoiceSelect = document.getElementById('invoiceFieldSelect');
    invoiceSelect.innerHTML = '<option value="">(sin factura)</option>' + options;
    if (currentInvoice.invoice_field_id) invoiceSelect.value = currentInvoice.invoice_field_id;
  } catch (e) {
    console.error('No se pudieron cargar los campos de Kommo', e);
  }
}

async function saveKommoFields(silent) {
  const field_id = document.getElementById('fieldSelect').value;
  if (!field_id) {
    if (!silent) alert('Elige un campo');
    return;
  }
  await api('/api/admin/kommo/field-config', {
    method: 'POST',
    body: JSON.stringify({ field_id }),
  });
  if (!silent) alert('Guardado. La proxima sincronizacion usara este campo.');
}

async function saveInvoiceField(silent) {
  const invoice_field_id = document.getElementById('invoiceFieldSelect').value;
  await api('/api/admin/kommo/invoice-field-config', {
    method: 'POST',
    body: JSON.stringify({ invoice_field_id }),
  });
  if (!silent) alert('Guardado. La proxima sincronizacion usara este campo para la factura.');
}

// Interruptor global de alertas (salesbots 103880/103878). Desmarcado, no
// se dispara nada al confirmar rutas ni al entregar - pero tampoco se
// marca como "ya notificado", asi que si se vuelve a activar despues, los
// pedidos que ya iban a avisar lo siguen haciendo.
async function loadAlertsEnabled() {
  try {
    const { enabled } = await api('/api/admin/alerts-enabled');
    document.getElementById('alertsEnabledCheckbox').checked = enabled;
  } catch (e) {
    console.error('No se pudo cargar el estado de alertas', e);
  }
}

async function saveAlertsEnabled() {
  const enabled = document.getElementById('alertsEnabledCheckbox').checked;
  await api('/api/admin/alerts-enabled', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
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
