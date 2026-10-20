// lib/score.js
// PURE: normalization, gates, confidence, slope, ranking.
// No IO, no network, no clock — score.js does the reading and writing.
//
// Two rules run through the whole file, both from the no-fake-zeros rule:
//   1. An absent signal is absent, never 0. Every component carries its own
//      "is this known?" answer, and only known components enter a mean.
//   2. Only *known absence* drops a product. A validator that was blocked or
//      not found tells us nothing, so it never drops anything.

import defaultConfig from '../config.js';

const MIN_CONFIDENCE_FOR_TOP_3 = 0.5;
const TOP_3 = 3;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isOk(signal) {
  return Boolean(signal) && signal.status === 'ok';
}

// --- normalize --------------------------------------------------------------

// normalize(values) -> number[]
// Min-max across the candidate set. Absent values stay absent (null), so a
// missing component never masquerades as a zero. A zero-range set (every
// value equal) maps to 0.5 — the honest "no information to separate them".
export function normalize(values) {
  if (!Array.isArray(values)) return [];
  const present = values.filter((v) => num(v) !== null).map((v) => Number(v));
  if (present.length === 0) return values.map(() => null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  const range = max - min;
  return values.map((v) => {
    const n = num(v);
    if (n === null) return null;
    if (range === 0) return 0.5;
    return (n - min) / range;
  });
}

// Same, but a bigger value scores lower — saturation is a penalty.
function normalizeInverted(values) {
  return normalize(values).map((v) => (v === null ? null : 1 - v));
}

// --- margin -----------------------------------------------------------------

// computeMargin(amazon, aliexpress) -> number|null
// The markup multiple: price / cost. The gate is "markup below 2.5x", so the
// gate value and the margin value must be the same number.
//
// null (uncomputable) whenever the cost is missing, blocked, or zero — never
// Infinity, never a fake 0, never a fake 100% gross margin.
export function computeMargin(amazon, aliexpress) {
  if (!isOk(amazon) || !isOk(aliexpress)) return null;
  const price = num(amazon.price);
  const cost = num(aliexpress.cost);
  if (price === null || cost === null) return null;
  if (price <= 0 || cost <= 0) return null;
  return price / cost;
}

// grossMargin(amazon, aliexpress) -> number|null
// The gross margin ratio (price - cost) / price. Reported next to the markup.
export function grossMargin(amazon, aliexpress) {
  if (!isOk(amazon) || !isOk(aliexpress)) return null;
  const price = num(amazon.price);
  const cost = num(aliexpress.cost);
  if (price === null || cost === null) return null;
  if (price <= 0 || cost <= 0) return null;
  return (price - cost) / price;
}

// Which signal is missing, so the brief can say *why* the margin is unknown.
export function marginGap(amazon, aliexpress) {
  if (!isOk(amazon)) return 'amazon price';
  if (!isOk(aliexpress)) return 'aliexpress cost';
  if (num(amazon.price) === null) return 'amazon price';
  if (num(aliexpress.cost) === null) return 'aliexpress cost';
  if (num(amazon.price) <= 0) return 'amazon price';
  if (num(aliexpress.cost) <= 0) return 'aliexpress cost';
  return null;
}

// --- confidence -------------------------------------------------------------

// computeConfidence(signals) -> number
// The share of *registered* validators that answered ok. Registered means the
// validator actually ran in this pipeline — the keys present in the signal
// object. A one-validator run that succeeds reaches 1.0; dividing by four
// would make every honest v1 run look like a failure.
export function computeConfidence(signals) {
  if (!signals || typeof signals !== 'object') return 0;
  const entries = Object.entries(signals).filter(([, v]) => v && typeof v === 'object');
  if (entries.length === 0) return 0;
  const ok = entries.filter(([, v]) => v.status === 'ok').length;
  return ok / entries.length;
}

// --- demand -----------------------------------------------------------------

// computeDemand(components) -> number|null
// The mean of the components that are present. An absent component is excluded
// from the mean entirely — counting it as 0 would punish a product for a
// validator that never ran.
export function computeDemand(components) {
  if (!components || typeof components !== 'object') return null;
  const present = Object.values(components).filter((v) => num(v) !== null).map(Number);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

// --- slope ------------------------------------------------------------------

// The strength of a single snapshot: ad proof when known, plus the Amazon
// rank negated (a falling rank number is an improvement). Absent signals
// contribute nothing rather than a zero.
function snapshotStrength(snapshot) {
  const signals = (snapshot && snapshot.signals) || {};
  let total = null;
  const ads = signals.ads;
  if (isOk(ads)) {
    const count = num(ads.activeCount);
    const days = num(ads.maxRunDays);
    if (count !== null && days !== null) total = (total ?? 0) + count * days;
  }
  const amazon = signals.amazon;
  if (isOk(amazon)) {
    const rank = num(amazon.rank);
    if (rank !== null) total = (total ?? 0) - rank;
  }
  return total;
}

// computeSlope(snapshots) -> number|null
// Least-squares slope of snapshot strength over the snapshot sequence, which
// must be chronological. Null below three snapshots: with one or two points a
// slope is noise, not durability.
export function computeSlope(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 3) return null;
  const series = snapshots.map(snapshotStrength).filter((v) => v !== null);
  if (series.length < 3) return null;
  const n = series.length;
  const meanX = (n - 1) / 2;
  const meanY = series.reduce((a, b) => a + b, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    numerator += dx * (series[i] - meanY);
    denominator += dx * dx;
  }
  if (denominator === 0) return null;
  return numerator / denominator;
}

// --- per-product signals ----------------------------------------------------

// adProof(ads) -> number|null — activeCount x maxRunDays, or absent.
function adProofOf(ads) {
  if (!isOk(ads)) return null;
  const count = num(ads.activeCount);
  const days = num(ads.maxRunDays);
  if (count === null || days === null) return null;
  return count * days;
}

// storeCountOf(shopify) -> number|null
function storeCountOf(shopify) {
  if (!isOk(shopify)) return null;
  return num(shopify.storeCount);
}

// Known absence of ad proof: the validator answered and there is no ad.
function adsKnownAbsent(ads) {
  return isOk(ads) && num(ads.activeCount) === 0;
}

// computeRankDelta(snapshots) -> number|null
// Rank movement across snapshots: first rank minus last rank. Positive means
// the product moved up (rank numbers fall as a product climbs). Absent with
// fewer than two usable snapshots.
export function computeRankDelta(snapshots) {
  if (!Array.isArray(snapshots)) return null;
  const ranks = snapshots
    .map((s) => (isOk(s && s.signals && s.signals.amazon) ? num(s.signals.amazon.rank) : null))
    .filter((r) => r !== null);
  if (ranks.length < 2) return null;
  return ranks[0] - ranks[ranks.length - 1];
}

// Peak attention: the highest views-per-day among the product's mentions.
// The peak, not the sum — a product mentioned in ten videos should not beat a
// single video with real reach.
function peakViews(mentions) {
  if (!Array.isArray(mentions)) return null;
  let best = null;
  for (const m of mentions) {
    const v = num(m && m.metric && m.metric.viewsPerDay);
    if (v !== null && (best === null || v > best)) best = v;
  }
  return best;
}

// Reddit mention count. Zero reddit mentions means "not measured" in v1 (there
// is no Reddit seed yet), so it stays absent rather than becoming a 0.
function redditMentions(mentions) {
  if (!Array.isArray(mentions)) return null;
  const count = mentions.filter((m) => m && m.source === 'reddit').length;
  return count > 0 ? count : null;
}

function bestEvidenceUrl(mentions) {
  if (!Array.isArray(mentions)) return '';
  let best = null;
  for (const m of mentions) {
    if (!m || !m.url) continue;
    const v = num(m.metric && m.metric.viewsPerDay);
    const score = v === null ? -1 : v;
    if (best === null || score > best.score) best = { url: m.url, score };
  }
  return best ? best.url : '';
}

function byRunAt(a, b) {
  const ta = Date.parse(a && a.runAt ? a.runAt : '') || 0;
  const tb = Date.parse(b && b.runAt ? b.runAt : '') || 0;
  return ta - tb;
}

function toEntries(byProduct) {
  if (!byProduct) return [];
  const pairs = byProduct instanceof Map ? [...byProduct.entries()] : Object.entries(byProduct);
  return pairs.map(([key, value]) => {
    const entry = value || {};
    const product = entry.product || { id: key };
    return {
      id: key,
      product: { id: key, ...product },
      snapshots: Array.isArray(entry.snapshots) ? [...entry.snapshots].sort(byRunAt) : [],
      mentions: Array.isArray(entry.mentions) ? entry.mentions : [],
    };
  });
}

// --- weights ----------------------------------------------------------------

// The durability term is off until a slope exists. Once it is on it takes the
// heaviest weight and the others rescale so the total stays 1.
function weightsFor(cfg, durabilityOn) {
  const base = { ...(cfg.weights || {}) };
  if (!durabilityOn || !('durability' in base)) return base;
  const others = { ...base };
  delete others.durability;
  const otherSum = Object.values(others).reduce((a, b) => a + b, 0);
  const durabilityWeight = Math.max(...Object.values(base));
  if (otherSum <= 0) return { ...others, durability: durabilityWeight };
  const factor = (1 - durabilityWeight) / otherSum;
  const out = {};
  for (const [k, v] of Object.entries(others)) out[k] = v * factor;
  out.durability = durabilityWeight;
  return out;
}

// --- evaluation -------------------------------------------------------------

// evaluateProducts(byProduct, cfg) -> { ranked, dropped }
// byProduct: { [productId]: { product, snapshots: [...], mentions: [...] } }
// ranked: kept candidates, best first, at most 10.
// dropped: candidates removed by a hard gate, with the reason.
export function evaluateProducts(byProduct, cfg = defaultConfig) {
  const entries = toEntries(byProduct);
  const prepared = entries.map((entry) => {
    const snapshots = entry.snapshots;
    const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;
    const signals = (latest && latest.signals) || {};
    return {
      entry,
      signals,
      confidence: computeConfidence(signals),
      margin: computeMargin(signals.amazon, signals.aliexpress),
      gross: grossMargin(signals.amazon, signals.aliexpress),
      marginGap: marginGap(signals.amazon, signals.aliexpress),
      adProof: adProofOf(signals.ads),
      saturation: storeCountOf(signals.shopify),
      rankDelta: computeRankDelta(snapshots),
      slope: computeSlope(snapshots),
      viewsPerDay: peakViews(entry.mentions),
      reddit: redditMentions(entry.mentions),
    };
  });

  // --- hard gates, applied before weighting ---
  // The gates need no cross-sectional numbers, so they run first: a candidate
  // a gate removes is not part of the candidate set the others are scaled
  // against.
  const gateReason = (p) => {
    if (!p.entry.snapshots.length) return 'not_validated';
    if (p.confidence <= 0) return 'no_validator_succeeded';
    if (p.margin !== null && p.margin < cfg.gates.minMarkup) return 'markup_below_min';
    if (adsKnownAbsent(p.signals.ads) && !(p.rankDelta > 0)) return 'no_ad_proof';
    return null;
  };

  const gated = prepared.map((p) => ({ p, reason: gateReason(p) }));
  const survivors = gated.filter((g) => g.reason === null).map((g) => g.p);
  // An empty survivor set means every candidate failed a gate: nothing ranks.
  const pool = survivors;

  // Cross-sectional normalization: each component is scaled against the
  // candidate set it belongs to.
  const normViews = normalize(pool.map((p) => p.viewsPerDay));
  const normDelta = normalize(pool.map((p) => p.rankDelta));
  const normReddit = normalize(pool.map((p) => p.reddit));
  const normAd = normalize(pool.map((p) => p.adProof));
  const normSat = normalizeInverted(pool.map((p) => p.saturation));
  const normDur = normalize(pool.map((p) => p.slope));

  const candidates = pool.map((p, i) => {
    const product = p.entry.product;
    const demand = computeDemand({
      viewsPerDay: normViews[i],
      rankDelta: normDelta[i],
      redditMentions: normReddit[i],
    });
    const components = {
      adProof: normAd[i],
      demand,
      saturation: normSat[i],
      durability: normDur[i],
    };
    const weights = weightsFor(cfg, components.durability !== null);
    const present = Object.entries(components).filter(([, v]) => v !== null);
    const presentWeight = present.reduce((a, [k]) => a + (weights[k] || 0), 0);
    const score =
      presentWeight > 0
        ? present.reduce((a, [k, v]) => a + (weights[k] || 0) * v, 0) / presentWeight
        : 0;

    const candidate = {
      productId: p.entry.id,
      name: product.name || p.entry.id,
      category: product.category || '',
      asin: (product.asins && product.asins[0]) || product.asin || '',
      firstSeen: product.firstSeen || '',
      evidenceUrl: bestEvidenceUrl(p.entry.mentions),
      score,
      confidence: p.confidence,
      margin: p.margin,
      grossMargin: p.gross,
      marginGap: p.marginGap,
      components: {
        viewsPerDay: normViews[i],
        rankDelta: normDelta[i],
        redditMentions: normReddit[i],
        demand,
        adProof: normAd[i],
        saturation: normSat[i],
        durability: normDur[i],
      },
      raw: {
        adProof: p.adProof,
        saturation: p.saturation,
        rankDelta: p.rankDelta,
        slope: p.slope,
        viewsPerDay: p.viewsPerDay,
        redditMentions: p.reddit,
      },
      weights,
      signals: p.signals,
      snapshotCount: p.entry.snapshots.length,
      capped: false,
      capReasons: [],
      dropped: false,
      dropReason: null,
      rank: null,
    };

    // --- caps: kept, but never in the top 3 ---
    if (candidate.margin === null) candidate.capReasons.push('margin_uncomputable');
    if (candidate.confidence < MIN_CONFIDENCE_FOR_TOP_3) candidate.capReasons.push('low_confidence');
    candidate.capped = candidate.capReasons.length > 0;
    return candidate;
  });

  const kept = candidates
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const fa = a.firstSeen || '';
      const fb = b.firstSeen || '';
      if (fa !== fb) return fa < fb ? -1 : 1;
      return a.productId < b.productId ? -1 : 1;
    });

  // Uncapped products take the top ranks. Capped products are pushed below
  // the top three, which stay empty rather than being filled by a product
  // that has not earned the slot.
  const uncapped = kept.filter((c) => !c.capped);
  const capped = kept.filter((c) => c.capped);
  let rank = 0;
  for (const c of uncapped) c.rank = ++rank;
  let cappedRank = Math.max(TOP_3 + 1, rank + 1);
  for (const c of capped) c.rank = cappedRank++;

  const dropped = gated
    .filter((g) => g.reason !== null)
    .map((g) => ({
      productId: g.p.entry.id,
      name: g.p.entry.product.name || g.p.entry.id,
      dropReason: g.reason,
      confidence: g.p.confidence,
      margin: g.p.margin,
    }))
    .sort((a, b) => (a.productId < b.productId ? -1 : 1));

  return { ranked: kept.slice(0, 10), dropped };
}

