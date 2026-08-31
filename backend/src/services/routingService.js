const axios = require('axios');

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Matriz de distancias real usando el servicio /table de OSRM.
// points = [{lat, lng}, ...] -> devuelve matriz NxN en metros, o null si OSRM no responde.
async function getOsrmDistanceMatrix(points) {
  try {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
    const url = `${process.env.OSRM_URL}/table/v1/driving/${coords}`;
    const { data } = await axios.get(url, { params: { annotations: 'distance' }, timeout: 5000 });
    if (data.code !== 'Ok') return null;
    return data.distances;
  } catch (err) {
    return null; // OSRM no disponible -> se usa respaldo
  }
}

// Vecino mas cercano (rapido, O(n^2)) - se usa solo como respaldo cuando hay
// demasiadas paradas para el calculo exacto. `endLocation` es solo un sesgo:
// deja para el final la parada mas cercana a ese punto (no minimiza el total).
function nearestNeighbor(n, distance, endLocation, stops) {
  const remaining = stops.map((_, idx) => idx + 1);
  const order = [];
  let current = 0;

  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const d = distance(current, remaining[k]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = k;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    order.push(stops[next - 1]);
    current = next;
  }

  if (endLocation) {
    let bestIdx = 0;
    let bestDist = Infinity;
    order.forEach((s, idx) => {
      const d = haversine(s, endLocation);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = idx;
      }
    });
    const [closestToEnd] = order.splice(bestIdx, 1);
    order.push(closestToEnd);
  }

  return order;
}

// Held-Karp: calcula el orden EXACTO de menor distancia/tiempo total,
// empezando en el punto de partida y (si se da `endDistance`) terminando
// donde ese costo total (incluyendo el tramo final) sea minimo - a
// diferencia del vecino mas cercano, esto si considera el recorrido
// completo, no solo el siguiente paso.
function heldKarp(n, distance, endDistance, stops) {
  const FULL = (1 << n) - 1;
  const dp = Array.from({ length: 1 << n }, () => new Array(n).fill(Infinity));
  const parent = Array.from({ length: 1 << n }, () => new Array(n).fill(-1));

  for (let i = 0; i < n; i++) {
    dp[1 << i][i] = distance(0, i + 1);
  }

  for (let mask = 1; mask <= FULL; mask++) {
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const cur = dp[mask][i];
      if (cur === Infinity) continue;
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j)) continue;
        const nextMask = mask | (1 << j);
        const cost = cur + distance(i + 1, j + 1);
        if (cost < dp[nextMask][j]) {
          dp[nextMask][j] = cost;
          parent[nextMask][j] = i;
        }
      }
    }
  }

  let bestI = 0;
  let bestCost = Infinity;
  for (let i = 0; i < n; i++) {
    const cost = dp[FULL][i] + (endDistance ? endDistance(i) : 0);
    if (cost < bestCost) {
      bestCost = cost;
      bestI = i;
    }
  }

  const orderIdx = [];
  let mask = FULL;
  let i = bestI;
  while (i !== -1) {
    orderIdx.push(i);
    const pi = parent[mask][i];
    mask ^= 1 << i;
    i = pi;
  }
  orderIdx.reverse();

  return orderIdx.map((idx) => stops[idx]);
}

// Limite hasta donde el calculo exacto (Held-Karp, O(n^2 * 2^n)) sigue siendo
// instantaneo. Con mas paradas que esto se usa el respaldo aproximado.
const EXACT_LIMIT = 14;

// Calcula el orden de menor tiempo/distancia total para visitar `stops`
// empezando en `startLocation` (repartidor, un pin, o un cliente) y,
// si se da `endLocation`, terminando lo mas cerca posible de ese punto
// (puede ser otro pin o cliente, no necesariamente una de las paradas).
async function optimizeRoute(startLocation, stops, endLocation) {
  // stops: [{ id, lat, lng, ... }]
  if (stops.length === 0) return [];
  if (stops.length === 1) return [stops[0]];

  const points = [startLocation, ...stops];
  let matrix = await getOsrmDistanceMatrix(points);

  const distance = (i, j) => {
    if (matrix) return matrix[i][j];
    return haversine(points[i], points[j]);
  };

  const n = stops.length;

  if (n <= EXACT_LIMIT) {
    const endDistance = endLocation ? (i) => haversine(stops[i], endLocation) : null;
    return heldKarp(n, distance, endDistance, stops);
  }

  return nearestNeighbor(n, distance, endLocation, stops);
}

module.exports = { optimizeRoute, haversine };
