// routes/aiOrchestrator.js
// Bilingual Voice & Text Conversational AI Intent Orchestrator ("Nirman-AI")
'use strict';

const express = require('express');
const router = express.Router();
const catchAsync = require('../utils/catchAsync');
const { optionalAuth } = require('../middleware/auth');
const { interpretUserUtterance } = require('../services/aiOrchestratorService');

router.post(
  '/orchestrate',
  optionalAuth,
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
      inputMode: inputMode || 'TEXT',
      userRole: req.user?.role || 'CLIENT'
    });

    res.status(200).json({
      status: 'success',
      data: intentPlan
    });
  })
);

module.exports = router;
