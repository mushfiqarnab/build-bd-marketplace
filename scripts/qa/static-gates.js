// scripts/qa/static-gates.js — no server, no database. Safe in CI.
//   1. Git hygiene: secret-bearing env files are never tracked
//   2. Secret scan over every tracked text file
//   3. Banned dangerous patterns in production source
//   4. Every first-party JS file parses
//   5. Dependency vulnerabilities (npm audit, high/critical = FAIL)
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { createReport, runCli } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const TEXT_EXT = new Set(['.js', '.json', '.md', '.html', '.css', '.yml', '.yaml', '.env', '.example', '.txt', '.ps1', '.sh', '.ts', '']);

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
}

// Each rule: id, regex, why. Placeholders like <PASSWORD> never match because
// the password groups exclude '<' and require real-looking material.
const SECRET_RULES = [
  { id: 'mongo-uri-with-password', re: /mongodb(?:\+srv)?:\/\/[^\s:/@<>"']+:[^\s@<>"'$]{6,}@/g, why: 'MongoDB connection string with an embedded password' },
  { id: 'redis-uri-with-password', re: /rediss?:\/\/[^\s:/@<>"']*:[^\s@<>"'$]{12,}@/g, why: 'Redis connection string with an embedded password' },
  { id: 'hex-secret-assignment', re: /\b(?:JWT|BID_SEAL|AUDIT_HMAC|STORAGE_LOCAL)_SECRET\s*[=:]\s*['"]?[0-9a-f]{64,}/gi, why: '64+ hex-char secret assigned to a *_SECRET variable' },
  { id: 'sslcommerz-store-password', re: /SSL_STORE_PASSWORD\s*[=:]\s*['"]?[A-Za-z0-9]{6,}@ssl/g, why: 'SSLCommerz store password' },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, why: 'PEM private key' },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, why: 'AWS access key id' }
];

// Production-source rules (tests and qa scripts are excluded where noted).
const BANNED_RULES = [
  { id: 'math-random-in-security-code', files: /^(routes|services|middleware)\//, re: /Math\.random\(/g, why: 'Math.random is not a CSPRNG — use crypto.randomInt / randomBytes' },
  { id: 'eval', files: /^(routes|services|middleware|models|utils|public)\/|^server\.js$/, re: /\beval\(|new Function\(/g, why: 'dynamic code execution' },
  { id: 'cors-wildcard-fallback', files: /^(server\.js|services\/)/, re: /CORS_ORIGIN\s*\|\|\s*['"]\*['"]/g, why: 'CORS silently opens to every origin when unset' },
  { id: 'innerHTML-in-portal', files: /^public\/.*\.(html|js)$/, re: /\.innerHTML\s*=|insertAdjacentHTML\(/g, why: 'XSS sink — use textContent/DOM APIs' },
  { id: 'egp-claim', files: /^(public|routes|services|models)\//, re: /\be-?GP\b|Section\s+(15|9)\b/g, why: 'e-GP alignment claims were removed by product decision' },
  { id: 'token-in-localstorage', files: /^public\/.*\.(html|js)$/, re: /localStorage\.setItem\(\s*['"][^'"]*(token|jwt)[^'"]*['"]/gi, why: 'session tokens belong in the httpOnly cookie, not localStorage' },
  { id: 'debug-otp-unguarded', files: /^routes\//, re: /debugOtp\s*=/g, why: 'debugOtp must only exist inside the console-delivery dev branch', allowIf: (src) => /deliveryMode === 'console' && process\.env\.NODE_ENV !== 'production'/.test(src) },
  { id: 'accusatory-error-strings', files: /^(routes|services|middleware|models|public|frontend)\//, re: /\bFraud\s+Alert\b/gi, why: 'Accusatory "Fraud Alert" strings violate the "inform, never accuse" copy policy' }
];

function lineOf(src, index) { return src.slice(0, index).split('\n').length; }

async function run() {
  const report = createReport('Static gates');
  const files = trackedFiles();

  // 1. Git hygiene
  const envTracked = files.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example'));
  if (envTracked.length) report.fail('git-env-tracked', 'Secret-bearing env files are tracked by git', envTracked);
  else report.pass('git-env-tracked', 'No .env / .env.beta files tracked');
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  const mustIgnore = ['.env', 'logs/', '.storage/', 'node_modules/'];
  const missing = mustIgnore.filter((p) => !gi.split(/\r?\n/).some((l) => l.trim() === p || l.trim() === `${p}*` || (p === '.env' && l.trim() === '.env.*')));
  if (missing.length) report.fail('gitignore', '.gitignore is missing required entries', missing);
  else report.pass('gitignore', '.gitignore covers env files, logs, storage, node_modules');

  // 2. Secret scan
  const secretHits = [];
  for (const f of files) {
    if (!TEXT_EXT.has(path.extname(f)) && !/\.env/.test(f)) continue;
    if (f.startsWith('scripts/qa/')) continue; // the rules themselves
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { continue; }
    if (src.length > 2_000_000) continue;
    for (const rule of SECRET_RULES) {
      for (const m of src.matchAll(rule.re)) {
        const snippet = m[0].slice(0, 24) + '…';
        // Fixtures in tests may contain obviously-fake material; still report as WARN.
        secretHits.push({ file: f, line: lineOf(src, m.index), rule: rule.id, why: rule.why, snippet, inTests: f.startsWith('tests/') });
      }
    }
  }
  const realHits = secretHits.filter((h) => !h.inTests);
  if (realHits.length) report.fail('secret-scan', `${realHits.length} probable secret(s) in tracked files`, realHits);
  else report.pass('secret-scan', `No secrets found in ${files.length} tracked files`);
  const testHits = secretHits.filter((h) => h.inTests);
  if (testHits.length) report.warn('secret-scan-tests', 'Secret-shaped strings in test fixtures — confirm they are fake', testHits);

  // 3. Banned patterns
  for (const rule of BANNED_RULES) {
    const hits = [];
    for (const f of files) {
      if (!rule.files.test(f) || f.startsWith('tests/')) continue;
      let src;
      try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { continue; }
      if (rule.allowIf && rule.allowIf(src)) continue;
      for (const m of src.matchAll(rule.re)) {
        // Ignore matches inside line comments.
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        if (/^\s*(\/\/|\*)/.test(src.slice(lineStart, m.index))) continue;
        hits.push(`${f}:${lineOf(src, m.index)}`);
      }
    }
    if (hits.length) report.fail(`banned:${rule.id}`, rule.why, hits);
    else report.pass(`banned:${rule.id}`, `No ${rule.id}`);
  }

  // 3b. Test-suite integrity
  const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'run-tests.js'), 'utf8');
  const suiteFiles = files.filter((f) => /^tests\/[^/]+\.js$/.test(f));
  const orphans = suiteFiles.filter((f) => !runner.includes(`'${f}'`));
  if (orphans.length) report.fail('orphan-tests', 'Test files not registered in scripts/run-tests.js — they never run (and rot)', orphans);
  else report.pass('orphan-tests', `All ${suiteFiles.length} test files are registered`);
  const swallowing = suiteFiles.filter((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return /finally\s*\{[^}]*process\.exit\(\s*0\s*\)/.test(src);
  });
  if (swallowing.length) report.fail('test-swallows-failure', 'Suites that exit 0 from a finally block can never fail', swallowing);
  else report.pass('test-swallows-failure', 'No suite hard-codes a passing exit code in finally');

  // 4. Syntax
  // components/ holds unbuilt React/JSX sources (not server code, not served).
  const jsFiles = files.filter((f) => f.endsWith('.js') && !f.startsWith('public/') && !f.startsWith('components/'));
  const unbuilt = files.filter((f) => f.startsWith('components/'));
  if (unbuilt.length) report.warn('dead-frontend-sources', 'components/ contains JSX that nothing builds, imports or serves — remove or wire into the real frontend', unbuilt);
  const broken = [];
  for (const f of jsFiles) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
    if (r.status !== 0) broken.push({ file: f, error: (r.stderr || '').split('\n').slice(0, 4).join(' ') });
  }
  if (broken.length) report.fail('syntax', 'JavaScript files fail to parse', broken);
  else report.pass('syntax', `${jsFiles.length} server-side JS files parse`);

  // 5. Dependencies
  // npm is a .cmd shim on Windows, which spawn can only run through a shell;
  // the command line is a constant, so no user input reaches the shell.
  const audit = process.platform === 'win32'
    ? spawnSync('npm audit --json --omit=dev', { cwd: ROOT, encoding: 'utf8', shell: true })
    : spawnSync('npm', ['audit', '--json', '--omit=dev'], { cwd: ROOT, encoding: 'utf8' });
  try {
    const j = JSON.parse(audit.stdout || '{}');
    const v = (j.metadata && j.metadata.vulnerabilities) || {};
    const severe = (v.high || 0) + (v.critical || 0);
    if (severe) report.fail('npm-audit', `${severe} high/critical production dependency vulnerabilities`, v);
    else if ((v.moderate || 0) + (v.low || 0)) report.warn('npm-audit', 'Low/moderate production dependency vulnerabilities', v);
    else report.pass('npm-audit', 'No known vulnerabilities in production dependencies');
  } catch (_) {
    report.warn('npm-audit', 'npm audit unavailable (offline?) — dependency check skipped', (audit.stderr || '').slice(0, 300));
  }

  // Dev/build-time dependencies: a high/critical advisory must be reviewed
  // into accepted-advisories.json (with reason + expiry) or the gate fails.
  const fullAudit = process.platform === 'win32'
    ? spawnSync('npm audit --json', { cwd: ROOT, encoding: 'utf8', shell: true })
    : spawnSync('npm', ['audit', '--json'], { cwd: ROOT, encoding: 'utf8' });
  try {
    const j = JSON.parse(fullAudit.stdout || '{}');
    if (!j.vulnerabilities) throw new Error('no audit data');
    const { accepted } = JSON.parse(fs.readFileSync(path.join(__dirname, 'accepted-advisories.json'), 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    const found = new Map();
    for (const [pkg, v] of Object.entries(j.vulnerabilities)) {
      for (const via of v.via) {
        if (typeof via !== 'object' || !['high', 'critical'].includes(via.severity)) continue;
        const id = String(via.url || '').split('/').pop();
        found.set(id, { id, package: pkg, severity: via.severity, title: via.title });
      }
    }
    const unreviewed = [...found.values()].filter((f) => !accepted.some((a) => a.id === f.id));
    const expired = accepted.filter((a) => found.has(a.id) && a.expires < today);
    const stale = accepted.filter((a) => !found.has(a.id)).map((a) => a.id);
    if (unreviewed.length) report.fail('dev-audit', 'Unreviewed high/critical advisories in dev dependencies — fix, or review into scripts/qa/accepted-advisories.json', unreviewed);
    else if (expired.length) report.fail('dev-audit', 'Accepted advisory past its expiry — re-review or upgrade', expired.map((a) => `${a.id} (${a.package}) expired ${a.expires}`));
    else report.pass('dev-audit', `Dev dependencies: ${found.size} high/critical advisor${found.size === 1 ? 'y' : 'ies'}, all reviewed and within expiry`);
    if (stale.length) report.warn('dev-audit-stale', 'Allowlist entries no longer needed — remove them', stale);
  } catch (_) {
    report.warn('dev-audit', 'npm audit unavailable (offline?) — dev dependency check skipped', (fullAudit.stderr || '').slice(0, 300));
  }

  return report;
}

module.exports = { run };
if (require.main === module) runCli(run);
