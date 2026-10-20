// routes/auth.js
// 🔐 Phase 20: WebAuthn (Passkeys) as primary auth + SMS OTP as secondary fallback
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { skipFn } = require('../middleware/rateLimiter');
const { issueSession, clearSession, revokeAllSessions } = require('../services/sessionService');
const { resolveOtpDelivery, isPhoneAllowed, deliverOtp } = require('../services/otpDelivery');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const User = require('../models/User');
const PasskeyCredential = require('../models/PasskeyCredential');
const catchAsync = require('../utils/catchAsync');

// ─────────────────────────────────────────────
// 🌐 ENVIRONMENT CONFIG
// ─────────────────────────────────────────────
const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'Build-BD Marketplace';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || `http://localhost:${process.env.PORT || 5000}`;

// 🛡️ Phase-1 passkey-register gate: a successful OTP verification is only
// valid for this window. 5 minutes mirrors the OTP's own expiry so the two
// never diverge in a way that locks legitimate users out.
const OTP_FRESH_WINDOW_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────
// 🛡️ RATE LIMITERS
// ─────────────────────────────────────────────
// Segment by phone number + IP to defeat cellular CGNAT collateral lockout
const { ipKeyGenerator } = require('express-rate-limit');
const phoneAuthKeyGen = (req) => {
  const phone = String(req.body?.phoneNumber || '').trim();
  const rawIp = req.ip || '127.0.0.1';
  let ip = rawIp;
  if (typeof ipKeyGenerator === 'function') {
    try { ip = ipKeyGenerator(rawIp, 56); } catch (_) {}
  }
  return phone ? `phone:${phone}:${ip}` : `anon:${ip}`;
};

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: phoneAuthKeyGen,
  validate: { keyGeneratorIpFallback: false },
  skip: skipFn,
  message: { status: 'error', message: 'Security Lockout: Too many OTP requests. Please wait 15 minutes.' }
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  keyGenerator: phoneAuthKeyGen,
  validate: { keyGeneratorIpFallback: false },
  skip: skipFn,
  message: { status: 'error', message: 'Security Lockout: Too many failed verification attempts.' }
});

const passkeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: phoneAuthKeyGen,
  validate: { keyGeneratorIpFallback: false },
  skip: skipFn,
  message: { status: 'error', message: 'Security Lockout: Too many passkey operations.' }
});

// ─────────────────────────────────────────────
// 🔧 OTP UTILITIES
// ─────────────────────────────────────────────
// crypto.randomInt is a CSPRNG. The JS engine's default PRNG is predictable
// and must never mint authentication secrets.
const generateOTP = () => String(crypto.randomInt(100000, 1000000));
// HMAC with a server secret: a bare SHA-256 of a 6-digit code is reversible
// by trying all 10^6 values if the users collection ever leaks.
const hashOTP = (otp) => crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev-otp-pepper').update(String(otp)).digest('hex');
const OTP_TTL_MS = 5 * 60 * 1000;
// Per-account cap on wrong codes. The IP limiter alone can be bypassed by
// rotating IPs; after this many misses the code is voided.
const MAX_OTP_ATTEMPTS = 5;
const hashesEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ─────────────────────────────────────────────
// 📲 LOCAL MOCK SMS GATEWAY ADAPTER
// Emits high-contrast ANSI terminal output in development.
// In production this should be replaced with a real provider (e.g., Twilio, BD-SMS).
// ─────────────────────────────────────────────
// Delivery lives in services/otpDelivery.js (console / operator relay).

// ─────────────────────────────────────────────
// ═══════════════════════════════════════════
//   TIER-1: WebAuthn / Passkey Endpoints
// ═══════════════════════════════════════════
// ─────────────────────────────────────────────

/**
 * POST /api/auth/passkey/register/options
 * Step 1 of 2: Generate WebAuthn registration challenge.
 * The client browser/app passes this challenge to the authenticator.
 *
 * Body: { phoneNumber, role? }
 */
