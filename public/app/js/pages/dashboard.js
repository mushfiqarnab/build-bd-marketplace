import { initShell } from '../shell.js';
import { requireAuth } from '../session.js';
import { ApiError } from '../api.js';
import { t } from '../i18n.js';

const ROLE_KEY = { CLIENT: 'role.client', CONTRACTOR: 'role.contractor', ADMIN: 'role.admin', MODERATOR: 'role.moderator' };

/** The right error key for the error at hand; defaults to "something went
 *  wrong" rather than mislabeling a 500 as "offline". */
function errorKeyFor(err) {
  if (err instanceof ApiError) {
    if (err.status === 0) return err.message === 'timeout' ? 'err.timeout' : 'err.offline';
    if (err.status === 429) return 'err.rateLimited';
    if (err.status === 503) return 'err.unavailable';
  }
  return 'err.generic';
}

(async () => {
  try {
    await initShell();
    const me = await requireAuth();
    document.getElementById('who').textContent = `${me.phoneNumber} · ${t(ROLE_KEY[me.role] || me.role)}`;
    document.getElementById('loading').hidden = true;
    document.getElementById('content').hidden = false;
  } catch (err) {
    document.getElementById('loading').hidden = true;
    const el = document.getElementById('error');
    el.textContent = t(errorKeyFor(err));
    el.hidden = false;
  }
})();
