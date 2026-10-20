// score.js — data/snapshots.jsonl → data/shortlist.csv + data/brief.md
// Thin IO around the pure lib/score.js. Reads the append-only snapshot
// history, the product file, and the mention file, then ranks.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'csv-stringify/sync';
import { readJson } from './lib/store.js';
import { mentionId } from './lib/extract.js';
import { evaluateProducts, renderBrief } from './lib/score.js';
import config from './config.js';

const SNAPSHOTS_PATH = 'data/snapshots.jsonl';
const PRODUCTS_PATH = 'data/products.json';
const MENTIONS_PATH = 'data/mentions.jsonl';
const CSV_PATH = 'data/shortlist.csv';
const BRIEF_PATH = 'data/brief.md';

const CSV_COLUMNS = [
  'rank',
  'name',
  'category',
  'score',
  'confidence',
  'margin',
  'amazon_price',
  'supplier_cost',
  'ad_count',
  'ad_max_run_days',
  'shopify_stores',
  'asin',
  'first_seen',
  'evidence_url',
];

// Read a JSONL file into an array. Malformed lines are skipped, never thrown.
async function readJsonl(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch { /* skip malformed lines */ }
    }
    return out;
  } catch {
    return [];
  }
}

function signalValue(signals, validator, field) {
  const signal = signals && signals[validator];
  if (!signal || signal.status !== 'ok') return '';
  const value = signal[field];
  return value === undefined || value === null ? '' : value;
}

function toCsvRow(ranked) {
  const signals = ranked.signals || {};
  return {
    rank: ranked.rank,
    name: ranked.name,
    category: ranked.category,
    score: ranked.score.toFixed(4),
    confidence: ranked.confidence.toFixed(2),
    // An uncomputable margin is empty, never 0 — the brief explains why.
    margin: ranked.margin === null ? '' : ranked.margin.toFixed(2),
    amazon_price: signalValue(signals, 'amazon', 'price'),
    supplier_cost: signalValue(signals, 'aliexpress', 'cost'),
    ad_count: signalValue(signals, 'ads', 'activeCount'),
    ad_max_run_days: signalValue(signals, 'ads', 'maxRunDays'),
    shopify_stores: signalValue(signals, 'shopify', 'storeCount'),
    asin: ranked.asin || '',
    first_seen: ranked.firstSeen || '',
    evidence_url: ranked.evidenceUrl || '',
  };
}

async function main() {
  const snapshots = await readJsonl(SNAPSHOTS_PATH);
  const products = await readJson(PRODUCTS_PATH, []);
  const mentions = await readJsonl(MENTIONS_PATH);

  // Every snapshot line, grouped by product — the whole history, because the
  // trend terms need more than the last run.
  const byProductId = new Map();
  for (const snap of snapshots) {
    if (!snap || !snap.productId) continue;
    if (!byProductId.has(snap.productId)) byProductId.set(snap.productId, []);
    byProductId.get(snap.productId).push(snap);
  }

  const mentionsById = new Map(mentions.map((m) => [mentionId(m), m]));

  // The candidate set: every known product, plus any product that only shows
  // up in the snapshot history (so nothing is silently lost).
  const ids = new Set([...products.map((p) => p.id), ...byProductId.keys()]);
  const byProduct = {};
  for (const id of ids) {
    const product = products.find((p) => p.id === id) || { id, name: id, category: '', asins: [] };
    const productMentions = (product.mentionIds || [])
      .map((id2) => mentionsById.get(id2))
      .filter(Boolean);
    byProduct[id] = {
      product,
      snapshots: byProductId.get(id) || [],
      mentions: productMentions,
    };
  }

  const { ranked, dropped } = evaluateProducts(byProduct, config);

  const csv = stringify(ranked.map(toCsvRow), { header: true, columns: CSV_COLUMNS });
  await mkdir(path.dirname(CSV_PATH), { recursive: true });
  await writeFile(CSV_PATH, csv);

  const registry = await import('./validators/index.js');
  const brief = renderBrief(ranked, {
    dropped,
    validators: registry.default.map((v) => v.name),
    generatedAt: new Date().toISOString(),
  });
  await mkdir(path.dirname(BRIEF_PATH), { recursive: true });
  await writeFile(BRIEF_PATH, brief);

  console.log(`score: ${ranked.length} product(s) ranked → ${CSV_PATH}, ${BRIEF_PATH}`);
  console.log(`score: ${dropped.length} product(s) dropped by a hard gate`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
