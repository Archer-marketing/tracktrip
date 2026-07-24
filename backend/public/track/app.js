const pathParts = location.pathname.split('/').filter(Boolean);
const token = pathParts.length > 1 ? pathParts[pathParts.length - 1] : null;
let map, driverMarker, customerMarker;

function renderEmpty(icon, text) {
  document.getElementById('content').innerHTML = `
    <div class="empty-card">
      <div class="icon">${icon}</div>
      <p>${text}</p>
    </div>
  `;
}

function ensureMapLayout() {
  const content = document.getElementById('content');
  if (document.getElementById('map')) return;
  content.innerHTML = `
    <div class="status-pill" id="statusPill"></div>
    <div class="big-count" id="bigCount"></div>
    <div class="subtext" id="subtext"></div>
    <div id="map"></div>
  `;
  map = L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);
}

function bigIcon(emoji, size, bg) {
  return L.divIcon({
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};border:3px solid white;box-shadow:0 0 6px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;font-size:${size * 0.55}px;">${emoji}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    className: '',
  });
}

function renderEnRuta(data) {
  ensureMapLayout();

  const pill = document.getElementById('statusPill');
  const big = document.getElementById('bigCount');
  const sub = document.getElementById('subtext');

  if (data.remaining === 0) {
    pill.textContent = '🚚 ¡Tu repartidor va en camino a tu pedido!';
    big.textContent = '';
    sub.textContent = 'Prepárate, ¡ya casi llega!';
  } else {
    pill.textContent = '🚚 Tu pedido va en ruta';
    big.textContent = data.remaining;
    sub.textContent = data.remaining === 1 ? 'pedido antes que el tuyo' : 'pedidos antes que el tuyo';
  }

  const bounds = [];
  if (data.driverLocation) {
    const pos = [data.driverLocation.lat, data.driverLocation.lng];
    if (driverMarker) {
      driverMarker.setLatLng(pos);
    } else {
      driverMarker = L.marker(pos, { icon: bigIcon('🚚', 40, '#5b9a3b') }).addTo(map);
    }
    bounds.push(pos);
  }
  if (data.customerLocation) {
    const pos = [data.customerLocation.lat, data.customerLocation.lng];
    if (customerMarker) {
      customerMarker.setLatLng(pos);
    } else {
      customerMarker = L.marker(pos, { icon: bigIcon('🏠', 36, '#b9d97a') }).addTo(map);
    }
    bounds.push(pos);
  }

  if (bounds.length === 2) {
    map.fitBounds(bounds, { padding: [40, 40] });
  } else if (bounds.length === 1) {
    map.setView(bounds[0], 14);
  } else {
    map.setView([20.9674, -89.5926], 12);
  }
  setTimeout(() => map && map.invalidateSize(), 50);
}

async function poll() {
  if (!token) {
    renderEmpty('🔗', 'Liga inválida.');
    return;
  }
  try {
    const res = await fetch(`/api/track/${token}`);
    const data = await res.json();

    if (res.status === 404) return renderEmpty('🔗', 'No encontramos este pedido. Verifica tu liga.');
    if (res.status === 410) return renderEmpty('⏳', 'Esta liga ya expiró. Pídele a la tienda una nueva.');

    if (data.status === 'delivered') return renderEmpty('✅', '¡Tu pedido ya fue entregado! Gracias por tu compra.');
    if (data.status === 'sin_pedido') return renderEmpty('🌿', 'Todavía no encontramos tu pedido.');
    if (data.status === 'pendiente') return renderEmpty('📦', 'Tu pedido está siendo preparado. En breve podrás ver a tu repartidor aquí.');
    if (data.status === 'en_ruta') return renderEnRuta(data);

    renderEmpty('🌿', 'Sin información por ahora.');
  } catch (e) {
    // red caida, se reintenta en el siguiente poll
  }
}

poll();
setInterval(poll, 10000);
