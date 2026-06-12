import React, { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard.jsx';
import LiveView from './components/LiveView.jsx';
import Diagnostics from './components/Diagnostics.jsx';
import { getExperiments } from './api/go.js';

function getInitialTheme() {
  const stored = localStorage.getItem('odm-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [liveExp, setLiveExp] = useState(null);
  const [runningExp, setRunningExp] = useState(null);
  const [theme, setTheme] = useState(getInitialTheme);

  // Apply theme to <html> so CSS :root[data-theme] selector works
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('odm-theme', theme);
  }, [theme]);

  const toggleTheme = () =>
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  // Poll acquisition endpoint every 5s for running experiment
  useEffect(() => {
    const poll = () => {
      getExperiments()
        .then((exps) => {
          const list = Array.isArray(exps) ? exps : [];
          setRunningExp(list.find((e) => e.is_running) ?? null);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  const handleViewLive = (expName) => {
    setLiveExp(expName);
    setPage('live');
  };

  const handleBack = () => {
    setPage('dashboard');
  };

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <nav className="sidebar">
        <div className="sidebar-logo">ODMeter</div>

        <button
          className={`nav-btn ${page === 'dashboard' ? 'active' : ''}`}
          onClick={() => setPage('dashboard')}
        >
          Dashboard
        </button>

        <button
          className={`nav-btn ${page === 'live' ? 'active' : ''}`}
          onClick={() => {
            const target = liveExp || runningExp?.name;
            if (target) handleViewLive(target);
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
          onClick={() => setPage('diagnostics')}
        >
          Diagnostics
        </button>

        <div className="sidebar-spacer" />

        <button className="theme-toggle" onClick={toggleTheme}>
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
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
