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
      max_assignment_eta_s:  1800,
      max_eta_sum_s:         3600,
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

  return {
    // Estado
    world, variables, simState, simTime, multiplier, log, graphStatus,
    scenarios, replayTime, metrics,
    recorder: recorderRef.current,
    // Control de simulación
    start, pause, reset, setMultiplier,
    // Entidades
    addDriver, updateDriver, removeDriver,
    addRestaurant, updateRestaurant, removeRestaurant,
    addCustomer, updateCustomer, removeCustomer,
    // Pedidos
    dispatchOrder, addOrderConfig, removeOrder, triggerOrder,
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
    pending_count:      orders.filter(o => o.status === 'queued').length,
    active_count:       orders.filter(o => ['assigned','on_the_way'].includes(o.status)).length,
    avg_wait_s:         +avgWaitMs.toFixed(1),
    total_dead_km:      +totalDeadKm.toFixed(2),
    total_idle_s:       +totalIdleS.toFixed(1),
    total_distance_km:  +totalDistKm.toFixed(2),
  };
}
