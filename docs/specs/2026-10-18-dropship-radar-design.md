# Dropship Radar — Design Spec

Date: 2026-10-18
Status: approved, not yet implemented
Scope: standalone project. No code, config or dependency shared with `genai-fb-lead-scraper`.

## 1. Purpose

Produce a weekly ranked shortlist of ~10 physical products that look viable for US dropshipping,
with the evidence for each, assembled entirely from free data sources on a local machine.

Primary user: internal, single operator. Output feeds a human's buy/test decision.

### What this is not

The output is **a ranked candidate list with evidence and a confidence level**, not a profitability
verdict. No free data source knows anyone's real unit economics. The system's job is to narrow
hundreds of noisy product mentions to ten worth a human's time, and to show its work so the human
can disagree with it.

### Non-goals

- No storefront, no order placement, no supplier contact.
- No paid APIs, no paid data vendors, no proxies. Hard constraint: zero running cost.
- No unattended operation. One pipeline stage requires a Claude Code session (see §5.3).
- No market other than US in v1.

## 2. Decisions and rationale

| Decision | Chosen | Why |
|---|---|---|
| Seed sources | YouTube Data API, Reddit, Amazon Movers & Shakers | Free, product-name-bearing, no ban risk |
| Instagram | **Rejected** | Logged-out IG is a login wall; reading it at scale needs a session cookie, and fresh accounts get disabled |
| TikTok Creative Center | **Rejected** | Spike 2026-10-16: no login wall, but no product data exists any more (see §2.1) |
| Target market | US | Deepest free data: Amazon.com, Ads Library US, Trends US, most Shopify stores |
| Time dimension | Hybrid | Run 1 ranks on same-day signals; trend-slope scoring auto-enables at 3+ snapshots per product |
| Product-name normalization | Claude Code as a pipeline step | Free under existing subscription, best quality on slang; weekly cadence makes the manual step acceptable |
| Funnel | ~200 mentions → ~40 candidates → full validation → top 10 | ~1-2h wall clock at polite pacing |
| Architecture | File-chained stages + pluggable validators | Stages give resume and crash-safety; the validator interface makes flaky sources survivable |

### 2.1 TikTok spike result (2026-10-16)

Measured, not assumed:

- No login wall. Creative Center pages render for a fresh browser profile.
- `/inspiration/popular` and `/top-products` both redirect to `/trends/hashtag`. The product list no
  longer exists; the service is now "TikTok One Creative Suite".
- The only ranked data served is hashtags, via XHR `ads.tiktok.com/CreativeOne/KnowledgeAPI/GetHashtagList`
  returning `{items[], pagination}` with `popularityCurve`, `publishCnt`, `vv`, `rankIndex`.
- That endpoint returns 404 to plain `curl` — it requires browser context.
- Top US hashtags were culture and news (`#tiktokscaryhorrorcontest`, `#hurricaneisaias`), not products.

Conclusion: no product signal. Revisit only as an optional topic-level tailwind, lowest priority.

### 2.2 Why YouTube is the primary seed

Review-video descriptions carry affiliate links, which yield an **exact join key** instead of a
product name. That removes the noisiest part of cross-referencing: Amazon validation becomes "fetch
this ASIN" rather than "search this phrase and hope the top hit is the same object".

**Measured 2026-10-19 over 452 real mentions from 10 queries** — the link form matters more than
expected:

| Link form in description | Mentions | Share |
|---|---|---|
| `amzn.to` shortener | 92 | 20.4% |
| direct `amazon.com/dp/` | 13 | 2.9% |
| `amzn.eu` / `a.co` | 6 | 1.3% |
| `amazon.com/gp/product/` | 0 | 0% |
| any AliExpress link | 3 | 0.7% |
| mentions "amazon" at all | 361 | 79.9% |

Creators overwhelmingly use the `amzn.to` shortener, whose path is an opaque slug carrying no ASIN.
**1,449 distinct short links** appeared in those 452 mentions. A HEAD request with redirect-follow
resolves each to its real product URL — verified on a sample: `amzn.to/3se9dWO` →
`amazon.com/dp/B018IBEHQU`. Free, keyless, cacheable.

