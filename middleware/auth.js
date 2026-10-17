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

module.exports = { verifyToken, requireRole };
