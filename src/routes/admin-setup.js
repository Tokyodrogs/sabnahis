/**
 * Admin panel — part 2: academic setup CRUD, requirements manager,
 * user & role management, reports, settings, audit log.
 */
const express = require('express');
const {
  flash, audit, sendCsv, peso, fmtDate, fmtDateTime,
  STATUS_LABELS, STATUS_COLORS, fullName,
} = require('../utils/helpers');
const Q = require('../utils/queries');
const { hashPassword, randomToken } = require('../utils/crypto');
const { requirePermission, can } = require('../middleware/auth');
const { db } = require('../app');

const router = express.Router();

/* ============================================================ ACADEMIC SETUP */
/* Whitelisted entities + their updatable columns (generic CRUD). */
const ENTITIES = {
  grade_levels: {
    label: 'Grade Level',
    columns: ['code', 'name', 'department', 'order_no'],
    required: ['code', 'name'],
    order: 'order_no',
  },
  sections: {
    label: 'Section',
    columns: ['name', 'grade_level_id', 'strand_id', 'capacity', 'adviser_id'],
    required: ['name', 'grade_level_id'],
    order: 'name',
  },
  strands: {
    label: 'Strand / Track',
    columns: ['code', 'name'],
    required: ['code', 'name'],
    order: 'name',
  },
  subjects: {
    label: 'Subject',
    columns: ['code', 'name', 'grade_level_id', 'strand_id', 'units'],
    required: ['name', 'grade_level_id'],
    order: 'name',
  },
  school_years: {
    label: 'School Year',
    columns: ['name', 'start_date', 'end_date', 'is_current'],
    required: ['name'],
    order: 'id',
  },
  grading_periods: {
    label: 'Grading Period',
    columns: ['school_year_id', 'name', 'order_no'],
    required: ['name', 'school_year_id'],
    order: 'order_no',
  },
  fees: {
    label: 'Fee',
    columns: ['name', 'category', 'amount', 'grade_level_id', 'strand_id', 'school_year_id', 'is_active'],
    required: ['name', 'amount'],
    order: 'id',
  },
};

function castValue(col, raw) {
  if (raw === '' || raw === undefined) {
    if (['strand_id', 'grade_level_id', 'school_year_id', 'adviser_id'].includes(col)) return null;
    if (['is_current', 'is_active'].includes(col)) return 0;
    if (['amount', 'capacity', 'order_no', 'units'].includes(col)) return 0;
    return null;
  }
  if (['strand_id', 'grade_level_id', 'school_year_id', 'adviser_id', 'capacity', 'order_no', 'units', 'is_current', 'is_active'].includes(col)) {
    return parseInt(raw, 10) || 0;
  }
  if (col === 'amount') return parseFloat(raw) || 0;
  return raw;
}

router.get('/academic', requirePermission('academic'), (req, res, next) => {
  try {
    const tab = req.query.tab || 'grade_levels';
    const grades = db.prepare('SELECT * FROM grade_levels ORDER BY order_no').all();
    const strands = db.prepare('SELECT * FROM strands ORDER BY name').all();
    const schoolYears = db.prepare('SELECT * FROM school_years ORDER BY id DESC').all();
    const advisers = db.prepare(
      `SELECT id, full_name FROM users WHERE role IN ('adviser','registrar','super_admin') AND status='active' ORDER BY full_name`
    ).all();

    res.render('admin/academic', {
      title: 'Academic Setup',
      tab, ENTITIES,
      gradeLevels: grades,
      strands,
      schoolYears,
      advisers,
      data: {
        grade_levels: grades,
        sections: db.prepare(
          `SELECT s.*, g.name AS grade_name, st.code AS strand_code, u.full_name AS adviser_name
           FROM sections s JOIN grade_levels g ON g.id = s.grade_level_id
           LEFT JOIN strands st ON st.id = s.strand_id
           LEFT JOIN users u ON u.id = s.adviser_id
           ORDER BY g.order_no, s.name`
        ).all(),
        strands,
        subjects: db.prepare(
          `SELECT s.*, g.name AS grade_name, st.code AS strand_code
           FROM subjects s JOIN grade_levels g ON g.id = s.grade_level_id
           LEFT JOIN strands st ON st.id = s.strand_id
           ORDER BY g.order_no, st.code IS NULL DESC, s.name`
        ).all(),
        school_years: schoolYears,
        grading_periods: db.prepare(
          `SELECT p.*, sy.name AS sy_name FROM grading_periods p
           JOIN school_years sy ON sy.id = p.school_year_id ORDER BY sy.id DESC, p.order_no`
        ).all(),
        fees: db.prepare(
          `SELECT f.*, g.name AS grade_name, st.code AS strand_code, sy.name AS sy_name
           FROM fees f
           LEFT JOIN grade_levels g ON g.id = f.grade_level_id
           LEFT JOIN strands st ON st.id = f.strand_id
           LEFT JOIN school_years sy ON sy.id = f.school_year_id
           ORDER BY f.id`
        ).all(),
      },
      FMTD: fmtDate,
    });
  } catch (e) { next(e); }
});

