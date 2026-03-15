// src/ui/LogPanel.jsx
import { useRef, useEffect, useState } from 'react';

const EVENT_ICONS = {
  assigned:           '📦',
  kitchen_ready:      '🍳',
  pickup:             '🛵',
  delivered:          '✅',
  arrived_restaurant: '🏪',
  no_driver:          '⚠️',
};

const EVENT_COLORS = {
  assigned:           'var(--accent)',
  kitchen_ready:      'var(--amber)',
  pickup:             'var(--driver-color)',
  delivered:          'var(--green)',
  arrived_restaurant: 'var(--restaurant-color)',
  no_driver:          'var(--red)',
};

function formatTime(s) {
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

export default function LogPanel({ log, recorder, simState, onSeek }) {
  const bottomRef     = useRef(null);
  const [autoScroll,  setAutoScroll] = useState(true);
  const [showReplay,  setShowReplay] = useState(false);
  const [replayT,     setReplayT]   = useState(0);
  const snapshots     = recorder?.snapshots ?? [];
  const maxTime       = snapshots.length > 0 ? snapshots[snapshots.length - 1].simTime : 0;

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log.length, autoScroll]);

  return (
    <div style={{
      width: 'var(--log-w)',
      background: 'var(--bg-1)',
      borderLeft: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      flexShrink: 0,
    }}>
      {/* Header */}
      <div style={{
        padding: '7px 10px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>
          Log de eventos
          {log.length > 0 && (
            <span style={{ marginLeft: 4, color: 'var(--text-2)', fontWeight: 400 }}>
              ({log.length})
            </span>
          )}
        </span>
        <button
          className={`btn icon ${autoScroll ? 'active' : ''}`}
          style={{ fontSize: 10, padding: '1px 5px' }}
          onClick={() => setAutoScroll(v => !v)}
          data-tip={autoScroll ? 'Desactivar auto-scroll' : 'Activar auto-scroll'}
        >
          ↓
        </button>
        {snapshots.length > 0 && (
          <button
            className={`btn icon ${showReplay ? 'active' : ''}`}
            style={{ fontSize: 10, padding: '1px 5px' }}
            onClick={() => setShowReplay(v => !v)}
            data-tip="Replay"
          >
            ⏮
          </button>
        )}
      </div>

      {/* Replay scrubber */}
      {showReplay && snapshots.length > 0 && (
        <div style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-0)',
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-1)', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
            <span>Replay</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{formatTime(replayT)}</span>
          </div>
          <input type="range" min="0" max={maxTime} value={replayT}
            onChange={e => { setReplayT(+e.target.value); onSeek(+e.target.value); }}
            style={{ width: '100%' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>
            <span>0:00</span>
            <span>{formatTime(maxTime)}</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-2)', marginTop: 4 }}>
            {snapshots.length} snapshots · cada 15s
          </div>
        </div>
      )}

      {/* Events */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {log.length === 0 ? (
          <div style={{ padding: '16px 10px', fontSize: 11, color: 'var(--text-2)', textAlign: 'center' }}>
            Los eventos aparecerán aquí durante la simulación
          </div>
        ) : (
          // Reversed — newest first
          [...log].map((event, i) => (
            <EventRow key={i} event={event} />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Filter note */}
      {log.length > 0 && (
        <div style={{
          padding: '4px 10px',
          borderTop: '1px solid var(--border)',
          fontSize: 10,
          color: 'var(--text-2)',
          flexShrink: 0,
        }}>
          Últimos 500 eventos
        </div>
      )}
    </div>
  );
}

function EventRow({ event }) {
  const [expanded, setExpanded] = useState(false);
  const hasBreakdown = event.results && Array.isArray(event.results) && event.results.length > 0;

  return (
    <div
      style={{
        padding: '4px 10px',
        borderBottom: '1px solid var(--border)',
        cursor: hasBreakdown ? 'pointer' : 'default',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-2)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      onClick={() => hasBreakdown && setExpanded(v => !v)}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        {/* Time */}
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--text-2)',
          flexShrink: 0,
          marginTop: 1,
        }}>
          {formatTime(event.time ?? 0)}
        </span>
        {/* Icon */}
        <span style={{ fontSize: 13, flexShrink: 0 }}>
          {EVENT_ICONS[event.type] ?? '·'}
        </span>
        {/* Message */}
        <span style={{
          fontSize: 11,
          color: EVENT_COLORS[event.type] ?? 'var(--text-0)',
          lineHeight: 1.4,
          flex: 1,
        }}>
          {event.message}
        </span>
        {hasBreakdown && (
          <span style={{ fontSize: 9, color: 'var(--text-2)', flexShrink: 0, marginTop: 2 }}>
            {expanded ? '▲' : '▼'}
          </span>
        )}
      </div>

      {/* Score breakdown */}
      {expanded && hasBreakdown && (
        <div style={{ marginTop: 4, marginLeft: 28, background: 'var(--bg-0)', borderRadius: 4, padding: '6px 8px' }}>
          {event.results
            .filter(r => !r.disqualified)
            .sort((a, b) => b.score - a.score)
            .map((r, i) => (
              <div key={r.driver.id} style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontSize: 11, fontWeight: 500, color: i === 0 ? 'var(--green)' : 'var(--text-1)' }}>
                    {i === 0 && '★ '}{r.driver.name}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: i === 0 ? 'var(--green)' : 'var(--text-1)' }}>
                    {r.score}
                  </span>
                </div>
                {r.breakdown.filter(b => b.contribution > 0 || b.value === 'PASS').map(b => (
                  <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-2)', paddingLeft: 8 }}>
                    <span>{b.name}</span>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>
                      {b.value === 'PASS' ? '✓' : `+${b.contribution}`}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          {event.results.filter(r => r.disqualified).map(r => (
            <div key={r.driver.id} style={{ fontSize: 10, color: 'var(--red)', paddingLeft: 8 }}>
              ✗ {r.driver.name}: {r.reason}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
