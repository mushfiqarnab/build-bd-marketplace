// Login / sign-up: phone → 6-digit code → session cookie.
import { initShell } from '../shell.js';
import { post, ApiError } from '../api.js';
import { t, applyLang } from '../i18n.js';
import { normalizeBdPhone, bengaliToAscii } from '../phone.js';
import { getMe, homeFor, safeNext } from '../session.js';

const RESEND_SECONDS = 60;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let phone = null;
let resendTimer = null;
let deliveryMode = null;
// Guards against double-submission beyond the button's `disabled` state —
// pressing Enter in a focused field fires the form submit event even while
// the primary button is disabled.
let submitting = false;

function showAlert(kind, text) {
  const box = $('alert');
  box.replaceChildren();
  if (!text) { box.hidden = true; return; }
  const div = document.createElement('div');
  div.className = kind === 'error' ? 'alert-error' : kind === 'success' ? 'alert-success' : 'alert-info';
  const icon = document.createElement('span');
  icon.className = 'icon text-[20px]';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = kind === 'error' ? 'error' : kind === 'success' ? 'check_circle' : 'info';
  const msg = document.createElement('span');
  msg.textContent = text;
  div.append(icon, msg);
  box.append(div);
  box.hidden = false;
}

function fieldError(id, text) {
  const el = $(id);
  el.textContent = text || '';
  el.hidden = !text;
  const input = id === 'phone-error' ? $('phone') : $('code');
  if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
}

function busy(btn, on, labelKey) {
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
  const label = btn.querySelector('[data-i18n]');
  if (label) label.textContent = t(on ? labelKey : label.dataset.i18n);
}

/** Maps backend/transport errors to one clear, translated sentence. */
function messageFor(err, stage) {
  if (!(err instanceof ApiError)) return t('err.generic');
  if (err.status === 0) return t(err.message === 'timeout' ? 'err.timeout' : 'err.offline');
  if (err.status === 403 && /invite-only/i.test(err.message)) return t('err.inviteOnly');
  if (err.status === 503) return t('err.unavailable');
  if (err.status === 429) return stage === 'verify' && /incorrect codes/i.test(err.message) ? t('err.tooManyCodes') : t('err.rateLimited');
  if (stage === 'verify' && err.status === 401) {
    const left = (err.message.match(/(\d+)\s+attempt/) || [])[1];
    if (left) return t('err.codeWrong', { left });
    return t('err.codeExpired');
  }
  if (stage === 'send' && err.status === 400) return t('login.phone.invalid');
  return t('err.generic');
}

function startResendCountdown() {
  clearInterval(resendTimer);
  let left = RESEND_SECONDS;
  const btn = $('resend-btn');
  const label = $('resend-label');
  btn.disabled = true;
  label.textContent = t('login.resendIn', { s: left });
  resendTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(resendTimer);
      btn.disabled = false;
      label.textContent = t('login.resend');
    } else {
      label.textContent = t('login.resendIn', { s: left });
    }
  }, 1000);
}

function showCodeStep(debugOtp) {
  $('phone-form').hidden = true;
  $('code-form').hidden = false;
  const sentTo = $('sent-to');
  sentTo.replaceChildren();
  if (debugOtp) {
    const strong = document.createElement('strong');
    strong.textContent = t('login.code.sentTo', { phone });
    const badge = document.createElement('span');
    badge.className = 'inline-block mt-1 text-money-fill font-bold text-body-md';
    badge.textContent = ` 🔑 Verification Code: ${debugOtp}`;
    sentTo.append(strong, document.createElement('br'), badge);
    $('code').value = debugOtp;
  } else {
    sentTo.textContent = `${t('login.code.sentTo', { phone })}${deliveryMode === 'operator' ? ` ${t('login.code.operator')}` : ''}`;
  }
  $('code').focus();
  startResendCountdown();
}

async function sendCode() {
  if (submitting) return;
  submitting = true;
  showAlert(null);
  const body = { phoneNumber: phone };
  const btn = $('send-btn');
  busy(btn, true, 'login.sending');
  try {
    const res = await post('/auth/send-otp', body);
    deliveryMode = res && res.delivery;
    showCodeStep(res && res.debugOtp);
    if (res && res.debugOtp) {
      showAlert('info', `OTP code: ${res.debugOtp}`);
    }
  } catch (err) {
    showAlert('error', messageFor(err, 'send'));
  } finally {
    busy(btn, false);
    submitting = false;
  }
}

