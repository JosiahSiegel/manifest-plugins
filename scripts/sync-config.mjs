#!/usr/bin/env node
/**
 * sync-config.mjs
 * ===============
 *
 * Build-time helper that materializes the canonical plugin config from
 * `config.example.json` into `manifest-plugins.config.json` at the repo
 * root.
 *
 * Why this exists:
 *   `scripts/filter-plugins.mjs` reads `manifest-plugins.config.json`
 *   at the repo root (not `config.example.json`). Without this script,
 *   the example file's defaults never take effect — the only way to
 *   disable a plugin would be to hand-write a separate
 *   `manifest-plugins.config.json`, which is easy to forget and easy
 *   to drift from the example.
 *
 *   To keep `config.example.json` as the single source of truth for
 *   plugin enablement defaults AND ensure the build actually consumes
 *   those defaults, every build runs this script which:
 *
 *     1. Reads `config.example.json` (parsed as JSON).
 *     2. Strips keys whose name starts with `_` (the doc/schema keys).
 *     3. Writes the result to `manifest-plugins.config.json`.
 *
 * Behavior:
 *   - Unconditional overwrite on every build. Operators wanting a
 *     one-off override for a single local build should edit
 *     `config.example.json` (committed) or set the `MANIFEST_PLUGINS_DISABLED`
 *     env var at runtime instead — both survive the next build.
 *
 * Run automatically via `npm run build`. Idempotent.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const SOURCE = resolve(repoRoot, 'config.example.json');
const TARGET = resolve(repoRoot, 'manifest-plugins.config.json');

const text = readFileSync(SOURCE, 'utf-8');
const parsed = JSON.parse(text);

if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
  throw new Error('config.example.json must be a JSON object at the top level');
}

const stripped = {};
for (const [key, value] of Object.entries(parsed)) {
  if (key.startsWith('_')) continue;
  stripped[key] = value;
}

writeFileSync(TARGET, JSON.stringify(stripped, null, 2) + '\n', 'utf-8');
console.log(
  `[sync-config] wrote ${TARGET} (stripped ${
    Object.keys(parsed).length - Object.keys(stripped).length
  } underscore-prefixed keys)`,
);