// src/ui/SimMap.jsx
//
// Mapa central con MapLibre GL. Renderiza:
//   🛵 Drivers  — azul, flecha de dirección cuando se mueven
//   🏪 Restaurantes — naranja, fijo
//   📍 Clientes — verde, fijo
//
// Click en mapa → agrega entidad según addMode.
// Click en marker existente → selecciona y muestra en SidePanel.
//
// Rutas activas de drivers se renderizan como líneas GeoJSON.

import { useEffect, useRef } from 'react';

// MapLibre cargado dinámicamente para no bloqueear el bundle inicial
let _ml = null;
function ensureML() {
  if (_ml) return Promise.resolve(_ml);
  if (window.maplibregl) { _ml = window.maplibregl; return Promise.resolve(_ml); }
  if (window.__mlPromise) return window.__mlPromise;
  window.__mlPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js';
    s.async = true;
    s.onload = () => { _ml = window.maplibregl; res(_ml); };
    s.onerror = () => rej(new Error('No se pudo cargar MapLibre'));
    document.head.appendChild(s);
  });
  return window.__mlPromise;
}

// Morelia centro
const MORELIA_CENTER = [-101.1844, 19.7026];

// Colores de entidades
const COLORS = {
  driver:     '#2f81f7',
  restaurant: '#f0883e',
  customer:   '#3fb950',
};

// SVG pins inline para cada tipo
function driverSVG(heading = 0, isMoving = false) {
  const color = isMoving ? '#2f81f7' : '#8d96a0';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="11" fill="${color}22" stroke="${color}" stroke-width="1.5"/>
    <path d="M12 5L7 18l5-3 5 3z" fill="${color}" stroke="${color}" stroke-width="0.5"
      style="transform-origin:50% 50%;transform:rotate(${heading}deg)"/>
  </svg>`;
}

function restaurantSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="36" viewBox="0 0 32 36">
    <path d="M16 2C9.37 2 4 7.37 4 14c0 9 12 20 12 20s12-11 12-20c0-6.63-5.37-12-12-12z"
      fill="#f0883e" stroke="#fff" stroke-width="1.5"/>
    <text x="16" y="18" text-anchor="middle" font-size="12" fill="white">🏪</text>
  </svg>`;
}

function customerSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="32" viewBox="0 0 28 32">
    <path d="M14 2C8.48 2 4 6.48 4 12c0 7.5 10 18 10 18s10-10.5 10-18c0-5.52-4.48-10-10-10z"
      fill="#3fb950" stroke="#fff" stroke-width="1.5"/>
    <circle cx="14" cy="12" r="4" fill="white"/>
  </svg>`;
}

function svgToDataURL(svg) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

export default function SimMap({ sim, addMode, onAddMode, selected, onSelect }) {
  const containerRef = useRef(null);
  const mapRef       = useRef(null);
  const markersRef   = useRef({});   // entityId → {marker, el}
  const routeLayersRef = useRef({}); // driverId → source/layer ids added

  const { world, simState } = sim;

  // ── Inicializar mapa ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    ensureML().then(ml => {
      if (!containerRef.current || mapRef.current) return;
      const map = new ml.Map({
        container:         containerRef.current,
        style:             'https://tiles.openfreemap.org/styles/bright',
        center:            MORELIA_CENTER,
        zoom:              13,
        pitch:             0,
        bearing:           0,
        attributionControl: false,
        dragRotate:        false,
      });
      map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
      map.addControl(new ml.ScaleControl({ unit: 'metric' }), 'bottom-right');

      // Click en mapa → agregar entidad
      map.on('click', (e) => {
        if (!addMode) return;
        const pos = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        if (addMode === 'driver')     sim.addDriver(pos);
        if (addMode === 'restaurant') sim.addRestaurant(pos);
        if (addMode === 'customer')   sim.addCustomer(pos);
        // No desactivar addMode para poder agregar múltiples
      });

      mapRef.current = map;
    });

    return () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cursor según addMode ───────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = addMode ? 'crosshair' : '';
  }, [addMode]);

  // ── Sincronizar markers de entidades ──────────────────────────────────────
  // Drivers — recrear si cambian, mover si se mueven
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !_ml) return;

    const drivers = Object.values(world.drivers);
    const driverIds = new Set(drivers.map(d => d.id));

    // Eliminar markers de drivers que ya no existen
    for (const [id, { marker }] of Object.entries(markersRef.current)) {
      if (id.startsWith('drv-') && !driverIds.has(id)) {
        marker.remove();
        delete markersRef.current[id];
      }
    }

    // Crear o actualizar markers
    for (const driver of drivers) {
      const key = driver.id;
      const isMoving = driver.status !== 'idle';
      const heading  = driver.path.length > 1 && driver.path_index < driver.path.length - 1
        ? _bearingBetween(driver.path[driver.path_index], driver.path[Math.min(driver.path_index + 1, driver.path.length - 1)])
        : 0;

      if (!markersRef.current[key]) {
        // Crear nuevo marker
        const el = document.createElement('div');
        el.innerHTML = driverSVG(heading, isMoving);
        el.style.cssText = 'cursor:pointer;user-select:none;';
        el.title = driver.name;
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          onSelect({ type: 'driver', id: driver.id });
        });

        const marker = new _ml.Marker({ element: el, anchor: 'center' })
          .setLngLat([driver.pos.lng, driver.pos.lat])
          .addTo(map);

        markersRef.current[key] = { marker, el };
      } else {
        // Mover + actualizar SVG
        const { marker, el } = markersRef.current[key];
        marker.setLngLat([driver.pos.lng, driver.pos.lat]);
        el.innerHTML = driverSVG(heading, isMoving);
      }

      // Highlight si está seleccionado
      const { el } = markersRef.current[key];
      el.style.filter = selected?.id === driver.id ? 'drop-shadow(0 0 6px #2f81f7)' : '';
    }
  }); // Sin deps — corre en cada render para mover markers en tiempo real

  // ── Markers estáticos (restaurants + customers) ───────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !_ml) return;

    const entities = [
      ...Object.values(world.restaurants).map(r => ({ ...r, _type: 'restaurant' })),
      ...Object.values(world.customers).map(c => ({ ...c, _type: 'customer' })),
    ];
    const entityIds = new Set(entities.map(e => e.id));

    // Eliminar markers de entidades que ya no existen
    for (const [id, { marker }] of Object.entries(markersRef.current)) {
      if ((id.startsWith('rst-') || id.startsWith('cus-')) && !entityIds.has(id)) {
        marker.remove();
        delete markersRef.current[id];
      }
    }

    // Crear markers para entidades nuevas
    for (const entity of entities) {
      if (markersRef.current[entity.id]) {
        // Actualizar highlight
        const { el } = markersRef.current[entity.id];
        el.style.filter = selected?.id === entity.id ? `drop-shadow(0 0 6px ${COLORS[entity._type]})` : '';
        continue;
      }

      const el = document.createElement('div');
      el.innerHTML = entity._type === 'restaurant' ? restaurantSVG() : customerSVG();
      el.style.cssText = 'cursor:pointer;user-select:none;';
      el.title = entity.name;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelect({ type: entity._type, id: entity.id });
      });

      // Popup con nombre
      const popup = new _ml.Popup({ closeButton: false, offset: 20 })
        .setText(entity.name);

      const marker = new _ml.Marker({ element: el })
        .setLngLat([entity.pos.lng, entity.pos.lat])
        .setPopup(popup)
        .addTo(map);

      markersRef.current[entity.id] = { marker, el };
    }
  }, [world.restaurants, world.customers, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Rutas de drivers (GeoJSON layers) ─────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    for (const driver of Object.values(world.drivers)) {
      const srcId = `route-${driver.id}`;
      const lyrId = `route-layer-${driver.id}`;
      const geo   = {
        type: 'Feature', properties: {},
        geometry: {
          type: 'LineString',
          coordinates: driver.path.slice(driver.path_index).map(p => [p.lng, p.lat]),
        },
      };

      if (!map.getSource(srcId)) {
        map.addSource(srcId, { type: 'geojson', data: geo });
        map.addLayer({
          id:     lyrId,
          type:   'line',
          source: srcId,
          paint: {
            'line-color':   COLORS.driver,
            'line-width':   2.5,
            'line-opacity': 0.6,
            'line-dasharray': [2, 2],
          },
          layout: { 'line-cap': 'round', 'line-join': 'round' },
        });
        routeLayersRef.current[driver.id] = true;
      } else {
        map.getSource(srcId).setData(geo);
      }
    }

    // Limpiar capas de drivers eliminados
    for (const driverId of Object.keys(routeLayersRef.current)) {
      if (!world.drivers[driverId]) {
        const srcId = `route-${driverId}`;
        const lyrId = `route-layer-${driverId}`;
        if (map.getLayer(lyrId)) map.removeLayer(lyrId);
        if (map.getSource(srcId)) map.removeSource(srcId);
        delete routeLayersRef.current[driverId];
      }
    }
  }); // Sin deps — corre en cada render

  // ── Indicador de modo de adición ──────────────────────────────────────────
  const modeLabel = {
    driver:     '🛵 Click para agregar Driver',
    restaurant: '🏪 Click para agregar Comercio',
    customer:   '📍 Click para agregar Cliente',
  }[addMode];

  return (
    <div style={{ height: '100%', width: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />

      {/* Modo de adición — banner */}
      {addMode && (
        <div style={{
          position: 'absolute',
          top: 10,
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(13,17,23,0.88)',
          border: '1px solid var(--accent)',
          color: 'var(--accent)',
          borderRadius: 20,
          padding: '5px 14px',
          fontSize: 12,
          fontWeight: 500,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          backdropFilter: 'blur(4px)',
        }}>
          {modeLabel}
          <button
            style={{ background: 'none', border: 'none', color: 'var(--text-2)', cursor: 'pointer', fontSize: 13 }}
            onClick={() => onAddMode(null)}
          >✕</button>
        </div>
      )}

      {/* Leyenda */}
      <div style={{
        position: 'absolute',
        top: 10,
        right: 44,
        background: 'rgba(13,17,23,0.82)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '6px 10px',
        fontSize: 11,
        color: 'var(--text-1)',
        zIndex: 10,
        backdropFilter: 'blur(4px)',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span><span style={{ color: COLORS.driver }}>⬤</span> Driver</span>
          <span><span style={{ color: COLORS.restaurant }}>⬤</span> Comercio</span>
          <span><span style={{ color: COLORS.customer }}>⬤</span> Cliente</span>
        </div>
      </div>

      {/* Atribuciones */}
      <div style={{
        position: 'absolute',
        bottom: 36,
        left: 8,
        fontSize: 10,
        color: 'var(--text-2)',
        zIndex: 10,
      }}>
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer"
          style={{ color: 'var(--text-2)' }}>OpenStreetMap</a>
      </div>
    </div>
  );
}

// Bearing entre dos puntos {lat,lng}
function _bearingBetween(from, to) {
  if (!from || !to) return 0;
  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat  * Math.PI / 180;
  const dLng = (to.lng - from.lng) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}
