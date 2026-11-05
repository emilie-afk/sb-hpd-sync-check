import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MemoryStore, loadFunctions, setEnv, req, signIn, captureLogs } from './helpers/harness.mjs';
import { createUpstream, installFetch, json, stalledBody } from './helpers/mock-upstream.mjs';
import { FAKE, bigCatalog } from './helpers/fixtures.mjs';

const golden = JSON.parse(readFileSync(new URL('./fixtures/golden-original.json', import.meta.url)));

let store, fns, restore;
beforeEach(async () => {
  setEnv();
  store = new MemoryStore();
  fns = await loadFunctions(store);
});
afterEach(() => restore && restore());

function useUpstream(opts) {
  if (restore) restore();
  const up = createUpstream(opts);
  restore = installFetch(up);
  return up;
}

async function runCheck(cookie, opts) {
  return fns.check(req('/api/check', { body: {}, cookie, ...opts }));
}

// ── Authorization before any external call ──────────────────────────────────
test('anonymous check -> 401 and no upstream call', async () => {
  const up = useUpstream();
  const r = await runCheck(undefined);
  assert.equal(r.status, 401);
  assert.equal(up.calls.length, 0);
});

test('browser flags and the old password header cannot authorize a check', async () => {
  const up = useUpstream();
  const attempts = [
    req('/api/check', { body: {}, headers: { 'x-site-password': FAKE.password } }),
    req('/api/check', { body: { authenticated: true } }),
    req('/api/check?authenticated=true', { body: {} }),
    req('/api/check', { body: {}, headers: { 'x-authenticated': 'true', authorization: 'Bearer ' + FAKE.password } }),
    req('/api/check', { body: {}, cookie: 'authenticated=true; hpd_pw=' + encodeURIComponent(FAKE.password) }),
  ];
  for (const a of attempts) assert.equal((await fns.check(a)).status, 401);
  assert.equal(up.calls.length, 0);
});

test('check rejects GET, missing CSRF header, cross-origin, params, big bodies — before upstream', async () => {
  const up = useUpstream();
  const cookie = await signIn(fns);
  assert.equal((await fns.check(req('/api/check', { method: 'GET', cookie }))).status, 405);
  assert.equal((await runCheck(cookie, { csrf: false })).status, 403);
  assert.equal((await runCheck(cookie, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fns.check(req('/api/check?sheet=abc', { body: {}, cookie }))).status, 400);
  assert.equal((await fns.check(req('/api/check', { body: { spreadsheetId: 'x', url: 'https://evil.example' }, cookie }))).status, 400);
  assert.equal((await fns.check(req('/api/check', { body: 'x'.repeat(1000), cookie }))).status, 413);
  assert.equal(up.calls.length, 0);
});

// ── Configuration ───────────────────────────────────────────────────────────
for (const name of ['HPD_INVENTORY_SHEET_ID', 'PRODUCTS_MASTER_SHEET_ID', 'PRODUCTS_MASTER_TAB_GID', 'GOOGLE_SHEETS_API_KEY']) {
  test(`missing ${name} -> safe 503, no upstream, no fallback sheet`, async () => {
    const up = useUpstream();
    const cookie = await signIn(fns);
    setEnv({ [name]: undefined });
    const { r, lines } = await captureLogs(() => runCheck(cookie));
    assert.equal(r.status, 503);
    const body = await r.text();
    assert.match(body, /not configured/);
    assert.ok(!body.includes(name), 'variable names stay in logs, not responses');
    assert.equal(up.calls.length, 0);
    assert.ok(lines.some(l => l.includes('config_incomplete') && l.includes(name)));
  });
}

// ── Parity with the original implementation ─────────────────────────────────
function strip(body) {
  const { ts, complete, warnings, unverified, cached, cachedAgeSeconds, ...rest } = body;
  return rest;
}

test('matching parity: synthetic fixture equals original output', async () => {
  useUpstream();
  const cookie = await signIn(fns);
  const r = await runCheck(cookie);
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.complete, true);
  assert.deepEqual(b.warnings, []);
  assert.deepEqual(b.unverified, []);
  assert.deepEqual(strip(b), golden.base.body);
});

test('matching parity: multi-page catalog (600 products) equals original output', async () => {
  const big = bigCatalog(600);
  useUpstream({ products: big.products, inventory: big.inv });
  setEnv({ CHECK_BUDGET_MS: '20000' });
  const cookie = await signIn(fns);
  const b = await (await runCheck(cookie)).json();
  assert.equal(b.complete, true);
  assert.deepEqual(strip(b), golden.paged.body);
});

