#!/usr/bin/env node
/**
 * sync-config.mjs
 * ===============
 *
 * Build-time helper that materializes `config.example.json` into
 * `manifest-plugins.config.json` at the repo root on **first** build only.
 *
 * Why copy-on-missing (not unconditional overwrite):
 *   The previous version wrote `manifest-plugins.config.json` on every
 *   build, which silently overwrote any operator-edited file with the
 *   example defaults. That made per-build disable config impossible to
 *   keep around and — more importantly — it caused the CI e2e gate to
 *   disable the `anthropic-models-fix` plugin automatically (because the
 *   example file shipped with that plugin disabled), which then failed
 *   the smoke test that asserts the plugin's `overrideModelList()` is
 *   present in the built image.
 *
 *   Copy-on-missing fixes both problems:
 *
 *     - On a fresh checkout (no `manifest-plugins.config.json` present)
 *       the example's defaults are copied once. The operator can then
 *       edit the materialized file to flip plugin enablement for their
 *       local builds without losing those edits to the next build.
 *
 *     - On subsequent builds (or in CI, which never sees the file on a
 *       clean checkout) the file is left untouched. CI therefore builds
 *       with **no** plugin-config overrides — meaning every plugin that
 *       shipped with `enabledByDefault: true` in its source metadata
 *       stays enabled and the e2e gate stays green.
 *
 * Stripping:
 *   Keys whose name starts with `_` (the doc/schema keys, e.g.
 *   `_comment`, `_schema`) are removed from the copied output so they
 *   don't reach `scripts/filter-plugins.mjs` (which validates every key
 *   against shipped plugin ids and would reject them).
 *
 * Idempotent. Run automatically via `npm run build`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const SOURCE = resolve(repoRoot, 'config.example.json');
const TARGET = resolve(repoRoot, 'manifest-plugins.config.json');

if (!existsSync(SOURCE)) {
  throw new Error(
    `sync-config: source not found at ${SOURCE} — cannot materialize plugin config`,
  );
}

if (existsSync(TARGET)) {
  console.log(
    `[sync-config] target already exists at ${TARGET} — leaving it untouched (copy-on-missing semantics). ` +
      `Delete the file to re-materialize from ${SOURCE}.`,
  );
  process.exit(0);
}

const text = readFileSync(SOURCE, 'utf-8');
const parsed = JSON.parse(text);

if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
  throw new Error('config.example.json must be a JSON object at the top level');
}

const stripped = {};
let dropped = 0;
for (const [key, value] of Object.entries(parsed)) {
  if (key.startsWith('_')) {
    dropped += 1;
    continue;
  }
  stripped[key] = value;
}

writeFileSync(TARGET, JSON.stringify(stripped, null, 2) + '\n', 'utf-8');
console.log(
  `[sync-config] wrote ${TARGET} (stripped ${dropped} underscore-prefixed keys)`,
);