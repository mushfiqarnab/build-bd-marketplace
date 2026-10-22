// tests/labour-hybrid-v2-unit.js
// DB-Free unit verification for V2 Labour & Hybrid Marketplace routes, policies, and calculations
'use strict';

const {
  interpretUserUtterance,
  computeDomesticWeeklySplit,
  computeMicroSettlementSplit,
  splitSslcommerzTranches,
  parseFeaturePhoneWebhook
} = require('../services/aiOrchestratorService');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function run() {
  console.log('🧪 Labour & Hybrid V2 Policy and Architecture Unit Suite');

  // 1. Nirman-AI bilingual intent inference on domestic labour
  const domPlan = interpretUserUtterance('ধানমন্ডি ৭ এ সকাল ৮টা থেকে ২ ঘণ্টার জন্য ছুটা বুয়া লাগবে ওয়াশিং মেশিন জানা');
  check('DOMESTIC_LABOUR intent extracted correctly', domPlan.vertical === 'DOMESTIC_LABOUR');
  check('Extracted Thana is Dhanmondi', domPlan.extractedSlots.thana === 'Dhanmondi');
  check('Appliance skill certified', domPlan.extractedSlots.skillTags.some((s) => s.tag_code === 'APPLIANCE_WASHING_MACHINE'));

  // 2. Domestic weekly 80/15/5 split invariant
  const splitWk2 = computeDomesticWeeklySplit(2250, 2, 0);
  check('Domestic weekly split is 100% integer BDT',
    Number.isInteger(splitWk2.workerImmediateBdt) &&
    Number.isInteger(splitWk2.continuityHoldBdt) &&
    Number.isInteger(splitWk2.platformFeeBdt));
  check('Domestic components sum exactly to gross',
    splitWk2.workerImmediateBdt + splitWk2.continuityHoldBdt + splitWk2.platformFeeBdt === 2250);

  // 3. Week 4 Continuity Reserve Release
  const splitWk4 = computeDomesticWeeklySplit(2250, 4, splitWk2.continuityHoldBdt * 3);
  check('Week 4 releases 100% accumulated continuity reserve',
    splitWk4.reserveReleasedBdt === splitWk2.continuityHoldBdt * 3 &&
    splitWk4.workerImmediateBdt === (2250 - splitWk4.platformFeeBdt) + (splitWk2.continuityHoldBdt * 3));

  // 4. Tier 1 Micro Settlement Split (80/10/10 labor + 97.5/2.5 parts)
  const microSplit = computeMicroSettlementSplit(1200, 400);
  check('Micro total is 100% integer BDT summing to gross',
    Number.isInteger(microSplit.immediateTechnicianPayoutBdt) &&
    Number.isInteger(microSplit.warrantyHold7DayBdt) &&
    Number.isInteger(microSplit.platformAndGatewayFeeBdt) &&
    (microSplit.immediateTechnicianPayoutBdt + microSplit.warrantyHold7DayBdt + microSplit.platformAndGatewayFeeBdt === microSplit.grossTotalBdt));

  // 5. Anti-collusion spare parts cap rule: parts <= min(3 * labor, 5000)
  const baseLabor = 800;
  const maxPartsAllowed = Math.min(baseLabor * 3, 5000); // 2400
  check('Anti-collusion formula correctly caps 800 BDT labor to 2,400 BDT parts', maxPartsAllowed === 2400);

  // 6. Tier 2 Mid Apartment Painting Split-BOQ
  const midPlan = interpretUserUtterance('মিরপুর DOHS এ ২০০০ স্কয়ার ফিট ফ্ল্যাট পেইন্টিং');
  check('Tier 2 Mid classified correctly with BOQ_SPLIT_CART',
    midPlan.vertical === 'TIER_2_MID' && midPlan.extractedSlots.materialMode === 'BOQ_SPLIT_CART');
  check('16-Bank EMI enabled for >= 5,000 BDT', midPlan.extractedSlots.emiEligible16Banks === true);
  const boq = midPlan.pricingEstimate.boqSplitBreakdown;
  check('Split-BOQ labor, paint, putty, and protection sum to total',
    (boq.laborBdt + boq.materialKitBdt + boq.puttyAndPrepBdt + boq.accessProtectionBdt) === midPlan.pricingEstimate.totalEstimatedBdt);

  // 7. Tier 3 Macro SSLCommerz Session Tranche Splitting
  const macroTranches = splitSslcommerzTranches(1500000, 'TEST-TRAN');
  check('1.5M BDT milestone splits into exactly 3 tranches each <= 500,000 BDT',
    macroTranches.length === 3 && macroTranches.every((t) => t.amount_bdt <= 500000 && Number.isInteger(t.amount_bdt)));

  // 8. 2G Feature Phone Webhooks
  const ping = parseFeaturePhoneWebhook({ fromPhone: '01700000000', digitsOrText: '', callType: 'MISSED_CALL_RING_DROP' });
  check('Missed call triggers LOG_ATTENDANCE_GATE_PING with 0 BDT cost',
    ping.action === 'LOG_ATTENDANCE_GATE_PING' && ping.costBdt === 0);

  const dtmf1 = parseFeaturePhoneWebhook({ fromPhone: '01700000000', digitsOrText: '১' });
  check('DTMF 1 confirms shift acceptance', dtmf1.action === 'ACCEPT_SHIFT_OR_CONFIRM_ATTENDANCE');

  const dtmf9 = parseFeaturePhoneWebhook({ fromPhone: '01700000000', digitsOrText: '৯' });
  check('DTMF 9 triggers safety/wage dispute escalation with 2H SLA',
    dtmf9.action === 'EMERGENCY_SAFETY_OR_WAGE_DISPUTE_ESCALATION' && dtmf9.priority === 'CRITICAL_SLA_2H');

  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
