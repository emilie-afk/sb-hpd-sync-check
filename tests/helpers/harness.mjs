// Test harness: in-memory store with the same conditional-write API as
// Netlify Blobs, env setup, request builders and fresh handler loading.
import { ENV } from './fixtures.mjs';

export class MemoryStore {
  constructor() { this.map = new Map(); this.n = 0; this.ops = 0; }
  async get(key, opts = {}) {
    this.ops++;
    const e = this.map.get(key);
    if (!e) return null;
    return opts.type === 'json' ? JSON.parse(e.v) : e.v;
  }
  async getWithMetadata(key, opts = {}) {
    this.ops++;
    await tick();
    const e = this.map.get(key);
    if (!e) return null;
    return { data: opts.type === 'json' ? JSON.parse(e.v) : e.v, etag: e.etag, metadata: {} };
  }
  async setJSON(key, value, opts = {}) {
    this.ops++;
    await tick();
    const e = this.map.get(key);
    if (opts.onlyIfNew && e) return { modified: false };
    if (opts.onlyIfMatch && (!e || e.etag !== opts.onlyIfMatch)) return { modified: false };
    const etag = `"${++this.n}"`;
    this.map.set(key, { v: JSON.stringify(value), etag });
    return { modified: true, etag };
  }
  async delete(key) { this.map.delete(key); }
}
const tick = () => new Promise(r => setImmediate(r));

let loadCounter = 0;
// Each call imports the function modules again (fresh module state), like a
// separate cold-started invocation. Only the shared store carries state.
export async function loadFunctions(store) {
  const v = `?inv=${++loadCounter}`;
  const storeMod = await import('../../netlify/lib/store.mjs');
  storeMod.setStoreForTests(store);
  const [login, logout, session, check] = await Promise.all([
    import('../../netlify/functions/login.mjs' + v),
    import('../../netlify/functions/logout.mjs' + v),
    import('../../netlify/functions/session.mjs' + v),
    import('../../netlify/functions/check.mjs' + v),
  ]);
  return { login: login.default, logout: logout.default, session: session.default, check: check.default };
}

export function setEnv(overrides = {}) {
  const keys = new Set([...Object.keys(ENV), 'SESSION_EPOCH', 'SESSION_TTL_HOURS', 'CHECK_CACHE_SECONDS',
    'CHECK_BUDGET_MS', 'CHECK_MAX_PER_SESSION', 'CHECK_MAX_GLOBAL', 'LOGIN_MAX_FAILURES_PER_IP',
    'LOGIN_MAX_FAILURES_GLOBAL', 'LOGIN_WINDOW_MINUTES', 'CHECK_WINDOW_MINUTES', ...Object.keys(overrides)]);
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, ENV, { CHECK_CACHE_SECONDS: '0' });
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const ORIGIN = 'https://hpd.example.test';

export function req(path, { method = 'POST', body, cookie, headers = {}, csrf = true } = {}) {
  const h = new Headers(headers);
  if (csrf) {
    h.set('x-hpd-request', '1');
    if (!h.has('origin')) h.set('origin', ORIGIN);
    if (!h.has('sec-fetch-site')) h.set('sec-fetch-site', 'same-origin');
  }
  if (body !== undefined) h.set('content-type', 'application/json');
  if (cookie) h.set('cookie', cookie);
  return new Request(ORIGIN + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

export function cookieFrom(res) {
  const sc = res.headers.get('set-cookie') || '';
  const m = sc.match(/(__Host-hpd_session=[^;]*)/);
  return m ? m[1] : null;
}

export async function signIn(fns, ip = '203.0.113.10') {
  const { FAKE } = await import('./fixtures.mjs');
  const res = await fns.login(req('/api/login', { body: { password: FAKE.password } }), { ip });
  if (res.status !== 200) throw new Error('sign-in failed ' + res.status);
  return cookieFrom(res);
}

// Capture console output during fn.
export async function captureLogs(fn) {
  const lines = [];
  const o = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try { const r = await fn(); return { r, lines }; } finally { Object.assign(console, o); }
}
