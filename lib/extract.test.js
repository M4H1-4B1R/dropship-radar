import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractAsins, extractAliexpressIds, buildMentions, buildPending, finalizeProducts, parseAmazonProduct, extractShortLinks, asinFromUrl } from './extract.js';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/youtube-videos-response.json', import.meta.url), 'utf8'));
const amazonHtml = readFileSync(new URL('../fixtures/amazon-product.html', import.meta.url), 'utf8');

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

test('buildPending emits one item per mention with mentionId "yt:<sourceId>"', () => {
  const mentions = [
    {
      source: 'youtube', sourceId: 'v1', rawText: 'hello', productHint: 'h',
      asin: 'B0ABCD1234', url: 'u', metric: { viewsPerDay: 1 }, seenAt: 't',
    },
    {
      source: 'youtube', sourceId: 'v2', rawText: 'world', productHint: 'w',
      url: 'u2', metric: { viewsPerDay: 2 }, seenAt: 't',
    },
  ];
  const items = buildPending(mentions);
  assert.strictEqual(items.length, 2);
  assert.deepStrictEqual(items[0].mentionId, 'yt:v1');
  assert.deepStrictEqual(items[1].mentionId, 'yt:v2');
  assert.deepStrictEqual(items[0].asin, 'B0ABCD1234');
  assert.deepStrictEqual(items[1].asin, undefined);
});

test('buildPending truncates rawText at 400 chars', () => {
  const mentions = [
    { source: 'youtube', sourceId: 'v1', rawText: 'x'.repeat(500), productHint: 'h', url: 'u', metric: { viewsPerDay: 1 }, seenAt: 't' },
  ];
  const items = buildPending(mentions);
  assert.strictEqual(items[0].rawText.length, 400);
});

test('finalizeProducts stamps firstSeen=today for a product absent from existing', () => {
  const draft = [
    { id: 'p1', name: 'Thing', category: 'kitchen', asins: ['B0ABCD1234'], aliexpressIds: [], mentionIds: ['yt:v1'] },
  ];
  const { products } = finalizeProducts(draft, [], '2026-10-18');
  assert.strictEqual(products[0].firstSeen, '2026-10-18');
});

test('finalizeProducts preserves the earlier firstSeen for a product already present', () => {
  const draft = [
    { id: 'p1', name: 'Thing', category: 'kitchen', asins: ['B0ABCD1234'], aliexpressIds: [], mentionIds: ['yt:v1'] },
  ];
  const existing = [
    { id: 'p1', name: 'Thing', category: 'kitchen', asins: ['B0ABCD1234'], aliexpressIds: [], mentionIds: ['yt:v1'], firstSeen: '2026-10-01' },
  ];
  const { products } = finalizeProducts(draft, existing, '2026-10-18');
  assert.strictEqual(products[0].firstSeen, '2026-10-01');
});

test('finalizeProducts reports products sharing an ASIN', () => {
  const draft = [
    { id: 'p1', name: 'Thing A', category: 'kitchen', asins: ['B0AAAAAAAA'], aliexpressIds: [], mentionIds: ['yt:v1'] },
    { id: 'p2', name: 'Thing B', category: 'kitchen', asins: ['B0AAAAAAAA'], aliexpressIds: [], mentionIds: ['yt:v2'] },
  ];
  const { duplicateAsins } = finalizeProducts(draft, [], '2026-10-18');
  assert.deepStrictEqual(duplicateAsins['B0AAAAAAAA'], ['p1', 'p2']);
});

test('parseAmazonProduct reads the price from the fixture', () => {
  assert.deepStrictEqual(parseAmazonProduct(amazonHtml).price, 14.99);
});

test('parseAmazonProduct reads the Best Sellers Rank integer from the fixture', () => {
  assert.deepStrictEqual(parseAmazonProduct(amazonHtml).rank, 3120);
});

test('parseAmazonProduct reads the review count from the fixture', () => {
  assert.deepStrictEqual(parseAmazonProduct(amazonHtml).reviews, 812);
});

test('parseAmazonProduct returns nulls, not zeros, when a field is absent', () => {
  assert.deepStrictEqual(parseAmazonProduct('<html><body></body></html>'), {
    price: null,
    rank: null,
    reviews: null,
  });
});

