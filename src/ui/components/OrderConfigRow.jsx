// src/ui/components/OrderConfigRow.jsx
// Fila de un pedido dentro del panel de restaurante

export default function OrderConfigRow({ order, sim, canEdit }) {
  const customer = sim.world.customers[order.customer_id];
  const statusColor = {
    queued:      'var(--text-2)',
    assigned:    'var(--accent)',
    on_the_way:  'var(--amber)',
    delivered:   'var(--green)',
    preparing:   'var(--amber)',
  }[order.status] ?? 'var(--text-2)';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 8px',
      background: 'var(--bg-2)',
      borderRadius: 'var(--radius-sm)',
      marginBottom: 2,
      fontSize: 11,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ color: 'var(--text-1)' }}>{order.id} </span>
        <span>→ {customer?.name ?? '?'}</span>
        {order.trigger !== 'manual' && (
          <span style={{ color: 'var(--text-2)', marginLeft: 4 }}>t={order.trigger}s</span>
        )}
      </div>
      <span style={{ color: statusColor, fontWeight: 600 }}>{order.status}</span>
      {order.status === 'queued' && !order.triggered && (
        <button className="btn icon" style={{ fontSize: 10, padding: '1px 5px' }}
          onClick={() => sim.triggerOrder(order.id)}>
          ▶
        </button>
      )}
      {canEdit && order.status === 'queued' && (
        <button className="btn icon danger" style={{ fontSize: 10, padding: '1px 5px' }}
          onClick={() => sim.removeOrder(order.id)}>
          ✕
        </button>
      )}
    </div>
  );
}
