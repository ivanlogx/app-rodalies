/**
 * Rodalies Proxy Server
 * 
 * Actúa como intermediario entre el frontend y los feeds GTFS-RT de Renfe.
 * Añade cabeceras CORS para que el navegador pueda hacer peticiones.
 * 
 * Fuente de datos: gtfsrt.renfe.com (CC-BY 4.0, actualizado cada 20s)
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const NodeCache = require('node-cache');
const path  = require('path');

const app   = express();
const cache = new NodeCache({ stdTTL: 20 }); // caché 20 segundos (igual que Renfe)

// ── CORS: permite peticiones desde cualquier origen ──────────────────────────
app.use(cors());
app.use(express.json());

// ── Sirve el frontend estático desde /public ─────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── URLs de Renfe GTFS-RT (datos abiertos CC-BY 4.0) ────────────────────────
const RENFE_URLS = {
  tripUpdates:   'https://gtfsrt.renfe.com/trip_updates.json',
  vehiclePos:    'https://gtfsrt.renfe.com/vehicle_positions.json',
  alerts:        'https://gtfsrt.renfe.com/alerts.json',
};

// ── Mapeo de stop_id GTFS → nombre legible (subset Rodalies Catalunya) ──────
// Los stop_id en el feed de Renfe son códigos numéricos de 5 dígitos
const STOP_NAMES = {
  '79300': 'Barcelona-Sants',
  '79302': 'Barcelona-Passeig de Gràcia',
  '79304': 'Barcelona-Plaça de Catalunya',
  '79306': 'Barcelona-Arc de Triomf',
  '79308': 'Barcelona-El Clot',
  '79310': 'La Sagrera-Meridiana',
  '79312': 'Barcelona-Sant Andreu',
  '79314': 'Barcelona-Fabra i Puig',
  '79316': 'Barcelona-Estació de França',
  '79318': "L'Hospitalet de Llobregat",
  '79320': 'Cornellà',
  '79322': 'Sant Joan Despí',
  '79324': 'Sant Feliu de Llobregat',
  '79326': 'Molins de Rei',
  '79328': 'El Papiol',
  '79330': 'Molins de Rei',
  '79400': 'Castellbisbal',
  '79402': 'Martorell Central',
  '79404': 'Gelida',
  '79406': "Sant Sadurní d'Anoia",
  '79408': 'Lavern-Subirats',
  '79410': 'La Granada',
  '79412': 'Vilafranca del Penedès',
  '79414': 'Els Monjos',
  '79416': "L'Arboç",
  '79418': 'El Vendrell',
  '79420': 'Sant Vicenç de Calders',
  '79200': 'Montcada Bifurcació',
  '79202': 'Montcada i Reixac',
  '79204': 'Montcada-Ripollet',
  '79206': 'Barberà del Vallès',
  '79208': 'Sabadell Sud',
  '79210': 'Sabadell Centre',
  '79212': 'Sabadell Nord',
  '79214': 'Terrassa Est',
  '79216': 'Terrassa Estació del Nord',
  '79218': 'Rubí',
  '79220': 'Cerdanyola del Vallès',
  '79222': 'Cerdanyola Universitat',
  '79100': 'Mollet-Sant Fost',
  '79102': 'Mollet-Santa Rosa',
  '79104': 'La Llagosta',
  '79106': 'Les Franqueses del Vallès',
  '79108': 'Granollers Centre',
  '79110': 'Granollers-Canovelles',
  '78800': 'La Sagrera-Meridiana',
  '78802': 'Sant Adrià de Besòs',
  '78804': 'Badalona',
  '78806': 'Montgat',
  '78808': 'Montgat Nord',
  '78810': 'El Masnou',
  '78812': 'Ocata',
  '78814': 'Premià de Mar',
  '78816': 'Vilassar de Mar',
  '78818': 'Cabrera de Mar-Vilassar',
  '78820': 'Mataró',
  '78822': 'Sant Pol de Mar',
  '78824': 'Calella',
  '78826': 'Pineda de Mar',
  '78828': 'Santa Susanna',
  '78830': 'Blanes',
  '78832': 'Tordera',
  '78834': 'Maçanet-Massanes',
  '72000': 'Bellvitge | Gornal',
  '72002': 'El Prat de Llobregat',
  '72004': 'Aeroport',
  '72006': 'Viladecans',
  '72008': 'Gavà',
  '72010': 'Castelldefels',
  '72012': 'Platja de Castelldefels',
  '72014': 'Garraf',
  '72016': 'Sitges',
  '72018': 'Vilanova i la Geltrú',
  '72020': 'Cubelles',
  '72022': 'Cunit',
  '72024': 'Segur de Calafell',
  '72026': 'Calafell',
  '79500': 'La Garriga',
  '79502': 'Figaró',
  '79504': 'Vic',
  '79506': 'Puigcerdà',
  '71000': 'Girona',
  '71002': 'Figueres',
  '71004': 'Portbou',
  '73000': 'Tarragona',
  '73002': 'Reus',
  '73004': 'Cambrils',
  '73006': 'Salou-Port Aventura',
  '73008': 'Tortosa',
  '74000': 'Lleida Pirineus',
};

// ── Función para parsear timestamp GTFS ──────────────────────────────────────
function tsToTime(ts) {
  if (!ts) return null;
  const d = new Date(Number(ts) * 1000);
  return d.toTimeString().slice(0, 5); // "HH:MM"
}

// ── Fetch con caché ───────────────────────────────────────────────────────────
async function fetchWithCache(url) {
  const cached = cache.get(url);
  if (cached) return cached;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'RodaliesProxy/1.0' },
    timeout: 8000,
  });
  if (!res.ok) throw new Error(`Renfe API error: ${res.status}`);
  const data = await res.json();
  cache.set(url, data);
  return data;
}

// ── Ruta: GET /api/departures?stopId=79300 ───────────────────────────────────
// Devuelve los próximos trenes para una estación concreta
app.get('/api/departures', async (req, res) => {
  const { stopId } = req.query;
  if (!stopId) return res.status(400).json({ error: 'stopId es requerido' });

  try {
    const data = await fetchWithCache(RENFE_URLS.tripUpdates);
    const entities = data.entity || [];

    const now = Math.floor(Date.now() / 1000);
    const departures = [];

    for (const entity of entities) {
      const tu = entity.trip_update;
      if (!tu) continue;

      const stopUpdates = tu.stop_time_update || [];
      for (const stu of stopUpdates) {
        if (String(stu.stop_id) !== String(stopId)) continue;

        const depTs = stu.departure?.time || stu.arrival?.time;
        if (!depTs || Number(depTs) < now - 60) continue; // ya pasó

        const arrTs = stu.arrival?.time;
        const depDelay = stu.departure?.delay || 0;
        const arrDelay = stu.arrival?.delay || 0;

        // Buscar destino (última parada del viaje)
        const lastStop = stopUpdates[stopUpdates.length - 1];
        const destId   = lastStop?.stop_id;
        const destName = STOP_NAMES[destId] || destId || 'Desconocido';

        departures.push({
          tripId:    tu.trip?.trip_id || '',
          routeId:   tu.trip?.route_id || '',
          stopId:    stu.stop_id,
          departure: tsToTime(depTs),
          departureTs: Number(depTs),
          arrival:   tsToTime(arrTs),
          delay:     depDelay,        // segundos de retraso (negativo = adelantado)
          delayMin:  Math.round(depDelay / 60),
          destination: destName,
          destinationId: destId,
          platform:  stu.platform_string || null,
          scheduleRelationship: stu.schedule_relationship || 'SCHEDULED',
        });
        break; // solo la primera coincidencia por viaje
      }
    }

    // Ordenar por hora de salida
    departures.sort((a, b) => a.departureTs - b.departureTs);

    res.json({
      stopId,
      stopName: STOP_NAMES[stopId] || stopId,
      updatedAt: new Date().toISOString(),
      departures: departures.slice(0, 20), // máx 20 trenes
    });

  } catch (err) {
    console.error('Error /api/departures:', err.message);
    res.status(502).json({ error: 'No se pudo obtener datos de Renfe', detail: err.message });
  }
});

// ── Ruta: GET /api/stops ──────────────────────────────────────────────────────
// Devuelve el listado de estaciones conocidas con sus IDs
app.get('/api/stops', (req, res) => {
  const stops = Object.entries(STOP_NAMES).map(([id, name]) => ({ id, name }));
  const q = (req.query.q || '').toLowerCase();
  const filtered = q
    ? stops.filter(s => s.name.toLowerCase().includes(q))
    : stops;
  res.json(filtered);
});

// ── Ruta: GET /api/alerts ─────────────────────────────────────────────────────
// Devuelve incidencias activas del servicio de cercanías
app.get('/api/alerts', async (req, res) => {
  try {
    const data = await fetchWithCache(RENFE_URLS.alerts);
    const entities = data.entity || [];

    const alerts = entities
      .filter(e => e.alert)
      .map(e => {
        const a = e.alert;
        return {
          id: e.id,
          headerText: a.header_text?.translation?.[0]?.text || '',
          descriptionText: a.description_text?.translation?.[0]?.text || '',
          effect: a.effect || '',
          cause: a.cause || '',
          activePeriods: (a.active_period || []).map(p => ({
            start: p.start ? new Date(Number(p.start) * 1000).toISOString() : null,
            end:   p.end   ? new Date(Number(p.end)   * 1000).toISOString() : null,
          })),
          informedEntities: (a.informed_entity || []).map(ie => ({
            routeId: ie.route_id || null,
            stopId:  ie.stop_id  || null,
          })),
        };
      });

    res.json({ updatedAt: new Date().toISOString(), alerts });
  } catch (err) {
    console.error('Error /api/alerts:', err.message);
    res.status(502).json({ error: 'No se pudo obtener alertas de Renfe', detail: err.message });
  }
});

// ── Ruta: GET /api/health ─────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Inicio del servidor ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚆 Rodalies Proxy arrancado en http://localhost:${PORT}`);
  console.log(`   /api/departures?stopId=79300  → próximos trenes Barcelona-Sants`);
  console.log(`   /api/stops?q=barcelona        → buscar estaciones`);
  console.log(`   /api/alerts                   → incidencias activas\n`);
});
