/**
 * Admin panel — part 1: dashboard, applicant management, payments,
 * enrollment management (periods, sections, assignments).
 */
const express = require('express');
const {
  flash, audit, notify, sendCsv, peso, fmtDate, fmtDateTime,
  STATUS_LABELS, STATUS_COLORS, fullName,
} = require('../utils/helpers');
const Q = require('../utils/queries');
const { removeUpload } = require('../middleware/upload');
const {
  requireAuth, requirePermission, can,
} = require('../middleware/auth');
const { db } = require('../app');

const router = express.Router();
const setupRouter = require('./admin-setup');

function requireStaff(req, res, next) {
  if (req.session.user && req.session.user.role !== 'applicant') return next();
  if (req.session.user) return res.redirect('/dashboard');
  return res.redirect('/');
}

router.use(requireAuth, requireStaff);

/* ================================================================= DASHBOARD */
router.get('/', (req, res, next) => {
  try {
    const sy = Q.currentSchoolYear(db);
    const grades = db.prepare('SELECT * FROM grade_levels ORDER BY order_no').all();

    const byGrade = grades.map((g) => {
      const row = db.prepare(
        `SELECT COUNT(*) AS c FROM enrollments e
         WHERE e.grade_level_id = ? AND e.school_year_id = ? AND e.status IN ('submitted','under_review','approved','enrolled')`
      ).get(g.id, sy ? sy.id : -1);
      return { name: g.name, count: row.c };
    });

    const byType = db.prepare(
      `SELECT s.enrollment_type AS t, COUNT(*) AS c
       FROM enrollments e JOIN students s ON s.id = e.student_id
       WHERE e.school_year_id = ? AND e.status IN ('submitted','under_review','approved','enrolled')
       GROUP BY s.enrollment_type`
    ).all(sy ? sy.id : -1);
    const typeMap = { new: 0, transferee: 0, returning: 0 };
    for (const r of byType) typeMap[r.t] = r.c;

    const byStatus = db.prepare(
      `SELECT status, COUNT(*) AS c FROM enrollments
       WHERE school_year_id = ? AND status != 'draft' GROUP BY status`
    ).all(sy ? sy.id : -1);

    const pending = (db.prepare(
      `SELECT COUNT(*) c FROM enrollments WHERE school_year_id = ? AND status IN ('submitted','under_review')`
    ).get(sy ? sy.id : -1)).c;
    const totalEnrollees = (db.prepare(
      `SELECT COUNT(*) c FROM enrollments WHERE school_year_id = ? AND status IN ('submitted','under_review','approved','enrolled')`
    ).get(sy ? sy.id : -1)).c;
    const enrolled = (db.prepare(
      `SELECT COUNT(*) c FROM enrollments WHERE school_year_id = ? AND status = 'enrolled'`
    ).get(sy ? sy.id : -1)).c;
    const pendingPayments = (db.prepare(
      `SELECT COUNT(*) c FROM payments WHERE status = 'pending'`
    ).get()).c;
    const verifiedCollections = (db.prepare(
      `SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status = 'verified'`
    ).get()).s;

    const recentActivity = db.prepare(
      `SELECT a.*, u.full_name AS uname FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.id DESC LIMIT 10`
    ).all();

    const recentApps = db.prepare(
      `SELECT e.id, e.reference_no, e.status, e.submitted_at, e.type,
              s.first_name, s.last_name, s.enrollment_type, gl.name AS grade_name
       FROM enrollments e
       JOIN students s ON s.id = e.student_id
       JOIN grade_levels gl ON gl.id = e.grade_level_id
       WHERE e.school_year_id = ? AND e.status != 'draft'
       ORDER BY e.id DESC LIMIT 8`
    ).all(sy ? sy.id : -1);

    res.render('admin/dashboard', {
      title: 'Admin Dashboard',
      sy, grades, byGrade, typeMap, byStatus, pending, totalEnrollees, enrolled,
      pendingPayments, verifiedCollections, recentActivity, recentApps,
      PAY: peso, FMTDT: fmtDateTime, FMTD: fmtDate,
      STATUS_LABELS, STATUS_COLORS,
      extraScripts: ['/vendor/chart.umd.min.js'],
      chartData: JSON.stringify({ byGrade, typeMap, byStatus }),
    });
  } catch (e) { next(e); }
});

