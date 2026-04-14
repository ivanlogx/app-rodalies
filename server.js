/**
 * Rodalies Proxy Server v2
 *
 * Estrategia:
 *  1. Al arrancar: descarga el GTFS estático de Renfe y construye en memoria
 *     un índice de horarios por estación.
 *  2. En cada petición /api/departures: sirve los horarios programados del día
 *     y aplica encima los retrasos del GTFS-RT (actualizado cada 20s).
 *
 * Fuentes:
 *  - GTFS estático:  https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip  (CC-BY 4.0)
 *  - GTFS-RT JSON:   https://gtfsrt.renfe.com/trip_updates.json  (CC-BY 4.0, cada 20s)
 */

'use strict';

const express   = require('express');
const cors      = require('cors');
const fetch     = require('node-fetch');
const NodeCache = require('node-cache');
const path      = require('path');
const AdmZip    = require('adm-zip');

const app   = express();
const cache = new NodeCache({ stdTTL: 20 });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── URLs fuente ───────────────────────────────────────────────────────────────
const GTFS_STATIC_URL = 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip';
const GTFS_RT_URL     = 'https://gtfsrt.renfe.com/trip_updates.json';
const GTFS_ALERTS_URL = 'https://gtfsrt.renfe.com/alerts.json';

// ── Estado global del GTFS estático ──────────────────────────────────────────
let GTFS = {
  ready: false,
  loadedAt: null,
  stops: {},        // stopId → { name, lat, lon }
  trips: {},        // tripId → { routeId, serviceId, headSign }
  routes: {},       // routeId → { shortName, longName }
  stopTimes: {},    // stopId → [ { tripId, departureTime, arrivalTime, stopSequence, stopHeadsign } ]
  calendar: {},     // serviceId → { monday...sunday, startDate, endDate }
  calendarDates: {},// serviceId → [ { date, exceptionType } ]
};

// ── Parser CSV ────────────────────────────────────────────────────────────────
function parseCsvHeaders(line) {
  return line.replace(/\r/g, '').split(',').map(h => h.trim().replace(/^"|"$/g, ''));
}

function parseCsvLine(line, headers) {
  const vals = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { vals.push(cur); cur = ''; }
    else cur += c;
  }
  vals.push(cur);
  const obj = {};
  headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
  return obj;
}