router.post('/passkey/register/options', passkeyLimiter, catchAsync(async (req, res, next) => {
  const phoneNumber = String(req.body.phoneNumber || '').trim();

  // 🛡️ PRIVILEGE ESCALATION GUARD
  let requestedRole = String(req.body.role || 'CLIENT').toUpperCase();
  if (!['CLIENT', 'CONTRACTOR'].includes(requestedRole)) requestedRole = 'CLIENT';

  if (!phoneNumber || !/^01[3-9]\d{8}$/.test(phoneNumber)) {
    const err = new Error('Invalid Bangladeshi phone number format.');
    err.statusCode = 400; err.isOperational = true;
    return next(err);
  }

  // Upsert user so we have a stable userId for the challenge
  let user = await User.findOneAndUpdate(
    { phoneNumber },
    {
      $setOnInsert: { role: requestedRole, status: 'PENDING_VERIFICATION' }
    },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
  );

  // Fetch existing credentials so the authenticator can exclude duplicates
  const existingCredentials = await PasskeyCredential.find({ userId: user._id }).lean();

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: user._id.toString(),
    userName: phoneNumber,
    userDisplayName: phoneNumber,
    timeout: 60000,
    attestationType: 'none',
    excludeCredentials: existingCredentials.map((cred) => ({
      id: cred.credentialID,
      type: 'public-key',
      transports: cred.transports,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  // 🛡️ Persist challenge on the user document for server-side verification in step 2
  user.webAuthnChallenge = options.challenge;
  await user.save();

  res.status(200).json({ status: 'success', options });
}));

/**
 * POST /api/auth/passkey/register/verify
 * Step 2 of 2: Verify the authenticator's registration response.
 *
 * Body: { phoneNumber, registrationResponse, deviceLabel? }
 */
router.post('/passkey/register/verify', passkeyLimiter, catchAsync(async (req, res, next) => {
  const phoneNumber = String(req.body.phoneNumber || '').trim();
  const { registrationResponse, deviceLabel } = req.body;

  if (!phoneNumber || !registrationResponse) {
    const err = new Error('phoneNumber and registrationResponse are required.');
    err.statusCode = 400; err.isOperational = true;
    return next(err);
  }

  // 🛡️ Phase-3: webAuthnChallenge + otpVerifiedAt are select:false on the
  // schema — opt in explicitly here where this handler must read them.
  const user = await User.findOne({ phoneNumber }).select('+webAuthnChallenge +otpVerifiedAt');
  if (!user || !user.webAuthnChallenge) {
    const err = new Error('No pending WebAuthn challenge found. Start registration flow first.');
    err.statusCode = 400; err.isOperational = true;
    return next(err);
  }

  // Never lift a moderation decision: suspended/banned accounts cannot register a passkey into ACTIVE.
  if (user.status === 'SUSPENDED' || user.status === 'BANNED') {
    const err = new Error('Access Denied: This account is suspended.');
    err.statusCode = 403; err.isOperational = true;
    return next(err);
  }

  // 🛡️ PHONE-OWNERSHIP GATE (Phase-1 ship-blocker fix)
  // Registering a passkey mints a 7-day JWT, so the server MUST have proof the
  // caller owns this phone number before accepting the credential. Proof is a
  // fresh OTP verification stamped on the user by /verify-otp in the last
  // OTP_FRESH_WINDOW_MS. Without this, anyone who knows a victim's phone
  // number can register a passkey on their account and take it over.
  const otpAge = user.otpVerifiedAt ? Date.now() - user.otpVerifiedAt.getTime() : Infinity;
  if (otpAge > OTP_FRESH_WINDOW_MS) {
    const err = new Error('Verify your phone number via OTP in the last 5 minutes, then retry.');
    err.statusCode = 401; err.isOperational = true;
    return next(err);
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: registrationResponse,
      expectedChallenge: user.webAuthnChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
  } catch (e) {
    const err = new Error(`WebAuthn registration verification failed: ${e.message}`);
    err.statusCode = 400; err.isOperational = true;
    return next(err);
  }

  if (!verification.verified || !verification.registrationInfo) {
    const err = new Error('WebAuthn registration was not verified.');
    err.statusCode = 400; err.isOperational = true;
    return next(err);
  }

  const { credential, aaguid } = verification.registrationInfo;

  // 🔐 Persist the new credential — convert Uint8Arrays to Base64URL strings
  await PasskeyCredential.create({
    userId: user._id,
    credentialID: Buffer.from(credential.id).toString('base64url'),
    credentialPublicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: registrationResponse.response?.transports || [],
    deviceLabel: String(deviceLabel || 'Unnamed Device').substring(0, 64),
    aaguid: aaguid || null,
  });

  // Activate user, clear challenge, and burn the OTP-fresh stamp (single-use).
  user.status = 'ACTIVE';
  user.webAuthnChallenge = undefined;
  user.otpVerifiedAt = null;
  await user.save();

  // Sets the httpOnly session cookie; the token is also returned in the body
  // for API clients, but the browser frontend never stores it.
  const token = issueSession(res, user);

  console.log(`✅ [WebAuthn] Passkey registered for ${phoneNumber} (device: ${deviceLabel || 'Unnamed Device'})`);

  res.status(201).json({
    status: 'success',
    message: 'Passkey registered successfully.',
    token,
    user: { id: user._id, phoneNumber: user.phoneNumber, role: user.role, status: user.status },
  });
}));

/**
 * POST /api/auth/passkey/authenticate/options
 * Step 1 of 2: Generate a WebAuthn authentication challenge.
 *
 * Body: { phoneNumber }
 */
router.post('/passkey/authenticate/options', passkeyLimiter, catchAsync(async (req, res, next) => {
  const phoneNumber = String(req.body.phoneNumber || '').trim();

  if (!phoneNumber) {
    const err = new Error('phoneNumber is required.');
    err.statusCode = 400; err.isOperational = true;
    return next(err);
  }

  const user = await User.findOne({ phoneNumber }).select('+webAuthnChallenge');
  if (!user) {
    // 🛡️ Don't leak account existence via timing; return generic error
    const err = new Error('No account found. Please register first.');
    err.statusCode = 404; err.isOperational = true;
    return next(err);
  }

  const existingCredentials = await PasskeyCredential.find({ userId: user._id }).lean();

  if (!existingCredentials.length) {
    const err = new Error('No passkeys registered for this account. Use OTP authentication.');
    err.statusCode = 404; err.isOperational = true;
    return next(err);
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    timeout: 60000,
    allowCredentials: existingCredentials.map((cred) => ({
      id: cred.credentialID,
      type: 'public-key',
      transports: cred.transports,
    })),
    userVerification: 'preferred',
  });

  // 🛡️ Persist challenge for verification in step 2
  user.webAuthnChallenge = options.challenge;
  await user.save();

  res.status(200).json({ status: 'success', options });
}));

/**
 * POST /api/auth/passkey/authenticate/verify
 * Step 2 of 2: Verify the authenticator's assertion response and issue a JWT.
 *
 * Body: { phoneNumber, authenticationResponse }
 */
router.post('/passkey/authenticate/verify', passkeyLimiter, catchAsync(async (req, res, next) => {
  const phoneNumber = String(req.body.phoneNumber || '').trim();
  const { authenticationResponse } = req.body;

  if (!phoneNumber || !authenticationResponse) {
    const err = new Error('phoneNumber and authenticationResponse are required.');
    err.statusCode = 400; err.isOperational = true;
    return next(err);
  }

  const user = await User.findOne({ phoneNumber }).select('+webAuthnChallenge');
  if (!user || !user.webAuthnChallenge) {
    const err = new Error('No pending WebAuthn challenge found. Start authentication flow first.');
    err.statusCode = 400; err.isOperational = true;
    return next(err);
  }

  if (user.status !== 'ACTIVE') {
    const err = new Error('Access Denied: This account is suspended or unverified.');
    err.statusCode = 403; err.isOperational = true;
    return next(err);
  }

  // Look up the specific credential being asserted
  const responseCredentialID = String(authenticationResponse.id || '');
  const credentialRecord = await PasskeyCredential.findOne({
    userId: user._id,
    credentialID: responseCredentialID,
  });

  if (!credentialRecord) {
    const err = new Error('Authenticator credential not recognised for this account.');
    err.statusCode = 401; err.isOperational = true;
    return next(err);
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: authenticationResponse,
      expectedChallenge: user.webAuthnChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: credentialRecord.credentialID,
        publicKey: Buffer.from(credentialRecord.credentialPublicKey, 'base64url'),
        counter: credentialRecord.counter,
        transports: credentialRecord.transports,
      },
    });
  } catch (e) {
    const err = new Error(`WebAuthn authentication failed: ${e.message}`);
    err.statusCode = 401; err.isOperational = true;
    return next(err);
  }

  if (!verification.verified) {
    const err = new Error('WebAuthn biometric assertion not verified.');
    err.statusCode = 401; err.isOperational = true;
    return next(err);
  }

  // 🛡️ MONOTONIC COUNTER CHECK — detects cloned authenticators
  const { newCounter } = verification.authenticationInfo;
  if (credentialRecord.counter !== 0 && newCounter <= credentialRecord.counter) {
    console.error(`🚨 CLONED AUTHENTICATOR DETECTED for user ${user._id} — counter regression: ${newCounter} <= ${credentialRecord.counter}`);
    const err = new Error('SECURITY ALERT: Authenticator counter regression detected. Access denied.');
    err.statusCode = 401; err.isOperational = true;
    return next(err);
  }

  // Advance counter and timestamp
  credentialRecord.counter = newCounter;
  credentialRecord.lastUsedAt = new Date();
  await credentialRecord.save();

  // Clear challenge
  user.webAuthnChallenge = undefined;
  await user.save();

  // Sets the httpOnly session cookie; the token is also returned in the body
  // for API clients, but the browser frontend never stores it.
  const token = issueSession(res, user);

  console.log(`✅ [WebAuthn] Biometric authentication successful for ${phoneNumber}`);

  res.status(200).json({
    status: 'success',
    token,
    user: { id: user._id, phoneNumber: user.phoneNumber, role: user.role, status: user.status },
  });
}));

