// config.js — queries, weights, gates, pacing. The only tuning surface.
// YT_API_KEY lives in gitignored .env, never here.

export default {
  youtube: {
    queries: [
      'tiktok made me buy it',
      'amazon must haves 2026',
      'amazon finds under 50',
      'viral amazon products',
      'dropshipping products 2026',
      'best amazon gadgets',
      'amazon home essentials',
      'things you need from amazon',
      'amazon kitchen must haves',
      'amazon beauty favorites',
    ],
    maxResults: 50,
  },
  gates: {
    minMarkup: 2.5,
  },
  weights: {
    adProof: 0.4,
    demand: 0.3,
    saturation: 0.2,
    durability: 0.1,
  },
  aliexpress: {
    minOrders: 100,
    minRating: 4.0,
    sampleSize: 3,
    tolerance: 0.5,
    queryWords: 8,     // Amazon titles are long; the first N words search better
  },
  pacing: {
    betweenPagesMs: [6000, 12000],
    pauseEvery: 10,
    pauseMs: [60000, 90000],
  },
};
