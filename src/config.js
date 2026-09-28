/**
 * Sablayan National Comprehensive High School — Online Enrollment System
 * Central configuration (env-driven with safe defaults).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  sessionSecret: process.env.SESSION_SECRET || 'sabnahis-dev-secret-change-me-in-production',
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'sabnahis.db'),
  uploadsDir: process.env.UPLOADS_DIR || path.join(ROOT, 'uploads'),
  mailLog: path.join(ROOT, 'data', 'mail.log'),

  // Security limits
  maxUploadBytes: 5 * 1024 * 1024, // 5 MB per file
  loginMaxFailures: 5,
  loginLockMinutes: 15,
  loginWindowMinutes: 15,   // per-IP sliding window
  loginMaxPerWindow: 20,
  sessionHours: 8,
  resetTokenTTLMinutes: 60,

  // Allowed upload types (sniffed from file content, never trusted from client)
  allowedUploads: {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
  },
};
