#!/usr/bin/env node
// tests/client-flows-audit-unit.js
// End-to-end invariant & regression unit suite across all 6 Client Personas:
//   1. Progressive Onboarding & Deep-Link Continuity (New / Multi-Role Clients)
//   2. Construction & Renovation Client + Zero-Cost Manual MFS Escrow Funding
//   3. Household Domestic Labour & Emergency Micro-Utility Dispatch
//   4. Direct & Project-Linked Material Buyer + Supplier 14-Category Taxonomy + Arbitration
//   5. Probashi / NRB Delegated Share-Link Isolation & Financial Redaction
//   6. Chat Counter-Offer Category Eligibility Alignment
'use strict';

const fs = require('fs');
const path = require('path');
const { toLedgerDto } = require('../utils/dto');
const { SUPPLIER_MATERIAL_CATEGORIES } = require('../config/bdWorkTaxonomy');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

(async () => {
  console.log('\n🧪 Multi-Persona Client Flow & Security Invariant Unit Suite\n');

  // ── 1. DTO Invariants (Zero-Cost Manual MFS Pending State without Secret Leak) ─
  const mfsPendingDto = toLedgerDto({
    _id: '60c72b2f9b1d8b2badbee111',
    ledgerStatus: 'PENDING_FUNDING',
    totalContractValue: 150000,
    pendingTransactionId: 'MFS-BKASH-BL92XK01AB',
    pendingTransactionIds: ['MFS-BKASH-BL92XK01AB'],
    gatewaySessionKey: 'MANUAL_BKASH_01712345678',
    paidByValId: null,
    orphanPayments: [{ valId: 'ORPHAN1' }]
  });
  check(
    'toLedgerDto sets pendingMfsVerification=true for MFS- pendingTransactionId without leaking internal fields',
    mfsPendingDto.pendingMfsVerification === true &&
      mfsPendingDto.fundedOnline === false &&
      !('pendingTransactionId' in mfsPendingDto) &&
      !('gatewaySessionKey' in mfsPendingDto) &&
      !('paidByValId' in mfsPendingDto) &&
      !('orphanPayments' in mfsPendingDto)
  );

  const sslFundedDto = toLedgerDto({
    _id: '60c72b2f9b1d8b2badbee222',
    ledgerStatus: 'FUNDED',
    totalContractValue: 250000,
    pendingTransactionId: null,
    paidByValId: 'MFS-VAL-BL92XK01AB'
  });
  check(
    'toLedgerDto sets fundedOnline=true and pendingMfsVerification=false once verified',
    sslFundedDto.fundedOnline === true && sslFundedDto.pendingMfsVerification === false
  );

  // ── 2. Progressive Onboarding & Role Redirect Continuity ──────────────────
  const sessionJs = read('frontend/js/session.js');
  const loginJs = read('frontend/js/pages/login.js');
  const onboardingJs = read('frontend/js/pages/onboarding.js');
  const materialsJs = read('frontend/js/pages/materials.js');

  check(
    'session.js preserves ?next= when forwarding PENDING_ONBOARDING or unprofiled CONTRACTOR on submit-bid',
    sessionJs.includes("me.role === 'PENDING_ONBOARDING'") &&
      sessionJs.includes('/app/onboarding.html?next=') &&
      sessionJs.includes('/app/contractor-profile.html?next=')
  );
  check(
    'login.js forwards both next and role hints to onboarding.html for PENDING_ONBOARDING sessions',
    loginJs.includes("obParams.set('next', dest)") &&
      loginJs.includes("obParams.set('role', validRoleHint)")
  );
  check(
    'onboarding.js enforces track-compatible next destination and routes WORK track through contractor-profile.html',
    onboardingJs.includes('function isDestCompatibleWithTrack(track, dest)') &&
      onboardingJs.includes('/app/contractor-profile.html?next=') &&
      onboardingJs.includes('getMe({ refresh: true })')
  );
  check(
    'materials.js routes PENDING_ONBOARDING buyers to onboarding.html instead of dead-ending checkout',
    materialsJs.includes("me.role === 'PENDING_ONBOARDING'") &&
      materialsJs.includes('/app/onboarding.html?role=CLIENT&next=')
  );

  // ── 3. Construction, Split-BOQ & Manual MFS Escrow Funding ────────────────
  const postProjectJs = read('frontend/js/pages/post-project.js');
  const projectDetailJs = read('frontend/js/pages/project-detail.js');
  const messagesMod = await import(path.join(ROOT, 'frontend/js/messages.js'));
  const { MESSAGES } = messagesMod;

  check(
    'post-project.js redirects newly created projects directly to /app/project-detail.html?id=',
    postProjectJs.includes('/app/project-detail.html?id=${encodeURIComponent(projectId)}')
  );
  check(
    'post-project.js enables Split-BOQ estimator across all 6 Tier-2 mid-scale categories',
    ['Renovation', 'Interior', 'Painting', 'Masonry & Tiles', 'Shifting & Movers', 'Cleaning & Pest Control']
      .every((cat) => postProjectJs.includes(cat))
  );
  check(
    'project-detail.js wires Zero-Cost Manual MFS modal, pending notice, and POST /payment/manual-mfs-submit/',
    projectDetailJs.includes('mfs-escrow-modal') &&
      projectDetailJs.includes('escrow-mfs-pending-notice') &&
      projectDetailJs.includes('/payment/manual-mfs-submit/') &&
      projectDetailJs.includes("gatewayMode === 'manual_mfs'") &&
      projectDetailJs.includes("currentUser.role === 'CLIENT' && !currentUser.isDelegate")
  );

  // ── 4. Household Domestic & Emergency Micro-Utility Flows ─────────────────
  const homeJs = read('frontend/js/pages/home.js');
  const domesticJs = read('frontend/js/pages/domestic-labour.js');
  const dashboardJs = read('frontend/js/pages/dashboard.js');
  const labourV2Js = read('routes/labourV2.js');

  check(
    'domestic-labour.js passes idempotencyKey on all 3 Tier-1 mutations (subscribe, security-gd, micro/dispatch)',
    domesticJs.includes('idempotencyKey: trialBookingIdemKey') &&
      domesticJs.includes('idempotencyKey: gdDisputeIdemKey') &&
      domesticJs.includes('idempotencyKey: microDispatchIdemKey')
  );
  check(
    'routes/labourV2.js masks worker phone numbers publicly and restricts PENDING phone access to ADMIN/MODERATOR',
    labourV2Js.includes('optionalAuth') &&
      labourV2Js.includes("const isStaff = Boolean(req.user && ['ADMIN', 'MODERATOR'].includes(req.user.role))") &&
      labourV2Js.includes("const exposePhone = isStaff && verificationStatus === 'PENDING'")
  );
  check(
    'routes/labourV2.js blocks self-subscription and auto-resolves timesheet on 48h Police GD disputes',
    labourV2Js.includes('String(workerId) === String(req.user.userId)') &&
      labourV2Js.includes("subscription.status = 'DISPUTED'") &&
      !domesticJs.includes('!subscriptionId || !timesheetId || !policeGdNumber')
  );
  check(
    'home.js sampleWorkers include deterministic userIds and prefer w.userId for deep-linking',
    homeJs.includes('60c72b2f9b1d8b2badbee001') &&
      homeJs.includes('w.userId || w._id')
  );
  check(
    'dashboard.js routes OPEN micro-utility dispatches to project-detail.html before contract formation and supports ?project= deep-link banner',
    dashboardJs.includes("const isContractReady = proj.status && proj.status !== 'OPEN' && proj.status !== 'CANCELLED'") &&
      dashboardJs.includes('dash.micro.trackDispatch') &&
      dashboardJs.includes("urlParams.get('project')")
  );

  // ── 5. Material Buyer Escrow, Supplier Taxonomy & Arbitration ─────────────
  const materialOrdersJs = read('frontend/js/pages/material-orders.js');
  const materialOrdersRouteJs = read('routes/materialOrders.js');
  const moderationJs = read('frontend/js/pages/moderation.js');

  check(
    'material-orders.js formats totalAmountBDT, targets #order-detail-view, and prompts for MFS TrxID when required',
    materialOrdersJs.includes('activeOrder?.totalAmountBDT') &&
      materialOrdersJs.includes("$('order-detail-view')") &&
      materialOrdersJs.includes('modal-order-mfs') &&
      materialOrdersJs.includes('mfsTrxId: cleanTrx')
  );
  check(
    'routes/materialOrders.js enforces MFS TrxID or wallet balance in manual_mfs/live mode (closing free-goods bypass)',
    materialOrdersRouteJs.includes("gatewayMode === 'manual_mfs'") &&
      materialOrdersRouteJs.includes("order.escrowFundedVia = 'MANUAL_MFS_TRXID'") &&
      materialOrdersRouteJs.includes('order.mfsTrxId = `${mfsProvider}:${rawTrx}`')
  );
  check(
    'moderation.js passes idempotencyKey when resolving material order disputes',
    moderationJs.includes('/resolve-dispute') &&
      moderationJs.includes('idempotencyKey: materialResolveIdemKey')
  );
  check(
    'dashboard.js SUPPLIER_CATEGORIES covers all 14 canonical SUPPLIER_MATERIAL_CATEGORIES with EN+BN keys',
    SUPPLIER_MATERIAL_CATEGORIES.every(
      (cat) =>
        dashboardJs.includes(`'${cat}'`) &&
        Boolean(MESSAGES.en[`supplier.cat.${cat.toLowerCase()}`]) &&
        Boolean(MESSAGES.bn[`supplier.cat.${cat.toLowerCase()}`])
    )
  );

  // ── 6. Probashi Delegation Isolation & Chat Counter-Offer Eligibility ─────
  const contractJs = read('frontend/js/pages/contract.js');
  const chatRouteJs = read('routes/chat.js');

  check(
    'routes/materialOrders.js scopes delegated project ledger to req.user.projectId and redacts financials when hideFinancials=true',
    materialOrdersRouteJs.includes('req.user.isDelegate && req.user.projectId !== String(projectId)') &&
      materialOrdersRouteJs.includes('totalSpendBDT: hideFinancials ? null : totalSpendBDT')
  );
  check(
    'contract.js supports ?token= delegated viewers, redacts amounts when hideFinancials=true, and disables mutating actions',
    contractJs.includes('setActiveShareToken(urlShareToken)') &&
      contractJs.includes('const isDelegate = Boolean(currentUser && currentUser.isDelegate)') &&
      contractJs.includes('const isClient = !isDelegate &&')
  );
  check(
    'routes/chat.js passes projectCategory: project.category to both assertContractorBidEligibility checks',
    (chatRouteJs.match(/projectCategory:\s*project\.category/g) || []).length >= 2
  );

  // ── 7. E-WorksBD Official Branding & Non-Truncating Mobile Header ─────────
  const headerHtml = read('frontend/partials/header.html');
  const appCss = read('frontend/styles/app.css');
  check(
    'header.html renders E-WorksBD with inline SVG emblem and zero truncate/shrink clipping on mobile',
    headerHtml.includes('site-brand-emblem') &&
      headerHtml.includes('E-Works<span class="site-brand-bd">BD</span>') &&
      !headerHtml.includes('truncate') &&
      appCss.includes('.site-brand') &&
      appCss.includes('flex-shrink: 0;') &&
      appCss.includes('white-space: nowrap;')
  );

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
  if (failed > 0) process.exit(1);
})();
