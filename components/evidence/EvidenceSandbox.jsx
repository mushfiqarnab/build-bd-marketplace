// components/evidence/EvidenceSandbox.jsx
/**
 * 🛡️ Phase 21 — Zero-RAM Evidence Submission Sandbox Component
 * 
 * Integrated Next.js / React Container for Bangladeshi Construction Market.
 * 
 * Features:
 *   1. Hardware Permission State Machine (via `useHardwareSandbox`).
 *   2. Background GPS Satellite Acquisition during Educational Screen.
 *   3. Live Camera Viewfinder (forced rear camera, strict no-gallery policy).
 *   4. Direct-to-S3 Zero-RAM Pipeline:
 *      - GET /api/governance/proof/presigned-url
 *      - Local SHA-256 hash via Web Crypto API (crypto.subtle.digest)
 *      - Direct S3 FormData POST (zero Node.js backend RAM)
 *      - POST /api/governance/proof/evidence/live (Pure JSON payload confirmation)
 *   5. Dual-Language high-contrast UI tailored for field conditions.
 */

import React, { useState, useCallback } from 'react';
import { useHardwareSandbox, SANDBOX_STATES } from './useHardwareSandbox';
import { CameraViewfinder } from './CameraViewfinder';

export function EvidenceSandbox({
  ledgerId,
  milestoneIndex,
  authToken,
  apiBaseUrl = '/api/governance',
  onSuccess,
  onCancel
}) {
  const {
    sandboxState,
    gpsData,
    gpsError,
    cameraStream,
    cameraError,
    isGpsLocked,
    requestHardwareAccess,
    stopCameraStream,
    accuracyThreshold
  } = useHardwareSandbox();

  const [isProcessing, setIsProcessing] = useState(false);
  const [pipelineStep, setPipelineStep] = useState(''); // Status message for pipeline steps
  const [errorMessage, setErrorMessage] = useState(null);
  const [uploadResult, setUploadResult] = useState(null);

  // ─────────────────────────────────────────────────────────────────────────
  // ⚡ DIRECT-TO-S3 ZERO-RAM CAPTURE & UPLOAD PIPELINE
  // ─────────────────────────────────────────────────────────────────────────
  const handleCaptureAndSubmit = useCallback(async (videoElement) => {
    if (!videoElement) {
      setErrorMessage('Video viewfinder is not active.');
      return;
    }

    if (!isGpsLocked || gpsData.lat === null) {
      setErrorMessage(`GPS accuracy must be <= ${accuracyThreshold}m before capturing.`);
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);

    try {
      // ── STEP 1: GET PRE-SIGNED S3 POST POLICY FROM BACKEND ────────────────
      setPipelineStep('📡 Fetching S3 Pre-Signed Upload Signature...');
      const presignUrl = `${apiBaseUrl}/proof/presigned-url?ledgerId=${encodeURIComponent(ledgerId)}&milestoneIndex=${encodeURIComponent(milestoneIndex)}&contentType=image/jpeg`;
      
      const presignRes = await fetch(presignUrl, {
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      });

      if (!presignRes.ok) {
        const errJson = await presignRes.json().catch(() => ({}));
        throw new Error(errJson.message || `Presign request failed (${presignRes.status}).`);
      }

      const presignJson = await presignRes.json();
      const { uploadUrl, uploadFields, s3KeyToken } = presignJson.data;

      // ── STEP 2: CAPTURE FRAME TO CANVAS & CONVERT TO JPEG BLOB ───────────
      setPipelineStep('📷 Capturing Frame & Computing SHA-256 Hash...');
      const canvas = document.createElement('canvas');
      canvas.width = videoElement.videoWidth || 1280;
      canvas.height = videoElement.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Canvas frame capture failed.'))),
          'image/jpeg',
          0.90
        );
      });

      // ── STEP 3: COMPUTE SHA-256 HASH LOCALLY VIA WEB CRYPTO API ───────────
      const arrayBuffer = await blob.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const imageHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

      // ── STEP 4: DIRECT S3 UPLOAD (ZERO NODE.JS BACKEND RAM) ───────────────
      setPipelineStep('☁️ Uploading Directly to Cloud Storage (S3)...');
      const formData = new FormData();
      Object.entries(uploadFields || {}).forEach(([key, value]) => {
        formData.append(key, value);
      });
      formData.append('file', blob, 'evidence.jpg');

      const s3Res = await fetch(uploadUrl, {
        method: 'POST',
        body: formData
      });

      if (!s3Res.ok && s3Res.status !== 204) {
        throw new Error(`Cloud storage upload failed with status ${s3Res.status}`);
      }

      // ── STEP 5: PURE JSON CONFIRMATION TO BACKEND (LIVE PATH) ─────────────
      setPipelineStep('🔒 Confirming Evidence Ledger Commit...');
      const confirmUrl = `${apiBaseUrl}/proof/evidence/live/${ledgerId}/milestone/${milestoneIndex}`;
      const confirmRes = await fetch(confirmUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
          s3KeyToken,
          imageHash,
          lat: gpsData.lat,
          lng: gpsData.lng,
          accuracy: gpsData.accuracy
        })
      });

      if (!confirmRes.ok) {
        const errJson = await confirmRes.json().catch(() => ({}));
        throw new Error(errJson.message || `Ledger confirmation failed (${confirmRes.status}).`);
      }

      const confirmJson = await confirmRes.json();
      stopCameraStream();
      setUploadResult(confirmJson);

      if (onSuccess) {
        onSuccess(confirmJson);
      }
    } catch (err) {
      console.error('💥 Evidence Pipeline Error:', err);
      setErrorMessage(err.message || 'An error occurred during evidence submission.');
    } finally {
      setIsProcessing(false);
      setPipelineStep('');
    }
  }, [apiBaseUrl, authToken, gpsData, isGpsLocked, accuracyThreshold, ledgerId, milestoneIndex, stopCameraStream, onSuccess]);

  // ─────────────────────────────────────────────────────────────────────────
  // 🟢 SUCCESS SCREEN
  // ─────────────────────────────────────────────────────────────────────────
  if (uploadResult) {
    return (
      <div className="w-full max-w-md mx-auto p-6 bg-slate-900 text-white rounded-2xl border-4 border-emerald-500 shadow-2xl text-center font-sans space-y-4">
        <div className="w-16 h-16 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto border-2 border-emerald-400">
          <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-black text-emerald-400">প্রমাণ সফলভাবে জমা হয়েছে!</h2>
        <p className="text-sm text-slate-300 font-medium">Evidence Recorded in Immutable Ledger</p>

        <div className="bg-slate-950 p-4 rounded-xl text-xs font-mono text-left space-y-2 border border-slate-800">
          <div className="flex justify-between border-b border-slate-800 pb-1">
            <span className="text-slate-500">Tier:</span>
            <span className="text-emerald-400 font-bold">{uploadResult.evidence?.verificationTier}</span>
          </div>
          <div className="flex justify-between border-b border-slate-800 pb-1">
            <span className="text-slate-500">Distance:</span>
            <span className="text-slate-200">{uploadResult.evidence?.distanceMeters}m from site</span>
          </div>
          <div>
            <span className="text-slate-500 block mb-1">SHA-256 Hash:</span>
            <span className="text-amber-400 font-mono text-[10px] break-all">{uploadResult.evidence?.imageHash}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => window.location.reload()}
          className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl text-sm transition-all"
        >
          সম্পন্ন করুন (Done)
        </button>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1️⃣ STATE 1: EDUCATIONAL PERMISSION SCREEN
  // ─────────────────────────────────────────────────────────────────────────
  if (sandboxState === SANDBOX_STATES.EDUCATIONAL_SCREEN) {
    return (
      <div className="w-full max-w-md mx-auto p-6 bg-slate-900 text-white rounded-2xl border-4 border-amber-500/80 shadow-2xl font-sans space-y-5">
        <div className="flex items-center gap-3 border-b border-slate-800 pb-4">
          <div className="w-12 h-12 bg-amber-500/20 text-amber-400 rounded-xl flex items-center justify-center border border-amber-500/50 text-xl font-bold">
            🔒
          </div>
          <div>
            <h2 className="text-lg font-black text-white">কাজের প্রমাণ ও পেমেন্ট নিরাপত্তা</h2>
            <p className="text-xs text-amber-400 font-semibold">Payment Guarantee & Proof Protocol</p>
          </div>
        </div>

        {/* EDUCATIONAL EXPLANATION BODY */}
        <div className="space-y-3 text-xs text-slate-300 leading-relaxed bg-slate-950 p-4 rounded-xl border border-slate-800">
          <p className="font-semibold text-slate-100">
            🇧🇩 ঠিকাদার ভাইদের অবগতির জন্য:
          </p>
          <p>
            মাইলস্টোনের টাকা সরাসরি পেতে আপনাকে সাইটে দাঁড়িয়ে লাইভ ক্যামেরা দিয়ে কাজের ছবি তুলতে হবে।
          </p>
          <ul className="space-y-2 text-slate-300 list-disc list-inside pt-1">
            <li><strong className="text-amber-400">জিপিএস অবস্থান (GPS):</strong> আপনি সঠিক নির্মাণ সাইটে আছেন কিনা তা যাচাই করে।</li>
            <li><strong className="text-amber-400">লাইভ ক্যামেরা (Live Camera):</strong> ভুয়া বা পুরনো ছবি আপলোড রোধ করে।</li>
          </ul>
          <div className="pt-2 text-[11px] text-emerald-400 font-mono">
            📡 জিপিএস স্যাটেলাইট কানেকশন ব্যাকগ্রাউন্ডে রেডি হচ্ছে...
            {gpsData.accuracy && <span className="block font-bold text-white mt-1">বর্তমান সিগন্যাল: {gpsData.accuracy}m</span>}
          </div>
        </div>

        {/* ERROR WARNING IF GPS IS BLOCKED */}
        {gpsError && (
          <div className="bg-rose-950/80 border border-rose-600 text-rose-200 text-xs p-3 rounded-lg text-center">
            ⚠️ {gpsError}
          </div>
        )}

        {/* ACTION BUTTONS */}
        <div className="space-y-2 pt-2">
          <button
            type="button"
            onClick={requestHardwareAccess}
            className="w-full py-4 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-xl text-base tracking-wide shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2"
            style={{ minHeight: '60px' }}
          >
            <span>অনুমতি দিন ও ক্যামেরা চালু করুন</span>
            <span className="text-xs">➔</span>
          </button>

          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="w-full py-2.5 bg-slate-800 text-slate-400 font-semibold rounded-lg text-xs hover:bg-slate-700"
            >
              ফিরে যান (Cancel)
            </button>
          )}
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2️⃣ STATE 2: WARMING UP (HARDWARE INITIALIZATION)
  // ─────────────────────────────────────────────────────────────────────────
  if (sandboxState === SANDBOX_STATES.WARMING_UP) {
    return (
      <div className="w-full max-w-md mx-auto p-8 bg-slate-900 text-white rounded-2xl border-4 border-slate-800 shadow-2xl text-center font-sans space-y-4">
        <div className="w-12 h-12 border-4 border-amber-500 border-t-transparent rounded-full animate-spin mx-auto" />
        <h3 className="text-base font-bold text-amber-400">ক্যামেরা ও জিপিএস প্রস্তুত হচ্ছে...</h3>
        <p className="text-xs text-slate-400">Warming up Rear Camera & Satellite GPS lock...</p>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3️⃣ STATE 4: DENIED / HARDWARE FAILURE SCREEN
  // ─────────────────────────────────────────────────────────────────────────
  if (sandboxState === SANDBOX_STATES.DENIED) {
    return (
      <div className="w-full max-w-md mx-auto p-6 bg-slate-900 text-white rounded-2xl border-4 border-rose-600 shadow-2xl font-sans text-center space-y-4">
        <div className="w-14 h-14 bg-rose-950 text-rose-400 rounded-full flex items-center justify-center mx-auto border border-rose-600 text-2xl">
          🚫
        </div>
        <h3 className="text-lg font-bold text-rose-400">অনুমতি প্রত্যাখ্যাত হয়েছে</h3>
        <p className="text-xs text-slate-300 leading-relaxed bg-slate-950 p-3 rounded-lg border border-slate-800">
          {cameraError || gpsError || 'ক্যামেরা বা জিপিএস ব্রাউজার দ্বারা ব্লক করা হয়েছে। মোবাইল সেটিংস থেকে সাইট পারমিশন অপশনে গিয়ে ক্যামেরা ও লোকেশন এলাউ (Allow) করুন।'}
        </p>
        <button
          type="button"
          onClick={requestHardwareAccess}
          className="w-full py-3.5 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-xl text-sm shadow-lg"
        >
          পুনরায় চেষ্টা করুন (Retry)
        </button>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4️⃣ STATE 3: READY (LIVE CAMERA VIEWFINDER & S3 PIPELINE)
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="w-full max-w-md mx-auto space-y-3 font-sans">
      
      {/* ERROR MESSAGE TOAST */}
      {errorMessage && (
        <div className="bg-rose-950 border-2 border-rose-500 text-rose-100 p-3.5 rounded-xl text-xs flex items-center justify-between shadow-xl">
          <span>⚠️ {errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-rose-400 font-bold ml-2 text-sm"
          >
            ✕
          </button>
        </div>
      )}

      {/* PIPELINE PROGRESS STATUS */}
      {isProcessing && (
        <div className="bg-amber-950/90 border border-amber-500 text-amber-200 p-3 rounded-xl text-xs font-semibold text-center animate-pulse shadow-lg">
          {pipelineStep}
        </div>
      )}

      {/* VIEWFINDER COMPONENT */}
      <CameraViewfinder
        cameraStream={cameraStream}
        gpsData={gpsData}
        gpsError={gpsError}
        isGpsLocked={isGpsLocked}
        accuracyThreshold={accuracyThreshold}
        onCapture={handleCaptureAndSubmit}
        isProcessing={isProcessing}
      />
    </div>
  );
}
