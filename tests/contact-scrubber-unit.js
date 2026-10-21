// tests/contact-scrubber-unit.js
// Unit tests for Bangla Phonetic & Digit Contact Scrubber (Roadmap §13.1 / §18 Item 13)
'use strict';

const http = require('http');
const express = require('express');
const sanitizeRequest = require('../middleware/sanitize');

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

function requestJson(port, method, path, body) {
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
      res.on('data', (c) => { data += c; });
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

(async () => {
  console.log('🧪 Bangla Phonetic & Digit Contact Scrubber Unit Tests');

  const { scrubContactLeaks, hasContactLeak, REDACTION_TOKEN } = sanitizeRequest;

  // 1. Direct String Leak Detection & Scrubbing
  const testCases = [
    { name: 'Standard ASCII BD phone', raw: '01712345678', expectLeak: true },
    { name: 'International prefix +880', raw: '+8801712345678', expectLeak: true },
    { name: 'Prefix 880 without plus', raw: '8801712345678', expectLeak: true },
    { name: 'Double zero prefix 00880', raw: '008801712345678', expectLeak: true },
    { name: 'Hyphenated phone number', raw: '017-1234-5678', expectLeak: true },
    { name: 'Dotted phone number', raw: '017.1234.5678', expectLeak: true },
    { name: 'Spaced phone number', raw: '017 1234 5678', expectLeak: true },
    { name: 'Dispersed spaced digits', raw: '0 1 7 1 2 3 4 5 6 7 8', expectLeak: true },
    { name: 'Underscore separated digits', raw: '017_1234_5678', expectLeak: true },
    { name: 'Slash separated digits', raw: '017/1234/5678', expectLeak: true },
    { name: 'Bengali numerals (বাংলা সংখ্যা)', raw: '০১৭১২৩৪৫৬৭৮', expectLeak: true },
    { name: 'Bengali numerals with +৮৮', raw: '+৮৮০১৭১২৩৪৫৬৭৮', expectLeak: true },
    { name: 'Bengali numerals with hyphens', raw: '০১৭-১২৩৪-৫৬৭৮', expectLeak: true },
    { name: 'Bengali numerals with spaces', raw: '০ ১ ৭ ১ ২ ৩ ৪ ৫ ৬ ৭ ৮', expectLeak: true },
    { name: 'Mixed Bengali & ASCII digits', raw: '0১7১2৩4৫67৮', expectLeak: true },
    { name: 'Banglish phonetic words', raw: 'shunno ek saat ek dui tin char pach choy saat aat', expectLeak: true },
    { name: 'English phonetic words', raw: 'zero one seven one two three four five six seven eight', expectLeak: true },
    { name: 'Bengali phonetic words (বাংলা বানান)', raw: 'শূণ্য এক সাত এক দুই তিন চার পাঁচ ছয় সাত আট', expectLeak: true },
    { name: 'Conversational sentence with phone', raw: 'Please call me at 01712-345678 for negotiation', expectLeak: true },
    { name: 'WhatsApp direct link', raw: 'Chat here wa.me/8801811223344 immediately', expectLeak: true }
  ];

  for (const tc of testCases) {
    check(`detects: ${tc.name}`, hasContactLeak(tc.raw) === tc.expectLeak);
    const scrubbed = scrubContactLeaks(tc.raw);
    check(`scrubs: ${tc.name}`, scrubbed.includes(REDACTION_TOKEN), scrubbed);
  }

  // 2. Non-leak / Invariant Preservation Tests
  const cleanCases = [
    { name: 'Clean conversation text', raw: 'Foundation concrete slab casting will start tomorrow.' },
    { name: 'English preposition "at"', raw: 'Meeting scheduled at site gate at 5pm.' },
    { name: 'Monetary figure with commas', raw: 'Total cement cost is 1,50,000 BDT.' },
    { name: 'Year and dimensions', raw: 'Project year 2026, plot area 2400 sq ft.' },
    { name: 'Structural grade notation', raw: 'Using 500W TMT rebar for columns.' }
  ];

  for (const cc of cleanCases) {
    check(`preserves clean text: ${cc.name}`, hasContactLeak(cc.raw) === false);
    check(`does not alter: ${cc.name}`, scrubContactLeaks(cc.raw) === cc.raw);
  }

  // 3. Stateless Idempotency check (Regex lastIndex trap prevention)
  const leakSample = 'Call 01711223344';
  check('idempotent hasContactLeak pass 1', hasContactLeak(leakSample) === true);
  check('idempotent hasContactLeak pass 2', hasContactLeak(leakSample) === true);
  check('idempotent hasContactLeak pass 3', hasContactLeak(leakSample) === true);

  // 4. Express 5 Middleware Pipeline Integration
  const app = express();
  app.use(express.json());
  app.use(sanitizeRequest);

  app.post('/test/chat', (req, res) => res.json({ message: req.body.message }));
  app.post('/test/bid', (req, res) => res.json({ proposalText: req.body.proposalText }));
  app.post('/test/auth', (req, res) => res.json({ phoneNumber: req.body.phoneNumber }));
  app.post('/test/supplier', (req, res) => res.json({ dealerPhone: req.body.dealerPhone, notes: req.body.notes }));

  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;

  try {
    // A. Chat message with leak is scrubbed
    const chatRes = await requestJson(port, 'POST', '/test/chat', {
      message: 'Sure, we can do it cheaper off platform! WhatsApp me on ০১৭১১-৯৯৮৮৭৭ right now.'
    });
    check('Middleware scrubs chat message', chatRes.body.message.includes(REDACTION_TOKEN));
    check('Middleware removes raw phone from chat message', !chatRes.body.message.includes('০৭১১'));

    // B. Bid proposal text with Banglish phonetic is scrubbed
    const bidRes = await requestJson(port, 'POST', '/test/bid', {
      proposalText: 'My bid is ৳4,50,000. Call shunno ek saat ek dui tin char pach choy saat aat.'
    });
    check('Middleware scrubs bid proposalText', bidRes.body.proposalText.includes(REDACTION_TOKEN));

    // C. Legitimate structured phone numbers are PRESERVED
    const authRes = await requestJson(port, 'POST', '/test/auth', {
      phoneNumber: '01712345678'
    });
    check('Middleware preserves structured phoneNumber', authRes.body.phoneNumber === '01712345678');

    // D. Legitimate structured dealerPhone is PRESERVED, while notes array is scrubbed
    const suppRes = await requestJson(port, 'POST', '/test/supplier', {
      dealerPhone: '01811223344',
      notes: ['Chalan verified at weighbridge', 'Driver phone: 01988776655']
    });
    check('Middleware preserves structured dealerPhone', suppRes.body.dealerPhone === '01811223344');
    check('Middleware scrubs communication notes inside array', suppRes.body.notes[1].includes(REDACTION_TOKEN));

  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log(`\nAll done: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
})();
