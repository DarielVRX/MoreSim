// src/engine/MovementEngine.js
//
// Gestiona el movimiento de todos los drivers en cada tick del SimClock.
//
// Dos modos de movimiento:
//   1. RUTA DE PEDIDO  — path calculado por OSRM, seguido fielmente
//   2. MOVIMIENTO LIBRE — path calculado con A* sobre el grafo local
//      destino: comercio más cercano (cuando driver no tiene pedidos)
//
// Stops:
//   - Nodo con signal=true (semáforo real de Overpass): 10s (tiempo real, afectado por speedMultiplier)
//   - Cualquier intersección con ≥3 conexiones: 1.5s
//   Estos valores son fijos pero visualmente el punto del driver "pausa" en el nodo.

import { getGraph, nearestNode, haversineMeters } from './GraphCache.js';

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';
const SIGNAL_STOP_S   = 10;   // segundos en semáforo real
const CORNER_STOP_S   = 1.5;  // segundos en esquina simple

// ─── OSRM route ───────────────────────────────────────────────────────────────
// Retorna [{lat, lng}] de puntos de la ruta y distancia total en metros.
export async function fetchOSRMRoute(from, to) {
  const url = `${OSRM_BASE}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=false`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const data  = await res.json();
  const route = data.routes?.[0];
  if (!route) throw new Error('OSRM: sin ruta');
  const coords = route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
  return { path: coords, distance_m: route.distance, duration_s: route.duration };
}

// ─── A* en grafo local ────────────────────────────────────────────────────────
function heuristic(graph, nodeId, goalId) {
  const a = graph.nodes[nodeId];
  const b = graph.nodes[goalId];
  if (!a || !b) return 0;
  return haversineMeters(a, b);
}

export function astarPath(graph, fromNodeId, toNodeId) {
  if (fromNodeId === toNodeId) return [fromNodeId];

  const open   = new Set([fromNodeId]);
  const cameFrom = {};
  const gScore = { [fromNodeId]: 0 };
  const fScore = { [fromNodeId]: heuristic(graph, fromNodeId, toNodeId) };

  let iterations = 0;
  while (open.size > 0 && iterations < 50000) {
    iterations++;
    // Nodo de open con menor fScore
    let current = null;
    let bestF   = Infinity;
    for (const n of open) {
      if ((fScore[n] ?? Infinity) < bestF) { bestF = fScore[n]; current = n; }
    }
    if (!current) break;
    if (current === toNodeId) {
      // Reconstruir path
      const path = [current];
      while (cameFrom[current]) { current = cameFrom[current]; path.unshift(current); }
      return path;
    }
    open.delete(current);
    const edges = graph.edges[current] ?? [];
    for (const edge of edges) {
      const tentG = (gScore[current] ?? Infinity) + edge.duration_s;
      if (tentG < (gScore[edge.to] ?? Infinity)) {
        cameFrom[edge.to] = current;
        gScore[edge.to]   = tentG;
        fScore[edge.to]   = tentG + heuristic(graph, edge.to, toNodeId);
        open.add(edge.to);
      }
    }
  }
  return null; // sin ruta
}

// Convierte un path de nodeIds a [{lat,lng}] con metadata de stops
export function nodePathToCoords(graph, nodePath) {
  return nodePath.map((nodeId, i) => {
    const node   = graph.nodes[nodeId];
    const edges  = graph.edges[nodeId] ?? [];
    // Determinar tipo de parada en este nodo
    let stopDuration = 0;
    if (i > 0 && i < nodePath.length - 1) {
      if (node.signal) {
        stopDuration = SIGNAL_STOP_S;
      } else if (edges.length >= 3) {
        stopDuration = CORNER_STOP_S;
      }
    }
    return { lat: node.lat, lng: node.lng, stop_s: stopDuration };
  });
}

// ─── Nearest restaurant helper ────────────────────────────────────────────────
export function nearestRestaurant(driver, restaurants) {
  let best = null;
  let bestDist = Infinity;
  for (const r of restaurants) {
    const d = haversineMeters(driver.pos, r.pos);
    if (d < bestDist) { bestDist = d; best = r; }
  }
  return best;
}

// ─── MovementEngine ───────────────────────────────────────────────────────────
export class MovementEngine {
  constructor() {
    this._pendingPaths = new Map(); // driverId → Promise
  }

  /**
   * Calcula y asigna una ruta OSRM al driver (para seguir un pedido).
   * Mutar driver.path y driver.path_index.
   */
  async setOrderRoute(driver, from, to) {
    try {
      const { path, distance_m, duration_s } = await fetchOSRMRoute(from, to);
      driver.path          = path;
      driver.path_index    = 0;
      driver.segment_elapsed = 0;
      driver.stop_elapsed  = 0;
      driver.stop_duration = 0;
      return { distance_m, duration_s };
    } catch (e) {
      console.warn('[MovementEngine] OSRM falló, usando línea recta:', e.message);
      driver.path          = [from, to];
      driver.path_index    = 0;
      driver.segment_elapsed = 0;
      const dist = haversineMeters(from, to);
      return { distance_m: dist, duration_s: dist / ((driver.speed_kmh * 1000) / 3600) };
    }
  }

