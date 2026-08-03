// tests/upload-diagnostic.js
const express = require('express');
const { uploadProof } = require('../middleware/upload');

const app = express();
const PORT = 5001; // Isolated test port

// Temporary test harness route binding our secure upload middleware
app.post('/test-upload', (req, res, next) => {
  uploadProof(req, res, (err) => {
    if (err) {
      return res.status(400).json({ status: 'error', message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'No file received' });
    }
    return res.status(200).json({
      status: 'success',
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      hasBuffer: Buffer.isBuffer(req.file.buffer)
    });
  });
});

const server = app.listen(PORT, async () => {
  console.log('🔬 INITIATING UPLOAD MIDDLEWARE MICROSCOPIC DIAGNOSTICS...\n');
  try {
    // ==========================================
    // TEST 1: VALID JPEG STREAM UPLOAD
    // ==========================================
    const validJpegBlob = new Blob(['fake-image-bytes'], { type: 'image/jpeg' });
    const form1 = new FormData();
    form1.append('proofFile', validJpegBlob, 'foundation.jpg');

    const res1 = await fetch(`http://localhost:${PORT}/test-upload`, {
      method: 'POST',
      body: form1
    });
    const data1 = await res1.json();
    
    if (res1.status === 200 && data1.hasBuffer) {
      console.log('✅ TEST 1 PASSED: Valid JPEG successfully processed into memory buffer.');
    } else {
      throw new Error(`Test 1 Failed: ${JSON.stringify(data1)}`);
    }

    // ==========================================
    // TEST 2: MALICIOUS FILE EXTENSION / MIME INJECTION
    // ==========================================
    const maliciousBlob = new Blob(['malicious-code'], { type: 'application/x-msdownload' });
    const form2 = new FormData();
    form2.append('proofFile', maliciousBlob, 'exploit.exe');

    const res2 = await fetch(`http://localhost:${PORT}/test-upload`, {
      method: 'POST',
      body: form2
    });
    const data2 = await res2.json();
    
    if (res2.status === 400 && data2.message.includes('Invalid file format')) {
      console.log('✅ TEST 2 PASSED: Security guard successfully blocked malicious executable.');
    } else {
      throw new Error(`Test 2 Failed: Malware was permitted! Response: ${JSON.stringify(data2)}`);
    }

    // ==========================================
    // TEST 3: DENIAL-OF-SERVICE (DOS) SIZE LIMIT EXCEPTION
    // ==========================================
    // Generate an 11 MB payload (Exceeding the 10MB ceiling)
    const largeArray = new Uint8Array(11 * 1024 * 1024);
    const largeBlob = new Blob([largeArray], { type: 'application/pdf' });
    const form3 = new FormData();
    form3.append('proofFile', largeBlob, 'huge-blueprint.pdf');

    const res3 = await fetch(`http://localhost:${PORT}/test-upload`, {
      method: 'POST',
      body: form3
    });
    const data3 = await res3.json();
    
    if (res3.status === 400 && data3.message.includes('File too large')) {
      console.log('✅ TEST 3 PASSED: Memory ceiling successfully intercepted oversized denial-of-service payload.');
    } else {
      throw new Error(`Test 3 Failed: Oversized payload allowed! Response: ${JSON.stringify(data3)}`);
    }

    console.log('\n🏆 ALL UPLOAD DIAGNOSTICS PASSED. ZERO DISCREPANCIES DETECTED.');

  } catch (err) {
    console.error('\n💥 UPLOAD DIAGNOSTIC FAILURE:', err.message);
  } finally {
    server.close();
    process.exit(0);
  }
});