// scripts/qa/route-policy.js — inspects the REAL Express routers (not source
// text) and enforces API security invariants. A new endpoint that forgets
// authentication, orders a role check before authentication, or moves money
// without idempotency fails this gate in CI. Authenticated READ routes must carry a
// role gate too, or a recorded ownership review (a deleted requireRole on an admin
// queue used to pass this gate).
'use strict';

const fs = require('fs');
const path = require('path');
const { createReport, runCli } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');

// Mount table — cross-checked against server.js below so it can't drift.
const MOUNTS = [
  ['/api/auth', 'routes/auth'],
  ['/api/projects/:id/materials', 'routes/projectMaterials'],
  ['/api/projects', 'routes/project'],
  ['/api/bids', 'routes/bid'],
  ['/api/contracts', 'routes/contract'],
  ['/api/contractor-profile', 'routes/contractorProfile'],
  ['/api/supplier', 'routes/supplier'],
  ['/api/materials/orders', 'routes/materialOrders'],
  ['/api/materials', 'routes/materials'],
  ['/api/payment', 'routes/payment'],
  ['/api/governance', 'routes/governance'],
  ['/api/finance', 'routes/finance'],
  ['/api/settlement', 'routes/settlement'],
  ['/api/moderation', 'routes/arbitration'],
  ['/api/chat', 'routes/chat'],
  ['/api/reviews', 'routes/review'],
  ['/api/dashboard', 'routes/dashboard'],
  ['/api/admin', 'routes/admin'],
  ['/api/ai', 'routes/aiOrchestrator'],
  ['/api/v2/labour', 'routes/labourV2'],
  ['/api/v2/projects', 'routes/hybridV2'],
  ['/__storage', 'routes/localStorage']
];

// Deliberately public. Every entry needs a reason a reviewer can check.
const PUBLIC_ROUTES = {
  'POST /api/auth/send-otp': 'starts login; rate-limited + invite-gated',
  'POST /api/auth/verify-otp': 'completes login; per-account attempt cap',
  'POST /api/auth/passkey/register/options': 'passkey ceremony step 1',
  'POST /api/auth/passkey/register/verify': 'gated by fresh OTP proof',
  'POST /api/auth/passkey/authenticate/options': 'passkey login step 1',
  'POST /api/auth/passkey/authenticate/verify': 'passkey login step 2 (signature)',
  'POST /api/payment/ipn': 'SSLCommerz server-to-server; HMAC signature + validator',
  'GET /api/payment/success': 'browser redirect from SSLCommerz; no state change',
  'POST /api/payment/success': 'browser redirect from SSLCommerz; no state change',
  'GET /api/payment/fail': 'browser redirect from SSLCommerz; no state change',
  'POST /api/payment/fail': 'browser redirect from SSLCommerz; no state change',
  'GET /api/payment/cancel': 'browser redirect from SSLCommerz; no state change',
  'POST /api/payment/cancel': 'browser redirect from SSLCommerz; no state change',
  'PUT /__storage/upload/:token': 'authorised by a short-lived HMAC upload token',
  'GET /api/reviews/contractor/:contractorId': 'public contractor reputation',
  'GET /api/supplier/directory': 'public verified supplier directory; no PII',
  'GET /api/supplier/:id': 'public verified single supplier card; no PII',
  'GET /api/materials/catalog': 'public materials catalog; filterable, no PII',
  'GET /api/materials/products/:id': 'public single material SKU details; filterable, no PII',
  'GET /api/projects/shared/:rawToken': 'public delegate view via 32-byte secret token; financial fields scrubbed',
  'POST /api/v2/labour/webhooks/sms-ivr-inbound': 'telecom inbound SMS/IVR webhook; verified by payload/phone signature',
  'GET /api/v2/labour/directory/search': 'public domestic worker directory search with PII-redacted profiles',
  'POST /api/v2/labour/workers/onboard': 'public self-onboarding for domestic workers/caregivers with Darwan guarantor; no money moves',
  'POST /api/ai/orchestrate': 'bilingual voice and text intent inference; read-only slot extraction and pricing calculator; no money moves',
  'GET /api/projects/exchange': 'public categorized works exchange feed; no PII, competitor bid amounts excluded by query projection',
  'GET /api/projects/feed': 'public categorized works exchange feed (alias); no PII, competitor bid amounts excluded by query projection'
};

