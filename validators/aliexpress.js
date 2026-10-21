// validators/aliexpress.js — Amazon title → AliExpress going rate.
// cost: 'browser' — needs to load the search page and read cards.
import { openAliexpressGuest } from '../lib/browser.js';
import { parseAliCard, pickGoingRate } from '../lib/extract.js';
import { sleep, jitter } from '../lib/wait.js';

export default {
  name: 'aliexpress',
  needs: ['amazon.title'],
  cost: 'browser',
  async probe(product, ctx) {
    const title = ctx.signals.amazon.title;
    if (!title) return { status: 'not_found', reason: 'needs_unmet' };
    
    const cfg = ctx.config.aliexpress;
    
    // Build search query: strip bracketed asides and punctuation, take first N words
    const cleaned = title
      .replace(/\[.*?\]/g, '')  // Remove [Brand] style brackets
      .replace(/\(.*?\)/g, '')  // Remove (details) style parens
      .replace(/[^\w\s]/g, ' ') // Remove punctuation
      .replace(/\s+/g, ' ')     // Collapse whitespace
      .trim();
    
    const words = cleaned.split(' ').slice(0, cfg.queryWords);
    const query = words.join('-');
    
    if (!query) {
      return { status: 'not_found', reason: 'no_search_query' };
    }
    
    let browser;
    try {
      const launched = await openAliexpressGuest();
      browser = launched.browser;
      const page = launched.page;
      
      const searchUrl = `https://www.aliexpress.com/w/wholesale-${encodeURIComponent(query)}.html`;
      
      await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      
      // Wait for cards to load
      await page.waitForTimeout(3000);
      
      // Scroll once to trigger lazy loading
      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(1000);
      
      // Extract raw card data (itemId, text)
      const rawCards = await page.evaluate(() => {
        const cardElements = document.querySelectorAll('a[href*="/item/"]');
        const results = [];
        
        for (const card of cardElements) {
          const href = card.getAttribute('href');
          const itemIdMatch = href && href.match(/\/item\/(\d+)\.html/);
          if (!itemIdMatch) continue;
          
          const itemId = itemIdMatch[1];
          const text = card.innerText.trim();
          
          if (text && !results.some(r => r.itemId === itemId)) {
            results.push({ itemId, text });
          }
        }
        
        return results;
      });
      
      // Parse cards
      const parsedCards = rawCards.map(parseAliCard).filter(Boolean);
      
      // Check if any card has a dollar price
      const hasDollarPrice = parsedCards.length > 0;
      if (!hasDollarPrice && rawCards.length > 0) {
        // Cards exist but none have $ prices → cookie didn't work
        return { status: 'blocked', error: 'prices not in USD' };
      }
      
      // Pick going rate
      const result = pickGoingRate(parsedCards, cfg);
      
      // Pace before next product
      await sleep(jitter(ctx.config.pacing.betweenPagesMs));
      
      return result;
      
    } catch (err) {
      return { status: 'blocked', error: String(err) };
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  },
};
