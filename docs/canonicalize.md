# Canonicalization — mentions → products

`canonicalize.js` turns `data/mentions.jsonl` into `data/products.json` in two steps.

## 1. Prepare (automatic)

```
node canonicalize.js --prepare
```

Reads `data/mentions.jsonl` and writes `data/pending.json`: one compact item per mention
(`mentionId`, `rawText` trimmed to 400 chars, `productHint`, `asin`, `aliexpressId`), sized to fit
one context window. Prints the path and the item count.

## 2. Merge & assign (manual — Claude Code session)

Open a Claude Code session and:

1. Read `data/pending.json`.
2. Merge duplicate wordings into one product each (same product, different mention wording).
3. Assign each product `id` (kebab-case), `name`, `category`.
4. Carry over `asins`, `aliexpressIds`, `mentionIds` from the mentions.
5. Write the result as a draft JSON file (e.g. `draft.json`).

## 3. Finalize (automatic — `firstSeen` stamped by code)

```
node canonicalize.js --finalize draft.json
```

Reads the draft, merges it against existing `data/products.json` via `finalizeProducts`, stamps
`firstSeen` (today for a new product; the earlier stored value preserved verbatim for an existing
one), writes `data/products.json`, and warns about any ASIN shared by two products
(`duplicateAsins`).

`firstSeen` is stamped by code, not by hand — it is the age signal and cannot be recovered once
lost.
