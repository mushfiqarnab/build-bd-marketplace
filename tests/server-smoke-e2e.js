// tests/server-smoke-e2e.js
// Boots the REAL server.js (all middleware, routes and workers) on a random port against
// MONGODB_URI, then checks the things a host and real users hit first:
//   - health probes are never rate-limited (a host polls them every few seconds)
//   - readiness reports MongoDB connected
//   - the portal and static files load and are not rate-limited
//   - protected API routes answer 401 (not 500), even with an injection-style query
//   - a crash makes the process exit with code 1, never 0 (otherwise hosts and this test
//     runner would treat a crashed server as a clean stop)
'use strict';

process.env.PORT = '0'; // must be set BEFORE server.js is required

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const mongoose = require('mongoose');

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function waitFor(predicate, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let ok = false;
      try { ok = predicate(); } catch (err) { clearInterval(timer); reject(err); return; }
      if (ok) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`timed out waiting for ${label}`)); }
    }, 50);
  });
}

// Boots server.js in a CHILD process, throws an uncaught error once it listens, and
// resolves with the child's exit code (or 'timeout').
function crashExitCode() {
  const script = [
    "process.env.PORT = '0';",
    "const { server } = require('./server');",
    "server.on('listening', () => setTimeout(() => { throw new Error('smoke-test deliberate crash'); }, 300));"
  ].join(' ');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), env: process.env, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 30000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

async function main() {
  console.log('🧪 server.js smoke test (real middleware stack)');
  const { server } = require('../server');
  await waitFor(() => server.listening, 'the HTTP server to listen', 15000);
  await waitFor(() => mongoose.connection.readyState === 1, 'MongoDB to connect', 20000);
  const port = server.address().port;
  console.log(`  server listening on port ${port}`);

  // 1. Health probes are never throttled
  let liveness200 = 0;
  let liveness429 = 0;
  for (let i = 0; i < 150; i++) {
    const r = await get(port, '/health/liveness');
    if (r.status === 200) liveness200 += 1;
    if (r.status === 429) liveness429 += 1;
  }
  check('150 rapid liveness probes all return 200 (no 429)', liveness200 === 150, `200=${liveness200} 429=${liveness429}`);

  const ready = await get(port, '/health/readiness');
  let readyBody = {};
  try { readyBody = JSON.parse(ready.body); } catch (_) { /* checked below */ }
  check('readiness returns 200', ready.status === 200, `status=${ready.status} body=${ready.body.slice(0, 200)}`);
  check('readiness reports MongoDB connected', readyBody.checks && readyBody.checks.mongodb === 'connected', ready.body.slice(0, 200));
  check('readiness includes redisTelemetry', Object.prototype.hasOwnProperty.call(readyBody, 'redisTelemetry'), ready.body.slice(0, 200));

  // 2. Portal and static files load and are not throttled
  const home = await get(port, '/');
  check('GET / returns 200', home.status === 200, `status=${home.status}`);
  check('GET / is HTML', String(home.headers['content-type'] || '').includes('text/html'), String(home.headers['content-type']));
  check('GET / is the Build BD portal', home.body.includes('Build BD Marketplace'), home.body.slice(0, 120));
  let static200 = 0;
  for (let i = 0; i < 120; i++) {
    const r = await get(port, '/index.html');
    if (r.status === 200) static200 += 1;
  }
  check('120 rapid static file requests all return 200', static200 === 120, `200=${static200}`);

  // 3. Protected API answers 401, never 500
  const noToken = await get(port, '/api/projects/open');
  check('protected route without a token returns 401', noToken.status === 401, `status=${noToken.status} body=${noToken.body.slice(0, 160)}`);
  const injected = await get(port, '/api/projects/open?$where=sleep(100)&category=Painting');
  check('injection-style query on a protected route returns 401, not 500', injected.status === 401, `status=${injected.status} body=${injected.body.slice(0, 160)}`);
  const badToken = await get(port, '/api/projects/open', { Authorization: 'Bearer not-a-real-token' });
  check('invalid token returns 401', badToken.status === 401, `status=${badToken.status}`);

  // 4. A crash exits with code 1
  const code = await crashExitCode();
  check('an uncaught exception makes the server exit with code 1', code === 1, `exit code=${code}`);

  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('💥 server-smoke crashed:', err);
  process.exit(1);
});