// rankProducts(byProduct, cfg) -> Ranked[]
// The shortlist: at most ten products, best first.
export function rankProducts(byProduct, cfg = defaultConfig) {
  return evaluateProducts(byProduct, cfg).ranked;
}

// assignMentions(products, mentionsById) -> { byProduct, sharedAsins }
// A mention that two products both claim — the same ASIN canonicalized twice
// — counts once, so its demand is never double counted. The first product in
// the list keeps it.
export function assignMentions(products, mentionsById) {
  const byProduct = {};
  const claimed = new Set();
  const asinOwners = new Map();
  for (const product of products) {
    for (const asin of product.asins || []) {
      if (!asinOwners.has(asin)) asinOwners.set(asin, []);
      asinOwners.get(asin).push(product.id);
    }
  }
  for (const product of products) {
    const owned = (product.mentionIds || [])
      .filter((key) => {
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      })
      .map((key) => mentionsById.get(key))
      .filter(Boolean);
    byProduct[product.id] = owned;
  }
  const sharedAsins = [...asinOwners.entries()].filter(([, owners]) => owners.length > 1);
  return { byProduct, sharedAsins };
}

// --- brief ------------------------------------------------------------------

function signalLine(name, signal) {
  if (!signal || typeof signal !== 'object') return `- ${name}: absent`;
  const status = signal.status || 'unknown';
  const bits = [];
  for (const key of ['price', 'cost', 'rank', 'reviews', 'activeCount', 'maxRunDays', 'storeCount', 'orders']) {
    const v = signal[key];
    if (v !== undefined && v !== null) bits.push(`${key} ${v}`);
  }
  return `- ${name}: ${status}${bits.length ? ` — ${bits.join(', ')}` : ''}`;
}

