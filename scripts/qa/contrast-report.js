// scripts/qa/contrast-report.js — WCAG AA color contrast verification.
// Computes WCAG contrast ratio for every text/background pair used in
// frontend/pages/*.html and frontend/js/pages/*.js against Tailwind tokens.
// Exits with 1 if any pair used for normal text falls below 4.5:1.
'use strict';

const fs = require('fs');
const path = require('path');
const { createReport, runCli } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');

const tailwindConfig = require(path.join(ROOT, 'frontend', 'tailwind.config.js'));
const colors = {
  ...tailwindConfig.theme.extend.colors,
  white: '#ffffff',
  black: '#000000',
  'amber-500': '#f59e0b',
  'slate-950': '#020617'
};

function parseHex(hex) {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16)
    };
  }
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  };
}

function sRGBtoLin(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relLuminance(hex) {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * sRGBtoLin(r) + 0.7152 * sRGBtoLin(g) + 0.0722 * sRGBtoLin(b);
}

function contrastRatio(hex1, hex2) {
  const l1 = relLuminance(hex1);
  const l2 = relLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function resolveColor(token, baseHex = '#ffffff') {
  if (!token) return null;
  const [name, alphaStr] = token.split('/');
  const rawHex = colors[name];
  if (!rawHex) return null;
  if (!alphaStr) return rawHex;
  const alpha = parseInt(alphaStr, 10) / 100;
  const fg = parseHex(rawHex);
  const bg = parseHex(baseHex);
  const r = Math.round(fg.r * alpha + bg.r * (1 - alpha));
  const g = Math.round(fg.g * alpha + bg.g * (1 - alpha));
  const b = Math.round(fg.b * alpha + bg.b * (1 - alpha));
  const toHex = (n) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const nonColorText = new Set([
  'center', 'right', 'left', 'justify', 'sm', 'md', 'lg', 'xs', 'xl',
  'h1', 'h2', 'h3', 'body-lg', 'body-md', 'body-sm', 'label-lg',
  'label-caps', 'label-sm', 'label-md', 'title-md', 'display-sm', 'bengali-support'
]);

function scanDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) files.push(...scanDir(full));
    else if (/\.(html|js|css)$/.test(ent.name)) files.push(full);
  }
  return files;
}

