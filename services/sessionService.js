// services/sessionService.js
// One session model shared by HTTP (middleware/auth.js) and Socket.io.
//
// Browsers authenticate with an httpOnly cookie, so page JavaScript (and any
// XSS payload) can never read the token. API clients and tests may still send
// `Authorization: Bearer <jwt>`. Every token carries the user's sessionVersion
// ("sv"); logout increments it, revoking ALL outstanding tokens for that user
// immediately rather than waiting up to 7 days for expiry.
'use strict';

const jwt = require('jsonwebtoken');
const User = require('../models/User');

const SESSION_COOKIE = 'bb_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function operational(message, statusCode) {
  return Object.assign(new Error(message), { statusCode, isOperational: true });
}

function cookieOptions() {
  return {
    httpOnly: true,
    // Behind ngrok/a load balancer `trust proxy` makes the request secure;
    // locally over plain http the cookie must not be Secure or it is dropped.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000
  };
}

/** Signs a session for `user`, sets the cookie, and returns the token. */
function issueSession(res, user) {
  const token = jwt.sign(
    { userId: String(user._id), role: user.role, sv: user.sessionVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: SESSION_TTL_SECONDS }
  );
  res.cookie(SESSION_COOKIE, token, cookieOptions());
  return token;
}

function clearSession(res) {
  const { maxAge, ...opts } = cookieOptions();
  res.clearCookie(SESSION_COOKIE, opts);
}

/** Minimal RFC 6265 cookie-header lookup (avoids a cookie-parser dependency). */
function readCookie(cookieHeader, name) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch (_) { return null; }
    }
  }
  return null;
}

/**
 * Extracts the token from a request-like object. Returns { token, via } where
 * via is 'bearer' | 'cookie' | null.
 */
function extractToken(headers) {
  const authz = headers && headers.authorization;
  if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
    return { token: authz.slice(7).trim(), via: 'bearer' };
  }
  const fromCookie = readCookie(headers && headers.cookie, SESSION_COOKIE);
  if (fromCookie) return { token: fromCookie, via: 'cookie' };
  return { token: null, via: null };
}

/** Verifies a token and the live account state. Throws operational 401/403. */
async function resolveSession(token) {
  if (!token) throw operational('Authentication token missing.', 401);
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    throw operational(err.name === 'TokenExpiredError'
      ? 'Your session has expired. Please log in again.'
      : 'Invalid authentication signature.', 401);
  }
  const user = await User.findById(decoded.userId).select('status role sessionVersion').lean();
  if (!user || user.status !== 'ACTIVE') {
    throw operational('Access Denied: This account is suspended or unverified.', 403);
  }
  if ((decoded.sv || 0) !== (user.sessionVersion || 0)) {
    throw operational('Your session was signed out. Please log in again.', 401);
  }
  return { userId: String(user._id), role: user.role };
}

/** Revokes every outstanding session for a user (logout, password-equivalent reset). */
async function revokeAllSessions(userId) {
  await User.updateOne({ _id: userId }, { $inc: { sessionVersion: 1 } });
}

module.exports = {
  SESSION_COOKIE,
  issueSession,
  clearSession,
  extractToken,
  resolveSession,
  revokeAllSessions,
  readCookie
};