// Money-moving or escrow-state endpoints: retries must be idempotent.
const MONEY_ROUTES = [
  'POST /api/governance/approve/:ledgerId/milestone/:milestoneIndex',
  'POST /api/governance/dispute/:ledgerId/milestone/:milestoneIndex',
  'POST /api/governance/arbitrate/:ledgerId/milestone/:milestoneIndex',
  'POST /api/settlement/milestone/:id/approve',
  'POST /api/settlement/milestone/:id/reject',
  'POST /api/settlement/milestone/:id/submit-payment',
  'POST /api/moderation/dispute/:ticketId/resolve',
  'POST /api/contracts/create-from-bid/:bidId',
  'POST /api/finance/withdraw',
  'POST /api/settlement/milestone/:id/confirm-receipt',
  'POST /api/admin/refunds/:ledgerId/:valId/complete',
  'POST /api/v2/labour/contracts/subscribe',
  'POST /api/v2/projects/micro/dispatch',
  'POST /api/v2/labour/disputes/security-gd',
  'POST /api/materials/orders/:id/fund-escrow',
  'POST /api/materials/orders/:id/confirm-delivery',
  'POST /api/materials/orders/:id/resolve-dispute'
];

// Authenticated mutations reviewed as safe WITHOUT idempotency middleware.
// A new mutation not listed here raises a WARN until someone reviews it.
const REVIEWED_MUTATIONS = {
  'POST /api/auth/logout': 'naturally idempotent (revoke + clear cookie)',
  'POST /api/projects': 'retry can create a duplicate draft project; no money moves',
  'POST /api/projects/wizard-submit': 'same as POST /api/projects',
  'POST /api/projects/:id/cancel': 'OPEN→CANCELLED compare-and-set; cancelling again answers 200 "already cancelled"; no money moves',
  'PATCH /api/contractor-profile/me': 'sets the caller\'s own profile fields to the sent values; repeating the same request changes nothing',
  'POST /api/bids/:projectId': 'unique (projectId, contractorId) index → retry returns 409',
  'POST /api/bids/sign/:projectId': 'attaches a signature to the caller\'s own bid; re-signing is harmless',
  'PUT /api/bids/:bidId/accept': 'PENDING→ACCEPTED status check inside a transaction → retry returns 409',
  'POST /api/contractor-profile': 'findOneAndUpdate upsert keyed on userId',
  'PATCH /api/contractor-profile/:userId/verify': 'admin sets a verification level; repeating sets the same value',
  'POST /api/payment/initiate/:ledgerId': 'PENDING_FUNDING CAS; KNOWN ISSUE: re-initiate replaces tran_id (task #41)',
  'POST /api/governance/proof/signature/:ledgerId/milestone/:milestoneIndex': 'issues a fresh upload URL; no state change',
  'POST /api/governance/proof/confirm/:ledgerId/milestone/:milestoneIndex': 'state-checked transition to PROOF_SUBMITTED',
  'POST /api/governance/proof/evidence/:ledgerId/milestone/:milestoneIndex': 'image-hash double-spend check rejects re-submission',
  'POST /api/governance/proof/evidence/live/:ledgerId/milestone/:milestoneIndex': 'same image-hash check as /evidence',
  'POST /api/chat/offer/:messageId/accept': 'offer status check → second accept returns 409',
  'POST /api/chat/:bidId/accept-offer': 'offer status check → second accept returns 409',
  'POST /api/chat/bid/:bidId/message': 'retry may duplicate a chat message; no money moves',
  'POST /api/chat/:bidId/message': 'alias of the message route',
  'POST /api/chat/:bidId/messages': 'alias of the message route',
  'POST /api/reviews': 'unique review per project/client → retry returns 409',
  'POST /api/bids/:bidId/withdraw': 'CAS (contractorId, status=PENDING) → retry on an already-withdrawn bid returns 409',
  'POST /api/supplier/profile': 'findOneAndUpdate upsert keyed on userId; no money moves',
  'PATCH /api/supplier/:userId/verify': 'admin sets supplier verification status with audit log; repeating sets the same value',
  'POST /api/materials/products': 'creates a material SKU; verified supplier role check; no money moves',
  'PATCH /api/materials/products/:id': 'updates a material SKU; supplier ownership check; no money moves',
  'POST /api/materials/orders': 'creates a bulk material purchase order; buyer role check; stock validated; no money moves',
  'PATCH /api/materials/orders/:id/accept': 'CAS transition from PENDING_SUPPLIER_ACCEPTANCE to ACCEPTED; supplier ownership check',
  'PATCH /api/materials/orders/:id/reject': 'CAS transition from PENDING_SUPPLIER_ACCEPTANCE to REJECTED; supplier ownership check',
  'POST /api/materials/orders/:id/dispatch': 'CAS transition from ESCROW_FUNDED to DISPATCHED; supplier ownership check; waybill recorded',
  'POST /api/materials/orders/:id/mark-delivered': 'CAS transition from DISPATCHED to DELIVERED; supplier ownership check; delivery proof recorded',
  'POST /api/materials/orders/:id/dispute': 'CAS transition to DISPUTED; buyer/supplier ownership check; locks escrow',
  'POST /api/projects/:id/shares': 'generates 32-byte crypto token and saves ProjectShareToken; client ownership check',
  'DELETE /api/projects/:id/shares/:shareId': 'marks share token isRevoked: true; client ownership check',
  'POST /api/v2/projects/mid/estimate-boq': 'parametric renovation and house shifting split-BOQ calculator; no state change; no money moves'
};

