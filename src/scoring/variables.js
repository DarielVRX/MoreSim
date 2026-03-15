// src/scoring/variables.js
//
// ─── PUNTO CENTRAL DEL ALGORITMO ────────────────────────────────────────────
// Este archivo es el ÚNICO lugar donde se define qué factores afectan
// la asignación de pedidos y cómo. Cada variable es un objeto con:
//
//   id        : identificador único (string, no cambiar una vez en uso)
//   name      : nombre legible en UI
//   enabled   : bool — se puede desactivar sin borrar
//   weight    : 0-100, importancia relativa
//   effect    : 'maximize' | 'minimize' | 'gate'
//               maximize → score más alto = mejor
//               minimize → score más bajo = mejor (se invierte internamente)
//               gate     → si retorna false/0, el driver queda descalificado
//   compute   : function(driver, order, restaurant, customer, world) → number | bool
//               Recibe el snapshot completo para que puedas usar cualquier dato.
//               Debe retornar un número 0-1 (o bool para gate).
//   description: explicación para el panel de UI
//
// Para agregar una variable nueva: agrega un objeto al array DEFAULT_VARIABLES.
// El scorer la detectará automáticamente en el siguiente tick.
//
// Para sobreescribir con fórmula custom pegada desde el copilot:
// cada variable tiene un campo `formula_override` (string de código JS).
// Si está presente, el scorer lo evalúa en lugar de `compute`.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_VARIABLES = [

  // ── GATES — descalifican al driver si no los pasan ──────────────────────
  {
    id:          'gate_available',
    name:        'Disponible',
    enabled:     true,
    weight:      100,
    effect:      'gate',
    description: 'El driver participa mientras tenga posición válida; el límite real de carga lo controla Capacidad de pedidos.',
    formula_override: null,
    compute: (driver) => {
      return Number.isFinite(driver?.pos?.lat) && Number.isFinite(driver?.pos?.lng);
    },
  },
  {
    id:          'gate_max_orders',
    name:        'Capacidad de pedidos',
    enabled:     true,
    weight:      100,
    effect:      'gate',
    description: 'El driver no puede superar su límite de pedidos simultáneos.',
    formula_override: null,
    compute: (driver) => {
      const activeOrders = Array.isArray(driver.orders) ? driver.orders.length : 0;
      const maxOrders = Number.isFinite(driver.max_orders) ? driver.max_orders : 1;
      return activeOrders < maxOrders;
    },
  },

  // ── DISTANCIA — favorece al driver más cercano al restaurante ─────────────
  {
    id:          'distance_to_restaurant',
    name:        'Distancia al comercio',
    enabled:     true,
    weight:      50,
    effect:      'maximize',
    description: 'Drivers más cercanos al restaurante reciben mayor puntuación. Usa ETA calculado por OSRM.',
    formula_override: null,
    // eta_to_restaurant_s se calcula en AssignmentEngine antes de llamar al scorer
    compute: (driver, order, restaurant, customer, world) => {
      const eta = driver._eta_to_restaurant_s ?? 0;
      // Normalizar contra un máximo razonable (30 min = 1800 s)
      const MAX_ETA = world.params.max_assignment_eta_s ?? 1800;
      return Math.max(0, 1 - eta / MAX_ETA);
    },
  },

  // ── ETA SUMA — favorece drivers con menos carga de entregas activas ────────
  {
    id:          'eta_sum',
    name:        'Carga de entregas activas (ETA)',
    enabled:     true,
    weight:      30,
    effect:      'maximize',
    description: 'Drivers con menor suma de ETAs pendientes reciben mayor puntuación.',
    formula_override: null,
    compute: (driver, order, restaurant, customer, world) => {
      const MAX_ETA_SUM = world.params.max_eta_sum_s ?? 3600;
      return Math.max(0, 1 - driver.eta_sum / MAX_ETA_SUM);
    },
  },

  // ── CALIFICACIÓN DEL DRIVER ────────────────────────────────────────────────
  {
    id:          'driver_rating',
    name:        'Calificación del driver',
    enabled:     true,
    weight:      20,
    effect:      'maximize',
    description: 'Drivers con mejor calificación de usuarios reciben preferencia.',
    formula_override: null,
    compute: (driver) => {
      // Normalizar 1-5 → 0-1
      return (driver.rating - 1) / 4;
    },
  },

  // ── PENALIZACIÓN DE RESTAURANTE ───────────────────────────────────────────
  // No afecta qué driver se asigna, sino si el restaurante tiene descuento
  // de prioridad. Se incluye aquí para que sea visible y modificable.
  {
    id:          'restaurant_penalty',
    name:        'Penalización de restaurante',
    enabled:     true,
    weight:      15,
    effect:      'minimize',
    description: 'Restaurantes con peores métricas reciben menor prioridad de asignación rápida.',
    formula_override: null,
    compute: (driver, order, restaurant) => {
      // penalty ya es 0-1 calculado desde métricas en el panel
      return restaurant.penalty;
    },
  },

  // ── ESTADO READY — prioriza pedidos que ya están listos para recoger ───────
  {
    id:          'kitchen_ready_bonus',
    name:        'Bonus pedido listo',
    enabled:     true,
    weight:      25,
    effect:      'maximize',
    description: 'Pedidos con kitchen_status=ready reciben un bonus de urgencia para ser asignados antes.',
    formula_override: null,
    compute: (driver, order) => {
      return order.kitchen_status === 'ready' ? 1 : 0.4;
    },
  },
];

// ─── Utilidades para el ScenarioStore ────────────────────────────────────────
// Exportamos una función para clonar las variables con posibilidad de merge
// con las guardadas en el escenario (el usuario puede haber modificado pesos).
export function mergeWithSaved(saved = []) {
  const defaultMap = Object.fromEntries(DEFAULT_VARIABLES.map(v => [v.id, v]));
  const savedMap   = Object.fromEntries(saved.map(v => [v.id, v]));
  // Las default siempre están, las saved sobreescriben campos editables
  const merged = DEFAULT_VARIABLES.map(v => ({
    ...v,
    ...(savedMap[v.id]
      ? {
          enabled:          savedMap[v.id].enabled,
          weight:           savedMap[v.id].weight,
          formula_override: savedMap[v.id].formula_override ?? null,
        }
      : {}),
  }));
  // Variables custom (no están en DEFAULT_VARIABLES) — se agregan al final
  const customVars = saved.filter(v => !defaultMap[v.id]);
  return [...merged, ...customVars];
}
