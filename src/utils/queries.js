/**
 * Shared domain queries: students, enrollments, fees, requirements, subjects.
 */
const { fullName } = require('./helpers');
const { makeReferenceNo } = require('./crypto');

function getStudentByUser(db, userId) {
  return db.prepare('SELECT * FROM students WHERE user_id = ?').get(userId);
}

function getStudent(db, id) {
  return db.prepare('SELECT * FROM students WHERE id = ?').get(id);
}

function currentSchoolYear(db) {
  return db.prepare('SELECT * FROM school_years WHERE is_current = 1 ORDER BY id DESC LIMIT 1').get()
      || db.prepare('SELECT * FROM school_years ORDER BY id DESC LIMIT 1').get();
}

function activePeriod(db, type) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(
    `SELECT * FROM enrollment_periods
     WHERE type = ? AND is_open = 1
       AND (opens_at IS NULL OR opens_at <= ?)
       AND (closes_at IS NULL OR closes_at >= ?)
     ORDER BY id DESC LIMIT 1`
  ).get(type, today, today);
}

/** Latest application/early enrollment for the current school year. */
function currentEnrollment(db, studentId, type) {
  const sy = currentSchoolYear(db);
  if (!sy) return null;
  return db.prepare(
    `SELECT e.*, gl.name AS grade_name, gl.code AS grade_code, s.name AS strand_name, s.code AS strand_code,
            sec.name AS section_name, sy.name AS sy_name
     FROM enrollments e
     JOIN grade_levels gl ON gl.id = e.grade_level_id
     LEFT JOIN strands s ON s.id = e.strand_id
     LEFT JOIN sections sec ON sec.id = e.section_id
     JOIN school_years sy ON sy.id = e.school_year_id
     WHERE e.student_id = ? AND e.school_year_id = ? AND e.type = ?
     ORDER BY e.id DESC LIMIT 1`
  ).get(studentId, sy.id, type || 'application');
}

function allCurrentEnrollments(db, studentId) {
  const sy = currentSchoolYear(db);
  if (!sy) return [];
  return db.prepare(
    `SELECT e.*, gl.name AS grade_name, gl.code AS grade_code, st.name AS strand_name, st.code AS strand_code,
            sec.name AS section_name, sy.name AS sy_name
     FROM enrollments e
     JOIN grade_levels gl ON gl.id = e.grade_level_id
     LEFT JOIN strands st ON st.id = e.strand_id
     LEFT JOIN sections sec ON sec.id = e.section_id
     JOIN school_years sy ON sy.id = e.school_year_id
     WHERE e.student_id = ? AND e.school_year_id = ?
     ORDER BY e.id DESC`
  ).all(studentId, sy.id);
}

function getEnrollment(db, id) {
  return db.prepare(
    `SELECT e.*, gl.name AS grade_name, gl.code AS grade_code, st.name AS strand_name, st.code AS strand_code,
            sec.name AS section_name, sy.name AS sy_name,
            stu.lrn, stu.first_name, stu.middle_name, stu.last_name, stu.suffix, stu.birthdate, stu.gender,
            stu.civil_status, stu.nationality, stu.religion, stu.contact_number, stu.home_address,
            stu.psa_birth_cert_no, stu.enrollment_type, stu.photo_path
     FROM enrollments e
     JOIN grade_levels gl ON gl.id = e.grade_level_id
     LEFT JOIN strands st ON st.id = e.strand_id
     LEFT JOIN sections sec ON sec.id = e.section_id
     JOIN school_years sy ON sy.id = e.school_year_id
     JOIN students stu ON stu.id = e.student_id
     WHERE e.id = ?`
  ).get(id);
}

function enrollmentHistory(db, enrollmentId) {
  return db.prepare(
    `SELECT h.*, u.full_name AS changed_by_name
     FROM enrollment_history h LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.enrollment_id = ? ORDER BY h.id ASC`
  ).all(enrollmentId);
}

function guardiansOf(db, studentId) {
  return db.prepare('SELECT * FROM guardians WHERE student_id = ?').all(studentId);
}

function educationOf(db, studentId) {
  return db.prepare('SELECT * FROM education_background WHERE student_id = ?').get(studentId);
}

function documentsOf(db, studentId) {
  return db.prepare('SELECT * FROM documents WHERE student_id = ? ORDER BY uploaded_at').all(studentId);
}

/** Fee lines applicable to a grade/strand/school year. */
function feesFor(db, gradeLevelId, strandId, schoolYearId) {
  return db.prepare(
    `SELECT * FROM fees
     WHERE is_active = 1
       AND (grade_level_id IS NULL OR grade_level_id = ?)
       AND (strand_id IS NULL OR strand_id = ?)
       AND (school_year_id IS NULL OR school_year_id = ?)
     ORDER BY category, id`
  ).all(gradeLevelId || -1, strandId || -1, schoolYearId || -1);
}

