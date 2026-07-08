/**
 * API client for the FastAPI data service (proxied at /svc/ in dev).
 */

async function request(method, path, body) {
  const opts = {
    method,
    headers: {},
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = '';
    try {
      const text = await res.text();
      detail = text ? ` — ${text}` : '';
    } catch (_) {}
    throw new Error(`${method} ${path} → ${res.status}${detail}`);
  }
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

/** GET /svc/experiments */
export function listExperiments() {
  return request('GET', '/svc/experiments');
}

/** GET /svc/configs — experiments that have a saved config YAML */
export function listConfigs() {
  return request('GET', '/svc/configs');
}

/**
 * GET /svc/data/{name}?max_points={maxPoints}
 * @param {string} name
 * @param {number} maxPoints
 */
export function getExperimentData(name, maxPoints = 500) {
  const params = new URLSearchParams({ max_points: String(maxPoints) });
  return request('GET', `/svc/data/${encodeURIComponent(name)}?${params}`);
}

/**
 * GET /svc/config/{name}
 */
export function getConfig(name) {
  return request('GET', `/svc/config/${encodeURIComponent(name)}`);
}

/**
 * POST /svc/config/{name}
 * @param {string} name
 * @param {object} config
 */
export function saveConfig(name, config) {
  return request('POST', `/svc/config/${encodeURIComponent(name)}`, config);
}

/**
 * GET /svc/growth-rates/{name}
 * Returns cached data and status; never triggers computation.
 */
export function getGrowthRates(name) {
  return request('GET', `/svc/growth-rates/${encodeURIComponent(name)}`);
}

/**
 * POST /svc/growth-rates/{name}/compute
 * Manually trigger growth-rate computation.
 * @param {string} name
 * @param {number|null} startMin  — if set, only data at t_min >= startMin is used
 */
export function computeGrowthRates(name, startMin = null) {
  const qs = startMin != null ? `?t_start=${encodeURIComponent(startMin)}` : '';
  return request('POST', `/svc/growth-rates/${encodeURIComponent(name)}/compute${qs}`);
}
