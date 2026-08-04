// middleware/bidIsolation.js
// 🛡️ Phase 21 — Zero-Knowledge Peer Isolation Engine
//
// Enforces strict data compartmentalization between bidding participants.
// The architecture follows the e-GP Section 9 principle of sealed bidding:
// no contractor may ever observe a competitor's pricing, identity, or timeline.
//
// Access Matrix:
//   CONTRACTOR → sees ONLY their own bid on the queried project
//   CLIENT     → sees ALL bids, but ONLY on projects they own
//   ADMIN      → full read access (audit / arbitration)
//
// This middleware populates req.isolationQuery which the route then uses
// as the MongoDB filter. It never touches req.body.

const Project = require('../models/Project');

/**
 * enforceBidIsolation
 * Must be mounted AFTER verifyToken so req.user is populated.
 * Reads req.params.projectId from the route.
 */
exports.enforceBidIsolation = async (req, res, next) => {
  try {
    const projectId = req.params.projectId || req.params.id;
    const { userId, role } = req.user;

    if (!projectId) {
      const err = new Error('Project ID is required for bid isolation enforcement.');
      err.statusCode = 400;
      err.isOperational = true;
      return next(err);
    }

    if (role === 'CONTRACTOR') {
      // 🔒 Zero-Knowledge: contractor sees ONLY their own bid — no competitor data leaks.
      req.isolationQuery = {
        projectId,
        contractorId: userId
      };
      return next();
    }

    if (role === 'CLIENT') {
      // 🔒 Ownership Verification: client may only read bids on their own projects.
      // Using lean() + select() — minimal memory footprint, no hydration overhead.
      const project = await Project.findById(projectId).select('clientId').lean();

      if (!project) {
        const err = new Error('Project not found.');
        err.statusCode = 404;
        err.isOperational = true;
        return next(err);
      }

      if (project.clientId.toString() !== userId) {
        console.warn(`🚨 [BidIsolation] Unauthorized project read attempt by CLIENT ${userId} on project ${projectId}`);
        const err = new Error('Confidentiality Breach: You are not the owner of this project.');
        err.statusCode = 403;
        err.isOperational = true;
        return next(err);
      }

      req.isolationQuery = { projectId };
      return next();
    }

    if (role === 'ADMIN' || role === 'MODERATOR') {
      // Full read access for arbitration and audit purposes
      req.isolationQuery = { projectId };
      return next();
    }

    // Unknown role — deny with extreme prejudice
    const err = new Error('Access Denied: Unrecognized role for bid data access.');
    err.statusCode = 403;
    err.isOperational = true;
    return next(err);
  } catch (err) {
    next(err);
  }
};
