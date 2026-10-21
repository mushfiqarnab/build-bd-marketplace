// tests/notification-service-unit.js
// Unit tests for Central Notification Dispatch Engine (Synthesis §3.3)
'use strict';

const {
  sendNotification,
  notifyMilestoneStalled,
  notifyEvidenceSubmitted,
  notifyMaterialVariance,
  notifyDisputeCreated
} = require('../services/notificationService');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

// Mock Socket.io
function createMockIo() {
  const emitted = [];
  return {
    to(room) {
      return {
        emit(event, data) {
          emitted.push({ room, event, data });
        }
      };
    },
    getEmitted() {
      return emitted;
    }
  };
}

async function run() {
  console.log('🧪 Notification Service Unit Tests');

  const mockIo = createMockIo();

  // Test 1: Direct sendNotification with Socket delivery
  const res1 = await sendNotification({
    userId: '654321000000000000000001',
    phoneNumber: '01711111111',
    eventType: 'CUSTOM_TEST',
    title: 'Test Notification',
    message: 'Hello Bangladesh!',
    metadata: { key: 'value' },
    io: mockIo
  });

  check('sendNotification reports delivered', res1.delivered === true);
  check('sendNotification reports socket channel active', res1.channels.socket === true);
  check('sendNotification reports SMS channel active', res1.channels.sms === true);

  const emitted = mockIo.getEmitted();
  check('Socket emit captured event', emitted.length === 1 && emitted[0].room === 'user:654321000000000000000001');
  check('Emitted payload matches', emitted[0].data.title === 'Test Notification');

  // Test 2: notifyMilestoneStalled triggers for both client and contractor
  const resStalled = await notifyMilestoneStalled({
    clientId: '654321000000000000000001',
    contractorId: '654321000000000000000002',
    projectId: 'p123',
    milestoneTitle: 'Ground Foundation',
    io: mockIo
  });
  check('notifyMilestoneStalled emits socket events to both user rooms', emitted.length === 3);

  // Test 3: notifyEvidenceSubmitted
  const resEvidence = await notifyEvidenceSubmitted({
    clientId: '654321000000000000000001',
    projectId: 'p123',
    milestoneTitle: 'First Floor Slab',
    tier: 'CRYPTOGRAPHIC_PROOF',
    io: mockIo
  });
  check('notifyEvidenceSubmitted delivers successfully', resEvidence.delivered === true);
  check('notifyEvidenceSubmitted payload includes tier', resEvidence.payload.metadata.tier === 'CRYPTOGRAPHIC_PROOF');

  // Test 4: notifyMaterialVariance
  const resVariance = await notifyMaterialVariance({
    clientId: '654321000000000000000001',
    projectId: 'p123',
    flags: ['BRAND_SUBSTITUTION_DETECTED', 'WEIGHT_SLIP_MISMATCH'],
    io: mockIo
  });
  check('notifyMaterialVariance delivers successfully', resVariance.delivered === true);
  check('notifyMaterialVariance includes flagged items', resVariance.payload.metadata.flags.length === 2);

  // Test 5: notifyDisputeCreated
  const resDispute = await notifyDisputeCreated({
    recipientId: '654321000000000000000002',
    ticketId: 'TKT-9988',
    reason: 'Structural foundation beam cracks visible',
    io: mockIo
  });
  check('notifyDisputeCreated delivers successfully', resDispute.delivered === true);
  check('notifyDisputeCreated contains ticketId', resDispute.payload.metadata.ticketId === 'TKT-9988');

  // Test 6: Graceful error handling on empty or missing fields
  const resFallback = await sendNotification({
    eventType: 'GENERIC_ALERT',
    title: 'Platform Maintenance',
    message: 'Scheduled at midnight'
  });
  check('sendNotification without io/phone succeeds gracefully', resFallback.delivered === true);
  check('sendNotification channel indicators false when absent', resFallback.channels.socket === false && resFallback.channels.sms === false);

  if (failed > 0) {
    console.error(`💥 ${failed} test(s) failed.`);
    process.exit(1);
  }
  console.log('✅ All notification service unit tests passed cleanly.');
  process.exit(0);
}

run();
