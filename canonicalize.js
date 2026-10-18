// canonicalize.js — mentions → products
// --prepare : data/mentions.jsonl → data/pending.json  (one compact item per mention)
// --finalize <draft.json> : draft + existing data/products.json → data/products.json
// firstSeen is stamped by code — never invented by hand.

import { readFile } from 'node:fs/promises';
import { readJson, writeJson } from './lib/store.js';
import { buildPending, finalizeProducts } from './lib/extract.js';

async function readMentionsJsonl(path) {
  try {
    const text = await readFile(path, 'utf8');
    const mentions = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        mentions.push(JSON.parse(line));
      } catch { /* skip malformed lines */ }
    }
    return mentions;
  } catch {
    return [];
  }
}

async function prepare() {
  const mentions = await readMentionsJsonl('data/mentions.jsonl');
  const pending = buildPending(mentions);
  await writeJson('data/pending.json', pending);
  console.log(`data/pending.json: ${pending.length} items`);
}

async function finalize(draftPath) {
  const draft = await readJson(draftPath, []);
  const existing = await readJson('data/products.json', []);
  const today = new Date().toISOString().slice(0, 10);
  const { products, duplicateAsins } = finalizeProducts(draft, existing, today);
  await writeJson('data/products.json', products);
  if (Object.keys(duplicateAsins).length) {
    console.warn(`WARNING: duplicate ASINs across products: ${JSON.stringify(duplicateAsins)}`);
  }
  console.log(`data/products.json: ${products.length} products`);
}

const command = process.argv[2];
if (command === '--prepare') {
  prepare().catch((err) => { console.error(err); process.exit(1); });
} else if (command === '--finalize') {
  const draftPath = process.argv[3];
  if (!draftPath) {
    console.error('Usage: node canonicalize.js --finalize <draft.json>');
    process.exit(1);
  }
  finalize(draftPath).catch((err) => { console.error(err); process.exit(1); });
} else {
  console.error('Usage: node canonicalize.js --prepare | --finalize <draft.json>');
  process.exit(1);
}
