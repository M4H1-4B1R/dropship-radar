// peek.js <url> — dumps one live page to fixtures/ for offline parser work.
// peek.js aliexpress <query> — dumps AliExpress search cards as JSON.
// Opens a headed guest browser, waits, writes page HTML + innerText.
// Committed fixtures replace live re-scraping (see Global Constraints).

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openAliexpressGuest } from './lib/browser.js';

async function captureAliexpressCards(query) {
  const { browser, page } = await openAliexpressGuest();
  try {
    const searchUrl = `https://www.aliexpress.com/w/wholesale-${encodeURIComponent(query.replace(/\s+/g, '-'))}.html`;
    console.log(`Navigating to: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Wait for cards to load
    await page.waitForTimeout(3000);
    
    // Scroll once to load more cards
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(1000);
    
    // Extract card data
    const cards = await page.evaluate(() => {
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
    
    await mkdir('fixtures', { recursive: true });
    const filename = 'aliexpress-search-cards.json';
    const filepath = path.join('fixtures', filename);
    
    // Load existing cards if any, append new ones
    let allCards = [];
    try {
      const { readFile } = await import('node:fs/promises');
      const existing = await readFile(filepath, 'utf8');
      allCards = JSON.parse(existing);
    } catch {
      // File doesn't exist yet
    }
    
    // Append new cards (avoiding duplicates by itemId)
    const existingIds = new Set(allCards.map(c => c.itemId));
    for (const card of cards) {
      if (!existingIds.has(card.itemId)) {
        allCards.push(card);
      }
    }
    
    await writeFile(filepath, JSON.stringify(allCards, null, 2));
    console.log(`Wrote ${cards.length} cards (${allCards.length} total) to fixtures/${filename}`);
    
  } finally {
    await browser.close();
  }
}

async function captureRegularPage(url) {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    locale: 'en-GB',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const html = await page.content();
  const innerText = await page.evaluate(() => document.body.innerText).catch(() => '');

  await mkdir('fixtures', { recursive: true });
  const base = (new URL(url).hostname + new URL(url).pathname.replace(/\//g, '_')).replace(/[^a-z0-9_-]/gi, '_');
  await writeFile(path.join('fixtures', `${base}.html`), html);
  await writeFile(path.join('fixtures', `${base}.txt`), innerText);

  console.log(`Wrote fixtures/${base}.html and fixtures/${base}.txt`);
  await browser.close();
}

async function main() {
  const mode = process.argv[2];
  
  if (mode === 'aliexpress') {
    const query = process.argv.slice(3).join(' ');
    if (!query) {
      console.error('Usage: node peek.js aliexpress <search query>');
      process.exit(1);
    }
    await captureAliexpressCards(query);
  } else {
    const url = mode;
    if (!url) {
      console.error('Usage: node peek.js <url>');
      console.error('   or: node peek.js aliexpress <search query>');
      process.exit(1);
    }
    await captureRegularPage(url);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
