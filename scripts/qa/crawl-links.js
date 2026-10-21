// scripts/qa/crawl-links.js — programmatic crawler and validator of all hrefs,
// buttons, redirects, query parameters, and schema enum alignments.
'use strict';

const fs = require('fs');
const path = require('path');
const { MATERIAL_CATEGORIES } = require('../../models/SupplierProfile');
const Project = require('../../models/Project');
const User = require('../../models/User');

const PROJECT_CATEGORIES = Project.schema.paths.category.enumValues;
const USER_ROLES = User.schema.paths.role.enumValues;

const ROOT = path.resolve(__dirname, '../..');
const PAGES_DIR = path.join(ROOT, 'frontend', 'pages');
const PARTIALS_DIR = path.join(ROOT, 'frontend', 'partials');
const JS_PAGES_DIR = path.join(ROOT, 'frontend', 'js', 'pages');

// safeNext regex from frontend/js/session.js:
const SAFE_NEXT_REGEX = /^\/app\/[\w\-./?=&]*$/;

function crawlHtml(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  const links = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const text = fs.readFileSync(full, 'utf8');
    const regex = /href=["']([^"']+)["']/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      links.push({ file: f, href: m[1] });
    }
  }
  return links;
}

const allLinks = [...crawlHtml(PAGES_DIR), ...crawlHtml(PARTIALS_DIR)];

console.log(`\n🔍 Found ${allLinks.length} total hrefs across templates.\n`);

const knownPages = new Set(fs.readdirSync(PAGES_DIR).map((f) => `/app/${f}`));
knownPages.add('/app/'); // points to index.html

let errors = 0;
let warnings = 0;
let passes = 0;

function pass(msg) {
  passes += 1;
  console.log(`  ✅ ${msg}`);
}

function warn(msg) {
  warnings += 1;
  console.log(`  ⚠️  ${msg}`);
}

function fail(msg) {
  errors += 1;
  console.log(`  ❌ ${msg}`);
}

for (const { file, href } of allLinks) {
  // Ignore external links, anchors, stylesheets, or font links
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#') || href.endsWith('.woff2') || href.includes('.css')) {
    continue;
  }

  // Parse path and query
  const [pathname, search] = href.split('?');
  const query = new URLSearchParams(search || '');

  // 1. Check target page existence
  if (pathname.startsWith('/app/')) {
    if (knownPages.has(pathname)) {
      pass(`[${file}] -> ${href} points to valid existing page`);
    } else {
      fail(`[${file}] -> ${href} TARGET PAGE DOES NOT EXIST! (${pathname})`);
    }
  }

  // 2. Check query params against schema enums
  if (query.has('category')) {
    const cat = query.get('category');
    if (pathname.includes('materials')) {
      if (MATERIAL_CATEGORIES.includes(cat)) {
        pass(`[${file}] materials category="${cat}" matches MaterialProduct schema enum`);
      } else {
        fail(`[${file}] materials category="${cat}" NOT in MATERIAL_CATEGORIES: ${MATERIAL_CATEGORIES.join(', ')}`);
      }
    } else if (pathname.includes('post-project')) {
      if (PROJECT_CATEGORIES.includes(cat)) {
        pass(`[${file}] project category="${cat}" matches Project schema enum`);
      } else {
        fail(`[${file}] project category="${cat}" NOT in PROJECT_CATEGORIES: ${PROJECT_CATEGORIES.join(', ')}`);
      }
    }
  }

  if (query.has('role')) {
    const role = query.get('role');
    if (USER_ROLES.includes(role)) {
      pass(`[${file}] role="${role}" matches User schema enum`);
    } else {
      fail(`[${file}] role="${role}" NOT in USER_ROLES: ${USER_ROLES.join(', ')}`);
    }
  }

  // 3. Check safeNext compatibility on 'next' redirect parameters
  if (query.has('next')) {
    const nextVal = query.get('next');
    if (SAFE_NEXT_REGEX.test(nextVal) && !nextVal.includes('//')) {
      pass(`[${file}] next="${nextVal}" satisfies strict safeNext regex`);
    } else {
      fail(`[${file}] next="${nextVal}" FAILS safeNext regex! User will be dropped on dashboard!`);
    }
  }
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`RESULTS: ${passes} passed, ${warnings} warnings, ${errors} errors.`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

if (errors > 0) process.exit(1);
process.exit(0);
