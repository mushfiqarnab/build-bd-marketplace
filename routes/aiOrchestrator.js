// routes/aiOrchestrator.js
// Bilingual Voice & Text Conversational AI Intent Orchestrator ("Nirman-AI")
'use strict';

const express = require('express');
const router = express.Router();
const catchAsync = require('../utils/catchAsync');
const { verifyToken, requireRole } = require('../middleware/auth');
const { interpretUserUtterance } = require('../services/aiOrchestratorService');

router.post(
  '/orchestrate',
  verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR', 'ADMIN', 'MODERATOR']),
  catchAsync(async (req, res, next) => {
    const { utterance, inputMode, localeHint } = req.body || {};

    if (!utterance || typeof utterance !== 'string' || !utterance.trim()) {
      return next(Object.assign(
        new Error('Utterance string is required for AI intent orchestration.'),
        { statusCode: 400, isOperational: true }
      ));
    }

    const intentPlan = interpretUserUtterance(utterance.trim(), {
      lang: localeHint,
      inputMode: inputMode || 'TEXT'
    });

    res.status(200).json({
      status: 'success',
      data: intentPlan
    });
  })
);

module.exports = router;
