// config/bdWorkTaxonomy.js
// Bangladesh Public Works Department (PWD) 2022/2026 Schedule of Rates & Market Taxonomy
'use strict';

const MACRO_DOMAINS = [
  { code: 'ALL', nameEn: 'All 8 Domains (25)', nameBn: 'সব ডোমেইন' },
  { code: 'PRE_CONSTRUCTION', nameEn: '1. Design, Soil & RAJUK', nameBn: 'নকশা, সয়েল টেস্ট ও রাজউক' },
  { code: 'PILING_FOUNDATION', nameEn: '2. Piling & Earthwork', nameBn: 'পাইলিং ও মাটি ভরাট' },
  { code: 'CIVIL_STRUCTURAL', nameEn: '3. Civil & RCC Structure', nameBn: 'সিভিল ও আরসিসি স্ট্রাকচার' },
  { code: 'FINISHING_TRADES', nameEn: '4. Tiles, Paint, Wood & Thai', nameBn: 'টাইলস, রঙ, কাঠ ও থাই' },
  { code: 'INTERIOR_RENOVATION', nameEn: '5. Interior & Renovation', nameBn: 'ইন্টেরিয়র ও সংস্কার' },
  { code: 'MEP_UTILITIES', nameEn: '6. Electrical, Plumbing, AC & Lift', nameBn: 'ইলেকট্রিক্যাল, প্লাম্বিং, এসি ও লিফট' },
  { code: 'FACILITY_MAINTENANCE', nameEn: '7. Shifting, Cleaning & Pest', nameBn: 'বাসা বদল ও পেস্ট কন্ট্রোল' },
  { code: 'DOMESTIC_CARE', nameEn: '8. Verified Domestic Staff', nameBn: 'যাচাইকৃত গৃহকর্মী ও কেয়ার' }
];