// renderBrief(ranked, opts) -> string
// One section per product: the score, the evidence, and every signal with its
// status. A product whose margin could not be computed says so, and says which
// signal was missing.
export function renderBrief(ranked, opts = {}) {
  const dropped = opts.dropped || [];
  const validators = opts.validators || [];
  const notes = opts.notes || [];
  const generatedAt = opts.generatedAt || '';
  const lines = [];

  lines.push('# Dropship Radar — shortlist brief');
  lines.push('');
  if (generatedAt) lines.push(`Generated: ${generatedAt}`);
  if (validators.length) {
    lines.push(`Validators in this run: ${validators.join(', ')}`);
    lines.push(
      'Confidence is the share of those validators that answered `ok`. A blocked or missing ' +
        'validator lowers confidence; it never counts as a zero.'
    );
  }
  lines.push('');

  for (const note of notes) {
    lines.push(`> ${note}`);
    lines.push('');
  }

  if (!ranked.length) {
    lines.push('No product survived the gates. See the dropped list below.');
    lines.push('');
  } else if (ranked.every((r) => r.rank > TOP_3)) {
    lines.push(
      `Ranks 1–3 are reserved for products with a computable margin and a confidence of at ` +
        `least ${MIN_CONFIDENCE_FOR_TOP_3}. No product in this run qualified, so the list starts ` +
        `at rank ${ranked[0].rank} — every candidate is capped, none is dropped.`
    );
    lines.push('');
  }

  for (const r of ranked) {
    lines.push(`## ${r.rank}. ${r.name}`);
    lines.push('');
    lines.push(`- id: ${r.productId}`);
    if (r.category) lines.push(`- category: ${r.category}`);
    lines.push(`- score: ${r.score.toFixed(3)}`);
    lines.push(`- confidence: ${r.confidence.toFixed(2)}`);
    if (r.margin === null) {
      lines.push(`- margin: uncomputable (missing: ${r.marginGap || 'price or cost signal'})`);
    } else {
      const gross = r.grossMargin === null ? '' : ` (${(r.grossMargin * 100).toFixed(1)}% gross)`;
      lines.push(`- margin: ${r.margin.toFixed(2)}x${gross}`);
    }
    if (r.asin) lines.push(`- asin: ${r.asin}`);
    if (r.firstSeen) lines.push(`- first seen: ${r.firstSeen}`);
    if (r.evidenceUrl) lines.push(`- evidence: ${r.evidenceUrl}`);
    const demand = r.components.demand;
    lines.push(`- demand: ${demand === null ? 'absent' : demand.toFixed(3)}`);
    lines.push(`- snapshots: ${r.snapshotCount || 1}`);
    lines.push('');
    lines.push('signals:');
    for (const [name, signal] of Object.entries(r.signals || {})) {
      lines.push(signalLine(name, signal));
    }
    if (r.capReasons.length) {
      lines.push('');
      lines.push(`Capped out of the top 3: ${r.capReasons.join(', ')}`);
    }
    lines.push('');
  }

  if (dropped.length) {
    lines.push('## Dropped by a hard gate');
    lines.push('');
    for (const d of dropped) {
      lines.push(`- ${d.name} (${d.productId}): ${d.dropReason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
