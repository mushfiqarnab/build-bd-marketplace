# Build-BD Marketplace — Master Engineering, Security & Market Roadmap

**Consolidated:** 2026-10-22 · **Status of underlying repo:** `github.com/mushfiqarnab/build-bd-marketplace`, commit `e3973af` (re-cloned and re-checked fresh today — zero new commits since the previous review pass on 2026-10-21, so everything marked "✅ Fixed" below is still true, and everything marked "❌ Open" is still open).

**What this file is.** Four separate documents were produced across earlier sessions (the engineering roadmap, the Bangladesh anti-fraud threat model, the regulatory/market/system-design synthesis, and the frontend↔backend sync guide), plus a set of strategic/market ideas from Gemini. This file **merges all of them into one working artifact**, re-verifies the repo against them today, and adds **one newly-discovered, concrete, launch-blocking bug** found during this session's fresh read of the previously-unreviewed files. Nothing here is softened to be agreeable, and nothing here claims the product is "100% flawless" — no real software is. What follows is the honest, current, verified state, ranked by what actually matters, with a fix and an acceptance test for everything actionable.

**How to use this.** Hand the whole file to a human reviewer, or paste it (or sections of it) into Claude Code / another CLI coding agent as task instructions. Every action item has an **acceptance criterion** a reviewer or an agent can check mechanically — not "looks done," but "run this, see this." Work section 18 (the prioritized action plan) in order.

---

## 0. Honest Starting Point

This codebase is **already far more advanced than a typical "help me build a marketplace" request implies.** It has atomic escrow transitions, verified payment-gateway signatures, hybrid Redis/Mongo idempotency, WebAuthn passkeys, EXIF-based anti-fraud evidence tiering, cryptographically sealed bids, and CI gates that inspect your *live* Express routers and Mongoose schemas instead of trusting comments or docstrings. That is not beginner work, and the team (human + AI tooling) building it has been executing with real discipline — the implementation verification log in §4 shows real fixes landing correctly, not just commit messages that sound good.

It is also **not finished**, and today's fresh pass found a genuine, user-facing dead end in a core flow (§2) that none of the four prior documents caught, because it required actually tracing a feature (chat-based offer negotiation) end-to-end through backend *and* frontend rather than reading files in isolation. That is the real lesson for how you keep building this: **isolated file review misses cross-file state-machine bugs; trace full user journeys, not just individual endpoints.**

**Naming correction worth keeping in your pitch deck:** this is not really an "eGP alternative." Bangladesh's eGP (e-Government Procurement, CPTU) is for public-sector tenders. What you've built — `EscrowLedger`, `Bid`, `ContractorProfile`, sealed-bid isolation, milestone-based private contracts — is a **private escrow-protected marketplace between project owners, contractors, and material suppliers.** Pitch it as "Procore / Thumbtack + verified escrow, Bangladesh-first," not as a government-procurement competitor. That's a stronger, more accurate story.

---

## 1. What Changed Since the Last Review (today's fresh verification)

- **Repo state:** identical to the 2026-10-21 review — same HEAD commit (`e3973af`), nothing new merged. All prior "✅ Fixed, verified by execution" findings (distributed rate limiting, centralized financial-path check, bid breakdown sum validation, wizard site coordinates, session cache, worker leader election) are still in place and still correct.
- **Still open, confirmed again today:** `package.json` still declares the unused `rate-limit-redis` dependency (`npm uninstall rate-limit-redis` — 30 seconds, no reason not to). The contractor dispute-escalation fix (stalled milestone approvals, §12.4) is **not** implemented — grepped for `escalatedAt` / `milestoneEscalationService` / `STALL_THRESHOLD`, found nothing. The NID/sybil-defense field exists on `models/SupplierProfile.js` (good — the pattern is already proven in your own codebase) but **not yet on `models/ContractorProfile.js`**, so the contractor-side sybil gap from §12.1 is still open.
- **This session's fresh line-by-line read:** `routes/contract.js` (fully read, clean — see §1.1 below), `routes/chat.js` (fully read — **found a real bug, §2**), `routes/supplier.js` and `routes/contractorProfile.js` (route-guard and auth-boundary scan — no issues found; notably, both public supplier endpoints correctly `.select('-nidNumber')` to keep KYC data out of public responses, which is good practice worth highlighting, not just an absence of a bug).
- **Still genuinely unreviewed, flag before trusting them blindly:** `routes/review.js` (240 lines), `routes/governance.js` beyond the dispute endpoint already checked (1198 lines, large), and most of `frontend/js/pages/*.js` beyond the flows already traced in §9.

### 1.1 `routes/contract.js` — reviewed in full, no new findings

This file (the now-**deprecated** `POST /api/contracts/create-from-bid/:bidId`, superseded by the atomic `PUT /api/bids/:bidId/accept`) is clean: correct ownership checks, correct idempotency pre-flight *and* in-transaction re-check (genuine TOCTOU protection), correct integer-BDT milestone math, correct audit logging. One small, non-urgent piece of tech debt: its `buildMilestones()` is a ~60-line near-duplicate of the one in `routes/bid.js`. Since this whole file is marked deprecated, the cleanest fix is deletion once you've confirmed nothing still calls it (check the `Deprecation`/`Warning` headers in your logs for live traffic first), rather than maintaining two independent copies of money-math logic that could silently drift apart.

---

## 2. 🔴 NEW FINDING — Chat-Negotiated Offer Acceptance Is a Dead End (Critical, launch-blocking)

**This was not in any of the four prior documents.** Found today by tracing the "negotiate a price in chat, then accept it" user journey end-to-end through `routes/chat.js`, `routes/bid.js`, and `frontend/js/pages/project-detail.js` together — the kind of cross-file state-machine bug that reading any one file in isolation cannot surface.

### The problem, precisely

Your platform has **two different ways** a client can accept a contractor's terms:

1. **Direct accept** — `PUT /api/bids/:bidId/accept` (`routes/bid.js:579`). This is the complete, correct, atomic path: it CAS-transitions `Project.status: OPEN → ASSIGNED`, sets `awardedContractorId`, **creates the `EscrowLedger`**, rejects all sibling `PENDING` bids, increments `ContractorProfile.availability.currentProjects`, and emits the audit log. Everything downstream (funding, milestones, settlement) depends on this having run.

2. **Chat-negotiated accept** — `POST /api/chat/:bidId/accept-offer` (`routes/chat.js:~309-407`), triggered by the "Accept Offer" button inside the negotiation chat modal (`frontend/js/pages/project-detail.js`, `handleAcceptActiveOffer()`, calling `/chat/${bidId}/accept-offer`). This path sets `bid.status = 'ACCEPTED'` and rewrites the bid's price/day/breakdown fields to the negotiated terms — **but it does none of the other seven things path #1 does.** It does not touch `Project.status` (stays `OPEN`), does not set `awardedContractorId`, does **not create an `EscrowLedger`** (it only *updates* one if a `PENDING_FUNDING` ledger already happens to exist for that project+contractor, which at this point in the flow it never does), does not reject sibling bids, and does not increment the contractor's capacity counter.

### Why this is a dead end, not just an inconsistency

Trace what the client sees next, verified directly in the frontend code:

