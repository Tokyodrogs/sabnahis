/**
 * Password hashing (scrypt) and other crypto helpers.
 * Stored format: scrypt$<salt-hex>$<hash-hex>
 */
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;

async function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(String(plain), salt, KEYLEN);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

async function verifyPassword(plain, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== KEYLEN) return false;
  const actual = await scrypt(String(plain), salt, KEYLEN);
  return crypto.timingSafeEqual(expected, actual);
}

/** Synchronous variant used only for boot-time seeding. */
function hashPasswordSync(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(plain), salt, KEYLEN);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Reference number: ENR-<year>-<zero-padded seq>, guaranteed unique. */
function makeReferenceNo(db, year) {
  const prefix = `ENR-${year}-%`;
  const rows = db.prepare(
    'SELECT reference_no FROM enrollments WHERE reference_no IS NOT NULL AND reference_no LIKE ?'
  ).all(prefix);
  let max = 0;
  for (const r of rows) {
    const parts = String(r.reference_no).split('-');
    const n = parseInt(parts[2], 10);
    if (!isNaN(n) && n > max) max = n;
  }
  let ref;
  do {
    max += 1;
    ref = `ENR-${year}-${String(max).padStart(6, '0')}`;
  } while (db.prepare('SELECT 1 FROM enrollments WHERE reference_no = ?').get(ref));
  return ref;
}

module.exports = { hashPassword, hashPasswordSync, verifyPassword, randomToken, makeReferenceNo };
