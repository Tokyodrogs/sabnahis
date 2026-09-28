/**
 * Authenticated file downloads (school documents, payment slips).
 * Access is checked: the owning student or any staff member may view.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { docPath } = require('../middleware/upload');
const { requireAuth } = require('../middleware/auth');
const { db } = require('../app');

const router = express.Router();
router.use(requireAuth);

function isStaff(req) {
  return req.session.user && req.session.user.role !== 'applicant';
}

/* Student documents: /files/document/:id */
router.get('/document/:id', (req, res, next) => {
  try {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).send('Not found');
    if (!isStaff(req)) {
      const student = db.prepare('SELECT id FROM students WHERE user_id = ?').get(req.session.userId);
      if (!student || student.id !== doc.student_id) return res.status(403).send('Forbidden');
    }
    streamFile(res, doc.stored_name, doc.mime, doc.original_name);
  } catch (e) { next(e); }
});

/* Payment slips: /files/payment/:id */
router.get('/payment/:id', (req, res, next) => {
  try {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).send('Not found');
    if (!isStaff(req)) {
      const student = db.prepare('SELECT id FROM students WHERE user_id = ?').get(req.session.userId);
      if (!student || student.id !== p.student_id) return res.status(403).send('Forbidden');
    }
    streamFile(res, p.slip_stored_name, guessMime(p.slip_stored_name), p.slip_original_name || 'proof');
  } catch (e) { next(e); }
});

function guessMime(name) {
  const ext = path.extname(name || '').toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  return 'image/jpeg';
}

function streamFile(res, storedName, mime, downloadName) {
  if (!storedName) return res.status(404).send('File missing');
  const fp = docPath(storedName);
  if (!fs.existsSync(fp)) return res.status(404).send('File missing on disk');
  res.setHeader('Content-Type', mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${String(downloadName || 'file').replace(/["\\]/g, '_')}"`);
  fs.createReadStream(fp).pipe(res);
}

module.exports = router;