test('six-page cap kept, but now labelled incomplete', async () => {
  const big = bigCatalog(1600);
  useUpstream({ products: big.products, inventory: big.inv });
  setEnv({ CHECK_BUDGET_MS: '25000' });
  const cookie = await signIn(fns);
  const b = await (await runCheck(cookie)).json();
  assert.equal(b.complete, false);
  assert.deepEqual(b.warnings, ['hpd_truncated']);
  assert.deepEqual(strip(b), golden.truncated.body);
});

// ── Source failures never look like success ─────────────────────────────────
const failureCases = [
  ['HPD 500', 'hpd', () => new Response('err', { status: 500 })],
  ['HPD invalid JSON', 'hpd', () => new Response('<html>', { status: 200 })],
  ['HPD wrong shape', 'hpd', () => json({ items: [] })],
  ['inventory 403', 'sheets-inventory', () => json({ error: { message: 'forbidden' } }, 403)],
  ['inventory wrong shape', 'sheets-inventory', () => json({ values: 'nope' })],
  ['reference meta 404', 'sheets-meta', () => json({ error: {} }, 404)],
  ['reference values 400', 'sheets-reference', () => json({ error: {} }, 400)],
  ['network error', 'sheets-inventory', () => Promise.reject(new TypeError('fetch failed'))],
];
for (const [label, kind, make] of failureCases) {
  test(`${label} -> 502 with no comparison and no raw upstream detail`, async () => {
    useUpstream({ override: (k) => (k === kind ? make() : undefined) });
    const cookie = await signIn(fns);
    const { r, lines } = await captureLogs(() => runCheck(cookie));
    assert.equal(r.status, 502);
    const b = await r.json();
    assert.equal(b.results, undefined);
    assert.equal(b.count, undefined);
    assert.match(b.error, /No comparison was produced/);
    const all = JSON.stringify(b) + lines.join('\n');
    for (const secret of [FAKE.inventoryId, FAKE.referenceId, FAKE.apiKey, 'forbidden', 'stack']) {
      assert.ok(!all.includes(secret), `leaked ${secret}`);
    }
  });
}

test('HPD failure on a later page is an error, not a shorter catalog', async () => {
  const big = bigCatalog(600);
  useUpstream({
    products: big.products, inventory: big.inv,
    override: (k, u) => (k === 'hpd' && u.searchParams.get('page') === '2' ? new Response('x', { status: 503 }) : undefined),
  });
  setEnv({ CHECK_BUDGET_MS: '20000' });
  const cookie = await signIn(fns);
  assert.equal((await runCheck(cookie)).status, 502);
});

test('empty sources are flagged incomplete, never a clean "0 missing"', async () => {
  useUpstream({ products: [], inventory: [['SKU']] });
  const cookie = await signIn(fns);
  const b = await (await runCheck(cookie)).json();
  assert.equal(b.count, 0);
  assert.equal(b.complete, false);
  assert.ok(b.warnings.includes('hpd_empty'));
  assert.ok(b.warnings.includes('inventory_empty'));
});

test('storefront failures -> "unverified", not "missing"; result marked partial', async () => {
  useUpstream({ override: (k, u) => (k === 'storefront' && u.pathname.includes('mystery-fern') ? new Response('x', { status: 500 }) : undefined) });
  const cookie = await signIn(fns);
  const b = await (await runCheck(cookie)).json();
  assert.equal(b.complete, false);
  assert.deepEqual(b.warnings, ['storefront_unverified']);
  assert.ok(!b.results.some(x => x.title === 'Mystery Fern'));
  assert.ok(b.unverified.some(x => x.title === 'Mystery Fern'));
  assert.equal(b.count, golden.base.body.count - 1);
});

test('transient upstream errors are retried once (bounded)', async () => {
  let n = 0;
  const up = useUpstream({ override: (k) => (k === 'sheets-inventory' && n++ < 1 ? new Response('busy', { status: 503 }) : undefined) });
  const cookie = await signIn(fns);
  assert.equal((await runCheck(cookie)).status, 200);
  assert.equal(up.calls.filter(c => c.kind === 'sheets-inventory').length, 2);

  let m = 0;
  const up2 = useUpstream({ override: (k) => (k === 'sheets-inventory' ? (m++, new Response('busy', { status: 503 })) : undefined) });
  const cookie2 = await signIn(fns, '203.0.113.99');
  assert.equal((await runCheck(cookie2)).status, 502);
  assert.equal(up2.calls.filter(c => c.kind === 'sheets-inventory').length, 2, 'one retry only');
});

test('deadline covers response-body reads (stalled body stops at the budget)', async () => {
  setEnv({ CHECK_BUDGET_MS: '2000' });
  useUpstream({ override: (k, u, init) => (k === 'hpd' ? stalledBody(init.signal) : undefined) });
  const cookie = await signIn(fns);
  const t0 = Date.now();
  const r = await runCheck(cookie);
  const took = Date.now() - t0;
  assert.equal(r.status, 502);
  assert.ok(took < 3500, `took ${took} ms`);
});

