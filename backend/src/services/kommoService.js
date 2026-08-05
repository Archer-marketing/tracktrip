const axios = require('axios');
const db = require('../db');
const { geocodeAddress } = require('./geocodeService');
const { getSetting, setSetting } = require('./settingsService');
const { parseLatLng } = require('./mapsLinkService');

function kommoClient() {
  return axios.create({
    baseURL: `https://${process.env.KOMMO_SUBDOMAIN}.kommo.com/api/v4`,
    headers: { Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}` },
  });
}

// Kommo limita a 7 solicitudes/segundo por cuenta. Esta cola serializa las
// llamadas dejando ~170ms entre cada una (~6/seg, con margen), asi nunca se
// manda mas de una a la vez ni se pasa del limite aunque se disparen muchas
// juntas (ej. al asignar una ruta con varios pedidos).
let kommoQueueTail = Promise.resolve();
function throttledKommoCall(fn) {
  const run = kommoQueueTail.then(async () => {
    try {
      return await fn();
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 170));
    }
  });
  kommoQueueTail = run.catch(() => {});
  return run;
}

// Campo personalizado de lead donde se escribe la liga publica de rastreo.
const TRACKING_FIELD_ID = process.env.KOMMO_TRACKING_FIELD_ID || '2445646';

async function updateLeadTrackingField(leadId, url) {
  const client = kommoClient();
  return throttledKommoCall(() =>
    client.patch(`/leads/${leadId}`, {
      custom_fields_values: [{ field_id: Number(TRACKING_FIELD_ID), values: [{ value: url }] }],
    })
  );
}

// Dispara un Salesbot de Kommo sobre un lead (ej. avisar "faltan 3 pedidos"
// o "eres el siguiente"). Pasa por la misma cola con limite de tasa.
async function runSalesbot(botId, leadId) {
  const client = kommoClient();
  return throttledKommoCall(() =>
    client.post(`/bots/${botId}/run`, { entity_id: Number(leadId), entity_type: 'leads' })
  );
}

// Al marcar un pedido como entregado, mueve el lead a la etapa configurada
// por variable de entorno (igual que KOMMO_TRACKING_FIELD_ID: fijo por env,
// sin control en el panel). Si no esta configurada, no hace nada.
async function markLeadDelivered(leadId) {
  const statusId = process.env.KOMMO_DELIVERED_STATUS_ID;
  if (!statusId) return;

  const body = { status_id: Number(statusId) };
  if (process.env.KOMMO_DELIVERED_PIPELINE_ID) {
    body.pipeline_id = Number(process.env.KOMMO_DELIVERED_PIPELINE_ID);
  }

  const client = kommoClient();
  return throttledKommoCall(() => client.patch(`/leads/${leadId}`, body));
}

// Deja solo digitos y se queda con los ultimos 10 (ignora "+52", "01",
// lada larga, espacios/guiones, etc. - asi comparamos numeros mexicanos
// sin importar como los haya guardado cada sistema).
function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  return digits.slice(-10);
}

// Busca en Kommo un lead cuyo contacto tenga ese telefono (comparando solo
// los ultimos 10 digitos). Se usa para conciliar facturas de Zoho Books
// con leads de Kommo. Devuelve el primer lead_id que haga match, o null.
async function findLeadByPhone(phone) {
  const last10 = normalizePhone(phone);
  if (!last10) return null;

  const client = kommoClient();
  const { data } = await throttledKommoCall(() =>
    client.get('/contacts', { params: { query: last10, with: 'leads', limit: 25 } })
  );
  const contacts = data?._embedded?.contacts || [];

  for (const contact of contacts) {
    const phoneField = (contact.custom_fields_values || []).find((f) => f.field_code === 'PHONE');
    const matches = (phoneField?.values || []).some((v) => normalizePhone(v.value) === last10);
    if (!matches) continue;

    const leads = contact._embedded?.leads || [];
    if (leads.length) return leads[0].id;
  }
  return null;
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

// Campos personalizados de leads, para el selector de "campo de direccion" / "campo lat-lng".
async function getLeadCustomFields() {
  const client = kommoClient();
  let fields = [];
  let page = 1;
  while (true) {
    const { data } = await client.get('/leads/custom_fields', { params: { limit: 250, page } });
    const batch = data?._embedded?.custom_fields || [];
    fields = fields.concat(batch);
    if (batch.length < 250) break;
    page++;
  }
  return fields.map((f) => ({ id: f.id, name: f.name, type: f.type }));
}

// Un solo campo: puede tener texto de direccion o una liga de Maps
// (completa, acortada, o "lat,lng" plano). syncFromKommo detecta cual es.
// Fijo por variable de entorno (igual que KOMMO_TRACKING_FIELD_ID) - sin
// control en el panel.
function getSyncFieldConfig() {
  return {
    field_id: process.env.KOMMO_LATLNG_FIELD_ID || process.env.KOMMO_ADDRESS_FIELD_ID || '',
  };
}

// Campo opcional con la factura del pedido (liga o texto), para mostrarle
// al repartidor junto con la parada.
function getSyncInvoiceFieldConfig() {
  return { invoice_field_id: getSetting('kommo_invoice_field_id') || '' };
}

function setSyncInvoiceFieldConfig(fieldId) {
  setSetting('kommo_invoice_field_id', fieldId ? String(fieldId) : '');
}

function extractCustomField(lead, fieldId) {
  if (!fieldId) return null;
  const cf = (lead.custom_fields_values || []).find(
    (f) => String(f.field_id) === String(fieldId)
  );
  if (!cf || !cf.values || !cf.values.length) return null;
  return cf.values[0].value;
}

function customerStatements() {
  return {
    insertCustomer: db.prepare(`
      INSERT INTO customers (kommo_lead_id, name, address, lat, lng, phone, invoice)
      VALUES (@kommo_lead_id, @name, @address, @lat, @lng, @phone, @invoice)
      ON CONFLICT(kommo_lead_id) DO UPDATE SET
        name=excluded.name, address=excluded.address,
        lat=excluded.lat, lng=excluded.lng, phone=excluded.phone, invoice=excluded.invoice
    `),
    findCustomerId: db.prepare(`SELECT id FROM customers WHERE kommo_lead_id = ?`),
    hasPendingStop: db.prepare(
      `SELECT id FROM stops WHERE customer_id = ? AND status IN ('pending','assigned')`
    ),
    insertStop: db.prepare(`INSERT INTO stops (customer_id, status) VALUES (?, 'pending')`),
  };
}

// Procesa un lead (geocodifica/guarda como customer + stop pendiente).
// Compartido por syncFromKommo (varios leads de un filtro) y addLeadById
// (un lead especifico agregado a mano, sin importar el filtro/etapa).
async function processLead(lead, fieldIds, statements, results) {
  const { field_id, invoice_field_id } = fieldIds;
  const { insertCustomer, findCustomerId, hasPendingStop, insertStop } = statements;

  try {
    const raw = extractCustomField(lead, field_id);
    let lat = null;
    let lng = null;

    const parsed = await parseLatLng(raw);
    if (parsed) {
      lat = parsed.lat;
      lng = parsed.lng;
    } else if (raw) {
      const geo = await geocodeAddress(raw);
      if (geo) {
        lat = geo.lat;
        lng = geo.lng;
        results.geocoded++;
      }
    }

    // Aunque no tengamos ubicacion, guardamos el lead igual (lat/lng en null)
    // para que aparezca marcado como "sin ubicacion" en el panel, en vez de
    // desaparecer silenciosamente hasta la proxima sincronizacion.
    if (lat == null || lng == null) {
      results.skipped++;
      const reason = !raw
        ? 'no se encontro el campo de direccion/Maps en este lead (revisa el selector "Kommo: campo" en el panel)'
        : `no se pudo geocodificar "${raw}"`;
      results.errors.push(`Lead ${lead.id} (${lead.name}): ${reason}`);
    }

    const phone = lead._embedded?.contacts?.[0]?.id ? '' : '';
    const invoice = extractCustomField(lead, invoice_field_id);

    insertCustomer.run({
      kommo_lead_id: String(lead.id),
      name: lead.name || `Pedido ${lead.id}`,
      address: raw || '',
      lat,
      lng,
      phone,
      invoice: invoice || null,
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

  const statements = customerStatements();
  const fieldIds = { field_id: getSyncFieldConfig().field_id, invoice_field_id: getSyncInvoiceFieldConfig().invoice_field_id };
  const results = { synced: 0, geocoded: 0, skipped: 0, removed: 0, errors: [] };
  const syncedLeadIds = new Set();

  for (const lead of leads) {
    await processLead(lead, fieldIds, statements, results);
    syncedLeadIds.add(String(lead.id));
  }

  // Quita de "pendientes" los leads que ya no aparecen en este sync (ej.
  // cambiaste de embudo/etapa, o el lead se movio/cerro en Kommo). Solo
  // toca 'pending' (nada asignado ni entregado) para no perder trabajo
  // que ya esta en curso.
  const pendingWithLead = db
    .prepare(
      `SELECT s.id, c.kommo_lead_id
       FROM stops s JOIN customers c ON c.id = s.customer_id
       WHERE s.status = 'pending'`
    )
    .all();
  const stale = pendingWithLead.filter((s) => !syncedLeadIds.has(String(s.kommo_lead_id)));
  if (stale.length) {
    const deleteStop = db.prepare('DELETE FROM stops WHERE id = ?');
    const tx = db.transaction((rows) => rows.forEach((r) => deleteStop.run(r.id)));
    tx(stale);
    results.removed = stale.length;
  }

  return results;
}

// Agrega un lead especifico por su ID, sin importar el embudo/etapa
// configurado para el sync normal - para cuando falta un pedido puntual.
async function addLeadById(leadId) {
  const client = kommoClient();
  let lead;
  try {
    const { data } = await client.get(`/leads/${leadId}`, { params: { with: 'contacts' } });
    lead = data;
  } catch (err) {
    if (err.response?.status === 404) {
      throw new Error(`No se encontro el lead ${leadId} en Kommo`);
    }
    throw err;
  }

  const statements = customerStatements();
  const fieldIds = { field_id: getSyncFieldConfig().field_id, invoice_field_id: getSyncInvoiceFieldConfig().invoice_field_id };
  const results = { synced: 0, geocoded: 0, skipped: 0, errors: [] };

  await processLead(lead, fieldIds, statements, results);
  return results;
}

module.exports = {
  syncFromKommo,
  addLeadById,
  getPipelines,
  getSyncStatusFilter,
  setSyncStatusFilter,
  getLeadCustomFields,
  getSyncFieldConfig,
  getSyncInvoiceFieldConfig,
  setSyncInvoiceFieldConfig,
  updateLeadTrackingField,
  runSalesbot,
  markLeadDelivered,
  findLeadByPhone,
};
