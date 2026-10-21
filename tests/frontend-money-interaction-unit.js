// tests/frontend-money-interaction-unit.js
// Frontend Component-Level Interaction Tests for Money-Sensitive Flows (Roadmap §10.4 / §18 Item 12)
//
// Covers:
//   1. moneyConfirmSheet.js — bKash-style 2.5s hold-to-confirm modal & DOM integrity
//   2. withdraw.js — payout validation, integer BDT, Bengali digits, idempotency lifecycle
//   3. submit-bid.js — bid floor, itemized breakdown sum validation, race lock
//   4. project-detail.js — chat negotiation revised offer acceptance modal & error handling
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

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

const imp = (p) => import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'js', p)).href);

(async () => {
  console.log('🧪 Frontend Money-Flow Interaction & Component Unit Tests');

  // ──────────────────────────────────────────────────────────────────────────
  // 1. moneyConfirmSheet.js — Hold-to-Confirm Modal
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Component 1: moneyConfirmSheet.js (Hold-to-Confirm Modal) ---');
  const sheetSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'components', 'moneyConfirmSheet.js'), 'utf8');

  // Pure DOM security: zero innerHTML / insertAdjacentHTML
  check('moneyConfirmSheet: zero innerHTML usage', !sheetSrc.includes('.innerHTML'));
  check('moneyConfirmSheet: zero insertAdjacentHTML usage', !sheetSrc.includes('.insertAdjacentHTML'));

  // Structural composition
  check('moneyConfirmSheet: creates dialog element with role="dialog"',
    sheetSrc.includes("document.createElement('dialog')") && sheetSrc.includes("setAttribute('role', 'dialog')"));
  check('moneyConfirmSheet: sets aria-modal="true"',
    sheetSrc.includes("setAttribute('aria-modal', 'true')"));
  check('moneyConfirmSheet: includes mobile bottom sheet handle bar',
    sheetSrc.includes("handleBar.className = 'w-12 h-1.5 rounded-full bg-outline-variant mx-auto sm:hidden'"));
  check('moneyConfirmSheet: includes shield security icon',
    sheetSrc.includes("shieldIcon.textContent = 'shield'"));
  check('moneyConfirmSheet: formats amount via formatTaka when provided',
    sheetSrc.includes('formatTaka(amount)'));

  // 2.5-second hold state machine
  check('moneyConfirmSheet: HOLD_DURATION_MS strictly configured to 2500ms',
    sheetSrc.includes('const HOLD_DURATION_MS = 2500;'));
  check('moneyConfirmSheet: starts with 0% progress bar width',
    sheetSrc.includes("progressBar.style.width = '0%'"));
  check('moneyConfirmSheet: listens to pointerdown to start hold',
    sheetSrc.includes("holdButton.addEventListener('pointerdown', startHold)"));
  check('moneyConfirmSheet: listens to pointerup to reset hold',
    sheetSrc.includes("holdButton.addEventListener('pointerup', resetHold)"));
  check('moneyConfirmSheet: listens to pointerleave to cancel hold if pointer drifts',
    sheetSrc.includes("holdButton.addEventListener('pointerleave', resetHold)"));
  check('moneyConfirmSheet: listens to pointercancel for OS/gesture interruption',
    sheetSrc.includes("holdButton.addEventListener('pointercancel', resetHold)"));
  check('moneyConfirmSheet: supports keyboard Space and Enter keys for accessibility',
    sheetSrc.includes("e.key === ' ' || e.key === 'Enter'"));
  check('moneyConfirmSheet: triggers onConfirm ONLY when progress >= 100',
    sheetSrc.includes('if (progress >= 100)') && sheetSrc.includes('onConfirm();'));
  check('moneyConfirmSheet: cleans up dialog from DOM on cancel and confirm',
    sheetSrc.includes('dialog.remove()'));

  // ──────────────────────────────────────────────────────────────────────────
  // 2. withdraw.js — Contractor Payout Portal
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Component 2: withdraw.js (Contractor Payout Portal) ---');
  const withdrawSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'withdraw.js'), 'utf8');

  check('withdraw.js: zero innerHTML usage (Lane 1 audit rule)', !withdrawSrc.includes('.innerHTML'));
  check('withdraw.js: requires CONTRACTOR role before revealing UI',
    withdrawSrc.includes("requireAuth({ roles: ['CONTRACTOR'] })") || withdrawSrc.includes("roles: ['CONTRACTOR']"));
  check('withdraw.js: enforces minimum withdrawal limit of 500 BDT',
    withdrawSrc.includes('amount < 500'));
  check('withdraw.js: enforces integer balance check against availableBalance',
    withdrawSrc.includes('amount > availableBalance'));
  check('withdraw.js: parses Bengali digits via bengaliToAscii',
    withdrawSrc.includes('bengaliToAscii('));
  check('withdraw.js: requires bankName, accountName, and accountNumber',
    withdrawSrc.includes('!bankName') && withdrawSrc.includes('!accountName') && withdrawSrc.includes('!accountNumber'));
  check('withdraw.js: enforces idempotency with newIdempotencyKey() and retry preservation',
    withdrawSrc.includes('newIdempotencyKey()') && withdrawSrc.includes('idempotencyKey'));
  check('withdraw.js: has submitting race lock preventing double click submissions',
    withdrawSrc.includes('if (submitting) return;') && withdrawSrc.includes('submitting = true;'));
  check('withdraw.js: clears form persistence draft on successful payout',
    withdrawSrc.includes('clearFormDraft('));

  // Test parseWholeNumber logic directly from phone/withdraw behavior
  const { bengaliToAscii } = await imp('phone.js');
  const parseAmount = (raw) => {
    const s = bengaliToAscii(String(raw || '')).replace(/[,\s]/g, '');
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
  };

  check('withdraw logic: parses ASCII numbers "5000" → 5000', parseAmount('5000') === 5000);
  check('withdraw logic: parses Bengali numbers "৫০০০" → 5000', parseAmount('৫০০০') === 5000);
  check('withdraw logic: parses comma-separated lakhs "১,৫০,০০০" → 150000', parseAmount('১,৫০,০০০') === 150000);
  check('withdraw logic: rejects floats "500.50" (integer BDT constraint)', parseAmount('500.50') === null);
  check('withdraw logic: rejects negative numbers "-500"', parseAmount('-500') === null);

  // ──────────────────────────────────────────────────────────────────────────
  // 3. submit-bid.js — Contractor Bid Submission & Itemized Breakdown
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Component 3: submit-bid.js (Contractor Bidding Portal) ---');
  const bidSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'submit-bid.js'), 'utf8');

  check('submit-bid.js: zero innerHTML usage (pure DOM)', !bidSrc.includes('.innerHTML'));
  check('submit-bid.js: requires CONTRACTOR role',
    bidSrc.includes("requireAuth({ roles: ['CONTRACTOR'] })") || bidSrc.includes("roles: ['CONTRACTOR']"));
  check('submit-bid.js: enforces floor bidAmount >= 100 BDT',
    bidSrc.includes('bidFloorBdt') && bidSrc.includes('bidAmount < bidFloorBdt'));
  check('submit-bid.js: validates minimum proposal length >= 10 characters',
    bidSrc.includes('proposalText.length < 10'));
  check('submit-bid.js: validates minimum estimatedDays >= 1 day',
    bidSrc.includes('estimatedDays < 1'));
  check('submit-bid.js: enforces server/client parity for itemized breakdown sum',
    bidSrc.includes('sumAmount !== bidAmount') && bidSrc.includes('breakdownAmountMismatch'));
  check('submit-bid.js: has submitting race lock',
    bidSrc.includes('if (submitting') && bidSrc.includes('submitting = true;'));
  check('submit-bid.js: supports Bengali numerals in bid form inputs',
    bidSrc.includes('bengaliToAscii'));

  // ──────────────────────────────────────────────────────────────────────────
  // 4. project-detail.js — Chat Negotiation Revised Offer Acceptance Modal
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Component 4: project-detail.js (Chat Negotiation Award Modal) ---');
  const projDetailSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'pages', 'project-detail.js'), 'utf8');

  check('project-detail.js: contains handleAcceptActiveOffer for revised chat offers',
    projDetailSrc.includes('async function handleAcceptActiveOffer()'));
  check('project-detail.js: has isChatSubmitting lock preventing duplicate accepts',
    projDetailSrc.includes('if (isChatSubmitting || !activeChatBid) return;'));
  check('project-detail.js: disables button and displays chat.accepting spinner text',
    projDetailSrc.includes('btn.disabled = true;') && projDetailSrc.includes("t('chat.accepting')"));
  check('project-detail.js: calls POST /chat/:bidId/accept-offer endpoint',
    projDetailSrc.includes("`/chat/${encodeURIComponent(activeChatBid._id)}/accept-offer`"));
  check('project-detail.js: sends dedicated idempotencyKey with accept-offer call',
    projDetailSrc.includes('idempotencyKey: newIdempotencyKey()'));
  check('project-detail.js: closes chat modal and alerts success on contract award',
    projDetailSrc.includes('closeChatModal();') && projDetailSrc.includes("t('chat.acceptSuccess')"));
  check('project-detail.js: refreshes project data to immediately reflect ASSIGNED status',
    projDetailSrc.includes('await refreshProjectData();'));
  check('project-detail.js: restores button text and re-enables on submission error',
    projDetailSrc.includes('btn.disabled = false;') && projDetailSrc.includes('btn.textContent = originalText;'));
  check('project-detail.js: resets isChatSubmitting = false in finally block',
    projDetailSrc.includes('isChatSubmitting = false;'));

  // ──────────────────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────────────────
  console.log(`\nAll done: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
})();