Without resolution the hit-rate is 2.7%, which would starve the pipeline. With it, the ~1,449 links
are the actual candidate pool. Hence the `resolve-links` stage in §4.

**Re-measured 2026-10-20 over 557 mentions** (105 more videos, same queries), after the resolver
and the cache join were in place:

| Measure | Value |
|---|---|
| mentions with a direct `amazon.com/dp` ASIN | 17 (3.1%) |
| mentions carrying an `amzn.to` / `a.co` link | 121 (21.7%) |
| distinct short links seen | 1,703 |
| short links attempted and resolved to an ASIN | 666 of 1,457 (45.7%) |
| **mentions with a known ASIN** (direct or resolved) | **82 (14.7%)** |

Two numbers matter and they are not the same: 45.7% of the links the resolver *attempted* resolved,
and 14.7% of mentions ended up with a usable ASIN. The gap is the resolver's rate limit — it stopped
on HTTP 429 with 246 links still unattempted — and descriptions that carry only storefront or
non-product links. Re-running the resolver raises the first number, not the second.

Also measured: 11.7% of descriptions route through a link aggregator (linktr.ee, beacons.ai, ltk),
and the direct `amazon.com` links that do appear are mostly creator **storefronts**
(`/shop/<creator>`, `/shop/.../list/<id>`), not product pages. Storefront list pages hold many
products each and could be mined later; out of scope for v1.

It is also the only officially free, keyed API in the design — no scraping, no block risk, no browser.

Quota budget (YouTube Data API v3, 10,000 units/day, no billing card):

| Call | Unit cost | Planned use | Units |
|---|---|---|---|
| `search.list` | 100 | 20 queries/run | 2,000 |
| `videos.list` | 1 per call, 50 IDs each | 20 calls | 20 |
| Headroom | | | ~80% unused |

## 3. Project layout

```
dropship-radar/
  config.js              queries, weights, gates, pacing
  .env.example           YT_API_KEY=
  .gitignore             data/ .env node_modules/
  seed-youtube.js        YT Data API → mentions.jsonl
  seed-reddit.js         reddit public JSON → mentions.jsonl
  seed-amazon.js         Movers & Shakers, headed browser → mentions.jsonl
  resolve-links.js       amzn.to/a.co redirects → link-cache.json  (cached, keyless)
  canonicalize.js        --prepare → pending.json   (Claude then writes products.json)
  validate.js            products.json → snapshots.jsonl
  score.js               snapshots.jsonl → shortlist.csv + brief.md
  run.js                 orchestrator, --dry-run
  validators/
    index.js             registry, ordered cheap → expensive
    amazon.js            needs asin
    aliexpress.js        needs aliexpressId
    adslibrary.js        needs name
    shopify.js           needs name
  lib/
    browser.js           headed/guest launchers, block detection
    wait.js              sleep, jitter
    store.js             readJson, writeJson, appendJsonl, loadDone
    extract.js           PURE: ASIN / item-id / price / count parsers
    score.js             PURE: formula, gates, confidence, slope
    *.test.js
  fixtures/              committed page dumps; parser tests run offline
  data/                  gitignored outputs
  docs/specs/            this file
```

`lib/browser.js`, `lib/wait.js` and `lib/store.js` are **copied** from the FB scraper (~150 lines
total), not imported. Three small files beat a shared package for two unrelated projects.

## 4. Pipeline

```
seed-*.js  →  data/mentions.jsonl      append per mention
    ↓
resolve-links.js → data/link-cache.json   short link → ASIN, resolved once, cached
    ↓
canonicalize.js --prepare → data/pending.json   (joins the cache in)
    ↓  [Claude Code session]
data/products.json                      rewritten whole, small
    ↓
validate.js → data/snapshots.jsonl      append one line per product per run
    ↓
score.js   → data/shortlist.csv + data/brief.md
```

Each stage is runnable standalone. `run.js` only sequences them via `spawnSync`, as in the FB scraper.

| Stage | Resume key |
|---|---|
| `seed-youtube` | video IDs already in `mentions.jsonl` |
| `seed-reddit` | post IDs already in `mentions.jsonl` |
| `seed-amazon` | run date already seen |
| `resolve-links` | URLs already keyed in `link-cache.json` |
| `validate` | `productId` already snapshotted with today's `runAt` date |