test('oversized upstream body is rejected', async () => {
  useUpstream({ override: (k) => (k === 'sheets-meta' ? new Response('x'.repeat(6 * 1024 * 1024), { status: 200 }) : undefined) });
  const cookie = await signIn(fns);
  assert.equal((await runCheck(cookie)).status, 502);
});

test('redirects: allowed hosts followed, others refused', async () => {
  const up = useUpstream({
    override: (k, u) => {
      if (k === 'storefront' && u.pathname === '/products/mystery-fern.js') {
        return new Response(null, { status: 301, headers: { location: 'https://www.succulentsbox.com/products/mystery-fern-renamed.js' } });
      }
      if (u.hostname === 'www.succulentsbox.com') return json({ variants: [{ available: true }] });
      if (k === 'hpd') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
      return undefined;
    },
  });
  const cookie = await signIn(fns);
  const r = await runCheck(cookie);
  assert.equal(r.status, 502, 'HPD redirect to a non-allowlisted host is refused');
  assert.ok(!up.calls.some(c => c.url.includes('169.254')));

  const up2 = useUpstream({
    override: (k, u) => {
      if (k === 'storefront' && u.pathname === '/products/mystery-fern.js') {
        return new Response(null, { status: 301, headers: { location: 'https://www.succulentsbox.com/products/mystery-fern-renamed.js' } });
      }
      if (u.hostname === 'www.succulentsbox.com') return json({ variants: [{ available: true }] });
      return undefined;
    },
  });
  const b = await (await fns.check(req('/api/check', { body: {}, cookie }))).json();
  assert.ok(!b.results.some(x => x.title === 'Mystery Fern'), 'redirected storefront page counted as synced (same as before)');
  assert.ok(up2.calls.some(c => c.url.startsWith('https://www.succulentsbox.com/')));
});

// ── Duplicate work and limits ───────────────────────────────────────────────
test('concurrent checks: only one runs upstream; the other gets 409', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const up = useUpstream({ override: async (k) => { if (k === 'hpd') await gate; return undefined; } });
  const cookie = await signIn(fns);
  const other = await loadFunctions(store); // separate invocation
  const p1 = runCheck(cookie);
  await new Promise(r => setTimeout(r, 30));
  const r2 = await other.check(req('/api/check', { body: {}, cookie }));
  assert.equal(r2.status, 409);
  release();
  assert.equal((await p1).status, 200);
  assert.equal(up.calls.filter(c => c.kind === 'hpd').length, 1);
});

test('short private cache avoids repeat upstream work', async () => {
  setEnv({ CHECK_CACHE_SECONDS: '30' });
  const up = useUpstream();
  const cookie = await signIn(fns);
  const a = await (await runCheck(cookie)).json();
  const before = up.calls.length;
  const r = await runCheck(cookie);
  const b = await r.json();
  assert.equal(up.calls.length, before);
  assert.equal(b.cached, true);
  assert.deepEqual(strip(b), strip(a));
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.match(r.headers.get('cache-control'), /private/);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  // Anonymous callers still get nothing from the cache.
  assert.equal((await runCheck(undefined)).status, 401);
});

test('incomplete results are not cached', async () => {
  setEnv({ CHECK_CACHE_SECONDS: '30' });
  useUpstream({ products: [] });
  const cookie = await signIn(fns);
  await runCheck(cookie);
  assert.equal(await store.get('check/last', { type: 'json' }), null);
});

test('per-session and global check limits hold across separate invocations', async () => {
  setEnv({ CHECK_MAX_PER_SESSION: '2', CHECK_MAX_GLOBAL: '3' });
  const up = useUpstream();
  const c1 = await signIn(fns, '198.51.100.1');
  const c2 = await signIn(fns, '198.51.100.2');
  const inv = async () => (await loadFunctions(store)).check;
  assert.equal((await (await inv())(req('/api/check', { body: {}, cookie: c1 }))).status, 200);
  assert.equal((await (await inv())(req('/api/check', { body: {}, cookie: c1 }))).status, 200);
  const third = await (await inv())(req('/api/check', { body: {}, cookie: c1 }));
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers.get('retry-after')) > 0);
  assert.equal((await (await inv())(req('/api/check', { body: {}, cookie: c2 }))).status, 200);
  const calls = up.calls.length;
  assert.equal((await (await inv())(req('/api/check', { body: {}, cookie: c2 }))).status, 429, 'global limit');
  assert.equal(up.calls.length, calls, 'limited requests make no upstream calls');
});

