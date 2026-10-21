#!/usr/bin/env node
// scripts/qa/contractor-sybil-audit.js — contractor sybil & duplicate account detector
//
// Identifies shell/sybil contractor accounts flagged in Bangladesh Market Threat Model §1:
//   SYBIL-01: Shared tradeLicense across distinct contractor profiles
//   SYBIL-02: Shared nidHash across distinct contractor accounts (same NID, multiple accounts)
//   SYBIL-03: Placeholder / dummy trade license strings (e.g., '12345', 'N/A', 'TEST')
//   SYBIL-04: Account registration bursts (multiple accounts created within a short window)
//
// Pure function `auditContractorSybils(profiles, users)` is exported for unit testing.
// CLI usage:
//   node scripts/qa/contractor-sybil-audit.js --uri "<mongodb uri>"
'use strict';

const { createReport, runCli } = require('./lib');

const PLACEHOLDER_LICENSES = new Set([
  '12345',
  '123456',
  '12345678',
  '000000',
  'NA',
  'N/A',
  'NONE',
  'TEST',
  'DUMMY',
  'SAMPLE'
]);

/**
 * Pure function to audit contractor profiles and users for sybil anomalies.
 * @param {Array<Object>} profiles - ContractorProfile documents
 * @param {Array<Object>} [users] - User documents (optional, for timing checks)
 * @returns {Array<{ rule: string, level: string, profileId: string, message: string, detail: any }>}
 */
function auditContractorSybils(profiles = [], users = []) {
  const anomalies = [];
  if (!Array.isArray(profiles) || profiles.length === 0) return anomalies;

  const tradeLicenseMap = new Map(); // license -> [profileId]
  const nidHashMap = new Map();       // nidHash -> [profileId]

  for (const p of profiles) {
    if (!p || typeof p !== 'object') continue;
    const pId = String(p._id || p.userId || '');
    const rawLicense = p.tradeLicense ? String(p.tradeLicense).trim().toUpperCase() : null;
    const rawNidHash = p.nidHash ? String(p.nidHash).trim().toLowerCase() : null;

    // SYBIL-03: Placeholder trade license
    if (rawLicense && PLACEHOLDER_LICENSES.has(rawLicense)) {
      anomalies.push({
        rule: 'SYBIL-03',
        level: 'WARN',
        profileId: pId,
        message: `Placeholder/dummy trade license '${rawLicense}' detected on contractor profile.`,
        detail: { profileId: pId, tradeLicense: rawLicense }
      });
    }

    if (rawLicense) {
      if (!tradeLicenseMap.has(rawLicense)) tradeLicenseMap.set(rawLicense, []);
      tradeLicenseMap.get(rawLicense).push(pId);
    }

    if (rawNidHash) {
      if (!nidHashMap.has(rawNidHash)) nidHashMap.set(rawNidHash, []);
      nidHashMap.get(rawNidHash).push(pId);
    }
  }

  // SYBIL-01: Shared trade license across distinct profiles
  for (const [license, ids] of tradeLicenseMap.entries()) {
    if (ids.length > 1) {
      anomalies.push({
        rule: 'SYBIL-01',
        level: 'WARN',
        profileId: ids[0],
        message: `Duplicate trade license '${license}' shared across ${ids.length} contractor profiles.`,
        detail: { tradeLicense: license, profileIds: ids }
      });
    }
  }

  // SYBIL-02: Shared NID hash across distinct profiles
  for (const [hash, ids] of nidHashMap.entries()) {
    if (ids.length > 1) {
      anomalies.push({
        rule: 'SYBIL-02',
        level: 'FAIL',
        profileId: ids[0],
        message: `Sybil identity collision: Identical NID hash shared across ${ids.length} contractor accounts.`,
        detail: { nidHash: hash.slice(0, 16) + '...', profileIds: ids }
      });
    }
  }

  // SYBIL-04: Rapid registration bursts among contractor users
  if (Array.isArray(users) && users.length >= 3) {
    const contractorUsers = users
      .filter((u) => u && u.role === 'CONTRACTOR' && u.createdAt)
      .map((u) => ({ id: String(u._id), t: new Date(u.createdAt).getTime(), phone: u.phoneNumber }))
      .sort((a, b) => a.t - b.t);

    for (let i = 0; i <= contractorUsers.length - 3; i++) {
      const spanMs = contractorUsers[i + 2].t - contractorUsers[i].t;
      if (spanMs <= 120 * 1000) { // 3 contractor accounts within 2 minutes
        anomalies.push({
          rule: 'SYBIL-04',
          level: 'INFO',
          profileId: contractorUsers[i].id,
          message: `Rapid contractor registration burst: 3 accounts created within ${Math.round(spanMs / 1000)}s.`,
          detail: { spanSeconds: Math.round(spanMs / 1000), userIds: contractorUsers.slice(i, i + 3).map((x) => x.id) }
        });
        break;
      }
    }
  }

  return anomalies;
}

async function auditDatabase(opts = {}) {
  const report = createReport('Contractor Sybil Audit');
  const uri = opts.uri || process.env.MONGODB_URI;

  if (!uri) {
    report.warn('SYBIL-URI', 'No MongoDB URI supplied. Pass --uri or set MONGODB_URI.');
    return report;
  }

  if (uri.startsWith('mongodb+srv://')) {
    require('dns').setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
  }

  const mongoose = require('mongoose');
  let conn;

  try {
    conn = await mongoose.createConnection(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 }).asPromise();
    const db = conn.db;

    const [profiles, users] = await Promise.all([
      db.collection('contractorprofiles').find({}).toArray(),
      db.collection('users').find({ role: 'CONTRACTOR' }).toArray()
    ]);

    if (!profiles.length) {
      report.pass('SYBIL-00', 'No contractor profiles found in database to evaluate.');
      return report;
    }

    const anomalies = auditContractorSybils(profiles, users);
    if (!anomalies.length) {
      report.pass('SYBIL-OK', `Evaluated ${profiles.length} contractor profile(s); 0 sybil or duplicate trade license anomalies detected.`);
    } else {
      for (const a of anomalies) {
        if (a.level === 'FAIL') report.fail(a.rule, a.message, a.detail);
        else if (a.level === 'WARN') report.warn(a.rule, a.message, a.detail);
        else report.info(a.rule, a.message, a.detail);
      }
    }
  } catch (err) {
    report.warn('SYBIL-CONN', `Database query failed: ${err.message}`);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }

  return report;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const uriIdx = argv.indexOf('--uri');
  const uri = uriIdx !== -1 ? argv[uriIdx + 1] : undefined;
  runCli(auditDatabase, { uri });
}

module.exports = { auditContractorSybils, auditDatabase };
