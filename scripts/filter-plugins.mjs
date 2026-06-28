#!/usr/bin/env node
/**
 * filter-plugins.mjs
 * ==================
 *
 * Post-build step that reads `manifest-plugins.config.json` and rewrites
 * `dist/index.js` to exclude plugins the user has disabled.
 *
 * The plugin array in `dist/index.js` is the literal text:
 *   `exports.plugins = Object.freeze([new X(...), new Y(...)]);`
 *
 * We find that block, split it on top-level commas, filter out the entries
 * whose class name appears in the config's `plugins` map with value
 * `false`, and write the file back. Class names not in the config are
 * enabled by default.
 *
 * Why post-build instead of compile-time:
 *   - The TS source (`src/index.ts`) is unfiltered, so `npm test` runs
 *     against the full plugin set with 100% coverage.
 *   - The shipped artifact (`dist/index.js`) is filtered, so the Docker
 *     image only carries the plugins the user wants.
 *   - No source-file mutation = no dirty working tree, no git status
 *     noise, no circular imports.
 *
 * Run automatically via `npm run build`. Re-runnable (idempotent if the
 * file is already in the desired shape).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const CONFIG_PATH = resolve(repoRoot, 'manifest-plugins.config.json');
const DIST_INDEX = resolve(repoRoot, 'dist/index.js');

/**
 * Plugins shipped by the registry. Adding a new plugin requires adding
 * its class name here AND instantiating it in `src/index.ts` — the
 * registry is the build-time allowlist, the index is the runtime
 * instantiation.
 */
const PLUGIN_CLASS_NAMES = ['AnthropicBillingHeaderPlugin', 'DefaultPolicyPlugin'];

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
      'manifest-plugins.config.json: "plugins" must be an object mapping class name to boolean',
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

function validateConfig(config) {
  for (const name of Object.keys(config.plugins)) {
    if (!PLUGIN_CLASS_NAMES.includes(name)) {
      throw new Error(
        `manifest-plugins.config.json: unknown plugin "${name}" — ` +
          `valid plugins are: ${PLUGIN_CLASS_NAMES.join(', ')}. ` +
          `If you added a new plugin, update PLUGIN_CLASS_NAMES in scripts/filter-plugins.mjs.`,
      );
    }
  }
}

function filterIndexJs(distSource, enabledMap) {
  // Find the exports.plugins = Object.freeze([...]); block. The array
  // body may span multiple lines and contain nested parentheses from
  // constructor calls. We use a lazy regex match.
  const pattern = /exports\.plugins\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\);/;
  const match = distSource.match(pattern);
  if (!match) {
    throw new Error(
      'dist/index.js does not contain the expected `exports.plugins = Object.freeze([...]);` block. ' +
        'The build output shape may have changed; update scripts/filter-plugins.mjs.',
    );
  }
  const arrayBody = match[1];
  // Split on top-level commas. Each element is `new ClassName(...)` (no
  // commas inside, since class constructors here take no positional args
  // other than possibly nested objects — and we don't pass any in the
  // current registry).
  const entries = arrayBody
    .split(/,\s*(?=new )/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Extract class name from each entry. Match `new [namespace.]ClassName(`
  // (tsc may rewrite imports to a namespace like `plugin_1.AnthropicBillingHeaderPlugin`).
  // We extract the class name as the part after the last `.`.
  const kept = entries.filter((entry) => {
    const classMatch = entry.match(/^new\s+(?:[\w$]+\.)?([A-Za-z_$][\w$]*)\s*\(/);
    if (!classMatch) {
      throw new Error(
        `Could not parse plugin entry: "${entry}". Update scripts/filter-plugins.mjs.`,
      );
    }
    const className = classMatch[1];
    // Default = enabled. Config value of `false` = disabled.
    return enabledMap[className] !== false;
  });
  const replacement = `exports.plugins = Object.freeze([${kept.join(', ')}]);`;
  return distSource.replace(pattern, replacement);
}

function main() {
  if (!existsSync(DIST_INDEX)) {
    console.error(
      `filter-plugins: ${DIST_INDEX} not found. Run \`npm run build\` first.`,
    );
    process.exit(1);
  }
  const config = loadConfig();
  validateConfig(config);
  const distSource = readFileSync(DIST_INDEX, 'utf-8');
  const filtered = filterIndexJs(distSource, config.plugins);
  if (filtered === distSource) {
    const excluded = PLUGIN_CLASS_NAMES.filter(
      (n) => config.plugins[n] === false,
    );
    console.log(
      `filter-plugins: dist/index.js already filtered${
        excluded.length > 0 ? ` (excluded: ${excluded.join(', ')})` : ''
      }`,
    );
    return;
  }
  writeFileSync(DIST_INDEX, filtered, 'utf-8');
  const excluded = PLUGIN_CLASS_NAMES.filter(
    (n) => config.plugins[n] === false,
  );
  const included = PLUGIN_CLASS_NAMES.filter(
    (n) => config.plugins[n] !== false,
  );
  console.log(
    `filter-plugins: rewrote dist/index.js — included: [${included.join(
      ', ',
    )}], excluded: [${excluded.join(', ')}]`,
  );
}

main();