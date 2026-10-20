import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize,
  computeMargin,
  grossMargin,
  computeConfidence,
  computeSlope,
  computeDemand,
  rankProducts,
  evaluateProducts,
  renderBrief,
  assignMentions,
  effectiveSignals,
} from './score.js';

// A deliberately small config so weight arithmetic is checkable by hand.
const CFG = {
  gates: { minMarkup: 2.5 },
  weights: { adProof: 0.4, demand: 0.3, saturation: 0.2, durability: 0.1 },
};

const RUN_AT = '2026-10-18T10:00:00.000Z';

// One candidate: product metadata + its snapshots + its mentions.
function entry(id, { signals = {}, snapshots, mentions = [], product = {} } = {}) {
  return {
    product: {
      id,
      name: `Product ${id}`,
      category: 'test',
      asins: [],
      aliexpressIds: [],
      mentionIds: [],
      firstSeen: '2026-10-01',
      ...product,
    },
    snapshots: snapshots || [{ productId: id, runAt: RUN_AT, signals, confidence: 1 }],
    mentions,
  };
}

// Signals where every validator answered ok.
function okSignals(extra = {}) {
  return {
    amazon: { status: 'ok', price: 25, rank: 100 },
    aliexpress: { status: 'ok', cost: 10 },
    ads: { status: 'ok', activeCount: 3, maxRunDays: 30 },
    ...extra,
  };
}

function mention(sourceId, viewsPerDay, source = 'youtube') {
  return {
    source,
    sourceId,
    url: `https://www.youtube.com/watch?v=${sourceId}`,
    metric: { viewsPerDay },
  };
}

// --- normalize --------------------------------------------------------------

test('normalize maps the max to 1 and the min to 0 across the candidate set', () => {
  assert.deepStrictEqual(normalize([5, 10, 15]), [0, 0.5, 1]);
});

test('normalize returns 0.5 for every entry when all values are equal', () => {
  assert.deepStrictEqual(normalize([3, 3, 3]), [0.5, 0.5, 0.5]);
});

test('normalize leaves an absent value absent instead of reading it as 0', () => {
  assert.deepStrictEqual(normalize([null, 5, 10]), [null, 0, 1]);
});

test('normalize returns no values for an empty set', () => {
  assert.deepStrictEqual(normalize([]), []);
});

// --- demand -----------------------------------------------------------------

test('demand averages only the components present, not treating absent as 0', () => {
  // viewsPerDay 1 and redditMentions 0 are present; rankDelta is absent and
  // must not drag the mean down to 1/3.
  assert.strictEqual(computeDemand({ viewsPerDay: 1, rankDelta: null, redditMentions: 0 }), 0.5);
});

test('demand is absent when no component is present', () => {
  assert.strictEqual(computeDemand({ viewsPerDay: null, rankDelta: null, redditMentions: null }), null);
});

// --- margin -----------------------------------------------------------------

test('computeMargin returns null when the cost signal is not ok', () => {
  assert.strictEqual(computeMargin({ status: 'ok', price: 25 }, { status: 'blocked' }), null);
});

test('computeMargin returns null when cost is 0', () => {
  assert.strictEqual(computeMargin({ status: 'ok', price: 25 }, { status: 'ok', cost: 0 }), null);
});

test('computeMargin returns null when the price signal is not ok', () => {
  assert.strictEqual(computeMargin({ status: 'blocked' }, { status: 'ok', cost: 10 }), null);
});

test('computeMargin returns the markup multiple price / cost', () => {
  assert.strictEqual(computeMargin({ status: 'ok', price: 30 }, { status: 'ok', cost: 10 }), 3);
});

test('grossMargin returns the gross margin ratio, or null when uncomputable', () => {
  assert.ok(Math.abs(grossMargin({ status: 'ok', price: 30 }, { status: 'ok', cost: 10 }) - 2 / 3) < 1e-9);
  assert.strictEqual(grossMargin({ status: 'ok', price: 30 }, { status: 'blocked' }), null);
});

// --- confidence -------------------------------------------------------------

test('confidence counts registered validators only, so a one-validator run can reach 1.0', () => {
  assert.strictEqual(computeConfidence({ amazon: { status: 'ok' } }), 1);
});

test('computeConfidence returns 0 when every signal failed, without dividing by zero', () => {
  assert.strictEqual(
    computeConfidence({ amazon: { status: 'blocked' }, aliexpress: { status: 'not_found' } }),
    0
  );
});

test('computeConfidence returns 0 for an empty signal set', () => {
  assert.strictEqual(computeConfidence({}), 0);
});

// --- slope ------------------------------------------------------------------

