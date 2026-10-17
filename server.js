// server.js
// Load .env FIRST: modules required below (e.g. services/redisClient.js) read process.env
// when they are loaded, so a later dotenv.config() would be too late for them.
require('dotenv').config();
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
const helmet      = require('helmet');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const compression = require('compression');
const hpp         = require('hpp');
const morgan      = require('morgan');
const logger      = require('./utils/logger'); // Phase 30: Structured Observability Logger
const { apiLimiter, strictAuthAndBidLimiter } = require('./middleware/rateLimiter');
const paymentRouter = require('./routes/payment');
const governanceRouter = require('./routes/governance');
const financeRouter = require('./routes/finance');
const contractorProfileRouter = require('./routes/contractorProfile');
const { initializeSocket }           = require('./services/socketService');
const { settlePendingTranches }      = require('./services/settlementService');
const { runReconciliationCycle }     = require('./services/reconciliationService');
const { runAbandonmentSweep }        = require('./services/abandonmentService');  // Phase 28
const { isRedisReady, closeRedis, getRedisTelemetry } = require('./services/redisClient');

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
  const redisTelemetry = await getRedisTelemetry().catch(() => ({ connected: false }));
  res.status(200).json({
    status: 'ready',
    checks: {
      mongodb: 'connected',
      redis: redisReady ? 'ready' : 'degraded (MongoDB fallback active)'
    },
    redisTelemetry,
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🛡️ PHASE 29: DISTRIBUTED ANTI-FRAUD PERIMETER
// ─────────────────────────────────────────────────────────────────────────────

// TIER 1 — API gateway limiter (middleware/rateLimiter.js): 120 requests per minute per IPv6 /56
// subnet, on /api only. The old global 100-per-15-min limiter on EVERY request was removed: it
// counted static files and health checks, so a host's health checker or many mobile users behind
// one carrier-grade-NAT address would be locked out within minutes.
app.use('/api', apiLimiter);

// TIER 2 — Financial endpoint limiter
// Applied explicitly to /api/contracts and /api/payment to add a second,
// tighter throttle on top of the global one. Prevents connection-pool
// exhaustion from targeted escrow flooding (10 req / 10 min).
const financialLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: {
    status: 'error',
    message: 'Financial rate limit exceeded. Maximum 10 contract/payment operations per 10 minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// 🚀 ENTERPRISE MIDDLEWARE PIPELINE
// Helmet with a CSP that explicitly permits the CDN origins used by
// public/index.html (Tailwind CDN, Google Fonts). A blanket strict-mode
// CSP would block the frontend from loading entirely.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
      styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:     ["'self'", "https://fonts.gstatic.com"],
      imgSrc:      ["'self'", "data:", "blob:"],
      connectSrc:  ["'self'"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
    }
  },
  // HSTS: 1 year, include subdomains, allow preload registration
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  // Clickjacking protection
  frameguard: { action: 'deny' }
}));

app.use(cors({ origin: process.env.CORS_ORIGIN || '*', optionsSuccessStatus: 200 }));

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

app.use(express.static(path.join(__dirname, 'public'))); // 🌐 Portal, PWA manifest, service worker

// NoSQL-injection guard (Express 5-safe): see middleware/sanitize.js
app.use(require('./middleware/sanitize'));

// 🗄️ DATABASE CONNECTION & HEARTBEAT MONITORING
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10000,
  autoIndex: process.env.NODE_ENV !== 'production'
})
.then(() => console.log('✅ Connected securely to MongoDB Atlas!'))
.catch((err) => {
  console.error('❌ Fatal Initial Database connection failure:', err.message);
  process.exit(1);
});

mongoose.connection.on('disconnected', () => console.warn('⚠️ MongoDB connection lost. Attempting to reconnect...'));
mongoose.connection.on('reconnected', () => console.log('🔄 MongoDB connection restored.'));

// 🌐 Environment probe — public, unauthenticated, cheap. Lets the client know whether
//    to render dev-only UI and what storage mode is live. Never exposes credentials.
app.get('/api/environment', (req, res) => {
  const { storageConfig } = require('./services/s3Service');
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
      version: require('./package.json').version
    }
  });
});

// 🗺️ ROUTING PIPELINE
app.use('/api/auth',               strictAuthAndBidLimiter, require('./routes/auth'));
app.use('/api/projects',           require('./routes/project'));
app.use('/api/bids',               strictAuthAndBidLimiter, require('./routes/bid'));
// Phase 29: financialLimiter (10 req/10min) applied as a second throttle layer
// on top of the global 100/15min limiter for all money-touching endpoints.
app.use('/api/contracts',          financialLimiter, require('./routes/contract'));
app.use('/api/contractor-profile', contractorProfileRouter);

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
  app.use('/api/payment',          financialLimiter, paymentRouter);
}
app.use('/api/governance',         governanceRouter);
app.use('/api/finance',            financeRouter);
app.use('/api/settlement',         require('./routes/settlement'));
app.use('/api/moderation',         require('./routes/arbitration'));
app.use('/api/chat',               require('./routes/chat'));
app.use('/api/reviews',            require('./routes/review'));

// 🛑 GLOBAL ENTERPRISE ERROR ISOLATION & PARSING LAYER
app.use((err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message;

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

const server = httpServer.listen(PORT, () => {
  console.log(`🚀 Automated marketplace engine running on port ${PORT}`);
});

const startSettlementWorker = () => {
  const intervalMs = Number(process.env.SETTLEMENT_POLL_MS || 60000);
  console.log(`🧠 Settlement worker active. Polling every ${Math.round(intervalMs / 1000)}s.`);

  setInterval(async () => {
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

startSettlementWorker();

const startReconciliationWorker = () => {
  const intervalMs = Number(process.env.RECONCILIATION_POLL_MS || 10 * 60 * 1000);
  console.log(
    `🛡️ Anti-entropy reconciliation worker active. Polling every ${Math.round(intervalMs / 1000)}s.`
  );

  setInterval(async () => {
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

startReconciliationWorker();

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

startAbandonmentWorker();

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

  // 1. Stop accepting new HTTP connections
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
