// components/evidence/useHardwareSandbox.js
/**
 * 🛡️ Phase 21 — Educational Permission & Hardware Warmup Hook
 * 
 * Designed for low-end Android WebViews (Walton, Symphony, Xiaomi, Realme)
 * operating under poor network and satellite visibility conditions in Bangladesh.
 * 
 * State Machine Flow:
 *   EDUCATIONAL_SCREEN ──(User Taps Grant)──> WARMING_UP ──(GPS & Cam Lock)──> READY
 *           │                                     │
 *           └──────────────(Permission Denied)────┴──────────> DENIED
 * 
 * Features:
 *   - Background GPS Satellite Warmup: Quietly initiates `watchPosition` with
 *     `enableHighAccuracy: true` during the EDUCATIONAL_SCREEN phase. This gives
 *     cold GPS chips 15–30 seconds to lock onto satellites while the user reads
 *     the payment guarantee explanation.
 *   - Environment Camera Request: Requests video stream with `facingMode: { ideal: 'environment' }`.
 *   - State transition management with explicit error handling.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

export const SANDBOX_STATES = Object.freeze({
  EDUCATIONAL_SCREEN: 'EDUCATIONAL_SCREEN',
  WARMING_UP: 'WARMING_UP',
  READY: 'READY',
  DENIED: 'DENIED'
});

export const ACCURACY_THRESHOLD_METERS = 80; // Hard cap for Bangladeshi construction site geofencing

export function useHardwareSandbox() {
  const [sandboxState, setSandboxState] = useState(SANDBOX_STATES.EDUCATIONAL_SCREEN);
  const [gpsData, setGpsData] = useState({ lat: null, lng: null, accuracy: null });
  const [gpsError, setGpsError] = useState(null);
  const [cameraStream, setCameraStream] = useState(null);
  const [cameraError, setCameraError] = useState(null);

  const watchIdRef = useRef(null);

  // ─────────────────────────────────────────────────────────────────────────
  // 📡 BACKGROUND GPS SATELLITE WARMUP
  // Quietly initiates geolocation tracking while user reads educational prompt.
  // Gives cold hardware GPS chips (Walton, Symphony) time to resolve ephemeris data.
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsError('Hardware Error: Geolocation is not supported by this browser/WebView.');
      return;
    }

    // Start background satellite acquisition
    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        setGpsData({
          lat: latitude,
          lng: longitude,
          accuracy: Math.round(accuracy)
        });
        setGpsError(null);
      },
      (err) => {
        let msg = 'Unable to acquire GPS position.';
        if (err.code === err.PERMISSION_DENIED) {
          msg = 'GPS Permission Denied. Please enable location services in device settings.';
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          msg = 'GPS Satellite Signal Unavailable. Please move outside away from tall concrete structures.';
        } else if (err.code === err.TIMEOUT) {
          msg = 'GPS Lock Timeout. Retrying satellite acquisition...';
        }
        setGpsError(msg);
      },
      {
        enableHighAccuracy: true,
        timeout: 25000,
        maximumAge: 0
      }
    );

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // 📷 CAMERA & HARDWARE INITIALIZATION
  // Called when user clicks "Grant Permissions" on the Educational Screen
  // ─────────────────────────────────────────────────────────────────────────
  const requestHardwareAccess = useCallback(async () => {
    setSandboxState(SANDBOX_STATES.WARMING_UP);
    setCameraError(null);

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera API not supported on this browser/WebView version.');
      }

      // Force rear/environment camera with fallbacks for low-end WebViews
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { exact: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          },
          audio: false
        });
      } catch (exactErr) {
        console.warn('Exact rear camera request failed, falling back to ideal environment mode...', exactErr);
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });
      }

      setCameraStream(stream);
      setSandboxState(SANDBOX_STATES.READY);
    } catch (err) {
      console.error('💥 Hardware Access Denied / Failed:', err);
      setCameraError(err.message || 'Camera access was denied or device is in use.');
      setSandboxState(SANDBOX_STATES.DENIED);
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // 🧹 CLEANUP CAMERA STREAM ON UNMOUNT
  // ─────────────────────────────────────────────────────────────────────────
  const stopCameraStream = useCallback(() => {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      setCameraStream(null);
    }
  }, [cameraStream]);

  useEffect(() => {
    return () => {
      stopCameraStream();
    };
  }, [stopCameraStream]);

  const isGpsLocked = gpsData.accuracy !== null && gpsData.accuracy <= ACCURACY_THRESHOLD_METERS;

  return {
    sandboxState,
    gpsData,
    gpsError,
    cameraStream,
    cameraError,
    isGpsLocked,
    requestHardwareAccess,
    stopCameraStream,
    accuracyThreshold: ACCURACY_THRESHOLD_METERS
  };
}
