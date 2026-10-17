#!/usr/bin/env node
// scripts/build-icons.js — subset Material Symbols Outlined to the icons in
// frontend/icons.txt using Google Fonts' official `icon_names` API, and commit
// the result to frontend/vendor/. Users never contact Google at runtime.
// The full variable font is ~3.3 MB; a subset of a few dozen icons is a few KB.
// Axes are pinned (opsz 24, wght 400, GRAD 0) and FILL kept 0..1 for .icon-fill.
//
//   npm run build:icons     (needs network; run only when icons.txt changes)
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIST = path.join(ROOT, 'frontend', 'icons.txt');
const OUT_DIR = path.join(ROOT, 'frontend', 'vendor');
// A modern UA makes the CSS API serve woff2.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function readIcons() {
  const icons = fs.readFileSync(LIST, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const bad = icons.filter((i) => !/^[a-z0-9_]+$/.test(i));
  if (bad.length) throw new Error(`Invalid icon names in icons.txt: ${bad.join(', ')}`);
  return [...new Set(icons)].sort(); // the API requires alphabetical order
}

async function main() {
  const icons = readIcons();
  const url = `https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0..1,0&icon_names=${icons.join(',')}&display=block`;
  const css = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
  const fontUrl = (css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)\s*format\('woff2'\)/) || [])[1];
  if (!fontUrl) throw new Error(`Google Fonts returned no woff2 for this icon list:\n${css.slice(0, 400)}`);
  const buf = Buffer.from(await (await fetch(fontUrl, { headers: { 'User-Agent': UA } })).arrayBuffer());
  if (buf.length < 1000 || buf.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error('Downloaded file is not a woff2 font.');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'material-symbols-subset.woff2'), buf);
  fs.writeFileSync(path.join(OUT_DIR, 'icons.lock'), icons.join('\n') + '\n');
  console.log(`✅ ${icons.length} icons → frontend/vendor/material-symbols-subset.woff2 (${(buf.length / 1024).toFixed(1)} KB; full font ≈ 3,300 KB)`);
}

main().catch((err) => { console.error(`❌ build-icons failed: ${err.message}`); process.exit(1); });
