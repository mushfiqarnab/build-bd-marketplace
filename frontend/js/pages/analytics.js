// frontend/js/pages/analytics.js — Interactive Executive Marketplace Analytics Controller.
//
// Invariants (.agy-rules.md & strict CSP):
//   - 100% pure DOM construction via createElement / createElementNS / textContent
//   - Strict CSP style-src 'self' compliant via SVG geometry attributes + stylesheet classes
//   - Network requests routed exclusively through ../api.js
//   - 100% English & Bangla parity via ../i18n.js with Lakh/Crore BDT formatting
//   - Every interactive control >= 44px touch target

import { initShell } from '../shell.js';
import { get } from '../api.js';
import { t, applyLang, formatTaka, formatDate, getLang, toBengaliDigits } from '../i18n.js';
import { getTheme, applyTheme } from '../theme.js';
import {
  ANCHOR_DATE,
  DIVISIONS,
  PROJECT_SEGMENTS,
  MATERIAL_SEGMENTS,
  CONTRACTOR_TIERS,
  LEDGER_STATUSES,
  VERIFICATION_TIERS,
  generateSampleAnalyticsDataset,
  resolveDateWindow,
  filterRecords,
  computeExecutiveKpis,
  computeTimeSeries,
  computeBarBreakdown,
  computeDonutBreakdown,
  sortRecords,
  paginateRecords,
  recordsToCsv
} from '../analyticsEngine.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  return node;
}