const BD_WORK_CATEGORIES = [
  {
    code: 'Architecture & Engineering',
    domain: 'PRE_CONSTRUCTION',
    isNew: false,
    tier: 'L3_MILESTONE_ESCROW',
    floor: 1000,
    unit: 'sft',
    rate: '৳25 – ৳85 / sft',
    bn: 'আর্কিটেকচারাল ও স্ট্রাকচারাল ডিজাইন',
    pwd: 'PWD Consultancy / BNBC 2020 Part 6',
    modalities: ['Deliverable Milestone', 'Site Visit'],
    genres: ['ARCHITECTURAL_CONSULTING', 'ENGINEERING_SERVICES']
  },
  {
    code: 'Land Survey & Soil Test',
    domain: 'PRE_CONSTRUCTION',
    isNew: true,
    tier: 'L2_SPLIT_BOQ',
    floor: 200,
    unit: 'borehole',
    rate: '৳4,500 – ৳8,500 / borehole',
    bn: 'ডিজিটাল ল্যান্ড সার্ভে ও সয়েল টেস্ট (SPT)',
    pwd: 'PWD Civil SoR Ch. 01 (Sub-Soil SPT)',
    modalities: ['Per Borehole / Kattha', 'Fixed Package'],
    genres: ['SURVEY_SOIL_APPROVAL', 'ENGINEERING_SERVICES']
  },
  {
    code: 'RAJUK & Plan Approval',
    domain: 'PRE_CONSTRUCTION',
    isNew: true,
    tier: 'L3_MILESTONE_ESCROW',
    floor: 1000,
    unit: 'lump_sum',
    rate: '৳35,000 – ৳1,80,000',
    bn: 'রাজউক / পৌরসভা প্ল্যান পাশ ও ক্লিয়ারেন্স',
    pwd: 'RAJUK DAP (2022–2035) & Imarat Nirman Bidhimala',
    modalities: ['Deliverable Milestone'],
    genres: ['SURVEY_SOIL_APPROVAL', 'ARCHITECTURAL_CONSULTING']
  },
  {
    code: 'Piling & Deep Foundation',
    domain: 'PILING_FOUNDATION',
    isNew: true,
    tier: 'L3_MILESTONE_ESCROW',
    floor: 1000,
    unit: 'rft',
    rate: '৳140–৳320/rft (Rig) | ৳650–৳1,450/rft (Turnkey)',
    bn: 'বোরিং পাইলিং, প্রি-কাস্ট পাইল ও শোর পাইলিং',
    pwd: 'PWD Civil SoR Ch. 09 (Pile Foundation)',
    modalities: ['Thika (Rig & Labour)', 'With-Material Turnkey'],
    genres: ['PILING_FOUNDATION', 'CIVIL_STRUCTURAL']
  },
  {
    code: 'Earthwork & Excavation',
    domain: 'PILING_FOUNDATION',
    isNew: true,
    tier: 'L2_SPLIT_BOQ',
    floor: 1000,
    unit: 'cft',
    rate: '৳8 – ৳22 / cft',
    bn: 'মাটি কাটা, বালি ভরাট (Balu Bhorat) ও ডিওয়াটারিং',
    pwd: 'PWD Civil SoR Ch. 02 (Earthwork)',
    modalities: ['Thika Measurement (cft)', 'Daily Hajira'],
    genres: ['EARTHWORK_EXCAVATION', 'PILING_FOUNDATION']
  },
  {
    code: 'Residential',
    domain: 'CIVIL_STRUCTURAL',
    isNew: false,
    tier: 'L3_MILESTONE_ESCROW',
    floor: 1000,
    unit: 'sft',
    rate: '৳240–৳360/sft (Thika) | ৳2,100–৳3,200/sft (Turnkey)',
    bn: 'আবাসিক বাড়ি ও অ্যাপার্টমেন্ট নির্মাণ (রাজমিস্ত্রি/রডমিস্ত্রি)',
    pwd: 'PWD Civil SoR Ch. 04–08 (Brick, Formwork, RCC)',
    modalities: ['Thika Labour-Only', 'With-Material Turnkey', 'Daily Hajira'],
    genres: ['BUILDING_CONSTRUCTION', 'CIVIL_STRUCTURAL']
  },
  {
    code: 'Commercial',
    domain: 'CIVIL_STRUCTURAL',
    isNew: false,
    tier: 'L3_MILESTONE_ESCROW',
    floor: 1000,
    unit: 'sft',
    rate: '৳280–৳450/sft (Labour) | ৳2,400–৳4,200/sft (Turnkey)',
    bn: 'কমার্শিয়াল ভবন, ফ্যাক্টরি শেড ও গোডাউন নির্মাণ',
    pwd: 'PWD Civil SoR Ch. 07 & Ch. 16 (RCC & Steel)',
    modalities: ['Thika Labour-Only', 'With-Material Turnkey'],
    genres: ['COMMERCIAL_FITOUT', 'STEEL_FABRICATION']
  },
  {
    code: 'Infrastructure',
    domain: 'CIVIL_STRUCTURAL',
    isNew: false,
    tier: 'L3_MILESTONE_ESCROW',
    floor: 1000,
    unit: 'rft',
    rate: '৳1,200 – ৳6,500 / rft',
    bn: 'রাস্তা, ড্রেনেজ, কালভার্ট ও বাউন্ডারি ওয়াল',
    pwd: 'PWD Civil SoR Ch. 24 (Roads & Culverts)',
    modalities: ['With-Material Turnkey', 'Thika Labour-Only'],
    genres: ['CIVIL_INFRASTRUCTURE', 'ROAD_INFRASTRUCTURE']
  },
  {
    code: 'Masonry & Tiles',
    domain: 'FINISHING_TRADES',
    isNew: false,
    tier: 'L2_SPLIT_BOQ',
    floor: 200,
    unit: 'sft',
    rate: '৳22–৳45/sft (Tiles Mistri) | ৳75–৳140/sft (Marble)',
    bn: 'টাইলস, মার্বেল, গ্রানাইট ও প্লাস্টার কাজ (টাইলস মিস্ত্রি)',
    pwd: 'PWD Civil SoR Ch. 14 & 15 (Plaster & Tiles)',
    modalities: ['Thika Labour-Only', 'Split-BOQ Turnkey', 'Daily Hajira'],
    genres: ['MASONRY_TILES', 'TILES_MARBLE_MOSAIC']
  },
  {
    code: 'Painting',
    domain: 'FINISHING_TRADES',
    isNew: false,
    tier: 'L2_SPLIT_BOQ',
    floor: 200,
    unit: 'sft',
    rate: '৳9–৳18/sft (Labour) | ৳24–৳48/sft (With Berger/Asian)',
    bn: 'দেয়াল রঙ, পুটি, ওয়েদারকোট ও ড্যাম্প ট্রিটমেন্ট',
    pwd: 'PWD Civil SoR Ch. 19 (Emulsion & WeatherCoat)',
    modalities: ['Split-BOQ Turnkey', 'Thika Labour-Only'],
    genres: ['PAINTING_WATERPROOFING', 'RENOVATION_INTERIOR']
  },
  {
    code: 'Carpentry & Woodwork',
    domain: 'FINISHING_TRADES',
    isNew: false,
    tier: 'L2_SPLIT_BOQ',
    floor: 200,
    unit: 'sft',
    rate: '৳350 – ৳1,600 / sft',
    bn: 'কাঠের চৌকাঠ, দরজা, ফার্নিচার ও বার্নিশ (কাঠমিস্ত্রি)',
    pwd: 'PWD Civil SoR Ch. 11 & 12 (Choukat & Shutters)',
    modalities: ['Thika Labour-Only', 'With-Material Turnkey'],
    genres: ['CARPENTRY_WOODWORK', 'INTERIOR_DESIGN']
  },
  {
    code: 'Thai Aluminum, uPVC & Glass',
    domain: 'FINISHING_TRADES',
    isNew: true,
    tier: 'L2_SPLIT_BOQ',
    floor: 200,
    unit: 'sft',
    rate: '৳380 – ৳750 / sft (KAI/Altech & 5–10mm Glass)',
    bn: 'থাই অ্যালুমিনিয়াম জানালা, ইউপিভিসি ও গ্লাস পার্টিশন',
    pwd: 'PWD Civil SoR Ch. 17 (Aluminum & Glass Works)',
    modalities: ['With-Material Turnkey', 'Thika Labour-Only'],
    genres: ['THAI_ALUMINUM_GLASS', 'COMMERCIAL_FITOUT']
  },
  {
    code: 'Welding & Fabrication',
    domain: 'FINISHING_TRADES',
    isNew: false,
    tier: 'L2_SPLIT_BOQ',
    floor: 200,
    unit: 'sft',
    rate: '৳45–৳90/sft (Labour) | ৳220–৳680/sft (With MS/SS)',
    bn: 'এমএস/এসএস গ্রিল, মেইন গেট, সিঁড়ি রেলিং ও টিন শেড',
    pwd: 'PWD Civil SoR Ch. 16 (MS Grill, Gate & SS Railing)',
    modalities: ['Thika Labour-Only', 'With-Material Turnkey'],
    genres: ['WELDING_FABRICATION', 'STEEL_FABRICATION']
  },
  {
    code: 'False Ceiling & Gypsum',
    domain: 'FINISHING_TRADES',
    isNew: true,
    tier: 'L2_SPLIT_BOQ',
    floor: 200,
    unit: 'sft',
    rate: '৳95 – ৳240 / sft',
    bn: 'জিপসাম, পিভিসি ফলস সিলিং ও কর্নিশ ডিজাইন',
    pwd: 'PWD Civil SoR Ch. 21 (False Ceiling)',
    modalities: ['With-Material Turnkey', 'Thika Labour-Only'],
    genres: ['INTERIOR_DESIGN', 'RENOVATION_INTERIOR']
  },
  {
    code: 'Waterproofing & Roof Treatment',
    domain: 'FINISHING_TRADES',
    isNew: true,
    tier: 'L2_SPLIT_BOQ',
    floor: 200,
    unit: 'sft',
    rate: '৳35 – ৳110 / sft (Jolchhad / PU Chemical)',
    bn: 'ছাদের জলছাদ, ড্যাম্প ও নোনা প্রতিরোধক কেমিক্যাল ট্রিটমেন্ট',
    pwd: 'PWD Civil SoR Ch. 10 (Lime Terracing & Damp Proofing)',
    modalities: ['With-Material Turnkey', 'Thika Labour-Only'],
    genres: ['WATERPROOFING_DAMP', 'ROOFING_WATERPROOFING']
  },
  {
    code: 'Interior',
    domain: 'INTERIOR_RENOVATION',
    isNew: false,
    tier: 'L2_SPLIT_BOQ',
    floor: 1000,
    unit: 'sft',
    rate: '৳850 – ৳2,500 / sft',
    bn: 'টার্নকি হোম ও অফিস ইন্টেরিয়র ডিজাইন এবং মডিউলার কিচেন',
    pwd: 'PWD Interior Fit-Out & Acoustic Works',
    modalities: ['Split-BOQ Turnkey', 'Thika Labour-Only'],
    genres: ['INTERIOR_DESIGN', 'RENOVATION_INTERIOR']
  },
  {
    code: 'Renovation',
    domain: 'INTERIOR_RENOVATION',
    isNew: false,
    tier: 'L2_SPLIT_BOQ',
    floor: 1000,
    unit: 'sft',
    rate: '৳350 – ৳1,400 / sft',
    bn: 'পুরাতন ফ্ল্যাট, বাথরুম ও কিচেন সংস্কার (রেনোভেশন)',
    pwd: 'PWD Civil SoR Ch. 25 (Retrofitting & Repair)',
    modalities: ['Split-BOQ Turnkey', 'Thika Labour-Only'],
    genres: ['RENOVATION_RETROFIT', 'RENOVATION_INTERIOR']
  },
  {
    code: 'Electrical',
    domain: 'MEP_UTILITIES',
    isNew: false,
    tier: 'L1_INSTANT_DISPATCH',
    floor: 200,
    unit: 'point',
    rate: '৳300–৳500 (Callout) | ৳180–৳350/point (Concealed)',
    bn: 'ইলেকট্রিক্যাল ওয়্যারিং, ডিবি বোর্ড ও ফ্যান/লাইট ফিটিং',
    pwd: 'PWD E/M SoR Ch. 01–04 (Wiring, DB & Earthing)',
    modalities: ['Instant Callout', 'Thika Per-Point', 'Turnkey'],
    genres: ['MEP_ELECTRICAL', 'ELECTRICAL_PLUMBING']
  },
  {
    code: 'Plumbing',
    domain: 'MEP_UTILITIES',
    isNew: false,
    tier: 'L1_INSTANT_DISPATCH',
    floor: 200,
    unit: 'point',
    rate: '৳300–৳500 (Callout) | ৳4,500–৳12,000/Bathroom',
    bn: 'প্লাম্বিং, স্যানিটারি, পানির কল ও সাবমার্সিবল পাম্প',
    pwd: 'PWD Civil SoR Ch. 22 & 23 (Sanitary & PPR Pipe)',
    modalities: ['Instant Callout', 'Thika Per-Bathroom', 'Turnkey'],
    genres: ['PLUMBING_SANITARY', 'WATER_SANITATION']
  },
  {
    code: 'AC & Appliance',
    domain: 'MEP_UTILITIES',
    isNew: false,
    tier: 'L1_INSTANT_DISPATCH',
    floor: 200,
    unit: 'unit',
    rate: '৳500–৳1,200 (Jet Wash) | ৳2,200–৳3,800 (Gas/Install)',
    bn: 'এসি সার্ভিসিং (জেট ওয়াশ), গ্যাস রিফিল, ফ্রিজ ও গিজার',
    pwd: 'PWD E/M SoR Ch. 09 (HVAC & Refrigeration)',
    modalities: ['Instant Callout', 'Fixed Rate Card'],
    genres: ['HVAC_MECHANICAL', 'MEP_ELECTRICAL']
  },
  {
    code: 'IPS, Solar & Power Backup',
    domain: 'MEP_UTILITIES',
    isNew: true,
    tier: 'L1_INSTANT_DISPATCH',
    floor: 200,
    unit: 'unit',
    rate: '৳500–৳2,500 (IPS Service) | Solar Custom BOQ',
    bn: 'আইপিএস, সোলার প্যানেল ও ব্যাটারি ইন্সটলেশন এবং সার্ভিসিং',
    pwd: 'PWD E/M SoR Ch. 12 (Solar PV & Inverter)',
    modalities: ['Instant Callout', 'Turnkey Package'],
    genres: ['SOLAR_RENEWABLE', 'LIFT_SOLAR_GENERATOR']
  },
  {
    code: 'Lift, Generator & Sub-Station',
    domain: 'MEP_UTILITIES',
    isNew: true,
    tier: 'L3_MILESTONE_ESCROW',
    floor: 1000,
    unit: 'unit',
    rate: '৳2,500–৳8,000/mo (AMC) | Erection Escrow',
    bn: 'লিফট, জেনারেটর, এভিআর ও সাব-স্টেশন ইন্সটলেশন ও AMC',
    pwd: 'PWD E/M SoR Ch. 06–08 (Lift, Generator, Sub-Station)',
    modalities: ['Deliverable Milestone', 'Monthly AMC'],
    genres: ['LIFT_SOLAR_GENERATOR', 'MEP_ELECTRICAL']
  },
  {
    code: 'Gas Line & Fire Safety',
    domain: 'MEP_UTILITIES',
    isNew: true,
    tier: 'L2_SPLIT_BOQ',
    floor: 200,
    unit: 'point',
    rate: '৳1,500 – ৳15,000',
    bn: 'এলপিজি গ্যাস রেটিকুলেশন, ফায়ার হাইড্র্যান্ট ও সেফটি সিস্টেম',
    pwd: 'PWD E/M SoR Ch. 10 & BNBC Part 4 (Fire & LPG)',
    modalities: ['With-Material Turnkey', 'Thika Labour-Only'],
    genres: ['HVAC_MECHANICAL', 'PLUMBING_SANITARY']
  },
  {
    code: 'CCTV & Smart Security',
    domain: 'MEP_UTILITIES',
    isNew: false,
    tier: 'L1_INSTANT_DISPATCH',
    floor: 200,
    unit: 'point',
    rate: '৳400–৳800/cam (Labour) | ৳12,000+ (4-Cam Package)',
    bn: 'সিসিটিভি ক্যামেরা, ইন্টারকম, বায়োমেট্রিক ও অ্যাক্সেস কন্ট্রোল',
    pwd: 'PWD E/M SoR Ch. 11 (IP CCTV & PABX)',
    modalities: ['Instant Callout', 'With-Material Package'],
    genres: ['CCTV_SECURITY', 'MEP_ELECTRICAL']
  },
  {
    code: 'Shifting & Movers',
    domain: 'FACILITY_MAINTENANCE',
    isNew: false,
    tier: 'L2_SPLIT_BOQ',
    floor: 200,
    unit: 'trip',
    rate: '৳4,500 – ৳18,000 (By BHK, Covered Van & Lift)',
    bn: 'বাসা ও অফিস বদল (পিকআপ/কাভার্ড ভ্যান, প্যাকিং ও এসি খোলা)',
    pwd: 'BD Urban Relocation Benchmark',
    modalities: ['Fixed Split Package'],
    genres: ['SHIFTING_MOVERS']
  },
  {
    code: 'Cleaning & Pest Control',
    domain: 'FACILITY_MAINTENANCE',
    isNew: false,
    tier: 'L2_SPLIT_BOQ',
    floor: 200,
    unit: 'sft',
    rate: '৳3.5–৳8/sft (Deep Clean) | ৳1,500–৳4,500 (Tank/Pest)',
    bn: 'ফ্ল্যাট ডিপ ক্লিনিং, পানির ট্যাংক পরিষ্কার ও পেস্ট কন্ট্রোল',
    pwd: 'BD Urban Hygiene & Vector Control Standard',
    modalities: ['Fixed Split Package'],
    genres: ['CLEANING_PEST_CONTROL', 'WATER_SANITATION']
  },
  {
    code: 'Domestic Care',
    domain: 'DOMESTIC_CARE',
    isNew: false,
    tier: 'L4_DOMESTIC_TRIAL',
    floor: 200,
    unit: 'shift',
    rate: '৳300–৳600/day (Trial) | ৳3,500–৳18,000/month',
    bn: 'ভেরিফাইড ছুটা বুয়া, বাঁধা বুয়া, বাবুর্চি, কেয়ারগিভার ও ড্রাইভার',
    pwd: 'Bangladesh Domestic Workers Policy (DWPWP) 2015',
    modalities: ['7-Day Trial Escrow', 'Monthly Retainer'],
    genres: ['DOMESTIC_CARE']
  }
];

