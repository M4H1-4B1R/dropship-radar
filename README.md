# Dropship Radar

> Turn YouTube product-review videos into a scored, evidence-backed shortlist of ~10 dropshipping candidates — free, local, no paid APIs.

The pipeline harvests product mentions from YouTube (and later Reddit and Amazon Movers & Shakers), resolves affiliate short-links to ASINs, validates each candidate against Amazon, and scores them into a ranked CSV and human-readable brief. A one-off Claude session in the middle merges duplicates and assigns canonical names so the rest of the pipeline can be fully automated.

---

## How it works

```
seed-youtube.js  ─────────────────────────────────────────► data/mentions.jsonl
                                                               │
resolve-links.js  (amzn.to / a.co → ASIN, cached) ──────► data/link-cache.json
                                                               │
canonicalize.js --prepare ──────────────────────────────► data/pending.json
                                                               │
        ⬇  Claude Code session  ⬇
        (merge duplicates, assign id/name/category, write draft.json)
                                                               │
canonicalize.js --finalize draft.json ──────────────────► data/products.json
                                                               │
validate.js ────────────────────────────────────────────► data/snapshots.jsonl
                                                               │
score.js ───────────────────────────────────────────────► data/shortlist.csv
                                                             data/brief.md
```

### Stage-by-stage

| Stage | What it does |
|---|---|
| **`seed-youtube.js`** | Calls the YouTube Data API for each query in `config.js`. Skips videos already seen. Writes one JSONL record per video (derived fields only — no raw API response stored, per YouTube ToS). |
| **`resolve-links.js`** | Reads every `amzn.to` / `a.co` short-link from `mentions.jsonl` and resolves it to an ASIN via a `HEAD` redirect-follow. Results are cached to `link-cache.json` so links are only resolved once. Stops cleanly on HTTP 429. |
| **`canonicalize.js --prepare`** | Joins the link cache into the mention list, trims to one line per mention (≤ 400 chars), and writes `data/pending.json` ready for a Claude session. |
| **Claude session** *(manual)* | Reads `pending.json`, merges duplicate wordings into one product per ASIN, assigns a kebab-case `id`, a readable `name`, and a `category`. Writes `draft.json`. |
| **`canonicalize.js --finalize`** | Merges the draft into `products.json`, stamps `firstSeen` on new products (preserved forever; cannot be recovered once lost), and warns about any ASIN shared between two products. |
| **`validate.js`** | Runs each product through the validator registry (cheap → expensive). Each validator returns `{ status: "ok" \| "blocked" \| "not_found", ...fields }` — **never a fake zero**. Appends one snapshot line per product immediately (crash-safe). Two consecutive `blocked` results from one validator disables it for the rest of the run. |
| **`score.js`** | Groups snapshot history by product. Applies hard gates, then scores and ranks. Writes `shortlist.csv` and `brief.md`. |

### Scoring formula

| Signal | Role |
|---|---|
| `margin` (markup multiple) | **Hard gate**: markup < 2.5× → dropped |
| `ad_proof` (`activeCount × maxRunDays`) | Heaviest weight. A long-running competitor ad is the closest free proxy to "unit-economics evidence". |
| `demand` | Mean of min-max-normalised `viewsPerDay`, Amazon `rankDelta`, Reddit mention count. Absent components are excluded from the mean, never treated as zero. |
| `saturation` (`shopify.storeCount`) | Penalty — high means late to market. |
| `durability` | Slope of `ad_proof + demand` across snapshot history. Activates at ≥ 3 snapshots. |
| `confidence` | Fraction of registered validators that returned `ok`. A one-validator run can reach 1.0. Below 0.5 → capped out of top 3. |

Hard gate rules before weighting:
- Markup < 2.5× → dropped.
- `ads.status === "ok"` with `activeCount === 0` **and** no Amazon rank movement → dropped (attention without purchase evidence). A non-`ok` ad signal means "unknown", never drops a product.
- Uncomputable margin → not dropped, but capped out of top 3 and flagged in the brief.

Weights (`config.js`): `adProof: 0.4`, `demand: 0.3`, `saturation: 0.2`, `durability: 0.1`. These are starting guesses — retune after the first real shortlist.

---

## Setup

### Prerequisites

