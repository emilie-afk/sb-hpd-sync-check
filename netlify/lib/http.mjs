// Response helpers, request validation and redacted logging.
import { randomBytes } from 'node:crypto';

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, private, max-age=0',
  'Pragma': 'no-cache',
  'Vary': 'Cookie',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

export function reply(status, body, extra = {}) {
  const headers = new Headers(BASE_HEADERS);
  for (const [k, v] of Object.entries(extra)) {
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
    else headers.set(k, v);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export const ref = () => randomBytes(4).toString('hex');

// Structured logs with codes only: never URLs, IDs, keys, passwords or cookies.
export function logEvent(level, event, fields = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'number' || typeof v === 'boolean') safe[k] = v;
    else if (typeof v === 'string' && /^[\w .:\-\/]{0,80}$/.test(v)) safe[k] = v;
  }
  (level === 'error' ? console.error : console.log)(JSON.stringify({ app: 'hpd-sync-check', event, ...safe }));
}

export class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// CSRF defence for cookie-authenticated POSTs: a custom header (forces a
// CORS preflight that is never approved), a same-origin Origin when sent,
// and Sec-Fetch-Site when sent. The cookie is also SameSite=Strict.
export function assertSameOrigin(req) {
  if (req.headers.get('x-hpd-request') !== '1') throw new RequestError(403, 'Request blocked');
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') throw new RequestError(403, 'Request blocked');
  const origin = req.headers.get('origin');
  if (origin) {
    let expected;
    try { expected = new URL(req.url).origin; } catch (_) { throw new RequestError(403, 'Request blocked'); }
    if (origin !== expected) throw new RequestError(403, 'Request blocked');
  }
}

export function assertMethod(req, method) {
  if (req.method !== method) throw new RequestError(405, 'Method not allowed');
}

export function assertNoQuery(req) {
  if (new URL(req.url).search) throw new RequestError(400, 'Unexpected parameters');
}

// Reads a small JSON body with a hard byte cap. Empty body -> {}.
export async function readJson(req, maxBytes) {
  const len = Number(req.headers.get('content-length') || '0');
  if (len > maxBytes) throw new RequestError(413, 'Request too large');
  const text = await readLimited(req, maxBytes);
  if (!text.trim()) return {};
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) throw new RequestError(415, 'JSON required');
  let v;
  try { v = JSON.parse(text); } catch (_) { throw new RequestError(400, 'Invalid JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RequestError(400, 'Invalid body');
  return v;
}

async function readLimited(req, maxBytes) {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) {}
      throw new RequestError(413, 'Request too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

export function onlyKeys(obj, allowed) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new RequestError(400, 'Unexpected parameters');
  }
}