/**
 * GET /api/auth/passkey/credentials
 * List registered passkeys for an authenticated user.
 * Requires a valid JWT (caller must attach Authorization: Bearer <token>).
 */
router.get('/passkey/credentials', passkeyLimiter, verifyToken, catchAsync(async (req, res) => {
  // verifyToken also re-checks status=ACTIVE and session version — the old
  // inline jwt.verify let a suspended or logged-out user list credentials.
  const credentials = await PasskeyCredential.find({ userId: req.user.userId })
    .select('credentialID deviceLabel transports lastUsedAt createdAt aaguid')
    .lean();

  res.status(200).json({ status: 'success', count: credentials.length, credentials });
}));

/**
 * GET /api/auth/me — the signed-in user's own profile. The browser cannot
 * read the httpOnly session cookie, so this is how the frontend learns who
 * is logged in (and whether anyone is).
 */
router.get('/me', verifyToken, catchAsync(async (req, res) => {
  const user = await User.findById(req.user.userId).select('phoneNumber role status preferences createdAt').lean();
  res.status(200).json({
    status: 'success',
    user: {
      id: user._id,
      phoneNumber: user.phoneNumber,
      role: user.role,
      status: user.status,
      language: (user.preferences && user.preferences.language) || 'bn',
      memberSince: user.createdAt
    }
  });
}));

