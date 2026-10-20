// frontend/js/api.js — the only way pages talk to the backend.
// - Session = httpOnly same-origin cookie; no token ever touches JS storage.
// - X-Requested-With satisfies the server's CSRF guard on mutations.
// - Money-moving calls pass an idempotency key that is REUSED across retries,
//   so a network blip can never double-submit.
// - Every failure becomes an ApiError with a status the UI can branch on
//   (0 = offline / network, 401 = signed out, 429 = rate limited, ...).

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body || null;
  }
}

export function newIdempotencyKey() {
  return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${crypto.getRandomValues(new Uint32Array(4)).join('-')}`;
}

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * @param {string} method
 * @param {string} path            path under /api, e.g. '/auth/me'
 * @param {object} [opts]
 * @param {object} [opts.body]
 * @param {string} [opts.idempotencyKey]  reuse the same key when retrying
 * @param {number} [opts.timeoutMs]
 */
export async function api(method, path, { body, idempotencyKey, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const headers = { Accept: 'application/json', 'X-Requested-With': 'fetch' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    throw new ApiError(0, err && err.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!res.ok) {
    const message = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    throw new ApiError(res.status, message, data);
  }
  return data;
}

export const get = (path, opts) => api('GET', path, opts);
export const post = (path, body, opts = {}) => api('POST', path, { ...opts, body });
export const put = (path, body, opts = {}) => api('PUT', path, { ...opts, body });
export const patch = (path, body, opts = {}) => api('PATCH', path, { ...opts, body });
export const del = (path, opts) => api('DELETE', path, opts);

/**
 * Direct-to-storage presigned upload helper (zero-RAM architecture).
 * Handles both S3 Pre-Signed POST (FormData) and PUT (binary body).
 */
export async function uploadPresigned(uploadUrl, { method = 'POST', headers = {}, fields = {}, file } = {}) {
  const normMethod = (method || 'POST').toUpperCase();
  if (normMethod === 'PUT') {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: headers || {},
      body: file
    });
    if (!res.ok) {
      throw new ApiError(res.status, `Storage upload failed with HTTP ${res.status}`);
    }
    return res;
  }
  const formData = new FormData();
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      formData.append(k, v);
    }
  }
  formData.append('file', file);
  const res = await fetch(uploadUrl, {
    method: 'POST',
    body: formData
  });
  if (!res.ok) {
    throw new ApiError(res.status, `Storage upload failed with HTTP ${res.status}`);
  }
  return res;
}