- **Node 20.6+** (required for `node --env-file` support)
- A free [YouTube Data API v3 key](https://console.cloud.google.com/apis/library/youtube.googleapis.com) (10,000 units/day, no billing card required)

### Install

```bash
git clone https://github.com/youruser/dropship-radar
cd dropship-radar
npm install
npx playwright install chromium   # headed browser for Amazon validation
```

### Configure

```bash
cp .env.example .env
# Edit .env and set YT_API_KEY=your_key_here
```

Tune queries, scoring weights, and pacing in [`config.js`](config.js) — that is the **only tuning surface**. The API key never goes in `config.js`.

---

## Usage

Run the stages in order. Each stage is independently resumable — re-running picks up where it left off.

### 1 · Seed YouTube

```bash
npm run seed:youtube
```

Fetches product-review videos for each query in `config.js` and appends to `data/mentions.jsonl`. Safe to re-run; already-seen video IDs are skipped. Stops cleanly if the daily quota (10k units) is exhausted.

### 2 · Resolve short-links

```bash
node resolve-links.js
```

Resolves `amzn.to` / `a.co` links to ASINs and writes `data/link-cache.json`. Run once; already-resolved URLs are skipped. Stops on HTTP 429 with a clear message — just re-run later.

### 3 · Prepare for canonicalization

```bash
node canonicalize.js --prepare
```

Joins the link cache into mentions and writes `data/pending.json`.

### 4 · Claude canonicalization session *(manual)*

Open a Claude Code session, point it at `data/pending.json`, and ask it to:

1. Merge mentions that describe the same product into one entry.
2. Assign a kebab-case `id`, a readable `name`, and a `category`.
3. Write the result to `draft.json`.

See [`docs/canonicalize.md`](docs/canonicalize.md) for the exact prompt.

### 5 · Finalize products

```bash
node canonicalize.js --finalize draft.json
```

Merges the draft into `data/products.json` with `firstSeen` preserved.

### 6 · Validate

```bash
node validate.js
# or limit to a small slice while testing:
node validate.js --max-products 5
```

Runs each product through the validator registry and appends to `data/snapshots.jsonl`. Opens a headed Chromium window for Amazon (Amazon blocks headless). Pacing is intentionally human-slow (~6–12 s between pages, 60–90 s pause every 10 products). Expect a full run over 40 products to take 1–2 hours.

> **Note:** Amazon throttles by IP after ~240 page loads in a day. When this happens the validator records `blocked` and disables itself for the rest of the run. Allow a few hours of cooldown between large validation runs.

### 7 · Score

```bash
node score.js
```

Reads `data/snapshots.jsonl`, scores and ranks all products, and writes:
- `data/shortlist.csv` — ranked table with all signals
- `data/brief.md` — one section per product with evidence and status for every signal

### Full pipeline (one command chain)

```bash
npm run seed:youtube && node resolve-links.js && node canonicalize.js --prepare
# → manual Claude step → write draft.json
node canonicalize.js --finalize draft.json && node validate.js && node score.js
```

---

## Project layout

```
config.js              Queries, weights, gates, pacing — the only tuning surface
.env.example           YT_API_KEY=
seed-youtube.js        YouTube Data API → data/mentions.jsonl
resolve-links.js       amzn.to/a.co redirects → data/link-cache.json
canonicalize.js        --prepare → pending.json | --finalize draft.json → products.json
validate.js            products.json → data/snapshots.jsonl
score.js               snapshots.jsonl → data/shortlist.csv + data/brief.md
peek.js                Dumps one live page to fixtures/ for offline parser work
lib/
  wait.js              sleep, jitter
  store.js             readJson, writeJson, appendJsonl, loadDoneIds
  browser.js           headed/guest launchers, block detection
  extract.js           PURE: ASIN / AliExpress-id / price / rank / review parsers
  score.js             PURE: normalization, gates, confidence, slope, ranking
  *.test.js
validators/
  index.js             Registry, ordered cheap → expensive
  amazon.js            ASIN → price, rank, reviews (cost: 'browser')
fixtures/              Committed page dumps — parser tests run offline, never re-scrape
data/                  Gitignored outputs (mentions.jsonl, products.json, snapshots.jsonl, …)
docs/
  specs/               Approved design spec
  plans/               Implementation plan
```

---

## Data files

| File | Description |
|---|---|
| `data/mentions.jsonl` | **Append-only.** One record per source video/post. |
| `data/link-cache.json` | Short-link → ASIN map. Rewritten whole; includes `null` entries for resolved-to-nothing links. |
| `data/pending.json` | Input for the Claude canonicalization session. |
| `data/products.json` | Canonical product list with `firstSeen` timestamps. |
| `data/snapshots.jsonl` | **Append-only.** One record per product per run. The scoring history. |
| `data/shortlist.csv` | Ranked output. Columns: `rank, name, category, score, confidence, margin, amazon_price, supplier_cost, ad_count, ad_max_run_days, shopify_stores, asin, first_seen, evidence_url`. |
| `data/brief.md` | Human-readable evidence summary, one section per product. |

All `data/` files are gitignored. **No raw YouTube API responses are stored** (YouTube ToS caps API data storage at 30 days; snapshot history is meant to accumulate for months, so only derived signals are kept).

---

## Testing

```bash
npm test              # node --test — runs all *.test.js files
node --test lib/extract.test.js
node --test lib/score.test.js
node --test validate.test.js
```

Pure modules (`lib/extract.js`, `lib/score.js`) carry their own tests. `validate.js` exports `runValidation(products, validators, ctx)` so tests can inject fake validators — no network, no browser. Fixtures in `fixtures/` are committed captured pages; parser tests run offline against them. **Never re-scrape a live site in a test loop.**

---

## Adding a new data source (seed)

1. Create `seed-<source>.js`.
2. Write one JSONL record per mention to `data/mentions.jsonl` via `appendJsonl` (one at a time, immediately — never buffered).
3. Use `loadDoneIds('data/mentions.jsonl', 'sourceId')` to skip already-seen IDs.
4. Follow the mention schema in the design spec (`source`, `sourceId`, `rawText`, `productHint`, `url`, `metric`, `seenAt`).

## Adding a new validator

1. Create `validators/<name>.js` with the shape:
   ```js
   export default {
     name: 'myvalidator',
     needs: ['asin'],            // product keys required; missing → { status: 'not_found' }
     cost: 'http',               // 'http' runs before 'browser'
     async probe(product, ctx) { // ctx = { page, config }
       return { status: 'ok', price, ... };
     },
   };
   ```
2. Register it in `validators/index.js`.
3. Dump a fixture page with `node peek.js <url>`, commit it, and write parser tests against it.

---

## Roadmap (slices 6–10, not yet planned)

The v1 pipeline runs end-to-end on one validator (Amazon). These sources would add the missing signals:

- [ ] **AliExpress validator** — supplier cost → margin gate switches on; top-3 ranking becomes meaningful.
- [ ] **Facebook Ads Library validator** — `ad_proof` signal (`activeCount × maxRunDays`); the heaviest scoring weight.
- [ ] **Shopify saturation validator** — DuckDuckGo `site:myshopify.com "<name>"` store count.
- [ ] **Reddit seed** — Reddit public JSON API for product mentions and upvotes.
- [ ] **Amazon Movers & Shakers seed** — headed browser scrape of the daily ranking delta.
- [ ] **`run.js` orchestrator** — `--dry-run` flag, sequences all stages via `spawnSync`.

Slices 6–10 are deliberately unplanned until Task 5 (Amazon validator) has proven the fixture workflow against live markup. Each additional validator requires a committed fixture before any parser code is written.

---

## Design decisions and constraints

- **Zero running cost.** Runtime dependencies: `playwright` and `csv-stringify` only. No paid APIs, no proxies.
- **No fake zeros.** Every signal carries `status: "ok" | "blocked" | "not_found"`. A failed lookup is never recorded as `0`. Scoring treats non-`ok` as absent.
- **Append-only history.** `mentions.jsonl` and `snapshots.jsonl` are appended one record at a time, immediately — never buffered, never rewritten.
- **`firstSeen` is permanent.** Once set, it must survive every run. It cannot be recovered.
- **Block detection: stop, never retry.** Two consecutive `blocked` results from one validator disables it for the rest of the run.
- **Parser work is offline.** Dump a page once with `peek.js`, commit the fixture, iterate against it. Never re-scrape a live site in a loop.
- **YouTube API ToS.** Raw API responses are not stored. Only derived fields (ASIN, `viewsPerDay`, title) are written to disk.

Full rationale: [`docs/specs/2026-10-18-dropship-radar-design.md`](docs/specs/2026-10-18-dropship-radar-design.md).

---

## Legal / ToS

- YouTube Data API data storage capped at 30 days for most fields → derived signals only.
- Amazon, AliExpress, and Facebook terms prohibit automated collection. This is internal, low-volume, human-paced reading of public pages. The pacing caps are what keeps it defensible — do not remove them.
- Output stays local. No resale or redistribution of scraped data.
- Reddit public JSON endpoints require a descriptive `User-Agent`; one is set in `seed-reddit.js`.