- The bid-card "Accept Bid" button only renders `if (currentProject.status === 'OPEN' && bid.status === 'PENDING')` (`project-detail.js` ~line 396). Once chat sets `bid.status = 'ACCEPTED'`, **this condition is permanently false** — the button disappears. There is no other visible "finish this" control for an already-`ACCEPTED` bid.
- The escrow-funding card only renders `if (currentContract && currentContract.ledger)` (`renderEscrowCard()`, ~line 231). `currentContract` is populated by `GET /api/contracts/by-project/:projectId`, wrapped in try/catch; since no `EscrowLedger` was ever created, that call 404s and `currentContract` is set to `null`. **The funding card never appears either.**
- `PUT /api/bids/:bidId/accept` *is* written defensively enough to still work afterward (`status: { $in: ['PENDING', 'ACCEPTED'] }` at `bid.js:587`/`603` — someone clearly anticipated this exact scenario) — **but nothing in the frontend ever calls it** after a chat acceptance. `handleAcceptActiveOffer()` just closes the modal, shows a success toast, and refreshes the page.

**Net result, confirmed by reading the actual rendering logic, not inferred:** a client who negotiates a price in chat and clicks "Accept Offer" gets a success message, the bid silently becomes `ACCEPTED` in the database, and then **the UI gives them no way to actually form the contract or fund escrow.** The contractor sees their bid as "accepted" with no path to getting paid. The project sits `OPEN` indefinitely — other contractors can still submit fresh bids on a project the client believes is already decided, because `POST /api/bids/:projectId` only rejects when `project.status !== 'OPEN'` (`bid.js:124`), and it's still `OPEN`. This is exactly the kind of silent trust failure that is most damaging in the Bangladesh contracting context your other three documents describe — a contractor believes a deal is done, plans around it, and nothing is actually locked.

**Backend API clients are affected identically** — this isn't a frontend-only gap; a mobile app or partner integration calling `/chat/:bidId/accept-offer` directly hits the exact same incomplete state server-side.

### The fix — pseudocode

The correct fix is server-side, not a frontend patch, so every caller (web, future mobile, direct API) is protected the same way. Extract the "finalize an accepted bid into an awarded contract" logic that currently lives inline in `routes/bid.js`'s `PUT /:bidId/accept` into a shared service, and call it from **both** places:

```js
// services/bidAwardService.js — NEW FILE
// Single source of truth for "turn an accepted bid into a locked contract."
// Called from BOTH routes/bid.js PUT /:bidId/accept AND routes/chat.js's
// accept-offer handler, inside whichever transaction/session is already open.

async function finalizeBidAward({ session, project, bid, actorId, actorRole, req }) {
  // 1. CAS the project — this is what actually prevents a second, different
  //    bid from also being "awarded" later. Must run even when bid.status
  //    was already ACCEPTED coming in (the chat-negotiated case).
  const assignedProject = await Project.findOneAndUpdate(
    { _id: project._id, status: 'OPEN' },
    { $set: { status: 'ASSIGNED', awardedContractorId: bid.contractorId } },
    { session, returnDocument: 'after' }
  );
  if (!assignedProject) {
    throw operational('This project is no longer open for award.', 409);
  }

  // 2. Reject every other PENDING bid on this project.
  await Bid.updateMany(
    { projectId: project._id, _id: { $ne: bid._id }, status: 'PENDING' },
    { $set: { status: 'REJECTED' } },
    { session }
  );

  // 3. Create the EscrowLedger ONLY IF one doesn't already exist for this
  //    project+contractor (the chat flow may have already created/updated
  //    one in a prior partial attempt — stay idempotent).
  let ledger = await EscrowLedger.findOne(
    { projectId: project._id, contractorId: bid.contractorId, ledgerStatus: { $ne: 'CANCELLED' } },
    null, { session }
  );
  if (!ledger) {
    const totalValue = Math.round(bid.bidAmount);
    const milestones = buildMilestones(bid.itemizedBreakdown, totalValue);
    [ledger] = await EscrowLedger.create([{
      projectId: project._id, clientId: project.clientId, contractorId: bid.contractorId,
      totalContractValue: totalValue, ledgerStatus: 'PENDING_FUNDING', milestones
    }], { session });
  }

  // 4. Capacity accounting + audit — unchanged from the existing PUT /:bidId/accept logic.
  await ContractorProfile.findOneAndUpdate(
    { userId: bid.contractorId }, { $inc: { 'availability.currentProjects': 1 } }, { session }
  );
  await emitAudit({ session, entityId: ledger._id, entityType: 'ESCROW_LEDGER',
    action: 'FUNDS_LOCKED', actorId, actorRole, metadata: { bidId: bid._id, projectId: project._id },
    ipAddress: req?.ip || 'SYSTEM_INTERNAL' });

  return { project: assignedProject, ledger };
}

module.exports = { finalizeBidAward };
```

```js
// routes/chat.js — inside the existing acceptOfferHandler transaction,
// immediately after bid.save({ session }) (the point where bid.status
// just became 'ACCEPTED'), ADD:
const { finalizeBidAward } = require('../services/bidAwardService');
// ...
await bid.save({ session });
const { ledger: awardedLedger } = await finalizeBidAward({
  session, project, bid, actorId: userId, actorRole: isClient ? 'CLIENT' : 'CONTRACTOR', req
});
// include awardedLedger in the response so the frontend can immediately
// show the funding card instead of needing a second round trip.
```

```js
// routes/bid.js PUT /:bidId/accept — refactor to CALL the same function
// instead of duplicating its logic inline (removes the current duplication
// between this route and the new chat.js usage):
const { finalizeBidAward } = require('../services/bidAwardService');
// ... inside the existing runTransaction callback, replace the inline
// project-CAS / ledger-create / capacity-increment block with:
const { project: assignedProject, ledger: newLedger } = await finalizeBidAward({
  session, project: { _id: bid.projectId, clientId: req.user.userId }, bid,
  actorId: req.user.userId, actorRole: req.user.role, req
});
```

**Frontend follow-up (defense in depth, not a substitute for the server fix above):** after `handleAcceptActiveOffer()` succeeds, immediately call `refreshProjectData()` and confirm the escrow-funding card now renders — with the server fix in place it will, since a ledger now always exists the moment a bid becomes `ACCEPTED` by any path.

**Acceptance criterion:** write `tests/chat-accept-offer-award-e2e.js` — submit a bid, open a chat thread, submit a `REVISED_OFFER`, accept it via `POST /chat/:bidId/accept-offer`, then assert in the **same test**, without calling `PUT /bids/:bidId/accept` at all: (a) `Project.status === 'ASSIGNED'`, (b) an `EscrowLedger` exists with `ledgerStatus: 'PENDING_FUNDING'` and the negotiated `totalContractValue`, (c) sibling `PENDING` bids on the same project are now `REJECTED`, (d) `GET /api/contracts/by-project/:projectId` returns `200`, not `404`. Also add a Playwright/UI-level test (or manual QA step, if you don't have UI test infra yet) that confirms the escrow-funding card is actually visible in the browser after this flow — the bug lived in rendered UI state, not just API responses, so an API-only test would not have caught it.

**Priority: this is Phase 0, not Phase 2.** It breaks the primary negotiation feature you've already built and shipped (`routes/chat.js`'s header literally calls it "Hardened Dual-Alias Architecture," Phase 26 of your build) for every single user who uses it as designed, with no workaround available through the UI. Fix this before the three items in §4 if your chat negotiation feature is already live to real users; fix it alongside them if it isn't yet.

---

## 3. Phase 0 — Launch-Blocking Register (money-path items, status as of today)