/* =============================================================== APPLICANTS */
router.get('/applicants', requirePermission('applicants'), (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const gradeId = req.query.grade || '';
    const strandId = req.query.strand || '';
    const status = req.query.status || '';
    const type = req.query.type || '';
    const sy = Q.currentSchoolYear(db);

    let sql = `
      SELECT e.*, s.first_name, s.middle_name, s.last_name, s.lrn, s.enrollment_type,
             s.contact_number, s.gender, s.birthdate,
             gl.name AS grade_name, st.code AS strand_code, sec.name AS section_name
      FROM enrollments e
      JOIN students s ON s.id = e.student_id
      JOIN grade_levels gl ON gl.id = e.grade_level_id
      LEFT JOIN strands st ON st.id = e.strand_id
      LEFT JOIN sections sec ON sec.id = e.section_id
      WHERE e.school_year_id = ? AND e.status != 'draft'`;
    const params = [sy ? sy.id : -1];
    if (q) {
      sql += ' AND (s.first_name LIKE ? OR s.last_name LIKE ? OR s.lrn LIKE ? OR e.reference_no LIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (gradeId) { sql += ' AND e.grade_level_id = ?'; params.push(gradeId); }
    if (strandId) { sql += ' AND e.strand_id = ?'; params.push(strandId); }
    if (status) { sql += ' AND e.status = ?'; params.push(status); }
    if (type) { sql += ' AND s.enrollment_type = ?'; params.push(type); }
    sql += ' ORDER BY e.id DESC';

    const rows = db.prepare(sql).all(...params);

    if (req.query.format === 'csv') {
      return sendCsv(res, 'applicants.csv',
        ['Reference No', 'LRN', 'Name', 'Type', 'Grade', 'Strand', 'Section', 'Status', 'Submitted'],
        rows.map((r) => [
          r.reference_no, r.lrn || '', fullName(r), r.enrollment_type,
          r.grade_name, r.strand_code || '', r.section_name || '',
          STATUS_LABELS[r.status] || r.status, r.submitted_at || '',
        ]));
    }

    res.render('admin/applicants', {
      title: 'Applicant Management',
      rows, q, gradeId, strandId, status, type,
      grades: db.prepare('SELECT * FROM grade_levels ORDER BY order_no').all(),
      strands: db.prepare('SELECT * FROM strands ORDER BY name').all(),
      STATUS_LABELS, STATUS_COLORS,
      can: (p) => can(req.session.user.role, p),
      counts: {
        submitted: countStatus(sy, 'submitted'),
        under_review: countStatus(sy, 'under_review'),
        returned: countStatus(sy, 'returned'),
        approved: countStatus(sy, 'approved'),
        enrolled: countStatus(sy, 'enrolled'),
        rejected: countStatus(sy, 'rejected'),
      },
    });
  } catch (e) { next(e); }
});

function countStatus(sy, status) {
  return db.prepare(
    `SELECT COUNT(*) c FROM enrollments WHERE school_year_id = ? AND status = ? AND status != 'draft'`
  ).get(sy ? sy.id : -1, status).c;
}

router.get('/applicants/:id', requirePermission('applicants'), (req, res, next) => {
  try {
    const app = Q.getEnrollment(db, req.params.id);
    if (!app) { flash(req, 'danger', 'Application not found.'); return res.redirect('/admin/applicants'); }
    const student = Q.getStudent(db, app.student_id);
    const grades = db.prepare('SELECT * FROM grade_levels ORDER BY order_no').all();
    const sections = Q.sectionsFor(db, app.grade_level_id);
    res.render('admin/applicant-view', {
      title: `Application ${app.reference_no}`,
      app, student,
      guardians: Q.guardiansOf(db, app.student_id),
      edu: Q.educationOf(db, app.student_id),
      docs: Q.documentsOf(db, app.student_id),
      history: Q.enrollmentHistory(db, app.id),
      payment: db.prepare('SELECT * FROM payments WHERE enrollment_id = ? ORDER BY id DESC LIMIT 1').get(app.id),
      requirements: Q.requirementsFor(db, student.enrollment_type, app.grade_code),
      sections, grades,
      assessment: Q.assessmentTotal(db, app.grade_level_id, app.strand_id, app.school_year_id),
      STATUS_LABELS, STATUS_COLORS,
      PAY: peso, FMTDT: fmtDateTime, FMTD: fmtDate,
    });
  } catch (e) { next(e); }
});

