import React, { useState, useCallback } from 'react';

const HEALTH_CHECKS = [
  { id: 'config', label: 'Go Config', method: 'GET', url: '/api/config/' },
  { id: 'device', label: 'Go Devices', method: 'GET', url: '/api/device/' },
  { id: 'sample', label: 'Go Samples', method: 'GET', url: '/api/sample/' },
  { id: 'acqusition', label: 'Go Experiments', method: 'GET', url: '/api/acqusition/' },
];

function StatusBadge({ status }) {
  if (!status) return <span style={{ color: '#444' }}>—</span>;
  if (status === 'running') return <span style={{ color: '#fa3' }}>running…</span>;
  if (status === 'pass') return <span className="pass">PASS</span>;
  if (status === 'fail') return <span className="fail">FAIL</span>;
  if (status === 'warn') return <span className="warn">WARN</span>;
  return <span>{status}</span>;
}

/**
 * Run a single HTTP health check and return result object.
 */
async function runHttpCheck({ label, method, url }) {
  const start = Date.now();
  try {
    const res = await fetch(url, { method });
    const elapsed = Date.now() - start;
    let detail = '';
    try {
      const body = await res.text();
      // Try to show just the first ~100 chars
      detail = body.length > 100 ? body.slice(0, 100) + '…' : body;
    } catch (_) {}
    return {
      label,
      method,
      url,
      status: res.ok ? 'pass' : 'fail',
      httpStatus: res.status,
      time: elapsed,
      detail,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    return {
      label,
      method,
      url,
      status: 'fail',
      httpStatus: null,
      time: elapsed,
      detail: err.message,
    };
  }
}

/**
 * Run a WebSocket connectivity check.
 */
function runWsCheck() {
  return new Promise((resolve) => {
    const start = Date.now();
    const wsUrl = `ws://${window.location.hostname}:8080/api/ws/`;
    let ws;
    const timer = setTimeout(() => {
      try { ws?.close(); } catch (_) {}
      resolve({
        label: 'WebSocket',
        method: 'WS',
        url: wsUrl,
        status: 'fail',
        httpStatus: null,
        time: Date.now() - start,
        detail: 'Timeout after 5s',
      });
    }, 5000);

    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.close();
        resolve({
          label: 'WebSocket',
          method: 'WS',
          url: wsUrl,
          status: 'pass',
          httpStatus: 101,
          time: Date.now() - start,
          detail: 'Connected and closed cleanly',
        });
      };
      ws.onerror = (e) => {
        clearTimeout(timer);
        resolve({
          label: 'WebSocket',
          method: 'WS',
          url: wsUrl,
          status: 'fail',
          httpStatus: null,
          time: Date.now() - start,
          detail: 'Connection error',
        });
      };
    } catch (err) {
      clearTimeout(timer);
      resolve({
        label: 'WebSocket',
        method: 'WS',
        url: wsUrl,
        status: 'fail',
        httpStatus: null,
        time: Date.now() - start,
        detail: err.message,
      });
    }
  });
}

/**
 * HealthChecks section.
 */
function HealthChecks() {
  const [results, setResults] = useState([]);
  const [running, setRunning] = useState(false);

  const runAll = useCallback(async () => {
    setRunning(true);
    setResults(
      [...HEALTH_CHECKS, { id: 'ws', label: 'WebSocket', method: 'WS', url: '' }].map(
        (c) => ({ ...c, status: 'running', time: null, detail: '', httpStatus: null })
      )
    );

    const httpResults = await Promise.all(HEALTH_CHECKS.map(runHttpCheck));
    const wsResult = await runWsCheck();

    setResults([...httpResults, wsResult]);
    setRunning(false);
  }, []);

  return (
    <div className="card">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 14,
        }}
      >
        <p className="section-header" style={{ marginBottom: 0 }}>
          Health Checks
        </p>
        <button
          className="btn btn-create btn-sm"
          onClick={runAll}
          disabled={running}
        >
          {running ? 'Running…' : 'Run'}
        </button>
      </div>

      {results.length === 0 ? (
        <p className="empty-state">Click "Run" to test connectivity to all services.</p>
      ) : (
        <table className="diag-table">
          <thead>
            <tr>
              <th>Test</th>
              <th>Method</th>
              <th>Status</th>
              <th>HTTP</th>
              <th>Time (ms)</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.method}</td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td style={{ color: '#555', fontSize: 11 }}>
                  {r.httpStatus ?? '—'}
                </td>
                <td style={{ color: '#555' }}>{r.time != null ? r.time : '—'}</td>
                <td
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 10,
                    color: '#555',
                    maxWidth: 300,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={r.detail}
                >
                  {r.detail}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * WriteTests section — deferred to CLI.
 */
function WriteTests() {
  return (
    <div className="card">
      <p className="section-header">Write Tests</p>
      <p style={{ color: '#555', fontSize: 12, lineHeight: 1.6 }}>
        Write tests require creating and deleting sample records. Run from terminal:
      </p>
      <div className="yaml-preview" style={{ marginTop: 10 }}>
        python api_tests.py --write
      </div>
    </div>
  );
}

/**
 * IntervalAccuracy section — deferred to CLI.
 */
function IntervalAccuracy() {
  return (
    <div className="card">
      <p className="section-header">Interval Accuracy</p>
      <p style={{ color: '#555', fontSize: 12, lineHeight: 1.6 }}>
        Interval accuracy tests require a long-running acquisition. Run from terminal:
      </p>
      <div className="yaml-preview" style={{ marginTop: 10 }}>
        python api_tests.py --interval
      </div>
    </div>
  );
}

/**
 * Diagnostics page.
 */
export default function Diagnostics() {
  return (
    <>
      <div className="page-header">
        <span className="page-title">Diagnostics</span>
      </div>
      <p style={{ fontSize: 12, color: '#555' }}>
        Server: {window.location.hostname}:{window.location.port || 80}
        &nbsp;|&nbsp; Go API: {window.location.hostname}:8080
        &nbsp;|&nbsp; Data service: {window.location.hostname}:8051
      </p>
      <HealthChecks />
      <WriteTests />
      <IntervalAccuracy />
    </>
  );
}
