// tests/frontend-unit.js — pure frontend logic, run in Node (ESM import).
//   - Bangladeshi phone normalisation (every way people type numbers)
//   - post-login redirect is restricted to same-origin /app/ paths
//   - every message key exists in both Bangla and English
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failed += 1; console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const imp = (p) => import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'js', p)).href);

(async () => {
  console.log('🧪 frontend unit');
  const { normalizeBdPhone } = await imp('phone.js');
  const ok = {
    '01712345678': '01712345678',
    '1712345678': '01712345678',
    '+8801712345678': '01712345678',
    '8801712345678': '01712345678',
    '008801712345678': '01712345678',
    '+880 1712-345678': '01712345678',
    '017 1234 5678': '01712345678',
    '(017) 1234-5678': '01712345678',
    '০১৭১২৩৪৫৬৭৮': '01712345678',
    '+৮৮০ ১৯৯৯-৯৯৯৯৯৯': '01999999999',
    '01312345678': '01312345678'
  };
  for (const [input, want] of Object.entries(ok)) check(`normalize "${input}"`, normalizeBdPhone(input) === want, normalizeBdPhone(input));
  for (const bad of ['', '12345', '01212345678', '0171234567', '017123456789', '+911712345678', 'abc', null, undefined, '01712345678x']) {
    check(`reject ${JSON.stringify(bad)}`, normalizeBdPhone(bad) === null, normalizeBdPhone(bad));
  }

  // session.js imports api.js, which only touches browser globals when called.
  const { safeNext } = await imp('session.js');
  check('safeNext allows /app/ paths', safeNext('/app/dashboard.html') === '/app/dashboard.html' && safeNext('/app/project.html?id=1') === '/app/project.html?id=1');
  for (const evil of ['https://evil.example', '//evil.example', '/app//evil.example', 'javascript:alert(1)', '/api/auth/logout', '/../app/x', null]) {
    check(`safeNext blocks ${JSON.stringify(evil)} (open redirect)`, safeNext(evil) === null, safeNext(evil));
  }

  // Foundation audit fix: safeNext must reject URL-encoded CR/LF via `%`.
  check('safeNext blocks %0A (encoded LF) — header injection shape', safeNext('/app/x%0Afoo') === null);
  check('safeNext blocks %0D (encoded CR)', safeNext('/app/x%0Dfoo') === null);
  check('safeNext blocks any `%` encoding', safeNext('/app/x%2fy') === null);

  // Bengali-digit helper is now exported from phone.js and used in multiple places.
  const { bengaliToAscii } = await imp('phone.js');
  check('bengaliToAscii converts Bengali digits', bengaliToAscii('০১২৩৪৫৬৭৮৯') === '0123456789');
  check('bengaliToAscii leaves ASCII and letters alone', bengaliToAscii('abc 123 ০৯৮') === 'abc 123 098');

  const { MESSAGES } = await imp('messages.js');
  const en = Object.keys(MESSAGES.en);
  const bn = Object.keys(MESSAGES.bn);
  check('every English message has a Bangla translation', en.every((k) => bn.includes(k)), en.filter((k) => !bn.includes(k)).join(', '));
  check('no Bangla-only keys', bn.every((k) => en.includes(k)), bn.filter((k) => !en.includes(k)).join(', '));
  check('no empty messages', [...Object.values(MESSAGES.en), ...Object.values(MESSAGES.bn)].every((v) => typeof v === 'string' && v.trim().length > 0));
  check('no e-GP claims in copy', !JSON.stringify(MESSAGES).match(/\be-?GP\b/));
  check('login.newHere key exists (role disclosure)', 'login.newHere' in MESSAGES.en && 'login.newHere' in MESSAGES.bn);

  // Login HTML: no more phone_iphone icon on the primary welcome, uses lock.
  const fs = require('fs');
  const loginHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pages', 'login.html'), 'utf8');
  check('login.html uses dynamic viewport (100dvh) for iOS keyboard', /min-h-\[100dvh\]/.test(loginHtml) || /min-height:100dvh/.test(loginHtml));
  check('login.html wraps role selector in <details> (not shown by default)', /<details[^>]*id="new-here"/.test(loginHtml));
  check('login.html primary icon is `lock`, not `phone_iphone`',
    /aria-hidden="true">lock</.test(loginHtml) && !/aria-hidden="true">phone_iphone</.test(loginHtml));

  // head.html: preloads Noto Sans Bengali so a BN-default user doesn't see fallback flash.
  const headHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'partials', 'head.html'), 'utf8');
  check('head.html preloads Noto Sans Bengali', /noto-sans-bengali.*\.woff2/.test(headHtml));

  // icons.txt: all F4-F8 glyphs listed so the build cannot ship with a missing icon.
  const iconList = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'icons.txt'), 'utf8');
  const F4F8_ICONS = ['upload_file', 'photo_camera', 'add_photo_alternate', 'add', 'edit', 'delete', 'filter_list', 'sort', 'chevron_right', 'event', 'place', 'map', 'timer', 'done_all', 'approval', 'assignment_turned_in', 'local_atm', 'pending', 'more_vert', 'close_small', 'visibility'];
  for (const ic of F4F8_ICONS) check(`icons.txt lists '${ic}' (F4-F8 glyph)`, new RegExp(`^${ic}$`, 'm').test(iconList));

  // i18n helpers F4-F8 depends on exist.
  const i18n = await imp('i18n.js');
  check('formatRelativeTime is exported', typeof i18n.formatRelativeTime === 'function');
  check('formatDate is exported', typeof i18n.formatDate === 'function');
  check('formatTaka handles 100000 → ৳1,00,000 (lakh grouping)',
    i18n.formatTaka(100000) === '৳1,00,000' || i18n.formatTaka(100000) === '৳১,০০,০০০');
  check('formatRelativeTime(now) is a string', typeof i18n.formatRelativeTime(new Date()) === 'string' && i18n.formatRelativeTime(new Date()).length > 0);

  // F4 — post-project screen.
  const F4_KEYS = ['post.title', 'post.subtitle', 'post.field.title', 'post.field.category',
    'post.field.location', 'post.field.budget', 'post.field.description', 'post.field.coords',
    'post.field.useMyLocation', 'post.submit', 'post.submitting', 'post.cancel', 'post.success',
    'post.cat.Residential', 'post.cat.Commercial', 'post.cat.Infrastructure', 'post.cat.Interior', 'post.cat.Renovation',
    'post.err.titleMissing', 'post.err.categoryMissing', 'post.err.locationMissing',
    'post.err.budgetInvalid', 'post.err.descriptionShort', 'post.err.coordsPair', 'post.err.coordsOutOfBd',
    'dash.postProject', 'err.sessionExpired', 'err.forbidden'];
  for (const k of F4_KEYS) check(`F4 i18n key '${k}' exists in en+bn`, k in MESSAGES.en && k in MESSAGES.bn);

  const postHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pages', 'post-project.html'), 'utf8');
  check('post-project.html exists + loads its module',
    /src="\/app\/js\/pages\/post-project\.js/.test(postHtml));
  check('post-project.html uses dynamic viewport (100dvh)',
    /min-h-\[100dvh\]/.test(postHtml) || /min-height:100dvh/.test(postHtml));
  check('post-project.html has novalidate form + aria-live alert',
    /novalidate/.test(postHtml) && /aria-live="assertive"/.test(postHtml));
  check('post-project.html has budget inputmode=numeric',
    /id="budget"[^>]*inputmode="numeric"/.test(postHtml));
  check('post-project.html wires "Use my current location" button',
    /id="geo-btn"/.test(postHtml));

  const dashHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pages', 'dashboard.html'), 'utf8');
  check('dashboard.html links to /app/post-project.html via CTA',
    /href="\/app\/post-project\.html"/.test(dashHtml));

  const postJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'post-project.js'), 'utf8');
  check('post-project.js imports post() from api.js (no raw fetch)',
    /from '\.\.\/api\.js'/.test(postJs) && !/\bfetch\s*\(/.test(postJs));
  check('post-project.js enforces CLIENT role via requireAuth',
    /requireAuth\(\{\s*roles:\s*\['CLIENT'\]\s*\}\)/.test(postJs));
  check('post-project.js has submitting race guard',
    /let\s+submitting\s*=\s*false/.test(postJs) && /if\s*\(submitting\)\s*return/.test(postJs));
  check('post-project.js validates BD bbox client-side',
    /BD_BOUNDS/.test(postJs) && /20\.3/.test(postJs) && /26\.8/.test(postJs));
  check('post-project.js uses bengaliToAscii for budget / coords',
    /bengaliToAscii/.test(postJs));
  check('post-project.js does not shadow window.location',
    !/\bconst\s+location\s*=/.test(postJs));


  // ── F5 — Tenders / Open Projects list ────────────────────────────────────
  const F5_KEYS = [
    'dash.findProjects',
    'tenders.title', 'tenders.sort.newest', 'tenders.filter.all', 'tenders.filter.clear',
    'tenders.summary.all', 'tenders.summary.filtered', 'tenders.empty',
    'tenders.card.budget', 'tenders.card.gpsVerified', 'tenders.card.bidPlaced',
    'tenders.card.view', 'tenders.card.bid', 'tenders.card.viewBid',
    'tenders.page.prev', 'tenders.page.next', 'tenders.page.info'
  ];
  for (const k of F5_KEYS) check(`F5 i18n key '${k}' exists in en+bn`, k in MESSAGES.en && k in MESSAGES.bn);

  const tendersHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pages', 'tenders.html'), 'utf8');
  check('tenders.html exists + loads its module',
    /src="\/app\/js\/pages\/tenders\.js/.test(tendersHtml));
  check('tenders.html uses dynamic viewport (100dvh)',
    /min-h-\[100dvh\]/.test(tendersHtml) || /min-height:100dvh/.test(tendersHtml));
  check('tenders.html has aria-live assertive alert banner',
    /aria-live="assertive"/.test(tendersHtml));
  check('tenders.html has aria-live polite result summary',
    /id="result-summary"/.test(tendersHtml) && /aria-live="polite"/.test(tendersHtml));
  check('tenders.html has skeleton loader (#loading)',
    /id="loading"/.test(tendersHtml) && /aria-busy="true"/.test(tendersHtml));
  check('tenders.html has #filter-bar nav',
    /id="filter-bar"/.test(tendersHtml) && /\bnav\b/.test(tendersHtml));
  check('tenders.html has #project-list ul',
    /id="project-list"/.test(tendersHtml));
  check('tenders.html has #empty empty state',
    /id="empty"/.test(tendersHtml));
  check('tenders.html has #pagination nav with prev/next buttons',
    /id="pagination"/.test(tendersHtml) && /id="prev-btn"/.test(tendersHtml) && /id="next-btn"/.test(tendersHtml));
  check('tenders.html has no inline <script> (CSP)',
    !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(tendersHtml));
  check('tenders.html has no inline event handlers (CSP)',
    !/\son[a-z]+=/.test(tendersHtml));

  const tendersJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'tenders.js'), 'utf8');
  check('tenders.js imports get() from api.js (no raw fetch)',
    /from '\.\.\/api\.js'/.test(tendersJs) && !/\bfetch\s*\(/.test(tendersJs));
  check('tenders.js enforces CONTRACTOR role via requireAuth',
    /requireAuth\(\{?\s*roles:\s*\['CONTRACTOR'\]/.test(tendersJs));
  check('tenders.js has stale-request guard (fetchSeq)',
    /fetchSeq/.test(tendersJs));
  check('tenders.js uses formatTaka for money display',
    /formatTaka/.test(tendersJs));
  check('tenders.js uses formatRelativeTime for dates',
    /formatRelativeTime/.test(tendersJs));
  check('tenders.js calls GET /api/projects/open (correct route)',
    /\/projects\/open/.test(tendersJs));
  check('tenders.js calls GET /api/bids/mine for bid-state badges',
    /\/bids\/mine/.test(tendersJs));
  check('tenders.js does not shadow window.location',
    !/\bconst\s+location\s*=/.test(tendersJs));
  check('tenders.js has langchange re-render handler',
    /langchange/.test(tendersJs));

  const dashHtmlF5 = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pages', 'dashboard.html'), 'utf8');
  check('dashboard.html links to /app/tenders.html via CONTRACTOR CTA',
    /href="\/app\/tenders\.html"/.test(dashHtmlF5));
  check('dashboard.html has both cta-post-project and cta-find-projects',
    /id="cta-post-project"/.test(dashHtmlF5) && /id="cta-find-projects"/.test(dashHtmlF5));

  const dashJsF5 = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'dashboard.js'), 'utf8');
  check('dashboard.js reveals cta-find-projects for CONTRACTOR role',
    /CONTRACTOR/.test(dashJsF5) && /cta-find-projects/.test(dashJsF5));


  // ── F6 — Bid submission & withdrawal ────────────────────────────────────
  const F6_KEYS = [
    'bid.title', 'bid.subtitle', 'bid.projectSummary', 'bid.clientBudget',
    'bid.field.amount', 'bid.field.amountPlaceholder', 'bid.field.amountHelp',
    'bid.field.days', 'bid.field.daysPlaceholder', 'bid.field.daysHelp',
    'bid.field.proposal', 'bid.field.proposalPlaceholder', 'bid.field.proposalHelp',
    'bid.field.breakdown', 'bid.field.breakdownHelp', 'bid.breakdown.addRow',
    'bid.breakdown.removeRow', 'bid.breakdown.titlePlaceholder', 'bid.breakdown.amountPlaceholder',
    'bid.breakdown.daysPlaceholder', 'bid.breakdown.sumMatch', 'bid.submit',
    'bid.submitting', 'bid.cancel', 'bid.success', 'bid.existing.title',
    'bid.existing.sealedNotice', 'bid.status.pending', 'bid.status.accepted',
    'bid.status.rejected', 'bid.status.withdrawn', 'bid.status.tampered',
    'bid.withdraw', 'bid.withdrawing', 'bid.withdrawConfirm', 'bid.withdrawnSuccess',
    'bid.err.amountMin', 'bid.err.amountInvalid', 'bid.err.daysMin', 'bid.err.daysInvalid',
    'bid.err.proposalShort', 'bid.err.breakdownIncomplete', 'bid.err.breakdownAmountMismatch',
    'bid.err.breakdownDaysMismatch', 'bid.err.projectClosed', 'bid.err.ownProject',
    'bid.err.duplicate', 'bid.err.missingProject'
  ];
  for (const k of F6_KEYS) check(`F6 i18n key '${k}' exists in en+bn`, k in MESSAGES.en && k in MESSAGES.bn);

  const bidHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pages', 'submit-bid.html'), 'utf8');
  check('submit-bid.html exists + loads its module',
    /src="\/app\/js\/pages\/submit-bid\.js/.test(bidHtml));
  check('submit-bid.html uses dynamic viewport (100dvh)',
    /min-h-\[100dvh\]/.test(bidHtml) || /min-height:100dvh/.test(bidHtml));
  check('submit-bid.html has aria-live assertive alert banner',
    /aria-live="assertive"/.test(bidHtml));
  check('submit-bid.html has skeleton loader (#loading)',
    /id="loading"/.test(bidHtml) && /aria-busy="true"/.test(bidHtml));
  check('submit-bid.html has novalidate form',
    /<form[^>]*id="form"[^>]*novalidate/.test(bidHtml));
  check('submit-bid.html has numeric bid-amount input',
    /id="bid-amount"[^>]*inputmode="numeric"/.test(bidHtml));
  check('submit-bid.html has numeric est-days input',
    /id="est-days"[^>]*inputmode="numeric"/.test(bidHtml));
  check('submit-bid.html has proposal textarea',
    /<textarea[^>]*id="proposal"/.test(bidHtml));
  check('submit-bid.html has breakdown details section',
    /<details[^>]*id="breakdown-details"/.test(bidHtml));
  check('submit-bid.html has withdraw button (#withdraw-btn)',
    /id="withdraw-btn"/.test(bidHtml));
  check('submit-bid.html has no inline <script> (CSP)',
    !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(bidHtml));
  check('submit-bid.html has no inline event handlers (CSP)',
    !/\son[a-z]+=/.test(bidHtml));

  const bidJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'submit-bid.js'), 'utf8');
  check('submit-bid.js imports post() from api.js (no raw fetch)',
    /from '\.\.\/api\.js'/.test(bidJs) && !/\bfetch\s*\(/.test(bidJs));
  check('submit-bid.js enforces CONTRACTOR role via requireAuth',
    /requireAuth\(\{?\s*roles:\s*\['CONTRACTOR'\]/.test(bidJs));
  check('submit-bid.js has submitting race guard',
    /let\s+submitting\s*=\s*false/.test(bidJs) && /if\s*\(submitting/.test(bidJs));
  check('submit-bid.js enforces 100 BDT bid floor',
    /bidFloorBdt/.test(bidJs) && /100/.test(bidJs));
  check('submit-bid.js calls POST /api/bids/:projectId',
    /\/bids\/\$\{currentProject\._id\}/.test(bidJs) || /\/bids\//.test(bidJs));
  check('submit-bid.js calls POST /api/bids/:bidId/withdraw',
    /\/bids\/.*\/withdraw/.test(bidJs));
  check('submit-bid.js uses bengaliToAscii for numeric parsing',
    /bengaliToAscii/.test(bidJs));
  check('submit-bid.js uses formatTaka for money display',
    /formatTaka/.test(bidJs));
  check('submit-bid.js uses formatRelativeTime for dates',
    /formatRelativeTime/.test(bidJs));
  check('submit-bid.js does not shadow window.location',
    !/\bconst\s+location\s*=/.test(bidJs));
  check('submit-bid.js has langchange re-render handler',
    /langchange/.test(bidJs));
  check('submit-bid.js has zero innerHTML assignments',
    !/\.innerHTML\s*=|insertAdjacentHTML\(/.test(bidJs));

  // F7 — Project Detail, Bid Review, Acceptance & Escrow Funding
  const F7_KEYS = [
    'detail.title', 'detail.loading', 'detail.notFound', 'detail.category',
    'detail.location', 'detail.budget', 'detail.status', 'detail.scope',
    'detail.timeline', 'detail.bidsTitle', 'detail.noBids', 'detail.bidCount',
    'detail.acceptBid', 'detail.accepting', 'detail.acceptConfirm', 'detail.acceptedNotice',
    'detail.escrowFundingTitle', 'detail.escrowFundingDesc', 'detail.fundEscrowBtn',
    'detail.fundingInProgress', 'detail.paymentsDisabledNotice', 'detail.openWorkspaceBtn',
    'detail.myBidTitle', 'detail.myBidStatus', 'detail.submitBidCta', 'detail.integrityVerified',
    'detail.biometricSigned', 'detail.breakdownTitle', 'detail.breakdownItem',
    'detail.breakdownAmount', 'detail.breakdownDays'
  ];
  for (const k of F7_KEYS) check(`F7 i18n key '${k}' exists in en+bn`, k in MESSAGES.en && k in MESSAGES.bn);

  const detailHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pages', 'project-detail.html'), 'utf8');
  check('project-detail.html exists + loads its module',
    /src="\/app\/js\/pages\/project-detail\.js/.test(detailHtml));
  check('project-detail.html uses dynamic viewport (100dvh)',
    /min-h-\[100dvh\]/.test(detailHtml) || /min-height:100dvh/.test(detailHtml));
  check('project-detail.html has aria-live assertive alert banner',
    /aria-live="assertive"/.test(detailHtml));
  check('project-detail.html has skeleton loader (#loading)',
    /id="loading"/.test(detailHtml) && /aria-busy="true"/.test(detailHtml));
  check('project-detail.html has #project-meta section',
    /id="project-meta"/.test(detailHtml));
  check('project-detail.html has #escrow-card section',
    /id="escrow-card"/.test(detailHtml));
  check('project-detail.html has #bids-section',
    /id="bids-section"/.test(detailHtml));
  check('project-detail.html has #contractor-section',
    /id="contractor-section"/.test(detailHtml));
  check('project-detail.html has no inline <script> (CSP)',
    !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(detailHtml));
  check('project-detail.html has no inline event handlers (CSP)',
    !/\son[a-z]+=/.test(detailHtml));

  const detailJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'project-detail.js'), 'utf8');
  check('project-detail.js imports get, post, put from api.js (no raw fetch)',
    /from '\.\.\/api\.js'/.test(detailJs) && !/\bfetch\s*\(/.test(detailJs));
  check('project-detail.js calls requireAuth',
    /requireAuth\(/.test(detailJs));
  check('project-detail.js has submitting race guard',
    /isSubmitting\s*=/.test(detailJs));
  check('project-detail.js accepts bids via PUT /bids/:bidId/accept',
    /\/bids\/.*\/accept/.test(detailJs));
  check('project-detail.js initiates escrow payment via POST /payment/initiate/:ledgerId',
    /\/payment\/initiate\//.test(detailJs));
  check('project-detail.js uses formatTaka for money display',
    /formatTaka/.test(detailJs));
  check('project-detail.js uses formatRelativeTime for dates',
    /formatRelativeTime/.test(detailJs));
  check('project-detail.js does not shadow window.location',
    !/\bconst\s+location\s*=/.test(detailJs));
  check('project-detail.js has langchange re-render handler',
    /langchange/.test(detailJs));
  check('project-detail.js has zero innerHTML assignments',
    !/\.innerHTML\s*=|insertAdjacentHTML\(/.test(detailJs));

  // F8 — Milestone Governance Workspace, Zero-RAM Proof Upload, Approval & Settlement
  const F8_KEYS = [
    'contract.title', 'contract.subtitle', 'contract.ledgerStatus', 'contract.totalValue',
    'contract.parties', 'contract.client', 'contract.contractor', 'contract.milestonesTitle',
    'contract.milestoneNum', 'contract.milestoneStatus.PENDING', 'contract.milestoneStatus.IN_PROGRESS',
    'contract.milestoneStatus.PROOF_SUBMITTED', 'contract.milestoneStatus.CLIENT_APPROVED',
    'contract.milestoneStatus.PAID_OFFLINE', 'contract.milestoneStatus.COMPLETED',
    'contract.milestoneStatus.DISPUTED', 'contract.proof.title', 'contract.proof.empty',
    'contract.proof.uploadCta', 'contract.proof.selectPhoto', 'contract.proof.uploading',
    'contract.proof.hashing', 'contract.proof.locating', 'contract.proof.submitting',
    'contract.proof.success', 'contract.tier.CRYPTOGRAPHIC_PROOF', 'contract.tier.GPS_ONLY',
    'contract.tier.TIME_ONLY', 'contract.tier.REQUIRES_CLIENT_AUDIT', 'contract.action.approve',
    'contract.action.approving', 'contract.action.approveSuccess', 'contract.action.recordPayment',
    'contract.action.dispute', 'contract.action.disputePrompt', 'contract.action.confirmReceipt',
    'contract.paymentModal.title', 'contract.paymentModal.method', 'contract.paymentModal.trxId',
    'contract.paymentModal.receipt', 'contract.paymentModal.amount', 'contract.paymentModal.submit',
    'contract.paymentModal.cancel'
  ];
  for (const k of F8_KEYS) check(`F8 i18n key '${k}' exists in en+bn`, k in MESSAGES.en && k in MESSAGES.bn);

  const contractHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pages', 'contract.html'), 'utf8');
  check('contract.html exists + loads its module',
    /src="\/app\/js\/pages\/contract\.js/.test(contractHtml));
  check('contract.html uses dynamic viewport (100dvh)',
    /min-h-\[100dvh\]/.test(contractHtml) || /min-height:100dvh/.test(contractHtml));
  check('contract.html has aria-live assertive alert banner',
    /aria-live="assertive"/.test(contractHtml));
  check('contract.html has skeleton loader (#loading)',
    /id="loading"/.test(contractHtml) && /aria-busy="true"/.test(contractHtml));
  check('contract.html has #contract-summary',
    /id="contract-summary"/.test(contractHtml));
  check('contract.html has #milestones-list',
    /id="milestones-list"/.test(contractHtml));
  check('contract.html has #payment-modal dialog',
    /id="payment-modal"/.test(contractHtml));
  check('contract.html has #dispute-modal dialog',
    /id="dispute-modal"/.test(contractHtml));
  check('contract.html has no inline <script> (CSP)',
    !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(contractHtml));
  check('contract.html has no inline event handlers (CSP)',
    !/\son[a-z]+=/.test(contractHtml));

  const contractJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'contract.js'), 'utf8');
  check('contract.js imports get, post, uploadPresigned from api.js (no raw fetch)',
    /from '\.\.\/api\.js'/.test(contractJs) && !/\bfetch\s*\(/.test(contractJs));
  check('contract.js calls requireAuth',
    /requireAuth\(/.test(contractJs));
  check('contract.js has submitting race guard',
    /isSubmitting\s*=/.test(contractJs));
  check('contract.js requests presigned proof URL',
    /\/governance\/proof\/presigned-url/.test(contractJs));
  check('contract.js commits proof via evidence endpoint',
    /\/governance\/proof\/evidence/.test(contractJs));
  check('contract.js approves milestone via /governance/approve/',
    /\/governance\/approve\//.test(contractJs));
  check('contract.js disputes milestone via /governance/dispute/',
    /\/governance\/dispute\//.test(contractJs));
  check('contract.js records offline payment via /settlement/milestone/',
    /\/settlement\/milestone\//.test(contractJs) && /submit-payment/.test(contractJs));
  check('contract.js confirms offline payment via confirm-receipt',
    /confirm-receipt/.test(contractJs));
  check('contract.js computes SHA-256 subtle digest',
    /crypto\.subtle\.digest/.test(contractJs));
  check('contract.js uses formatTaka for money display',
    /formatTaka/.test(contractJs));
  check('contract.js uses formatRelativeTime for dates',
    /formatRelativeTime/.test(contractJs));
  check('contract.js does not shadow window.location',
    !/\bconst\s+location\s*=/.test(contractJs));
  check('contract.js has langchange re-render handler',
    /langchange/.test(contractJs));
  check('contract.js has zero innerHTML assignments',
    !/\.innerHTML\s*=|insertAdjacentHTML\(/.test(contractJs));

  // ── Permanent CLI Self-Guard Regressions & Cross-Layer Seams ──
  check('project-detail.js sets workspaceBtn.href to /app/contract.html',
    /workspaceBtn\.href\s*=\s*`\/app\/contract\.html\?id=/.test(detailJs));
  check('project-detail.js preserves both branches of if (ledger.ledgerStatus === \'PENDING_FUNDING\') ... else',
    /if\s*\(\s*ledger\.ledgerStatus\s*===\s*'PENDING_FUNDING'\s*\)[\s\S]*?\}\s*else\s*\{[\s\S]*?fundBtn\.hidden\s*=\s*true[\s\S]*?workspaceBtn\.hidden\s*=\s*false/.test(detailJs));

  const govRouteCode = fs.readFileSync(path.join(__dirname, '..', 'routes', 'governance.js'), 'utf8');
  // Every verification tier (incl. REQUIRES_CLIENT_AUDIT) must advance to
  // PROOF_SUBMITTED, or low-trust evidence deadlocks before client review. The
  // write lives in commitEvidence(), shared by both evidence routes.
  const commitEvidenceBody = (govRouteCode.match(/async function commitEvidence[\s\S]*?\n}\n/) || [''])[0];
  check('routes/governance.js commitEvidence advances milestone.status = PROOF_SUBMITTED + proofOfWorkUrl for every tier',
    /milestone\.status\s*=\s*'PROOF_SUBMITTED';[\s\S]*?milestone\.proofOfWorkUrl\s*=\s*entry\.s3Key;/.test(commitEvidenceBody)
    && !/verificationTier/.test(commitEvidenceBody));
  check('both proof evidence endpoints commit through commitEvidence',
    /\/proof\/evidence\/:ledgerId\/milestone\/:milestoneIndex'[\s\S]*?await commitEvidence\(/.test(govRouteCode)
    && /\/proof\/evidence\/live\/:ledgerId\/milestone\/:milestoneIndex'[\s\S]*?await commitEvidence\(/.test(govRouteCode));

  const settlementRouteCode = fs.readFileSync(path.join(__dirname, '..', 'routes', 'settlement.js'), 'utf8');
  check('routes/settlement.js checks expectedRole inside resolveLedgerAndMilestone',
    /function\s+resolveLedgerAndMilestone\([^)]*expectedRole\s*=\s*'CLIENT'[\s\S]*?expectedRole\s*===\s*'CLIENT'[\s\S]*?expectedRole\s*===\s*'CONTRACTOR'/.test(settlementRouteCode));

  // ── F9 — Live Dashboard Wiring & Off-Thread EXIF Worker Pool ─────────────
  const F9_KEYS = [
    'dash.payment.success', 'dash.payment.fail', 'dash.payment.cancel', 'dash.payment.tranId',
    'dash.counters.title', 'dash.wallet.title', 'dash.wallet.locked', 'dash.wallet.pending', 'dash.wallet.available',
    'dash.kpi.projectsOpen', 'dash.kpi.projectsAssigned', 'dash.kpi.bidsPending', 'dash.kpi.awaitingFunding',
    'dash.kpi.inProgress', 'dash.kpi.disputed', 'dash.kpi.settled',
    'dash.kpi.myBidsPending', 'dash.kpi.myBidsAccepted', 'dash.kpi.myBidsRejected',
    'dash.myProjects.title', 'dash.myProjects.empty', 'dash.myProjects.view', 'dash.myProjects.workspace', 'dash.myProjects.bidsCount',
    'dash.myBids.title', 'dash.myBids.empty', 'dash.myBids.view', 'dash.myBids.workspace', 'dash.myBids.estDays'
  ];
  for (const k of F9_KEYS) check(`F9 i18n key '${k}' exists in en+bn`, k in MESSAGES.en && k in MESSAGES.bn);

  const dashHtmlF9 = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pages', 'dashboard.html'), 'utf8');
  check('dashboard.html has #payment-banner aside',
    /id="payment-banner"/.test(dashHtmlF9));
  check('dashboard.html has #wallet-section',
    /id="wallet-section"/.test(dashHtmlF9));
  check('dashboard.html has #counters-section & #kpi-grid',
    /id="counters-section"/.test(dashHtmlF9) && /id="kpi-grid"/.test(dashHtmlF9));
  check('dashboard.html has #activity-section & #activity-list',
    /id="activity-section"/.test(dashHtmlF9) && /id="activity-list"/.test(dashHtmlF9));
  check('dashboard.html has no inline <script> (CSP)',
    !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(dashHtmlF9));
  check('dashboard.html has no inline event handlers (CSP)',
    !/\son[a-z]+=/.test(dashHtmlF9));

  const dashJsF9 = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'dashboard.js'), 'utf8');
  check('dashboard.js fetches /dashboard/counters',
    /\/dashboard\/counters/.test(dashJsF9));
  check('dashboard.js fetches /projects/mine for CLIENT',
    /\/projects\/mine/.test(dashJsF9));
  check('dashboard.js fetches /bids/mine for CONTRACTOR',
    /\/bids\/mine/.test(dashJsF9));
  check('dashboard.js renders project-detail and contract workspace links',
    /\/app\/project-detail\.html\?id=/.test(dashJsF9) && /\/app\/contract\.html\?id=/.test(dashJsF9));
  check('dashboard.js handles URL payment return query banner',
    /urlParams\.get\(['"]payment['"]\)/.test(dashJsF9) || /URLSearchParams/.test(dashJsF9));
  check('dashboard.js uses formatTaka for money display',
    /formatTaka/.test(dashJsF9));
  check('dashboard.js does not shadow window.location',
    !/\bconst\s+location\s*=/.test(dashJsF9));
  check('dashboard.js has langchange re-render handler',
    /langchange/.test(dashJsF9));
  check('dashboard.js has zero innerHTML assignments',
    !/\.innerHTML\s*=|insertAdjacentHTML\(/.test(dashJsF9));

  const evidenceServiceCode = fs.readFileSync(path.join(__dirname, '..', 'services', 'evidenceService.js'), 'utf8');
  check('evidenceService.js wires parseExifOffThread into verifyImageEvidence',
    /verifyImageEvidence[\s\S]*?await\s+parseExifOffThread\(imageBuffer\)/.test(evidenceServiceCode));

  // ── Brief 04 — Launch Screens L1–L4 ─────────────────────────────────────────
  const launchPages = [
    {
      name: 'contractor-profile',
      roles: ['CONTRACTOR'],
      isMoneyPost: false
    },
    {
      name: 'withdraw',
      roles: ['CONTRACTOR', 'CLIENT'],
      isMoneyPost: true
    },
    {
      name: 'admin-verify',
      roles: ['ADMIN'],
      isMoneyPost: false
    },
    {
      name: 'moderation',
      roles: ['MODERATOR', 'ADMIN'],
      isMoneyPost: true
    }
  ];

  for (const p of launchPages) {
    const htmlPath = path.join(__dirname, '..', 'frontend', 'pages', `${p.name}.html`);
    const jsPath = path.join(__dirname, '..', 'frontend', 'js', 'pages', `${p.name}.js`);
    check(`${p.name}.html page file exists`, fs.existsSync(htmlPath));
    check(`${p.name}.js script file exists`, fs.existsSync(jsPath));

    const htmlContent = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
    const jsContent = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';

    check(`${p.name}.html has no inline <script> (CSP)`, !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(htmlContent));
    check(`${p.name}.html has no inline event handlers (CSP)`, !/\son[a-z]+=/.test(htmlContent));

    for (const role of p.roles) {
      check(`${p.name}.js guards access with requireAuth for role ${role}`,
        new RegExp(`requireAuth\\(\\s*\\{[^}]*roles:\\s*\\[[^\\]]*['"]${role}['"]`).test(jsContent));
    }

    check(`${p.name}.js has zero innerHTML assignments (pure DOM)`,
      !/\.innerHTML\s*=|insertAdjacentHTML\(/.test(jsContent));

    if (p.isMoneyPost) {
      check(`${p.name}.js passes idempotencyKey on mutating POSTs`,
        /idempotencyKey/.test(jsContent) && /newIdempotencyKey/.test(jsContent));
    }
  }

  // Dashboard role-gated entry buttons
  const dashHtmlL = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pages', 'dashboard.html'), 'utf8');
  check('dashboard.html has cta-contractor-profile', /id="cta-contractor-profile"/.test(dashHtmlL));
  check('dashboard.html has cta-contractor-withdraw', /id="cta-contractor-withdraw"/.test(dashHtmlL));
  check('dashboard.html has cta-admin-verify', /id="cta-admin-verify"/.test(dashHtmlL));
  check('dashboard.html has cta-moderation', /id="cta-moderation"/.test(dashHtmlL));

  const dashJsL = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'dashboard.js'), 'utf8');
  check('dashboard.js shows profile + withdraw for CONTRACTOR',
    /cta-contractor-profile/.test(dashJsL) && /cta-contractor-withdraw/.test(dashJsL));
  check('dashboard.js shows verify + moderation for ADMIN',
    /cta-admin-verify/.test(dashJsL) && /cta-moderation/.test(dashJsL));
  check('dashboard.js shows moderation for MODERATOR',
    /currentUser\.role\s*===\s*['"]MODERATOR['"][\s\S]*?cta-moderation/.test(dashJsL));

  // submit-bid.js links to contractor profile on failure
  const submitBidJs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'submit-bid.js'), 'utf8');
  check('submit-bid.js links to /app/contractor-profile.html when profile required',
    /\/app\/contractor-profile\.html/.test(submitBidJs) && /Contractor profile required/.test(submitBidJs));

  // ── Brief 11 — Stage 1+2 UI Hardening Guards ────────────────────────────────
  const B11_KEYS = [
    'banner.testMode',
    'withdraw.clientTitle',
    'withdraw.clientIntro',
    'dash.cta.clientWithdraw',
    'detail.cancelProjectBtn',
    'detail.cancelConfirmTitle',
    'detail.cancelConfirmMessage',
    'detail.cancelConfirmBtn',
    'detail.cancelSuccess',
    'profile.editBtn',
    'profile.editTitle',
    'profile.recheckNotice',
    'contract.milestone.restarted',
    'profile.willingToTravel',
    'profile.addDistrict',
    'common.close'
  ];
  for (const k of B11_KEYS) {
    check(`Brief 11 i18n key '${k}' exists in en and bn`, k in MESSAGES.en && k in MESSAGES.bn);
  }

  // Screen A: Client withdraw
  const withdrawHtmlB11 = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pages', 'withdraw.html'), 'utf8');
  const withdrawJsB11 = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'withdraw.js'), 'utf8');
  check('withdraw.html has #card-balance-pending container', /id="card-balance-pending"/.test(withdrawHtmlB11));
  check('withdraw.js customizes title/intro for CLIENT', /withdraw\.clientTitle/.test(withdrawJsB11) && /withdraw\.clientIntro/.test(withdrawJsB11));
  check('withdraw.js hides pending clearance card for CLIENT', /card-balance-pending[\s\S]*?hidden\s*=\s*true/.test(withdrawJsB11));
  check('dashboard.html has cta-client-withdraw', /id="cta-client-withdraw"/.test(dashHtmlL));
  check('dashboard.js shows cta-client-withdraw when availableToWithdraw > 0',
    /cta-client-withdraw[\s\S]*?availableToWithdraw\s*>\s*0/.test(dashJsL));

  // Screen B: Test-mode banner
  const shellJsB11 = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'shell.js'), 'utf8');
  check('shell.js checks /environment payments.gateway', /\/environment/.test(shellJsB11) && /payments[\s\S]*?gateway\s*===\s*['"]mock['"]/.test(shellJsB11));
  check('shell.js renders #test-mode-banner with pure DOM', /test-mode-banner/.test(shellJsB11) && !/\.innerHTML\s*=/.test(shellJsB11));

  // Screen C: Cancel project
  const projDetailHtmlB11 = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pages', 'project-detail.html'), 'utf8');
  const projDetailJsB11 = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'project-detail.js'), 'utf8');
  check('project-detail.html has #btn-cancel-project', /id="btn-cancel-project"/.test(projDetailHtmlB11));
  check('project-detail.html has #cancel-project-modal dialog', /<dialog[^>]*id="cancel-project-modal"/.test(projDetailHtmlB11));
  check('project-detail.html modal close button has data-i18n-aria="common.close"', /data-i18n-aria="common\.close"/.test(projDetailHtmlB11));
  check('project-detail.js checks owner using currentUser.id', /String\(currentUser\.id\b/.test(projDetailJsB11));
  check('project-detail.js calls POST /projects/:id/cancel', /\/projects\/.*\/cancel/.test(projDetailJsB11));
  check('project-detail.js sets status to CANCELLED on success', /currentProject\.status\s*=\s*['"]CANCELLED['"]/.test(projDetailJsB11));

  // Screen D: Contractor profile edit
  const profHtmlB11 = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'pages', 'contractor-profile.html'), 'utf8');
  const profJsB11 = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'contractor-profile.js'), 'utf8');
  check('contractor-profile.html has #btn-edit-profile', /id="btn-edit-profile"/.test(profHtmlB11));
  check('contractor-profile.html has #service-areas-container and #btn-add-district',
    /id="service-areas-container"/.test(profHtmlB11) && /id="btn-add-district"/.test(profHtmlB11));
  check('contractor-profile.html Add District button has min-h-[44px]',
    /btn-add-district[\s\S]*?min-h-\[44px\]/.test(profHtmlB11));
  check('contractor-profile.html Add District button has data-i18n="profile.addDistrict" without +',
    /data-i18n="profile\.addDistrict">Add District</.test(profHtmlB11));
  check('contractor-profile.js calls PATCH /contractor-profile/me', /patch\(['"]\/contractor-profile\/me['"]/.test(profJsB11));
  check('contractor-profile.js uses profile.willingToTravel and profile.removeDistrict',
    /profile\.willingToTravel/.test(profJsB11) && /profile\.removeDistrict/.test(profJsB11));
  check('contractor-profile.js displays re-check notice', /profile\.recheckNotice/.test(profJsB11));

  // Screen E & F: Honest evidence wording & restarted milestones
  const contractJsB11 = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'contract.js'), 'utf8');
  check('contract.js uses neutral styling for CRYPTOGRAPHIC_PROOF badge (no green success border)',
    /tier\s*===\s*['"]CRYPTOGRAPHIC_PROOF['"][\s\S]*?bg-surface-variant[\s\S]*?border-outline-variant/.test(contractJsB11));
  check('contract.js renders restarted milestone friendly notice',
    /milestone\.status\s*===\s*['"]IN_PROGRESS['"][\s\S]*?contract\.milestone\.restarted/.test(contractJsB11));

  // Screen G: Masked phone in bid list
  check('project-detail.js renders contractorName and masked phone',
    /contractorName[\s\S]*?phoneNumber/.test(projDetailJsB11));

  // ── Task T1 Detailed Guards (F1–F8) ──────────────────────────────────────────
  // F1: Payments off banner & live gateway separation
  check('shell.js renders payments-off banner when payments.enabled is false',
    /banner\.paymentsOff/.test(shellJsB11) && /payments\?\.enabled\s*===\s*false/.test(shellJsB11));
  check('shell.js never displays test mode when gateway is live',
    /payments\?\.gateway\s*===\s*['"]mock['"]/.test(shellJsB11) && /banner\.paymentsOff/.test(shellJsB11));

  // F3: Single-district placeholder without hard-coded fallback
  check('contractor-profile.js uses profile.districtPlaceholder on area input without District fallback',
    /profile\.districtPlaceholder/.test(profJsB11) && !/\|\|\s*['"]District['"]/.test(profJsB11));

  // F4: Dynamic area row tagging and querySelector
  check('contractor-profile.js area rows use data-area-row attribute and selector',
    /dataset\.areaRow\s*=\s*['"]1['"]/.test(profJsB11) && /\[data-area-row\]/.test(profJsB11));

  // F5: Bidder phone masking and translated role
  check('project-detail.js masks contractor phone unless bid is ACCEPTED',
    /bid\.status\s*===\s*['"]ACCEPTED['"]\s*\?\s*bid\.contractorId\?\.phoneNumber\s*:\s*null/.test(projDetailJsB11));
  check('project-detail.js uses role.contractor fallback instead of literal Contractor',
    /bid\.contractorName\s*\|\|\s*t\(['"]role\.contractor['"]\)/.test(projDetailJsB11) && !/contractorName\s*\|\|\s*['"]Contractor['"]/.test(projDetailJsB11));

  // F7: Cancel project error branches and idempotency reuse
  check('project-detail.js wireCancelProject handles 409 conflict and refreshes project',
    /err\.status\s*===\s*409[\s\S]*?cancelConflict[\s\S]*?refreshProjectData/.test(projDetailJsB11));
  check('project-detail.js wireCancelProject reuses idempotency key across retries',
    /cancelIdempotencyKey[\s\S]*?newIdempotencyKey[\s\S]*?idempotencyKey:\s*cancelIdempotencyKey/.test(projDetailJsB11));

  // F8: EOF whitespace cleanliness
  check('shell.js has no trailing blank line at EOF',
    !/\n\s*\n\s*$/.test(shellJsB11));

  // i18n keys existence in both en and bn
  check('T1 i18n key banner.paymentsOff exists in en and bn',
    Boolean(MESSAGES.en['banner.paymentsOff'] && MESSAGES.bn['banner.paymentsOff']));
  check('T1 i18n key profile.removeDistrict exists in en and bn',
    Boolean(MESSAGES.en['profile.removeDistrict'] && MESSAGES.bn['profile.removeDistrict']));
  check('T1 i18n key profile.districtPlaceholder exists in en and bn',
    Boolean(MESSAGES.en['profile.districtPlaceholder'] && MESSAGES.bn['profile.districtPlaceholder']));
  check('T1 i18n key detail.err.cancelConflict exists in en and bn',
    Boolean(MESSAGES.en['detail.err.cancelConflict'] && MESSAGES.bn['detail.err.cancelConflict']));

  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);


})().catch((err) => { console.error('💥 frontend-unit crashed:', err); process.exit(1); });
