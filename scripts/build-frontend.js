#!/usr/bin/env node
// scripts/build-frontend.js — builds frontend/ into public/app/.
//
//   npm run build:frontend
//
// 1. Pages: frontend/pages/*.html with <!--#include NAME --> partials and
//    {{v}} → content-hash cache-buster.
// 2. CSS: Tailwind (frontend/tailwind.config.js) compiled + minified.
// 3. JS: frontend/js copied as native ES modules (no bundler needed).
// 4. Fonts: Inter + Noto Sans Bengali from @fontsource, icon subset from
//    frontend/vendor — all self-hosted.
// 5. Guards — the build FAILS if any page:
//      • loads anything from an outside host (no CDN, no Google, no hotlinks)
//      • contains an inline <script> or inline event handler (strict CSP)
//      • uses an icon that is not in the subset (it would render as text)
//      • the icon subset is stale (icons.txt changed without build:icons)
//      • claims an eGP (government e-procurement) link (removed by product decision)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'frontend');
const OUT = path.join(ROOT, 'public', 'app');
const errors = [];

const read = (p) => fs.readFileSync(p, 'utf8');
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
function listFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? listFiles(p, ext) : (p.endsWith(ext) ? [p] : []);
    });
}

function readIconList() {
  return [...new Set(read(path.join(SRC, 'icons.txt')).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')))].sort();
}

function main() {
  const isSyncOnly = process.argv.includes('--sync-only');
  const existingCss = path.join(OUT, 'app.css');
  const existingFonts = path.join(OUT, 'fonts');
  const hasExistingAssets = fs.existsSync(existingCss) && fs.existsSync(existingFonts);

  if (!isSyncOnly && !hasExistingAssets) {
    // Fresh output only when doing full build or no assets exist
    fs.rmSync(OUT, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(OUT, 'fonts'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'js'), { recursive: true });

  // ── Icons: subset must match the declared list ────────────────────────────
  const icons = readIconList();
  const lockPath = path.join(SRC, 'vendor', 'icons.lock');
  const locked = fs.existsSync(lockPath) ? read(lockPath).split(/\r?\n/).filter(Boolean) : [];
  if (icons.join(',') !== locked.join(',')) errors.push('frontend/icons.txt changed but the font subset was not regenerated — run: npm run build:icons');

  // ── Fonts ─────────────────────────────────────────────────────────────────
  if (!isSyncOnly) {
    try {
      const fontSources = [
        ['@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'],
        ['@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2'],
        ...['400', '500', '600', '700'].map((w) => [`@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-${w}-normal.woff2`])
      ];
      for (const [mod] of fontSources) {
        const src = require.resolve(mod);
        fs.copyFileSync(src, path.join(OUT, 'fonts', path.basename(src)));
      }
      fs.copyFileSync(path.join(SRC, 'vendor', 'material-symbols-subset.woff2'), path.join(OUT, 'fonts', 'material-symbols-subset.woff2'));
      fs.copyFileSync(path.join(SRC, 'vendor', 'material-symbols-subset-v2.woff2'), path.join(OUT, 'fonts', 'material-symbols-subset-v2.woff2'));
      fs.copyFileSync(path.join(SRC, 'vendor', 'material-symbols-subset-v3.woff2'), path.join(OUT, 'fonts', 'material-symbols-subset-v3.woff2'));
    } catch (fontErr) {
      if (hasExistingAssets) {
        console.warn(`⚠️ [Build] Font source resolution failed (${fontErr.message}); preserving existing fonts in ${existingFonts}`);
      } else {
        throw fontErr;
      }
    }
  }

  // ── JS ────────────────────────────────────────────────────────────────────
  const jsFiles = listFiles(path.join(SRC, 'js'), '.js');
  for (const f of jsFiles) {
    const dest = path.join(OUT, 'js', path.relative(path.join(SRC, 'js'), f));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f, dest);
  }

  // ── CSS (Tailwind) ────────────────────────────────────────────────────────
  let builtCss = false;
  if (!isSyncOnly) {
    try {
      const tw = spawnSync(process.execPath, [
        require.resolve('tailwindcss/lib/cli.js'),
        '-c', path.join(SRC, 'tailwind.config.js'),
        '-i', path.join(SRC, 'styles', 'app.css'),
        '-o', path.join(OUT, 'app.css'),
        '--minify'
      ], { cwd: ROOT, encoding: 'utf8' });
      if (tw.status === 0) {
        builtCss = true;
      } else {
        if (!hasExistingAssets) {
          console.error(tw.stderr || tw.stdout);
          throw new Error('Tailwind build failed');
        }
        console.warn('⚠️ [Build] Tailwind compilation failed; falling back to existing public/app/app.css');
      }
    } catch (twErr) {
      if (!hasExistingAssets) throw twErr;
      console.warn('⚠️ [Build] Tailwind binary unavailable; using existing public/app/app.css');
    }
  }

  if (!fs.existsSync(path.join(OUT, 'app.css'))) {
    throw new Error('No public/app/app.css found. A full build with tailwindcss is required once.');
  }

  // Cache-buster: one hash over every shipped asset.
  const version = hash(Buffer.concat([
    fs.readFileSync(path.join(OUT, 'app.css')),
    ...jsFiles.map((f) => fs.readFileSync(f))
  ]));

  // ── Pages ─────────────────────────────────────────────────────────────────
  const partials = {};
  for (const f of listFiles(path.join(SRC, 'partials'), '.html')) partials[path.basename(f, '.html')] = read(f);
  const usedIcons = new Set();
  const pages = listFiles(path.join(SRC, 'pages'), '.html');
  for (const f of pages) {
    const name = path.relative(path.join(SRC, 'pages'), f);
    let html = read(f);
    for (let i = 0; i < 5 && /<!--#include\s+[\w-]+\s*-->/.test(html); i += 1) {
      html = html.replace(/<!--#include\s+([\w-]+)\s*-->/g, (_, p) => {
        if (!(p in partials)) { errors.push(`${name}: unknown partial "${p}"`); return ''; }
        return partials[p];
      });
    }
    html = html.replace(/\{\{v\}\}/g, version);

    // Guards
    const external = [...html.matchAll(/(?:src|href|action|srcset)\s*=\s*["']\s*(?:https?:)?\/\/(?!localhost)([^"'/]+)/gi)].map((m) => m[1]);
    if (external.length) errors.push(`${name}: loads from outside hosts: ${[...new Set(external)].join(', ')}`);
    if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) errors.push(`${name}: inline <script> (violates strict CSP)`);
    if (/\son[a-z]+\s*=\s*["']/i.test(html)) errors.push(`${name}: inline event handler attribute (violates strict CSP)`);
    if (/\be-?GP\b/.test(html)) errors.push(`${name}: eGP (government e-procurement) claim`);
    for (const m of html.matchAll(/class="[^"]*\bicon\b[^"]*"[^>]*>\s*([a-z0-9_]+)\s*</g)) usedIcons.add(m[1]);

    const dest = path.join(OUT, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, html);
  }
  for (const f of jsFiles) for (const m of read(f).matchAll(/\bicon\(\s*'([a-z0-9_]+)'/g)) usedIcons.add(m[1]);
  const missing = [...usedIcons].filter((i) => !icons.includes(i));
  if (missing.length) errors.push(`Icons used but not in frontend/icons.txt: ${missing.join(', ')}`);

  if (errors.length) {
    console.error('❌ Frontend build failed:\n' + errors.map((e) => `   • ${e}`).join('\n'));
    process.exit(1);
  }
  const cssKb = (fs.statSync(path.join(OUT, 'app.css')).size / 1024).toFixed(1);
  console.log(`✅ Frontend built → public/app  (${pages.length} pages, ${jsFiles.length} JS modules, app.css ${cssKb} KB, ${icons.length} icons, version ${version})`);
}

try { main(); } catch (err) { console.error(`❌ ${err.message}`); process.exit(1); }