router.post('/academic/:entity/save', requirePermission('academic'), (req, res, next) => {
  try {
    const { entity } = req.params;
    const def = ENTITIES[entity];
    if (!def) { flash(req, 'danger', 'Unknown entity.'); return res.redirect('/admin/academic'); }

    const values = {};
    for (const col of def.columns) values[col] = castValue(col, req.body[col]);
    for (const reqCol of def.required) {
      if (values[reqCol] === null || values[reqCol] === '' || values[reqCol] === undefined) {
        flash(req, 'danger', `${def.label}: missing required field "${reqCol}".`);
        return res.redirect(`/admin/academic?tab=${entity}`);
      }
    }

    if (req.body.id) {
      const sets = def.columns.map((c) => `${c} = ?`).join(', ');
      db.prepare(`UPDATE ${entity} SET ${sets} WHERE id = ?`)
        .run(...def.columns.map((c) => values[c]), req.body.id);
      flash(req, 'success', `${def.label} updated.`);
      audit(db, req, `${entity}_update`, entity, req.body.id, JSON.stringify(values));
    } else {
      const cols = def.columns.join(', ');
      const ph = def.columns.map(() => '?').join(', ');
      const info = db.prepare(`INSERT INTO ${entity} (${cols}) VALUES (${ph})`)
        .run(...def.columns.map((c) => values[c]));
      flash(req, 'success', `${def.label} created.`);
      audit(db, req, `${entity}_create`, entity, info.lastInsertRowid, JSON.stringify(values));
    }
    res.redirect(`/admin/academic?tab=${entity}`);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {
      flash(req, 'danger', 'Duplicate value — that record already exists.');
      return res.redirect(`/admin/academic?tab=${req.params.entity}`);
    }
    if (/FOREIGN KEY|constraint/i.test(e.message)) {
      flash(req, 'danger', 'Cannot modify/delete: related records still reference this item.');
      return res.redirect(`/admin/academic?tab=${req.params.entity}`);
    }
    next(e);
  }
});

router.post('/academic/:entity/:id/delete', requirePermission('academic'), (req, res, next) => {
  try {
    const { entity, id } = req.params;
    if (!ENTITIES[entity]) { flash(req, 'danger', 'Unknown entity.'); return res.redirect('/admin/academic'); }
    db.prepare(`DELETE FROM ${entity} WHERE id = ?`).run(id);
    flash(req, 'success', `${ENTITIES[entity].label} deleted.`);
    audit(db, req, `${entity}_delete`, entity, id, null);
    res.redirect(`/admin/academic?tab=${entity}`);
  } catch (e) {
    if (/FOREIGN KEY|constraint/i.test(e.message)) {
      flash(req, 'danger', 'Cannot delete — other records still reference this item (e.g. students enrolled in this section).');
      return res.redirect(`/admin/academic?tab=${req.params.entity}`);
    }
    next(e);
  }
});

