// services/otpDelivery.js
// Pluggable OTP delivery. The code itself is generated, hashed and expired in
// routes/auth.js; this module only decides WHERE the plaintext goes.
//
//   OTP_DELIVERY=console   dev/test only: printed to the terminal and echoed
//                          as debugOtp. Refused in production.
//   OTP_DELIVERY=operator  zero-cost beta: appended to logs/otp-relay.log on
//                          the server (never sent to the browser); the
//                          operator reads it with `node scripts/otp-relay.js`
//                          and forwards it to the tester.
//   (unset)                console outside production; in production NO
//                          channel → send-otp answers 503 instead of
//                          pretending a code was sent.
//
// BETA_ALLOWED_PHONES=01711111111,01822222222 makes OTP invite-only.
'use strict';

const fs = require('fs');
const path = require('path');

const RELAY_LOG = path.join(__dirname, '..', 'logs', 'otp-relay.log');
const MODES = new Set(['console', 'operator']);

function resolveOtpDelivery(env = process.env) {
  const mode = (env.OTP_DELIVERY || '').trim().toLowerCase();
  const production = env.NODE_ENV === 'production';
  if (mode && !MODES.has(mode)) return null;
  if (mode === 'console') return production ? null : 'console';
  if (mode === 'operator') return 'operator';
  return production ? null : 'console';
}

function isPhoneAllowed(phoneNumber, env = process.env) {
  const list = (env.BETA_ALLOWED_PHONES || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(phoneNumber);
}

function printConsoleBox(phoneNumber, rawOTP) {
  const border = '\x1b[45m\x1b[97m';
  const reset = '\x1b[0m';
  const accent = '\x1b[93m';
  console.log(`\n${border}  ┌──────────────────────────────────────────────┐  ${reset}`);
  console.log(`${border}  │   📲 LOCAL SMS MOCK GATEWAY [BUILD-BD]        │  ${reset}`);
  console.log(`${border}  │   Recipient : ${accent}${phoneNumber.padEnd(29)}${border}│  ${reset}`);
  console.log(`${border}  │   OTP Code  : ${accent}${rawOTP.padEnd(29)}${border}│  ${reset}`);
  console.log(`${border}  │   Expires   : 5 minutes                       │  ${reset}`);
  console.log(`${border}  └──────────────────────────────────────────────┘  ${reset}\n`);
}

/** Delivers via the resolved mode. Throws if writing the relay log fails. */
function deliverOtp(mode, phoneNumber, rawOTP, expiresAt, relayLog = RELAY_LOG) {
  if (mode === 'console') return printConsoleBox(phoneNumber, rawOTP);
  if (mode === 'operator') {
    fs.mkdirSync(path.dirname(relayLog), { recursive: true });
    fs.appendFileSync(relayLog, JSON.stringify({
      phone: phoneNumber,
      code: rawOTP,
      expiresAt: expiresAt.toISOString(),
      requestedAt: new Date().toISOString()
    }) + '\n', { mode: 0o600 });
    // The general server log never contains the code itself.
    console.log(`[OTP-RELAY] Code ready for ${phoneNumber} — run: node scripts/otp-relay.js`);
    return undefined;
  }
  throw new Error(`Unknown OTP delivery mode: ${mode}`);
}

module.exports = { resolveOtpDelivery, isPhoneAllowed, deliverOtp, RELAY_LOG };
