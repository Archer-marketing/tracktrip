const axios = require('axios');
const db = require('../db');
const { geocodeAddress } = require('./geocodeService');

function kommoClient() {
  return axios.create({
    baseURL: `https://${process.env.KOMMO_SUBDOMAIN}.kommo.com/api/v4`,
    headers: { Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}` },
  });
}

function extractCustomField(lead, fieldId) {
  if (!fieldId) return null;
  const cf = (lead.custom_fields_values || []).find(
    (f) => String(f.field_id) === String(fieldId)
  );
  if (!cf || !cf.values || !cf.values.length) return null;
  return cf.values[0].value;
}

// Trae los leads del pipeline/status configurado como "listos para entregar"
// y los sincroniza como customers + stops pendientes.
async function syncFromKommo() {
  const client = kommoClient();
  const params = { with: 'contacts', limit: 250 };
  if (process.env.KOMMO_STATUS_ID) {
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
      if (latlngRaw && latlngRaw.includes(',')) {
        const [la, ln] = latlngRaw.split(',').map((s) => parseFloat(s.trim()));
        lat = la;
        lng = ln;
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
        results.errors.push(`Lead ${lead.id} (${lead.name}): sin direccion valida`);
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

module.exports = { syncFromKommo };
