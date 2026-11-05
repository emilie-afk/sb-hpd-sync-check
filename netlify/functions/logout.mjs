// POST /api/logout -> revokes this session server-side and clears the cookie.
import { handler } from '../lib/guard.mjs';
import { reply, assertMethod, assertSameOrigin } from '../lib/http.mjs';
import { verifyToken, readCookie, revoke, clearCookie } from '../lib/session.mjs';

export default handler('logout', async (req, { cfg, store }) => {
  assertMethod(req, 'POST');
  assertSameOrigin(req);
  const p = verifyToken(cfg, readCookie(req));
  if (p) await revoke(store, p);
  return reply(200, { authenticated: false }, { 'Set-Cookie': clearCookie() });
});

export const config = { path: '/api/logout' };
