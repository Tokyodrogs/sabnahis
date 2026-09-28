/**
 * Express application setup.
 */
const path = require('path');
const express = require('express');
const session = require('express-session');

const config = require('./config');
const { openDatabase } = require('./db');
const SqliteStore = require('./session-store');
const { loadSessionUser, sameOrigin } = require('./middleware/auth');
const helpers = require('./utils/helpers');

const db = openDatabase();

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: config.env === 'production' ? '1d' : 0,
  }));

  app.use(session({
    store: new SqliteStore(db),
    name: 'sabnahis.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.env === 'production' && process.env.FORCE_HTTPS === '1',
      maxAge: config.sessionHours * 60 * 60 * 1000,
    },
  }));

  app.use(sameOrigin);
  app.use(loadSessionUser(db));

  // Common template locals
  app.use((req, res, next) => {
    res.locals.settings = getSettings();
    res.locals.flashes = helpers.takeFlashes(req);
    res.locals.h = helpers;
    res.locals.query = req.query;
    res.locals.path = req.path;
    res.locals.currentYear = new Date().getFullYear();
    res.locals.req = req;
    next();
  });

  app.use('/', require('./routes/public'));
  app.use('/', require('./routes/student'));
  app.use('/', require('./routes/enroll'));
  app.use('/admin', require('./routes/admin'));
  app.use('/files', require('./routes/files'));

  // 404
  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Page Not Found', code: 404,
      message: 'The page you are looking for does not exist.',
    });
  });

  // Error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    const msg = err.message && /limit|file too large/i.test(err.message)
      ? 'File exceeds the 5 MB size limit.'
      : (err.message || 'Something went wrong.');
    if (req.path.startsWith('/admin') || (req.session.user && req.session.user.role !== 'applicant')) {
      helpers.flash(req, 'danger', msg);
      return res.redirect('back' in req ? req.get('Referer') || '/' : '/');
    }
    helpers.flash(req, 'danger', msg);
    res.redirect(req.get('Referer') || '/');
  });

  return app;
}

module.exports = { createApp, db, getSettings };
