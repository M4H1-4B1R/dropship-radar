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

// Amazon short-link hosts: amzn.to, a.co, amzn.eu.
// Returns deduped URLs preserving first-seen order, trailing sentence punctuation stripped.
const SHORT_LINK = /https?:\/\/(?:amzn\.to|a\.co|amzn\.eu)\/[A-Za-z0-9]+/gi;

export function extractShortLinks(text) {
  if (typeof text !== 'string') return [];
  const seen = new Set();
  const out = [];
  let match;
  // eslint-disable-next-line no-cond-assign
  while ((match = SHORT_LINK.exec(text)) !== null) {
    let url = match[0].replace(/[)\],.]+$/, '');
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

// asinFromUrl(url) -> string|null
// Recovers an ASIN from a resolved Amazon /dp/ or /gp/product/ URL.
// Storefront / vanity URLs (e.g. /shop/<creator>) return null.
const ASIN_FROM_URL =
  /(?:https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/)([A-Z0-9]{10})/i;

export function asinFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(ASIN_FROM_URL);
  return m ? m[1].toUpperCase() : null;
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

// mentionId(mention) -> string
// The stable id of a mention, shared by canonicalize.js and score.js.
export function mentionId(mention) {
  const prefix = SOURCE_PREFIX[mention.source] || String(mention.source);
  return `${prefix}:${mention.sourceId}`;
}

// buildPending(mentions, linkCache) -> PendingItem[]
// One pending item per mention, rawText trimmed to 400 chars.
// linkCache maps short-link URL -> { asin, resolvedAt, reason? }.
// A mention's own asin always wins over a cached one; a cached null asin is
// ignored. The cache is keyed by the short link found in the mention text —
// the mention's own url is the source page, not the link that was resolved.
export function buildPending(mentions, linkCache = {}) {
  return mentions.map((m) => {
    let asin = m.asin;
    if (!asin) {
      for (const link of extractShortLinks(m.rawText || '')) {
        const cached = linkCache[link];
        if (cached && cached.asin) {
          asin = cached.asin;
          break;
        }
      }
    }
    return {
      mentionId: mentionId(m),
      rawText: (m.rawText || '').slice(0, 400),
      productHint: m.productHint || '',
      asin,
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
//
// The rules below are the shapes a captured product page actually uses
// (fixtures/amazon-product.html). A live page carries the same string in
// several places — a list price, a "typical price", a per-unit price — so
// every rule prefers the buy box over the first number it can find.

// The buy-box price. Its class is "a-price apex-price-to-pay-value".
const APEX_PRICE_BLOCK = /class="[^"]*apex-price-to-pay-value[^"]*"/i;
// The buy-box container.
const CORE_PRICE_BLOCK = /id="corePrice_feature_div"/i;
// Any price rendered as an offscreen span. The class is also used for
// truncated image alt text, so the amount must be the whole span content.
const OFFSCREEN_AMOUNT =
  /<span[^>]*class="[^"]*a-offscreen[^"]*"[^>]*>\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*<\/span>/gi;
// A price that is not the price: "Typical: $45.99", "List price: $79.99".
const PRICE_LABEL = /(?:typical|list price|from|was)\s*[:\-]?\s*$/i;
// The visible price, split into whole and fraction, with the decimal point
// nested inside the whole span.
const PRICE_WHOLE_FRAC =
  /<span[^>]*class="[^"]*a-price-whole[^"]*"[^>]*>\s*([\d,]+)\s*(?:<span[^>]*>\s*\.\s*<\/span>)?\s*<\/span>\s*<span[^>]*class="[^"]*a-price-fraction[^"]*"[^>]*>\s*(\d{1,2})\s*<\/span>/i;
// The rank label and the rank itself.
const RANK_LABEL = /Best Sellers Rank/i;
const RANK_NUMBER = /#\s*([\d,]+)\s*in\b/i;
// The review count, in the shapes the page uses.
const REVIEWS_ARIA = /id="acrCustomerReviewText"[^>]*aria-label="([\d,]+)\s*reviews?/i;
const REVIEWS_PAREN = /id="acrCustomerReviewText"[^>]*>\s*\(\s*([\d,]+)\s*\)/i;
const REVIEWS_TEXT = /id="acrCustomerReviewText"[^>]*>\s*([\d,]+)\s*(?:ratings|reviews)/i;

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

// The first offscreen amount in a slice of the page, skipping the ones that
// are labelled as something other than the price.
function firstPriceIn(html) {
  const re = new RegExp(OFFSCREEN_AMOUNT.source, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    const before = html.slice(Math.max(0, m.index - 24), m.index);
    if (PRICE_LABEL.test(before)) continue;
    const value = numOrNull(m[1]);
    if (value !== null) return value;
  }
  return null;
}

function parsePrice(html) {
  const apex = html.search(APEX_PRICE_BLOCK);
  if (apex >= 0) {
    const price = firstPriceIn(html.slice(apex, apex + 800));
    if (price !== null) return price;
  }
  const core = html.search(CORE_PRICE_BLOCK);
  if (core >= 0) {
    const price = firstPriceIn(html.slice(core, core + 4000));
    if (price !== null) return price;
  }
  const any = firstPriceIn(html);
  if (any !== null) return any;
  const whole = html.match(PRICE_WHOLE_FRAC);
  if (whole) return numOrNull(`${whole[1]}.${whole[2]}`);
  return null;
}

function parseRank(html) {
  const label = html.search(RANK_LABEL);
  if (label >= 0) {
    const m = html.slice(label, label + 2000).match(RANK_NUMBER);
    if (m) return intOrNull(m[1]);
  }
  const m = html.match(RANK_NUMBER);
  return m ? intOrNull(m[1]) : null;
}

function parseReviews(html) {
  const aria = html.match(REVIEWS_ARIA);
  if (aria) return intOrNull(aria[1]);
  const paren = html.match(REVIEWS_PAREN);
  if (paren) return intOrNull(paren[1]);
  const text = html.match(REVIEWS_TEXT);
  if (text) return intOrNull(text[1]);
  return null;
}

// isAmazonNotFound(html) -> boolean
// True when the page is Amazon's "Page Not Found" — the ASIN is delisted or
// never existed. Known absence, not a product with no price.
export function isAmazonNotFound(html) {
  if (typeof html !== 'string') return false;
  const title = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  if (title && /page\s*not\s*found/i.test(title[1])) return true;
  return /sorry!\s*we couldn't find that page/i.test(html);
}

// isAmazonProductPage(html) -> boolean
// True when the page actually carries a product detail container. Amazon
// sometimes answers with a stripped page — nav and footer only, no title, no
// buy box — when it is throttling us. That page holds no evidence, so it is
// not a product page and must never be recorded as a product with no price.
export function isAmazonProductPage(html) {
  if (typeof html !== 'string') return false;
  return (
    /id="productTitle"/i.test(html) ||
    /id="ppd"/i.test(html) ||
    /id="dp-container"/i.test(html)
  );
}

export function parseAmazonProduct(html) {
  if (typeof html !== 'string') return { price: null, rank: null, reviews: null };
  return {
    price: parsePrice(html),
    rank: parseRank(html),
    reviews: parseReviews(html),
  };
}
