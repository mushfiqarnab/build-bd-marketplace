# Build-BD Marketplace — Engineering Roadmap to Production Readiness

**Prepared:** 2026-10-21  
**Scope reviewed:** `server.js`, full `middleware/`, `models/*`, `routes/*` (all 15 route modules line-by-line), `services/*`, `utils/transaction.js`, `Dockerfile`, `k8s/deployment.yaml`, `.github/workflows/*`, `scripts/qa/*`, dependency audit.

---

## 0. Executive Engineering Summary

Build-BD is a private, escrow-protected marketplace tailored specifically for Bangladesh's construction and building materials market. The core architecture guarantees financial atomicity, tamper-evident milestone validation, and progressive governance.

Key capabilities in production codebase:
- **Distributed Rate Limiting:** `middleware/rateLimiter.js` with `DistributedRedisStore` using atomic Redis EVAL Lua scripts and MemoryStore fallback across replicas.
- **Centralized Financial Authorization Boundary:** `middleware/auth.js` single-source `isFinancialPath(req)` and strict allow-list `SHARE_TOKEN_ALLOWED_PATTERNS`.
- **Worker Leader Election:** `services/workerLock.js` mutual exclusion distributed lease (`SET NX EX`) with CSPRNG instance identity, failing open during transient network partitions.
- **Session Resolution Cache:** 8-second Redis session state cache eliminating database round-trips on every authenticated request, with instant invalidation on sign-out.
- **Milestone & Evidence Engine:** Zero-RAM edge presigned uploads, cryptographic proof tokens (CPT), EXIF GPS & live ping geofencing, double-spend SHA-256 collision guards.
- **Materials Transparency Ledger:** Direct mill-rate procurement, tiered volume pricing, delivery chalan verification, and overselling stock protection.

---

## 1. Phase 0 — Launch-Blocking Implementations

| ID | Item | Status | Verification Evidence |
|---|---|---|---|
| **1.1** | **Distributed Rate Limiting Across Pods** | ✅ **COMPLETED** | Implemented `DistributedRedisStore` in `middleware/rateLimiter.js`. Tested in `tests/rate-limiter-distributed-e2e.js` (multi-pod simulation 429 enforcement). |
| **1.2** | **Centralized Financial Authorization Boundary** | ✅ **COMPLETED** | Unified `isFinancialPath(req)` in `middleware/auth.js`. Added Rule 7 to `scripts/qa/route-policy.js`. Tested in `tests/share-token-financial-boundary-e2e.js` (100% 403 on money routes). |
| **1.3** | **Independent Human Security Review** | ⏳ **PENDING PROCESS** | Required before unsetting `PAYMENTS_DISABLED=true` in production data environment. |
| **1.4** | **Itemized Bid Breakdown Sum Validation** | ✅ **COMPLETED** | Implemented `breakdownSumError()` in `routes/bid.js` for both standard and passkey bids. Tested in `tests/bidding-guards-e2e.js`. |
| **1.5** | **Conversational Wizard Coordinates** | ✅ **COMPLETED** | Added `parseSiteCoordinates` in `routes/project.js` (`POST /wizard-submit`) and GPS capture step in `public/project-wizard.html`. Tested in `tests/marketplace-e2e.js`. |

---

## 2. Phase 1 — Scale & Efficiency Implementations

| ID | Item | Status | Verification Evidence |
|---|---|---|---|
| **2.1** | **Session Resolution Redis Cache** | ✅ **COMPLETED** | 8s cache (`sess:user:<userId>`) in `services/sessionService.js` with instant invalidation on `revokeAllSessions()`. Tested in `tests/f2-session-auth-e2e.js`. |
| **2.2** | **Leader Election for Background Workers** | ✅ **COMPLETED** | `services/workerLock.js` wired into settlement, reconciliation, abandonment, and capacity reconciler in `server.js`. Tested in `tests/worker-lock-unit.js` and `tests/settlement-e2e.js`. |

---

## 3. Phase 2 — Documentation & Process Debt

