// POST /api/login  { "password": "..." }  -> sets the session cookie.
import { createHmac } from 'node:crypto';
import { handler } from '../lib/guard.mjs';
import { reply, assertMethod, assertSameOrigin, assertNoQuery, readJson, onlyKeys, RequestError, logEvent } from '../lib/http.mjs';
import { checkPassword, issueSession, sessionCookie } from '../lib/session.mjs';
import { reserve, release } from '../lib/limits.mjs';

export default handler('login', async (req, { cfg, store, context }) => {
  assertMethod(req, 'POST');
  assertSameOrigin(req);
  assertNoQuery(req);
  const body = await readJson(req, 1024);
  onlyKeys(body, ['password']);
  const pw = body.password;
  if (typeof pw !== 'string' || pw.length < 1 || pw.length > 256) throw new RequestError(400, 'Password required');

  const ip = context.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  const ipKey = 'login/ip/' + createHmac('sha256', cfg.secret).update('ip:' + ip).digest('hex').slice(0, 32);
  const globalKey = 'login/global';
  const { maxPerIp, maxGlobal, windowMs } = cfg.login;

  // Reserve a failure slot before verifying, so parallel guesses cannot exceed the limit.
  const a = await reserve(store, ipKey, maxPerIp, windowMs);
  if (!a.ok) return limited(a.retryAfter);
  const g = await reserve(store, globalKey, maxGlobal, windowMs);
  if (!g.ok) { await release(store, ipKey, a.token); return limited(g.retryAfter); }

  if (!checkPassword(cfg, pw)) {
    logEvent('info', 'login_failed');
    return reply(401, { error: 'Incorrect password.' });
  }
  // Success does not count against the limit.
  await release(store, ipKey, a.token);
  await release(store, globalKey, g.token);
  const { token, payload } = issueSession(cfg);
  logEvent('info', 'login_ok');
  return reply(200, { authenticated: true, expiresAt: payload.exp * 1000 }, {
    'Set-Cookie': sessionCookie(token, cfg.sessionTtlSeconds),
  });
});

function limited(retryAfter) {
  logEvent('info', 'login_limited');
  return reply(429, { error: 'Too many attempts. Try again later.' }, { 'Retry-After': String(retryAfter) });
}

export const config = { path: '/api/login' };
