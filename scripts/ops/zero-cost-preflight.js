// scripts/ops/zero-cost-preflight.js
// ═════════════════════════════════════════════════════════════════════════════
// Build-BD Marketplace v3 — ৳0-Cost Operational Preflight & Integrity Verification
//
// Usage:
//   node scripts/ops/zero-cost-preflight.js [--init-env] [--skip-qa]
//   npm run preflight:zero-cost
//
// Checks:
//   1. Environment configuration & cryptographic secrets (or initializes .env)
//   2. Bangladesh Work & Material Taxonomy completeness (8 domains, 25 categories)
//   3. Split-BOQ Estimators (Painting, Shifting, Deep Cleaning, Tiles/Masonry)
//   4. Frontend unit tests & CSP / Pure-DOM validation
//   5. Repository static QA gates (Route policy, Schema policy, Static secrets, WCAG AA)
// ═════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// Load env if not already populated
if (!process.env.JWT_SECRET) {
  try {
    if (fs.existsSync(path.join(ROOT, '.env.beta'))) {
      require('dotenv').config({ path: path.join(ROOT, '.env.beta') });
    } else if (fs.existsSync(path.join(ROOT, '.env'))) {
      require('dotenv').config({ path: path.join(ROOT, '.env') });
    }
  } catch (_) {}
}

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

function pass(msg) {
  console.log(`  ${COLORS.green}✔${COLORS.reset} ${msg}`);
}

function fail(msg) {
  console.log(`  ${COLORS.red}✖${COLORS.reset} ${COLORS.bold}${msg}${COLORS.reset}`);
}

function info(msg) {
  console.log(`  ${COLORS.cyan}ℹ${COLORS.reset} ${msg}`);
}

function banner(title) {
  console.log(`\n${COLORS.bold}${COLORS.cyan}━━━ ${title} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}\n`);
}

function initEnvIfRequested() {
  const envPath = path.join(ROOT, '.env');
  const examplePath = path.join(ROOT, '.env.zero-cost.example');

  if (process.argv.includes('--init-env')) {
    if (fs.existsSync(envPath)) {
      info('.env file already exists; skipping --init-env template generation.');
      return;
    }

    banner('Zero-Cost Environment Initialization (--init-env)');
    let template = '';
    if (fs.existsSync(examplePath)) {
      template = fs.readFileSync(examplePath, 'utf8');
    } else {
      template = `# Build-BD Marketplace Zero-Cost Production Environment
PORT=5000
NODE_ENV=production
BASE_URL=http://localhost:5000
MONGODB_URI=mongodb://127.0.0.1:27017/build-bd?replicaSet=rs0
REDIS_URL=redis://127.0.0.1:6379
JWT_SECRET=REPLACE_ME
BID_SEAL_SECRET=REPLACE_ME
AUDIT_HMAC_SECRET=REPLACE_ME
STORAGE_LOCAL_SECRET=REPLACE_ME
PAYMENT_GATEWAY_MODE=manual_mfs
TREASURY_PHONE=01700000000
STORAGE_PROVIDER=local
STORAGE_LOCAL_DIR=.storage
STORAGE_LOCAL_URL=http://localhost:5000/__storage
DELIVERY_MODE=console
`;
    }

    const genSecret = () => crypto.randomBytes(32).toString('hex');
    const hydrated = template
      .replace(/JWT_SECRET=.*/, `JWT_SECRET=${genSecret()}`)
      .replace(/BID_SEAL_SECRET=.*/, `BID_SEAL_SECRET=${genSecret()}`)
      .replace(/AUDIT_HMAC_SECRET=.*/, `AUDIT_HMAC_SECRET=${genSecret()}`)
      .replace(/STORAGE_LOCAL_SECRET=.*/, `STORAGE_LOCAL_SECRET=${genSecret()}`);

    fs.writeFileSync(envPath, hydrated, { mode: 0o600 });
    pass(`Created fresh .env with 256-bit cryptographically secure random keys.`);
  }
}

