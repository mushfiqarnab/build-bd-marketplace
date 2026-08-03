// routes/project.js
const express = require('express');
const router = express.Router();
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