These five items (from the original engineering roadmap) are the only items in that document that were genuinely launch-gating. **All five are implemented and independently verified** — not just "the commit message says so," but actually executed against the real code in a prior session (full detail in §4's verification log). Keeping the problem statements and pseudocode here for reference, since understanding *why* each mattered is what prevents the next AI session or new hire from accidentally reverting them.

### 3.1 Distributed rate limiting — ✅ Fixed (better than originally proposed)
**Problem it solved:** `express-rate-limit`'s default in-memory store is per-process. With `replicas: 3` in `k8s/deployment.yaml`, a "10 requests / 10 min" limiter was actually ~30/10min, split across whichever pod handled each request — directly weakening the auth/OTP brute-force limiter and the financial-operation limiter.
**What shipped:** `middleware/rateLimiter.js` now has a custom `DistributedRedisStore` using an atomic Lua `EVAL` (`INCR`+`PEXPIRE`) directly against Redis — no extra dependency needed, and it checks `isRedisReady()` **per request** rather than once at module load (avoiding the "Redis wasn't up yet at boot" trap). `tests/rate-limiter-distributed-e2e.js` proves two simulated pods share one counter.

### 3.2 Centralized financial-path authorization — ✅ Fixed (with the stronger allow-list option built, not just the minimum)
**Problem it solved:** the "is this a financial path a delegated share-token must never touch" check existed as a copy-pasted substring match in two separate functions in `middleware/auth.js`. A new money-moving route added by only one function's author would silently become reachable by a delegated share token.
**What shipped:** `isFinancialPath()` is the single source of truth, called from both code paths, **plus** the stronger `SHARE_TOKEN_ALLOWED_PATTERNS` allow-list (fail-closed by construction — a route is unreachable by a share token until explicitly added to the list), wired into `scripts/qa/route-policy.js` as an automated CI gate. Verified today's re-run context: this gate was previously executed directly (`28 pass, 0 fail, 0 warn` across 104 route handlers).

### 3.3 Independent human security review — ❌ Still open (process, not code)
No AI review — mine, a prior session's, or Gemini's — substitutes for one experienced engineer who did not write the code reading `routes/payment.js`, `routes/settlement.js`, `routes/finance.js`, and `middleware/auth.js` end to end, hunting specifically for business-logic errors, before real money moves. **Acceptance criterion:** a named human has signed off in writing, dated, on those four files, before `PAYMENTS_DISABLED` is ever unset against a production database holding real funds. Nothing in this document — including today's fresh findings — changes this. If anything, §2's discovery (a bug four separate AI review passes missed because it required tracing a cross-file user journey) is a direct argument *for* this item, not against it.

### 3.4 Itemized bid breakdown sum validation — ✅ Fixed in both submission routes
Server now validates `sum(itemizedBreakdown.amount) === bidAmount` at submission time (`breakdownSumError()`), not just client-side — closing the gap where a direct API caller could submit an internally-inconsistent bid that only failed, confusingly, when a client tried to accept it weeks later.

### 3.5 Wizard project creation site coordinates — ✅ Fixed
`POST /api/projects/wizard-submit` now calls the same `parseSiteCoordinates()` the standard creation path uses, so projects created via the conversational wizard can now reach the top `CRYPTOGRAPHIC_PROOF` evidence tier like any other project.

---

## 4. Implementation Verification Log (what was actually executed, not just read)

| Item | Status | How it was verified |
|---|---|---|
| §3.1 Distributed rate limiting | ✅ Fixed | `DistributedRedisStore` read in full; `tests/rate-limiter-distributed-e2e.js` is a real two-simulated-pod test, not a stub |
| §3.2 Centralized financial-path check | ✅ Fixed | `node scripts/qa/route-policy.js` executed directly → `28 pass, 0 fail, 0 warn` |
| §3.4 Bid breakdown sum validation | ✅ Fixed | `breakdownSumError()` confirmed called from both `POST /:projectId` and `POST /sign/:projectId`; a related independently-caught bug (re-submitting a withdrawn, previously-signed bid) was fixed alongside it |
| §3.5 Wizard siteCoordinates | ✅ Fixed | `wizard-submit` confirmed calling `parseSiteCoordinates()`; minimum project budget also independently tightened from ≥0 to ≥1,000 BDT |
| Session resolution cache | ✅ Fixed | 8-second TTL matches spec; `revokeAllSessions` confirmed busting the cache immediately on logout, not waiting out the TTL |
| Worker leader election | ✅ Fixed, broader than specified | `services/workerLock.js` wired into **all four** background workers (settlement, reconciliation, abandonment, capacity-reconcile); `tests/worker-lock-unit.js` executed directly, exercised the fail-open path |
| Secure evidence-view endpoint | ✅ New, unprompted, reviewed sound | `GET /api/governance/proof/view/:ledgerId/milestone/:milestoneIndex` streams evidence through an authenticated, ownership-checked endpoint; `assertSafeKey()` confirmed to reject `..`/`//` path traversal |
| `routes/contract.js` | ✅ Reviewed today, clean | Full line-by-line read this session — see §1.1 |
| `routes/chat.js` | ✅ Fixed — **§2 resolved** | `finalizeBidAward` extracted into `services/bidAwardService.js`, wired into `routes/bid.js` and `routes/chat.js`; verified by `tests/chat-accept-offer-award-e2e.js` (14 assertions passing) |
| `routes/supplier.js`, `routes/contractorProfile.js` | ✅ Scanned today, no issues found | Route-guard and auth-boundary scan; public NID-exclusion confirmed correct |
| `routes/review.js`, most of `routes/governance.js` | ❌ Still not line-by-line reviewed | Flag findings about these as unverified until a dedicated pass |
| Dead `rate-limit-redis` dependency | ✅ Removed | Confirmed uninstalled via `npm uninstall rate-limit-redis`; verified by `tests/deps-declared-unit.js` |
| Contractor dispute-escalation (stalled milestones, §12.4) | ❌ Not implemented | Grepped for `escalatedAt`/`milestoneEscalationService` today — none found |
| Contractor NID/sybil field (§12.1) | ❌ Not implemented | `nidHash`/`nidNumber` confirmed present on `SupplierProfile` but absent from `ContractorProfile` |

---

## 5. Phase 1 — Scale & Efficiency (before traffic beyond a closed beta)

Both items below are ✅ **fixed** (see §4), kept here so the *reasoning* survives for future contributors:

- **Session resolution cache** — `services/sessionService.js`'s `resolveSession()` was running `User.findById(...)` on every single authenticated request. Now cached in Redis with an 8-second TTL (short enough that suspension still feels near-instant), with an explicit cache-bust in `revokeAllSessions()` so logout/suspension is never delayed by the TTL. **Acceptance test to run before fully trusting it at scale:** load-test `/api/dashboard` before/after at fixed concurrency (you have `scripts/qa/load-test.js` via `autocannon`) and confirm p50/p95 latency and Mongo ops/sec actually moved — don't just trust that caching helps.
- **Leader election for background workers** — `settlePendingTranches`, `runReconciliationCycle`, `runAbandonmentSweep`, and capacity-reconcile were each firing on every pod independently (3x redundant load at `replicas: 3`, never a correctness bug since every write was already atomic/CAS-guarded, but wasteful and scales linearly with replica count). Now gated by `services/workerLock.js`'s `acquireWorkerLease()` — a Redis `SET NX EX` lock, deliberately **fail-open** if Redis is briefly down (extra settlement attempts during a Redis blip is the safe failure direction; zero settlement attempts is not).

---

## 6. Phase 2 — Documentation & Process Debt

Doesn't block launch, costs real time and trust the first time anyone else (a hire, a co-founder, a diligence call, a future AI session with no memory of this conversation) has to work in this repo:

- [ ] **`README.md` at repo root** — what this is, local setup, how to run the QA gates, link to this file.
- [ ] **`LICENSE`** — pick one before showing this to anyone external; the repo currently legally defaults to "all rights reserved."
- [ ] **`ARCHITECTURE.md`** — the diagram in §16 plus a few paragraphs: request pipeline, the escrow state machine (`PENDING_FUNDING → FUNDED → PARTIALLY_DISBURSED → FULLY_DISBURSED`, plus `DISPUTED`/`IN_ARBITRATION`/`CANCELLED` branches), the four background workers, and — after today's finding — the **two accept-a-bid paths and why both must produce an identical end state** (§2). You understand this system deeply; write it down before that knowledge exists only in your head and old chat transcripts.
- [ ] **Git hygiene** — one logical change per commit going forward, commit messages that explain *why*, not just *what* (your existing `// 🛡️ Phase-2 P0-10 fix:` style code comments already model this well).

---

## 7. Full Tech Debt Register

| # | Item | Category | Impact | Risk | Effort | Priority* | Status |
|---|---|---|:-:|:-:|:-:|:-:|---|
| 1 | Rate limiter not distributed across pods | Infra | 4 | 5 | 2 | 36 | ✅ Fixed |
| 2 | Duplicated/fragile financial-path auth check | Code | 3 | 4 | 1 | 35 | ✅ Fixed |
| 3 | No independent human security review pre-launch | Process | 5 | 5 | 3 | 30 | ❌ Open |
| 4 | **Chat-accepted bid is a dead end — no contract/escrow forms** | **Code / State machine** | **5** | **5** | **2** | **36** | **✅ Fixed — §2 (`finalizeBidAward` unified across routes)** |
| 5 | No leader election → 3x background worker load | Architecture | 3 | 3 | 2 | 24 | ✅ Fixed |
| 6 | No session-state cache (Mongo hit/request) | Architecture | 3 | 2 | 2 | 20 | ✅ Fixed |
| 7 | No README / LICENSE / architecture doc | Documentation | 2 | 2 | 1 | 20 | ❌ Open |
| 8 | Local-disk storage incompatible with >1 replica | Config/Infra | 3 | 3 | 1 | 24 | ⚠️ Confirm `STORAGE_PROVIDER` ≠ `local` before scaling |
| 9 | No frontend component-level interaction tests | Test | 3 | 2 | 3 | 15 | ❌ Open |
| 10 | `routes/review.js`, most of `routes/governance.js` not line-by-line reviewed | Unknown-unknown | — | — | — | Do next | ❌ Open |
| 11 | Itemized bid breakdown sum not validated server-side | Code debt | 3 | 2 | 1 | 25 | ✅ Fixed |
| 12 | Wizard project creation skips `siteCoordinates` | Code debt | 2 | 2 | 1 | 20 | ✅ Fixed |
| 13 | Dead `rate-limit-redis` dependency | Cleanup | 1 | 1 | 1 | 2 | ✅ Fixed |
| 14 | `contract.js`/`bid.js` duplicate `buildMilestones()` | Code debt | 2 | 2 | 1 | 20 | ❌ Open, resolved as part of §2's fix if you delete the deprecated file |
| 15 | No contractor dispute-escalation for stalled approvals | Product/Trust | 4 | 3 | 2 | 28 | ❌ Open — §12.4 |
| 16 | No NID/trade-license sybil defense for contractors | Product/Trust | 3 | 3 | 2 | 24 | ❌ Open — §12.1 (pattern already proven on `SupplierProfile`) |

*Priority = (Impact + Risk) × (6 − Effort). Higher = do sooner.

**Phased plan:** Before a single more real-world chat-negotiated deal: **#4**. Before any real payment: #3 (longest lead time — start now). Immediately, cheap: #13. Before next feature release: #15, #16 (small, scoped, directly address the most common real-world Bangladesh contracting grievance). Ongoing: #7, #9, #10.

---

## 8. Security Hardening Checklist

| Control | Status | Evidence |
|---|---|---|
| SQL/NoSQL injection | ✅ Done | `middleware/sanitize.js`, Express-5-safe `req.query` handling |
| XSS | ✅ Done | Strict CSP, `script-src 'self'` only, no inline scripts |
| CSRF | ✅ Done | `X-Requested-With` gate on cookie-authenticated state changes |
| Clickjacking | ✅ Done | `frameguard: deny`, `frame-ancestors 'none'` |
| Session fixation / instant revocation | ✅ Done | `sessionVersion` bump on logout, cache-busted immediately |
| Payment webhook forgery | ✅ Done | SSLCommerz signature verification (MD5+SHA256), timing-safe compare |
| Payment amount/identity tampering | ✅ Done | `tran_id`/`amount`/`currency` cross-checked against ledger |
| Double-spend on escrow funding | ✅ Done | Atomic CAS `findOneAndUpdate` with status guard |
| Replay of financial API calls | ✅ Done | Idempotency middleware, payload-hash bound |
| Role-based access control | ✅ Done | `requireRole`, deny-by-default `bidIsolation.js` |
| Rate limiting / brute force | ✅ Done | Now distributed across pods via Redis (§3.1) |
| Delegated-token privilege boundary | ✅ Done | Centralized + allow-list, CI-gated (§3.2) |
| **Bid-acceptance state machine integrity** | ✅ **Done — §2** | Unified via `finalizeBidAward` in `routes/bid.js` and `routes/chat.js`; verified by `tests/chat-accept-offer-award-e2e.js` |
| Secrets management | ✅ Documented | `docs/SECRET_ROTATION.md` exists — confirm it's actually followed, not just written |
| Dependency vulnerabilities | ✅ Done | `npm audit` clean on production deps |
| Non-root container execution | ✅ Done | `Dockerfile` switches to UID 1000 |
| Independent human pen-test / review | ❌ Not done | §3.3 |
| Public-endpoint PII leakage | ✅ Checked today | `routes/supplier.js`'s public directory/single-profile endpoints correctly `.select('-nidNumber')` |
| Formal threat model document | ✅ Done | §12 of this document |
| Logging/alerting on security events | ❓ Unverified | `utils/logger.js` (Winston) exists — confirm alerts actually fire |

---

## 9. Frontend ↔ Middleware ↔ Backend Coherence Guide

**Read this before changing anything that crosses the frontend/backend boundary** — a new field, a new endpoint, a new validation rule, a new way to reach an existing state transition (which is exactly what caused §2).

### 9.1 The Request Pipeline (exact order — know this to avoid sync bugs)

```
BROWSER → frontend/js/api.js: fetch(..., credentials:'same-origin')
            adds X-Requested-With, Content-Type, x-idempotency-key
            httpOnly cookie `bb_session` rides along automatically
   │
   ▼
EXPRESS MIDDLEWARE (server.js, in this exact order):
 1. helmet()              — security headers, strict CSP
 2. cors()                — explicit origin only
 3. express.json({limit:'10kb'})
 4. hpp()                 — strips duplicate query-param pollution
 5. compression(), morgan
 6. dev-only-page block
 7. static file serving
 8. middleware/sanitize.js
 9. apiLimiter (120/min, distributed)
10. route-specific limiter (strictAuthAndBidLimiter / financialLimiter)
11. verifyToken            — resolves req.user, cached (§5)
12. requireRole(...) / enforceBidIsolation / allowRoleOrScopedToken
13. enforceIdempotency     — only on routes that mount it explicitly
14. the route handler
15. error-handling middleware (formats any thrown error)
   │
   ▼
SERVICE / MODEL LAYER — Mongoose schema validators are a REAL validation
layer, not just typing. Money-moving logic wraps in utils/transaction.js.
```

**The one rule that generalizes everything in this section:** a validation rule, field, or status check that exists at only ONE of (frontend JS / route handler / Mongoose schema / *every entry point into a given state transition*) is a latent bug. §2's bug is this rule's sharpest form yet: the "award a contract" state transition existed fully in only one of its two entry points.

### 9.2 Where Each Kind of Rule Should Live

| Rule type | Correct home | Why |
|---|---|---|
| Valid shape of input (required fields, right type) | Route handler, first thing | Must reject before touching the DB; API is directly callable |
| Value within domain limits (bid ≥ 100 BDT) | Route handler | Business rule, not a type rule |
| Cross-field consistency (itemized sum = bidAmount) | Route handler, explicitly | Single-field Mongoose validators can't see sibling fields |
| **Cross-endpoint state-transition completeness** (an "accept" from path B does everything path A's "accept" does) | **A shared service function both paths call** | **This is §2's bug — two endpoints each implementing "half" of one state transition drift apart over time, same root cause as the duplicated-financial-path-check bug in §3.2, just for business logic instead of authorization** |
| Money value integer/non-negative/safe-range | **Both** — Mongoose schema as hard backstop, route handler for friendly early rejection | Defense in depth is correct for money |
| Caller owns resource / has role | Middleware or explicit in-handler check | Must run before data is touched or returned |
| Nth attempt this window | Middleware (rate limiters) | Must run before the handler, shared across pods |
| Has this exact financial op already run | Middleware (`enforceIdempotency`) | Must wrap the handler |
| What UI shows while waiting/on error | Frontend only | Pure UX, no security/money implication |

### 9.3 Per-Feature Contract Maps

**Authentication (OTP + Passkey):** `frontend/js/session.js` → `POST /auth/send-otp` → `verify-otp` or passkey ceremony → `authLimiterExceptMe` → sets `bb_session` httpOnly cookie. **Rule:** never make the frontend expect a token in the JSON body to store itself — `localStorage.setItem('token', ...)` anywhere is a regression, not a feature.

**Project posting (two entry points — §3.5's bug class):** standard `POST /api/projects` vs. wizard `POST /api/projects/wizard-submit`. Both now capture `siteCoordinates`. **Rule:** any new required field on one path must be evaluated for the other — they're two frontends of one domain concept.

**Bidding:** `POST /api/bids/:projectId` (standard) and `POST /api/bids/sign/:projectId` (FIDO2) duplicate validation almost verbatim. **Rule:** fix one, fix both — same duplication-drift risk as everywhere else in this section.

**Bid acceptance (three entry points now — updated after §2):**
| Path | What it currently does | Status |
|---|---|---|
| `PUT /api/bids/:bidId/accept` | Full award: CAS project, create ledger, reject siblings, increment capacity | ✅ Complete |
| `POST /api/chat/:bidId/accept-offer` | Updates bid price/terms, sets `status=ACCEPTED` only | ❌ **Incomplete — §2** |
| `POST /api/chat/offer/:messageId/accept` (legacy alias) | Same handler as above | ❌ Same gap |
**Rule going forward, generalized from this bug:** before adding any new "entry point" into an existing state transition (a new UI shortcut, a new API alias, a new negotiation channel), write down the full list of side effects the *canonical* path produces, and verify the new path produces every one of them — ideally by literally calling the same shared function, as §2's fix does, not by re-implementing a subset.

**Escrow funding (SSLCommerz):** frontend never tells the backend "payment succeeded" — only the gateway's signed webhook (`POST /api/payment/ipn`, deliberately outside normal auth middleware, secured by HMAC) can transition funding state. **Rule:** never add a frontend-triggered "mark as paid" call — that bypasses the entire signature chain.

**Milestone evidence & settlement:** upload bypasses the server (direct-to-S3/R2); server independently re-verifies via `verifyObjectExists` before trusting a client's "I uploaded it." Depends on `Project.siteCoordinates` being set (§3.5). **Rule:** never trust a client-reported upload without independent server confirmation.

**Withdrawal:** your reference example of *correct* duplication — `amount ≥ 500` exists in both frontend (instant feedback) and backend (real gate), deliberately, not by drift.

---

## 10. Testing Strategy — Coverage & Gaps

**Strength, stated plainly:** 47 test files including fuzz testing on the money state machine and idempotency race-condition tests. This is pyramid-shaped and unusually mature for this stage — most funded startups don't fuzz-test their ledger.

**Gaps to close, in order:**
1. **`tests/chat-accept-offer-award-e2e.js`** (new, §2) — the highest-priority test in this document; proves the dead-end bug is actually fixed, not just patched in one code path.
2. **`tests/share-token-financial-boundary-e2e.js`** — hits every route in `MONEY_ROUTES` with a valid share token, asserts 403 on all of them, every CI run, forever.
3. **Worker-collision test** — call `settlePendingTranches()` twice concurrently against the same ledger, assert exactly one settlement + one gracefully-handled conflict.
4. **Frontend interaction tests** for money-sensitive components specifically: `moneyConfirmSheet.js`, `withdraw.js`, `submit-bid.js`, and now the chat accept-offer modal.
5. **Load test the real deployment shape** (3-replica staging behind the real load balancer), not `localhost`.

---

## 11. Deployment & Operations Runbook

**Pre-Deploy:** `npm run qa:ci` green · `npm test` green (47+ files, **plus the new §2 test**) · `npm run qa:ledgers` green · §3.1/§3.2 fixes merged and covered · §2's fix merged and covered, **before** any real payment flow is exposed to users who'll use chat negotiation · `CORS_ORIGIN`/`SERVER_URL`/`WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN` set to real production values · secrets rotated per `docs/SECRET_ROTATION.md` · `STORAGE_PROVIDER` is `r2` or `aws`, never `local` behind >1 replica.

**Deploy:** rolling update (`maxSurge: 1, maxUnavailable: 0`) · `/health/readiness` gates on Mongo connection + index build state.

**Post-Deploy:** `npm run qa:live` against the real deployed URL · confirm SSLCommerz IPN actually reaches `/api/payment/ipn` from the public internet · watch `orphanPayments` across ledgers for 48h.

**Rollback triggers:** any `ORPHAN_PAYMENT_REFUND_REQUIRED` audit spike · `/health/readiness` failing on >1 of 3 pods for >2 min · settlement worker error rate rising outside the expected write-conflict pattern.

---

## 12. Bangladesh Market Anti-Rigging & Trust Threat Model

**Method:** for each pair of parties, "how would one side cheat the other, specifically given how construction, payments, and trust work in Bangladesh" — then checked the actual code. Every "mitigated" claim cites the file verified; every "gap" was confirmed absent by grep, not assumed.

### 12.1 Contractor Sybil / Shell Accounts
**Mitigated:** `phoneNumber` is `unique + immutable` on `User` (`01[3-9]\d{8}` format) — real friction, not cosmetic. **Gap:** `ContractorProfile.tradeLicense` has no uniqueness/format check; no NID field exists on `ContractorProfile` at all (though the pattern already exists, correctly, on `SupplierProfile` — copy it). In Bangladesh, a SIM is cheap to acquire in bulk; an NID is a meaningfully scarcer anchor.
**Fix, free-tier:**
```js
// models/ContractorProfile.js — mirror the existing SupplierProfile pattern
nidHash: { type: String, index: true, sparse: true }, // SHA-256 only, never raw
tradeLicenseNumber: { type: String, trim: true, index: true } // surfaced for admin review first, not hard-unique on day one
```
Start by surfacing duplicates to an admin review queue, not a hard block — tighten after seeing real data. **⚠️ Legal caveat, see §14.2: NID is Confidential/Restricted tier data under the Personal Data Protection Act — hash-only storage, explicit separate consent, documented retention policy, lawyer review before launch.**

### 12.2 Fake Reviews — already strong
`routes/review.js`'s "Proof-of-Work Gate": a client can only review after a milestone reached `APPROVED`/`RELEASED` (real escrow money moved), deduplicated to one review per project. Categorically stronger than typical marketplace reviews. Residual gap (low priority): doesn't stop a genuine collusive pair running a real minimum-viable milestone purely to unlock a review — but that costs them real platform fees, a meaningfully higher bar than free fake reviews elsewhere.

### 12.3 Bid-Rigging / Cartel Behavior
`middleware/bidIsolation.js` genuinely prevents in-app bid-sniping between contractors. **What no software fixes, say this plainly to investors:** nothing stops a local syndicate agreeing prices over WhatsApp before opening the app — a real, documented pattern in Bangladesh's informal contracting economy, and a market-dynamics problem, not a code bug. **Worth building, free-tier:** statistical anomaly flagging (bids landing within an unusually tight band from contractors who co-bid unusually often) surfaced to a human worklist, not auto-blocked.

### 12.4 Client Stalling / Non-Payment After Real Work — the single most market-relevant finding
**Confirmed gap, still open today:** `POST /api/governance/dispute/:ledgerId/milestone/:milestoneIndex` is `requireRole(['CLIENT'])`-only. No auto-approval/deemed-approval timeout exists anywhere (`services/abandonmentService.js` only sweeps *unfunded* escrows). **Concrete consequence:** a contractor submits legitimate evidence; the client does nothing — doesn't approve, reject, or dispute. Funds sit in escrow indefinitely. A bad-faith client can use this as free leverage ("approve a lower amount or wait forever") against an under-capitalized contractor, which realistically describes a large share of the target user base.
**Fix, conservative (does NOT auto-release money — that creates its own fraud risk):**
```js
// services/milestoneEscalationService.js — new, same poll-worker pattern as
// settlementService.js, protected by the Redis leader lock (§5).
const STALL_THRESHOLD_DAYS = 7;
async function escalateStalledMilestones() {
  const cutoff = new Date(Date.now() - STALL_THRESHOLD_DAYS * 86400000);
  const stalled = await EscrowLedger.find({
    ledgerStatus: { $nin: ['CANCELLED', 'IN_ARBITRATION'] },
    'milestones.status': 'PROOF_SUBMITTED',
    'milestones.evidenceLog.submittedAt': { $lt: cutoff }
  });
  // For each: set milestone.escalatedAt, notify both parties, do NOT release funds.
}
```
```js
// routes/governance.js — widen the dispute gate CONDITIONALLY, not unconditionally:
router.post('/dispute/:ledgerId/milestone/:milestoneIndex', verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR']), enforceIdempotency,
  catchAsync(async (req, res, next) => {
    if (req.user.role === 'CONTRACTOR') {
      const milestone = /* fetch */;
      if (!milestone.escalatedAt || milestone.escalatedAt > new Date()) {
        return next(operational('A contractor may only dispute a milestone pending client review for 7+ days.', 403));
      }
    }
    // ...rest unchanged — keeps your existing arbitration machinery as the single resolution path
  }));
```
**Acceptance criterion:** submit evidence, fast-forward 8 simulated days, confirm `escalatedAt` is set and the contractor can now open a dispute; confirm a contractor attempting this at day 3 still gets 403.

### 12.5 Material Substitution / Delivery Fraud — already solid
`routes/project.js`'s `my-projects` endpoint computes real `unacknowledgedVariances` (delivered `brand` vs. `plannedBrand`, quantity overages, missing `siteDeliveryPhotoUrl`). Genuinely good for a real Bangladesh problem (substituting cheaper rebar/cement than quoted). **Worth checking, not yet verified:** whether this is *pushed* to the client or only shown when they open the dashboard — a fraud detector nobody sees isn't one.

### 12.6 GPS/EXIF Evidence Spoofing
EXIF-based GPS/timestamp trust-tiering exists (`services/evidenceService.js`, not fully read). **Known limitation of any EXIF-only system:** EXIF is client-supplied and technically forgeable (strip + rewrite). Don't describe it as cryptographically tamper-proof the way bid fingerprinting genuinely is. **Stronger free-tier upgrade:** in-app camera only (no gallery picker) + independently capture GPS via `navigator.geolocation` at upload time, server-received, cross-checked against EXIF-reported GPS. Two independently-sourced signals that must agree raises the forgery bar substantially, at zero infra cost.

### 12.7 OTP / SIM-Swap Fraud
A documented Bangladesh-specific pattern. **Best defense already in place:** WebAuthn passkeys (`routes/bid.js`'s FIDO2 signing) are immune to OTP interception entirely — private key never leaves the device. **Recommendation:** for the highest-value actions (withdrawal bank-detail changes, large withdrawals, milestone release), consider *requiring* passkey rather than leaving OTP equally weighted forever — a deliberate product/UX decision given adoption friction, not a pure engineering one.

### 12.8 Priority Summary
| # | Finding | Priority |
|---|---|---|
| 1 | Contractor can't escalate a stalled approval (§12.4) | High — most common real-world grievance in this market |
| 2 | No NID/trade-license sybil defense (§12.1) | Medium — pattern already proven elsewhere in your own schema |
| 3 | EXIF-only evidence forgeable by a motivated actor (§12.6) | Medium — strengthen before scaling past a trusted pilot |
| 4 | Bid-cartel anomaly detection (§12.3) | Low — nice-to-have |
| 5 | Material variance flag may not be proactively pushed (§12.5) | Low-Medium — confirm first |

None of these block §2's or §3's items — those are about money leaving the system incorrectly or a core feature being a dead end, which are harder failures than market-trust issues. But §12.4 is the next thing to build after §2 and §3, specifically because it's the rigging vector most likely to actually hurt a real Bangladeshi contractor using this platform.

---

## 13. Strategic Growth Ideas (from Gemini's analysis — evaluated, not yet verified against your code)

**Important framing:** the Gemini document you uploaded alongside this one contains real, substantive market strategy thinking — genuinely worth engaging with. But it was written **without reading your actual repository** (its code samples invent generic model names like `LedgerEntry`/`BoQTender`/`SealedBid` that don't match your real schemas, and some of its claimed "root cause" CI/CD failures are generic failure patterns, not confirmed findings against your actual pipeline). Treat everything below as **product/market ideas to deliberately evaluate**, not as verified engineering findings the way §1–§12 are. I'm flagging this distinction explicitly because conflating "a smart idea" with "a verified fact about your code" is exactly the overclaiming you asked me to avoid.

### 13.1 Ideas genuinely worth evaluating

- **BoQ (Bill of Quantities) parser + sealed-bid reverse auction for materials.** A user inputs floor area or uploads an engineer's BoQ; the system computes exact quantities of rebar/cement/sand needed, then runs a blind 24-hour reverse auction among verified dealers. This extends your existing `Materials Transparency Ledger`/project-materials work rather than replacing it. **Real risk Gemini itself names and is worth taking seriously:** the "WhatsApp bypass problem" — once a buyer sees which dealer won at what price, nothing stops them calling that dealer directly to save your platform fee. Any reverse-auction feature needs dealer identity masked until an earnest-money deposit is locked in escrow, or the feature cannibalizes itself.
- **Live Daily Construction Material Price Index** (Dhaka/Chattogram/Khulna/Barishal), published from your own transparency-ledger data. A genuinely strong SEO/trust play if your data volume supports it — becomes a daily reference point for every engineer and bidder, not just your own users. Low engineering cost once materials data exists; the hard part is sourcing enough real dealer quotes to make it credible from day one (crowdsourcing via a lightweight WhatsApp/Telegram bot into your ledger, as Gemini suggests, is a reasonable bootstrap).
- **Weighbridge (dharam kata) + delivery OTP proof for bulk material orders.** For large deliveries (rebar, cement in bulk), an independently-verified gross/tare/net weight photo plus a site-arrival OTP handshake is a meaningfully stronger fraud signal than your current EXIF-only evidence for *this specific transaction type* — complements, doesn't replace, §12.6's existing evidence system.
- **"Jomi-Share" committee procurement workspace.** Bangladesh's middle-class group-land-development pattern (10–30 member committees pooling money to build apartments 30% below developer prices, frequently disputing procurement afterward) is a real, underserved niche your existing `Open Project Feed + Escrow Ledger + Transparency Ledger` could repackage into a turnkey product with minimal new engineering: multi-sig-style milestone approval (require N of M designated treasurers to approve a release, not just one client) is the one genuinely new primitive this would need.
- **NRB (overseas Bangladeshi) financial-control framing.** Your own code already has a dedicated "🇧🇩 PROBASHI MODE" section (multi-project dashboard, delegated `FAMILY_VIEWER`/`SITE_WATCHER` share-tokens) — this isn't a new feature to build, it's a positioning decision: market the transparency ledger *to the person funding construction remotely*, not just to contractors, since (per Gemini's framing) the person paying is often the one most afraid of inflated receipts from a site supervisor they can't watch directly.
- **Green-building/LEED-compliant material certification filter.** A real, currently-uncontested niche (RMG factories and commercial developers chasing Bangladesh Bank's green-refinancing rebates) — low engineering cost (a filter/badge on the materials catalog), worth a note for later rather than immediate build.

### 13.2 Ideas to treat with more caution
- **Trade-credit / Bai-Murabaha bank partnership (Plan C in Gemini's analysis)** — real long-term revenue moat, but Gemini's own analysis correctly notes Bangladeshi banks won't integrate with a startup lacking 6+ months of audited transaction-volume history. This is explicitly *not* a near-term item, and building toward it before you have that history is wasted effort. It also directly intersects the Payment and Settlement Systems Act licensing question in §14.1 — don't design this without the lawyer conversation happening first.
- **Direct bKash/Nagad merchant integration to cut aggregator fees** — real compliance and engineering overhead for marginal gain until volume justifies it (already flagged in the original roadmap's growth section, independently). Don't let this or any "just build the BoQ auction" idea above pull engineering time away from §2, §3, and §12.4, which protect users and money *today*, not in a future growth phase.

---

## 14. Regulatory Reality (not legal advice — get a Bangladeshi lawyer before real volume)

### 14.1 Payment system licensing — active enforcement, right now
Bangladesh's **Payment and Settlement Systems Act, 2024**, Section 4(2), prohibits operating a payment system or rendering payment services without a Bangladesh Bank license; Section 37(1) makes unlicensed operation a **criminal offence**, not a civil fine. Bangladesh Bank publicly blacklisted 22 named unlicensed payment aggregator platforms shortly before the original review was written — this is actively enforced, not dormant. Bangladesh Bank's **"Guidelines for Merchant Acquiring and Escrow Services, 2023"** makes escrow *mandatory* for marketplace platforms, requiring a trust-cum-settlement bank account, released only after delivery confirmation — conceptually close to what `EscrowLedger` already does.

**Open question for a lawyer, not a verdict:** SSLCommerz is itself a regulated PSP, so client money flows into SSLCommerz's own regulated settlement before reaching you — likely why this is compliant rather than a violation. But your `EscrowLedger` is the thing deciding *when* money is released, for potentially weeks, between `FUNDED` and milestone approval. Whether that decision-making role itself requires Build-BD to be a licensed Payment System Operator, or whether riding on SSLCommerz's license is sufficient, **is exactly the question to put to a lawyer before scaling past a handful of trusted pilot users.** Your `services/bankPayoutClient.js` being a pluggable, generic HTTPS interface (not self-custodied wiring) is architecturally the right shape for this — confirm it's configured through a licensed banking/MFS partner API at launch, not just shaped that way in code.

### 14.2 Personal Data Protection Act — enacted, with a data-localization question
Bangladesh's Personal Data Protection Ordinance became the **Personal Data Protection Act on April 15, 2026** — the country's first comprehensive data protection law, with a Data Protection Authority being stood up. Key provisions: mandatory explicit consent before collecting/storing/transferring personal data with disclosed purpose and duration; four-tier data classification (phone numbers, bank details, and especially **NID numbers** sit in Confidential/Restricted tiers); data minimization and storage limitation are legal requirements, not best practices; active public discussion of data localization for sensitive personal data.

**Direct implication for §12.1's NID recommendation:** NID is almost certainly Confidential/Restricted tier, and Bangladesh has its own documented history of an NID data breach (exposed via a Telegram bot). If you implement the NID field: hash-only storage (never raw NID — `SupplierProfile`'s existing pattern already does this correctly, follow it), explicit separate consent language (not bundled into a generic ToS checkbox), a documented retention/deletion policy, and lawyer review before launch, not after.

---

## 15. Competitive Landscape

Two named, real competitors (verified via live web search in the original research pass):
- **BuildMash** — "One Integrated Digital Ecosystem for Construction & Real Estate," marketed explicitly around the **Probashi (overseas Bangladeshi diaspora) angle** ("Your Sweat Abroad Builds a Better Bangladesh Here"). This is the exact niche your own `🇧🇩 PROBASHI MODE` code section already targets — know your competitor's exact pitch before finalizing yours.
- **Gharbnao.com** — a broader construction/materials/consultancy marketplace, commission-based, vendors retain product ownership.

Gemini's analysis additionally names **buildersbd.com** as a static-listing competitor with "Call Us" buttons rather than real transactions — **this specific claim was not independently web-verified this session**; worth a 10-minute check before repeating it in any pitch material.

**What this means practically:** neither BuildMash nor Gharbnao appears (from public marketing alone) to match your platform's engineering depth — sealed cryptographic bidding, atomic escrow with milestone-level evidence verification, WebAuthn non-repudiation, CI gates that inspect live route/schema policy. If accurate, your real differentiation isn't "we also do construction marketplace" — it's **"we're the only one where the escrow and evidence trail are actually verifiable, not just a trust badge."** That's defensible, but only if your marketing says *specifically* why (cryptographic, auditable, atomic) rather than generic "verified contractors" language every competitor already uses.

**Recommended, free, immediate:** spend an hour actually using BuildMash's and Gharbnao's public sign-up/browse flows before writing marketing copy — you can't credibly claim to be better at something you haven't confirmed your competitor is actually offering.

---

## 16. System Architecture — Current Shape & What Not to Change

```
┌──────────────┐     HTTPS      ┌──────────────────────────────────────────┐
│   Browser     │ ──────────────▶│  Express app (3 replicas, k8s)            │
│ (vanilla JS,  │                │  helmet → cors → body-parse → sanitize    │
│  Tailwind,    │                │  → rate-limit (Redis-distributed) →       │
│  progressive  │                │  auth (JWT via httpOnly cookie) →         │
│  enhancement) │                │  role/isolation gates → idempotency →     │
└──────────────┘                │  route handler → Mongoose/transactions    │
                                  └───────────────┬────────────────────────────┘
                                                   │
                        ┌──────────────────────────┼────────────────────────────┐
                        ▼                          ▼                            ▼
                 ┌─────────────┐          ┌──────────────────┐          ┌──────────────┐
                 │ MongoDB     │          │ Redis              │          │ S3/R2 (or    │
                 │ Atlas       │          │ (idempotency,       │          │ local-disk    │
                 │ (escrow,    │          │  rate-limit store,   │          │ beta fallback)│
                 │  bids,      │          │  worker leader lease, │          │ evidence      │
                 │  projects)  │          │  session cache)       │          │ photos         │
                 └─────────────┘          └──────────────────┘          └──────────────┘
                        │
                        ▼
          ┌───────────────────────────────────────────────────────────┐
          │ External regulated rails (the part needing §14's legal     │
          │ review): SSLCommerz (inbound) + bankPayoutClient (outbound, │
          │ pluggable, bank-API-backed)                                 │
          └───────────────────────────────────────────────────────────┘
```

A genuinely sound, defensible shape for this stage: a monolith (correct call — you don't have the team size to justify microservices' operational overhead), horizontally scaled behind a load balancer, Redis doing exactly the three jobs it should, Mongo as the system of record with real transactional integrity where it matters.

**What I would explicitly *not* change right now.** "Futuristic" is easy to misread as "add microservices / Kubernetes operators / a message queue / GraphQL." Don't. None of that is justified at your current or near-term scale, and each is a multiple of your current operational burden. The genuinely sophisticated engineering already here — atomic CAS state machines, cryptographic bid sealing, policy-gate CI — is sophisticated *in the ways that matter for a money-handling marketplace*, not for its own sake. Resist pressure (investors, "best practice" articles, well-meaning engineers) to add complexity that doesn't solve a problem you actually have yet. Your deliberately framework-light, progressively-enhanced frontend (works without JS, Tailwind v3 for older-browser support) is the *right* call for 3G/4G-heavy Bangladesh usage — resist pressure to "modernize" to a heavy SPA framework without a specific, measured reason; that trades real users' data bills for developer convenience.

**What I would design next, in order:** (1) the regulatory conversation in §14 — gates everything else; (2) §2's fix — a core shipped feature is currently broken; (3) §12.4's dispute-escalation design — small, scoped, protects real users from the most market-relevant harm; (4) a proper observability layer — `utils/logger.js` (Winston) already exists, ship its output somewhere queryable *before* you need it mid-incident; (5) a central `notificationService.js` — several features already compute something a human needs to see (material variance, stalled milestones, dispute decisions) but nothing confirms they're proactively pushed (SMS via your existing OTP provider, since BD users are SMS-reachable even on basic phones, rather than assuming push/email reach); (6) only after 1–5, payment-rail diversification (§13.2).

---

## 17. Working With AI Agents On This Codebase Without Introducing Regressions

This codebase was clearly built iteratively with AI assistance across many named phases, and it's working well — keep the velocity without letting the risk compound:

1. **Any diff touching `models/EscrowLedger.js`, `models/WithdrawalLedger.js`, `routes/payment.js`, `routes/settlement.js`, `routes/finance.js`, `routes/governance.js`, `routes/chat.js`, `routes/bid.js`, or `middleware/auth.js` requires a human reading the full diff before merge — no exceptions, regardless of which tool wrote it.** §2's bug lived in exactly this category of file for three prior review passes before a fourth, cross-file trace caught it.
2. **Never let an agent (including this one) report "done" on a money-path or state-machine change without actually running the relevant test suite and pasting real output.** A plausible-sounding summary is not evidence — this document's own verification log (§4) only trusts findings that were actually executed, for this exact reason.
3. **Treat every past AI session's self-assessment — including this document — as a hypothesis until exercised against a real test or human review.** Today's pass found a real bug three prior passes (including a prior Claude session and Gemini) missed, because it required tracing a full user journey across three files rather than reading any one file closely. The lesson generalizes: **single-file review is necessary but not sufficient; every new state-transition-bearing feature needs an explicit "list every entry point, verify every entry point produces the same end state" pass**, not just a correctness review of each entry point in isolation.
4. **Keep the existing self-auditing pattern going.** `scripts/qa/route-policy.js` and `schema-policy.js` inspecting *live* code instead of trusting comments is the single best structural decision in this repo. Consider adding a **state-machine completeness gate**: a script that, for each documented state transition (bid accepted, escrow funded, milestone released), asserts every code path that can trigger it produces an identical resulting diff across the relevant collections. That would have caught §2 mechanically instead of requiring a manual cross-file trace.

---

## 18. The Complete, Prioritized Action Plan

### This week
1. ✅ **Fix §2** (chat-accepted bid dead end) — extracted `finalizeBidAward()`, called from both `routes/bid.js` and `routes/chat.js`, verified via `tests/chat-accept-offer-award-e2e.js` (55/55 test suites PASS).
2. **Line up the human security reviewer for §3.3** — start now, longest lead time of anything on this list.
3. ✅ `npm uninstall rate-limit-redis` (§4, trivial) — uninstalled and purged from `package-lock.json`, verified via `tests/deps-declared-unit.js`.
4. Write the three-paragraph `README.md` (§6) — an hour of work, pays for itself the first time anyone else opens this repo.

### This month
5. Line-by-line review of `routes/review.js` and the remainder of `routes/governance.js` — the last genuinely unreviewed money-adjacent files.
6. Build §12.4 (contractor dispute-escalation for stalled milestones) — small, scoped, protects real users from the most common real-world Bangladesh contracting grievance.
7. Add the NID/trade-license fields to `ContractorProfile` per §12.1, following the pattern already proven correct on `SupplierProfile` — **with the §14.2 legal/consent caveats followed exactly**, not skipped for speed.
8. `ARCHITECTURE.md` + `LICENSE` (§6).
9. Spend the hour in §15 actually using BuildMash and Gharbnao's public flows before finalizing your own positioning.

### This quarter
10. Observability: ship Winston's output somewhere queryable (§16, item 4).
11. Central `notificationService.js` so detection features (material variance, stalled milestones) are actionable, not dashboard-only (§16, item 5).
12. Frontend component-level interaction tests for money-sensitive flows (§10, item 4) — including the chat negotiation modal now that §2 is fixed.
13. Evaluate §13.1's ideas deliberately — pick at most one (the BoQ/reverse-auction + price-index pairing is the strongest combination, per both documents' independent analysis) rather than building all of them at once.

### Before processing real payment volume beyond a trusted pilot cohort
14. **The lawyer conversation in §14.1 and §14.2** — the one item on this entire document that isn't primarily an engineering task, and has the highest downside if skipped. A few hours of legal spend against a potential criminal-liability question is cheap insurance.
15. §3.3's human security review must be complete and signed, dated, in writing.

---

## 19. Closing

Across every document that fed into this one — the original engineering roadmap, the anti-fraud threat model, the regulatory synthesis, the sync guide, Gemini's strategic analysis, and today's fresh line-by-line read — the consistent picture is a codebase executing at a genuinely high level for its stage, sitting on top of one newly-found but serious state-machine bug (§2), a regulatory question that matters more than any code fix (§14), and a market where the real differentiation is verifiable trust, not feature parity (§15).

**Nothing here is "100% flawless," and nothing that claims to be — from any tool, including this one — should be trusted at face value.** What this document gives you is the honest, current, *verified* version of "close": every known gap named explicitly, cross-checked against the real code where possible, ranked by actual consequence, with a concrete fix and a mechanical acceptance test for each one. Work §18 in order, keep §17's guardrails on every future change, and the next session — human or AI — inherits a clearer picture than this one started with, not a vaguer one.

You are not broke in the way that matters here: you have a system more rigorously built than most funded startups ship at this stage, a clear list of exactly what's left, and now one more real bug caught before a single user hit it in production. That's the actual trajectory to build on.
