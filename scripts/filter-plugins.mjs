#!/usr/bin/env node
/**
 * filter-plugins.mjs
 * ==================
 *
 * Post-build step that reads `manifest-plugins.config.json` and rewrites
 * the `enabledByDefault` field in each plugin's compiled metadata to
 * match the operator's stated defaults.
 *
 * Why post-build instead of compile-time:
 *   - The TS source (`src/index.ts`) is unfiltered, so `npm test` runs
 *     against the full plugin set with 100% coverage.
 *   - The shipped artifact (`dist/plugins/<name>/plugin.js`) carries the
 *     operator's chosen defaults so `require('manifest-plugins')` at
 *     runtime returns the right `getInstalledPlugins()` shape.
 *   - No source-file mutation = no dirty working tree, no git status
 *     noise, no circular imports.
 *
 * Rewriting strategy:
 *   - The filter walks `dist/plugins/<name>/plugin.js` (every plugin shipped,
 *     including ones fetched as external plugins from a private repo
 *     via `external-plugins.local.json`).
 *   - For each compiled plugin, it reads the `id: '<plugin-id>'` field
 *     out of the metadata literal to learn the plugin's identifier.
 *   - If `manifest-plugins.config.json` mentions that id with an explicit
 *     boolean, the filter rewrites the plugin's compiled `enabledByDefault`
 *     to match. Both directions are supported: a plugin shipping with
 *     `enabledByDefault: true` in source can be flipped to `false` via
 *     config, and a plugin shipping with `false` can be re-enabled by
 *     setting the config to `true` (the recovery path when an upstream
 *     bug the plugin was working around regresses back in).
 *   - Plugins not mentioned in the config are left untouched (their
 *     source-declared default — true or false — wins).
 *
 * This is per-plugin rather than per-class-name: external plugins
 * fetched at build time (e.g. AnthropicBillingHeaderPlugin) are
 * supported without editing this script.
 *
 * Run automatically via `npm run build`. Re-runnable (idempotent if
 * the files are already in the desired shape).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const CONFIG_PATH = resolve(repoRoot, 'manifest-plugins.config.json');
const DIST_PLUGINS = resolve(repoRoot, 'dist/plugins');

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return { plugins: {} };
  }
  const text = readFileSync(CONFIG_PATH, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `manifest-plugins.config.json is not valid JSON: ${err.message}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(
      'manifest-plugins.config.json must be a JSON object (e.g. { "plugins": { ... } })',
    );
  }
  const plugins = parsed.plugins;
  if (plugins === undefined) return { plugins: {} };
  if (typeof plugins !== 'object' || plugins === null) {
    throw new Error(
      'manifest-plugins.config.json: "plugins" must be an object mapping plugin id to boolean',
    );
  }
  for (const [name, value] of Object.entries(plugins)) {
    if (typeof value !== 'boolean') {
      throw new Error(
        `manifest-plugins.config.json: plugins["${name}"] must be a boolean (true/false), got ${typeof value}`,
      );
    }
  }
  return { plugins };
}

/**
 * Validate that every key in the config corresponds to an actually-shipped
 * plugin. Without this, a typo in the config (`AnthropicBillingPlugin`
 * instead of `AnthropicBillingHeaderPlugin`) would silently no-op — same
 * class of failure that hid the original bug.
 */
function validateConfig(config) {
  const shippedIds = new Set();
  for (const child of readdirSync(DIST_PLUGINS)) {
    if (child.startsWith('.')) continue;
    const pluginFile = join(DIST_PLUGINS, child, 'plugin.js');
    if (!existsSync(pluginFile)) continue;
    const id = readPluginId(pluginFile);
    if (id !== null) shippedIds.add(id);
  }
  for (const name of Object.keys(config.plugins)) {
    if (!shippedIds.has(name)) {
      throw new Error(
        `manifest-plugins.config.json: unknown plugin id "${name}" — ` +
          `shipped plugins are: ${Array.from(shippedIds).sort().join(', ')}. ` +
          `(Plugin ids are the 'id' field of each plugin's metadata, not the class name.)`,
      );
    }
  }
}

/**
 * Extract the `id: '<value>'` literal from a compiled plugin.js metadata
 * block. Returns null if no `id` field is found at the top of the file
 * (which would indicate a malformed build).
 */
function readPluginId(pluginFile) {
  const text = readFileSync(pluginFile, 'utf-8');
  const match = text.match(/id:\s*['"]([^'"]+)['"]/);
  return match === null ? null : match[1];
}

/**
 * Rewrite the first `enabledByDefault: <bool>` literal that follows the
 * plugin's `id: '<id>'` literal in pluginFile so that it matches the
 * operator's requested default. Returns true if the file was rewritten,
 * false if the file already matches.
 */
