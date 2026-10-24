// server.js
// Load .env FIRST: modules required below (e.g. services/redisClient.js) read process.env
// when they are loaded, so a later dotenv.config() would be too late for them.
require('dotenv').config();

// Strip accidental whitespace / newlines from pasted cloud secrets
if (process.env.MONGODB_URI) process.env.MONGODB_URI = process.env.MONGODB_URI.replace(/\s+/g, '');
if (process.env.REDIS_URL) process.env.REDIS_URL = process.env.REDIS_URL.replace(/\s+/g, '');
if (process.env.TREASURY_PHONE) process.env.TREASURY_PHONE = process.env.TREASURY_PHONE.replace(/\s+/g, '');

const dns = require('dns');

// 🌐 Public DNS only for MongoDB Atlas SRV (mongodb+srv://) lookups, which some Bangladeshi
// ISP resolvers fail. Local and replica-set URIs do not need it, so it stays off for them.
if ((process.env.MONGODB_URI || '').startsWith('mongodb+srv://')) {
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
    console.log('🌐 Public DNS override active for the Atlas SRV lookup (8.8.8.8, 1.1.1.1, 8.8.4.4)');
  } catch (err) {
    console.error('⚠️ DNS override failed:', err.message);
  }
}

const path = require('path');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
if (process.env.ALLOW_PREVIEW_IFRAME === 'true' && process.env.SKIP_DB_IN_PREVIEW === 'true') {
  mongoose.set('bufferCommands', false);
}
const helmet      = require('helmet');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const compression = require('compression');
const hpp         = require('hpp');
const morgan      = require('morgan');
const logger      = require('./utils/logger'); // Phase 30: Structured Observability Logger
const { apiLimiter, strictAuthAndBidLimiter, financialLimiter } = require('./middleware/rateLimiter');
const paymentRouter = require('./routes/payment');
const governanceRouter = require('./routes/governance');
const financeRouter = require('./routes/finance');
const contractorProfileRouter = require('./routes/contractorProfile');
const { initializeSocket }           = require('./services/socketService');
const { settlePendingTranches }      = require('./services/settlementService');
const { runReconciliationCycle }     = require('./services/reconciliationService');
const { runAbandonmentSweep }        = require('./services/abandonmentService');  // Phase 28
const { escalateStalledMilestones }   = require('./services/milestoneEscalationService'); // Anti-withholding stall escalator
const { reconcileCapacity }          = require('./services/ledgerLifecycle');
const { isRedisReady, closeRedis, getRedisTelemetry } = require('./services/redisClient');
const { ensureIndexes, getIndexState } = require('./services/indexService');
const { acquireWorkerLease } = require('./services/workerLock');

// 🛡️ TIER-1 BOOT SEQUENCE ARMOR: Fail-fast environmental assertions
const REQUIRED_ENV_VARS = [
  'MONGODB_URI',
  'JWT_SECRET',
  'TREASURY_PHONE'
];

REQUIRED_ENV_VARS.forEach((envVar) => {
  if (!process.env[envVar]) {
    console.error(`💥 FATAL BOOT EXCEPTION: Architecture halted. Missing critical environment variable: ${envVar}`);
    process.exit(1);
  }
});

// 🛡️ Phase-3 P1 fix: In production, CORS_ORIGIN must be an explicit origin
// (or a comma-separated allow-list). On Render.com, RENDER_EXTERNAL_URL is
// automatically injected with the exact https://<service>.onrender.com origin.
const resolvedCorsOrigin = (process.env.CORS_ORIGIN || process.env.RENDER_EXTERNAL_URL || '').trim();
if (process.env.NODE_ENV === 'production') {
  if (!resolvedCorsOrigin || resolvedCorsOrigin === '*') {
    console.error('💥 FATAL BOOT EXCEPTION: CORS_ORIGIN must be set to an explicit origin in production (e.g. your public URL). An unset or "*" value is refused.');
    process.exit(1);
  }
}

