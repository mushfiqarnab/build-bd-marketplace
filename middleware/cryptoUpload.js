const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

class CryptoStorageEngine {
  constructor(options = {}) {
    this.destination = options.destination || './uploads/proofs';

    if (!fs.existsSync(this.destination)) {
      fs.mkdirSync(this.destination, { recursive: true });
    }
  }

  _handleFile(req, file, cb) {
    const hash = crypto.createHash('sha256');
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname || 'proof.bin');
    const filename = `${file.fieldname}-${uniqueSuffix}${ext}`;
    const finalPath = path.join(this.destination, filename);

    const outStream = fs.createWriteStream(finalPath);

    file.stream.on('error', (err) => cb(err));
    outStream.on('error', (err) => cb(err));

    file.stream.on('data', (chunk) => {
      hash.update(chunk);
    });

    file.stream.pipe(outStream);

    outStream.on('finish', () => {
      const cryptographicSeal = hash.digest('hex');
      cb(null, {
        destination: this.destination,
        filename,
        path: finalPath,
        size: outStream.bytesWritten,
        cryptographicSeal,
        mimeType: file.mimetype
      });
    });
  }

  _removeFile(req, file, cb) {
    if (file.path) {
      fs.unlink(file.path, (err) => cb(err));
      return;
    }
    cb(null);
  }
}

const cryptoUpload = multer({
  storage: new CryptoStorageEngine({ destination: './uploads/proofs' }),
  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

module.exports = cryptoUpload;