const PROJECT_CATEGORIES = BD_WORK_CATEGORIES.map((c) => c.code);

const TRADE_MICRO_CATEGORIES = [
  'Electrical',
  'Plumbing',
  'AC & Appliance',
  'Painting',
  'Carpentry & Woodwork',
  'Masonry & Tiles',
  'Welding & Fabrication',
  'Shifting & Movers',
  'Cleaning & Pest Control',
  'CCTV & Smart Security',
  'Domestic Care',
  'Land Survey & Soil Test',
  'Thai Aluminum, uPVC & Glass',
  'False Ceiling & Gypsum',
  'Waterproofing & Roof Treatment',
  'IPS, Solar & Power Backup',
  'Gas Line & Fire Safety'
];

const CONTRACTOR_WORK_GENRES = [
  'BUILDING_CONSTRUCTION',
  'CIVIL_INFRASTRUCTURE',
  'WATER_SANITATION',
  'MEP_ELECTRICAL',
  'RENOVATION_INTERIOR',
  'MATERIALS_SUPPLY',
  'ENGINEERING_SERVICES',
  'AC_APPLIANCE_REPAIR',
  'CARPENTRY_WOOD_THAI',
  'MASONRY_TILES_WATERPROOF',
  'WELDING_STEEL_FAB',
  'PAINTING_POLISH',
  'SHIFTING_CLEANING_PEST',
  'CCTV_SOLAR_LIFT',
  'CIVIL_STRUCTURAL',
  'INTERIOR_DESIGN',
  'ELECTRICAL_PLUMBING',
  'ROAD_INFRASTRUCTURE',
  'RENOVATION_RETROFIT',
  'ARCHITECTURAL_CONSULTING',
  'DAILY_LABOUR_SUPPLY',
  'SURVEY_SOIL_APPROVAL',
  'PILING_FOUNDATION',
  'EARTHWORK_EXCAVATION',
  'COMMERCIAL_FITOUT',
  'STEEL_FABRICATION',
  'MASONRY_TILES',
  'TILES_MARBLE_MOSAIC',
  'PAINTING_WATERPROOFING',
  'CARPENTRY_WOODWORK',
  'THAI_ALUMINUM_GLASS',
  'WELDING_FABRICATION',
  'WATERPROOFING_DAMP',
  'ROOFING_WATERPROOFING',
  'PLUMBING_SANITARY',
  'HVAC_MECHANICAL',
  'SOLAR_RENEWABLE',
  'LIFT_SOLAR_GENERATOR',
  'CCTV_SECURITY',
  'SHIFTING_MOVERS',
  'CLEANING_PEST_CONTROL',
  'DOMESTIC_CARE'
];

