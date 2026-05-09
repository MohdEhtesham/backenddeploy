const mongoose = require('mongoose');
const { MONGODB_URI } = require('./env');

mongoose.set('strictQuery', true);

async function connectDB() {
  if (!MONGODB_URI) {
    throw new Error(
      'MONGODB_URI is not set. Add it in Render → Environment (or copy .env.example to .env locally).',
    );
  }

  // Mask credentials in startup log
  const safe = MONGODB_URI.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
  console.log(`[db] connecting to ${safe}`);

  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 15000,
    });
    console.log('[db] connected');
  } catch (err) {
    console.error('[db] connection failed:', err.message);
    throw err;
  }
}

module.exports = { connectDB };
