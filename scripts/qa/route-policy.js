// scripts/qa/route-policy.js — inspects the REAL Express routers (not source
// text) and enforces API security invariants. A new endpoint that forgets
// authentication, orders a role check before authentication, or moves money
// without idempotency fails this gate in CI.
'use strict';

const fs = require('fs');
const path = require('path');
const { createReport, runCli } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');

// Mount table — cross-checked against server.js below so it can't drift.
const MOUNTS = [
  ['/api/auth', 'routes/auth'],
  ['/api/projects', 'routes/project'],
  ['/api/bids', 'routes/bid'],
  ['/api/contracts', 'routes/contract'],
  ['/api/contractor-profile', 'routes/contractorProfile'],
  ['/api/payment', 'routes/payment'],
  ['/api/governance', 'routes/governance'],
  ['/api/finance', 'routes/finance'],
  ['/api/settlement', 'routes/settlement'],
  ['/api/moderation', 'routes/arbitration'],
  ['/api/chat', 'routes/chat'],
  ['/api/reviews', 'routes/review'],
  ['/api/dashboard', 'routes/dashboard'],
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
  'POST /api/payment/success': 'browser redirect from SSLCommerz; no state change',
  'POST /api/payment/fail': 'browser redirect from SSLCommerz; no state change',
  'POST /api/payment/cancel': 'browser redirect from SSLCommerz; no state change',
  'PUT /__storage/upload/:token': 'authorised by a short-lived HMAC upload token',
  'GET /api/reviews/contractor/:contractorId': 'public contractor reputation'
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
  'POST /api/finance/withdraw'
];

// Authenticated mutations reviewed as safe WITHOUT idempotency middleware.
// A new mutation not listed here raises a WARN until someone reviews it.
const REVIEWED_MUTATIONS = {
  'POST /api/auth/logout': 'naturally idempotent (revoke + clear cookie)',
  'POST /api/projects': 'retry can create a duplicate draft project; no money moves',
  'POST /api/projects/wizard-submit': 'same as POST /api/projects',
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
  'POST /api/bids/:bidId/withdraw': 'CAS (contractorId, status=PENDING) → retry on an already-withdrawn bid returns 409'
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
  const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];
  const review = routes.filter((r) => r.authed && MUTATING.includes(r.method)
    && !r.idempotent && !MONEY_ROUTES.includes(r.key) && !REVIEWED_MUTATIONS[r.key]);
  if (review.length) report.warn('mutations-without-idempotency', 'NEW authenticated mutations without idempotency — review, then record why in REVIEWED_MUTATIONS', review.map((r) => r.key));
  else report.pass('mutations-without-idempotency', `All ${Object.keys(REVIEWED_MUTATIONS).length} non-idempotent mutations carry a recorded safety review`);

  // 5. Role coverage for mutations.
  const noRole = routes.filter((r) => r.authed && MUTATING.includes(r.method) && !r.roles && !REVIEWED_NO_ROLE[r.key]);
  if (noRole.length) report.warn('mutations-without-role', 'NEW authenticated mutations with no role gate — confirm ownership is checked in the handler, then record it in REVIEWED_NO_ROLE', noRole.map((r) => r.key));
  else report.pass('mutations-without-role', 'Every role-less mutation has a recorded ownership review');

  const staleReviews = [...Object.keys(REVIEWED_MUTATIONS), ...Object.keys(REVIEWED_NO_ROLE)].filter((k) => !routes.some((r) => r.key === k));
  if (staleReviews.length) report.warn('review-list-stale', 'Review entries that match no route (remove them)', [...new Set(staleReviews)]);

  return report;
}

module.exports = { run, collectRoutes, PUBLIC_ROUTES, MONEY_ROUTES };
if (require.main === module) runCli(run).finally(() => {});
