// scripts/jest-global-setup.js
// ============================================================================
// Jest global setup: runs once before any test file.
// ============================================================================
//
// Materializes external plugins into src/plugins/ so the auto-discovery in
// src/registry/discover.ts picks them up. This is the test-time counterpart
// of the build-time step `node scripts/fetch-external-plugins.mjs`.
//
// Runs the fetch script via child_process so the .mjs file is the single
// source of truth for both paths.

const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

module.exports = async function jestGlobalSetup() {
  const root = join(__dirname, '..');
  const manifestPath = join(root, 'external-plugins.json');

  if (!existsSync(manifestPath)) {
    // No external-plugins.json; nothing to fetch.
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