// 🛡️ Audit E7: with NODE_ENV unset the payment layer may fall back to the (unsigned) mock gateway. That is fine on
// a developer's loopback, never on a network-reachable bind. Refuse to start rather than run an open gateway.
{
  const bind = (process.env.BIND_ADDRESS || '127.0.0.1').trim();
  const loopback = bind === '127.0.0.1' || bind === 'localhost' || bind === '::1';
  if (!process.env.NODE_ENV && !loopback) {
    console.error(`💥 FATAL BOOT EXCEPTION: NODE_ENV is not set but BIND_ADDRESS=${bind} is reachable from the network. Set NODE_ENV=production (or development/test for a local run).`);
    process.exit(1);
  }
}

const app = express();

// 🛡️ CRITICAL DEPLOYMENT FIX: Tells Express to trust the Load Balancer / Cloudflare IP
app.set('trust proxy', 1);

// ─────────────────────────────────────────────
// 🏥 KUBERNETES ORCHESTRATION PROBES
// Registered FIRST, before every rate limiter and other middleware, so a health
// checker polling every few seconds can never be throttled or blocked.
// ─────────────────────────────────────────────

/**
 * GET /health/liveness
 * Kubernetes liveness probe.
 * Returns 200 as long as the Node.js process is alive and the event loop is
 * not stuck. A 503 here causes Kubernetes to RESTART the pod.
 */
app.get('/health/liveness', (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ status: 'shutting_down', message: 'Pod is draining.' });
  }
  res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

/**
 * GET /health/readiness
 * Kubernetes readiness probe.
 * Returns 200 only when ALL dependencies are healthy — MongoDB connected AND
 * either Redis ready or Redis intentionally bypassed.
 * A 503 here causes Kubernetes to REMOVE the pod from the load-balancer pool
 * WITHOUT restarting it.
 */
app.get('/health/readiness', async (req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ status: 'shutting_down', message: 'Pod is draining.' });
  }
  const mongoReady = mongoose.connection.readyState === 1;
  const redisReady = isRedisReady();
  if (!mongoReady) {
    return res.status(503).json({
      status: 'not_ready',
      checks: { mongodb: 'disconnected', redis: redisReady ? 'ready' : 'degraded' }
    });
  }
  // In production the integrity constraints (unique/TTL indexes) must be in
  // place before this instance takes traffic.
  const indexState = getIndexState();
  if (process.env.NODE_ENV === 'production' && indexState.status !== 'ok') {
    return res.status(503).json({
      status: 'not_ready',
      checks: { mongodb: 'connected', indexes: indexState.status }
    });
  }
  // Redis memory telemetry is for operators, not anonymous callers, and costs
  // two INFO round-trips per probe (metered on Upstash). Production omits it.
  const redisTelemetry = process.env.NODE_ENV === 'production'
    ? undefined
    : await getRedisTelemetry().catch(() => ({ connected: false }));
  res.status(200).json({
    status: 'ready',
    checks: {
      mongodb: 'connected',
      redis: redisReady ? 'ready' : 'degraded (MongoDB fallback active)',
      ...(process.env.NODE_ENV === 'production' ? { indexes: indexState.status } : {})
    },
    ...(redisTelemetry ? { redisTelemetry } : {}),
    timestamp: new Date().toISOString()
  });
});

const allowPreviewIframe = process.env.ALLOW_PREVIEW_IFRAME === 'true' && process.env.NODE_ENV !== 'production';

// 🚀 ENTERPRISE MIDDLEWARE PIPELINE
// 1. Global Security Headers & CORS (Mounted before rate limiters so 429 responses retain CORS & HSTS headers)
// Helmet with a zero-external-CDN script CSP. All scripts must be same-origin ('self').
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'"],
      styleSrc:    ["'self'"],
      fontSrc:     ["'self'"],
      imgSrc:      ["'self'", "data:", "blob:"],
      connectSrc:  ["'self'"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
      baseUri:     ["'none'"],
      formAction:  ["'self'"],
      ...(allowPreviewIframe ? { frameAncestors: ["'self'", 'https:'] } : {})
    }
  },
  // HSTS: 1 year, include subdomains, allow preload registration
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  // Clickjacking protection
  frameguard: allowPreviewIframe ? false : { action: 'deny' }
}));

