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

// Algoritmo de "vecino mas cercano" empezando desde el punto del repartidor.
// points[0] es SIEMPRE la posicion actual del repartidor (no se incluye en el resultado).
async function optimizeRoute(driverLocation, stops) {
  // stops: [{ id, lat, lng, ... }]
  if (stops.length === 0) return [];
  if (stops.length === 1) return [stops[0]];

  const points = [driverLocation, ...stops];
  let matrix = await getOsrmDistanceMatrix(points);

  const distance = (i, j) => {
    if (matrix) return matrix[i][j];
    return haversine(points[i], points[j]);
  };

  const remaining = stops.map((_, idx) => idx + 1); // indices en `points`, offset por el repartidor
  const order = [];
  let current = 0; // indice del repartidor

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

  return order;
}

module.exports = { optimizeRoute, haversine };