/** Choose a section with free slots for a grade (+ strand for SHS). */
function autoSection(gradeLevelId, strandId, excludeSectionId) {
  const sections = Q.sectionsFor(db, gradeLevelId)
    .filter((s) => s.id !== excludeSectionId)
    .filter((s) => !strandId || !s.strand_id || s.strand_id === strandId);
  const withSlots = sections.filter((s) => s.remaining > 0);
  const pool = withSlots.length ? withSlots : sections.filter((s) => !s.strand_id);
  pool.sort((a, b) => b.remaining - a.remaining);
  return pool[0] || null;
}

/** If an approved enrollment already has a verified payment → enroll it. */
function reconcile(enrollmentId, actorId) {
  const e = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(enrollmentId);
  if (!e || e.status !== 'approved') return false;
  const p = db.prepare(
    `SELECT * FROM payments WHERE enrollment_id = ? AND status = 'verified' ORDER BY id DESC LIMIT 1`
  ).get(enrollmentId);
  if (!p) return false;
  db.prepare(
    `UPDATE enrollments SET status='enrolled', enrolled_at=datetime('now','localtime'),
       updated_at=datetime('now','localtime') WHERE id=?`
  ).run(enrollmentId);
  db.prepare(
    `INSERT INTO enrollment_history (enrollment_id, status, remarks, changed_by)
     VALUES (?, 'enrolled', 'Payment verified — enrollment completed', ?)`
  ).run(enrollmentId, actorId || null);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(e.student_id);
  if (student && student.user_id) {
    const sy = db.prepare('SELECT name FROM school_years WHERE id = ?').get(e.school_year_id);
    notify(db, student.user_id, 'You are now enrolled 🎉',
      `Congratulations! You are officially enrolled for SY ${sy ? sy.name : ''}. Check your dashboard to confirm your schedule and print your COR.`,
      '/dashboard');
  }
  return true;
}