// No wildcard default: the app's own pages are same-origin and need no CORS
// grant. An explicit CORS_ORIGIN (required in production by the boot check
// above) is the only cross-origin caller allowed. Supports comma-separated origins.
const parseCorsOrigin = (val) => {
  const trimmed = (val || '').trim();
  if (!trimmed) return false;
  if (trimmed.includes(',')) {
    return trimmed.split(',').map((o) => o.trim()).filter(Boolean);
  }
  return trimmed;
};
app.use(cors({ origin: parseCorsOrigin(resolvedCorsOrigin), optionsSuccessStatus: 200 }));

// ─────────────────────────────────────────────────────────────────────────────
// 🛡️ PHASE 29: DISTRIBUTED ANTI-FRAUD PERIMETER
// ─────────────────────────────────────────────────────────────────────────────

// TIER 1 — API gateway limiter (middleware/rateLimiter.js): 120 requests per minute per IPv6 /56
// subnet, on /api only. Mounted before body parsers to reject volumetric traffic before buffer allocation.
app.use('/api', apiLimiter);

// TIER 2 — Financial endpoint limiter (middleware/rateLimiter.js): 10 req / 10 min
// Applied explicitly to /api/contracts and /api/payment to add a second,
// tighter throttle on top of the global one. Uses user-aware keyGenerator
// to prevent CGNAT collisions for mobile users.

// 💾 Local-disk upload endpoint for STORAGE_PROVIDER=local. Mounted BEFORE express.json
// so the raw PUT body is not consumed by the JSON parser. Only mounted when the local
// adapter is active, so other deployments never expose this surface.
{
  const { storageConfig } = require('./services/s3Service');
  if (storageConfig.provider === 'local') {
    app.use('/__storage', require('./routes/localStorage'));
  }
}

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' })); // 🛡️ CRITICAL: Parses SSLCommerz form-encoded IPN webhooks & redirects
app.use(hpp());
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', { stream: logger.stream }));

// 🚧 Dev-only pages — refuse to serve in production (defence in depth; the files may be
//    present in the image but must not be reachable by end users).
const DEV_ONLY_PAGES = new Set(['/test-client.html', '/evidence-sandbox.html', '/project-wizard.html']);
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && DEV_ONLY_PAGES.has(req.path)) {
    return res.status(404).send('Not found');
  }
  next();
});

// Step L6: Root route cutover (/ and /index.html redirect to /app/)
app.get(['/', '/index.html'], (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  if (allowPreviewIframe && process.env.PREVIEW_ENTRY === 'analytics') {
    return res.redirect(302, `/app/analytics.html${qs}`);
  }
  return res.redirect(302, `/app/${qs}`);
});

// 🌐 New frontend (built from frontend/ into public/app). It has no inline
// scripts and loads nothing from other hosts, so it gets a strict CSP —
// stronger than the legacy portal's policy, which still needs 'unsafe-inline'.
const APP_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "font-src 'self'",
  "img-src 'self' data: blob:", "connect-src 'self'",
  allowPreviewIframe ? "frame-ancestors 'self' https:" : "frame-ancestors 'none'",
  "base-uri 'none'", "form-action 'self'", "object-src 'none'"
].join('; ');
app.use('/app', (req, res, next) => { res.setHeader('Content-Security-Policy', APP_CSP); next(); });
// Fonts never change at the same filename → cache for a year. CSS/JS are
// cache-busted with ?v=<content hash> and revalidated via ETag.
app.use('/app/fonts', express.static(path.join(__dirname, 'public', 'app', 'fonts'), { maxAge: '365d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public'))); // 🌐 Portal, PWA manifest, service worker