// Authenticated mutations without a requireRole gate, reviewed as checking
// ownership inside the handler.
const REVIEWED_NO_ROLE = {
  'POST /api/auth/logout': 'any signed-in user may sign themselves out',
  'POST /api/chat/offer/:messageId/accept': 'acceptOfferHandler verifies the caller owns the bid/project',
  'POST /api/chat/:bidId/accept-offer': 'acceptOfferHandler verifies the caller owns the bid/project',
  'POST /api/chat/bid/:bidId/message': 'checkParticipant: only the bid\'s client/contractor',
  'POST /api/chat/:bidId/message': 'checkParticipant: only the bid\'s client/contractor',
  'POST /api/chat/:bidId/messages': 'checkParticipant: only the bid\'s client/contractor'
};

// Authenticated READ routes without a requireRole gate. A read with no role gate is only safe if the handler scopes
// the data to the caller or checks that the caller is a party — record that here, with the reason, after verifying it.
// A new read route missing from both this list and the role gates FAILS the gate (a data-exposure risk, not a style nit).
const REVIEWED_READ_NO_ROLE = {
  'GET /api/auth/me': 'returns only the caller own account (findById(req.user.userId))',
  'GET /api/auth/passkey/credentials': 'lists only the caller own passkeys (userId: req.user.userId)',
  'GET /api/projects/:id': 'handler computes owner/awarded/staff access: strangers get 403/404, contractors only see OPEN or their own bid',
  'GET /api/contracts/by-project/:projectId': 'handler returns 403 unless the caller is the client or awarded contractor of the project',
  'GET /api/chat/bid/:bidId': 'verifyBidParticipant: only the client or contractor of the bid',
  'GET /api/chat/:bidId': 'alias of GET /api/chat/bid/:bidId (verifyBidParticipant)',
  'GET /api/dashboard/counters': 'every query is scoped by req.user.userId and branched on req.user.role',
  'GET /api/materials/orders/project/:projectId/ledger': 'handler returns 403 unless the caller is the client or awarded contractor of the project or admin'
};

const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Authenticated read routes that have neither a requireRole gate nor a recorded ownership review.
 * Pure function so tests/route-policy-unit.js can prove it fails when a gate is removed.
 */
