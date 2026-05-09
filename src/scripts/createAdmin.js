// Bootstrap script to create the first admin user.
//
// Usage (locally or via Render shell):
//
//   node src/scripts/createAdmin.js \
//     --email=admin@aabroo.com \
//     --password='someStrongPassword' \
//     --name='Aabroo Admin' \
//     --phone=9999999999
//
// Env vars must be set (MONGODB_URI, JWT_SECRET, etc.) — same as the
// running server.
//
// Re-running with the same email is idempotent: it just promotes the
// existing user to admin and resets the password if --password is given.

require('dotenv').config();

const mongoose = require('mongoose');
const env = require('../config/env');
const User = require('../models/User');

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map(a => a.replace(/^--/, '').split('='))
    .map(([k, ...v]) => [k, v.join('=')]),
);

const { email, password, name = 'Admin', phone = '0000000000' } = args;

if (!email || !password) {
  console.error('Usage: node src/scripts/createAdmin.js --email=... --password=... [--name=...] [--phone=...]');
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(env.MONGODB_URI);
    console.log('[createAdmin] connected to db');

    let user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (user) {
      user.role = 'admin';
      user.suspended = false;
      await user.setPassword(password);
      await user.save();
      console.log(`[createAdmin] promoted existing user ${user.email} → admin (password reset)`);
    } else {
      user = new User({
        email: String(email).toLowerCase().trim(),
        fullName: name,
        phone,
        role: 'admin',
      });
      await user.setPassword(password);
      await user.save();
      console.log(`[createAdmin] created new admin ${user.email}`);
    }

    console.log('\nAdmin login credentials:');
    console.log(`  email:    ${user.email}`);
    console.log(`  password: ${password}`);
    console.log('\nDo not commit this password anywhere. Rotate it after first login.');
  } catch (e) {
    console.error('[createAdmin] failed:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
