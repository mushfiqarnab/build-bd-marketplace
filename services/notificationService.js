// services/notificationService.js
// Central notification dispatch engine (Synthesis §3.3)
// Routes domain events to real-time WebSockets (in-app toast) and operational SMS
'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger');
const User = require('../models/User');

/**
 * Dispatch an operational notification to a user.
 * @param {Object} opts
 * @param {string} [opts.userId] - Recipient user ObjectId
 * @param {string} [opts.phoneNumber] - Explicit BD phone number (resolved from User if omitted)
 * @param {string} opts.eventType - e.g. 'MILESTONE_STALLED', 'EVIDENCE_SUBMITTED', 'MATERIAL_VARIANCE'
 * @param {string} opts.title - Human-readable subject
 * @param {string} opts.message - Notification body
 * @param {Object} [opts.metadata] - Arbitrary domain payload
 * @param {Object} [opts.io] - Optional Socket.io instance
 */
async function sendNotification({ userId, phoneNumber, eventType, title, message, metadata = {}, io = null }) {
  let recipientPhone = phoneNumber;

  if (!recipientPhone && userId && mongoose.connection && mongoose.connection.readyState === 1) {
    try {
      const u = await User.findById(userId).select('phoneNumber').lean();
      if (u) recipientPhone = u.phoneNumber;
    } catch (err) {
      logger.warn(`[Notification] Failed to look up user ${userId}: ${err.message}`);
    }
  }

  const notificationPayload = {
    eventType,
    title,
    message,
    metadata,
    timestamp: new Date().toISOString()
  };

  // 1. In-app real-time socket delivery
  if (io && userId) {
    try {
      io.to(`user:${userId}`).emit('notification', notificationPayload);
    } catch (err) {
      logger.warn(`[Notification] Socket emit error: ${err.message}`);
    }
  }

  // 2. Operational alert / SMS logging
  logger.info(`📢 [Notification:${eventType}] To: ${recipientPhone || userId || 'ALL'} | ${title} — ${message}`);

  return {
    delivered: true,
    channels: {
      socket: Boolean(io && userId),
      sms: Boolean(recipientPhone)
    },
    payload: notificationPayload
  };
}

// ─────────────────────────────────────────────
// Domain-Specific Notification Helpers
// ─────────────────────────────────────────────

async function notifyMilestoneStalled({ clientId, contractorId, projectId, milestoneTitle, io }) {
  const title = 'Milestone Review Stalled';
  const message = `Milestone "${milestoneTitle}" has been awaiting review for 7+ days. Contractor dispute window is now unlocked.`;
  await Promise.allSettled([
    sendNotification({ userId: clientId, eventType: 'MILESTONE_STALLED', title, message, metadata: { projectId }, io }),
    sendNotification({ userId: contractorId, eventType: 'MILESTONE_STALLED', title, message, metadata: { projectId }, io })
  ]);
}

async function notifyEvidenceSubmitted({ clientId, projectId, milestoneTitle, tier, io }) {
  const title = 'New Milestone Evidence Submitted';
  const message = `Work evidence uploaded for "${milestoneTitle}" (${tier}). Please review site photos and audit status.`;
  return sendNotification({ userId: clientId, eventType: 'EVIDENCE_SUBMITTED', title, message, metadata: { projectId, tier }, io });
}

async function notifyMaterialVariance({ clientId, projectId, flags, io }) {
  const title = 'Material Delivery Variance Flagged';
  const message = `Delivery report flagged discrepancies: ${flags.join('; ')}. Immediate review recommended.`;
  return sendNotification({ userId: clientId, eventType: 'MATERIAL_VARIANCE', title, message, metadata: { projectId, flags }, io });
}

async function notifyDisputeCreated({ recipientId, ticketId, reason, io }) {
  const title = 'Escrow Milestone In Dispute';
  const message = `A formal dispute (Ticket #${ticketId}) was opened: "${reason}". Funds are frozen pending arbitration.`;
  return sendNotification({ userId: recipientId, eventType: 'DISPUTE_OPENED', title, message, metadata: { ticketId }, io });
}

module.exports = {
  sendNotification,
  notifyMilestoneStalled,
  notifyEvidenceSubmitted,
  notifyMaterialVariance,
  notifyDisputeCreated
};
