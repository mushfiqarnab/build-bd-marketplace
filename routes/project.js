// routes/project.js
const express = require('express');
const TRADE_MICRO_CATEGORIES = [
  'Electrical', 'Plumbing', 'AC & Appliance', 'Painting',
  'Carpentry & Woodwork', 'Masonry & Tiles', 'Welding & Fabrication',
  'Shifting & Movers', 'Cleaning & Pest Control', 'CCTV & Smart Security',
  'Domestic Care'
];

const router = express.Router();
const mongoose = require('mongoose');
const { verifyToken, optionalAuth, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const Project = require('../models/Project');
const Bid = require('../models/Bid');
const { runTransaction } = require('../utils/transaction');
const { emitAudit } = require('../services/auditService');
const crypto = require('crypto');
const ProjectShareToken = require('../models/ProjectShareToken');
const EscrowLedger = require('../models/EscrowLedger');
const MaterialOrder = require('../models/MaterialOrder');

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

  // Integer BDT, consistent with the escrow money model and models/Project.js min: 200/1000.
  const safeBudget = Math.round(Number(budget));
  const isMicroTrade = TRADE_MICRO_CATEGORIES.includes(category);
  const minFloor = isMicroTrade ? 200 : 1000;
  if (isMicroTrade ? safeBudget < 200 : safeBudget < 1000) {
    return next(Object.assign(new Error(`Minimum budget allocation is ${minFloor} BDT.`), {
      statusCode: 400,
      isOperational: true
    }));
  }

  let coords = null;
  if (req.body.siteCoordinates || !isMicroTrade) {
    try {
      coords = parseSiteCoordinates(req.body.siteCoordinates);
    } catch (err) {
      if (!isMicroTrade) return next(err);
    }
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

  // 🛡️ Roadmap §1.5: Capture and validate siteCoordinates so conversational projects
  // qualify for top-tier cryptographic EXIF evidence verification.
  let coords;
  try {
    coords = parseSiteCoordinates(req.body.siteCoordinates);
  } catch (err) {
    return next(err);
  }

  // 1. Create and save the new Project document
  const project = await Project.create({
    clientId: req.user.userId,
    title: projectTitle,
    category,
    description: cleanDescription,
    location,
    budget,
    status: 'OPEN',
    siteCoordinates: coords
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

// Helper to construct ReDoS-safe query filters across category, nature, thana, keywords, and integer BDT budget ranges
function buildProjectsFilter(query) {
  const { category, thana, q, minBudget, maxBudget, nature } = query;
  const filter = { status: 'OPEN' };

  let explicitCategory = null;
  if (category && typeof category === 'string' && category.trim()) {
    explicitCategory = category.trim();
    filter.category = explicitCategory;
  } else if (nature && typeof nature === 'string') {
    const n = nature.toUpperCase();
    if (n === 'WORKS') {
      filter.category = { $in: ['Residential', 'Commercial', 'Infrastructure'] };
    } else if (n === 'RENOVATION') {
      filter.category = { $in: ['Renovation', 'Interior'] };
    } else if (n === 'TRADES' || n === 'MICRO' || n === 'MICRO_TRADES') {
      filter.category = { $in: TRADE_MICRO_CATEGORIES };
    } else if (n === 'SERVICES') {
      filter.category = { $in: ['Domestic Care'] };
    }
  }

  // Location scoping: explicit thana takes precedence
  let effectiveThana = (thana && typeof thana === 'string' && thana.trim()) ? thana.trim() : null;

  if (q && typeof q === 'string' && q.trim()) {
    const rawQ = q.trim();
    const escaped = rawQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Tokenize words, filtering out common conversational stop words in EN & BN
    const STOP_WORDS = new Set([
      'in', 'at', 'on', 'of', 'for', 'to', 'the', 'a', 'an', 'and', 'or', 'is', 'are',
      'need', 'problem', 'issue', 'urgent', 'emergency', 'chai', 'lagbe', 'ase', 'ache',
      'দরকার', 'সমস্যা', 'লাগে', 'এর', 'মধ্যে', 'জরুরি', 'চাই'
    ]);

    const words = rawQ
      .split(/[\s,.-]+/)
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));

    // Inferred categories from trade keywords if not locked
    const inferredCategories = [];
    if (/ac|air\s*con|cooling|chiller|jet\s*wash|গ্যাস/i.test(rawQ)) inferredCategories.push('AC & Appliance');
    if (/plumb|pipe|leak|flush|valve|commode|tap|basin|water|drain|পাইপ|লিক|কল/i.test(rawQ)) inferredCategories.push('Plumbing');
    if (/electr|wiring|breaker|tripping|short\s*circuit|mcb|220v|কারেন্ট|ওয়্যারিং/i.test(rawQ)) inferredCategories.push('Electrical');
    if (/paint|colour|damp|fungal|emulsion|asian\s*paints|রং|রংমিস্ত্রি/i.test(rawQ)) inferredCategories.push('Painting');
    if (/carpent|wood|timber|cabinet|plywood|কাঠ|কার্পেন্টার/i.test(rawQ)) inferredCategories.push('Carpentry & Woodwork');
    if (/mason|tiles|rajmistri|brick\s*work|টাইলস|রাজমিস্ত্রি/i.test(rawQ)) inferredCategories.push('Masonry & Tiles');
    if (/weld|grill|steel\s*fab|ওয়েল্ডিং|গ্রিল/i.test(rawQ)) inferredCategories.push('Welding & Fabrication');
    if (/shift|mover|relocat|বাসা\s*বদল/i.test(rawQ)) inferredCategories.push('Shifting & Movers');
    if (/pest|termite|deep\s*clean|water\s*tank|ট্যাংক|পোকা/i.test(rawQ)) inferredCategories.push('Cleaning & Pest Control');
    if (/cctv|camera|intercom|access\s*control|সিসিটিভি|ক্যামেরা/i.test(rawQ)) inferredCategories.push('CCTV & Smart Security');
    if (/architect|soil\s*test|structural\s*design|rajuk|নকশা|প্ল্যান/i.test(rawQ)) inferredCategories.push('Architecture & Engineering');
    if (/maid|bua|cook|clean|baby|elderly|driver|কেয়ার|বুয়া|বাবুর্চি|কেয়ার/i.test(rawQ)) inferredCategories.push('Domestic Care');
    if (/kitchen|cabinet|renovat|interior|tile|টাইলস|সংস্কার/i.test(rawQ)) inferredCategories.push('Renovation', 'Interior');
    if (/rebar|rod|cement|rcc|column|slab|building|civil|রড|সিমেন্ট|ছাদ|বিল্ডিং/i.test(rawQ)) inferredCategories.push('Residential', 'Commercial', 'Infrastructure');

    // Inferred Dhaka thanas: used for location scoping ($and) rather than polluting $or
    const KNOWN_THANAS = ['Mirpur', 'Dhanmondi', 'Gulshan', 'Uttara', 'Banani', 'Mohammadpur', 'Bashundhara', 'Motijheel', 'Agrabad', 'Sylhet'];
    const matchedThana = KNOWN_THANAS.find((th) => new RegExp(`\\b${th}\\b`, 'i').test(rawQ));
    if (!effectiveThana && matchedThana) {
      effectiveThana = matchedThana;
    }

    // Construct resilient $or clause matching across title and description
    const orClauses = [
      { title: { $regex: escaped, $options: 'i' } },
      { description: { $regex: escaped, $options: 'i' } }
    ];

    if (words.length > 0) {
      const asciiWords = [];
      const unicodeWords = [];
      for (const w of words) {
        const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (/^[\x00-\x7F]+$/.test(w)) {
          asciiWords.push(esc);
        } else {
          unicodeWords.push(esc);
        }
      }

      const patterns = [];
      if (asciiWords.length > 0) patterns.push(`\\b(${asciiWords.join('|')})\\b`);
      if (unicodeWords.length > 0) patterns.push(`(${unicodeWords.join('|')})`);

      if (patterns.length > 0) {
        const wordPattern = patterns.join('|');
        orClauses.push({ title: { $regex: wordPattern, $options: 'i' } });
        orClauses.push({ description: { $regex: wordPattern, $options: 'i' } });
      }
    }

    if (inferredCategories.length > 0 && !explicitCategory) {
      orClauses.push({ category: { $in: inferredCategories } });
    }

    filter.$or = orClauses;
  }

  if (effectiveThana) {
    const escapedThana = effectiveThana.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.location = { $regex: escapedThana, $options: 'i' };
  }

  const parsedMin = parseInt(minBudget, 10);
  const parsedMax = parseInt(maxBudget, 10);
  if (Number.isFinite(parsedMin) || Number.isFinite(parsedMax)) {
    filter.budget = {};
    if (Number.isFinite(parsedMin) && parsedMin >= 0) filter.budget.$gte = parsedMin;
    if (Number.isFinite(parsedMax) && parsedMax >= 0) filter.budget.$lte = parsedMax;
  }

  return filter;
}

function parseSortOrder(sort) {
  if (sort === 'budget_desc') return { budget: -1, createdAt: -1 };
  if (sort === 'budget_asc') return { budget: 1, createdAt: -1 };
  return { createdAt: -1 };
}

async function queryOpenProjects(query) {
  const { page = 1, limit = 20, sort } = query;
  const parsedLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const skip = (parsedPage - 1) * parsedLimit;

  const filter = buildProjectsFilter(query);
  const sortOrder = parseSortOrder(sort);

  const [projectsRaw, total] = await Promise.all([
    Project.find(filter)
      .sort(sortOrder)
      .skip(skip)
      .limit(parsedLimit)
      .select('title category description location budget status siteCoordinates createdAt updatedAt')
      .lean(),
    Project.countDocuments(filter)
  ]);

  const projectIds = projectsRaw.map((p) => p._id);
  const counts = projectIds.length
    ? await Bid.aggregate([
      { $match: { projectId: { $in: projectIds }, status: { $in: ['PENDING', 'ACCEPTED'] } } },
      { $group: { _id: '$projectId', n: { $sum: 1 } } }
    ])
    : [];
  const bidCountMap = new Map(counts.map((c) => [String(c._id), c.n]));

  const projects = projectsRaw.map((p) => {
    const { siteCoordinates, ...rest } = p;
    return {
      ...rest,
      bidCount: bidCountMap.get(String(p._id)) || 0,
      hasSiteCoordinates: Boolean(siteCoordinates && siteCoordinates.latitude !== null && siteCoordinates.longitude !== null)
    };
  });

  return {
    metrics: {
      total,
      currentPage: parsedPage,
      totalPages: Math.ceil(total / parsedLimit) || 0
    },
    projects
  };
}

// @route   GET /api/projects/exchange
// @desc    Public categorized works exchange feed (OPEN RFQs; keyword, category, thana, budget range)
// @access  Public (optionalAuth)
router.get('/exchange', optionalAuth, catchAsync(async (req, res) => {
  const result = await queryOpenProjects(req.query);
  res.status(200).json({ status: 'success', ...result });
}));

// @route   GET /api/projects/feed
// @desc    Public categorized works exchange feed (backward compatibility alias)
// @access  Public (optionalAuth)
router.get('/feed', optionalAuth, catchAsync(async (req, res) => {
  const result = await queryOpenProjects(req.query);
  res.status(200).json({ status: 'success', ...result });
}));

// @route   GET /api/projects/open
// @desc    Contractor demand feed (OPEN RFQs only; no competitor bid amounts)
// @access  Private (CONTRACTOR)
router.get('/open', verifyToken, requireRole(['CONTRACTOR']), catchAsync(async (req, res) => {
  const result = await queryOpenProjects(req.query);
  res.status(200).json({ status: 'success', ...result });
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

// ─────────────────────────────────────────────────────────────────────────────
// 🇧🇩 PROBASHI MODE & MULTI-PROJECT GOVERNANCE (Phase 2)
// ─────────────────────────────────────────────────────────────────────────────

// @route   GET /api/projects/my-projects
// @desc    Probashi multi-project governance dashboard. Groups projects,
//          computes aggregated EscrowLedger committed & released taka, live bid queues,
//          unacknowledged material variances, and active delegation tokens.
// @access  Private (CLIENT)
router.get('/my-projects', verifyToken, requireRole(['CLIENT']), catchAsync(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const parsedLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const skip = (parsedPage - 1) * parsedLimit;

  const filter = { clientId: req.user.userId };
  if (status) filter.status = String(status);

  const [projectsRaw, total] = await Promise.all([
    Project.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .select('title category description location budget status awardedContractorId siteCoordinates createdAt updatedAt')
      .lean(),
    Project.countDocuments(filter)
  ]);

  const projectIds = projectsRaw.map((p) => p._id);

  // Parallel fetch of Ledgers, Bids, Material Orders, and Share Tokens
  const [ledgers, bids, materialOrders, shareTokens] = await Promise.all([
    EscrowLedger.find({ projectId: { $in: projectIds } }).lean(),
    Bid.find({ projectId: { $in: projectIds }, status: { $in: ['PENDING', 'ACCEPTED'] } })
      .select('projectId status bidAmount contractorId createdAt')
      .lean(),
    MaterialOrder.find({ projectId: { $in: projectIds } })
      .select('projectId status totalAmountBDT orderNumber items plannedBrand plannedQuantity siteDeliveryPhotoUrl createdAt')
      .lean(),
    ProjectShareToken.find({
      projectId: { $in: projectIds },
      clientUserId: req.user.userId,
      isRevoked: false,
      expiresAt: { $gt: new Date() }
    })
      .select('projectId scopedRole delegateName delegatePhone hideFinancials expiresAt createdAt')
      .lean()
  ]);

  const ledgersByProject = new Map(ledgers.map((l) => [String(l.projectId), l]));
  const bidsByProject = new Map();
  for (const b of bids) {
    const pid = String(b.projectId);
    if (!bidsByProject.has(pid)) bidsByProject.set(pid, []);
    bidsByProject.get(pid).push(b);
  }

  const materialsByProject = new Map();
  for (const mo of materialOrders) {
    const pid = String(mo.projectId);
    if (!materialsByProject.has(pid)) materialsByProject.set(pid, []);
    materialsByProject.get(pid).push(mo);
  }

  const sharesByProject = new Map();
  for (const s of shareTokens) {
    const pid = String(s.projectId);
    if (!sharesByProject.has(pid)) sharesByProject.set(pid, []);
    sharesByProject.get(pid).push(s);
  }

  let totalCommittedBDT = 0;
  let totalReleasedBDT = 0;
  let activeContractsCount = 0;
  let pendingActionsCount = 0;

  const decoratedProjects = projectsRaw.map((p) => {
    const pid = String(p._id);
    const ledger = ledgersByProject.get(pid) || null;
    const projectBids = bidsByProject.get(pid) || [];
    const projectMaterials = materialsByProject.get(pid) || [];
    const projectShares = sharesByProject.get(pid) || [];

    const unreviewedBidsCount = projectBids.filter((b) => b.status === 'PENDING').length;
    let pendingProofsCount = 0;
    let ledgerCommitted = 0;
    let ledgerReleased = 0;

    if (ledger) {
      if (ledger.ledgerStatus !== 'CANCELLED') {
        activeContractsCount += 1;
        ledgerCommitted = ledger.totalContractValue || 0;
        totalCommittedBDT += ledgerCommitted;
      }
      for (const m of ledger.milestones || []) {
        if (m.status === 'COMPLETED') {
          ledgerReleased += m.amount || 0;
        } else if (m.status === 'PROOF_SUBMITTED') {
          pendingProofsCount += 1;
        }
      }
      totalReleasedBDT += ledgerReleased;
    }

    let unacknowledgedVariances = 0;
    for (const mo of projectMaterials) {
      let hasVar = false;
      if (mo.plannedBrand) {
        const plannedNorm = mo.plannedBrand.toLowerCase().trim();
        for (const it of mo.items || []) {
          if (it.brand && it.brand.toLowerCase().trim() !== plannedNorm) {
            hasVar = true;
            break;
          }
        }
      }
      if (!hasVar && mo.plannedQuantity !== null && mo.plannedQuantity !== undefined) {
        const totalOrdered = (mo.items || []).reduce((sum, it) => sum + (it.quantity || 0), 0);
        if (totalOrdered > mo.plannedQuantity) hasVar = true;
      }
      if (!hasVar && (mo.status === 'DELIVERED' || mo.status === 'COMPLETED') && !mo.siteDeliveryPhotoUrl) {
        hasVar = true;
      }
      if (hasVar) unacknowledgedVariances += 1;
    }
    const actionRequired = unreviewedBidsCount + pendingProofsCount + unacknowledgedVariances;
    pendingActionsCount += actionRequired;

    return {
      _id: p._id,
      title: p.title,
      category: p.category,
      location: p.location,
      budget: p.budget,
      status: p.status,
      awardedContractorId: p.awardedContractorId,
      hasSiteCoordinates: Boolean(p.siteCoordinates && p.siteCoordinates.latitude !== null),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      financials: {
        committedBDT: ledgerCommitted,
        releasedBDT: ledgerReleased,
        remainingBDT: Math.max(0, ledgerCommitted - ledgerReleased)
      },
      queue: {
        bidsCount: projectBids.length,
        unreviewedBidsCount,
        pendingProofsCount,
        materialsCount: projectMaterials.length,
        variancesCount: unacknowledgedVariances,
        actionRequired
      },
      activeShares: projectShares.map((s) => ({
        _id: s._id,
        scopedRole: s.scopedRole,
        delegateName: s.delegateName,
        delegatePhone: s.delegatePhone,
        hideFinancials: s.hideFinancials,
        expiresAt: s.expiresAt
      }))
    };
  });

  res.status(200).json({
    status: 'success',
    metrics: {
      total,
      currentPage: parsedPage,
      totalPages: Math.ceil(total / parsedLimit) || 0
    },
    summary: {
      totalProjectsCount: total,
      activeContractsCount,
      totalCommittedBDT,
      totalReleasedBDT,
      pendingActionsCount
    },
    projects: decoratedProjects
  });
}));

// @route   GET /api/projects/shared/:rawToken
// @desc    Public delegate view via 32-byte secret token. Enforces role-based financial redaction.
// @access  Public (Token-authenticated)
router.get('/shared/:rawToken', catchAsync(async (req, res, next) => {
  const { rawToken } = req.params;
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 32) {
    return next(operational('Invalid delegation token format.', 400));
  }

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const share = await ProjectShareToken.findOne({
    tokenHash,
    isRevoked: false,
    expiresAt: { $gt: new Date() }
  }).lean();

  if (!share) {
    return next(operational('Share link is invalid, expired, or has been revoked by the owner.', 404));
  }

  const project = await Project.findById(share.projectId)
    .select('title category description location budget status siteCoordinates awardedContractorId createdAt updatedAt')
    .lean();

  if (!project) return next(operational('Project not found.', 404));

  const [ledger, materialOrders] = await Promise.all([
    EscrowLedger.findOne({ projectId: project._id }).lean(),
    MaterialOrder.find({ projectId: project._id })
      .select('orderNumber items totalAmountBDT status logistics createdAt')
      .lean()
  ]);

  // Strip financial figures if hideFinancials is true
  const hideFinancials = share.hideFinancials === true;

  const sanitizedProject = {
    _id: project._id,
    title: project.title,
    category: project.category,
    description: project.description,
    location: project.location,
    budget: hideFinancials ? null : project.budget,
    status: project.status,
    hasSiteCoordinates: Boolean(project.siteCoordinates && project.siteCoordinates.latitude !== null),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };

  let sanitizedLedger = null;
  if (ledger) {
    sanitizedLedger = {
      ledgerStatus: ledger.ledgerStatus,
      totalContractValue: hideFinancials ? null : ledger.totalContractValue,
      milestones: (ledger.milestones || []).map((m, idx) => ({
        index: idx,
        title: m.title,
        description: m.description,
        status: m.status,
        amount: hideFinancials ? null : m.amount,
        evidenceCount: m.evidenceLog ? m.evidenceLog.length : 0,
        evidenceLog: (m.evidenceLog || []).map((e) => ({
          submittedAt: e.submittedAt,
          capturedAt: e.capturedAt,
          exifVerified: e.exifVerified,
          gpsVerified: e.gpsVerified
        }))
      }))
    };
  }

  const sanitizedMaterials = (materialOrders || []).map((mo) => ({
    orderNumber: mo.orderNumber,
    items: (mo.items || []).map((it) => ({
      category: it.category,
      title: it.title,
      brand: it.brand,
      quantity: it.quantity,
      unit: it.unit,
      unitPriceBDT: hideFinancials ? null : it.unitPriceBDT,
      totalPriceBDT: hideFinancials ? null : (it.totalPriceBDT ?? it.subtotalBDT),
      subtotalBDT: hideFinancials ? null : (it.totalPriceBDT ?? it.subtotalBDT)
    })),
    status: mo.status,
    totalAmountBDT: hideFinancials ? null : mo.totalAmountBDT,
    logistics: mo.logistics || {},
    waybill: mo.logistics?.challanNumber || null,
    deliveredAt: mo.logistics?.deliveredAt || null,
    createdAt: mo.createdAt
  }));

  res.status(200).json({
    status: 'success',
    data: {
      project: sanitizedProject,
      ledger: sanitizedLedger,
      materialOrders: sanitizedMaterials,
      share: {
        scopedRole: share.scopedRole,
        delegateName: share.delegateName,
        hideFinancials: share.hideFinancials,
        expiresAt: share.expiresAt
      }
    }
  });
}));

// @route   POST /api/projects/:id/shares
// @desc    Generate a cryptographically scoped delegation token for family or site watchers
// @access  Private (CLIENT who owns the project)
router.post('/:id/shares', verifyToken, requireRole(['CLIENT']), catchAsync(async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(operational('Project not found.', 404));
  }

  const project = await Project.findOne({ _id: req.params.id, clientId: req.user.userId });
  if (!project) return next(operational('Project not found.', 404));

  const { scopedRole, delegateName, delegatePhone, hideFinancials, expiresInDays } = req.body;

  if (!scopedRole || !['FAMILY_VIEWER', 'SITE_WATCHER'].includes(scopedRole)) {
    return next(operational("scopedRole must be either 'FAMILY_VIEWER' or 'SITE_WATCHER'.", 400));
  }

  if (!delegateName || typeof delegateName !== 'string' || delegateName.trim().length < 2 || delegateName.trim().length > 80) {
    return next(operational('delegateName must be between 2 and 80 characters.', 400));
  }

  if (scopedRole === 'SITE_WATCHER' && !delegatePhone) {
    return next(operational('delegatePhone is mandatory for SITE_WATCHER delegates for field evidence correlation.', 400));
  }

  const days = Math.min(180, Math.max(1, parseInt(expiresInDays, 10) || 30));
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const shouldHideFinancials = hideFinancials !== undefined ? Boolean(hideFinancials) : (scopedRole === 'FAMILY_VIEWER');

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const share = await runTransaction(async (session) => {
    const [created] = await ProjectShareToken.create([{
      projectId: project._id,
      clientUserId: req.user.userId,
      tokenHash,
      scopedRole,
      delegateName: delegateName.trim(),
      delegatePhone: delegatePhone ? String(delegatePhone).trim() : null,
      hideFinancials: shouldHideFinancials,
      expiresAt
    }], { session });

    await emitAudit({
      session,
      entityId: created._id,
      entityType: 'PROJECT_SHARE',
      action: 'PROJECT_SHARE_CREATED',
      actorId: req.user.userId,
      actorRole: req.user.role,
      metadata: {
        projectId: project._id,
        scopedRole,
        delegateName: created.delegateName,
        expiresAt: created.expiresAt,
        hideFinancials: created.hideFinancials
      },
      ipAddress: req.ip || '127.0.0.1'
    });
    return created;
  });

  const shareUrl = `/app/project-detail.html?id=${project._id}&token=${rawToken}`;
  const whatsappText = encodeURIComponent(
    scopedRole === 'SITE_WATCHER'
      ? `Build-BD Site-Watcher link for project "${project.title}": ${shareUrl}`
      : `Build-BD Family project view for "${project.title}": ${shareUrl}`
  );

  res.status(201).json({
    status: 'success',
    message: 'Project share link created successfully.',
    data: {
      shareId: share._id,
      rawToken,
      shareUrl,
      whatsappUrl: `https://wa.me/?text=${whatsappText}`,
      scopedRole: share.scopedRole,
      delegateName: share.delegateName,
      delegatePhone: share.delegatePhone,
      hideFinancials: share.hideFinancials,
      expiresAt: share.expiresAt
    }
  });
}));

// @route   GET /api/projects/:id/shares
// @desc    List all delegation share links for a project (revoked and active)
// @access  Private (CLIENT who owns the project)
router.get('/:id/shares', verifyToken, requireRole(['CLIENT']), catchAsync(async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next(operational('Project not found.', 404));

  const project = await Project.findOne({ _id: req.params.id, clientId: req.user.userId }).select('_id');
  if (!project) return next(operational('Project not found.', 404));

  const shares = await ProjectShareToken.find({
    projectId: project._id,
    clientUserId: req.user.userId
  })
    .sort({ createdAt: -1 })
    .select('-tokenHash')
    .lean();

  res.status(200).json({
    status: 'success',
    shares
  });
}));

// @route   DELETE /api/projects/:id/shares/:shareId
// @desc    Instantly revoke an active delegation share token
// @access  Private (CLIENT who owns the project)
router.delete('/:id/shares/:shareId', verifyToken, requireRole(['CLIENT']), catchAsync(async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id) || !mongoose.Types.ObjectId.isValid(req.params.shareId)) {
    return next(operational('Target project or share not found.', 404));
  }

  const share = await runTransaction(async (session) => {
    const revoked = await ProjectShareToken.findOneAndUpdate(
      { _id: req.params.shareId, projectId: req.params.id, clientUserId: req.user.userId, isRevoked: false },
      { $set: { isRevoked: true } },
      { session, returnDocument: 'after' }
    );

    if (!revoked) throw operational('Active share token not found.', 404);

    await emitAudit({
      session,
      entityId: revoked._id,
      entityType: 'PROJECT_SHARE',
      action: 'PROJECT_SHARE_REVOKED',
      actorId: req.user.userId,
      actorRole: req.user.role,
      metadata: { projectId: req.params.id, shareId: revoked._id },
      ipAddress: req.ip || '127.0.0.1'
    });
    return revoked;
  });

  res.status(200).json({
    status: 'success',
    message: 'Delegation share token successfully revoked.'
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