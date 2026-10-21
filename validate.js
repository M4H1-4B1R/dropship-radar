// validate.js — products × validators → data/snapshots.jsonl
// Exports runValidation(products, validators, ctx) so tests can inject fakes.
// The CLI entry (bottom) loads the real registry and accepts --max-products N.

import { readJson, appendJsonl } from './lib/store.js';
import { sleep, jitter } from './lib/wait.js';
import config from './config.js';

const DEFAULT_SNAPSHOT_PATH = 'data/snapshots.jsonl';
const PRODUCTS_PATH = 'data/products.json';

// Product IDs already snapshotted today are skipped (resume key).
async function readDoneToday(snapshotPath) {
  try {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(snapshotPath, 'utf8');
    const today = new Date().toISOString().slice(0, 10);
    const done = new Set();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.productId && obj.runAt && obj.runAt.slice(0, 10) === today) {
          done.add(obj.productId);
        }
      } catch { /* skip malformed lines */ }
    }
    return done;
  } catch {
    return new Set();
  }
}

export async function runValidation(products, validators, ctx = {}) {
  const snapshotPath = ctx.snapshotPath || DEFAULT_SNAPSHOT_PATH;
  const cfg = ctx.config || config;
  const done = await readDoneToday(snapshotPath);
  
  // Partition validators: those without dotted needs (independent) and those with (dependent).
  // Independent validators are ordered http first, then browser.
  // Dependent validators run after their dependencies.
  const independent = validators.filter((v) => !v.needs?.some((n) => n.includes('.')));
  const dependent = validators.filter((v) => v.needs?.some((n) => n.includes('.')));
  
  const orderedIndependent = [...independent].sort(
    (a, b) => Number(a.cost !== 'http') - Number(b.cost !== 'http')
  );
  
  const consecutiveBlocked = new Map(); // validator name -> consecutive blocked count

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    if (done.has(product.id)) continue;

    const signals = {};
    
    // Run independent validators first
    for (const v of orderedIndependent) {
      // Two consecutive blocked results disable the validator for the rest of the run.
      if (consecutiveBlocked.get(v.name) >= 2) {
        signals[v.name] = { status: 'blocked' };
        continue;
      }
      // Missing needs key → not_found, never a value.
      const needsKey = v.needs?.[0];
      if (needsKey != null && product[needsKey] == null) {
        signals[v.name] = { status: 'not_found' };
        continue;
      }
      try {
        const signal = await v.probe(product, { ...ctx, config: cfg, signals });
        signals[v.name] = signal || { status: 'ok' };
        if (signals[v.name].status === 'blocked') {
          consecutiveBlocked.set(v.name, (consecutiveBlocked.get(v.name) || 0) + 1);
        } else {
          consecutiveBlocked.set(v.name, 0);
        }
      } catch (err) {
        // A validator that throws never escapes — recorded as blocked, run continues.
        signals[v.name] = { status: 'blocked', error: String(err) };
        consecutiveBlocked.set(v.name, (consecutiveBlocked.get(v.name) || 0) + 1);
      }
    }
    
    // Run dependent validators after their dependencies
    for (const v of dependent) {
      // Two consecutive blocked results disable the validator for the rest of the run.
      if (consecutiveBlocked.get(v.name) >= 2) {
        signals[v.name] = { status: 'blocked' };
        continue;
      }
      
      // Check dotted needs: e.g., "amazon.title"
      let needsUnmet = false;
      for (const need of v.needs || []) {
        if (need.includes('.')) {
          const [depName, depField] = need.split('.');
          const depSignal = signals[depName];
          if (!depSignal || depSignal.status !== 'ok' || depSignal[depField] == null) {
            needsUnmet = true;
            break;
          }
        } else {
          // Non-dotted needs check against product
          if (product[need] == null) {
            needsUnmet = true;
            break;
          }
        }
      }
      
      if (needsUnmet) {
        signals[v.name] = { status: 'not_found', reason: 'needs_unmet' };
        continue;
      }
      
      try {
        const signal = await v.probe(product, { ...ctx, config: cfg, signals });
        signals[v.name] = signal || { status: 'ok' };
        if (signals[v.name].status === 'blocked') {
          consecutiveBlocked.set(v.name, (consecutiveBlocked.get(v.name) || 0) + 1);
        } else {
          consecutiveBlocked.set(v.name, 0);
        }
      } catch (err) {
        // A validator that throws never escapes — recorded as blocked, run continues.
        signals[v.name] = { status: 'blocked', error: String(err) };
        consecutiveBlocked.set(v.name, (consecutiveBlocked.get(v.name) || 0) + 1);
      }
    }

    const okCount = Object.values(signals).filter((s) => s && s.status === 'ok').length;
    // Confidence divides by registered validators, not by four.
    const allValidators = [...orderedIndependent, ...dependent];
    const confidence = allValidators.length ? okCount / allValidators.length : 0;

    // Append immediately — a crash loses at most one product.
    await appendJsonl(snapshotPath, {
      productId: product.id,
      runAt: new Date().toISOString(),
      signals,
      confidence,
    });

    // Pacing between products, plus a long pause every pauseEvery.
    if (i < products.length - 1) {
      await sleep(jitter(cfg.pacing.betweenPagesMs));
      if ((i + 1) % cfg.pacing.pauseEvery === 0) {
        await sleep(jitter(cfg.pacing.pauseMs));
      }
    }
  }
}

// --- CLI entry (thin wrapper) ----------------------------------------------

// Only run the CLI when this file is the entry point (not when imported by tests).
let isMain = false;
try {
  const argv1 = process.argv[1];
  isMain = typeof argv1 === 'string' && typeof import.meta.url === 'string'
    && import.meta.url === 'file://' + argv1;
} catch {
  isMain = false;
}

if (isMain) {
  (async () => {
    const maxProductsArg = process.argv.find((a) => a.startsWith('--max-products='));
    const maxProducts = maxProductsArg ? Number(maxProductsArg.split('=')[1]) : undefined;
    const products = await readJson(PRODUCTS_PATH, []);
    const limited = maxProducts && maxProducts > 0 ? products.slice(0, maxProducts) : products;
    const { default: registry } = await import('./validators/index.js');
    await runValidation(limited, registry, { config });
    console.log(`validate: processed ${limited.length} product(s)`);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
