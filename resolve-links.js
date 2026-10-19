// resolve-links.js — resolve amzn.to / a.co / amzn.eu short links to ASINs.
// Native fetch with redirect: 'follow'. Writes data/link-cache.json keyed by URL
// -> { asin, resolvedAt, reason? }. Resume-safe: URLs already cached (incl. asin: null) are skipped.
// No new dependency — uses native fetch.

import { readFile } from 'node:fs/promises';
import { readJson, writeJson } from './lib/store.js';
import { sleep, jitter } from './lib/wait.js';
import { extractShortLinks, asinFromUrl } from './lib/extract.js';
import config from './config.js';

const MENTIONS_PATH = 'data/mentions.jsonl';
const CACHE_PATH = 'data/link-cache.json';
const BATCH = 4; // at most 4 in flight

class RateLimited extends Error {
  constructor() { super('rate limited (429)'); this.name = 'RateLimited'; }
}

async function readMentionsJsonl(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    const mentions = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { mentions.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
    }
    return mentions;
  } catch {
    return [];
  }
}

function collectShortLinks(mentions) {
  const links = new Set();
  for (const m of mentions) {
    for (const u of extractShortLinks(m.rawText || '')) links.add(u);
  }
  return [...links];
}

// Resolve one short link: HEAD with redirect-follow, then extract ASIN from final URL.
// 405 on the final page is expected and harmless — the redirect has already landed.
// 429 stops the whole run.
async function resolveOne(url) {
  const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  if (res.status === 429) throw new RateLimited();
  const finalUrl = res.url || url;
  const asin = asinFromUrl(finalUrl);
  if (asin) return { asin, resolvedAt: new Date().toISOString() };
  return { asin: null, resolvedAt: new Date().toISOString(), reason: 'not_a_product' };
}

async function main() {
  const mentions = await readMentionsJsonl(MENTIONS_PATH);
  const links = collectShortLinks(mentions);
  const cache = await readJson(CACHE_PATH, {});

  const pending = links.filter((u) => !(u in cache));
  console.log(`Resolving ${pending.length} new short links (${links.length} total, ${Object.keys(cache).length} cached)`);

  let resolved = 0;
  let nextWrite = 25; // write the cache after every 25 resolutions
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map((u) => resolveOne(u)));

    let hitRateLimit = false;
    for (let idx = 0; idx < batch.length; idx++) {
      const u = batch[idx];
      const r = results[idx];
      if (r.status === 'rejected') {
        if (r.reason instanceof RateLimited) {
          hitRateLimit = true;
          break;
        }
        cache[u] = { asin: null, resolvedAt: new Date().toISOString(), reason: String(r.reason) };
      } else {
        cache[u] = r.value;
      }
    }
    resolved += batch.length;

    if (hitRateLimit) {
      await writeJson(CACHE_PATH, cache);
      console.log('HTTP 429 rate limited. Cache written, exiting. Never retry in a loop.');
      process.exit(0);
    }

    // Write the cache after every 25 resolutions so an interrupted run keeps its work.
    if (resolved >= nextWrite || i + BATCH >= pending.length) {
      await writeJson(CACHE_PATH, cache);
      nextWrite += 25;
    }

    // Pacing: jitter between batches (skip after the last batch).
    if (i + BATCH < pending.length) {
      await sleep(jitter(config.pacing.betweenPagesMs));
    }
  }

  await writeJson(CACHE_PATH, cache);
  let okCount = 0;
  for (const v of Object.values(cache)) if (v.asin) okCount++;
  console.log(`Done. ${okCount} of ${Object.keys(cache).length} cached links resolved to an ASIN.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