/* ======================================================= REQUIREMENTS MANAGER */
router.get('/requirements', requirePermission('requirements'), (req, res, next) => {
  try {
    res.render('admin/requirements', {
      title: 'Requirements Manager',
      rows: db.prepare('SELECT * FROM requirements ORDER BY sort_order, id').all(),
      TYPE_OPTIONS: ['new', 'transferee', 'returning', 'all'],
      GRADE_OPTIONS: ['all', 'G7', 'G10', 'G11', 'G12', 'JHS', 'SHS'],
    });
  } catch (e) { next(e); }
});

router.post('/requirements/save', requirePermission('requirements'), (req, res, next) => {
  try {
    const b = req.body;
    if (!b.doc_type || !b.label) { flash(req, 'danger', 'Document key and label are required.'); return res.redirect('/admin/requirements'); }
    const applies = Array.isArray(b.applies_to) ? b.applies_to.join(',') : (b.applies_to || 'all');
    const grades = Array.isArray(b.grade_scope) ? b.grade_scope.join(',') : (b.grade_scope || 'all');
    if (b.id) {
      db.prepare(
        `UPDATE requirements SET label=?, applies_to=?, grade_scope=?, is_required=?, sort_order=? WHERE id=?`
      ).run(b.label, applies, grades, b.is_required === 'on' ? 1 : 0, parseInt(b.sort_order, 10) || 0, b.id);
      flash(req, 'success', 'Requirement updated.');
      audit(db, req, 'requirement_update', 'requirement', b.id, b.label);
    } else {
      db.prepare(
        `INSERT INTO requirements (doc_type, label, applies_to, grade_scope, is_required, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(b.doc_type, b.label, applies, grades, b.is_required === 'on' ? 1 : 0, parseInt(b.sort_order, 10) || 0);
      flash(req, 'success', 'Requirement added.');
      audit(db, req, 'requirement_create', 'requirement', null, b.label);
    }
    res.redirect('/admin/requirements');
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {
      flash(req, 'danger', 'That document key already exists.');
      return res.redirect('/admin/requirements');
    }
    next(e);
  }
});

router.post('/requirements/:id/delete', requirePermission('requirements'), (req, res, next) => {
  try {
    db.prepare('DELETE FROM requirements WHERE id = ?').run(req.params.id);
    audit(db, req, 'requirement_delete', 'requirement', req.params.id, null);
    flash(req, 'success', 'Requirement removed.');
    res.redirect('/admin/requirements');
  } catch (e) { next(e); }
});

/* ======================================================= USER & ROLE MANAGEMENT */
router.get('/users', requirePermission('users'), (req, res, next) => {
  try {
    res.render('admin/users', {
      title: 'User & Role Management',
      rows: db.prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM students WHERE user_id = u.id) AS has_profile
         FROM users u ORDER BY u.role, u.full_name`
      ).all(),
      roles: [
        ['super_admin', 'Super Admin — full access'],
        ['registrar', 'Registrar — applicants, enrollment, academics, reports'],
        ['cashier', 'Cashier / Finance — payments & collection reports'],
        ['adviser', 'Adviser / Teacher — class lists & reports'],
        ['applicant', 'Applicant / Student'],
      ],
      me: req.session.userId,
      FMTDT: fmtDateTime,
    });
  } catch (e) { next(e); }
});

