import React, { useState, useEffect, useRef, useCallback } from 'react';
import Plot from 'react-plotly.js';
import { getExperimentData, getConfig, getGrowthRates } from '../api/data.js';

const PLOTLY_COLORS = [
  '#636EFA', '#EF553B', '#00CC96', '#AB63FA',
  '#FFA15A', '#19D3F3', '#FF6692', '#B6E880',
  '#FF97FF', '#FECB52',
];

const DARK_LAYOUT = {
  paper_bgcolor: '#1a1a1a',
  plot_bgcolor: '#111',
  font: { color: '#ddd', size: 11 },
  margin: { t: 30, r: 20, b: 50, l: 55 },
  legend: { bgcolor: '#1a1a1a', bordercolor: '#2a2a2a', borderwidth: 1 },
};

const AXIS_STYLE = {
  gridcolor: '#2a2a2a',
  linecolor: '#2a2a2a',
  tickcolor: '#444',
  zerolinecolor: '#2a2a2a',
};

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
        const label = sampleNames?.[tr.channel] || `Ch ${tr.channel}`;
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
function DeviceChart({ device, traces, sampleNames, yScale }) {
  const [visibility, setVisibility] = useState({});

  const handleToggle = (i) => {
    setVisibility((prev) => {
      // If any are explicitly hidden, just toggle this one
      const anyHidden = Object.values(prev).some((v) => v === false);
      if (!anyHidden) {
        // Isolate: hide all except i
        const next = {};
        traces.forEach((_, idx) => {
          if (idx !== i) next[idx] = false;
        });
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
    ...DARK_LAYOUT,
    xaxis: { ...AXIS_STYLE, title: 'Time (min)' },
    yaxis: {
      ...AXIS_STYLE,
      title: 'OD',
      type: yScale === 'log' ? 'log' : 'linear',
    },
    height: 280,
  };

  return (
    <div className="device-section">
      <span className="device-label">{device}</span>
      <Plot
        data={plotTraces}
        layout={layout}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%' }}
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
function GrowthRateChart({ device, traces, sampleNames }) {
  const [visibility, setVisibility] = useState({});

  const handleToggle = (i) => {
    setVisibility((prev) => {
      const anyHidden = Object.values(prev).some((v) => v === false);
      if (!anyHidden) {
        const next = {};
        traces.forEach((_, idx) => {
          if (idx !== i) next[idx] = false;
        });
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
    ...DARK_LAYOUT,
    xaxis: { ...AXIS_STYLE, title: 'Time (min)' },
    yaxis: { ...AXIS_STYLE, title: 'Growth rate (h⁻¹)' },
    height: 240,
  };

  return (
    <div className="device-section">
      <span className="device-label">{device} — Growth Rates</span>
      <Plot
        data={plotTraces}
        layout={layout}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: '100%' }}
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
 * LiveView — main experiment live view page.
 *
 * Props: expName (string), onBack (function)
 */
export default function LiveView({ expName, onBack }) {
  const [histData, setHistData] = useState([]);
  const [liveRows, setLiveRows] = useState([]);
  const [config, setConfig] = useState(null);
  const [growthRates, setGrowthRates] = useState(null);
  const [yScale, setYScale] = useState('linear');
  const [wsStatus, setWsStatus] = useState('connecting'); // 'connecting' | 'open' | 'closed'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const wsRef = useRef(null);
  const growthPollRef = useRef(null);
  const timeStartedRef = useRef(null); // ISO string; used to convert live t → t_min

  // Build sample name map: {device: {channel: sampleName}}
  const sampleNames = {};
  if (config?.samples) {
    config.samples.forEach((s) => {
      if (!sampleNames[s.device]) sampleNames[s.device] = {};
      sampleNames[s.device][s.channel] = s.name || `Ch ${s.channel}`;
    });
  }

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

  // WebSocket connection with auto-reconnect
  useEffect(() => {
    let ws = null;
    let retryTimerId = null;
    let unmounted = false;
    let retries = 0;

    const handleMessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
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
          setLiveRows((prev) => {
            const newRows = readings
              .filter((r) => r !== null && r !== undefined)
              .map((r) => ({
                ...r,
                t_min: t0 ? (new Date(r.t).getTime() - t0) / 60000 : null,
              }));
            return mergeRows(prev, newRows);
          });
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
  }, [expName]);

  // Poll growth rates every 3s; stop if CSV doesn't exist yet (404)
  useEffect(() => {
    const poll = () => {
      getGrowthRates(expName)
        .then((data) => setGrowthRates(data))
        .catch((err) => {
          if (err?.message && err.message.includes('→ 404')) {
            clearInterval(growthPollRef.current);
          }
        });
    };
    poll();
    growthPollRef.current = setInterval(poll, 3000);
    return () => clearInterval(growthPollRef.current);
  }, [expName]);

  // Merged rows
  const allRows = mergeRows(histData, liveRows);

  // Get unique devices
  const deviceSet = new Set(allRows.map((r) => r.device).filter(Boolean));
  const devices = [...deviceSet].sort();

  // Growth rate devices
  const grDeviceSet = new Set();
  if (growthRates && typeof growthRates === 'object') {
    Object.keys(growthRates).forEach((d) => grDeviceSet.add(d));
  }
  const grDevices = [...grDeviceSet].sort();

  // Build growth rate trace data
  const buildGrTraces = (device) => {
    const deviceData = growthRates?.[device];
    if (!deviceData) return [];
    const byChannel = {};
    Object.entries(deviceData).forEach(([channel, points]) => {
      if (!Array.isArray(points)) return;
      const ch = Number(channel);
      byChannel[ch] = {
        channel: ch,
        x: points.map((p) => p.t ?? p.time),
        y: points.map((p) => p.mu ?? p.rate ?? p.value),
      };
    });
    return Object.values(byChannel).sort((a, b) => a.channel - b.channel);
  };

  return (
    <>
      <div className="page-header">
        <button className="btn-back" onClick={onBack}>
          ← Dashboard
        </button>
        <span className="page-title">{expName}</span>
        <span
          style={{
            fontSize: 11,
            color: wsStatus === 'open' ? '#3d3' : wsStatus === 'connecting' ? '#fa3' : '#c03',
            marginLeft: 'auto',
          }}
        >
          WS: {wsStatus}
        </span>
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
        {liveRows.length > 0 && (
          <span className="exp-meta">+{liveRows.length} live points</span>
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
              />
            </div>
          );
        })}

      {grDevices.length > 0 && (
        <>
          <p className="section-header" style={{ marginTop: 8 }}>
            Growth Rates
          </p>
          {grDevices.map((device) => {
            const traces = buildGrTraces(device);
            return (
              <div key={`gr-${device}`} className="card">
                <GrowthRateChart
                  device={device}
                  traces={traces}
                  sampleNames={sampleNames[device]}
                />
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
