// Durable state (sessions revoked on logout, rate limits, check lock, short
// result cache) in a private Netlify Blobs store. Blobs are never served as
// static files and are not reachable from the browser.
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'hpd-sync-check-security';
let override = null;

// Tests inject an in-memory store with the same API.
export function setStoreForTests(store) { override = store; }

export class StoreUnavailable extends Error {}

export function openStore() {
  if (override) return override;
  try {
    return getStore({ name: STORE_NAME, consistency: 'strong' });
  } catch (_) {
    throw new StoreUnavailable('store unavailable');
  }
}

// Atomic read-modify-write using ETag conditions. `fn(current|null)` returns
// { value, result } to write, or { result } to leave the entry unchanged.
export async function update(store, key, fn, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    const cur = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    const out = fn(cur ? cur.data : null);
    if (!('value' in out)) return out.result;
    const opts = cur && cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true };
    const w = await store.setJSON(key, out.value, opts);
    if (w && w.modified) return out.result;
    await new Promise(r => setTimeout(r, 5 + Math.random() * 25));
  }
  throw new StoreUnavailable('contention');
}
