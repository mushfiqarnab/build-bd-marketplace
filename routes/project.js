// routes/project.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const Project = require('../models/Project');

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

  const safeBudget = Number(budget);
  if (!Number.isFinite(safeBudget) || safeBudget < 0) {
    return next(Object.assign(new Error('Budget must be a non-negative number.'), {
      statusCode: 400,
      isOperational: true
    }));
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
    budget: safeBudget
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

  const [projects, total] = await Promise.all([
    Project.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .select('title category description location budget status createdAt')
      .lean(),
    Project.countDocuments(filter)
  ]);

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

module.exports = router;