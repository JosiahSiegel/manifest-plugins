#!/usr/bin/env node
/**
 * filter-plugins.mjs
 * ==================
 *
 * Post-build step that reads `manifest-plugins.config.json` and rewrites
 * `dist/index.js` metadata defaults for plugins the user has disabled.
 *
 * The plugin array in `dist/index.js` keeps every installed plugin class so
 * runtime overrides can re-enable it. A config value of `false` only changes
 * the plugin's `enabledByDefault` metadata from `true` to `false`.
 *
 * Why post-build instead of compile-time:
 *   - The TS source (`src/index.ts`) is unfiltered, so `npm test` runs
 *     against the full plugin set with 100% coverage.
 *   - The shipped artifact (`dist/index.js`) keeps disabled plugins
 *     discoverable while changing their default enabled state.
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

function parseRegistryClassNames(distSource) {
  // Find the registry array. tsc emits `const pluginRegistry = Object.freeze([...])`
  // where each entry is `Object.freeze({ pluginClassName: 'X', ... })`. We
  // use a lazy regex match on the `pluginClassName: 'X'` markers to stay
  // agnostic to the rest of the shape (single-line vs multi-line,
  // presence of additional registry fields, etc.).
  const pattern = /pluginRegistry\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/;
  const match = distSource.match(pattern);
  if (!match) {
    throw new Error(
      'dist/index.js does not contain the expected `pluginRegistry = Object.freeze([...])` block. ' +
        'The build output shape may have changed; update scripts/filter-plugins.mjs.',
    );
  }
  const arrayBody = match[1];
  const classMatches = [
    ...arrayBody.matchAll(/pluginClassName:\s*['"]([^'"]+)['"]/g),
  ];
  if (classMatches.length === 0) {
    throw new Error(
      'dist/index.js pluginRegistry block does not contain any pluginClassName markers. ' +
        'Update scripts/filter-plugins.mjs.',
    );
  }
  return classMatches.map((m) => m[1]);
}

function annotateEnabledDefaults(distSource, disabledClassNames) {
  if (disabledClassNames.length === 0) return distSource;
  const pluginIds = {
    AnthropicBillingHeaderPlugin: 'anthropic-billing-header',
    DefaultPolicyPlugin: 'default-policy',
  };
  let next = distSource;
  for (const className of disabledClassNames) {
    const pluginId = pluginIds[className];
    const idIndex = next.indexOf(`id: "${pluginId}"`);
    if (idIndex === -1) continue;
    const defaultIndex = next.indexOf('enabledByDefault: true', idIndex);
    if (defaultIndex === -1) continue;
    next = `${next.slice(0, defaultIndex)}enabledByDefault: false${next.slice(
      defaultIndex + 'enabledByDefault: true'.length,
    )}`;
  }
  return next;
}

function filterIndexJs(distSource, enabledMap) {
  const registryClassNames = parseRegistryClassNames(distSource);
  const disabledClassNames = registryClassNames.filter(
    (className) => enabledMap[className] === false,
  );
  return annotateEnabledDefaults(distSource, disabledClassNames);
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