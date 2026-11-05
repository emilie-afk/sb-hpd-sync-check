// Mocked external services (HPD catalog, Google Sheets, Shopify storefront).
// Installs a fake global fetch; nothing leaves the process.
import { FAKE, hpdProducts, inventoryValues, referenceValues, storefront } from './fixtures.mjs';

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// A response whose headers arrive immediately but whose body never finishes.
export function stalledBody(signal) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"products":['));
      signal?.addEventListener('abort', () => {
        try { controller.error(signal.reason || new Error('aborted')); } catch (_) {}
      });
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

export function createUpstream(opts = {}) {
  const data = {
    products: opts.products || hpdProducts(),
    inventory: opts.inventory || inventoryValues(),
    reference: opts.reference || referenceValues(),
    storefront: opts.storefront || storefront(),
    inventoryId: opts.inventoryId || FAKE.inventoryId,
    referenceId: opts.referenceId || FAKE.referenceId,
    gid: opts.gid ?? FAKE.referenceGid,
    tab: opts.tab || FAKE.referenceTab,
    apiKey: opts.apiKey || FAKE.apiKey,
  };
  const calls = [];
  const override = opts.override || (() => undefined);

  async function handle(url, init) {
    const u = new URL(url);
    const kind = classify(u);
    calls.push({ kind, url: u.toString() });
    const o = await override(kind, u, init, calls);
    if (o !== undefined) return o;

    if (kind === 'hpd') {
      const page = Number(u.searchParams.get('page'));
      const limit = Number(u.searchParams.get('limit'));
      const slice = data.products.slice((page - 1) * limit, page * limit);
      return json({ products: slice });
    }
    if (kind === 'sheets-inventory') {
      if (u.searchParams.get('key') !== data.apiKey) return json({ error: { message: 'bad key' } }, 400);
      return json({ range: 'Inventory!A1:C99', values: data.inventory });
    }
    if (kind === 'sheets-meta') {
      if (u.searchParams.get('key') !== data.apiKey) return json({ error: { message: 'bad key' } }, 400);
      return json({ sheets: [
        { properties: { sheetId: 0, title: 'Other' } },
        { properties: { sheetId: data.gid, title: data.tab } },
      ] });
    }
    if (kind === 'sheets-reference') {
      const range = decodeURIComponent(u.pathname.split('/values/')[1]);
      if (range !== `${data.tab}!A:AZ`) return json({ error: { message: 'Unable to parse range' } }, 400);
      return json({ values: data.reference });
    }
    if (kind === 'storefront') {
      const handle = u.pathname.replace(/^\/products\//, '').replace(/\.js$/, '');
      const p = data.storefront[handle];
      return p ? json(p) : new Response('Not found', { status: 404 });
    }
    return new Response('unexpected', { status: 599 });
  }

  function classify(u) {
    if (u.hostname === 'houseplantdropship.com' && u.pathname === '/products.json') return 'hpd';
    if (u.hostname === 'sheets.googleapis.com') {
      const p = decodeURIComponent(u.pathname);
      if (p.startsWith(`/v4/spreadsheets/${data.inventoryId}/values/`)) return 'sheets-inventory';
      if (p === `/v4/spreadsheets/${data.referenceId}`) return 'sheets-meta';
      if (p.startsWith(`/v4/spreadsheets/${data.referenceId}/values/`)) return 'sheets-reference';
      return 'sheets-unknown';
    }
    if (u.hostname === 'succulentsbox.com' && u.pathname.startsWith('/products/')) return 'storefront';
    return 'unknown';
  }

  const fetchImpl = (url, init = {}) => {
    // honour abort like a real fetch
    if (init.signal?.aborted) return Promise.reject(init.signal.reason || new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(init.signal.reason || new DOMException('Aborted', 'AbortError'));
      init.signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(handle(typeof url === 'string' ? url : url.url, init))
        .then((r) => { init.signal?.removeEventListener('abort', onAbort); resolve(r); }, reject);
    });
  };

  return { fetch: fetchImpl, calls, data };
}

export function installFetch(upstream) {
  const prev = globalThis.fetch;
  globalThis.fetch = upstream.fetch;
  return () => { globalThis.fetch = prev; };
}
