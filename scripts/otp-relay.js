#!/usr/bin/env node
// scripts/otp-relay.js — operator view of login codes (OTP_DELIVERY=operator).
//
//   node scripts/otp-relay.js           show every code that is still valid
//   node scripts/otp-relay.js --watch   keep running; print new codes as they arrive
//
// Forward a code ONLY to the person who owns that phone number (call them,
// or message the number itself). Never post codes in a group chat.
'use strict';

const fs = require('fs');
const { RELAY_LOG } = require('../services/otpDelivery');

function readEntries() {
  if (!fs.existsSync(RELAY_LOG)) return [];
  return fs.readFileSync(RELAY_LOG, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
}

function fmt(e) {
  const left = Math.max(0, Math.round((new Date(e.expiresAt) - Date.now()) / 1000));
  return `  ${e.phone}   code ${e.code}   valid ${Math.floor(left / 60)}m${String(left % 60).padStart(2, '0')}s   (requested ${new Date(e.requestedAt).toLocaleTimeString()})`;
}

function activeLatestPerPhone() {
  const latest = new Map();
  for (const e of readEntries()) latest.set(e.phone, e); // later lines win
  return [...latest.values()].filter((e) => new Date(e.expiresAt) > new Date());
}

if (process.argv.includes('--watch')) {
  const seen = new Set(readEntries().map((e) => `${e.phone}|${e.requestedAt}`));
  console.log(`Watching ${RELAY_LOG} for new login codes (Ctrl+C to stop)…`);
  for (const e of activeLatestPerPhone()) console.log(fmt(e));
  setInterval(() => {
    for (const e of readEntries()) {
      const k = `${e.phone}|${e.requestedAt}`;
      if (!seen.has(k)) { seen.add(k); console.log(fmt(e)); }
    }
  }, 1500);
} else {
  const active = activeLatestPerPhone();
  if (!active.length) console.log('No valid login codes right now.');
  else { console.log('Valid login codes (latest per phone):'); active.forEach((e) => console.log(fmt(e))); }
}
