import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { MemoryStore, loadFunctions, setEnv, req, cookieFrom, signIn } from './helpers/harness.mjs';
import { createUpstream, installFetch } from './helpers/mock-upstream.mjs';
import { FAKE } from './helpers/fixtures.mjs';
import { issueSession } from '../netlify/lib/session.mjs';
import { loadAuthConfig } from '../netlify/lib/config.mjs';

let store, fns, up, restore;
beforeEach(async () => {
  setEnv();
  store = new MemoryStore();
  fns = await loadFunctions(store);
  up = createUpstream();
  restore = installFetch(up);
});
afterEach(() => restore());

for (const missing of ['SITE_PASSWORD', 'SESSION_SECRET']) {
  test(`missing ${missing} denies login, session and check`, async () => {
    setEnv({ [missing]: undefined });
    const l = await fns.login(req('/api/login', { body: { password: FAKE.password } }), { ip: '1.1.1.1' });
    assert.equal(l.status, 503);
    assert.equal(l.headers.get('set-cookie'), null);
    assert.equal((await fns.session(req('/api/session', { method: 'GET' }))).status, 503);
    assert.equal((await fns.check(req('/api/check', { body: {} }))).status, 503);
    assert.equal(up.calls.length, 0);
  });
}

test('weak or reused signing secret denies access', async () => {
  for (const env of [{ SESSION_SECRET: 'short' }, { SESSION_SECRET: FAKE.password.padEnd(40, 'x'), SITE_PASSWORD: FAKE.password.padEnd(40, 'x') }]) {
    setEnv(env);
    const l = await fns.login(req('/api/login', { body: { password: process.env.SITE_PASSWORD } }), { ip: '1.1.1.1' });
    assert.equal(l.status, 503);
  }
});

test('correct password issues Secure HttpOnly SameSite=Strict cookie; body never echoes it', async () => {
  const res = await fns.login(req('/api/login', { body: { password: FAKE.password } }), { ip: '1.1.1.1' });
  assert.equal(res.status, 200);
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /^__Host-hpd_session=/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) assert.ok(sc.includes(flag), flag);
  const text = await res.text();
  assert.ok(!text.includes(FAKE.password));
  assert.ok(!sc.includes(FAKE.password));
  assert.match(res.headers.get('cache-control'), /no-store/);
});

test('wrong password -> 401 generic, no cookie', async () => {
  const res = await fns.login(req('/api/login', { body: { password: 'nope' } }), { ip: '1.1.1.1' });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('login validates method, CSRF header, origin, body size and fields', async () => {
  const ctx = { ip: '1.1.1.1' };
  assert.equal((await fns.login(req('/api/login', { method: 'GET' }), ctx)).status, 405);
  assert.equal((await fns.login(req('/api/login', { body: { password: FAKE.password }, csrf: false }), ctx)).status, 403);
  assert.equal((await fns.login(req('/api/login', { body: { password: FAKE.password }, headers: { origin: 'https://evil.example' } }), ctx)).status, 403);
  const cross = req('/api/login', { body: { password: FAKE.password } });
  cross.headers.set('sec-fetch-site', 'cross-site');
  assert.equal((await fns.login(cross, ctx)).status, 403);
  assert.equal((await fns.login(req('/api/login', { body: 'x'.repeat(5000) }), ctx)).status, 413);
  assert.equal((await fns.login(req('/api/login', { body: { password: FAKE.password, admin: true } }), ctx)).status, 400);
  assert.equal((await fns.login(req('/api/login', { body: { password: 123 } }), ctx)).status, 400);
  assert.equal((await fns.login(req('/api/login?x=1', { body: { password: FAKE.password } }), ctx)).status, 400);
});

test('session restore: valid cookie -> authenticated; none -> 401', async () => {
  const cookie = await signIn(fns);
  const ok = await fns.session(req('/api/session', { method: 'GET', cookie, csrf: false }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).authenticated, true);
  const anon = await fns.session(req('/api/session', { method: 'GET', csrf: false }));
  assert.equal(anon.status, 401);
});

test('forged, tampered, expired, wrong-epoch and old-password sessions are rejected', async () => {
  const cfg = loadAuthConfig();
  const good = await signIn(fns);
  const token = good.split('=')[1];
  const [body, sig] = token.split('.');

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  const tamperedBody = Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 99999 })).toString('base64url');
  const forgedSig = createHmac('sha256', 'guessed-secret').update(body).digest('base64url');
  const expired = issueSession(cfg, Date.now() - 13 * 3600 * 1000).token;
  const otherEpoch = issueSession({ ...cfg, epoch: 'old' }).token;
  const oldPassword = issueSession({ ...cfg, password: 'previous password' }).token;
  const tooLong = issueSession({ ...cfg, sessionTtlSeconds: 999999 }).token;

  const bad = [
    'garbage', `${body}`, `${body}.${forgedSig}`, `${tamperedBody}.${sig}`, `${body}.${sig}x`,
    expired, otherEpoch, oldPassword, tooLong, '', 'a.b.c',
  ];
  for (const t of bad) {
    const cookie = `__Host-hpd_session=${t}`;
    assert.equal((await fns.session(req('/api/session', { method: 'GET', cookie, csrf: false }))).status, 401, t);
    assert.equal((await fns.check(req('/api/check', { body: {}, cookie }))).status, 401, t);
  }
  assert.equal(up.calls.length, 0, 'no upstream call for any rejected session');
});

