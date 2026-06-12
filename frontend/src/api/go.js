/**
 * API client for the Go server (proxied at /api/ in dev, same origin in prod).
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
  // Go serializes NaN as a bare NaN token (invalid JSON); replace with null.
  return JSON.parse(text.replace(/\bNaN\b/g, 'null'));
}

/** GET /api/config/ */
export function getConfig() {
  return request('GET', '/api/config/');
}

/** GET /api/device/ */
export function getDevices() {
  return request('GET', '/api/device/');
}

/** GET /api/sample/ */
export function getSamples() {
  return request('GET', '/api/sample/');
}

/**
 * GET /api/acqusition/
 * Note: typo is intentional — matches the server route.
 */
export function getExperiments() {
  return request('GET', '/api/acqusition/');
}

/**
 * POST /api/sample/
 * @param {Array<{device: string, channel: number, name: string, standard_curve_name: string, metadata: object, user: string}>} rows
 */
export function createSamples(rows) {
  return request('POST', '/api/sample/', rows);
}

/**
 * DELETE /api/sample/
 * @param {Array<{device: string, channel: number}>} rows
 */
export function deleteSamples(rows) {
  return request('DELETE', '/api/sample/', rows);
}

/**
 * POST /api/acqusition/
 * @param {{name: string, user: string, interval: number, samples: Array<{uuid: string}>}} params
 */
export function createExperiment({ name, user, interval, samples }) {
  return request('POST', '/api/acqusition/', { name, user, interval, samples });
}

/**
 * GET /api/acqusition/{name}/start/
 */
export function startExperiment(name) {
  return request('GET', `/api/acqusition/${encodeURIComponent(name)}/start/`);
}

/**
 * GET /api/acqusition/{name}/stop/
 */
export function stopExperiment(name) {
  return request('GET', `/api/acqusition/${encodeURIComponent(name)}/stop/`);
}

/**
 * GET /api/acqusition/{name}/close/
 */
export function closeExperiment(name) {
  return request('GET', `/api/acqusition/${encodeURIComponent(name)}/close/`);
}
