/**
 * Student enrollment application — multi-step form with draft saving.
 * Steps 1–3 persist to the student profile tables (independent drafts),
 * step 4 creates/updates the draft enrollment, step 5 collects documents,
 * then review & submit generates the Enrollment Reference Number.
 */
const express = require('express');
const { flash, audit, notify, fmtDateTime } = require('../utils/helpers');
const Q = require('../utils/queries');
const { storeUpload, removeUpload, upload } = require('../middleware/upload');
const { requireAuth, requireVerifiedEmail } = require('../middleware/auth');
const { db } = require('../app');

const router = express.Router();

const STEPS = [
  { n: 1, label: 'Personal Info' },
  { n: 2, label: 'Parent / Guardian' },
  { n: 3, label: 'Educational Background' },
  { n: 4, label: 'Grade Level & Strand' },
  { n: 5, label: 'Requirements' },
];

function requireApplicant(req, res, next) {
  if (req.session.user && req.session.user.role === 'applicant') return next();
  // This router is mounted at "/", so let other routers' paths fall through.
  if (req.path.startsWith('/admin') || req.path.startsWith('/files')) return next();
  if (!req.session.user) return res.redirect('/?login=required');
  return res.redirect('/');
}

function gradeLevels() {
  return db.prepare('SELECT * FROM grade_levels ORDER BY order_no').all();
}
function strands() {
  return db.prepare('SELECT * FROM strands ORDER BY name').all();
}

/** Active application for the current SY (any status except enrolled/rejected). */
function activeApplication(studentId) {
  const sy = Q.currentSchoolYear(db);
  if (!sy) return null;
  return db.prepare(
    `SELECT * FROM enrollments
     WHERE student_id = ? AND school_year_id = ? AND type = 'application'
       AND status NOT IN ('enrolled')
     ORDER BY id DESC LIMIT 1`
  ).get(studentId, sy.id);
}

// Guard only enrollment paths so unknown URLs fall through to the 404 handler.
router.use('/enroll', requireAuth, requireApplicant, requireVerifiedEmail);

/* ---------------------------------------------------------------- entry point */
router.get('/enroll', (req, res, next) => {
  try {
    const student = Q.getStudentByUser(db, req.session.userId);
    if (!student) { flash(req, 'danger', 'Student profile not found.'); return res.redirect('/dashboard'); }
    if (student.enrollment_type === 'returning') return res.redirect('/early');

    const period = Q.activePeriod(db, 'new');
    const app = activeApplication(student.id);

    if (app && ['submitted', 'under_review', 'approved', 'enrolled'].includes(app.status)) {
      flash(req, 'info', 'Your application is already in progress — see its status on your dashboard.');
      return res.redirect('/dashboard');
    }
    if (app && app.status === 'rejected') {
      flash(req, 'warning', 'A previous application was rejected. Please contact the registrar office.');
      return res.redirect('/dashboard');
    }
    if (!period && (!app || app.status !== 'returned')) {
      return res.render('enroll/period-closed', {
        title: 'Enrollment Closed', student,
        period: db.prepare('SELECT * FROM enrollment_periods WHERE type = ? ORDER BY id DESC LIMIT 1').get('new'),
        STEPS,
      });
    }

    let step = parseInt(req.query.step || '1', 10);
    if (isNaN(step) || step < 1) step = 1;
    if (step > 6) step = 6;
    renderStep(res, student, app, step, { error: null });
  } catch (e) { next(e); }
});

function renderStep(res, student, app, step, opts = {}) {
  const edu = Q.educationOf(db, student.id);
  const guardians = Q.guardiansOf(db, student.id);
  const docs = Q.documentsOf(db, student.id);
  const reqs = Q.requirementsFor(db, student.enrollment_type,
    app ? (gradeLevels().find((g) => g.id === app.grade_level_id) || {}).code : null);
  res.render('enroll/form', {
    title: 'Online Enrollment Application',
    STEPS, step, student, app, edu, guardians, docs, requirements: reqs,
    grades: gradeLevels(), strands: strands(),
    feesJson: JSON.stringify(db.prepare('SELECT * FROM fees WHERE is_active = 1').all()),
    assessment: app ? Q.assessmentTotal(db, app.grade_level_id, app.strand_id, app.school_year_id) : null,
    returnedRemarks: app && app.status === 'returned' ? app.remarks : null,
    error: opts.error || null,
    savedAt: opts.savedAt || null,
  });
}

