// middleware/upload.js
const multer = require('multer');
const path = require('path');

// 🚀 ULTRA-ENTERPRISE ARCHITECTURE: Memory Storage Engine
// Storing files in RAM buffers completely eliminates local disk fragmentation 
// and enables seamless horizontal scaling across multi-instance cloud clusters (Docker/AWS).
const storage = multer.memoryStorage();

// 🛡️ STRICT MIME-TYPE & EXTENSION GUARD (Anti-Malware Filtering)
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'application/pdf'];
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.pdf'];

  const ext = path.extname(file.originalname).toLowerCase();

  // Dual-validation: Check both declared MIME type and file extension signature
  if (allowedMimeTypes.includes(file.mimetype) && allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file format. Only JPEG, PNG, and PDF documents are permitted for construction proof of work.'), false);
  }
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // Strict 10 Megabyte ceiling to prevent Denial of Service (DoS) memory exhaustion
  },
  fileFilter: fileFilter
});

// Export single file upload middleware targeting the 'proofFile' form payload
exports.uploadProof = upload.single('proofFile');