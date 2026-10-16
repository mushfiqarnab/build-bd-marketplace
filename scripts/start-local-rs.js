// scripts/start-local-rs.js
'use strict';

const fs = require('fs');
const path = require('path');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

async function main() {
  console.log('🚀 Initializing MongoMemoryReplSet (1-node WiredTiger rs0)...');

  const replSet = await MongoMemoryReplSet.create({
    replSet: {
      count: 1,
      storageEngine: 'wiredTiger',
      name: 'rs0'
    }
  });

  const uri = replSet.getUri();
  console.log(`✅ MongoMemoryReplSet online at: ${uri}`);

  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, 'utf8');
    if (envContent.includes('MONGODB_URI=') && !envContent.includes('# OLD_MONGODB_URI=')) {
      envContent = envContent.replace(/^MONGODB_URI=(.*)$/m, '# OLD_MONGODB_URI=$1\nMONGODB_URI=' + uri);
    } else if (envContent.includes('MONGODB_URI=')) {
      envContent = envContent.replace(/^MONGODB_URI=.*$/m, 'MONGODB_URI=' + uri);
    } else {
      envContent += '\nMONGODB_URI=' + uri + '\n';
    }
    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log('✅ Updated .env with local MongoMemoryReplSet URI');
  }

  fs.writeFileSync(path.resolve(__dirname, '..', '.local-mongo-uri'), uri, 'utf8');

  console.log('🟢 Replica set server listening. Ready for ACID transactions.');

  const shutdown = async () => {
    console.log('🛑 Shutting down MongoMemoryReplSet...');
    try {
      await replSet.stop();
    } catch {}
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep event loop alive
  setInterval(() => {}, 10000);
}

main().catch((err) => {
  console.error('💥 Failed to start MongoMemoryReplSet:', err);
  process.exit(1);
});