// NoSQL-injection guard (Express 5-safe): see middleware/sanitize.js
app.use(require('./middleware/sanitize'));

// 🗄️ DATABASE CONNECTION & HEARTBEAT MONITORING
if (allowPreviewIframe && process.env.SKIP_DB_IN_PREVIEW === 'true') {
  console.log('🌐 [Preview Mode] Running UI server without MongoDB replica set (SKIP_DB_IN_PREVIEW=true).');
} else {
  mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 30000,
    autoIndex: process.env.NODE_ENV !== 'production'
  })
  .then(() => {
    console.log('✅ Connected securely to MongoDB Atlas!');
    // 🛡️ Phase-4 P0: autoIndex is off in production, so build the schema's
    // unique/TTL indexes explicitly (create-only, idempotent) and surface any
    // failure through /health/readiness instead of running without them.
    if (process.env.NODE_ENV === 'production') {
      ensureIndexes().then((r) => {
        if (r.status === 'ok') console.log('🗂️ [Indexes] All schema indexes present.');
        else console.error(`🚨 [Indexes] ${r.failures.length} model(s) failed index build — readiness will report not_ready:`, r.failures);
      });
    }
  })
  .catch((err) => {
    console.error('❌ Fatal Initial Database connection failure:', err.message);
    process.exit(1);
  });
}

mongoose.connection.on('disconnected', () => console.warn('⚠️ MongoDB connection lost. Attempting to reconnect...'));
mongoose.connection.on('reconnected', () => console.log('🔄 MongoDB connection restored.'));

// 🌐 Environment probe — public, unauthenticated, cheap. Lets the client know whether
//    to render dev-only UI and what storage mode is live. Never exposes credentials.
// Extended for F4-F8 so the frontend can read platform constants (payments
// kill-switch, bid floor, upload caps, allowed content types) without hard-
// coding them. Everything here is public knowledge — nothing secret ships.
app.get(['/api/environment', '/api/system/environment'], (req, res) => {
  const { storageConfig } = require('./services/s3Service');
  const s3Service = require('./services/s3Service');
  const mode = process.env.NODE_ENV === 'production' ? 'production'
             : process.env.NODE_ENV === 'test'       ? 'test'
             :                                         'development';
  res.status(200).json({
    status: 'success',
    data: {
      mode,
      storage: {
        provider: storageConfig.provider,
        uploadMethod: storageConfig.uploadMethod,
        failClosed: Boolean(storageConfig.failClosed)
      },
      payments: {
        // The frontend F7 payment step shows a 503 kill-switch banner up front
        // instead of attempting /initiate and parsing the 503 error body.
        enabled: process.env.PAYMENTS_DISABLED !== 'true',
        // 'manual_mfs' = zero-cost manual bKash/Nagad TrxID escrow, 'mock' = test mode, 'live' = SSLCommerz
        gateway: process.env.PAYMENT_GATEWAY_MODE === 'manual_mfs'
          ? 'manual_mfs'
          : (paymentRouter.isMockGateway() ? 'mock' : 'live'),
        treasuryPhone: process.env.TREASURY_PHONE || '01700000000'
      },
      limits: {
        bidFloorBdt: 100,                    // models/Bid.js min
        projectBudgetFloorBdt: 1000,         // models/Project.js min
        milestoneReceiptMaxBytes: s3Service.MAX_EVIDENCE_SIZE_BYTES || 10 * 1024 * 1024,
        proofMaxBytes: s3Service.MAX_FILE_SIZE_BYTES || 25 * 1024 * 1024,
        allowedEvidenceContentTypes: s3Service.EVIDENCE_ALLOWED_MIME_TYPES
          ? [...s3Service.EVIDENCE_ALLOWED_MIME_TYPES]
          : ['image/jpeg', 'image/png', 'image/webp'],
        allowedProofContentTypes: s3Service.ALLOWED_MIME_TYPES
          ? [...s3Service.ALLOWED_MIME_TYPES]
          : ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
      },
      projectCategories: require('./config/bdWorkTaxonomy').PROJECT_CATEGORIES,
      tradeCategories: require('./config/bdWorkTaxonomy').TRADE_MICRO_CATEGORIES,
      macroDomains: require('./config/bdWorkTaxonomy').MACRO_DOMAINS,
      workCategories: require('./config/bdWorkTaxonomy').BD_WORK_CATEGORIES,
      materialCategories: require('./config/bdWorkTaxonomy').SUPPLIER_MATERIAL_CATEGORIES,
      microTaskBudgetFloorBdt: 200,
      version: require('./package.json').version
    }
  });
});

