// tests/logger-observability-unit.js
// Unit tests for Winston remote observability log drain (Roadmap §16.4 / §18 Item 10)
'use strict';

const assert = require('assert');
const http = require('http');
const logger = require('../utils/logger');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}: ${detail}`);
  }
}

(async () => {
  console.log('🧪 Logger Observability Unit Tests');

  // 1. Validation of URL input
  try {
    logger.buildHttpDrainTransport({});
    check('Rejects missing URL', false, 'Expected error was not thrown');
  } catch (err) {
    check('Rejects missing URL', /required/i.test(err.message));
  }

  try {
    logger.buildHttpDrainTransport({ url: 'not-a-valid-url' });
    check('Rejects invalid URL string', false, 'Expected error was not thrown');
  } catch (err) {
    check('Rejects invalid URL string', /Invalid URL/i.test(err.message));
  }

  // 2. Transport parameter extraction
  const customTransport = logger.buildHttpDrainTransport({
    url: 'https://admin:secpass@logs.buildbd.internal:9443/v2/ingest?source=api-cluster#hash',
    token: 'custom-bearer-token',
    headers: { 'X-Cluster-Id': 'dhaka-prod-1' }
  });

  check('Transport host parsed', customTransport.options.host === 'logs.buildbd.internal');
  check('Transport port parsed', customTransport.options.port === 9443);
  check('Transport ssl enabled', customTransport.options.ssl === true);
  check('Transport path includes query string', customTransport.options.path === '/v2/ingest?source=api-cluster');
  check('Transport auth populated', customTransport.options.auth?.username === 'admin' && customTransport.options.auth?.password === 'secpass');
  check('Transport Authorization header set', customTransport.options.headers?.Authorization === 'Bearer custom-bearer-token');
  check('Transport custom header preserved', customTransport.options.headers?.['X-Cluster-Id'] === 'dhaka-prod-1');

  // 3. Live in-memory HTTP ingest test
  const receivedRequests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      receivedRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(body)
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;

  const testDrain = logger.addHttpDrain({
    url: `http://127.0.0.1:${serverPort}/api/logs/ingest`,
    token: 'live-test-bearer-xyz',
    batch: false
  });

  const testPayload = {
    entityId: 'LEDGER-0099',
    action: 'FUNDS_LOCKED',
    amount: 500000,
    actorId: 'CLIENT-123'
  };

  logger.info('Live observability log event', testPayload);

  // Allow microtask / HTTP request to complete
  await new Promise((r) => setTimeout(r, 400));

  check('Ingest server received exactly 1 log request', receivedRequests.length === 1);
  if (receivedRequests.length > 0) {
    const req = receivedRequests[0];
    check('HTTP method is POST', req.method === 'POST');
    check('HTTP path matches target ingest endpoint', req.url === '/api/logs/ingest');
    check('Bearer token delivered in Authorization header', req.headers['authorization'] === 'Bearer live-test-bearer-xyz');
    check('Log message matches', req.body.message === 'Live observability log event');
    check('Log metadata entityId matches', req.body.entityId === 'LEDGER-0099');
    check('Log metadata action matches', req.body.action === 'FUNDS_LOCKED');
    check('Service defaultMeta present', req.body.service === 'buildbd-api');
    check('ISO timestamp generated', typeof req.body.timestamp === 'string');
  }

  // Clean up logger transport & server
  logger.remove(testDrain);
  await new Promise((resolve) => server.close(resolve));

  // 4. Fail-open resilience test: transport pointing to offline port should not throw or exit
  process.env.SUPPRESS_LOG_DRAIN_WARN = 'true';
  const offlineDrain = logger.addHttpDrain({
    url: 'http://127.0.0.1:59998/offline-logs',
    batch: false
  });

  let processSurvived = true;
  try {
    logger.info('Event emitted while drain is unreachable', { test: true });
    await new Promise((r) => setTimeout(r, 200));
  } catch (err) {
    processSurvived = false;
  }
  check('Process survives unreachable log drain without crashing', processSurvived);
  logger.remove(offlineDrain);
  delete process.env.SUPPRESS_LOG_DRAIN_WARN;

  // 5. Final summary
  console.log(`\nAll done: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
})();
