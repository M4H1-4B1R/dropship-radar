import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readFileSync, unlinkSync } from 'node:fs';
import { runValidation } from './validate.js';

// Test snapshots live in the OS temp directory, never in data/ — a stray file
// there could be mistaken for a real run's output.
const SNAPSHOTS = path.join(os.tmpdir(), 'dropship-radar-validate-test-snapshots.jsonl');

const fastConfig = {
  pacing: {
    betweenPagesMs: [1, 2],
    pauseEvery: 100,
    pauseMs: [1, 2],
  },
};

function readSnapshots() {
  try {
    const text = readFileSync(SNAPSHOTS, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
    }
    return out;
  } catch {
    return [];
  }
}

function reset() {
  try { unlinkSync(SNAPSHOTS); } catch { /* ignore */ }
}

const fastValidator = {
  name: 'fast',
  needs: [],
  cost: 'http',
  async probe() {
    return { status: 'ok', value: 1 };
  },
};

const slowValidator = {
  name: 'slow',
  needs: ['asin'],
  cost: 'browser',
  async probe() {
    return { status: 'ok', value: 2 };
  },
};

test('appends one snapshot per product, with a signal entry per validator', async () => {
  reset();
  const products = [
    { id: 'p1', asin: 'B0ABCD1234' },
    { id: 'p2', asin: 'B0XYZ78901' },
  ];
  await runValidation(products, [fastValidator, slowValidator], {
    snapshotPath: SNAPSHOTS,
    config: fastConfig,
  });
  const snaps = readSnapshots();
  assert.strictEqual(snaps.length, 2);
  for (const s of snaps) {
    assert.ok(s.productId);
    assert.ok(s.runAt);
    assert.deepStrictEqual(Object.keys(s.signals).sort(), ['fast', 'slow']);
    assert.deepStrictEqual(s.signals.fast.status, 'ok');
    assert.deepStrictEqual(s.signals.fast.value, 1);
    assert.deepStrictEqual(s.signals.slow.status, 'ok');
    assert.deepStrictEqual(s.signals.slow.value, 2);
    // both validators ok → confidence 1.0 (2 of 2 registered)
    assert.deepStrictEqual(s.confidence, 1);
  }
});

test('a validator that throws yields status "blocked", and the run continues', async () => {
  reset();
  const throwing = {
    name: 'throws',
    needs: [],
    cost: 'http',
    async probe() {
      throw new Error('boom');
    },
  };
  const products = [{ id: 'p1' }, { id: 'p2' }];
  await runValidation(products, [throwing, fastValidator], {
    snapshotPath: SNAPSHOTS,
    config: fastConfig,
  });
  const snaps = readSnapshots();
  assert.strictEqual(snaps.length, 2);
  assert.deepStrictEqual(snaps[0].signals.throws.status, 'blocked');
  assert.deepStrictEqual(snaps[1].signals.throws.status, 'blocked');
  assert.deepStrictEqual(snaps[0].signals.fast.status, 'ok');
});

test('a product missing a validator needs key yields status "not_found"', async () => {
  reset();
  const products = [{ id: 'p1' }]; // no asin
  await runValidation(products, [fastValidator, slowValidator], {
    snapshotPath: SNAPSHOTS,
    config: fastConfig,
  });
  const snaps = readSnapshots();
  assert.deepStrictEqual(snaps[0].signals.slow.status, 'not_found');
  assert.deepStrictEqual(snaps[0].signals.fast.status, 'ok');
});

test('two consecutive blocked results disable that validator for the rest of the run', async () => {
  reset();
  let calls = 0;
  const flaky = {
    name: 'flaky',
    needs: [],
    cost: 'http',
    async probe() {
      calls++;
      return { status: 'blocked' };
    },
  };
  const products = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
  await runValidation(products, [flaky], {
    snapshotPath: SNAPSHOTS,
    config: fastConfig,
  });
  const snaps = readSnapshots();
  assert.strictEqual(snaps.length, 3);
  assert.deepStrictEqual(snaps[0].signals.flaky.status, 'blocked');
  assert.deepStrictEqual(snaps[1].signals.flaky.status, 'blocked');
  assert.deepStrictEqual(snaps[2].signals.flaky.status, 'blocked');
  // probe invoked only twice; the third product records disabled "blocked" without calling probe
  assert.strictEqual(calls, 2);
});

// Helper to run validation and return parsed snapshot lines
async function runToLines(validators, products) {
  reset();
  await runValidation(products, validators, {
    snapshotPath: SNAPSHOTS,
    config: fastConfig,
  });
  return readSnapshots();
}

test('a validator needing another validator\'s field runs after it and reads its signal', async () => {
  const first = {
    name: 'amazon',
    needs: ['asins'],
    cost: 'browser',
    async probe() {
      return { status: 'ok', title: 'Real Title' };
    },
  };
  const second = {
    name: 'aliexpress',
    needs: ['amazon.title'],
    cost: 'browser',
    async probe(p, ctx) {
      return { status: 'ok', seen: ctx.signals.amazon.title };
    },
  };
  // registered in the wrong order on purpose
  const lines = await runToLines([second, first], [{ id: 'p1', asins: ['B0'] }]);
  assert.strictEqual(lines[0].signals.aliexpress.seen, 'Real Title');
});

test('an unmet signal dependency skips the validator instead of guessing', async () => {
  const first = {
    name: 'amazon',
    needs: ['asins'],
    cost: 'browser',
    async probe() {
      return { status: 'blocked' };
    },
  };
  let probed = false;
  const second = {
    name: 'aliexpress',
    needs: ['amazon.title'],
    cost: 'browser',
    async probe() {
      probed = true;
      return { status: 'ok' };
    },
  };
  const lines = await runToLines([first, second], [{ id: 'p1', asins: ['B0'], name: 'garbage name' }]);
  assert.strictEqual(probed, false);
  assert.deepStrictEqual(lines[0].signals.aliexpress, { status: 'not_found', reason: 'needs_unmet' });
});

test('a dependency that answered ok but without the needed field is also unmet', async () => {
  const first = {
    name: 'amazon',
    needs: ['asins'],
    cost: 'browser',
    async probe() {
      return { status: 'ok', title: null };
    },
  };
  const second = {
    name: 'aliexpress',
    needs: ['amazon.title'],
    cost: 'browser',
    async probe() {
      return { status: 'ok' };
    },
  };
  const lines = await runToLines([first, second], [{ id: 'p1', asins: ['B0'] }]);
  assert.strictEqual(lines[0].signals.aliexpress.reason, 'needs_unmet');
});