function icon(name, extraClass = '') {
  const span = el('span', `icon ${extraClass}`.trim(), name);
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function formatNum(n, decimals = 0) {
  const formatted = Number(n || 0).toFixed(decimals);
  return getLang() === 'bn' ? toBengaliDigits(formatted) : formatted;
}

function formatCompactTaka(amount) {
  const val = Math.round(Number(amount) || 0);
  const lang = getLang();
  if (val >= 10_000_000) {
    const cr = (val / 10_000_000).toFixed(1).replace(/\.0$/, '');
    return lang === 'bn' ? `৳${toBengaliDigits(cr)} কোটি` : `৳${cr} Cr`;
  }
  if (val >= 100_000) {
    const lk = (val / 100_000).toFixed(1).replace(/\.0$/, '');
    return lang === 'bn' ? `৳${toBengaliDigits(lk)} লক্ষ` : `৳${lk} L`;
  }
  if (val >= 1_000) {
    const k = Math.round(val / 1_000);
    return lang === 'bn' ? `৳${toBengaliDigits(k)} হাজার` : `৳${k}K`;
  }
  return formatTaka(val);
}

function getPalette() {
  const dark = getTheme() === 'dark';
  return dark
    ? {
        primary: '#38bdf8',
        primaryFill: 'rgba(56, 189, 248, 0.22)',
        secondary: '#34d399',
        tertiary: '#fbbf24',
        quaternary: '#a78bfa',
        danger: '#fb7185',
        teal: '#2dd4bf',
        grid: '#1e293b',
        axis: '#94a3b8',
        cardBg: '#0f172a',
        hoverBand: 'rgba(56, 189, 248, 0.08)',
        tooltipBg: '#1e293b',
        tooltipBorder: '#475569',
        tooltipText: '#f8fafc',
        tooltipMuted: '#cbd5e1',
        slices: ['#38bdf8', '#34d399', '#fbbf24', '#a78bfa', '#2dd4bf', '#fb7185', '#60a5fa', '#f472b6']
      }
    : {
        primary: '#0284c7',
        primaryFill: 'rgba(2, 132, 199, 0.16)',
        secondary: '#059669',
        tertiary: '#d97706',
        quaternary: '#4f46e5',
        danger: '#e11d48',
        teal: '#0d9488',
        grid: '#e2e8f0',
        axis: '#475569',
        cardBg: '#ffffff',
        hoverBand: 'rgba(2, 132, 199, 0.06)',
        tooltipBg: '#0f172a',
        tooltipBorder: '#334155',
        tooltipText: '#f8fafc',
        tooltipMuted: '#cbd5e1',
        slices: ['#0284c7', '#059669', '#d97706', '#4f46e5', '#0d9488', '#e11d48', '#2563eb', '#9333ea']
      };
}

function labelForSegment(seg) {
  return t(`analytics.seg.${seg}`);
}

function labelForDivision(div) {
  const key = `analytics.div.${div}`;
  const out = t(key);
  return out === key ? div : out;
}

function labelForStatus(st) {
  const key = `analytics.status.${st}`;
  const out = t(key);
  return out === key ? st : out;
}

function labelForTier(tier) {
  const key = `analytics.tier.${tier}`;
  const out = t(key);
  return out === key ? tier : out;
}

function labelForVerify(vt) {
  const key = `analytics.verify.${vt}`;
  const out = t(key);
  return out === key ? vt : out;
}

function statusBadgeClass(status) {
  if (status === 'FULLY_DISBURSED') return 'ana-badge ana-badge-positive';
  if (status === 'IN_ARBITRATION') return 'ana-badge ana-badge-negative';
  if (status === 'PENDING_CLEARANCE' || status === 'IN_TRANSIT') return 'ana-badge ana-badge-amber';
  if (status === 'FUNDED' || status === 'PARTIALLY_DISBURSED') return 'ana-badge ana-badge-info';
  return 'ana-badge ana-badge-neutral';
}

// ── State ────────────────────────────────────────────────────────────────────
const sampleRecords = generateSampleAnalyticsDataset(20261024, ANCHOR_DATE);
let allRecords = sampleRecords;
let hasLiveDbRecords = false;

const initialWindow = resolveDateWindow('30D', '', '', ANCHOR_DATE);

const state = {
  preset: '30D',
  startDate: initialWindow.startDate,
  endDate: initialWindow.endDate,
  prevStartDate: initialWindow.prevStartDate,
  prevEndDate: initialWindow.prevEndDate,
  division: 'ALL',
  stream: 'ALL',
  segment: 'ALL',
  contractorTier: 'ALL',
  status: 'ALL',
  verificationTier: 'ALL',
  search: '',
  granularity: 'auto',
  visibleSeries: { gmv: true, settled: true, fee: true },
  donutMode: 'status',
  barDimension: 'division',
  sortKey: 'date',
  sortDir: 'desc',
  page: 1,
  pageSize: 10
};

let currentFilteredRecords = [];

// ── Select Option Hydration ──────────────────────────────────────────────────
function populateFilterSelects() {
  const divSel = $('filter-division');
  divSel.replaceChildren(new Option(t('analytics.filter.allDivisions'), 'ALL'));
  for (const d of DIVISIONS) divSel.append(new Option(labelForDivision(d), d));
  divSel.value = state.division;

  const streamSel = $('filter-stream');
  streamSel.replaceChildren(
    new Option(t('analytics.filter.allStreams'), 'ALL'),
    new Option(t('analytics.filter.streamEscrow'), 'ESCROW_CONTRACT'),
    new Option(t('analytics.filter.streamMaterials'), 'MATERIAL_ORDER')
  );
  streamSel.value = state.stream;

  const segSel = $('filter-segment');
  segSel.replaceChildren(new Option(t('analytics.filter.allSegments'), 'ALL'));
  const allowedSegments = state.stream === 'ESCROW_CONTRACT'
    ? PROJECT_SEGMENTS
    : state.stream === 'MATERIAL_ORDER'
      ? MATERIAL_SEGMENTS
      : [...PROJECT_SEGMENTS, ...MATERIAL_SEGMENTS];
  for (const s of allowedSegments) {
    segSel.append(new Option(labelForSegment(s), s));
  }
  if (!allowedSegments.includes(state.segment)) state.segment = 'ALL';
  segSel.value = state.segment;

  const tierSel = $('filter-tier');
  tierSel.replaceChildren(new Option(t('analytics.filter.allTiers'), 'ALL'));
  for (const tr of CONTRACTOR_TIERS) tierSel.append(new Option(labelForTier(tr), tr));
  tierSel.value = state.contractorTier;

  const statusSel = $('table-status-filter');
  statusSel.replaceChildren(new Option(t('analytics.table.allStatuses'), 'ALL'));
  for (const st of LEDGER_STATUSES) statusSel.append(new Option(labelForStatus(st), st));
  statusSel.value = state.status;

  const verifySel = $('table-verify-filter');
  verifySel.replaceChildren(new Option(t('analytics.table.allVerify'), 'ALL'));
  for (const vt of VERIFICATION_TIERS) verifySel.append(new Option(labelForVerify(vt), vt));
  verifySel.value = state.verificationTier;

  $('filter-date-start').value = state.startDate;
  $('filter-date-end').value = state.endDate;
  $('table-search').value = state.search;
  $('table-page-size').value = String(state.pageSize);
}

function syncToolbarButtons() {
  for (const btn of document.querySelectorAll('#preset-range-group [data-preset]')) {
    btn.setAttribute('aria-pressed', btn.dataset.preset === state.preset ? 'true' : 'false');
  }
  for (const btn of document.querySelectorAll('#line-granularity-group [data-granularity]')) {
    btn.setAttribute('aria-pressed', btn.dataset.granularity === state.granularity ? 'true' : 'false');
  }
  for (const btn of document.querySelectorAll('#donut-mode-group [data-donut-mode]')) {
    btn.setAttribute('aria-pressed', btn.dataset.donutMode === state.donutMode ? 'true' : 'false');
  }
  for (const btn of document.querySelectorAll('#bar-dimension-group [data-bar-dim]')) {
    btn.setAttribute('aria-pressed', btn.dataset.barDim === state.barDimension ? 'true' : 'false');
  }
}

// ── Active Filter Chips & Summary ────────────────────────────────────────────
function renderActiveFilterChips(filteredCount) {
  const pill = $('telemetry-source-pill');
  const countFmt = formatNum(allRecords.length);
  pill.textContent = hasLiveDbRecords
    ? t('analytics.source.live', { count: countFmt })
    : t('analytics.source.sample', { count: countFmt });

  $('active-filter-summary').textContent = t('analytics.filter.activeSummary', {
    shown: formatNum(filteredCount),
    total: formatNum(allRecords.length),
    start: formatDate(state.startDate) || state.startDate,
    end: formatDate(state.endDate) || state.endDate
  });

  const chipWrap = $('active-filter-chips');
  chipWrap.replaceChildren();

  const activeFacets = [];
  if (state.division !== 'ALL') activeFacets.push({ label: labelForDivision(state.division), clear: () => { state.division = 'ALL'; } });
  if (state.stream !== 'ALL') {
    activeFacets.push({
      label: state.stream === 'ESCROW_CONTRACT' ? t('analytics.filter.streamEscrow') : t('analytics.filter.streamMaterials'),
      clear: () => { state.stream = 'ALL'; }
    });
  }
  if (state.segment !== 'ALL') activeFacets.push({ label: labelForSegment(state.segment), clear: () => { state.segment = 'ALL'; } });
  if (state.contractorTier !== 'ALL') activeFacets.push({ label: labelForTier(state.contractorTier), clear: () => { state.contractorTier = 'ALL'; } });
  if (state.status !== 'ALL') activeFacets.push({ label: labelForStatus(state.status), clear: () => { state.status = 'ALL'; } });
  if (state.verificationTier !== 'ALL') activeFacets.push({ label: labelForVerify(state.verificationTier), clear: () => { state.verificationTier = 'ALL'; } });
  if (state.search.trim()) activeFacets.push({ label: `"${state.search.trim()}"`, clear: () => { state.search = ''; } });

  for (const facet of activeFacets) {
    const chip = el('button', 'chip min-h-[44px] gap-xs text-xs font-semibold');
    chip.type = 'button';
    chip.append(el('span', '', facet.label), icon('close', 'text-[16px]'));
    chip.addEventListener('click', () => {
      facet.clear();
      state.page = 1;
      populateFilterSelects();
      renderAll();
    });
    chipWrap.append(chip);
  }
}

// ── KPI Sparkline & Cards ────────────────────────────────────────────────────
function buildSparklineSvg(values, strokeColor, fillId) {
  const w = 132;
  const h = 38;
  const pad = 3;
  const pts = Array.isArray(values) && values.length > 1 ? values : [0, 0];
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;

  const coords = pts.map((v, idx) => {
    const x = pad + (idx / (pts.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [Number(x.toFixed(1)), Number(y.toFixed(1))];
  });

  const lineD = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  const areaD = `${lineD} L${coords[coords.length - 1][0]},${h} L${coords[0][0]},${h} Z`;

  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, 'aria-hidden': 'true' });
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: fillId, x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(
    svgEl('stop', { offset: '0%', 'stop-color': strokeColor, 'stop-opacity': '0.30' }),
    svgEl('stop', { offset: '100%', 'stop-color': strokeColor, 'stop-opacity': '0.0' })
  );
  defs.append(grad);

  const area = svgEl('path', { d: areaD, fill: `url(#${fillId})` });
  const line = svgEl('path', {
    d: lineD,
    fill: 'none',
    stroke: strokeColor,
    'stroke-width': '2.2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round'
  });
  const last = coords[coords.length - 1];
  const endDot = svgEl('circle', { cx: last[0], cy: last[1], r: '3', fill: strokeColor });

  svg.append(defs, area, line, endDot);
  return svg;
}

function renderKpiCards(kpis) {
  const pal = getPalette();
  const grid = $('kpi-grid');
  grid.replaceChildren();

  const cards = [
    {
      id: 'gmv',
      iconName: 'account_balance_wallet',
      title: t('analytics.kpi.gmv.title'),
      headline: formatTaka(kpis.gmv.valueBDT),
      delta: kpis.gmv.deltaPct,
      invertGood: false,
      unit: '%',
      sub: t('analytics.kpi.gmv.sub', { prev: formatCompactTaka(kpis.gmv.prevBDT) }),
      spark: kpis.gmv.sparkline,
      color: pal.primary
    },
    {
      id: 'settled',
      iconName: 'local_atm',
      title: t('analytics.kpi.settled.title'),
      headline: formatTaka(kpis.settled.valueBDT),
      delta: kpis.settled.deltaPct,
      invertGood: false,
      unit: '%',
      sub: t('analytics.kpi.settled.sub', { count: formatNum(kpis.settled.settledCount) }),
      spark: kpis.settled.sparkline,
      color: pal.secondary
    },
    {
      id: 'revenue',
      iconName: 'layers',
      title: t('analytics.kpi.revenue.title'),
      headline: formatTaka(kpis.revenue.valueBDT),
      delta: kpis.revenue.deltaPct,
      invertGood: false,
      unit: '%',
      sub: t('analytics.kpi.revenue.sub'),
      spark: kpis.revenue.sparkline,
      color: pal.quaternary
    },
    {
      id: 'active',
      iconName: 'construction',
      title: t('analytics.kpi.active.title'),
      headline: formatNum(kpis.activeOps.value),
      delta: kpis.activeOps.deltaPct,
      invertGood: false,
      unit: '%',
      sub: t('analytics.kpi.active.sub', { total: formatNum(kpis.activeOps.totalInWindow) }),
      spark: kpis.activeOps.sparkline,
      color: pal.tertiary
    },
    {
      id: 'crypto',
      iconName: 'verified_user',
      title: t('analytics.kpi.crypto.title'),
      headline: `${formatNum(kpis.cryptoProof.valuePct, 1)}%`,
      delta: kpis.cryptoProof.deltaPp,
      invertGood: false,
      unit: 'pp',
      sub: t('analytics.kpi.crypto.sub'),
      spark: kpis.cryptoProof.sparkline,
      color: pal.teal
    },
    {
      id: 'speed',
      iconName: 'timer',
      title: t('analytics.kpi.speed.title'),
      headline: `${formatNum(kpis.settlementSpeed.hours, 1)}h`,
      delta: kpis.settlementSpeed.deltaPct,
      invertGood: true,
      unit: '%',
      sub: t('analytics.kpi.speed.sub', { dispute: formatNum(kpis.settlementSpeed.disputeRatePct, 1) }),
      spark: kpis.settlementSpeed.sparkline,
      color: pal.secondary
    }
  ];

  for (const c of cards) {
    const card = el('article', 'ana-surface ana-kpi-card p-md md:p-lg flex flex-col justify-between gap-sm');

    const top = el('div', 'flex items-center justify-between gap-sm');
    const titleWrap = el('div', 'flex items-center gap-xs');
    const iconBadge = el('span', 'ana-surface-subtle w-9 h-9 inline-flex items-center justify-center rounded-lg ana-ink');
    iconBadge.append(icon(c.iconName, 'text-[20px]'));
    titleWrap.append(iconBadge, el('h3', 'text-body-sm font-semibold ana-muted', c.title));

    const isPositiveMove = c.invertGood ? c.delta <= 0 : c.delta >= 0;
    const arrow = c.delta > 0 ? '▲ +' : c.delta < 0 ? '▼ ' : '• ';
    const formattedDelta = `${arrow}${formatNum(Math.abs(c.delta), 1)}${c.unit === 'pp' ? ' pp' : '%'}`;
    const trendBadge = el('span', isPositiveMove ? 'ana-badge ana-badge-positive' : 'ana-badge ana-badge-negative', formattedDelta);
    trendBadge.setAttribute('title', t('analytics.kpi.vsPrev'));

    top.append(titleWrap, trendBadge);

    const mid = el('div', 'flex items-end justify-between gap-sm pt-xs');
    const valBox = el('div', 'space-y-0.5 min-w-0');
    const headlineEl = el('p', 'text-h3 md:text-h2 font-extrabold tracking-tight ana-ink truncate', c.headline);
    const subEl = el('p', 'text-xs ana-muted truncate', c.sub);
    valBox.append(headlineEl, subEl);

    const sparkWrap = el('div', 'shrink-0');
    sparkWrap.append(buildSparklineSvg(c.spark, c.color, `spark-grad-${c.id}`));

    mid.append(valBox, sparkWrap);
    card.append(top, mid);
    grid.append(card);
  }
}

// ── Smooth Catmull-Rom / Monotone Bezier Path Helper ─────────────────────────
function buildSmoothPath(coords) {
  if (coords.length === 0) return '';
  if (coords.length === 1) return `M${coords[0][0]},${coords[0][1]}`;
  let d = `M${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)}`;
  for (let i = 0; i < coords.length - 1; i += 1) {
    const p0 = coords[i === 0 ? 0 : i - 1];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[i + 2 < coords.length ? i + 2 : i + 1];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

// ── SVG Tooltip Card Builder (Strict CSP Safe — Pure SVG Geometry) ───────────
function renderSvgTooltipBox(pal, x, y, viewW, lines) {
  const boxW = 228;
  const lineH = 18;
  const boxH = 16 + lines.length * lineH;
  const clampedX = Math.max(8, Math.min(viewW - boxW - 8, x - boxW / 2));
  const clampedY = Math.max(6, y - boxH - 14);

  const g = svgEl('g', {
    class: 'ana-svg-tooltip',
    transform: `translate(${clampedX.toFixed(1)}, ${clampedY.toFixed(1)})`
  });

  const rect = svgEl('rect', {
    x: 0,
    y: 0,
    width: boxW,
    height: boxH,
    rx: 8,
    ry: 8,
    fill: pal.tooltipBg,
    stroke: pal.tooltipBorder,
    'stroke-width': '1.2',
    opacity: '0.97'
  });
  g.append(rect);

  lines.forEach((ln, idx) => {
    const rowY = 20 + idx * lineH;
    if (ln.dotColor) {
      g.append(svgEl('circle', { cx: 14, cy: rowY - 4, r: 4, fill: ln.dotColor }));
    }
    const labelText = svgEl('text', {
      x: ln.dotColor ? 24 : 12,
      y: rowY,
      fill: idx === 0 ? pal.tooltipText : pal.tooltipMuted,
      'font-size': idx === 0 ? '12' : '11',
      'font-weight': idx === 0 ? '700' : '500'
    });
    labelText.textContent = ln.label;
    g.append(labelText);

    if (ln.value) {
      const valText = svgEl('text', {
        x: boxW - 12,
        y: rowY,
        fill: pal.tooltipText,
        'font-size': '11',
        'font-weight': '700',
        'text-anchor': 'end'
      });
      valText.textContent = ln.value;
      g.append(valText);
    }
  });

  return g;
}

// ── 1. Multi-Series Line / Area Chart ────────────────────────────────────────
function renderLineSeriesToggles(pal) {
  const wrap = $('line-series-toggles');
  wrap.replaceChildren();

  const defs = [
    { key: 'gmv', label: t('analytics.chart.series.gmv'), color: pal.primary },
    { key: 'settled', label: t('analytics.chart.series.settled'), color: pal.secondary },
    { key: 'fee', label: t('analytics.chart.series.fee'), color: pal.tertiary }
  ];

  for (const s of defs) {
    const active = Boolean(state.visibleSeries[s.key]);
    const btn = el('button', 'ana-seg-btn min-h-[44px] px-sm text-xs');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');

    const dotSvg = svgEl('svg', { viewBox: '0 0 12 12', width: 10, height: 10, 'aria-hidden': 'true' });
    dotSvg.append(svgEl('circle', { cx: 6, cy: 6, r: 5, fill: active ? s.color : pal.axis }));
    btn.append(dotSvg, el('span', '', s.label));

    btn.addEventListener('click', () => {
      const next = !state.visibleSeries[s.key];
      const activeCount = Object.values(state.visibleSeries).filter(Boolean).length;
      if (!next && activeCount <= 1) return; // keep at least one series visible
      state.visibleSeries[s.key] = next;
      renderLineChart(currentFilteredRecords);
    });
    wrap.append(btn);
  }
}

function renderLineChart(records) {
  const pal = getPalette();
  renderLineSeriesToggles(pal);

  const stage = $('line-chart-stage');
  stage.replaceChildren();
  const readout = $('line-hover-readout');
  readout.textContent = t('analytics.chart.hoverHint');

  const { points } = computeTimeSeries(records, state.startDate, state.endDate, state.granularity);
  const W = 760;
  const H = 295;
  const padL = 72;
  const padR = 20;
  const padT = 22;
  const padB = 42;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxVal = Math.max(
    10000,
    ...points.map((p) => Math.max(
      state.visibleSeries.gmv ? p.grossBDT : 0,
      state.visibleSeries.settled ? p.settledBDT : 0,
      state.visibleSeries.fee ? p.feeBDT : 0
    ))
  ) * 1.12;

  const svg = svgEl('svg', {
    class: 'ana-chart-svg',
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': t('analytics.chart.line.title')
  });

  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: 'line-gmv-area', x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(
    svgEl('stop', { offset: '0%', 'stop-color': pal.primary, 'stop-opacity': '0.28' }),
    svgEl('stop', { offset: '100%', 'stop-color': pal.primary, 'stop-opacity': '0.01' })
  );
  defs.append(grad);
  svg.append(defs);

  // Horizontal gridlines & Y-axis labels
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i += 1) {
    const ratio = i / yTicks;
    const y = padT + plotH - ratio * plotH;
    const val = maxVal * ratio;
    svg.append(svgEl('line', {
      x1: padL,
      y1: y.toFixed(1),
      x2: W - padR,
      y2: y.toFixed(1),
      stroke: pal.grid,
      'stroke-dasharray': i === 0 ? '0' : '4 4',
      'stroke-width': '1'
    }));
    const lbl = svgEl('text', {
      x: padL - 8,
      y: (y + 4).toFixed(1),
      fill: pal.axis,
      'font-size': '11',
      'text-anchor': 'end'
    });
    lbl.textContent = formatCompactTaka(val);
    svg.append(lbl);
  }

  const xForIdx = (idx) => (points.length <= 1 ? padL + plotW / 2 : padL + (idx / (points.length - 1)) * plotW);
  const yForVal = (v) => padT + plotH - (Math.max(0, v) / maxVal) * plotH;

  const gmvCoords = points.map((p, i) => [xForIdx(i), yForVal(p.grossBDT)]);
  const settledCoords = points.map((p, i) => [xForIdx(i), yForVal(p.settledBDT)]);
  const feeCoords = points.map((p, i) => [xForIdx(i), yForVal(p.feeBDT)]);

  if (state.visibleSeries.gmv && gmvCoords.length > 0) {
    const lineD = buildSmoothPath(gmvCoords);
    const baselineY = (padT + plotH).toFixed(1);
    const areaD = `${lineD} L${gmvCoords[gmvCoords.length - 1][0].toFixed(1)},${baselineY} L${gmvCoords[0][0].toFixed(1)},${baselineY} Z`;
    svg.append(svgEl('path', { d: areaD, fill: 'url(#line-gmv-area)' }));
    svg.append(svgEl('path', {
      d: lineD,
      fill: 'none',
      stroke: pal.primary,
      'stroke-width': '2.8',
      'stroke-linecap': 'round'
    }));
  }

  if (state.visibleSeries.settled && settledCoords.length > 0) {
    svg.append(svgEl('path', {
      d: buildSmoothPath(settledCoords),
      fill: 'none',
      stroke: pal.secondary,
      'stroke-width': '2.4',
      'stroke-dasharray': '6 4',
      'stroke-linecap': 'round'
    }));
  }

  if (state.visibleSeries.fee && feeCoords.length > 0) {
    svg.append(svgEl('path', {
      d: buildSmoothPath(feeCoords),
      fill: 'none',
      stroke: pal.tertiary,
      'stroke-width': '2',
      'stroke-linecap': 'round'
    }));
  }

  // X-axis date labels (up to 7 evenly spaced labels)
  const labelStep = Math.max(1, Math.ceil(points.length / 7));
  points.forEach((p, idx) => {
    if (idx % labelStep !== 0 && idx !== points.length - 1) return;
    const x = xForIdx(idx);
    const txt = svgEl('text', {
      x: x.toFixed(1),
      y: H - 12,
      fill: pal.axis,
      'font-size': '11',
      'text-anchor': idx === 0 ? 'start' : idx === points.length - 1 ? 'end' : 'middle'
    });
    txt.textContent = formatDate(p.date) || p.date.slice(5);
    svg.append(txt);
  });

  // Visible vertex dots (when point count is comfortable)
  if (points.length <= 40) {
    points.forEach((p, i) => {
      if (state.visibleSeries.gmv) {
        svg.append(svgEl('circle', {
          cx: gmvCoords[i][0].toFixed(1),
          cy: gmvCoords[i][1].toFixed(1),
          r: '3.2',
          fill: pal.cardBg,
          stroke: pal.primary,
          'stroke-width': '2'
        }));
      }
    });
  }

  // Interactive Hover Overlay Layer
  const overlay = svgEl('g', { 'data-role': 'line-overlay' });
  const hitGroup = svgEl('g', { 'data-role': 'line-hitboxes' });

  const showPointTooltip = (idx) => {
    overlay.replaceChildren();
    const pt = points[idx];
    if (!pt) return;
    const cx = xForIdx(idx);

    overlay.append(svgEl('line', {
      x1: cx.toFixed(1),
      y1: padT,
      x2: cx.toFixed(1),
      y2: padT + plotH,
      stroke: pal.axis,
      'stroke-width': '1.2',
      'stroke-dasharray': '3 3'
    }));

    const activeDots = [];
    if (state.visibleSeries.gmv) activeDots.push([gmvCoords[idx][1], pal.primary]);
    if (state.visibleSeries.settled) activeDots.push([settledCoords[idx][1], pal.secondary]);
    if (state.visibleSeries.fee) activeDots.push([feeCoords[idx][1], pal.tertiary]);

    for (const [cy, col] of activeDots) {
      overlay.append(svgEl('circle', {
        cx: cx.toFixed(1),
        cy: cy.toFixed(1),
        r: '5.5',
        fill: col,
        stroke: pal.cardBg,
        'stroke-width': '2'
      }));
    }

    const topY = activeDots.length > 0 ? Math.min(...activeDots.map((d) => d[0])) : padT + 40;
    const tooltipLines = [
      { label: formatDate(pt.date) || pt.date, value: `${formatNum(pt.count)} ops` }
    ];
    if (state.visibleSeries.gmv) tooltipLines.push({ dotColor: pal.primary, label: t('analytics.chart.series.gmv'), value: formatTaka(pt.grossBDT) });
    if (state.visibleSeries.settled) tooltipLines.push({ dotColor: pal.secondary, label: t('analytics.chart.series.settled'), value: formatTaka(pt.settledBDT) });
    if (state.visibleSeries.fee) tooltipLines.push({ dotColor: pal.tertiary, label: t('analytics.chart.series.fee'), value: formatTaka(pt.feeBDT) });

    overlay.append(renderSvgTooltipBox(pal, cx, topY, W, tooltipLines));
    readout.textContent = `${formatDate(pt.date) || pt.date} · ${t('analytics.chart.series.gmv')}: ${formatTaka(pt.grossBDT)} · ${t('analytics.chart.series.settled')}: ${formatTaka(pt.settledBDT)}`;
  };

  const clearPointTooltip = () => {
    overlay.replaceChildren();
    readout.textContent = t('analytics.chart.hoverHint');
  };

  const colW = points.length > 1 ? plotW / (points.length - 1) : plotW;
  points.forEach((pt, idx) => {
    const cx = xForIdx(idx);
    const rectX = Math.max(padL, cx - colW / 2);
    const rectW = Math.min(W - padR - rectX, colW);
    const hit = svgEl('rect', {
      x: rectX.toFixed(1),
      y: padT,
      width: Math.max(8, rectW).toFixed(1),
      height: plotH,
      fill: 'transparent',
      tabindex: '0',
      role: 'button',
      'aria-label': `${pt.date}: ${formatTaka(pt.grossBDT)}`
    });
    hit.addEventListener('mouseenter', () => showPointTooltip(idx));
    hit.addEventListener('focus', () => showPointTooltip(idx));
    hit.addEventListener('mouseleave', clearPointTooltip);
    hit.addEventListener('blur', clearPointTooltip);
    hitGroup.append(hit);
  });

  svg.append(overlay, hitGroup);
  stage.append(svg);
}

// ── 2. Interactive Donut Chart ───────────────────────────────────────────────
function renderDonutChart(records) {
  const pal = getPalette();
  const stage = $('donut-chart-stage');
  const legend = $('donut-legend');
  stage.replaceChildren();
  legend.replaceChildren();

  const data = computeDonutBreakdown(records, state.donutMode);
  const size = 236;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 82;
  const circumference = 2 * Math.PI * radius;

  const svg = svgEl('svg', {
    class: 'ana-chart-svg',
    viewBox: `0 0 ${size} ${size}`,
    width: size,
    height: size,
    role: 'img',
    'aria-label': t('analytics.chart.donut.title')
  });

  // Base track ring
  svg.append(svgEl('circle', {
    cx,
    cy,
    r: radius,
    fill: 'none',
    stroke: pal.grid,
    'stroke-width': '24'
  }));

  // Center Dynamic Label Group
  const centerTop = svgEl('text', {
    x: cx,
    y: cy - 12,
    fill: pal.axis,
    'font-size': '11',
    'font-weight': '600',
    'text-anchor': 'middle'
  });
  centerTop.textContent = t('analytics.chart.donut.totalLabel');

  const centerVal = svgEl('text', {
    x: cx,
    y: cy + 10,
    fill: pal.tooltipText === '#f8fafc' && getTheme() !== 'dark' ? '#0f172a' : '#f8fafc',
    'font-size': '16',
    'font-weight': '800',
    'text-anchor': 'middle'
  });
  centerVal.textContent = formatCompactTaka(data.totalBDT);

  const centerSub = svgEl('text', {
    x: cx,
    y: cy + 28,
    fill: pal.axis,
    'font-size': '11',
    'font-weight': '500',
    'text-anchor': 'middle'
  });
  centerSub.textContent = `${formatNum(data.totalCount)} ops`;

  const resetCenter = () => {
    centerTop.textContent = t('analytics.chart.donut.totalLabel');
    centerVal.textContent = formatCompactTaka(data.totalBDT);
    centerSub.textContent = `${formatNum(data.totalCount)} ops`;
  };

  const labelForSlice = (key) => (state.donutMode === 'materials' ? labelForSegment(key) : labelForStatus(key));

  const toggleSliceFilter = (sliceKey) => {
    if (state.donutMode === 'materials') {
      if (state.segment === sliceKey) {
        state.segment = 'ALL';
      } else {
        state.stream = 'MATERIAL_ORDER';
        state.segment = sliceKey;
      }
    } else {
      state.status = state.status === sliceKey ? 'ALL' : sliceKey;
    }
    state.page = 1;
    populateFilterSelects();
    renderAll();
  };

  let cumulativeFraction = 0;
  data.slices.forEach((slice, idx) => {
    const frac = data.totalBDT > 0 ? slice.grossBDT / data.totalBDT : 0;
    const dashLen = Math.max(0, frac * circumference - (data.slices.length > 1 ? 2 : 0));
    const dashOffset = -cumulativeFraction * circumference;
    cumulativeFraction += frac;
    const color = pal.slices[idx % pal.slices.length];

    const arc = svgEl('circle', {
      class: 'ana-donut-arc',
      cx,
      cy,
      r: radius,
      fill: 'none',
      stroke: color,
      'stroke-width': '24',
      'stroke-dasharray': `${dashLen.toFixed(2)} ${circumference.toFixed(2)}`,
      'stroke-dashoffset': dashOffset.toFixed(2),
      transform: `rotate(-90 ${cx} ${cy})`,
      tabindex: '0',
      role: 'button',
      'aria-label': `${labelForSlice(slice.key)}: ${formatTaka(slice.grossBDT)} (${formatNum(slice.sharePct, 1)}%)`
    });

    const highlightSlice = () => {
      centerTop.textContent = labelForSlice(slice.key).slice(0, 22);
      centerVal.textContent = formatCompactTaka(slice.grossBDT);
      centerSub.textContent = `${formatNum(slice.sharePct, 1)}% · ${formatNum(slice.count)} ops`;
    };

    arc.addEventListener('mouseenter', highlightSlice);
    arc.addEventListener('focus', highlightSlice);
    arc.addEventListener('mouseleave', resetCenter);
    arc.addEventListener('blur', resetCenter);
    arc.addEventListener('click', () => toggleSliceFilter(slice.key));
    arc.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSliceFilter(slice.key);
      }
    });
    svg.append(arc);

    // Interactive Legend Button Row (>= 44px touch target)
    const isSelected = (state.donutMode === 'materials' && state.segment === slice.key) ||
      (state.donutMode === 'status' && state.status === slice.key);

    const rowBtn = el(
      'button',
      `w-full min-h-[44px] px-sm py-xs rounded-lg flex items-center justify-between gap-sm text-left transition-colors ${isSelected ? 'ana-seg-btn-active' : 'ana-surface-subtle hover:opacity-90'}`
    );
    rowBtn.type = 'button';

    const left = el('span', 'flex items-center gap-xs min-w-0');
    const swatch = svgEl('svg', { viewBox: '0 0 12 12', width: 12, height: 12, 'aria-hidden': 'true' });
    swatch.append(svgEl('rect', { x: 1, y: 1, width: 10, height: 10, rx: 3, fill: color }));
    left.append(swatch, el('span', 'text-xs font-semibold truncate', labelForSlice(slice.key)));

    const right = el('span', 'text-xs font-bold shrink-0', `${formatCompactTaka(slice.grossBDT)} (${formatNum(slice.sharePct, 1)}%)`);
    rowBtn.append(left, right);

    rowBtn.addEventListener('mouseenter', highlightSlice);
    rowBtn.addEventListener('mouseleave', resetCenter);
    rowBtn.addEventListener('click', () => toggleSliceFilter(slice.key));
    legend.append(rowBtn);
  });

  svg.append(centerTop, centerVal, centerSub);
  stage.append(svg);
}

