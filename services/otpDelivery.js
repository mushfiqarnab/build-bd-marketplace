// services/otpDelivery.js
// Pluggable OTP delivery for both local dev and 24/7 cloud deployments.
// The 6-digit code itself is generated, HMAC-hashed, and expired in routes/auth.js;
// this module decides WHERE the plaintext code is delivered:
//
//   OTP_DELIVERY=console          dev/test only: printed to terminal and echoed
//                                 as debugOtp. Refused in production.
//   OTP_DELIVERY=operator         ৳0 beta relay: appended to logs/otp-relay.log
//                                 (readable via /app/admin-verify.html, GET /api/admin/otp-relay,
//                                 or optional Telegram bot alert). Never sent in HTTP body.
//   OTP_DELIVERY=sms              Bangladeshi SMS gateway (BulkSMSBD, Greenweb, SSL Wireless,
//                                 or custom HTTPS webhook). Fails closed if SMS creds missing.
//   OTP_DELIVERY=sms_or_operator  Cloud-resilient hybrid: sends real SMS when SMS_API_TOKEN is
//                                 configured; automatically falls back to ৳0 operator relay if
//                                 SMS creds are not yet set or carrier HTTP fails.
//   (unset)                       console outside production; in production NO channel -> 503.
//
// BETA_ALLOWED_PHONES=01711111111,01822222222 makes OTP invite-only.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// OTP_RELAY_LOG lets tests use a throwaway file instead of the operator's.
const RELAY_LOG = process.env.OTP_RELAY_LOG || path.join(__dirname, '..', 'logs', 'otp-relay.log');
const MODES = new Set(['console', 'operator', 'sms', 'sms_or_operator']);
const SMS_PROVIDERS = new Set(['bulksmsbd', 'greenweb', 'sslwireless', 'webhook']);
const PLACEHOLDER_RE = /^(your_|replace_with_|<|changeme|example)/i;
const SMS_TIMEOUT_MS = 8000;

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

function isUsableSecret(val) {
  const trimmed = String(val || '').trim();
  return trimmed.length >= 6 && !PLACEHOLDER_RE.test(trimmed);
}

/**
 * Pure: resolves Bangladeshi SMS gateway configuration from env.
 */
function resolveSmsConfig(env = process.env) {
  const rawProvider = String(env.SMS_PROVIDER || '').trim().toLowerCase();
  const provider = (!rawProvider || rawProvider === 'mock') ? 'bulksmsbd' : rawProvider;
  const token = String(env.SMS_API_TOKEN || '').trim();
  const senderId = String(env.SMS_SENDER_ID || '').trim();
  const customUrl = String(env.SMS_GATEWAY_URL || '').trim();
  const isProduction = env.NODE_ENV === 'production';

  if (!SMS_PROVIDERS.has(provider)) {
    return { valid: false, provider, reason: `Unsupported SMS_PROVIDER '${provider}'.` };
  }

  let gatewayUrl = customUrl;
  if (!gatewayUrl) {
    if (provider === 'bulksmsbd') gatewayUrl = 'https://bulksmsbd.net/api/smsapi';
    else if (provider === 'greenweb') gatewayUrl = 'https://api.greenweb.com.bd/api.php?json';
    else if (provider === 'sslwireless') gatewayUrl = 'https://smsplus.sslwireless.com/api/v3/send-sms';
  }

  if (!gatewayUrl) {
    return { valid: false, provider, reason: 'SMS_GATEWAY_URL is required for webhook SMS provider.' };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(gatewayUrl);
  } catch (_) {
    return { valid: false, provider, reason: 'SMS_GATEWAY_URL is not a valid URL.' };
  }

  const loopback = isLoopbackHost(parsedUrl.hostname);
  if (isProduction && parsedUrl.protocol !== 'https:' && !loopback) {
    return { valid: false, provider, reason: 'SMS_GATEWAY_URL must use https:// in production.' };
  }

  if (provider !== 'webhook' && !isUsableSecret(token)) {
    return { valid: false, provider, reason: 'SMS_API_TOKEN is missing or still set to a placeholder.' };
  }
  if (provider === 'sslwireless' && !senderId) {
    return { valid: false, provider, reason: 'SMS_SENDER_ID (SID) is required for SSL Wireless.' };
  }

  return {
    valid: true,
    provider,
    gatewayUrl,
    token,
    senderId: senderId || '8809617611000'
  };
}

