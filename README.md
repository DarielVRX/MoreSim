# MoreSim — Simulador de Asignación de Pedidos

Proyecto standalone para probar y depurar algoritmos de asignación.
No requiere backend. Todo corre en el navegador.

---

## Requisitos

- Node.js ≥ 18
- npm ≥ 9

Verifica:
```bash
node -v
npm -v
```

---

## Instalación

```bash
cd moresim
npm install
```

---

## Correr en desarrollo (recomendado para pruebas)

```bash
npm run dev
```

Abre `http://localhost:5174` automáticamente.

Accesible desde otros dispositivos en la misma red en `http://<tu-ip-local>:5174`.

---

## Build + preview (simula producción localmente)

```bash
npm run build
npm run preview
```

Corre en `http://localhost:5175`.

---

## Primera apertura

Al abrir por primera vez, el mapa descargará el grafo de calles de Morelia
desde Overpass API (~30 segundos). Se guarda en IndexedDB del navegador
y no vuelve a descargarse.

Si el grafo no carga (conexión lenta o Overpass saturado), espera unos minutos
e intenta recargar la página.

---

## Estructura del proyecto

```
src/
├── engine/
│   ├── SimClock.js          — reloj 1-60x
│   ├── GraphCache.js        — grafo de calles (Overpass + IndexedDB)
│   ├── MovementEngine.js    — A* libre + OSRM para pedidos
│   └── AssignmentEngine.js  — ciclo completo de asignación
├── scoring/
│   ├── variables.js         — ← AQUÍ SE MODIFICA EL ALGORITMO
│   └── scorer.js            — evaluador de variables
├── entities/index.js        — Driver, Restaurant, Customer, Order
├── replay/Recorder.js       — snapshots cada 15s
├── persistence/
│   └── ScenarioStore.js     — localStorage + export/import JSON
├── hooks/useSimulation.js   — hook central, única interfaz para UI
└── ui/
    ├── SimMap.jsx            — mapa MapLibre
    ├── TopBar.jsx            — controles de simulación
    ├── SidePanel.jsx         — panel lateral con tabs
    ├── LogPanel.jsx          — feed de eventos + replay
    ├── MetricsBar.jsx        — métricas en tiempo real
    └── components/
        ├── EntityInspector.jsx  — drivers / comercios / clientes
        ├── AlgorithmPanel.jsx   — variables de scoring
        ├── ScenariosPanel.jsx   — guardar / cargar escenarios
        └── OrderConfigRow.jsx

```

---

## Modificar el algoritmo de asignación

**Solo editar `src/scoring/variables.js`.**

Cada variable es un objeto:

```js
{
  id:          'mi_variable',     // ID único — no cambiar en producción
  name:        'Mi variable',     // nombre visible en UI
  enabled:     true,              // se puede toggle desde la UI
  weight:      30,                // 0-100, importancia relativa
  effect:      'maximize',        // 'maximize' | 'minimize' | 'gate'
  description: 'Para qué sirve',
  compute: (driver, order, restaurant, customer, world) => {
    // Retorna 0-1 (o bool para gate)
    return algúnCálculo;
  },
}
```

También puedes pegar una fórmula override desde la UI (tab Algoritmo → campo Fórmula override)
sin tocar el archivo.

---

## Parámetros globales del mundo

En `src/hooks/useSimulation.js`, función `createEmptyWorld()`:

```js
params: {
  max_assignment_eta_s: 1800,  // ETA máximo para normalizar distancia (30 min)
  max_eta_sum_s:        3600,  // ETA sum máximo para normalizar carga (1 hora)
}
```

---

## Acceso a OSRM

El proyecto usa `https://router.project-osrm.org` (instancia pública) para rutas de pedidos.
Si está caída o lenta, el fallback es línea recta.

Para usar una instancia local de OSRM, editar `src/engine/MovementEngine.js`:

```js
const OSRM_BASE = 'http://localhost:5000/route/v1/driving';
```

---

## Datos guardados en el navegador

- `localStorage` — escenarios guardados + último escenario auto-saved
- `IndexedDB (moresim-graph)` — grafo de calles de Morelia

Para limpiar todo: DevTools → Application → Clear site data.
