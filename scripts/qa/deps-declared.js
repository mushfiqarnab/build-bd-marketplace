// scripts/qa/deps-declared.js — every package the code imports must be declared in package.json, and code that ships
// in the production image must import only `dependencies`.
//
// Why: PR #40 removed two packages from package.json that frontend/tailwind.config.js still require()d. It passed on
// the author's machine because node_modules still held them, and failed only on a clean `npm ci` in CI. This layer
// needs no node_modules and no network: it reads the source text, so the same break fails locally in seconds.
//
// Second class caught: the Dockerfile runs `npm prune --production`, so a file copied into the image that imports a
// devDependency crashes the container at start-up even though every test passes.
//
// Limits (stated, not hidden): only literal specifiers are seen (`require('x')`, `import ... from 'x'`, `import('x')`);
// `require(someVariable)` is invisible; a package used only through a CLI/bin or a config string is reported as INFO.
'use strict';

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const { createReport, runCli } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'public', 'uploads', 'logs', 'qa-reports', 'coverage', '.claude', '.storage']);
// What the production image contains (Dockerfile, runner stage: COPY --from=builder /app/<x>).
const RUNTIME_PATHS = ['server.js', 'models', 'routes', 'middleware', 'services', 'utils'];
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.split('/')[0]]));
const PKG_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const IMPORT_RE = /(?:\brequire\(\s*|\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

/** Package names imported by a source text (comments skipped, built-ins and relative paths dropped). */
function importedPackages(text) {
  const out = new Set();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    for (const m of line.matchAll(IMPORT_RE)) {
      const spec = m[2];
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!PKG_NAME.test(name) || BUILTINS.has(name)) continue;
      out.add(name);
    }
  }
  return out;
}

function collectFiles(root = ROOT, dir = root, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(root, full, acc);
    else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) {
      acc.push({ path: path.relative(root, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') });
    }
  }
  return acc;
}

function isRuntimeFile(p, runtimePaths = RUNTIME_PATHS) {
  return runtimePaths.some((r) => p === r || p.startsWith(`${r}/`));
}

/**
 * Pure: which imported packages are undeclared, and which runtime files import a devDependency.
 * @param {{path:string,text:string}[]} files
 * @param {{dependencies?:object,devDependencies?:object}} pkg
 */
function findProblems(files, pkg, runtimePaths = RUNTIME_PATHS) {
  const deps = new Set(Object.keys(pkg.dependencies || {}));
  const dev = new Set(Object.keys(pkg.devDependencies || {}));
  const undeclared = new Map();
  const devInRuntime = new Map();
  const imported = new Set();
  for (const f of files) {
    for (const name of importedPackages(f.text)) {
      imported.add(name);
      if (!deps.has(name) && !dev.has(name)) {
        if (!undeclared.has(name)) undeclared.set(name, []);
        undeclared.get(name).push(f.path);
      } else if (!deps.has(name) && dev.has(name) && isRuntimeFile(f.path, runtimePaths)) {
        if (!devInRuntime.has(name)) devInRuntime.set(name, []);
        devInRuntime.get(name).push(f.path);
      }
    }
  }
  const unused = [...deps, ...dev].filter((n) => !imported.has(n)).sort();
  const asList = (m) => [...m].map(([pkgName, paths]) => ({ package: pkgName, files: [...new Set(paths)].sort() }));
  return { undeclared: asList(undeclared), devInRuntime: asList(devInRuntime), unused };
}

/** Paths the Dockerfile copies into the runner image: `COPY ... --from=builder /app/<x>`. */
function dockerCopiedPaths(dockerfile) {
  return [...dockerfile.matchAll(/COPY\s+(?:--\S+\s+)*--from=builder\s+\/app\/(\S+)/g)]
    .map((m) => m[1].replace(/\/$/, ''))
    .filter((p) => p !== 'node_modules' && p !== 'package.json' && p !== 'public');
}

async function run() {
  const report = createReport('Declared dependencies');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = collectFiles();
  report.info('inventory', `${files.length} JS files scanned; ${Object.keys(pkg.dependencies || {}).length} dependencies + ${Object.keys(pkg.devDependencies || {}).length} devDependencies declared`);

  const { undeclared, devInRuntime, unused } = findProblems(files, pkg);
  if (undeclared.length) report.fail('undeclared-imports', 'Code imports packages that package.json does not declare (a clean `npm ci` will not install them)', undeclared);
  else report.pass('undeclared-imports', 'Every imported package is declared in package.json');

  if (devInRuntime.length) report.fail('dev-dependency-in-runtime', 'Files shipped in the production image import a devDependency (`npm prune --production` removes it; the container would crash)', devInRuntime);
  else report.pass('dev-dependency-in-runtime', `Runtime code (${RUNTIME_PATHS.join(', ')}) imports only production dependencies`);

  const dockerfile = path.join(ROOT, 'Dockerfile');
  if (fs.existsSync(dockerfile)) {
    const copied = dockerCopiedPaths(fs.readFileSync(dockerfile, 'utf8'));
    const unknown = copied.filter((p) => !RUNTIME_PATHS.includes(p));
    if (unknown.length) report.warn('docker-runtime-paths', 'The Dockerfile copies paths this check does not treat as runtime code — add them to RUNTIME_PATHS in scripts/qa/deps-declared.js', unknown);
    else report.pass('docker-runtime-paths', 'RUNTIME_PATHS matches what the Dockerfile copies into the image');
  }

  if (unused.length) report.info('declared-but-not-imported', 'Declared packages with no literal import (normal for CLI tools / config-only packages; review occasionally)', unused);
  return report;
}

module.exports = { run, importedPackages, findProblems, collectFiles, dockerCopiedPaths, RUNTIME_PATHS };
if (require.main === module) runCli(run).finally(() => {});
