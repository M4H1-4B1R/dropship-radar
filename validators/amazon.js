// validators/amazon.js — ASIN → price, rank, reviews.
// cost: 'browser' — Amazon blocks headless fetches, so this runs headed.
import { openHeadedGuest } from '../lib/browser.js';
import { isBlocked } from '../lib/browser.js';
import { parseAmazonProduct, isAmazonNotFound, isAmazonProductPage, parsePackQty } from '../lib/extract.js';

export default {
  name: 'amazon',
  // products.json stores `asins: [...]` (spec §5.2); a single `asin` is also
  // accepted so a hand-written product file works.
  needs: ['asins'],
  cost: 'browser',
  async probe(product, ctx) {
    const asin = product.asin || (Array.isArray(product.asins) ? product.asins[0] : null);
    if (!asin) return { status: 'not_found' };
    let browser;
    try {
      const launched = await openHeadedGuest();
      browser = launched.browser;
      const page = launched.page;
      await page.goto(`https://www.amazon.com/dp/${asin}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      if (await isBlocked(page)) return { status: 'blocked' };
      const html = await page.content();
      // A delisted ASIN lands on Amazon's "Page Not Found". That is known
      // absence, not a product that happens to have no price.
      if (isAmazonNotFound(html)) return { status: 'not_found' };
      // A stripped page — nav and footer, no product detail — is Amazon
      // throttling us. It holds no evidence, so it is a block, not a product
      // with no price.
      if (!isAmazonProductPage(html)) {
        return { status: 'blocked', error: 'degraded page: no product detail container' };
      }
      const parsed = parseAmazonProduct(html);
      return {
        status: 'ok',
        price: parsed.price,
        rank: parsed.rank,
        reviews: parsed.reviews,
        title: parsed.title,
        packQty: parsePackQty(parsed.title),
      };
    } catch (err) {
      return { status: 'blocked', error: String(err) };
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  },
};
