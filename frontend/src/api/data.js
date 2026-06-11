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
 */
export function getGrowthRates(name) {
  return request('GET', `/svc/growth-rates/${encodeURIComponent(name)}`);
}
