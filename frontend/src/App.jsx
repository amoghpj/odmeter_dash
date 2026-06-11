import React, { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard.jsx';
import LiveView from './components/LiveView.jsx';
import Diagnostics from './components/Diagnostics.jsx';
import { getExperiments } from './api/go.js';

/**
 * App — top-level shell with sidebar navigation.
 *
 * Navigation state:
 *   page: 'dashboard' | 'live' | 'diagnostics'
 *   liveExp: string | null  (experiment name when on live page)
 */
export default function App() {
  const [page, setPage] = useState('dashboard');
  const [liveExp, setLiveExp] = useState(null);
  const [runningExp, setRunningExp] = useState(null);

  // Poll acquisition endpoint every 5s for running experiment
  useEffect(() => {
    const poll = () => {
      getExperiments()
        .then((exps) => {
          if (!Array.isArray(exps)) {
            setRunningExp(null);
            return;
          }
          const running = exps.find((e) => e.is_running) ?? null;
          setRunningExp(running);
        })
        .catch(() => {
          // Server may not be up yet; ignore
        });
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  const navigate = (newPage, expName) => {
    setPage(newPage);
    if (newPage === 'live' && expName) setLiveExp(expName);
  };

  const handleViewLive = (expName) => {
    setLiveExp(expName);
    setPage('live');
  };

  const handleBack = () => {
    setPage('dashboard');
    setLiveExp(null);
  };

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <nav className="sidebar">
        <div className="sidebar-logo">ODMeter</div>
        <button
          className={`nav-btn ${page === 'dashboard' ? 'active' : ''}`}
          onClick={() => navigate('dashboard')}
        >
          Dashboard
        </button>
        <button
          className={`nav-btn ${page === 'live' ? 'active' : ''}`}
          onClick={() => {
            if (liveExp) {
              navigate('live', liveExp);
            } else if (runningExp) {
              navigate('live', runningExp.name);
            }
          }}
          disabled={!liveExp && !runningExp}
          title={
            liveExp
              ? `Live: ${liveExp}`
              : runningExp
              ? `Live: ${runningExp.name}`
              : 'No active experiment'
          }
        >
          Live
        </button>
        <button
          className={`nav-btn ${page === 'diagnostics' ? 'active' : ''}`}
          onClick={() => navigate('diagnostics')}
        >
          Diagnostics
        </button>
      </nav>

      {/* Main content */}
      <main className="main-content">
        {page === 'dashboard' && (
          <Dashboard onViewLive={handleViewLive} runningExp={runningExp} />
        )}
        {page === 'live' && liveExp && (
          <LiveView expName={liveExp} onBack={handleBack} />
        )}
        {page === 'live' && !liveExp && (
          <div className="card">
            <p className="empty-state">No experiment selected. Go to Dashboard first.</p>
          </div>
        )}
        {page === 'diagnostics' && <Diagnostics />}
      </main>
    </div>
  );
}
