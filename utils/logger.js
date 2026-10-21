// utils/logger.js
// Phase 30 — Structured Observability Logger
//
// Architecture decisions:
//
// [1] stdout-only in production — no file transports.
//     This app runs in a Docker container (Dockerfile already exists).
//     The 12-factor app methodology mandates treating logs as event streams
//     written to stdout. The container runtime (Docker, K8s) captures stdout
//     and routes it to whatever aggregator you configure (Datadog, CloudWatch,
//     GCP Logging, ELK). Writing to log files inside a container means:
//       - Logs are lost when the container restarts
//       - You need a persistent volume for something that has no transactional value
//       - Log rotation must be managed inside the container
//     If you want file logging locally during development, set LOG_FILE=true
//     in your .env and files will appear in ./logs/. They are gitignored.
//
// [2] JSON format in production, human-readable in development.
//     The LOG_PRETTY=true env var switches to colorized printf format for
//     local terminal use. Production always emits JSON for log aggregators.
//
// [3] Log level governed by LOG_LEVEL env var (default: 'info').
//     Set LOG_LEVEL=debug in development for verbose output.
//     Set LOG_LEVEL=warn in production to reduce noise volume and cost.

'use strict';

const winston = require('winston');
const path    = require('path');

const { combine, timestamp, json, printf, colorize, errors } = winston.format;

// ─────────────────────────────────────────────
// Configuration from environment
// ─────────────────────────────────────────────
const LOG_LEVEL  = process.env.LOG_LEVEL  || 'info';
const LOG_PRETTY = process.env.LOG_PRETTY === 'true' || process.env.NODE_ENV !== 'production';
const LOG_FILE   = process.env.LOG_FILE   === 'true';

// ─────────────────────────────────────────────
// Human-readable format for local development
// ─────────────────────────────────────────────
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ timestamp: ts, level, message, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? ` ${JSON.stringify(meta)}`
      : '';
    return `${ts} ${level}: ${message}${stack ? `\n${stack}` : ''}${metaStr}`;
  })
);

// ─────────────────────────────────────────────
// Structured JSON format for production aggregators
// (Datadog, CloudWatch, GCP Logging, ELK)
// ─────────────────────────────────────────────
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

// ─────────────────────────────────────────────
// Transports
// ─────────────────────────────────────────────
const transports = [
  // Stdout — always present. This is the canonical log stream in a container.
  new winston.transports.Console({
    format: LOG_PRETTY ? devFormat : prodFormat
  })
];

// Optional file transports — development aid only, never in production containers.
// Enable with LOG_FILE=true in .env.
if (LOG_FILE) {
  const logsDir = path.join(process.cwd(), 'logs');
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level:    'error',
      format:   prodFormat
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format:   prodFormat
    })
  );
  console.log(`📁 File logging enabled → ./logs/ (LOG_FILE=true)`);
}

/**
 * Factory for creating an HTTP log drain transport (Roadmap §16.4 / §18 Item 10).
 * Streams structured JSON logs directly to a queryable remote aggregator
 * (Axiom, Datadog, CloudWatch, BetterStack, Logstash, or custom ingest endpoint).
 *
 * @param {object} options
 * @param {string} options.url - Full HTTP/HTTPS ingest URL
 * @param {string} [options.token] - Optional Bearer token
 * @param {object} [options.headers] - Additional HTTP headers
 * @param {boolean} [options.batch] - Whether to buffer and batch logs
 * @param {number} [options.batchInterval] - Flush interval in ms when batched
 * @param {number} [options.batchCount] - Max log count before flushing batch
 * @param {string} [options.level] - Transport log level
 * @returns {winston.transports.Http}
 */
function buildHttpDrainTransport({
  url,
  token,
  headers = {},
  batch = false,
  batchInterval = 2000,
  batchCount = 10,
  level = LOG_LEVEL
} = {}) {
  if (!url || typeof url !== 'string') {
    throw new Error('Valid URL string is required for HTTP log drain transport.');
  }

  const drainUrl = new URL(url);
  const drainHeaders = { ...headers };
  if (token) {
    drainHeaders['Authorization'] = `Bearer ${token}`;
  }

  const transport = new winston.transports.Http({
    host: drainUrl.hostname,
    port: drainUrl.port ? Number(drainUrl.port) : (drainUrl.protocol === 'https:' ? 443 : 80),
    path: (drainUrl.pathname || '/') + (drainUrl.search || ''),
    ssl: drainUrl.protocol === 'https:',
    auth: (drainUrl.username && drainUrl.password)
      ? { username: drainUrl.username, password: drainUrl.password }
      : undefined,
    headers: drainHeaders,
    batch: Boolean(batch),
    batchInterval: Number(batchInterval) || 2000,
    batchCount: Number(batchCount) || 10,
    level,
    format: prodFormat
  });

  transport.on('error', (err) => {
    // Fail-open: prevent network unreachability of remote log drain from crashing the application
    if (process.env.NODE_ENV !== 'production' && !process.env.SUPPRESS_LOG_DRAIN_WARN) {
      console.warn(`⚠️ [Logger:HttpDrain] Ingest dispatch failed: ${err.message}`);
    }
  });

  return transport;
}

// Optional remote HTTP log drain (Roadmap §16.4 / §18 Item 10)
// Enable by setting LOG_HTTP_URL in environment (e.g. https://logs.axiom.co/v1/datasets/buildbd/ingest)
const LOG_HTTP_URL = process.env.LOG_HTTP_URL;
if (LOG_HTTP_URL) {
  try {
    let customHeaders = {};
    if (process.env.LOG_HTTP_HEADERS) {
      try {
        customHeaders = JSON.parse(process.env.LOG_HTTP_HEADERS);
      } catch (_) { /* ignore malformed custom headers */ }
    }

    const drain = buildHttpDrainTransport({
      url: LOG_HTTP_URL,
      token: process.env.LOG_HTTP_TOKEN,
      headers: customHeaders,
      batch: process.env.LOG_HTTP_BATCH === 'true',
      batchInterval: Number(process.env.LOG_HTTP_BATCH_INTERVAL) || 2000,
      batchCount: Number(process.env.LOG_HTTP_BATCH_COUNT) || 10,
      level: process.env.LOG_HTTP_LEVEL || LOG_LEVEL
    });

    transports.push(drain);
    console.log(`📡 Remote HTTP log drain active → ${LOG_HTTP_URL}`);
  } catch (err) {
    console.warn(`⚠️ [Logger:HttpDrain] Failed to initialize drain: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// Logger instance
// ─────────────────────────────────────────────
const logger = winston.createLogger({
  level:            LOG_LEVEL,
  defaultMeta:      { service: 'buildbd-api' },
  transports,
  // Prevents winston from exiting on uncaughtException — that's handled
  // by the graceful shutdown handler in server.js.
  exitOnError: false
});

// ─────────────────────────────────────────────
// Morgan stream adapter
// Pipes morgan HTTP request logs through winston at 'http' level.
// Morgan format: ':method :url :status :res[content-length] - :response-time ms'
// ─────────────────────────────────────────────
logger.stream = {
  write(message) {
    // morgan appends a newline; trim it before passing to winston
    logger.http(message.trimEnd());
  }
};

// ─────────────────────────────────────────────
// Observability Drain Helpers (Roadmap §16.4 / §18 Item 10)
// ─────────────────────────────────────────────
logger.buildHttpDrainTransport = buildHttpDrainTransport;
logger.addHttpDrain = function (opts) {
  const drain = buildHttpDrainTransport(opts);
  logger.add(drain);
  return drain;
};

module.exports = logger;