function readRoleGaps(routes, reviewed = REVIEWED_READ_NO_ROLE) {
  return routes
    .filter((r) => r.authed && !MUTATING.includes(r.method) && !r.roles && !reviewed[r.key])
    .map((r) => r.key);
}

function collectRoutes(verifyToken, enforceIdempotency) {
  const routes = [];
  for (const [mount, mod] of MOUNTS) {
    const file = path.join(ROOT, `${mod}.js`);
    if (!fs.existsSync(file)) continue;
    const router = require(file);
    let routerLevelAuth = false;
    for (const layer of router.stack || []) {
      if (!layer.route) {
        if (layer.handle === verifyToken) routerLevelAuth = true;
        continue;
      }
      const handles = layer.route.stack.map((l) => l.handle);
      const authIdx = handles.indexOf(verifyToken);
      const roleIdx = handles.findIndex((h) => Array.isArray(h.requiredRoles));
      const idemIdx = handles.indexOf(enforceIdempotency);
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths)
      for (const method of Object.keys(layer.route.methods).filter((m) => layer.route.methods[m] && m !== '_all')) {
        routes.push({
          key: `${method.toUpperCase()} ${mount}${p === '/' ? '' : p}`,
          method: method.toUpperCase(),
          authed: routerLevelAuth || authIdx !== -1,
          authIdx: routerLevelAuth ? -1 : authIdx,
          roles: roleIdx !== -1 ? handles[roleIdx].requiredRoles : null,
          roleIdx,
          idempotent: idemIdx !== -1,
          idemIdx
        });
      }
    }
  }
  return routes;
}