  /**
   * Calcula y asigna una ruta libre (A*) al driver hacia un destino.
   */
  async setFreeRoute(driver, toPos) {
    const graph = getGraph();
    if (!graph) return;
    const fromNode = nearestNode(graph, driver.pos);
    const toNode   = nearestNode(graph, toPos);
    const nodePath = astarPath(graph, fromNode, toNode);
    if (!nodePath) return;
    const coords = nodePathToCoords(graph, nodePath);
    driver.path          = coords;
    driver.path_index    = 0;
    driver.segment_elapsed = 0;
    driver.stop_elapsed  = 0;
    driver.stop_duration = 0;
  }

  /**
   * Avanza a todos los drivers según el delta de tiempo (segundos simulados).
   * Muta driver.pos, driver.path_index, driver.segment_elapsed, etc.
   *
   * @param {object[]} drivers
   * @param {number}   dtSim — segundos simulados en este tick
   * @param {object[]} restaurants — para movimiento libre
   * @param {Function} onDriverArrived — callback(driver, type) donde type es
   *                   'at_restaurant' | 'at_customer' | 'at_free_dest'
   */
  tick(drivers, dtSim, restaurants, onDriverArrived) {
    for (const driver of drivers) {
      this._tickDriver(driver, dtSim, restaurants, onDriverArrived);
    }
  }

  _tickDriver(driver, dtSim, restaurants, onDriverArrived) {
    if (driver.path.length === 0) {
      const isWaiting = driver.status === 'idle' ||
      (driver.status === 'waiting_at_restaurant' && driver.orders.length === 0);

      if (isWaiting) {
        driver.idle_elapsed = (driver.idle_elapsed ?? 0) + dtSim;
        driver.metrics.idle_time_s += dtSim;
        if (driver.idle_elapsed >= driver.idle_wait_s && restaurants.length > 0) {
          const nearest = nearestRestaurant(driver, restaurants);
          if (nearest) {
            this.setFreeRoute(driver, nearest.pos);
            driver.status = 'moving_free';
            driver.idle_elapsed = 0;
          }
        }
      }
      return;
    }

    let remaining = dtSim;

    while (remaining > 0 && driver.path_index < driver.path.length - 1) {
      const from  = driver.path[driver.path_index];
      const to    = driver.path[driver.path_index + 1];

      // ── Stop en nodo actual ──────────────────────────────────────────────
      const stopDur = from.stop_s ?? 0;
      if (driver.stop_duration < stopDur) {
        driver.stop_duration = stopDur;
      }
      if (driver.stop_elapsed < driver.stop_duration) {
        const stopRemaining = driver.stop_duration - driver.stop_elapsed;
        if (remaining <= stopRemaining) {
          driver.stop_elapsed += remaining;
          remaining = 0;
          break;
        } else {
          remaining -= stopRemaining;
          driver.stop_elapsed  = 0;
          driver.stop_duration = 0;
        }
      }

      // ── Avanzar por el segmento ──────────────────────────────────────────
      const segDist_m = haversineMeters(from, to);
      const speed_ms  = (driver.speed_kmh * 1000) / 3600;
      const segDur_s  = segDist_m / speed_ms;

      const segRemaining = segDur_s - driver.segment_elapsed;

      if (remaining < segRemaining) {
        // Avanzar parcialmente dentro del segmento
        const fraction = (driver.segment_elapsed + remaining) / segDur_s;
        driver.pos = {
          lat: from.lat + (to.lat - from.lat) * fraction,
          lng: from.lng + (to.lng - from.lng) * fraction,
        };
        // Acumular distancia real
        const movedDist_m = remaining * speed_ms;
        driver.metrics.total_distance_km += movedDist_m / 1000;
        driver.segment_elapsed += remaining;
        remaining = 0;
      } else {
        // Llegar al siguiente nodo
        const movedDist_m = segRemaining * speed_ms;
        driver.metrics.total_distance_km += movedDist_m / 1000;
        remaining -= segRemaining;
        driver.path_index++;
        driver.segment_elapsed = 0;
        driver.stop_elapsed    = 0;
        driver.stop_duration   = 0;
        driver.pos             = { lat: to.lat, lng: to.lng };

        // Verificar si llegó al final del path
        if (driver.path_index >= driver.path.length - 1) {
          driver.path       = [];
          driver.path_index = 0;
          onDriverArrived?.(driver, driver._arrival_type ?? 'at_free_dest');
          break;
        }
      }
    }
  }
}
