// middleware/auth.js
const catchAsync = require('../utils/catchAsync');
const { extractToken, resolveSession } = require('../services/sessionService');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// 🛡️ SINGLE SOURCE OF TRUTH — Sync Guide fix (2026-10-21).
// Previously this exact rule was copy-pasted in BOTH verifyToken and
// allowScopedProjectToken below. A new money-moving route added to only
// one of the two copies would have silently stayed reachable by a
// delegated share token. Both functions now call isFinancialPath(req)
// instead of maintaining their own list.
//
// Invariant: Scoped delegation tokens (FAMILY_VIEWER, SITE_WATCHER) must NEVER be
// capable of mutating money, approving milestones, funding escrow, withdrawing,
// executing refunds, or creating contracts.
const FINANCIAL_PATH_RULES = [
  (p) => p.startsWith('/api/payment'),
  (p) => p.startsWith('/api/finance'),
  (p) => p.startsWith('/api/contracts'),
  (p) => p.startsWith('/api/settlement'),
  (p) => p.startsWith('/api/admin'),
  (p) => p.includes('/approve'),
  (p) => p.includes('/reject'),
  (p) => p.includes('/accept'),
  (p) => p.includes('/arbitrate'),
  (p) => p.includes('/dispute'),
  (p) => p.includes('/resolve-dispute'),
  (p) => p.includes('/fund-escrow'),
  (p) => p.includes('/confirm-delivery'),
  (p) => p.includes('/disburse'),
  (p) => p.includes('/withdraw'),
  (p) => p.includes('/refund'),
  (p) => p.includes('/subscribe'),
  (p) => p.includes('/dispatch'),
];

function isFinancialPath(req) {
  const fullPath = (req.baseUrl || '') + (req.path || '');
  return FINANCIAL_PATH_RULES.some((rule) => rule(fullPath));
}

// Scoped Delegation Tokens Explicit Allow-list:
// Scoped tokens (FAMILY_VIEWER, SITE_WATCHER) are ONLY permitted on read-only
// project/material endpoints, plus SITE_WATCHER delivery logging.
const SHARE_TOKEN_ALLOWED_PATTERNS = [
  /^\/api\/projects\/shared\/[^/]+$/,
  /^\/api\/projects\/[^/]+$/,
  /^\/api\/projects\/[^/]+\/materials/,
  /^\/api\/projects\/[^/]+\/materials\/proof\/[a-f0-9]+/,
  /^\/api\/materials\/orders\/project\/[^/]+\/ledger$/,
  /^\/api\/governance\/escrow\/[^/]+$/,
  /^\/api\/governance\/audit-trail\/[^/]+$/,
];

const SHARE_TOKEN_WRITE_PATTERNS = [
  /^\/api\/projects\/[^/]+\/materials\/deliveries$/,
];

function isShareTokenAllowed(req, scopedRole) {
  if (isFinancialPath(req)) return false;
  const fullPath = (req.baseUrl || '') + (req.path || '');
  if (SAFE_METHODS.has(req.method)) {
    return SHARE_TOKEN_ALLOWED_PATTERNS.some((pattern) => pattern.test(fullPath));
  }
  if (req.method === 'POST' && scopedRole === 'SITE_WATCHER') {
    return SHARE_TOKEN_WRITE_PATTERNS.some((pattern) => pattern.test(fullPath));
  }
  return false;
}

// 🛡️ Token & DB state verification. Accepts the httpOnly session cookie
// (browsers) or `Authorization: Bearer` (API clients, tests).
//
// CSRF: a cookie is sent automatically by the browser, so a state-changing
// request authenticated ONLY by the cookie must also carry the
// `X-Requested-With` header. Cross-site pages cannot add custom headers
// without a CORS preflight, which our CORS policy refuses — so a forged
// form/POST from another site never passes. Bearer requests are exempt:
// a token in a header can't be sent ambiently by a browser.
const verifyToken = catchAsync(async (req, res, next) => {
  const { token, via } = extractToken(req.headers);
  const shareHeader = req.headers['x-project-share-token'];
  const isShareToken = (token && token.startsWith('share:')) || Boolean(shareHeader);

  if (isShareToken) {
    const rawToken = shareHeader || token.slice(6);
    if (isFinancialPath(req)) {
      return next(Object.assign(new Error('Forbidden: Delegated share tokens are not authorized to perform financial transactions or milestone approvals.'), { statusCode: 403, isOperational: true }));
    }

    const crypto = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const ProjectShareToken = require('../models/ProjectShareToken');
    const share = await ProjectShareToken.findOne({
      tokenHash,
      isRevoked: false,
      expiresAt: { $gt: new Date() }
    }).lean();

    if (!share) {
      return next(Object.assign(new Error('Invalid, expired, or revoked delegation share token.'), { statusCode: 401, isOperational: true }));
    }

    if (!isShareTokenAllowed(req, share.scopedRole)) {
      return next(Object.assign(new Error('Forbidden: Delegated share token is not permitted to access this endpoint or perform this action.'), { statusCode: 403, isOperational: true }));
    }

    req.share = share;
    req.user = {
      userId: String(share.clientUserId),
      role: share.scopedRole,
      isDelegate: true,
      delegateName: share.delegateName,
      projectId: String(share.projectId),
      hideFinancials: share.hideFinancials
    };
    return next();
  }

  if (!token) {
    return next(Object.assign(new Error('Authentication token missing.'), { statusCode: 401, isOperational: true }));
  }
  if (via === 'cookie' && !SAFE_METHODS.has(req.method) && !req.headers['x-requested-with']) {
    return next(Object.assign(new Error('Missing X-Requested-With header on a cookie-authenticated request.'), { statusCode: 403, isOperational: true }));
  }
  try {
    req.user = await resolveSession(token);
  } catch (err) {
    return next(err);
  }
  next();
});

