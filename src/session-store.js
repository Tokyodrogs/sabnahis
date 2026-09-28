/**
 * SQLite session store for express-session.
 */
const session = require('express-session');

class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY, data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      expires_at INTEGER NOT NULL)`);
    // Purge expired rows on boot and periodically
    this.purge();
    this.timer = setInterval(() => this.purge(), 10 * 60 * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  purge() {
    try { this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); } catch (_) {}
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires_at < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      const expires = (sess.cookie && sess.cookie.expires)
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + (sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : 3600000);
      this.db.prepare(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
      ).run(sid, JSON.stringify(sess), expires);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }

  destroy(sid, cb) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb && cb(null); }
    catch (e) { cb && cb(e); }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = SqliteStore;
