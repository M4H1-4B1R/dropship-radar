// lib/browser.js
// Playwright contexts vs pages. A guest context is cookie-less so an IP
// cooldown never touches an account. Block detection: stop, never
// loop-retry. Copied from the FB scraper, FB-specific comments stripped,
// openProfile removed (unused here).

import { chromium } from 'playwright';

// Guest: cookie-less, headless. Used for extraction.
export async function openGuest() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'en-GB' });
  const page = await context.newPage();
  return { browser, context, page };
}

// Headed guest: no profile, no cookies, but a visible window. Search
// engines bot-challenge headless Chromium; a real headed window passes.
export async function openHeadedGuest() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    locale: 'en-GB',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  return { browser, context, page };
}

// Detect a block / login wall. If this fires, stop immediately — never
// loop-retry on a block.
export async function isBlocked(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  return (
    url.includes('/login') ||
    url.includes('/checkpoint/') ||
    url.includes('/recover') ||
    title.toLowerCase().includes('log in')
  );
}

// Detect DuckDuckGo's bot challenge page. If this fires, stop and wait
// 15+ minutes — retrying immediately makes the block longer.
export async function isSearchBlocked(page) {
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  return /bots use DuckDuckGo|anomaly|If this persists, please email us/i.test(text);
}
