// src/engine/GraphCache.js
//
// Descarga el grafo de calles de Morelia desde Overpass API y lo guarda en IndexedDB.
// Primera vez: descarga y parsea (~30s). Siguientes: carga desde cache (~1s).
//
// El grafo es un objeto con:
//   nodes: Map<nodeId, {lat, lng, signals: bool}> — intersecciones
//   edges: Map<nodeId, [{to, distance_m, duration_s, one_way}]> — aristas
//
// OSRM se sigue usando para rutas de pedidos. Este grafo es SOLO para
// el movimiento libre de drivers (pathfinding A* hacia comercio más cercano).

import { openDB } from 'idb';

const DB_NAME    = 'moresim-graph';
const DB_VERSION = 1;
const STORE_NAME = 'graph';
const CACHE_KEY  = 'morelia-v1';

// Bounding box de Morelia metropolitana
const MORELIA_BBOX = {
  south: 19.57,
  west:  -101.42,
  north: 19.84,
  east:  -100.98,
};

// ─── IndexedDB helpers ────────────────────────────────────────────────────────
async function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore(STORE_NAME);
    },
  });
}

async function loadFromCache() {
  try {
    const db  = await getDB();
    const raw = await db.get(STORE_NAME, CACHE_KEY);
    return raw ?? null;
  } catch { return null; }
}

async function saveToCache(graphData) {
  try {
    const db = await getDB();
    await db.put(STORE_NAME, graphData, CACHE_KEY);
  } catch (e) {
    console.warn('[GraphCache] No se pudo guardar en IndexedDB:', e);
  }
}

// ─── Overpass query ───────────────────────────────────────────────────────────
// Descarga nodos y ways de tipo highway dentro de la bbox de Morelia.
const OVERPASS_URL  = 'https://overpass-api.de/api/interpreter';
const OVERPASS_QUERY = `
[out:json][timeout:60];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|service|unclassified|living_street)$"]
     (${MORELIA_BBOX.south},${MORELIA_BBOX.west},${MORELIA_BBOX.north},${MORELIA_BBOX.east});
);
out body;
>;
out skel qt;
`;

// Velocidades base en km/h por tipo de vía
const SPEED_BY_HIGHWAY = {
  motorway:      90,
  trunk:         70,
  primary:       50,
  secondary:     40,
  tertiary:      30,
  residential:   25,
  service:       15,
  unclassified:  25,
  living_street: 10,
};

// Tipos de vía que típicamente tienen semáforos en intersecciones principales
const SIGNAL_HIGHWAYS = new Set(['motorway', 'trunk', 'primary', 'secondary']);

function haversineMeters(a, b) {
  const R  = 6371000;
  const φ1 = a.lat * Math.PI / 180;
  const φ2 = b.lat * Math.PI / 180;
  const Δφ = (b.lat - a.lat) * Math.PI / 180;
  const Δλ = (b.lng - a.lng) * Math.PI / 180;
  const s  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ─── Parser de respuesta Overpass ─────────────────────────────────────────────
function parseOverpass(data) {
  const nodeMap = new Map();   // id → {lat, lng}
  const adjMap  = new Map();   // nodeId → [{to, distance_m, duration_s, one_way, highway}]

  // Indexar nodos
  for (const el of data.elements) {
    if (el.type === 'node') {
      nodeMap.set(el.id, { lat: el.lat, lng: el.lon });
    }
  }

  // Construir aristas desde ways
  for (const el of data.elements) {
    if (el.type !== 'way') continue;
    const highway  = el.tags?.highway || 'residential';
    const speed    = (SPEED_BY_HIGHWAY[highway] ?? 25) / 3.6; // m/s
    const isOneWay = el.tags?.oneway === 'yes';
    const isSignal = SIGNAL_HIGHWAYS.has(highway);
    const refs     = el.nodes;

    for (let i = 0; i < refs.length - 1; i++) {
      const fromId = refs[i];
      const toId   = refs[i + 1];
      const from   = nodeMap.get(fromId);
      const to     = nodeMap.get(toId);
      if (!from || !to) continue;

      const dist_m = haversineMeters(from, to);
      const dur_s  = dist_m / speed;

      if (!adjMap.has(fromId)) adjMap.set(fromId, []);
      adjMap.get(fromId).push({ to: toId, distance_m: dist_m, duration_s: dur_s, one_way: isOneWay, highway, signal: isSignal });

      if (!isOneWay) {
        if (!adjMap.has(toId)) adjMap.set(toId, []);
        adjMap.get(toId).push({ to: fromId, distance_m: dist_m, duration_s: dur_s, one_way: false, highway, signal: isSignal });
      }
    }
  }

  // Detectar nodos con semáforos reales (tags del overpass)
  const signalNodes = new Set();
  for (const el of data.elements) {
    if (el.type === 'node' && (el.tags?.highway === 'traffic_signals' || el.tags?.highway === 'stop')) {
      signalNodes.add(el.id);
    }
  }

  // Serializar Maps a objetos planos para IndexedDB
  const nodes = {};
  nodeMap.forEach((v, k) => { nodes[k] = { ...v, signal: signalNodes.has(k) }; });

  const edges = {};
  adjMap.forEach((v, k) => { edges[k] = v; });

  return { nodes, edges, built_at: Date.now() };
}

// ─── API pública ─────────────────────────────────────────────────────────────
let _graph = null;
let _loading = false;
const _listeners = [];

export async function loadGraph(onProgress) {
  if (_graph) return _graph;
  if (_loading) {
    // Esperar a que termine la carga en curso
    return new Promise(resolve => _listeners.push(resolve));
  }

  _loading = true;
  onProgress?.({ stage: 'Buscando caché…', pct: 0 });

  const cached = await loadFromCache();
  if (cached) {
    onProgress?.({ stage: 'Cargando desde caché', pct: 90 });
    _graph = cached;
    _loading = false;
    _listeners.forEach(fn => fn(_graph));
    _listeners.length = 0;
    onProgress?.({ stage: 'Listo', pct: 100 });
    return _graph;
  }

  onProgress?.({ stage: 'Descargando calles de Morelia…', pct: 10 });
  const res = await fetch(OVERPASS_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `data=${encodeURIComponent(OVERPASS_QUERY)}`,
  });

  if (!res.ok) throw new Error(`Overpass error: ${res.status}`);

  onProgress?.({ stage: 'Parseando grafo…', pct: 60 });
  const json = await res.json();

  onProgress?.({ stage: 'Construyendo aristas…', pct: 75 });
  const graphData = parseOverpass(json);

  onProgress?.({ stage: 'Guardando en caché…', pct: 90 });
  await saveToCache(graphData);

  _graph = graphData;
  _loading = false;
  _listeners.forEach(fn => fn(_graph));
  _listeners.length = 0;
  onProgress?.({ stage: 'Listo', pct: 100 });
  return _graph;
}

export function getGraph() { return _graph; }

export async function clearGraphCache() {
  _graph = null;
  const db = await getDB();
  await db.delete(STORE_NAME, CACHE_KEY);
}

// ─── Nearest node helper ──────────────────────────────────────────────────────
// Encuentra el nodo del grafo más cercano a una posición {lat, lng}
export function nearestNode(graph, pos) {
  let best = null;
  let bestDist = Infinity;
  for (const [id, node] of Object.entries(graph.nodes)) {
    const d = haversineMeters(pos, node);
    if (d < bestDist) { bestDist = d; best = id; }
  }
  return best;
}

export { haversineMeters };
