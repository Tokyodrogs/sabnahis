/**
 * Small shared helpers: flash messages, audit log, notifications,
 * CSV export, formatting, status labels.
 */

/* ------------------------------------------------------------------ flash */
function flash(req, type, message) {
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ type, message });
}
function takeFlashes(req) {
  const f = req.session.flash || [];
  delete req.session.flash;
  return f;
}

/* ------------------------------------------------------------------ audit */
function audit(db, req, action, entity, entityId, details) {
  db.prepare(
    `INSERT INTO audit_logs (user_id, user_name, action, entity, entity_id, details, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.session.userId || null,
    (req.session.user && req.session.user.full_name) || 'guest',
    action, entity || null,
    entityId != null ? String(entityId) : null,
    details || null,
    req.ip || (req.headers && req.headers['x-forwarded-for']) || null
  );
}

/* ---------------------------------------------------------- notifications */
function notify(db, userId, title, body, link) {
  if (!userId) return;
  db.prepare('INSERT INTO notifications (user_id, title, body, link) VALUES (?, ?, ?, ?)')
    .run(userId, title, body, link || null);
}

/* ------------------------------------------------------------------- csv */
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  return lines.join('\r\n');
}
function sendCsv(res, filename, headers, rows) {
  const csv = toCsv(headers, rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // BOM so Excel opens UTF-8 correctly
  res.send('\uFEFF' + csv);
}

/* ------------------------------------------------------------- formatting */
function peso(n) {
  const v = Number(n || 0);
  return '₱' + v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '—';
  const s = String(d).slice(0, 10);
  const dt = new Date(s + (String(d).length === 10 ? 'T00:00:00' : ''));
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '—';
  const dt = new Date(String(d).replace(' ', 'T'));
  if (isNaN(dt)) return d;
  return dt.toLocaleString('en-PH', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
function fullName(s) {
  if (!s) return '';
  return [s.first_name, s.middle_name, s.last_name, s.suffix].filter(Boolean).join(' ');
}

/* ------------------------------------------------------------ status maps */
const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under Review',
  returned: 'Returned for Correction',
  approved: 'Approved – For Assessment',
  enrolled: 'Enrolled',
  rejected: 'Rejected',
};
const STATUS_COLORS = {
  draft: 'secondary',
  submitted: 'info',
  under_review: 'warning text-dark',
  returned: 'danger',
  approved: 'primary',
  enrolled: 'success',
  rejected: 'dark',
};
/** Ordered pipeline used by the timeline tracker. */
const STATUS_TIMELINE = ['submitted', 'under_review', 'approved', 'enrolled'];
const TIMELINE_LABELS = {
  submitted: 'Submitted',
  under_review: 'Under Review',
  approved: 'Approved / For Assessment',
  enrolled: 'Enrolled',
};

module.exports = {
  flash, takeFlashes, audit, notify,
  csvEscape, toCsv, sendCsv,
  peso, fmtDate, fmtDateTime, fullName,
  STATUS_LABELS, STATUS_COLORS, STATUS_TIMELINE, TIMELINE_LABELS,
};
