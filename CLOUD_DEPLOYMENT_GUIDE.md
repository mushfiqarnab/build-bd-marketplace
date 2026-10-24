# Build-BD Marketplace — 24/7 Cloud Deployment Guide (No Local PC Required)

This guide migrates Build-BD off your local Windows PC (`scripts/beta-up.ps1` + `ngrok`) onto **Render.com ($0 Free Tier, Singapore Region)** so the marketplace stays live 24/7 even when your computer is completely shut down.

---

## Architecture Overview (100% Cloud, $0/month Fixed Cost)

| Layer | Cloud Service | Cost | Role |
| :--- | :--- | :--- | :--- |
| **App + WebSockets (`server.js`)** | **Render.com Web Service** (`singapore`) | **$0 / mo** (`750 hrs/mo` free) | Serves `/app/*`, `/api/*`, and Socket.io over automatic HTTPS (`*.onrender.com` or custom domain). Auto-deploys on every merge to `main`. |
| **ACID Database** | **MongoDB Atlas M0** (`ap-southeast-1`) | **$0 / mo** | 3-node Replica Set (reuse your existing `MONGODB_URI` from `.env.beta`). |
| **Cache & Rate Limit** | **Upstash Redis** (`ap-southeast-1`) | **$0 / mo** | Primary idempotency & rate-limit store (optional — falls back to MongoDB automatically if omitted). |
| **Evidence & Photo Storage** | **Cloudflare R2** (10 GB/mo free) | **$0 / mo** | Permanent S3-compatible object storage so uploaded site/waybill photos survive container restarts. |
| **Login OTP Delivery** | **BD SMS Gateway + ৳0 Fallback** (`sms_or_operator`) | Pay-per-SMS (~৳0.25) or **৳0** | Sends real SMS via **BulkSMSBD**, **Greenweb**, or **SSL Wireless**; automatically falls back to `/app/admin-verify.html` (**Cloud OTP Relay** tab) + optional Telegram Bot DM if SMS credits aren't configured yet. |
| **24/7 Wakefulness** | **cron-job.org / UptimeRobot** (`10m` ping) | **$0 / mo** | Pings `/health/liveness` every 10 minutes so the free Render instance never sleeps (`744 hrs / 31-day month` fits inside Render's `750 free hrs`). |

---

## Step 1: 1-Click Deploy on Render.com (3 Minutes)

1. Sign in at **[dashboard.render.com](https://dashboard.render.com)** with your GitHub account.
2. Click **New +** -> **Blueprint**.
3. Select repository **`mushfiqarnab/build-bd-marketplace`** (branch: `main`). Render automatically reads `render.yaml` from the root of the repo.
4. Fill in the prompted environment variables (you can copy `MONGODB_URI`, `REDIS_URL`, and `TREASURY_PHONE` straight from your local `.env.beta`):
   - `MONGODB_URI`: Your MongoDB Atlas `mongodb+srv://...` connection string *(ensure `0.0.0.0/0` is enabled under Atlas -> Network Access so Render Singapore IPs can connect)*.
   - `TREASURY_PHONE`: Your official bKash/Nagad number (e.g. `017XXXXXXXX`) for Zero-Cost Manual MFS Escrow.
   - `REDIS_URL` *(optional)*: Your Upstash `rediss://...` URI.
   - `SMS_API_TOKEN` *(optional on Day 1)*: Your BulkSMSBD or Greenweb API key (see Step 2 below). Leave blank on Day 1 to use the built-in **৳0 Cloud Operator Fallback** immediately.
5. Click **Apply**. Render builds `public/app`, generates 256-bit cryptographic secrets (`JWT_SECRET`, `BID_SEAL_SECRET`, `AUDIT_HMAC_SECRET`, `STORAGE_LOCAL_SECRET`, `TELECOM_WEBHOOK_SECRET`), auto-binds `CORS_ORIGIN` and WebAuthn Passkeys (`RP_ID` / `ORIGIN`) to your `https://<service>.onrender.com` URL via `RENDER_EXTERNAL_URL`, and brings the site live.

---

## Step 2: Configure Bangladeshi SMS Gateway (+ ৳0 Fallback)

`render.yaml` defaults to `OTP_DELIVERY=sms_or_operator`:
- **When `SMS_API_TOKEN` is set**: Users receive a 6-digit SMS directly on their Grameenphone / Robi / Banglalink / Teletalk phone. If the telecom gateway ever times out or runs out of balance, Build-BD **never locks users out** — it automatically falls back to the ৳0 Operator Relay.
- **When `SMS_API_TOKEN` is empty**: Build-BD uses the **৳0 Cloud Operator Relay** automatically.

### Supported Bangladeshi Providers (`SMS_PROVIDER`)

1. **BulkSMSBD (`SMS_PROVIDER=bulksmsbd` — Default)**
   - Register at `bulksmsbd.net` (instant bKash top-up).
   - Set `SMS_PROVIDER=bulksmsbd`, `SMS_API_TOKEN=<your_api_key>`, and `SMS_SENDER_ID=<approved_sender_id_or_8809617611000>`.
2. **Greenweb / BDBulkSMS (`SMS_PROVIDER=greenweb`)**
   - Register at `greenweb.com.bd`.
   - Set `SMS_PROVIDER=greenweb` and `SMS_API_TOKEN=<your_greenweb_token>`.
3. **SSL Wireless (`SMS_PROVIDER=sslwireless`)**
   - Set `SMS_PROVIDER=sslwireless`, `SMS_API_TOKEN=<api_token>`, and `SMS_SENDER_ID=<your_sid>`.

### Viewing ৳0 Fallback OTPs Without a Local PC
- **In the Web Admin Portal**: Sign in as an `ADMIN` and open **`/app/admin-verify.html`** -> click the **Cloud OTP Relay** tab (`GET /api/admin/otp-relay`) to view and 1-click copy active codes.
- **Instant Free Telegram Push (Recommended for Day-1 Bootstrap before SMS is topped up)**:
  1. Message `@BotFather` on Telegram -> `/newbot` -> copy the Bot Token into `TELEGRAM_BOT_TOKEN` on Render.
  2. Message `@userinfobot` on Telegram -> copy your numeric ID into `TELEGRAM_CHAT_ID` on Render.
  3. Every fallback OTP arrives privately on your phone in `<1s` at `৳0` cost.

---

## Step 3: Enable Permanent Photo Storage on Cloudflare R2 ($0 Free 10 GB)

Render's Free container filesystem resets whenever a new commit deploys. For permanent storage of contractor KYC documents, milestone photos, and delivery waybills:

1. In Cloudflare Dashboard -> **R2 Object Storage**, create bucket `buildbd-evidence` (Free tier includes **10 GB/month + $0 egress**).
2. Under **Bucket Settings -> CORS Policy**, allow `PUT` and `GET` from your `https://<your-app>.onrender.com` origin (headers: `Content-Type`, `Content-Length`).
3. Create an R2 API Token (Object Read & Write) and set these 5 variables in Render -> **Environment**:
   - `STORAGE_PROVIDER=r2`
   - `S3_BUCKET=buildbd-evidence`
   - `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
   - `S3_ACCESS_KEY_ID=<your_r2_access_key_id>`
   - `S3_SECRET_ACCESS_KEY=<your_r2_secret_access_key>`

---

## Step 4: Keep Render Awake 24/7 at $0 & Retire Local `ngrok`

1. **Prevent 15-Minute Idle Spin-Down ($0)**:
   - Create a free account at **[cron-job.org](https://cron-job.org)** or **[UptimeRobot](https://uptimerobot.com)**.
   - Add an HTTP `GET` monitor pointing to `https://<your-app>.onrender.com/health/liveness` every **10 minutes**.
   - One Render service running 24/7 uses at most `744 hours/month`, staying strictly inside Render's `750 free hours/month` allowance.
2. **Point GitHub Live QA Probe at Render**:
   - In GitHub -> `Settings` -> `Secrets and variables` -> `Actions` -> `Variables`, update `QA_LIVE_URL` to `https://<your-app>.onrender.com`.
3. **Turn Off Local PC Autostart**:
   - You no longer need `scripts\beta-up.ps1` or `ngrok` running on your PC. If you previously registered Windows autostart via `scripts\install-autostart.ps1`, remove the scheduled task once with:
     ```powershell
     Unregister-ScheduledTask -TaskName "BuildBD-Beta" -Confirm:$false
     ```