router.post('/applicants/:id/status', requirePermission('applicants'), (req, res, next) => {
  try {
    const app = Q.getEnrollment(db, req.params.id);
    if (!app) { flash(req, 'danger', 'Application not found.'); return res.redirect('/admin/applicants'); }
    const { action, remarks, section_id } = req.body;
    const actor = req.session.userId;
    const student = Q.getStudent(db, app.student_id);

    // Guard: only legal transitions from the current status are allowed
    const ALLOWED = {
      review: ['submitted', 'returned'],
      approve: ['submitted', 'under_review', 'returned'],
      return: ['submitted', 'under_review'],
      reject: ['submitted', 'under_review', 'returned'],
    };
    if (ALLOWED[action] && !ALLOWED[action].includes(app.status)) {
      flash(req, 'warning', `Cannot "${action}" an application that is already ${STATUS_LABELS[app.status] || app.status}.`);
      return res.redirect(req.body.return_to === 'list' ? '/admin/applicants' : `/admin/applicants/${app.id}`);
    }

    if (action === 'review') {
      Q.setStatus(db, app.id, 'under_review', actor, remarks || 'Application under review');
      notify(db, student.user_id, 'Application under review',
        `Your application ${app.reference_no} is now being reviewed by the registrar.`, '/dashboard');
      flash(req, 'success', 'Application marked as Under Review.');
    } else if (action === 'return') {
      if (!remarks || !remarks.trim()) {
        flash(req, 'danger', 'Please provide remarks when returning an application for correction.');
        return res.redirect(`/admin/applicants/${app.id}`);
      }
      Q.setStatus(db, app.id, 'returned', actor, remarks.trim());
      notify(db, student.user_id, 'Application returned for correction',
        remarks.trim(), '/enroll?step=1');
      flash(req, 'success', 'Application returned to the student for correction.');
    } else if (action === 'reject') {
      if (!remarks || !remarks.trim()) {
        flash(req, 'danger', 'Please provide remarks when rejecting an application.');
        return res.redirect(`/admin/applicants/${app.id}`);
      }
      Q.setStatus(db, app.id, 'rejected', actor, remarks.trim());
      notify(db, student.user_id, 'Application rejected', remarks.trim(), '/dashboard');
      flash(req, 'success', 'Application rejected.');
    } else if (action === 'approve') {
      let sectionId = section_id ? Number(section_id) : (app.section_id || null);
      if (sectionId) {
        const slot = Q.sectionSlots(db, sectionId);
        if (!slot || slot.grade_level_id !== app.grade_level_id) sectionId = null;
        else if (slot.remaining <= 0 && app.section_id !== sectionId) {
          flash(req, 'danger', `Section "${slot.name}" is already full (capacity ${slot.capacity}). Choose another section.`);
          return res.redirect(`/admin/applicants/${app.id}`);
        }
      }
      if (!sectionId) {
        const auto = autoSection(app.grade_level_id, app.strand_id, null);
        if (!auto) {
          flash(req, 'danger', 'No section with available slots exists for this grade level. Create one under Academic Setup.');
          return res.redirect(`/admin/applicants/${app.id}`);
        }
        sectionId = auto.id;
      }
      db.prepare('UPDATE enrollments SET section_id = ? WHERE id = ?').run(sectionId, app.id);
      Q.setStatus(db, app.id, 'approved', actor, remarks || 'Approved by registrar');
      db.prepare('UPDATE enrollments SET approved_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(app.id);
      const sec = db.prepare('SELECT name FROM sections WHERE id = ?').get(sectionId);
      notify(db, student.user_id, 'Application approved ✅',
        `Your application ${app.reference_no} was approved. Section: ${sec ? sec.name : '—'}. Please view your assessment and submit payment.`,
        '/dashboard');
      const enrolledNow = reconcile(app.id, actor);
      if (enrolledNow) notify(db, student.user_id, 'Enrollment complete',
        'Your payment was already verified — you are officially enrolled!', '/dashboard');
      flash(req, 'success', `Application approved${enrolledNow ? ' and enrolled' : ''}.`);
    } else {
      flash(req, 'danger', 'Unknown action.');
    }
    audit(db, req, `application_${action}`, 'enrollment', app.id, `ref=${app.reference_no}`);
    res.redirect(req.body.return_to === 'list' ? '/admin/applicants' : `/admin/applicants/${app.id}`);
  } catch (e) { next(e); }
});

router.post('/applicants/bulk', requirePermission('applicants'), (req, res, next) => {
  try {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids])
      .filter(Boolean).map(Number).filter((n) => !isNaN(n));
    if (!ids.length) { flash(req, 'warning', 'No applications selected.'); return res.redirect('/admin/applicants'); }
    if (req.body.action !== 'approve') { flash(req, 'danger', 'Only bulk approve is supported.'); return res.redirect('/admin/applicants'); }

    let ok = 0; const skipped = [];
    for (const id of ids) {
      const app = Q.getEnrollment(db, id);
      if (!app || !['submitted', 'under_review', 'returned'].includes(app.status)) {
        skipped.push(app ? app.reference_no : `#${id}`);
        continue;
      }
      const section = app.section_id ? Q.sectionSlots(db, app.section_id) : null;
      let sectionId = section && section.remaining > 0 ? section.id : null;
      if (!sectionId) {
        const auto = autoSection(app.grade_level_id, app.strand_id, null);
        if (!auto) { skipped.push(`${app.reference_no} (no slots)`); continue; }
        sectionId = auto.id;
      }
      db.prepare('UPDATE enrollments SET section_id = ? WHERE id = ?').run(sectionId, app.id);
      Q.setStatus(db, app.id, 'approved', req.session.userId, 'Bulk approved by registrar');
      db.prepare('UPDATE enrollments SET approved_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(app.id);
      const student = Q.getStudent(db, app.student_id);
      notify(db, student.user_id, 'Application approved ✅',
        `Your application ${app.reference_no} was approved. Please submit your payment.`, '/dashboard');
      reconcile(app.id, req.session.userId);
      ok++;
    }
    audit(db, req, 'bulk_approve', 'enrollment', null, `approved=${ok} skipped=${skipped.length}`);
    flash(req, 'success', `${ok} application(s) approved.${skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''}`);
    res.redirect('/admin/applicants');
  } catch (e) { next(e); }
});

