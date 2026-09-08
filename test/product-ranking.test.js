import assert from 'node:assert/strict';
import test from 'node:test';

import {
  groupProductsByQuantity,
  normalizeProductName,
} from '../src/product-ranking.js';

test('removes size and color variant after colon from product name', () => {
  assert.equal(
    normalizeProductName('двойка Adidas #437: STD/графит'),
    'двойка Adidas #437',
  );
  assert.equal(
    normalizeProductName('двойка Adidas #437: M / черный'),
    'двойка Adidas #437',
  );
});

test('normalizes whitespace without changing a base product name', () => {
  assert.equal(
    normalizeProductName('  джинсы   база прямые ZH  '),
    'джинсы база прямые ZH',
  );
});

test('combines variants and sums quantity and revenue', () => {
  const result = groupProductsByQuantity([
    {
      product: 'двойка Adidas #437: STD/графит',
      quantity: 2,
      amount: 66_415,
    },
    {
      product: 'двойка Adidas #437: M/черный',
      quantity: 1,
      amount: 31_000,
    },
    {
      product: 'другой товар: S/белый',
      quantity: 1,
      amount: 20_000,
    },
  ]);

  assert.deepEqual(result[0], {
    name: 'двойка Adidas #437',
    revenue: 97_415,
    count: 2,
    quantity: 3,
    averageCheck: 48_707.5,
  });
  assert.equal(result[1].name, 'другой товар');
});
