// Durable sliding-window limits shared by every function invocation.
// A slot is reserved atomically BEFORE the guarded work runs, so concurrent
// requests cannot overshoot the limit.
import { randomBytes } from 'node:crypto';
import { update } from './store.mjs';

export async function reserve(store, key, max, windowMs, now = Date.now()) {
  return update(store, key, (cur) => {
    const ev = ((cur && Array.isArray(cur.ev)) ? cur.ev : []).filter(e => e && e.t > now - windowMs);
    if (ev.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((ev[0].t + windowMs - now) / 1000));
      return { result: { ok: false, retryAfter } };
    }
    const token = randomBytes(9).toString('base64url');
    ev.push({ t: now, id: token });
    return { value: { ev }, result: { ok: true, token } };
  });
}

export async function release(store, key, token) {
  if (!token) return;
  await update(store, key, (cur) => {
    const ev = (cur && Array.isArray(cur.ev)) ? cur.ev : [];
    const next = ev.filter(e => e && e.id !== token);
    if (next.length === ev.length) return { result: null };
    return { value: { ev: next }, result: null };
  });
}

// Single-holder lock with expiry (prevents duplicate concurrent checks).
export async function acquireLock(store, key, ttlMs, now = Date.now()) {
  const owner = randomBytes(9).toString('base64url');
  return update(store, key, (cur) => {
    if (cur && cur.owner && cur.exp > now) {
      return { result: { ok: false, retryAfter: Math.max(1, Math.ceil((cur.exp - now) / 1000)) } };
    }
    return { value: { owner, exp: now + ttlMs }, result: { ok: true, owner } };
  });
}

export async function releaseLock(store, key, owner) {
  await update(store, key, (cur) => {
    if (!cur || cur.owner !== owner) return { result: null };
    return { value: { owner: null, exp: 0 }, result: null };
  });
}
