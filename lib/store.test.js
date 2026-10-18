import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendJsonl, loadDoneIds, readJson } from './store.js';

test('appendJsonl creates missing directories and appends one line per call', async () => {
  const path = 'data/.store-test-append.jsonl';
  await appendJsonl(path, { a: 1 });
  await appendJsonl(path, { b: 2 });
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(path, 'utf8');
  const lines = text.trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(JSON.parse(lines[0]), { a: 1 });
  assert.deepStrictEqual(JSON.parse(lines[1]), { b: 2 });
});

test('loadDoneIds skips malformed lines and returns the valid ids', async () => {
  const path = 'data/.store-test-load.jsonl';
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, '{"sourceId":"a"}\n{not json\n{"sourceId":"b"}\n');
  const ids = await loadDoneIds(path);
  assert.deepStrictEqual([...ids].sort(), ['a', 'b']);
});

test('readJson returns the fallback when the file is absent', async () => {
  const result = await readJson('data/.does-not-exist.json', { fallback: true });
  assert.deepStrictEqual(result, { fallback: true });
});
