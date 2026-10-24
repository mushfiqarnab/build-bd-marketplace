# 🇧🇩 Build-BD Marketplace v3 — Zero-Cost Launch & Scale Roadmap
**The Definitive Operator Playbook: From ৳0 Bootstrapped Pilot to Nation-Scale Bangladesh Construction Infrastructure**

---

## 1. Executive Summary & The ৳0-Cost Philosophy

Launching a construction and domestic services marketplace in Bangladesh usually suffers from severe bureaucratic and capital chicken-and-egg traps:
- **Merchant Gateways** (SSLCommerz, bKash Merchant) require an operational Trade License, TIN, BIN, RJSC incorporation, e-TIN, and physical office inspection before issuing credentials.
- **Telecom SMS Gateways** (OnnoRokom, Infobip) require bulk SMS aggregator contracts and advance deposits.
- **Biometric APIs** (Porichoy) require formal institutional clearance and per-hit API fees.

**Build-BD Marketplace v3 breaks this impasse completely.**  
By architecting a **hybrid, dual-mode operational core**, the system is capable of running **100% full-featured escrow-protected contracting, contractor bidding, material procurement, and domestic labour recruitment at exactly ৳0 initial setup cost**.

```
┌────────────────────────────────────────────────────────────────────────┐
│             BUILD-BD ZERO-COST DEPLOYMENT TOPOLOGY                     │
│                                                                        │
│   [ Client Browser ]     [ Contractor PWA ]     [ Supplier Portal ]    │
│            │                      │                      │             │
│            ▼                      ▼                      ▼             │
│   ══════════════════════════════════════════════════════════════════   │
│             Cloudflare Tunnel (`cloudflared`) — ৳0 Cost                │
│             (Global SSL, DDoS Protection, Zero Public IP)              │
│   ══════════════════════════════════════════════════════════════════   │
│                                  │                                     │
│                                  ▼                                     │
│     [ Node.js Server (Port 5000) - Helmet CSP & Pure DOM Frontend ]    │
│            │                             │               │             │
│            ▼                             ▼               ▼             │
│  MongoDB Atlas M0 Free          Upstash Redis Free   Local Disk Storage│
│  (ACID 3-Node Replica Set)     (10k ops/day Cache)  (HMAC Token View)  │
│                                                                        │
│  ═══════════════════════════════════════════════════════════════════   │
│                     OPERATIONAL RESILIENCE LAYER                       │
│  ═══════════════════════════════════════════════════════════════════   │
│  • OTP Delivery: `scripts/otp-relay.js` (Console / Web Dashboard)      │
│  • Escrow Verification: `scripts/ops/mfs-escrow-cli.js` (bKash/Nagad)  │
│  • Preflight Integrity: `scripts/ops/zero-cost-preflight.js`           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. The 15-Minute Zero-Cost Infrastructure Stack

Follow this exact sequence to take Build-BD from a bare terminal to live production in 15 minutes:

### Step 1: Initialize Cryptographic Secrets
Run the zero-cost preflight with `--init-env` to generate 256-bit CSPRNG secrets:
```bash
npm run preflight:zero-cost -- --init-env
```
This generates cryptographically isolated keys for:
- `JWT_SECRET` (User session & token integrity)
- `BID_SEAL_SECRET` (Cryptographic bid tampering deterrence)
- `AUDIT_HMAC_SECRET` (Double-entry transaction audit verification)
- `STORAGE_LOCAL_SECRET` (Time-bound HMAC presigned upload/view tokens)

### Step 2: Database Provisioning (MongoDB Atlas M0 Free Tier)
1. Sign up at [mongodb.com/atlas](https://www.mongodb.com/atlas) (Free Forever M0 Sandbox).
2. Create an M0 cluster in AWS `ap-southeast-1` (Singapore — lowest latency to Dhaka, ~38ms).
3. Create a database user `buildbd_user` with strong password.
4. Set Network Access to `0.0.0.0/0` (secured via SCRAM-SHA-256 and IP isolation).
5. Copy the connection string into `.env`:
   ```env
   MONGODB_URI=mongodb+srv://buildbd_user:<password>@cluster0.xxxxx.mongodb.net/buildbd?retryWrites=true&w=majority
   ```
*(Note: M0 provides 512MB storage and full 3-node Replica Set support, guaranteeing `runTransaction()` ACID double-entry safety).*

### Step 3: Cache & Rate Limiting (Upstash Redis Free Tier)
1. Sign up at [upstash.com](https://upstash.com) (Serverless Redis).
2. Create a database in `ap-southeast-1`.
3. Copy the Redis URI into `.env`:
   ```env
   REDIS_URL=rediss://default:<password>@ap-southeast-1.upstash.io:6379
   ```

### Step 4: Storage Configuration (৳0 Local Disk Storage)
Configure local storage in `.env`:
```env
STORAGE_PROVIDER=local
STORAGE_LOCAL_DIR=.storage
STORAGE_LOCAL_URL=https://your-domain.com/__storage
```
All uploads (contractor licenses, work site photos, delivery waybills) are stored in `.storage` and served through the hardened, path-traversal-protected route `GET /__storage/view/{*key}` authorized by HMAC tokens.

### Step 5: OTP Delivery Configuration
Set delivery mode to `console` in `.env`:
```env
DELIVERY_MODE=console
AUTO_FILL_OTP=false
```
In a background terminal, run the real-time OTP relay dashboard:
```bash
node scripts/otp-relay.js --watch
```
This serves a live web UI on `http://127.0.0.1:5001` where founders/moderators can view incoming OTP codes in real time without incurring any SMS gateway fees.

