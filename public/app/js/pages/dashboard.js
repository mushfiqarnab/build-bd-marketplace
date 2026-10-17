import { initShell } from '../shell.js';
import { requireAuth } from '../session.js';
import { t } from '../i18n.js';

const ROLE_KEY = { CLIENT: 'role.client', CONTRACTOR: 'role.contractor', ADMIN: 'role.admin', MODERATOR: 'role.moderator' };

(async () => {
  try {
    await initShell();
    const me = await requireAuth();
    document.getElementById('who').textContent = `${me.phoneNumber} · ${t(ROLE_KEY[me.role] || me.role)}`;
    document.getElementById('loading').hidden = true;
    document.getElementById('content').hidden = false;
  } catch (_) {
    document.getElementById('loading').hidden = true;
    const el = document.getElementById('error');
    el.textContent = t('err.offline');
    el.hidden = false;
  }
})();
