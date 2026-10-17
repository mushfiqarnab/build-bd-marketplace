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

  const { MESSAGES } = await imp('messages.js');
  const en = Object.keys(MESSAGES.en);
  const bn = Object.keys(MESSAGES.bn);
  check('every English message has a Bangla translation', en.every((k) => bn.includes(k)), en.filter((k) => !bn.includes(k)).join(', '));
  check('no Bangla-only keys', bn.every((k) => en.includes(k)), bn.filter((k) => !en.includes(k)).join(', '));
  check('no empty messages', [...Object.values(MESSAGES.en), ...Object.values(MESSAGES.bn)].every((v) => typeof v === 'string' && v.trim().length > 0));
  check('no e-GP claims in copy', !JSON.stringify(MESSAGES).match(/\be-?GP\b/));

  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error('💥 frontend-unit crashed:', err); process.exit(1); });
