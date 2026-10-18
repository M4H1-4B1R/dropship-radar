import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jitter } from './wait.js';

test('jitter returns an integer within [min, max] across 100 draws', () => {
  for (let i = 0; i < 100; i++) {
    const n = jitter([6000, 12000]);
    assert.ok(Number.isInteger(n), `not an integer: ${n}`);
    assert.ok(n >= 6000 && n <= 12000, `out of range: ${n}`);
  }
});