/* ------------------------------------------------------------ step 1: personal */
router.post('/enroll/step/1', (req, res, next) => {
  try {
    const b = req.body;
    const errors = [];
    if (!b.first_name || !b.first_name.trim()) errors.push('First name is required.');
    if (!b.last_name || !b.last_name.trim()) errors.push('Last name is required.');
    if (!b.birthdate) errors.push('Birthdate is required.');
    if (!['male', 'female'].includes(b.gender)) errors.push('Gender is required.');
    if (b.lrn && !/^\d{12}$/.test(b.lrn.trim())) errors.push('LRN must be exactly 12 digits (or leave blank).');
    if (!['new', 'transferee'].includes(b.enrollment_type)) errors.push('Enrollment type is required.');

    const student = Q.getStudentByUser(db, req.session.userId);
    if (b.lrn && b.lrn.trim()) {
      const clash = db.prepare('SELECT id FROM students WHERE lrn = ? AND id != ?')
        .get(b.lrn.trim(), student.id);
      if (clash) errors.push('That LRN is already registered to another student.');
    }
    if (errors.length) {
      const app = activeApplication(student.id);
      return renderStep(res, student, app, 1, { error: errors.join(' ') });
    }

    db.prepare(
      `UPDATE students SET first_name=?, middle_name=?, last_name=?, suffix=?, birthdate=?, gender=?,
         civil_status=?, nationality=?, religion=?, contact_number=?, home_address=?,
         psa_birth_cert_no=?, lrn=CASE WHEN lrn='' OR lrn IS NULL THEN ? ELSE lrn END,
         enrollment_type=?, updated_at=datetime('now','localtime')
       WHERE id=?`
    ).run(
      b.first_name.trim(), (b.middle_name || '').trim(), b.last_name.trim(), (b.suffix || '').trim(),
      b.birthdate, b.gender, b.civil_status || null, b.nationality || 'Filipino',
      b.religion || null, (b.contact_number || '').trim(), (b.home_address || '').trim(),
      (b.psa_birth_cert_no || '').trim(), (b.lrn || '').trim() || null,
      b.enrollment_type, student.id
    );
    flash(req, 'success', 'Step 1 saved — draft updated.');
    res.redirect('/enroll?step=2');
  } catch (e) { next(e); }
});