## 5. Data contracts

### 5.1 `mentions.jsonl` (append-only)

```jsonc
{
  "source": "youtube" | "reddit" | "amazon_movers",
  "sourceId": "video/post/asin id — the resume key",
  "rawText": "title + description excerpt",
  "productHint": "best-effort noun phrase, may be empty",
  "asin": "B0XXXXXXXX",          // optional, from affiliate link
  "aliexpressId": "1005006...",  // optional, from affiliate link
  "url": "...",
  "metric": { "viewsPerDay": 4210 },   // or upvotes, or rankDelta
  "seenAt": "2026-10-18T09:00:00.000Z"
}
```

`mentionId` referenced elsewhere is `"<source prefix>:<sourceId>"` — `yt:`, `rd:`, `am:`. It is derived,
not stored on the mention itself.

Only derived fields are stored. Raw YouTube API responses are **not** retained — see §10.

### 5.2 `products.json` (rewritten whole)

```jsonc
{
  "id": "collapsible-dog-bowl",
  "name": "Collapsible Silicone Dog Bowl",
  "category": "pet",
  "asins": ["B0XXXXXXXX"],
  "aliexpressIds": ["1005006..."],
  "mentionIds": ["yt:abc123", "rd:def456"],
  "firstSeen": "2026-10-18"
}
```

`firstSeen` must be preserved across runs — it is the age signal and cannot be recovered once lost.

### 5.3 Canonicalization step

`canonicalize.js --prepare` writes `data/pending.json`: a compact array of `{mentionId, rawText,
productHint, asin, aliexpressId}`, trimmed so the batch fits one context window. A Claude Code
session reads it, merges duplicates (same product, different wording), assigns `id`/`name`/`category`,
and writes `data/products.json`, carrying `firstSeen` forward from the existing file.

No API key, no model call from code. The pipeline simply pauses here.

### 5.4 `snapshots.jsonl` (append-only, the history)

```jsonc
{
  "productId": "collapsible-dog-bowl",
  "runAt": "2026-10-18T10:14:00.000Z",
  "signals": {
    "amazon":     { "status": "ok", "price": 14.99, "rank": 3120, "reviews": 812 },
    "aliexpress": { "status": "ok", "cost": 2.41, "orders": 5300 },
    "ads":        { "status": "ok", "activeCount": 23, "maxRunDays": 74 },
    "shopify":    { "status": "blocked" }
  },
  "confidence": 0.75
}
```

**The rule that keeps this honest: a validator never writes `0` for a failure.** Every signal object
carries `status: "ok" | "blocked" | "not_found"`. A blocked AliExpress lookup must never read as a
zero supplier cost. `score.js` treats a non-`ok` signal as absent, not as a value.

Snapshots are never rewritten. `score.js` groups all historical lines by `productId`.

### 5.5 `link-cache.json` (rewritten whole)

```jsonc
{
  "https://amzn.to/3se9dWO": { "asin": "B018IBEHQU", "resolvedAt": "2026-10-19" },
  "https://amzn.to/3deadXX": { "asin": null, "reason": "no_dp_in_target", "resolvedAt": "2026-10-19" }
}
```

A resolved-to-nothing link is stored with `asin: null` and a reason, so it is never retried on every
run. `null` here means "resolved, no product" — distinct from a key being absent, which means "not
yet attempted". The same ok/blocked/not_found discipline as §5.4, in a different shape.

**`mentions.jsonl` is never rewritten to backfill ASINs.** The cache is joined in at canonicalization
time, which keeps the append-only history intact and makes already-collected mentions usable without
spending API quota again.

## 6. Validator contract

```js
export default {
  name: 'amazon',
  needs: ['asin'],        // key missing → skip, record { status: 'not_found' }
  cost: 'browser',        // 'http' validators run first; Amazon blocks headless, so it is 'browser'
  async probe(product, ctx) {   // ctx = { page, config }
    return { status: 'ok', price, rank, reviews };
  },
};
```

`validate.js`:

