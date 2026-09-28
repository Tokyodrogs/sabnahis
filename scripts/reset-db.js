/**
 * Reset the database: deletes data/sabnahis.db and re-imports database/sabnahis.sql.
 * Usage:  npm run db:reset   (asks for confirmation via --yes to skip)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'sabnahis.db');

if (!process.argv.includes('--yes')) {
  console.log('This will DELETE the database at', dbPath);
  console.log('Re-run with --yes to confirm:  npm run db:reset -- --yes');
  process.exit(1);
}

for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
}
console.log('[reset] old database removed');

// Re-open via the app bootstrap (applies schema + demo passwords)
delete require.cache[require.resolve('../src/db')];
const { openDatabase } = require('../src/db');
openDatabase();
console.log('[reset] database re-initialized from database/sabnahis.sql');
