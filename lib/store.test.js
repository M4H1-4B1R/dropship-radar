import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { appendJsonl, loadDoneIds, readJson } from './store.js';

// Test artifacts live in the OS temp directory. They must never land in
// data/, where a stray file could be mistaken for pipeline output.
const TMP = os.tmpdir();

test('appendJsonl creates missing directories and appends one line per call', async () => {
  const filePath = path.join(TMP, 'dropship-radar-store-test-append.jsonl');
  const { unlink, readFile } = await import('node:fs/promises');
  await unlink(filePath).catch(() => {}); // start fresh — idempotent across runs
  await appendJsonl(filePath, { a: 1 });
  await appendJsonl(filePath, { b: 2 });
  const text = await readFile(filePath, 'utf8');
  const lines = text.trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(JSON.parse(lines[0]), { a: 1 });
  assert.deepStrictEqual(JSON.parse(lines[1]), { b: 2 });
  await unlink(filePath).catch(() => {});
});

test('loadDoneIds skips malformed lines and returns the valid ids', async () => {
  const filePath = path.join(TMP, 'dropship-radar-store-test-load.jsonl');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(filePath, '{"sourceId":"a"}\n{not json\n{"sourceId":"b"}\n');
  const ids = await loadDoneIds(filePath);
  assert.deepStrictEqual([...ids].sort(), ['a', 'b']);
  await writeFile(filePath, '');
});

test('readJson returns the fallback when the file is absent', async () => {
  const result = await readJson('data/.does-not-exist.json', { fallback: true });
  assert.deepStrictEqual(result, { fallback: true });
});
