// lib/wait.js
// Jitter and backoff. Fixed delays look like a bot; random ranges in
// human-like windows don't. Every wait in the scraper goes through here so
// pacing is tuned in one place (config.js). Copied from the FB scraper,
// minus humanScroll (unused here).

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Random integer in [min, max] — pick a fresh value on every call.
export function jitter([min, max]) {
  return Math.floor(min + Math.random() * (max - min));
}
