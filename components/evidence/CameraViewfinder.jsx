// components/evidence/CameraViewfinder.jsx
/**
 * 📷 Live Camera Viewfinder Component — Low-End Android WebView Optimized
 * 
 * Strict Operational Principles:
 *   1. Direct HTML5 Video Stream Rendering.
 *   2. ABSOLUTELY NO GALLERY UPLOAD OPTION (<input type="file"> is excluded by construction).
 *   3. High-Contrast Live GPS Accuracy HUD.
 *   4. Capture Button disabled unless GPS Accuracy <= 80m (Dynamic Geofence Compliance).
 *   5. High-contrast Bengali & English field-ready UX with large touch targets.
 */

import React, { useRef, useEffect } from 'react';

export function CameraViewfinder({
  cameraStream,
  gpsData,
  gpsError,
  isGpsLocked,
  accuracyThreshold = 80,
  onCapture,
  isProcessing = false
}) {
  const videoRef = useRef(null);

  // Bind media stream to video element when stream or ref changes
  useEffect(() => {
    if (videoRef.current && cameraStream) {
      videoRef.current.srcObject = cameraStream;
    }
  }, [cameraStream]);

  const accuracy = gpsData.accuracy;
  const isAccuracyGood = isGpsLocked;

  return (
    <div className="relative w-full max-w-md mx-auto bg-black text-white rounded-2xl overflow-hidden shadow-2xl border-4 border-slate-800 flex flex-col font-sans">
      
      {/* ───────────────────────────────────────────────────────────────────────
          📺 LIVE CAMERA VIEWFINDER FRAME
          ─────────────────────────────────────────────────────────────────────── */}
      <div className="relative w-full aspect-[3/4] bg-slate-950 flex items-center justify-center overflow-hidden">
        {cameraStream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="flex flex-col items-center justify-center p-6 text-center text-slate-400">
            <svg className="w-16 h-16 animate-pulse mb-3 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <p className="text-sm font-semibold">ক্যামেরা ফিড লোড হচ্ছে...</p>
            <p className="text-xs text-slate-500 mt-1">Initializing Rear Camera Feed...</p>
          </div>
        )}

        {/* ── VIEWFINDER TARGET OVERLAY ── */}
        <div className="absolute inset-0 pointer-events-none border-2 border-white/20 m-6 rounded-lg flex items-center justify-center">
          <div className="w-12 h-12 border-t-2 border-l-2 border-amber-400 absolute top-0 left-0" />
          <div className="w-12 h-12 border-t-2 border-r-2 border-amber-400 absolute top-0 right-0" />
          <div className="w-12 h-12 border-b-2 border-l-2 border-amber-400 absolute bottom-0 left-0" />
          <div className="w-12 h-12 border-b-2 border-r-2 border-amber-400 absolute bottom-0 right-0" />
          <div className="w-3 h-3 bg-amber-400/80 rounded-full animate-ping" />
        </div>

        {/* ── HIGH-CONTRAST GPS ACCURACY BADGE HUD (TOP LEFT) ── */}
        <div className="absolute top-4 left-4 right-4 flex items-center justify-between pointer-events-none">
          <div
            className={`px-3 py-1.5 rounded-full text-xs font-bold tracking-wide flex items-center gap-2 shadow-lg backdrop-blur-md transition-all duration-300 ${
              accuracy === null
                ? 'bg-slate-900/90 text-slate-300 border border-slate-700'
                : isAccuracyGood
                ? 'bg-emerald-600/95 text-white border border-emerald-400 animate-pulse'
                : 'bg-rose-700/95 text-white border border-rose-400'
            }`}
          >
            <span className={`w-2.5 h-2.5 rounded-full ${
              accuracy === null ? 'bg-slate-400' : isAccuracyGood ? 'bg-emerald-300' : 'bg-rose-300'
            }`} />
            {accuracy !== null ? (
              <span>
                GPS Accuracy: <strong>{accuracy}m</strong> {isAccuracyGood ? '🎯 (Locked)' : `⚠️ (> ${accuracyThreshold}m)`}
              </span>
            ) : (
              <span>📡 Searching Satellite GPS...</span>
            )}
          </div>

          {/* LIVE BADGE */}
          <div className="px-2.5 py-1 bg-red-600 text-white text-[10px] font-black rounded tracking-widest uppercase shadow">
            LIVE ONLY
          </div>
        </div>

        {/* ── GPS ERROR WARNING BANNER ── */}
        {gpsError && (
          <div className="absolute bottom-4 left-4 right-4 bg-rose-950/90 border border-rose-600 text-rose-200 text-xs p-2.5 rounded-lg backdrop-blur-sm shadow-lg text-center">
            ⚠️ {gpsError}
          </div>
        )}
      </div>

      {/* ───────────────────────────────────────────────────────────────────────
          🎮 CONTROL PANEL (CAPTURE ACTION ONLY - NO GALLERY UPLOAD)
          ─────────────────────────────────────────────────────────────────────── */}
      <div className="p-5 bg-slate-900 border-t border-slate-800 flex flex-col gap-3">
        
        {/* FIELD INSTRUCTION STATUS TEXT */}
        <div className="text-center">
          {!isAccuracyGood ? (
            <p className="text-xs font-bold text-amber-400 bg-amber-950/60 py-1.5 px-3 rounded-md border border-amber-700/50 inline-block">
              🇧🇩 জিপিএস সিগন্যাল শক্তিশালী করতে খোলা জায়গায় যান (লক্ষ্য: ≤{accuracyThreshold}m)
            </p>
          ) : (
            <p className="text-xs font-bold text-emerald-400 bg-emerald-950/60 py-1.5 px-3 rounded-md border border-emerald-700/50 inline-block">
              ✅ অবস্থান নিশ্চিত হয়েছে — কাজের ছবি তুলুন
            </p>
          )}
        </div>

        {/* 🔴 LARGE HIGH-CONTRAST CAPTURE BUTTON */}
        <button
          type="button"
          onClick={() => onCapture(videoRef.current)}
          disabled={!isAccuracyGood || !cameraStream || isProcessing}
          className={`w-full py-4 rounded-xl font-extrabold text-base tracking-wider transition-all duration-200 flex items-center justify-center gap-3 shadow-xl active:scale-95 ${
            isAccuracyGood && cameraStream && !isProcessing
              ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 cursor-pointer ring-4 ring-emerald-500/30'
              : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
          }`}
          style={{ minHeight: '64px' }} // Field-ready large touch target for low-end phones
        >
          {isProcessing ? (
            <>
              <svg className="animate-spin h-5 w-5 text-slate-950" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span>প্রসেসিং ও S3 আপলোড হচ্ছে...</span>
            </>
          ) : (
            <>
              <div className={`w-4 h-4 rounded-full ${isAccuracyGood ? 'bg-slate-950' : 'bg-slate-600'}`} />
              <span>CAPTURE PROOF OF WORK (ছবি তুলুন)</span>
            </>
          )}
        </button>

        {/* EXPLICIT NO-GALLERY SECURITY DECLARATION */}
        <p className="text-[11px] text-slate-400 text-center font-medium">
          🔒 সিকিউরিটি নীতি: গ্যালারি থেকে ফাইল আপলোড নিষ্ক্রিয় করা হয়েছে (Live Stream Only)
        </p>
      </div>

    </div>
  );
}
