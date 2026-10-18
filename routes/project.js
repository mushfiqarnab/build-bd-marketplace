// routes/project.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const Project = require('../models/Project');
const Bid = require('../models/Bid');
const { runTransaction } = require('../utils/transaction');
const { emitAudit } = require('../services/auditService');

function operational(message, statusCode) {
  return Object.assign(new Error(message), { statusCode, isOperational: true });
}

// Bangladesh bounding box with a small margin. Build-BD only serves
// Bangladesh, so coordinates outside it are almost always a lat/lng swap
// (e.g. 90.41, 23.81), which would silently break every GPS evidence check.
const BD_BOUNDS = { minLat: 20.3, maxLat: 26.8, minLng: 87.9, maxLng: 92.8 };

/** Returns { latitude, longitude } (both null when omitted). Throws 400. */
function parseSiteCoordinates(input) {
  if (input === undefined || input === null) return { latitude: null, longitude: null };
  if (typeof input !== 'object') throw operational('siteCoordinates must be an object with latitude and longitude.', 400);
  const hasLat = input.latitude !== undefined && input.latitude !== null && input.latitude !== '';
  const hasLng = input.longitude !== undefined && input.longitude !== null && input.longitude !== '';
  if (!hasLat && !hasLng) return { latitude: null, longitude: null };
  if (hasLat !== hasLng) throw operational('Provide both latitude and longitude, or neither.', 400);
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw operational('Latitude and longitude must be numbers.', 400);
  if (latitude < BD_BOUNDS.minLat || latitude > BD_BOUNDS.maxLat || longitude < BD_BOUNDS.minLng || longitude > BD_BOUNDS.maxLng) {
    throw operational('Site coordinates are outside Bangladesh. Check that latitude (≈20–27) and longitude (≈88–93) are not swapped.', 400);
  }
  return { latitude, longitude };
}

function parsePaging(query) {
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 20));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { limit, page, skip: (page - 1) * limit };
}

// @route   POST /api/projects
// @desc    Create a new project (RFQ)
// @access  Private (Only CLIENTS allowed)
router.post('/', verifyToken, requireRole(['CLIENT']), catchAsync(async (req, res, next) => {
  const { title, category, description, location, budget } = req.body;

  if (!title || !category || !description || !location || budget === undefined || budget === null) {
    return next(Object.assign(new Error('All project fields are required.'), {
      statusCode: 400,
      isOperational: true
    }));
  }

  // Integer BDT, consistent with the escrow money model.
  const safeBudget = Math.round(Number(budget));
  if (!Number.isFinite(safeBudget) || safeBudget < 0) {
    return next(Object.assign(new Error('Budget must be a non-negative number.'), {
      statusCode: 400,
      isOperational: true
    }));
  }

  let coords;
  try {
    coords = parseSiteCoordinates(req.body.siteCoordinates);
  } catch (err) {
    return next(err);
  }

  if (String(description).trim().length < 20) {
    return next(Object.assign(new Error('Description must be at least 20 characters for meaningful RFQ scoping.'), {
      statusCode: 400,
      isOperational: true
    }));
  }

  const project = await Project.create({
    clientId: req.user.userId,
    title: String(title).trim(),
    category,
    description: String(description).trim(),
    location: String(location).trim(),
    budget: safeBudget,
    // Previously dropped: the portal sent coordinates but they were never
    // saved, so GPS evidence verification could never match the site.
    siteCoordinates: coords
  });

  res.status(201).json({
    status: 'success',
    message: 'Project posted successfully',
    project
  });
}));