router.post('/users/save', requirePermission('users'), async (req, res, next) => {
  try {
    const b = req.body;
    const validRoles = ['super_admin', 'registrar', 'cashier', 'adviser', 'applicant'];
    if (!b.full_name || !b.login_id || !validRoles.includes(b.role)) {
      flash(req, 'danger', 'Name, username and a valid role are required.');
      return res.redirect('/admin/users');
    }
    if (b.id) {
      db.prepare(
        `UPDATE users SET full_name=?, login_id=?, email=?, role=?, status=?, updated_at=datetime('now','localtime') WHERE id=?`
      ).run(b.full_name.trim(), b.login_id.trim(), (b.email || '').trim() || null, b.role,
        b.status === 'disabled' ? 'disabled' : 'active', b.id);
      if (b.password && b.password.length >= 8) {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(b.password), b.id);
      }
      flash(req, 'success', 'User updated.');
      audit(db, req, 'user_update', 'user', b.id, `role=${b.role} status=${b.status || 'active'}`);
    } else {
      if (!b.password || b.password.length < 8) {
        flash(req, 'danger', 'Initial password must be at least 8 characters.');
        return res.redirect('/admin/users');
      }
      const exists = db.prepare('SELECT id FROM users WHERE login_id = ? OR lower(email) = lower(?)')
        .get(b.login_id.trim(), (b.email || '').trim() || '~none~');
      if (exists) { flash(req, 'danger', 'Username or email already in use.'); return res.redirect('/admin/users'); }
      const info = db.prepare(
        `INSERT INTO users (login_id, email, password_hash, full_name, role, status, email_verified)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      ).run(b.login_id.trim(), (b.email || '').trim() || null, await hashPassword(b.password),
        b.full_name.trim(), b.role, b.status === 'disabled' ? 'disabled' : 'active');
      flash(req, 'success', `User "${b.full_name}" created.`);
      audit(db, req, 'user_create', 'user', info.lastInsertRowid, `login=${b.login_id} role=${b.role}`);
    }
    res.redirect('/admin/users');
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) { flash(req, 'danger', 'Username or email already exists.'); return res.redirect('/admin/users'); }
    next(e);
  }
});

router.post('/users/:id/toggle', requirePermission('users'), (req, res, next) => {
  try {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) { flash(req, 'danger', 'User not found.'); return res.redirect('/admin/users'); }
    if (u.id === req.session.userId) {
      flash(req, 'danger', 'You cannot disable your own account.');
      return res.redirect('/admin/users');
    }
    const nextStatus = u.status === 'active' ? 'disabled' : 'active';
    db.prepare('UPDATE users SET status = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?')
      .run(nextStatus, u.id);
    audit(db, req, 'user_status', 'user', u.id, nextStatus);
    flash(req, 'success', `Account ${nextStatus === 'active' ? 'activated' : 'disabled'}.`);
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

router.post('/users/:id/reset-password', requirePermission('users'), async (req, res, next) => {
  try {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) { flash(req, 'danger', 'User not found.'); return res.redirect('/admin/users'); }
    const pw = req.body.password;
    if (!pw || pw.length < 8) {
      flash(req, 'danger', 'New password must be at least 8 characters.');
      return res.redirect('/admin/users');
    }
    db.prepare(
      `UPDATE users SET password_hash=?, failed_attempts=0, locked_until=NULL, reset_token=NULL,
        updated_at=datetime('now','localtime') WHERE id=?`
    ).run(await hashPassword(pw), u.id);
    audit(db, req, 'user_password_reset', 'user', u.id, null);
    flash(req, 'success', `Password reset for "${u.full_name}".`);
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

/* =================================================================== REPORTS */
router.get('/reports', requirePermission('reports'), (req, res, next) => {
  try {
    const type = req.query.type || 'by-grade';
    const sy = Q.currentSchoolYear(db);
    const grades = db.prepare('SELECT * FROM grade_levels ORDER BY order_no').all();
    const sections = db.prepare(
      `SELECT s.*, g.name AS grade_name FROM sections s
       JOIN grade_levels g ON g.id = s.grade_level_id ORDER BY g.order_no, s.name`
    ).all();

    // Advisers only see their own sections' class lists
    const isAdviser = req.session.user.role === 'adviser';
    const visibleSections = isAdviser
      ? sections.filter((s) => s.adviser_id === req.session.userId)
      : sections;

    const ctx = { type, sy, grades, sections: visibleSections, allSections: sections, isAdviser, PAY: peso, FMTD: fmtDate };
    let data = null; let headers = null; let rows = null;

    const baseWhere = `e.school_year_id = ? AND e.status IN ('submitted','under_review','approved','enrolled')`;

    if (type === 'by-grade') {
      data = grades.map((g) => {
        const r = db.prepare(
          `SELECT
             COUNT(*) total,
             SUM(CASE WHEN s.enrollment_type='new' THEN 1 ELSE 0 END) newc,
             SUM(CASE WHEN s.enrollment_type='transferee' THEN 1 ELSE 0 END) transferee,
             SUM(CASE WHEN s.enrollment_type='returning' THEN 1 ELSE 0 END) returningc,
             SUM(CASE WHEN e.status='enrolled' THEN 1 ELSE 0 END) enrolled,
             SUM(CASE WHEN e.status='approved' THEN 1 ELSE 0 END) approved,
             SUM(CASE WHEN e.status IN ('submitted','under_review') THEN 1 ELSE 0 END) pending
           FROM enrollments e JOIN students s ON s.id = e.student_id
           WHERE e.grade_level_id = ? AND ${baseWhere}`
        ).get(g.id, sy ? sy.id : -1);
        return { grade: g.name, ...r };
      });
      headers = ['Grade Level', 'New', 'Transferee', 'Returning', 'Total', 'Approved', 'Enrolled', 'Pending'];
      rows = data.map((d) => [d.grade, d.newc || 0, d.transferee || 0, d.returningc || 0,
        d.total || 0, d.approved || 0, d.enrolled || 0, d.pending || 0]);
    } else if (type === 'by-section') {
      data = sections.map((sec) => {
        const r = db.prepare(
          `SELECT COUNT(*) total,
             SUM(CASE WHEN e.status='enrolled' THEN 1 ELSE 0 END) enrolled
           FROM enrollments e WHERE e.section_id = ? AND e.school_year_id = ?
             AND e.status IN ('approved','enrolled')`
        ).get(sec.id, sy ? sy.id : -1);
        return { section: `${sec.grade_name} – ${sec.name}`, capacity: sec.capacity, total: r.total || 0, enrolled: r.enrolled || 0 };
      });
      headers = ['Section', 'Capacity', 'Assigned', 'Enrolled'];
      rows = data.map((d) => [d.section, d.capacity, d.total, d.enrolled]);
    } else if (type === 'by-strand') {
      data = db.prepare(
        `SELECT st.code, st.name, COUNT(*) total
         FROM enrollments e JOIN strands st ON st.id = e.strand_id
         WHERE e.school_year_id = ? AND e.status IN ('submitted','under_review','approved','enrolled')
         GROUP BY st.id ORDER BY st.name`
      ).all(sy ? sy.id : -1);
      headers = ['Strand', 'Description', 'Enrollees'];
      rows = data.map((d) => [d.code, d.name, d.total]);
    } else if (type === 'class-list') {
      const sectionId = Number(req.query.section_id || 0);
      const sec = sections.find((s) => s.id === sectionId) || null;
      data = sec ? db.prepare(
        `SELECT s.lrn, s.first_name, s.middle_name, s.last_name, s.gender, s.contact_number,
                e.reference_no, e.status, st.code AS strand_code
         FROM enrollments e
         JOIN students s ON s.id = e.student_id
         LEFT JOIN strands st ON st.id = e.strand_id
         WHERE e.section_id = ? AND e.school_year_id = ? AND e.status IN ('approved','enrolled')
         ORDER BY s.last_name, s.first_name`
      ).all(sec.id, sy ? sy.id : -1) : [];
      ctx.selectedSection = sec;
      ctx.roster = data;
      headers = ['#', 'LRN', 'Name', 'Gender', 'Contact', 'Strand', 'Reference No'];
      rows = data.map((r, i) => [i + 1, r.lrn || '', fullName(r), r.gender || '', r.contact_number || '',
        r.strand_code || '', r.reference_no]);
    } else if (type === 'collection') {
      data = db.prepare(
        `SELECT p.*, s.first_name, s.last_name, s.lrn, e.reference_no, gl.name AS grade_name
         FROM payments p
         JOIN students s ON s.id = p.student_id
         JOIN enrollments e ON e.id = p.enrollment_id
         JOIN grade_levels gl ON gl.id = e.grade_level_id
         ORDER BY p.id DESC`
      ).all();
      const totals = {
        verified: data.filter((p) => p.status === 'verified').reduce((a, p) => a + p.amount, 0),
        pending: data.filter((p) => p.status === 'pending').reduce((a, p) => a + p.amount, 0),
        rejected: data.filter((p) => p.status === 'rejected').reduce((a, p) => a + p.amount, 0),
      };
      ctx.collection = data; ctx.totals = totals;
      headers = ['Date', 'Student', 'LRN', 'Enrollment Ref', 'Grade', 'Amount', 'Method', 'Status'];
      rows = data.map((p) => [p.created_at, fullName({ first_name: p.first_name, last_name: p.last_name }),
        p.lrn || '', p.reference_no, p.grade_name, p.amount, p.method, p.status]);
    } else if (type === 'status') {
      data = db.prepare(
        `SELECT status, COUNT(*) total FROM enrollments WHERE school_year_id = ? AND status != 'draft'
         GROUP BY status ORDER BY status`
      ).all(sy ? sy.id : -1);
      headers = ['Status', 'Count'];
      rows = data.map((d) => [STATUS_LABELS[d.status] || d.status, d.total]);
    }

    if (req.query.format === 'csv') {
      if (!headers) { flash(req, 'danger', 'Nothing to export.'); return res.redirect('/admin/reports'); }
      return sendCsv(res, `report-${type}.csv`, headers, rows);
    }

    res.render('admin/reports', {
      title: 'Reports', ...ctx, data, headers, rows,
      STATUS_LABELS, STATUS_COLORS,
      types: [
        ['by-grade', 'Enrollment Statistics by Grade Level'],
        ['by-section', 'Enrollment by Section'],
        ['by-strand', 'Enrollment by Strand (SHS)'],
        ['class-list', 'Class List (per Section)'],
        ['collection', 'Collection / Fee Report'],
        ['status', 'Enrollment Status Summary'],
      ],
    });
  } catch (e) { next(e); }
});

/* ================================================================= SETTINGS */
router.get('/settings', requirePermission('settings'), (req, res, next) => {
  try {
    const s = {};
    for (const r of db.prepare('SELECT key, value FROM settings').all()) s[r.key] = r.value;
    res.render('admin/settings', { title: 'Settings', s });
  } catch (e) { next(e); }
});

const SETTING_KEYS = [
  'school_name', 'school_tagline', 'system_title', 'school_address', 'school_contact',
  'primary_color', 'logo_path', 'campus_bg_path', 'entrance_path', 'instructions',
  'enrollment_deadline', 'currency',
];

router.post('/settings', requirePermission('settings'), (req, res, next) => {
  try {
    const changed = [];
    for (const key of SETTING_KEYS) {
      if (req.body[key] !== undefined) {
        db.prepare(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).run(key, String(req.body[key]));
        changed.push(key);
      }
    }
    audit(db, req, 'settings_update', 'settings', null, changed.join(','));
    flash(req, 'success', 'Settings saved.');
    res.redirect('/admin/settings');
  } catch (e) { next(e); }
});

/* =================================================================== AUDIT LOG */
router.get('/audit', requirePermission('audit'), (req, res, next) => {
  try {
    const userFilter = req.query.user || '';
    const action = req.query.action || '';
    let sql = `
      SELECT a.*, u.full_name AS uname, u.role AS urole
      FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE 1=1`;
    const params = [];
    if (userFilter) { sql += ' AND a.user_id = ?'; params.push(userFilter); }
    if (action) { sql += ' AND a.action LIKE ?'; params.push(`%${action}%`); }
    sql += ' ORDER BY a.id DESC LIMIT 500';

    const rows = db.prepare(sql).all(...params);
    if (req.query.format === 'csv') {
      return sendCsv(res, 'audit-log.csv',
        ['Timestamp', 'User', 'Role', 'Action', 'Entity', 'Entity ID', 'Details', 'IP'],
        rows.map((r) => [r.created_at, r.uname || r.user_name, r.urole || '', r.action,
          r.entity || '', r.entity_id || '', r.details || '', r.ip || '']));
    }
    res.render('admin/audit', {
      title: 'Audit Log',
      rows, userFilter, action,
      users: db.prepare('SELECT id, full_name FROM users ORDER BY full_name').all(),
      FMTDT: fmtDateTime,
    });
  } catch (e) { next(e); }
});

module.exports = router;
