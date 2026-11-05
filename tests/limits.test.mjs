import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, loadFunctions, setEnv, req } from './helpers/harness.mjs';
import { FAKE } from './helpers/fixtures.mjs';

let store;
beforeEach(() => { setEnv(); store = new MemoryStore(); });

const guess = (fns, ip, password = 'wrong') =>
  fns.login(req('/api/login', { body: { password } }), { ip });

test('per-IP login failure limit holds across separate invocations', async () => {
  setEnv({ LOGIN_MAX_FAILURES_PER_IP: '3' });
  for (let i = 0; i < 3; i++) {
    const fns = await loadFunctions(store);
    assert.equal((await guess(fns, '192.0.2.1')).status, 401);
  }
  const fns = await loadFunctions(store);
  const r = await guess(fns, '192.0.2.1');
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  // Even the right password is refused while limited.
  assert.equal((await guess(fns, '192.0.2.1', FAKE.password)).status, 429);
  // Another IP is unaffected.
  assert.equal((await guess(fns, '192.0.2.2', FAKE.password)).status, 200);
});

test('successful logins do not consume the failure budget', async () => {
  setEnv({ LOGIN_MAX_FAILURES_PER_IP: '2' });
  const fns = await loadFunctions(store);
  for (let i = 0; i < 5; i++) assert.equal((await guess(fns, '192.0.2.5', FAKE.password)).status, 200);
  assert.equal((await guess(fns, '192.0.2.5')).status, 401);
});

test('global login limit across many IPs', async () => {
  setEnv({ LOGIN_MAX_FAILURES_GLOBAL: '4' });
  const fns = await loadFunctions(store);
  for (let i = 0; i < 4; i++) assert.equal((await guess(fns, `192.0.2.${10 + i}`)).status, 401);
  assert.equal((await guess(fns, '192.0.2.99')).status, 429);
});

test('parallel wrong guesses from separate invocations cannot exceed the limit', async () => {
  setEnv({ LOGIN_MAX_FAILURES_PER_IP: '5' });
  const instances = await Promise.all(Array.from({ length: 4 }, () => loadFunctions(store)));
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => guess(instances[i % 4], '192.0.2.50')));
  const statuses = results.map(r => r.status);
  assert.equal(statuses.filter(s => s === 401).length, 5, statuses.join(','));
  assert.equal(statuses.filter(s => s === 429).length, 11);
});

test('failures expire after the window', async () => {
  setEnv({ LOGIN_MAX_FAILURES_PER_IP: '1', LOGIN_WINDOW_MINUTES: '1' });
  const fns = await loadFunctions(store);
  assert.equal((await guess(fns, '192.0.2.60')).status, 401);
  assert.equal((await guess(fns, '192.0.2.60')).status, 429);
  // Age the stored attempts by 61 s.
  for (const [k, e] of store.map) {
    if (!k.startsWith('login/')) continue;
    const v = JSON.parse(e.v);
    v.ev = v.ev.map(x => ({ ...x, t: x.t - 61000 }));
    e.v = JSON.stringify(v);
  }
  assert.equal((await guess(fns, '192.0.2.60')).status, 401);
});

test('client IPs are stored only as keyed hashes', async () => {
  const fns = await loadFunctions(store);
  await guess(fns, '192.0.2.77');
  const dump = JSON.stringify([...store.map]);
  assert.ok(!dump.includes('192.0.2.77'));
});
