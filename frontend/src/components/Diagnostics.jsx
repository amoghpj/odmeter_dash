import React, { useState, useCallback } from 'react';

// ── Go API health checks ──────────────────────────────────────────────────────

const GO_CHECKS = [
  { id: 'config',     label: 'Go Config',      method: 'GET', url: '/api/config/' },
  { id: 'device',     label: 'Go Devices',     method: 'GET', url: '/api/device/' },
  { id: 'sample',     label: 'Go Samples',     method: 'GET', url: '/api/sample/' },
  { id: 'acqusition', label: 'Go Experiments', method: 'GET', url: '/api/acqusition/' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  if (!status) return <span className="empty-state">—</span>;
  if (status === 'running') return <span className="warn">running…</span>;
  if (status === 'pass')    return <span className="pass">PASS</span>;
  if (status === 'fail')    return <span className="fail">FAIL</span>;
  if (status === 'warn')    return <span className="warn">WARN</span>;
  return <span>{status}</span>;
}

async function runHttpCheck({ label, method, url }) {
  const start = Date.now();
  try {
    const res = await fetch(url, { method });
    const elapsed = Date.now() - start;
    let detail = '';
    try {
      const body = await res.text();
      detail = body.length > 120 ? body.slice(0, 120) + '…' : body;
    } catch (_) {}
    return { label, method, url, status: res.ok ? 'pass' : 'fail', httpStatus: res.status, time: elapsed, detail };
  } catch (err) {
    return { label, method, url, status: 'fail', httpStatus: null, time: Date.now() - start, detail: err.message };
  }
}

function runWsCheck() {
  return new Promise((resolve) => {
    const start = Date.now();
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/svc/ws/`;
    let ws;
    const timer = setTimeout(() => {
      try { ws?.close(); } catch (_) {}
      resolve({ label: 'WebSocket (proxy)', method: 'WS', url: wsUrl, status: 'fail', httpStatus: null, time: Date.now() - start, detail: 'Timeout after 5 s' });
    }, 5000);

    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.close();
        resolve({ label: 'WebSocket (proxy)', method: 'WS', url: wsUrl, status: 'pass', httpStatus: 101, time: Date.now() - start, detail: 'Connected and closed cleanly' });
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve({ label: 'WebSocket (proxy)', method: 'WS', url: wsUrl, status: 'fail', httpStatus: null, time: Date.now() - start, detail: 'Connection error' });
      };
    } catch (err) {
      clearTimeout(timer);
      resolve({ label: 'WebSocket (proxy)', method: 'WS', url: wsUrl, status: 'fail', httpStatus: null, time: Date.now() - start, detail: err.message });
    }
  });
}

// ── Results table ─────────────────────────────────────────────────────────────

function ResultsTable({ results }) {
  if (results.length === 0) return null;
  return (
    <table className="diag-table" style={{ marginTop: 10 }}>
      <thead>
        <tr>
          <th>Test</th>
          <th>Method</th>
          <th>Status</th>
          <th>HTTP</th>
          <th>ms</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        {results.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.method}</td>
            <td><StatusBadge status={r.status} /></td>
            <td className="mono">{r.httpStatus ?? '—'}</td>
            <td className="mono">{r.time != null ? r.time : '—'}</td>
            <td
              className="mono"
              style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10 }}
              title={r.detail}
            >
              {r.detail}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Go + WebSocket health checks ──────────────────────────────────────────────

function GoHealthChecks() {
  const [results, setResults] = useState([]);
  const [running, setRunning] = useState(false);

  const runAll = useCallback(async () => {
    setRunning(true);
    setResults([
      ...GO_CHECKS,
      { id: 'ws', label: 'WebSocket (proxy)', method: 'WS', url: '' },
    ].map((c) => ({ ...c, status: 'running', time: null, detail: '', httpStatus: null })));

    const [httpResults, wsResult] = await Promise.all([
      Promise.all(GO_CHECKS.map(runHttpCheck)),
      runWsCheck(),
    ]);
    setResults([...httpResults, wsResult]);
    setRunning(false);
  }, []);

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <p className="section-header" style={{ marginBottom: 0 }}>Go API + WebSocket</p>
        <button className="btn btn-create btn-sm" onClick={runAll} disabled={running}>
          {running ? 'Running…' : 'Run'}
        </button>
      </div>
      {results.length === 0
        ? <p className="empty-state">Click "Run" to test connectivity.</p>
        : <ResultsTable results={results} />}
    </div>
  );
}

// ── Data service status ───────────────────────────────────────────────────────

function DataServiceStatus() {
  const [status, setStatus] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/svc/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }, []);

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <p className="section-header" style={{ marginBottom: 0 }}>Data Service Status</p>
        <button className="btn btn-create btn-sm" onClick={run} disabled={running}>
          {running ? 'Fetching…' : 'Run'}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {status && (
        <table className="diag-table" style={{ marginTop: 10 }}>
          <thead>
            <tr><th>Key</th><th>Value</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Go API</td>
              <td className="mono">{status.go_api}</td>
            </tr>
            <tr>
              <td>Go reachable</td>
              <td>{status.go_reachable ? <span className="pass">yes</span> : <span className="fail">no</span>}</td>
            </tr>
            <tr>
              <td>Pandas</td>
              <td className="mono">{status.pandas_version}</td>
            </tr>
            <tr>
              <td>Python</td>
              <td className="mono">{status.python_version}</td>
            </tr>
            <tr>
              <td>Experiments found</td>
              <td className="mono">{status.experiments_total}</td>
            </tr>
          </tbody>
        </table>
      )}

      {status?.data_dirs && (
        <>
          <p className="section-header" style={{ marginTop: 14, marginBottom: 6 }}>Data directories</p>
          <table className="diag-table">
            <thead>
              <tr><th>Path</th><th>Exists</th><th>Experiments</th></tr>
            </thead>
            <tbody>
              {status.data_dirs.map((d) => (
                <tr key={d.path}>
                  <td className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{d.path}</td>
                  <td>{d.exists ? <span className="pass">yes</span> : <span className="fail">no</span>}</td>
                  <td className="mono">{d.experiments}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {!status && !error && (
        <p className="empty-state">Click "Run" to check data service state.</p>
      )}
    </div>
  );
}

// ── Experiment list ───────────────────────────────────────────────────────────

function ExperimentList() {
  const [exps, setExps] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/svc/experiments');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setExps(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }, []);

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <p className="section-header" style={{ marginBottom: 0 }}>Experiment List (/svc/experiments)</p>
        <button className="btn btn-create btn-sm" onClick={run} disabled={running}>
          {running ? 'Fetching…' : 'Run'}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {exps !== null && exps.length === 0 && (
        <p className="empty-state">No experiments found in data directories.</p>
      )}

      {exps && exps.length > 0 && (
        <table className="diag-table" style={{ marginTop: 10 }}>
          <thead>
            <tr><th>Name</th><th>Samples</th><th>Started</th><th>Size</th></tr>
          </thead>
          <tbody>
            {exps.map((e) => (
              <tr key={e.name}>
                <td className="mono" style={{ fontSize: 11 }}>{e.name}</td>
                <td className="mono">{e.sample_count ?? '—'}</td>
                <td className="mono" style={{ fontSize: 10 }}>
                  {e.time_started ? new Date(e.time_started).toLocaleString() : '—'}
                </td>
                <td className="mono">{e.size_bytes != null ? `${(e.size_bytes / 1024).toFixed(1)} KB` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {exps === null && !error && (
        <p className="empty-state">Click "Run" to list experiments found in data directories.</p>
      )}
    </div>
  );
}

// ── Data load test ────────────────────────────────────────────────────────────

function DataLoadTest() {
  const [name, setName] = useState('');
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    const n = name.trim();
    if (!n) return;
    setRunning(true);
    setResult(null);
    const start = Date.now();
    try {
      const res = await fetch(`/svc/data/${encodeURIComponent(n)}?max_points=10`);
      const elapsed = Date.now() - start;
      const body = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (_) {}

      let detail = '';
      if (res.ok && parsed) {
        detail = `${parsed.total_rows ?? '?'} rows, ${parsed.rows?.length ?? 0} returned, downsampled=${parsed.downsampled}`;
      } else {
        detail = body.length > 200 ? body.slice(0, 200) + '…' : body;
      }

      setResult({ status: res.ok ? 'pass' : 'fail', httpStatus: res.status, time: elapsed, detail });
    } catch (err) {
      setResult({ status: 'fail', httpStatus: null, time: Date.now() - start, detail: err.message });
    } finally {
      setRunning(false);
    }
  }, [name]);

  return (
    <div className="card">
      <p className="section-header" style={{ marginBottom: 10 }}>Data Load Test (/svc/data/…)</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="experiment name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          style={{ width: 280 }}
        />
        <button className="btn btn-create btn-sm" onClick={run} disabled={running || !name.trim()}>
          {running ? 'Loading…' : 'Test'}
        </button>
      </div>

      {result && (
        <table className="diag-table" style={{ marginTop: 12 }}>
          <thead>
            <tr><th>Status</th><th>HTTP</th><th>ms</th><th>Detail</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><StatusBadge status={result.status} /></td>
              <td className="mono">{result.httpStatus ?? '—'}</td>
              <td className="mono">{result.time}</td>
              <td className="mono" style={{ fontSize: 10, wordBreak: 'break-all' }}>{result.detail}</td>
            </tr>
          </tbody>
        </table>
      )}

      {!result && <p className="empty-state" style={{ marginTop: 10 }}>Enter an experiment name and click "Test" to check if its CSV can be parsed.</p>}
    </div>
  );
}

// ── CLI stubs ─────────────────────────────────────────────────────────────────

function CliStubs() {
  return (
    <div className="card">
      <p className="section-header">CLI Tests</p>
      <p className="loading-text" style={{ lineHeight: 1.6 }}>
        Write and interval-accuracy tests require the terminal:
      </p>
      <div className="yaml-preview" style={{ marginTop: 10 }}>
        python api_tests.py --write{'\n'}python api_tests.py --interval
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Diagnostics() {
  return (
    <>
      <div className="page-header">
        <span className="page-title">Diagnostics</span>
      </div>
      <p className="loading-text">
        Serving from&nbsp;
        <span style={{ fontFamily: 'monospace' }}>
          {window.location.host}
        </span>
      </p>
      <GoHealthChecks />
      <DataServiceStatus />
      <ExperimentList />
      <DataLoadTest />
      <CliStubs />
    </>
  );
}
