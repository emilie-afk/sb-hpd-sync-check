// The comparison itself. Called only after the session has been verified.
import { createBudget } from './upstream.mjs';
import { fetchHPDProducts, fetchInventoryMap, fetchReferenceData, checkAllStorefronts } from './sources.mjs';
import { findUncovered, classify } from './matching.mjs';

export async function runCheck(cfg) {
  const budget = createBudget(cfg.check.budgetMs);
  const warnings = [];
  try {
    // A failure in any of these throws SourceError -> no comparison at all.
    const [hpdProducts, inventoryMap, ref] = await Promise.all([
      fetchHPDProducts(budget, warnings),
      fetchInventoryMap(cfg, budget, warnings),
      fetchReferenceData(cfg, budget, warnings),
    ]);

    const uncovered = findUncovered(hpdProducts, inventoryMap, ref);
    const sfResults = await checkAllStorefronts(uncovered, budget);
    const { results, review, unverified } = classify(uncovered, sfResults);
    if (unverified.length) warnings.push('storefront_unverified');

    return {
      ts: new Date().toISOString(),
      complete: warnings.length === 0,
      warnings,
      count: results.length,
      stats: {
        hpd:           hpdProducts.length,
        inStockSkus:   Object.values(inventoryMap).filter(v => v > 0).length,
        shopifyMapped: ref.trueProdNames.size,
      },
      results,
      review,
      unverified,
    };
  } finally {
    budget.done();
  }
}