// ── Leakage ─────────────────────────────────────────────────────────────────
test('successful responses and logs contain no source IDs, keys, password or cookie', async () => {
  useUpstream();
  const { r: cookie, lines: l1 } = await captureLogs(() => signIn(fns));
  const { r, lines } = await captureLogs(() => runCheck(cookie));
  const text = await r.text() + JSON.stringify([...r.headers]) + l1.join('\n') + lines.join('\n');
  for (const s of [FAKE.inventoryId, FAKE.referenceId, FAKE.apiKey, FAKE.password, FAKE.secret, cookie.split('=')[1], String(FAKE.referenceGid), FAKE.referenceTab]) {
    assert.ok(!text.includes(s), `leaked ${s.slice(0, 12)}`);
  }
});

// ── Review fixes: no tab fallback, strict storefront validation ─────────────
test('configured Products Master tab missing -> 502, no fallback tab, no comparison', async () => {
  const up = useUpstream({ gid: 999 }); // sheet metadata no longer lists the configured gid
  const cookie = await signIn(fns);
  const { r, lines } = await captureLogs(() => runCheck(cookie));
  assert.equal(r.status, 502);
  const b = await r.json();
  assert.equal(b.results, undefined);
  assert.match(b.error, /Products Master sheet\. No comparison was produced/);
  assert.equal(up.calls.filter(c => c.kind === 'sheets-reference').length, 0, 'no values read from any other tab');
  assert.equal(up.calls.filter(c => c.kind === 'storefront').length, 0);
  assert.ok(lines.some(l => l.includes('source_failed') && l.includes('tab_missing')));
});

for (const [label, title] of [['empty', ''], ['blank', '   '], ['non-string', 42], ['missing', undefined], ['control chars', 'Tab\u0000!A1'], ['too long', 'x'.repeat(101)]]) {
  test(`invalid Products Master tab title (${label}) -> 502, no comparison`, async () => {
    const up = useUpstream({
      override: (k) => (k === 'sheets-meta'
        ? json({ sheets: [{ properties: { sheetId: FAKE.referenceGid, ...(title === undefined ? {} : { title }) } }] })
        : undefined),
    });
    const cookie = await signIn(fns);
    const r = await runCheck(cookie);
    assert.equal(r.status, 502);
    assert.equal(up.calls.filter(c => c.kind === 'sheets-reference').length, 0);
  });
}

const malformedStorefront = [
  ['empty object', () => json({})],
  ['empty variants', () => json({ variants: [] })],
  ['variants not an array', () => json({ variants: 'yes' })],
  ['variant without availability', () => json({ variants: [{}] })],
  ['string availability', () => json({ variants: [{ available: 'true' }] })],
  ['numeric availability', () => json({ variants: [{ available: 1 }] })],
  ['null variant', () => json({ variants: [null] })],
  ['one bad variant among good', () => json({ variants: [{ available: false }, { available: 'false' }] })],
  ['array body', () => json([])],
  ['invalid JSON', () => new Response('<html>', { status: 200 })],
];
for (const [label, make] of malformedStorefront) {
  test(`storefront 200 with ${label} -> "Could not verify", incomplete, no other handle tried`, async () => {
    const up = useUpstream({ override: (k, u) => (k === 'storefront' && u.pathname === '/products/mystery-fern.js' ? make() : undefined) });
    const cookie = await signIn(fns);
    const b = await (await runCheck(cookie)).json();
    assert.equal(b.complete, false);
    assert.deepEqual(b.warnings, ['storefront_unverified']);
    assert.ok(b.unverified.some(x => x.title === 'Mystery Fern'));
    assert.ok(!b.review.some(x => x.title === 'Mystery Fern'), 'not reported as out of stock');
    assert.ok(!b.results.some(x => x.title === 'Mystery Fern'), 'not reported as missing');
    assert.equal(up.calls.filter(c => c.url.includes('/products/mystery-fern-')).length, 0);
  });
}

test('malformed data on a later handle is unverified too (not "out of stock")', async () => {
  useUpstream({ storefront: { 'alocasia-shown': { variants: [{ available: true }] }, 'anthurium-rosy-red-1': { variants: [{}] } } });
  const cookie = await signIn(fns);
  const b = await (await runCheck(cookie)).json();
  assert.equal(b.review.length, 0);
  assert.ok(b.unverified.some(x => x.title === "Anthurium 'Rosy' (Red)"));
  assert.equal(b.complete, false);
});

test('valid storefront data still classifies exactly as before', async () => {
  useUpstream({ storefront: {
    'alocasia-shown': { variants: [{ available: false }, { available: true }] },
    'anthurium-rosy-red-1': { variants: [{ available: false }, { available: false }] },
  } });
  const cookie = await signIn(fns);
  const b = await (await runCheck(cookie)).json();
  assert.equal(b.complete, true);
  assert.deepEqual(strip(b), golden.base.body);
});