1. Loads `products.json`, filters out products already snapshotted today.
2. For each product, runs the registry in `cost` order, collecting signals.
3. Appends one snapshot line immediately after each product — a crash loses at most one product.
4. Never lets a validator throw escape: `try/catch` → `{ status: 'blocked', error }`.

Adding a source later (Etsy, Alibaba) is one file plus a registry line.

## 7. Scoring

In `lib/score.js`, pure, fully tested.

| Term | Formula | Role |
|---|---|---|
| `margin` | markup multiple: `amazon.price / aliexpress.cost` | **Hard gate**: markup < 2.5x → drop. `null` when the cost is missing, blocked or zero — never `Infinity`, never a fake 0 |
| `gross margin` | `(amazon.price − aliexpress.cost) / amazon.price` | Reported next to the markup in the brief; never used for a gate |
| `ad_proof` | `activeCount × maxRunDays` | Heaviest weight in run 1 |
| `demand` | mean of its three components, each min-max normalized across the current candidate set: `viewsPerDay`, Amazon `rankDelta`, Reddit mention count | 0-1; absent components are excluded from the mean, not treated as 0 |
| `saturation` | `shopify.storeCount` | Penalty — high means late |
| `durability` | slope of `ad_proof` + `demand` across snapshots | Off below 3 snapshots; heaviest once on |
| `confidence` | fraction of **registered** validators returning `ok` (not of all four — a one-validator run can reach 1.0) | Displayed; below 0.5 cannot rank in the top 3 |

The markup multiple, not the gross ratio, is what the gate uses: the gate is expressed in
multiples (2.5x), so the gate value and the margin value have to be the same number. The gross
ratio is kept alongside it for reading, not for deciding.

Hard gates, applied before weighting:

- Markup below 2.5x → dropped.
- Known-absent ad proof (`ads.status === "ok"` with `activeCount` 0) **and** no Amazon rank movement → dropped
  (attention without purchase evidence). A non-`ok` ad signal is unknown, not zero, and never drops a product —
  otherwise a run without the Ads Library validator would drop every candidate.
- `margin` uncomputable because either price signal is non-`ok` → not dropped, but capped out of the
  top 3 and flagged in the brief.

Ranking follows the caps literally: products that earn a top-3 slot (a computable margin and a
confidence of at least 0.5) take ranks 1, 2, 3; every other candidate is ranked from 4 downwards, so
a v1 run without the AliExpress validator produces a list that starts at rank 4 rather than a list
whose first three entries broke the rule. The brief says so in one line when it happens.

**Why `ad_proof` carries the most weight:** a competitor paying to run the same ad for 60+ days is
unit-economics evidence produced by someone who has the real numbers. Views and upvotes only prove
attention. This is the closest free proxy to "profitable in the long run" that exists.

The weights and the 2.5x gate are starting guesses. They live in `config.js` and are expected to be
retuned after the first real shortlist is checked against known winners and losers.

## 8. Failure handling and pacing

- Every validator failure becomes a `status`, never an exception that escapes.
- Two consecutive `blocked` results from one validator → that validator is disabled for the rest of
  the run, and every later snapshot records it as `blocked`.
- Block detection is copied from the FB scraper: **stop, never loop-retry.**
- All delays go through `lib/wait.js` jitter ranges; values live only in `config.js`. Random delay
  between browser hits, longer pause every 10 products.
- `YT_API_KEY` lives in a gitignored `.env`, never in `config.js`.

## 9. Testing

Pure modules carry the tests, the same reason `parse.js` is the only tested module in the FB scraper.

Required coverage:

- `lib/extract.js`: ASIN extraction from description text, AliExpress item-id extraction, price
  parsing across formats, store-count parsing from search results, link-aggregator URLs yielding
  nothing rather than garbage.
- `lib/score.js`: margin gate at and around 2.5x, both no-evidence drop conditions, confidence
  arithmetic, slope with 1 / 2 / 3 / 6 snapshots, and every signal-absent path.
- `validate.js`: one assert-based smoke test wiring a fake validator, asserting a snapshot is appended
  per product and that a throwing validator yields `blocked` rather than crashing the run.

