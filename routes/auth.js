// routes/auth.js
// 🔐 Phase 20: WebAuthn (Passkeys) as primary auth + SMS OTP as secondary fallback
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
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
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { status: 'error', message: 'Security Lockout: Too many OTP requests. Please wait 15 minutes.' }
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { status: 'error', message: 'Security Lockout: Too many failed verification attempts.' }
});

const passkeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { status: 'error', message: 'Security Lockout: Too many passkey operations.' }
});

// ─────────────────────────────────────────────
// 🔧 OTP UTILITIES
// ─────────────────────────────────────────────
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();
const hashOTP = (otp) => crypto.createHash('sha256').update(otp).digest('hex');

// ─────────────────────────────────────────────
// 📲 LOCAL MOCK SMS GATEWAY ADAPTER
// Emits high-contrast ANSI terminal output in development.
// In production this should be replaced with a real provider (e.g., Twilio, BD-SMS).
// ─────────────────────────────────────────────
function dispatchOTP(phoneNumber, rawOTP) {
  if (process.env.NODE_ENV !== 'production') {
    // ANSI high-contrast block — impossible to miss in any terminal
    const border = '\x1b[45m\x1b[97m'; // Magenta BG, bright white FG
    const reset  = '\x1b[0m';
    const accent = '\x1b[93m';          // Bright yellow for the OTP digits
    console.log(`\n${border}  ┌──────────────────────────────────────────────┐  ${reset}`);
    console.log(`${border}  │   📲 LOCAL SMS MOCK GATEWAY [BUILD-BD]        │  ${reset}`);
    console.log(`${border}  │   Recipient : ${accent}${phoneNumber.padEnd(29)}${border}│  ${reset}`);
    console.log(`${border}  │   OTP Code  : ${accent}${rawOTP.padEnd(29)}${border}│  ${reset}`);
    console.log(`${border}  │   Expires   : 5 minutes                       │  ${reset}`);
    console.log(`${border}  └──────────────────────────────────────────────┘  ${reset}\n`);
  } else {
    // Production hook: replace with real SMS provider SDK call
    console.log(`[SMS_GATEWAY] OTP dispatch requested for ${phoneNumber}. Wire up production provider.`);
  }
}

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

  const user = await User.findOne({ phoneNumber });
  if (!user || !user.webAuthnChallenge) {
    const err = new Error('No pending WebAuthn challenge found. Start registration flow first.');
    err.statusCode = 400; err.isOperational = true;
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

  const token = jwt.sign(
    { userId: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

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

  const user = await User.findOne({ phoneNumber });
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

  const user = await User.findOne({ phoneNumber });
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

  const token = jwt.sign(
    { userId: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

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
router.get('/passkey/credentials', passkeyLimiter, catchAsync(async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    const err = new Error('Authentication token required.');
    err.statusCode = 401; err.isOperational = true;
    return next(err);
  }
  let decoded;
  try {
    decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    const err = new Error('Invalid or expired token.');
    err.statusCode = 401; err.isOperational = true;
    return next(err);
  }

  const credentials = await PasskeyCredential.find({ userId: decoded.userId })
    .select('credentialID deviceLabel transports lastUsedAt createdAt aaguid')
    .lean();

  res.status(200).json({ status: 'success', count: credentials.length, credentials });
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

  const rawOTP = generateOTP();
  const hashedOTP = hashOTP(rawOTP);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await User.findOneAndUpdate(
    { phoneNumber },
    {
      $set: { 'otp.hash': hashedOTP, 'otp.expiresAt': expiresAt },
      $setOnInsert: { role: requestedRole, status: 'PENDING_VERIFICATION' }
    },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
  );

  // 📲 Dispatch via Local Mock Gateway Adapter (ANSI high-contrast in dev)
  dispatchOTP(phoneNumber, rawOTP);

  const responsePayload = {
    status: 'success',
    message: 'OTP dispatched. Check server terminal (dev) or your SMS inbox (prod).'
  };

  if (process.env.NODE_ENV !== 'production') {
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

  const user = await User.findOne({ phoneNumber });

  if (!user || !user.otp || !user.otp.hash) {
    const error = new Error('Invalid request or OTP session expired.');
    error.statusCode = 401;
    error.isOperational = true;
    return next(error);
  }

  if (new Date() > user.otp.expiresAt) {
    user.otp = undefined;
    await user.save();
    const error = new Error('OTP has expired.');
    error.statusCode = 401;
    error.isOperational = true;
    return next(error);
  }

  if (hashOTP(otp) !== user.otp.hash) {
    const error = new Error('Incorrect OTP authorization code.');
    error.statusCode = 401;
    error.isOperational = true;
    return next(error);
  }

  user.status = 'ACTIVE';
  user.otp = undefined;
  // Stamp a short-lived proof-of-phone-ownership so the caller can register
  // a passkey immediately after. Consumed in /passkey/register/verify.
  user.otpVerifiedAt = new Date();
  await user.save();

  const token = jwt.sign(
    { userId: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.status(200).json({
    status: 'success',
    token,
    user: { id: user._id, phoneNumber: user.phoneNumber, role: user.role, status: user.status }
  });
}));

module.exports = router;