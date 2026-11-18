// Title exclusions are private configuration (HPD_TITLE_EXCLUSIONS), not code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTitleExclusions, loadSourceConfig } from '../netlify/lib/config.mjs';
import { findUncovered } from '../netlify/lib/matching.mjs';
import { ENV } from './helpers/fixtures.mjs';

test('the exclusion list is parsed case-insensitively and is optional', () => {
  assert.deepEqual([...parseTitleExclusions('["Example Lamp ", "A B"]')], ['example lamp', 'a b']);
  assert.equal(parseTitleExclusions('').size, 0);
  assert.equal(parseTitleExclusions(undefined).size, 0);
  const { HPD_TITLE_EXCLUSIONS, ...noList } = ENV;
  assert.equal(loadSourceConfig(noList).titleExclusions.size, 0);
});

test('an invalid list fails closed with a configuration error naming only the variable', () => {
  for (const bad of ['not json', '{"a":1}', '[1,2]', '[""]', JSON.stringify(Array(501).fill('x'))]) {
    assert.throws(() => loadSourceConfig({ ...ENV, HPD_TITLE_EXCLUSIONS: bad }), err => {
      assert.deepEqual(err.missing, ['HPD_TITLE_EXCLUSIONS']);
      return true;
    });
  }
});

test('excluded titles are skipped; nothing is excluded without the list', () => {
  const products = [{ title: 'Example Lamp', variants: [{ sku: '4_LAMP' }] }];
  const inv = { '4_LAMP': 3 };
  const ref = { trueProdNames: new Set(), trueSizes: new Set() };
  assert.equal(findUncovered(products, inv, ref).length, 1);
  assert.equal(findUncovered(products, inv, ref, parseTitleExclusions('["example lamp"]')).length, 0);
});
