/**
 * Email helper.
 *
 * No SMTP server is available in the demo environment, so outgoing mail is
 * appended to data/mail.log AND surfaced in-app (the verification / reset link
 * is shown on screen after registration or password reset).
 * Replace `send()` with nodemailer (or your provider) in production.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

function send({ to, subject, body, link }) {
  const entry = [
    `--- ${new Date().toISOString()}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    body,
    link ? `Link: ${link}` : '',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(path.dirname(config.mailLog), { recursive: true });
    fs.appendFileSync(config.mailLog, entry);
  } catch (e) {
    console.error('[mail] failed to write log:', e.message);
  }
  console.log(`[mail] to=${to} subject="${subject}"${link ? ` link=${link}` : ''}`);
  return true;
}

function verificationEmail(to, link) {
  return send({
    to,
    subject: 'Verify your email — Online Enrollment Module',
    body: 'Welcome to the Online Enrollment Module. Please verify your email address by opening the link below:',
    link,
  });
}

function resetEmail(to, link) {
  return send({
    to,
    subject: 'Reset your password — Online Enrollment Module',
    body: 'We received a request to reset your password. Open the link below to choose a new one (valid 1 hour):',
    link,
  });
}

module.exports = { send, verificationEmail, resetEmail };
