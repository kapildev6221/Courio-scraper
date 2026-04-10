/**
 * In-memory TTL cache — prevents re-scraping identical queries within a window.
 * Keyed by string, auto-evicts on expiry or when MAX_ENTRIES is reached.
 */

const DEFAULT_TTL = 10 * 60 * 1000; // 10 minutes
const MAX_ENTRIES = 500;

const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function set(key, value, ttlMs = DEFAULT_TTL) {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function del(key) {
  store.delete(key);
}

function size() {
  return store.size;
}

function stats() {
  const now = Date.now();
  let live = 0;
  let expired = 0;
  for (const entry of store.values()) {
    if (now > entry.expiresAt) expired++;
    else live++;
  }
  return { total: store.size, live, expired };
}

module.exports = { get, set, del, size, stats, DEFAULT_TTL };
