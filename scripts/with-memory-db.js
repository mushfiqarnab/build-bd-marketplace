#!/usr/bin/env node
// scripts/with-memory-db.js — run ONE node command against a throwaway in-memory replica set.
// Usage: node scripts/with-memory-db.js [node args...] <script.js>
//   e.g. node scripts/with-memory-db.js -r ./scripts/hang-probe.js tests/bidding-guards-e2e.js
//
// The child runs with ASYNC spawn on purpose: mongodb-memory-server reads mongod's log output
// through a pipe in THIS process. A blocking spawnSync would stop that pipe from being read,
// mongod would block on a full pipe, and every query would hang.
// The replica set lives in memory only; .env is never changed; it is always stopped at the end.
// WITH_DB_TIMEOUT_MS (default 150000) kills the child if it runs longer.
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const TIMEOUT_MS = Number(process.env.WITH_DB_TIMEOUT_MS || 150000);

function runChild(childArgs, env, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(process.execPath, childArgs, { cwd: ROOT, stdio: 'inherit', env, windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => finish({ code: 1, detail: `spawn error: ${err.message}`, seconds: elapsed() }));
    child.on('exit', (code, signal) => {
      if (timedOut) return finish({ code: 124, detail: `TIMED OUT after ${timeoutMs / 1000} s (killed)`, seconds: elapsed() });
      return finish({ code: code === null ? 1 : code, detail: `exit ${code}${signal ? ` (signal ${signal})` : ''}`, seconds: elapsed() });
    });
  });
}

async function main() {
  if (args.length === 0) {
    console.error('usage: node scripts/with-memory-db.js [node args...] <script.js>');
    return 2;
  }
  let MongoMemoryReplSet;
  try {
    ({ MongoMemoryReplSet } = require('mongodb-memory-server'));
  } catch (_) {
    console.error('💥 mongodb-memory-server is not installed. Run: npm install --save-dev mongodb-memory-server');
    return 1;
  }
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger', name: 'rs0' },
    instanceOpts: [{ ip: '127.0.0.1' }]
  });
  const uri = replSet.getUri();
  console.log(`🧪 In-memory replica set ready at ${uri}`);
  let result = { code: 1, detail: 'not run', seconds: '0.0' };
  try {
    result = await runChild(args, { ...process.env, MONGODB_URI: uri }, TIMEOUT_MS);
    console.log(`child finished: ${result.detail} [${result.seconds}s]`);
  } finally {
    await replSet.stop({ doCleanup: true, force: true }).catch((e) => console.warn('⚠️ replSet stop:', e.message));
    console.log('🧹 In-memory replica set stopped.');
  }
  return result.code;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('💥 with-memory-db crashed:', err);
    process.exit(1);
  });
