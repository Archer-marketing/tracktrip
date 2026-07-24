let adminPass = sessionStorage.getItem('adminPass');
let map, driverMarkers = {}, stopMarkers = [];
let selectedStops = new Set();

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

  map = L.map('map').setView([19.4326, -99.1332], 12); // default CDMX, se ajusta solo
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  await loadDrivers();
  await loadStops();
  await loadKommoPipelines();
  await loadKommoFields();

  const socket = io();
  socket.on('admin:driverUpdate', ({ driver_id, lat, lng }) => {
    updateDriverMarker(driver_id, lat, lng);
  });

  setInterval(loadStops, 20000);
}

async function loadDrivers() {
  const drivers = await api('/api/admin/drivers');
  const list = document.getElementById('drivers');
  const select = document.getElementById('driverSelect');
  list.innerHTML = '';
  select.innerHTML = '';

  drivers.forEach((d) => {
    const div = document.createElement('div');
    div.className = 'stop';
    div.innerHTML = `<b>${d.name}</b> <span class="driver-tag">${d.lat ? 'en línea' : 'sin ubicación'}</span>`;
    list.appendChild(div);

    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name;
    select.appendChild(opt);

    if (d.lat && d.lng) updateDriverMarker(d.id, d.lat, d.lng, d.name);
  });
}

function updateDriverMarker(driverId, lat, lng, name) {
  if (driverMarkers[driverId]) {
    driverMarkers[driverId].setLatLng([lat, lng]);
  } else {
    const icon = L.divIcon({
      html: '🚚',
      iconSize: [24, 24],
      className: '',
    });
    driverMarkers[driverId] = L.marker([lat, lng], { icon }).addTo(map).bindPopup(name || `Repartidor ${driverId}`);
  }
}

// Color estable por cliente (angulo dorado -> tonos bien distribuidos),
// asi el mismo color identifica a un cliente tanto en la lista como en el mapa.
function colorForCustomer(customerId) {
  const hue = (Number(customerId) * 137.508) % 360;
  return `hsl(${hue}, 70%, 45%)`;
}

async function loadStops() {
  const stops = await api('/api/admin/stops');
  const container = document.getElementById('stops');
  container.innerHTML = '';

  stopMarkers.forEach((m) => map.removeLayer(m));
  stopMarkers = [];

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
        const icon = L.divIcon({
          html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 3px rgba(0,0,0,.6)"></div>`,
          iconSize: [16, 16],
          className: '',
        });
        const marker = L.marker([s.lat, s.lng], { icon }).addTo(map).bindPopup(s.name);
        stopMarkers.push(marker);
      }
    });
}

function toggleStop(id, checked) {
  if (checked) selectedStops.add(id);
  else selectedStops.delete(id);
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

    const options = fields.map((f) => `<option value="${f.id}">${f.name} (${f.type})</option>`).join('');

    const fieldSelect = document.getElementById('fieldSelect');
    fieldSelect.innerHTML = options;
    if (current.field_id) fieldSelect.value = current.field_id;
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

async function syncKommo() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Sincronizando...';
  try {
    const result = await api('/api/admin/sync-kommo', { method: 'POST' });
    let msg = `Sincronizados: ${result.synced}, geocodificados: ${result.geocoded}, con error: ${result.skipped}`;
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

async function assignRoute() {
  const driverId = document.getElementById('driverSelect').value;
  if (!driverId) return alert('Selecciona un repartidor');
  if (!selectedStops.size) return alert('Selecciona al menos un pedido');

  const result = await api('/api/admin/assign-route', {
    method: 'POST',
    body: JSON.stringify({ driver_id: driverId, stop_ids: [...selectedStops] }),
  });

  if (result.error) return alert(result.error);
  alert('Ruta asignada:\n' + result.order.join('\n'));
  selectedStops.clear();
  await loadStops();
}

if (adminPass) init();
