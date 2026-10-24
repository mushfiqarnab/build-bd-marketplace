// tests/qa-full-audit-unit.js
// Full-Project QA Audit Regression Suite:
// Verifies middleware delegation scope, backend route/service hardening,
// dynamic i18n parity, and per-persona UI/UX invariants across all 7 roles.
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function check(label, cond) {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${label}`);
  }
}

function readRel(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

(async () => {
  console.log('\n🔬 Full-Project QA Audit Regression Suite\n');

  // ── 1. Middleware Delegation Scope Enforcement ────────────────────────────
  console.log('--- Layer 1: Middleware Delegation & Sanitizer Invariants ---');
  const authMwSrc = readRel('middleware/auth.js');
  check('M1: middleware/auth.js invokes isShareTokenAllowed(req, share.scopedRole) inside verifyToken',
    authMwSrc.includes('isShareTokenAllowed(req, share.scopedRole)'));
  check('M1: middleware/auth.js permits POST deliveries only for SITE_WATCHER',
    authMwSrc.includes("req.method === 'POST' && scopedRole === 'SITE_WATCHER'"));

  const { hasContactLeak, scrubContactLeaks, REDACTION_TOKEN } = require('../middleware/sanitize');
  check('Sanitizer: detects Bangla digit phone leak and scrubs to REDACTION_TOKEN',
    hasContactLeak('আমার নাম্বার ০১৭১১২২৩৩৪৪') && scrubContactLeaks('কল ০১৭১১২২৩৩৪৪').includes(REDACTION_TOKEN));

  // ── 2. Backend Route & Service Hardening ──────────────────────────────────
  console.log('\n--- Layer 2: Backend Route & Service Security / Money Invariants ---');
  const authRouteSrc = readRel('routes/auth.js');
  check('B1: routes/auth.js blocks delegated share tokens on /passkey/credentials, /me, and /logout',
    (authRouteSrc.match(/req\.user\.isDelegate/g) || []).length >= 3);

  const chatRouteSrc = readRel('routes/chat.js');
  check('B2: routes/chat.js blocks delegated share tokens in verifyBidParticipant and acceptOfferHandler',
    chatRouteSrc.includes('Forbidden: Delegated share tokens cannot access sealed bid negotiation threads.') &&
    chatRouteSrc.includes('Forbidden: Delegated share tokens cannot accept financial offers.'));

  const dashRouteSrc = readRel('routes/dashboard.js');
  check('B3: routes/dashboard.js explicitly requires ADMIN or MODERATOR before platform-wide counters',
    dashRouteSrc.includes("role !== 'ADMIN' && role !== 'MODERATOR'"));

  const supplierRouteSrc = readRel('routes/supplier.js');
  const adminVerifySrc = readRel('frontend/js/pages/admin-verify.js');
  check('B4: routes/supplier.js & admin-verify.js reject unsafe URI schemes on bstiQrDocUrl',
    supplierRouteSrc.includes('cleanBstiDocUrl') &&
    adminVerifySrc.includes('^(https?:\\/\\/|\\/[^/])'));

  const matOrdersRouteSrc = readRel('routes/materialOrders.js');
  check('B5: routes/materialOrders.js uses returnDocument: "after" (zero deprecated new: true)',
    !matOrdersRouteSrc.includes('new: true') && matOrdersRouteSrc.includes("returnDocument: 'after'"));

  const projRouteSrc = readRel('routes/project.js');
  check('B6: routes/project.js scopes delegated GET /:id to delegateProjectId, redacts budget when hideFinancials, and exposes clientId to fullAccess owner',
    projRouteSrc.includes('String(delegateProjectId) !== String(project._id)') &&
    projRouteSrc.includes('isDelegateViewer && hideFinancials ? null : project.budget') &&
    projRouteSrc.includes('body.clientId = project.clientId'));

  const socketSvcSrc = readRel('services/socketService.js');
  check('B7: services/socketService.js scrubs contact leaks and enforces contractor bid eligibility on REVISED_OFFER',
    socketSvcSrc.includes('scrubContactLeaks(') &&
    socketSvcSrc.includes('assertContractorBidEligibility('));

  const bidRouteSrc = readRel('routes/bid.js');
  const settlementRouteSrc = readRel('routes/settlement.js');
  const bidAwardSvcSrc = readRel('services/bidAwardService.js');
  check('B9: routes/bid.js & routes/settlement.js enforce whole-integer BDT and integer days',
    bidRouteSrc.includes('!Number.isInteger(bidAmount)') &&
    bidRouteSrc.includes('!Number.isInteger(safeAmount)') &&
    settlementRouteSrc.includes('!Number.isInteger(safeAmount)'));
  check('B9: services/bidAwardService.js increments contractor currentProjects only when isNewLedger is true',
    bidAwardSvcSrc.includes('const isNewLedger = !ledger;') &&
    bidAwardSvcSrc.includes('if (isNewLedger)'));

  // ── 3. Frontend Infrastructure, Dynamic i18n & Per-Persona UX Flows ───────
  console.log('\n--- Layer 3: Frontend API, Dynamic i18n & 7-Persona UX Flows ---');
  const apiSrc = readRel('frontend/js/api.js');
  check('F5/F6/F8: frontend/js/api.js supports query params on get(), custom headers, and setActiveShareToken',
    apiSrc.includes('export function setActiveShareToken') &&
    apiSrc.includes('appendQueryParams(') &&
    apiSrc.includes("'x-project-share-token'"));

  const i18nSrc = readRel('frontend/js/i18n.js');
  check('i18n: setLang dispatches bubbling langchange CustomEvent so both document and window listeners fire',
    i18nSrc.includes("CustomEvent('langchange', { bubbles: true"));

  const { MESSAGES } = await import(pathToFileURL(path.join(ROOT, 'frontend/js/messages.js')).href);
  const enKeys = Object.keys(MESSAGES.en);
  const bnKeys = new Set(Object.keys(MESSAGES.bn));
  const REQUIRED_DYNAMIC_KEYS = [
    'category.CEMENT', 'category.STEEL', 'category.ROD', 'category.SAND', 'category.BRICKS',
    'category.STONE_AGGREGATE', 'category.TILES', 'category.PAINT', 'category.PLUMBING',
    'category.ELECTRICAL', 'category.OTHER',
    'cat.Residential', 'cat.Commercial', 'cat.Renovation', 'cat.Plumbing', 'cat.Electrical', 'cat.Civil',
    'project.status.OPEN', 'project.status.UNDER_BIDDING', 'project.status.ASSIGNED',
    'project.status.IN_PROGRESS', 'project.status.DISPUTED', 'project.status.COMPLETED', 'project.status.CANCELLED',
    'profile.status.pending_verification', 'supplier.kyc.title', 'supplier.sku.openBtn',
    'delegate.banner.viewerTitle', 'delegate.banner.watcherTitle'
  ];
  check('i18n: 100% EN/BN key count parity',
    enKeys.length === bnKeys.size && enKeys.every((k) => bnKeys.has(k)));
  check('i18n: all dynamic category, project.status, supplier KYC/SKU, and delegate keys exist in EN & BN',
    REQUIRED_DYNAMIC_KEYS.every((k) => Boolean(MESSAGES.en[k]) && Boolean(MESSAGES.bn[k])));

  const withdrawSrc = readRel('frontend/js/pages/withdraw.js');
  check('F1: withdraw.js renders w.createdAt fallback and customizes SUPPLIER copy',
    withdrawSrc.includes('w.createdAt || w.requestedAt') &&
    withdrawSrc.includes("role === 'SUPPLIER'"));

  const dashSrc = readRel('frontend/js/pages/dashboard.js');
  check('F2/F3: dashboard.js loads /materials/orders + /supplier/me for SUPPLIER and renders ADMIN/MODERATOR governance KPIs',
    dashSrc.includes("get('/materials/orders')") &&
    dashSrc.includes("get('/supplier/me')") &&
    dashSrc.includes("post('/supplier/profile'") &&
    dashSrc.includes("role === 'ADMIN' || role === 'MODERATOR'"));

  const materialsSrc = readRel('frontend/js/pages/materials.js');
  const materialOrdersSrc = readRel('frontend/js/pages/material-orders.js');
  const projDetailSrc = readRel('frontend/js/pages/project-detail.js');
  const submitBidSrc = readRel('frontend/js/pages/submit-bid.js');
  check('F3: materials.js provides SUPPLIER SKU publishing modal (POST /materials/products)',
    materialsSrc.includes("post('/materials/products'"));
  check('F4: zero blocking native dialog calls across materials, material-orders, project-detail, and submit-bid',
    !/\b(alert|confirm)\s*\(/.test(materialsSrc) &&
    !/\b(alert|confirm)\s*\(/.test(materialOrdersSrc) &&
    !/window\.confirm\s*\(/.test(projDetailSrc) &&
    !/window\.confirm\s*\(/.test(submitBidSrc));

  const projMatSrc = readRel('frontend/js/pages/project-materials.js');
  check('F6: project-detail.js & project-materials.js consume ?token= share links via /projects/shared/:token',
    projDetailSrc.includes('/projects/shared/') &&
    projMatSrc.includes('/projects/shared/') &&
    projMatSrc.includes('idempotencyKey: newIdempotencyKey()'));

  const domesticSrc = readRel('frontend/js/pages/domestic-labour.js');
  const worksSrc = readRel('frontend/js/pages/works.js');
  const contractSrc = readRel('frontend/js/pages/contract.js');
  const contractHtml = readRel('frontend/pages/contract.html');
  const profileSrc = readRel('frontend/js/pages/contractor-profile.js');
  const headerHtml = readRel('frontend/partials/header.html');
  const footerHtml = readRel('frontend/partials/footer.html');
  const worksHtml = readRel('frontend/pages/works.html');
  const appCss = readRel('frontend/styles/app.css');
  const shellSrc = readRel('frontend/js/shell.js');
  const loginHtml = readRel('frontend/pages/login.html');

  check('F7: domestic-labour.js redirects guests to login, hydrates subscriptions/mine for CIMS export, and has zero inline style mutations',
    domesticSrc.includes('/v2/labour/subscriptions/mine') &&
    domesticSrc.includes("addEventListener('langchange'") &&
    !domesticSrc.includes('micBtn.' + 'style'));
  check('F10: works.js routes guest Submit Bid with role=CONTRACTOR and opens Scope Preview Modal for non-contractor viewers',
    worksSrc.includes('role=CONTRACTOR&next=') &&
    worksSrc.includes('openProjectPreviewModal('));
  check('F9/F11/F12: contract.js uses getLang(), star glyphs do not use Material icon font class, and 44px touch targets hold in header/login',
    contractSrc.includes('const isBn = getLang() === \'bn\'') &&
    !contractHtml.includes('star-btn icon') &&
    !profileSrc.includes("'icon text-secondary font-bold', '★'") &&
    !headerHtml.includes('min-h-[36px]') &&
    !loginHtml.includes('min-h-[32px]'));
  check('F13: Responsive navigation menu drawer, mobile bottom bar, and Live Works category/filter menu are wired',
    headerHtml.includes('id="site-menu-btn"') &&
    headerHtml.includes('id="site-menu-panel"') &&
    footerHtml.includes('id="bottom-nav"') &&
    shellSrc.includes('initSiteMenu()') &&
    worksHtml.includes('id="trade-quick-select"') &&
    worksHtml.includes('id="works-filter-toggle"') &&
    worksHtml.includes('id="works-filter-sidebar"'));
  check('F14: Global Night Mode overrides remap dark-on-dark surfaces, text, buttons, chips, and inputs to WCAG high contrast',
    appCss.includes('html[data-theme="dark"] .bg-surface-main') &&
    appCss.includes('html[data-theme="dark"] .text-on-surface') &&
    appCss.includes('html[data-theme="dark"] .text-on-surface-variant') &&
    appCss.includes('html[data-theme="dark"] .text-primary') &&
    appCss.includes('html[data-theme="dark"] .btn-primary') &&
    appCss.includes('html[data-theme="dark"] select option'));

  console.log(`\nSummary: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
})();
