// tests/deps-declared-unit.js
// DB-free regression test for scripts/qa/deps-declared.js.
//
// Replays the PR #40 break: it removed @tailwindcss/forms and @tailwindcss/container-queries from package.json while
// frontend/tailwind.config.js still require()d them. Local builds kept passing (node_modules still held the packages);
// only a clean `npm ci` in CI failed. This proves the check now fails on the REAL repo files in that situation, and
// also on the second class: production-image code importing a devDependency (`npm prune --production` removes it).
'use strict';

const fs = require('fs');
const path = require('path');
const { importedPackages, findProblems, collectFiles, dockerCopiedPaths, RUNTIME_PATHS } = require('../scripts/qa/deps-declared');

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

console.log('🧪 deps-declared: imports vs package.json');

// ── import scanning ────────────────────────────────────────────────────────────────────────────────
// The sample sources are assembled at runtime: the scanner reads every file in the repo (this one included), so
// import statements written literally inside strings here would be reported as real, undeclared imports.
const Q = "'";
const DQ = '"';
const REQ = 'req' + 'uire';
const req = (name) => `${REQ}(${Q}${name}${Q})`;
const from = (name) => 'fr' + 'om ' + Q + name + Q;
const src = [
  `const express = ${req('express')};`,
  `const { x } = ${REQ}(${DQ}@aws-sdk/client-s3/dist/thing${DQ});`,
  `import { a } ${from('lodash/fp')};`,
  `const m = await import(${Q}dynamic-pkg${Q});`,
  `const fs = ${req('fs')}; const p = ${req('node:path')}; const q = ${req('fs/promises')};`,
  `const rel = ${req('./local')}; const up = ${req('../up')}; const abs = ${req('/abs/file')};`,
  `// const nope = ${req('commented-out')};`,
  ` * ${req('in-jsdoc')}`,
  // regex literals that merely look like imports (as in scripts that scan for imports themselves)
  'const re = /(?:\\b' + REQ + '\\(\\s*|\\bfr' + 'om\\s+)[\'"]([^\'"./][^\'"]*)[\'"]/g;',
  'const weird = /fr' + 'om\\s+[\'"]\\.\\.\\\\[\'"]/;'
].join('\n');
const found = importedPackages(src);
check('finds require / import-from / dynamic import, with scope and subpath handled',
  same(found, ['express', '@aws-sdk/client-s3', 'lodash', 'dynamic-pkg']), JSON.stringify([...found]));
check('ignores built-ins (fs, node:path, fs/promises), relative and absolute paths',
  !['fs', 'path', 'local', 'up', 'abs'].some((n) => found.has(n)));
check('ignores commented-out requires and regex literals that merely look like imports',
  !found.has('commented-out') && !found.has('in-jsdoc') && [...found].every((n) => /^(@[\w.-]+\/)?[\w.-]+$/.test(n)));

// ── pure problem finding ───────────────────────────────────────────────────────────────────────────
const pkg = { dependencies: { express: '1' }, devDependencies: { tailwindcss: '3', autocannon: '8' } };
const files = [
  { path: 'server.js', text: `${req('express')}; ${req('ghost-pkg')};` },
  { path: 'routes/a.js', text: `${req('autocannon')};` },
  { path: 'scripts/load.js', text: `${req('autocannon')};` },
  { path: 'frontend/tailwind.config.js', text: `${req('tailwindcss')};` }
];
const r = findProblems(files, pkg);
check('an undeclared import is reported with its file',
  r.undeclared.length === 1 && r.undeclared[0].package === 'ghost-pkg' && r.undeclared[0].files[0] === 'server.js');
check('a devDependency imported by RUNTIME code is reported',
  r.devInRuntime.length === 1 && r.devInRuntime[0].package === 'autocannon' && r.devInRuntime[0].files[0] === 'routes/a.js');
check('a devDependency imported by a script or config is fine',
  !r.devInRuntime.some((x) => x.files.includes('scripts/load.js')) && !r.devInRuntime.some((x) => x.package === 'tailwindcss'));

// ── the real repository ───────────────────────────────────────────────────────────────────────────
const root = path.resolve(__dirname, '..');
const realPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const realFiles = collectFiles();
const real = findProblems(realFiles, realPkg);
check('real repo: every imported package is declared', real.undeclared.length === 0, JSON.stringify(real.undeclared));
check('real repo: runtime code imports only production dependencies', real.devInRuntime.length === 0, JSON.stringify(real.devInRuntime));
check('real repo: the scan really sees files (sanity)',
  realFiles.length > 100 && realFiles.some((f) => f.path === 'frontend/tailwind.config.js'), `files=${realFiles.length}`);

// PR #40 replayed: declare neither Tailwind plugin -> the config file must be flagged.
const dev40 = { ...realPkg.devDependencies };
delete dev40['@tailwindcss/forms'];
delete dev40['@tailwindcss/container-queries'];
const replay = findProblems(realFiles, { ...realPkg, devDependencies: dev40 });
const flagged = Object.fromEntries(replay.undeclared.map((u) => [u.package, u.files]));
check('PR #40 replayed: @tailwindcss/forms is flagged in frontend/tailwind.config.js',
  Array.isArray(flagged['@tailwindcss/forms']) && flagged['@tailwindcss/forms'].includes('frontend/tailwind.config.js'), JSON.stringify(flagged));
check('PR #40 replayed: @tailwindcss/container-queries is flagged too', Array.isArray(flagged['@tailwindcss/container-queries']));

// production dependency demoted to devDependencies -> server.js would crash in the pruned image.
const demoted = { dependencies: { ...realPkg.dependencies }, devDependencies: { ...realPkg.devDependencies, express: realPkg.dependencies.express } };
delete demoted.dependencies.express;
const dm = findProblems(realFiles, demoted);
check('express moved to devDependencies is flagged as dev-in-runtime (server.js)',
  dm.devInRuntime.some((x) => x.package === 'express' && x.files.includes('server.js')));

// an actually removed runtime dependency is "undeclared"
const gone = { dependencies: { ...realPkg.dependencies }, devDependencies: { ...realPkg.devDependencies } };
delete gone.dependencies.express;
check('express removed entirely is flagged as undeclared', findProblems(realFiles, gone).undeclared.some((x) => x.package === 'express'));

// ── RUNTIME_PATHS must match the Dockerfile ──────────────────────────────────────────────────────
const copied = dockerCopiedPaths(fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'));
check('Dockerfile copies at least the runtime directories we treat as shipped', copied.length >= 5, copied.join(','));
check('every path the Dockerfile copies is in RUNTIME_PATHS (else the dev-in-runtime check has a blind spot)',
  copied.every((p) => RUNTIME_PATHS.includes(p)), copied.filter((p) => !RUNTIME_PATHS.includes(p)).join(','));

console.log(failed ? `\n💥 ${failed} check(s) failed` : '\n✅ deps-declared unit checks passed');
process.exit(failed ? 1 : 0);