const SUPPLIER_MATERIAL_CATEGORIES = [
  'ROD',
  'CEMENT',
  'SAND',
  'BRICK',
  'STONE',
  'TILES',
  'SANITARY',
  'ELECTRICAL',
  'PAINT_CHEMICAL',
  'TIMBER_PLYWOOD',
  'THAI_GLASS_UPVC',
  'PIPES_FITTINGS',
  'HARDWARE_STEEL',
  'READY_MIX_CONCRETE'
];

const CONTRACT_MODALITIES = [
  'THIKA_LABOUR_ONLY',
  'WITH_MATERIAL_TURNKEY',
  'HAJIRA_DAILY_MISTRI',
  'FIXED_CALLOUT'
];

function getContractorGenresForCategory(category) {
  const match = BD_WORK_CATEGORIES.find((c) => c.code === category);
  return match ? match.genres : [];
}

function getCategoryByCode(code) {
  return BD_WORK_CATEGORIES.find((c) => c.code === code) || null;
}

module.exports = {
  MACRO_DOMAINS,
  BD_WORK_CATEGORIES,
  PROJECT_CATEGORIES,
  TRADE_MICRO_CATEGORIES,
  CONTRACTOR_WORK_GENRES,
  SUPPLIER_MATERIAL_CATEGORIES,
  CONTRACT_MODALITIES,
  getContractorGenresForCategory,
  getCategoryByCode
};
