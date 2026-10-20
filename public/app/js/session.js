// frontend/js/session.js — who is signed in (from GET /api/auth/me, since the
// httpOnly cookie is invisible to JS) and page-level access control.
import { get, post, ApiError } from './api.js';

let cached;
let lastFailureAt = 0;
// On a transient error (500 / 503 / network) we don't want pages to re-fetch
// /auth/me on every click, which would hammer the API under outage. We cache
// nothing but hold a cooldown; within the cooldown callers get a rejection
// from the cached error, not a fresh network trip.
let cachedError = null;
const FAILURE_COOLDOWN_MS = 10_000;

/** Resolves to the user object, or null when nobody is signed in. Throws
 *  the ApiError on transient failures (offline / 5xx) so pages can render
 *  their own error state; signed-out (401/403) is NOT an error, resolves
 *  to null and is cached. */
export async function getMe({ refresh = false } = {}) {
  if (cached !== undefined && !refresh) return cached;
  if (cachedError && Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS && !refresh) throw cachedError;
  try {
    const data = await get('/auth/me');
    cached = data && data.user ? data.user : null;
    cachedError = null;
    return cached;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      cached = null;
      cachedError = null;
      return null;
    }
    // Transient: cache the error for a short window so pages don't loop.
    cachedError = err;
    lastFailureAt = Date.now();
    throw err;
  }
}

const HOME_BY_ROLE = {
  CLIENT: '/app/dashboard.html',
  CONTRACTOR: '/app/dashboard.html',
  SUPPLIER: '/app/dashboard.html',
  ADMIN: '/app/dashboard.html',
  MODERATOR: '/app/dashboard.html'
};

export function homeFor(user) {
  return (user && HOME_BY_ROLE[user.role]) || '/app/';
}

/** Only same-origin /app/ paths are accepted as a post-login destination.
 *  Explicitly rejects `%` so URL-encoded CR/LF (%0A, %0D) can never slip
 *  through into location.replace() — defense in depth even though the
 *  browser normalises most of them. Allowed chars are a strict byte list:
 *  letters, digits, _, -, ., /, ?, =, &. */
export function safeNext(raw) {
  if (typeof raw !== 'string') return null;
  return /^\/app\/[\w\-./?=&]*$/.test(raw) && !raw.includes('//') ? raw : null;
}

/** Redirects to login (remembering where to come back) unless signed in with an allowed role. */
export async function requireAuth({ roles } = {}) {
  const me = await getMe();
  if (!me) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace(`/app/login.html?next=${next}`);
    return new Promise(() => {}); // halt the page while navigating
  }
  if (roles && !roles.includes(me.role)) {
    location.replace(homeFor(me));
    return new Promise(() => {});
  }
  return me;
}

export async function logout() {
  try { await post('/auth/logout'); } catch (_) { /* cookie may already be gone */ }
  cached = null;
  location.replace('/app/');
}
