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

export default function SidePanel({ sim, activeTab, onTabChange, selected, onSelect, addMode, onAddMode }) {
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
    </div>
  );
}