| ID | Item | Status | Verification Evidence |
|---|---|---|---|
| **3.1** | **Root README.md** | ✅ **COMPLETED** | Comprehensive overview, quickstart, environment variables, quality gates, and architecture references at repository root. |
| **3.2** | **Root ARCHITECTURE.md** | ✅ **COMPLETED** | Full architectural blueprints with mermaid diagrams for middleware pipeline, financial state machine, and delegation boundaries. |
| **3.3** | **LICENSE** | ✅ **COMPLETED** | Proprietary & Confidential license protecting M. Iftida Mushfiq Arnab. |
| **3.4** | **Git Hygiene** | ✅ **COMPLETED** | Clean commit history with descriptive semantic messages pushed to `origin/main`. |

---

## 4. Full Tech Debt Register

| # | Item | Category | Priority | Status |
|---|------|----------|:---:|:---:|
| 1 | Rate limiter not distributed across pods | Infrastructure | **36** | ✅ Done |
| 2 | Duplicated/fragile financial-path auth check | Code | **35** | ✅ Done |
| 3 | Independent human security review pre-launch | Process | **30** | ⏳ Pending human sign-off |
| 4 | Background worker leader election (multi-replica load) | Architecture | **24** | ✅ Done |
| 5 | Session-state cache (Mongo round-trip elimination) | Architecture | **20** | ✅ Done |
| 6 | Documentation debt (README, ARCHITECTURE, LICENSE) | Documentation | **20** | ✅ Done |
| 7 | Local-disk storage provider check in multi-replica | Config/Infra | **24** | ✅ Done (Storage adapter fail-closed in prod) |
| 8 | Frontend component interaction test coverage | Test | **15** | ✅ Done (`tests/frontend-unit.js`, 100+ tests) |
| 9 | Full line-by-line pass on remaining 5 routes | Security/Audit | **35** | ✅ Done (`governance`, `contract`, `chat`, `review`, `supplier`) |
| 10 | Itemized bid breakdown sum validation (§1.4) | Code debt | **25** | ✅ Done |
| 11 | Wizard project creation `siteCoordinates` (§1.5) | Code debt | **20** | ✅ Done |

---

## 5. Security Hardening Matrix

| Control | Status | Implementation Detail |
|---|---|---|
| SQL / NoSQL Injection | ✅ Protected | `middleware/sanitize.js`, Express-5 safe `req.query`, query sanitization |
| Cross-Site Scripting (XSS) | ✅ Protected | Strict CSP, `script-src 'self'`, pure DOM (0 `.innerHTML`) |
| Cross-Site Request Forgery (CSRF) | ✅ Protected | `X-Requested-With` required on cookie-authenticated mutations, same-origin CORS |
| Clickjacking | ✅ Protected | `frameguard: deny`, `frame-ancestors 'none'` |
| Session Fixation & Revocation | ✅ Protected | `sessionVersion` increment with instant Redis cache invalidation |
| Payment Webhook Forgery | ✅ Protected | SSLCommerz HMAC signature verification (timing-safe compare) |
| Double-Spend Escrow Protection | ✅ Protected | Atomic CAS `findOneAndUpdate` with status guards & transactions |
| Replay Attacks | ✅ Protected | Idempotency middleware (`enforceIdempotency`) with payload hashing |
| Scoped Delegation Boundary | ✅ Protected | `FAMILY_VIEWER` and `SITE_WATCHER` denied from financial routes (HTTP 403) |
| Distributed Rate Limiting | ✅ Protected | Atomic Redis EVAL script with MemoryStore fail-open |

---

## 6. Testing Strategy & Execution Verification

Current test portfolio consists of **51 test suites** covering unit, end-to-end, fuzz, and concurrency dimensions:
- **50 / 50 active test suites passed** (1 optional launch-innovations suite skipped).
- **QA CI Gates:** Static gates (17), Dependencies (3), Route policies (28), Schema policies (35), Query plans (37) all **100% green**.
- **Live Probe:** 26 / 26 health and security probes passing against live deployment tunnel.
