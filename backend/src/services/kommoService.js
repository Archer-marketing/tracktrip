const axios = require('axios');
const db = require('../db');
const { geocodeAddress } = require('./geocodeService');
const { getSetting, setSetting } = require('./settingsService');

function kommoClient() {
  return axios.create({
    baseURL: `https://${process.env.KOMMO_SUBDOMAIN}.kommo.com/api/v4`,
    headers: { Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}` },
  });
}

// Embudos (pipelines) y etapas (statuses) de la cuenta, para el selector del panel.
async function getPipelines() {
  const client = kommoClient();
  const { data } = await client.get('/leads/pipelines');
  const pipelines = data?._embedded?.pipelines || [];
  return pipelines.map((p) => ({
    id: p.id,
    name: p.name,
    statuses: (p._embedded?.statuses || []).map((s) => ({ id: s.id, name: s.name })),
  }));
}

function getSyncStatusFilter() {
  return {
    pipeline_id: getSetting('kommo_pipeline_id'),
    status_id: getSetting('kommo_status_id'),
  };
}

function setSyncStatusFilter(pipelineId, statusId) {
  setSetting('kommo_pipeline_id', String(pipelineId));
  setSetting('kommo_status_id', String(statusId));
}

function extractCustomField(lead, fieldId) {
  if (!fieldId) return null;
  const cf = (lead.custom_fields_values || []).find(
    (f) => String(f.field_id) === String(fieldId)
  );
  if (!cf || !cf.values || !cf.values.length) return null;
  return cf.values[0].value;
}

// Busca coordenadas en el texto de un link de Google Maps ya "completo"
// (formatos !3d..!4d.., @lat,lng,zoom o ?q=lat,lng).
function extractLatLngFromText(str) {
  const dataMatch = str.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (dataMatch) return { lat: parseFloat(dataMatch[1]), lng: parseFloat(dataMatch[2]) };

  const atMatch = str.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atMatch) return { lat: parseFloat(atMatch[1]), lng: parseFloat(atMatch[2]) };

  const qMatch = str.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (qMatch) return { lat: parseFloat(qMatch[1]), lng: parseFloat(qMatch[2]) };

  const plainMatch = str.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (plainMatch) return { lat: parseFloat(plainMatch[1]), lng: parseFloat(plainMatch[2]) };

  return null;
}

// Ligas cortas (maps.app.goo.gl, goo.gl/maps) no traen coords en el texto,
// pero Google responde con un redirect 302 hacia la URL completa que si las
// trae. Sin API key ni servicio externo: solo seguimos esa redireccion.
async function resolveRedirectLocation(url) {
  try {
    const res = await axios.get(url, { maxRedirects: 0, validateStatus: () => true, timeout: 5000 });
    return res.headers.location || null;
  } catch (err) {
    return null;
  }
}

// Acepta "lat,lng" plano, un link de Google Maps completo, o uno acortado.
async function parseLatLng(raw) {
  if (!raw) return null;

  let current = raw.trim();
  const direct = extractLatLngFromText(current);
  if (direct) return direct;

  if (/^https?:\/\//.test(current)) {
    for (let hop = 0; hop < 5; hop++) {
      const next = await resolveRedirectLocation(current);
      if (!next) break;
      const found = extractLatLngFromText(next);
      if (found) return found;
      current = next;
    }
  }

  return null;
}

// Trae los leads del pipeline/status configurado como "listos para entregar"
// y los sincroniza como customers + stops pendientes.
async function syncFromKommo() {
  const client = kommoClient();
  const params = { with: 'contacts', limit: 250 };

  const { pipeline_id, status_id } = getSyncStatusFilter();
  if (pipeline_id && status_id) {
    // Kommo pide pipeline_id + status_id juntos para filtrar una etapa especifica.
    params['filter[statuses][0][pipeline_id]'] = pipeline_id;
    params['filter[statuses][0][status_id]'] = status_id;
  } else if (process.env.KOMMO_STATUS_ID) {
    // Compatibilidad con la variable de entorno anterior (sin pipeline_id).
    params['filter[statuses][0][status_id]'] = process.env.KOMMO_STATUS_ID;
  }

  const { data } = await client.get('/leads', { params });
  const leads = data?._embedded?.leads || [];

  const insertCustomer = db.prepare(`
    INSERT INTO customers (kommo_lead_id, name, address, lat, lng, phone)
    VALUES (@kommo_lead_id, @name, @address, @lat, @lng, @phone)
    ON CONFLICT(kommo_lead_id) DO UPDATE SET
      name=excluded.name, address=excluded.address,
      lat=excluded.lat, lng=excluded.lng, phone=excluded.phone
  `);
  const findCustomerId = db.prepare(`SELECT id FROM customers WHERE kommo_lead_id = ?`);
  const hasPendingStop = db.prepare(
    `SELECT id FROM stops WHERE customer_id = ? AND status IN ('pending','assigned')`
  );
  const insertStop = db.prepare(
    `INSERT INTO stops (customer_id, status) VALUES (?, 'pending')`
  );

  const results = { synced: 0, geocoded: 0, skipped: 0, errors: [] };

  for (const lead of leads) {
    try {
      const address = extractCustomField(lead, process.env.KOMMO_ADDRESS_FIELD_ID);
      let lat = null;
      let lng = null;

      const latlngRaw = extractCustomField(lead, process.env.KOMMO_LATLNG_FIELD_ID);
      const parsed = await parseLatLng(latlngRaw);
      if (parsed) {
        lat = parsed.lat;
        lng = parsed.lng;
      } else if (address) {
        const geo = await geocodeAddress(address);
        if (geo) {
          lat = geo.lat;
          lng = geo.lng;
          results.geocoded++;
        }
      }

      if (lat == null || lng == null) {
        results.skipped++;
        const reason = !latlngRaw && !address
          ? 'no se encontro el campo de direccion ni de lat/lng en el lead (revisa KOMMO_ADDRESS_FIELD_ID / KOMMO_LATLNG_FIELD_ID)'
          : `no se pudo geocodificar la direccion "${address}"`;
        results.errors.push(`Lead ${lead.id} (${lead.name}): ${reason}`);
        continue;
      }

      const phone = lead._embedded?.contacts?.[0]?.id ? '' : '';

      insertCustomer.run({
        kommo_lead_id: String(lead.id),
        name: lead.name || `Pedido ${lead.id}`,
        address: address || '',
        lat,
        lng,
        phone,
      });

      const customer = findCustomerId.get(String(lead.id));
      if (customer && !hasPendingStop.get(customer.id)) {
        insertStop.run(customer.id);
      }
      results.synced++;
    } catch (err) {
      results.errors.push(`Lead ${lead.id}: ${err.message}`);
    }
  }

  return results;
}

module.exports = { syncFromKommo, getPipelines, getSyncStatusFilter, setSyncStatusFilter };
