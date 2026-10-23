// scripts/switch-user-role.js
'use strict';
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
require('../models/User');
const User = mongoose.model('User');

const phone = process.argv[2] || '01610906072';
const targetRole = (process.argv[3] || 'CONTRACTOR').toUpperCase();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  await User.collection.updateOne(
    { phoneNumber: phone },
    { $set: { role: targetRole } }
  );
  const updated = await User.collection.findOne({ phoneNumber: phone });
  console.log('Updated user:', updated ? { id: updated._id, phone: updated.phoneNumber, role: updated.role } : 'Not found');
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
