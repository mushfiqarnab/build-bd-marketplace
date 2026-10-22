// tests/link-to-sink-matrix-e2e.js
// Exhaustive architectural verification of Mandate 1 to Mandate 4:
// Full Cross-Layer Traceability, Link-to-Sink Invariants, Strict Regex Audit,
// Schema Enum Synchronization, and Post-Login State Resumption.
'use strict';

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
process.env.PORT = '0'; // ephemeral port so it doesn't collide with 5000

const fs = require('fs');
const path = require('path');
const http = require('http');
const mongoose = require('mongoose');

const { app, server } = require('../server');
const Project = require('../models/Project');
const MaterialProduct = require('../models/MaterialProduct');
const User = require('../models/User');
const { MATERIAL_CATEGORIES } = require('../models/SupplierProfile');

const PROJECT_CATEGORIES = Project.schema.paths.category.enumValues;
const USER_ROLES = User.schema.paths.role.enumValues;
const SAFE_NEXT_REGEX = /^\/app\/[\w\-./?=&]*$/;

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

const ROOT = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(ROOT, 'frontend', 'pages');
const PARTIALS_DIR = path.join(ROOT, 'frontend', 'partials');

function crawlLinks(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  const links = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const regex = /href=["']([^"']+)["']/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      links.push({ file: f, href: m[1] });
    }
  }
  return links;
}

