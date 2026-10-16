// tests/sanitize-unit.js
// DB-free test of middleware/sanitize.js on a real Express 5 app.
'use strict';

const http = require('http');
const express = require('express');
const sanitizeRequest = require('../middleware/sanitize');

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {}
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('🧪 sanitize middleware (Express 5)');
  const app = express();
  app.use(express.json());
  app.use(sanitizeRequest);
  app.get('/echo', (req, res) => {
    const first = req.query;
    const second = req.query;
    res.json({ query: first, stable: first === second });
  });
  app.post('/echo', (req, res) => res.json({ body: req.body, query: req.query }));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  try {
    const plain = await request(port, 'GET', '/echo');
    check('GET without a query string returns 200', plain.status === 200, JSON.stringify(plain));
    check('empty query stays an empty object', plain.body && JSON.stringify(plain.body.query) === '{}', JSON.stringify(plain.body));

    const normal = await request(port, 'GET', '/echo?category=Painting&location=Dhaka&areaSqFt=500');
    check('normal query values pass unchanged', normal.status === 200
      && normal.body.query.category === 'Painting'
      && normal.body.query.location === 'Dhaka'
      && normal.body.query.areaSqFt === '500', JSON.stringify(normal.body));
    check('req.query is the same object on every read', normal.body.stable === true, JSON.stringify(normal.body));

    const attack = await request(port, 'GET', '/echo?$where=sleep(5000)&ok=1&a.b=2');
    check('"$where" key is removed from the query', attack.status === 200 && !('$where' in attack.body.query), JSON.stringify(attack.body));
    check('dotted key "a.b" is removed from the query', !('a.b' in attack.body.query), JSON.stringify(attack.body));
    check('other query keys survive', attack.body.query.ok === '1', JSON.stringify(attack.body));

    const body = await request(port, 'POST', '/echo', {
      email: 'user.name@example.com',
      budget: 250000.5,
      filter: { $ne: null },
      $gt: 1,
      nested: { deep: { $where: 'x' }, keep: true }
    });
    check('POST returns 200', body.status === 200, JSON.stringify(body));
    check('"$gt" top-level key removed from the body', !('$gt' in body.body.body), JSON.stringify(body.body));
    check('"$ne" removed inside an object', body.body.body.filter && Object.keys(body.body.body.filter).length === 0, JSON.stringify(body.body));
    check('deeply nested "$where" removed', body.body.body.nested && body.body.body.nested.deep && Object.keys(body.body.body.nested.deep).length === 0, JSON.stringify(body.body));
    check('values with dots are kept (email)', body.body.body.email === 'user.name@example.com', JSON.stringify(body.body));
    check('numbers are kept', body.body.body.budget === 250000.5 && body.body.body.nested.keep === true, JSON.stringify(body.body));
  } finally {
    server.close();
  }

  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('💥 sanitize-unit crashed:', err);
  process.exit(1);
});
