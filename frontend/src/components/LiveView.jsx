import React, { useState, useEffect, useRef, useCallback } from 'react';
import Plot from 'react-plotly.js';
import { getExperimentData, getConfig, getGrowthRates, computeGrowthRates } from '../api/data.js';

const PLOTLY_COLORS = [
  '#636EFA', '#EF553B', '#00CC96', '#AB63FA',
  '#FFA15A', '#19D3F3', '#FF6692', '#B6E880',
  '#FF97FF', '#FECB52',
];

const THEME_LAYOUT = {
  dark: {
    base: {
      paper_bgcolor: '#1a1a1a',
      plot_bgcolor: '#111111',
      font: { color: '#dddddd', size: 11 },
      margin: { t: 30, r: 20, b: 50, l: 55 },
      legend: { bgcolor: '#1a1a1a', bordercolor: '#2a2a2a', borderwidth: 1 },
      autosize: true,
    },
    axis: {
      gridcolor: '#2a2a2a',
      linecolor: '#2a2a2a',
      tickcolor: '#444444',
      zerolinecolor: '#2a2a2a',
    },
  },
  light: {
    base: {
      paper_bgcolor: '#ffffff',
      plot_bgcolor: '#f8f8f8',
      font: { color: '#222222', size: 11 },
      margin: { t: 30, r: 20, b: 50, l: 55 },
      legend: { bgcolor: '#ffffff', bordercolor: '#dddddd', borderwidth: 1 },
      autosize: true,
    },
    axis: {
      gridcolor: '#e0e0e0',
      linecolor: '#cccccc',
      tickcolor: '#999999',
      zerolinecolor: '#cccccc',
    },
  },
};

// Keep only the most useful mode-bar buttons; always show on hover (default).
const MODEBAR_REMOVE = [
  'select2d', 'lasso2d', 'toggleSpikelines',
  'hoverClosestCartesian', 'hoverCompareCartesian', 'toImage',
];

function makePlotConfig() {
  return {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: MODEBAR_REMOVE,
  };
}

/**
 * Build Plotly traces for a single device.
 * Rows from /svc/data have {t_min, converted_od, device, channel, sample_name}.
 * Live WS rows are normalised to the same shape before being merged in.
 */
function buildTraces(rows, device) {
  const byChannel = {};
  rows.forEach((row) => {
    if (row.device !== device) return;
    const key = row.channel;
    if (!byChannel[key]) byChannel[key] = { x: [], y: [], channel: key };
    byChannel[key].x.push(row.t_min ?? null);
    byChannel[key].y.push(row.converted_od ?? null);
  });
  return Object.values(byChannel).sort((a, b) => a.channel - b.channel);
}

/**
 * Merge hist rows and live rows, deduplicating by (device, channel, t_min).
 */
