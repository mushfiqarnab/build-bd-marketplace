// scripts/stress-test-physical-economy.js
// High-Concurrency Load & Race-Condition Stress Suite for Build-BD Physical Economy
'use strict';

const dns = require('dns');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
require('dotenv').config({ path: '.env.beta' });

try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (_) {}

const User = require('../models/User');
const Project = require('../models/Project');
const DomesticWorkerProfile = require('../models/DomesticWorkerProfile');
const LabourSubscription = require('../models/LabourSubscription');
const Timesheet = require('../models/Timesheet');
const AuditLog = require('../models/AuditLog');

const phone = () => '017' + Math.floor(10000000 + Math.random() * 89999999);
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';

function formatStats(latencies) {
  if (latencies.length === 0) return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const p = (pct) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * (pct / 100)))];
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(sum / sorted.length),
    p50: p(50),
    p95: p(95),
    p99: p(99)
  };
}

async function request(method, path, body, token, customIdemKey) {
  const start = Date.now();
  const headers = { 'Content-Type': 'application/json' };
  if (customIdemKey) headers['x-idempotency-key'] = customIdemKey;
  else if (method !== 'GET') headers['x-idempotency-key'] = `stress-${Date.now()}-${Math.random()}`;
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const duration = Date.now() - start;
    const json = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body: json, duration };
  } catch (err) {
    const duration = Date.now() - start;
    return { status: 0, ok: false, error: err.message, duration };
  }
}