// ── 3. Stacked & Grouped Bar Chart ───────────────────────────────────────────
function renderBarChart(records) {
  const pal = getPalette();
  const stage = $('bar-chart-stage');
  const barLegend = $('bar-legend');
  const readout = $('bar-hover-readout');
  stage.replaceChildren();
  barLegend.replaceChildren();
  readout.textContent = t('analytics.chart.bar.clickHint');

  const legendItems = [
    { color: pal.primary, label: t('analytics.filter.streamEscrow') },
    { color: pal.secondary, label: t('analytics.filter.streamMaterials') }
  ];
  for (const li of legendItems) {
    const item = el('span', 'inline-flex items-center gap-xs');
    const sw = svgEl('svg', { viewBox: '0 0 12 12', width: 12, height: 12, 'aria-hidden': 'true' });
    sw.append(svgEl('rect', { x: 1, y: 1, width: 10, height: 10, rx: 3, fill: li.color }));
    item.append(sw, el('span', '', li.label));
    barLegend.append(item);
  }

  const bars = computeBarBreakdown(records, state.barDimension);
  const W = 920;
  const H = 280;
  const padL = 74;
  const padR = 24;
  const padT = 26;
  const padB = 48;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxTotal = Math.max(10000, ...bars.map((b) => b.totalBDT)) * 1.15;

  const svg = svgEl('svg', {
    class: 'ana-chart-svg',
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': t('analytics.chart.bar.title')
  });

  // Gridlines
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i += 1) {
    const ratio = i / yTicks;
    const y = padT + plotH - ratio * plotH;
    svg.append(svgEl('line', {
      x1: padL,
      y1: y.toFixed(1),
      x2: W - padR,
      y2: y.toFixed(1),
      stroke: pal.grid,
      'stroke-dasharray': i === 0 ? '0' : '4 4'
    }));
    const lbl = svgEl('text', {
      x: padL - 8,
      y: (y + 4).toFixed(1),
      fill: pal.axis,
      'font-size': '11',
      'text-anchor': 'end'
    });
    lbl.textContent = formatCompactTaka(maxTotal * ratio);
    svg.append(lbl);
  }

  const overlay = svgEl('g', { 'data-role': 'bar-overlay' });
  const slotW = bars.length > 0 ? plotW / bars.length : plotW;
  const barW = Math.min(58, Math.max(22, slotW * 0.48));

  const formatBarKey = (key) => (state.barDimension === 'division' ? labelForDivision(key) : labelForSegment(key));

  bars.forEach((b, idx) => {
    const centerX = padL + idx * slotW + slotW / 2;
    const barX = centerX - barW / 2;
    const escrowH = (b.escrowBDT / maxTotal) * plotH;
    const matH = (b.materialsBDT / maxTotal) * plotH;
    const totalH = escrowH + matH;

    const escrowY = padT + plotH - escrowH;
    const matY = escrowY - matH;

    const isSelected = (state.barDimension === 'division' && state.division === b.key) ||
      (state.barDimension === 'segment' && state.segment === b.key);

    const g = svgEl('g', {
      class: 'ana-bar-group',
      tabindex: '0',
      role: 'button',
      'aria-label': `${formatBarKey(b.key)}: ${formatTaka(b.totalBDT)}`
    });

    const hoverBg = svgEl('rect', {
      x: (padL + idx * slotW + 4).toFixed(1),
      y: padT,
      width: Math.max(12, slotW - 8).toFixed(1),
      height: plotH,
      rx: 6,
      fill: isSelected ? pal.hoverBand : 'transparent'
    });
    g.append(hoverBg);

    if (escrowH > 0) {
      g.append(svgEl('rect', {
        class: 'ana-bar-rect',
        x: barX.toFixed(1),
        y: escrowY.toFixed(1),
        width: barW.toFixed(1),
        height: Math.max(2, escrowH).toFixed(1),
        rx: matH > 0 ? 0 : 5,
        fill: pal.primary
      }));
    }

    if (matH > 0) {
      g.append(svgEl('rect', {
        class: 'ana-bar-rect',
        x: barX.toFixed(1),
        y: matY.toFixed(1),
        width: barW.toFixed(1),
        height: Math.max(2, matH).toFixed(1),
        rx: 5,
        fill: pal.secondary
      }));
    }

    // Value caption above stacked bar
    const topLabel = svgEl('text', {
      x: centerX.toFixed(1),
      y: Math.max(padT + 10, padT + plotH - totalH - 6).toFixed(1),
      fill: pal.axis,
      'font-size': '10.5',
      'font-weight': '600',
      'text-anchor': 'middle'
    });
    topLabel.textContent = formatCompactTaka(b.totalBDT);
    g.append(topLabel);

    // X-axis category label
    const xLabel = svgEl('text', {
      x: centerX.toFixed(1),
      y: H - 18,
      fill: pal.axis,
      'font-size': '11',
      'font-weight': isSelected ? '700' : '500',
      'text-anchor': 'middle'
    });
    const textStr = formatBarKey(b.key);
    xLabel.textContent = textStr.length > 15 ? `${textStr.slice(0, 14)}…` : textStr;
    g.append(xLabel);

    const onEnter = () => {
      hoverBg.setAttribute('fill', pal.hoverBand);
      overlay.replaceChildren(
        renderSvgTooltipBox(pal, centerX, padT + plotH - totalH, W, [
          { label: formatBarKey(b.key), value: `${formatNum(b.sharePct, 1)}%` },
          { dotColor: pal.primary, label: t('analytics.filter.streamEscrow'), value: formatTaka(b.escrowBDT) },
          { dotColor: pal.secondary, label: t('analytics.filter.streamMaterials'), value: formatTaka(b.materialsBDT) },
          { label: t('analytics.chart.donut.totalLabel'), value: `${formatTaka(b.totalBDT)} (${formatNum(b.count)})` }
        ])
      );
      readout.textContent = `${formatBarKey(b.key)} · ${formatTaka(b.totalBDT)} (${formatNum(b.sharePct, 1)}% · ${formatNum(b.count)} ops)`;
    };

    const onLeave = () => {
      hoverBg.setAttribute('fill', isSelected ? pal.hoverBand : 'transparent');
      overlay.replaceChildren();
      readout.textContent = t('analytics.chart.bar.clickHint');
    };

    const onActivate = () => {
      if (state.barDimension === 'division') {
        state.division = state.division === b.key ? 'ALL' : b.key;
      } else {
        state.segment = state.segment === b.key ? 'ALL' : b.key;
      }
      state.page = 1;
      populateFilterSelects();
      renderAll();
    };

    g.addEventListener('mouseenter', onEnter);
    g.addEventListener('focus', onEnter);
    g.addEventListener('mouseleave', onLeave);
    g.addEventListener('blur', onLeave);
    g.addEventListener('click', onActivate);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    });

    svg.append(g);
  });

  svg.append(overlay);
  stage.append(svg);
}