test('extractShortLinks finds amzn.to, a.co and amzn.eu URLs', () => {
  assert.deepStrictEqual(
    extractShortLinks('a https://amzn.to/3se9dWO b https://a.co/xyz c https://amzn.eu/abc'),
    ['https://amzn.to/3se9dWO', 'https://a.co/xyz', 'https://amzn.eu/abc']
  );
});

test('extractShortLinks strips trailing ) ] , . from a URL at the end of a sentence', () => {
  assert.deepStrictEqual(
    extractShortLinks('Check https://amzn.to/3se9dWO. Also https://a.co/xyz, and https://amzn.eu/abc]'),
    ['https://amzn.to/3se9dWO', 'https://a.co/xyz', 'https://amzn.eu/abc']
  );
});

test('extractShortLinks dedupes a link repeated in one description', () => {
  assert.deepStrictEqual(
    extractShortLinks('https://amzn.to/3se9dWO and again https://amzn.to/3se9dWO'),
    ['https://amzn.to/3se9dWO']
  );
});

test('extractShortLinks ignores a full amazon.com/dp link', () => {
  assert.deepStrictEqual(
    extractShortLinks('https://www.amazon.com/dp/B0ABCD1234'),
    []
  );
});

test('asinFromUrl reads the ASIN from a resolved /dp/<ASIN>?tag=... URL', () => {
  assert.strictEqual(asinFromUrl('https://www.amazon.com/dp/B018IBEHQU?tag=xyz'), 'B018IBEHQU');
});

test('asinFromUrl reads the ASIN from a /gp/product/<ASIN> URL', () => {
  assert.strictEqual(asinFromUrl('https://www.amazon.com/gp/product/B0XYZ78901/'), 'B0XYZ78901');
});

test('asinFromUrl returns null for a /shop/<creator> storefront URL', () => {
  assert.strictEqual(asinFromUrl('https://www.amazon.com/shop/somecreator'), null);
});

test('buildPending attaches the ASIN from the link cache when the mention has none', () => {
  // The short link lives in the mention text; the mention url is the source
  // page (the YouTube video), never the key the cache is written under.
  const mentions = [
    { source: 'youtube', sourceId: 'v1', rawText: 'must have https://amzn.to/3se9dWO', productHint: 'h', url: 'https://www.youtube.com/watch?v=v1', metric: { viewsPerDay: 1 }, seenAt: 't' },
  ];
  const linkCache = { 'https://amzn.to/3se9dWO': { asin: 'B018IBEHQU', resolvedAt: '2026-10-19' } };
  const items = buildPending(mentions, linkCache);
  assert.strictEqual(items[0].asin, 'B018IBEHQU');
});

test('buildPending does not look the cache up by the mention url', () => {
  const mentions = [
    { source: 'youtube', sourceId: 'v1', rawText: 'no link here', productHint: 'h', url: 'https://amzn.to/3se9dWO', metric: { viewsPerDay: 1 }, seenAt: 't' },
  ];
  const linkCache = { 'https://amzn.to/3se9dWO': { asin: 'B018IBEHQU', resolvedAt: '2026-10-19' } };
  const items = buildPending(mentions, linkCache);
  assert.strictEqual(items[0].asin, undefined);
});

test('buildPending prefers the mention\'s own asin over a cached one', () => {
  const mentions = [
    { source: 'youtube', sourceId: 'v1', rawText: 'https://amzn.to/3se9dWO', productHint: 'h', asin: 'B0ABCD1234', url: 'https://www.youtube.com/watch?v=v1', metric: { viewsPerDay: 1 }, seenAt: 't' },
  ];
  const linkCache = { 'https://amzn.to/3se9dWO': { asin: 'B018IBEHQU', resolvedAt: '2026-10-19' } };
  const items = buildPending(mentions, linkCache);
  assert.strictEqual(items[0].asin, 'B0ABCD1234');
});

test('buildPending ignores a cache entry whose asin is null', () => {
  const mentions = [
    { source: 'youtube', sourceId: 'v1', rawText: 'https://amzn.to/3se9dWO', productHint: 'h', url: 'https://www.youtube.com/watch?v=v1', metric: { viewsPerDay: 1 }, seenAt: 't' },
  ];
  const linkCache = { 'https://amzn.to/3se9dWO': { asin: null, resolvedAt: '2026-10-19', reason: 'not_a_product' } };
  const items = buildPending(mentions, linkCache);
  assert.deepStrictEqual(items[0].asin, undefined);
});


