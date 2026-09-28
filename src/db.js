/**
 * Database bootstrap: opens the SQLite database, applies database/sabnahis.sql
 * on first run, and ensures demo account password hashes are valid.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');
const { hashPasswordSync } = require('./utils/crypto');

const SCHEMA_FILE = path.join(__dirname, '..', 'database', 'sabnahis.sql');

function openDatabase() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const marker = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!marker) {
    const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
    db.exec(sql);
    console.log('[db] Initialized schema + seed from database/sabnahis.sql');
  }

  ensureDemoPasswords(db);
  return db;
}

/**
 * Demo/default accounts ship with placeholder or stale hashes in the SQL file.
 * On first boot we replace them with real scrypt hashes for the documented
 * default credentials (see README.md). If an admin later changes a password,
 * the stored hash will verify correctly and we leave it untouched.
 */
const DEFAULT_ACCOUNTS = [
  ['admin', 'Admin@2026'],
  ['registrar', 'Registrar@2026'],
  ['cashier', 'Cashier@2026'],
  ['adviser', 'Adviser@2026'],
  ['123456789012', 'Student@2026'],
  ['987654321098', 'Student@2026'],
];

function ensureDemoPasswords(db) {
  const stmt = db.prepare('SELECT id, password_hash FROM users WHERE login_id = ?');
  const upd = db.prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?');
  for (const [loginId, defaultPw] of DEFAULT_ACCOUNTS) {
    const user = stmt.get(loginId);
    if (!user) continue;
    // If the current hash already verifies the default password, nothing to do.
    let ok = false;
    try { ok = require('crypto').timingSafeEqual(
      Buffer.from(user.password_hash.split('$')[2] || '', 'hex'),
      Buffer.from(require('crypto').scryptSync(defaultPw, user.password_hash.split('$')[1] || '', 64))
    ); } catch (_) { ok = false; }
    if (!ok) {
      const placeholder = /PLACEHOLDER|0f3a1c9d|1a2b3c4d|2b3c4d5e|3c4d5e6f/.test(user.password_hash);
      if (placeholder) {
        upd.run(hashPasswordSync(defaultPw), user.id);
        console.log(`[db] Seeded password for demo account "${loginId}"`);
      }
      // Non-placeholder hashes are real user-chosen passwords — never overwrite.
    }
  }
}

module.exports = { openDatabase };
