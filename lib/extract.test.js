import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractAsins, extractAliexpressIds, buildMentions, buildPending, finalizeProducts, parseAmazonProduct, extractShortLinks, asinFromUrl, isAmazonNotFound, isAmazonProductPage, parsePackQty } from './extract.js';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/youtube-videos-response.json', import.meta.url), 'utf8'));
const amazonHtml = readFileSync(new URL('../fixtures/amazon-product.html', import.meta.url), 'utf8');
const notFoundHtml = readFileSync(new URL('../fixtures/amazon-not-found.html', import.meta.url), 'utf8');
const degradedHtml = readFileSync(new URL('../fixtures/amazon-degraded.html', import.meta.url), 'utf8');

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

// The fixture is a captured YouTube videos.list response (see
// fixtures/README.md). The ids below are real video ids.
const VID_DIRECT_LINK = 'ePzkMP3tFZ4';   // one amazon.com/dp link
const VID_MAAS_LINK = '5LRf_4EF5vs';     // amazon.com/dp link with a maas query string
const VID_SHORT_LINKS = 'QB4sGbPgxLc';  // 29 amzn.to short links, no direct link
const VID_NO_LINK = 'fJMzzYTMliU';      // links, but none of them Amazon
const VID_NEWEST = '7i1VRwr9npM';       // published 2025-12-07

test('buildMentions computes viewsPerDay as viewCount / days since publishedAt', () => {
  const mentions = buildMentions(fixture.items, NOW);
  const m = mentions.find((x) => x.sourceId === VID_DIRECT_LINK);
  // 17,853,054 views over 791 whole days (2024-08-17 → 2026-10-18).
  assert.ok(Math.abs(m.metric.viewsPerDay - 17853054 / 791) < 1e-9);
});

test('buildMentions clamps days to a minimum of 1 for a video published today', () => {
  const publishedAt = '2025-12-07T01:00:09Z';
  const mentions = buildMentions(fixture.items, publishedAt);
  const m = mentions.find((x) => x.sourceId === VID_NEWEST);
  // Published the same second: zero days would divide by zero, so it clamps.
  assert.strictEqual(m.metric.viewsPerDay, 10332);
});

test('buildMentions attaches the ASIN found in the description', () => {
  const mentions = buildMentions(fixture.items, NOW);
  const m = mentions.find((x) => x.sourceId === VID_DIRECT_LINK);
  assert.strictEqual(m.asin, 'B0DD4TT2SM');
});

test('buildMentions reads the ASIN out of a dp link carrying a long query string', () => {
  const mentions = buildMentions(fixture.items, NOW);
  const m = mentions.find((x) => x.sourceId === VID_MAAS_LINK);
  assert.strictEqual(m.asin, 'B0GCFPRJJ4');
});

test('buildMentions omits asin when the description has no Amazon link', () => {
  const mentions = buildMentions(fixture.items, NOW);
  const m = mentions.find((x) => x.sourceId === VID_NO_LINK);
  assert.strictEqual(m.asin, undefined);
  assert.ok(!('asin' in m));
});

test('buildMentions omits asin when the description only holds short links', () => {
  // A short link carries no ASIN. It is resolved later, by resolve-links.js.
  const mentions = buildMentions(fixture.items, NOW);
  const m = mentions.find((x) => x.sourceId === VID_SHORT_LINKS);
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
  const noAsin = mentions.find((x) => x.sourceId === VID_NO_LINK);
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
  assert.deepStrictEqual(parseAmazonProduct(amazonHtml).price, 41.39);
});

test('parseAmazonProduct reads the Best Sellers Rank integer from the fixture', () => {
  assert.deepStrictEqual(parseAmazonProduct(amazonHtml).rank, 27287);
});

test('parseAmazonProduct reads the review count from the fixture', () => {
  // The captured page renders the count as "(403)" inside the link.
  assert.deepStrictEqual(parseAmazonProduct(amazonHtml).reviews, 403);
});

test('parseAmazonProduct returns nulls, not zeros, when a field is absent', () => {
  assert.deepStrictEqual(parseAmazonProduct('<html><body></body></html>'), {
    price: null,
    rank: null,
    reviews: null,
    title: null,
  });
});

// The shapes a product page has used, kept as small inline samples so a
// layout change upstream shows up as a failing test rather than a silent null.
const PRICE_ONLY = '<span class="a-price a-text-price apexPriceToPay"><span class="a-offscreen">$14.99</span></span>';
const PRICE_TYPICAL = '<span class="a-price apex-price-to-pay-value"><span class="a-offscreen">$41.39</span></span><span class="a-offscreen">Typical: $45.99</span>';
const PRICE_ALT_TEXT =
  '<span class="a-truncate-full a-offscreen">Neck Massager, 10 Modes 16 Intensities, 3 Heads</span>' +
  '<span class="a-price apex-price-to-pay-value"><span class="a-offscreen">$41.39</span></span>';