// ── 4. Sortable & Filterable Data Table + Audit Dialog ───────────────────────
const TABLE_COLUMNS = [
  { key: 'id', labelKey: 'analytics.table.col.id', sortable: true },
  { key: 'date', labelKey: 'analytics.table.col.date', sortable: true },
  { key: 'title', labelKey: 'analytics.table.col.project', sortable: true },
  { key: 'division', labelKey: 'analytics.table.col.division', sortable: true },
  { key: 'segment', labelKey: 'analytics.table.col.segment', sortable: true },
  { key: 'grossAmountBDT', labelKey: 'analytics.table.col.gross', sortable: true },
  { key: 'platformFeeBDT', labelKey: 'analytics.table.col.fee', sortable: true },
  { key: 'trustScore', labelKey: 'analytics.table.col.trust', sortable: true },
  { key: 'status', labelKey: 'analytics.table.col.status', sortable: true },
  { key: 'action', labelKey: 'analytics.table.col.action', sortable: false }
];

function openAuditModal(record) {
  const dialog = $('ledger-audit-dialog');
  const body = $('ledger-audit-body');
  if (!dialog || !body) return;
  body.replaceChildren();

  const pal = getPalette();

  // Header
  const header = el('div', 'flex items-start justify-between gap-md pb-md border-b border-border-subtle');
  const titleWrap = el('div', 'space-y-xs');
  const refBadge = el('span', 'ana-badge ana-badge-info', `${record.id} · ${formatDate(record.date) || record.date}`);
  const h3 = el('h3', 'text-title-md font-bold ana-ink', record.title);
  h3.id = 'audit-modal-title';
  const metaP = el('p', 'text-body-sm ana-muted', `${record.counterparty} · ${record.district} · ${labelForTier(record.contractorTier)}`);
  titleWrap.append(refBadge, h3, metaP);

  const closeBtn = el('button', 'btn-outline min-h-[44px] min-w-[44px] px-sm');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', t('analytics.modal.close'));
  closeBtn.append(icon('close', 'text-[20px]'));
  closeBtn.addEventListener('click', () => {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  });
  header.append(titleWrap, closeBtn);

  // Conservation Split Section
  const splitSec = el('section', 'ana-surface-subtle p-md space-y-sm');
  const splitHead = el('div', 'flex flex-wrap items-center justify-between gap-xs');
  splitHead.append(
    el('h4', 'text-xs font-bold uppercase tracking-wider ana-ink', t('analytics.modal.financialSplit')),
    el('span', statusBadgeClass(record.status), labelForStatus(record.status))
  );

  // Proportional SVG conservation bar (zero inline styles!)
  const barW = 560;
  const netW = Math.round((record.netDisbursedBDT / record.grossAmountBDT) * barW);
  const feeW = Math.round((record.platformFeeBDT / record.grossAmountBDT) * barW);
  const holdW = Math.max(0, barW - netW - feeW);

  const splitSvg = svgEl('svg', { class: 'ana-chart-svg', viewBox: `0 0 ${barW} 14`, height: 14, 'aria-hidden': 'true' });
  splitSvg.append(
    svgEl('rect', { x: 0, y: 0, width: netW, height: 14, rx: 4, fill: pal.secondary }),
    svgEl('rect', { x: netW, y: 0, width: feeW, height: 14, fill: pal.primary }),
    svgEl('rect', { x: netW + feeW, y: 0, width: holdW, height: 14, rx: 4, fill: pal.tertiary })
  );

  const splitGrid = el('div', 'grid grid-cols-2 sm:grid-cols-4 gap-sm pt-xs');
  const splitItems = [
    { label: t('analytics.modal.gross'), val: formatTaka(record.grossAmountBDT) },
    { label: t('analytics.modal.netContractor'), val: formatTaka(record.netDisbursedBDT) },
    { label: t('analytics.modal.platformFee'), val: formatTaka(record.platformFeeBDT) },
    { label: t('analytics.modal.retainage'), val: formatTaka(record.retainageHoldBDT) }
  ];
  for (const si of splitItems) {
    const box = el('div', 'ana-surface p-sm');
    box.append(
      el('p', 'text-xs ana-muted', si.label),
      el('p', 'text-body-sm font-bold ana-ink mt-0.5', si.val)
    );
    splitGrid.append(box);
  }
  splitSec.append(splitHead, splitSvg, splitGrid);

  // Milestone Schedule List
  const msSec = el('section', 'space-y-xs');
  msSec.append(el('h4', 'text-xs font-bold uppercase tracking-wider ana-muted', t('analytics.modal.milestones')));
  const msList = el('div', 'space-y-xs');
  const milestones = Array.isArray(record.milestones) ? record.milestones : [];
  for (const m of milestones) {
    const row = el('div', 'ana-surface-subtle px-md py-sm flex flex-wrap items-center justify-between gap-sm');
    row.append(
      el('span', 'text-body-sm font-medium ana-ink', `${formatNum(m.index)}. ${m.title} (${formatNum(m.releasePercentage)}%)`),
      el('span', 'text-body-sm font-bold ana-ink', `${formatTaka(m.amountBDT)} · ${m.status}`)
    );
    msList.append(row);
  }
  msSec.append(msList);

  const footer = el('div', 'pt-sm border-t border-border-subtle flex items-center justify-between gap-sm');
  const verifyInfo = el(
    'span',
    'text-xs ana-muted',
    `${labelForVerify(record.verificationTier)}${record.gpsDistanceMeters ? ` · GPS Δ ${formatNum(record.gpsDistanceMeters)}m` : ''} · Trust ${formatNum(record.trustScore)}/100`
  );
  const doneBtn = el('button', 'btn-primary min-h-[44px] px-lg text-body-sm', t('analytics.modal.close'));
  doneBtn.type = 'button';
  doneBtn.addEventListener('click', () => {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  });
  footer.append(verifyInfo, doneBtn);

  body.append(header, splitSec, msSec, footer);
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute('open', 'open');
  }
}