/* ================================================================== PAYMENTS */
router.get('/payments', requirePermission('payments'), (req, res, next) => {
  try {
    const status = req.query.status || 'pending';
    const rows = db.prepare(
      `SELECT p.*, s.first_name, s.last_name, s.lrn, e.reference_no, e.status AS enrollment_status,
              gl.name AS grade_name, u.full_name AS verifier_name
       FROM payments p
       JOIN students s ON s.id = p.student_id
       JOIN enrollments e ON e.id = p.enrollment_id
       JOIN grade_levels gl ON gl.id = e.grade_level_id
       LEFT JOIN users u ON u.id = p.verified_by
       WHERE p.status = ? ORDER BY p.id DESC`
    ).all(status);
    res.render('admin/payments', {
      title: 'Payments', rows, status, PAY: peso, FMTDT: fmtDateTime,
      STATUS_LABELS, STATUS_COLORS,
    });
  } catch (e) { next(e); }
});

router.post('/payments/:id/verify', requirePermission('payments'), (req, res, next) => {
  try {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!p) { flash(req, 'danger', 'Payment not found.'); return res.redirect('/admin/payments'); }
    const action = req.body.action;
    if (!['verify', 'reject'].includes(action)) { flash(req, 'danger', 'Unknown action.'); return res.redirect('/admin/payments'); }

    db.prepare(
      `UPDATE payments SET status = ?, remarks = ?, verified_by = ?, verified_at = datetime('now','localtime')
       WHERE id = ?`
    ).run(action === 'verify' ? 'verified' : 'rejected', req.body.remarks || null, req.session.userId, p.id);

    const student = Q.getStudent(db, p.student_id);
    if (action === 'verify') {
      notify(db, student.user_id, 'Payment verified ✅',
        `Your payment of ${peso(p.amount)} has been verified.`, '/dashboard');
      const becameEnrolled = reconcile(p.enrollment_id, req.session.userId);
      if (becameEnrolled) {
        notify(db, student.user_id, 'You are now enrolled 🎉',
          'Your enrollment is complete. Confirm your schedule and print your COR on the dashboard.', '/dashboard');
      } else {
        // Payment verified while still under review — registrar will finish approval
        notify(db, student.user_id, 'Payment received',
          'Your payment was verified. Waiting for final approval of your application.', '/dashboard');
      }
      flash(req, 'success', `Payment verified.${becameEnrolled ? ' Student is now enrolled.' : ''}`);
    } else {
      notify(db, student.user_id, 'Payment rejected', req.body.remarks || 'Payment proof could not be verified.', '/dashboard');
      flash(req, 'success', 'Payment rejected.');
    }
    audit(db, req, `payment_${action}`, 'payment', p.id, `amount=${p.amount}`);
    res.redirect('/admin/payments?status=' + encodeURIComponent(req.body.return_status || 'pending'));
  } catch (e) { next(e); }
});

/* ====================================================== ENROLLMENT MANAGEMENT */
router.get('/enrollment', requirePermission('enrollment'), (req, res, next) => {
  try {
    const periods = db.prepare(
      `SELECT p.*, sy.name AS sy_name FROM enrollment_periods p
       JOIN school_years sy ON sy.id = p.school_year_id ORDER BY p.id DESC`
    ).all();
    const grades = db.prepare('SELECT * FROM grade_levels ORDER BY order_no').all();
    const sections = grades.flatMap((g) =>
      Q.sectionsFor(db, g.id).map((s) => ({ ...s, grade_name: g.name })));

    // Unassigned approved students (need a section)
    const sy = Q.currentSchoolYear(db);
    const unassigned = db.prepare(
      `SELECT e.id, e.reference_no, e.status, s.first_name, s.last_name, s.lrn, gl.name AS grade_name,
              e.grade_level_id, e.strand_id, st.code AS strand_code
       FROM enrollments e
       JOIN students s ON s.id = e.student_id
       JOIN grade_levels gl ON gl.id = e.grade_level_id
       LEFT JOIN strands st ON st.id = e.strand_id
       WHERE e.school_year_id = ? AND e.section_id IS NULL AND e.status IN ('approved','enrolled')
       ORDER BY gl.order_no, s.last_name`
    ).all(sy ? sy.id : -1);

    const advisers = db.prepare(
      `SELECT id, full_name FROM users WHERE role IN ('adviser','registrar','super_admin') AND status='active' ORDER BY full_name`
    ).all();

    res.render('admin/enrollment', {
      title: 'Enrollment Management',
      periods, sections, grades, unassigned, advisers,
      schoolYears: db.prepare('SELECT * FROM school_years ORDER BY id DESC').all(),
      FMTD: fmtDate,
    });
  } catch (e) { next(e); }
});

