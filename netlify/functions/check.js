const fetch = require('node-fetch');

// ── Sheet / store config ──────────────────────────────────────────────────────
const SHEETS_API     = 'https://sheets.googleapis.com/v4/spreadsheets';
const INVENTORY_ID   = 'REDACTED_HPD_INVENTORY_SHEET_ID';
const REFERENCE_ID   = 'REDACTED_PRODUCTS_MASTER_SHEET_ID';
const REFERENCE_GID  = 655463913;
const SHOPIFY_STORE  = 'succulentsbox.com';

// Products confirmed synced but not in the reference sheet
// (storefront handles don't match the generated handle)
const TITLE_EXCLUSIONS = new Set([
  'winter plant shipping protection',
  'tillandsia air plants fertilizer - 2oz',
  'led flexible grow light',
  'disco ball hanging planter',
  'peperomia rosso',           // Shopify handle is peperomia-rosso-1
  'alocasia micholitziana \'frydek\'' // Confirmed synced via HPD Merchant app
]);

// Skip products whose title contains any of these
const SKIP_KEYWORDS = ['succulent', 'tillandsia', 'air plant', 'subscription', 'gift card'];

// Common name display lookup
const COMMON_NAMES = [
  [/philodendron/i,   'Philodendron'],
  [/dracaena/i,       'Dracaena'],
  [/snake plant/i,    'Snake Plant'],
  [/anthurium/i,      'Flamingo Flower'],
  [/calathea/i,       'Prayer Plant'],
  [/maranta/i,        'Prayer Plant'],
  [/alocasia/i,       'Elephant Ear'],
  [/hypoestes/i,      'Polka Dot Plant'],
  [/monstera/i,       'Monstera'],
  [/pothos/i,         'Pothos'],
  [/areca palm/i,     'Areca Palm'],
  [/opuntia/i,        'Cactus'],
  [/cactus/i,         'Cactus'],
  [/pilea/i,          'Chinese Money Plant'],
  [/peperomia/i,      'Peperomia'],
  [/spider plant/i,   'Spider Plant'],
  [/money tree/i,     'Money Tree'],
  [/rubber plant/i,   'Rubber Plant'],
  [/fiddle leaf/i,    'Fiddle Leaf Fig'],
  [/lipstick/i,       'Lipstick Plant'],
  [/bromeliad/i,      'Bromeliad'],
  [/aglaonema/i,      'Chinese Evergreen'],
  [/zamioculcas/i,    'ZZ Plant'],
  [/zz plant/i,       'ZZ Plant'],
  [/begonia/i,        'Begonia'],
  [/ficus/i,          'Ficus'],
];

function getCommonName(title) {
  for (const [re, name] of COMMON_NAMES) {
    if (re.test(title)) return name;
  }
  return null;
}

