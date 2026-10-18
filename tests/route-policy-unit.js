// tests/route-policy-unit.js
// DB-free regression test for the route-policy gate's READ-route role check (audit pass 3, mutant MUT-03).
//
// Before this check, deleting `requireRole(['ADMIN'])` from GET /api/contractor-profile/pending left
// `npm run qa` green: the policy reviewed role gates on mutations only. Here we prove, against the REAL routers,
// that removing the role gate from ANY currently gated read route now makes the gate flag it.
'use strict';

const path = require('path');
const { collectRoutes, readRoleGaps, REVIEWED_READ_NO_ROLE } = require('../scripts/qa/route-policy');
const { verifyToken } = require('../middleware/auth');
const { enforceIdempotency } = require('../middleware/idempotency');

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

console.log('🧪 route-policy: read-route role coverage');

// ── pure behaviour ────────────────────────────────────────────────────────────────────────────────
const fake = (key, over = {}) => ({ key, method: key.split(' ')[0], authed: true, roles: null, ...over });

check('a gated read is not flagged', readRoleGaps([fake('GET /x', { roles: ['ADMIN'] })], {}).length === 0);
check('an ungated, unreviewed read IS flagged',
  JSON.stringify(readRoleGaps([fake('GET /x')], {})) === JSON.stringify(['GET /x']));
check('an ungated read with a recorded review is not flagged', readRoleGaps([fake('GET /x')], { 'GET /x': 'scoped to caller' }).length === 0);
check('an unauthenticated (public) read is left to the auth check, not this one', readRoleGaps([fake('GET /p', { authed: false })], {}).length === 0);
check('mutations are handled by the mutation role check, not this one', readRoleGaps([fake('POST /m')], {}).length === 0);

// ── against the real routers ─────────────────────────────────────────────────────────────────────
const routes = collectRoutes(verifyToken, enforceIdempotency);
const reads = routes.filter((r) => r.authed && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
const gated = reads.filter((r) => r.roles);

check('real routers: no authenticated read lacks a role gate or a recorded review', readRoleGaps(routes).length === 0, readRoleGaps(routes).join(', '));
check('real routers: there are gated reads to mutate (sanity)', gated.length >= 10, `found ${gated.length}`);

// MUT-03 replayed on every gated read: delete its role gate -> the check must flag exactly that route.
const survivors = [];
for (const g of gated) {
  const mutated = routes.map((r) => (r.key === g.key ? { ...r, roles: null } : r));
  const gaps = readRoleGaps(mutated);
  if (!(gaps.length === 1 && gaps[0] === g.key)) survivors.push(g.key);
}
check(`removing the role gate from each of the ${gated.length} gated reads is detected (0 surviving mutants)`, survivors.length === 0, survivors.join(', '));

// the specific mutant the audit found
const pending = routes.find((r) => r.key === 'GET /api/contractor-profile/pending');
check('GET /api/contractor-profile/pending is ADMIN-gated today', !!pending && Array.isArray(pending.roles) && pending.roles.includes('ADMIN') && pending.roles.length === 1);
check('...and the audit\'s mutant (gate removed) is flagged',
  readRoleGaps(routes.map((r) => (r.key === 'GET /api/contractor-profile/pending' ? { ...r, roles: null } : r))).includes('GET /api/contractor-profile/pending'));

// the reviewed list must not rot: every entry must still match a real, ungated read
const stale = Object.keys(REVIEWED_READ_NO_ROLE).filter((k) => !reads.some((r) => r.key === k));
check('every reviewed-read entry still matches a real authenticated read route', stale.length === 0, stale.join(', '));
const redundant = Object.keys(REVIEWED_READ_NO_ROLE).filter((k) => gated.some((r) => r.key === k));
check('no reviewed-read entry is for a route that now has a role gate (remove the entry)', redundant.length === 0, redundant.join(', '));

console.log(failed ? `\n💥 ${failed} check(s) failed` : '\n✅ route-policy read-role unit checks passed');
// the routers import Redis/Mongo clients that keep the event loop alive
process.exit(failed ? 1 : 0);