router.post('/enrollment/period/save', requirePermission('enrollment'), (req, res, next) => {
  try {
    const b = req.body;
    if (b.id) {
      db.prepare(
        `UPDATE enrollment_periods SET label=?, type=?, school_year_id=?, opens_at=?, closes_at=?, is_open=?
         WHERE id=?`
      ).run(b.label, b.type, b.school_year_id, b.opens_at || null, b.closes_at || null,
        b.is_open === 'on' || b.is_open === '1' ? 1 : 0, b.id);
      flash(req, 'success', 'Enrollment period updated.');
      audit(db, req, 'period_update', 'enrollment_period', b.id, b.label);
    } else {
      db.prepare(
        `INSERT INTO enrollment_periods (label, type, school_year_id, opens_at, closes_at, is_open)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(b.label, b.type, b.school_year_id, b.opens_at || null, b.closes_at || null,
        b.is_open === 'on' || b.is_open === '1' ? 1 : 0);
      flash(req, 'success', 'Enrollment period created.');
      audit(db, req, 'period_create', 'enrollment_period', null, b.label);
    }
    res.redirect('/admin/enrollment');
  } catch (e) { next(e); }
});

router.post('/enrollment/period/:id/toggle', requirePermission('enrollment'), (req, res, next) => {
  try {
    const p = db.prepare('SELECT * FROM enrollment_periods WHERE id = ?').get(req.params.id);
    if (!p) { flash(req, 'danger', 'Period not found.'); return res.redirect('/admin/enrollment'); }
    db.prepare('UPDATE enrollment_periods SET is_open = ? WHERE id = ?').run(p.is_open ? 0 : 1, p.id);
    audit(db, req, p.is_open ? 'period_close' : 'period_open', 'enrollment_period', p.id, p.label);
    flash(req, 'success', `Period "${p.label}" ${p.is_open ? 'closed' : 'opened'}.`);
    res.redirect('/admin/enrollment');
  } catch (e) { next(e); }
});

router.post('/enrollment/section/save', requirePermission('enrollment'), (req, res, next) => {
  try {
    const { id, capacity, adviser_id } = req.body;
    const sec = db.prepare('SELECT * FROM sections WHERE id = ?').get(id);
    if (!sec) { flash(req, 'danger', 'Section not found.'); return res.redirect('/admin/enrollment'); }
    const cap = Math.max(1, parseInt(capacity, 10) || sec.capacity);
    const adv = adviser_id ? Number(adviser_id) : null;
    db.prepare('UPDATE sections SET capacity = ?, adviser_id = ? WHERE id = ?').run(cap, adv, sec.id);
    audit(db, req, 'section_update', 'section', sec.id, `capacity=${cap}`);
    flash(req, 'success', `Section "${sec.name}" updated (capacity ${cap}).`);
    res.redirect('/admin/enrollment');
  } catch (e) { next(e); }
});

router.post('/enrollment/assign', requirePermission('enrollment'), (req, res, next) => {
  try {
    const { enrollment_id, section_id } = req.body;
    const app = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(enrollment_id);
    const sec = Q.sectionSlots(db, Number(section_id));
    if (!app || !sec) { flash(req, 'danger', 'Enrollment or section not found.'); return res.redirect('/admin/enrollment'); }
    if (sec.grade_level_id !== app.grade_level_id) {
      flash(req, 'danger', 'That section belongs to a different grade level.');
      return res.redirect('/admin/enrollment');
    }
    if (sec.remaining <= 0) {
      flash(req, 'danger', `Section "${sec.name}" is full.`);
      return res.redirect('/admin/enrollment');
    }
    db.prepare('UPDATE enrollments SET section_id = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?')
      .run(sec.id, app.id);
    audit(db, req, 'assign_section', 'enrollment', app.id, `section=${sec.name}`);
    flash(req, 'success', 'Student assigned to section.');
    res.redirect('/admin/enrollment');
  } catch (e) { next(e); }
});

/* Mount remaining admin routes (academic, requirements, users, reports, …) */
router.use(setupRouter);

module.exports = router;
