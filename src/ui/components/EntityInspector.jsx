// src/ui/components/EntityInspector.jsx
import { useState, useEffect } from 'react';
import OrderConfigRow from './OrderConfigRow.jsx';

export default function EntityInspector({ sim, selected, onSelect }) {
  const { world, simState } = sim;
  const [openSection,    setOpenSection]    = useState('drivers');
  const [expandedEntity, setExpandedEntity] = useState(null);

  const canEdit = simState === 'stopped' || simState === 'paused';

  // Cuando el mapa u otro origen externo cambia `selected`,
  // abrir la sección correcta y expandir la entidad automáticamente.
  useEffect(() => {
    if (!selected?.id || !selected?.type) return;
    const sectionMap = { driver: 'drivers', restaurant: 'restaurants', customer: 'customers' };
    const section    = sectionMap[selected.type];
    if (section) setOpenSection(section);
    setExpandedEntity(selected.id);
  }, [selected?.id, selected?.type]);

  function toggleSection(s) {
    setOpenSection(prev => prev === s ? null : s);
    setExpandedEntity(null);
  }

  function toggleEntity(id, type) {
    const next = expandedEntity === id ? null : id;
    setExpandedEntity(next);
    onSelect(next ? { type, id } : null);
  }

  // ... resto sin cambios, solo las llamadas a onRowClick:
  // onRowClick={() => toggleEntity(driver.id, 'driver')}
  // onRowClick={() => toggleEntity(r.id, 'restaurant')}
  // onRowClick={() => toggleEntity(c.id, 'customer')}

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>

      {/* ── Drivers ─────────────────────────────────────────────── */}
      <Section
        label={`Drivers (${Object.keys(world.drivers).length})`}
        open={openSection === 'drivers'}
        onToggle={() => toggleSection('drivers')}
        color="var(--driver-color)"
      >
        {Object.values(world.drivers).map(driver => (
          <EntityRow
            key={driver.id}
            icon="🛵"
            label={driver.name}
            status={driver.status}
            selected={selected?.id === driver.id}
            expanded={expandedEntity === driver.id}
            onRowClick={() => { onSelect({ type: 'driver', id: driver.id }); toggleEntity(driver.id); }}
            onDelete={canEdit ? () => sim.removeDriver(driver.id) : null}
          >
            <DriverFields driver={driver} sim={sim} canEdit={canEdit} />
          </EntityRow>
        ))}
        {Object.keys(world.drivers).length === 0 && (
          <EmptyHint>Haz click en el mapa con modo "Driver" activo</EmptyHint>
        )}
      </Section>

      {/* ── Restaurants ─────────────────────────────────────────── */}
      <Section
        label={`Comercios (${Object.keys(world.restaurants).length})`}
        open={openSection === 'restaurants'}
        onToggle={() => toggleSection('restaurants')}
        color="var(--restaurant-color)"
      >
        {Object.values(world.restaurants).map(r => (
          <EntityRow
            key={r.id}
            icon="🏪"
            label={r.name}
            status={`prep: ${r.prep_time_s}s`}
            selected={selected?.id === r.id}
            expanded={expandedEntity === r.id}
            onRowClick={() => { onSelect({ type: 'restaurant', id: r.id }); toggleEntity(r.id); }}
            onDelete={canEdit ? () => sim.removeRestaurant(r.id) : null}
          >
            <RestaurantFields restaurant={r} sim={sim} canEdit={canEdit} />
          </EntityRow>
        ))}
        {Object.keys(world.restaurants).length === 0 && (
          <EmptyHint>Haz click en el mapa con modo "Comercio" activo</EmptyHint>
        )}
      </Section>

      {/* ── Customers ───────────────────────────────────────────── */}
      <Section
        label={`Clientes (${Object.keys(world.customers).length})`}
        open={openSection === 'customers'}
        onToggle={() => toggleSection('customers')}
        color="var(--customer-color)"
      >
        {Object.values(world.customers).map(c => (
          <EntityRow
            key={c.id}
            icon="📍"
            label={c.name}
            status={`dist. max: ${c.max_distance_km}km`}
            selected={selected?.id === c.id}
            expanded={expandedEntity === c.id}
            onRowClick={() => { onSelect({ type: 'customer', id: c.id }); toggleEntity(c.id); }}
            onDelete={canEdit ? () => sim.removeCustomer(c.id) : null}
          >
            <CustomerFields customer={c} sim={sim} canEdit={canEdit} />
          </EntityRow>
        ))}
        {Object.keys(world.customers).length === 0 && (
          <EmptyHint>Haz click en el mapa con modo "Cliente" activo</EmptyHint>
        )}
      </Section>
    </div>
  );
}

