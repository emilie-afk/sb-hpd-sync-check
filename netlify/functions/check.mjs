// POST /api/check -> runs the HPD vs Shopify comparison for a signed-in user.
import { handler } from '../lib/guard.mjs';
import { reply, ref, logEvent, assertMethod, assertSameOrigin, assertNoQuery, readJson, onlyKeys } from '../lib/http.mjs';
import { authenticate } from '../lib/session.mjs';
import { loadSourceConfig } from '../lib/config.mjs';
import { reserve, acquireLock, releaseLock } from '../lib/limits.mjs';
import { runCheck } from '../lib/check-run.mjs';
import { SourceError } from '../lib/sources.mjs';

const SOURCE_LABEL = {
  hpd: 'the HPD catalog',
  inventory: 'the HPD inventory sheet',
  reference: 'the Products Master sheet',
};
const CACHE_KEY = 'check/last';
const LOCK_KEY = 'check/lock';

export default handler('check', async (req, { cfg, store }) => {
  assertMethod(req, 'POST');
  assertSameOrigin(req);

  // Session first: nothing below runs for anonymous, forged, expired or revoked sessions.
  const session = await authenticate(req, cfg, store);
  if (!session) return reply(401, { error: 'Sign in required.' });

  assertNoQuery(req);
  const body = await readJson(req, 256);
  onlyKeys(body, []);

  const src = loadSourceConfig();
  const c = src.check;

  // Recent complete result: serve it instead of hitting upstream again.
  if (c.cacheSeconds > 0) {
    const cached = await store.get(CACHE_KEY, { type: 'json', consistency: 'strong' });
    if (cached && cached.at > Date.now() - c.cacheSeconds * 1000 && cached.data) {
      return reply(200, { ...cached.data, cached: true, cachedAgeSeconds: Math.round((Date.now() - cached.at) / 1000) });
    }
  }

  const s = await reserve(store, `check/session/${session.sid}`, c.maxPerSession, c.windowMs);
  if (!s.ok) return reply(429, { error: 'Too many checks. Please wait a few minutes.' }, { 'Retry-After': String(s.retryAfter) });
  const g = await reserve(store, 'check/global', c.maxGlobal, c.windowMs);
  if (!g.ok) return reply(429, { error: 'Too many checks. Please wait a few minutes.' }, { 'Retry-After': String(g.retryAfter) });

  const lock = await acquireLock(store, LOCK_KEY, c.budgetMs + 5000);
  if (!lock.ok) return reply(409, { error: 'A check is already running. Try again in a few seconds.' }, { 'Retry-After': String(lock.retryAfter) });

  try {
    const data = await runCheck(src);
    if (data.complete && c.cacheSeconds > 0) await store.setJSON(CACHE_KEY, { at: Date.now(), data });
    logEvent('info', 'check_done', { complete: data.complete, count: data.count, review: data.review.length, unverified: data.unverified.length });
    return reply(200, data);
  } catch (e) {
    if (e instanceof SourceError) {
      const id = ref();
      logEvent('error', 'source_failed', { source: e.source, code: e.code, status: e.status || 0, ref: id });
      return reply(502, {
        error: `Could not load ${SOURCE_LABEL[e.source] || 'a data source'}. No comparison was produced — try again. (ref ${id})`,
      });
    }
    throw e;
  } finally {
    await releaseLock(store, LOCK_KEY, lock.owner).catch(() => {});
  }
});

export const config = { path: '/api/check' };
