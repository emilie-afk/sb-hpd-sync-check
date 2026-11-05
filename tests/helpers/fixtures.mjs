// Synthetic test data only. Every ID, key, SKU and product below is fictional.

export const FAKE = {
  inventoryId: 'TEST_INVENTORY_SHEET_ID_0000000000000',
  referenceId: 'TEST_PRODUCTS_MASTER_ID_0000000000000',
  referenceGid: 424242,
  referenceTab: 'Master Tab',
  apiKey: 'test-google-api-key-not-real-0000',
  password: 'correct horse battery staple',
  secret: 'test-session-signing-secret-0123456789abcdef',
};

function variant(sku, available = true) {
  return { sku, available };
}

// HPD catalog (products.json shape)
export function hpdProducts() {
  return [
    // Not covered, not on storefront -> results
    { title: 'Philodendron Testus (Green Leaf)', variants: [variant('4_PHILO_TESTUS')] },
    // Covered exactly by raw name
    { title: 'Monstera Example', variants: [variant('6_MONSTERA_EXAMPLE')] },
    // Covered by size prefix after stripping _POT_ suffix
    { title: 'Pothos Sample in Pot', variants: [variant('6_POTHOS_SAMPLE_POT_WHITE')] },
    // Uncovered size (8 not in reference sizes) -> results
    { title: 'Pothos Sample Large', variants: [variant('8_POTHOS_SAMPLE')] },
    // Skip keyword
    { title: 'Succulent Mix Tray', variants: [variant('4_SUCC_MIX')] },
    { title: 'Air Plant Bundle', variants: [variant('AIR_BUNDLE')] },
    // Title exclusion (case-insensitive)
    { title: 'LED Flexible Grow Light', variants: [variant('LED_LIGHT')] },
    // Out of stock in inventory -> skipped
    { title: 'Calathea Nowhere', variants: [variant('4_CALATHEA_NOWHERE')] },
    // Not in inventory at all -> skipped
    { title: 'Ficus Ghost', variants: [variant('4_FICUS_GHOST')] },
    // Uncovered, found on storefront and in stock -> already synced, skipped
    { title: 'Alocasia Shown', variants: [variant('4_ALOCASIA_SHOWN')] },
    // Uncovered, storefront page exists (-1 handle) but out of stock -> review
    { title: "Anthurium 'Rosy' (Red)", variants: [variant('4_ANTH_ROSY')] },
    // Non-sized SKU covered via trueProdNames
    { title: 'Moss Pole Kit', variants: [variant('mosspole_kit')] },
    // Non-sized SKU uncovered -> results, no common name
    { title: 'Mystery Fern', variants: [variant('MYSTERY_FERN')] },
    // Lowercase + whitespace sku, covered by prefix
    { title: 'Dracaena Lemon', variants: [variant('  6_dracaena_lemon_pp.white ')] },
    // Mixed variants: one out of stock uncovered, one in stock covered -> covered
    { title: 'Peperomia Mixed', variants: [variant('4_PEP_MIXED_X'), variant('6_PEP_MIXED')] },
    // Duplicate title (two HPD products) -> both reported
    { title: 'Begonia Twin', variants: [variant('4_BEGONIA_TWIN_A')] },
    { title: 'Begonia Twin', variants: [variant('4_BEGONIA_TWIN_B')] },
    // Incomplete record: variant without sku, other variant uncovered
    { title: 'Hoya Partial', variants: [{ available: true }, variant('4_HOYA_PARTIAL')] },
    // No variants
    { title: 'Empty Product', variants: [] },
    // Untrusted text in a title (rendered safely by the UI)
    { title: 'Evil <img src=x onerror=alert(1)> Plant', variants: [variant('4_EVIL_PLANT')] },
  ];
}

// Inventory sheet values (A:C): SKU, name, available
export function inventoryValues() {
  return [
    ['SKU', 'Name', 'Available'],
    ['4_PHILO_TESTUS', 'x', '5'],
    ['6_MONSTERA_EXAMPLE', 'x', '3'],
    ['6_POTHOS_SAMPLE_POT_WHITE', 'x', '2'],
    ['8_POTHOS_SAMPLE', 'x', '7'],
    ['4_SUCC_MIX', 'x', '9'],
    ['AIR_BUNDLE', 'x', '9'],
    ['LED_LIGHT', 'x', '9'],
    ['4_CALATHEA_NOWHERE', 'x', '0'],
    ['4_ALOCASIA_SHOWN', 'x', '4'],
    ['4_ANTH_ROSY', 'x', '1'],
    ['MOSSPOLE_KIT', 'x', '1'],
    ['MYSTERY_FERN', 'x', '2'],
    ['6_DRACAENA_LEMON_PP.WHITE', 'x', '3'],
    ['4_PEP_MIXED_X', 'x', '0'],
    ['6_PEP_MIXED', 'x', '6'],
    ['4_BEGONIA_TWIN_A', 'x', '2'],
    ['4_BEGONIA_TWIN_B', 'x', 'n/a'],   // non-numeric -> 0
    ['4_BEGONIA_TWIN_B', 'x', '3'],     // duplicate row: last wins
    ['4_HOYA_PARTIAL', 'x', '2'],
    ['4_EVIL_PLANT', 'x', '1'],
    ['', 'blank sku row', '5'],
    ['ORPHAN_SKU'],                      // short row
  ];
}

// Products Master values; header row names the HD SKU and Shopify flag columns
export function referenceValues() {
  return [
    ['No.', 'Plant Name', 'Size', 'HD SKU', 'E', 'Shopify Uploaded Listing'],
    ['', '', '', '6_MONSTERA_EXAMPLE', '', 'TRUE'],
    ['', '', '', '4_POTHOS_SAMPLE', '', 'TRUE'],
    ['', '', '', '6_POTHOS_SAMPLE', '', 'true'],
    ['', '', '', 'MOSSPOLE_KIT', '', 'TRUE'],
    ['', '', '', '4_DRACAENA_LEMON_NURSERY_POT', '', 'TRUE'],
    ['', '', '', '6_DRACAENA_LEMON', '', 'TRUE'],
    ['', '', '', '6_PEP_MIXED', '', 'TRUE'],
    ['', '', '', '4_PHILO_TESTUS', '', 'FALSE'],
    ['', '', '', '', '', 'TRUE'],
    ['', '', '', '4_SHORT_ROW'],
  ];
}

// Storefront: handle -> product JSON (absent = 404)
export function storefront() {
  return {
    'alocasia-shown': { variants: [{ available: false }, { available: true }] },
    'anthurium-rosy-red-1': { variants: [{ available: false }] },
  };
}

export function bigCatalog(n) {
  const products = [];
  const inv = [['SKU', 'Name', 'Available']];
  for (let i = 0; i < n; i++) {
    const sku = `4_BULK_PLANT_${i}`;
    products.push({ title: `Bulk Plant ${i}`, variants: [variant(sku)] });
    inv.push([sku, 'x', i % 3 === 0 ? '0' : '2']);
  }
  return { products, inv };
}

export const ENV = {
  SITE_PASSWORD: FAKE.password,
  SESSION_SECRET: FAKE.secret,
  GOOGLE_SHEETS_API_KEY: FAKE.apiKey,
  HPD_INVENTORY_SHEET_ID: FAKE.inventoryId,
  PRODUCTS_MASTER_SHEET_ID: FAKE.referenceId,
  PRODUCTS_MASTER_TAB_GID: String(FAKE.referenceGid),
};