function hasValidSmsConfig(env = process.env) {
  return resolveSmsConfig(env).valid;
}

function resolveOtpDelivery(env = process.env) {
  const mode = (env.OTP_DELIVERY || '').trim().toLowerCase();
  const production = env.NODE_ENV === 'production';
  if (mode && !MODES.has(mode)) return null;
  if (mode === 'console') return production ? null : 'console';
  if (mode === 'operator') return 'operator';
  if (mode === 'sms') return hasValidSmsConfig(env) ? 'sms' : null;
  if (mode === 'sms_or_operator') {
    return hasValidSmsConfig(env) ? 'sms_or_operator' : 'operator';
  }
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

function formatOtpSmsText(rawOTP) {
  return `Build-BD verification code: ${rawOTP}. Valid for 5 minutes. Do not share this code.`;
}

function notifyTelegramOperator(phoneNumber, rawOTP, expiresAt, env = process.env) {
  const botToken = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
  if (!isUsableSecret(botToken) || !chatId) return;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const text = `🔐 Build-BD Login OTP\nPhone: ${phoneNumber}\nCode: ${rawOTP}\nExpires: ${expiresAt.toISOString()}`;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(5000)
  }).catch((err) => {
    console.warn(`⚠️ [OTP-RELAY] Telegram operator notification failed: ${err.message}`);
  });
}

function writeOperatorRelay(phoneNumber, rawOTP, expiresAt, relayLog = RELAY_LOG, env = process.env) {
  fs.mkdirSync(path.dirname(relayLog), { recursive: true });
  fs.appendFileSync(relayLog, JSON.stringify({
    phone: phoneNumber,
    code: rawOTP,
    expiresAt: expiresAt.toISOString(),
    requestedAt: new Date().toISOString()
  }) + '\n', { mode: 0o600 });
  // The general server log never contains the code itself.
  console.log(`[OTP-RELAY] Code ready for ${phoneNumber} — view in Admin OTP Relay or run: node scripts/otp-relay.js`);
  notifyTelegramOperator(phoneNumber, rawOTP, expiresAt, env);
}

/**
 * Dispatches an OTP via the configured Bangladeshi SMS gateway.
 * Throws an operational 502 error if the upstream gateway rejects or times out.
 */
async function sendSmsOtp(phoneNumber, rawOTP, expiresAt, env = process.env) {
  const cfg = resolveSmsConfig(env);
  if (!cfg.valid) {
    throw Object.assign(new Error(cfg.reason || 'SMS gateway is not configured.'), {
      statusCode: 503,
      isOperational: true
    });
  }

  const msisdn88 = phoneNumber.startsWith('88') ? phoneNumber : `88${phoneNumber}`;
  const message = formatOtpSmsText(rawOTP);

  let reqInit;
  if (cfg.provider === 'bulksmsbd') {
    const params = new URLSearchParams({
      api_key: cfg.token,
      type: 'text',
      number: msisdn88,
      senderid: cfg.senderId,
      message
    });
    reqInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(SMS_TIMEOUT_MS)
    };
  } else if (cfg.provider === 'greenweb') {
    const params = new URLSearchParams({
      token: cfg.token,
      to: phoneNumber,
      message
    });
    reqInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(SMS_TIMEOUT_MS)
    };
  } else if (cfg.provider === 'sslwireless') {
    reqInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        api_token: cfg.token,
        sid: cfg.senderId,
        msisdn: msisdn88,
        sms: message,
        csms_id: crypto.randomBytes(8).toString('hex')
      }),
      signal: AbortSignal.timeout(SMS_TIMEOUT_MS)
    };
  } else {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    reqInit = {
      method: 'POST',
      headers,
      body: JSON.stringify({
        to: `+${msisdn88}`,
        phoneNumber,
        message,
        expiresAt: expiresAt.toISOString()
      }),
      signal: AbortSignal.timeout(SMS_TIMEOUT_MS)
    };
  }

  let res;
  let bodyText = '';
  try {
    res = await fetch(cfg.gatewayUrl, reqInit);
    bodyText = await res.text();
  } catch (err) {
    throw Object.assign(
      new Error('SMS gateway is temporarily unreachable. Please try again shortly.'),
      { statusCode: 502, isOperational: true, cause: err }
    );
  }

  if (!res.ok) {
    throw Object.assign(
      new Error(`SMS gateway rejected dispatch (HTTP ${res.status}).`),
      { statusCode: 502, isOperational: true }
    );
  }

  // Provider-specific carrier payload validation (many BD gateways return HTTP 200 on auth/balance errors)
  let parsed = null;
  try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch (_) { parsed = null; }

  if (cfg.provider === 'bulksmsbd' && parsed && parsed.response_code !== undefined) {
    if (Number(parsed.response_code) !== 202) {
      throw Object.assign(
        new Error(`BulkSMSBD rejected dispatch (code ${parsed.response_code}).`),
        { statusCode: 502, isOperational: true }
      );
    }
  } else if (cfg.provider === 'greenweb') {
    if (Array.isArray(parsed) && parsed.length > 0 && String(parsed[0].status || '').toUpperCase() === 'FAILED') {
      throw Object.assign(new Error('Greenweb SMS gateway reported FAILED status.'), { statusCode: 502, isOperational: true });
    }
    if (!parsed && /^error:/i.test(bodyText.trim())) {
      throw Object.assign(new Error('Greenweb SMS gateway returned an error.'), { statusCode: 502, isOperational: true });
    }
  } else if (cfg.provider === 'sslwireless' && parsed && parsed.status) {
    if (String(parsed.status).toUpperCase() !== 'SUCCESS') {
      throw Object.assign(new Error(`SSL Wireless rejected dispatch (${parsed.status_code || parsed.status}).`), { statusCode: 502, isOperational: true });
    }
  }

  console.log(`📲 [SMS-OTP] Code dispatched via ${cfg.provider} to ${phoneNumber.slice(0, 3)}****${phoneNumber.slice(-2)}`);
  return { channel: 'sms', provider: cfg.provider, fallbackUsed: false };
}