async function run() {
  const report = createReport('Route policy');
  const { verifyToken } = require(path.join(ROOT, 'middleware', 'auth'));
  const { enforceIdempotency } = require(path.join(ROOT, 'middleware', 'idempotency'));

  // Mount table must match server.js.
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const missingMounts = MOUNTS.filter(([m]) => !serverSrc.includes(`'${m}'`)).map(([m]) => m);
  if (missingMounts.length) report.fail('mount-table', 'QA mount table lists paths server.js does not mount (update MOUNTS)', missingMounts);
  // '/api' alone is the gateway rate limiter, not a router.
  const unknownMounts = [...serverSrc.matchAll(/app\.use\(\s*'(\/(?:api|__)[^']*)'/g)].map((m) => m[1])
    .filter((m) => m !== '/api' && !MOUNTS.some(([x]) => x === m));
  if (unknownMounts.length) report.fail('mount-table', 'server.js mounts routers the QA policy does not inspect (add to MOUNTS)', [...new Set(unknownMounts)]);
  else if (!missingMounts.length) report.pass('mount-table', `QA mount table matches server.js (${MOUNTS.length} routers)`);

  const routes = collectRoutes(verifyToken, enforceIdempotency);
  report.info('inventory', `${routes.length} route handlers inspected`);

  // 1. Authentication on everything not explicitly public.
  const unauthed = routes.filter((r) => !r.authed && !PUBLIC_ROUTES[r.key]);
  if (unauthed.length) report.fail('auth-required', 'Routes reachable without authentication that are not on the reviewed public list', unauthed.map((r) => r.key));
  else report.pass('auth-required', 'Every non-public route requires authentication');

  const stalePublic = Object.keys(PUBLIC_ROUTES).filter((k) => !routes.some((r) => r.key === k));
  if (stalePublic.length) report.warn('public-list-stale', 'Public allow-list entries match no route (remove them)', stalePublic);
  const publicButAuthed = routes.filter((r) => PUBLIC_ROUTES[r.key] && r.authed);
  if (publicButAuthed.length) report.info('public-list-authed', 'Allow-listed routes that do authenticate anyway', publicButAuthed.map((r) => r.key));

  // 2. Role checks must run after authentication (requireRole reads req.user).
  const misordered = routes.filter((r) => r.roleIdx !== -1 && r.authIdx !== -1 && r.roleIdx < r.authIdx);
  if (misordered.length) report.fail('role-after-auth', 'requireRole runs before verifyToken', misordered.map((r) => r.key));
  else report.pass('role-after-auth', 'Every role gate runs after authentication');

  // 3. Idempotency on money routes, and placed after auth (it keys on userId).
  for (const key of MONEY_ROUTES) {
    const r = routes.find((x) => x.key === key);
    if (!r) { report.fail(`idem:${key}`, 'Money route listed in policy no longer exists (update MONEY_ROUTES)'); continue; }
    if (!r.idempotent) report.fail(`idem:${key}`, 'Money route missing enforceIdempotency');
    else if (r.authIdx !== -1 && r.idemIdx < r.authIdx) report.fail(`idem:${key}`, 'enforceIdempotency runs before verifyToken (it needs req.user)');
    else report.pass(`idem:${key}`, 'idempotent, after auth');
  }

  // 4. Other state-changing authenticated routes without idempotency: review list.
  const review = routes.filter((r) => r.authed && MUTATING.includes(r.method)
    && !r.idempotent && !MONEY_ROUTES.includes(r.key) && !REVIEWED_MUTATIONS[r.key]);
  if (review.length) report.warn('mutations-without-idempotency', 'NEW authenticated mutations without idempotency — review, then record why in REVIEWED_MUTATIONS', review.map((r) => r.key));
  else report.pass('mutations-without-idempotency', `All ${Object.keys(REVIEWED_MUTATIONS).length} non-idempotent mutations carry a recorded safety review`);

  // 5. Role coverage for mutations.
  const noRole = routes.filter((r) => r.authed && MUTATING.includes(r.method) && !r.roles && !REVIEWED_NO_ROLE[r.key]);
  if (noRole.length) report.warn('mutations-without-role', 'NEW authenticated mutations with no role gate — confirm ownership is checked in the handler, then record it in REVIEWED_NO_ROLE', noRole.map((r) => r.key));
  else report.pass('mutations-without-role', 'Every role-less mutation has a recorded ownership review');

  // 6. Role coverage for reads: an admin/moderator queue that loses its requireRole must not pass silently.
  const readGaps = readRoleGaps(routes);
  if (readGaps.length) report.fail('reads-without-role', 'Authenticated READ routes with no role gate and no recorded ownership review — add requireRole, or verify the handler scopes data to the caller and record it in REVIEWED_READ_NO_ROLE', readGaps);
  else report.pass('reads-without-role', `Every authenticated read has a role gate or a recorded ownership review (${Object.keys(REVIEWED_READ_NO_ROLE).length} reviewed)`);

  // 7. Scoped share-token boundary (Roadmap §1.2): NO money route may ever be reachable by a delegation share token.
  const { isFinancialPath, isShareTokenAllowed } = require('../../middleware/auth');
  for (const key of MONEY_ROUTES) {
    const routePath = key.split(' ')[1];
    const dummyReq = { baseUrl: '', path: routePath };
    if (!isFinancialPath(dummyReq)) {
      report.fail(`share-token-blocked:${key}`, 'Money route not classified as financial path by middleware/auth.js');
    } else if (isShareTokenAllowed(dummyReq)) {
      report.fail(`share-token-blocked:${key}`, 'CRITICAL: Money route is matched by SHARE_TOKEN_ALLOWED_PATTERNS');
    } else {
      report.pass(`share-token-blocked:${key}`, 'Unreachable by delegation share tokens');
    }
  }

  const staleReviews = [...Object.keys(REVIEWED_MUTATIONS), ...Object.keys(REVIEWED_NO_ROLE), ...Object.keys(REVIEWED_READ_NO_ROLE)].filter((k) => !routes.some((r) => r.key === k));
  if (staleReviews.length) report.warn('review-list-stale', 'Review entries that match no route (remove them)', [...new Set(staleReviews)]);

  return report;
}

module.exports = { run, collectRoutes, readRoleGaps, PUBLIC_ROUTES, MONEY_ROUTES, REVIEWED_READ_NO_ROLE };
if (require.main === module) runCli(run).finally(() => {});
