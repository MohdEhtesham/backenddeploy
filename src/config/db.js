const mongoose = require('mongoose');
const { MONGODB_URI } = require('./env');

mongoose.set('strictQuery', true);

// Last error captured so /diagnostics can expose a sanitized summary
let lastError = null;

function maskUri(uri) {
  return uri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
}

async function connectOnce() {
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 30000,
    socketTimeoutMS: 60000,
  });
}

async function connectDB({ retries = 5, backoffMs = 5000 } = {}) {
  if (!MONGODB_URI) {
    const err = new Error(
      'MONGODB_URI is not set. Add it in Render → Environment.',
    );
    lastError = { name: 'ConfigError', message: err.message };
    throw err;
  }

  console.log(`[db] connecting to ${maskUri(MONGODB_URI)}`);

  let attempt = 0;
  while (attempt < retries) {
    attempt++;
    try {
      await connectOnce();
      console.log(`[db] connected (attempt ${attempt})`);
      lastError = null;

      // Auto-reconnect events
      mongoose.connection.on('disconnected', () => {
        console.warn('[db] disconnected — mongoose will attempt to reconnect');
      });
      mongoose.connection.on('reconnected', () => {
        console.log('[db] reconnected');
      });
      mongoose.connection.on('error', err => {
        console.error('[db] error:', err.message);
      });

      return;
    } catch (err) {
      lastError = {
        name: err?.name,
        code: err?.code,
        codeName: err?.codeName,
        message: err?.message,
        attempt,
        at: new Date().toISOString(),
      };

      console.error(
        `[db] connect attempt ${attempt}/${retries} failed: ${err?.name || ''} ${err?.message || ''}`,
      );

      if (attempt >= retries) {
        throw err;
      }
      console.log(`[db] retrying in ${backoffMs / 1000}s…`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}

function getStatus() {
  const stateMap = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  return {
    state: stateMap[mongoose.connection.readyState] ?? 'unknown',
    readyState: mongoose.connection.readyState,
    host: mongoose.connection.host || null,
    name: mongoose.connection.name || null,
    lastError,
  };
}

module.exports = { connectDB, getStatus };
