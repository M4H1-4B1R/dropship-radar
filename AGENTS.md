# Dropship Radar v1 — AGENTS.md

**Status:** pre-implementation. The repo holds only the design spec and implementation plan; no source code exists yet.

**Sources of truth (read before writing code):**
- `docs/specs/2026-10-18-dropship-radar-design.md` — approved design (contracts, pipeline, scoring, ToS constraints).
- `docs/plans/2026-10-18-dropship-radar-v1.md` — implementation plan, slices 1–5 complete; slices 6–10 deliberately not planned.

**Goal:** turn YouTube product-review videos into a scored, evidence-backed shortlist of ~10 dropshipping candidates, free, locally. File-chained stages, pluggable validators, pure tested modules for parsing/scoring; network/browser work confined to thin stage scripts.

---

## Hard constraints (violating these is a real mistake)

- **Node 20.6+** (for `node --env-file`). ESM only: `"type": "module"`.
- **Zero running cost.** Runtime deps limited to `playwright` and `csv-stringify`. No paid APIs, no proxies, no other runtime deps.
- Load secrets with **`node --env-file=.env`** — never `dotenv`.
- `YT_API_KEY` lives in gitignored `.env`; never in `config.js`. `config.js` holds only queries, weights, gates, pacing.
- **No raw YouTube API responses stored** (ToS 30-day storage cap). Store derived fields only (ASIN, viewsPerDay, title, etc.).
- **No fake zeros.** Every signal carries `status: "ok" | "blocked" | "not_found"`. A failed lookup is never recorded as `0`. `score.js` treats non-`ok` as absent, never as `0`.
- `mentions.jsonl` and `snapshots.jsonl` are **append-only**, one record at a time, immediately — never buffered, never rewritten.
- `firstSeen` on a product must survive every run; it cannot be recovered once lost.
- All delays go through `lib/wait.js` jitter ranges; values live only in `config.js`.
- **Parser work runs against committed `fixtures/` only** — never re-scrape a live site in a loop. Dump a page once with `peek.js`, commit the fixture, iterate offline.
- Block detection (copied from the FB scraper): **stop, never loop-retry.** Two consecutive `blocked` results from one validator disables it for the rest of the run.

---

## Project layout (spec §3)

```
config.js              queries, weights, gates, pacing (the only tuning surface)
.env.example           YT_API_KEY=
seed-youtube.js        YouTube Data API → data/mentions.jsonl
canonicalize.js        --prepare → data/pending.json ; --finalize draft.json → data/products.json
validate.js            products.json → data/snapshots.jsonl
score.js               snapshots.jsonl → data/shortlist.csv + data/brief.md
lib/
  wait.js              sleep, jitter
  store.js             readJson, writeJson, appendJsonl, loadDoneIds
  browser.js           headed/guest launchers, block detection
  extract.js           PURE: ASIN / item-id / price / count parsers, mentions builder
  score.js             PURE: normalization, gates, confidence, slope, ranking
  *.test.js
validators/
  index.js             registry, ordered cheap → expensive
  amazon.js            needs asin; cost: 'browser' (Amazon blocks headless)
fixtures/              committed page dumps; parser tests run offline
data/                  gitignored outputs (mentions.jsonl, products.json, snapshots.jsonl, shortlist.csv, brief.md)
```

`lib/wait.js`, `lib/store.js`, `lib/browser.js` are copied verbatim from `genai-fb-lead-scraper/lib/` — not imported as a shared package.

---

## Exact commands

| What | Command |
|------|---------|
| Install | `npm install` (deps: `playwright`, `csv-stringify`) |
| Run all tests | `npm test` → `node --test` |
| One test file | `node --test lib/extract.test.js` (or `lib/score.test.js`, `validate.test.js`) |
| Seed YouTube | `npm run seed:youtube` → `node --env-file=.env seed-youtube.js` (needs `.env` with `YT_API_KEY`) |
| Canonicalize prepare | `node canonicalize.js --prepare` → `data/pending.json` |
| Canonicalize finalize | `node canonicalize.js --finalize draft.json` → `data/products.json` (manual Claude step in between; see docs/plans Task 4) |
| Validate | `node validate.js [--max-products N]` → appends `data/snapshots.jsonl` |
| Score | `node score.js` → `data/shortlist.csv` + `data/brief.md` |
| Full pipeline (slices 1–5) | `npm run seed:youtube && node canonicalize.js --prepare` → [manual step] → `node canonicalize.js --finalize draft.json && node validate.js && node score.js` |

Scripts come from `package.json` (created in slice 1): `test`, `seed:youtube`, `canonicalize`, `validate`, `score`.

Resume keys: `seed-youtube` skips video IDs already in `mentions.jsonl`; `validate` skips products already snapshotted today (`runAt` date matches).

---

## Pipeline order

`seed-*.js` → `data/mentions.jsonl` → `canonicalize.js --prepare` → `data/pending.json` → **[manual Claude session merges duplicates, assigns id/name/category]** → `data/products.json` → `validate.js` → `data/snapshots.jsonl` → `score.js` → `data/shortlist.csv` + `data/brief.md`.

Each stage is runnable standalone. `run.js` (slice 10, not yet planned) will sequence them via `spawnSync`.

Slices 6–10 (AliExpress, Ads Library, Shopify validators; Reddit + Amazon Movers seeds; `run.js`) have no planned tasks, no fixtures, and no real-markup assertions yet. Do not write assertions against live sites for them — that would be fiction. They get a second plan after Task 5 proves the fixture workflow.

---

## Edge cases with pinned tests (easy to get wrong)

- **Malformed JSONL line:** readers (`loadDoneIds`, snapshot readers) must skip the bad line and continue, never throw.
- **YouTube quota exhausted (HTTP 403 `quotaExceeded`):** log the count written so far and `process.exit(0)` — not a throw, not a retry. Keep every mention already written.
- **Every validator failed:** confidence must be `0`, not `NaN` from a zero divisor; the product must not rank.
- **Price present but cost absent or zero:** margin is uncomputable, never `Infinity` or `NaN`; flagged in the brief, capped out of top 3 but not dropped.
- **Same ASIN canonicalized into two products:** demand must not be double-counted; the duplicate must be detectable (`duplicateAsins`).
- Ads gate: drops only on **known** absence (`ads.status === "ok"` with `activeCount 0` and no rank movement). A non-`ok` ad signal is unknown, never drops a product.
- `computeConfidence` divides by the number of **registered** validators, not by four — a one-validator run can reach `1.0`.

---

## Testing conventions

- Pure modules carry the tests (`lib/extract.js`, `lib/score.js`); validator runner gets assert-based smoke tests with injected fake validators (no network, no browser).
- Fixtures are the cost control: each validator's target page dumped once into `fixtures/` and committed. Parser tests run offline against them.
- `validate.js` exports `runValidation(products, validators, ctx)` so tests can inject fakes; the CLI is a thin wrapper loading the real registry.

---

## Legal / ToS (constraints on the build)

- YouTube API data storage capped at 30 days for most fields → derived signals only in snapshots; history accumulates for months.
- Amazon/AliExpress/Facebook terms prohibit automated collection: internal, low-volume, human-paced reading of public pages. Keep the pacing caps.
- Output stays local — no resale or redistribution of scraped data.
- Reddit public JSON endpoints require a descriptive User-Agent; set one.
