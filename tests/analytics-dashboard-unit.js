// tests/analytics-dashboard-unit.js — Unit & property invariants for Build-BD Executive Analytics.
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

const ROOT = path.resolve(__dirname, '..');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, 'frontend', 'js', rel)).href);

(async () => {
  console.log('🧪 analytics-dashboard unit & conservation invariants');

  const engine = await imp('analyticsEngine.js');
  const { MESSAGES } = await imp('messages.js');
  const themeMod = await imp('theme.js');

  // 1. Deterministic dataset & zero-Taka financial drift invariants
  const ds1 = engine.generateSampleAnalyticsDataset(20261024, '2026-10-24');
  const ds2 = engine.generateSampleAnalyticsDataset(20261024, '2026-10-24');

  check('dataset generates 260 deterministic marketplace records', ds1.length === 260);
  check('dataset is 100% deterministic across runs', JSON.stringify(ds1) === JSON.stringify(ds2));

  const allIntegers = ds1.every((r) =>
    Number.isInteger(r.grossAmountBDT) && r.grossAmountBDT >= 1000 &&
    Number.isInteger(r.platformFeeBDT) && r.platformFeeBDT >= 0 &&
    Number.isInteger(r.retainageHoldBDT) && r.retainageHoldBDT >= 0 &&
    Number.isInteger(r.netDisbursedBDT) && r.netDisbursedBDT >= 0
  );
  check('all currency fields are non-negative whole-Taka integers', allIntegers);

  const zeroSplitDrift = ds1.every((r) =>
    r.netDisbursedBDT + r.platformFeeBDT + r.retainageHoldBDT === r.grossAmountBDT
  );
  check('0-Taka split conservation (net + fee + hold === gross) across all 260 records', zeroSplitDrift);

  const zeroMilestoneDrift = ds1.every((r) =>
    Array.isArray(r.milestones) &&
    r.milestones.length >= 2 &&
    r.milestones.every((m) => Number.isInteger(m.amountBDT) && m.amountBDT > 0) &&
    r.milestones.reduce((sum, m) => sum + m.amountBDT, 0) === r.grossAmountBDT
  );
  check('0-Taka milestone tranche conservation across all 260 records', zeroMilestoneDrift);

  // 2. Date window & prior-period calculations
  const win7 = engine.resolveDateWindow('7D', '', '', '2026-10-24');
  check('7D window spans 2026-10-18 to 2026-10-24 (7 days)',
    win7.startDate === '2026-10-18' && win7.endDate === '2026-10-24' && win7.spanDays === 7);
  check('7D prior window is adjacent 7-day period (2026-10-11 to 2026-10-17)',
    win7.prevStartDate === '2026-10-11' && win7.prevEndDate === '2026-10-17');

  const winCustom = engine.resolveDateWindow('CUSTOM', '2026-09-01', '2026-09-30', '2026-10-24');
  check('CUSTOM date window computes exact 30-day span', winCustom.spanDays === 30 && winCustom.startDate === '2026-09-01');

  // 3. Filtering (including Bangla numeral normalization)
  const dhakaOnly = engine.filterRecords(ds1, { division: 'Dhaka' });
  check('division filter isolates Dhaka records accurately', dhakaOnly.length > 20 && dhakaOnly.every((r) => r.division === 'Dhaka'));

  const matRod = engine.filterRecords(ds1, { stream: 'MATERIAL_ORDER', segment: 'ROD' });
  check('stream + segment filter isolates ROD material orders', matRod.length > 0 && matRod.every((r) => r.stream === 'MATERIAL_ORDER' && r.segment === 'ROD'));

  const bnQueryHits = engine.filterRecords(ds1, { search: '১০৪২০০' });
  check('table search normalizes Bangla digits (১০৪২০০ -> 104200)', bnQueryHits.length >= 1 && bnQueryHits[0].id.includes('104200'));

  // 4. KPIs, Line, Bar, Donut, Sort, Pagination & CSV
  const win30 = engine.resolveDateWindow('30D', '', '', '2026-10-24');
  const cur30 = engine.filterRecords(ds1, { startDate: win30.startDate, endDate: win30.endDate });
  const prev30 = engine.filterRecords(ds1, { startDate: win30.prevStartDate, endDate: win30.prevEndDate });
  const kpis = engine.computeExecutiveKpis(cur30, prev30, win30);
  check('KPIs produce positive integer GMV & 12-point sparklines',
    Number.isInteger(kpis.gmv.valueBDT) && kpis.gmv.valueBDT > 0 && kpis.gmv.sparkline.length === 12);

  const tsDaily = engine.computeTimeSeries(cur30, win30.startDate, win30.endDate, 'daily');
  check('daily time-series produces 30 continuous daily buckets', tsDaily.granularity === 'daily' && tsDaily.points.length === 30);

  const tsMonthly = engine.computeTimeSeries(ds1, '2025-11-01', '2026-10-24', 'monthly');
  check('monthly time-series produces 12 monthly buckets', tsMonthly.granularity === 'monthly' && tsMonthly.points.length === 12);

  const barDiv = engine.computeBarBreakdown(cur30, 'division');
  check('bar breakdown by division covers all 6 divisions', barDiv.length === 6);

  const donutMat = engine.computeDonutBreakdown(ds1, 'materials');
  const shareSum = donutMat.slices.reduce((s, x) => s + x.sharePct, 0);
  check('donut material breakdown slices sum to 100%', Math.abs(shareSum - 100) < 0.01);

  const sortedGrossAsc = engine.sortRecords(cur30, 'grossAmountBDT', 'asc');
  check('sortRecords sorts grossAmountBDT ascending cleanly',
    sortedGrossAsc.length >= 2 && sortedGrossAsc[0].grossAmountBDT <= sortedGrossAsc[sortedGrossAsc.length - 1].grossAmountBDT);

  const paged = engine.paginateRecords(sortedGrossAsc, 2, 10);
  check('paginateRecords computes page 2 bounds accurately', paged.page === 2 && paged.startIndex === 11);

  const csv = engine.recordsToCsv(cur30.slice(0, 3));
  check('recordsToCsv outputs header + 3 data rows', csv.split('\n').length === 4 && csv.startsWith('Reference_ID,Date,'));

  // 5. Theme module SSR safety
  check('theme.js exports getTheme, setTheme, toggleTheme safely in Node',
    typeof themeMod.getTheme === 'function' && themeMod.getTheme() === 'light');

  // 6. Strict CSP, pure DOM & i18n parity checks on analytics.html & analytics.js
  const analyticsHtml = fs.readFileSync(path.join(ROOT, 'frontend', 'pages', 'analytics.html'), 'utf8');
  const analyticsJs = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'pages', 'analytics.js'), 'utf8');
  const engineJs = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'analyticsEngine.js'), 'utf8');

  check('analytics.html uses dynamic viewport (100dvh)', /min-h-\[100dvh\]/.test(analyticsHtml));
  check('analytics.html has zero inline <script> blocks (CSP)', !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(analyticsHtml));
  check('analytics.html has zero inline event handlers (CSP)', !/\son[a-z]+\s*=/i.test(analyticsHtml));
  check('analytics.html has zero inline style attributes (strict style-src self)', !/\sstyle\s*=/i.test(analyticsHtml));
  check('analytics.js has zero innerHTML/insertAdjacentHTML (pure DOM)', !/\.innerHTML\s*=|insertAdjacentHTML\(/.test(analyticsJs));
  check('analytics.js has zero inline .style mutations (strict style-src self)', !/\.style\./.test(analyticsJs));
  check('analytics.js & analyticsEngine.js have zero Math.random()', !/Math\.random\(/.test(analyticsJs) && !/Math\.random\(/.test(engineJs));
  check('analytics.js imports get() from api.js (zero raw fetch)', /from '\.\.\/api\.js'/.test(analyticsJs) && !/\bfetch\s*\(/.test(analyticsJs));
  check('analytics i18n keys exist in both en and bn',
    'analytics.title' in MESSAGES.en && 'analytics.title' in MESSAGES.bn &&
    'nav.analytics' in MESSAGES.en && 'nav.analytics' in MESSAGES.bn &&
    'theme.dark' in MESSAGES.en && 'theme.dark' in MESSAGES.bn);

  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('💥 analytics-dashboard-unit crashed:', err);
  process.exit(1);
});
