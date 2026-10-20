# Build-BD — Frontend ↔ Middleware ↔ Backend Sync Guide

**Purpose:** this is the document you or any contributor (human or AI) reads **before changing anything that crosses the frontend/backend boundary** — a new field, a new endpoint, a new validation rule. It exists because two real bugs (§3) were caused by drift across layers, and the goal is zero more of them.

**Companion document:** `docs/BUILD-BD-ENGINEERING-ROADMAP.md` covers security/infra/process. This one covers *coherence* — does what the frontend sends match what the backend expects, does what the backend returns match what the frontend reads, and does every validation rule exist in both places or (correctly) in only one.

---

## 1. The Request Lifecycle — What Actually Runs, In Order

Every state-changing request in this app passes through the same fixed pipeline. Knowing this exact order is the single most useful thing for avoiding sync bugs, because **a rule enforced at the wrong layer, or missing from one layer, is where drift originates.**

```
┌─────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                              │
│  frontend/js/pages/*.js                                              │
│    → calls frontend/js/api.js: post('/bids/123', { bidAmount, ... }) │
│    → api.js adds: X-Requested-With, Content-Type, x-idempotency-key  │
│    → fetch('/api/bids/123', { credentials: 'same-origin' })          │
│    → httpOnly cookie `bb_session` rides along automatically          │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ EXPRESS MIDDLEWARE PIPELINE (server.js, in THIS exact order)         │
│  1. helmet()              — security headers, strict CSP             │
│  2. cors()                — explicit origin only                     │
│  3. express.json({limit:'10kb'})  — body parsed here; req.body exists │
│  4. hpp()                 — strips duplicate query-param pollution   │
│  5. compression(), morgan — non-security, skip mentally               │
│  6. dev-only-page block   — 404s test pages in production            │
│  7. static file serving   — /app/*, fonts, public assets              │
│  8. middleware/sanitize.js — strips $ / . keys from body+query        │
│  9. app.use('/api', apiLimiter)        — 120 req/min, distributed    │
│ 10. route-specific limiter (strictAuthAndBidLimiter or financialLimiter) │
│ 11. verifyToken (middleware/auth.js)   — resolves req.user from cookie/Bearer │
│ 12. requireRole([...]) or enforceBidIsolation or allowRoleOrScopedToken │
│ 13. enforceIdempotency (middleware/idempotency.js) — ONLY on routes that mount it explicitly │
│ 14. the route handler itself           — your actual business logic  │
│ 15. error-handling middleware (bottom of server.js) — formats ANY thrown error │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ SERVICE / MODEL LAYER                                                │
│  routes/*.js call into services/*.js and models/*.js                 │
│  Mongoose schema validators run on .save()/.create() — this is a     │
│  REAL validation layer, not just a type system. See §2.              │
│  Money-moving logic wraps in utils/transaction.js → runTransaction() │
└─────────────────────────────────────────────────────────────────────┘
```

**The one rule that generalizes everything in this document:**
> A validation rule, a field, or a status check that exists at only ONE of (frontend JS / route handler / Mongoose schema) is a latent bug. It's not automatically wrong to have it in only one place — but it must be a *deliberate* choice, and you should be able to say out loud which layer is the source of truth and why.

---

## 2. Where Each Kind of Rule *Should* Live

