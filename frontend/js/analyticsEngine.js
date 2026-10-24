// frontend/js/analyticsEngine.js — Deterministic Build-BD Executive Telemetry & Pure Analytics Engine.
//
// Invariants (.agy-rules.md):
//   - Deterministic seeded Mulberry32 integer PRNG for reproducible tests & telemetry
//   - 100% Whole-Taka integer BDT arithmetic (Math.round + residual subtraction, zero paisa drift)
//   - Aligned with Project, EscrowLedger, MaterialOrder, ContractorProfile & SupplierProfile enums
//   - Zero DOM / browser globals required (safe to import directly in Node unit tests)

import { bengaliToAscii } from './phone.js';

export const ANCHOR_DATE = '2026-10-24';

export const DIVISIONS = ['Dhaka', 'Chattogram', 'Sylhet', 'Rajshahi', 'Khulna', 'Barishal'];

export const PROJECT_SEGMENTS = ['Residential', 'Commercial', 'Infrastructure', 'Interior', 'Renovation'];

export const MATERIAL_SEGMENTS = ['ROD', 'CEMENT', 'BRICK', 'SAND', 'TILES', 'SANITARY', 'ELECTRICAL', 'STONE'];

export const CONTRACTOR_TIERS = ['ENGINEERING_FIRM', 'SPECIALTY_TRADE', 'MISTRI_SARDAR', 'MATERIAL_DEALER'];

export const LEDGER_STATUSES = [
  'FULLY_DISBURSED',
  'PARTIALLY_DISBURSED',
  'FUNDED',
  'IN_TRANSIT',
  'PENDING_CLEARANCE',
  'IN_ARBITRATION'
];

export const VERIFICATION_TIERS = [
  'CRYPTOGRAPHIC_PROOF',
  'GPS_ONLY',
  'TIME_ONLY',
  'REQUIRES_CLIENT_AUDIT'
];

const DIVISION_PROFILES = [
  {
    division: 'Dhaka',
    weight: 42,
    multiplier: 1.28,
    districts: ['Uttara Sector 11, Dhaka', 'Bashundhara R/A, Dhaka', 'Dhanmondi, Dhaka', 'Mirpur DOHS, Dhaka', 'Gulshan-2, Dhaka', 'Gazipur Industrial']
  },
  {
    division: 'Chattogram',
    weight: 22,
    multiplier: 1.15,
    districts: ['Agrabad C/A, Chattogram', 'Nasirabad, Chattogram', 'Khulshi Hills, Chattogram', 'Halishahar, Chattogram', 'Coxs Bazar Marine Dr']
  },
  {
    division: 'Sylhet',
    weight: 14,
    multiplier: 1.08,
    districts: ['Shahjalal Upashahar, Sylhet', 'Zindabazar, Sylhet', 'Amberkhana, Sylhet', 'Moulvibazar Sadar']
  },
  {
    division: 'Rajshahi',
    weight: 9,
    multiplier: 0.88,
    districts: ['Padma Residential, Rajshahi', 'Boalia, Rajshahi', 'Bogura Sadar']
  },
  {
    division: 'Khulna',
    weight: 8,
    multiplier: 0.86,
    districts: ['Sonadanga R/A, Khulna', 'Khalishpur, Khulna', 'Jashore Sadar']
  },
  {
    division: 'Barishal',
    weight: 5,
    multiplier: 0.78,
    districts: ['Sadar Road, Barishal', 'Rupatali Housing, Barishal']
  }
];

