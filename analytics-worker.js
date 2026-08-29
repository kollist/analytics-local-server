'use strict';

// Dashboard aggregation worker. Owns a read-only connection to the same SQLite
// file the main process writes to (WAL makes concurrent read + write fine) and
// runs the heavy /api/stats and /api/errors queries here so they never block
// the main thread's HTTP handling or event ingest.

const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const Database = require('better-sqlite3');
const { computeStats, computeErrors } = require('./lib/analytics-queries');

const db = new Database(path.join(workerData.dbDir, 'analytics.sqlite'), { readonly: true });
db.pragma('cache_size = -16000');
db.pragma('mmap_size = 67108864');
db.pragma('temp_store = MEMORY');

parentPort.on('message', (msg) => {
  const { id, kind, params } = msg;
  const t0 = Date.now();
  try {
    const result = kind === 'errors' ? computeErrors(db, params) : computeStats(db, params);
    parentPort.postMessage({ id, ok: true, result, ms: Date.now() - t0 });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message, ms: Date.now() - t0 });
  }
});
