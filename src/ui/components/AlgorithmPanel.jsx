// src/ui/components/AlgorithmPanel.jsx
//
// Panel para modificar las variables de scoring en tiempo real.
// Cada variable tiene:
//   - Toggle de habilitación
//   - Slider de peso (0-100)
//   - Selector de efecto (maximize / minimize / gate)
//   - Campo de formula_override (pegar código JS generado externamente)
//
// Las variables default siempre aparecen primero.
// Las custom (agregadas por el usuario) aparecen después.

import { useState } from 'react';

const EFFECT_OPTIONS = ['maximize', 'minimize', 'gate'];
const EFFECT_LABELS  = { maximize: '↑ Maximizar', minimize: '↓ Minimizar', gate: '🔒 Gate' };
const EFFECT_COLORS  = { maximize: 'var(--green)', minimize: 'var(--red)', gate: 'var(--purple)' };

export default function AlgorithmPanel({ sim }) {
  const { variables, updateVariable, addVariable, removeVariable } = sim;
  const [expandedVar, setExpandedVar] = useState(null);
  const [showAddForm,  setShowAddForm] = useState(false);

  function toggleVar(id) {
    setExpandedVar(prev => prev === id ? null : id);
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>

      {/* Header */}
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        fontSize: 11,
        color: 'var(--text-1)',
        background: 'var(--bg-0)',
        flexShrink: 0,
      }}>
        <div style={{ fontWeight: 600, color: 'var(--text-0)', marginBottom: 2 }}>
          Variables de asignación
        </div>
        <div>
          Modifica pesos y fórmulas. Los cambios aplican en el próximo tick.
        </div>
      </div>

      {/* Variable list */}
      {variables.map(v => (
        <VariableRow
          key={v.id}
          variable={v}
          expanded={expandedVar === v.id}
          onToggle={() => toggleVar(v.id)}
          onUpdate={(patch) => updateVariable(v.id, patch)}
          onRemove={v._isCustom ? () => removeVariable(v.id) : null}
        />
      ))}

      {/* Add variable */}
      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        {!showAddForm ? (
          <button className="btn" style={{ width: '100%', justifyContent: 'center', fontSize: 11 }}
            onClick={() => setShowAddForm(true)}>
            + Nueva variable
          </button>
        ) : (
          <AddVariableForm
            onAdd={(varDef) => { addVariable(varDef); setShowAddForm(false); }}
            onCancel={() => setShowAddForm(false)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Variable row ─────────────────────────────────────────────────────────────
function VariableRow({ variable: v, expanded, onToggle, onUpdate, onRemove }) {
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      {/* Compact header */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 12px',
          cursor: 'pointer',
          background: expanded ? 'var(--bg-2)' : 'transparent',
          transition: 'background 0.1s',
          userSelect: 'none',
        }}
      >
        {/* Enable toggle */}
        <button
          className="btn icon"
          style={{
            padding: '1px 5px',
            fontSize: 10,
            background: v.enabled ? 'var(--green-d)' : 'var(--bg-3)',
            color: v.enabled ? '#fff' : 'var(--text-2)',
            borderColor: v.enabled ? 'var(--green)' : 'var(--border)',
            flexShrink: 0,
          }}
          onClick={(e) => { e.stopPropagation(); onUpdate({ enabled: !v.enabled }); }}
          data-tip={v.enabled ? 'Desactivar' : 'Activar'}
        >
          {v.enabled ? '✓' : '✗'}
        </button>

        {/* Name + effect */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{
            fontSize: 12,
            fontWeight: 500,
            color: v.enabled ? 'var(--text-0)' : 'var(--text-2)',
            opacity: v.enabled ? 1 : 0.6,
          }}>
            {v.name}
          </span>
          {v.formula_override && (
            <span style={{ marginLeft: 4, fontSize: 9, color: 'var(--accent)' }}>fx</span>
          )}
        </div>

        {/* Effect badge */}
        <span style={{ fontSize: 9, color: EFFECT_COLORS[v.effect], fontWeight: 700, flexShrink: 0 }}>
          {v.effect.toUpperCase()}
        </span>

        {/* Weight */}
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-1)', minWidth: 26, textAlign: 'right', flexShrink: 0 }}>
          {v.weight}
        </span>

        {/* Chevron */}
        <span style={{ fontSize: 9, color: 'var(--text-2)', transition: 'transform 0.15s',
          transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', flexShrink: 0 }}>▼</span>
      </div>

      {/* Weight bar (visual, always visible) */}
      {v.effect !== 'gate' && (
        <div style={{ height: 2, background: 'var(--bg-3)', marginBottom: 0 }}>
          <div style={{
            height: '100%',
            width: `${v.weight}%`,
            background: v.enabled ? EFFECT_COLORS[v.effect] : 'var(--bg-3)',
            transition: 'width 0.2s',
            opacity: v.enabled ? 0.7 : 0.2,
          }} />
        </div>
      )}

      {/* Expanded fields */}
      {expanded && (
        <div style={{ background: 'var(--bg-0)', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>

          {/* Description */}
          {v.description && (
            <div style={{ fontSize: 11, color: 'var(--text-2)', fontStyle: 'italic', lineHeight: 1.4 }}>
              {v.description}
            </div>
          )}

          {/* Effect selector */}
          <div className="field">
            <label>Efecto</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {EFFECT_OPTIONS.map(eff => (
                <button
                  key={eff}
                  className="btn"
                  style={{
                    flex: 1,
                    justifyContent: 'center',
                    fontSize: 10,
                    padding: '3px 6px',
                    background: v.effect === eff ? EFFECT_COLORS[eff] + '33' : undefined,
                    borderColor: v.effect === eff ? EFFECT_COLORS[eff] : undefined,
                    color: v.effect === eff ? EFFECT_COLORS[eff] : undefined,
                  }}
                  onClick={() => onUpdate({ effect: eff })}
                >
                  {EFFECT_LABELS[eff]}
                </button>
              ))}
            </div>
          </div>

          {/* Weight slider */}
          {v.effect !== 'gate' && (
            <div className="field">
              <label>Peso: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-0)' }}>{v.weight}</span></label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button className="btn icon" style={{ fontSize: 10 }}
                  onClick={() => onUpdate({ weight: Math.max(0, v.weight - 5) })}>−</button>
                <input type="range" min="0" max="100" value={v.weight}
                  onChange={e => onUpdate({ weight: +e.target.value })}
                  style={{ flex: 1 }} />
                <button className="btn icon" style={{ fontSize: 10 }}
                  onClick={() => onUpdate({ weight: Math.min(100, v.weight + 5) })}>+</button>
              </div>
            </div>
          )}

          {/* Formula override */}
          <div className="field">
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Fórmula override <span style={{ color: 'var(--text-2)' }}>(JS — pegar desde copilot)</span></span>
              {v.formula_override && (
                <button
                  style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 10, cursor: 'pointer', padding: 0 }}
                  onClick={() => onUpdate({ formula_override: null })}
                >
                  ✕ Limpiar
                </button>
              )}
            </label>
            <textarea
              rows={4}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11, resize: 'vertical' }}
              placeholder={`// Parámetros: driver, order, restaurant, customer, world\n// Debe retornar número 0-1 (o bool para gate)\n// Ejemplo:\n(1 - driver.eta_sum / 3600) * 0.8`}
              value={v.formula_override ?? ''}
              onChange={e => onUpdate({ formula_override: e.target.value || null })}
            />
            {v.formula_override && (
              <div style={{ fontSize: 10, color: 'var(--amber)', marginTop: 2 }}>
                ⚠ La fórmula default está sobreescrita. El compute() original no se ejecuta.
              </div>
            )}
          </div>

          {/* Delete custom variable */}
          {onRemove && (
            <button className="btn danger" style={{ justifyContent: 'center', fontSize: 11 }}
              onClick={onRemove}>
              ✕ Eliminar variable
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Add variable form ────────────────────────────────────────────────────────
function AddVariableForm({ onAdd, onCancel }) {
  const [id,      setId]      = useState('');
  const [name,    setName]    = useState('');
  const [effect,  setEffect]  = useState('maximize');
  const [weight,  setWeight]  = useState(20);
  const [desc,    setDesc]    = useState('');
  const [formula, setFormula] = useState('');

  function submit() {
    if (!id || !name) return;
    const idClean = id.trim().replace(/\s+/g, '_').toLowerCase();
    onAdd({
      id:               idClean,
      name:             name.trim(),
      enabled:          true,
      weight,
      effect,
      description:      desc,
      formula_override: formula || null,
      _isCustom:        true,
      compute: () => 0, // Placeholder — siempre se usará formula_override
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-0)', marginBottom: 2 }}>
        Nueva variable
      </div>
      <div className="field-row">
        <div className="field">
          <label>ID único</label>
          <input placeholder="mi_variable" value={id} onChange={e => setId(e.target.value)} />
        </div>
        <div className="field">
          <label>Nombre</label>
          <input placeholder="Mi variable" value={name} onChange={e => setName(e.target.value)} />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label>Efecto</label>
          <select value={effect} onChange={e => setEffect(e.target.value)}>
            {EFFECT_OPTIONS.map(e => <option key={e} value={e}>{EFFECT_LABELS[e]}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Peso (0-100)</label>
          <input type="number" min="0" max="100" value={weight} onChange={e => setWeight(+e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>Descripción</label>
        <input placeholder="Para qué sirve esta variable" value={desc} onChange={e => setDesc(e.target.value)} />
      </div>
      <div className="field">
        <label>Fórmula JS (obligatoria para variables custom)</label>
        <textarea rows={4}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
          placeholder="(driver, order, restaurant, customer, world) => ..."
          value={formula} onChange={e => setFormula(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn green" style={{ flex: 1, justifyContent: 'center' }}
          onClick={submit} disabled={!id || !name || !formula}>
          ✓ Agregar
        </button>
        <button className="btn" onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}
