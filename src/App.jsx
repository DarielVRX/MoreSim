// src/App.jsx
import { useState } from 'react';
import SimMap       from './ui/SimMap.jsx';
import SidePanel    from './ui/SidePanel.jsx';
import TopBar       from './ui/TopBar.jsx';
import LogPanel     from './ui/LogPanel.jsx';
import MetricsBar   from './ui/MetricsBar.jsx';
import { useSimulation } from './hooks/useSimulation.js';
import './styles.css';

export default function App() {
  const sim = useSimulation();
  const [logOpen,    setLogOpen]    = useState(true);
  const [panelOpen,  setPanelOpen]  = useState(true);
  const [activeTab,  setActiveTab]  = useState('entities'); // 'entities' | 'algorithm' | 'scenarios'
  const [addMode,    setAddMode]    = useState(null);       // null | 'driver' | 'restaurant' | 'customer'
  const [selected,   setSelected]   = useState(null);       // { type, id }

  return (
    <div className="app-root">
      <TopBar
        sim={sim}
        addMode={addMode}
        onAddMode={setAddMode}
        onToggleLog={() => setLogOpen(v => !v)}
        onTogglePanel={() => setPanelOpen(v => !v)}
        logOpen={logOpen}
        panelOpen={panelOpen}
      />

      <div className="app-body">
        {/* Panel lateral izquierdo */}
        {panelOpen && (
          <SidePanel
            sim={sim}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            selected={selected}
            onSelect={setSelected}
            addMode={addMode}
            onAddMode={setAddMode}
          />
        )}

        {/* Mapa central */}
        <div className="map-area">
          <SimMap
            sim={sim}
            addMode={addMode}
            onAddMode={setAddMode}
            selected={selected}
            onSelect={setSelected}
          />
          <MetricsBar metrics={sim.metrics} simTime={sim.simTime} />
        </div>

        {/* Panel de log inferior derecho */}
        {logOpen && (
          <LogPanel
            log={sim.log}
            recorder={sim.recorder}
            simState={sim.simState}
            onSeek={sim.seekReplay}
          />
        )}
      </div>
    </div>
  );
}