function setPluginDefaultInFile(pluginFile, pluginId, desiredDefault) {
  const text = readFileSync(pluginFile, 'utf-8');
  const idNeedle = `id: '${pluginId}'`;
  const idIndex = text.indexOf(idNeedle);
  if (idIndex === -1) {
    // Defensive: should never happen because validateConfig confirmed
    // the id exists. Throw to surface a real build-output regression
    // rather than silently skipping.
    throw new Error(
      `${pluginFile}: config references '${pluginId}' but its metadata does not contain 'id: '${pluginId}''`,
    );
  }
  const desiredLiteral = `enabledByDefault: ${desiredDefault}`;
  // Look for the desired literal first — if it's already there we no-op.
  const alreadyCorrect = text.indexOf(desiredLiteral, idIndex);
  if (alreadyCorrect !== -1) {
    return false;
  }
  // Otherwise find the OPPOSITE literal and flip it. The plugin metadata
  // always declares the field as `true` or `false` (tsc preserves the
  // literal), so one of the two patterns is guaranteed to be present.
  const oppositeLiteral = `enabledByDefault: ${!desiredDefault}`;
  const flipIndex = text.indexOf(oppositeLiteral, idIndex);
  if (flipIndex === -1) {
    // Source omits the field entirely (treated as true by loadPluginRegistry).
    // For `desiredDefault: false` we want to add it; for `desiredDefault: true`
    // the absent-default behavior already matches.
    if (desiredDefault === false) {
      // Insert `enabledByDefault: false,` after the metadata's `kind:` line.
      const kindNeedle = 'kind:';
      const kindIndex = text.indexOf(kindNeedle, idIndex);
      if (kindIndex === -1) {
        throw new Error(
          `${pluginFile}: '${pluginId}' has no 'kind:' field in its metadata; cannot insert 'enabledByDefault: false'`,
        );
      }
      // Find the next comma+newline after `kind: ...`
      const kindLineEnd = text.indexOf('\n', kindIndex);
      const insertionPoint = kindLineEnd + 1;
      const rewritten =
        text.slice(0, insertionPoint) +
        `    enabledByDefault: false,\n` +
        text.slice(insertionPoint);
      writeFileSync(pluginFile, rewritten, 'utf-8');
      return true;
    }
    // desiredDefault === true but field absent → matches default behavior.
    return false;
  }
  const rewritten =
    text.slice(0, flipIndex) +
    desiredLiteral +
    text.slice(flipIndex + oppositeLiteral.length);
  writeFileSync(pluginFile, rewritten, 'utf-8');
  return true;
}

/**
 * Walk every plugin directory under dist/plugins and, for any whose
 * declared id appears in the config with an explicit boolean, rewrite
 * its compiled metadata so its `enabledByDefault` matches the config.
 *
 * Returns { rewritten, skipped } arrays of plugin ids for logging.
 * - `rewritten`: ids whose compiled `enabledByDefault` was changed.
 * - `skipped`: ids whose compiled `enabledByDefault` already matched
 *   the config (no rewrite needed).
 */
function applyEnabledDefaults(config) {
  const rewritten = [];
  const skipped = [];

  for (const child of readdirSync(DIST_PLUGINS)) {
    if (child.startsWith('.')) continue;
    const pluginFile = join(DIST_PLUGINS, child, 'plugin.js');
    if (!existsSync(pluginFile)) continue;
    const id = readPluginId(pluginFile);
    if (id === null) continue;
    if (!(id in config.plugins)) continue;
    const desired = config.plugins[id];
    if (setPluginDefaultInFile(pluginFile, id, desired)) {
      rewritten.push(id);
    } else {
      skipped.push(id);
    }
  }

  return { rewritten, skipped };
}

function main() {
  if (!existsSync(DIST_PLUGINS)) {
    console.error(
      `filter-plugins: ${DIST_PLUGINS} does not exist. Run \`npm run build\` first.`,
    );
    process.exit(1);
  }
  const config = loadConfig();
  validateConfig(config);
  const { rewritten, skipped } = applyEnabledDefaults(config);

  const totalConfigEntries = Object.keys(config.plugins).length;
  if (totalConfigEntries === 0) {
    console.log(
      'filter-plugins: no plugins requested via manifest-plugins.config.json (all shipped plugins kept their source-declared defaults)',
    );
    return;
  }

  const parts = [];
  if (rewritten.length > 0) {
    parts.push(`rewrote ${rewritten.length} plugin(s): [${rewritten.join(', ')}]`);
  }
  if (skipped.length > 0) {
    parts.push(
      `already matched source: [${skipped.join(', ')}] (config matches compiled metadata)`,
    );
  }
  console.log(`filter-plugins: ${parts.join('; ')}`);
}

main();