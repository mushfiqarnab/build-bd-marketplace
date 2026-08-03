// models/ContractorProfile.js
const mongoose = require('mongoose');

const contractorProfileSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true, 
    unique: true 
  },
  businessType: { 
    type: String, 
    enum: ['INDIVIDUAL', 'COMPANY'], 
    required: true 
  },
  fullName: String,
  tradeLicense: String, 
  
  serviceAreas: [{
    district: String,
    areas: [String],
    willingToTravel: Boolean
  }],

  verification: {
    status: { 
      type: String, 
      enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'], 
      default: 'UNVERIFIED' 
    },
    verificationLevel: { 
      type: String, 
      enum: ['BASIC', 'STANDARD', 'PREMIUM'],
      default: 'BASIC'
    },
    probationStatus: {
      isProbation: { type: Boolean, default: true },
      projectsCompleted: { type: Number, default: 0 },
      projectsRequired: { type: Number, default: 3 }, 
      canBidAbove: { type: Number, default: 100000 } 
    }
  },

  statistics: {
    totalProjectsCompleted: { type: Number, default: 0 },
    completionRate: { type: Number, default: 0 },
    averageRating: { type: Number, default: 0 }
  },

  // Capacity lock for concurrent awarded work (spec §8 trust controls).
  availability: {
    currentProjects: { type: Number, default: 0, min: 0 },
    maxConcurrentProjects: { type: Number, default: 3, min: 1 }
  },
  
  trustScore: { type: Number, default: 0 }
}, { timestamps: true });

contractorProfileSchema.index({ "verification.status": 1 });
contractorProfileSchema.index({ trustScore: -1 });

module.exports = mongoose.model('ContractorProfile', contractorProfileSchema);