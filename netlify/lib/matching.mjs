// Product matching and classification. Logic moved unchanged from the original
// netlify/functions/check.js; only I/O was separated out so it can be tested.

// Products confirmed synced but not in the reference sheet
// (storefront handles don't match the generated handle)
export const TITLE_EXCLUSIONS = new Set([
  'winter plant shipping protection',
  'tillandsia air plants fertilizer - 2oz',
  'led flexible grow light',
  'disco ball hanging planter',
  'peperomia rosso',           // Shopify handle is peperomia-rosso-1
  'alocasia micholitziana \'frydek\'' // Confirmed synced via HPD Merchant app
]);

// Skip products whose title contains any of these
export const SKIP_KEYWORDS = ['succulent', 'tillandsia', 'air plant', 'subscription', 'gift card'];

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

export function getCommonName(title) {
  for (const [re, name] of COMMON_NAMES) {
    if (re.test(title)) return name;
  }
  return null;
}

export function makeHandle(title) {
  return title.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function stripPotSuffix(raw) {
  return raw
    .replace(/_POT_.*$/,        '')
    .replace(/_PP\..*$/,        '')
    .replace(/_NURSERY\.POT.*$/, '')
    .replace(/_NURSERY_POT.*$/, '');
}

// Does any reference-sheet row (Shopify=TRUE) cover this SKU?
export function isCovered(sku, trueProdNames, trueSizes) {
  const upper = (sku || '').toUpperCase();
  const m = upper.match(/^(\d+)_(.+)$/);
  if (!m) return trueProdNames.has(upper);

  const [, size, raw] = m;
  const stripped = stripPotSuffix(raw);

  if (trueProdNames.has(raw)) return true;

  const parts = stripped.split('_');
  for (let len = parts.length; len >= 1; len--) {
    const prefix = parts.slice(0, len).join('_');
    if (trueSizes[prefix] && trueSizes[prefix].has(size)) return true;
  }
  return false;
}

// Inventory sheet rows (A:C, header first) -> { SKU: available }
export function parseInventory(values) {
  const map = {};
  for (const row of (values || []).slice(1)) {
    const sku   = (row[0] || '').toString().trim().toUpperCase();
    const avail = parseInt(row[2] || '0', 10);
    if (sku) map[sku] = isNaN(avail) ? 0 : avail;
  }
  return map;
}

// Products Master rows (A:F, header first); D = HD SKU, F = Shopify flag
export function parseReference(values) {
  const trueProdNames = new Set();
  const trueSizes     = Object.create(null);

  for (const row of (values || []).slice(1)) {
    const hdSku = (row[3] || '').toString().trim().toUpperCase();
    const flag  = (row[5] || '').toString().trim().toUpperCase();
    if (!hdSku || flag !== 'TRUE') continue;

    const m = hdSku.match(/^(\d+)_(.+)$/);
    if (!m) {
      trueProdNames.add(hdSku);
    } else {
      const [, size, raw] = m;
      trueProdNames.add(raw);
      const stripped = stripPotSuffix(raw);
      if (!trueSizes[stripped]) trueSizes[stripped] = new Set();
      trueSizes[stripped].add(size);
    }
  }
  return { trueProdNames, trueSizes };
}

// First pass: HPD products in stock but not covered by the reference sheet
export function findUncovered(hpdProducts, inventoryMap, ref) {
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
      isCovered((v.sku || '').trim().toUpperCase(), ref.trueProdNames, ref.trueSizes)
    );
    if (!covered) uncovered.push(product);
  }
  return uncovered;
}

// Second pass: classify by storefront result.
// sf = { found, inStock, handle } or { unknown: true } when it could not be checked.
export function classify(uncovered, sfResults) {
  const results    = [];
  const review     = [];
  const unverified = [];

  uncovered.forEach((product, i) => {
    const sf = sfResults[i];
    const entry = {
      title:      product.title,
      commonName: getCommonName(product.title)
    };
    if (!sf || sf.unknown) {
      unverified.push({ ...entry, note: 'Storefront check failed — could not confirm whether this product is on Shopify' });
      return;
    }
    if (sf.found && sf.inStock) return; // already synced
    if (sf.found && !sf.inStock) {
      review.push({
        ...entry,
        note: `Page exists at succulentsbox.com/${sf.handle} but out of stock — verify sync in HPD Merchant`
      });
    } else {
      results.push(entry);
    }
  });
  return { results, review, unverified };
}
