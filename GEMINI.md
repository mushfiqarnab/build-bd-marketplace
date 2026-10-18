# GEMINI MANDATORY RULES — BUILD-BD MARKETPLACE
# This file is automatically loaded by Antigravity CLI for every turn in D:\build-bd-marketplace.
# Authority: M. Iftida Mushfiq Arnab ("Arnab", GitHub @mushfiqarnab) — sole human architect, reviewer, merger, and decider.
# Complete guide reference: D:\agy-briefs\START-HERE.md, GEMINI-STANDARD.md, LEAD-CHARTER-build-bd-and-uiscan.md, WORKFLOW-2026-10-18-parallel-agy-claude.md.

## 0. THE IRON HONESTY RULES (GEMINI-STANDARD §0)
1. Never write "done", "verified", "merged", or "approved" without pasting the raw terminal command and output. No raw output = not done.
2. Never claim browser testing. You cannot open a browser. Write verbatim: "Not browser-tested." and supply the owner manual checklist.
3. Never invent API fields, routes, models, flags, or test files. Verify everything against the repo via grep/ls this session.
4. Never delete, skip, loosen, weaken, or `// ignore` any test, gate, or lint check.
5. Never claim anyone approved anything unless quoted directly from a file or message.
6. When unsure: STOP and ask. A question costs minutes; a wrong guess costs the owner money.

## 1. OWNERSHIP & BOUNDARIES (LEAD CHARTER §2, WORKFLOW §2.4)
- **YOU OWN:**
  * `frontend/pages/*.html`
  * `frontend/js/pages/*.js`
  * `frontend/js/components/*.js` (pure factory functions returning HTMLElement, zero network calls)
  * `frontend/js/messages.js` — **APPEND-ONLY** (never reorder, reword, or delete existing keys; always add en AND bn pairs)
  * `frontend/js/shell.js`, `dialog.js`, `i18n.js`, `session.js`, `api.js` (only when explicitly named in a brief)
  * `tests/frontend-unit.js` (append-only guards)
  * `public/app/**` (ONLY generated via `npm run build:frontend`; never hand-edit or hand-merge)
  * `frontend/icons.txt` (only icons explicitly named in the brief)
- **CLAUDE OWNS (STRICTLY FORBIDDEN TO EDIT):**
  * `routes/`, `models/`, `utils/`, `services/`, `middleware/`, `server.js`, `scripts/`, `package*.json`, `CLAUDE.md`, `.env*`
  * All escrow, settlement, money math, auth, and database transaction logic.
  * If a backend route or field is missing: write a `REQUEST:` block for Claude and take the next unblocked frontend task.
- **OWNER DECIDES (ARNAB ONLY):**
  * Merging PRs, deploying, restarting the beta, touching Atlas/ngrok/ports 5000/5055, modifying dependencies/workflows, approving copy.

## 2. 100% FREE & ZERO-SAAS CONSTRAINT (GEMINI-STANDARD §2)
- Zero paid APIs, zero external SaaS, zero external CDNs, scripts, or fonts. (CSP blocks external scripts; fonts and icons are bundled).
- Zero new npm dependencies without explicit owner approval. Use standard Web APIs.
- Performance budgets: No image > 150 KB, no new JS file > 40 KB. Fast on 3G and low-end Android.

## 3. FUNCTIONAL & ACCESSIBILITY HARD FLOOR (GEMINI-STANDARD §3-§4)
- **9 Mandatory States:** Loading skeleton, empty state, error state (with retry button), success state, inline validation errors, disabled-while-busy buttons (prevent double submit), offline network banner, expired-session redirect to login, and wrong-role feedback message.
- **Idempotency:** Every mutating call (`POST`/`PATCH`/`PUT`) must pass an `idempotencyKey`, reuse the identical key on retry, and never auto-retry a money endpoint.
- **Pure DOM Rule:** ZERO `innerHTML`, `outerHTML`, or `insertAdjacentHTML`. ZERO inline `<script>`. ZERO inline `on*=` handlers (`onclick`, etc.). Never shadow `window.location`.
- **Touch & Typography:** Touch targets $\ge 44$ px (`min-h-[44px]` or `min-w-[44px]`). Bangla text $\ge 14$ px.
- **Contrast & Layout:** WCAG AA contrast using design tokens from `frontend/tailwind.config.js` (e.g., `text-money-fill`, never raw `text-success` on white). Viewport responsive at 360 px width without horizontal scroll. Focus indicators visible; dialogs trap focus and close on Escape (`dialog.js` pattern).
- **Icons:** Whitelisted in `frontend/icons.txt` only (`close`, `add`, `edit`, `info`, `error`, `warning`, `account_balance_wallet`; `cancel` and `check` do NOT exist).