function renderDataTable(records) {
  const headRow = $('table-head-row');
  const tbody = $('table-body');
  const emptyBox = $('table-empty');
  const paginationNav = $('table-pagination');

  headRow.replaceChildren();
  tbody.replaceChildren();

  for (const col of TABLE_COLUMNS) {
    const th = el('th');
    if (col.sortable) {
      const isCurrent = state.sortKey === col.key;
      const arrow = isCurrent ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : ' ⇅';
      const btn = el('button', `ana-th-btn min-h-[44px] ${isCurrent ? 'ana-th-btn-active' : ''}`);
      btn.type = 'button';
      btn.textContent = `${t(col.labelKey)}${arrow}`;
      th.setAttribute('aria-sort', isCurrent ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
      btn.addEventListener('click', () => {
        if (state.sortKey === col.key) {
          state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortKey = col.key;
          state.sortDir = col.key === 'grossAmountBDT' || col.key === 'platformFeeBDT' || col.key === 'trustScore' || col.key === 'date' ? 'desc' : 'asc';
        }
        state.page = 1;
        renderDataTable(currentFilteredRecords);
      });
      th.append(btn);
    } else {
      const span = el('span', 'inline-flex items-center min-h-[44px] px-md text-xs font-bold uppercase tracking-wider ana-muted', t(col.labelKey));
      th.append(span);
    }
    headRow.append(th);
  }

  const sorted = sortRecords(records, state.sortKey, state.sortDir);
  const pageData = paginateRecords(sorted, state.page, state.pageSize);
  state.page = pageData.page;

  if (pageData.total === 0) {
    emptyBox.hidden = false;
    paginationNav.hidden = true;
    return;
  }

  emptyBox.hidden = true;
  paginationNav.hidden = false;

  for (const rec of pageData.rows) {
    const tr = el('tr', 'cursor-pointer');
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openAuditModal(rec);
    });

    // 1. Reference ID
    const tdId = el('td', 'font-mono text-xs font-bold whitespace-nowrap ana-ink', rec.id);

    // 2. Date
    const tdDate = el('td', 'text-xs whitespace-nowrap ana-muted', formatDate(rec.date) || rec.date);

    // 3. Project / Consignment + Counterparty
    const tdProj = el('td', 'min-w-[220px] max-w-[300px]');
    tdProj.append(
      el('p', 'text-body-sm font-semibold ana-ink truncate', rec.title),
      el('p', 'text-xs ana-muted truncate', `${rec.counterparty} · ${rec.district}`)
    );

    // 4. Division
    const tdDiv = el('td', 'text-body-sm font-medium whitespace-nowrap ana-ink', labelForDivision(rec.division));

    // 5. Segment
    const tdSeg = el('td', 'whitespace-nowrap');
    tdSeg.append(el('span', 'ana-badge ana-badge-neutral', labelForSegment(rec.segment)));

    // 6. Gross Escrow BDT
    const tdGross = el('td', 'text-body-sm font-extrabold whitespace-nowrap ana-ink', formatTaka(rec.grossAmountBDT));

    // 7. Fee (5%)
    const tdFee = el('td', 'text-xs font-semibold whitespace-nowrap text-money-fill', formatTaka(rec.platformFeeBDT));

    // 8. Proof & Trust Score (with pure SVG progress bar)
    const tdTrust = el('td', 'whitespace-nowrap min-w-[140px]');
    const trustTop = el('div', 'flex items-center justify-between text-xs mb-1');
    trustTop.append(
      el('span', 'ana-muted truncate max-w-[100px]', labelForVerify(rec.verificationTier).split(' ')[0]),
      el('span', 'font-bold ana-ink', `${formatNum(rec.trustScore)}%`)
    );
    const barSvg = svgEl('svg', { viewBox: '0 0 100 6', width: 112, height: 6, 'aria-hidden': 'true' });
    const pal = getPalette();
    barSvg.append(
      svgEl('rect', { x: 0, y: 0, width: 100, height: 6, rx: 3, fill: pal.grid }),
      svgEl('rect', { x: 0, y: 0, width: Math.max(8, rec.trustScore), height: 6, rx: 3, fill: rec.trustScore >= 88 ? pal.secondary : pal.primary })
    );
    tdTrust.append(trustTop, barSvg);

    // 9. Status Badge
    const tdStatus = el('td', 'whitespace-nowrap');
    tdStatus.append(el('span', statusBadgeClass(rec.status), labelForStatus(rec.status)));

    // 10. Audit Button (>= 44px touch target)
    const tdAction = el('td', 'whitespace-nowrap');
    const inspectBtn = el('button', 'btn-outline min-h-[44px] px-sm text-xs font-semibold');
    inspectBtn.type = 'button';
    inspectBtn.append(icon('visibility', 'text-[18px]'), el('span', '', t('analytics.table.inspect')));
    inspectBtn.addEventListener('click', () => openAuditModal(rec));
    tdAction.append(inspectBtn);

    tr.append(tdId, tdDate, tdProj, tdDiv, tdSeg, tdGross, tdFee, tdTrust, tdStatus, tdAction);
    tbody.append(tr);
  }

  $('table-showing-summary').textContent = t('analytics.table.showing', {
    start: formatNum(pageData.startIndex),
    end: formatNum(pageData.endIndex),
    total: formatNum(pageData.total)
  });
  $('table-page-pill').textContent = `${formatNum(pageData.page)} / ${formatNum(pageData.totalPages)}`;
  $('table-prev-btn').disabled = pageData.page <= 1;
  $('table-next-btn').disabled = pageData.page >= pageData.totalPages;
}