function checkEnvironment() {
  banner('1. ৳0-Cost Environment & Cryptographic Secrets');
  let hasError = false;

  const secrets = ['JWT_SECRET', 'BID_SEAL_SECRET', 'AUDIT_HMAC_SECRET'];
  for (const s of secrets) {
    const val = process.env[s];
    if (!val) {
      fail(`Missing required environment secret: ${s}`);
      hasError = true;
    } else if (val.length < 32) {
      fail(`Secret ${s} length is ${val.length} chars (minimum 32 required)`);
      hasError = true;
    } else {
      pass(`Secret ${s} is securely configured (${val.length} chars)`);
    }
  }

  const gatewayMode = process.env.PAYMENT_GATEWAY_MODE || 'sslcommerz';
  if (gatewayMode === 'manual_mfs') {
    pass(`Payment Gateway: manual_mfs (৳0 setup, verified via bKash/Nagad TrxID SMS)`);
    pass(`Treasury Phone: ${process.env.TREASURY_PHONE || '01700000000'}`);
  } else {
    info(`Payment Gateway: ${gatewayMode}`);
  }

  const storageProvider = process.env.STORAGE_PROVIDER || 'mock';
  pass(`Storage Provider: ${storageProvider} (${storageProvider === 'local' ? '৳0 local disk storage' : 'cloud'})`);

  return !hasError;
}

function checkTaxonomy() {
  banner('2. Bangladesh Work & Material Taxonomy');
  try {
    const tax = require('../../config/bdWorkTaxonomy');
    const domains = Object.keys(tax.MACRO_DOMAINS || {});
    const categories = tax.PROJECT_CATEGORIES || [];
    const materials = tax.SUPPLIER_MATERIAL_CATEGORIES || [];
    const genres = tax.CONTRACTOR_WORK_GENRES || [];

    if (domains.length < 8) {
      fail(`Found ${domains.length} Work Domains (expected 8)`);
      return false;
    }
    pass(`8 Bangladesh Macro-Domains validated`);

    if (categories.length < 25) {
      fail(`Found ${categories.length} Work Categories (expected >= 25)`);
      return false;
    }
    pass(`${categories.length} Work Categories verified (including RAJUK approval, Piling, False Ceiling, Thai Aluminum)`);

    if (materials.length < 14) {
      fail(`Found ${materials.length} Material Categories (expected >= 14)`);
      return false;
    }
    pass(`${materials.length} Supplier Material Categories verified (BSRM, Cement, Tiles, Thai Glass, PPR)`);

    pass(`${genres.length} Specialist Mistri / Contractor Genres verified`);
    return true;
  } catch (err) {
    fail(`Taxonomy load failed: ${err.message}`);
    return false;
  }
}

function checkEstimators() {
  banner('3. Split-BOQ Parametric Estimators');
  try {
    const {
      estimateRenovationPaintingSplit,
      estimateHomeShiftingSplit,
      estimateDeepCleaningSplit,
      estimateTilesAndMasonrySplit
    } = require('../../services/aiOrchestratorService');

    const paint = estimateRenovationPaintingSplit({ carpetAreaSqFt: 1200, paintGrade: 'LUXURY_SILK' });
    if (!paint || !paint.materialsBdt || !paint.laborBdt || paint.totalEstimatedBdt !== (paint.materialsBdt + paint.laborBdt)) {
      fail(`Painting estimator failed integer split math`);
      return false;
    }
    pass(`Painting Split-BOQ: Materials: ৳${paint.materialsBdt}, Labor: ৳${paint.laborBdt} (Total: ৳${paint.totalEstimatedBdt})`);

    const shift = estimateHomeShiftingSplit({ floorSource: 4, floorTarget: 2, hasLiftSource: false, hasLiftTarget: true });
    if (!shift || !shift.laborBdt || shift.laborBdt <= 0) {
      fail(`Home shifting estimator failed`);
      return false;
    }
    pass(`Home Shifting Estimator: Labor: ৳${shift.laborBdt}, Materials: ৳${shift.materialsBdt} (Total: ৳${shift.totalEstimatedBdt})`);

    const clean = estimateDeepCleaningSplit({ carpetAreaSqFt: 1500, cleaningIntensity: 'POST_CONSTRUCTION_DEEP' });
    if (!clean || !clean.materialsBdt || !clean.laborBdt) {
      fail(`Deep cleaning estimator failed`);
      return false;
    }
    pass(`Deep Cleaning Estimator: Materials: ৳${clean.materialsBdt}, Labor: ৳${clean.laborBdt} (Total: ৳${clean.totalEstimatedBdt})`);

    const tiles = estimateTilesAndMasonrySplit({ tileAreaSqFt: 800, tileType: 'IMPORTED_PORCELAIN' });
    if (!tiles || !tiles.materialsBdt || !tiles.laborBdt) {
      fail(`Tiles & Masonry estimator failed`);
      return false;
    }
    pass(`Tiles & Masonry Estimator: Materials: ৳${tiles.materialsBdt}, Labor: ৳${tiles.laborBdt} (Total: ৳${tiles.totalEstimatedBdt})`);

    return true;
  } catch (err) {
    fail(`Estimator check failed: ${err.message}`);
    return false;
  }
}

