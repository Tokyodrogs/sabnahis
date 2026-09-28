/**
 * Secure file uploads (multer).
 * - Files go to a temp dir, then are re-validated by magic bytes (never trust
 *   the client's content-type), size-checked, renamed to random names and
 *   moved into uploads/docs. Documents are only served through an
 *   authenticated route that checks ownership / staff permission.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');

const TMP_DIR = path.join(config.uploadsDir, 'tmp');
const DOC_DIR = path.join(config.uploadsDir, 'docs');
for (const d of [config.uploadsDir, TMP_DIR, DOC_DIR]) fs.mkdirSync(d, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadBytes, files: 8 },
  fileFilter: (req, file, cb) => {
    // Light pre-filter by extension; real check happens in sniffAndValidate.
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!['.pdf', '.jpg', '.jpeg', '.png'].includes(ext)) {
      return cb(new Error('Only PDF, JPG, or PNG files are allowed.'));
    }
    cb(null, true);
  },
});

/** Detect real type from file header bytes. Returns mime or null. */
function sniff(buffer) {
  if (!buffer || buffer.length < 8) return null;
  if (buffer.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  return null;
}

/**
 * Validate an uploaded temp file. On success returns final stored info;
 * on failure deletes the temp file and throws.
 */
function validateUpload(tmpPath) {
  const stat = fs.statSync(tmpPath);
  if (stat.size > config.maxUploadBytes) {
    fs.unlinkSync(tmpPath);
    throw new Error('File exceeds the 5 MB size limit.');
  }
  const fd = fs.openSync(tmpPath, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  const mime = sniff(head);
  if (!mime || !config.allowedUploads[mime]) {
    fs.unlinkSync(tmpPath);
    throw new Error('Unsupported file type. Allowed: PDF, JPG, PNG.');
  }
  return { mime, size: stat.size };
}

/** Move a validated temp file into uploads/docs with a random name. */
function storeUpload(tmpPath, originalName) {
  const extMap = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };
  const { mime, size } = validateUpload(tmpPath);
  const stored = crypto.randomBytes(16).toString('hex') + (extMap[mime] || '');
  fs.renameSync(tmpPath, path.join(DOC_DIR, stored));
  return { storedName: stored, mime, size, originalName };
}

function docPath(storedName) {
  // Prevent path traversal: name must be a plain basename.
  const base = path.basename(storedName);
  return path.join(DOC_DIR, base);
}

function removeUpload(storedName) {
  if (!storedName) return;
  try { fs.unlinkSync(docPath(storedName)); } catch (_) {}
}

/** Middleware factory: accepts a single file under `fieldName`. */
function uploadSingle(fieldName) {
  return upload.single(fieldName);
}
function uploadFields(fields) {
  return upload.fields(fields.map((name) => ({ name, maxCount: 1 })));
}

module.exports = { upload, uploadSingle, uploadFields, validateUpload, storeUpload, docPath, removeUpload, DOC_DIR };