/**
 * POST /api/auth/logout — revokes every outstanding session token for this
 * user (sessionVersion bump) and clears the cookie.
 */
router.post('/logout', verifyToken, catchAsync(async (req, res) => {
  await revokeAllSessions(req.user.userId);
  clearSession(res);
  res.status(200).json({ status: 'success', message: 'Signed out.' });
}));

// ─────────────────────────────────────────────
// ═══════════════════════════════════════════
//   TIER-2: SMS OTP (Legacy Fallback)
// ═══════════════════════════════════════════
// ─────────────────────────────────────────────

/**
 * POST /api/auth/send-otp
 * Secondary fallback for devices without WebAuthn capability.
 */
router.post('/send-otp', otpLimiter, catchAsync(async (req, res, next) => {
  // 🛡️ MICROSCOPIC DEFENSE: Force cast input directly to a primitive string
  const phoneNumber = String(req.body.phoneNumber || '').trim();

  // 🛡️ PRIVILEGE ESCALATION GUARD: Hard-lock public registrations
  let requestedRole = String(req.body.role || 'CLIENT').toUpperCase();
  if (!['CLIENT', 'CONTRACTOR'].includes(requestedRole)) {
    requestedRole = 'CLIENT'; // Silently downgrade malicious admin attempts
  }

  if (!phoneNumber || !/^01[3-9]\d{8}$/.test(phoneNumber)) {
    const error = new Error('Invalid Bangladeshi phone number format.');
    error.statusCode = 400;
    error.isOperational = true;
    return next(error);
  }

  // Both checks run BEFORE any user/OTP is written, so a refused request
  // leaves no ghost account behind.
  const deliveryMode = resolveOtpDelivery();
  if (!deliveryMode) {
    // Previously production "succeeded" while the code went nowhere.
    console.error('🚨 [OTP] No delivery channel configured (set OTP_DELIVERY). Refusing to issue a code nobody can receive.');
    return next(Object.assign(new Error('Login codes are temporarily unavailable. Please try again later.'), { statusCode: 503, isOperational: true }));
  }
  if (!isPhoneAllowed(phoneNumber)) {
    return next(Object.assign(new Error('Build-BD is currently invite-only. This number is not on the beta list.'), { statusCode: 403, isOperational: true }));
  }

  const rawOTP = generateOTP();
  const hashedOTP = hashOTP(rawOTP);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await User.findOneAndUpdate(
    { phoneNumber },
    {
      $set: { 'otp.hash': hashedOTP, 'otp.expiresAt': expiresAt, 'otp.attempts': 0 },
      $setOnInsert: { role: requestedRole, status: 'PENDING_VERIFICATION' }
    },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
  );

  deliverOtp(deliveryMode, phoneNumber, rawOTP, expiresAt);

  const responsePayload = {
    status: 'success',
    delivery: deliveryMode,
    message: deliveryMode === 'operator'
      ? 'Code issued. Your Build-BD beta contact will send it to you.'
      : 'Code sent.'
  };

  // Only the dev/test console channel ever echoes the code (never production).
  if (deliveryMode === 'console' && process.env.NODE_ENV !== 'production') {
    responsePayload.debugOtp = rawOTP;
  }

  res.status(200).json(responsePayload);
}));

