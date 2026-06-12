import React, { useState, useCallback } from 'react';

const DEFAULT_META_COLS = ['strain', 'condition', 'replicate', 'group', 'std_curve'];

/**
 * SampleSheet — spreadsheet-style sample editor.
 *
 * Props:
 *   devices    [{label: string, channels: [{channel: number, enabled: bool}]}]
 *   stdCurves  [string]
 *   rows       [{id, device, channel, sampleName, meta: {...}}]
 *   onChange   (newRows) => void
 */
export default function SampleSheet({ devices = [], stdCurves = [], rows, onChange }) {
  const [advOpen, setAdvOpen] = useState(false);
  const [activeCols, setActiveCols] = useState(new Set(DEFAULT_META_COLS));
  const [customCols, setCustomCols] = useState([]);
  const [newColName, setNewColName] = useState('');

  const allMetaCols = [...DEFAULT_META_COLS, ...customCols];
  const visibleMetaCols = allMetaCols.filter((c) => activeCols.has(c));

  const updateRow = useCallback(
    (id, patch) => {
      onChange(
        rows.map((r) => {
          if (r.id !== id) return r;
          const updated = { ...r, ...patch };
          // If device changed, reset channel
          if (patch.device !== undefined && patch.device !== r.device) {
            const dev = devices.find((d) => d.label === patch.device);
            const firstCh = dev?.channels?.[0]?.channel ?? 1;
            updated.channel = firstCh;
          }
          return updated;
        })
      );
    },
    [rows, onChange, devices]
  );

  const updateMeta = useCallback(
    (id, key, value) => {
      onChange(
        rows.map((r) => (r.id === id ? { ...r, meta: { ...r.meta, [key]: value } } : r))
      );
    },
    [rows, onChange]
  );

  const addRow = useCallback(() => {
    const defaultDevice = devices[0]?.label ?? '';
    const defaultChannel = devices[0]?.channels?.[0]?.channel ?? 1;
    const meta = {};
    allMetaCols.forEach((c) => (meta[c] = ''));
    onChange([
      ...rows,
      {
        id: `row-${Date.now()}-${Math.random()}`,
        device: defaultDevice,
        channel: defaultChannel,
        sampleName: '',
        meta,
      },
    ]);
  }, [rows, onChange, devices, allMetaCols]);

  const deleteRow = useCallback(
    (id) => onChange(rows.filter((r) => r.id !== id)),
    [rows, onChange]
  );

  const toggleCol = (col) => {
    setActiveCols((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  const addCustomCol = () => {
    const name = newColName.trim().toLowerCase().replace(/\s+/g, '_');
    if (!name || allMetaCols.includes(name)) return;
    setCustomCols((prev) => [...prev, name]);
    setActiveCols((prev) => new Set([...prev, name]));
    // Add blank value to all existing rows
    onChange(rows.map((r) => ({ ...r, meta: { ...r.meta, [name]: '' } })));
    setNewColName('');
  };

  const getChannelOptions = (deviceLabel) => {
    const dev = devices.find((d) => d.label === deviceLabel);
    if (!dev || !dev.channels || dev.channels.length === 0) {
      return Array.from({ length: 8 }, (_, i) => i + 1);
    }
    // Go sets enabled:true when a sample is assigned, enabled:false when free.
    // Show all channels; the submit flow handles any conflicts.
    return dev.channels.map((c) => c.channel);
  };

  // Build YAML preview
  const yamlLines = [
    'samples:',
    ...rows.map((r, i) => {
      const lines = [
        `  - device: ${r.device || '""'}`,
        `    channel: ${r.channel}`,
        `    name: ${r.sampleName || '""'}`,
      ];
      Object.entries(r.meta).forEach(([k, v]) => {
        if (v) lines.push(`    ${k}: ${v}`);
      });
      return lines.join('\n');
    }),
  ];
  const yamlText = yamlLines.join('\n');

  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table className="sheet">
          <thead>
            <tr>
              <th className="rn">#</th>
              <th>Device</th>
              <th>Channel</th>
              <th>Sample Name</th>
              {visibleMetaCols.map((col) => (
                <th key={col}>{col.replace(/_/g, ' ')}</th>
              ))}
              <th style={{ width: 32 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={4 + visibleMetaCols.length + 1}
                  style={{ padding: '12px 10px', fontSize: 12 }}
                  className="empty-state"
                >
                  No samples — click "+ Add row" to begin
                </td>
              </tr>
            ) : (
              rows.map((row, idx) => (
                <tr key={row.id}>
                  <td className="rn">
                    <span className="cell" style={{ textAlign: 'center' }}>
                      {idx + 1}
                    </span>
                  </td>
                  <td>
                    <select
                      className="cell"
                      value={row.device}
                      onChange={(e) => updateRow(row.id, { device: e.target.value })}
                    >
                      {devices.length === 0 && (
                        <option value="">No devices</option>
                      )}
                      {devices.map((d) => (
                        <option key={d.label} value={d.label}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="cell"
                      value={row.channel}
                      onChange={(e) =>
                        updateRow(row.id, { channel: Number(e.target.value) })
                      }
                    >
                      {getChannelOptions(row.device).map((ch) => (
                        <option key={ch} value={ch}>
                          {ch}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="text"
                      className="cell"
                      placeholder="sample name"
                      value={row.sampleName}
                      onChange={(e) => updateRow(row.id, { sampleName: e.target.value })}
                    />
                  </td>
                  {visibleMetaCols.map((col) =>
                    col === 'std_curve' ? (
                      <td key={col}>
                        <select
                          className="cell"
                          value={row.meta[col] ?? ''}
                          onChange={(e) => updateMeta(row.id, col, e.target.value)}
                        >
                          <option value="">— none —</option>
                          {stdCurves.map((sc) => (
                            <option key={sc} value={sc}>
                              {sc}
                            </option>
                          ))}
                        </select>
                      </td>
                    ) : (
                      <td key={col}>
                        <input
                          type="text"
                          className="cell"
                          value={row.meta[col] ?? ''}
                          onChange={(e) => updateMeta(row.id, col, e.target.value)}
                          placeholder={col}
                        />
                      </td>
                    )
                  )}
                  <td style={{ textAlign: 'center' }}>
                    <button
                      type="button"
                      className="btn-del-row"
                      onClick={() => deleteRow(row.id)}
                      title="Remove row"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <button type="button" className="btn-add-row" onClick={addRow}>
        + Add row
      </button>

      <div className="accordion">
        <div
          className="accordion-header"
          onClick={() => setAdvOpen((o) => !o)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setAdvOpen((o) => !o)}
        >
          <span className={`accordion-arrow ${advOpen ? 'open' : ''}`}>▶</span>
          Advanced — Metadata columns
        </div>
        <div className={`accordion-body ${advOpen ? 'open' : ''}`}>
          <p className="section-header" style={{ marginBottom: 8 }}>
            Toggle visible columns
          </p>
          <div className="chips-row">
            {allMetaCols.map((col) => (
              <button
                type="button"
                key={col}
                className={`chip ${activeCols.has(col) ? 'active' : ''}`}
                onClick={() => toggleCol(col)}
              >
                {col.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
          <div className="add-col-row">
            <input
              type="text"
              placeholder="new column name"
              value={newColName}
              onChange={(e) => setNewColName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCustomCol()}
            />
            <button type="button" className="btn btn-close btn-sm" onClick={addCustomCol}>
              + Add column
            </button>
          </div>
          <div className="yaml-preview">{yamlText}</div>
        </div>
      </div>
    </div>
  );
}