async function main() {
  console.log('⚡ Build-BD High-Concurrency Physical Economy Stress Suite');
  console.log(`🌐 Target Ingress: ${BASE_URL}`);

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI);
  }

  const createdUserIds = [];
  const createdSubIds = [];
  const createdProjectIds = [];

  try {
    // ── Phase 1: 100 Concurrent Nirman-AI NLU Queries ───────────────────────
    console.log('\n── Phase 1: 100 Concurrent Nirman-AI NLU Inferences (Public) ──');
    const utterances = [
      'ধানমন্ডি এলাকায় ২ ঘণ্টার জন্য ছুটা বুয়া দরকার',
      'মিরপুর ১০ এ ২ বেডরুমের ১৮০০ স্কয়ার ফিট ফ্ল্যাট রং করার আনুমানিক খরচ কত?',
      'উত্তরা ১০ নম্বর সেক্টরে এসি গ্যাস রিফিল লাগবে ৪ তলায়',
      'সিলেটে ১৫০ বস্তা শাহ স্পেশাল সিমেন্ট দরকার',
      'Banani te full time automatic car driver chai',
      'গুলশানে ডিপ ক্লিনিং ও ভ্যাকুয়াম করার জন্য ১ দিনের হেল্পার লাগবে',
      'মোহাম্মদপুরে ৩ রুমের বাসা বদল শিফটিং সার্ভিস খরচ',
      'চট্টগ্রাম আগ্রাবাদে ১০ টন বিএসআরএম রড দরকার',
      'বাচ্চা দেখাশোনার জন্য সারাদিনের অভিজ্ঞ আয়া প্রয়োজন ধানমন্ডিতে',
      'প্লাম্বার লাগবে কিচেনের পাইপ লিক করছে জরুরি'
    ];

    const aiTasks = Array.from({ length: 100 }, (_, i) => {
      const text = utterances[i % utterances.length];
      return request('POST', '/api/ai/orchestrate', { utterance: text });
    });

    const aiStart = Date.now();
    const aiResults = await Promise.all(aiTasks);
    const aiTotalDuration = Date.now() - aiStart;

    const aiLatencies = aiResults.map((r) => r.duration);
    const aiSuccesses = aiResults.filter((r) => r.status === 200 && r.body?.status === 'success');
    const aiStats = formatStats(aiLatencies);

    console.log(`  Requests: 100 | Succeeded: ${aiSuccesses.length}/100 (100%)`);
    console.log(`  Total Wall Time: ${aiTotalDuration}ms | Throughput: ${Math.round((100 / aiTotalDuration) * 1000)} req/s`);
    console.log(`  Latency (ms): min=${aiStats.min} | mean=${aiStats.mean} | p50=${aiStats.p50} | p95=${aiStats.p95} | p99=${aiStats.p99} | max=${aiStats.max}`);

    if (aiSuccesses.length !== 100) {
      throw new Error(`AI Concurrency Failure: Only ${aiSuccesses.length}/100 succeeded`);
    }

    // ── Phase 2: 50 Concurrent Public Directory Queries ─────────────────────
    console.log('\n── Phase 2: 50 Concurrent Public Worker Directory Queries ──');
    const thanas = ['Dhanmondi', 'Gulshan', 'Uttara', 'Banani', 'Mirpur'];
    const dirTasks = Array.from({ length: 50 }, (_, i) => {
      const thana = thanas[i % thanas.length];
      return request('GET', `/api/v2/labour/directory/search?thana=${thana}&limit=10`);
    });

    const dirStart = Date.now();
    const dirResults = await Promise.all(dirTasks);
    const dirTotalDuration = Date.now() - dirStart;

    const dirLatencies = dirResults.map((r) => r.duration);
    const dirSuccesses = dirResults.filter((r) => r.status === 200 && r.body?.status === 'success');
    const dirStats = formatStats(dirLatencies);

    console.log(`  Requests: 50 | Succeeded: ${dirSuccesses.length}/50 (100%)`);
    console.log(`  Total Wall Time: ${dirTotalDuration}ms | Throughput: ${Math.round((50 / dirTotalDuration) * 1000)} req/s`);
    console.log(`  Latency (ms): min=${dirStats.min} | mean=${dirStats.mean} | p50=${dirStats.p50} | p95=${dirStats.p95} | p99=${dirStats.p99} | max=${dirStats.max}`);

    if (dirSuccesses.length !== 50) {
      throw new Error(`Directory Concurrency Failure: Only ${dirSuccesses.length}/50 succeeded`);
    }

    // ── Phase 3: 20 Concurrent Distinct Domestic Contract Subscriptions ─────
    console.log('\n── Phase 3: 20 Concurrent Distinct Domestic Contract Subscriptions (ACID Tx) ──');
    const worker = await User.create({
      phoneNumber: phone(),
      role: 'CONTRACTOR',
      status: 'ACTIVE'
    });
    createdUserIds.push(worker._id);

    const workerProfile = await DomesticWorkerProfile.create({
      userId: worker._id,
      fullName: 'Stress Test Staff',
      phoneNumber: worker.phoneNumber,
      workerCategory: 'HOUSEMAID_CHHUTA',
      subTier: 'L2_PART_TIME_MONTHLY',
      thana: 'Dhanmondi',
      district: 'Dhaka',
      base_coordinates: { type: 'Point', coordinates: [90.3760, 23.7465] },
      monthlyRateAmount: 8000,
      dailyRateAmount: 300,
      ring1_porichoy: { face_match_percentage: 90, is_adult_18_plus: true, sim_nid_matched: true, porichoy_verified_at: new Date() },
      guarantors: [{ name: 'Anchor 1', phone: '01711223344', relationship: 'URBAN_CARETAKER_DARWAN', status: 'ACTIVE_VOUCHED', verified_via: 'SMS_OTP', vouched_at: new Date() }],
      ring3_dmp_cims: { cims_tracking_ref: 'CIMS-STRESS-99', qr_smart_card_hash: 'QR-STRESS', cims_verified: true, dossier_issued_at: new Date() },
      skill_tags: [{ tag_code: 'CHORE_CLEAN', labelEn: 'Cleaning', labelBn: 'পরিষ্কার', is_certified: true }],
      availability: 'AVAILABLE'
    });

    // Seed 20 distinct clients
    const clientUsers = await Promise.all(
      Array.from({ length: 20 }, () =>
        User.create({
          phoneNumber: phone(),
          role: 'CLIENT',
          status: 'ACTIVE'
        })
      )
    );
    clientUsers.forEach((u) => createdUserIds.push(u._id));

    const clientTokens = clientUsers.map((u) =>
      jwt.sign({ userId: String(u._id), role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' })
    );

    const subTasks = clientTokens.map((token) =>
      request(
        'POST',
        '/api/v2/labour/contracts/subscribe',
        {
          workerId: String(worker._id),
          subTier: 'L2_PART_TIME_MONTHLY',
          workerCategory: 'HOUSEMAID_CHHUTA',
          agreedMonthlySalaryAmount: 8000,
          trialShiftFeeAmount: 250
        },
        token
      )
    );

    const subStart = Date.now();
    const subResults = await Promise.all(subTasks);
    const subTotalDuration = Date.now() - subStart;

    const subLatencies = subResults.map((r) => r.duration);
    const subSuccesses = subResults.filter((r) => r.status === 201 && r.body?.status === 'success');
    const subStats = formatStats(subLatencies);

    console.log(`  Requests: 20 | Succeeded: ${subSuccesses.length}/20 (100%)`);
    console.log(`  Total Wall Time: ${subTotalDuration}ms | Throughput: ${Math.round((20 / subTotalDuration) * 1000)} req/s`);
    console.log(`  Latency (ms): min=${subStats.min} | mean=${subStats.mean} | p50=${subStats.p50} | p95=${subStats.p95} | p99=${subStats.p99} | max=${subStats.max}`);

    subSuccesses.forEach((r) => {
      if (r.body?.data?._id) createdSubIds.push(r.body.data._id);
    });

    // DB Invariant Verifications
    const createdSubsCount = await LabourSubscription.countDocuments({ _id: { $in: createdSubIds } });
    const createdTimesheetsCount = await Timesheet.countDocuments({ subscriptionId: { $in: createdSubIds } });
    const auditLogsCount = await AuditLog.countDocuments({ entityId: { $in: createdSubIds }, action: 'CONTRACT_CREATED' });

    console.log(`  🔍 Invariant Check: Subscriptions created in DB: ${createdSubsCount} (expected: 20)`);
    console.log(`  🔍 Invariant Check: Trial Timesheets created in DB: ${createdTimesheetsCount} (expected: 20)`);
    console.log(`  🔍 Invariant Check: Immutable AuditLogs sealed: ${auditLogsCount} (expected: 20)`);

    if (createdSubsCount !== 20 || createdTimesheetsCount !== 20 || auditLogsCount !== 20) {
      throw new Error(`ACID Transaction Mismatch: subs=${createdSubsCount}, timesheets=${createdTimesheetsCount}, audits=${auditLogsCount}`);
    }

    // ── Phase 4: Parallel Idempotency Race (Double-Booking Replay Attack) ────
    console.log('\n── Phase 4: Parallel Idempotency Race (10 Microsecond Replays on 1 Key) ──');
    const attackerClient = clientUsers[0];
    const attackerToken = clientTokens[0];
    const sharedIdemKey = `race-idem-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

    const raceTasks = Array.from({ length: 10 }, () =>
      request(
        'POST',
        '/api/v2/labour/contracts/subscribe',
        {
          workerId: String(worker._id),
          subTier: 'L3_FULL_TIME_MONTHLY',
          workerCategory: 'HOMEMAKER_FULLTIME',
          agreedMonthlySalaryAmount: 12000,
          trialShiftFeeAmount: 350
        },
        attackerToken,
        sharedIdemKey
      )
    );

    const raceResults = await Promise.all(raceTasks);
    const raceOk = raceResults.filter((r) => r.status === 201 || (r.status === 200 && r.body?.data));
    console.log(`  Race Requests: 10 | Replayed Identical Key: ${sharedIdemKey}`);
    console.log(`  Successful Responses (Original + Cached Replays): ${raceOk.length}/10`);

    // Verify all successful responses returned the identical subscription ID
    const uniqueReturnedSubIds = new Set(raceOk.map((r) => r.body?.data?._id).filter(Boolean));
    console.log(`  🔍 Unique Contract IDs returned across all 10 parallel requests: ${uniqueReturnedSubIds.size} (MUST BE 1)`);

    if (uniqueReturnedSubIds.size !== 1) {
      throw new Error(`CRITICAL IDEMPOTENCY RACE FAILURE: Multiple distinct contracts were created for a single idempotency key!`);
    }

    const raceSubId = [...uniqueReturnedSubIds][0];
    createdSubIds.push(raceSubId);

    const totalTimesheetsForRace = await Timesheet.countDocuments({ subscriptionId: raceSubId });
    console.log(`  🔍 Timesheets created for race subscription: ${totalTimesheetsForRace} (MUST BE EXACTLY 1)`);

    if (totalTimesheetsForRace !== 1) {
      throw new Error(`CRITICAL RACE FAILURE: ${totalTimesheetsForRace} timesheets created instead of 1!`);
    }

    // ── Phase 5: 20 Concurrent Tier 1 Micro Dispatches (AC & Plumbing) ──────
    console.log('\n── Phase 5: 20 Concurrent Tier 1 Micro Dispatches ──');
    const microTasks = clientTokens.map((token, idx) =>
      request(
        'POST',
        '/api/v2/projects/micro/dispatch',
        {
          categoryCode: idx % 2 === 0 ? 'AC_MASTER_JET_WASH' : 'PLUMBING_LEAK_URGENT',
          thana: thanas[idx % thanas.length],
          floorLevel: (idx % 10) + 1,
          baseLaborBdt: 800,
          sparePartsBdt: idx === 19 ? 5000 : 600, // idx 19 triggers anti-collusion cash memo audit
          description: `Concurrent Micro Emergency Dispatch ${idx + 1}`
        },
        token
      )
    );

    const microStart = Date.now();
    const microResults = await Promise.all(microTasks);
    const microTotalDuration = Date.now() - microStart;

    const microLatencies = microResults.map((r) => r.duration);
    const microSuccesses = microResults.filter((r) => r.status === 201 && r.body?.status === 'success');
    const microStats = formatStats(microLatencies);

    console.log(`  Requests: 20 | Succeeded: ${microSuccesses.length}/20 (100%)`);
    console.log(`  Total Wall Time: ${microTotalDuration}ms | Throughput: ${Math.round((20 / microTotalDuration) * 1000)} req/s`);
    console.log(`  Latency (ms): min=${microStats.min} | mean=${microStats.mean} | p50=${microStats.p50} | p95=${microStats.p95} | p99=${microStats.p99} | max=${microStats.max}`);

    microSuccesses.forEach((r) => {
      if (r.body?.data?.project?._id) createdProjectIds.push(r.body.data.project._id);
    });

    const cashMemoFlagged = microSuccesses.filter((r) => r.body?.data?.requiresCashMemoAudit === true);
    console.log(`  🔍 Anti-Collusion Audit Triggered: ${cashMemoFlagged.length} request(s) correctly flagged`);

    const createdProjectsCount = await Project.countDocuments({ _id: { $in: createdProjectIds } });
    console.log(`  🔍 Invariant Check: Micro Projects created in DB: ${createdProjectsCount} (expected: 20)`);

    if (createdProjectsCount !== 20 || cashMemoFlagged.length !== 1) {
      throw new Error(`Micro Dispatch Concurrency Mismatch: projects=${createdProjectsCount}, cashMemo=${cashMemoFlagged.length}`);
    }

    console.log('\n🏆 HIGH-CONCURRENCY STRESS SUITE: 100% SUCCESS — ALL INVARIANTS INTACT');
  } finally {
    // Clean teardown
    console.log('\n🧹 Cleaning up test fixtures...');
    await Promise.all([
      User.deleteMany({ _id: { $in: createdUserIds } }),
      DomesticWorkerProfile.deleteMany({ userId: { $in: createdUserIds } }),
      LabourSubscription.deleteMany({ _id: { $in: createdSubIds } }),
      Timesheet.deleteMany({ subscriptionId: { $in: createdSubIds } }),
      Project.deleteMany({ _id: { $in: createdProjectIds } })
    ]);
    console.log('✅ Cleanup completed cleanly.');
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('\n❌ Fatal Stress Test Error:', err);
  process.exit(1);
});
