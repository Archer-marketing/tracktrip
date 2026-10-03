let reorderPass = sessionStorage.getItem('reorderPass');
let drivers = [];
let currentDriverId = null;
let currentStops = []; // [{id, sequence, name, address}] en el orden actual en pantalla
let originalOrderIds = []; // para saber si de verdad cambio algo
let dragging = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-reorder-password': reorderPass,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    sessionStorage.removeItem('reorderPass');
    showGate('Código incorrecto o venció la sesión.');
    throw new Error('No autorizado');
  }
  return res.json();
}

function showGate(error) {
  document.getElementById('gate').style.display = 'flex';
  document.getElementById('topHeader').style.display = 'none';
  document.getElementById('app').style.display = 'none';
  document.getElementById('saveBar').style.display = 'none';
  document.getElementById('gateError').textContent = error || '';
}

async function enter() {
  const pass = document.getElementById('pass').value;
  const result = await fetch('/api/reorder/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pass }),
  }).then((r) => r.json());

  if (result.error) {
    document.getElementById('gateError').textContent = result.error;
    return;
  }
  reorderPass = pass;
  sessionStorage.setItem('reorderPass', pass);
  await init();
}

async function init() {
  document.getElementById('gate').style.display = 'none';
  document.getElementById('topHeader').style.display = 'flex';
  document.getElementById('app').style.display = 'flex';
  await loadDrivers();
}

async function loadDrivers() {
  drivers = await api('/api/reorder/drivers');
  const select = document.getElementById('driverSelect');
  if (!drivers.length) {
    select.innerHTML = '<option>(sin repartidores)</option>';
    return;
  }
  const prev = select.value;
  select.innerHTML = drivers
    .map((d) => `<option value="${d.id}">${d.name} (${d.active_count})</option>`)
    .join('');
  if (prev && [...select.options].some((o) => o.value === prev)) {
    select.value = prev;
  } else {
    currentDriverId = select.value;
  }
  await loadRoute();
}

function onDriverChange() {
  currentDriverId = document.getElementById('driverSelect').value;
  loadRoute();
}

async function loadRoute() {
  if (!currentDriverId) return;
  const data = await api(`/api/reorder/route/${currentDriverId}`);
  currentStops = data.stops || [];
  originalOrderIds = currentStops.map((s) => s.id);
  renderList();
  hideSaveBar();
}

function renderList() {
  const list = document.getElementById('list');
  const emptyMsg = document.getElementById('emptyMsg');

  if (!currentStops.length) {
    list.innerHTML = '';
    emptyMsg.style.display = 'block';
    return;
  }
  emptyMsg.style.display = 'none';

  list.innerHTML = '';
  currentStops.forEach((s, idx) => {
    const div = document.createElement('div');
    div.className = 'reorder-item';
    div.dataset.stopId = s.id;
    div.innerHTML = `
      <span class="reorder-seq">${idx + 1}</span>
      <span class="reorder-info">
        <b>${s.name}</b>
        <small>${s.address || ''}</small>
      </span>
      <span class="drag-handle">☰</span>
    `;
    list.appendChild(div);
  });

  list.querySelectorAll('.drag-handle').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => startDrag(e, handle.closest('.reorder-item')));
  });
}

function startDrag(e, item) {
  e.preventDefault();
  dragging = { el: item, pointerId: e.pointerId, startY: e.clientY };
  item.classList.add('dragging');
  try {
    item.setPointerCapture(e.pointerId);
  } catch (err) {}
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
}

function onDragMove(e) {
  if (!dragging) return;
  const deltaY = e.clientY - dragging.startY;
  dragging.el.style.transform = `translateY(${deltaY}px)`;

  const list = document.getElementById('list');
  const items = [...list.querySelectorAll('.reorder-item')];
  const draggedRect = dragging.el.getBoundingClientRect();
  const draggedMid = draggedRect.top + draggedRect.height / 2;
  const draggedPos = items.indexOf(dragging.el);

  for (const other of items) {
    if (other === dragging.el) continue;
    const rect = other.getBoundingClientRect();
    const otherMid = rect.top + rect.height / 2;
    const otherPos = items.indexOf(other);

    if (otherPos < draggedPos && draggedMid < otherMid) {
      list.insertBefore(dragging.el, other);
      break;
    } else if (otherPos > draggedPos && draggedMid > otherMid) {
      list.insertBefore(dragging.el, other.nextSibling);
      break;
    }
  }
}

function onDragEnd() {
  if (!dragging) return;
  const el = dragging.el;
  el.classList.remove('dragging');
  el.style.transform = '';
  try {
    el.releasePointerCapture(dragging.pointerId);
  } catch (err) {}
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  dragging = null;

  const list = document.getElementById('list');
  const newOrderIds = [...list.querySelectorAll('.reorder-item')].map((e) => Number(e.dataset.stopId));
  currentStops = newOrderIds.map((id) => currentStops.find((s) => s.id === id));
  renderList();

  const changed = newOrderIds.some((id, idx) => id !== originalOrderIds[idx]);
  if (changed) showSaveBar();
  else hideSaveBar();
}

function showSaveBar() {
  document.getElementById('saveBar').style.display = 'block';
  document.getElementById('saveStatus').textContent = '';
}

function hideSaveBar() {
  document.getElementById('saveBar').style.display = 'none';
}

async function saveOrder() {
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  try {
    const ordered_stop_ids = currentStops.map((s) => s.id);
    const result = await api(`/api/reorder/route/${currentDriverId}`, {
      method: 'POST',
      body: JSON.stringify({ ordered_stop_ids }),
    });
    if (result.error) {
      document.getElementById('saveStatus').textContent = result.error;
    } else {
      originalOrderIds = ordered_stop_ids;
      document.getElementById('saveStatus').textContent = '✅ Orden guardado';
      setTimeout(hideSaveBar, 1500);
    }
  } catch (e) {
    document.getElementById('saveStatus').textContent = 'Error al guardar';
  }
  btn.disabled = false;
  btn.textContent = '💾 Guardar orden';
}

if (reorderPass) init();
