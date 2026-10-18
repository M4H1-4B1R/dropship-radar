// peek.js <url> — dumps one live page to fixtures/ for offline parser work.
// Opens a headed guest browser, waits, writes page HTML + innerText.
// Committed fixtures replace live re-scraping (see Global Constraints).

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node peek.js <url>');
    process.exit(1);
  }

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