// ── Convierte "HH:MM:SS" (puede superar 24h en GTFS) a minutos desde medianoche
function hhmmToMin(hhmm) {
  if (!hhmm) return null;
  const parts = hhmm.split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function minToHHMM(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// ── Fecha de hoy en formato YYYYMMDD ─────────────────────────────────────────
function todayStr() {
  const d = new Date();
  return d.getFullYear().toString()
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0');
}

// ── Día de la semana actual ───────────────────────────────────────────────────
function todayDayKey() {
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  return days[new Date().getDay()];
}

// ── Filtra los serviceIds activos hoy ─────────────────────────────────────────
function getActiveServiceIds() {
  const today  = todayStr();
  const dayKey = todayDayKey();
  const active = new Set();

  for (const [sid, cal] of Object.entries(GTFS.calendar)) {
    if (cal.startDate <= today && today <= cal.endDate && cal[dayKey] === '1') {
      active.add(sid);
    }
  }
  for (const [sid, exceptions] of Object.entries(GTFS.calendarDates)) {
    for (const ex of exceptions) {
      if (ex.date === today) {
        if (ex.exceptionType === '1') active.add(sid);
        if (ex.exceptionType === '2') active.delete(sid);
      }
    }
  }
  return active;
}

// ── Carga el GTFS estático ────────────────────────────────────────────────────
async function loadGtfsStatic() {
  console.log('📥 Descargando GTFS estático de Renfe...');
  const res = await fetch(GTFS_STATIC_URL, {
    headers: { 'User-Agent': 'RodaliesProxy/2.0' },
    timeout: 90000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar GTFS`);

  const buf = await res.buffer();
  console.log(`📦 Descargado: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

  const zip = new AdmZip(buf);

  function readFile(name) {
    const entry = zip.getEntry(name);
    if (!entry) { console.warn(`⚠️  ${name} no encontrado`); return ''; }
    return zip.readAsText(entry);
  }

  function parseAll(name) {
    const text  = readFile(name);
    if (!text) return [];
    const lines = text.replace(/\r/g, '').split('\n').filter(Boolean);
    const hdrs  = parseCsvHeaders(lines[0]);
    return lines.slice(1).map(l => parseCsvLine(l, hdrs));
  }

  // stops.txt
  const stops = {};
  for (const r of parseAll('stops.txt')) {
    stops[r.stop_id] = { name: r.stop_name || r.stop_id, lat: parseFloat(r.stop_lat) || 0, lon: parseFloat(r.stop_lon) || 0 };
  }

  // routes.txt
  const routes = {};
  for (const r of parseAll('routes.txt')) {
    routes[r.route_id] = { shortName: r.route_short_name || r.route_id, longName: r.route_long_name || '' };
  }

  // trips.txt
  const trips = {};
  for (const r of parseAll('trips.txt')) {
    trips[r.trip_id] = { routeId: r.route_id, serviceId: r.service_id, headSign: r.trip_headsign || '' };
  }

  // calendar.txt
  const calendar = {};
  for (const r of parseAll('calendar.txt')) {
    calendar[r.service_id] = {
      monday: r.monday, tuesday: r.tuesday, wednesday: r.wednesday,
      thursday: r.thursday, friday: r.friday, saturday: r.saturday, sunday: r.sunday,
      startDate: r.start_date, endDate: r.end_date,
    };
  }

  // calendar_dates.txt
  const calendarDates = {};
  for (const r of parseAll('calendar_dates.txt')) {
    if (!calendarDates[r.service_id]) calendarDates[r.service_id] = [];
    calendarDates[r.service_id].push({ date: r.date, exceptionType: r.exception_type });
  }

  // stop_times.txt — archivo más grande, parsear manualmente línea a línea
  console.log('⏳ Procesando stop_times.txt...');
  const stopTimes = {};
  const stText = readFile('stop_times.txt');
  if (stText) {
    const lines = stText.replace(/\r/g, '').split('\n');
    const hdrs  = parseCsvHeaders(lines[0]);
    const iTrip = hdrs.indexOf('trip_id');
    const iStop = hdrs.indexOf('stop_id');
    const iDep  = hdrs.indexOf('departure_time');
    const iArr  = hdrs.indexOf('arrival_time');
    const iSeq  = hdrs.indexOf('stop_sequence');
    const iSign = hdrs.indexOf('stop_headsign');

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]; if (!line) continue;
      const cols = line.split(',');
      const stopId = (cols[iStop] || '').trim(); if (!stopId) continue;
      if (!stopTimes[stopId]) stopTimes[stopId] = [];
      stopTimes[stopId].push({
        tripId:        (cols[iTrip] || '').trim(),
        departureTime: (cols[iDep]  || '').trim(),
        arrivalTime:   (cols[iArr]  || '').trim(),
        stopSequence:  parseInt(cols[iSeq] || '0', 10),
        stopHeadsign:  (cols[iSign] || '').trim(),
      });
    }
  }

  GTFS = { ready: true, loadedAt: new Date(), stops, trips, routes, stopTimes, calendar, calendarDates };

  const nST = Object.values(stopTimes).reduce((s, a) => s + a.length, 0);
  console.log(`✅ GTFS listo: ${Object.keys(stops).length} paradas, ${Object.keys(trips).length} viajes, ${nST} stop_times`);
}

async function scheduleGtfsReload() {
  try { await loadGtfsStatic(); } catch (e) { console.error('❌ Error cargando GTFS:', e.message); }
  setInterval(async () => {
    try { await loadGtfsStatic(); } catch (e) { console.error('❌ Error recargando GTFS:', e.message); }
  }, 24 * 60 * 60 * 1000);
}

// ── Obtiene retrasos del GTFS-RT ──────────────────────────────────────────────
async function getRtDelays() {
  const cached = cache.get('rt_delays');
  if (cached) return cached;

  const res = await fetch(GTFS_RT_URL, { headers: { 'User-Agent': 'RodaliesProxy/2.0' }, timeout: 8000 });
  if (!res.ok) throw new Error(`GTFS-RT HTTP ${res.status}`);
  const data = await res.json();

  const delays = {};
  for (const entity of (data.entity || [])) {
    const tu = entity.tripUpdate || entity.trip_update;
    if (!tu) continue;
    const tripId = tu.trip?.tripId || tu.trip?.trip_id;
    if (!tripId) continue;
    const updates = tu.stopTimeUpdate || tu.stop_time_update || [];
    if (!updates.length) continue;
    const last     = updates[updates.length - 1];
    const delaySec = last.departure?.delay ?? last.arrival?.delay ?? tu.delay ?? 0;
    delays[tripId] = { delaySec, delayMin: Math.round(delaySec / 60) };
  }

  cache.set('rt_delays', delays);
  return delays;
}

// ── GET /api/departures?stopId=XXXXX ─────────────────────────────────────────
app.get('/api/departures', async (req, res) => {
  if (!GTFS.ready) {
    return res.status(503).json({
      error: 'El servidor está cargando los horarios por primera vez. Espera unos segundos y recarga.',
      loading: true,
    });
  }

  const { stopId } = req.query;
  if (!stopId) return res.status(400).json({ error: 'stopId es requerido' });

  const stopInfo = GTFS.stops[stopId];
  const rawTimes = GTFS.stopTimes[stopId];

  if (!rawTimes || !rawTimes.length) {
    return res.json({
      stopId, stopName: stopInfo?.name || stopId,
      updatedAt: new Date().toISOString(), departures: [],
      warning: 'No hay horarios para esta parada en el GTFS de Renfe.',
    });
  }

  const activeServices = getActiveServiceIds();
  const now    = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // Ventana: desde ahora hasta 2 horas en adelante
  const winEnd = nowMin + 120;

  const filtered = rawTimes.filter(st => {
    const trip = GTFS.trips[st.tripId];
    if (!trip || !activeServices.has(trip.serviceId)) return false;
    const depMin = hhmmToMin(st.departureTime);
    return depMin !== null && depMin >= nowMin - 1 && depMin <= winEnd;
  }).sort((a, b) => hhmmToMin(a.departureTime) - hhmmToMin(b.departureTime));

  // Retrasos RT
  let delays = {};
  try { delays = await getRtDelays(); } catch (_) { /* continuamos sin RT */ }

  const departures = filtered.slice(0, 20).map(st => {
    const trip    = GTFS.trips[st.tripId]   || {};
    const route   = GTFS.routes[trip.routeId] || {};
    const rt      = delays[st.tripId]        || null;
    const depMin  = hhmmToMin(st.departureTime);
    const realMin = rt ? depMin + rt.delayMin : depMin;
    const dest    = st.stopHeadsign || trip.headSign || route.longName || '';

    return {
      tripId:        st.tripId,
      routeId:       trip.routeId   || '',
      routeName:     route.shortName || trip.routeId || '',
      destination:   dest,
      departure:     minToHHMM(depMin),   // hora programada
      departureReal: minToHHMM(realMin),  // hora real con retraso aplicado
      delayMin:      rt ? rt.delayMin : 0,
      hasRealtime:   !!rt,
      countdownMin:  realMin - nowMin,
      scheduleRelationship: 'SCHEDULED',
    };
  });

  res.json({
    stopId, stopName: stopInfo?.name || stopId,
    updatedAt: new Date().toISOString(),
    departures,
  });
});

// ── GET /api/stops?q=barcelona ───────────────────────────────────────────────
app.get('/api/stops', (req, res) => {
  if (!GTFS.ready) return res.status(503).json({ error: 'GTFS cargando...' });
  const q = (req.query.q || '').toLowerCase();
  const stops = Object.entries(GTFS.stops)
    .filter(([, s]) => !q || s.name.toLowerCase().includes(q))
    .map(([id, s]) => ({ id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(stops.slice(0, 30));
});

// ── GET /api/alerts ───────────────────────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  try {
    const cached = cache.get('alerts');
    if (cached) return res.json(cached);
    const data = await fetch(GTFS_ALERTS_URL, { timeout: 8000 }).then(r => r.json());
    const alerts = (data.entity || []).filter(e => e.alert).map(e => {
      const a = e.alert;
      return {
        id: e.id,
        header:      (a.headerText      || a.header_text)?.translation?.[0]?.text      || '',
        description: (a.descriptionText || a.description_text)?.translation?.[0]?.text || '',
        effect: a.effect || '',
        routes: ((a.informedEntity || a.informed_entity) || [])
          .map(ie => ie.routeId || ie.route_id).filter(Boolean),
      };
    });
    const result = { updatedAt: new Date().toISOString(), alerts };
    cache.set('alerts', result, 60);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'No se pudieron obtener alertas', detail: e.message });
  }
});

