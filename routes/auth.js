// routes/auth.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const catchAsync = require('../utils/catchAsync');

// 🛡️ TIER-1 DEFENSE: Dedicated SMS rate limiter (3 requests per 15 minutes per IP)
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { status: 'error', message: 'Security Lockout: Too many OTP requests. Please wait 15 minutes.' }
});

// 🛡️ TIER-1 DEFENSE: OTP Brute-Force Limiter (Max 5 attempts per 15 minutes)
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { status: 'error', message: 'Security Lockout: Too many failed verification attempts.' }
});

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();
const hashOTP = (otp) => crypto.createHash('sha256').update(otp).digest('hex');

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
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  console.log(`\n📲 [SMS GATEWAY MOCK] OTP [ ****** ] dispatched securely to ${phoneNumber}\n`);

  res.status(200).json({
    status: 'success',
    message: 'OTP generated and sent successfully.'
  });
}));

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