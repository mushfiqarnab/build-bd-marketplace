// frontend/js/session.js — who is signed in (from GET /api/auth/me, since the
// httpOnly cookie is invisible to JS) and page-level access control.
import { get, post, ApiError } from './api.js';

let cached;

/** Resolves to the user object, or null when nobody is signed in. */
export async function getMe({ refresh = false } = {}) {
  if (cached !== undefined && !refresh) return cached;
  try {
    const data = await get('/auth/me');
    cached = data && data.user ? data.user : null;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) cached = null;
    else throw err; // offline etc. — let the page show its error state
  }
  return cached;
}

const HOME_BY_ROLE = {
  CLIENT: '/app/dashboard.html',
  CONTRACTOR: '/app/dashboard.html',
  ADMIN: '/app/dashboard.html',
  MODERATOR: '/app/dashboard.html'
};

export function homeFor(user) {
  return (user && HOME_BY_ROLE[user.role]) || '/app/';
}

/** Only same-origin /app/ paths are accepted as a post-login destination. */
export function safeNext(raw) {
  if (typeof raw !== 'string') return null;
  return /^\/app\/[\w\-./?=&%]*$/.test(raw) && !raw.includes('//') ? raw : null;
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
