// lib/store.js
// JSONL vs JSON for append-only logs. One line per record, written
// immediately — if the process crashes, everything already written is on
// disk. Copied from the FB scraper, renamed loadDoneSlugs → loadDoneIds
// with default key 'sourceId'.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

async function ensureDir(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

export async function readJson(filePath, fallback = null) {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, data) {
  await ensureDir(filePath);
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

// Append one JSON object as a single line — crash-safe, no read-modify-write.
export async function appendJsonl(filePath, obj) {
  await ensureDir(filePath);
  const { appendFile } = await import('node:fs/promises');
  await appendFile(filePath, JSON.stringify(obj) + '\n');
}

// Read a JSONL file and return the set of values for a given key
// (e.g. "sourceId"). Skips malformed lines, never throws.
export async function loadDoneIds(filePath, key = 'sourceId') {
  try {
    const text = await readFile(filePath, 'utf8');
    const ids = new Set();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj[key]) ids.add(obj[key]);
      } catch { /* skip malformed lines */ }
    }
    return ids;
  } catch {
    return new Set();
  }
}
