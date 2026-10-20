// routes/dashboard.js
// 🧭 Role-aware dashboard counters. One round-trip replaces 4-6 that F3/F4-F8
// side rails would otherwise need. All values are counts of docs the caller
// is allowed to see — never leaks counts from another role's data.
'use strict';

const express = require('express');
const router = express.Router();

const { verifyToken } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');

const Project = require('../models/Project');
const Bid = require('../models/Bid');
const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// @route   GET /api/dashboard/counters
// @desc    Returns the counters relevant to the caller's role. Shape differs
//          by role — the frontend branches on `role` or on presence of the
//          counter keys. Never includes staff-only aggregates.
// @access  Private (any authenticated user)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/counters', verifyToken, catchAsync(async (req, res) => {
  const { userId, role } = req.user;

  if (role === 'CLIENT') {
    // Projects I posted + the bids/ledgers downstream. Everything is MY data
    // only — Project.clientId / EscrowLedger.clientId scope every query.
    const [projectsOpen, projectsAssigned, bidsPending, awaitingFunding, inProgress, disputed, settled, wallet] = await Promise.all([
      Project.countDocuments({ clientId: userId, status: 'OPEN' }),
      Project.countDocuments({ clientId: userId, status: 'ASSIGNED' }),
      Bid.countDocuments({ status: 'PENDING' }).where({ projectId: { $in: await Project.find({ clientId: userId, status: 'OPEN' }).distinct('_id') } }),
      EscrowLedger.countDocuments({ clientId: userId, ledgerStatus: 'PENDING_FUNDING' }),
      EscrowLedger.countDocuments({ clientId: userId, ledgerStatus: { $in: ['FUNDED', 'PARTIALLY_DISBURSED'] } }),
      EscrowLedger.countDocuments({ clientId: userId, ledgerStatus: 'IN_ARBITRATION' }),
      EscrowLedger.countDocuments({ clientId: userId, ledgerStatus: 'FULLY_DISBURSED' }),
      User.findById(userId).select('wallet').lean()
    ]);
    return res.status(200).json({
      status: 'success',
      role,
      counters: {
        projectsOpen,
        projectsAssigned,
        bidsPending,
        awaitingFunding,
        inProgress,
        disputed,
        settled
      },
      wallet: wallet && wallet.wallet ? wallet.wallet : { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 }
    });
  }

  if (role === 'CONTRACTOR') {
    const [myBidsPending, myBidsAccepted, myBidsRejected, inProgress, disputed, settled, wallet] = await Promise.all([
      Bid.countDocuments({ contractorId: userId, status: 'PENDING' }),
      Bid.countDocuments({ contractorId: userId, status: 'ACCEPTED' }),
      Bid.countDocuments({ contractorId: userId, status: 'REJECTED' }),
      EscrowLedger.countDocuments({ contractorId: userId, ledgerStatus: { $in: ['FUNDED', 'PARTIALLY_DISBURSED'] } }),
      EscrowLedger.countDocuments({ contractorId: userId, ledgerStatus: 'IN_ARBITRATION' }),
      EscrowLedger.countDocuments({ contractorId: userId, ledgerStatus: 'FULLY_DISBURSED' }),
      User.findById(userId).select('wallet').lean()
    ]);
    return res.status(200).json({
      status: 'success',
      role,
      counters: {
        myBidsPending,
        myBidsAccepted,
        myBidsRejected,
        inProgress,
        disputed,
        settled
      },
      wallet: wallet && wallet.wallet ? wallet.wallet : { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 }
    });
  }

  if (role === 'SUPPLIER') {
    const MaterialOrder = require('../models/MaterialOrder');
    const { MaterialProduct } = require('../models/MaterialProduct');
    const { SupplierProfile } = require('../models/SupplierProfile');

    const profile = await SupplierProfile.findOne({ userId }).select('_id').lean();
    const supplierId = profile ? profile._id : null;

    const [totalProducts, activeOrders, pendingDelivery, completedOrders, disputedOrders, wallet] = await Promise.all([
      supplierId ? MaterialProduct.countDocuments({ supplierId }) : 0,
      supplierId ? MaterialOrder.countDocuments({ supplierId, status: { $in: ['ACCEPTED', 'ESCROW_FUNDED'] } }) : 0,
      supplierId ? MaterialOrder.countDocuments({ supplierId, status: 'IN_TRANSIT' }) : 0,
      supplierId ? MaterialOrder.countDocuments({ supplierId, status: 'COMPLETED' }) : 0,
      supplierId ? MaterialOrder.countDocuments({ supplierId, status: 'DISPUTED' }) : 0,
      User.findById(userId).select('wallet').lean()
    ]);

    return res.status(200).json({
      status: 'success',
      role,
      counters: {
        totalProducts,
        activeOrders,
        pendingDelivery,
        completedOrders,
        disputedOrders
      },
      wallet: wallet && wallet.wallet ? wallet.wallet : { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 }
    });
  }

  // ADMIN / MODERATOR: platform-wide counters (not scoped to a user).
  const [pendingDisputes, inArbitration, pendingSettlement] = await Promise.all([
    require('../models/DisputeTicket').countDocuments({ status: 'OPEN_FOR_REVIEW' }),
    EscrowLedger.countDocuments({ ledgerStatus: 'IN_ARBITRATION' }),
    EscrowLedger.countDocuments({ 'milestones.settlementStatus': 'PENDING_CLEARANCE' })
  ]);
  return res.status(200).json({
    status: 'success',
    role,
    counters: {
      pendingDisputes,
      inArbitration,
      pendingSettlement
    }
  });
}));

module.exports = router;
