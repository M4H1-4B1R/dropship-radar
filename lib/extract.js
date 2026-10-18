// lib/extract.js
// PURE: affiliate-link ID parsers. No network, no browser.
// Anchors on the host and path shape — never on a bare 10-char token.
// Returns deduped arrays preserving first-seen order.

// ASIN: 10 chars, B0-style (B0 + 8 alphanumeric).
const ASIN_CORE = 'B0[A-Z0-9]{8}';
const AMAZON_URL = new RegExp(
  '(?:https?:\\/\\/)?(?:www\\.)?amazon\\.com\\/(?:dp|gp\\/product)\\/(' + ASIN_CORE + ')',
  'gi'
);
const AMZN_URL = new RegExp('(?:https?:\\/\\/)?amzn\\.to\\/(' + ASIN_CORE + ')', 'gi');

export function extractAsins(text) {
  const seen = new Set();
  const out = [];
  for (const re of [AMAZON_URL, AMZN_URL]) {
    let match;
    // eslint-disable-next-line no-cond-assign
    while ((match = re.exec(text)) !== null) {
      const asin = match[1].toUpperCase();
      if (!seen.has(asin)) {
        seen.add(asin);
        out.push(asin);
      }
    }
  }
  return out;
}

// AliExpress item id: a run of digits in an item page or short-link path.
const AE_ITEM = /aliexpress\.com\/item\/(\d+)\.html/gi;
const AE_SHORT = /a\.aliexpress\.com\/(?:item\/)?(\d+)/gi;

export function extractAliexpressIds(text) {
  const seen = new Set();
  const out = [];
  for (const re of [AE_ITEM, AE_SHORT]) {
    let match;
    // eslint-disable-next-line no-cond-assign
    while ((match = re.exec(text)) !== null) {
      const id = match[1];
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

// Whole days between an ISO publishedAt timestamp and `nowMs`.
function daysBetween(publishedAt, nowMs) {
  const ms = nowMs - new Date(publishedAt).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// buildMentions(videoItems, now) -> Mention[]
// Pure: builds derived mention records from YouTube videos.list items.
// Stores no raw API response fields — only the documented Mention keys.
export function buildMentions(videoItems, now) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return videoItems.map((item) => {
    const snippet = item.snippet || {};
    const statistics = item.statistics || {};
    const id = item.id;
    const title = snippet.title || '';
    const description = snippet.description || '';
    const rawText = title + (description ? '\n' + description : '');
    const asins = extractAsins(description);
    const aliexpressIds = extractAliexpressIds(description);
    const days = Math.max(1, daysBetween(snippet.publishedAt, nowMs));
    const viewsPerDay = Number(statistics.viewCount || 0) / days;
    const mention = {
      source: 'youtube',
      sourceId: id,
      rawText,
      productHint: title,
      url: `https://www.youtube.com/watch?v=${id}`,
      metric: { viewsPerDay },
      seenAt: new Date(nowMs).toISOString(),
    };
    if (asins.length) mention.asin = asins[0];
    if (aliexpressIds.length) mention.aliexpressId = aliexpressIds[0];
    return mention;
  });
}

// Source prefixes used to build mentionId "<source prefix>:<sourceId>".
const SOURCE_PREFIX = { youtube: 'yt', reddit: 'rd', amazon_movers: 'am' };

// buildPending(mentions) -> PendingItem[]
// One pending item per mention, rawText trimmed to 400 chars.
export function buildPending(mentions) {
  return mentions.map((m) => {
    const prefix = SOURCE_PREFIX[m.source] || String(m.source);
    return {
      mentionId: `${prefix}:${m.sourceId}`,
      rawText: (m.rawText || '').slice(0, 400),
      productHint: m.productHint || '',
      asin: m.asin,
      aliexpressId: m.aliexpressId,
    };
  });
}

// finalizeProducts(draft, existing, today) -> { products, duplicateAsins }
// draft: human-written products without firstSeen.
// existing: previously stored products (carry firstSeen forward verbatim).
// Never invents a firstSeen — a product present in existing keeps its value.
export function finalizeProducts(draft, existing, today) {
  const byId = new Map(existing.map((p) => [p.id, p]));
  const products = [];
  const asinToProductIds = new Map();

  for (const d of draft) {
    const existingP = byId.get(d.id);
    const firstSeen = existingP ? existingP.firstSeen : today;
    const product = {
      id: d.id,
      name: d.name,
      category: d.category,
      asins: [...(d.asins || [])],
      aliexpressIds: [...(d.aliexpressIds || [])],
      mentionIds: [...(d.mentionIds || [])],
      firstSeen,
    };
    products.push(product);
    for (const asin of product.asins) {
      if (!asinToProductIds.has(asin)) asinToProductIds.set(asin, new Set());
      asinToProductIds.get(asin).add(product.id);
    }
  }

  const duplicateAsins = {};
  for (const [asin, ids] of asinToProductIds) {
    if (ids.size > 1) duplicateAsins[asin] = [...ids];
  }

  return { products, duplicateAsins };
}

// parseAmazonProduct(html) -> { price, rank, reviews }
// Pure: extracts Amazon product data from HTML text. Absent field -> null, never 0.
const PRICE_OFFSCREEN = /<span[^>]*class="[^"]*a-offscreen[^"]*"[^>]*>\s*\$?([\d,]+(?:\.\d{1,2})?)\s*<\/span>/i;
const PRICE_WHOLE_FRAC =
  /<span[^>]*class="[^"]*a-price-whole[^"]*"[^>]*>\s*([\d,]+)\s*<\/span>\s*<span[^>]*class="[^"]*a-price-fraction[^"]*"[^>]*>\s*(\d{1,2})\s*<\/span>/i;
const RANK_RE = /(?:Best Sellers Rank\D{0,40})?#\s*([\d,]+)\s*in\b/i;
const REVIEWS_RE = /id="acrCustomerReviewText"[^>]*>\s*([\d,]+)\s*(?:ratings|reviews)\s*<\/span>/i;

function numOrNull(text) {
  if (text == null) return null;
  const n = parseFloat(String(text).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function intOrNull(text) {
  if (text == null) return null;
  const n = parseInt(String(text).replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

export function parseAmazonProduct(html) {
  if (typeof html !== 'string') return { price: null, rank: null, reviews: null };
  let price = null;
  const m1 = html.match(PRICE_OFFSCREEN);
  if (m1) price = numOrNull(m1[1]);
  else {
    const m2 = html.match(PRICE_WHOLE_FRAC);
    if (m2) price = numOrNull(`${m2[1]}.${m2[2]}`);
  }
  const rankM = html.match(RANK_RE);
  const reviewsM = html.match(REVIEWS_RE);
  return {
    price,
    rank: rankM ? intOrNull(rankM[1]) : null,
    reviews: reviewsM ? intOrNull(reviewsM[1]) : null,
  };
}
