/**
 * tests/contractor-role-activation-e2e.js
 * Verifies:
 * 1. Streamlined phone-first onboarding (PENDING_ONBOARDING)
 * 2. Ability for a CLIENT to become a Service Provider / Contractor later without 403 lockout
 * 3. General name fallback ("স্বতন্ত্র সেবাদাতা ও কারিগর") when no custom name is entered
 * 4. Dynamic work field registration with anti-fraud scanned completion proof
 * 5. Incomplete profile notice flag in GET /api/auth/me
 */
'use strict';

const assert = require('assert');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5000';

async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...(options.headers || {})
  };
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, headers: res.headers, data: json };
}

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/bb_session=([^;]+)/);
  return match ? `bb_session=${match[1]}` : null;
}

async function run() {
  console.log('🧪 Starting Contractor Role Activation & General Name E2E Tests...');
  const testPhone = `01799${Math.floor(100000 + Math.random() * 900000)}`;

  // 1. Request OTP without upfront role categorization
  console.log(`\n1. Request OTP for ${testPhone}...`);
  const otpRes = await request('/api/auth/send-otp', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: testPhone })
  });
  assert.strictEqual(otpRes.status, 200, 'send-otp must succeed with 200');
  const otpCode = otpRes.data.debugOtp;
  assert.ok(otpCode, 'debugOtp must be present in dev/test environment');

  // 2. Verify OTP -> should default to PENDING_ONBOARDING
  console.log('2. Verify OTP...');
  const verifyRes = await request('/api/auth/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: testPhone, otp: otpCode })
  });
  assert.strictEqual(verifyRes.status, 200, 'verify-otp must succeed with 200');
  assert.strictEqual(verifyRes.data.user.role, 'PENDING_ONBOARDING', 'New signups must default to PENDING_ONBOARDING');
  assert.strictEqual(verifyRes.data.user.needsOnboarding, true, 'needsOnboarding must be true');

  let cookie = extractCookie(verifyRes);
  assert.ok(cookie, 'bb_session cookie must be issued');

  // 3. User checks auth state -> notice of incomplete profile
  console.log('3. GET /api/auth/me during PENDING_ONBOARDING...');
  const mePending = await request('/api/auth/me', { headers: { Cookie: cookie } });
  assert.strictEqual(mePending.status, 200);
  assert.strictEqual(mePending.data.user.hasProfile, false);
  assert.strictEqual(mePending.data.user.profileCompleteness, 'INCOMPLETE', 'Incomplete profile notice flag must be active');

  // 4. User chooses HIRE track initially (becomes CLIENT)
  console.log('4. User selects HIRE track...');
  const trackRes = await request('/api/auth/select-track', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ track: 'HIRE' })
  });
  assert.strictEqual(trackRes.status, 200);
  assert.strictEqual(trackRes.data.role, 'CLIENT');
  cookie = extractCookie(trackRes) || cookie;

  // 5. User checks auth state as CLIENT
  const meClient = await request('/api/auth/me', { headers: { Cookie: cookie } });
  assert.strictEqual(meClient.data.user.role, 'CLIENT');

  // 6. User decides to become a Service Provider / Contractor LATER!
  // Calls POST /api/contractor-profile with NO fullName provided (general name requirement)
  console.log('5. Client becomes Service Provider / Contractor later with general name...');
  const profileCreateRes = await request('/api/contractor-profile', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({
      businessType: 'INDIVIDUAL',
      serviceAreas: [{ district: 'Dhaka', areas: ['Mirpur', 'Dhanmondi'] }]
    })
  });
  assert.strictEqual(profileCreateRes.status, 201, 'CLIENT must be permitted to create contractor profile without 403');
  assert.strictEqual(profileCreateRes.data.profile.fullName, 'স্বতন্ত্র সেবাদাতা ও কারিগর', 'Must assign default general name');
  assert.strictEqual(profileCreateRes.data.profile.businessType, 'INDIVIDUAL');

  cookie = extractCookie(profileCreateRes) || cookie;

  // 7. GET /api/auth/me must now reflect CONTRACTOR role
  console.log('6. Verify user role dynamically upgraded to CONTRACTOR...');
  const meContractor = await request('/api/auth/me', { headers: { Cookie: cookie } });
  assert.strictEqual(meContractor.data.user.role, 'CONTRACTOR', 'Account must be upgraded to CONTRACTOR');
  assert.strictEqual(meContractor.data.user.hasProfile, true);
  // Still INCOMPLETE because no work genres selected yet
  assert.strictEqual(meContractor.data.user.profileCompleteness, 'INCOMPLETE', 'Notice flag must remain until service types/genres are selected');

  // 8. Contractor updates work fields / service types with past work proof
  console.log('7. Contractor registers MEP_ELECTRICAL field with completion proof...');
  const fieldRes = await request('/api/contractor-profile/fields', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({
      genre: 'MEP_ELECTRICAL',
      tier: 'GENERAL',
      pastWorkSummary: 'Completed 3 residential electrical distribution boards and conduit wiring in Mirpur.',
      completionDocuments: [
        {
          title: 'Mirpur Residential Wiring Completion Photo',
          mimeType: 'image/jpeg',
          fileData: 'data:image/jpeg;base64,' + Buffer.from('TEST_EVIDENCE_PHOTO_' + Date.now()).toString('base64')
        }
      ]
    })
  });
  assert.strictEqual(fieldRes.status, 200, 'Field registration must succeed');
  assert.strictEqual(fieldRes.data.field.genre, 'MEP_ELECTRICAL');
  assert.strictEqual(fieldRes.data.field.status, 'ACTIVE');

  // 9. Auth state now reflects COMPLETE
  console.log('8. Verify profile is now COMPLETE...');
  const meComplete = await request('/api/auth/me', { headers: { Cookie: cookie } });
  assert.strictEqual(meComplete.data.user.profileCompleteness, 'COMPLETE', 'Profile completeness must be COMPLETE once trade field is selected');

  console.log('\n🎉 ALL CONTRACTOR ROLE ACTIVATION & GENERAL NAME TESTS PASSED FLAWLESSLY!\n');
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
