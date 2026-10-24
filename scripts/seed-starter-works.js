// scripts/seed-starter-works.js
// Seeds the 7 essential trade starter RFQs across Dhaka into MongoDB Atlas.
// Invariants:
//   - Idempotent: checks for matching title before creating
//   - Uses real CLIENT user ID from database
//   - Follows models/Project schema constraints (categories, budget >= 200, integer BDT)
'use strict';

const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
require('../models/User');
require('../models/Project');

const User = mongoose.model('User');
const Project = mongoose.model('Project');

const SEED_PROJECTS = [
  {
    title: 'Emergency 220V Distribution Board Tripping & Circuit Breaker Replacement',
    category: 'Electrical',
    budget: 800,
    description: 'Main distribution board circuit breaker trips intermittently under AC load. Need certified electrician with clamp meter and spare 32A MCBs.',
    location: 'Mirpur-10, Dhaka',
    siteCoordinates: { latitude: 23.8041, longitude: 90.3667 }
  },
  {
    title: 'Concealed PPR Pipeline Leak Repair & Commode Flush Valve Replacement',
    category: 'Plumbing',
    budget: 500,
    description: 'Concealed wall leakage behind bathroom tiles. Requires leak diagnostic and replacement of worn siphon flush valve.',
    location: 'Dhanmondi 27, Dhaka',
    siteCoordinates: { latitude: 23.7465, longitude: 90.3760 }
  },
  {
    title: '1.5 Ton Inverter AC Master Jet Wash & Drainage Pipe Unclog',
    category: 'AC & Appliance',
    budget: 800,
    description: 'Indoor blower and outdoor condenser full pressure jet wash. Water dripping from indoor drain tray requires line flush and gas pressure check.',
    location: 'Mirpur-12, Dhaka',
    siteCoordinates: { latitude: 23.8223, longitude: 90.3654 }
  },
  {
    title: '2-Bedroom Master Suite Asian Paints Anti-Fungal Damp Treatment & Topcoat',
    category: 'Painting',
    budget: 4500,
    description: 'North-facing wall exhibits monsoon moisture dampness. Scraping, waterproof sealer application, and two coats of washable plastic emulsion.',
    location: 'Uttara Sector 4, Dhaka',
    siteCoordinates: { latitude: 23.8728, longitude: 90.3984 }
  },
  {
    title: 'Experienced Morning Cook & Dishwashing Assistant (8 AM - 11 AM)',
    category: 'Domestic Care',
    budget: 3500,
    description: 'Part-time morning household domestic helper for cooking Bengali breakfast/lunch and kitchen cleanup. DWPWP-2015 trial shift agreement.',
    location: 'Banani DOHS, Dhaka',
    siteCoordinates: { latitude: 23.7940, longitude: 90.4043 }
  },
  {
    title: 'Modern Kitchen Modular Cabinetry & Granite Countertop Installation',
    category: 'Renovation',
    budget: 65000,
    description: 'Complete kitchen modernization including moisture-resistant marine ply cabinets, soft-close hinges, and 20mm Indian black granite top.',
    location: 'Bashundhara R/A, Block C, Dhaka',
    siteCoordinates: { latitude: 23.8191, longitude: 90.4285 }
  },
  {
    title: 'G+5 Residential Building 3rd Floor RCC Column & Beam Casting',
    category: 'Residential',
    budget: 380000,
    description: 'Structural concrete pouring (1:1.5:3 mix), 60-grade deformed rebar tying, and waterproof shuttering for 14 columns and perimeter tie beams.',
    location: 'Mohammadpur Housing, Dhaka',
    siteCoordinates: { latitude: 23.7662, longitude: 90.3589 }
  }
];

async function seed() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Missing MONGODB_URI');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB Atlas.');

  const client = await User.findOne({ role: 'CLIENT' });
  if (!client) {
    console.error('No CLIENT user found in database. Create a client first.');
    process.exit(1);
  }

  let createdCount = 0;
  for (const item of SEED_PROJECTS) {
    const existing = await Project.findOne({ title: item.title });
    if (existing) {
      console.log(`[EXISTS] ${item.title}`);
      continue;
    }

    await Project.create({
      ...item,
      clientId: client._id,
      status: 'OPEN'
    });
    console.log(`[CREATED] ${item.category} | ${item.location} | ৳${item.budget} | ${item.title}`);
    createdCount++;
  }

  console.log(`Seeding complete. Inserted ${createdCount} new projects.`);
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seeding error:', err);
  process.exit(1);
});
