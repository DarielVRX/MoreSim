// src/ui/TopBar.jsx
import { useState } from 'react';

const ENTITY_MODES = [
  { mode: 'driver',     icon: '🛵', label: 'Driver',    color: 'var(--driver-color)' },
  { mode: 'restaurant', icon: '🏪', label: 'Comercio',  color: 'var(--restaurant-color)' },
  { mode: 'customer',   icon: '📍', label: 'Cliente',   color: 'var(--customer-color)' },
];

export default function TopBar({ sim, addMode, onAddMode, onToggleLog, onTogglePanel, logOpen, panelOpen }) {
  const { simState, simTime, multiplier, graphStatus, setMultiplier, start, pause, reset } = sim;
  const [showMultiplier, setShowMultiplier] = useState(false);

  const isRunning = simState === 'running';
  const isStopped = simState === 'stopped';

  function formatTime(s) {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  return (
    <div style={{
      height: 'var(--topbar-h)',
      background: 'var(--bg-1)',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '0 12px',
      flexShrink: 0,
      zIndex: 100,
    }}>
      {/* Logo */}
      <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--accent)', letterSpacing: '-0.5px', marginRight: 8 }}>
        More<span style={{ color: 'var(--text-1)' }}>Sim</span>
      </span>

      {/* Panel toggle */}
      <button className="btn icon" onClick={onTogglePanel} data-tip="Panel lateral"
        style={{ borderColor: panelOpen ? 'var(--accent)' : undefined }}>
        ☰
      </button>

      <div style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />

      {/* Simulation controls */}
      <button className={`btn ${isRunning ? '' : 'primary'}`} onClick={isRunning ? pause : start}
        disabled={graphStatus.pct < 100 && graphStatus.stage !== 'Listo' && graphStatus.pct > 0}>
        {isRunning ? '⏸ Pausar' : isStopped ? '▶ Iniciar' : '▶ Continuar'}
      </button>

      <button className="btn danger" onClick={reset} disabled={isStopped}>
        ↺ Reset
      </button>

      {/* Sim time */}
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 16,
        fontWeight: 700,
        color: isRunning ? 'var(--green)' : 'var(--text-1)',
        minWidth: 52,
        textAlign: 'center',
      }}>
        {formatTime(simTime)}
      </div>

      {/* Speed multiplier */}
      <div style={{ position: 'relative' }}>
        <button className="btn" onClick={() => setShowMultiplier(v => !v)}
          style={{ fontFamily: 'var(--font-mono)', minWidth: 44 }}>
          {multiplier}x
        </button>
        {showMultiplier && (
          <div style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            background: 'var(--bg-2)',
            border: '1px solid var(--border-l)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 12px',
            zIndex: 200,
            width: 180,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <button className="btn icon" onClick={() => setMultiplier(multiplier - 1)}>−</button>
              <span style={{ flex: 1, textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                {multiplier}x
              </span>
              <button className="btn icon" onClick={() => setMultiplier(multiplier + 1)}>+</button>
            </div>
            <input type="range" min="1" max="60" value={multiplier}
              onChange={e => setMultiplier(Number(e.target.value))} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>
              <span>1x</span><span>Tiempo real</span><span>60x</span>
            </div>
          </div>
        )}
      </div>

      <div style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />

      {/* Add entity modes */}
      <span style={{ fontSize: 11, color: 'var(--text-2)', marginRight: 2 }}>Agregar:</span>
      {ENTITY_MODES.map(({ mode, icon, label, color }) => (
        <button
          key={mode}
          className={`btn ${addMode === mode ? 'active' : ''}`}
          onClick={() => onAddMode(addMode === mode ? null : mode)}
          data-tip={`Click en mapa para agregar ${label}`}
          style={addMode === mode ? { borderColor: color, background: `${color}22` } : {}}
        >
          {icon} {label}
        </button>
      ))}

      <div style={{ flex: 1 }} />

      {/* Graph status */}
      {graphStatus.pct > 0 && graphStatus.pct < 100 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-1)' }}>
          <div className="pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--amber)' }} />
          {graphStatus.stage} {graphStatus.pct}%
        </div>
      )}
      {graphStatus.stage === 'Listo' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--green)' }}>
          ✓ Grafo listo
        </div>
      )}

      {/* Log toggle */}
      <button className="btn icon" onClick={onToggleLog} data-tip="Panel de log"
        style={{ borderColor: logOpen ? 'var(--accent)' : undefined }}>
        📋
      </button>
    </div>
  );
}
