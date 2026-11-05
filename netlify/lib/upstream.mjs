// Outbound HTTP for the check: allowlisted HTTPS hosts only, validated
// redirects, one overall deadline that also covers response-body reads,
// bounded body size and bounded retries.

export const ALLOWED_HOSTS = new Set([
  'houseplantdropship.com',
  'www.houseplantdropship.com',
  'sheets.googleapis.com',
  'succulentsbox.com',
  'www.succulentsbox.com',
]);

export class UpstreamError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;     // timeout | budget | network | too_large | redirect | disallowed | bad_json
    this.status = status; // upstream HTTP status, when known
  }
}

export function createBudget(ms) {
  const ctrl = new AbortController();
  const deadline = Date.now() + ms;
  const timer = setTimeout(() => ctrl.abort(new UpstreamError('budget')), ms);
  return {
    signal: ctrl.signal,
    remaining: () => deadline - Date.now(),
    expired: () => ctrl.signal.aborted || Date.now() >= deadline,
    // Stops every outstanding request (used when the check ends or fails).
    done: () => { clearTimeout(timer); if (!ctrl.signal.aborted) ctrl.abort(new UpstreamError('budget')); },
  };
}

function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { throw new UpstreamError('disallowed'); }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) {
    throw new UpstreamError('disallowed');
  }
  if (!ALLOWED_HOSTS.has(u.hostname)) throw new UpstreamError('disallowed');
  return u;
}

function combinedSignal(budget, ms) {
  const ctrl = new AbortController();
  const onBudget = () => ctrl.abort(new UpstreamError('budget'));
  if (budget.signal.aborted) onBudget();
  else budget.signal.addEventListener('abort', onBudget, { once: true });
  const t = setTimeout(() => ctrl.abort(new UpstreamError('timeout')), Math.max(1, ms));
  return {
    signal: ctrl.signal,
    cleanup: () => { clearTimeout(t); budget.signal.removeEventListener('abort', onBudget); },
  };
}

async function readBody(res, maxBytes, signal) {
  const len = Number(res.headers.get('content-length') || '0');
  if (len > maxBytes) throw new UpstreamError('too_large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  const onAbort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new UpstreamError('too_large');
      chunks.push(value);
    }
  } catch (e) {
    try { await reader.cancel(); } catch (_) {}
    if (e instanceof UpstreamError) throw e;
    if (signal.reason instanceof UpstreamError) throw signal.reason;
    throw new UpstreamError('network');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

// One attempt, following up to `maxRedirects` validated redirects.
async function attempt(url, opts) {
  const { budget, perRequestMs, maxBytes, maxRedirects } = opts;
  let current = validateUrl(url);
  for (let hop = 0; ; hop++) {
    if (budget.expired()) throw new UpstreamError('budget');
    const { signal, cleanup } = combinedSignal(budget, Math.min(perRequestMs, budget.remaining()));
    try {
      let res;
      try {
        res = await fetch(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal,
          headers: { accept: 'application/json' },
        });
      } catch (e) {
        if (signal.reason instanceof UpstreamError) throw signal.reason;
        throw new UpstreamError('network');
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        try { await res.body?.cancel(); } catch (_) {}
        if (hop >= maxRedirects) throw new UpstreamError('redirect');
        const loc = res.headers.get('location');
        if (!loc) throw new UpstreamError('redirect');
        current = validateUrl(new URL(loc, current).toString());
        continue;
      }
      const text = await readBody(res, maxBytes, signal);
      return { status: res.status, ok: res.ok, text };
    } finally {
      cleanup();
    }
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function getText(url, {
  budget, perRequestMs = 8000, maxBytes = 5 * 1024 * 1024, maxRedirects = 3, retries = 1,
} = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await attempt(url, { budget, perRequestMs, maxBytes, maxRedirects });
      if (RETRYABLE_STATUS.has(r.status) && i < retries && budget.remaining() > 1500) {
        lastErr = new UpstreamError('status', r.status);
        await sleep(250, budget);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      const transient = e.code === 'network' || e.code === 'timeout';
      if (!transient || i >= retries || budget.remaining() <= 1500) throw e;
      await sleep(250, budget);
    }
  }
  throw lastErr;
}

export async function getJson(url, opts) {
  const r = await getText(url, opts);
  let data = null;
  try { data = JSON.parse(r.text); } catch (_) { data = undefined; }
  return { status: r.status, ok: r.ok, data };
}

function sleep(ms, budget) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.min(ms, Math.max(0, budget.remaining())));
    budget.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// Run `fn` over items with bounded concurrency, preserving order.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
