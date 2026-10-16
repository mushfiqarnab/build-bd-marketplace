// scripts/hang-probe.js — diagnostic preload. Usage:
//   node -r ./scripts/hang-probe.js tests/bidding-guards-e2e.js
// Prints every Mongo operation and every HTTP request/response with a timestamp,
// and if the process is still alive after HANG_PROBE_MS (default 60 s) it prints
// what is keeping it alive and exits with code 124. It changes no test file.
const http = require('http');
let mongoose = null;
try { mongoose = require('mongoose'); } catch (_) { /* not installed */ }

const LIMIT_MS = Number(process.env.HANG_PROBE_MS || 60000);
const t0 = Date.now();
const stamp = () => `[probe +${((Date.now() - t0) / 1000).toFixed(1)}s]`;

if (mongoose) {
  mongoose.set('debug', (collection, method) => console.log(stamp(), 'mongo', `${collection}.${method}`));
}

const originalRequest = http.request;
http.request = function patchedRequest(...args) {
  const opts = args[0] && typeof args[0] === 'object' ? args[0] : {};
  const label = `${opts.method || 'GET'} ${opts.hostname || opts.host || 'localhost'}:${opts.port || ''}${opts.path || ''}`;
  console.log(stamp(), 'http ->', label);
  const req = originalRequest.apply(this, args);
  req.on('response', (res) => console.log(stamp(), 'http <-', res.statusCode, label));
  req.on('error', (err) => console.log(stamp(), 'http x ', err.code || err.message, label));
  return req;
};

const watchdog = setTimeout(() => {
  console.log(stamp(), `STILL RUNNING after ${LIMIT_MS / 1000} s`);
  console.log(stamp(), 'active resources:', JSON.stringify(process.getActiveResourcesInfo()));
  if (mongoose) console.log(stamp(), 'mongoose readyState:', mongoose.connection.readyState);
  process.exit(124);
}, LIMIT_MS);
watchdog.unref();