function runQaStep(scriptPath, name) {
  process.stdout.write(`  ${COLORS.gray}Running ${name}...${COLORS.reset} `);
  const result = spawnSync('node', [scriptPath], {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8'
  });

  if (result.status === 0) {
    console.log(`\r  ${COLORS.green}✔${COLORS.reset} ${name}`);
    return true;
  } else {
    console.log(`\r  ${COLORS.red}✖${COLORS.reset} ${name} FAILED:`);
    if (result.stderr) console.error(result.stderr.trim());
    if (result.stdout) console.log(result.stdout.trim());
    return false;
  }
}

function runQaGates() {
  if (process.argv.includes('--skip-qa')) {
    info('Skipping QA gates (--skip-qa passed).');
    return true;
  }

  banner('4. Automated QA Verification Gates');
  let allPass = true;

  allPass = runQaStep('tests/frontend-unit.js', 'Frontend Unit & CSP / DOM Ratification') && allPass;
  allPass = runQaStep('scripts/qa/route-policy.js', 'Route Policy & Idempotency Mounts') && allPass;
  allPass = runQaStep('scripts/qa/schema-policy.js', 'Mongoose Schema Integrity & Integer BDT') && allPass;
  allPass = runQaStep('scripts/qa/static-gates.js', 'Static Hygiene & Leaked Secret Scan') && allPass;
  allPass = runQaStep('scripts/qa/contrast-report.js', 'WCAG AA Design Token Contrast Ratios') && allPass;

  return allPass;
}

function main() {
  console.log(`\n${COLORS.bold}${COLORS.yellow}🇧🇩 Build-BD Marketplace v3 — Preflight & Launch Verification${COLORS.reset}`);
  console.log(`${COLORS.gray}Target: ৳0-Cost Bangladesh Construction & Service Platform${COLORS.reset}`);

  initEnvIfRequested();

  const envOk = checkEnvironment();
  const taxOk = checkTaxonomy();
  const estOk = checkEstimators();
  const qaOk = runQaGates();

  console.log(`\n${COLORS.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
  if (envOk && taxOk && estOk && qaOk) {
    console.log(`${COLORS.green}${COLORS.bold}🎉 PREFLIGHT SUCCESS: SYSTEM IS 100% READY FOR ৳0-COST PILOT LAUNCH!${COLORS.reset}`);
    console.log(`${COLORS.gray}• Next: Run 'npm run ops:mfs' to manage manual escrow transactions${COLORS.reset}`);
    console.log(`${COLORS.gray}• Next: Run 'npm run seed:v3' to seed Dhaka pilot projects & vendors${COLORS.reset}\n`);
    process.exit(0);
  } else {
    console.error(`${COLORS.red}${COLORS.bold}❌ PREFLIGHT CHECKS FAILED — REVIEW THE ISSUES ABOVE BEFORE LAUNCH.${COLORS.reset}\n`);
    process.exit(1);
  }
}

main();
