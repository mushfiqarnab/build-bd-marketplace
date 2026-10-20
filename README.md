# Build-BD Marketplace

> **Bangladesh-First Escrow-Protected Construction & Materials Marketplace**  
> Connecting property owners (clients), verified contractors (ঠিকাদার), and building materials suppliers with cryptographic milestone escrow, tamper-evident EXIF site evidence, and progressive multi-project governance.

---

## 🌟 Overview

Build-BD solves the trust deficit in Bangladesh's private construction and material procurement market. Unlike public tender systems (e-GP), Build-BD protects **private property owners, contractors, and material suppliers**:

1. **Escrow-Protected Milestone Payments:** Money is deposited to an escrow ledger before work commences, disbursed tranche-by-tranche strictly upon verified milestone completion.
2. **Cryptographic Anti-Fraud Geofencing:** Milestone progress photos are validated server-side for authentic EXIF metadata (GPS site coordinates, timestamp tamper protection, SHA-256 duplicate image hashing).
3. **Materials Transparency Ledger & Chalan Verification:** Direct mill-rate procurement (BSRM, AKS, Shah Cement) with delivery escrow locks, weight slip / chalan photo validation, and automatic stock protection against overselling.
4. **Probashi Multi-Project Hub & Scoped Family Delegation:** Non-resident Bangladeshis can oversee construction back home and delegate inspection roles (`FAMILY_VIEWER`, `SITE_WATCHER`) with strict financial isolation (delegated tokens cannot release money or approve milestones).
5. **Ultra-Low Bandwidth & High Resilience:** Light DOM architecture without bloated single-page framework overhead, optimized for 3G/4G connectivity, offline-tolerant, with complete bilingual parity (English + Bengali).

---

## 🚀 Quick Start

### Prerequisites
- **Node.js** v20.x or v22.x+
- **MongoDB** 6.0+ (Replica Set required for ACID transactions; MongoDB Atlas supported)
- **Redis** 6.2+ (Upstash or local Redis for distributed rate-limiting, idempotency, and session caching)

### 1. Installation
```bash
git clone https://github.com/mushfiqarnab/build-bd-marketplace.git
cd build-bd-marketplace
npm install
```

### 2. Environment Configuration
Create `.env` (or `.env.beta`) from the template:
```bash
cp .env.example .env
```
Key required environment variables:
```ini
NODE_ENV=production
PORT=5000
BIND_ADDRESS=127.0.0.1
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/buildbd?retryWrites=true&w=majority
REDIS_URL=rediss://default:<token>@<host>.upstash.io:6379
JWT_SECRET=your_64_byte_random_hex_secret
BID_SEAL_SECRET=your_64_byte_random_hex_secret
AUDIT_HMAC_SECRET=your_64_byte_random_hex_secret
TREASURY_PHONE=01700000000
CORS_ORIGIN=https://yourdomain.com
SERVER_URL=https://yourdomain.com
```

### 3. Local In-Memory Development
To run locally without a pre-configured MongoDB replica set:
```bash
npm run dev:local-db
```

### 4. Running the Server
```bash
node --env-file=.env server.js
```

---

## 🛡️ Testing & QA Quality Gates

The codebase contains an exhaustive, pyramid-shaped automated testing and verification suite.

### Run All 50 Test Suites
```bash
npm test
```
*Executes all unit suites, end-to-end integration flows, money state-machine fuzz testing (480 random actions with 0 invariant violations), and idempotency concurrency race suites.*

### Run QA CI Architecture Policy Gates
```bash
npm run qa:ci
```
*Inspects live Express routers and Mongoose schemas to enforce:*
1. **Static Gates:** Zero `.innerHTML`, zero prohibited terms, pure DOM security.
2. **Dependency Gate:** Asserts all imported packages are explicitly declared.
3. **Route Policy Gate:** Enforces `enforceIdempotency` on all financial endpoints, strict role ordering, and share token financial boundaries.
4. **Schema Policy Gate:** Verifies integer BDT currency types, immutable identity constraints, and proper indexes.
5. **Query Plans Gate:** Analyzes MongoDB aggregation and query index utilization.

### Run Live Probe (Deployment Verification)
```bash
node scripts/qa/live-probe.js https://your-deployment-url.com
```

---

## 📂 Architecture & Reference Documentation

- [`ARCHITECTURE.md`](file:///D:/build-bd-marketplace/ARCHITECTURE.md): Full system architecture, request pipeline lifecycle, financial state machines, and delegation security boundaries.
- [`FRONTEND-MIDDLEWARE-BACKEND-SYNC-GUIDE.md`](file:///C:/Users/iftid/Downloads/files(2)/FRONTEND-MIDDLEWARE-BACKEND-SYNC-GUIDE.md): Cross-layer contract coherence and sync checklist.
- [`BUILD-BD-ENGINEERING-ROADMAP.md`](file:///C:/Users/iftid/Downloads/files(2)/BUILD-BD-ENGINEERING-ROADMAP.md): Technical debt register, security hardening checklist, and post-launch roadmap.

---

## 📜 License

Copyright © 2026 M. Iftida Mushfiq Arnab. All rights reserved.  
Proprietary software. Unauthorized copying, modification, or distribution is strictly prohibited.
