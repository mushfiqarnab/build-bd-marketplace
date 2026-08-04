// models/PasskeyCredential.js
// 🔐 WebAuthn Credential Store — binds FIDO2 authenticators to users.
// Each user may own multiple credentials (phone biometrics, hardware keys, etc.)
const mongoose = require('mongoose');

const passkeyCredentialSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    // The raw credential ID bytes as Base64URL — primary lookup key during assertion
    credentialID: {
      type: String,
      required: true,
      unique: true
    },
    // COSE-encoded public key (Base64URL), stored for signature verification
    credentialPublicKey: {
      type: String,
      required: true
    },
    // RPID counter — strictly monotonically increasing. Drift = cloned authenticator.
    counter: {
      type: Number,
      required: true,
      default: 0
    },
    // Transports reported by the authenticator (usb, nfc, ble, internal)
    transports: {
      type: [String],
      default: []
    },
    // Human-readable device label (e.g., "iPhone Face ID", "YubiKey 5C")
    deviceLabel: {
      type: String,
      default: 'Unnamed Device'
    },
    // AAGUID uniquely identifies the authenticator model
    aaguid: {
      type: String,
      default: null
    },
    lastUsedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

passkeyCredentialSchema.index({ userId: 1, credentialID: 1 });

module.exports = mongoose.model('PasskeyCredential', passkeyCredentialSchema);
