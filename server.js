// server.js
const dns = require('dns');

// 🌐 Resiliency layer bypassing local ISP SRV lookup failures
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
  console.log('🌐 Forced public DNS override active (8.8.8.8, 1.1.1.1)');
} catch (err) {
  console.error('⚠️ DNS override failed initialization:', err.message);
}

const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const compression = require('compression'); 
const hpp = require('hpp');                 
const escrowRouter = require('./routes/escrow');
const paymentRouter = require('./routes/payment');
const governanceRouter = require('./routes/governance');
const financeRouter = require('./routes/finance');
const contractorProfileRouter = require('./routes/contractorProfile');
const { settlePendingTranches } = require('./services/settlementService');
const { runReconciliationCycle } = require('./services/reconciliationService');

dotenv.config();

// 🛡️ ERADICATE DEPRECATION NOISE


const app = express();

// 🛡️ CRITICAL DEPLOYMENT FIX: Tells Express to trust the Load Balancer / Cloudflare IP
app.set('trust proxy', 1);

// 🛡️ FINANCIAL SECURITY LAYER
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100, 
  message: { status: 'error', message: 'Too many requests from this IP. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// 🚀 ENTERPRISE MIDDLEWARE PIPELINE
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', optionsSuccessStatus: 200 }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' })); // 🛡️ CRITICAL: Parses SSLCommerz form-encoded IPN webhooks & redirects
app.use(hpp()); 
app.use(compression()); 

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

// 🗺️ ROUTING PIPELINE
app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/project'));
app.use('/api/bids', require('./routes/bid'));
app.use('/api/contractor-profile', contractorProfileRouter);
app.use('/api/escrow', escrowRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/governance', governanceRouter);
app.use('/api/finance', financeRouter);

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

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
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

// 🔄 GRADUAL CLEANUP LIFECYCLE FUNCTION
let isShuttingDown = false; 

const initiateGracefulShutdown = async (signal) => {
  if (isShuttingDown) return; 
  isShuttingDown = true;
  
  console.log(`\n🛑 ${signal} received. Executing safe systems shutdown sequence...`);
  
  server.close(async () => {
    console.log('🏁 Express server instances terminated safely.');
    try {
      await mongoose.connection.close(false);
      console.log('🗄️ MongoDB connection pool drained cleanly. Process exiting.');
      process.exit(0);
    } catch (err) {
      console.error(`💥 Error during MongoDB disconnect: ${err.message}`);
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.error('⚠️ Graceful shutdown timed out. Forcing process exit.');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => initiateGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => initiateGracefulShutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  console.error(`💥 Unhandled Promise Rejection: ${err.message}`);
  initiateGracefulShutdown('UNHANDLED_REJECTION');
});
process.on('uncaughtException', (err) => {
  console.error(`💥 Uncaught System Exception: ${err.message}`);
  initiateGracefulShutdown('UNCAUGHT_EXCEPTION');
});