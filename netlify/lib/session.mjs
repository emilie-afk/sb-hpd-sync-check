// Signed, expiring session cookies. The password is checked once at login;
// afterwards the browser only holds an HttpOnly cookie it cannot read.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = '__Host-hpd_session';
const VERSION = 1;

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function signingKey(cfg) {
  return hmac(cfg.secret, 'hpd-session-signing-v1');
}

// Ties every session to the current password: changing SITE_PASSWORD
// invalidates all sessions issued under the old one.
function passwordFingerprint(cfg) {
  return hmac(cfg.secret, 'hpd-password-fp-v1:' + cfg.password).toString('base64url').slice(0, 22);
}

export function safeEqual(a, b) {
  const ka = hmac('cmp', String(a));
  const kb = hmac('cmp', String(b));
  return timingSafeEqual(ka, kb);
}

export function checkPassword(cfg, provided) {
  return typeof provided === 'string' && safeEqual(provided, cfg.password);
}

export function issueSession(cfg, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const payload = {
    v: VERSION,
    sid: randomBytes(16).toString('base64url'),
    iat,
    exp: iat + cfg.sessionTtlSeconds,
    ep: cfg.epoch,
    pf: passwordFingerprint(cfg),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = hmac(signingKey(cfg), body).toString('base64url');
  return { token: `${body}.${sig}`, payload };
}

// Returns the payload, or null for anything forged, tampered, expired or stale.
export function verifyToken(cfg, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = hmac(signingKey(cfg), body);
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch (_) { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
  const t = Math.floor(now / 1000);
  if (!p || p.v !== VERSION || typeof p.sid !== 'string') return null;
  if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp)) return null;
  if (p.exp <= t || p.iat > t + 60) return null;
  if (p.exp - p.iat > cfg.sessionTtlSeconds) return null;
  if (p.ep !== cfg.epoch) return null;
  if (!safeEqual(p.pf, passwordFingerprint(cfg))) return null;
  return p;
}

export function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(token, maxAge) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

const revokedKey = (sid) => `revoked/${sid}`;

export async function isRevoked(store, sid) {
  const r = await store.get(revokedKey(sid), { type: 'json', consistency: 'strong' });
  return !!r;
}

export async function revoke(store, payload) {
  await store.setJSON(revokedKey(payload.sid), { exp: payload.exp });
}

// Full server-side check: signature, expiry, epoch, password, revocation.
export async function authenticate(req, cfg, store, now = Date.now()) {
  const p = verifyToken(cfg, readCookie(req), now);
  if (!p) return null;
  if (await isRevoked(store, p.sid)) return null;
  return p;
}
