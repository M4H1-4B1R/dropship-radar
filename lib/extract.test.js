import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAsins, extractAliexpressIds } from './extract.js';

test('extracts ASIN from amazon.com/dp/ URL', () => {
  assert.deepStrictEqual(
    extractAsins('Check it out: https://www.amazon.com/dp/B0ABCD1234 and more'),
    ['B0ABCD1234']
  );
});

test('extracts ASIN from amazon.com/gp/product/ URL', () => {
  assert.deepStrictEqual(
    extractAsins('https://www.amazon.com/gp/product/B0XYZ78901/'),
    ['B0XYZ78901']
  );
});

test('extracts ASIN from a shortened amzn.to link only when the ASIN is in the path', () => {
  assert.deepStrictEqual(extractAsins('https://amzn.to/B0ABCD1234'), ['B0ABCD1234']);
  assert.deepStrictEqual(extractAsins('https://amzn.to/3AbcDef'), []);
});

test('ignores a 10-char token that is not in an Amazon URL', () => {
  assert.deepStrictEqual(extractAsins('B0ABCD1234 is just a code'), []);
});

test('dedupes a repeated ASIN', () => {
  assert.deepStrictEqual(
    extractAsins('https://www.amazon.com/dp/B0ABCD1234 also https://amzn.to/B0ABCD1234'),
    ['B0ABCD1234']
  );
});

test('extracts item id from aliexpress.com/item/1005006123456789.html', () => {
  assert.deepStrictEqual(
    extractAliexpressIds('https://www.aliexpress.com/item/1005006123456789.html'),
    ['1005006123456789']
  );
});

test('extracts item id from an a.aliexpress.com short link path', () => {
  assert.deepStrictEqual(
    extractAliexpressIds('https://a.aliexpress.com/1005006123456789'),
    ['1005006123456789']
  );
});

test('returns [] for a linktr.ee description', () => {
  const text = 'Follow me: https://linktr.ee/coolproducts';
  assert.deepStrictEqual(extractAsins(text), []);
  assert.deepStrictEqual(extractAliexpressIds(text), []);
});
