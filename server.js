/**
 * SABNAHIS — High School Online Enrollment System
 * Entry point.  Start with:  npm start
 */
const config = require('./src/config');
const { createApp } = require('./src/app');

const app = createApp();

app.listen(config.port, '0.0.0.0', () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────────────┐');
  console.log('  │  SABNAHIS — Online Enrollment Module                │');
  console.log('  │  Server running on http://0.0.0.0:' + String(config.port).padEnd(36) + '│');
  console.log('  │  Environment: ' + config.env.padEnd(39) + '│');
  console.log('  └─────────────────────────────────────────────────────┘');
  console.log('');
});