| Rule type | Correct home | Why | Wrong home that causes bugs |
|---|---|---|---|
| "Is this a valid shape of input" (required fields present, right type) | Route handler, first thing | Needs to reject before touching the DB | Frontend-only (API is directly callable) |
| "Is this value within domain limits" (bid ≥ 100 BDT, withdrawal ≥ 500 BDT) | Route handler | Business rule, not a type rule | Mongoose schema alone (schema only sees what already got that far) |
| "Does this value stay consistent with another value in the same payload" (itemized sum = bidAmount) | Route handler, explicitly — **enforced in `routes/bid.js`** | Cross-field checks don't belong in a single-field Mongoose validator | Frontend-only |
| "Is this money value an integer, non-negative, within safe-integer range" | **Both** — Mongoose schema (`models/EscrowLedger.js`, `WithdrawalLedger.js`) as the hard backstop, route handler as the early, friendly rejection | Defense in depth is correct here because it's money | — |
| "Does the caller own this resource / have this role" | Middleware (`requireRole`, `enforceBidIsolation`) or explicit in-handler ownership check | Must run before any data is touched or returned | Frontend route guards (a hidden button is not security) |
| "Is this the caller's Nth attempt this window" | Middleware (distributed rate limiters via `DistributedRedisStore`) | Needs to be enforced before the handler runs, and shared across pods | Process-local in-memory limiters |
| "Has this exact financial operation already been performed" | Middleware (`enforceIdempotency`) | Must wrap the handler, not live inside it | — |
| "What should the UI show while waiting / on error" | Frontend only | Pure UX, no security or money implication | — |

---

## 3. Boundary Audits & Status (verified against actual code)

### 3.1 Itemized bid breakdown — ✅ FIXED & IN SYNC
- **Frontend:** `frontend/js/pages/submit-bid.js` blocks submission client-side if `sum(itemizedBreakdown.amount) !== bidAmount`.
- **Backend:** `routes/bid.js` implements `breakdownSumError()` checking both `POST /:projectId` and `POST /sign/:projectId`.
- **Verification Evidence:** `tests/bidding-guards-e2e.js` asserts 400 rejection on mismatch at submission time.

### 3.2 Wizard project creation — ✅ FIXED & IN SYNC
- **Standard path:** `POST /api/projects` captures and validates `siteCoordinates` (with Bangladesh bounding-box check).
- **Wizard backend path:** `POST /api/projects/wizard-submit` in `routes/project.js` runs `parseSiteCoordinates(req.body.siteCoordinates)` and persists coordinates in `Project.create`.
- **Wizard frontend UI:** `public/project-wizard.html` provides a GPS capture step ("📍 লোকেশন দিন / Use GPS") at the Location step via `navigator.geolocation`.
- **Verification Evidence:** `tests/marketplace-e2e.js` (Test 1B) verifies coordinates capture, Bangladesh bounding box validation, and database persistence.

### 3.3 Core Flows Confirmed in Sync
- `frontend/js/pages/withdraw.js` ↔ `routes/finance.js` `POST /withdraw`: field names (`amount`, `bankDetails.{accountName, accountNumber, routingNumber, bankName}`) match exactly, and the frontend's `amount < 500` check mirrors the backend's `Number(amount) < 500` check.
- `frontend/js/api.js` idempotency-key handling, `X-Requested-With` header, and same-origin credential mode line up exactly with `middleware/auth.js` and `middleware/idempotency.js`.
- `public/project-wizard.html` ↔ `routes/project.js` `POST /wizard-submit`: fields `category`, `location`, `scopeDescription`, `priority`, and `siteCoordinates` match.

---

## 4. The Pre-Change Checklist (use this every time you touch a boundary)

```
[ ] 1. Did I add/change a field the frontend sends? → grep the backend route
      handler for that exact field name. If it's not read there, either the
      backend is silently ignoring data (likely a bug) or it's genuinely
      unused (delete it from the frontend payload).

[ ] 2. Did I add/change a field the backend expects? → grep every frontend
      page that calls this endpoint for that exact field name. Check
      frontend/js/pages/*.js AND any shared component in
      frontend/js/components/*.js that might build the payload.

[ ] 3. Did I add a NEW validation rule? → find its row in §2's table.
      Put it in the layer that row names. If it's a cross-field or
      domain-limit rule, it MUST exist in the route handler even if it
      also exists in the frontend for UX.

[ ] 4. Did I add a NEW route that touches money, milestones, bids, or
      contracts? → it MUST appear in scripts/qa/route-policy.js's
      MONEY_ROUTES list (for idempotency) and be blocked by
      isFinancialPath(req) in middleware/auth.js.

[ ] 5. Did I add a field to a Mongoose model that stores money? → it MUST
      have an integer validator matching the pattern already used in
      models/EscrowLedger.js. Copy that pattern, don't write a new one.

[ ] 6. Does this change need a corresponding change in duplicate logic? →
      check middleware/auth.js's isFinancialPath(req); it is the
      centralized single source of truth for financial path boundaries.

[ ] 7. Did I run `npm run qa:ci` and `npm test` and actually read the
      output, not just check the exit code?
```

