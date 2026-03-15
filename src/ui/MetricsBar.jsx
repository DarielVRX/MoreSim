// src/ui/MetricsBar.jsx

function fmtTime(s) {
  if (!s) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

export default function MetricsBar({ metrics, simTime }) {
  if (!metrics) return null;

  const items = [
    { label: 'Entregados',         value: metrics.delivered_count,                         color: 'var(--green)'  },
    { label: 'En curso',           value: metrics.active_count,                             color: 'var(--accent)' },
    { label: 'Pendientes',         value: metrics.pending_count,                            color: 'var(--amber)'  },
    { label: 'Espera prom.',       value: fmtTime(metrics.avg_wait_s),                      color: 'var(--text-0)' },
    { label: 'Km muertos total',   value: `${metrics.total_dead_km} km`,                    color: 'var(--red)'    },
    { label: 'Km recorridos',      value: `${metrics.total_distance_km} km`,                color: 'var(--text-0)' },
    { label: 'Tiempo idle total',  value: fmtTime(metrics.total_idle_s),                    color: 'var(--amber)'  },
  ];

  return (
    <div style={{
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: 32,
      background: 'rgba(13,17,23,0.92)',
      backdropFilter: 'blur(4px)',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      gap: 0,
      zIndex: 50,
      overflow: 'hidden',
    }}>
      {items.map((item, i) => (
        <div key={i} style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '0 14px',
          borderRight: '1px solid var(--border)',
          height: '100%',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 10, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{item.label}</span>
          <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 600, color: item.color }}>
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}
