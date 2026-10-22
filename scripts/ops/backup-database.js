// scripts/ops/backup-database.js
// Production Automated Database Archival & Integrity Verification Engine
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const dns = require('dns');
const mongoose = require('mongoose');
require('dotenv').config({ path: '.env.beta' });

const BACKUP_ROOT = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
const MAX_SNAPSHOTS_RETAINED = Number(process.env.BACKUP_RETENTION_COUNT) || 7;

function getTimestampString() {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, '-');
}

// Pre-load all application Mongoose models
function loadAllModels() {
  const modelsDir = path.join(__dirname, '..', '..', 'models');
  for (const file of fs.readdirSync(modelsDir).filter((f) => f.endsWith('.js'))) {
    try {
      require(path.join(modelsDir, file));
    } catch (_) {}
  }
}

async function streamModelToGzip(model, targetFilePath) {
  return new Promise((resolve, reject) => {
    const cursor = model.find({}).lean().cursor();
    const gzip = zlib.createGzip({ level: 9 });
    const output = fs.createWriteStream(targetFilePath);

    let docCount = 0;
    let isFirst = true;

    output.on('error', reject);
    gzip.on('error', reject);
    cursor.on('error', reject);

    gzip.pipe(output);

    // Stream as a JSON array of documents
    gzip.write('[\n');

    cursor.on('data', (doc) => {
      docCount += 1;
      const json = JSON.stringify(doc);
      if (!isFirst) {
        gzip.write(',\n');
      } else {
        isFirst = false;
      }
      gzip.write(json);
    });

    cursor.on('end', () => {
      gzip.write('\n]\n');
      gzip.end();
    });

    output.on('finish', () => {
      const fileBuffer = fs.readFileSync(targetFilePath);
      const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const stats = fs.statSync(targetFilePath);
      resolve({
        docCount,
        bytes: stats.size,
        sha256
      });
    });
  });
}

async function verifyBackupSnapshot(snapshotDir, manifest) {
  console.log(`\n🔍 Verifying Snapshot Integrity: ${snapshotDir}`);
  for (const item of manifest.collections) {
    const filePath = path.join(snapshotDir, item.filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Integrity Failure: Expected file missing: ${item.filename}`);
    }
    const fileBuffer = fs.readFileSync(filePath);
    const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    if (actualHash !== item.sha256) {
      throw new Error(`SHA-256 Checksum Mismatch in ${item.filename}! Expected ${item.sha256}, got ${actualHash}`);
    }

    // Verify gzip decompression and valid JSON parse
    const uncompressed = zlib.gunzipSync(fileBuffer).toString('utf8');
    const parsed = JSON.parse(uncompressed);
    if (!Array.isArray(parsed) || parsed.length !== item.documentCount) {
      throw new Error(`Data Corruption in ${item.filename}: Expected ${item.documentCount} docs, parsed ${parsed.length}`);
    }
    console.log(`  ✅ ${item.modelName} (${item.collectionName}): ${item.documentCount} docs | ${item.bytes} bytes | Checksum Verified`);
  }
}

async function pruneOldSnapshots() {
  if (!fs.existsSync(BACKUP_ROOT)) return;
  const entries = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('backup-'))
    .map((d) => ({
      name: d.name,
      path: path.join(BACKUP_ROOT, d.name),
      time: fs.statSync(path.join(BACKUP_ROOT, d.name)).mtimeMs
    }))
    .sort((a, b) => b.time - a.time);

  if (entries.length > MAX_SNAPSHOTS_RETAINED) {
    const toPrune = entries.slice(MAX_SNAPSHOTS_RETAINED);
    console.log(`\n🧹 Retention Policy: Pruning ${toPrune.length} snapshot(s) older than newest ${MAX_SNAPSHOTS_RETAINED}...`);
    for (const snap of toPrune) {
      fs.rmSync(snap.path, { recursive: true, force: true });
      console.log(`  🗑️ Pruned old snapshot: ${snap.name}`);
    }
  }
}

async function runBackup() {
  console.log('📦 Build-BD Automated Database Backup & Disaster Recovery Engine');
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI environment variable is required.');
  }

  if (uri.startsWith('mongodb+srv://')) {
    try { dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']); } catch (_) {}
  }

  loadAllModels();

  if (mongoose.connection.readyState !== 1) {
    console.log('Connecting to database...');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  }

  const timestamp = getTimestampString();
  const snapshotName = `backup-${timestamp}`;
  const targetDir = path.join(BACKUP_ROOT, snapshotName);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const modelNames = mongoose.modelNames().sort();
  console.log(`Found ${modelNames.length} domain models to archive into ${targetDir}\n`);

  const manifest = {
    snapshotName,
    createdAt: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV || 'production',
    dbName: mongoose.connection.name || 'production',
    modelsCount: modelNames.length,
    totalDocuments: 0,
    totalCompressedBytes: 0,
    collections: []
  };

  for (const modelName of modelNames) {
    const model = mongoose.model(modelName);
    const collName = model.collection.name;
    const filename = `${collName}.json.gz`;
    const targetFile = path.join(targetDir, filename);

    process.stdout.write(`Archiving model '${modelName}' (${collName})... `);
    const result = await streamModelToGzip(model, targetFile);
    console.log(`✅ ${result.docCount} docs (${result.bytes} bytes, sha256:${result.sha256.slice(0, 10)}...)`);

    manifest.totalDocuments += result.docCount;
    manifest.totalCompressedBytes += result.bytes;
    manifest.collections.push({
      modelName,
      collectionName: collName,
      filename,
      documentCount: result.docCount,
      bytes: result.bytes,
      sha256: result.sha256
    });
  }

  // Write manifest.json
  const manifestPath = path.join(targetDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n📋 Manifest written: ${manifestPath}`);

  // Automated self-verification
  await verifyBackupSnapshot(targetDir, manifest);

  // Retention pruning
  await pruneOldSnapshots();

  console.log(`\n🎉 Backup Snapshot [${snapshotName}] Completed Successfully!`);
  console.log(`Total Docs: ${manifest.totalDocuments} | Compressed Size: ${Math.round(manifest.totalCompressedBytes / 1024)} KB`);
  return { snapshotName, targetDir, manifest };
}

if (require.main === module) {
  runBackup()
    .then(async () => {
      await mongoose.disconnect();
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ Backup Execution Failed:', err);
      process.exit(1);
    });
}

module.exports = { runBackup, verifyBackupSnapshot };
