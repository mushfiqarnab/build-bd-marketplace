// middleware/auth.js
const catchAsync = require('../utils/catchAsync');
const { extractToken, resolveSession } = require('../services/sessionService');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
    const fullPath = (req.baseUrl || '') + (req.path || '');
    const isFinancial = 
      fullPath.startsWith('/api/payment') ||
      fullPath.startsWith('/api/finance') ||
      fullPath.startsWith('/api/contracts') ||
      fullPath.startsWith('/api/settlement') ||
      fullPath.includes('/approve') ||
      fullPath.includes('/reject') ||
      fullPath.includes('/accept') ||
      fullPath.includes('/arbitrate') ||
      fullPath.includes('/dispute') ||
      fullPath.includes('/fund-escrow') ||
      fullPath.includes('/confirm-delivery') ||
      fullPath.includes('/disburse') ||
      fullPath.includes('/withdraw');

    if (isFinancial) {
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

// 🛡️ Scoped Project Delegation Token Middleware (Phase 2)
// Invariant: Scoped tokens are strictly forbidden from any money, milestone approval, or payout endpoints.
const allowScopedProjectToken = catchAsync(async (req, res, next) => {
  const shareHeader = req.headers['x-project-share-token'];
  const authHeader = req.headers.authorization;
  const rawToken = shareHeader || (authHeader && authHeader.startsWith('Bearer share:') ? authHeader.slice(13) : null);

  if (!rawToken) {
    return next();
  }

  // Reject financial endpoints immediately
  const fullPath = (req.baseUrl || '') + (req.path || '');
  const isFinancialEndpoint = 
    fullPath.startsWith('/api/payment') ||
    fullPath.startsWith('/api/finance') ||
    fullPath.startsWith('/api/contracts') ||
    fullPath.startsWith('/api/settlement') ||
    fullPath.includes('/approve') ||
    fullPath.includes('/reject') ||
    fullPath.includes('/accept') ||
    fullPath.includes('/arbitrate') ||
    fullPath.includes('/dispute') ||
    fullPath.includes('/fund-escrow') ||
    fullPath.includes('/confirm-delivery') ||
    fullPath.includes('/disburse') ||
    fullPath.includes('/withdraw');

  if (isFinancialEndpoint) {
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

module.exports = { verifyToken, requireRole, allowScopedProjectToken };