// ── Master Live Render Pipeline ──────────────────────────────────────────────
function renderAll() {
  syncToolbarButtons();

  currentFilteredRecords = filterRecords(allRecords, {
    startDate: state.startDate,
    endDate: state.endDate,
    division: state.division,
    stream: state.stream,
    segment: state.segment,
    contractorTier: state.contractorTier,
    status: state.status,
    verificationTier: state.verificationTier,
    search: state.search
  });

  const previousPeriodRecords = filterRecords(allRecords, {
    startDate: state.prevStartDate,
    endDate: state.prevEndDate,
    division: state.division,
    stream: state.stream,
    segment: state.segment,
    contractorTier: state.contractorTier,
    status: state.status,
    verificationTier: state.verificationTier,
    search: state.search
  });

  renderActiveFilterChips(currentFilteredRecords.length);

  const kpis = computeExecutiveKpis(currentFilteredRecords, previousPeriodRecords, {
    startDate: state.startDate,
    endDate: state.endDate
  });
  renderKpiCards(kpis);
  renderLineChart(currentFilteredRecords);
  renderDonutChart(currentFilteredRecords);
  renderBarChart(currentFilteredRecords);
  renderDataTable(currentFilteredRecords);
}

// ── Event Wiring ─────────────────────────────────────────────────────────────
function applyPresetWindow(preset) {
  state.preset = preset;
  const win = resolveDateWindow(preset, $('filter-date-start').value, $('filter-date-end').value, ANCHOR_DATE);
  state.startDate = win.startDate;
  state.endDate = win.endDate;
  state.prevStartDate = win.prevStartDate;
  state.prevEndDate = win.prevEndDate;
  $('filter-date-start').value = state.startDate;
  $('filter-date-end').value = state.endDate;
  state.page = 1;
  renderAll();
}

