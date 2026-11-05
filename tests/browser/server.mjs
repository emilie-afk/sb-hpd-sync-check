// Local stand-in for Netlify: serves public/ with the netlify.toml headers and
// routes /api/* to the real function handlers. Upstream services are mocked
// and the store is in memory. Synthetic data only.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { MemoryStore, loadFunctions, setEnv } from '../helpers/harness.mjs';
import { createUpstream, installFetch } from '../helpers/mock-upstream.mjs';

const root = new URL('../..', import.meta.url).pathname;
const toml = readFileSync(join(root, 'netlify.toml'), 'utf8');
const globalHeaders = {};
const block = toml.split('[[headers]]').find(b => /for = "\/\*"/.test(b)) || '';
for (const m of block.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$/gm)) if (m[1] !== 'for') globalHeaders[m[1]] = m[2];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.txt': 'text/plain' };

export async function start({ port = 0, upstream: upOpts = {} } = {}) {
  setEnv({ CHECK_CACHE_SECONDS: '0' });
  const store = new MemoryStore();
  const fns = await loadFunctions(store);
  const state = { upstream: createUpstream(upOpts) };
  installFetch({ fetch: (...a) => state.upstream.fetch(...a) });

  const routes = { '/api/login': fns.login, '/api/logout': fns.logout, '/api/session': fns.session, '/api/check': fns.check };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const fn = routes[url.pathname];
    if (fn) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const r = await fn(request, { ip: req.socket.remoteAddress });
      const headers = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      if (sc.length) headers['set-cookie'] = sc;
      res.writeHead(r.status, headers);
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = join(root, 'public', p);
    if (!file.startsWith(join(root, 'public')) || !existsSync(file)) { res.writeHead(404, globalHeaders); res.end('Not found'); return; }
    res.writeHead(200, { ...globalHeaders, 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://localhost:${server.address().port}`,
    setUpstream: (opts) => { state.upstream = createUpstream(opts); },
    store,
    close: () => new Promise(r => server.close(r)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await start({ port: Number(process.env.PORT || 8888) });
  console.log('listening', s.url);
}
