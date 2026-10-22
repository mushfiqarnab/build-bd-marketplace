# Build-BD Bilingual Voice & Text AI Model Blueprint ("Nirman-AI")
## Full-Stack CLI Implementation Specification for Domestic Labour (L1–L3) & Hybrid Services (Micro / Mid / Macro)

---

## 1. Executive Architecture & System Topology

Build-BD's **Nirman-AI** (`services/aiOrchestratorService.js`) is a **Deterministic-First, Schema-Constrained Bilingual (Bangla + Banglish + English) Conversational & Voice AI Orchestrator**. It enables any homeowner, property developer, contractor, domestic worker (via 2G feature phone IVR/SMS), or technician (via smartphone or SMS) to speak or type naturally in **Standard Bangla (`bn-BD`)**, **Regional/Colloquial Bangla**, **Phonetic Romanized Banglish**, or **English (`en-BD`)** and automatically compile their intent into an ACID-safe MongoDB state transition and SSLCommerz / bKash escrow payload.

### Why a Hybrid Neuro-Symbolic Architecture Is Mandatory for Build-BD
Pure unconstrained LLM tool-calling fails in financial escrow marketplaces due to hallucinated prices, floating-point rounding drift, and prompt-injection vulnerabilities. **Nirman-AI** solves this via a **Two-Stage Neuro-Symbolic Pipeline**:
1. **Stage 1 — Bilingual Acoustic & Semantic Parsing (ASR + NLU Slot Extractor)**:
   - **Web / Smartphone Audio Input**: Dual-mode speech capture using browser `SpeechRecognition` (`bn-BD` / `en-US`) with seamless fallback to server-side Whisper (`whisper-large-v3-turbo` / Bangla fine-tuned ASR) via `POST /api/ai/voice-intent`.
   - **2G Feature Phone Telecom Input (Zero-Data Worker Loop)**: Inbound SIP/PBX IVR voice streams & DTMF keypad presses (`1`, `2`, `9`) + Greenweb/SSL Wireless inbound SMS (`POST /api/v2/labour/webhooks/sms-ivr-inbound`).
   - **Code-Switched Entity Normalization**: Normalizes Bangla digits (`০-৯` → `0-9`), phonetic Banglish tokens (`bua`, `kajer lok`, `mistri`, `jogali`, `ac Pani porche`, `shift korbo`, `rong`), Dhaka/Chattogram/Sylhet thanas, and unit measures (`sqft`, `ton`, `bag`, `cft`).
2. **Stage 2 — Deterministic Pricing, Policy & Integer-BDT Escrow Compiler (`services/aiOrchestratorService.js`)**:
   - **Zero Hallucinated Prices**: The LLM/NLU layer *only* extracts structured enum slots (`vertical`, `subTier`, `categoryCode`, `thana`, `floorLevel`, `hasServiceLift`, `shiftHours`, `skillTags`, `sqft`, `quantity`). All monetary figures are computed deterministically by `services/aiOrchestratorService.js` using `utils/money.js` (`integerBDT`).
   - **Strict Whole-Taka Invariant (`Number.isInteger`)**: Reconciles the `.docx` architectural blueprints with `models/EscrowLedger.js` and bKash B2C API rules by rounding fee/reserve tranches via `Math.round()` and absorbing 1-Taka rounding residuals into the primary payout bucket.

---

## 2. Five-Vertical Intent Taxonomy & Routing Matrix

