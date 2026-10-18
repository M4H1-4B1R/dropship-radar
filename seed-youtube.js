// seed-youtube.js — YouTube Data API v3 → data/mentions.jsonl
// Thin IO around lib/extract.js. Reads the key from YT_API_KEY (node --env-file=.env).
// Append-only: skips video IDs already in mentions.jsonl (resume-safe).
// Quota exhausted (HTTP 403 quotaExceeded): log count written so far, exit 0 — never retry.

import config from './config.js';
import { appendJsonl, loadDoneIds } from './lib/store.js';
import { sleep, jitter } from './lib/wait.js';
import { buildMentions } from './lib/extract.js';

const BASE = 'https://www.googleapis.com/youtube/v3';

let written = 0;

async function fetchJson(url) {
  const res = await fetch(url);
  if (res.status === 403) {
    const body = await res.text();
    try {
      const err = JSON.parse(body);
      const quotaExceeded = (err.error?.errors || []).some((e) => e.reason === 'quotaExceeded');
      if (quotaExceeded) {
        console.error(`YouTube quota exceeded. Mentions written so far: ${written}`);
        process.exit(0);
      }
    } catch {
      /* not JSON — fall through to generic error below */
    }
    throw new Error(`YouTube API 403: ${body}`);
  }
  if (!res.ok) {
    throw new Error(`YouTube API ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

async function searchVideoIds(query) {
  const url =
    `${BASE}/search?part=id&type=video&regionCode=US&maxResults=${config.youtube.maxResults}` +
    `&key=${encodeURIComponent(process.env.YT_API_KEY)}&q=${encodeURIComponent(query)}`;
  const data = await fetchJson(url);
  return (data.items || []).map((item) => item.id.videoId);
}

async function fetchVideos(ids) {
  const url =
    `${BASE}/videos?part=snippet,statistics&id=${ids.join(',')}` +
    `&key=${encodeURIComponent(process.env.YT_API_KEY)}`;
  const data = await fetchJson(url);
  return data.items || [];
}

async function main() {
  if (!process.env.YT_API_KEY) {
    console.error(
      'YT_API_KEY is not set. Copy .env.example to .env and add your YouTube Data API key.'
    );
    process.exit(1);
  }

  const done = await loadDoneIds('data/mentions.jsonl');
  console.log(`Seeding YouTube mentions. Already done: ${done.size}`);

  for (const query of config.youtube.queries) {
    const ids = await searchVideoIds(query);
    const newIds = ids.filter((id) => !done.has(id));
    if (newIds.length === 0) {
      console.log(`query "${query}": no new videos`);
      continue;
    }

    for (let i = 0; i < newIds.length; i += 50) {
      const chunk = newIds.slice(i, i + 50);
      const items = await fetchVideos(chunk);
      const mentions = buildMentions(items, new Date());
      for (const m of mentions) {
        await appendJsonl('data/mentions.jsonl', m);
        written++;
        done.add(m.sourceId);
      }
    }

    console.log(`query "${query}": ${newIds.length} new videos`);
    await sleep(jitter(config.pacing.betweenPagesMs));
  }

  console.log(`Done. ${written} new mentions written to data/mentions.jsonl`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
