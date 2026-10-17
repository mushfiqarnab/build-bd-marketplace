// scripts/qa/load-test.js — measured capacity, not guesses.
//
//   node scripts/qa/load-test.js [--connections 100] [--duration 15]
//
// Boots the REAL server (NODE_ENV=production: compression, logging, auth,
// index gate) as a child process against a local in-memory MongoDB replica
// set seeded with 300 open projects, then drives concurrent load with
// autocannon. Loopback traffic bypasses the per-IP rate limiter, so this
// measures raw application capacity on THIS machine. A free-tier deployment
// (Atlas M0, ngrok free, one home PC) is limited by those services first.
'use strict';

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const autocannon = require('autocannon');
const { createReport, runCli } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

async function waitReady(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(`${url}/health/readiness`); if (r.status === 200) return true; } catch (_) { /* booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function cannon(opts) {
  return new Promise((resolve, reject) => {
    const inst = autocannon(opts, (err, res) => (err ? reject(err) : resolve(res)));
    autocannon.track(inst, { renderProgressBar: false, renderResultsTable: false, renderLatencyTable: false });
  });
}

async function run() {
  const report = createReport('Load test (local, production mode)');
  const connections = arg('connections', 100);
  const duration = arg('duration', 15);
  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  const mongoose = require('mongoose');

  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = rs.getUri('buildbd_load');
  const secret = crypto.randomBytes(48).toString('hex');
  let child;
  try {
    // Seed users + projects directly.
    await mongoose.connect(uri);
    for (const f of require('fs').readdirSync(path.join(ROOT, 'models')).filter((x) => x.endsWith('.js'))) require(path.join(ROOT, 'models', f));
    const User = mongoose.model('User');
    const Project = mongoose.model('Project');
    await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes()));
    const client = await User.create({ phoneNumber: '01700000001', role: 'CLIENT', status: 'ACTIVE' });
    const contractor = await User.create({ phoneNumber: '01700000002', role: 'CONTRACTOR', status: 'ACTIVE' });
    await User.create({ phoneNumber: '01700000000', role: 'ADMIN', status: 'ACTIVE' });
    const cats = ['Residential', 'Commercial', 'Infrastructure', 'Interior', 'Renovation'];
    await Project.insertMany(Array.from({ length: 300 }, (_, i) => ({
      clientId: client._id, title: `Load project ${i}`, category: cats[i % cats.length],
      description: 'Synthetic project used only for load testing the open-projects feed.',
      location: i % 2 ? 'Dhaka' : 'Chattogram', budget: 50000 + i * 100, status: 'OPEN'
    })));
    await mongoose.disconnect();

    const jwt = require('jsonwebtoken');
    const token = (u) => jwt.sign({ userId: String(u._id), role: u.role, sv: 0 }, secret, { expiresIn: 3600 });
    const port = 5600 + Math.floor(Math.random() * 300);
    const base = `http://127.0.0.1:${port}`;

    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        NODE_ENV: 'production', PORT: String(port), BIND_ADDRESS: '127.0.0.1',
        MONGODB_URI: uri, JWT_SECRET: secret, AUDIT_HMAC_SECRET: secret,
        TREASURY_PHONE: '01700000000', CORS_ORIGIN: base, SERVER_URL: base,
        REDIS_URL: 'redis://127.0.0.1:1', PAYMENTS_DISABLED: 'true', OTP_DELIVERY: 'operator',
        STORAGE_PROVIDER: 'mock', ALLOW_MOCK_STORAGE: 'true',
        SETTLEMENT_POLL_MS: '3600000', RECONCILIATION_POLL_MS: '3600000', CONTRACT_ABANDONMENT_POLL_MS: '3600000'
      }
    });
    if (!(await waitReady(base))) { report.fail('boot', 'Server did not become ready within 60s'); return report; }
    report.info('setup', `${connections} connections × ${duration}s per scenario against ${base} (Redis absent → MongoDB fallback path)`);

    const scenarios = [
      { id: 'liveness', title: 'GET /health/liveness (baseline)', url: `${base}/health/liveness` },
      { id: 'portal', title: 'GET / (static portal, compressed)', url: `${base}/`, headers: { 'accept-encoding': 'br, gzip' } },
      { id: 'me', title: 'GET /api/auth/me (auth + user lookup)', url: `${base}/api/auth/me`, headers: { authorization: `Bearer ${token(client)}` } },
      { id: 'open-feed', title: 'GET /api/projects/open (auth + query + count)', url: `${base}/api/projects/open?limit=20`, headers: { authorization: `Bearer ${token(contractor)}` } }
    ];

    for (const s of scenarios) {
      const r = await cannon({ url: s.url, connections, duration, headers: s.headers || {} });
      const detail = {
        req_per_sec_avg: Math.round(r.requests.average),
        latency_ms: { p50: r.latency.p50, p97_5: r.latency.p97_5, p99: r.latency.p99, max: r.latency.max },
        total: r.requests.total, non2xx: r.non2xx, errors: r.errors, timeouts: r.timeouts
      };
      const clean = r.errors === 0 && r.timeouts === 0 && r.non2xx === 0;
      if (!clean) report.fail(`load:${s.id}`, `${s.title}: errors/non-2xx under load`, detail);
      else if (r.latency.p99 > 1000) report.warn(`load:${s.id}`, `${s.title}: p99 ${r.latency.p99}ms exceeds 1s`, detail);
      else report.pass(`load:${s.id}`, `${s.title}: ${detail.req_per_sec_avg} req/s, p99 ${r.latency.p99}ms`, detail);
    }

    const feed = report.results.find((x) => x.id === 'load:open-feed');
    if (feed && feed.detail) {
      const rps = feed.detail.req_per_sec_avg;
      report.info('capacity-estimate', `≈${(rps * 10).toLocaleString()} concurrently active users on the heaviest read path, assuming one API call per user every 10 s. Machine-specific estimate; not a free-tier figure.`, { heaviest_path_rps: rps, think_time_s: 10 });
    }
    return report;
  } finally {
    if (child) child.kill();
    await mongoose.disconnect().catch(() => {});
    await rs.stop().catch(() => {});
  }
}

module.exports = { run };
if (require.main === module) runCli(run);