function wireControls() {
  for (const btn of document.querySelectorAll('#preset-range-group [data-preset]')) {
    btn.addEventListener('click', () => applyPresetWindow(btn.dataset.preset));
  }

  const onCustomDateChange = () => {
    const cs = $('filter-date-start').value;
    const ce = $('filter-date-end').value;
    if (!cs || !ce) return;
    state.preset = 'CUSTOM';
    const win = resolveDateWindow('CUSTOM', cs, ce, ANCHOR_DATE);
    state.startDate = win.startDate;
    state.endDate = win.endDate;
    state.prevStartDate = win.prevStartDate;
    state.prevEndDate = win.prevEndDate;
    state.page = 1;
    renderAll();
  };
  $('filter-date-start').addEventListener('change', onCustomDateChange);
  $('filter-date-end').addEventListener('change', onCustomDateChange);

  $('filter-division').addEventListener('change', (e) => {
    state.division = e.target.value;
    state.page = 1;
    renderAll();
  });

  $('filter-stream').addEventListener('change', (e) => {
    state.stream = e.target.value;
    state.page = 1;
    populateFilterSelects();
    renderAll();
  });

  $('filter-segment').addEventListener('change', (e) => {
    state.segment = e.target.value;
    state.page = 1;
    renderAll();
  });

  $('filter-tier').addEventListener('change', (e) => {
    state.contractorTier = e.target.value;
    state.page = 1;
    renderAll();
  });

  for (const btn of document.querySelectorAll('#line-granularity-group [data-granularity]')) {
    btn.addEventListener('click', () => {
      state.granularity = btn.dataset.granularity;
      syncToolbarButtons();
      renderLineChart(currentFilteredRecords);
    });
  }

  for (const btn of document.querySelectorAll('#donut-mode-group [data-donut-mode]')) {
    btn.addEventListener('click', () => {
      state.donutMode = btn.dataset.donutMode;
      syncToolbarButtons();
      renderDonutChart(currentFilteredRecords);
    });
  }

  for (const btn of document.querySelectorAll('#bar-dimension-group [data-bar-dim]')) {
    btn.addEventListener('click', () => {
      state.barDimension = btn.dataset.barDim;
      syncToolbarButtons();
      renderBarChart(currentFilteredRecords);
    });
  }

  $('table-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    state.page = 1;
    renderAll();
  });

  $('table-status-filter').addEventListener('change', (e) => {
    state.status = e.target.value;
    state.page = 1;
    renderAll();
  });

  $('table-verify-filter').addEventListener('change', (e) => {
    state.verificationTier = e.target.value;
    state.page = 1;
    renderAll();
  });

  $('table-page-size').addEventListener('change', (e) => {
    state.pageSize = Number(e.target.value) || 10;
    state.page = 1;
    renderDataTable(currentFilteredRecords);
  });

  $('table-prev-btn').addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      renderDataTable(currentFilteredRecords);
    }
  });

  $('table-next-btn').addEventListener('click', () => {
    state.page += 1;
    renderDataTable(currentFilteredRecords);
  });

  $('btn-reset-filters').addEventListener('click', () => {
    const win = resolveDateWindow('30D', '', '', ANCHOR_DATE);
    state.preset = '30D';
    state.startDate = win.startDate;
    state.endDate = win.endDate;
    state.prevStartDate = win.prevStartDate;
    state.prevEndDate = win.prevEndDate;
    state.division = 'ALL';
    state.stream = 'ALL';
    state.segment = 'ALL';
    state.contractorTier = 'ALL';
    state.status = 'ALL';
    state.verificationTier = 'ALL';
    state.search = '';
    state.page = 1;
    populateFilterSelects();
    renderAll();
  });

  $('btn-export-csv').addEventListener('click', () => {
    const csv = '\uFEFF' + recordsToCsv(currentFilteredRecords);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = `build-bd-analytics-${state.startDate}-to-${state.endDate}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // Close dialog when clicking backdrop
  const dialog = $('ledger-audit-dialog');
  if (dialog) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog && typeof dialog.close === 'function') {
        dialog.close();
      }
    });
  }
}

document.addEventListener('langchange', () => {
  applyLang();
  applyTheme();
  populateFilterSelects();
  renderAll();
});

document.addEventListener('themechange', () => {
  renderAll();
});

// ── Boot Sequence ────────────────────────────────────────────────────────────
(async () => {
  try {
    const me = await initShell();

    // If signed in as ADMIN or MODERATOR, pull live MongoDB records and merge seamlessly
    if (me && (me.role === 'ADMIN' || me.role === 'MODERATOR')) {
      try {
        const res = await get('/admin/analytics');
        const liveList = res?.data?.records;
        if (Array.isArray(liveList) && liveList.length > 0) {
          hasLiveDbRecords = true;
          allRecords = [...liveList, ...sampleRecords];
        }
      } catch (_) {
        // Gracefully retain deterministic executive dataset if offline
      }
    }

    populateFilterSelects();
    wireControls();
    renderAll();

    $('loading').hidden = true;
    $('content').hidden = false;
  } catch (err) {
    console.error('Analytics boot failed:', err);
    $('loading').hidden = true;
    const bootError = $('boot-error');
    bootError.textContent = t('err.generic');
    bootError.hidden = false;
  }
})();
