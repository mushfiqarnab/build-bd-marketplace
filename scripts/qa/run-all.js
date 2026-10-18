#!/usr/bin/env node
// scripts/qa/run-all.js — the whole QA system in one command.
//
//   npm run qa                         static + routes + schema + plans + tests
//   npm run qa -- --live <url>         …plus the read-only live probe
//   npm run qa -- --load               …plus the local load test
//   npm run qa -- --ui <url>           …plus real-browser render checks (Edge/Chrome)
//   npm run qa -- --ledgers <uri>      …plus a READ-ONLY audit of every escrow ledger in that DB
//   npm run qa -- --only static,routes run selected layers
//
// Each layer runs in its own process (no shared module state), and the run
// writes qa-reports/qa-<timestamp>.{md,json}. Exit code 1 if any layer fails.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : undefined; };

const liveUrl = val('live') || process.env.QA_LIVE_URL;
const LAYERS = [
  { id: 'static', title: 'Static gates', script: 'static-gates.js' },
  { id: 'deps', title: 'Declared dependencies', script: 'deps-declared.js' },
  { id: 'contrast', title: 'Colour contrast', script: 'contrast-report.js' },
  { id: 'routes', title: 'Route policy', script: 'route-policy.js' },
  { id: 'schema', title: 'Schema policy', script: 'schema-policy.js' },
  { id: 'plans', title: 'Query plans', script: 'query-plans.js' },
  { id: 'tests', title: 'Test suites (npm test)', test: true },
  { id: 'live', title: 'Live probe', script: 'live-probe.js', args: [liveUrl], when: () => Boolean(liveUrl) },
  { id: 'ledgers', title: 'Ledger invariants (read-only DB audit)', script: 'ledger-invariants.js', args: ['--uri', val('ledgers')], when: () => Boolean(val('ledgers')) },
  { id: 'load', title: 'Load test', script: 'load-test.js', when: () => flag('load') },
  { id: 'ui', title: 'UI render (real browser)', script: 'ui-render.js', args: [val('ui')], when: () => Boolean(val('ui')) }
];

function runChild(cmd, args, { env } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, shell: false });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - t0 }));
  });
}

async function main() {
  const only = val('only') ? new Set(val('only').split(',')) : null;
  const selected = LAYERS.filter((l) => (only ? only.has(l.id) : (!l.when || l.when())));
  const started = new Date();
  const rows = [];

  for (const layer of selected) {
    process.stdout.write(`▶ ${layer.title} … `);
    let result;
    if (layer.test) {
      const r = await runChild(process.execPath, [path.join(ROOT, 'scripts', 'run-tests.js')]);
      const summary = (r.out.match(/✅ ALL \d+ SUITES PASSED|💥 FAILED at [^\n]+/) || ['(no summary)'])[0];
      result = { id: layer.id, title: layer.title, ok: r.code === 0, counts: null, summary, ms: r.ms, results: [] };
    } else {
      const r = await runChild(process.execPath, [path.join(__dirname, layer.script), '--json', ...(layer.args || []).filter(Boolean)]);
      const line = r.out.split(/\r?\n/).find((l) => l.startsWith('QA_JSON:'));
      if (!line) {
        result = { id: layer.id, title: layer.title, ok: false, counts: null, summary: 'layer crashed — see output', ms: r.ms, results: [], crash: r.out.slice(-2000) };
      } else {
        const j = JSON.parse(line.slice(8));
        result = { id: layer.id, title: layer.title, ok: j.ok, counts: j.counts, summary: `${j.counts.PASS} pass, ${j.counts.FAIL} fail, ${j.counts.WARN} warn`, ms: r.ms, results: j.results };
      }
    }
    rows.push(result);
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  (${result.summary}, ${(result.ms / 1000).toFixed(1)}s)`);
  }

  const ok = rows.every((r) => r.ok);
  const stamp = started.toISOString().replace(/[:.]/g, '-');
  const dir = path.join(ROOT, 'qa-reports');
  fs.mkdirSync(dir, { recursive: true });

  const md = [
    `# Build-BD QA report — ${started.toISOString()}`,
    '',
    `**Result: ${ok ? 'PASS' : 'FAIL'}**${liveUrl ? ` · live target: ${liveUrl}` : ''}`,
    '',
    '| Layer | Result | Summary | Time |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.title} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.summary} | ${(r.ms / 1000).toFixed(1)}s |`),
    ''
  ];
  for (const r of rows) {
    const notable = r.results.filter((x) => x.level !== 'PASS');
    if (!notable.length && !r.crash) continue;
    md.push(`## ${r.title}`, '');
    for (const x of notable) {
      md.push(`- **${x.level}** \`${x.id}\` — ${x.message}`);
      if (x.detail) md.push('', '  ```', ...JSON.stringify(x.detail, null, 2).split('\n').slice(0, 30).map((l) => `  ${l}`), '  ```');
    }
    if (r.crash) md.push('', '```', r.crash, '```');
    md.push('');
  }
  fs.writeFileSync(path.join(dir, `qa-${stamp}.md`), md.join('\n'));
  fs.writeFileSync(path.join(dir, `qa-${stamp}.json`), JSON.stringify({ startedAt: started, ok, liveUrl: liveUrl || null, layers: rows }, null, 2));

  console.log(`\n${ok ? '✅ QA PASSED' : '❌ QA FAILED'} — report: qa-reports/qa-${stamp}.md`);
  for (const r of rows.filter((x) => !x.ok)) {
    console.log(`  ✗ ${r.title}: ${r.summary}`);
    for (const x of r.results.filter((y) => y.level === 'FAIL').slice(0, 10)) console.log(`      - [${x.id}] ${x.message}`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