const CONTRACT_TEMPLATES = [
  { segment: 'Residential', title: 'G+6 RCC Frame & Foundation Piling', baseBDT: 1850000, tier: 'ENGINEERING_FIRM', milestones: ['Mobilization & Soil Test', 'Pile Cap & Grade Beam', '1st–3rd Roof Slab Casting', ' Structural Handover'] },
  { segment: 'Residential', title: 'Probashi Duplex Villa Turnkey Build', baseBDT: 2420000, tier: 'ENGINEERING_FIRM', milestones: ['Footing & Plinth', 'Superstructure Brickwork', 'MEP & Plastering', 'Finishing & Handover'] },
  { segment: 'Residential', title: '3-Storey Family Boundary & Roof Waterproofing', baseBDT: 460000, tier: 'MISTRI_SARDAR', milestones: ['Surface Chipping & Prep', 'Damp-Proof Screed', 'Curing & Final Seal'] },
  { segment: 'Commercial', title: 'Corporate Floor Curtain Wall & HVAC Fit-Out', baseBDT: 3180000, tier: 'ENGINEERING_FIRM', milestones: ['Sub-frame Fabrication', 'Double-Glazed Panel Mount', 'HVAC Ducting & Fire Test', 'Commissioning'] },
  { segment: 'Commercial', title: 'Garment RMG Warehouse Heavy Industrial Slab', baseBDT: 3850000, tier: 'ENGINEERING_FIRM', milestones: ['Sub-base Compaction', 'Rebar Mesh & Vapor Barrier', 'Laser Screed Pour', 'Joint Sawing & Cure'] },
  { segment: 'Infrastructure', title: ' Culvert Drainage & Access Road Concrete Paving', baseBDT: 2740000, tier: 'ENGINEERING_FIRM', milestones: ['Excavation & Shoring', 'Box Culvert Wall Pour', 'Rigid Pavement Slab', 'Load Verification'] },
  { segment: 'Infrastructure', title: 'Deep Tube-Well & Overhead Water Reservoir', baseBDT: 1380000, tier: 'SPECIALTY_TRADE', milestones: ['Borehole & Casing', 'Submersible Pump Rig', 'Overhead Tank Formwork', 'Hydrostatic Test'] },
  { segment: 'Interior', title: '2,400 sqft Apartment Acoustic & Cabinetry Fit-Out', baseBDT: 920000, tier: 'SPECIALTY_TRADE', milestones: ['False Ceiling & Wiring', 'Marine Ply Kitchen & Wardrobes', 'Lacquer Polish & Lighting'] },
  { segment: 'Interior', title: 'Medical Diagnostic Clinic Clean-Room Partitioning', baseBDT: 1240000, tier: 'SPECIALTY_TRADE', milestones: ['Lead/Gypsum Framing', 'Antibacterial Vinyl Flooring', 'Electrical DB & Handover'] },
  { segment: 'Renovation', title: 'Heritage Building Structural Column Retrofitting', baseBDT: 1120000, tier: 'ENGINEERING_FIRM', milestones: ['Micro-Concrete Jacketing', 'Rebar Anchoring', 'Epoxy Grout & Ultrasonic Test'] },
  { segment: 'Renovation', title: 'Full Bathroom Sanitary, Concealed CPVC & Tile Upgrade', baseBDT: 340000, tier: 'MISTRI_SARDAR', milestones: ['Demolition & Waterproofing', 'Concealed Piping Pressure Test', 'Porcelain Tile & Fixture Mount'] }
];

const MATERIAL_TEMPLATES = [
  { segment: 'ROD', title: 'BSRM Xtreme 500W Deformed Bar (16mm & 20mm · 8 MT)', baseBDT: 768000 },
  { segment: 'ROD', title: 'AKS TMT 500W Structural Steel Bundle (12mm · 5 MT)', baseBDT: 475000 },
  { segment: 'CEMENT', title: 'Shah Special PCC Cement Bulk Consignment (450 Bags)', baseBDT: 243000 },
  { segment: 'CEMENT', title: 'Crown OPC 53-Grade Structural Cement (600 Bags)', baseBDT: 342000 },
  { segment: 'BRICK', title: 'Mirpur Ceramic 1st-Class Machine Auto Bricks (18,000 Pcs)', baseBDT: 252000 },
  { segment: 'SAND', title: 'Sylhet 2.5 FM Washed Coarse Casting Sand (1,800 CFT)', baseBDT: 135000 },
  { segment: 'STONE', title: 'Jaflong 20mm Graded Crushed Aggregate (1,400 CFT)', baseBDT: 294000 },
  { segment: 'TILES', title: 'RAK 24x24 Double-Charge Porcelain Tiles (3,200 SQFT)', baseBDT: 368000 },
  { segment: 'SANITARY', title: 'Stella Commercial Wall-Hung Cistern & Basin Suite (14 Sets)', baseBDT: 287000 },
  { segment: 'ELECTRICAL', title: 'BRB Fire-Retardant BYM Copper Cable & Breaker Lot', baseBDT: 318000 }
];

const CONTRACTORS = [
  'Padma Structural Engineers Ltd.',
  'Karnaphuli Civil & Piling Co.',
  'Surma Turnkey Builders',
  'Meghna MEP & Interiors',
  'Jamuna Foundation Associates',
  'Bengal Sardar Construction',
  'Barind Infrastructure Works',
  'Rupsha Engineering Consortium'
];