function assessmentTotal(db, gradeLevelId, strandId, schoolYearId) {
  const fees = feesFor(db, gradeLevelId, strandId, schoolYearId);
  return {
    fees,
    total: fees.reduce((sum, f) => sum + Number(f.amount), 0),
  };
}

/** Requirements that apply to an enrollment type + target grade code. */
function requirementsFor(db, enrollmentType, gradeCode) {
  const all = db.prepare('SELECT * FROM requirements ORDER BY sort_order, id').all();
  return all.filter((r) => {
    const applies = (r.applies_to || 'all').split(',').map((s) => s.trim());
    const grades = (r.grade_scope || 'all').split(',').map((s) => s.trim());
    const okType = applies.includes('all') || applies.includes(enrollmentType);
    const okGrade = grades.includes('all') || grades.includes(gradeCode);
    return okType && okGrade;
  });
}

/** Subjects for a grade + strand (strand-agnostic or matching). */
function subjectsFor(db, gradeLevelId, strandId) {
  return db.prepare(
    `SELECT * FROM subjects
     WHERE grade_level_id = ? AND (strand_id IS NULL OR strand_id = ?)
     ORDER BY name`
  ).all(gradeLevelId, strandId || -1);
}

function sectionSlots(db, sectionId) {
  const sec = db.prepare('SELECT * FROM sections WHERE id = ?').get(sectionId);
  if (!sec) return null;
  const sy = currentSchoolYear(db);
  const used = db.prepare(
    `SELECT COUNT(*) AS c FROM enrollments
     WHERE section_id = ? AND status IN ('approved','enrolled')
       AND (? IS NULL OR school_year_id = ?)`
  ).get(sectionId, sy ? sy.id : null, sy ? sy.id : null).c;
  return { ...sec, used, remaining: Math.max(0, sec.capacity - used) };
}

function sectionsFor(db, gradeLevelId) {
  const sy = currentSchoolYear(db);
  const rows = db.prepare(
    'SELECT * FROM sections WHERE grade_level_id = ? ORDER BY name'
  ).all(gradeLevelId);
  return rows.map((sec) => {
    const used = sy
      ? db.prepare(
          `SELECT COUNT(*) AS c FROM enrollments
           WHERE section_id = ? AND status IN ('approved','enrolled') AND school_year_id = ?`
        ).get(sec.id, sy.id).c
      : 0;
    const strand = sec.strand_id
      ? db.prepare('SELECT * FROM strands WHERE id = ?').get(sec.strand_id)
      : null;
    return { ...sec, used, remaining: Math.max(0, sec.capacity - used), strand };
  });
}

/** Timeline view-model for the status tracker. */
function statusTimeline(db, enrollment) {
  const history = enrollmentHistory(db, enrollment.id);
  const reached = {};
  for (const h of history) reached[h.status] = h;
  if (enrollment.submitted_at && !reached.submitted) {
    reached.submitted = { created_at: enrollment.submitted_at, changed_by_name: null, remarks: null };
  }
  if (enrollment.approved_at && !reached.approved) {
    reached.approved = { created_at: enrollment.approved_at, changed_by_name: null, remarks: null };
  }
  if (enrollment.enrolled_at && !reached.enrolled) {
    reached.enrolled = { created_at: enrollment.enrolled_at, changed_by_name: null, remarks: null };
  }
  return { history, reached };
}

function generateReference(db) {
  const sy = currentSchoolYear(db);
  const year = sy ? sy.name.slice(0, 4) : String(new Date().getFullYear());
  return makeReferenceNo(db, year);
}

/** Create or update history entry when status changes. */
function setStatus(db, enrollmentId, status, changedBy, remarks) {
  db.prepare(
    `UPDATE enrollments SET status = ?, remarks = COALESCE(?, remarks), updated_at = datetime('now','localtime')
     WHERE id = ?`
  ).run(status, remarks || null, enrollmentId);
  db.prepare(
    `INSERT INTO enrollment_history (enrollment_id, status, remarks, changed_by)
     VALUES (?, ?, ?, ?)`
  ).run(enrollmentId, status, remarks || null, changedBy || null);
}

module.exports = {
  getStudentByUser, getStudent, currentSchoolYear, activePeriod,
  currentEnrollment, allCurrentEnrollments, getEnrollment, enrollmentHistory,
  guardiansOf, educationOf, documentsOf,
  feesFor, assessmentTotal, requirementsFor, subjectsFor,
  sectionSlots, sectionsFor, statusTimeline,
  generateReference, setStatus, fullName,
};
