// GET /api/session -> whether the cookie holds a valid session (for page reloads).
import { handler } from '../lib/guard.mjs';
import { reply, assertMethod } from '../lib/http.mjs';
import { authenticate, clearCookie } from '../lib/session.mjs';

export default handler('session', async (req, { cfg, store }) => {
  assertMethod(req, 'GET');
  const p = await authenticate(req, cfg, store);
  if (!p) return reply(401, { authenticated: false }, { 'Set-Cookie': clearCookie() });
  return reply(200, { authenticated: true, expiresAt: p.exp * 1000 });
});

export const config = { path: '/api/session' };
