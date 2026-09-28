/**
 * Public routes: landing page, login, registration, email verification,
 * forgot / reset password, logout.
 */
const express = require('express');
const { hashPassword, randomToken } = require('../utils/crypto');
const { flash, audit, notify } = require('../utils/helpers');
const mailer = require('../utils/mailer');
const config = require('../config');
const {
  ipRateLimit, attemptLogin, requireAuth,
} = require('../middleware/auth');
const { db } = require('../app');

const router = express.Router();

const LRN_RE = /^\d{12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function settingsMap() {
  const s = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) s[r.key] = r.value;
  return s;
}

/* ------------------------------------------------------------------ landing */
router.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'applicant' ? '/dashboard' : '/admin');
  }
  res.render('landing', {
    title: 'Online Enrollment',
    bodyClass: 'landing-body',
    settings: settingsMap(),
    loginRequired: req.query.login === 'required',
  });
});

/* -------------------------------------------------------------------- login */
router.post('/login', ipRateLimit, async (req, res, next) => {
  try {
    const { login, password } = req.body;
    if (!login || !password) {
      flash(req, 'danger', 'Please enter your username/LRN and password.');
      return res.redirect('/');
    }
    const result = await attemptLogin(db, req, login, password);
    if (!result.ok) {
      const messages = {
        invalid: 'Incorrect username/LRN or password.'
          + (result.remaining != null ? ` (${result.remaining} attempt(s) left before lockout)` : ''),
        disabled: 'This account has been disabled. Please contact the registrar.',
        locked: 'Account temporarily locked due to too many failed attempts. Try again in a few minutes.',
      };
      audit(db, req, 'login_failed', 'user', null, `login=${login} reason=${result.reason}`);
      flash(req, 'danger', messages[result.reason] || 'Login failed.');
      return res.redirect('/');
    }
    audit(db, req, 'login', 'user', result.user.id, `login=${result.user.login_id}`);
    const back = req.session.returnTo;
    delete req.session.returnTo;
    if (result.user.role === 'applicant') return res.redirect(back && back.startsWith('/enroll') ? back : '/dashboard');
    return res.redirect(back && back.startsWith('/admin') ? back : '/admin');
  } catch (e) { next(e); }
});

router.post('/logout', requireAuth, (req, res) => {
  audit(db, req, 'logout', 'user', req.session.userId, null);
  req.session.destroy(() => res.redirect('/'));
});

/* -------------------------------------------------------------- registration */
router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/register', {
    title: 'Create an Account',
    bodyClass: 'auth-body',
    settings: settingsMap(),
    form: { enrollment_type: req.query.type || 'new' },
    sent: null,
  });
});

