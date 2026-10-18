import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractAsins, extractAliexpressIds, buildMentions } from './extract.js';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/youtube-videos-response.json', import.meta.url), 'utf8'));

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

const NOW = '2026-10-18T12:00:00.000Z';

test('buildMentions computes viewsPerDay as viewCount / days since publishedAt', () => {
  const mentions = buildMentions(fixture.items, NOW);
  const m = mentions.find((x) => x.sourceId === 'vidHasAsin');
  assert.strictEqual(m.metric.viewsPerDay, 1000);
});

test('buildMentions clamps days to a minimum of 1 for a video published today', () => {
  const mentions = buildMentions(fixture.items, NOW);
  const m = mentions.find((x) => x.sourceId === 'vidToday');
  assert.strictEqual(m.metric.viewsPerDay, 100);
});

test('buildMentions attaches the ASIN found in the description', () => {
  const mentions = buildMentions(fixture.items, NOW);
  const m = mentions.find((x) => x.sourceId === 'vidHasAsin');
  assert.strictEqual(m.asin, 'B0ABCD1234');
});

test('buildMentions omits asin when the description has no Amazon link', () => {
  const mentions = buildMentions(fixture.items, NOW);
  const m = mentions.find((x) => x.sourceId === 'vidNoAsin');
  assert.strictEqual(m.asin, undefined);
  assert.ok(!('asin' in m));
});

test('buildMentions stores no raw API response fields', () => {
  const mentions = buildMentions(fixture.items, NOW);
  const allowed = new Set([
    'source', 'sourceId', 'rawText', 'productHint', 'asin', 'aliexpressId', 'url', 'metric', 'seenAt',
  ]);
  for (const m of mentions) {
    for (const key of Object.keys(m)) {
      assert.ok(allowed.has(key), `unexpected key ${key}`);
    }
    assert.deepStrictEqual(Object.keys(m.metric), ['viewsPerDay']);
    assert.strictEqual(m.source, 'youtube');
    assert.ok(typeof m.seenAt === 'string');
  }
  const noAsin = mentions.find((x) => x.sourceId === 'vidNoAsin');
  assert.deepStrictEqual(
    Object.keys(noAsin).sort(),
    ['metric', 'productHint', 'rawText', 'seenAt', 'source', 'sourceId', 'url']
  );
});

