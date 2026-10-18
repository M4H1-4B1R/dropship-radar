// validators/amazon.js — ASIN → price, rank, reviews.
// cost: 'browser' — Amazon blocks headless fetches, so this runs headed.
import { openHeadedGuest } from '../lib/browser.js';
import { isBlocked } from '../lib/browser.js';
import { parseAmazonProduct } from '../lib/extract.js';

export default {
  name: 'amazon',
  needs: ['asin'],
  cost: 'browser',
  async probe(product, ctx) {
    if (!product.asin) return { status: 'not_found' };
    let browser;
    try {
      const launched = await openHeadedGuest();
      browser = launched.browser;
      const page = launched.page;
      await page.goto(`https://www.amazon.com/dp/${product.asin}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      if (await isBlocked(page)) return { status: 'blocked' };
      const html = await page.content();
      const parsed = parseAmazonProduct(html);
      return {
        status: 'ok',
        price: parsed.price,
        rank: parsed.rank,
        reviews: parsed.reviews,
      };
    } catch (err) {
      return { status: 'blocked', error: String(err) };
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  },
};