// The field sits after a fixed "+880" label, so tidy whatever was typed
// (01…, +880…, spaces, dashes, Bengali digits) into the 10-digit 1XXXXXXXXX
// form when the user leaves it — the leading 0 is dropped after +880.
$('phone').addEventListener('blur', () => {
  const n = normalizeBdPhone($('phone').value);
  if (n) { $('phone').value = n.slice(1); fieldError('phone-error', ''); }
});

$('phone-form').addEventListener('submit', (e) => {
  e.preventDefault();
  phone = normalizeBdPhone($('phone').value);
  if (!phone) { fieldError('phone-error', t('login.phone.invalid')); $('phone').focus(); return; }
  $('phone').value = phone.slice(1);
  fieldError('phone-error', '');
  sendCode();
});

$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitting) return;
  submitting = true;
  showAlert(null);
  // Accept Bengali OR ASCII digits; strip everything else, keep 6 digits.
  const code = bengaliToAscii($('code').value).replace(/\D/g, '');
  if (code.length !== 6) {
    fieldError('code-error', t('login.code.invalid'));
    $('code').focus();
    submitting = false;
    return;
  }
  fieldError('code-error', '');
  const btn = $('verify-btn');
  busy(btn, true, 'login.verifying');
  try {
    await post('/auth/verify-otp', { phoneNumber: phone, otp: code });
    clearInterval(resendTimer);
    showAlert('success', t('login.success'));
    const me = await getMe({ refresh: true });
    const postLoginDest = sessionStorage.getItem('postLoginDest');
    sessionStorage.removeItem('postLoginDest');
    const dest = safeNext(params.get('next')) || safeNext(postLoginDest);
    const roleHint = (params.get('role') || '').trim().toUpperCase();
    const validRoleHint = ['CLIENT', 'CONTRACTOR', 'SUPPLIER'].includes(roleHint) ? roleHint : '';

    if (me && me.role === 'PENDING_ONBOARDING') {
      const obParams = new URLSearchParams();
      if (dest) obParams.set('next', dest);
      if (validRoleHint) obParams.set('role', validRoleHint);
      const obQs = obParams.toString();
      location.replace(`/app/onboarding.html${obQs ? `?${obQs}` : ''}`);
      return;
    }
    if (me && me.role === 'CONTRACTOR' && me.hasProfile === false) {
      location.replace(dest ? `/app/contractor-profile.html?next=${encodeURIComponent(dest)}&prompt=register_first` : '/app/contractor-profile.html');
      return;
    }
    location.replace(dest || homeFor(me));
  } catch (err) {
    showAlert('error', messageFor(err, 'verify'));
    $('code').select();
    busy(btn, false);
    submitting = false;
  }
});

$('resend-btn').addEventListener('click', () => { if (phone) sendCode(); });
$('change-btn').addEventListener('click', () => {
  clearInterval(resendTimer);
  showAlert(null);
  $('code-form').hidden = true;
  $('phone-form').hidden = false;
  $('phone').focus();
});

// Re-render dynamic text when the language changes.
document.addEventListener('langchange', () => {
  applyLang();
  if (!$('code-form').hidden && phone) $('sent-to').textContent = `${t('login.code.sentTo', { phone })}${deliveryMode === 'operator' ? ` ${t('login.code.operator')}` : ''}`;
});

(async () => {
  const me = await initShell();
  if (me) {
    const dest = safeNext(params.get('next'));
    const roleHint = (params.get('role') || '').trim().toUpperCase();
    const validRoleHint = ['CLIENT', 'CONTRACTOR', 'SUPPLIER'].includes(roleHint) ? roleHint : '';
    if (me.role === 'PENDING_ONBOARDING') {
      const obParams = new URLSearchParams();
      if (dest) obParams.set('next', dest);
      if (validRoleHint) obParams.set('role', validRoleHint);
      const obQs = obParams.toString();
      location.replace(`/app/onboarding.html${obQs ? `?${obQs}` : ''}`);
      return;
    }
    location.replace(dest || homeFor(me));
    return;
  }
})();
