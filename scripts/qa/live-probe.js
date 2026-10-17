// scripts/qa/live-probe.js — READ-ONLY checks against a running deployment.
//
//   node scripts/qa/live-probe.js https://endearing-suffrage-body.ngrok-free.dev
//
// Never creates data: no OTP requests, no logins, no writes. Verifies what
// users actually receive (through ngrok / a load balancer), not what the
// code intends: TLS, security headers, CORS, dependency + index readiness,
// dev pages hidden, auth enforced, no stack traces, latency.
'use strict';

const { createReport, runCli } = require('./lib');

const UA = 'BuildBD-QA-Probe/1.0';

async function req(base, path, init = {}) {
  const t0 = performance.now();
  const res = await fetch(base + path, { redirect: 'manual', ...init, headers: { 'User-Agent': UA, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* html or text */ }
  return { status: res.status, headers: res.headers, text, json, ms: performance.now() - t0 };
}

function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; }

async function run({ url } = {}) {
  const base = (url || process.argv.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/+$/, '');
  const report = createReport(`Live probe — ${base || '(no URL)'}`);
  if (!base) { report.fail('url', 'Pass the deployment URL, e.g. node scripts/qa/live-probe.js https://example'); return report; }

  // TLS
  if (base.startsWith('https://')) report.pass('tls', 'Served over HTTPS');
  else report.fail('tls', 'Deployment is not HTTPS — cookies are Secure-only in production');

  // Health + readiness (incl. index enforcement)
  const live = await req(base, '/health/liveness').catch((e) => ({ status: 0, error: e.message }));
  if (live.status === 200) report.pass('liveness', 'liveness 200');
  else { report.fail('liveness', `liveness ${live.status}`, live.error || live.text); return report; }
  const ready = await req(base, '/health/readiness');
  const checks = (ready.json && ready.json.checks) || {};
  if (ready.status === 200 && checks.mongodb === 'connected') report.pass('readiness', 'readiness 200, MongoDB connected', checks);
  else report.fail('readiness', `readiness ${ready.status}`, ready.json || ready.text.slice(0, 200));
  if (checks.redis === 'ready') report.pass('redis', 'Redis ready');
  else report.warn('redis', 'Redis degraded — idempotency falls back to MongoDB', checks.redis);
  if (checks.indexes === 'ok') report.pass('indexes', 'All integrity indexes present');
  else if (checks.indexes) report.fail('indexes', `Index state: ${checks.indexes}`);
  else report.warn('indexes', 'Readiness does not report index state (not production mode?)');
  if (ready.json && ready.json.redisTelemetry && /memory|keys/i.test(JSON.stringify(ready.json.redisTelemetry))) {
    report.warn('readiness-disclosure', 'Readiness exposes Redis telemetry to anonymous callers', Object.keys(ready.json.redisTelemetry));
  }

  // Environment endpoint
  const env = await req(base, '/api/environment');
  const mode = env.json && env.json.data && env.json.data.mode;
  if (mode === 'production') report.pass('mode', 'Running in production mode');
  else report.fail('mode', `Not production mode (${mode})`);

  // Security headers on the portal
  const home = await req(base, '/');
  const h = (n) => home.headers.get(n);
  const hsts = h('strict-transport-security') || '';
  if (/max-age=(\d+)/.test(hsts) && Number(hsts.match(/max-age=(\d+)/)[1]) >= 15552000) report.pass('hsts', `HSTS ${hsts}`);
  else report.fail('hsts', 'HSTS missing or shorter than 180 days', hsts);
  const csp = h('content-security-policy') || '';
  if (csp.includes("default-src 'self'")) report.pass('csp', 'CSP default-src self');
  else report.fail('csp', 'CSP missing or permissive', csp.slice(0, 200));
  if (/script-src[^;]*'unsafe-inline'/.test(csp)) report.warn('csp-inline', "CSP allows 'unsafe-inline' scripts (needed by the legacy portal; remove with the new frontend)");
  if ((h('x-frame-options') || '').toUpperCase() === 'DENY' || /frame-ancestors 'none'/.test(csp)) report.pass('clickjacking', 'Framing denied');
  else report.fail('clickjacking', 'Page can be framed (clickjacking)');
  if ((h('x-content-type-options') || '') === 'nosniff') report.pass('nosniff', 'X-Content-Type-Options: nosniff');
  else report.fail('nosniff', 'X-Content-Type-Options missing');
  if (!h('x-powered-by')) report.pass('x-powered-by', 'No X-Powered-By fingerprint');
  else report.fail('x-powered-by', `X-Powered-By: ${h('x-powered-by')}`);
  if (h('referrer-policy')) report.pass('referrer-policy', `Referrer-Policy: ${h('referrer-policy')}`);
  else report.warn('referrer-policy', 'No Referrer-Policy header');
  if (/gzip|br/.test(home.headers.get('content-encoding') || '') || home.text.length < 1024) report.info('compression', `content-encoding: ${home.headers.get('content-encoding') || 'none'}`);

  // Branding / claims on the public page
  if (/\be-?GP\b/.test(home.text)) report.fail('egp-claim', 'Public page mentions e-GP (removed by product decision)');
  else report.pass('egp-claim', 'No e-GP claims on the public page');

  // CORS: a foreign origin must not be granted
  const cors = await req(base, '/api/environment', { headers: { Origin: 'https://evil.example' } });
  const acao = cors.headers.get('access-control-allow-origin');
  if (!acao || (acao !== '*' && acao !== 'https://evil.example')) report.pass('cors', `Foreign origin not granted (ACAO=${acao || 'none'})`);
  else report.fail('cors', `Foreign origin granted: ACAO=${acao}`);

  // Dev-only pages hidden in production
  for (const page of ['/test-client.html', '/evidence-sandbox.html', '/project-wizard.html']) {
    const r = await req(base, page);
    if (r.status === 404) report.pass(`dev-page:${page}`, 'hidden (404)');
    else report.fail(`dev-page:${page}`, `dev-only page served (${r.status})`);
  }

  // Auth enforced, no stack traces, consistent JSON errors
  for (const p of ['/api/auth/me', '/api/projects/mine', '/api/bids/mine', '/api/projects/open']) {
    const r = await req(base, p);
    if (r.status === 401) report.pass(`auth:${p}`, '401 without a session');
    else report.fail(`auth:${p}`, `expected 401, got ${r.status}`, r.text.slice(0, 200));
  }
  const forged = await req(base, '/api/auth/me', { headers: { Cookie: 'bb_session=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4In0.forged' } });
  if (forged.status === 401) report.pass('forged-cookie', 'Forged session cookie rejected');
  else report.fail('forged-cookie', `Forged session cookie got ${forged.status}`);
  const junk = await req(base, '/api/projects/%7B%22%24gt%22%3A%22%22%7D', { headers: { Authorization: 'Bearer not.a.jwt' } });
  if (!/at\s+\S+\s+\(|node_modules|\\routes\\|\/routes\//.test(junk.text)) report.pass('no-stack-leak', 'Error responses carry no stack traces or paths');
  else report.fail('no-stack-leak', 'Error response leaks stack/paths', junk.text.slice(0, 300));
  const unknown = await req(base, '/api/does-not-exist');
  if (unknown.status === 404) report.pass('unknown-route', 'Unknown API route → 404');
  else report.warn('unknown-route', `Unknown API route → ${unknown.status}`);

  // Payments kill-switch state (POST without auth: 503 if off, 401 if on — no writes either way)
  const pay = await req(base, '/api/payment/initiate/000000000000000000000000', { method: 'POST' });
  if (pay.status === 503) report.info('payments', 'Payments switched OFF (kill switch)');
  else if (pay.status === 401) report.info('payments', 'Payments switched ON (auth required)');
  else report.warn('payments', `Unexpected payment endpoint status ${pay.status}`);

  // Rate-limit headers advertised on the API
  if (env.headers.get('ratelimit') || env.headers.get('ratelimit-policy')) report.pass('ratelimit-headers', 'Rate-limit headers present');
  else report.warn('ratelimit-headers', 'No rate-limit headers on /api responses');

  // Latency (sequential, through the real network path)
  const samples = [];
  for (let i = 0; i < 20; i += 1) samples.push((await req(base, '/health/liveness')).ms);
  samples.sort((a, b) => a - b);
  const p50 = pct(samples, 0.5);
  const p95 = pct(samples, 0.95);
  const detail = { p50_ms: Math.round(p50), p95_ms: Math.round(p95), max_ms: Math.round(samples[samples.length - 1]) };
  if (p95 < 1500) report.pass('latency', `liveness p50 ${detail.p50_ms}ms, p95 ${detail.p95_ms}ms`, detail);
  else report.warn('latency', `slow: p95 ${detail.p95_ms}ms`, detail);

  return report;
}

module.exports = { run };
if (require.main === module) runCli(run);
