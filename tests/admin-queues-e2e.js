// tests/admin-queues-e2e.js
// Read-only queues the launch screens need:
//   GET /api/moderation/disputes          (MODERATOR | ADMIN) — open first-come-first-served, filters
//   GET /api/contractor-profile/pending   (ADMIN) — contractors awaiting verification
//   GET /api/finance/withdrawals          (CONTRACTOR | CLIENT) — own rows only, account number masked
'use strict';

const dotenv = require('dotenv');
dotenv.config();
process.env.PORT = '0';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

const User = require('../models/User');
const DisputeTicket = require('../models/DisputeTicket');
const ContractorProfile = require('../models/ContractorProfile');
const WithdrawalLedger = require('../models/WithdrawalLedger');

const PHONE_PREFIX = '0199121';
let seq = 0;
const phone = () => `${PHONE_PREFIX}${String(seq++).padStart(4, '0')}`;
let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failed += 1; console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function main() {
  if (!appServer.listening) await new Promise((r) => appServer.once('listening', r));
  const base = `http://127.0.0.1:${appServer.address().port}/api`;
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('🧪 admin / moderator / contractor queues');

  const mk = (role) => User.create({ role, phoneNumber: phone(), status: 'ACTIVE' });
  const [admin, moderator, client, a, b] = await Promise.all([mk('ADMIN'), mk('MODERATOR'), mk('CLIENT'), mk('CONTRACTOR'), mk('CONTRACTOR')]);
  const tok = (u) => jwt.sign({ userId: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const get = async (path, user) => {
    const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${tok(user)}` } });
    return { status: r.status, body: await r.json().catch(() => null), raw: r };
  };

  const ids = { tickets: [], profiles: [], withdrawals: [] };
  try {
    // ── Disputes ─────────────────────────────────────────────────────────────
    const ticket = (status, ageMin) => DisputeTicket.create({
      projectId: new mongoose.Types.ObjectId(), ledgerId: new mongoose.Types.ObjectId(), milestoneIndex: 0,
      clientId: client._id, contractorId: a._id, clientRejectionReason: 'Work does not match the drawings.', status,
      createdAt: new Date(Date.now() - ageMin * 60000)
    });
    const older = await ticket('OPEN_FOR_REVIEW', 30);
    const newer = await ticket('MEDIATION_IN_PROGRESS', 5);
    const done = await ticket('RESOLVED_CANCELLED', 60);
    ids.tickets.push(older._id, newer._id, done._id);

    check('contractor cannot see the dispute queue (403)', (await get('/moderation/disputes', a)).status === 403);
    const open = await get('/moderation/disputes', moderator);
    const openIds = (open.body?.data?.disputes || []).map((d) => String(d.ticketId)).filter((id) => ids.tickets.map(String).includes(id));
    check('moderator sees open tickets only, oldest first', open.status === 200 && openIds.join() === [older._id, newer._id].map(String).join(), JSON.stringify(openIds));
    const resolved = await get('/moderation/disputes?status=resolved', admin);
    const resolvedIds = (resolved.body?.data?.disputes || []).map((d) => String(d.ticketId));
    check('resolved filter returns resolved tickets', resolvedIds.includes(String(done._id)) && !resolvedIds.includes(String(older._id)));

    // ── Verification queue ──────────────────────────────────────────────────
    const pa = await ContractorProfile.create({ userId: a._id, businessType: 'INDIVIDUAL', fullName: 'Pending Contractor', verification: { status: 'PENDING' } });
    const pb = await ContractorProfile.create({ userId: b._id, businessType: 'COMPANY', fullName: 'Verified Contractor', verification: { status: 'VERIFIED' } });
    ids.profiles.push(pa._id, pb._id);
    check('client cannot see the verification queue (403)', (await get('/contractor-profile/pending', client)).status === 403);
    check('moderator cannot see the verification queue (403)', (await get('/contractor-profile/pending', moderator)).status === 403);
    const pending = await get('/contractor-profile/pending', admin);
    const rows = pending.body?.data?.profiles || [];
    const rowA = rows.find((p) => String(p.userId) === String(a._id));
    check('admin sees the pending contractor with phone and name', pending.status === 200 && rowA && rowA.phoneNumber === a.phoneNumber && rowA.fullName === 'Pending Contractor');
    check('verified contractors are not in the queue', !rows.some((p) => String(p.userId) === String(b._id)));

    // ── Withdrawal history ──────────────────────────────────────────────────
    const bank = (n) => ({ accountName: 'Test', accountNumber: n, routingNumber: '090261234', bankName: 'Fuzz Bank' });
    const w = (user, amount, acct, status) => WithdrawalLedger.create({ userId: user._id, amount, destinationBankDetails: bank(acct), idempotencyKey: `q-${seq++}-${Date.now()}`, status });
    ids.withdrawals.push(...(await Promise.all([w(a, 1000, '00112233445566', 'COMPLETED'), w(a, 700, '00112233445566', 'FAILED'), w(b, 900, '99887766554433', 'PROCESSING')])).map((x) => x._id));
    // Audit G4: clients hold withdrawable money too (dispute refunds), so they may list THEIR OWN withdrawals;
    // staff roles have no wallet flow and stay refused.
    const clientList = await get('/finance/withdrawals', client);
    check('client may list their own withdrawals (200, none yet)', clientList.status === 200 && (clientList.body?.data?.withdrawals || []).length === 0);
    check('moderator cannot list withdrawals (403)', (await get('/finance/withdrawals', moderator)).status === 403);
    const mine = await get('/finance/withdrawals', a);
    const list = mine.body?.data?.withdrawals || [];
    check('contractor sees only their own withdrawals', mine.status === 200 && list.length === 2 && list.every((x) => [1000, 700].includes(x.amount)), JSON.stringify(list.map((x) => x.amount)));
    check('account number is masked to the last 4 digits', list.every((x) => x.accountLast4 === '5566'));
    check('the full account number never leaves the server', !JSON.stringify(mine.body).includes('00112233445566'));
  } finally {
    await DisputeTicket.deleteMany({ _id: { $in: ids.tickets } });
    await ContractorProfile.deleteMany({ _id: { $in: ids.profiles } });
    await WithdrawalLedger.deleteMany({ _id: { $in: ids.withdrawals } });
    await User.deleteMany({ phoneNumber: { $regex: new RegExp(`^${PHONE_PREFIX}`) } });
  }

  console.log(failed ? `--- Results: ${failed} failed ---` : '--- Results: all passed ---');
  return failed ? 1 : 0;
}

main()
  .then(async (code) => { await mongoose.connection.close().catch(() => {}); appServer.close(); process.exit(code); })
  .catch(async (err) => { console.error('💥 admin queues e2e crashed:', err); await mongoose.connection.close().catch(() => {}); process.exit(1); });
