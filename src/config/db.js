const mongoose = require('mongoose');
const { MONGODB_URI } = require('./env');

mongoose.set('strictQuery', true);

async function connectDB() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not set');
  }
  await mongoose.connect(MONGODB_URI);
  console.log('[db] connected');
}

module.exports = { connectDB };