function collectPairs() {
  const files = [
    ...scanDir(path.join(ROOT, 'frontend', 'pages')),
    ...scanDir(path.join(ROOT, 'frontend', 'js', 'pages')),
    ...scanDir(path.join(ROOT, 'frontend', 'partials')),
    path.join(ROOT, 'frontend', 'styles', 'app.css')
  ];

  const pairs = new Map();

  function addPair(fgToken, bgToken, source) {
    const key = `${fgToken} on ${bgToken}`;
    if (!pairs.has(key)) {
      pairs.set(key, { fgToken, bgToken, sources: new Set() });
    }
    pairs.get(key).sources.add(source);
  }

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');

    // Parse class strings in attributes and JS strings
    const stringRegex = /['"`]([^'"`\n]+)['"`]/g;
    let match;
    while ((match = stringRegex.exec(content)) !== null) {
      const str = match[1];
      const tokens = str.split(/\s+/);
      const bgList = tokens.filter((t) => t.startsWith('bg-')).map((t) => t.replace('bg-', ''));
      const txList = tokens
        .filter((t) => t.startsWith('text-') && !nonColorText.has(t.replace('text-', '')) && !/^\[\d+px\]$/.test(t.replace('text-', '')))
        .map((t) => t.replace('text-', ''));
      const isIconOnly = tokens.includes('icon') && !txList.some((t) => t === 'money-fill' || t === 'on-surface');

      if (bgList.length > 0 && txList.length > 0 && !isIconOnly) {
        for (const bg of bgList) {
          for (const tx of txList) {
            addPair(tx, bg, rel);
          }
        }
      } else if (txList.length > 0 && !isIconOnly) {
        // Elements without explicit bg inherit the container card/surface (default: surface-card #ffffff)
        for (const tx of txList) {
          addPair(tx, 'surface-card', rel);
        }
      }
    }
  }

  // Design system component patterns & Arnab review role tokens
  const designSystemPairs = [
    ['on-primary', 'primary-container', 'frontend/styles/app.css (.btn-primary, .chip-active)'],
    ['on-surface', 'cta-amber', 'frontend/styles/app.css (.btn-cta)'],
    ['on-surface', 'surface-card', 'frontend/styles/app.css (.btn-outline, .card, .field)'],
    ['on-surface-variant', 'surface-card', 'frontend/styles/app.css (.btn-ghost, .chip)'],
    ['on-primary-fixed', 'primary-fixed', 'frontend/styles/app.css (.alert-info, .badge-category)'],
    ['on-error-container', 'error-container', 'frontend/styles/app.css (.alert-error)'],
    ['on-surface', 'success/10', 'frontend/styles/app.css (.alert-success)'],
    ['on-surface', 'success/15', 'frontend/styles/app.css (.badge-bid-placed)'],
    ['error', 'surface-card', 'frontend/styles/app.css (.field-error)'],
    ['money-fill', 'surface-card', 'design token (money-fill on white)'],
    ['money-fill', 'success/10', 'design token (money-fill on success/10)'],
    ['danger-fill', 'surface-card', 'design token (danger-fill on white)'],
    ['warning-fg', 'primary', 'design token (warning-fg on dark primary)'],
    ['danger-fg', 'primary', 'design token (danger-fg on dark primary)'],
    ['text-secondary', 'primary', 'design token (text-secondary on dark primary)']
  ];

  for (const [fg, bg, src] of designSystemPairs) {
    addPair(fg, bg, src);
  }

  return pairs;
}

async function run() {
  const report = createReport('Colour contrast');
  const pairs = collectPairs();

  console.log('\n┌──────────────────────────────────────┬─────────────┬─────────────┬──────────┬─────────┐');
  console.log('│ Text Token / Background Token        │ Text Hex    │ BG Hex      │ Ratio    │ WCAG AA │');
  console.log('├──────────────────────────────────────┼─────────────┼─────────────┼──────────┼─────────┤');

  for (const [key, item] of pairs.entries()) {
    const fgHex = resolveColor(item.fgToken);
    const bgHex = resolveColor(item.bgToken);
    if (!fgHex || !bgHex) continue;

    const ratio = contrastRatio(fgHex, bgHex);
    const passes = ratio >= 4.5;
    const pairLabel = `${item.fgToken} on ${item.bgToken}`.padEnd(36).slice(0, 36);
    const fgStr = fgHex.padEnd(11);
    const bgStr = bgHex.padEnd(11);
    const ratioStr = `${ratio.toFixed(2)}:1`.padEnd(8);
    const statusStr = passes ? 'PASS   ' : 'FAIL   ';

    console.log(`│ ${pairLabel} │ ${fgStr} │ ${bgStr} │ ${ratioStr} │ ${statusStr} │`);

    const id = `contrast-${item.fgToken}-on-${item.bgToken}`.replace(/[\/\s]/g, '-');
    if (passes) {
      report.pass(id, `${item.fgToken} (${fgHex}) on ${item.bgToken} (${bgHex}) passes WCAG AA (${ratio.toFixed(2)}:1)`, {
        ratio: Number(ratio.toFixed(2)),
        sources: [...item.sources]
      });
    } else {
      report.fail(id, `${item.fgToken} (${fgHex}) on ${item.bgToken} (${bgHex}) fails WCAG AA (${ratio.toFixed(2)}:1 < 4.5:1)`, {
        ratio: Number(ratio.toFixed(2)),
        sources: [...item.sources]
      });
    }
  }

  console.log('└──────────────────────────────────────┴─────────────┴─────────────┴──────────┴─────────┘');

  return report;
}

module.exports = { run, contrastRatio, relLuminance, resolveColor, collectPairs };
if (require.main === module) runCli(run).finally(() => {});
