// middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const catchAsync = require('../utils/catchAsync');

// 🛡️ DYNAMIC HARDENING LAYER: Token & DB State Verification
const verifyToken = catchAsync(async (req, res, next) => {
  let token;
  
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(Object.assign(new Error('Authentication token missing.'), { statusCode: 401, isOperational: true }));
  }

  let decoded;
  try {
    // 🛡️ ARCHITECTURAL FIX: Isolate native cryptographic errors and map them to our Global Boundary
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (jwtError) {
    const message = jwtError.name === 'TokenExpiredError' 
      ? 'Your session has expired. Please log in again.' 
      : 'Invalid authentication signature.';
    return next(Object.assign(new Error(message), { statusCode: 401, isOperational: true }));
  }
  
  // 🚀 FUTURISTIC ADVANCEMENT: .lean() bypasses Mongoose memory hydration for raw V8 speed
  const activeUser = await User.findById(decoded.userId).select('status role').lean();
  
  if (!activeUser || activeUser.status !== 'ACTIVE') {
    return next(Object.assign(new Error('Access Denied: This account is suspended or unverified.'), { statusCode: 403, isOperational: true }));
  }

  // Inject sanitized user identity into the request pipeline
  // activeUser._id is technically a MongoDB ObjectId here due to .lean(), so we safely cast it to a String
  req.user = { userId: String(activeUser._id), role: activeUser.role };
  next();
});

// 🛡️ ROLE-BASED ACCESS CONTROL (RBAC) GATE
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(Object.assign(new Error(`Unauthorized Access. Required system clearance: ${roles.join(' or ')}`), { statusCode: 403, isOperational: true }));
    }
    next();
  };
};

module.exports = { verifyToken, requireRole };