test('changing SITE_PASSWORD invalidates existing sessions', async () => {
  const cookie = await signIn(fns);
  setEnv({ SITE_PASSWORD: 'a brand new password' });
  assert.equal((await fns.session(req('/api/session', { method: 'GET', cookie, csrf: false }))).status, 401);
});

test('changing SESSION_EPOCH or SESSION_SECRET signs everyone out', async () => {
  const cookie = await signIn(fns);
  setEnv({ SESSION_EPOCH: '2' });
  assert.equal((await fns.session(req('/api/session', { method: 'GET', cookie, csrf: false }))).status, 401);
  setEnv({ SESSION_SECRET: 'another-very-long-signing-secret-0123456789' });
  assert.equal((await fns.session(req('/api/session', { method: 'GET', cookie, csrf: false }))).status, 401);
});

test('logout revokes the session server-side (a copied cookie stops working)', async () => {
  const cookie = await signIn(fns);
  const out = await fns.logout(req('/api/logout', { body: {}, cookie }));
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  // Copy of the cookie kept elsewhere is rejected, even by a fresh invocation.
  const fresh = await loadFunctions(store);
  assert.equal((await fresh.session(req('/api/session', { method: 'GET', cookie, csrf: false }))).status, 401);
  assert.equal((await fresh.check(req('/api/check', { body: {}, cookie }))).status, 401);
  assert.equal(up.calls.length, 0);
});

test('logout requires the CSRF header', async () => {
  const cookie = await signIn(fns);
  const r = await fns.logout(req('/api/logout', { body: {}, cookie, csrf: false }));
  assert.equal(r.status, 403);
  assert.equal((await fns.session(req('/api/session', { method: 'GET', cookie, csrf: false }))).status, 200);
});

test('session expiry is enforced on the server', async () => {
  setEnv({ SESSION_TTL_HOURS: '1' });
  const cfg = loadAuthConfig();
  const issued = issueSession(cfg, Date.now() - 3601 * 1000).token;
  const cookie = `__Host-hpd_session=${issued}`;
  assert.equal((await fns.session(req('/api/session', { method: 'GET', cookie, csrf: false }))).status, 401);
  const fresh = issueSession(cfg, Date.now() - 3500 * 1000).token;
  assert.equal((await fns.session(req('/api/session', { method: 'GET', cookie: `__Host-hpd_session=${fresh}`, csrf: false }))).status, 200);
});

test('cookieFrom helper sanity', async () => {
  const res = await fns.login(req('/api/login', { body: { password: FAKE.password } }), { ip: '9.9.9.9' });
  assert.ok(cookieFrom(res));
});