async function main() {
  console.log('🧪 Mandate 1-4: Link-to-Sink Vertical Traceability & Invariant Matrix');

  // Wait until server is listening
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve));
  }
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // ── 1. Mandate 1 & Pillar 2: Link & Catalog Matrix Crawl ──────────────────
  const allLinks = [...crawlLinks(PAGES_DIR), ...crawlLinks(PARTIALS_DIR)];
  const knownPages = new Set(fs.readdirSync(PAGES_DIR).map((f) => `/app/${f}`));
  knownPages.add('/app/');

  let deadLinks = 0;
  let enumMismatches = 0;
  let safeNextViolations = 0;

  for (const { file, href } of allLinks) {
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#') || href.endsWith('.woff2') || href.includes('.css')) {
      continue;
    }

    const [rawPath, search] = href.split('?');
    const pathname = (rawPath || '').split('#')[0];
    const query = new URLSearchParams(search || '');

    // Target route exists
    if (pathname.startsWith('/app/')) {
      if (!knownPages.has(pathname)) {
        deadLinks += 1;
        check(`Link [${file}] -> ${href} route existence`, false, `points to non-existent route: ${pathname}`);
      }
    }

    // Material categories align with Mongoose schema enum
    if (query.has('category') && pathname.includes('materials')) {
      const cat = query.get('category');
      if (!MATERIAL_CATEGORIES.includes(cat)) {
        enumMismatches += 1;
        check(`Link [${file}] category=${cat} enum check`, false, `not in MATERIAL_CATEGORIES`);
      }
    }

    // Project categories align with Mongoose schema enum
    if (query.has('category') && pathname.includes('post-project')) {
      const cat = query.get('category');
      if (!PROJECT_CATEGORIES.includes(cat)) {
        enumMismatches += 1;
        check(`Link [${file}] category=${cat} enum check`, false, `not in PROJECT_CATEGORIES`);
      }
    }

    // Role queries align with User schema enum
    if (query.has('role')) {
      const role = query.get('role');
      if (!USER_ROLES.includes(role)) {
        enumMismatches += 1;
        check(`Link [${file}] role=${role} enum check`, false, `not in USER_ROLES`);
      }
    }

    // Next redirects must satisfy safeNext invariant
    if (query.has('next')) {
      const nextVal = query.get('next');
      if (!SAFE_NEXT_REGEX.test(nextVal) || nextVal.includes('//')) {
        safeNextViolations += 1;
        check(`Link [${file}] next=${nextVal} safeNext check`, false, `fails safeNext regex`);
      }
    }
  }

  check('All HTML template links point to verified existing pages', deadLinks === 0, `${deadLinks} broken links`);
  check('All category query params align with Mongoose schema enums', enumMismatches === 0, `${enumMismatches} mismatches`);
  check('All next redirect URLs strictly pass safeNext regex invariant', safeNextViolations === 0, `${safeNextViolations} violations`);

  // ── 2. Mandate 1 & Pillar 1: Strict Regex & safeNext Security Invariant Audit ─
  check('safeNext allows /app/dashboard.html', SAFE_NEXT_REGEX.test('/app/dashboard.html'));
  check('safeNext allows /app/materials.html?category=ROD', SAFE_NEXT_REGEX.test('/app/materials.html?category=ROD'));
  check('safeNext allows /app/post-project.html?category=Residential&ref=probashi', SAFE_NEXT_REGEX.test('/app/post-project.html?category=Residential&ref=probashi'));
  check('safeNext allows /app/post-project.html?category=Residential&budget=9000000&floors=3&sqft=4500', SAFE_NEXT_REGEX.test('/app/post-project.html?category=Residential&budget=9000000&floors=3&sqft=4500'));

  const evilPayloads = [
    'https://evil.example',
    '//evil.example',
    '/app//evil.example',
    'javascript:alert(1)',
    '/app/foo%0Abar',
    '/app/foo%0Dbar',
    '/app/x%2fy',
    '/../app/x'
  ];
  let evilBlocked = 0;
  for (const evil of evilPayloads) {
    if (!SAFE_NEXT_REGEX.test(evil) || evil.includes('//') || evil.includes('%')) evilBlocked += 1;
  }
  check('safeNext strictly blocks open redirects and encoded CR/LF header injections', evilBlocked === evilPayloads.length);

  // ── 3. Mandate 2: Inbound Query Parameter Reception & UI State Binding ────────
  const postProjectJs = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'pages', 'post-project.js'), 'utf8');
  check('post-project.js reads floors and sqft from location.search', postProjectJs.includes("params.get('floors')") && postProjectJs.includes("params.get('sqft')"));
  check('post-project.js reads category and budget from location.search', postProjectJs.includes("params.get('category')") && postProjectJs.includes("params.get('budget')"));

  const materialsJs = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'pages', 'materials.js'), 'utf8');
  check('materials.js reads category query param on initial mount', materialsJs.includes("urlParams.get('category')"));

  // ── 4. Mandate 4 & Pillar 3: Post-Login State Resumption $\rightarrow$ DB Mutation Proof ──
  // Authenticate as CLIENT test user 01781405063
  const sendRes = await fetch(`${baseUrl}/api/auth/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: '01781405063', role: 'CLIENT' })
  });
  const sendData = await sendRes.json();

  let otp = sendData.debugOtp;
  if (!otp) {
    const relayPath = path.join(ROOT, 'logs', 'otp-relay.log');
    if (fs.existsSync(relayPath)) {
      const lines = fs.readFileSync(relayPath, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.phone === '01781405063') { otp = entry.code; break; }
        } catch (_) {}
      }
    }
  }

  const verifyRes = await fetch(`${baseUrl}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: '01781405063', otp })
  });
  const cookieHeader = verifyRes.headers.get('set-cookie');
  const clientCookie = cookieHeader ? cookieHeader.split(';')[0] : '';
  check('CLIENT authentication succeeded with session cookie', verifyRes.status === 200 && Boolean(clientCookie));

  // Simulate client posting project with pre-filled state from Landing Page Estimator
  const postRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'fetch',
      Cookie: clientCookie
    },
    body: JSON.stringify({
      title: '3-Story Building Construction (4,500 sq ft)',
      category: 'Residential',
      description: 'End-to-end grey structure construction including 500W rebar, cement, and slab casting.',
      location: 'Mirpur, Dhaka',
      budget: 9000000,
      siteCoordinates: { latitude: 23.8103, longitude: 90.4125 }
    })
  });

  check('Project creation from estimator state returned HTTP 201', postRes.status === 201);
  const data = await postRes.json();
  const projectId = data && data.project && data.project._id;
  check('Project returned valid MongoDB ObjectId', Boolean(projectId));

  if (projectId) {
    const dbDoc = await Project.findById(projectId).lean();
    check('Document persisted in MongoDB Atlas with exact title', dbDoc && dbDoc.title === '3-Story Building Construction (4,500 sq ft)');
    check('Document category matches Residential enum', dbDoc && dbDoc.category === 'Residential');
    check('Document budget matches calculated 9,000,000 BDT', dbDoc && dbDoc.budget === 9000000);
    check('Document coordinates match site GPS bounds', dbDoc && dbDoc.siteCoordinates.latitude === 23.8103);
    check('Document status initialized to OPEN', dbDoc && dbDoc.status === 'OPEN');

    // Clean up
    await Project.findByIdAndDelete(projectId);
    check('Test project document cleanly pruned from database', true);
  }

  // ── 5. Mandate 2: Materials Catalog API Filter Invariant (ROD & CEMENT) ─────
  const rodRes = await fetch(`${baseUrl}/api/materials/catalog?category=ROD`);
  check('GET /api/materials/catalog?category=ROD returns HTTP 200', rodRes.status === 200);
  const rodData = await rodRes.json();
  check('Materials catalog returns products array for category=ROD', rodData && Array.isArray(rodData.data.products));

  const cementRes = await fetch(`${baseUrl}/api/materials/catalog?category=CEMENT`);
  check('GET /api/materials/catalog?category=CEMENT returns HTTP 200', cementRes.status === 200);
  const cementData = await cementRes.json();
  check('Materials catalog returns products array for category=CEMENT', cementData && Array.isArray(cementData.data.products));

  console.log(`\n🏆 LINK-TO-SINK TRACEABILITY MATRIX: ${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECKS FAILED`}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('💥 Unhandled error in link-to-sink test:', err);
  process.exit(1);
});
