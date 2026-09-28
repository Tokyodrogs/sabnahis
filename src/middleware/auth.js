/**
 * Authentication / authorization middleware and guards.
 */
const { verifyPassword } = require('../utils/crypto');

/* ------------------------------------------------------------- permissions */
const PERMISSIONS = {
  dashboard:    ['super_admin', 'registrar', 'cashier', 'adviser'],
  applicants:   ['super_admin', 'registrar'],
  enrollment:   ['super_admin', 'registrar'],
  academic:     ['super_admin', 'registrar'],
  requirements: ['super_admin', 'registrar'],
  payments:     ['super_admin', 'cashier', 'registrar'],
  users:        ['super_admin'],
  reports:      ['super_admin', 'registrar', 'cashier', 'adviser'],
  settings:     ['super_admin'],
  audit:        ['super_admin'],
};
function can(role, perm) {
  const list = PERMISSIONS[perm] || [];
  return list.includes(role);
}

/* ------------------------------------------------------------------ guards */
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  req.session.returnTo = req.originalUrl;
  return res.redirect('/?login=required');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (req.session.user && roles.includes(req.session.user.role)) return next();
    if (req.session.user) return res.status(403).render('error', {
      title: 'Access Denied',
      code: 403,
      message: 'Your account does not have permission to access that page.',
    });
    return res.redirect('/?login=required');
  };
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (req.session.user && can(req.session.user.role, perm)) return next();
    if (req.session.user) {
      return res.status(403).render('error', {
        title: 'Access Denied', code: 403,
        message: 'Your account does not have permission to access that page.',
      });
    }
    return res.redirect('/?login=required');
  };
}

function requireVerifiedEmail(req, res, next) {
  const u = req.session.user;
  if (u && u.role === 'applicant' && !u.email_verified) {
    // Allow everything except final submission of an enrollment application.
    if (req.method === 'POST' && req.path.startsWith('/enroll/submit')) {
      return res.status(403).render('error', {
        title: 'Email Not Verified', code: 403,
        message: 'Please verify your email address first. Check your inbox (demo: see the link on the verification page) and click the verification link.',
      });
    }
  }
  next();
}

/* ------------------------------------------------------- login rate limits */
const attempts = new Map(); // ip -> [timestamps]

function ipRateLimit(req, res, next) {
  const now = Date.now();
  const windowMs = require('../config').loginWindowMinutes * 60 * 1000;
  const max = require('../config').loginMaxPerWindow;
  let list = attempts.get(req.ip) || [];
  list = list.filter((t) => now - t < windowMs);
  if (list.length >= max) {
    attempts.set(req.ip, list);
    return res.status(429).render('error', {
      title: 'Too Many Attempts', code: 429,
      message: 'Too many login attempts. Please wait a few minutes and try again.',
    });
  }
  list.push(now);
  attempts.set(req.ip, list);
  next();
}

/* Same-origin guard for state-changing requests (basic CSRF defence;
   session cookie is also SameSite=Lax + httpOnly). */
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin
    || (req.headers.referer ? new URL(req.headers.referer).origin : null);
  if (!origin) return next(); // non-browser client
  const host = req.headers.host;
  if (origin === `http://${host}` || origin === `https://${host}`) return next();
  return res.status(403).render('error', {
    title: 'Request Blocked', code: 403,
    message: 'Cross-origin request blocked.',
  });
}

/* ----------------------------------------------------------- login helper */
async function attemptLogin(db, req, loginId, password) {
  const config = require('../config');
  const user = db.prepare(
    'SELECT * FROM users WHERE lower(login_id) = lower(?) OR lower(email) = lower(?)'
  ).get(String(loginId || '').trim(), String(loginId || '').trim());

  if (!user) return { ok: false, reason: 'invalid' };
  if (user.status !== 'active') return { ok: false, reason: 'disabled' };

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return { ok: false, reason: 'locked', until: user.locked_until };
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    const fails = (user.failed_attempts || 0) + 1;
    let lockedUntil = null;
    if (fails >= config.loginMaxFailures) {
      lockedUntil = new Date(Date.now() + config.loginLockMinutes * 60000).toISOString();
    }
    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?')
      .run(fails, lockedUntil, user.id);
    return { ok: false, reason: 'invalid', remaining: Math.max(0, config.loginMaxFailures - fails) };
  }

  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login = datetime(\'now\',\'localtime\') WHERE id = ?')
    .run(user.id);

  req.session.userId = user.id;
  req.session.user = {
    id: user.id,
    login_id: user.login_id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    email_verified: !!user.email_verified,
  };
  return { ok: true, user };
}

/* ---------------------------------------------------------- session loader */
function loadSessionUser(db) {
  return (req, res, next) => {
    res.locals.user = null;
    res.locals.flashes = [];
    if (req.session && req.session.userId) {
      const u = db.prepare('SELECT id, login_id, email, full_name, role, status, email_verified FROM users WHERE id = ?')
        .get(req.session.userId);
      if (u && u.status !== 'active') {
        delete req.session.userId;
        delete req.session.user;
        return next();
      }
      if (u) {
        req.session.user = {
          id: u.id, login_id: u.login_id, email: u.email,
          full_name: u.full_name, role: u.role, email_verified: !!u.email_verified,
        };
        res.locals.user = req.session.user;
        if (u.role === 'applicant') {
          const st = db.prepare('SELECT enrollment_type FROM students WHERE user_id = ?').get(u.id);
          res.locals.userEnrollmentType = st ? st.enrollment_type : null;
        }
      } else {
        delete req.session.userId;
        delete req.session.user;
      }
    }
    next();
  };
}

module.exports = {
  PERMISSIONS, can, requireAuth, requireRole, requirePermission,
  requireVerifiedEmail, ipRateLimit, sameOrigin, attemptLogin, loadSessionUser,
};
