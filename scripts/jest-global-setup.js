// scripts/jest-global-setup.js
// ============================================================================
// Jest global setup: runs once before any test file.
// ============================================================================
//
// By default, unit tests run against the in-tree plugin set only. External
// plugins are an operator concern (deployed via the loader at build time),
// not a contributor concern (unit tests must remain deterministic regardless
// of operator-side configuration).
//
// To opt in to fetching external plugins for a test run, set:
//   JEST_FETCH_EXTERNAL_PLUGINS=1 npm test
//
// When opted in, this delegates to the same script the build pipeline uses
// (scripts/fetch-external-plugins.mjs) so there's a single source of truth
// for the loader behavior.

const { execFileSync } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const IN_TREE_PLUGIN_DIRS = new Set(['default-policy', 'header-tier-router', 'show-all-router-views']);

module.exports = async function jestGlobalSetup() {
  const root = join(__dirname, '..');
  const pluginsDir = join(root, 'src', 'plugins');

  // Always start from a clean in-tree baseline. If a previous build or
  // opt-in run left external plugin sources under src/plugins/, wipe
  // them so unit tests see a deterministic two-plugin registry.
  if (existsSync(pluginsDir)) {
    for (const child of readdirSync(pluginsDir)) {
      if (IN_TREE_PLUGIN_DIRS.has(child)) continue;
      execFileSync('node', [
        '-e',
        `require('fs').rmSync(${JSON.stringify(join(pluginsDir, child))}, ` +
          `{ recursive: true, force: true })`,
      ]);
      console.log(`jest-global-setup: removed external plugin source ${child}/`);
    }
  }

  if (process.env.JEST_FETCH_EXTERNAL_PLUGINS !== '1') {
    return;
  }

  const fetchScript = join(root, 'scripts', 'fetch-external-plugins.mjs');
  if (!existsSync(fetchScript)) {
    console.warn(
      'jest-global-setup: fetch-external-plugins.mjs not found; external plugins will be missing from tests',
    );
    return;
  }

  // Build env, falling back to gh auth token if needed.
  const env = { ...process.env };
  if (!env.GIT_TOKEN) {
    try {
      const ghToken = execFileSync('gh', ['auth', 'token'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      if (ghToken) env.GIT_TOKEN = ghToken;
    } catch {
      // gh CLI not available or not authenticated; SSH must work.
    }
  }

  execFileSync('node', [fetchScript], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
};