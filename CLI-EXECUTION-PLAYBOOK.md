# CLI Execution Playbook — How To Work `BUILD-BD-MASTER-ROADMAP.md`

**Purpose:** paste this whole file (or just the steps below) as instructions to Claude Code or any CLI coding agent working on `build-bd-marketplace`. It tells the agent exactly how to consume the roadmap safely — one verified change at a time, never a batch of unverified ones.

---

## Step 0 — One-time setup, before touching any code

```bash
git clone https://github.com/mushfiqarnab/build-bd-marketplace.git
cd build-bd-marketplace
npm install
cp .env.example .env   # fill in real values; the server refuses to boot without the REQUIRED_ENV_VARS
npm run dev:local-db    # or point at a real MongoDB REPLICA SET — transactions (runTransaction) require one, a standalone Mongo will fail every money-path test
```
**Confirm the baseline is green before changing anything:**
```bash
npm test
npm run qa:ci
npm run qa:ledgers
```
If any of these fail on a clean checkout, stop and report that first — don't start fixing roadmap items on top of an already-broken baseline.

---

## Step 1 — Read, don't skim

The agent must read `BUILD-BD-MASTER-ROADMAP.md` **in full** before writing any code — not just §18 (the action list). §2, §9, and §17 explain *why* each fix matters and what pattern caused it; skipping straight to the checklist is exactly the "read one file in isolation" habit that let §2's bug through three prior reviews.

---

## Step 2 — Work the list in the roadmap's own order, one item at a time

Follow §18 top to bottom: **This week → This month → This quarter → Before real payment volume.** For each item:

1. State which roadmap section you're implementing (e.g. "§2 — fixing the chat accept-offer dead end") before writing code.
2. Implement **only** that item. Do not bundle unrelated fixes into the same change — §17's guardrail #1 requires a human to read the full diff on money-path files, and a mixed diff makes that review meaningless.
3. Write or adapt the **exact acceptance test the roadmap specifies** for that item (every §1–§13 finding names one). If no test is named, write one before marking the item done.
4. Run it, and run the full suite:
```bash
npm test
npm run qa:ci
npm run qa:ledgers
node scripts/qa/route-policy.js
node scripts/qa/schema-policy.js
node scripts/qa/static-gates.js
```
5. **Paste the real output, not a summary of it.** Per §17 guardrail #2: "a plausible-sounding summary is not evidence." If a test fails, fix it before moving on — don't skip to the next roadmap item with a known-red test.
6. Commit **only this one change**, with a message that says *why* (matching the existing `// 🛡️ Phase-X fix:` style already in the repo), referencing the roadmap section number.
7. **Update the roadmap file itself**: change that item's status from ❌/⚠️ to ✅, and add one line under it saying how it was verified (the file is designed to stay a living document — §19 depends on this).

---

## Step 3 — Hard stop conditions (never cross these automatically)

- **Any diff touching `models/EscrowLedger.js`, `models/WithdrawalLedger.js`, `routes/payment.js`, `routes/settlement.js`, `routes/finance.js`, `routes/governance.js`, `routes/chat.js`, `routes/bid.js`, or `middleware/auth.js`** → implement and test it, but **do not merge to `main` or enable it against real money** without a named human actually reading the diff. Flag this explicitly in your summary to the user; don't silently proceed as if it's done.
- **§3.3 and §14's items (independent security review, lawyer consultation)** are not code tasks. The CLI cannot complete them. State clearly that these remain open and need a human to schedule, every time you report progress — don't let them quietly fall off the list once the code items start getting checked off.
- **Never set `PAYMENTS_DISABLED` to anything other than `true` against a database holding real funds** unless the user explicitly confirms §3.3's human review is complete.

---

## Step 4 — Handling §13 (Gemini's growth ideas) specifically

These are **ideas to evaluate, not a backlog to implement.** For each one the user asks about:
1. Check it against the *real* schema and routes first (`grep`/`view` the actual models — Gemini's own code samples used invented model names that don't match this repo).
2. Write a short feasibility note: does it conflict with an existing feature, does it touch a regulated/financial path (if so, it inherits Step 3's hard stop), what's the smallest version that tests the idea.
3. **Do not write implementation code for any §13 idea until the user explicitly picks one.** Building all five in parallel is explicitly what §13.2 warns against — it pulls time from §2/§3/§12.4, which protect real users today.

---

## Step 5 — After each work session, report back in this shape

- Which roadmap item(s) were completed, with real test output.
- Which items are now blocked on a human (security review, lawyer, design decision) — list them by name every time, don't let them go silent.
- The next 1–3 items in roadmap order, so the user always knows what's next without re-reading the whole file.

---

**The one rule that matters most:** this playbook exists so the CLI never has to guess what "done" means — the roadmap already defines an acceptance test for everything actionable. If an item has no clear acceptance test and no clear next step, stop and ask the user rather than inventing one.