/**
 * Delivers via the resolved mode.
 * Synchronous for `console` and `operator` (preserving legacy callers), async for `sms` / `sms_or_operator`.
 */
function deliverOtp(mode, phoneNumber, rawOTP, expiresAt, relayLog = RELAY_LOG, env = process.env) {
  if (mode === 'console') {
    printConsoleBox(phoneNumber, rawOTP);
    return { channel: 'console', fallbackUsed: false };
  }
  if (mode === 'operator') {
    writeOperatorRelay(phoneNumber, rawOTP, expiresAt, relayLog, env);
    return { channel: 'operator', fallbackUsed: false };
  }
  if (mode === 'sms') {
    return sendSmsOtp(phoneNumber, rawOTP, expiresAt, env);
  }
  if (mode === 'sms_or_operator') {
    return sendSmsOtp(phoneNumber, rawOTP, expiresAt, env).catch((err) => {
      console.warn(`⚠️ [OTP] Primary SMS gateway failed (${err.message}); falling back to ৳0 operator relay.`);
      writeOperatorRelay(phoneNumber, rawOTP, expiresAt, relayLog, env);
      return { channel: 'operator', fallbackUsed: true };
    });
  }
  throw new Error(`Unknown OTP delivery mode: ${mode}`);
}

/**
 * Reads active (unexpired) operator relay codes, keeping only the latest per phone number.
 */
function readActiveOperatorOtps(relayLog = RELAY_LOG) {
  if (!fs.existsSync(relayLog)) return [];
  const now = Date.now();
  const latest = new Map();
  const lines = fs.readFileSync(relayLog, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry && entry.phone && entry.code && entry.expiresAt) {
        latest.set(entry.phone, entry);
      }
    } catch (_) {
      // Ignore malformed lines
    }
  }
  return [...latest.values()]
    .filter((e) => new Date(e.expiresAt).getTime() > now)
    .sort((a, b) => new Date(b.requestedAt || 0).getTime() - new Date(a.requestedAt || 0).getTime())
    .map((e) => ({
      phone: e.phone,
      code: e.code,
      expiresAt: e.expiresAt,
      requestedAt: e.requestedAt,
      remainingSeconds: Math.max(0, Math.round((new Date(e.expiresAt).getTime() - now) / 1000))
    }));
}

module.exports = {
  resolveOtpDelivery,
  resolveSmsConfig,
  hasValidSmsConfig,
  isPhoneAllowed,
  deliverOtp,
  sendSmsOtp,
  readActiveOperatorOtps,
  RELAY_LOG
};
