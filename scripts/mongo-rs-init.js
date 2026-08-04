// scripts/mongo-rs-init.js
// MongoDB Replica Set Initialisation Script
// Executed automatically on first boot via /docker-entrypoint-initdb.d/
// Idempotent — safe to re-run on container restart.
(function initReplicaSet() {
  try {
    const status = rs.status();
    if (status.ok === 1) {
      print('[RS-INIT] Replica set already initialised. Skipping.');
      return;
    }
  } catch (e) {
    // NotYetInitialized or no primary elected → proceed with initiation
  }

  print('[RS-INIT] Initiating replica set rs0...');
  const result = rs.initiate({
    _id: 'rs0',
    members: [{ _id: 0, host: 'mongo-primary:27017' }]
  });

  if (result.ok === 1) {
    print('[RS-INIT] ✅ Replica set rs0 initiated successfully.');
  } else {
    print('[RS-INIT] ❌ Replica set initiation returned: ' + JSON.stringify(result));
  }
}());