---

## 5. Per-Feature Contract Maps

### 5.1 Authentication (OTP + Passkey)

| Layer | Detail |
|---|---|
| Frontend | `frontend/js/session.js`, `frontend/js/pages/login.js` |
| Endpoint | `POST /api/auth/send-otp` → `POST /api/auth/verify-otp` (or passkey ceremony endpoints) |
| Middleware | `authLimiterExceptMe` |
| Backend sets | `bb_session` httpOnly cookie via `services/sessionService.js` `issueSession()` |
| Frontend reads | Nothing from the response body for the token — cookie is httpOnly. Frontend only reads `user` profile. |
| Sync rule | **Never** store auth tokens in `localStorage` in production. |

### 5.2 Project Posting (Standard & Wizard)

| Layer | Standard path | Wizard path |
|---|---|---|
| Frontend | `frontend/js/pages/post-project.js` | `public/project-wizard.html` |
| Endpoint | `POST /api/projects` | `POST /api/projects/wizard-submit` |
| Required fields | `title, category, description (≥20 chars), location, budget, siteCoordinates?` | `category, location, scopeDescription (≥20 chars), priority, siteCoordinates?` |
| Backend validation | `parseSiteCoordinates()` — BD bounding box, lat/lng pair validation | `parseSiteCoordinates()` — BD bounding box, lat/lng pair validation |
| Sync rule | Both paths capture coordinates so projects qualify for highest `CRYPTOGRAPHIC_PROOF` EXIF evidence tiers. |

### 5.3 Bidding (Sealed + Optional Passkey-Signed)

| Layer | Detail |
|---|---|
| Frontend | `frontend/js/pages/submit-bid.js` |
| Endpoint | `POST /api/bids/:projectId` (standard) or `POST /api/bids/sign/:projectId` (FIDO2) |
| Middleware | `strictAuthAndBidLimiter` (distributed Redis), `verifyToken`, `requireRole(['CONTRACTOR'])` |
| Backend validation | `bidAmount ≥ 100`, `estimatedDays ≥ 1`, `breakdownSumError()` enforcing itemized breakdown sum |
| On accept | `PUT /api/bids/:bidId/accept` — atomic CAS, builds `EscrowLedger.milestones` from breakdown |

### 5.4 Escrow Funding (SSLCommerz payment)

| Layer | Detail |
|---|---|
| Frontend | Browser redirects to SSLCommerz hosted gateway, returns to `/api/payment/success\|fail\|cancel` |
| Backend endpoint | `POST /api/payment/ipn` — server-to-server webhook |
| Middleware | Deliberately public, secured by SSLCommerz HMAC signature verified in-handler |
| Backend validation | Signature → `tran_id` match → `amount`/`currency` match against ledger → atomic CAS funding |

### 5.5 Milestone Evidence & Settlement

| Layer | Detail |
|---|---|
| Frontend | Photo upload UI → `uploadPresigned()` in `frontend/js/api.js` → direct to S3/R2 edge |
| Backend | `services/evidenceService.js` verifies EXIF (GPS/timestamp) → assigns `verificationTier` → `routes/governance.js` commits to milestone |
| Depends on | `Project.siteCoordinates` — enables `CRYPTOGRAPHIC_PROOF` tier verification |

### 5.6 Withdrawal

| Layer | Detail |
|---|---|
| Frontend | `frontend/js/pages/withdraw.js` |
| Endpoint | `POST /api/finance/withdraw` |
| Middleware | `verifyToken`, `requireRole(['CONTRACTOR','CLIENT'])`, `enforceIdempotency`, `financialLimiter` |
| Backend validation | `amount ≥ 500`, integer, complete `bankDetails`, atomic debit-then-create-ledger transaction |
