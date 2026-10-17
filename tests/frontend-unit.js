// tests/frontend-unit.js — pure frontend logic, run in Node (ESM import).
//   - Bangladeshi phone normalisation (every way people type numbers)
//   - post-login redirect is restricted to same-origin /app/ paths
//   - every message key exists in both Bangla and English
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failed += 1; console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const imp = (p) => import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'js', p)).href);

(async () => {
  console.log('🧪 frontend unit');
  const { normalizeBdPhone } = await imp('phone.js');
  const ok = {
    '01712345678': '01712345678',
    '1712345678': '01712345678',
    '+8801712345678': '01712345678',
    '8801712345678': '01712345678',
    '008801712345678': '01712345678',
    '+880 1712-345678': '01712345678',
    '017 1234 5678': '01712345678',
    '(017) 1234-5678': '01712345678',
    '০১৭১২৩৪৫৬৭৮': '01712345678',
    '+৮৮০ ১৯৯৯-৯৯৯৯৯৯': '01999999999',
    '01312345678': '01312345678'
  };
  for (const [input, want] of Object.entries(ok)) check(`normalize "${input}"`, normalizeBdPhone(input) === want, normalizeBdPhone(input));
  for (const bad of ['', '12345', '01212345678', '0171234567', '017123456789', '+911712345678', 'abc', null, undefined, '01712345678x']) {
    check(`reject ${JSON.stringify(bad)}`, normalizeBdPhone(bad) === null, normalizeBdPhone(bad));
  }

  // session.js imports api.js, which only touches browser globals when called.
  const { safeNext } = await imp('session.js');
  check('safeNext allows /app/ paths', safeNext('/app/dashboard.html') === '/app/dashboard.html' && safeNext('/app/project.html?id=1') === '/app/project.html?id=1');
  for (const evil of ['https://evil.example', '//evil.example', '/app//evil.example', 'javascript:alert(1)', '/api/auth/logout', '/../app/x', null]) {
    check(`safeNext blocks ${JSON.stringify(evil)} (open redirect)`, safeNext(evil) === null, safeNext(evil));
  }

  // Foundation audit fix: safeNext must reject URL-encoded CR/LF via `%`.
  check('safeNext blocks %0A (encoded LF) — header injection shape', safeNext('/app/x%0Afoo') === null);
  check('safeNext blocks %0D (encoded CR)', safeNext('/app/x%0Dfoo') === null);
  check('safeNext blocks any `%` encoding', safeNext('/app/x%2fy') === null);

  // Bengali-digit helper is now exported from phone.js and used in multiple places.
  const { bengaliToAscii } = await imp('phone.js');
  check('bengaliToAscii converts Bengali digits', bengaliToAscii('০১২৩৪৫৬৭৮৯') === '0123456789');
  check('bengaliToAscii leaves ASCII and letters alone', bengaliToAscii('abc 123 ০৯৮') === 'abc 123 098');

  const { MESSAGES } = await imp('messages.js');
  const en = Object.keys(MESSAGES.en);
  const bn = Object.keys(MESSAGES.bn);
  check('every English message has a Bangla translation', en.every((k) => bn.includes(k)), en.filter((k) => !bn.includes(k)).join(', '));
  check('no Bangla-only keys', bn.every((k) => en.includes(k)), bn.filter((k) => !en.includes(k)).join(', '));
  check('no empty messages', [...Object.values(MESSAGES.en), ...Object.values(MESSAGES.bn)].every((v) => typeof v === 'string' && v.trim().length > 0));
  check('no e-GP claims in copy', !JSON.stringify(MESSAGES).match(/\be-?GP\b/));
  check('login.newHere key exists (role disclosure)', 'login.newHere' in MESSAGES.en && 'login.newHere' in MESSAGES.bn);

  // Login HTML: no more phone_iphone icon on the primary welcome, uses lock.
  const fs = require('fs');
  const loginHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pages', 'login.html'), 'utf8');
  check('login.html uses dynamic viewport (100dvh) for iOS keyboard', /min-h-\[100dvh\]/.test(loginHtml) || /min-height:100dvh/.test(loginHtml));
  check('login.html wraps role selector in <details> (not shown by default)', /<details[^>]*id="new-here"/.test(loginHtml));
  check('login.html primary icon is `lock`, not `phone_iphone`',
    /aria-hidden="true">lock</.test(loginHtml) && !/aria-hidden="true">phone_iphone</.test(loginHtml));

  // head.html: preloads Noto Sans Bengali so a BN-default user doesn't see fallback flash.
  const headHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'partials', 'head.html'), 'utf8');
  check('head.html preloads Noto Sans Bengali', /noto-sans-bengali.*\.woff2/.test(headHtml));

  // icons.txt: all F4-F8 glyphs listed so the build cannot ship with a missing icon.
  const iconList = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'icons.txt'), 'utf8');
  const F4F8_ICONS = ['upload_file', 'photo_camera', 'add_photo_alternate', 'add', 'edit', 'delete', 'filter_list', 'sort', 'chevron_right', 'event', 'place', 'map', 'timer', 'done_all', 'approval', 'assignment_turned_in', 'local_atm', 'pending', 'more_vert', 'close_small', 'visibility'];
  for (const ic of F4F8_ICONS) check(`icons.txt lists '${ic}' (F4-F8 glyph)`, new RegExp(`^${ic}$`, 'm').test(iconList));

  // i18n helpers F4-F8 depends on exist.
  const i18n = await imp('i18n.js');
  check('formatRelativeTime is exported', typeof i18n.formatRelativeTime === 'function');
  check('formatDate is exported', typeof i18n.formatDate === 'function');
  check('formatTaka handles 100000 → ৳1,00,000 (lakh grouping)',
    i18n.formatTaka(100000) === '৳1,00,000' || i18n.formatTaka(100000) === '৳১,০০,০০০');
  check('formatRelativeTime(now) is a string', typeof i18n.formatRelativeTime(new Date()) === 'string' && i18n.formatRelativeTime(new Date()).length > 0);

  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error('💥 frontend-unit crashed:', err); process.exit(1); });