function mergeRows(hist, live) {
  const seen = new Set();
  const result = [];
  [...hist, ...live].forEach((r) => {
    const key = `${r.device}|${r.channel}|${r.t_min ?? r.t}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(r);
    }
  });
  return result;
}

/**
 * PillLegend — colored pill buttons per trace; click to isolate/toggle.
 */
function PillLegend({ traces, sampleNames, visibility, onToggle, onReset }) {
  return (
    <div className="pill-legend">
      {traces.map((tr, i) => {
        const color = PLOTLY_COLORS[i % PLOTLY_COLORS.length];
        const label = sampleNames?.[tr.channel] || tr.sample_name || `Ch ${tr.channel ?? i}`;
        const hidden = visibility?.[i] === false;
        return (
          <button
            key={tr.channel}
            className={`pill ${hidden ? 'hidden' : ''}`}
            style={{
              color: hidden ? '#555' : color,
              borderColor: hidden ? '#333' : color,
              background: hidden ? 'none' : `${color}22`,
            }}
            onClick={() => onToggle(i)}
          >
            {label}
          </button>
        );
      })}
      <button className="pill-reset" onClick={onReset}>
        Reset
      </button>
    </div>
  );
}

/**
 * DeviceChart — Plotly chart + pill legend for one device.
 */
function DeviceChart({ device, traces, sampleNames, yScale, theme }) {
  const [visibility, setVisibility] = useState({});
  const t = THEME_LAYOUT[theme] ?? THEME_LAYOUT.dark;

  const handleToggle = (i) => {
    setVisibility((prev) => {
      const anyHidden = Object.values(prev).some((v) => v === false);
      if (!anyHidden) {
        const next = {};
        traces.forEach((_, idx) => { if (idx !== i) next[idx] = false; });
        return next;
      }
      const next = { ...prev };
      next[i] = prev[i] === false ? true : false;
      return next;
    });
  };

  const handleReset = () => setVisibility({});

  const plotTraces = traces.map((tr, i) => ({
    x: tr.x,
    y: tr.y,
    type: 'scatter',
    mode: 'lines+markers',
    name: sampleNames?.[tr.channel] || `Ch ${tr.channel}`,
    line: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length], width: 1.5 },
    marker: { size: 3, color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] },
    visible: visibility[i] === false ? false : true,
  }));

  const layout = {
    ...t.base,
    xaxis: { ...t.axis, title: 'Time (min)' },
    yaxis: {
      ...t.axis,
      title: 'OD',
      type: yScale === 'log' ? 'log' : 'linear',
      rangemode: yScale === 'log' ? 'normal' : 'tozero',
    },
    height: 280,
  };

  return (
    <div className="device-section">
      <span className="device-label">{device}</span>
      <Plot
        data={plotTraces}
        layout={layout}
        config={makePlotConfig()}
        style={{ width: '100%', height: '280px' }}
        useResizeHandler
      />
      <PillLegend
        traces={traces}
        sampleNames={sampleNames}
        visibility={visibility}
        onToggle={handleToggle}
        onReset={handleReset}
      />
    </div>
  );
}

/**
 * GrowthRateChart — same structure but for growth rate data.
 */
function GrowthRateChart({ device, traces, theme }) {
  const [visibility, setVisibility] = useState({});
  const t = THEME_LAYOUT[theme] ?? THEME_LAYOUT.dark;

  const handleToggle = (i) => {
    setVisibility((prev) => {
      const anyHidden = Object.values(prev).some((v) => v === false);
      if (!anyHidden) {
        const next = {};
        traces.forEach((_, idx) => { if (idx !== i) next[idx] = false; });
        return next;
      }
      const next = { ...prev };
      next[i] = prev[i] === false ? true : false;
      return next;
    });
  };

  const handleReset = () => setVisibility({});

  const plotTraces = traces.map((tr, i) => ({
    x: tr.x,
    y: tr.y,
    type: 'scatter',
    mode: 'lines+markers',
    name: tr.sample_name || `Series ${i}`,
    line: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length], width: 1.5 },
    marker: { size: 3, color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] },
    visible: visibility[i] === false ? false : true,
  }));

  const layout = {
    ...t.base,
    xaxis: { ...t.axis, title: 'Time (min)' },
    yaxis: { ...t.axis, title: 'Growth rate (h⁻¹)' },
    height: 240,
  };

  return (
    <div className="device-section">
      <span className="device-label">{device} — Growth Rates</span>
      <Plot
        data={plotTraces}
        layout={layout}
        config={makePlotConfig()}
        style={{ width: '100%', height: '240px' }}
        useResizeHandler
      />
      <PillLegend
        traces={traces}
        visibility={visibility}
        onToggle={handleToggle}
        onReset={handleReset}
      />
    </div>
  );
}

/**
 * LiveView — main experiment live view page.
 *
 * Props: expName (string), onBack (function)
 */
export default function LiveView({ expName, onBack, theme = 'dark', isLive = true }) {
  const [histData, setHistData] = useState([]);
  const [liveRows, setLiveRows] = useState([]);
  const [config, setConfig] = useState(null);
  const [grRows, setGrRows] = useState([]);
  const [grStatus, setGrStatus] = useState('idle'); // 'idle' | 'computing' | 'done' | 'error'
  const [yScale, setYScale] = useState('linear');
  const [wsStatus, setWsStatus] = useState('connecting');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [paused, setPaused] = useState(false);

  const wsRef = useRef(null);
  const grPollRef = useRef(null);
  const timeStartedRef = useRef(null);
  const pausedRef = useRef(false);       // mirrors `paused` for use inside WS closure
  const pauseBufferRef = useRef([]);     // accumulates live rows while paused

  // Build sample name map: {device: {channel: sampleName}}
  // Config is primary (always present for live experiments); histData rows
  // are the fallback for historical experiments that have no config YAML.
  const sampleNames = {};
  if (config?.samples) {
    config.samples.forEach((s) => {
      if (!sampleNames[s.device]) sampleNames[s.device] = {};
      sampleNames[s.device][s.channel] = s.name || `Ch ${s.channel}`;
    });
  }
  histData.forEach((r) => {
    if (!r.device || r.channel == null || !r.sample_name) return;
    if (!sampleNames[r.device]) sampleNames[r.device] = {};
    if (!sampleNames[r.device][r.channel]) {
      sampleNames[r.device][r.channel] = r.sample_name;
    }
  });

  // Load historical data + config on mount
  useEffect(() => {
    setLoading(true);
    Promise.all([
      getExperimentData(expName, 500).catch((e) => {
        console.warn('getExperimentData error:', e);
        return null;
      }),
      getConfig(expName).catch(() => null),
    ]).then(([data, cfg]) => {
      if (data?.rows) {
        setHistData(data.rows);
        // Store experiment start time so the WS handler can compute t_min
        if (data.meta?.time_started) {
          timeStartedRef.current = data.meta.time_started;
        }
      } else {
        setHistData([]);
      }
      setConfig(cfg);
      setLoading(false);
    });
  }, [expName]);

  // WebSocket connection with auto-reconnect — only for the live experiment
  useEffect(() => {
    if (!isLive) return;

    let ws = null;
    let retryTimerId = null;
    let unmounted = false;
    let retries = 0;

    const handleMessage = (event) => {
      try {
        // Go emits bare NaN tokens (invalid JSON) when no calibration curve is set.
        // Replace them with null before parsing so the message isn't silently dropped.
        const sanitized = event.data.replace(/\bNaN\b/g, 'null');
        const msg = JSON.parse(sanitized);
        if (msg.eventType === 'NewReadings') {
          const readings = msg.readings ?? [];
          if (!Array.isArray(readings)) return;
          // If we have no historical start time, use the first reading as t0
          if (!timeStartedRef.current && readings[0]?.t) {
            timeStartedRef.current = readings[0].t;
          }
          const t0 = timeStartedRef.current
            ? new Date(timeStartedRef.current).getTime()
            : null;
          const newRows = readings
            .filter((r) => r !== null && r !== undefined)
            .map((r) => ({
              ...r,
              t_min: t0 ? (new Date(r.t).getTime() - t0) / 60000 : null,
            }));
          if (pausedRef.current) {
            pauseBufferRef.current.push(...newRows);
          } else {
            setLiveRows((prev) => mergeRows(prev, newRows));
          }
        }
      } catch (e) {
        // ignore parse errors
      }
    };

    const connect = () => {
      if (unmounted) return;
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}/svc/ws/`;
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        retries = 0;
        setWsStatus('open');
      };

      ws.onclose = () => {
        if (unmounted) return;
        retries++;
        setWsStatus('connecting');
        // Exponential backoff: 2s, 4s, 8s … capped at 30s
        const delay = Math.min(2000 * Math.pow(2, retries - 1), 30000);
        retryTimerId = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose fires after onerror; reconnect logic is there
      };

      ws.onmessage = handleMessage;
    };

    connect();

    return () => {
      unmounted = true;
      clearTimeout(retryTimerId);
      if (ws) ws.close();
    };
  }, [expName, isLive]);

  // Load any cached growth rates on mount
  useEffect(() => {
    getGrowthRates(expName)
      .then((data) => {
        if (data?.rows) setGrRows(data.rows);
        if (data?.status === 'computing') setGrStatus('computing');
        else if (data?.rows?.length) setGrStatus('done');
      })
      .catch(() => {});
  }, [expName]);

  // Poll status while a computation is in progress
  useEffect(() => {
    if (grStatus !== 'computing') return;
    const poll = () => {
      getGrowthRates(expName)
        .then((data) => {
          if (data?.status === 'done') {
            setGrRows(data.rows || []);
            setGrStatus('done');
            clearInterval(grPollRef.current);
          } else if (data?.status === 'error') {
            setGrStatus('error');
            clearInterval(grPollRef.current);
          }
        })
        .catch(() => {});
    };
    grPollRef.current = setInterval(poll, 3000);
    return () => clearInterval(grPollRef.current);
  }, [grStatus, expName]);

  // Merged rows
  const allRows = mergeRows(histData, liveRows);

  // Get unique devices
  const deviceSet = new Set(allRows.map((r) => r.device).filter(Boolean));
  const devices = [...deviceSet].sort();

  // Growth rate devices derived from flat rows
  const grDeviceSet = new Set(grRows.map((r) => r.device).filter(Boolean));
  const grDevices = [...grDeviceSet].sort();

  const buildGrTraces = (device) => {
    const bySample = {};
    grRows.forEach((row) => {
      if (row.device !== device) return;
      const key = (row.sample_name != null && row.sample_name !== '') ? String(row.sample_name) : 'unknown';
      if (!bySample[key]) bySample[key] = { x: [], y: [], sample_name: key };
      bySample[key].x.push(row.t_min ?? null);
      bySample[key].y.push(row.growth_rate ?? null);
    });
    return Object.values(bySample).sort((a, b) => String(a.sample_name).localeCompare(String(b.sample_name)));
  };

  return (
    <>
      <div className="page-header">
        <button className="btn-back" onClick={onBack}>
          ← Dashboard
        </button>
        <span className="page-title">{expName}</span>
        {isLive && (
          <span
            style={{
              fontSize: 11,
              color: wsStatus === 'open' ? '#3d3' : wsStatus === 'connecting' ? '#fa3' : '#c03',
              marginLeft: 'auto',
            }}
          >
            WS: {wsStatus}
          </span>
        )}
      </div>

      <div className="controls-row">
        <span className="section-header" style={{ marginBottom: 0 }}>Y scale:</span>
        <div className="toggle-group">
          <button
            className={`toggle-btn ${yScale === 'linear' ? 'active' : ''}`}
            onClick={() => setYScale('linear')}
          >
            Linear
          </button>
          <button
            className={`toggle-btn ${yScale === 'log' ? 'active' : ''}`}
            onClick={() => setYScale('log')}
          >
            Log
          </button>
        </div>

        {isLive && (
          <>
            <button
              className={`toggle-btn ${paused ? 'active' : ''}`}
              style={{ border: '1px solid var(--border)', borderRadius: 6 }}
              onClick={() => {
                if (paused) {
                  pausedRef.current = false;
                  setPaused(false);
                  setLiveRows((prev) => mergeRows(prev, pauseBufferRef.current));
                  pauseBufferRef.current = [];
                } else {
                  pausedRef.current = true;
                  setPaused(true);
                }
              }}
            >
              {paused ? '▶ Resume' : '⏸ Pause'}
            </button>

            {liveRows.length > 0 && (
              <span className="exp-meta">
                +{liveRows.length} live pts
                {paused && pauseBufferRef.current.length > 0 && (
                  <span style={{ color: 'var(--amber)', marginLeft: 6 }}>
                    ({pauseBufferRef.current.length} buffered)
                  </span>
                )}
              </span>
            )}
          </>
        )}
      </div>

      {loading && <p className="loading-text">Loading experiment data…</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && devices.length === 0 && (
        <div className="card">
          <p className="empty-state">No data yet — waiting for readings…</p>
        </div>
      )}

      {!loading &&
        devices.map((device) => {
          const traces = buildTraces(allRows, device);
          return (
            <div key={device} className="card">
              <DeviceChart
                device={device}
                traces={traces}
                sampleNames={sampleNames[device]}
                yScale={yScale}
                theme={theme}
              />
            </div>
          );
        })}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <p className="section-header" style={{ marginBottom: 0 }}>Growth Rates</p>
        {grStatus === 'computing' ? (
          <span style={{ fontSize: 11, color: 'var(--amber)' }}>Computing…</span>
        ) : (
          <button
            className="btn-back"
            style={{ fontSize: 11, padding: '3px 10px' }}
            onClick={() => {
              setGrStatus('computing');
              computeGrowthRates(expName).catch(() => setGrStatus('error'));
            }}
          >
            {grRows.length > 0 ? 'Recompute' : 'Compute'}
          </button>
        )}
        {grStatus === 'error' && (
          <span style={{ fontSize: 11, color: 'var(--fail-color)' }}>
            Error — check server logs
          </span>
        )}
      </div>

      {grDevices.length > 0 && grDevices.map((device) => (
        <div key={`gr-${device}`} className="card">
          <GrowthRateChart
            device={device}
            traces={buildGrTraces(device)}
            theme={theme}
          />
        </div>
      ))}

      {grRows.length === 0 && grStatus !== 'computing' && (
        <p className="empty-state" style={{ paddingTop: 0 }}>
          No growth rates computed yet.
        </p>
      )}
    </>
  );
}