| Vertical Enum | Target Persona & Input Example (Bangla / Banglish / English) | Mapped Schema & Collection | Escrow & Settlement Rule (Integer BDT) |
| :--- | :--- | :--- | :--- |
| **`DOMESTIC_LABOUR`** (`SUB_TIER_L1_DAILY`, `SUB_TIER_L2_PART_TIME`, `SUB_TIER_L3_FULL_TIME`) | *"ধানমন্ডি ৭ নাম্বার রোডে প্রতিদিন সকাল ৮টা থেকে ২ ঘণ্টার জন্য একজন ছুটা বুয়া লাগবে, ওয়াশিং মেশিন চালানো জানা থাকতে হবে"* / *"Need a part-time maid in Dhanmondi for 2 hours daily"* | `DomesticWorkerProfile`, `Subscription`, `Contract`, 4× Weekly `Milestone` (`WEEKLY_TIMESHEET_T0`), 30× `Timesheet` | **L1 Daily**: 100% locked at check-in; **95% Worker / 5% Fee** at T+0 OTP.<br>**L2/L3 Monthly**: 1-day trial (`৳250`) → 100% Month 1 escrow; Thursday 20:00 cron pays **80% Immediate bKash B2C / 15% Continuity Reserve / 5% Fee** (Week 4 releases 95% + 100% accumulated reserve). |
| **`TIER_1_MICRO`** (On-Demand Utility & Task: `৳400–৳4,999`) | *"আমার বাসার এসি থেকে পানি পড়ছে, গুলশান ২, ১০ তলায় আউটডোর ইউনিট"* / *"AC jet wash in Gulshan 2, 10th floor"* | `Project` (`tier: 'MICRO'`), compressed single `Milestone` (`is_compressed_single: true`, `INSTANT_OTP_T0`) | **৳0 Booking Advance** (`৳200` visit fee floor if cancelled post-arrival). On-site check-in locks base labor (`৳800`) + floor hanging surcharge (`৳400` ≤8F, `৳800` >8F). T+0 OTP pays **80% Labor + 97.5% Parts** immediately; **10% Labor held 7 days** (`WARRANTY_HOLD`); **10% Labor + 2.5% Part MDR** to Platform. |
| **`TIER_2_MID`** (Renovation & Shifting: `৳5,000–৳2,50,000`) | *"মিরপুর DOHS এ ১৮০০ স্কয়ার ফিট ফ্ল্যাট পেইন্টিং করাবো"* / *"Need 1800 sqft flat painting in Mirpur"* | `Project` (`tier: 'MID'`, `BOQ_SPLIT_CART`), `Contract`, 2× `Milestone` (`ACCELERATED_24H`) | **20% Mandatory Advance Escrow** on work order confirmation; **16-Bank Credit Card EMI** enabled automatically when total `≥ ৳5,000`. Splits BOQ into **43% Labor / 45% Paint & Primer / 8% Putty / 4% Protection**. **6% Composite Fee**. |
| **`TIER_3_MACRO`** (Heavy Civil Tender: `৳2,50,000–Crores`) | *"উত্তরা সেক্টর ১১ তে ৬ তলা বিল্ডিংয়ের ফাউন্ডেশন ও ফ্রেম নির্মাণের দরপত্র"* / *"G+6 RCC foundation tender in Uttara budget 18.5 lakh"* | `Project` (`tier: 'MACRO'`, `OPEN_SEALED_BID`), `Bid` (SHA-256 + FIDO2), `EscrowLedger` (`STANDARD_48H_MOD`) | **100% Upfront Milestone Escrow**. Automatically splits milestones `> ৳5,00,000` into child SSLCommerz sessions (`_T1`, `_T2`, `_T3` each `≤ ৳5,00,000`). **95% Contractor / 5% Platform Fee** after 48h audit & 40m–80m Dhaka Dynamic Geofence proof. |
| **`MATERIALS_DIRECT`** (Materials Marketplace Bulk Order) | *"৫০০ বস্তা শাহ সিমেন্ট এবং ১০ টন বিএসআরএম রড গাজীপুরে ডেলিভারি চাই"* | `MaterialProduct`, `MaterialOrder` (`runTransaction` stock lock + escrow) | Atomic stock reservation (`modifiedCount === 1`) + integer BDT escrow funding (`FUNDED` → `IN_TRANSIT` → `DELIVERED` → `RELEASED`). |

---

## 3. Critical Architectural Reconciliations (Preventing Spec-vs-Repo Bugs)

When implementing the two `.docx` specifications inside `build-bd-marketplace`, the CLI **must** enforce these four engineering reconciliations:

