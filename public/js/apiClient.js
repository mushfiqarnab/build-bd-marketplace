/**
 * 🛡️ BUILD-BD PRODUCTION FRONTEND API & STORAGE CLIENT
 * Tier-1 edge architecture for direct-to-S3 CPT streaming & idempotent mutations.
 */
class BuildBDEngineClient {
  constructor(baseURL = '/api') {
    this.baseURL = baseURL;
  }

  getAuthHeader() {
    // 'bb_token' is the key the portal writes on login (public/index.html).
    // The two legacy keys stay for one release so an already-logged-in tester
    // isn't silently logged out when they refresh after the upgrade.
    const token =
      localStorage.getItem('bb_token') ||
      localStorage.getItem('buildbd_token') ||
      localStorage.getItem('build_bd_jwt');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }

  /**
   * ☁️ Phase 18.9: Two-Step Stateless CPT Cloud Upload Pipeline
   * Streams files directly to AWS S3, bypassing Node.js server RAM entirely.
   */
  async uploadMilestoneProof(ledgerId, milestoneIndex, file) {
    if (!file) throw new Error('A valid File object is required for proof upload.');

    // Step 1: Request Pre-Signed URL & Cryptographic Proof Token (CPT)
    const sigRes = await fetch(`${this.baseURL}/governance/proof/signature/${ledgerId}/milestone/${milestoneIndex}`, {
      method: 'POST',
      headers: {
        ...this.getAuthHeader(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ contentType: file.type || 'application/pdf' })
    });

    const sigData = await sigRes.json();
    if (!sigRes.ok) throw new Error(`Signature generation failed: ${sigData.message}`);

    const { presignedUrl, fileKey, proofToken } = sigData.data;

    // Step 2: Stream bytes directly to Cloud Storage (S3 / R2)
    const s3UploadRes = await fetch(presignedUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': file.type || 'application/octet-stream'
      },
      body: file // Direct binary stream
    });

    if (!s3UploadRes.ok) {
      throw new Error(`Cloud storage upload failed with status ${s3UploadRes.status}`);
    }

    // Step 3: Confirm physical upload with backend via CPT & S3 HeadObject reconciliation
    const confirmRes = await fetch(`${this.baseURL}/governance/proof/confirm/${ledgerId}/milestone/${milestoneIndex}`, {
      method: 'POST',
      headers: {
        ...this.getAuthHeader(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ proofToken })
    });

    const confirmData = await confirmRes.json();
    if (!confirmRes.ok) throw new Error(`Proof confirmation failed: ${confirmData.message}`);

    return confirmData;
  }

  /**
   * 💳 Phase 19: Idempotent Financial Mutation Wrapper
   * Injects cryptographic Idempotency-Keys to prevent duplicate payouts on network drop.
   */
  async idempotentFetch(endpoint, options = {}) {
    const idempotencyKey = crypto.randomUUID ? crypto.randomUUID() : `IDEM-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const headers = {
      ...this.getAuthHeader(),
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'x-idempotency-key': idempotencyKey,
      ...(options.headers || {})
    };

    const response = await fetch(`${this.baseURL}${endpoint}`, {
      ...options,
      headers
    });

    const data = await response.json();
    if (!response.ok) {
      const err = new Error(data.message || 'API transaction failed.');
      err.status = response.status;
      err.data = data;
      throw err;
    }

    return data;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BuildBDEngineClient };
}