test('computeSlope returns null below 3 snapshots and a number at 3', () => {
  const snap = (rank) => ({ productId: 'p', runAt: RUN_AT, signals: { amazon: { status: 'ok', rank } } });
  const snaps = [snap(100), snap(80), snap(60)];
  assert.strictEqual(computeSlope(snaps.slice(0, 2)), null);
  const slope = computeSlope(snaps);
  assert.strictEqual(typeof slope, 'number');
  // Rank falling is improvement, so the slope must be positive.
  assert.ok(slope > 0, `expected a positive slope, got ${slope}`);
});

test('computeSlope returns null when fewer than three snapshots carry a usable signal', () => {
  const good = { productId: 'p', runAt: RUN_AT, signals: { amazon: { status: 'ok', rank: 100 } } };
  const bad = { productId: 'p', runAt: RUN_AT, signals: { amazon: { status: 'blocked' } } };
  assert.strictEqual(computeSlope([good, good, bad]), null);
});

// --- gates ------------------------------------------------------------------

test('a product below gates.minMarkup is dropped', () => {
  const res = evaluateProducts(
    { p1: entry('p1', { signals: { amazon: { status: 'ok', price: 20 }, aliexpress: { status: 'ok', cost: 10 } } }) },
    CFG
  );
  assert.strictEqual(res.ranked.length, 0);
  assert.strictEqual(res.dropped[0].productId, 'p1');
  assert.strictEqual(res.dropped[0].dropReason, 'markup_below_min');
});

test('markup exactly at 2.5 is kept', () => {
  const res = evaluateProducts(
    { p1: entry('p1', { signals: { amazon: { status: 'ok', price: 25 }, aliexpress: { status: 'ok', cost: 10 } } }) },
    CFG
  );
  assert.strictEqual(res.ranked.length, 1);
  assert.strictEqual(res.ranked[0].margin, 2.5);
});

test('a product whose ad signal is ok with activeCount 0 and no rank movement is dropped', () => {
  const res = evaluateProducts(
    {
      p1: entry('p1', {
        signals: {
          amazon: { status: 'ok', price: 25 },
          aliexpress: { status: 'ok', cost: 10 },
          ads: { status: 'ok', activeCount: 0, maxRunDays: 0 },
        },
      }),
    },
    CFG
  );
  assert.strictEqual(res.ranked.length, 0);
  assert.strictEqual(res.dropped[0].dropReason, 'no_ad_proof');
});

test('a product whose ad signal is not ok is NOT dropped — unknown is not zero', () => {
  const res = evaluateProducts(
    {
      p1: entry('p1', {
        signals: {
          amazon: { status: 'ok', price: 25 },
          aliexpress: { status: 'ok', cost: 10 },
          ads: { status: 'blocked' },
        },
      }),
    },
    CFG
  );
  assert.strictEqual(res.ranked.length, 1);
});

test('a product where every validator failed is not ranked and its confidence is 0', () => {
  const res = evaluateProducts({ p1: entry('p1', { signals: { amazon: { status: 'blocked' } } }) }, CFG);
  assert.strictEqual(res.ranked.length, 0);
  assert.strictEqual(res.dropped[0].confidence, 0);
});

test('a product that was never validated is dropped as not_validated', () => {
  const res = evaluateProducts({ p1: entry('p1', { snapshots: [] }) }, CFG);
  assert.strictEqual(res.ranked.length, 0);
  assert.strictEqual(res.dropped[0].dropReason, 'not_validated');
});

test('a product with an uncomputable margin is flagged and capped, not dropped', () => {
  const res = evaluateProducts(
    {
      p1: entry('p1', { signals: { amazon: { status: 'ok', price: 25 } } }),
      p2: entry('p2', { signals: okSignals() }),
      p3: entry('p3', { signals: okSignals() }),
    },
    CFG
  );
  const p1 = res.ranked.find((r) => r.productId === 'p1');
  assert.ok(p1, 'p1 must still be ranked');
  assert.strictEqual(p1.margin, null);
  assert.ok(p1.capped, 'p1 must be capped out of the top 3');
  assert.ok(p1.rank > 3, `expected a rank beyond 3, got ${p1.rank}`);
});

// --- ranking ----------------------------------------------------------------

test('a product with confidence below 0.5 cannot rank in the top 3', () => {
  const res = evaluateProducts(
    {
      good1: entry('good1', { signals: okSignals() }),
      good2: entry('good2', { signals: okSignals() }),
      good3: entry('good3', { signals: okSignals() }),
      weak: entry('weak', {
        signals: {
          amazon: { status: 'ok', price: 25 },
          aliexpress: { status: 'ok', cost: 10 },
          ads: { status: 'blocked' },
          shopify: { status: 'blocked' },
          reddit: { status: 'blocked' },
        },
      }),
    },
    CFG
  );
  const weak = res.ranked.find((r) => r.productId === 'weak');
  assert.ok(weak.confidence < 0.5, 'fixture must produce a low confidence');
  assert.ok(weak.rank > 3, `expected a rank beyond 3, got ${weak.rank}`);
});