// ─── Section collapsible ──────────────────────────────────────────────────────
function Section({ label, open, onToggle, color, children }) {
  return (
    <div className="panel-section">
      <div className="panel-section-header" onClick={onToggle}>
        <span style={{ color }}>{label}</span>
        <span className={`chevron ${open ? 'open' : ''}`}>▼</span>
      </div>
      {open && <div className="panel-section-body">{children}</div>}
    </div>
  );
}

// ─── Entity row ───────────────────────────────────────────────────────────────
function EntityRow({ icon, label, status, selected, expanded, onRowClick, onDelete, children }) {
  return (
    <div>
      <div className={`entity-row ${selected ? 'selected' : ''}`} onClick={onRowClick}>
        <span className="entity-icon">{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="entity-name">{label}</div>
          <div className="entity-status">{status}</div>
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {onDelete && (
            <button className="btn icon danger" style={{ fontSize: 10, padding: '1px 5px' }}
              onClick={(e) => { e.stopPropagation(); onDelete(); }}>✕</button>
          )}
          <span style={{ fontSize: 10, color: 'var(--text-2)', transition: 'transform 0.15s',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
        </div>
      </div>
      {expanded && (
        <div style={{ background: 'var(--bg-0)', borderBottom: '1px solid var(--border)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Driver fields ────────────────────────────────────────────────────────────
function DriverFields({ driver, sim, canEdit }) {
  const update = (patch) => sim.updateDriver(driver.id, patch);
  return (
    <div className="field-group">
      <Field label="Nombre">
        <input value={driver.name} disabled={!canEdit}
          onChange={e => update({ name: e.target.value })} />
      </Field>
      <div className="field-row">
        <Field label="Velocidad (km/h)">
          <input type="number" min="5" max="120" value={driver.speed_kmh} disabled={!canEdit}
            onChange={e => update({ speed_kmh: +e.target.value })} />
        </Field>
        <Field label="Pedidos simultáneos (máx)">
          <input type="number" min="1" max="5" value={driver.max_orders} disabled={!canEdit}
            onChange={e => update({ max_orders: +e.target.value })} />
        </Field>
      </div>
      <div className="field-row">
      <Field label="Calificación (1-5)">
      <input type="number" min="1" max="5" step="0.1" value={driver.rating} disabled={!canEdit}
      onChange={e => update({ rating: +e.target.value })} />
      </Field>
      <Field label="Espera sin pedido (min)">
      <input type="number" min="0" max="30" step="0.5"
      value={+(driver.idle_wait_s / 60).toFixed(2)} disabled={!canEdit}
      onChange={e => update({ idle_wait_s: Math.round(+e.target.value * 60) })} />
      </Field>
      </div>
      {/* Métricas runtime */}
      {sim.simState !== 'stopped' && (
        <div style={{ background: 'var(--bg-2)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontSize: 11 }}>
          <MetricRow label="Estado"      value={driver.status} />
          <MetricRow label="Pedidos"     value={driver.orders.join(', ') || '—'} />
          <MetricRow label="ETA sum"     value={`${driver.eta_sum.toFixed(0)}s`} />
          <MetricRow label="Km totales"  value={`${driver.metrics.total_distance_km.toFixed(2)} km`} />
          <MetricRow label="Km muertos"  value={`${driver.metrics.dead_km.toFixed(2)} km`} />
          <MetricRow label="Idle"        value={`${driver.metrics.idle_time_s.toFixed(0)}s`} />
        </div>
      )}
    </div>
  );
}

// ─── Restaurant fields ────────────────────────────────────────────────────────
function RestaurantFields({ restaurant, sim, canEdit }) {
  const update = (patch) => sim.updateRestaurant(restaurant.id, patch);
  const customers = Object.values(sim.world.customers);
  const [newOrderCustomer, setNewOrderCustomer] = useState('');
  const [newOrderAmount,   setNewOrderAmount]   = useState(15000);
  const [newOrderTrigger,  setNewOrderTrigger]  = useState('manual');

  function addOrder() {
    if (!newOrderCustomer) return;
    sim.addOrderConfig(restaurant.id, {
      customer_id:  newOrderCustomer,
      amount_cents: newOrderAmount,
      trigger:      newOrderTrigger === 'manual' ? 'manual' : Number(newOrderTrigger),
    });
    setNewOrderCustomer('');
  }

  const myOrders = Object.values(sim.world.orders).filter(o => o.restaurant_id === restaurant.id);

  return (
    <div className="field-group">
      <Field label="Nombre">
        <input value={restaurant.name} disabled={!canEdit}
          onChange={e => update({ name: e.target.value })} />
      </Field>
      <Field label="Tiempo de preparación (min)">
      <input type="number" min="1" max="60" step="0.5"
      value={+(restaurant.prep_time_s / 60).toFixed(1)} disabled={!canEdit}
      onChange={e => update({ prep_time_s: Math.round(+e.target.value * 60) })} />
      </Field>

      {/* Métricas de restaurante (afectan penalización) */}
      <div style={{ fontSize: 11, color: 'var(--text-1)', fontWeight: 600, marginTop: 4 }}>Métricas (afectan scoring)</div>
      <div className="field-row">
        <Field label="Puntualidad (0-1)">
          <input type="number" min="0" max="1" step="0.05" value={restaurant.metrics.punctuality}
            disabled={!canEdit}
            onChange={e => update({ metrics: { ...restaurant.metrics, punctuality: +e.target.value } })} />
        </Field>
        <Field label="Penalización (0-1)">
          <input type="number" min="0" max="1" step="0.05" value={restaurant.penalty}
            disabled={!canEdit}
            onChange={e => update({ penalty: +e.target.value })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Rating drivers">
          <input type="number" min="1" max="5" step="0.1" value={restaurant.metrics.driver_rating}
            disabled={!canEdit}
            onChange={e => update({ metrics: { ...restaurant.metrics, driver_rating: +e.target.value } })} />
        </Field>
        <Field label="Rating usuarios">
          <input type="number" min="1" max="5" step="0.1" value={restaurant.metrics.user_rating}
            disabled={!canEdit}
            onChange={e => update({ metrics: { ...restaurant.metrics, user_rating: +e.target.value } })} />
        </Field>
      </div>

      {/* Pedidos configurados */}
      <div style={{ fontSize: 11, color: 'var(--text-1)', fontWeight: 600, marginTop: 4 }}>Pedidos</div>
      {myOrders.map(order => (
        <OrderConfigRow key={order.id} order={order} sim={sim} canEdit={canEdit} />
      ))}

      {/* Agregar pedido */}
      <div style={{ background: 'var(--bg-2)', borderRadius: 'var(--radius-sm)', padding: '6px 8px' }}>
        <div style={{ fontSize: 10, color: 'var(--text-2)', marginBottom: 4 }}>Nuevo pedido</div>
        <div className="field-row">
          <Field label="Cliente">
            <select value={newOrderCustomer} onChange={e => setNewOrderCustomer(e.target.value)}>
              <option value="">— elegir —</option>
              {customers.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Monto (centavos)">
            <input type="number" min="0" value={newOrderAmount}
              onChange={e => setNewOrderAmount(+e.target.value)} />
          </Field>
        </div>
        <div className="field-row" style={{ marginBottom: 4 }}>
          <Field label="Disparo">
            <select value={newOrderTrigger} onChange={e => setNewOrderTrigger(e.target.value)}>
              <option value="manual">Manual</option>
              <option value="30">t=30s</option>
              <option value="60">t=1min</option>
              <option value="120">t=2min</option>
              <option value="300">t=5min</option>
            </select>
          </Field>
        </div>
        <button className="btn green" style={{ width: '100%', justifyContent: 'center' }}
          onClick={addOrder} disabled={!newOrderCustomer}>
          + Agregar pedido
        </button>
      </div>
    </div>
  );
}

// ─── Customer fields ──────────────────────────────────────────────────────────
function CustomerFields({ customer, sim, canEdit }) {
  const update = (patch) => sim.updateCustomer(customer.id, patch);
  return (
    <div className="field-group">
      <Field label="Nombre">
        <input value={customer.name} disabled={!canEdit}
          onChange={e => update({ name: e.target.value })} />
      </Field>
      <Field label="Distancia máx. comercio→cliente (km)">
        <input type="number" min="0.5" max="50" step="0.5" value={customer.max_distance_km}
          disabled={!canEdit}
          onChange={e => update({ max_distance_km: +e.target.value })} />
      </Field>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function Field({ label, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

function MetricRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
      <span style={{ color: 'var(--text-2)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-0)' }}>{value}</span>
    </div>
  );
}

function EmptyHint({ children }) {
  return (
    <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--text-2)', fontStyle: 'italic' }}>
      {children}
    </div>
  );
}
