'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dest = path.resolve('C:/Users/iftid/Downloads/build-bd-marketplace-v3-zero-cost-ready.zip');
if (fs.existsSync(dest)) {
  fs.unlinkSync(dest);
}

const excludes = new Set(['node_modules', '.git', 'mongo.txt', '.local-mongo-uri', 'scratch']);
const items = fs.readdirSync(process.cwd()).filter((f) => {
  if (excludes.has(f)) return false;
  if (f.startsWith('.env')) return false;
  return true;
});

console.log(`📦 Packaging ${items.length} root items into ${dest}...`);

const pwsh = spawnSync('powershell', [
  '-NoProfile',
  '-Command',
  `Compress-Archive -Path ${items.join(',')} -DestinationPath '${dest}' -CompressionLevel Optimal`
], { stdio: 'inherit' });

if (pwsh.status !== 0) {
  console.error('❌ Failed to create zip archive');
  process.exit(1);
}

const stat = fs.statSync(dest);
console.log(`✅ Deployable archive updated: ${(stat.size / 1024 / 1024).toFixed(2)} MB (${stat.size} bytes)`);
