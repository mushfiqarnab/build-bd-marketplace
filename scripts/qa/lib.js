// scripts/qa/lib.js — shared result collector for every QA layer.
// A layer returns a report; FAIL makes the run exit non-zero, WARN is
// surfaced for human review but does not block.
'use strict';

function createReport(layer) {
  const results = [];
  const add = (level, id, message, detail) => { results.push({ level, id, message, detail: detail === undefined ? null : detail }); };
  return {
    layer,
    results,
    pass: (id, message, detail) => add('PASS', id, message, detail),
    fail: (id, message, detail) => add('FAIL', id, message, detail),
    warn: (id, message, detail) => add('WARN', id, message, detail),
    info: (id, message, detail) => add('INFO', id, message, detail),
    counts() {
      const c = { PASS: 0, FAIL: 0, WARN: 0, INFO: 0 };
      for (const r of results) c[r.level] += 1;
      return c;
    },
    ok() { return results.every((r) => r.level !== 'FAIL'); }
  };
}

const ICON = { PASS: '✅', FAIL: '❌', WARN: '⚠️ ', INFO: 'ℹ️ ' };

function printReport(report, { verbose = false } = {}) {
  const c = report.counts();
  console.log(`\n━━ ${report.layer} — ${c.PASS} pass, ${c.FAIL} fail, ${c.WARN} warn`);
  for (const r of report.results) {
    if (r.level === 'PASS' && !verbose) continue;
    console.log(`  ${ICON[r.level]} [${r.id}] ${r.message}`);
    if (r.detail && (r.level !== 'PASS' || verbose)) {
      const d = typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail, null, 2);
      console.log(d.split('\n').slice(0, 25).map((l) => `       ${l}`).join('\n'));
    }
  }
}

/** Runs a layer as a CLI: prints and exits 1 on any FAIL. */
async function runCli(layerFn, opts) {
  try {
    const report = await layerFn(opts);
    printReport(report, { verbose: process.argv.includes('--verbose') });
    // Machine-readable line for scripts/qa/run-all.js.
    if (process.argv.includes('--json')) {
      console.log(`QA_JSON:${JSON.stringify({ layer: report.layer, ok: report.ok(), counts: report.counts(), results: report.results })}`);
    }
    process.exit(report.ok() ? 0 : 1);
  } catch (err) {
    console.error(`💥 QA layer crashed: ${err.stack || err.message}`);
    process.exit(2);
  }
}

module.exports = { createReport, printReport, runCli };
