// models/ContractorProfile.js
const mongoose = require('mongoose');

// Directory taxonomy (UX plan §B5). Defaults keep every pre-existing profile valid.
const WORK_GENRES = ['BUILDING_CONSTRUCTION', 'CIVIL_INFRASTRUCTURE', 'WATER_SANITATION', 'MEP_ELECTRICAL', 'RENOVATION_INTERIOR', 'MATERIALS_SUPPLY', 'ENGINEERING_SERVICES'];
const MODALITIES = ['WITH_MATERIALS', 'LABOUR_ONLY', 'DIRECT_SUPPLY'];
const CONTRACTOR_TIERS = ['MISTRI_SARDAR', 'SPECIALTY_TRADE', 'ENGINEERING_FIRM', 'MATERIAL_DEALER'];

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
  tradeLicense: {
    type: String,
    trim: true,
    index: true,
    sparse: true
  },
  nidHash: {
    type: String,
    trim: true,
    index: true,
    sparse: true
  }, 
  
  serviceAreas: [{
    district: String,
    areas: [String],
    willingToTravel: Boolean
  }],

  contractorTier: { type: String, enum: CONTRACTOR_TIERS, default: 'MISTRI_SARDAR' },
  workGenres: { type: [{ type: String, enum: WORK_GENRES }], default: [], validate: [(v) => v.length <= WORK_GENRES.length, 'Too many work genres'] },
  supportedModalities: { type: [{ type: String, enum: MODALITIES }], default: [], validate: [(v) => v.length <= MODALITIES.length, 'Too many modalities'] },

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

// Admin verification queue: filter by status, oldest first — status alone is a prefix of this.
contractorProfileSchema.index({ "verification.status": 1, createdAt: 1 });
contractorProfileSchema.index({ trustScore: -1 });
// Directory (verified only, best-trusted first). MongoDB forbids one compound index over two
// array fields, so genre and district each get their own index; the other filter is applied
// to the already-narrowed set. Equality prefix + trustScore/_id sort => no in-memory SORT.
contractorProfileSchema.index({ 'verification.status': 1, trustScore: -1, _id: -1 });
contractorProfileSchema.index({ 'verification.status': 1, workGenres: 1, trustScore: -1, _id: -1 });
contractorProfileSchema.index({ 'verification.status': 1, 'serviceAreas.district': 1, trustScore: -1, _id: -1 });

module.exports = mongoose.model('ContractorProfile', contractorProfileSchema);
module.exports.WORK_GENRES = WORK_GENRES;
module.exports.MODALITIES = MODALITIES;
module.exports.CONTRACTOR_TIERS = CONTRACTOR_TIERS;