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

module.exports = logger;