test('rankProducts returns at most 10 entries', () => {
  const byProduct = {};
  for (let i = 0; i < 15; i++) {
    byProduct[`p${i}`] = entry(`p${i}`, { signals: okSignals() });
  }
  assert.strictEqual(rankProducts(byProduct, CFG).length, 10);
});

test('ranked scores stay between 0 and 1', () => {
  const res = evaluateProducts(
    {
      p1: entry('p1', { signals: okSignals(), mentions: [mention('v1', 1000)] }),
      p2: entry('p2', { signals: okSignals(), mentions: [mention('v2', 5000)] }),
    },
    CFG
  );
  for (const r of res.ranked) {
    assert.ok(r.score >= 0 && r.score <= 1, `score out of range: ${r.score}`);
  }
});

test('a stronger ad proof scores higher than a weaker one', () => {
  const res = evaluateProducts(
    {
      weak: entry('weak', {
        signals: {
          amazon: { status: 'ok', price: 25 },
          aliexpress: { status: 'ok', cost: 10 },
          ads: { status: 'ok', activeCount: 1, maxRunDays: 5 },
        },
      }),
      strong: entry('strong', {
        signals: {
          amazon: { status: 'ok', price: 25 },
          aliexpress: { status: 'ok', cost: 10 },
          ads: { status: 'ok', activeCount: 20, maxRunDays: 90 },
        },
      }),
    },
    CFG
  );
  const byId = Object.fromEntries(res.ranked.map((r) => [r.productId, r]));
  assert.ok(byId.strong.score > byId.weak.score);
});

test('more Shopify stores mean lower saturation score', () => {
  const res = evaluateProducts(
    {
      fresh: entry('fresh', {
        signals: {
          amazon: { status: 'ok', price: 25 },
          aliexpress: { status: 'ok', cost: 10 },
          shopify: { status: 'ok', storeCount: 2 },
        },
      }),
      stale: entry('stale', {
        signals: {
          amazon: { status: 'ok', price: 25 },
          aliexpress: { status: 'ok', cost: 10 },
          shopify: { status: 'ok', storeCount: 40 },
        },
      }),
    },
    CFG
  );
  const byId = Object.fromEntries(res.ranked.map((r) => [r.productId, r]));
  assert.ok(byId.fresh.components.saturation > byId.stale.components.saturation);
});

test('durability takes the heaviest weight once a slope exists, and the rest rescale to 1', () => {
  const snap = (id, rank, day) => ({
    productId: id,
    runAt: `2026-10-${day}T10:00:00.000Z`,
    signals: { amazon: { status: 'ok', price: 25, rank } },
  });
  const res = evaluateProducts(
    {
      p1: entry('p1', {
        snapshots: [snap('p1', 100, 16), snap('p1', 80, 17), snap('p1', 60, 18)],
        signals: { amazon: { status: 'ok', price: 25, rank: 60 } },
      }),
    },
    CFG
  );
  const p1 = res.ranked[0];
  assert.strictEqual(p1.weights.durability, 0.4);
  const others = p1.weights.adProof + p1.weights.demand + p1.weights.saturation;
  assert.ok(Math.abs(others - 0.6) < 1e-9, `expected the other weights to sum to 0.6, got ${others}`);
});

test('rank delta is absent with a single snapshot and present with two', () => {
  const one = evaluateProducts(
    { p1: entry('p1', { signals: { amazon: { status: 'ok', price: 25, rank: 100 } } }) },
    CFG
  ).ranked[0];
  assert.strictEqual(one.components.rankDelta, null);

  const snap = (rank, day) => ({
    productId: 'p1',
    runAt: `2026-10-${day}T10:00:00.000Z`,
    signals: { amazon: { status: 'ok', price: 25, rank } },
  });
  const two = evaluateProducts(
    { p1: entry('p1', { snapshots: [snap(100, 17), snap(60, 18)] }) },
    CFG
  ).ranked[0];
  // Raw movement is rank 100 minus rank 60 = 40 (the product climbed).
  assert.strictEqual(two.raw.rankDelta, 40);
  // Normalized against the candidate set: one candidate carries a delta, so
  // the range is zero and it lands on 0.5 — no information to separate them.
  assert.strictEqual(two.components.rankDelta, 0.5);
});

// --- brief ------------------------------------------------------------------