### 3.1 Integer BDT Enforcement vs. Floating-Point Paisa (`.toFixed(2)`)
* **Conflict**: `Build-BD Domestic Labour Architecture.docx` wrote `Number((grossEarnedBdt * 0.15).toFixed(2))` yielding `157.50 Tk` on a `1,050 BDT` weekly wage, and `Build-BD Hybrid Marketplace Architecture.docx` wrote `12.50 BDT` for a 2.5% gateway fee on a `500 BDT` spare part. However, `utils/money.js` (`integerBDT`) and `scripts/qa/schema-policy.js` reject non-integer floats across MongoDB and bKash B2C payouts.
* **Engineered Resolution (Implemented in `services/aiOrchestratorService.js`)**:
  - **Weekly Domestic Split (`computeDomesticWeeklySplit`)**:
    ```javascript
    const platformFeeBdt = Math.round(grossEarned * 0.05);
    // Weeks 1-3:
    const continuityHoldBdt = Math.round(grossEarned * 0.15);
    const workerImmediateBdt = grossEarned - platformFeeBdt - continuityHoldBdt;
    // Example on 1,050 BDT: Fee = 53 BDT, Continuity Hold = 158 BDT, Worker Immediate = 839 BDT (Sum = 1,050 BDT, 100% Integer).
    ```
  - **Micro Tier T+0 Split (`computeMicroSettlementSplit`)**:
    ```javascript
    const platformLaborFeeBdt = Math.round(laborGross * 0.10);
    const warrantyHoldBdt = Math.round(laborGross * 0.10);
    const immediateLaborPayoutBdt = laborGross - platformLaborFeeBdt - warrantyHoldBdt;
    const gatewayPartFeeBdt = Math.round(partsGross * 0.025);
    const partsNetReimbursementBdt = partsGross - gatewayPartFeeBdt;
    // Example on 1,000 Labor + 500 Part: Immediate Payout = 800 + 487 = 1,287 BDT, Warranty Hold = 100 BDT, Total Fee = 100 + 13 = 113 BDT (Sum = 1,500 BDT, 100% Integer).
    ```

### 3.2 Static-Gate Lexicon Compliance (`scripts/qa/static-gates.js`)
* **Conflict**: The `.docx` specifications refer to `e-GP` and `Fraud Alert`. In `build-bd-marketplace`, `scripts/qa/static-gates.js` fails the build if `/\be-?GP\b|Section\s+(15|9)\b/` appears in `public/`, `routes/`, `services/`, or `models/`, or if `/\bFraud\s+Alert\b/i` appears anywhere.
* **Engineered Resolution**: All code comments, string literals, and UI templates inside `services/`, `routes/`, `models/`, `frontend/`, and `public/` must use `Macro Civil Tender` or `Public-Standard Tender` instead of the banned token, and `Security Escalation` / `Integrity Notice` instead of the banned alert phrase.

### 3.3 Anti-Collusion Cap on Micro Field Addendums
* **Rule**: Because `SPARE_PART` addendums carry only a `2.5%` gateway MDR pass-through whereas `MICRO` labor carries a `10%` platform fee, `services/aiOrchestratorService.js` (`computeMicroSettlementSplit`) enforces `sparePartsBdt <= Math.min(baseLaborBdt * 3, 5000)`. Any spare-part addendum above `3.0x` base labor or `৳5,000` sets `requiresModeratorCashMemoAudit = true` and blocks instant T+0 auto-clearance until a moderator verifies the hardware cash memo photo.

### 3.4 Three-Ring Domestic Trust & DWPWP-2015 Safety Guardrails
* **Ring 1 (Porichoy Biometric & Child-Labour Gate)**: Enforces `face_match_percentage >= 80`, `sim_nid_matched === true`, and `age >= 18` (`is_adult_18_plus === true`), blocking minors (`38.6%` of informal live-in workers in BILS surveys) at onboarding.
* **Ring 2 (Digital Darwan / Samity Guarantor Graph)**: Requires `>= 2` `ACTIVE_VOUCHED` guarantors (1 Urban Thana Anchor such as a Building Darwan/Caretaker or Samity Secretary + 1 Rural Kinship Anchor) verified via Porichoy NID, 15-second Bangla IVR voice recording, and 4-digit SMS OTP.
* **Ring 3 (Automated DMP CIMS Police Dossier)**: Auto-generates the Dhaka Metropolitan Police Citizen Information Management System (`CIMS`) printable dossier (`GET /api/v2/labour/dmp-cims-export/:contractId`) and laminated QR Smart ID Card upon hire confirmation.
* **48-Hour Police GD Gate for Security Disputes**: Prohibits unverified public "theft" review tags. Selecting `THEFT_OR_SECURITY_BREACH` freezes only the 15% continuity reserve (never already-cleared weekly wages) and requires a verified DMP Thana General Diary (`GD`) number within 48 hours, or automatically unfreezes and disburses the reserve to the worker's bKash wallet.

---

## 4. End-to-End Voice & Text API Specification