// 🗺️ ROUTING PIPELINE
// GET /api/auth/me runs on every page load to learn who is signed in; the
// strict 30-per-15-min auth limiter is for OTP/passkey attempts, not this.
// /me stays under the general /api limiter.
const authLimiterExceptMe = (req, res, next) =>
  (req.method === 'GET' && req.path === '/me') ? next() : strictAuthAndBidLimiter(req, res, next);
app.use('/api/auth',               authLimiterExceptMe, require('./routes/auth'));
app.use('/api/projects/:id/materials', require('./routes/projectMaterials'));
app.use('/api/projects',           require('./routes/project'));
app.use('/api/bids',               strictAuthAndBidLimiter, require('./routes/bid'));
// Phase 29: financialLimiter (10 req/10min) applied as a second throttle layer
// on top of the global 100/15min limiter for all money-touching endpoints.
app.use('/api/contracts',          financialLimiter, require('./routes/contract'));
app.use('/api/contractor-profile', contractorProfileRouter);
app.use('/api/supplier',           require('./routes/supplier'));
app.use('/api/materials/orders',   require('./routes/materialOrders'));
app.use('/api/materials',          require('./routes/materials'));

// 🛑 Phase-1 payments kill switch. Set PAYMENTS_DISABLED=true to answer every
// /api/payment/* request with 503 — the audit found six P0 SSLCommerz holes
// (IPN signature not verified, amount not compared, val_id reuse, mock-gateway
// fallthrough on empty creds). Keep this on until all six are fixed and the
// SSLCommerz sandbox creds are set to real values in .env.beta.
if (process.env.PAYMENTS_DISABLED === 'true') {
  app.use('/api/payment', (req, res) => {
    res.status(503).json({
      status: 'error',
      message: 'Payments are temporarily disabled on this environment. Please try again later.'
    });
  });
  console.warn('⚠️ [Payments] /api/payment/* is in kill-switch mode (PAYMENTS_DISABLED=true).');
} else {
  // 🛡️ Phase-3 P1 fix: SSLCommerz IPN callbacks arrive from a single gateway
  // IP in bursts. Running them through the 10-per-10-min financialLimiter
  // would 429 legitimate webhooks, which SSLCommerz interprets as failure
  // and retries forever. /ipn skips the limiter; every other payment path
  // keeps the second-layer financial throttle.
  const financialUnlessIpn = (req, res, next) => {
    if (req.path === '/ipn') return next();
    return financialLimiter(req, res, next);
  };
  app.use('/api/payment', financialUnlessIpn, paymentRouter);
}
app.use('/api/governance',         governanceRouter);
app.use('/api/finance',            financialLimiter, financeRouter);
app.use('/api/settlement',         financialLimiter, require('./routes/settlement'));
app.use('/api/moderation',         require('./routes/arbitration'));
app.use('/api/chat',               require('./routes/chat'));
app.use('/api/reviews',            require('./routes/review'));
app.use('/api/dashboard',          require('./routes/dashboard'));
app.use('/api/admin',              require('./routes/admin'));
app.use('/api/ai',                 require('./routes/aiOrchestrator'));
app.use('/api/v2/labour',          require('./routes/labourV2'));
app.use('/api/v2/projects',        require('./routes/hybridV2'));