// @route   POST /api/projects/wizard-submit
// @desc    Submit project posted via Conversational Wizard (Phase 25)
// @access  Private (Only CLIENTS allowed)
router.post('/wizard-submit', verifyToken, requireRole(['CLIENT']), catchAsync(async (req, res, next) => {
  const { category, location, scopeDescription, priority } = req.body;

  if (!category || !location || !scopeDescription || !priority) {
    return next(Object.assign(new Error('Missing required conversational parameters: category, location, scopeDescription, priority.'), {
      statusCode: 400,
      isOperational: true
    }));
  }
  // Audit G14: these are used as strings below (regex escaping, title); a number/object used to crash with a 500.
  if ([category, location, scopeDescription, priority].some((v) => typeof v !== 'string')) {
    return next(operational('category, location, scopeDescription and priority must all be text.', 400));
  }
  if (location.length > 80) return next(operational('location is too long.', 400));
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(priority)) {
    return next(operational("priority must be 'LOW', 'MEDIUM' or 'HIGH'.", 400));
  }

  const cleanDescription = String(scopeDescription).trim();
  if (cleanDescription.length < 20) {
    return next(Object.assign(new Error('Scope description must be at least 20 characters for meaningful matching.'), {
      statusCode: 400,
      isOperational: true
    }));
  }

  // Map conversational values to standard Project model requirements
  // Conversational priority maps to project estimation parameters or budgets:
  // Low priority: 50,000 BDT, Medium: 250,000 BDT, High: 1,000,000 BDT
  let budget = 250000;
  if (priority === 'LOW') budget = 50000;
  if (priority === 'HIGH') budget = 1000000;

  const projectTitle = `${category} Work in ${location}`;

  // 1. Create and save the new Project document
  const project = await Project.create({
    clientId: req.user.userId,
    title: projectTitle,
    category,
    description: cleanDescription,
    location,
    budget,
    status: 'OPEN'
  });

  // 2. Perform a highly-optimized MongoDB Aggregation Pipeline against the ContractorProfile collection
  // to count exact matching contractors who serve this category and location.
  // Using $match stage on indexing fields, then projecting matching documents, and grouping to get count.

  // 🛡️ C-4 ReDoS Guard: Escape special regex metacharacters in user-supplied
  // location before constructing the RegExp. Raw input like "Dhaka+(bad|regex)"
  // would hang the aggregation pipeline thread on the MongoDB server.
  const escapedLocation = location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const contractorMatchPipeline = [
    {
      $match: {
        // Enforce verified status matching spec §8 requirements
        'verification.status': 'VERIFIED',
        serviceAreas: {
          $elemMatch: {
            district: new RegExp(`^${escapedLocation}$`, 'i')
          }
        }
      }
    },
    {
      $count: 'matchCount'
    }
  ];

  const matchStats = await mongoose.model('ContractorProfile').aggregate(contractorMatchPipeline);
  const matchCount = matchStats.length > 0 ? matchStats[0].matchCount : 0;

  res.status(201).json({
    status: 'success',
    message: 'Project successfully created via Conversational Matching Wizard.',
    projectId: project._id,
    matchCount
  });
}));

// @route   POST /api/projects/:id/cancel
// @desc    Client closes their own OPEN project (nobody hired yet). Pending bids are rejected. Idempotent:
//          cancelling an already-cancelled project answers 200. Once a contractor is hired the contract
//          (escrow) governs the project and it can no longer be cancelled here. (Audit K1)
// @access  Private (CLIENT who owns the project)
router.post('/:id/cancel', verifyToken, requireRole(['CLIENT']), catchAsync(async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next(operational('Project not found.', 404));

  const outcome = await runTransaction(async (session) => {
    const closed = await Project.findOneAndUpdate(
      { _id: req.params.id, clientId: req.user.userId, status: 'OPEN' },
      { $set: { status: 'CANCELLED' } },
      { session, returnDocument: 'after' }
    );
    if (!closed) {
      const p = await Project.findOne({ _id: req.params.id, clientId: req.user.userId }).select('status').session(session).lean();
      if (!p) throw operational('Project not found.', 404);
      if (p.status === 'CANCELLED') return { already: true };
      throw operational(`Only an open project can be cancelled. This one is ${p.status}.`, 409);
    }
    const rejected = await Bid.updateMany({ projectId: closed._id, status: 'PENDING' }, { $set: { status: 'REJECTED' } }, { session });
    await emitAudit({
      session,
      entityId: closed._id,
      entityType: 'PROJECT',
      action: 'PROJECT_CANCELLED',
      actorId: req.user.userId,
      actorRole: req.user.role,
      metadata: { rejectedBids: rejected.modifiedCount },
      ipAddress: req.ip || 'SYSTEM_INTERNAL'
    });
    return { already: false, rejectedBids: rejected.modifiedCount };
  });

  res.status(200).json({ status: 'success', message: outcome.already ? 'Project was already cancelled.' : 'Project cancelled.', data: outcome });
}));