### 4.1 `POST /api/ai/orchestrate` (Bilingual Voice/Text Intent Endpoint)
* **Request Payload**:
  ```json
  {
    "utterance": "ধানমন্ডি ৭ নাম্বার রোডে প্রতিদিন সকাল ৮টা থেকে ২ ঘণ্টার জন্য একজন ছুটা বুয়া লাগবে, ওয়াশিং মেশিন চালানো জানা থাকতে হবে",
    "inputMode": "VOICE_TRANSCRIPT",
    "localeHint": "bn-BD"
  }
  ```
* **Response Payload (Generated by `services/aiOrchestratorService.js`)**:
  ```json
  {
    "detectedLanguage": "bn",
    "vertical": "DOMESTIC_LABOUR",
    "subTier": "SUB_TIER_L2_PART_TIME",
    "categoryCode": "HOUSEMAID_CHHUTA",
    "entities": {
      "thana": "Dhanmondi",
      "floorLevel": 1,
      "hasServiceLift": true,
      "shiftHours": 2,
      "skillTags": ["APPLIANCE_WASHING_MACHINE"],
      "isApplianceTrained": true
    },
    "pricing": {
      "trialDayFeeBdt": 250,
      "estimatedMonthlySalaryBdt": 9000,
      "weeklyGrossBdt": 2250,
      "week1To3Split": {
        "grossEarnedBdt": 2250,
        "workerImmediateBdt": 1800,
        "continuityHoldBdt": 338,
        "platformFeeBdt": 113
      },
      "week4FinalSplit": {
        "grossEarnedBdt": 2250,
        "workerImmediateBdt": 3151,
        "continuityHoldBdt": 0,
        "continuityReserveReleasedBdt": 1014,
        "platformFeeBdt": 113
      },
      "dwpwp2015Terms": {
        "paidWeeklyHolidaysPerMonth": 4,
        "maxDailyHours": 12,
        "noticePeriodDays": 7,
        "doubleBlindIvrShieldActive": true,
        "policeGdGateHours": 48
      }
    },
    "trustRequirements": {
      "ring1PorichoyBiometric": { "minFaceMatchPct": 80, "minAgeYears": 18, "simNidMatchRequired": true },
      "ring2DigitalDarwanGuarantors": { "minActiveGuarantors": 2 },
      "ring3DmpCimsDossier": { "autoGeneratePdf": true, "qrSmartIdCardIssued": true }
    },
    "apiAction": {
      "method": "POST",
      "endpoint": "/api/v2/labour/contracts/trial",
      "followUpSubscribeEndpoint": "/api/v2/labour/contracts/subscribe",
      "uiTemplate": "#tpl-domestic-directory"
    }
  }
  ```

### 4.2 `POST /api/v2/labour/webhooks/sms-ivr-inbound` (2G Feature Phone Webhook)
Processed deterministically by `parseFeaturePhoneWebhook()` in `services/aiOrchestratorService.js`:
* `channel: 'MISSED_CALL_CLI'` → Returns `LOG_ATTENDANCE_GATE_PING` (`attendance_status: 'PRESENT_AUTO_GATE_PING'`, `costBdt: 0`).
* `channel: 'IVR_DTMF'` or `'SMS_TEXT'` with `'1'` / `'রাজি'` / `'হ্যাঁ'` → Returns `ACCEPT_JOB_OR_TRIAL_OFFER` (locks contract atomically).
* `channel: 'IVR_DTMF'` or `'SMS_TEXT'` with `'2'` / `'না'` → Returns `DECLINE_OR_FLAG_SCOPE_CREEP`.
* `channel: 'IVR_DTMF'` or `'SMS_TEXT'` with `'9'` / `'বিপদ'` / `'বেতন দেয়নি'` → Returns `EMERGENCY_SAFETY_OR_WAGE_DISPUTE` (`HARASSMENT_FLAG` / `WAGE_DENIAL_CLAIMED`, routes to female Trust & Safety specialist within 15 minutes).
* `channel: 'SMS_TEXT'` with 4-digit code (`4829`) → Returns `VERIFY_REVERSE_ATTENDANCE_OTP` (`attendance_status: 'PRESENT_VERIFIED'`).

---

## 5. Verification & QA Test Suite Execution
Run the following commands to verify 100% compliance across the repository:
```bash
node tests/ai-orchestrator-unit.js
node scripts/qa/static-gates.js
node scripts/qa/deps-declared.js
node tests/frontend-unit.js
```