### Step 6: Payment Configuration (Manual MFS Escrow)
Set payment mode in `.env`:
```env
PAYMENT_GATEWAY_MODE=manual_mfs
TREASURY_PHONE=017XXXXXXXX
```
Replace `TREASURY_PHONE` with the platform's official bKash/Nagad personal or merchant mobile number.

### Step 7: Expose to Public Internet via Cloudflare Tunnel
Install `cloudflared` (free forever, no port forwarding or public static IP required):
```bash
cloudflared tunnel --url http://localhost:5000
```
Cloudflare provides an immediate `https://xxxx.trycloudflare.com` URL (or your own domain) with free SSL/TLS encryption, HTTP/2, and global DDoS protection.

---

## 3. Day-1 Ground Operations: Field Onboarding Playbook

### Targeted Pilot Hubs:
1. **Mirpur-10 & Mirpur-1 Mistri Patti** (High density of Masonry, Tiles, Gypsum, and Painting Mistris).
2. **Dhanmondi & Mohammadpur** (High renovation demand, shifting/movers, and domestic caregivers).
3. **Keraniganj Rohitpur & Zinzira** (Deep structural civil contractors, piling sardars, and timber mills).

### Tactical Onboarding Workflows:

#### A. Mistris & Trade Sardars (First 10 Onboarded)
1. **Zero App-Install Barrier**: Mistris do not need to download a heavy app from Google Play. Share the lightweight Web PWA URL (`https://buildbd.com/app/works.html`).
2. **Phone Number Registration**: Send OTP, observe it via `scripts/otp-relay.js`, and assist in initial sign-in.
3. **Work Modality Alignment**:
   - For Independent Mistris: Set `contractorTier: MISTRI_SARDAR` and supported modalities to `THIKA_LABOUR_ONLY` and `HAJIRA_DAILY_MISTRI`.
   - For Turnkey Contractors: Enable `WITH_MATERIAL_TURNKEY`.
4. **Physical Trust Verification**: Admin reviews national ID and sets verification level in `/app/admin-verify.html`.

#### B. Building Material Dealers (First 5 Onboarded)
1. **Supplier Registration**: Onboard local hardware/cement dealers in Mirpur and Keraniganj via `/app/login.html` with role `SUPPLIER`.
2. **Catalog Seeding**: Use `npm run seed:v3` or upload their live inventory:
   - Rod: BSRM / AKS / GPH (unit: TON)
   - Cement: Shah / Fresh / Bashundhara (unit: BAG)
   - Tiles: RAK / Greatwall (unit: SQFT)
   - Sanitary/PPR: RFL / National Polymer (unit: PIECE)
3. **Escrow Guarantee**: Explain to dealers that their payout is locked in platform escrow before they dispatch their delivery truck, eliminating bad-debt and default risk.

---

## 4. Scale Milestones & Progressive Legal Compliance Thresholds

Build-BD follows a progressive three-stage maturity framework to ensure 100% legal compliance as transactional volume grows:

