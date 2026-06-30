#!/usr/bin/env node
// scripts/fetch-external-plugins.mjs
// ============================================================================
// External plugin loader
// ============================================================================
//
// Reads external-plugins.json, fetches each plugin from its source repo, and
// materializes it under src/plugins/<name>/ so the existing auto-discovery
// (src/registry/discover.ts) picks it up at build/test time.
//
// Why this exists:
//   Plugins that aren't appropriate to vendor into the public manifest-plugins
//   repo (private, commercial, sensitive business logic, large dependencies,
//   etc.) can be loaded at build time from a separate repo. Adding a new
//   external plugin is one line in external-plugins.json — no edits to
//   src/index.ts, no manual copy step.
//
// Authentication:
//   - SSH (default): git+ssh://git@github.com/owner/repo.git, uses the
//     user's SSH key. Works in any environment with a configured SSH key.
//   - HTTPS + token: set GIT_TOKEN (or have `gh auth` available) for
//     HTTPS access to private repos in CI/sandboxes without SSH keys.
//
// Idempotency:
//   Each fetch wipes and re-extracts src/plugins/<name>/, so the build is
//   always deterministic from external-plugins.json + the pinned refs.
//
// See docs/EXTERNAL_PLUGINS.md for the full plugin manifest schema.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const MANIFEST_PATH = join(ROOT, 'external-plugins.json');
const PLUGINS_DIR = join(ROOT, 'src', 'plugins');

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    return { plugins: [] };
  }
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw);
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function rmrf(dir) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function resolveSourceUrl(entry) {
  // Allow HTTPS override via GIT_TOKEN for CI without SSH keys.
  // Falls back to `gh auth token` if GIT_TOKEN isn't set in env.
  if (entry.source.startsWith('git+ssh://git@github.com/')) {
    let token = process.env.GIT_TOKEN;
    if (!token) {
      try {
        const out = execFileSync('gh', ['auth', 'token'], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        token = out.toString().trim();
      } catch {
        // gh CLI not available; rely on SSH.
      }
    }
    if (token) {
      const path = entry.source.replace('git+ssh://git@github.com/', '');
      return `https://x-access-token:${token}@github.com/${path}`;
    }
  }
  return entry.source;
}

function fetchPlugin(entry) {
  if (!entry.name || !entry.source || !entry.ref) {
    throw new Error(
      `external-plugins.json entry missing required field(s): ${JSON.stringify(entry)}`,
    );
  }

  const target = join(PLUGINS_DIR, entry.name);
  const sourceUrl = resolveSourceUrl(entry);
  const ref = entry.ref;

  console.log(`fetch-external-plugins: ${entry.name} @ ${ref}`);
  if (entry.private === true) {
    const usingToken = process.env.GIT_TOKEN || hasGhAuth();
    console.log(`  (private repo — using ${usingToken ? 'token' : 'SSH'} auth)`);
  }

  // Step 1: rm -rf the target dir to ensure clean state.
  rmrf(target);
  ensureDir(target);

  // Step 2: shallow clone to a temp dir. Windows doesn't support
  // `git archive --remote` reliably, so we use clone + copy.
  const tmpDir = join(ROOT, '.tmp-external-plugin-' + entry.name);
  rmrf(tmpDir);
  ensureDir(tmpDir);

  try {
    execFileSync(
      'git',
      ['clone', '--depth', '1', '--branch', ref, sourceUrl, tmpDir],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    rmrf(tmpDir);
    throw new Error(
      `fetch-external-plugins: failed to clone ${entry.name} from ${entry.source}@${ref}: ${err.message}`,
    );
  }

  // Step 3: find the plugin directory inside the cloned repo. The convention
  // is src/plugins/<name>/, but we also try src/<name>/ and root for
  // single-plugin repos.
  const candidates = [
    join(tmpDir, 'src', 'plugins', entry.name),
    join(tmpDir, 'src', entry.name),
    join(tmpDir, entry.name),
    tmpDir,
  ];
  const sourceDir = candidates.find((p) => existsSync(p));
  if (!sourceDir) {
    rmrf(tmpDir);
    throw new Error(
      `fetch-external-plugins: could not locate plugin dir for ${entry.name} (tried: ${candidates
        .map((c) => relative(tmpDir, c))
        .join(', ')})`,
    );
  }

  // Step 4: copy source files into src/plugins/<name>/, excluding common
  // non-source artifacts.
  copyDir(sourceDir, target);

  // Step 5: copy root-level metadata files if present.
  for (const f of ['package.json', 'README.md', 'LICENSE', 'LICENSE.md']) {
    const src = join(tmpDir, f);
    if (existsSync(src)) {
      copyFile(src, join(target, f));
    }
  }

  // Step 6: run the plugin's vendor script if present (e.g. for plugins
  // that bundle hash-wasm or other build artifacts).
  const vendorScript = join(target, 'vendor-hash-wasm.mjs');
  if (existsSync(vendorScript)) {
    console.log(`  running vendor script: ${relative(ROOT, vendorScript)}`);
    try {
      execFileSync('node', [vendorScript], { cwd: target, stdio: 'inherit' });
    } catch (err) {
      console.warn(`  vendor script failed (non-fatal): ${err.message}`);
    }
  }

  // Step 7: cleanup temp clone.
  rmrf(tmpDir);

  console.log(`  -> ${relative(ROOT, target)}`);
}

function hasGhAuth() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of readdirSync(src)) {
    if (
      entry === 'node_modules' ||
      entry === '.git' ||
      entry === 'dist' ||
      entry === 'coverage'
    ) {
      continue;
    }
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (stat.isFile()) {
      copyFile(srcPath, destPath);
    }
  }
}

function copyFile(src, dest) {
  writeFileSync(dest, readFileSync(src));
}

function main() {
  const manifest = readManifest();
  const plugins = manifest.plugins || [];

  if (plugins.length === 0) {
    // Empty manifest is the supported default; no work to do.
    return;
  }

  console.log(`fetch-external-plugins: ${plugins.length} plugin(s) configured\n`);

  let failed = 0;
  for (const entry of plugins) {
    try {
      fetchPlugin(entry);
    } catch (err) {
      console.error(`fetch-external-plugins: ERROR for ${entry.name}:`);
      console.error(`  ${err.message}\n`);
      failed++;
    }
  }

  if (failed > 0) {
    console.error(`fetch-external-plugins: ${failed} plugin(s) failed to fetch`);
    process.exit(1);
  }

  console.log(`\nfetch-external-plugins: ${plugins.length} plugin(s) ready under src/plugins/`);
}

main();