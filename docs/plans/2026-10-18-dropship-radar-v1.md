# Dropship Radar v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working end-to-end pipeline that turns YouTube product-review videos into a scored, evidence-backed shortlist of dropshipping candidates, running free on a local machine.

**Architecture:** Standalone Node ESM project. Stages are separate scripts chained through files in `data/`, each resumable and crash-safe; append-only JSONL for anything accumulated, whole-file JSON for small state. Data sources are pluggable validators behind one interface. All parsing and scoring lives in pure, tested modules; network and browser work stays in the thin stage scripts.

**Tech Stack:** Node 20.6+, ESM, `node --test`, Playwright, `csv-stringify`, native `fetch`, `node --env-file`.

**Spec:** `docs/specs/2026-10-18-dropship-radar-design.md`

## Scope

This plan covers spec §11 slices 1-5 — the complete pipeline on one validator (Amazon). It produces working, shippable software: real shortlist, real evidence, honest low confidence scores.

Spec §11 slices 6-10 (AliExpress, Ads Library, Shopify validators; Reddit and Amazon Movers seeds; `run.js`) are **deliberately not planned here.** Their tests must assert against real page markup, and no fixtures exist yet. Writing those assertions now would be fiction. They get a second plan once Task 5 has proven the fixture workflow against a live site.

## Global Constraints

Copied from the spec; every task's requirements implicitly include these.

- Node 20.6+ (`--env-file` support). ESM only (`"type": "module"`).
- **Zero running cost.** Permitted dependencies: `playwright`, `csv-stringify`. No paid APIs, no proxies, no other runtime deps. Use `node --env-file=.env`, not `dotenv`.
- **No fake zeros.** Every signal object carries `status: "ok" | "blocked" | "not_found"`. A failed lookup is never recorded as a value. `score.js` treats non-`ok` as absent, never as `0`.
- **Append-only history.** `mentions.jsonl` and `snapshots.jsonl` are appended one record at a time, immediately. Never buffered, never rewritten.
- `firstSeen` on a product must survive every run. It cannot be recovered once lost.
- **No raw YouTube API responses stored** (ToS, 30-day cap). Store derived fields only.
- All delays go through `lib/wait.js` jitter ranges; values live only in `config.js`.
- `YT_API_KEY` lives in gitignored `.env`, never in `config.js`.
- Parser work is done against committed fixtures, never by re-scraping a live site in a loop.

## Review Focus

Input classes the spec implies but which no task's happy path exercises. Each has a test pinned to the task that owns the code.

1. **Malformed JSONL line** (hand-edited or half-written on crash) — readers must skip it and continue, not throw. → Task 1.
2. **YouTube quota exhausted mid-run** (HTTP 403 `quotaExceeded`) — must stop cleanly and keep every mention already written. → Task 3.
3. **Product where every validator failed** — confidence must be `0`, not `NaN` from a zero divisor, and the product must not rank. → Task 6.
4. **Price present but cost absent or zero** — margin must be reported uncomputable, never `Infinity` or `NaN`. → Task 6.
5. **Same ASIN canonicalized into two products** — demand must not be double-counted; the duplicate must be detectable. → Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `config.js` | Queries, weights, gates, pacing. The only tuning surface. |
| `lib/wait.js` | `sleep`, `jitter`. Copied verbatim from the FB scraper. |
| `lib/store.js` | `readJson`, `writeJson`, `appendJsonl`, `loadDoneIds`. Copied, one rename. |
| `lib/browser.js` | Headed/guest launchers, block detection. Copied verbatim. |
| `lib/extract.js` | **Pure.** ASIN / AliExpress-id / price / rank / review-count parsers. |
| `lib/score.js` | **Pure.** Normalization, gates, confidence, slope, ranking. |
| `seed-youtube.js` | YouTube API → `mentions.jsonl`. Thin IO around `lib/extract.js`. |
| `canonicalize.js` | `--prepare` → `pending.json`; `--finalize` → `products.json` with `firstSeen` stamped. |
| `validators/index.js` | Registry, ordered by `cost`. |
| `validators/amazon.js` | ASIN → price, rank, reviews. |
| `validate.js` | Runner: products × validators → `snapshots.jsonl`. |
| `score.js` | `snapshots.jsonl` → `shortlist.csv` + `brief.md`. |
| `peek.js` | Dumps one live page to `fixtures/` for parser work. |

