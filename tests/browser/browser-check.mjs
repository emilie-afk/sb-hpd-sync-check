// Browser checks with Playwright (Chromium) against the local stand-in server.
// Run: npm run test:browser   (needs Playwright + Chromium installed globally)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { start } from './server.mjs';
import { FAKE } from '../helpers/fixtures.mjs';
import { json } from '../helpers/mock-upstream.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const realFetch = globalThis.fetch; // the server mocks global fetch for upstream calls
const srv = await start();
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const problems = [];
page.on('console', m => { if (m.type() === 'error' && !/401|409|429|502|Failed to load resource/.test(m.text())) problems.push(m.text()); });
page.on('pageerror', e => problems.push(String(e)));
page.on('dialog', d => { problems.push('dialog: ' + d.message()); d.dismiss(); });
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
  if (process.env.VERBOSE) console.log(results.at(-1).join('  ').slice(0, 200));
}

try {
  // A previous version stored the raw password in sessionStorage.
  await page.goto(srv.url);
  await page.evaluate(() => sessionStorage.setItem('hpd_pw', 'old-password'));
  await page.reload();

  await check('gate shown, old sessionStorage password removed', async () => {
    await page.waitForSelector('#gate:not([hidden])');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('hpd_pw')), null);
    assert.equal(await page.isVisible('#app'), false);
  });

  await check('wrong password shows error, no cookie', async () => {
    await page.fill('#pwInput', 'wrong password');
    await page.click('#unlockBtn');
    await page.waitForFunction(() => document.getElementById('gateError').textContent.includes('Incorrect'));
    assert.equal((await context.cookies()).length, 0);
  });

  await check('correct password -> results table renders', async () => {
    await page.fill('#pwInput', FAKE.password);
    await page.click('#unlockBtn');
    await page.waitForSelector('#app:not([hidden]) .table-wrap');
    const meta = await page.textContent('#meta');
    assert.match(meta, /^6 products not yet synced/);
    assert.equal(await page.locator('.table-wrap').first().locator('tbody tr').count(), 6);
    assert.equal(await page.locator('.table-wrap.review tbody tr').count(), 1);
    assert.match(await page.textContent('#footer'), /20 HPD products scanned/);
    assert.match(await page.textContent('#content'), /Philodendron Testus\s*\(Philodendron\)/);
  });

  await check('cookie is HttpOnly, Secure, SameSite=Strict and unreadable from JS', async () => {
    const c = (await context.cookies()).find(x => x.name === '__Host-hpd_session');
    assert.ok(c && c.httpOnly && c.secure && c.sameSite === 'Strict');
    assert.equal(await page.evaluate(() => document.cookie), '');
    assert.equal(await page.evaluate(() => JSON.stringify(sessionStorage) + JSON.stringify(localStorage)).then(s => s.includes(FAKE.password)), false);
  });

  await check('untrusted product text is rendered as text, not HTML', async () => {
    assert.equal(await page.locator('#content img').count(), 0);
    assert.match(await page.textContent('#content'), /Evil <img src=x onerror=alert\(1\)> Plant/);
  });

  await check('session restored after reload', async () => {
    await page.reload();
    await page.waitForSelector('#app:not([hidden]) .table-wrap');
  });

  await check('refresh works', async () => {
    await page.click('#refreshBtn');
    await page.waitForSelector('#app .table-wrap');
    assert.equal(await page.isEnabled('#refreshBtn'), true);
  });

  await check('source failure shows an error, not "0 missing"', async () => {
    srv.setUpstream({ override: (k) => (k === 'sheets-inventory' ? json({ error: { message: 'raw google detail' } }, 403) : undefined) });
    await page.click('#refreshBtn');
    await page.waitForSelector('#content .error-box');
    const t = await page.textContent('#content');
    assert.match(t, /Could not load the HPD inventory sheet\. No comparison was produced/);
    assert.ok(!t.includes('raw google detail'));
    assert.equal(await page.textContent('#meta'), 'No comparison available');
  });

  await check('partial storefront result is labelled', async () => {
    srv.setUpstream({ override: (k, u) => (k === 'storefront' && u.pathname.includes('mystery-fern') ? new Response('x', { status: 500 }) : undefined) });
    await page.click('#refreshBtn');
    await page.waitForSelector('.warn-box');
    assert.match(await page.textContent('#meta'), /^INCOMPLETE/);
    assert.equal(await page.locator('.table-wrap.unverified tbody tr').count(), 1);
    srv.setUpstream({});
  });

  await check('anonymous API call is rejected', async () => {
    const r = await realFetch(srv.url + '/api/check', { method: 'POST', headers: { 'x-hpd-request': '1', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
  });

  const sessionStatus = () => page.evaluate(() => fetch('/api/session', { headers: { 'X-HPD-Request': '1' } }).then(r => r.status));

  await check('failed sign-out (HTTP 500) keeps the app, shows a retryable error, session still active', async () => {
    await page.route('**/api/logout', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Unexpected error. (ref test)"}' }));
    await page.click('#signoutBtn');
    await page.waitForSelector('#notice:not([hidden])');
    assert.match(await page.textContent('#notice'), /Sign out failed.*still signed in/);
    assert.equal(await page.isVisible('#app'), true);
    assert.equal(await page.isVisible('#gate'), false);
    assert.equal(await page.isEnabled('#signoutBtn'), true);
    assert.equal(await sessionStatus(), 200);
    await page.unroute('**/api/logout');
  });

  await check('sign-out network failure keeps the app and shows a retryable error', async () => {
    await page.route('**/api/logout', r => r.abort('failed'));
    await page.click('#signoutBtn');
    await page.waitForFunction(() => /Could not reach the server to sign out/.test(document.getElementById('notice').textContent));
    assert.equal(await page.isVisible('#app'), true);
    assert.equal(await sessionStatus(), 200);
    await page.unroute('**/api/logout');
  });

  await check('retry after a failed sign-out succeeds', async () => {
    await page.click('#signoutBtn');
    await page.waitForSelector('#gate:not([hidden])');
    assert.equal(await sessionStatus(), 401);
    await page.fill('#pwInput', FAKE.password);
    await page.click('#unlockBtn');
    await page.waitForSelector('#app:not([hidden]) .table-wrap');
  });

  let lateResponses = 0;
  async function delayCheck(ms) {
    // The request reaches the server (with a valid session) right away; only
    // the response is held back, as with a slow upstream check.
    await page.route('**/api/check', async (route) => {
      let response;
      try { response = await route.fetch(); } catch (_) { return; }
      if (response.status() === 200) lateResponses++;
      await new Promise(r => setTimeout(r, ms));
      try { await route.fulfill({ response }); } catch (_) {}
    });
  }

  await check('delayed check response after sign-out is discarded', async () => {
    await delayCheck(1500);
    await page.click('#refreshBtn');
    await page.waitForSelector('.spinner');
    await page.click('#signoutBtn');
    await page.waitForSelector('#gate:not([hidden])');
    await page.waitForTimeout(2200);
    assert.equal(lateResponses, 1, 'the server did answer 200 for the delayed check');
    assert.equal(await page.isVisible('#gate'), true);
    assert.equal(await page.isVisible('#app'), false);
    assert.equal(await page.locator('#content .table-wrap').count(), 0);
    assert.equal(await page.textContent('#content'), '');
    assert.equal(await sessionStatus(), 401);
    await page.unroute('**/api/check');
  });

  await check('delayed check is discarded when sign-out fails too', async () => {
    await page.fill('#pwInput', FAKE.password);
    await page.click('#unlockBtn');
    await page.waitForSelector('#app:not([hidden]) .table-wrap');
    await delayCheck(1500);
    await page.route('**/api/logout', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Service temporarily unavailable."}' }));
    await page.click('#refreshBtn');
    await page.waitForSelector('.spinner');
    await page.click('#signoutBtn');
    await page.waitForSelector('#notice:not([hidden])');
    await page.waitForTimeout(2200);
    assert.equal(await page.locator('#content .table-wrap').count(), 0, 'late results not rendered');
    assert.equal(await page.textContent('#meta'), 'Check cancelled');
    assert.equal(await page.isEnabled('#refreshBtn'), true);
    await page.unroute('**/api/logout');
    await page.unroute('**/api/check');
    await page.click('#refreshBtn');
    await page.waitForSelector('#content .table-wrap');
    assert.equal(await page.isVisible('#notice'), false);
  });

  let savedCookie;
  await check('sign out returns to the gate and revokes the session', async () => {
    savedCookie = (await context.cookies()).find(x => x.name === '__Host-hpd_session');
    await page.click('#signoutBtn');
    await page.waitForSelector('#gate:not([hidden])');
    assert.equal(await page.textContent('#content'), '');
    await page.reload();
    await page.waitForSelector('#gate:not([hidden])');
    const r = await realFetch(srv.url + '/api/check', {
      method: 'POST', body: '{}',
      headers: { 'x-hpd-request': '1', 'content-type': 'application/json', cookie: `${savedCookie.name}=${savedCookie.value}` },
    });
    assert.equal(r.status, 401, 'copied cookie rejected after logout');
  });

  await check('static server/config files are not published', async () => {
    for (const p of ['/netlify.toml', '/package.json', '/netlify/functions/check.mjs', '/tests/helpers/fixtures.mjs', '/.env.example', '/netlify/lib/config.mjs']) {
      assert.equal((await realFetch(srv.url + p)).status, 404, p);
    }
  });

  await check('CSP header present; no console errors, CSP violations or dialogs', async () => {
    const r = await realFetch(srv.url + '/');
    assert.match(r.headers.get('content-security-policy') || '', /script-src 'self'/);
    assert.deepEqual(problems, []);
  });

  await page.setViewportSize({ width: 1100, height: 800 });
  await page.fill('#pwInput', FAKE.password);
  await page.click('#unlockBtn');
  await page.waitForSelector('#app:not([hidden]) .table-wrap');
  await page.screenshot({ path: process.env.SHOT || '/tmp/hpd-results.png', fullPage: true });
} finally {
  await browser.close();
  await srv.close();
}

for (const r of results) console.log(r.join('  '));
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