const SUPPLIERS = [
  'Dhaka Steel & Ispat Syndicate',
  'Chattogram Port Bulk Cement Depot',
  'Sylhet Aggregate & Sand Traders',
  'Uttara Ceramic & Sanitary Mart',
  'Narayanganj Rebar & Hardware Agency',
  'Gazipur Ready-Mix & Building Supply'
];

/**
 * Deterministic 32-bit PRNG (Mulberry32).
 */
export function createSeededRng(seed = 20261024) {
  let state = seed >>> 0;
  return function nextFloat() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseIsoDay(isoStr) {
  const [y, m, d] = String(isoStr).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}

function formatIsoDay(utcMs) {
  const d = new Date(utcMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const DAY_MS = 86_400_000;

function pickWeightedDivision(rng) {
  const total = DIVISION_PROFILES.reduce((s, d) => s + d.weight, 0);
  let roll = rng() * total;
  for (const prof of DIVISION_PROFILES) {
    roll -= prof.weight;
    if (roll <= 0) return prof;
  }
  return DIVISION_PROFILES[0];
}

/**
 * Splits whole-Taka grossAmountBDT across milestone labels with residual absorption
 * on the final tranche so tranche amounts ALWAYS sum to exact grossAmountBDT.
 */
export function buildMilestoneSchedule(grossAmountBDT, labels, status) {
  const safeGross = Math.max(1000, Math.round(Number(grossAmountBDT) || 0));
  const list = Array.isArray(labels) && labels.length > 0
    ? labels
    : ['Advance Mobilization', 'Mid-Stage Inspection', 'Final Handover'];
  const count = list.length;
  const weights = count === 4 ? [0.20, 0.30, 0.30, 0.20]
    : count === 3 ? [0.30, 0.40, 0.30]
    : list.map(() => 1 / count);

  let allocated = 0;
  return list.map((title, idx) => {
    const isLast = idx === count - 1;
    const amountBDT = isLast
      ? safeGross - allocated
      : Math.round(safeGross * weights[idx]);
    allocated += amountBDT;

    let trancheStatus = 'PENDING';
    if (status === 'FULLY_DISBURSED') trancheStatus = 'COMPLETED';
    else if (status === 'PARTIALLY_DISBURSED') trancheStatus = idx < Math.ceil(count / 2) ? 'COMPLETED' : (idx === Math.ceil(count / 2) ? 'PROOF_SUBMITTED' : 'IN_PROGRESS');
    else if (status === 'IN_ARBITRATION') trancheStatus = idx === 0 ? 'COMPLETED' : (idx === 1 ? 'DISPUTED' : 'LOCKED');
    else if (status === 'PENDING_CLEARANCE') trancheStatus = idx < count - 1 ? 'COMPLETED' : 'CLIENT_APPROVED';
    else trancheStatus = idx === 0 ? 'IN_PROGRESS' : 'PENDING';

    return {
      index: idx + 1,
      title,
      releasePercentage: Math.round(weights[idx] * 100),
      amountBDT,
      status: trancheStatus
    };
  });
}

/**
 * Generates 260 realistic Bangladesh construction & materials escrow records across 365 days.
 * Guaranteed 0-Taka drift: netDisbursedBDT + platformFeeBDT + retainageHoldBDT === grossAmountBDT.
 */
export function generateSampleAnalyticsDataset(seed = 20261024, anchorDate = ANCHOR_DATE) {
  const rng = createSeededRng(seed);
  const anchorMs = parseIsoDay(anchorDate);
  const records = [];
  const totalRecords = 260;

  for (let i = 0; i < totalRecords; i += 1) {
    // Bias slightly toward recent 90 days to reflect marketplace scale-up & post-monsoon surge
    const u = rng();
    const daysAgo = i < 24
      ? Math.floor(rng() * 7) // ensure rich density in 7D view
      : i < 95
        ? Math.floor(rng() * 30) // rich density in 30D view
        : i < 165
          ? 30 + Math.floor(rng() * 60) // 31..90 days ago
          : 90 + Math.floor(u * 274); // 91..364 days ago

    const dateMs = anchorMs - daysAgo * DAY_MS;
    const dateIso = formatIsoDay(dateMs);
    const monthIdx = new Date(dateMs).getUTCMonth(); // 0=Jan .. 9=Oct

    // Bangladesh seasonal construction factor: dry season (Oct-Apr) boost, monsoon (Jun-Aug) moderation
    const seasonalFactor = (monthIdx >= 5 && monthIdx <= 7)
      ? 0.84
      : (monthIdx >= 9 || monthIdx <= 3)
        ? 1.18
        : 1.0;

    // Secular marketplace growth factor as daysAgo approaches 0
    const growthFactor = 0.86 + ((365 - daysAgo) / 365) * 0.32;

    const divProfile = pickWeightedDivision(rng);
    const district = divProfile.districts[Math.floor(rng() * divProfile.districts.length)];

    const isContract = rng() < 0.58;
    const stream = isContract ? 'ESCROW_CONTRACT' : 'MATERIAL_ORDER';

    let segment;
    let title;
    let contractorTier;
    let counterparty;
    let baseBDT;
    let milestoneLabels;

    if (isContract) {
      const tpl = CONTRACT_TEMPLATES[Math.floor(rng() * CONTRACT_TEMPLATES.length)];
      segment = tpl.segment;
      title = tpl.title;
      contractorTier = tpl.tier;
      counterparty = CONTRACTORS[Math.floor(rng() * CONTRACTORS.length)];
      baseBDT = tpl.baseBDT;
      milestoneLabels = tpl.milestones;
    } else {
      const tpl = MATERIAL_TEMPLATES[Math.floor(rng() * MATERIAL_TEMPLATES.length)];
      segment = tpl.segment;
      title = tpl.title;
      contractorTier = 'MATERIAL_DEALER';
      counterparty = SUPPLIERS[Math.floor(rng() * SUPPLIERS.length)];
      baseBDT = tpl.baseBDT;
      milestoneLabels = ['Supplier Acceptance & Stock Lock', 'Waybill Dispatch & Weighbridge', 'Site Delivery Confirmation'];
    }

    const variance = 0.78 + rng() * 0.48;
    // Round to clean 500-BDT whole integer increments (>= 10,000 BDT)
    const rawGross = baseBDT * divProfile.multiplier * seasonalFactor * growthFactor * variance;
    const grossAmountBDT = Math.max(10000, Math.round(rawGross / 500) * 500);

    // Exact integer BDT splits with residual subtraction
    const platformFeeBDT = Math.round(grossAmountBDT * 0.05);
    const retainageHoldBDT = isContract ? Math.round(grossAmountBDT * 0.10) : 0;
    const netDisbursedBDT = grossAmountBDT - platformFeeBDT - retainageHoldBDT;

    // Lifecycle status realistic age progression
    const sRoll = rng();
    let status;
    if (daysAgo > 45) {
      if (sRoll < 0.72) status = 'FULLY_DISBURSED';
      else if (sRoll < 0.88) status = 'PARTIALLY_DISBURSED';
      else if (sRoll < 0.96) status = 'FUNDED';
      else status = 'IN_ARBITRATION';
    } else if (daysAgo > 12) {
      if (sRoll < 0.46) status = 'FULLY_DISBURSED';
      else if (sRoll < 0.70) status = isContract ? 'PARTIALLY_DISBURSED' : 'IN_TRANSIT';
      else if (sRoll < 0.86) status = 'FUNDED';
      else if (sRoll < 0.96) status = 'PENDING_CLEARANCE';
      else status = 'IN_ARBITRATION';
    } else {
      if (sRoll < 0.30) status = 'FULLY_DISBURSED';
      else if (sRoll < 0.56) status = isContract ? 'PARTIALLY_DISBURSED' : 'IN_TRANSIT';
      else if (sRoll < 0.80) status = 'FUNDED';
      else if (sRoll < 0.96) status = 'PENDING_CLEARANCE';
      else status = 'IN_ARBITRATION';
    }

    // Verification tier (improving adoption in recent months)
    const vRoll = rng();
    const cryptoThreshold = daysAgo < 60 ? 0.74 : 0.62;
    let verificationTier;
    if (vRoll < cryptoThreshold) verificationTier = 'CRYPTOGRAPHIC_PROOF';
    else if (vRoll < 0.90) verificationTier = 'GPS_ONLY';
    else if (vRoll < 0.96) verificationTier = 'TIME_ONLY';
    else verificationTier = 'REQUIRES_CLIENT_AUDIT';

    const trustScore = Math.min(99, Math.max(74, Math.round(84 + rng() * 15 - (status === 'IN_ARBITRATION' ? 9 : 0))));
    const gpsDistanceMeters = verificationTier === 'CRYPTOGRAPHIC_PROOF'
      ? Math.round(4 + rng() * 28)
      : verificationTier === 'GPS_ONLY'
        ? Math.round(18 + rng() * 65)
        : null;
    const settlementHours = Math.max(4, Math.round((daysAgo < 60 ? 15 : 21) + (rng() - 0.45) * 14));

    const prefix = isContract ? 'ESC' : 'ORD';
    const seqNum = String(104200 + i * 17).slice(-6);
    const id = `${prefix}-${dateIso.slice(2, 4)}${dateIso.slice(5, 7)}-${seqNum}`;

    const milestones = buildMilestoneSchedule(grossAmountBDT, milestoneLabels, status);

    records.push({
      id,
      date: dateIso,
      stream,
      title,
      counterparty,
      division: divProfile.division,
      district,
      segment,
      contractorTier,
      status,
      verificationTier,
      grossAmountBDT,
      platformFeeBDT,
      retainageHoldBDT,
      netDisbursedBDT,
      trustScore,
      gpsDistanceMeters,
      settlementHours,
      milestoneCount: milestones.length,
      milestones
    });
  }

  return records.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

/**
 * Resolves preset ('7D', '30D', '90D', 'YTD', 'ALL', 'CUSTOM') into exact current & previous ISO date windows.
 */
export function resolveDateWindow(preset = '30D', customStart = '', customEnd = '', anchorDate = ANCHOR_DATE) {
  const anchorMs = parseIsoDay(anchorDate);
  let startMs;
  let endMs = anchorMs;

  if (preset === 'CUSTOM' && customStart && customEnd) {
    const cs = parseIsoDay(customStart);
    const ce = parseIsoDay(customEnd);
    startMs = Math.min(cs, ce);
    endMs = Math.max(cs, ce);
  } else if (preset === '7D') {
    startMs = anchorMs - 6 * DAY_MS;
  } else if (preset === '90D') {
    startMs = anchorMs - 89 * DAY_MS;
  } else if (preset === 'YTD') {
    const year = new Date(anchorMs).getUTCFullYear();
    startMs = Date.UTC(year, 0, 1);
  } else if (preset === 'ALL') {
    startMs = anchorMs - 364 * DAY_MS;
  } else {
    // Default 30D
    startMs = anchorMs - 29 * DAY_MS;
  }

  const spanDays = Math.max(1, Math.round((endMs - startMs) / DAY_MS) + 1);
  const prevEndMs = startMs - DAY_MS;
  const prevStartMs = prevEndMs - (spanDays - 1) * DAY_MS;

  return {
    startDate: formatIsoDay(startMs),
    endDate: formatIsoDay(endMs),
    prevStartDate: formatIsoDay(prevStartMs),
    prevEndDate: formatIsoDay(prevEndMs),
    spanDays
  };
}

/**
 * Filters records across all global & table-level facets.
 */
export function filterRecords(records, filters = {}) {
  const {
    startDate = '',
    endDate = '',
    division = 'ALL',
    stream = 'ALL',
    segment = 'ALL',
    contractorTier = 'ALL',
    status = 'ALL',
    verificationTier = 'ALL',
    search = ''
  } = filters;

  const normalizedQuery = bengaliToAscii(String(search || '')).trim().toLowerCase();

  return records.filter((r) => {
    if (startDate && r.date < startDate) return false;
    if (endDate && r.date > endDate) return false;
    if (division && division !== 'ALL' && r.division !== division) return false;
    if (stream && stream !== 'ALL' && r.stream !== stream) return false;
    if (segment && segment !== 'ALL' && r.segment !== segment) return false;
    if (contractorTier && contractorTier !== 'ALL' && r.contractorTier !== contractorTier) return false;
    if (status && status !== 'ALL' && r.status !== status) return false;
    if (verificationTier && verificationTier !== 'ALL' && r.verificationTier !== verificationTier) return false;

    if (normalizedQuery) {
      const haystack = `${r.id} ${r.title} ${r.counterparty} ${r.division} ${r.district} ${r.segment} ${r.status} ${r.grossAmountBDT}`.toLowerCase();
      if (!haystack.includes(normalizedQuery)) return false;
    }
    return true;
  });
}

function pctDelta(current, previous) {
  if (!previous || previous <= 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function buildSparklineBuckets(records, startDate, endDate, extractor, bucketCount = 12) {
  const sMs = parseIsoDay(startDate);
  const eMs = Math.max(sMs, parseIsoDay(endDate));
  const totalSpan = Math.max(DAY_MS, eMs - sMs + DAY_MS);
  const buckets = new Array(bucketCount).fill(0);
  const counts = new Array(bucketCount).fill(0);

  for (const r of records) {
    const rMs = parseIsoDay(r.date);
    if (rMs < sMs || rMs > eMs) continue;
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor(((rMs - sMs) / totalSpan) * bucketCount)));
    buckets[idx] += extractor(r);
    counts[idx] += 1;
  }
  return { buckets, counts };
}

/**
 * Computes all 6 Executive KPIs with period-over-period trends & 12-point sparklines.
 */
export function computeExecutiveKpis(currentRecords, previousRecords, dateWindow) {
  const summarize = (list) => {
    let grossGmvBDT = 0;
    let settledPayoutBDT = 0;
    let platformRevenueBDT = 0;
    let activeCount = 0;
    let settledCount = 0;
    let cryptoVerifiedCount = 0;
    let disputeCount = 0;
    let settlementHoursTotal = 0;

    for (const r of list) {
      grossGmvBDT += r.grossAmountBDT;
      platformRevenueBDT += r.platformFeeBDT;

      if (r.status === 'FULLY_DISBURSED') {
        settledPayoutBDT += r.netDisbursedBDT;
        settledCount += 1;
      } else if (r.status === 'PARTIALLY_DISBURSED') {
        settledPayoutBDT += Math.round(r.netDisbursedBDT * 0.5);
      }

      if (r.status === 'FUNDED' || r.status === 'PARTIALLY_DISBURSED' || r.status === 'IN_TRANSIT' || r.status === 'PENDING_CLEARANCE') {
        activeCount += 1;
      }
      if (r.verificationTier === 'CRYPTOGRAPHIC_PROOF') cryptoVerifiedCount += 1;
      if (r.status === 'IN_ARBITRATION') disputeCount += 1;
      settlementHoursTotal += r.settlementHours || 18;
    }

    const total = list.length;
    const cryptoRatePct = total > 0 ? (cryptoVerifiedCount / total) * 100 : 0;
    const disputeRatePct = total > 0 ? (disputeCount / total) * 100 : 0;
    const avgSettlementHours = total > 0 ? settlementHoursTotal / total : 0;

    return {
      totalCount: total,
      grossGmvBDT,
      settledPayoutBDT,
      platformRevenueBDT,
      activeCount,
      settledCount,
      cryptoRatePct,
      disputeRatePct,
      avgSettlementHours
    };
  };

  const cur = summarize(currentRecords);
  const prev = summarize(previousRecords);

  const start = dateWindow?.startDate || '2026-09-25';
  const end = dateWindow?.endDate || ANCHOR_DATE;

  const gmvSpark = buildSparklineBuckets(currentRecords, start, end, (r) => r.grossAmountBDT).buckets;
  const settledSpark = buildSparklineBuckets(
    currentRecords,
    start,
    end,
    (r) => (r.status === 'FULLY_DISBURSED' ? r.netDisbursedBDT : r.status === 'PARTIALLY_DISBURSED' ? Math.round(r.netDisbursedBDT * 0.5) : 0)
  ).buckets;
  const revSpark = buildSparklineBuckets(currentRecords, start, end, (r) => r.platformFeeBDT).buckets;
  const activeSpark = buildSparklineBuckets(currentRecords, start, end, () => 1).buckets;

  const cryptoBuckets = buildSparklineBuckets(currentRecords, start, end, (r) => (r.verificationTier === 'CRYPTOGRAPHIC_PROOF' ? 100 : 0));
  const cryptoSpark = cryptoBuckets.buckets.map((sum, i) => (cryptoBuckets.counts[i] > 0 ? Math.round(sum / cryptoBuckets.counts[i]) : 72));

  const speedBuckets = buildSparklineBuckets(currentRecords, start, end, (r) => r.settlementHours || 18);
  const speedSpark = speedBuckets.buckets.map((sum, i) => (speedBuckets.counts[i] > 0 ? Math.round(sum / speedBuckets.counts[i]) : 16));

  return {
    totalRecords: cur.totalCount,
    gmv: {
      valueBDT: cur.grossGmvBDT,
      prevBDT: prev.grossGmvBDT,
      deltaPct: pctDelta(cur.grossGmvBDT, prev.grossGmvBDT),
      sparkline: gmvSpark
    },
    settled: {
      valueBDT: cur.settledPayoutBDT,
      prevBDT: prev.settledPayoutBDT,
      settledCount: cur.settledCount,
      deltaPct: pctDelta(cur.settledPayoutBDT, prev.settledPayoutBDT),
      sparkline: settledSpark
    },
    revenue: {
      valueBDT: cur.platformRevenueBDT,
      prevBDT: prev.platformRevenueBDT,
      deltaPct: pctDelta(cur.platformRevenueBDT, prev.platformRevenueBDT),
      sparkline: revSpark
    },
    activeOps: {
      value: cur.activeCount,
      totalInWindow: cur.totalCount,
      prev: prev.activeCount,
      deltaPct: pctDelta(cur.totalCount, prev.totalCount),
      sparkline: activeSpark
    },
    cryptoProof: {
      valuePct: cur.cryptoRatePct,
      prevPct: prev.cryptoRatePct,
      deltaPp: cur.cryptoRatePct - prev.cryptoRatePct,
      sparkline: cryptoSpark
    },
    settlementSpeed: {
      hours: cur.avgSettlementHours,
      prevHours: prev.avgSettlementHours,
      disputeRatePct: cur.disputeRatePct,
      // Lower settlement hours is a positive operational improvement
      deltaPct: pctDelta(cur.avgSettlementHours, prev.avgSettlementHours),
      sparkline: speedSpark
    }
  };
}

/**
 * Aggregates records into Daily, Weekly, or Monthly buckets for the multi-series Line/Area Chart.
 */
export function computeTimeSeries(records, startDate, endDate, granularity = 'auto') {
  const sMs = parseIsoDay(startDate);
  const eMs = Math.max(sMs, parseIsoDay(endDate));
  const spanDays = Math.max(1, Math.round((eMs - sMs) / DAY_MS) + 1);

  let mode = granularity;
  if (mode === 'auto') {
    if (spanDays <= 35) mode = 'daily';
    else if (spanDays <= 140) mode = 'weekly';
    else mode = 'monthly';
  }

  const bucketMap = new Map();

  const bucketKeyForMs = (ms) => {
    const d = new Date(ms);
    if (mode === 'monthly') {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      return `${y}-${m}-01`;
    }
    if (mode === 'weekly') {
      // Align to week steps from startDate
      const offsetDays = Math.floor((ms - sMs) / (7 * DAY_MS)) * 7;
      return formatIsoDay(sMs + offsetDays * DAY_MS);
    }
    return formatIsoDay(ms);
  };

  // Pre-seed continuous timeline buckets so there are no missing gaps
  if (mode === 'monthly') {
    const cur = new Date(sMs);
    cur.setUTCDate(1);
    while (cur.getTime() <= eMs) {
      const k = formatIsoDay(cur.getTime());
      bucketMap.set(k, { date: k, grossBDT: 0, settledBDT: 0, feeBDT: 0, escrowBDT: 0, materialsBDT: 0, count: 0 });
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
  } else if (mode === 'weekly') {
    for (let ms = sMs; ms <= eMs; ms += 7 * DAY_MS) {
      const k = formatIsoDay(ms);
      bucketMap.set(k, { date: k, grossBDT: 0, settledBDT: 0, feeBDT: 0, escrowBDT: 0, materialsBDT: 0, count: 0 });
    }
  } else {
    for (let ms = sMs; ms <= eMs; ms += DAY_MS) {
      const k = formatIsoDay(ms);
      bucketMap.set(k, { date: k, grossBDT: 0, settledBDT: 0, feeBDT: 0, escrowBDT: 0, materialsBDT: 0, count: 0 });
    }
  }

  for (const r of records) {
    const rMs = parseIsoDay(r.date);
    if (rMs < sMs || rMs > eMs) continue;
    const key = bucketKeyForMs(rMs);
    if (!bucketMap.has(key)) {
      bucketMap.set(key, { date: key, grossBDT: 0, settledBDT: 0, feeBDT: 0, escrowBDT: 0, materialsBDT: 0, count: 0 });
    }
    const b = bucketMap.get(key);
    b.grossBDT += r.grossAmountBDT;
    b.feeBDT += r.platformFeeBDT;
    if (r.status === 'FULLY_DISBURSED') b.settledBDT += r.netDisbursedBDT;
    else if (r.status === 'PARTIALLY_DISBURSED') b.settledBDT += Math.round(r.netDisbursedBDT * 0.5);
    if (r.stream === 'ESCROW_CONTRACT') b.escrowBDT += r.grossAmountBDT;
    else b.materialsBDT += r.grossAmountBDT;
    b.count += 1;
  }

  return {
    granularity: mode,
    points: [...bucketMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  };
}

/**
 * Aggregates records for the Grouped/Stacked Bar Chart by 'division' or 'segment'.
 */
export function computeBarBreakdown(records, dimension = 'division') {
  const groups = new Map();
  let grandTotalBDT = 0;

  const seedKeys = dimension === 'division'
    ? DIVISIONS
    : [...PROJECT_SEGMENTS, 'ROD', 'CEMENT', 'BRICK'];

  for (const key of seedKeys) {
    groups.set(key, { key, escrowBDT: 0, materialsBDT: 0, totalBDT: 0, count: 0 });
  }

  for (const r of records) {
    const k = dimension === 'division' ? r.division : r.segment;
    if (!groups.has(k)) {
      groups.set(k, { key: k, escrowBDT: 0, materialsBDT: 0, totalBDT: 0, count: 0 });
    }
    const item = groups.get(k);
    if (r.stream === 'ESCROW_CONTRACT') item.escrowBDT += r.grossAmountBDT;
    else item.materialsBDT += r.grossAmountBDT;
    item.totalBDT += r.grossAmountBDT;
    item.count += 1;
    grandTotalBDT += r.grossAmountBDT;
  }

  return [...groups.values()]
    .filter((g) => g.totalBDT > 0 || dimension === 'division')
    .sort((a, b) => b.totalBDT - a.totalBDT)
    .slice(0, 8)
    .map((g) => ({
      ...g,
      sharePct: grandTotalBDT > 0 ? (g.totalBDT / grandTotalBDT) * 100 : 0
    }));
}

/**
 * Aggregates records for the Donut Chart by 'status' (Escrow Lifecycle) or 'materials' (Material Categories).
 */
export function computeDonutBreakdown(records, mode = 'status') {
  const source = mode === 'materials'
    ? records.filter((r) => r.stream === 'MATERIAL_ORDER')
    : records;

  const map = new Map();
  let totalBDT = 0;

  for (const r of source) {
    const k = mode === 'materials' ? r.segment : r.status;
    if (!map.has(k)) {
      map.set(k, { key: k, grossBDT: 0, count: 0 });
    }
    const bucket = map.get(k);
    bucket.grossBDT += r.grossAmountBDT;
    bucket.count += 1;
    totalBDT += r.grossAmountBDT;
  }

  const slices = [...map.values()]
    .sort((a, b) => b.grossBDT - a.grossBDT)
    .map((s) => ({
      ...s,
      sharePct: totalBDT > 0 ? (s.grossBDT / totalBDT) * 100 : 0
    }));

  return {
    mode,
    totalBDT,
    totalCount: source.length,
    slices
  };
}

/**
 * Multi-column deterministic sorting for the Operations Data Table.
 */
export function sortRecords(records, sortKey = 'date', sortDir = 'desc') {
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...records].sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'grossAmountBDT' || sortKey === 'platformFeeBDT' || sortKey === 'trustScore') {
      cmp = (Number(a[sortKey]) || 0) - (Number(b[sortKey]) || 0);
    } else {
      cmp = String(a[sortKey] || '').localeCompare(String(b[sortKey] || ''));
    }
    if (cmp !== 0) return cmp * dir;
    return b.date.localeCompare(a.date) || b.id.localeCompare(a.id);
  });
}

export function paginateRecords(records, page = 1, pageSize = 10) {
  const safeSize = Math.max(1, Number(pageSize) || 10);
  const total = records.length;
  const totalPages = Math.max(1, Math.ceil(total / safeSize));
  const currentPage = Math.min(totalPages, Math.max(1, Number(page) || 1));
  const startIdx = (currentPage - 1) * safeSize;
  return {
    rows: records.slice(startIdx, startIdx + safeSize),
    total,
    totalPages,
    page: currentPage,
    pageSize: safeSize,
    startIndex: total === 0 ? 0 : startIdx + 1,
    endIndex: Math.min(total, startIdx + safeSize)
  };
}

function escapeCsvCell(val) {
  const str = String(val ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function recordsToCsv(records) {
  const headers = [
    'Reference_ID',
    'Date',
    'Stream',
    'Title',
    'Counterparty',
    'Division',
    'District',
    'Segment',
    'Tier',
    'Status',
    'Verification_Tier',
    'Gross_Escrow_BDT',
    'Platform_Fee_BDT',
    'Retainage_Hold_BDT',
    'Net_Disbursed_BDT',
    'Trust_Score'
  ];
  const lines = [headers.join(',')];
  for (const r of records) {
    lines.push([
      r.id,
      r.date,
      r.stream,
      r.title,
      r.counterparty,
      r.division,
      r.district,
      r.segment,
      r.contractorTier,
      r.status,
      r.verificationTier,
      r.grossAmountBDT,
      r.platformFeeBDT,
      r.retainageHoldBDT,
      r.netDisbursedBDT,
      r.trustScore
    ].map(escapeCsvCell).join(','));
  }
  return lines.join('\n');
}
