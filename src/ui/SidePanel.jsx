// src/ui/SidePanel.jsx
import { useState }     from 'react';
import EntityInspector  from './components/EntityInspector.jsx';
import AlgorithmPanel   from './components/AlgorithmPanel.jsx';
import ScenariosPanel   from './components/ScenariosPanel.jsx';

const TABS = [
  { id: 'entities',  label: 'Entidades' },
{ id: 'algorithm', label: 'Algoritmo' },
{ id: 'scenarios', label: 'Escenarios' },
];

function cleanStaleEntities(sim) {
  // Bloquear si el rebalancer está en vuelo para evitar mutaciones concurrentes
  if (sim?.engine?._rebalancingInFlight) return { skipped: true, removed: 0 };

  const world = sim?.world;
  if (!world?.orders) return { skipped: false, removed: 0 };

  const { orders, drivers = {}, restaurants = {}, customers = {} } = world;
  let removed = 0;

  for (const [id, order] of Object.entries(orders)) {
    const isTerminal = ['delivered', 'cancelled'].includes(order.status);
    const driverMissing  = order.driver_id && !drivers[order.driver_id];
    const restaurantMissing = !restaurants[order.restaurant_id];
    const customerMissing   = !customers[order.customer_id];

    if (driverMissing) {
      order.driver_id = null;
      order.status = 'queued';
      order.assigned_at = null;
      order.last_transferred_at = null;
      delete order.next_retry_at;
      order.triggered = true;
    }

    if (isTerminal || customerMissing) {
      delete orders[id];
      removed++;
    }
  }

  // Reparar driver.orders para que no apunten a órdenes eliminadas
  for (const driver of Object.values(drivers)) {
    driver.orders = (driver.orders ?? []).filter(id => !!orders[id]);
  }

  // Notificar al engine para que resincronice su estado interno
  sim?.engine?._syncDriverOrdersFromOrderLinks?.();

  return { skipped: false, removed };
}

export default function SidePanel({ sim, activeTab, onTabChange, selected, onSelect, addMode, onAddMode }) {
  const [cleanState, setCleanState] = useState(null); // null | 'confirm' | { removed, skipped }

  function handleCleanClick() {
    setCleanState('confirm');
  }

  function handleConfirm() {
    const result = cleanStaleEntities(sim);
    setCleanState(result);
    // Limpiar el feedback después de 3 segundos
    setTimeout(() => setCleanState(null), 3000);
  }

  function handleCancel() {
    setCleanState(null);
  }

  const feedbackMsg = cleanState && cleanState !== 'confirm'
  ? cleanState.skipped
  ? '⚠ Rebalanceo en curso, intenta de nuevo'
  : cleanState.removed === 0
  ? 'Todo limpio'
  : `${cleanState.removed} entidad${cleanState.removed !== 1 ? 'es' : ''} eliminada${cleanState.removed !== 1 ? 's' : ''}`
  : null;

  return (
    <div className="panel" style={{ width: 'var(--panel-w)', flexShrink: 0 }}>
    {/* Tabs */}
    <div style={{
      display: 'flex',
      borderBottom: '1px solid var(--border)',
          background: 'var(--bg-0)',
          flexShrink: 0,
    }}>
    {TABS.map(tab => (
      <button
      key={tab.id}
      onClick={() => onTabChange(tab.id)}
      style={{
        flex: 1,
        padding: '8px 4px',
        fontSize: 11,
        fontWeight: 600,
        background: 'none',
        color: activeTab === tab.id ? 'var(--accent)' : 'var(--text-1)',
                      borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
                      transition: 'color 0.1s',
      }}
      >
      {tab.label}
      </button>
    ))}
    </div>

    {/* Tab content */}
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
    {activeTab === 'entities'  && (
      <EntityInspector sim={sim} selected={selected} onSelect={onSelect} />
    )}
    {activeTab === 'algorithm' && (
      <AlgorithmPanel sim={sim} />
    )}
    {activeTab === 'scenarios' && (
      <ScenariosPanel sim={sim} />
    )}
    </div>

    {/* Footer: botón de limpieza */}
    <div style={{
      borderTop: '1px solid var(--border)',
          padding: '8px 10px',
          background: 'var(--bg-0)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 40,
    }}>
    {cleanState === 'confirm' ? (
      <>
      <span style={{ fontSize: 11, color: 'var(--text-1)', flex: 1 }}>
      ¿Eliminar entidades inválidas?
      </span>
      <button
      onClick={handleConfirm}
      style={{
        fontSize: 11, padding: '3px 10px',
        background: 'var(--accent)', color: '#fff',
                                 borderRadius: 4, fontWeight: 600,
      }}
      >
      Confirmar
      </button>
      <button
      onClick={handleCancel}
      style={{
        fontSize: 11, padding: '3px 10px',
        background: 'none', color: 'var(--text-1)',
                                 borderRadius: 4, border: '1px solid var(--border)',
      }}
      >
      Cancelar
      </button>
      </>
    ) : feedbackMsg ? (
      <span style={{
        fontSize: 11,
        color: cleanState?.skipped ? 'var(--text-warn, #b45309)' : 'var(--text-1)',
                       flex: 1,
      }}>
      {feedbackMsg}
      </span>
    ) : (
      <button
      onClick={handleCleanClick}
      style={{
        fontSize: 11, padding: '3px 10px',
        background: 'none', color: 'var(--text-2)',
         borderRadius: 4, border: '1px solid var(--border)',
         cursor: 'pointer', marginLeft: 'auto',
      }}
      >
      Limpiar entidades
      </button>
    )}
    </div>
    </div>
  );
}