const PRICE_WHOLE_FRACTION =
  '<span class="a-price-whole">41<span class="a-price-decimal">.</span></span><span class="a-price-fraction">39</span>';
const REVIEWS_ARIA_LABEL =
  '<span id="acrCustomerReviewText" aria-label="1,234 Reviews" class="a-size-small">(1,234)</span>';
const REVIEWS_TEXT = '<span id="acrCustomerReviewText">812 ratings</span>';

test('parseAmazonProduct reads a price out of the plain buy-box span', () => {
  assert.strictEqual(parseAmazonProduct(PRICE_ONLY).price, 14.99);
});

test('parseAmazonProduct prefers the buy-box price over the typical price', () => {
  assert.strictEqual(parseAmazonProduct(PRICE_TYPICAL).price, 41.39);
});

test('parseAmazonProduct ignores an offscreen span that holds alt text', () => {
  assert.strictEqual(parseAmazonProduct(PRICE_ALT_TEXT).price, 41.39);
});

test('parseAmazonProduct reads a price split into whole and fraction', () => {
  assert.strictEqual(parseAmazonProduct(PRICE_WHOLE_FRACTION).price, 41.39);
});

test('parseAmazonProduct reads a review count from an aria label', () => {
  assert.strictEqual(parseAmazonProduct(REVIEWS_ARIA_LABEL).reviews, 1234);
});

test('parseAmazonProduct reads a review count written as a plain number', () => {
  assert.strictEqual(parseAmazonProduct(REVIEWS_TEXT).reviews, 812);
});

test('parseAmazonProduct reads a rank that follows the Best Sellers Rank label', () => {
  const html =
    '<tr><th>Best Sellers Rank</th><td><ul><li><span>#27,287 in Health &amp; Household</span></li></ul></td></tr>';
  assert.strictEqual(parseAmazonProduct(html).rank, 27287);
});

test('isAmazonNotFound recognises the Page Not Found page', () => {
  assert.strictEqual(isAmazonNotFound(notFoundHtml), true);
});

test('isAmazonNotFound is false for a real product page', () => {
  assert.strictEqual(isAmazonNotFound(amazonHtml), false);
});

test('parseAmazonProduct finds nothing on a Page Not Found page', () => {
  assert.deepStrictEqual(parseAmazonProduct(notFoundHtml), {
    price: null,
    rank: null,
    reviews: null,
    title: null,
  });
});

test('isAmazonProductPage recognises a real product page', () => {
  assert.strictEqual(isAmazonProductPage(amazonHtml), true);
});

test('isAmazonProductPage rejects a Page Not Found page', () => {
  assert.strictEqual(isAmazonProductPage(notFoundHtml), false);
});

test('isAmazonProductPage rejects a stripped page with no product detail', () => {
  // What Amazon serves when it throttles us: nav and footer, no title, no buy
  // box. It holds no evidence, so it must not be recorded as a product.
  assert.strictEqual(isAmazonProductPage(degradedHtml), false);
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

test('parsePackQty reads the pack count from an Amazon title', () => {
  assert.equal(parsePackQty('Dog Bowl, 8 Pack'), 8);
  assert.equal(parsePackQty('Dog Bowl (Pack of 12)'), 12);
  assert.equal(parsePackQty('Dog Bowl 2-Pack'), 2);
  assert.equal(parsePackQty('Dog Bowl, Set of 4'), 4);
  assert.equal(parsePackQty('Dog Bowl, 6 Count'), 6);
});

test('parsePackQty defaults to 1 and never returns a bad divisor', () => {
  assert.equal(parsePackQty('Collapsible Silicone Dog Bowl'), 1);  // no count
  assert.equal(parsePackQty('0 Pack Weirdness'), 1);               // never 0
  assert.equal(parsePackQty(''), 1);
  assert.equal(parsePackQty(null), 1);
  assert.equal(parsePackQty('Mount for 65 inch TV'), 1);           // a size, not a pack
});

test('parseAmazonProduct returns the product title from real markup', () => {
  const html = readFileSync(new URL('../fixtures/amazon-product.html', import.meta.url), 'utf8');
  const parsed = parseAmazonProduct(html);
  assert.equal(typeof parsed.title, 'string');
  assert.ok(parsed.title.length > 10);
  assert.ok(!/^\s|\s$/.test(parsed.title));   // trimmed
});


