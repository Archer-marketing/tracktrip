const axios = require('axios');

// Nominatim (OSM) pide max 1 request/segundo. Hacemos una cola simple.
let lastCall = 0;
async function throttle() {
  const wait = Math.max(0, 1100 - (Date.now() - lastCall));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

async function geocodeAddress(address) {
  await throttle();
  const url = `${process.env.NOMINATIM_URL}/search`;
  const { data } = await axios.get(url, {
    params: { q: address, format: 'json', limit: 1 },
    headers: { 'User-Agent': process.env.NOMINATIM_USER_AGENT || 'delivery-tracker' },
  });
  if (!data || !data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

module.exports = { geocodeAddress };
