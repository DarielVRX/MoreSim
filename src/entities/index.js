// src/entities/index.js
// Constructores de entidades. Todos los campos son mutables desde la UI.
// No usar clases — objetos planos para facilitar serialización/clone de estados.

let _nextId = 1;
function uid(prefix) { return `${prefix}-${_nextId++}`; }

// ─── Driver ──────────────────────────────────────────────────────────────────
// speed_kmh      : velocidad promedio (multiplicador sobre tiempo OSRM)
// max_orders     : límite de pedidos simultáneos (configurable antes de correr)
// rating         : calificación promedio de usuarios (1-5)
// eta_sum        : suma de ETAs de pedidos activos en segundos (calculado en runtime)
// status         : 'idle' | 'moving_to_pickup' | 'moving_to_delivery' | 'waiting_at_restaurant'
// idle_wait_s    : segundos a esperar sin pedido antes de moverse al comercio más cercano
// orders         : array de order IDs activos
// path           : [{lat,lng}, ...] ruta actual calculada por OSRM
// path_index     : posición actual en el path
// home_pos       : {lat, lng} — donde se colocó en el mapa, siempre el punto de inicio
// pos            : {lat, lng} — posición actual en runtime
// metrics        : { dead_km, idle_time_s, total_distance_km }
export function createDriver(pos, overrides = {}) {
  return {
    id:            uid('drv'),
    name:          overrides.name || `Driver ${_nextId - 1}`,
    home_pos:      { ...pos },
    pos:           { ...pos },
    speed_kmh:     overrides.speed_kmh     ?? 35,
    max_orders:    overrides.max_orders    ?? 1,
    rating:        overrides.rating        ?? 5.0,
    eta_sum:       0,
    status:        'idle',
    idle_wait_s:   overrides.idle_wait_s   ?? 30,
    idle_elapsed:  0,            // segundos transcurridos en idle antes de moverse
    orders:        [],
    path:          [],
    path_index:    0,
    segment_elapsed: 0,          // segundos recorridos en el segmento actual
    stop_elapsed:  0,            // segundos en stop (semáforo/esquina)
    stop_duration: 0,            // duración total del stop actual
    metrics: {
      dead_km:          0,
      idle_time_s:      0,
      total_distance_km: 0,
    },
    ...overrides,
  };
}

// ─── Restaurant ───────────────────────────────────────────────────────────────
// prep_time_s    : tiempo de preparación en segundos (fijo, ingresado manual)
// penalty        : penalización dinámica 0-1 (afecta scoring). Calculada desde métricas.
// metrics base   : puntualidad (0-1), driver_rating (1-5), user_rating (1-5)
// orders_config  : pedidos pre-programados [{id, customer_id, trigger:'manual'|timestamp, amount_cents}]
export function createRestaurant(pos, overrides = {}) {
  return {
    id:            uid('rst'),
    name:          overrides.name       || `Comercio ${_nextId - 1}`,
    pos:           { ...pos },
    prep_time_s:   overrides.prep_time_s ?? 600,   // 10 min default
    penalty:       overrides.penalty    ?? 0,
    metrics: {
      punctuality:   overrides.metrics?.punctuality  ?? 1.0,
      driver_rating: overrides.metrics?.driver_rating ?? 5.0,
      user_rating:   overrides.metrics?.user_rating   ?? 5.0,
    },
    orders_config: overrides.orders_config ?? [],
    ...overrides,
  };
}

// ─── Customer ─────────────────────────────────────────────────────────────────
// max_distance_km: restricción de distancia para recibir pedidos (no afecta scoring)
export function createCustomer(pos, overrides = {}) {
  return {
    id:            uid('cus'),
    name:          overrides.name           || `Cliente ${_nextId - 1}`,
    pos:           { ...pos },
    max_distance_km: overrides.max_distance_km ?? 10,
    ...overrides,
  };
}

// ─── Order ────────────────────────────────────────────────────────────────────
// status: 'queued' | 'assigned' | 'preparing' | 'ready' | 'on_the_way' | 'delivered'
//
// NOTA CRÍTICA: preparing y ready son independientes de assigned y on_the_way.
// Un pedido puede estar 'assigned' mientras está 'preparing'.
// El driver puede llegar al restaurante y esperar hasta que pase a 'ready'.
// Los estados de cocina (preparing → ready) los controla prep_time_s del restaurante.
// Los estados de entrega (assigned → on_the_way → delivered) los controla el driver.
//
// route_distance_km : distancia directa comercio→cliente (calculada por OSRM al asignar)
// assigned_at       : timestamp de simulación cuando fue asignado
// ready_at          : timestamp cuando pasó a ready
// delivered_at      : timestamp cuando fue entregado
// pickup_wait_s     : segundos que el driver esperó en el restaurante (para métricas)
export function createOrder(restaurant_id, customer_id, overrides = {}) {
  return {
    id:                uid('ord'),
    restaurant_id,
    customer_id,
    driver_id:         null,
    status:            'queued',
    kitchen_status:    'preparing',  // 'preparing' | 'ready' — independiente del delivery
    amount_cents:      overrides.amount_cents ?? 15000,
    trigger:           overrides.trigger      ?? 'manual',   // 'manual' | number (sim seconds)
    triggered:         false,        // ya fue lanzado al engine
    assigned_at:       null,
    kitchen_ready_at:  null,
    picked_up_at:      null,
    delivered_at:      null,
    route_distance_km: null,         // comercio→cliente, calculado al asignar
    pickup_wait_s:     0,
    score_breakdown:   null,         // qué driver ganó y por qué
    ...overrides,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function resetIdCounter() { _nextId = 1; }
export function setIdCounter(n)  { _nextId = n; }