**Fixtures are the cost control.** Each validator's target page is dumped once into `fixtures/` and
committed. Parser tests then run offline against the fixture. This turns a ~30k-token
scrape-read-fix loop into a ~2k-token test loop, and it is the difference between the 250-400k and
the 1M+ build estimate. No parser work may be done by repeatedly re-scraping a live site.

## 10. Legal and ToS constraints

These are constraints on the build, not disclaimers:

- **YouTube API ToS caps storage of API data at 30 days for most fields.** Snapshots must therefore
  store derived signals (ASIN, velocity number, title) rather than raw API responses. This matters
  because snapshot history is meant to accumulate for months; retrofitting it later would mean
  discarding history.
- Amazon, AliExpress and Facebook terms prohibit automated collection. This is internal, low-volume,
  human-paced reading of public pages. Keep the pacing caps; they are what makes that defensible.
- Output stays local. No resale, no redistribution of scraped data.
- Reddit's public JSON endpoints require a descriptive User-Agent; set one.

## 11. Build order

Each slice ends with something runnable.

1. **Skeleton** — `config.js`, copied `lib/`, `.env.example`, `.gitignore`, `store`/`wait` tests.
2. **Seed: YouTube** — the highest-value source, and the only one needing no browser. Ends with
   `mentions.jsonl`.
2a. **Resolve links** — `amzn.to`/`a.co` redirects → `link-cache.json`. Without this the ASIN
   hit-rate is 2.7% and nothing downstream has enough products to rank (§2.2).
3. **Canonicalize** — `--prepare` (joining the link cache) plus the documented Claude step. Ends with
   `products.json`.
4. **Validator framework + Amazon** — registry, `validate.js`, snapshot writing, one real validator.
5. **Scoring + output** — `lib/score.js`, `score.js`, `shortlist.csv`, `brief.md`. **End-to-end
   pipeline works here** on one validator, with low confidence scores that are honest about it.
6. **AliExpress validator** — margin becomes computable; the gate switches on.
7. **Ads Library validator** — `ad_proof` switches on.
8. **Shopify saturation validator** — DuckDuckGo `site:myshopify.com "<name>"` count.
9. **Reddit + Amazon Movers seeds** — widen the funnel.
10. **`run.js`** orchestrator with `--dry-run`.

Slices 6-8 are independent and can be reordered or dropped without breaking 1-5.

## 12. Expected build cost

| | Tokens |
|---|---|
| Slices 1-5 (end-to-end, one validator) | 250-400k with fixture discipline |
| Each additional validator | 80-200k |
| Per weekly run (canonicalize + review shortlist) | 30-60k |

## 13. Open risks

- **Validator parsers are unproven against live markup.** Nothing in §6-7 has been tested against a
  real Amazon, AliExpress or Ads Library page. This is the estimate most likely to move.
  **Closed for Amazon on 2026-10-20** (Task 8): the parser now runs against a captured product page
  (`fixtures/amazon-product.html`), and price, rank and review count all parse from real markup.
  AliExpress and the Ads Library are still unproven.
- **ASIN hit-rate is now measured, and depends entirely on link resolution** (§2.2): 3.1% of mentions
  carry a direct ASIN, 14.7% after resolution. Resolution was verified on a 3-link sample only.
  Expect real coverage below 100% — dead links, region redirects, and links pointing at storefronts
  rather than products. If `amzn.to` rate-limits at volume, the resolver must stop on 429, not grind.
  It did: the 2026-10-20 run stopped on 429 with 246 links unattempted.
- **Query quality is mediocre.** "tiktok made me buy it" surfaced talk shows and vlogs rather than
  affiliate reviewers. 79.9% of mentions name Amazon, so the queries work, but filtering to videos
  that actually carry affiliate links would raise signal. A `config.js` change, not a code change.
- **Scoring weights are uncalibrated.** First shortlist should be checked against products already
  known to have won or lost before the numbers are trusted.
- **Shopify store count via a search engine is a rough proxy** for saturation, biased by indexing lag.
- **Any of the four scraped sources can break without warning.** The validator interface contains the
  blast radius to one file and one signal; it does not prevent the breakage.
