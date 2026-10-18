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
