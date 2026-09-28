/**
 * Student / parent area: dashboard, notifications, documents,
 * early registration (returning students), payments, printables.
 */
const express = require('express');
const { flash, audit, notify, peso, fmtDate, fmtDateTime } = require('../utils/helpers');
const Q = require('../utils/queries');
const { storeUpload, removeUpload, upload } = require('../middleware/upload');
const { requireAuth } = require('../middleware/auth');
const { db } = require('../app');

const router = express.Router();

function requireApplicant(req, res, next) {
  if (req.session.user && req.session.user.role === 'applicant') return next();
  // This router is mounted at "/", so let other routers' paths fall through.
  if (req.path.startsWith('/admin') || req.path.startsWith('/files')) return next();
  if (!req.session.user) return res.redirect('/?login=required');
  return res.redirect('/admin');
}

// Guard only this router's own paths so unknown URLs fall through to the 404 handler.
const STUDENT_PATHS = ['/dashboard', '/notifications', '/documents', '/early',
  '/payment', '/confirm-schedule', '/print'];
router.use(STUDENT_PATHS, requireAuth, requireApplicant);

function gradeLevels() {
  return db.prepare('SELECT * FROM grade_levels ORDER BY order_no').all();
}

function nextGrade(currentId) {
  if (!currentId) return null;
  return db.prepare('SELECT * FROM grade_levels WHERE order_no > ? ORDER BY order_no LIMIT 1')
    .get((db.prepare('SELECT order_no FROM grade_levels WHERE id = ?').get(currentId) || {}).order_no ?? -1) || null;
}

