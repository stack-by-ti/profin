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

test('removes color and article from a product name', () => {
  assert.equal(
    normalizeProductName('футболка укороченная черная арт.51027'),
    'футболка укороченная',
  );
  assert.equal(
    normalizeProductName('футболка укороченная белая арт. 51027'),
    'футболка укороченная',
  );
});

test('keeps model numbers that are not marked as an article', () => {
  assert.equal(normalizeProductName('двойка Adidas #437'), 'двойка Adidas #437');
  assert.equal(normalizeProductName('кеды замша цветные 3619-50'), 'кеды замша 3619-50');
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

test('combines products across colors and articles', () => {
  const result = groupProductsByQuantity([
    { product: 'футболка укороченная черная арт.51027', quantity: 7, amount: 32_900 },
    { product: 'футболка укороченная белая арт.51027', quantity: 4, amount: 20_000 },
  ]);

  assert.deepEqual(result, [{
    name: 'футболка укороченная',
    revenue: 52_900,
    count: 2,
    quantity: 11,
    averageCheck: 26_450,
  }]);
});