// ── GET /api/health ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: GTFS.ready ? 'ok' : 'loading',
    gtfsReady:    GTFS.ready,
    gtfsLoadedAt: GTFS.loadedAt,
    stops:        Object.keys(GTFS.stops).length,
    trips:        Object.keys(GTFS.trips).length,
    timestamp:    new Date().toISOString(),
  });
});

// ── Arranque ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚆 Rodalies Proxy v2 en http://localhost:${PORT}`);
  scheduleGtfsReload();
});

// ── GET /api/stop-id-lookup?name=Barcelona-Sants ─────────────────────────────
// Dado un nombre (o parte de él), devuelve el stop_id real del GTFS.
// El frontend lo usa como fallback cuando su stop_id hardcodeado no da resultados.
app.get('/api/stop-id-lookup', (req, res) => {
  if (!GTFS.ready) return res.status(503).json({ error: 'GTFS cargando...' });
  const name = (req.query.name || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!name) return res.status(400).json({ error: 'name es requerido' });

  let best = null, bestScore = 0;
  for (const [id, stop] of Object.entries(GTFS.stops)) {
    const sn = stop.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (sn === name) { best = { stopId: id, stopName: stop.name }; break; }
    if (sn.includes(name) || name.includes(sn)) {
      const score = Math.min(sn.length, name.length) / Math.max(sn.length, name.length);
      if (score > bestScore) { bestScore = score; best = { stopId: id, stopName: stop.name }; }
    }
  }
  if (best) return res.json(best);
  res.status(404).json({ error: 'Stop no encontrado' });
});