/* --------------------------------------------------------------- dashboard */
router.get('/dashboard', (req, res, next) => {
  try {
    const student = Q.getStudentByUser(db, req.session.userId);
    if (!student) { flash(req, 'danger', 'Student profile missing.'); return res.redirect('/'); }

    const sy = Q.currentSchoolYear(db);
    const application = Q.currentEnrollment(db, student.id, 'application');
    const early = Q.currentEnrollment(db, student.id, 'early');
    const docs = Q.documentsOf(db, student.id);

    const active = early || application; // prefer showing whichever exists
    let timeline = null;
    let history = [];
    let payment = null;
    if (active) {
      timeline = Q.statusTimeline(db, active);
      history = timeline.history;
      payment = db.prepare('SELECT * FROM payments WHERE enrollment_id = ? ORDER BY id DESC LIMIT 1')
        .get(active.id);
    }

    const notices = db.prepare(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 6'
    ).all(req.session.userId);
    const unreadCount = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(req.session.userId).c;

    const newPeriod = Q.activePeriod(db, 'new');
    const earlyPeriod = Q.activePeriod(db, 'early');
    const grades = gradeLevels();

    // For early registration readiness
    const targetGrade = student.enrollment_type === 'returning'
      ? nextGrade(student.current_grade_level_id)
      : null;

    // Application completion percent (rough)
    let progress = 0;
    if (application) {
      const marks = [
        student.first_name && student.birthdate && student.gender,
        Q.guardiansOf(db, student.id).length >= 2,
        !!Q.educationOf(db, student.id),
        !!application.grade_level_id,
        application.status !== 'draft',
      ];
      progress = Math.round((marks.filter(Boolean).length / marks.length) * 100);
    }

    res.render('student/dashboard', {
      title: 'My Dashboard',
      student, sy, application, early, active, docs, history,
      timeline, payment, notices, unreadCount,
      newPeriod, earlyPeriod, grades, targetGrade, progress,
      reqs: active
        ? Q.requirementsFor(db, student.enrollment_type,
            (grades.find((g) => g.id === active.grade_level_id) || {}).code)
        : [],
      PAY: peso, FMTD: fmtDate, FMTDT: fmtDateTime,
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ notifications */
router.get('/notifications', (req, res, next) => {
  try {
    const notices = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100')
      .all(req.session.userId);
    res.render('student/notifications', { title: 'Notifications', notices, FMTDT: fmtDateTime });
  } catch (e) { next(e); }
});

router.post('/notifications/read', (req, res, next) => {
  try {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.session.userId);
    res.redirect(req.get('Referer') || '/notifications');
  } catch (e) { next(e); }
});

router.post('/notifications/:id/read', (req, res, next) => {
  try {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
      .run(req.params.id, req.session.userId);
    const n = db.prepare('SELECT link FROM notifications WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.session.userId);
    res.redirect((n && n.link) || '/notifications');
  } catch (e) { next(e); }
});

/* --------------------------------------------------------------- documents */
router.get('/documents', (req, res, next) => {
  try {
    const student = Q.getStudentByUser(db, req.session.userId);
    const active = Q.currentEnrollment(db, student.id, 'early')
      || Q.currentEnrollment(db, student.id, 'application');
    const grades = gradeLevels();
    const gradeCode = active ? (grades.find((g) => g.id === active.grade_level_id) || {}).code : null;
    res.render('student/documents', {
      title: 'My Documents',
      student, active,
      requirements: Q.requirementsFor(db, student.enrollment_type, gradeCode),
      docs: Q.documentsOf(db, student.id),
    });
  } catch (e) { next(e); }
});

router.post('/documents/upload', upload.any(), (req, res, next) => {
  try {
    const student = Q.getStudentByUser(db, req.session.userId);
    const files = (req.files || []).filter((f) => f && f.originalname);
    if (!files.length) { flash(req, 'warning', 'No file selected.'); return res.redirect('/documents'); }
    const failures = [];
    for (const file of files) {
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
        if (prev && prev.stored_name) removeUpload(prev.stored_name);
      } catch (err) { failures.push(`${docType}: ${err.message}`); }
    }
    if (failures.length) flash(req, 'danger', failures.join(' '));
    else flash(req, 'success', 'Document(s) uploaded.');
    res.redirect('/documents');
  } catch (e) { next(e); }
});

router.post('/documents/delete', (req, res, next) => {
  try {
    const student = Q.getStudentByUser(db, req.session.userId);
    const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND student_id = ?')
      .get(req.body.doc_id, student.id);
    if (doc) {
      removeUpload(doc.stored_name);
      db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
      flash(req, 'success', 'Document removed.');
    }
    res.redirect('/documents');
  } catch (e) { next(e); }
});

/* ============================================================ EARLY REGISTRATION */
function ensureEarlyDraft(student) {
  const sy = Q.currentSchoolYear(db);
  let early = db.prepare(
    `SELECT * FROM enrollments WHERE student_id = ? AND school_year_id = ? AND type = 'early'`
  ).get(student.id, sy.id);
  const target = nextGrade(student.current_grade_level_id);
  if (!early && target) {
    const info = db.prepare(
      `INSERT INTO enrollments (student_id, school_year_id, grade_level_id, strand_id, type, status)
       VALUES (?, ?, ?, NULL, 'early', 'draft')`
    ).run(student.id, sy.id, target.id);
    early = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(info.lastInsertRowid);
  } else if (early && early.status === 'draft' && target && early.grade_level_id !== target.id) {
    db.prepare('UPDATE enrollments SET grade_level_id = ? WHERE id = ?').run(target.id, early.id);
    early.grade_level_id = target.id;
  }
  return early;
}

router.get('/early', (req, res, next) => {
  try {
    const student = Q.getStudentByUser(db, req.session.userId);
    if (student.enrollment_type !== 'returning') {
      flash(req, 'info', 'Early registration is for returning students. New students and transferees should use the enrollment form.');
      return res.redirect('/enroll');
    }
    const period = Q.activePeriod(db, 'early');
    const submitted = Q.currentEnrollment(db, student.id, 'early');
    if (submitted && ['submitted', 'under_review', 'approved', 'enrolled'].includes(submitted.status)) {
      flash(req, 'info', 'Your early registration is already on file — track it on your dashboard.');
      return res.redirect('/dashboard');
    }
    if (!period && (!submitted || submitted.status !== 'draft' && submitted.status !== 'returned')) {
      return res.render('enroll/period-closed', {
        title: 'Early Registration Closed',
        student, STEPS: [],
        period: db.prepare(`SELECT * FROM enrollment_periods WHERE type='early' ORDER BY id DESC LIMIT 1`).get(),
        mode: 'early',
      });
    }

    const early = ensureEarlyDraft(student);
    if (!early) { flash(req, 'danger', 'No target grade level could be determined.'); return res.redirect('/dashboard'); }

    const grades = gradeLevels();
    const target = grades.find((g) => g.id === early.grade_level_id);
    const isShs = target && target.department === 'shs';
    const sections = Q.sectionsFor(db, early.grade_level_id);
    const assessment = Q.assessmentTotal(db, early.grade_level_id, early.strand_id, early.school_year_id);
    const payment = db.prepare('SELECT * FROM payments WHERE enrollment_id = ? ORDER BY id DESC LIMIT 1').get(early.id);

    res.render('student/early', {
      title: 'Early Registration',
      student, early, target, isShs,
      sy: Q.currentSchoolYear(db),
      grades: gradeLevels(), strands: db.prepare('SELECT * FROM strands ORDER BY name').all(),
      sections, assessment, payment,
      currentGrade: (grades.find((g) => g.id === student.current_grade_level_id) || null),
      returnedRemarks: early.status === 'returned' ? early.remarks : null,
      PAY: peso,
    });
  } catch (e) { next(e); }
});

router.post('/early', upload.any(), (req, res, next) => {
  try {
    const student = Q.getStudentByUser(db, req.session.userId);
    const early = ensureEarlyDraft(student);
    if (!early) { flash(req, 'danger', 'Early registration is not available.'); return res.redirect('/dashboard'); }
    const b = req.body;

    if (b.action === 'preview') {
      // Update strand / section choices and re-render the assessment
      const target = db.prepare('SELECT * FROM grade_levels WHERE id = ?').get(early.grade_level_id);
      let strandId = early.strand_id;
      if (target && target.department === 'shs') {
        const s = db.prepare('SELECT id FROM strands WHERE id = ?').get(b.strand_id || -1);
        if (!s) { flash(req, 'danger', 'Please select a strand first.'); return res.redirect('/early'); }
        strandId = s.id;
      }
      let sectionId = null;
      if (b.section_id) {
        const slot = Q.sectionSlots(db, Number(b.section_id));
        if (slot && slot.remaining > 0 && slot.grade_level_id === early.grade_level_id) sectionId = slot.id;
        else flash(req, 'warning', 'That section is full or unavailable — a section will be assigned to you.');
      }
      db.prepare('UPDATE enrollments SET strand_id = ?, section_id = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?')
        .run(strandId, sectionId, early.id);
      flash(req, 'success', 'Assessment updated.');
      return res.redirect('/early');
    }

    /* ---------------------------------------------------------- final submit */
    const errors = [];
    if (!b.contact_number || b.contact_number.trim().length < 7) errors.push('Valid contact number is required.');
    if (!b.home_address || b.home_address.trim().length < 5) errors.push('Home address is required.');

    const target = db.prepare('SELECT * FROM grade_levels WHERE id = ?').get(early.grade_level_id);
    let strandId = early.strand_id;
    if (target && target.department === 'shs') {
      const s = db.prepare('SELECT id FROM strands WHERE id = ?').get(b.strand_id || -1);
      if (!s) errors.push('Please select a strand.');
      else strandId = s.id;
    }
    if (errors.length) {
      flash(req, 'danger', errors.join(' '));
      return res.redirect('/early');
    }

    // Section: honor student's choice if slots remain, else auto-assign later
    let sectionId = early.section_id;
    if (b.section_id) {
      const slot = Q.sectionSlots(db, Number(b.section_id));
      if (slot && slot.remaining > 0 && slot.grade_level_id === early.grade_level_id) sectionId = slot.id;
    }

    const referenceNo = Q.generateReference(db);
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE students SET contact_number = ?, home_address = ?, updated_at = datetime('now','localtime')
         WHERE id = ?`
      ).run(b.contact_number.trim(), b.home_address.trim(), student.id);
      db.prepare(
        `UPDATE enrollments SET strand_id=?, section_id=?, status='submitted', reference_no=?,
           submitted_at=datetime('now','localtime'), remarks=NULL, updated_at=datetime('now','localtime')
         WHERE id=?`
      ).run(strandId, sectionId, referenceNo, early.id);
      db.prepare(
        `INSERT INTO enrollment_history (enrollment_id, status, remarks, changed_by)
         VALUES (?, 'submitted', 'Early registration confirmed by student', ?)`
      ).run(early.id, req.session.userId);

      // Optional payment proof submitted together with the registration
      if (b.payment_method && (b.payment_reference || (req.files || []).some((f) => f.fieldname === 'payment_slip'))) {
        const assessment = Q.assessmentTotal(db, early.grade_level_id, strandId, early.school_year_id);
        let storedName = null; let origName = null;
        const slip = (req.files || []).find((f) => f.fieldname === 'payment_slip');
        if (slip) {
          const stored = storeUpload(slip.path, slip.originalname);
          storedName = stored.storedName; origName = stored.originalName;
        }
        db.prepare(
          `INSERT INTO payments (enrollment_id, student_id, amount, method, reference_no, slip_stored_name, slip_original_name)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(early.id, student.id, assessment.total, b.payment_method,
          (b.payment_reference || '').trim() || null, storedName, origName);
      }
    });
    tx();

    const registrars = db.prepare(`SELECT id FROM users WHERE role IN ('super_admin','registrar') AND status='active'`).all();
    for (const r of registrars) {
      notify(db, r.id, 'New early registration',
        `${Q.fullName(student)} — ${referenceNo} (returning)`, '/admin/applicants');
    }
    notify(db, req.session.userId, 'Early registration submitted',
      `Reference ${referenceNo}. Please wait for the registrar's approval.`, '/dashboard');
    audit(db, req, 'early_registration_submit', 'enrollment', early.id, `ref=${referenceNo}`);
    flash(req, 'success', 'Early registration submitted! Keep your reference number: ' + referenceNo);
    res.redirect('/dashboard');
  } catch (e) { next(e); }
});

/* ================================================================== PAYMENTS */
/* Payment can be submitted for an application once it is "for assessment",
   or any time during early registration processing. */
router.post('/payment', upload.any(), (req, res, next) => {
  try {
    const student = Q.getStudentByUser(db, req.session.userId);
    const enrollmentId = Number(req.body.enrollment_id);
    const enrollment = db.prepare(
      `SELECT * FROM enrollments WHERE id = ? AND student_id = ?`
    ).get(enrollmentId, student.id);
    if (!enrollment) { flash(req, 'danger', 'Enrollment record not found.'); return res.redirect('/dashboard'); }

    const allowed = enrollment.type === 'early'
      ? ['submitted', 'under_review', 'approved']
      : ['approved'];
    if (!allowed.includes(enrollment.status)) {
      flash(req, 'warning', 'Payment can be uploaded once your application is approved (For Assessment).');
      return res.redirect('/dashboard');
    }

    const method = req.body.payment_method;
    if (!['deposit_slip', 'online_reference'].includes(method)) {
      flash(req, 'danger', 'Please choose a payment method.');
      return res.redirect('/dashboard');
    }

    const assessment = Q.assessmentTotal(db, enrollment.grade_level_id, enrollment.strand_id, enrollment.school_year_id);
    let storedName = null; let origName = null;
    const slip = (req.files || []).find((f) => f.fieldname === 'payment_slip');
    if (method === 'deposit_slip') {
      if (!slip) { flash(req, 'danger', 'Please attach a photo/PDF of your deposit slip.'); return res.redirect('/dashboard'); }
      const stored = storeUpload(slip.path, slip.originalname);
      storedName = stored.storedName; origName = stored.originalName;
    } else if (!req.body.payment_reference) {
      flash(req, 'danger', 'Please enter the online payment reference number.');
      return res.redirect('/dashboard');
    }

    db.prepare(
      `INSERT INTO payments (enrollment_id, student_id, amount, method, reference_no, slip_stored_name, slip_original_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(enrollment.id, student.id, assessment.total, method,
      (req.body.payment_reference || '').trim() || null, storedName, origName);

    const cashiers = db.prepare(`SELECT id FROM users WHERE role IN ('super_admin','cashier') AND status='active'`).all();
    for (const c of cashiers) {
      notify(db, c.id, 'New payment for verification',
        `${Q.fullName(student)} — ${peso(assessment.total)}`, '/admin/payments');
    }
    notify(db, req.session.userId, 'Payment submitted',
      'Your payment proof was submitted and is awaiting verification by the cashier.', '/dashboard');
    audit(db, req, 'payment_submit', 'enrollment', enrollment.id, `amount=${assessment.total} method=${method}`);
    flash(req, 'success', 'Payment submitted for verification.');
    res.redirect('/dashboard');
  } catch (e) { next(e); }
});

/* --------------------------------------------------------- confirm schedule */
router.post('/confirm-schedule', (req, res, next) => {
  try {
    const student = Q.getStudentByUser(db, req.session.userId);
    const enrollment = db.prepare(
      `SELECT * FROM enrollments WHERE id = ? AND student_id = ? AND status = 'enrolled'`
    ).get(req.body.enrollment_id, student.id);
    if (!enrollment) { flash(req, 'danger', 'Enrollment not found.'); return res.redirect('/dashboard'); }
    db.prepare('UPDATE enrollments SET schedule_confirmed = 1, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?')
      .run(enrollment.id);
    audit(db, req, 'schedule_confirmed', 'enrollment', enrollment.id, null);
    flash(req, 'success', 'Schedule confirmed. You may now print your Certificate of Registration.');
    res.redirect('/dashboard');
  } catch (e) { next(e); }
});

/* ================================================================ PRINTABLES */
function loadForPrint(req) {
  const student = Q.getStudentByUser(db, req.session.userId);
  const type = req.query.type === 'early' ? 'early' : 'application';
  const enrollment = Q.currentEnrollment(db, student.id, type)
    || Q.currentEnrollment(db, student.id, 'application')
    || Q.currentEnrollment(db, student.id, 'early');
  if (!enrollment) return null;
  const full = Q.getEnrollment(db, enrollment.id);
  return {
    student,
    full,
    history: Q.enrollmentHistory(db, enrollment.id),
    guardians: Q.guardiansOf(db, student.id),
    edu: Q.educationOf(db, student.id),
    assessment: Q.assessmentTotal(db, full.grade_level_id, full.strand_id, full.school_year_id),
    subjects: Q.subjectsFor(db, full.grade_level_id, full.strand_id),
    payment: db.prepare('SELECT * FROM payments WHERE enrollment_id = ? ORDER BY id DESC LIMIT 1').get(enrollment.id),
    adviser: full.section_id
      ? (db.prepare('SELECT u.full_name FROM sections s LEFT JOIN users u ON u.id = s.adviser_id WHERE s.id = ?')
          .get(full.section_id) || {}).full_name
      : null,
  };
}

router.get('/print/summary', (req, res, next) => {
  try {
    const data = loadForPrint(req);
    if (!data) { flash(req, 'warning', 'No enrollment record to print.'); return res.redirect('/dashboard'); }
    res.render('print/summary', { ...data, title: 'Enrollment Summary' });
  } catch (e) { next(e); }
});

router.get('/print/assessment', (req, res, next) => {
  try {
    const data = loadForPrint(req);
    if (!data) { flash(req, 'warning', 'No assessment to print.'); return res.redirect('/dashboard'); }
    res.render('print/assessment', { ...data, title: 'Assessment of Fees' });
  } catch (e) { next(e); }
});

router.get('/print/cor', (req, res, next) => {
  try {
    const data = loadForPrint(req);
    if (!data) { flash(req, 'warning', 'No enrollment record.'); return res.redirect('/dashboard'); }
    if (data.full.status !== 'enrolled') {
      flash(req, 'warning', 'The Certificate of Registration is available once you are Enrolled.');
      return res.redirect('/dashboard');
    }
    if (!data.full.schedule_confirmed) {
      flash(req, 'warning', 'Please confirm your schedule on the dashboard before printing your COR.');
      return res.redirect('/dashboard');
    }
    res.render('print/cor', { ...data, title: 'Certificate of Registration' });
  } catch (e) { next(e); }
});

module.exports = router;
