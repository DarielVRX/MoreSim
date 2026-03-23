// src/hooks/useSimulation.js
//
// Hook central que orquesta todos los engines y expone estado a la UI.
// La UI NO toca engines directamente — todo va a través de este hook.

import { useState, useEffect, useRef, useCallback } from 'react';
import { SimClock }          from '../engine/SimClock.js';
import { MovementEngine }    from '../engine/MovementEngine.js';
import { AssignmentEngine }  from '../engine/AssignmentEngine.js';
import { Recorder }          from '../replay/Recorder.js';
import { loadGraph }         from '../engine/GraphCache.js';
import { mergeWithSaved }    from '../scoring/variables.js';
import { createDriver, createRestaurant, createCustomer, createOrder, setIdCounter } from '../entities/index.js';
import {
  saveLastScenario, loadLastScenario, serializeWorld,
  saveScenario as saveToLibrary, loadLibrary, deleteScenario as deleteFromLibrary,
  exportScenarioToFile, importScenarioFromFile,
} from '../persistence/ScenarioStore.js';

// ─── WorldState inicial ───────────────────────────────────────────────────────
function createEmptyWorld() {
  return {
    params: {
      max_assignment_eta_s:           1800,
      max_eta_sum_s:                  3600,
      assignment_batch_size:          4,
      assignment_retry_base_s:        2,
      assignment_retry_max_s:         60,
      fairness_penalty_per_order_s:   120,
      soft_sla_penalty_factor:        2,
      hard_sla_penalty_s:             3000,
      pickup_proximity_penalty_factor: 0.35,
      transfer_cooldown_s:            60,
      transfer_min_gain_s:            10,
      transfer_max_iterations:        5,
      simulation_budget_per_tick:     75,
      reconnect_window_s:             600,
      driver_offer_timeout_s:         120,
      max_customer_restaurant_distance_km: 5,
    },
    drivers:     {},
    restaurants: {},
    customers:   {},
    orders:      {},
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useSimulation() {
  // ── Engines (refs — no causan re-render) ──────────────────────────────────
  const clockRef      = useRef(new SimClock());
  const movementRef   = useRef(new MovementEngine());
  const recorderRef   = useRef(new Recorder());
  const assignRef     = useRef(null);  // se crea después de cargar variables

  // ── Estado reactivo ───────────────────────────────────────────────────────
  const [world,       setWorld]       = useState(createEmptyWorld);
  const [variables,   setVariables]   = useState(() => mergeWithSaved([]));
  const [simState,    setSimState]    = useState('stopped'); // 'stopped' | 'running' | 'paused' | 'replay'
  const [simTime,     setSimTime]     = useState(0);
  const [multiplier,  setMultiplierS] = useState(1);
  const [log,         setLog]         = useState([]);        // eventos de la simulación
  const [graphStatus, setGraphStatus] = useState({ stage: 'idle', pct: 0 });
  const [scenarios,   setScenarios]   = useState(() => loadLibrary());
  const [replayTime,  setReplayTime]  = useState(0);
  const [metrics,     setMetrics]     = useState(null);

  // Ref mutable al world para engines (sin stale closure)
  const worldRef = useRef(world);
  useEffect(() => { worldRef.current = world; }, [world]);
  if (assignRef.current) {
    assignRef.current._world = worldRef.current;
  }

  useEffect(() => {
    movementRef.current.setSimTimeProvider(() => clockRef.current.simTime);
  }, []);

  const variablesRef = useRef(variables);
  useEffect(() => { variablesRef.current = variables; }, [variables]);

  // ── Inicializar AssignmentEngine ──────────────────────────────────────────
  useEffect(() => {
    assignRef.current = new AssignmentEngine({
      variables:      variablesRef.current,
      world:          worldRef.current,
      movementEngine: movementRef.current,
      onEvent: (event) => {
        recorderRef.current.addEvent(event);
        setLog(prev => [event, ...prev].slice(0, 500));
      },
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sincronizar variables en AssignmentEngine cuando cambian
  useEffect(() => {
    assignRef.current?.updateVariables(variables);
  }, [variables]);

  // ── Cargar grafo al montar ────────────────────────────────────────────────
  useEffect(() => {
    loadGraph((progress) => setGraphStatus(progress)).catch(console.error);
  }, []);

  // ── SimClock tick ─────────────────────────────────────────────────────────
  useEffect(() => {
    const clock = clockRef.current;
    clock.setOnTick((dtSim, st) => {
      setSimTime(st);

      // Pedidos programados — disparar si su tiempo llegó
      const w = worldRef.current;
      for (const order of Object.values(w.orders)) {
        if (!order.triggered && typeof order.trigger === 'number' && st >= order.trigger) {
          order.triggered = true;
          assignRef.current?.handleOrderCreated(order.id, st);
        }
      }

      // Tick del assignment engine
      if (assignRef.current) {
        assignRef.current._world = w;
        assignRef.current._finder?.update({
          world: w
        });
        assignRef.current.tick(dtSim, st);
      }

      // Snapshot para replay
      recorderRef.current.maybeSave(st, w);

      // Calcular métricas cada segundo simulado
      if (Math.floor(st) !== Math.floor(st - dtSim)) {
        setMetrics(computeMetrics(w));
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Loop de movimiento continuo (independiente del assignment tick) ───────
  useEffect(() => {
    if (simState !== 'running') return;

    let lastMs = performance.now();

    const intervalId = setInterval(() => {
      const nowMs = performance.now();
      const realDt = (nowMs - lastMs) / 1000;
      lastMs = nowMs;

      const dtSim = Math.min(realDt, 0.2) * clockRef.current.multiplier;
      const w = worldRef.current;

      movementRef.current.tick(
        Object.values(w.drivers),
        dtSim,
        Object.values(w.restaurants),
        (driver, type) => assignRef.current?.handleDriverArrived(driver, type, clockRef.current.simTime)
      );

      // refrescar posiciones para la UI
      setWorld(prev => ({ ...prev, drivers: { ...prev.drivers } }));
    }, 100);

    return () => clearInterval(intervalId);
  }, [simState]);

  // ── Control de simulación ─────────────────────────────────────────────────
  const start = useCallback(() => {
    if (simState === 'stopped') {
      recorderRef.current.start();
      setLog([]);
    }
    clockRef.current.start();
    setSimState('running');
  }, [simState]);

  const pause = useCallback(() => {
    clockRef.current.pause();
    setSimState('paused');
  }, []);

  const reset = useCallback(() => {
    clockRef.current.reset();
    recorderRef.current.reset();
    setSimState('stopped');
    setSimTime(0);
    setLog([]);
    setMetrics(null);
    // Resetear estado runtime de drivers y pedidos
    setWorld(prev => {
      const drivers = Object.fromEntries(
        Object.entries(prev.drivers).map(([id, d]) => [id, {
          ...d,
          pos:             { ...d.home_pos },
          status:          'idle',
          idle_elapsed:    0,
          orders:          [],
          path:            [],
          path_index:      0,
          segment_elapsed: 0,
          stop_elapsed:    0,
          stop_duration:   0,
          eta_sum:         0,
          metrics:         { dead_km: 0, idle_time_s: 0, total_distance_km: 0 },
        }])
      );
      const orders = Object.fromEntries(
        Object.entries(prev.orders).map(([id, o]) => [id, {
          ...o,
          status:          'queued',
          kitchen_status:  'preparing',
          driver_id:       null,
          triggered:       false,
          assigned_at:     null,
          offer_sent_at:    null,
          offer_expires_at: null,
          offer_answered_at: null,
          triggered_at:    null,
          prep_started_at: null,
          prep_ready_at_estimate: null,
          kitchen_ready_at: null,
          picked_up_at:    null,
          delivered_at:    null,
          pickup_wait_s:   0,
          score_breakdown: null,
          retry_count:     0,
          next_retry_at:   0,
          last_transferred_at: null,
          _kitchen_elapsed: 0,
        }])
      );
      return { ...prev, drivers, orders };
    });
  }, []);

  const setMultiplier = useCallback((x) => {
    clockRef.current.setMultiplier(x);
    setMultiplierS(clockRef.current.multiplier);

    setWorld(prev => ({
      ...prev,
      params: {
        ...prev.params,
        sim_multiplier: x
      }
    }));
  }, []);

  // ── Gestión de entidades ──────────────────────────────────────────────────
  const addDriver = useCallback((pos, overrides = {}) => {
    const driver = createDriver(pos, overrides);
    setWorld(prev => {
      const next = { ...prev, drivers: { ...prev.drivers, [driver.id]: driver } };
      _autoSave(next, variablesRef.current);
      return next;
    });
    return driver.id;
  }, []);

  const updateDriver = useCallback((id, patch) => {
    setWorld(prev => {
      const next = { ...prev, drivers: { ...prev.drivers, [id]: { ...prev.drivers[id], ...patch } } };
      _autoSave(next, variablesRef.current);
      return next;
    });
  }, []);

  const removeDriver = useCallback((id) => {
    setWorld(prev => {
      const { [id]: _, ...rest } = prev.drivers;
      const next = { ...prev, drivers: rest };
      _autoSave(next, variablesRef.current);
      return next;
    });
  }, []);

  const addRestaurant = useCallback((pos, overrides = {}) => {
    const r = createRestaurant(pos, overrides);
    setWorld(prev => {
      const next = { ...prev, restaurants: { ...prev.restaurants, [r.id]: r } };
      _autoSave(next, variablesRef.current);
      return next;
    });
    return r.id;
  }, []);

  const updateRestaurant = useCallback((id, patch) => {
    setWorld(prev => {
      const next = { ...prev, restaurants: { ...prev.restaurants, [id]: { ...prev.restaurants[id], ...patch } } };
      _autoSave(next, variablesRef.current);
      return next;
    });
  }, []);

  const removeRestaurant = useCallback((id) => {
    setWorld(prev => {
      const { [id]: _, ...rest } = prev.restaurants;
      const next = { ...prev, restaurants: rest };
      _autoSave(next, variablesRef.current);
      return next;
    });
  }, []);

  const addCustomer = useCallback((pos, overrides = {}) => {
    const c = createCustomer(pos, overrides);
    setWorld(prev => {
      const next = { ...prev, customers: { ...prev.customers, [c.id]: c } };
      _autoSave(next, variablesRef.current);
      return next;
    });
    return c.id;
  }, []);

  const updateCustomer = useCallback((id, patch) => {
    setWorld(prev => {
      const next = { ...prev, customers: { ...prev.customers, [id]: { ...prev.customers[id], ...patch } } };
      _autoSave(next, variablesRef.current);
      return next;
    });
  }, []);

  const removeCustomer = useCallback((id) => {
    setWorld(prev => {
      const { [id]: _, ...rest } = prev.customers;
      const next = { ...prev, customers: rest };
      _autoSave(next, variablesRef.current);
      return next;
    });
  }, []);

  // ── Pedidos ───────────────────────────────────────────────────────────────
  // Lanzar pedido manual durante la simulación
  const dispatchOrder = useCallback((restaurantId, customerId, overrides = {}) => {

    const order = createOrder(restaurantId, customerId, {
      ...overrides,
      trigger: 'manual',
      triggered: true,
    });

    setWorld(prev => {

      const next = {
        ...prev,
        orders: { ...prev.orders, [order.id]: order }
      };

      _autoSave(next, variablesRef.current);

      // disparar evento
      if (assignRef.current) {
        assignRef.current._world = next;
        assignRef.current.handleOrderCreated(order.id, clockRef.current.simTime);
      }

      return next;
    });

    return order.id;

  }, []);

  // Agregar pedido pre-programado a un restaurante (en orders_config)
  const addOrderConfig = useCallback((restaurantId, config) => {
    const order = createOrder(restaurantId, config.customer_id, {
      amount_cents: config.amount_cents ?? 15000,
      trigger:      config.trigger      ?? 'manual',
    });
    setWorld(prev => {
      const rest  = prev.restaurants[restaurantId];
      const next  = {
        ...prev,
        orders: { ...prev.orders, [order.id]: order },
        restaurants: {
          ...prev.restaurants,
          [restaurantId]: {
            ...rest,
            orders_config: [...(rest.orders_config ?? []), { ...config, order_id: order.id }],
          },
        },
      };
      _autoSave(next, variablesRef.current);
      return next;
    });
    return order.id;
  }, []);

  const removeOrder = useCallback((orderId) => {
    setWorld(prev => {
      const { [orderId]: _, ...rest } = prev.orders;
      const next = { ...prev, orders: rest };
      _autoSave(next, variablesRef.current);
      return next;
    });
  }, []);

  // Disparar manualmente un pedido pre-programado
  const triggerOrder = useCallback((orderId) => {

    setWorld(prev => {

      const order = prev.orders[orderId];
      if (!order) return prev;

      const updated = { ...order, triggered: true };

      const next = {
        ...prev,
        orders: { ...prev.orders, [orderId]: updated }
      };

      if (assignRef.current) {
        assignRef.current._world = next;
        assignRef.current.handleOrderCreated(order.id, clockRef.current.simTime);
      }

      return next;

    });

  }, []);

  // ── Variables de scoring ──────────────────────────────────────────────────
  const updateVariable = useCallback((id, patch) => {
    setVariables(prev => {
      const next = prev.map(v => v.id === id ? { ...v, ...patch } : v);
      _autoSaveVars(worldRef.current, next);
      return next;
    });
  }, []);

  const addVariable = useCallback((varDef) => {
    setVariables(prev => {
      const next = [...prev, varDef];
      _autoSaveVars(worldRef.current, next);
      return next;
    });
  }, []);

  const removeVariable = useCallback((id) => {
    setVariables(prev => {
      const next = prev.filter(v => v.id !== id);
      _autoSaveVars(worldRef.current, next);
      return next;
    });
  }, []);

  // ── Escenarios ────────────────────────────────────────────────────────────
  const saveScenario = useCallback((name) => {
    const scenario = serializeWorld(worldRef.current, variablesRef.current);
    saveToLibrary(name, scenario);
    setScenarios(loadLibrary());
  }, []);

  const loadScenario = useCallback((nameOrData) => {
    const data = typeof nameOrData === 'string'
      ? loadLibrary()[nameOrData]
      : nameOrData;
    if (!data) return;
    _applyScenario(data, setWorld, setVariables);
  }, []);

  const deleteScenario = useCallback((name) => {
    deleteFromLibrary(name);
    setScenarios(loadLibrary());
  }, []);

  const exportScenario = useCallback((name) => {
    const scenario = serializeWorld(worldRef.current, variablesRef.current);
    exportScenarioToFile(name, scenario);
  }, []);

  const importScenario = useCallback(async () => {
    const data = await importScenarioFromFile();
    _applyScenario(data, setWorld, setVariables);
  }, []);

  // ── Replay ────────────────────────────────────────────────────────────────
  const seekReplay = useCallback((targetTime) => {
    const snap = recorderRef.current.getSnapshotAt(targetTime);
    if (snap) {
      setReplayTime(snap.simTime);
      setWorld(snap.world);
    }
  }, []);

  // ── Cargar último escenario al montar ─────────────────────────────────────
  useEffect(() => {
    const last = loadLastScenario();
    if (last) _applyScenario(last, setWorld, setVariables);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const syncWorld = useCallback((note) => {
    const next = {
      ...worldRef.current,
      drivers: { ...worldRef.current.drivers },
      restaurants: { ...worldRef.current.restaurants },
      customers: { ...worldRef.current.customers },
      orders: { ...worldRef.current.orders },
      params: { ...worldRef.current.params },
    };

    worldRef.current = next;
    setWorld(next);

    if (note !== false) {
      _autoSave(next, variablesRef.current);
    }

    return next;
  }, []);

  const pushManualEvent = useCallback((type, message, extra = {}) => {
    const event = {
      time: clockRef.current.simTime,
      type,
      message,
      ...extra,
    };

    recorderRef.current.addEvent(event);
    setLog(prev => [event, ...prev].slice(0, 500));
    return event;
  }, []);

  const updateWorldParam = useCallback((name, value) => {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
      pushManualEvent('role_action_error', `⚠️ Parámetro inválido para ${name}`, {
        role: 'engine',
        action: 'update_param',
        param: name,
      });
      return { ok: false, message: `Valor inválido para ${name}` };
    }

    const world = worldRef.current;
    world.params = {
      ...world.params,
      [name]: numericValue,
    };
    syncWorld();
    pushManualEvent('role_action', `⚙️ Engine: ${name} = ${numericValue}`, {
      role: 'engine',
      action: 'update_param',
      param: name,
      value: numericValue,
    });

    return { ok: true, message: `${name} actualizado a ${numericValue}` };
  }, [pushManualEvent, syncWorld]);

  const roleAction = useCallback((role, action, payload = {}) => {
    const world = worldRef.current;
    const simTimeNow = clockRef.current.simTime;

    const log = (message, extra = {}) => pushManualEvent('role_action', message, { role, action, ...extra });
    const error = (message, extra = {}) => {
      pushManualEvent('role_action_error', `⚠️ ${message}`, { role, action, ...extra });
      return { ok: false, message };
    };
    const success = (message, extra = {}) => {
      syncWorld();
      log(message, extra);
      return { ok: true, message };
    };
    const isTerminalOrder = (order) => !order || ['delivered', 'cancelled'].includes(order.status);
    const detachOrderFromDriver = (order) => {
      const driver = order?.driver_id ? world.drivers[order.driver_id] : null;
      if (!driver) return null;
      driver.orders = (driver.orders ?? []).filter(id => id !== order.id);
      if ((driver.orders ?? []).length === 0 && driver.status !== 'offline') driver.status = 'idle';
      assignRef.current?._syncDriverOrdersFromOrderLinks?.();
      assignRef.current?._routingPlanner?.replan(driver);
      return driver;
    };
    const queueOrderAgain = (order) => {
      order.driver_id = null;
      order.status = 'queued';
      order.assigned_at = null;
      order.next_retry_at = simTimeNow;
      order.triggered = true;
      order.triggered_at = Number.isFinite(order.triggered_at) ? order.triggered_at : simTimeNow;
      order.last_transferred_at = simTimeNow;
      assignRef.current?.handleOrderCreated?.(order.id, simTimeNow);
    };

    if (role === 'driver') {
      const driver = world.drivers[payload.driverId];
      if (!driver) return error('Driver no encontrado');

      const order = payload.orderId ? world.orders[payload.orderId] : null;

      if (action === 'toggleAvailability') {
        driver.is_available = !(driver.is_available ?? true);
        if (!driver.is_available && (driver.orders?.length ?? 0) === 0) {
          driver.status = 'offline';
        } else if (driver.is_available && driver.status === 'offline') {
          driver.status = 'idle';
        }
        driver.last_availability_toggle_at = simTimeNow;
        return success(`🛵 ${driver.name} ${driver.is_available ? 'quedó disponible' : 'quedó fuera de línea'}`, { driverId: driver.id });
      }

      if (action === 'reportLocation') {
        const jitter = () => (Math.random() - 0.5) * 0.0012;
        driver.pos = {
          lat: driver.pos.lat + jitter(),
          lng: driver.pos.lng + jitter(),
        };
        driver.last_location_report_at = simTimeNow;
        return success(`📍 ${driver.name} reportó ubicación manual`, { driverId: driver.id });
      }

      if (!order) return error('Selecciona un pedido para esta acción', { driverId: driver.id });
      if (isTerminalOrder(order)) return error(`El pedido ${order.id} ya no admite acciones manuales`, { driverId: driver.id, orderId: order.id });

      if (action === 'acceptOffer') {
        const result = assignRef.current?.acceptDriverOffer?.(order.id, driver.id, simTimeNow);
        return result?.ok
          ? success(`✅ ${result.message}`, { driverId: driver.id, orderId: order.id })
          : error(result?.message ?? `No se pudo aceptar ${order.id}`, { driverId: driver.id, orderId: order.id });
      }

      if (action === 'claimOrder') {
        const result = assignRef.current?.forceAssignOrderToDriver?.(order.id, driver.id, simTimeNow);
        return result?.ok
          ? success(`🛵 ${result.message}`, { driverId: driver.id, orderId: order.id })
          : error(result?.message ?? `No se pudo tomar ${order.id}`, { driverId: driver.id, orderId: order.id });
      }

      if (action === 'rejectOffer') {
        const result = assignRef.current?.rejectDriverOffer?.(order.id, driver.id, simTimeNow, 'manual_reject');
        return result?.ok
          ? success(`❌ ${result.message}`, { driverId: driver.id, orderId: order.id })
          : error(result?.message ?? `No se pudo rechazar ${order.id}`, { driverId: driver.id, orderId: order.id });
      }

      if (action === 'requestRebalance') {
        if (order.driver_id !== driver.id) return error(`El pedido ${order.id} no está asignado a ${driver.name}`, { driverId: driver.id, orderId: order.id });
        order.rebalance_requested_at = simTimeNow;
        const result = assignRef.current?.requeueOrder?.(order.id, simTimeNow, 'manual_rebalance');
        return result?.ok
          ? success(`🔄 ${driver.name} pidió rebalanceo para ${order.id}; volvió a cola`, { driverId: driver.id, orderId: order.id })
          : error(result?.message ?? `No se pudo rebalancear ${order.id}`, { driverId: driver.id, orderId: order.id });
      }

      if (action === 'releaseOrder') {
        if (order.driver_id !== driver.id) return error(`El pedido ${order.id} no está asignado a ${driver.name}`, { driverId: driver.id, orderId: order.id });
        const result = assignRef.current?.requeueOrder?.(order.id, simTimeNow, 'manual_release');
        return result?.ok
          ? success(`🧯 ${driver.name} liberó ${order.id}; volvió a cola`, { driverId: driver.id, orderId: order.id })
          : error(result?.message ?? `No se pudo liberar ${order.id}`, { driverId: driver.id, orderId: order.id });
      }

      return error(`Acción de driver no soportada: ${action}`, { driverId: driver.id });
    }

    if (role === 'restaurant') {
      const restaurant = world.restaurants[payload.restaurantId];
      if (!restaurant) return error('Comercio no encontrado');
      const order = payload.orderId ? world.orders[payload.orderId] : null;

      if (action === 'toggleOpen') {
        restaurant.manual_open_override = !(restaurant.manual_open_override ?? true);
        restaurant.last_open_toggle_at = simTimeNow;
        return success(`🏪 ${restaurant.name} ${restaurant.manual_open_override ? 'abrió operación' : 'pausó operación'}`, { restaurantId: restaurant.id });
      }

      if (action === 'speedPrepUp') {
        restaurant.prep_time_s = Math.max(60, Math.round((restaurant.prep_time_s ?? 600) - 60));
        return success(`⚡ ${restaurant.name} redujo su prep a ${restaurant.prep_time_s}s`, { restaurantId: restaurant.id });
      }

      if (action === 'slowPrepDown') {
        restaurant.prep_time_s = Math.min(3600, Math.round((restaurant.prep_time_s ?? 600) + 60));
        return success(`🐢 ${restaurant.name} aumentó su prep a ${restaurant.prep_time_s}s`, { restaurantId: restaurant.id });
      }

      if (!order) return error('Selecciona un pedido del comercio', { restaurantId: restaurant.id });
      if (isTerminalOrder(order)) return error(`El pedido ${order.id} ya está cerrado`, { restaurantId: restaurant.id, orderId: order.id });

      if (action === 'markPreparing') {
        order.kitchen_status = 'preparing';
        order.prep_started_at = Number.isFinite(order.prep_started_at) ? order.prep_started_at : simTimeNow;
        order.kitchen_ready_at = null;
        return success(`🍳 ${restaurant.name} puso ${order.id} en preparación`, { restaurantId: restaurant.id, orderId: order.id });
      }

      if (action === 'markReady') {
        order.kitchen_status = 'ready';
        order.kitchen_ready_at = simTimeNow;
        return success(`🍱 ${restaurant.name} marcó ${order.id} listo para retiro`, { restaurantId: restaurant.id, orderId: order.id });
      }

      if (action === 'sendSuggestion') {
        order.suggestion_status = 'pending_customer';
        order.suggestion_text = payload.note || 'Sugerencia manual enviada desde el panel';
        order.suggested_at = simTimeNow;
        return success(`💡 ${restaurant.name} envió sugerencia para ${order.id}`, { restaurantId: restaurant.id, orderId: order.id });
      }

      if (action === 'cancelOrder') {
        detachOrderFromDriver(order);
        order.driver_id = null;
        order.offer_sent_at = null;
        order.offer_expires_at = null;
        order.offer_answered_at = simTimeNow;
        order.status = 'cancelled';
        order.cancelled_by = 'restaurant';
        order.cancelled_at = simTimeNow;
        return success(`⛔ ${restaurant.name} canceló ${order.id}`, { restaurantId: restaurant.id, orderId: order.id });
      }

      return error(`Acción de comercio no soportada: ${action}`, { restaurantId: restaurant.id });
    }

    if (role === 'customer') {
      const customer = world.customers[payload.customerId];
      if (!customer) return error('Cliente no encontrado');
      const order = payload.orderId ? world.orders[payload.orderId] : null;

      if (action === 'placeOrder') {
        if (!payload.restaurantId) return error('Selecciona un comercio para crear el pedido', { customerId: customer.id });
        const restaurant = world.restaurants[payload.restaurantId];
        if (!restaurant) return error('Comercio no encontrado para crear el pedido', { customerId: customer.id, restaurantId: payload.restaurantId });
        if (restaurant.manual_open_override === false) {
          return error(`${restaurant.name} está pausado y no recibe pedidos`, { customerId: customer.id, restaurantId: restaurant.id });
        }
        const orderId = dispatchOrder(payload.restaurantId, customer.id, { amount_cents: payload.amountCents ?? 15000 });
        return success(`🛒 ${customer.name} creó ${orderId}`, { customerId: customer.id, orderId, restaurantId: payload.restaurantId });
      }

      if (!order) return error('Selecciona un pedido del cliente', { customerId: customer.id });
      if (action === 'cancelOrder') {
        if (isTerminalOrder(order)) return error(`El pedido ${order.id} ya está cerrado`, { customerId: customer.id, orderId: order.id });
        detachOrderFromDriver(order);
        order.driver_id = null;
        order.offer_sent_at = null;
        order.offer_expires_at = null;
        order.offer_answered_at = simTimeNow;
        order.status = 'cancelled';
        order.cancelled_by = 'customer';
        order.cancelled_at = simTimeNow;
        return success(`🚫 ${customer.name} canceló ${order.id}`, { customerId: customer.id, orderId: order.id });
      }

      if (isTerminalOrder(order)) return error(`El pedido ${order.id} ya está cerrado`, { customerId: customer.id, orderId: order.id });

      if (action === 'acceptSuggestion') {
        if (order.suggestion_status !== 'pending_customer') {
          return error(`No hay sugerencia pendiente en ${order.id}`, { customerId: customer.id, orderId: order.id });
        }
        order.suggestion_status = 'accepted';
        order.suggestion_answered_at = simTimeNow;
        return success(`👍 ${customer.name} aceptó sugerencia en ${order.id}`, { customerId: customer.id, orderId: order.id });
      }

      if (action === 'rejectSuggestion') {
        if (order.suggestion_status !== 'pending_customer') {
          return error(`No hay sugerencia pendiente en ${order.id}`, { customerId: customer.id, orderId: order.id });
        }
        order.suggestion_status = 'rejected';
        order.suggestion_answered_at = simTimeNow;
        return success(`👎 ${customer.name} rechazó sugerencia en ${order.id}`, { customerId: customer.id, orderId: order.id });
      }

      if (action === 'requestSupport') {
        order.support_status = 'open';
        order.support_requested_at = simTimeNow;
        return success(`🆘 ${customer.name} abrió soporte para ${order.id}`, { customerId: customer.id, orderId: order.id });
      }

      return error(`Acción de cliente no soportada: ${action}`, { customerId: customer.id });
    }

    return error(`Rol no soportado: ${role}`);
  }, [dispatchOrder, pushManualEvent, syncWorld]);


  return {
    // Estado
    world, variables, simState, simTime, multiplier, log, graphStatus,
    scenarios, replayTime, metrics,
    recorder: recorderRef.current,
    engine: assignRef.current,
    // Control de simulación
    start, pause, reset, setMultiplier,
    // Entidades
    addDriver, updateDriver, removeDriver,
    addRestaurant, updateRestaurant, removeRestaurant,
    addCustomer, updateCustomer, removeCustomer,
    // Pedidos
    dispatchOrder, addOrderConfig, removeOrder, triggerOrder,
    // Paneles manuales
    updateWorldParam, roleAction,
    // Variables
    updateVariable, addVariable, removeVariable,
    // Escenarios
    saveScenario, loadScenario, deleteScenario, exportScenario, importScenario,
    // Replay
    seekReplay,
  };
}

// ─── Helpers internos ─────────────────────────────────────────────────────────
function _autoSave(world, variables) {
  saveLastScenario(serializeWorld(world, variables));
}

function _autoSaveVars(world, variables) {
  saveLastScenario(serializeWorld(world, variables));
}

function _isValidPos(pos) {
  return Number.isFinite(pos?.lat) && Number.isFinite(pos?.lng);
}

function _applyScenario(data, setWorld, setVariables) {
  if (data.params || data.drivers || data.restaurants || data.customers || data.orders) {
    setWorld(prev => {
      const loadedDrivers = data.drivers
        ? Object.fromEntries(
            Object.entries(data.drivers).flatMap(([id, d]) => {
              const basePos = _isValidPos(d.home_pos) ? d.home_pos : (_isValidPos(d.pos) ? d.pos : null);
              if (!basePos) return [];
              return [[id, {
                ...createDriver(basePos, d),
                id,
                home_pos: basePos,
                pos: basePos,
              }]];
            })
          )
        : prev.drivers;

      const loadedRestaurants = data.restaurants
        ? Object.fromEntries(
            Object.entries(data.restaurants).flatMap(([id, r]) => {
              if (!_isValidPos(r.pos)) return [];
              return [[id, {
                ...createRestaurant(r.pos, r),
                id,
              }]];
            })
          )
        : prev.restaurants;

      const loadedCustomers = data.customers
        ? Object.fromEntries(
            Object.entries(data.customers).flatMap(([id, c]) => {
              if (!_isValidPos(c.pos)) return [];
              return [[id, {
                ...createCustomer(c.pos, c),
                id,
              }]];
            })
          )
        : prev.customers;

      const loadedOrders = data.orders
        ? Object.fromEntries(
            Object.entries(data.orders).flatMap(([id, o]) => {
              if (!o?.restaurant_id || !o?.customer_id) return [];
              return [[id, {
                ...createOrder(o.restaurant_id, o.customer_id, o),
                id,
              }]];
            })
          )
        : prev.orders;

      const maxId = [
        ...Object.keys(loadedDrivers),
        ...Object.keys(loadedRestaurants),
        ...Object.keys(loadedCustomers),
        ...Object.keys(loadedOrders),
      ].reduce((max, id) => {
        const n = Number((id ?? '').split('-')[1]);
        return Number.isFinite(n) ? Math.max(max, n) : max;
      }, 0);
      setIdCounter(maxId + 1);

      return {
        params:      data.params ?? prev.params,
        drivers:     loadedDrivers,
        restaurants: loadedRestaurants,
        customers:   loadedCustomers,
        orders:      loadedOrders,
      };
    });
  }
  if (data.variables) {
    setVariables(mergeWithSaved(data.variables));
  }
}

// ─── Cálculo de métricas globales ────────────────────────────────────────────
function computeMetrics(world) {
  const drivers  = Object.values(world.drivers);
  const orders   = Object.values(world.orders);
  const delivered = orders.filter(o => o.status === 'delivered');

  const avgWaitMs = delivered.length > 0
    ? delivered.reduce((sum, o) => {
        const wait = (o.delivered_at ?? 0) - (o.assigned_at ?? 0);
        return sum + wait;
      }, 0) / delivered.length
    : 0;

  const totalDeadKm = drivers.reduce((sum, d) => sum + (d.metrics.dead_km ?? 0), 0);
  const totalIdleS  = drivers.reduce((sum, d) => sum + (d.metrics.idle_time_s ?? 0), 0);
  const totalDistKm = drivers.reduce((sum, d) => sum + (d.metrics.total_distance_km ?? 0), 0);

  return {
    delivered_count:    delivered.length,
    pending_count:      orders.filter(o => ['queued', 'offer_pending'].includes(o.status)).length,
    active_count:       orders.filter(o => ['assigned','on_the_way'].includes(o.status)).length,
    avg_wait_s:         +avgWaitMs.toFixed(1),
    total_dead_km:      +totalDeadKm.toFixed(2),
    total_idle_s:       +totalIdleS.toFixed(1),
    total_distance_km:  +totalDistKm.toFixed(2),
  };
}