/* --------------------------------------------------- step 2: parent / guardian */
router.post('/enroll/step/2', (req, res, next) => {
  try {
    const b = req.body;
    const student = Q.getStudentByUser(db, req.session.userId);
    const errors = [];
    if (!b.mother_first || !b.mother_last) errors.push("Mother's name is required.");
    if (!b.father_first || !b.father_last) errors.push("Father's name is required.");
    if (b.has_guardian === 'yes' && (!b.guardian_first || !b.guardian_last)) {
      errors.push('Guardian name is required when "I have a guardian" is checked.');
    }
    if (errors.length) {
      const app = activeApplication(student.id);
      return renderStep(res, student, app, 2, { error: errors.join(' ') });
    }

    const tx = db.transaction(() => {
      const upsert = (rel, prefix) => {
        const existing = db.prepare('SELECT id FROM guardians WHERE student_id = ? AND relationship = ?')
          .get(student.id, rel);
        const data = [
          (b[`${prefix}_first`] || '').trim(), (b[`${prefix}_middle`] || '').trim(),
          (b[`${prefix}_last`] || '').trim(), (b[`${prefix}_occupation`] || '').trim(),
          (b[`${prefix}_contact`] || '').trim(), (b[`${prefix}_email`] || '').trim(),
          (b[`${prefix}_address`] || '').trim(),
        ];
        if (existing) {
          db.prepare(
            `UPDATE guardians SET first_name=?, middle_name=?, last_name=?, occupation=?,
               contact_number=?, email=?, address=? WHERE id=?`
          ).run(...data, existing.id);
        } else {
          db.prepare(
            `INSERT INTO guardians (student_id, relationship, first_name, middle_name, last_name,
               occupation, contact_number, email, address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(student.id, rel, ...data);
        }
      };
      upsert('mother', 'mother');
      upsert('father', 'father');
      if (b.has_guardian === 'yes') upsert('guardian', 'guardian');
      else db.prepare('DELETE FROM guardians WHERE student_id = ? AND relationship = ?').run(student.id, 'guardian');
    });
    tx();
    flash(req, 'success', 'Step 2 saved — draft updated.');
    res.redirect('/enroll?step=3');
  } catch (e) { next(e); }
});

/* ----------------------------------------------- step 3: educational background */
router.post('/enroll/step/3', (req, res, next) => {
  try {
    const b = req.body;
    const student = Q.getStudentByUser(db, req.session.userId);
    const errors = [];
    if (!b.last_school_name || !b.last_school_name.trim()) errors.push('School completed is required.');
    if (!b.school_year_graded || !b.school_year_graded.trim()) errors.push('School year graduated/completed is required.');
    if (!b.grade_completed) errors.push('Grade level completed is required.');
    if (student.enrollment_type === 'transferee' && !b.reason_for_transfer) {
      errors.push('Reason for transferring is required for transferees.');
    }
    if (errors.length) {
      const app = activeApplication(student.id);
      return renderStep(res, student, app, 3, { error: errors.join(' ') });
    }

    const existing = Q.educationOf(db, student.id);
    const data = [
      b.last_school_name.trim(), (b.last_school_address || '').trim(),
      b.school_year_graded.trim(), (b.general_average || '').trim(),
      b.grade_completed, (b.reason_for_transfer || '').trim(),
    ];
    if (existing) {
      db.prepare(
        `UPDATE education_background SET last_school_name=?, last_school_address=?, school_year_graded=?,
           general_average=?, grade_completed=?, reason_for_transfer=? WHERE student_id=?`
      ).run(...data, student.id);
    } else {
      db.prepare(
        `INSERT INTO education_background (student_id, last_school_name, last_school_address,
           school_year_graded, general_average, grade_completed, reason_for_transfer)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(student.id, ...data);
    }
    flash(req, 'success', 'Step 3 saved — draft updated.');
    res.redirect('/enroll?step=4');
  } catch (e) { next(e); }
});

/* ------------------------------------------- step 4: grade level & strand */
router.post('/enroll/step/4', (req, res, next) => {
  try {
    const b = req.body;
    const student = Q.getStudentByUser(db, req.session.userId);
    const sy = Q.currentSchoolYear(db);
    const grade = db.prepare('SELECT * FROM grade_levels WHERE id = ?').get(b.grade_level_id);
    const errors = [];
    if (!grade) errors.push('Please select a grade level.');
    let strandId = null;
    if (grade && grade.department === 'shs') {
      const strand = db.prepare('SELECT * FROM strands WHERE id = ?').get(b.strand_id);
      if (!strand) errors.push('Please select a track/strand for Senior High School.');
      else strandId = strand.id;
    }
    if (errors.length) {
      const app = activeApplication(student.id);
      return renderStep(res, student, app, 4, { error: errors.join(' ') });
    }

    const app = activeApplication(student.id);
    if (app) {
      db.prepare(
        `UPDATE enrollments SET grade_level_id=?, strand_id=?, updated_at=datetime('now','localtime')
         WHERE id=?`
      ).run(grade.id, strandId, app.id);
    } else {
      db.prepare(
        `INSERT INTO enrollments (student_id, school_year_id, grade_level_id, strand_id, type, status)
         VALUES (?, ?, ?, ?, 'application', 'draft')`
      ).run(student.id, sy.id, grade.id, strandId);
    }
    flash(req, 'success', 'Step 4 saved — draft updated.');
    res.redirect('/enroll?step=5');
  } catch (e) { next(e); }
});

/* ------------------------------------------ step 5: requirements upload */
router.post('/enroll/step/5', upload.any(), (req, res, next) => {
  try {
    const student = Q.getStudentByUser(db, req.session.userId);
    const app = activeApplication(student.id);
    const uploaded = [];
    const failures = [];

    const files = (req.files || []).filter((f) => f && f.originalname);
    if (!files.length) {
      flash(req, 'warning', 'No file selected.');
      return res.redirect('/enroll?step=5');
    }
    for (const file of files) {
      // fieldname format: doc_<doc_type>
      const docType = String(file.fieldname || '').replace(/^doc_/, '');
      if (!docType) continue;
      try {
        const stored = storeUpload(file.path, file.originalname);
        const prev = db.prepare('SELECT stored_name FROM documents WHERE student_id = ? AND doc_type = ?')
          .get(student.id, docType);
        db.prepare(
          `INSERT INTO documents (student_id, doc_type, original_name, stored_name, mime, size, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')
           ON CONFLICT(student_id, doc_type) DO UPDATE SET
             original_name=excluded.original_name, stored_name=excluded.stored_name,
             mime=excluded.mime, size=excluded.size, status='pending', remarks=NULL,
             uploaded_at=datetime('now','localtime')`
        ).run(student.id, docType, stored.originalName, stored.storedName, stored.mime, stored.size);
        if (prev && prev.stored_name) removeUpload(prev.stored_name); // replace old file
        uploaded.push(docType);
      } catch (err) {
        failures.push(`${docType}: ${err.message}`);
      }
    }
    if (failures.length) flash(req, 'danger', failures.join(' '));
    if (uploaded.length) flash(req, 'success', `Uploaded: ${uploaded.join(', ')}.`);
    res.redirect('/enroll?step=5');
  } catch (e) { next(e); }
});

router.post('/enroll/doc/delete', (req, res, next) => {
  try {
    const student = Q.getStudentByUser(db, req.session.userId);
    const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND student_id = ?')
      .get(req.body.doc_id, student.id);
    if (doc) {
      removeUpload(doc.stored_name);
      db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
      flash(req, 'success', 'Document removed.');
    }
    res.redirect('/enroll?step=5');
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------- submit */
router.get('/enroll/review', (req, res, next) => {
  try {
    const student = Q.getStudentByUser(db, req.session.userId);
    const app = activeApplication(student.id);
    if (!app) { flash(req, 'warning', 'Please complete step 4 (grade level) first.'); return res.redirect('/enroll?step=1'); }
    renderStep(res, student, app, 6, {});
  } catch (e) { next(e); }
});

router.post('/enroll/submit', (req, res, next) => {
  try {
    const student = Q.getStudentByUser(db, req.session.userId);
    const app = activeApplication(student.id);
    if (!app) { flash(req, 'danger', 'Please complete steps 1–4 first.'); return res.redirect('/enroll?step=1'); }
    if (app.status === 'submitted' || app.status === 'under_review' || app.status === 'approved' || app.status === 'enrolled') {
      flash(req, 'info', 'Your application has already been submitted.');
      return res.redirect('/dashboard');
    }

    // Validation: profile completeness + required documents
    const missing = [];
    if (!student.first_name || !student.last_name || !student.birthdate || !student.gender) missing.push('personal information (step 1)');
    const g = Q.guardiansOf(db, student.id);
    if (!g.some((x) => x.relationship === 'mother') || !g.some((x) => x.relationship === 'father')) missing.push('parent/guardian details (step 2)');
    if (!Q.educationOf(db, student.id)) missing.push('educational background (step 3)');

    const gradeCode = (db.prepare('SELECT code FROM grade_levels WHERE id = ?').get(app.grade_level_id) || {}).code;
    const reqs = Q.requirementsFor(db, student.enrollment_type, gradeCode).filter((r) => r.is_required);
    const docs = Q.documentsOf(db, student.id);
    const uploadedTypes = new Set(docs.map((d) => d.doc_type));
    const missingDocs = reqs.filter((r) => !uploadedTypes.has(r.doc_type)).map((r) => r.label);
    if (missingDocs.length) missing.push(`required documents: ${missingDocs.join('; ')}`);

    if (missing.length) {
      flash(req, 'danger', 'Cannot submit yet — missing: ' + missing.join(' | '));
      return res.redirect('/enroll?step=' + (missingDocs.length ? 5 : 1));
    }

    const referenceNo = Q.generateReference(db);
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE enrollments SET status='submitted', reference_no=?, submitted_at=datetime('now','localtime'),
           remarks=NULL, updated_at=datetime('now','localtime') WHERE id=?`
      ).run(referenceNo, app.id);
      db.prepare(
        `INSERT INTO enrollment_history (enrollment_id, status, remarks, changed_by)
         VALUES (?, 'submitted', 'Application submitted online', ?)`
      ).run(app.id, req.session.userId);
    });
    tx();

    // Notify registrars + the applicant
    const registrars = db.prepare(`SELECT id FROM users WHERE role IN ('super_admin','registrar') AND status='active'`).all();
    for (const r of registrars) {
      notify(db, r.id, 'New enrollment application',
        `${Q.fullName(student)} — ${referenceNo} (${student.enrollment_type})`, '/admin/applicants');
    }
    notify(db, req.session.userId, 'Application submitted',
      `Your application ${referenceNo} was submitted and is now under review.`, '/dashboard');
    audit(db, req, 'enrollment_submit', 'enrollment', app.id, `ref=${referenceNo}`);

    flash(req, 'success', 'Your application has been submitted successfully!');
    res.redirect('/enroll/success?ref=' + encodeURIComponent(referenceNo));
  } catch (e) { next(e); }
});

router.get('/enroll/success', (req, res) => {
  res.render('enroll/success', {
    title: 'Application Submitted',
    ref: req.query.ref || '',
    STEPS,
  });
});

module.exports = router;
