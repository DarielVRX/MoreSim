// src/persistence/ScenarioStore.js
//
// Guarda y carga escenarios completos (entidades + parámetros + variables de scoring).
// Auto-guarda el último escenario en localStorage en cada cambio.
// También permite exportar/importar JSON.

const LAST_KEY     = 'moresim_last_scenario';
const LIBRARY_KEY  = 'moresim_scenarios';

export function saveLastScenario(scenario) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(scenario));
  } catch (e) {
    console.warn('[ScenarioStore] No se pudo guardar último escenario:', e);
  }
}

export function loadLastScenario() {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ─── Biblioteca de escenarios guardados ──────────────────────────────────────
export function saveScenario(name, scenario) {
  const library = loadLibrary();
  library[name] = { ...scenario, _saved_at: Date.now() };
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
  } catch (e) {
    console.warn('[ScenarioStore] localStorage lleno, eliminando el más viejo');
    const keys = Object.keys(library).sort((a, b) => library[a]._saved_at - library[b]._saved_at);
    delete library[keys[0]];
    library[name] = { ...scenario, _saved_at: Date.now() };
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
  }
}

export function loadLibrary() {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function deleteScenario(name) {
  const library = loadLibrary();
  delete library[name];
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
}

// ─── Export / Import JSON ─────────────────────────────────────────────────────
export function exportScenarioToFile(name, scenario) {
  const json = JSON.stringify({ name, ...scenario }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `moresim-${name.replace(/\s+/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importScenarioFromFile() {
  return new Promise((resolve, reject) => {
    const input    = document.createElement('input');
    input.type     = 'file';
    input.accept   = '.json';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return reject(new Error('Sin archivo'));
      try {
        const text     = await file.text();
        const scenario = JSON.parse(text);
        resolve(scenario);
      } catch (err) {
        reject(new Error('JSON inválido: ' + err.message));
      }
    };
    input.click();
  });
}

// ─── Serialización del WorldState ─────────────────────────────────────────────
// Convierte el world (con Maps anidados y estado runtime) a un objeto
// plano guardable. Excluye estado de runtime (paths, segment_elapsed, etc.)
export function serializeWorld(world, variables) {
  return {
    params: { ...world.params },
    drivers: Object.fromEntries(
      Object.entries(world.drivers).map(([id, d]) => [id, {
        id: d.id, name: d.name, home_pos: d.home_pos,
        speed_kmh: d.speed_kmh, max_orders: d.max_orders,
        rating: d.rating, idle_wait_s: d.idle_wait_s,
      }])
    ),
    restaurants: Object.fromEntries(
      Object.entries(world.restaurants).map(([id, r]) => [id, {
        id: r.id, name: r.name, pos: r.pos,
        prep_time_s: r.prep_time_s, penalty: r.penalty,
        metrics: r.metrics, orders_config: r.orders_config ?? [],
      }])
    ),
    customers: Object.fromEntries(
      Object.entries(world.customers).map(([id, c]) => [id, {
        id: c.id, name: c.name, pos: c.pos,
        max_distance_km: c.max_distance_km,
      }])
    ),
    orders: Object.fromEntries(
      Object.entries(world.orders).map(([id, o]) => [id, {
        id: o.id,
        restaurant_id: o.restaurant_id,
        customer_id: o.customer_id,
        amount_cents: o.amount_cents,
        trigger: o.trigger,
      }])
    ),
    variables: variables.map(v => ({
      id: v.id, enabled: v.enabled, weight: v.weight,
      formula_override: v.formula_override ?? null,
    })),
  };
}