// @route   GET /api/projects/open
// @desc    Contractor demand feed (OPEN RFQs only; no competitor bid amounts)
// @access  Private (CONTRACTOR)
router.get('/open', verifyToken, requireRole(['CONTRACTOR']), catchAsync(async (req, res) => {
  const { category, page = 1, limit = 20 } = req.query;
  const parsedLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const skip = (parsedPage - 1) * parsedLimit;

  const filter = { status: 'OPEN' };
  if (category) filter.category = category;

  const [projectsRaw, total] = await Promise.all([
    Project.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .select('title category description location budget status siteCoordinates createdAt')
      .lean(),
    Project.countDocuments(filter)
  ]);

  const projects = projectsRaw.map((p) => {
    const { siteCoordinates, ...rest } = p;
    return {
      ...rest,
      hasSiteCoordinates: Boolean(siteCoordinates && siteCoordinates.latitude !== null && siteCoordinates.longitude !== null)
    };
  });

  res.status(200).json({
    status: 'success',
    metrics: {
      total,
      currentPage: parsedPage,
      totalPages: Math.ceil(total / parsedLimit) || 0
    },
    projects
  });
}));

// @route   GET /api/projects/mine
// @desc    The signed-in client's own projects, newest first, with live
//          bid counts (withdrawn / tamper-flagged bids excluded).
// @access  Private (CLIENT)
router.get('/mine', verifyToken, requireRole(['CLIENT']), catchAsync(async (req, res) => {
  const { limit, page, skip } = parsePaging(req.query);
  const filter = { clientId: req.user.userId };
  if (req.query.status) filter.status = String(req.query.status);

  const [projects, total] = await Promise.all([
    Project.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('title category location budget status awardedContractorId createdAt updatedAt')
      .lean(),
    Project.countDocuments(filter)
  ]);

  const counts = projects.length
    ? await Bid.aggregate([
      { $match: { projectId: { $in: projects.map((p) => p._id) }, status: { $in: ['PENDING', 'ACCEPTED'] } } },
      { $group: { _id: '$projectId', n: { $sum: 1 } } }
    ])
    : [];
  const countById = new Map(counts.map((c) => [String(c._id), c.n]));

  res.status(200).json({
    status: 'success',
    metrics: { total, currentPage: page, totalPages: Math.ceil(total / limit) || 0 },
    projects: projects.map((p) => ({ ...p, bidCount: countById.get(String(p._id)) || 0 }))
  });
}));

// @route   GET /api/projects/:id
// @desc    One project. Owner, awarded contractor and staff see everything
//          including exact site coordinates. Other contractors see OPEN
//          projects without exact coordinates. Everyone else gets 404, so a
//          private project's existence is not revealed.
// @access  Private
router.get('/:id', verifyToken, catchAsync(async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(operational('Project not found.', 404));
  }
  const project = await Project.findById(req.params.id)
    .select('clientId title category description location budget status awardedContractorId siteCoordinates createdAt updatedAt')
    .lean();
  if (!project) return next(operational('Project not found.', 404));

  const { userId, role } = req.user;
  const isOwner = String(project.clientId) === userId;
  const isAwarded = project.awardedContractorId && String(project.awardedContractorId) === userId;
  const isStaff = role === 'ADMIN' || role === 'MODERATOR';

  let myBid = null;
  if (role === 'CONTRACTOR') {
    myBid = await Bid.findOne({ projectId: project._id, contractorId: userId })
      .select('bidAmount estimatedDays proposalText itemizedBreakdown status bidFingerprint cryptographicProof createdAt updatedAt')
      .lean();
  }

  const fullAccess = isOwner || isAwarded || isStaff;
  if (!fullAccess && !(role === 'CONTRACTOR' && (project.status === 'OPEN' || myBid))) {
    return next(operational('Project not found.', 404));
  }

  const body = {
    _id: project._id,
    title: project.title,
    category: project.category,
    description: project.description,
    location: project.location,
    budget: project.budget,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    hasSiteCoordinates: project.siteCoordinates && project.siteCoordinates.latitude !== null
  };
  if (fullAccess) {
    body.siteCoordinates = project.siteCoordinates;
    body.awardedContractorId = project.awardedContractorId;
  }
  if (isOwner || isStaff) {
    body.bidCount = await Bid.countDocuments({ projectId: project._id, status: { $in: ['PENDING', 'ACCEPTED'] } });
  }
  if (myBid) body.myBid = myBid;

  res.status(200).json({ status: 'success', project: body, access: fullAccess ? 'full' : 'public' });
}));

module.exports = router;
module.exports.parseSiteCoordinates = parseSiteCoordinates;