// ── Handle helpers ────────────────────────────────────────────────────────────
function makeHandle(title) {
  return title.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Fetch with timeout ────────────────────────────────────────────────────────
async function fetchT(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── isCovered: does any reference-sheet row (Shopify=TRUE) cover this SKU? ───
function isCovered(sku, trueProdNames, trueSizes) {
  const upper = (sku || '').toUpperCase();
  const m = upper.match(/^(\d+)_(.+)$/);
  if (!m) return trueProdNames.has(upper);

  const [, size, raw] = m;
  const stripped = raw
    .replace(/_POT_.*$/,        '')
    .replace(/_PP\..*$/,        '')
    .replace(/_NURSERY\.POT.*$/, '')
    .replace(/_NURSERY_POT.*$/, '');

  if (trueProdNames.has(raw)) return true;

  const parts = stripped.split('_');
  for (let len = parts.length; len >= 1; len--) {
    const prefix = parts.slice(0, len).join('_');
    if (trueSizes[prefix] && trueSizes[prefix].has(size)) return true;
  }
  return false;
}

// ── Data fetchers ─────────────────────────────────────────────────────────────
async function fetchHPDProducts() {
  const all = [];
  for (let page = 1; page <= 6; page++) {
    const r = await fetchT(`https://houseplantdropship.com/products.json?limit=250&page=${page}`);
    if (!r.ok) break;
    const d = await r.json();
    if (!d.products || d.products.length === 0) break;
    all.push(...d.products);
    if (d.products.length < 250) break;
  }
  return all;
}

async function fetchInventoryMap(apiKey) {
  const url = `${SHEETS_API}/${INVENTORY_ID}/values/Inventory!A:C?key=${apiKey}`;
  const r   = await fetchT(url);
  const d   = await r.json();
  const map = {};
  for (const row of (d.values || []).slice(1)) {
    const sku   = (row[0] || '').toString().trim().toUpperCase();
    const avail = parseInt(row[2] || '0', 10);
    if (sku) map[sku] = isNaN(avail) ? 0 : avail;
  }
  return map;
}

async function fetchReferenceData(apiKey) {
  // Resolve gid → sheet name
  const metaR = await fetchT(`${SHEETS_API}/${REFERENCE_ID}?key=${apiKey}&fields=sheets.properties`);
  const meta  = await metaR.json();
  const sheet = (meta.sheets || []).find(s => s.properties.sheetId === REFERENCE_GID);
  const name  = sheet ? sheet.properties.title : 'Sheet1';

  const url = `${SHEETS_API}/${REFERENCE_ID}/values/${encodeURIComponent(name + '!A:F')}?key=${apiKey}`;
  const r   = await fetchT(url);
  const d   = await r.json();

  const trueProdNames = new Set();
  const trueSizes     = {};

  for (const row of (d.values || []).slice(1)) {
    const hdSku = (row[3] || '').toString().trim().toUpperCase();
    const flag  = (row[5] || '').toString().trim().toUpperCase();
    if (!hdSku || flag !== 'TRUE') continue;

    const m = hdSku.match(/^(\d+)_(.+)$/);
    if (!m) {
      trueProdNames.add(hdSku);
    } else {
      const [, size, raw] = m;
      trueProdNames.add(raw);
      const stripped = raw
        .replace(/_POT_.*$/,        '')
        .replace(/_PP\..*$/,        '')
        .replace(/_NURSERY\.POT.*$/, '')
        .replace(/_NURSERY_POT.*$/, '');
      if (!trueSizes[stripped]) trueSizes[stripped] = new Set();
      trueSizes[stripped].add(size);
    }
  }
  return { trueProdNames, trueSizes, sheetName: name };
}

async function checkStorefront(title) {
  const base    = makeHandle(title);
  const handles = [base, base + '-1', base + '-2'];
  for (const h of handles) {
    try {
      const r = await fetchT(`https://${SHOPIFY_STORE}/products/${h}.js`, 5000);
      if (r.ok) {
        const d       = await r.json();
        const inStock = Array.isArray(d.variants) && d.variants.some(v => v.available);
        return { handle: h, found: true, inStock };
      }
    } catch (_) {}
  }
  return { handle: base, found: false, inStock: false };
}

// ── Lambda handler ────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // Password gate — checked server-side so data never reaches the browser without it
  const sitePassword = process.env.SITE_PASSWORD;
  if (sitePassword) {
    const provided = event.headers['x-site-password'] || '';
    if (provided !== sitePassword) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Incorrect password' })
      };
    }
  }

  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Missing GOOGLE_SHEETS_API_KEY env var' })
    };
  }

  try {
    // Fetch all data sources in parallel
    const [hpdProducts, inventoryMap, refData] = await Promise.all([
      fetchHPDProducts(),
      fetchInventoryMap(apiKey),
      fetchReferenceData(apiKey)
    ]);
    const { trueProdNames, trueSizes } = refData;

    // First pass — find products not covered by reference sheet
    const uncovered = [];
    for (const product of hpdProducts) {
      const titleLower = product.title.toLowerCase();
      if (SKIP_KEYWORDS.some(kw => titleLower.includes(kw))) continue;
      if (TITLE_EXCLUSIONS.has(titleLower)) continue;

      const inStockVariants = (product.variants || []).filter(v => {
        const sku = (v.sku || '').trim().toUpperCase();
        return (inventoryMap[sku] || 0) > 0;
      });
      if (inStockVariants.length === 0) continue;

      const covered = inStockVariants.some(v =>
        isCovered((v.sku || '').trim().toUpperCase(), trueProdNames, trueSizes)
      );
      if (!covered) uncovered.push(product);
    }

    // Second pass — storefront check (parallel)
    const sfResults = await Promise.all(uncovered.map(p => checkStorefront(p.title)));

    const results = [];
    const review  = [];

    uncovered.forEach((product, i) => {
      const sf = sfResults[i];
      if (sf.found && sf.inStock) {
        // In stock on Shopify storefront → already synced, skip
        return;
      }
      const entry = {
        title:      product.title,
        commonName: getCommonName(product.title)
      };
      if (sf.found && !sf.inStock) {
        review.push({
          ...entry,
          note: `Page exists at succulentsbox.com/${sf.handle} but out of stock — verify sync in HPD Merchant`
        });
      } else {
        results.push(entry);
      }
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'no-store'
      },
      body: JSON.stringify({
        ts:      new Date().toISOString(),
        count:   results.length,
        stats: {
          hpd:           hpdProducts.length,
          inStockSkus:   Object.values(inventoryMap).filter(v => v > 0).length,
          shopifyMapped: trueProdNames.size
        },
        results,
        review
      })
    };

  } catch (err) {
    console.error('check() error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
