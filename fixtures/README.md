# Fixtures

Captured pages, not hand-written ones. Parser tests run offline against these
files — never against a live site in a loop (see `AGENTS.md`).

| File | What it is | Captured |
|---|---|---|
| `youtube-videos-response.json` | A YouTube Data API `videos.list` response, trimmed to the fields the parser reads: `id`, `snippet.publishedAt`, `snippet.title`, `snippet.description`, `snippet.channelTitle`, `statistics.*`. Six real videos: two with a direct `amazon.com/dp` link, two with `amzn.to` short links, one with 82 links of mixed shapes, one with no Amazon link at all. | 2026-10-20 |
| `amazon-product.html` | A full Amazon product page (`amazon.com/dp/B0GCFPRJJ4`) — 2.8 MB of real markup. | 2026-10-20 |
| `amazon-product.txt` | The same page's visible text, for reading. The parser never uses it. | 2026-10-20 |
| `amazon-not-found.html` | Amazon's "Page Not Found" page (`amazon.com/dp/B00DB9WCR6`) — 2.3 KB. A delisted ASIN lands here; the validator must report `not_found`, not a product with no price. | 2026-10-20 |

## Why the YouTube fixture is trimmed

The YouTube API's terms cap how long API data may be stored. The raw response
(etag, `pageInfo`, every snippet field) is therefore never committed — only the
fields the parser reads. That is the same rule the pipeline follows when it
writes `data/mentions.jsonl`: derived fields, never a raw API blob.

## Re-capturing

```bash
# Amazon — dumps the page and its visible text into fixtures/
node peek.js "https://www.amazon.com/dp/<ASIN>"

# YouTube — the raw response lands in a temp file; only the trimmed
# fixture is committed
node --env-file=.env /path/to/capture-youtube.mjs
```

After replacing a fixture, the parser tests must be updated to the new content
and must pass before the change is committed. A fixture that no longer matches
the live page is worse than no fixture: it hides a broken parser.
