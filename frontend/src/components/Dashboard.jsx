import React, { useState, useEffect, useCallback } from 'react';
import SampleSheet from './SampleSheet.jsx';
import {
  getConfig,
  getDevices,
  getExperiments,
  getSamples,
  createSamples,
  deleteSamples,
  createExperiment,
  startExperiment,
  stopExperiment,
  closeExperiment,
} from '../api/go.js';
import { listExperiments, saveConfig, getConfig as getSvcConfig } from '../api/data.js';

function formatDuration(startIso) {
  if (!startIso) return null;
  const start = new Date(startIso);
  const diff = Math.floor((Date.now() - start) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
}

/**
 * StatusBanner — shows running experiment or idle state.
 */
function StatusBanner({ runningExp, onViewLive, onStop }) {
  const [stopping, setStopping] = useState(false);

  const handleStop = async () => {
    setStopping(true);
    try {
      await onStop();
    } finally {
      setStopping(false);
    }
  };

  if (!runningExp) {
    return (
      <div className="status-banner stopped">
        <span className="status-dot grey" />
        <span className="status-idle-text">No experiment running</span>
      </div>
    );
  }

  return (
    <div className="status-banner">
      <span className="status-dot green" />
      <div className="status-info">
        <span className="status-name">{runningExp.name}</span>
        {runningExp.user && (
          <span className="status-sub">User: {runningExp.user}</span>
        )}
      </div>
      <div className="status-actions">
        <button className="btn btn-create" onClick={() => onViewLive(runningExp.name)}>
          View Live Plots →
        </button>
        <button className="btn btn-stop" onClick={handleStop} disabled={stopping}>
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
        <button className="btn btn-close" disabled>
          Close
        </button>
      </div>
    </div>
  );
}

/**
 * PastExperiments — right-column card.
 */
function PastExperiments({ localExps, goExps, onViewLive }) {
  if (!localExps || localExps.length === 0) {
    return <p className="empty-state">No past experiments found.</p>;
  }

  // Build a map of name → running status from Go experiments
  const runningSet = new Set(
    (goExps || []).filter((e) => e.is_running).map((e) => e.name)
  );

  return (
    <ul className="exp-list">
      {localExps.map((exp) => {
        const name = typeof exp === 'string' ? exp : exp.name || exp.experiment;
        const isRunning = runningSet.has(name);
        const timeStarted = exp.time_started || exp.started_at;
        const duration = timeStarted ? formatDuration(timeStarted) : null;

        return (
          <li key={name}>
            <span className="exp-name" title={name}>
              {name}
            </span>
            {duration && <span className="exp-meta">{duration}</span>}
            <span className={`tag ${isRunning ? 'running' : 'stopped'}`}>
              {isRunning ? 'running' : 'stopped'}
            </span>
            <a
              className="exp-action"
              href={`/svc/csv/${encodeURIComponent(name)}`}
              download={`${name}.csv`}
              title="Download CSV"
            >
              ↓ CSV
            </a>
            <button className="exp-action" onClick={() => onViewLive(name)}>
              View plots →
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Dashboard — main landing page.
 */
export default function Dashboard({ onViewLive, runningExp }) {
  // Remote data
  const [experiments, setExperiments] = useState([]);
  const [devices, setDevices] = useState([]);
  const [goConfig, setGoConfig] = useState(null);
  const [localExps, setLocalExps] = useState([]);

  // Form state
  const [expName, setExpName] = useState('');
  const [user, setUser] = useState('');
  const [interval, setInterval_] = useState(30);
  const [sampleRows, setSampleRows] = useState([]);
  const [formStatus, setFormStatus] = useState(null); // null | 'submitting' | 'error:...' | 'success'

  // Load static data once
  useEffect(() => {
    getDevices()
      .then((data) => setDevices(data || []))
      .catch((err) => console.warn('getDevices error:', err));

    getConfig()
      .then((data) => {
        setGoConfig(data);
        if (data?.users?.length) setUser(data.users[0].name);
      })
      .catch((err) => console.warn('getConfig error:', err));

    listExperiments()
      .then((data) => setLocalExps(Array.isArray(data) ? data : []))
      .catch((err) => console.warn('listExperiments error:', err));
  }, []);

  // Poll Go experiments every 5s
  useEffect(() => {
    const poll = () => {
      getExperiments()
        .then((data) => setExperiments(Array.isArray(data) ? data : []))
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  // When a running experiment is detected, populate the form with its settings.
  // This handles navigating back to Dashboard while an experiment is active.
  useEffect(() => {
    if (!runningExp) return;

    setExpName(runningExp.name || '');
    if (runningExp.user) setUser(runningExp.user);
    if (runningExp.interval) setInterval_(runningExp.interval);

    getSvcConfig(runningExp.name)
      .then((cfg) => {
        if (!cfg?.samples?.length) return;
        const DEFAULT_META_KEYS = ['strain', 'condition', 'replicate', 'group', 'std_curve'];
        const rows = cfg.samples.map((s) => {
          const meta = {};
          DEFAULT_META_KEYS.forEach((k) => { meta[k] = s[k] !== undefined ? String(s[k]) : ''; });
          Object.keys(s).forEach((k) => {
            if (!['device', 'channel', 'name', ...DEFAULT_META_KEYS].includes(k)) {
              meta[k] = s[k] !== undefined ? String(s[k]) : '';
            }
          });
          return {
            id: `row-${Date.now()}-${Math.random()}`,
            device: String(s.device || ''),
            channel: Number(s.channel) || 1,
            sampleName: s.name || '',
            meta,
          };
        });
        setSampleRows(rows);
      })
      .catch(() => {});
  }, [runningExp?.name]);

  const handleStop = useCallback(async () => {
    if (!runningExp) return;
    await stopExperiment(runningExp.name);
    await new Promise((r) => setTimeout(r, 1000));
    await closeExperiment(runningExp.name);
  }, [runningExp]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!expName.trim()) {
      setFormStatus('error:Experiment name is required');
      return;
    }
    if (sampleRows.length === 0) {
      setFormStatus('error:Add at least one sample row');
      return;
    }
    const seen = new Set();
    for (const r of sampleRows) {
      const key = `${r.device}:${r.channel}`;
      if (seen.has(key)) {
        setFormStatus(`error:Duplicate channel — ${r.device} ch ${r.channel} appears more than once`);
        return;
      }
      seen.add(key);
    }

    setFormStatus('submitting');
    try {
      // 1. Stop running experiment if any
      if (runningExp) {
        await stopExperiment(runningExp.name);
        await new Promise((r) => setTimeout(r, 1000));
        await closeExperiment(runningExp.name);
      }

      // 2. Delete any samples still registered in Go so channels are free.
      //    Go does not release channel assignments on close; lingering samples
      //    cause "channel is being used" 400 errors on the next createSamples.
      const existingSamples = await getSamples().catch(() => null);
      const samplesToDelete = Array.isArray(existingSamples) ? existingSamples : [];
      if (samplesToDelete.length > 0) {
        await deleteSamples(
          samplesToDelete.map((s) => ({ device: s.device, channel: s.channel }))
        );
      }

      // 3. Create samples
      const samplePayload = sampleRows.map((r) => ({
        device: r.device,
        channel: r.channel,
        name: r.sampleName,
        standard_curve_name: r.meta?.std_curve || 'Ecoli-ReusableGlassTube',
        metadata: Object.fromEntries(
          Object.entries(r.meta || {}).filter(([k]) => k !== 'std_curve')
        ),
        user,
      }));
      const createdSamples = await createSamples(samplePayload);
      const uuids = (Array.isArray(createdSamples) ? createdSamples : [])
        .map((s) => s.uuid)
        .filter(Boolean);

      // 4. Create experiment
      await createExperiment({
        name: expName.trim(),
        user,
        interval: Number(interval),
        samples: uuids.map((u) => ({ uuid: u })),
      });

      // 5. Start experiment
      await startExperiment(expName.trim());

      // 6. Save config to data service
      await saveConfig(expName.trim(), {
        experiment: expName.trim(),
        interval: Number(interval),
        samples: sampleRows.map((r) => ({
          device: r.device,
          channel: r.channel,
          name: r.sampleName,
          ...r.meta,
        })),
      });

      setFormStatus('success');
      onViewLive(expName.trim());
    } catch (err) {
      setFormStatus(`error:${err.message}`);
    }
  };

  const stdCurves = goConfig?.standard_curves
    ? goConfig.standard_curves.map((sc) => sc.name)
    : [];
  const users = goConfig?.users || [];

  const isSubmitting = formStatus === 'submitting';

  return (
    <>
      <StatusBanner
        runningExp={runningExp}
        onViewLive={onViewLive}
        onStop={handleStop}
      />

      <div className="two-col">
        {/* Left: experiment definition form */}
        <div className="card">
          <p className="section-header">New Experiment</p>
          <form onSubmit={handleSubmit}>
            <div className="form-row" style={{ flexWrap: 'wrap' }}>
              <div className="form-field" style={{ flex: '1 1 180px' }}>
                <label>Experiment Name</label>
                <input
                  type="text"
                  value={expName}
                  onChange={(e) => setExpName(e.target.value)}
                  placeholder="e.g. exp_2026_06_10"
                  disabled={isSubmitting}
                />
              </div>
              <div className="form-field" style={{ flex: '0 1 140px' }}>
                <label>User</label>
                <select
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  disabled={isSubmitting}
                >
                  {users.length === 0 && <option value="">—</option>}
                  {users.map((u) => (
                    <option key={u.name} value={u.name}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field" style={{ flex: '0 1 110px' }}>
                <label>Interval (s)</label>
                <input
                  type="number"
                  value={interval}
                  min={1}
                  onChange={(e) => setInterval_(e.target.value)}
                  disabled={isSubmitting}
                />
              </div>
            </div>

            <hr className="divider" />
            <p className="section-header">Samples</p>
            <SampleSheet
              devices={devices}
              stdCurves={stdCurves}
              rows={sampleRows}
              onChange={setSampleRows}
            />

            <div
              style={{
                marginTop: 16,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <button
                type="submit"
                className="btn btn-create"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Creating…' : 'Create & Start'}
              </button>
              {runningExp && (
                <span className="form-hint">
                  Stops any running experiment first
                </span>
              )}
            </div>

            {formStatus && formStatus !== 'submitting' && (
              <p
                className={`form-status ${
                  formStatus.startsWith('error') ? 'error' : 'success'
                }`}
              >
                {formStatus.startsWith('error:')
                  ? formStatus.slice(6)
                  : 'Experiment started successfully'}
              </p>
            )}
          </form>
        </div>

        {/* Right: past experiments */}
        <div className="card">
          <p className="section-header">Past Experiments</p>
          <PastExperiments
            localExps={localExps}
            goExps={experiments}
            onViewLive={onViewLive}
          />
        </div>
      </div>
    </>
  );
}