router.post('/register', ipRateLimit, async (req, res, next) => {
  try {
    const {
      full_name, email, password, confirm_password, enrollment_type,
    } = req.body;
    const errors = [];
    if (!full_name || full_name.trim().length < 4) errors.push('Please enter the student\'s full name.');
    if (!email || !EMAIL_RE.test(email)) errors.push('Please enter a valid email address.');
    if (!password || password.length < 8) errors.push('Password must be at least 8 characters.');
    if (password !== confirm_password) errors.push('Passwords do not match.');
    if (!['new', 'transferee'].includes(enrollment_type)) errors.push('Please choose an enrollment type.');

    if (errors.length) {
      flash(req, 'danger', errors.join(' '));
      return res.render('auth/register', {
        title: 'Create an Account', bodyClass: 'auth-body',
        settings: settingsMap(), form: req.body, sent: null,
      });
    }

    const exists = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email.trim());
    if (exists) {
      flash(req, 'danger', 'An account with this email already exists. Try logging in instead.');
      return res.redirect('/register');
    }

    // Auto username: SAB-XXXXXX
    let loginId;
    do { loginId = 'SAB-' + randomToken(3).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6).padEnd(6, 'X'); }
    while (db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(loginId));

    const token = randomToken();
    const pwHash = await hashPassword(password);
    const nameParts = full_name.trim().split(/\s+/);
    const last = nameParts.length > 1 ? nameParts.pop() : nameParts[0];
    const first = nameParts.shift() || last;

    const tx = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO users (login_id, email, password_hash, full_name, role, email_verified, verify_token)
         VALUES (?, ?, ?, ?, 'applicant', 0, ?)`
      ).run(loginId, email.trim(), pwHash, full_name.trim(), token);
      const userId = info.lastInsertRowid;
      db.prepare(
        `INSERT INTO students (user_id, first_name, last_name, enrollment_type)
         VALUES (?, ?, ?, ?)`
      ).run(userId, first, last, enrollment_type);
      return userId;
    });
    const userId = tx();

    const verifyUrl = `${req.protocol}://${req.get('host')}/verify-email?token=${token}`;
    mailer.verificationEmail(email.trim(), verifyUrl);
    audit(db, req, 'register', 'user', userId, `email=${email}`);

    req.session.userId = userId;
    req.session.user = {
      id: userId, login_id: loginId, email: email.trim(),
      full_name: full_name.trim(), role: 'applicant', email_verified: false,
    };

    res.render('auth/register', {
      title: 'Account Created', bodyClass: 'auth-body',
      settings: settingsMap(), form: {},
      sent: { loginId, verifyUrl, email: email.trim() },
    });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------- email verification */
router.get('/verify-email', async (req, res, next) => {
  try {
    const { token } = req.query;
    const user = token
      ? db.prepare('SELECT id FROM users WHERE verify_token = ?').get(String(token))
      : null;
    if (!user) {
      flash(req, 'danger', 'Invalid or expired verification link.');
      return res.redirect('/');
    }
    db.prepare('UPDATE users SET email_verified = 1, verify_token = NULL, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?')
      .run(user.id);
    audit(db, req, 'email_verified', 'user', user.id, null);
    flash(req, 'success', 'Your email address has been verified. Thank you!');
    if (req.session.user && req.session.user.id === user.id) {
      req.session.user.email_verified = true;
      return res.redirect('/dashboard');
    }
    res.redirect('/');
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ forgot password */
router.get('/forgot-password', (req, res) => {
  res.render('auth/forgot', {
    title: 'Forgot Password', bodyClass: 'auth-body',
    settings: settingsMap(), sent: null,
  });
});

router.post('/forgot-password', ipRateLimit, (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim();
    const user = db.prepare('SELECT id, email FROM users WHERE lower(email) = lower(?)').get(email);
    let sent = { email };
    if (user) {
      const token = randomToken();
      const expires = new Date(Date.now() + config.resetTokenTTLMinutes * 60000).toISOString();
      db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?').run(token, expires, user.id);
      const url = `${req.protocol}://${req.get('host')}/reset-password?token=${token}`;
      mailer.resetEmail(user.email, url);
      sent.resetUrl = url;
      audit(db, req, 'password_reset_requested', 'user', user.id, null);
    }
    // Always show the same screen (no account enumeration).
    res.render('auth/forgot', {
      title: 'Forgot Password', bodyClass: 'auth-body',
      settings: settingsMap(), sent,
    });
  } catch (e) { next(e); }
});

router.get('/reset-password', (req, res) => {
  const { token } = req.query;
  const user = token
    ? db.prepare('SELECT id FROM users WHERE reset_token = ? AND reset_expires > ?')
        .get(String(token), new Date().toISOString())
    : null;
  if (!user) {
    flash(req, 'danger', 'This password reset link is invalid or has expired.');
    return res.redirect('/forgot-password');
  }
  res.render('auth/reset', {
    title: 'Reset Password', bodyClass: 'auth-body',
    settings: settingsMap(), token: String(token), error: null,
  });
});

router.post('/reset-password', ipRateLimit, async (req, res, next) => {
  try {
    const { token, password, confirm_password } = req.body;
    const user = db.prepare('SELECT id FROM users WHERE reset_token = ? AND reset_expires > ?')
      .get(String(token || ''), new Date().toISOString());
    if (!user) {
      flash(req, 'danger', 'This password reset link is invalid or has expired.');
      return res.redirect('/forgot-password');
    }
    if (!password || password.length < 8) {
      return res.render('auth/reset', {
        title: 'Reset Password', bodyClass: 'auth-body',
        settings: settingsMap(), token, error: 'Password must be at least 8 characters.',
      });
    }
    if (password !== confirm_password) {
      return res.render('auth/reset', {
        title: 'Reset Password', bodyClass: 'auth-body',
        settings: settingsMap(), token, error: 'Passwords do not match.',
      });
    }
    db.prepare(
      `UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL,
        failed_attempts = 0, locked_until = NULL, updated_at = datetime('now','localtime')
       WHERE id = ?`
    ).run(await hashPassword(password), user.id);
    audit(db, req, 'password_reset', 'user', user.id, null);
    flash(req, 'success', 'Password updated. You can now log in.');
    res.redirect('/');
  } catch (e) { next(e); }
});

module.exports = router;
