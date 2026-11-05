// Data fetchers. Source locations come only from server configuration.
import { getJson, mapLimit, UpstreamError } from './upstream.mjs';
import { parseInventory, parseReference, makeHandle } from './matching.mjs';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const HPD_URL = 'https://houseplantdropship.com/products.json';
const SHOPIFY_STORE = 'succulentsbox.com';
const HPD_MAX_PAGES = 6;
const HPD_PAGE_SIZE = 250;

// A required source could not be read completely: no comparison is produced.
export class SourceError extends Error {
  constructor(source, code, status) {
    super(`${source}:${code}`);
    this.source = source; // 'hpd' | 'inventory' | 'reference'
    this.code = code;
    this.status = status;
  }
}

async function required(source, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SourceError) throw e;
    if (e instanceof UpstreamError) throw new SourceError(source, e.code, e.status);
    throw new SourceError(source, 'error');
  }
}

function isRows(v) {
  return v === undefined || (Array.isArray(v) && v.every(r => Array.isArray(r)));
}

export async function fetchHPDProducts(budget, warnings) {
  return required('hpd', async () => {
    const all = [];
    for (let page = 1; page <= HPD_MAX_PAGES; page++) {
      const r = await getJson(`${HPD_URL}?limit=${HPD_PAGE_SIZE}&page=${page}`, { budget, maxBytes: 8 * 1024 * 1024 });
      if (!r.ok) throw new SourceError('hpd', 'status', r.status);
      const d = r.data;
      if (!d || typeof d !== 'object' || !Array.isArray(d.products)) throw new SourceError('hpd', 'bad_shape');
      for (const p of d.products) {
        if (!p || typeof p.title !== 'string' || (p.variants !== undefined && !Array.isArray(p.variants))) {
          throw new SourceError('hpd', 'bad_shape');
        }
      }
      if (d.products.length === 0) break;
      all.push(...d.products);
      if (d.products.length < HPD_PAGE_SIZE) break;
      if (page === HPD_MAX_PAGES) warnings.push('hpd_truncated');
    }
    if (all.length === 0) warnings.push('hpd_empty');
    return all;
  });
}

export async function fetchInventoryMap(cfg, budget, warnings) {
  return required('inventory', async () => {
    const url = `${SHEETS_API}/${cfg.inventoryId}/values/Inventory!A:C?key=${encodeURIComponent(cfg.apiKey)}`;
    const r = await getJson(url, { budget });
    if (!r.ok) throw new SourceError('inventory', 'status', r.status);
    if (!r.data || typeof r.data !== 'object' || !isRows(r.data.values)) throw new SourceError('inventory', 'bad_shape');
    const map = parseInventory(r.data.values);
    if (Object.keys(map).length === 0) warnings.push('inventory_empty');
    return map;
  });
}

export async function fetchReferenceData(cfg, budget, warnings) {
  return required('reference', async () => {
    // Resolve gid -> sheet name
    const metaUrl = `${SHEETS_API}/${cfg.referenceId}?key=${encodeURIComponent(cfg.apiKey)}&fields=sheets.properties`;
    const m = await getJson(metaUrl, { budget });
    if (!m.ok) throw new SourceError('reference', 'status', m.status);
    if (!m.data || !Array.isArray(m.data.sheets)) throw new SourceError('reference', 'bad_shape');
    // The configured tab must exist; there is no fallback to another tab.
    const sheet = m.data.sheets.find(s => s && s.properties && s.properties.sheetId === cfg.referenceGid);
    if (!sheet) throw new SourceError('reference', 'tab_missing');
    const name = sheet.properties.title;
    if (!validTabTitle(name)) throw new SourceError('reference', 'tab_invalid');

    const url = `${SHEETS_API}/${cfg.referenceId}/values/${encodeURIComponent(name + '!' + REFERENCE_RANGE)}?key=${encodeURIComponent(cfg.apiKey)}`;
    const r = await getJson(url, { budget });
    if (!r.ok) throw new SourceError('reference', 'status', r.status);
    if (!r.data || typeof r.data !== 'object' || !isRows(r.data.values)) throw new SourceError('reference', 'bad_shape');
    const cols = referenceColumns(r.data.values);
    const ref = parseReference(r.data.values, cols);
    if (ref.trueProdNames.size === 0) warnings.push('reference_empty');
    return ref;
  });
}

// Products Master columns are found by their header (row 1), so inserting or
// moving columns doesn't silently change what is read. A missing or
// duplicated header is a source error: no comparison is produced.
const REFERENCE_RANGE = 'A:AZ';
export const REFERENCE_HEADERS = { sku: 'HD SKU', flag: 'Shopify Uploaded Listing' };
const normHeader = (h) => String(h ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export function referenceColumns(values) {
  const header = Array.isArray(values) && Array.isArray(values[0]) ? values[0].map(normHeader) : [];
  const cols = {};
  for (const [k, name] of Object.entries(REFERENCE_HEADERS)) {
    const want = normHeader(name);
    const hits = header.reduce((a, h, i) => (h === want ? a.concat(i) : a), []);
    if (hits.length === 0) throw new SourceError('reference', 'column_missing');
    if (hits.length > 1) throw new SourceError('reference', 'column_ambiguous');
    cols[k] = hits[0];
  }
  return cols;
}

// Google Sheets tab titles: non-empty, bounded, no control characters.
function validTabTitle(t) {
  return typeof t === 'string' && t.trim().length > 0 && t.length <= 100 && !/[\u0000-\u001f\u007f]/.test(t);
}

// Shopify /products/<handle>.js: an object with at least one variant, and
// every variant carrying a boolean `available`.
function validStorefrontProduct(d) {
  return !!d && typeof d === 'object' && !Array.isArray(d) &&
    Array.isArray(d.variants) && d.variants.length > 0 &&
    d.variants.every(v => v && typeof v === 'object' && typeof v.available === 'boolean');
}

// Storefront availability. 404 = this handle does not exist; any other
// failure makes the result unknown instead of silently "missing".
export async function checkStorefront(title, budget) {
  const base = makeHandle(title);
  const handles = [base, base + '-1', base + '-2'];
  let failed = false;
  for (const h of handles) {
    if (budget.expired()) return { handle: base, unknown: true };
    try {
      const r = await getJson(`https://${SHOPIFY_STORE}/products/${encodeURIComponent(h)}.js`, {
        budget, perRequestMs: 5000, maxBytes: 2 * 1024 * 1024,
      });
      if (r.ok) {
        // A page exists at this handle. If its data can't be validated, the
        // product is unverified (never "out of stock", never another handle).
        if (!validStorefrontProduct(r.data)) return { handle: h, unknown: true };
        const inStock = r.data.variants.some(v => v.available === true);
        return { handle: h, found: true, inStock };
      }
      if (r.status !== 404) failed = true;
    } catch (_) {
      failed = true;
    }
  }
  if (failed) return { handle: base, unknown: true };
  return { handle: base, found: false, inStock: false };
}

export function checkAllStorefronts(products, budget, concurrency = 8) {
  return mapLimit(products, concurrency, p => checkStorefront(p.title, budget));
}