// 🛡️ Optional Authentication: populates req.user if session is valid,
// but allows unauthenticated public requests to pass through with req.user = null.
const optionalAuth = catchAsync(async (req, res, next) => {
  const { token } = extractToken(req.headers);
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    req.user = await resolveSession(token);
  } catch {
    req.user = null;
  }
  next();
});

// 🛡️ ROLE-BASED ACCESS CONTROL (RBAC) GATE
const requireRole = (roles) => {
  const gate = (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(Object.assign(new Error(`Unauthorized Access. Required system clearance: ${roles.join(' or ')}`), { statusCode: 403, isOperational: true }));
    }
    next();
  };
  // Lets scripts/qa/route-policy.js recognise role gates by inspection.
  gate.requiredRoles = roles.slice();
  return gate;
};

// 🛡️ Scoped Role or Delegation Clearance Gate (Phase 3)
const allowRoleOrScopedToken = (userRoles, delegateRoles = []) => {
  const allowed = [...userRoles, ...delegateRoles];
  const gate = (req, res, next) => {
    if (!req.user || !allowed.includes(req.user.role)) {
      return next(Object.assign(new Error(`Unauthorized Access. Required clearance: ${allowed.join(' or ')}`), { statusCode: 403, isOperational: true }));
    }
    const targetProjectId = req.params.id || req.params.projectId;
    if (req.user.isDelegate && targetProjectId && req.user.projectId !== String(targetProjectId)) {
      return next(Object.assign(new Error('Delegation token not authorized for this project.'), { statusCode: 403, isOperational: true }));
    }
    next();
  };
  gate.requiredRoles = allowed.slice();
  return gate;
};

// 🛡️ Scoped Project Delegation Token Middleware (Phase 2)
// Invariant: Scoped tokens are strictly forbidden from any money, milestone approval, or payout endpoints.
const allowScopedProjectToken = catchAsync(async (req, res, next) => {
  const shareHeader = req.headers['x-project-share-token'];
  const authHeader = req.headers.authorization;
  const rawToken = shareHeader || (authHeader && authHeader.startsWith('Bearer share:') ? authHeader.slice(13) : null);

  if (!rawToken) {
    return next();
  }

  // Reject financial endpoints immediately via centralized security boundary
  if (isFinancialPath(req)) {
    return next(Object.assign(new Error('Forbidden: Delegated share tokens are not authorized to perform financial transactions or milestone approvals.'), { statusCode: 403, isOperational: true }));
  }

  const crypto = require('crypto');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const ProjectShareToken = require('../models/ProjectShareToken');
  const share = await ProjectShareToken.findOne({
    tokenHash,
    isRevoked: false,
    expiresAt: { $gt: new Date() }
  }).lean();

  if (!share) {
    return next(Object.assign(new Error('Invalid, expired, or revoked delegation share token.'), { statusCode: 401, isOperational: true }));
  }

  req.share = share;
  req.user = {
    userId: String(share.clientUserId),
    role: share.scopedRole,
    isDelegate: true,
    delegateName: share.delegateName,
    projectId: String(share.projectId),
    hideFinancials: share.hideFinancials
  };

  next();
});

module.exports = {
  verifyToken,
  optionalAuth,
  requireRole,
  allowRoleOrScopedToken,
  allowScopedProjectToken,
  isFinancialPath,
  isShareTokenAllowed,
  FINANCIAL_PATH_RULES,
  SHARE_TOKEN_ALLOWED_PATTERNS
};