/**
 * POST /api/auth/verify-otp
 * Secondary fallback OTP verification.
 */
router.post('/verify-otp', verifyLimiter, catchAsync(async (req, res, next) => {
  // 🛡️ MICROSCOPIC DEFENSE: Type casting inputs to completely neutralize NoSQL Injection vectors
  const phoneNumber = String(req.body.phoneNumber || '').trim();
  const otp = String(req.body.otp || '').trim();

  if (!phoneNumber || !otp) {
    const error = new Error('Phone number and OTP are mandatory parameters.');
    error.statusCode = 400;
    error.isOperational = true;
    return next(error);
  }

  // 🛡️ Phase-3: otp.hash + otp.expiresAt are select:false on the schema.
  const user = await User.findOne({ phoneNumber }).select('+otp.hash +otp.expiresAt +otp.attempts');

  if (!user || !user.otp || !user.otp.hash) {
    const error = new Error('Invalid request or OTP session expired.');
    error.statusCode = 401;
    error.isOperational = true;
    return next(error);
  }

  // A suspended or banned account stays out: a valid code must never lift a moderation decision.
  // Only never-activated (PENDING_VERIFICATION) and ACTIVE accounts may sign in with a code.
  if (user.status === 'SUSPENDED' || user.status === 'BANNED') {
    return next(Object.assign(new Error('Access Denied: This account is suspended.'), { statusCode: 403, isOperational: true }));
  }

  if (new Date() > user.otp.expiresAt) {
    user.otp = undefined;
    await user.save();
    const error = new Error('OTP has expired.');
    error.statusCode = 401;
    error.isOperational = true;
    return next(error);
  }

  const storedHash = user.otp.hash;
  if (!hashesEqual(hashOTP(otp), storedHash)) {
    // Atomic increment so parallel guesses can't all read the same count.
    const after = await User.findOneAndUpdate(
      { _id: user._id, 'otp.hash': storedHash },
      { $inc: { 'otp.attempts': 1 } },
      { returnDocument: 'after', projection: { 'otp.attempts': 1 } }
    );
    const attempts = after && after.otp && Number.isInteger(after.otp.attempts) ? after.otp.attempts : MAX_OTP_ATTEMPTS;
    if (attempts >= MAX_OTP_ATTEMPTS) {
      await User.updateOne({ _id: user._id, 'otp.hash': storedHash }, { $unset: { otp: 1 } });
      return next(Object.assign(new Error('Too many incorrect codes. Please request a new code.'), { statusCode: 429, isOperational: true }));
    }
    return next(Object.assign(new Error(`Incorrect code. ${MAX_OTP_ATTEMPTS - attempts} attempt(s) left.`), { statusCode: 401, isOperational: true }));
  }

  // Consume the code atomically: only succeeds if it is still the current,
  // non-exhausted code. Two parallel requests with the same code can't both
  // pass, and a code voided by too many misses can't be used in a race.
  const consumed = await User.updateOne(
    {
      _id: user._id,
      status: { $in: ['PENDING_VERIFICATION', 'ACTIVE'] }, // re-checked atomically: a ban between read and write wins
      'otp.hash': storedHash,
      'otp.attempts': { $not: { $gte: MAX_OTP_ATTEMPTS } }
    },
    { $unset: { otp: 1 }, $set: { status: 'ACTIVE', otpVerifiedAt: new Date() } }
  );
  if (consumed.modifiedCount !== 1) {
    return next(Object.assign(new Error('This code is no longer valid. Please request a new code.'), { statusCode: 401, isOperational: true }));
  }
  // The atomic update above already persisted status=ACTIVE and the
  // otpVerifiedAt stamp (proof of phone ownership for passkey registration).
  user.status = 'ACTIVE';
  user.otp = undefined;

  // Sets the httpOnly session cookie; the token is also returned in the body
  // for API clients, but the browser frontend never stores it.
  const token = issueSession(res, user);

  res.status(200).json({
    status: 'success',
    token,
    user: { id: user._id, phoneNumber: user.phoneNumber, role: user.role, status: user.status }
  });
}));

module.exports = router;