| Milestone & GMV Range | Legal Entity & Licensing | Banking & Payment Infrastructure | Identity & Regulatory Clearance |
| :--- | :--- | :--- | :--- |
| **Stage A: ৳0 Pilot**<br>*(GMV: ৳0 – ৳5,00,000)*<br>*Projects: 1 – 15* | **Sole Proprietorship / Sandbox**<br>• Founder personal NID & Tax Certificate (TIN).<br>• Platform operated as a proprietary matchmaking beta. | **Manual MFS Escrow**<br>• `PAYMENT_GATEWAY_MODE=manual_mfs`<br>• Dedicated personal bKash/Nagad/Rocket account.<br>• Operator verification via `npm run ops:mfs`. | **3-Ring Community Verification**<br>• Ring 1: Manual NID upload.<br>• Ring 2: Darwan / Caretaker guarantor.<br>• Ring 3: Police clearance GD copy. |
| **Stage B: Commercial Beta**<br>*(GMV: ৳5,00,000 – ৳50,00,000)*<br>*Projects: 15 – 100* | **Formal Incorporation**<br>• Trade License (DNCC/DSCC: "E-Commerce & Digital Marketplace").<br>• Digital Business Identification (**DBID**) from Ministry of Commerce.<br>• Corporate BIN & e-TIN. | **Automated PGW & Corporate Escrow**<br>• Scheduled Commercial Bank Escrow Account (e.g. BRAC Bank).<br>• SSLCommerz / bKash Merchant Gateway activated (`PAYMENT_GATEWAY_MODE=sslcommerz`). | **Telecom Aggregator SMS**<br>• Migration from `console` to OnnoRokom / Greenweb SMS gateway.<br>• Automated 4-digit transactional OTP SMS delivery. |
| **Stage C: Scale & National Rollout**<br>*(GMV: > ৳50,00,000)*<br>*Projects: 100+* | **Full Private Limited Entity**<br>• RJSC Incorporation as "Build-BD Technology Ltd."<br>• Bangladesh Bank Payment System Operator (**PSO**) exemption or PSP escrow partnership.<br>• BASIS Membership. | **Multi-Bank Direct Clearing**<br>• Direct BEFTN / NPSB / RTGS automated payouts via bank host-to-host API.<br>• Multi-currency Probashi remittance escrow (USD/AED to BDT). | **Government Porichoy API**<br>• Direct Election Commission biometric Porichoy API handshake.<br>• Instant SIM-NID ownership match and automated criminal background check. |

---

## 5. Operator Command Reference

| Task / Purpose | CLI Command | Notes |
| :--- | :--- | :--- |
| **System Preflight & Integrity** | `npm run preflight:zero-cost` | Validates `.env`, taxonomy, estimators, and all 5 QA gates. |
| **Initialize Secure Keys** | `npm run preflight:zero-cost -- --init-env` | Generates 256-bit cryptographically secure `.env` secrets. |
| **Inspect Pending MFS Escrows** | `npm run ops:mfs -- --list` | Displays all pending bKash/Nagad client deposits awaiting verification. |
| **Verify & Unlock Milestone 0** | `npm run ops:mfs -- --verify <ledgerId> <trxId> <amount>` | ACID double-entry settlement from the terminal. |
| **Inspect Pending Vendor Payouts** | `npm run ops:mfs -- --payouts` | Lists contractor/supplier bank withdrawal requests. |
| **Complete Vendor Payout** | `npm run ops:mfs -- --pay-payout <id> <bankRef>` | Marks bank transfer or MFS cashout as completed. |
| **Seed Bangladesh Market Data** | `npm run seed:v3` | Idempotently seeds 8-domain projects, 14 materials, and Mistris. |
| **Real-Time OTP Relay Watcher** | `node scripts/otp-relay.js --watch` | Serves live OTP monitor at `http://127.0.0.1:5001`. |
| **Recompile & Sync Frontend** | `node scripts/build-frontend.js --sync-only` | Compiles 21 HTML pages and 38 JS modules into `public/app/`. |
| **Run Complete QA Gate Suite** | `npm run qa:ci` | Runs static gates, route policy, schema policy, query plans. |
| **Start Production Server** | `node server.js` | Runs Express engine under strict Helmet CSP and security guards. |

---
*Authored by the Principal Distributed Systems Architect & Bangladesh Market Specialist for Build-BD Marketplace v3.*