---

### Task 1: Skeleton, copied libs, and their tests

**Files:**
- Create: `package.json`, `.gitignore`, `.env.example`, `config.js`
- Create: `lib/wait.js`, `lib/store.js`, `lib/browser.js` (copied from `/home/abir/repos/genai-fb-lead-scraper/lib/`)
- Test: `lib/store.test.js`, `lib/wait.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `sleep(ms)`, `jitter([min,max]) -> int`, `readJson(path, fallback)`, `writeJson(path, data)`, `appendJsonl(path, obj)`, `loadDoneIds(path, key) -> Set<string>`, and `config` default export with `{ youtube: { queries, maxResults }, weights, gates: { minMarkup: 2.5 }, pacing }`.

- [ ] **Step 1: Scaffold the project**

`git init`. `package.json` with `"type": "module"`, deps `playwright` and `csv-stringify`, and scripts:
```json
"test": "node --test",
"seed:youtube": "node --env-file=.env seed-youtube.js",
"canonicalize": "node canonicalize.js",
"validate": "node validate.js",
"score": "node score.js"
```
`.gitignore`: `node_modules/`, `data/`, `.env`. `.env.example`: `YT_API_KEY=`.

- [ ] **Step 2: Copy the three libs**

Copy `lib/wait.js`, `lib/store.js`, `lib/browser.js` verbatim from `/home/abir/repos/genai-fb-lead-scraper/lib/`. In `store.js`, rename `loadDoneSlugs` → `loadDoneIds` and default its `key` parameter to `'sourceId'`. Delete `humanScroll` from `wait.js` (unused here). Strip the FB-specific comments from `browser.js`; keep `openGuest`, `openHeadedGuest`, `isBlocked`, `isSearchBlocked`.

- [ ] **Step 3: Write `config.js`**

Default export with `youtube.queries` (10-20 US product-review search strings, e.g. `"tiktok made me buy it"`, `"amazon must haves 2026"`), `youtube.maxResults: 50`, `gates.minMarkup: 2.5`, `weights: { adProof, demand, saturation, durability }` summing to 1, and `pacing.betweenPagesMs: [6000, 12000]`, `pacing.pauseEvery: 10`, `pacing.pauseMs: [60000, 90000]`.

- [ ] **Step 4: Write the failing tests**

```js
// lib/store.test.js
test('appendJsonl creates missing directories and appends one line per call')
test('loadDoneIds skips malformed lines and returns the valid ids')   // Review Focus 1
test('readJson returns the fallback when the file is absent')
// lib/wait.test.js
test('jitter returns an integer within [min, max] across 100 draws')
```
The malformed-line test writes a file containing one valid record, one `{not json`, one more valid record, and asserts a 2-element Set.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS (the copied libs already satisfy these; a failure means the copy was wrong).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: project skeleton with copied store/wait/browser libs"
```

---

### Task 2: `lib/extract.js` — affiliate-link ID parsers

**Files:**
- Create: `lib/extract.js`
- Test: `lib/extract.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractAsins(text) -> string[]` (deduped, uppercase, 10-char `B0`-style IDs), `extractAliexpressIds(text) -> string[]` (deduped numeric item IDs).

- [ ] **Step 1: Write the failing tests**

```js
test('extracts ASIN from amazon.com/dp/ URL')
test('extracts ASIN from amazon.com/gp/product/ URL')
test('extracts ASIN from a shortened amzn.to link only when the ASIN is in the path')
test('ignores a 10-char token that is not in an Amazon URL')
test('dedupes a repeated ASIN')
test('extracts item id from aliexpress.com/item/1005006123456789.html')
test('extracts item id from an a.aliexpress.com short link path')
test('returns [] for a linktr.ee description')   // the aggregator case, spec §13
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/extract.test.js`
Expected: FAIL, `extractAsins is not a function`.

- [ ] **Step 3: Implement both functions in `lib/extract.js`**

Regex over the text; anchor on the host and path shape, never on a bare 10-char token. Return deduped arrays preserving first-seen order.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/extract.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/extract.js lib/extract.test.js
git commit -m "feat: extract Amazon ASINs and AliExpress item ids from description text"
```

---

### Task 3: `seed-youtube.js` — YouTube Data API → `mentions.jsonl`

**Files:**
- Create: `seed-youtube.js`
- Modify: `lib/extract.js` (add `buildMentions`)
- Test: `lib/extract.test.js` (extend), `fixtures/youtube-videos-response.json`

**Interfaces:**
- Consumes: `extractAsins`, `extractAliexpressIds` (Task 2); `appendJsonl`, `loadDoneIds` (Task 1).
- Produces: `buildMentions(videoItems, now) -> Mention[]` where `Mention` is `{ source: 'youtube', sourceId, rawText, productHint, asin?, aliexpressId?, url, metric: { viewsPerDay }, seenAt }`. Writes `data/mentions.jsonl`.

- [ ] **Step 1: Capture a fixture**

Run one real `search.list` + `videos.list` pair by hand with the API key, save the `videos.list` response to `fixtures/youtube-videos-response.json`, and commit it — it is public data. This fixture is what every later test runs against, so no test needs the network or the quota.

- [ ] **Step 2: Write the failing tests**

```js
test('buildMentions computes viewsPerDay as viewCount / days since publishedAt')
test('buildMentions clamps days to a minimum of 1 for a video published today')
test('buildMentions attaches the ASIN found in the description')
test('buildMentions omits asin when the description has no Amazon link')
test('buildMentions stores no raw API response fields')   // Global Constraint: ToS
```
The last one asserts the returned object's keys are exactly the documented Mention keys.

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test lib/extract.test.js`
Expected: FAIL, `buildMentions is not a function`.

- [ ] **Step 4: Implement `buildMentions(videoItems, now)` in `lib/extract.js`**

`viewsPerDay = Number(statistics.viewCount) / Math.max(1, daysBetween(publishedAt, now))`. `productHint` is the video title left as-is — canonicalization fixes it later, this stage does not guess.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test lib/extract.test.js`
Expected: PASS.

- [ ] **Step 6: Implement `seed-youtube.js`**

For each query in `config.youtube.queries`: `search.list` (`part=id`, `type=video`, `regionCode=US`, `maxResults`), collect video IDs, drop any already in `loadDoneIds('data/mentions.jsonl')`, then `videos.list` (`part=snippet,statistics`, 50 IDs per call) and `appendJsonl` each mention as it is built. Read the key from `process.env.YT_API_KEY`; exit with a clear message if unset.

**On HTTP 403 with reason `quotaExceeded`: log the count written so far and `process.exit(0)` — not a throw, not a retry.** (Review Focus 2.)

- [ ] **Step 7: Run it for real**

Run: `npm run seed:youtube`
Expected: `data/mentions.jsonl` exists with one line per video and at least one line carrying an `asin`. Run it a second time: it adds nothing (resume works).

- [ ] **Step 8: Commit**

```bash
git add seed-youtube.js lib/extract.js lib/extract.test.js fixtures/youtube-videos-response.json
git commit -m "feat: seed mentions from YouTube Data API"
```

---

### Task 4: `canonicalize.js` — mentions → products

**Files:**
- Create: `canonicalize.js`, `docs/canonicalize.md`
- Modify: `lib/extract.js` (add `buildPending`, `finalizeProducts`)
- Test: `lib/extract.test.js` (extend)

**Interfaces:**
- Consumes: `readJson`, `writeJson` (Task 1); `data/mentions.jsonl` (Task 3).
- Produces: `buildPending(mentions) -> PendingItem[]`; `finalizeProducts(draft, existing, today) -> { products, duplicateAsins }` where a product is `{ id, name, category, asins[], aliexpressIds[], mentionIds[], firstSeen }`. Writes `data/pending.json` and `data/products.json`.

- [ ] **Step 1: Write the failing tests**

```js
test('buildPending emits one item per mention with mentionId "yt:<sourceId>"')
test('buildPending truncates rawText at 400 chars')
test('finalizeProducts stamps firstSeen=today for a product absent from existing')
test('finalizeProducts preserves the earlier firstSeen for a product already present')
test('finalizeProducts reports products sharing an ASIN')   // Review Focus 5
```
The last test passes two draft products both listing `B0AAAAAAAA` and asserts `duplicateAsins` names both product ids.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/extract.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `buildPending` and `finalizeProducts` in `lib/extract.js`**

`finalizeProducts` never invents a `firstSeen`: a product present in `existing` keeps its stored value verbatim.

- [ ] **Step 4: Implement `canonicalize.js`**

`--prepare`: read `mentions.jsonl`, write `data/pending.json`, print the path and the item count.
`--finalize <draft.json>`: read the Claude-written draft, merge against existing `data/products.json` via `finalizeProducts`, write `data/products.json`, print any `duplicateAsins` as a warning.

`--finalize` exists so `firstSeen` is stamped by code, not by hand. The spec marks it unrecoverable; a human step is the wrong place to guard it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test lib/extract.test.js`
Expected: PASS.

- [ ] **Step 6: Document the manual step**

`docs/canonicalize.md`: run `--prepare`; open a Claude Code session; have it read `data/pending.json`, merge duplicate wordings into one product each, assign `id` (kebab-case), `name`, `category`, carry over `asins`/`aliexpressIds`/`mentionIds`, write a draft; then run `--finalize`.

- [ ] **Step 7: Commit**

```bash
git add canonicalize.js lib/extract.js lib/extract.test.js docs/canonicalize.md
git commit -m "feat: canonicalization prepare/finalize with firstSeen preservation"
```

---

### Task 5: Validator framework + Amazon validator

**Files:**
- Create: `validators/index.js`, `validators/amazon.js`, `validate.js`, `peek.js`
- Modify: `lib/extract.js` (add `parseAmazonProduct`)
- Test: `lib/extract.test.js` (extend), `validate.test.js`, `fixtures/amazon-product.html`

**Interfaces:**
- Consumes: `openGuest`/`openHeadedGuest`, `isBlocked`, `appendJsonl`, `readJson`, `jitter` (Task 1); `products.json` (Task 4).
- Produces: validator module shape `{ name, needs: string[], cost: 'http'|'browser', probe(product, ctx) -> Signal }` where `Signal` is `{ status, ...fields }`; `parseAmazonProduct(html) -> { price, rank, reviews }`; `runValidation(products, validators, ctx) -> void`. Writes `data/snapshots.jsonl` with `{ productId, runAt, signals, confidence }`.

- [ ] **Step 1: Write `peek.js` and capture the Amazon fixture**

`peek.js <url>` opens a headed browser, waits, writes the page HTML and innerText to `fixtures/`. Run once against a real ASIN page, commit `fixtures/amazon-product.html`. All parser iteration from here runs offline against this file — see Global Constraints.

- [ ] **Step 2: Write the failing parser tests**

```js
test('parseAmazonProduct reads the price from the fixture')
test('parseAmazonProduct reads the Best Sellers Rank integer from the fixture')
test('parseAmazonProduct reads the review count from the fixture')
test('parseAmazonProduct returns nulls, not zeros, when a field is absent')
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test lib/extract.test.js`
Expected: FAIL.

- [ ] **Step 4: Implement `parseAmazonProduct(html)` in `lib/extract.js`**

Pure, takes HTML text. Absent field → `null`, never `0`.

- [ ] **Step 5: Write the runner smoke tests**

```js
// validate.test.js
test('appends one snapshot per product, with a signal entry per validator')
test('a validator that throws yields status "blocked", and the run continues')
test('a product missing a validator needs key yields status "not_found"')
test('two consecutive blocked results disable that validator for the rest of the run')
```
These inject two fake validators into `runValidation` — no network, no browser.

- [ ] **Step 6: Run tests to verify they fail**

Run: `node --test validate.test.js`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement `validators/index.js`, `validators/amazon.js`, `validate.js`**

`validate.js` exports `runValidation(products, validators, ctx)` so tests can inject fakes; the CLI entry is a thin wrapper loading the real registry and accepting `--max-products N`. Registry runs `cost: 'http'` before `cost: 'browser'`. `amazon.js` is `cost: 'browser'` — Amazon blocks headless fetches. Append each snapshot immediately after its product. Pace with `jitter(config.pacing.betweenPagesMs)` between products and a long pause every `pauseEvery`.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Run it for real on a small slice**

Run: `node validate.js --max-products 3`
Expected: three lines in `data/snapshots.jsonl`, each with an `amazon` signal whose `status` is `ok` or an honest `blocked`.

- [ ] **Step 10: Commit**

```bash
git add validators/ validate.js validate.test.js peek.js lib/extract.js lib/extract.test.js fixtures/amazon-product.html
git commit -m "feat: validator framework with Amazon validator"
```

---

### Task 6: Scoring and output

**Files:**
- Create: `lib/score.js`, `score.js`
- Test: `lib/score.test.js`

**Interfaces:**
- Consumes: `data/snapshots.jsonl` (Task 5); `config.weights`, `config.gates` (Task 1).
- Produces: `normalize(values) -> number[]`, `computeMargin(amazon, aliexpress) -> number|null`, `computeConfidence(signals) -> number`, `computeSlope(snapshots) -> number|null`, `rankProducts(byProduct, config) -> Ranked[]`. Writes `data/shortlist.csv` and `data/brief.md`.

- [ ] **Step 1: Write the failing tests**

```js
test('normalize maps the max to 1 and the min to 0 across the candidate set')
test('normalize returns 0.5 for every entry when all values are equal')   // zero-range divisor
test('demand averages only the components present, not treating absent as 0')
test('computeMargin returns null when the cost signal is not ok')         // Review Focus 4
test('computeMargin returns null when cost is 0')                         // Review Focus 4
test('a product below gates.minMarkup is dropped')
test('markup exactly at 2.5 is kept')
test('a product whose ad signal is ok with activeCount 0 and no rank movement is dropped')
test('a product whose ad signal is not ok is NOT dropped — unknown is not zero')
test('confidence counts registered validators only, so a one-validator run can reach 1.0')
test('computeConfidence returns 0 when every signal failed, without dividing by zero')  // Review Focus 3
test('a product with confidence below 0.5 cannot rank in the top 3')
test('computeSlope returns null below 3 snapshots and a number at 3')
test('rankProducts returns at most 10 entries')
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/score.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/score.js`**

Pure. `demand` is the mean of min-max-normalized `viewsPerDay`, Amazon `rankDelta` and Reddit mention count, **excluding absent components from the mean rather than counting them as 0**. `durability` contributes only when `computeSlope` is non-null; when it does, it takes the heaviest weight and the others rescale so the total stays 1.

Two definitions that keep a partial validator set usable, both following from the no-fake-zeros rule:

- `computeConfidence` divides by the number of **registered** validators, not by four. A one-validator run that succeeds scores 1.0.
- The no-evidence gate fires only on **known** absence: `ads.status === 'ok' && ads.activeCount === 0` and no rank movement. A non-`ok` ad signal means unknown, which never drops a product.

Without these, a v1 run on one validator yields an empty shortlist.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/score.test.js`
Expected: PASS.

- [ ] **Step 5: Implement `score.js`**

Read every line of `snapshots.jsonl`, group by `productId`, call `rankProducts`, write `data/shortlist.csv` via `csv-stringify` with columns `rank, name, category, score, confidence, margin, amazon_price, supplier_cost, ad_count, ad_max_run_days, shopify_stores, asin, first_seen, evidence_url`, and `data/brief.md` with one section per product listing each signal and its `status`. A product whose margin is `null` prints `margin: uncomputable` plus which signal was missing.

- [ ] **Step 6: Run the full pipeline**

Run: `npm run seed:youtube && node canonicalize.js --prepare` → Claude step → `node canonicalize.js --finalize draft.json && node validate.js && node score.js`
Expected: `data/shortlist.csv` with up to 10 rows, every confidence value honest about running on one validator.

- [ ] **Step 7: Commit**

```bash
git add lib/score.js lib/score.test.js score.js
git commit -m "feat: scoring, shortlist CSV and evidence brief"
```

---

## Done when

`npm test` is green, and one command sequence takes an empty `data/` to a `shortlist.csv` with real products in it. Confidence scores will be low — one validator of four is live. That is correct behavior, not a defect.