test('a candidate removed by a gate does not stretch the normalization range', () => {
  // The blocked candidate has the biggest reach. It is dropped by the gate,
  // so it must not drag the survivor's viewsPerDay down to 0.
  const res = evaluateProducts(
    {
      alive: entry('alive', {
        signals: { amazon: { status: 'ok', price: 25 } },
        mentions: [mention('v1', 100)],
      }),
      dead: entry('dead', {
        signals: { amazon: { status: 'blocked' } },
        mentions: [mention('v2', 1000)],
      }),
    },
    CFG
  );
  const alive = res.ranked.find((r) => r.productId === 'alive');
  assert.strictEqual(alive.components.viewsPerDay, 0.5);
  assert.ok(res.dropped.some((d) => d.productId === 'dead'));
});

test('the brief says why the list starts below rank 3', () => {
  const res = evaluateProducts(
    { p1: entry('p1', { signals: { amazon: { status: 'ok', price: 25 } } }) },
    CFG
  );
  const md = renderBrief(res.ranked, { dropped: res.dropped });
  assert.match(md, /Ranks 1–3 are reserved/);
});

test('a mention two products both claim is counted once', () => {
  const products = [
    { id: 'p1', asins: ['B0SHARED01'], mentionIds: ['yt:v1'] },
    { id: 'p2', asins: ['B0SHARED01'], mentionIds: ['yt:v1'] },
  ];
  const mentionsById = new Map([
    ['yt:v1', { source: 'youtube', sourceId: 'v1', url: 'https://youtu.be/v1', metric: { viewsPerDay: 900 } }],
  ]);
  const { byProduct, sharedAsins } = assignMentions(products, mentionsById);
  assert.strictEqual(byProduct.p1.length, 1);
  assert.strictEqual(byProduct.p2.length, 0, 'the second product must not claim the mention again');
  assert.deepStrictEqual(sharedAsins, [['B0SHARED01', ['p1', 'p2']]]);
});

test('a blocked check does not erase what the same validator answered earlier', () => {
  const ok = {
    productId: 'p1',
    runAt: '2026-10-20T10:00:00.000Z',
    signals: { amazon: { status: 'ok', price: 25 } },
  };
  const blocked = {
    productId: 'p1',
    runAt: '2026-10-20T11:00:00.000Z',
    signals: { amazon: { status: 'blocked' } },
  };
  const res = evaluateProducts({ p1: entry('p1', { snapshots: [ok, blocked] }) }, CFG);
  const p1 = res.ranked[0];
  assert.ok(p1, 'the product must still rank on its last answer');
  assert.strictEqual(p1.signals.amazon.status, 'ok');
  assert.strictEqual(p1.confidence, 1);
  assert.strictEqual(p1.signalAsOf.amazon, '2026-10-20T10:00:00.000Z');
});

test('a later not_found overrides an earlier ok — absence is an answer too', () => {
  const ok = {
    productId: 'p1',
    runAt: '2026-10-20T10:00:00.000Z',
    signals: { amazon: { status: 'ok', price: 25 } },
  };
  const gone = {
    productId: 'p1',
    runAt: '2026-10-20T11:00:00.000Z',
    signals: { amazon: { status: 'not_found' } },
  };
  const res = evaluateProducts({ p1: entry('p1', { snapshots: [ok, gone] }) }, CFG);
  assert.strictEqual(res.ranked.length, 0);
  assert.strictEqual(res.dropped[0].dropReason, 'no_validator_succeeded');
});

test('effectiveSignals keeps the latest answer per validator', () => {
  const { signals, asOf } = effectiveSignals([
    { runAt: 'a', signals: { amazon: { status: 'ok', price: 1 }, ads: { status: 'blocked' } } },
    { runAt: 'b', signals: { amazon: { status: 'blocked' } } },
    { runAt: 'c', signals: { ads: { status: 'ok', activeCount: 2 } } },
  ]);
  assert.strictEqual(signals.amazon.status, 'ok');
  assert.strictEqual(signals.ads.status, 'ok');
  assert.strictEqual(asOf.amazon, 'a');
  assert.strictEqual(asOf.ads, 'c');
});

test('renderBrief lists every signal with its status', () => {
  const res = evaluateProducts(
    {
      p1: entry('p1', {
        signals: {
          amazon: { status: 'ok', price: 25 },
          aliexpress: { status: 'blocked' },
          ads: { status: 'ok', activeCount: 3, maxRunDays: 30 },
        },
        mentions: [mention('v1', 1200)],
      }),
    },
    CFG
  );
  const md = renderBrief(res.ranked, { dropped: res.dropped });
  assert.match(md, /Product p1/);
  assert.match(md, /amazon: ok/);
  assert.match(md, /aliexpress: blocked/);
  assert.match(md, /margin: uncomputable/);
  assert.match(md, /aliexpress/);
});