## 4. COPY & TERMINOLOGY DISCIPLINE
- **Clearance:** Strictly **2 calendar days** ("২ দিন" / "2 days"). NEVER write "কার্যদিবস" / "business days" (money rules run on 48h calendar time).
- **Estimates:** Always "estimate (আনুমানিক)", NEVER "market price".
- **Tone:** "Inform, never accuse". No words like "Fraud", "Violation", "Shortage", "প্রতারণা". Use neutral amber chips (`bg-amber-50 border-amber-300 text-amber-950`).
- **Endorsements:** Never imply or state government, e-GP, or BSTI endorsement.
- **Evidence Copy:** GPS/photos are contractor-phone-reported, not independently verified. Replace "cryptographic proof" with neutral copy ("Location reported at site" / "সাইটে থাকা অবস্থায় লোকেশন জমা"). No green verified shields for `CRYPTOGRAPHIC_PROOF`.
- **Role Privacy:** Hide all Taka amounts from `FAMILY_VIEWER` and `SITE_WATCHER`. Hide contractor phone numbers on bid comparisons until the bid is `ACCEPTED`.
- **Client Wording:** Do not reword or unify "প্রকল্প মালিক" / "গ্রাহক" (undecided by owner).
- **Draft Copy:** Every new user-facing sentence must be listed in the PR body under `DRAFT copy — owner to approve` (en + bn).

## 5. THE 11 PROVEN REPO TRAPS (MEMORIZE WITH RECEIPTS)
1. `/api/auth/me` returns `data.user.id`, NOT `userId`. Reading `currentUser.userId` returns `undefined`. Always use `currentUser.id`.
2. Worktrees use junctioned `node_modules` (`mklink /J`). Running `git worktree remove --force` wipes out `D:\build-bd-marketplace\node_modules`. Always run `cmd /c rmdir <worktree>\node_modules` first, then remove worktree without `--force`.
3. Local `node_modules` hides undeclared dependencies removed from `package.json`. Never touch `package*.json`.
4. Lockfile refresh drifts packages (e.g. `@tailwindcss/forms` 0.5.9 $\rightarrow$ 0.5.11), breaking CSS diff reproducibility.
5. Commit author email MUST be `miftida@gmail.com` or `iftida88@gmail.com` (user.name `Iftida`). Never pass `-c user.email` or use any Claude account email.
6. A gate never seen failing proves nothing (route-policy and parity script false-greens). Every guard must be proven via mutation (§2.7).
7. Scripted edits lie: regex `\s*$` swallowed blank lines; heredocs stripped backslashes. Use Edit tool and inspect every line of `git diff`.
8. Uncommitted WIP in `D:\build-bd-marketplace` risks destruction on branch switch. Keep main checkout clean on `main` and work in `C:\Users\iftid\Projects\bb-agy`.
9. D: drive free space is volatile (8 GB to 36 GB). Worktrees belong on C:.
10. Windows PowerShell displays Bangla UTF-8 as `????`. This is a console codepage artifact. Verify with Node UTF-8 inspection.
11. Implication fallacy: Verify call sites before claiming a function or status is never reached.

## 6. THE LEAD'S OPERATING LOOP (S0–S7)
- **S0 Ritual Start:** Fetch origin, inspect `git status -sb`, verify perishable facts, check open PR states.
- **S1 Deep-Analysis:** Write `D:\agy-briefs\work\T<n>-analysis.md` BEFORE touching code. Must have all 7 sections: Restatement, Reading Log with line numbers, Invariants, Failure Modes ($\ge 10$), Options Considered ($\ge 2$), Chosen Design + Test Plan, Unknowns.
- **S2 Small Steps:** Small edits $\rightarrow$ run check $\rightarrow$ rebuild $\rightarrow$ verify.
- **S3 Mutation Proof (§2.7):** For every new guard in `tests/frontend-unit.js`: State rule $\rightarrow$ clean tree $\rightarrow$ backup & SHA256 $\rightarrow$ mutate 1 rule ($\le 3$ lines) $\rightarrow$ verify guard FAILS and save to `mut-<guard>.txt` $\rightarrow$ restore exactly $\rightarrow$ verify SHA256 $\rightarrow$ re-verify PASS $\rightarrow$ record row in PR table.
- **S4 Hostile Review & Stretch:** Execute $\ge 10$ attacks (`ATTACKS_RUN: n`) across $\ge 10$ categories. Execute $\ge 2$ stretch items (`STRETCH_ITEMS: n`). Apply ratchet rule (permanent guard).
- **S5 Mechanical Checker:** Run `node D:\agy-briefs\work\check-report.js <task> --repo <worktree> --run-gates`. Exit code MUST be 0.
- **S6 Report:** Follow 10-section template, paste raw outputs, declare "Not browser-tested.", provide owner checklist.
- **S7 Ritual End:** Update `D:\agy-briefs\STATE-build-bd.md` (Facts, Now/Next, Blocked, Risks, Lessons). Clean tree. STOP.

## 7. MECHANICAL PRE-FLIGHT EVIDENCE CHECKLIST
Before opening PR, the checker verifies all files in `work\T<n>-outputs\`:
- `01-base-ok`: contains `BASE_OK`
- `02-build`: contains `Frontend built`
- `03-status`: clean tree after build
- `04-frontend-unit`: contains `all passed`
- `05-qa`: contains `QA PASSED` (ALL layers: static 15, contrast, route policy 17, schema 35, query plans, all test suites)
- `06-diff-stat`: only files you own
- `07-parity`: `node D:\agy-briefs\work\i18n-parity.js` contains `PARITY OK` (zero duplicate keys, en/bn parity)
- `08-identity`: allowed owner email
- `mut-*.txt`: every mutation log shows guard failing
- Onboarding exam passed: `EXAM-build-bd-result.json` has `passed: true`.
