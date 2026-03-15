// src/ui/components/ScenariosPanel.jsx
import { useState } from 'react';

export default function ScenariosPanel({ sim }) {
  const { scenarios, saveScenario, loadScenario, deleteScenario, exportScenario, importScenario } = sim;
  const [saveName, setSaveName] = useState('');
  const [msg,      setMsg]      = useState(null);
  const scenarioList = Object.entries(scenarios).sort(([, a], [, b]) => b._saved_at - a._saved_at);

  function flash(text, isErr = false) {
    setMsg({ text, err: isErr });
    setTimeout(() => setMsg(null), 2500);
  }

  function handleSave() {
    const name = saveName.trim();
    if (!name) return;
    saveScenario(name);
    setSaveName('');
    flash(`Guardado: "${name}"`);
  }

  async function handleImport() {
    try {
      await importScenario();
      flash('Escenario importado');
    } catch (e) {
      flash(e.message, true);
    }
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>

      {/* Save current */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-0)', marginBottom: 6 }}>
          Guardar escenario actual
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            placeholder="Nombre del escenario"
            value={saveName}
            onChange={e => setSaveName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            style={{ flex: 1 }}
          />
          <button className="btn primary" onClick={handleSave} disabled={!saveName.trim()}>
            Guardar
          </button>
        </div>
        {msg && (
          <div style={{ marginTop: 6, fontSize: 11, color: msg.err ? 'var(--red)' : 'var(--green)' }}>
            {msg.text}
          </div>
        )}
      </div>

      {/* Import */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <button className="btn" style={{ width: '100%', justifyContent: 'center', fontSize: 11 }}
          onClick={handleImport}>
          📂 Importar desde archivo .json
        </button>
      </div>

      {/* Scenario list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {scenarioList.length === 0 ? (
          <div style={{ padding: '16px 12px', fontSize: 11, color: 'var(--text-2)', textAlign: 'center' }}>
            No hay escenarios guardados
          </div>
        ) : (
          scenarioList.map(([name, data]) => (
            <ScenarioRow
              key={name}
              name={name}
              data={data}
              onLoad={() => { loadScenario(name); flash(`Cargado: "${name}"`); }}
              onExport={() => exportScenario(name)}
              onDelete={() => deleteScenario(name)}
            />
          ))
        )}
      </div>

      {/* Auto-save note */}
      <div style={{ padding: '6px 12px', borderTop: '1px solid var(--border)', flexShrink: 0,
        fontSize: 10, color: 'var(--text-2)' }}>
        ✓ El último escenario se guarda automáticamente al modificar entidades.
      </div>
    </div>
  );
}

function ScenarioRow({ name, data, onLoad, onExport, onDelete }) {
  const [confirm, setConfirm] = useState(false);
  const date = data._saved_at ? new Date(data._saved_at).toLocaleString('es-MX', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  }) : '';

  const driversCount     = Object.keys(data.drivers     ?? {}).length;
  const restaurantsCount = Object.keys(data.restaurants ?? {}).length;
  const customersCount   = Object.keys(data.customers   ?? {}).length;

  return (
    <div style={{
      padding: '8px 12px',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, fontWeight: 500, fontSize: 12, color: 'var(--text-0)' }}>{name}</span>
        <button className="btn icon" onClick={onLoad} data-tip="Cargar">⤵</button>
        <button className="btn icon" onClick={onExport} data-tip="Exportar .json">⤴</button>
        {confirm ? (
          <>
            <button className="btn danger" style={{ fontSize: 10, padding: '1px 6px' }} onClick={onDelete}>Confirmar</button>
            <button className="btn" style={{ fontSize: 10, padding: '1px 6px' }} onClick={() => setConfirm(false)}>No</button>
          </>
        ) : (
          <button className="btn icon" onClick={() => setConfirm(true)} data-tip="Eliminar">✕</button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span className="tag">🛵 {driversCount}</span>
        <span className="tag">🏪 {restaurantsCount}</span>
        <span className="tag">📍 {customersCount}</span>
        {date && <span style={{ fontSize: 10, color: 'var(--text-2)', marginLeft: 'auto' }}>{date}</span>}
      </div>
    </div>
  );
}