// 🛑 GLOBAL ENTERPRISE ERROR ISOLATION & PARSING LAYER
app.use((err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message;
  // A "try again" answer must not be frozen by the idempotency layer (middleware/idempotency.js).
  if (err.retryable) res.locals.idemRetryable = true;

  // 🛡️ Mongoose Validation Error Parser
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors).map(val => val.message).join(', ');
  }
  // 🛡️ Mongoose Duplicate Key Error Parser
  else if (err.code === 11000) {
    statusCode = 409;
    message = 'Duplicate entry detected. Resource already exists.';
  }
  // 🛡️ Mongoose Cast Error (Invalid ObjectId) Parser
  else if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid database identifier format for ${err.path}.`;
  }

  if (statusCode === 500) {
    console.error(`💥 [CRITICAL SERVER ERROR]:`, err);
  } else {
    console.warn(`⚠️ [Operational Error ${statusCode}]: ${message}`);
  }

  res.status(statusCode).json({
    status: 'error',
    message: (statusCode === 500 && !err.isOperational) ? 'Internal Server Configuration Error' : message
  });
});

const PORT       = process.env.PORT || 5000;
const httpServer = http.createServer(app);

// Phase 26: Socket.io shares the same HTTP server as the REST API.
// The io instance is also attached to app via app.set('io', io) inside
// initializeSocket so REST routes can emit events into Socket rooms.
initializeSocket(httpServer, app);

// 🛡️ Phase-3 P1 fix: default to loopback (127.0.0.1) so a LAN peer cannot
// reach the beta directly on the user's residential IP and bypass ngrok's
// TLS termination. Set BIND_ADDRESS=0.0.0.0 explicitly when running behind
// a container / load-balancer that needs the external interface.
const BIND_ADDRESS = (process.env.BIND_ADDRESS || '127.0.0.1').trim();
const server = httpServer.listen(PORT, BIND_ADDRESS, () => {
  console.log(`🚀 Automated marketplace engine running on ${BIND_ADDRESS}:${PORT}`);
});

const startSettlementWorker = () => {
  const intervalMs = Number(process.env.SETTLEMENT_POLL_MS || 60000);
  console.log(`🧠 Settlement worker active. Polling every ${Math.round(intervalMs / 1000)}s.`);

  setInterval(async () => {
    // 🛡️ Roadmap §2.2: Distributed worker lease prevents 3x duplicate runs across pods
    const leaseSeconds = Math.max(5, Math.floor(intervalMs / 1000) - 2);
    if (!(await acquireWorkerLease('settlement', leaseSeconds))) return;

    try {
      const result = await settlePendingTranches();
      if (result?.settledTranches > 0) {
        console.log(`💸 Settlement worker released ${result.settledTranches} tranche(s) to withdrawable funds.`);
      }
    } catch (err) {
      console.error('⚠️ Settlement worker failed:', err.message);
    }
  }, intervalMs).unref();
};

const skipPreviewWorkers = allowPreviewIframe && process.env.SKIP_DB_IN_PREVIEW === 'true';

if (!skipPreviewWorkers) startSettlementWorker();

const startReconciliationWorker = () => {
  const intervalMs = Number(process.env.RECONCILIATION_POLL_MS || 10 * 60 * 1000);
  console.log(
    `🛡️ Anti-entropy reconciliation worker active. Polling every ${Math.round(intervalMs / 1000)}s.`
  );

  setInterval(async () => {
    // 🛡️ Roadmap §2.2: Distributed worker lease
    const leaseSeconds = Math.max(10, Math.floor(intervalMs / 1000) - 5);
    if (!(await acquireWorkerLease('reconciliation', leaseSeconds))) return;

    try {
      const summary = await runReconciliationCycle();
      if (summary.claimed > 0) {
        console.log(
          `🛡️ Reconciliation sweep: claimed=${summary.claimed} completed=${summary.completed} refunded=${summary.refunded} pending=${summary.pending} quarantined=${summary.quarantined}`
        );
      }
    } catch (err) {
      console.error('⚠️ Reconciliation worker failed:', err.message);
    }
  }, intervalMs).unref();
};

if (!skipPreviewWorkers) startReconciliationWorker();

// ─────────────────────────────────────────────
// Phase 28 — Ghost Contract Abandonment Sweeper
//
// Detects EscrowLedgers stuck in PENDING_FUNDING for > CONTRACT_ABANDONMENT_EXPIRY_MS
// (default 60 min) and rolls back the ghost contract atomically:
//   EscrowLedger → CANCELLED
//   Project      → OPEN  (re-enters bidding pool)
//   Bid          → WITHDRAWN (offer lapsed; contractor not penalised)
//   ContractorProfile.availability.currentProjects -= 1
//   AuditLog     → CONTRACT_EXPIRED_UNPAID
// ─────────────────────────────────────────────
const startAbandonmentWorker = () => {
  const intervalMs = Number(process.env.CONTRACT_ABANDONMENT_POLL_MS || 15 * 60 * 1000); // 15 min default
  console.log(
    `👻 Ghost-contract abandonment sweeper active. ` +
    `Polling every ${Math.round(intervalMs / 1000)}s ` +
    `(expiry window: ${Math.round(Number(process.env.CONTRACT_ABANDONMENT_EXPIRY_MS || 3600000) / 60000)}min).`
  );

  setInterval(async () => {
    // 🛡️ Roadmap §2.2: Distributed worker lease
    const leaseSeconds = Math.max(10, Math.floor(intervalMs / 1000) - 5);
    if (!(await acquireWorkerLease('abandonment', leaseSeconds))) return;

    try {
      const summary = await runAbandonmentSweep();
      if (summary.rolledBack > 0 || summary.errors > 0) {
        console.log(
          `👻 [Abandonment] sweep: scanned=${summary.scanned} ` +
          `rolledBack=${summary.rolledBack} skipped=${summary.skipped} errors=${summary.errors}`
        );
      }
    } catch (err) {
      console.error('⚠️ Abandonment sweeper failed:', err.message);
    }
  }, intervalMs).unref();
};

if (!skipPreviewWorkers) startAbandonmentWorker();

// ─────────────────────────────────────────────
// Capacity reconciler (audit G5): recomputes every contractor's concurrent-project count from the ledgers
// that are really still open. Heals counters that drifted before the lifecycle hook existed (contractors
// locked out of bidding after a few finished jobs) and any future miss. Idempotent; set
// CAPACITY_RECONCILE_MS=0 to disable.
// ─────────────────────────────────────────────
const startCapacityReconciler = () => {
  const intervalMs = Number(process.env.CAPACITY_RECONCILE_MS === undefined ? 24 * 60 * 60 * 1000 : process.env.CAPACITY_RECONCILE_MS);
  if (!intervalMs) return;
  const run = async () => {
    // 🛡️ Roadmap §2.2: Distributed worker lease
    const leaseSeconds = Math.max(30, Math.floor(intervalMs / 1000) - 5);
    if (!(await acquireWorkerLease('capacity', leaseSeconds))) return;

    try {
      const r = await reconcileCapacity();
      if (r.corrected > 0) console.log(`🔧 [Capacity] corrected ${r.corrected} of ${r.profiles} contractor slot counter(s).`);
    } catch (err) {
      console.error('⚠️ Capacity reconciler failed:', err.message);
    }
  };
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, intervalMs).unref();
};

if (!skipPreviewWorkers) startCapacityReconciler();

// ─────────────────────────────────────────────
// Milestone Stalling Escalator (Threat Model §4):
// Periodically checks funded/partially-disbursed escrows for milestones pending
// client review for ≥7 days without action, unlocking contractor dispute rights.
// ─────────────────────────────────────────────
const startMilestoneEscalationWorker = () => {
  const intervalMs = Number(process.env.MILESTONE_ESCALATION_POLL_MS || 60 * 60 * 1000);
  console.log(`⏱️ Milestone stalling escalation worker active. Polling every ${Math.round(intervalMs / 60000)}m.`);

  setInterval(async () => {
    const leaseSeconds = Math.max(30, Math.floor(intervalMs / 1000) - 10);
    if (!(await acquireWorkerLease('escalation', leaseSeconds))) return;

    try {
      const summary = await escalateStalledMilestones();
      if (summary.escalated > 0) {
        console.log(`⚖️ [MilestoneEscalation] Escalate sweep: scanned=${summary.scanned} escalated=${summary.escalated}`);
      }
    } catch (err) {
      console.error('⚠️ Milestone escalation worker failed:', err.message);
    }
  }, intervalMs).unref();
};

if (!skipPreviewWorkers) startMilestoneEscalationWorker();

// ─────────────────────────────────────────────
// 🔄 KUBERNETES-GRADE GRACEFUL SHUTDOWN
//
// Sequence on SIGTERM / SIGINT:
//   1. Set isShuttingDown = true  → liveness/readiness probes return 503
//      (Kubernetes removes the pod from LB before we stop accepting connections)
//   2. server.close()             → stop accepting NEW connections
//   3. closeRedis()               → drain Redis connection pool
//   4. mongoose.connection.close()→ drain MongoDB connection pool
//   5. process.exit(exitCode)     → 0 after SIGTERM/SIGINT, 1 after a crash, so a host
//                                   (Render, Docker restart policies, CI) sees the failure
// ─────────────────────────────────────────────
let isShuttingDown = false;

const initiateGracefulShutdown = async (signal, exitCode = 0) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n🛑 ${signal} received. Executing safe systems shutdown sequence...`);

  // Hard-kill watchdog: prevent hanging shutdown from blocking Kubernetes termination
  const forcedKillTimeout = setTimeout(() => {
    console.error('⚠️ Graceful shutdown timed out after 15s. Forcing process exit.');
    process.exit(1);
  }, 15000);
  forcedKillTimeout.unref();

  // 1a. 🛡️ Phase-3 P1 fix: close Socket.io first so open WebSockets receive
  // a proper disconnect and the client triggers its reconnect flow, instead
  // of hanging until the 15 s force-kill watchdog fires.
  try {
    const io = app.get('io');
    if (io && typeof io.close === 'function') {
      await new Promise((resolve) => io.close(resolve));
      console.log('🔌 Socket.io gateway closed.');
    }
  } catch (ioErr) {
    console.error(`⚠️ Socket.io close error: ${ioErr.message}`);
  }

  // 1b. Stop accepting new HTTP connections
  server.close(async () => {
    console.log('🏁 Express server instances terminated safely.');

    try {
      // 2. Drain Redis pool
      await closeRedis();
    } catch (redisErr) {
      console.error(`⚠️ Redis drain error: ${redisErr.message}`);
    }

    try {
      // 3. Drain MongoDB pool
      await mongoose.connection.close(false);
      console.log(`🗄️ MongoDB connection pool drained cleanly. Process exiting with code ${exitCode}.`);
      process.exit(exitCode);
    } catch (err) {
      console.error(`💥 Error during MongoDB disconnect: ${err.message}`);
      process.exit(1);
    }
  });
};

process.on('SIGTERM', () => initiateGracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => initiateGracefulShutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  console.error(`💥 Unhandled Promise Rejection: ${err && err.message ? err.message : err}`);
  initiateGracefulShutdown('UNHANDLED_REJECTION', 1);
});
process.on('uncaughtException', (err) => {
  console.error(`💥 Uncaught System Exception: ${err.message}`);
  initiateGracefulShutdown('UNCAUGHT_EXCEPTION', 1);
});

module.exports = { app, server };
