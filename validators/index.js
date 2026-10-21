// validators/index.js — registry, ordered cheap (http) → expensive (browser).
// Adding a source later is one file plus one registry line.
import amazon from './amazon.js';
import aliexpress from './aliexpress.js';

export default [amazon, aliexpress];
