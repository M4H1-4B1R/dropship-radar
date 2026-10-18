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
