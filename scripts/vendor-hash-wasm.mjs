#!/usr/bin/env node
/**
 * vendor-hash-wasm.mjs
 * =====================
 *
 * Post-build step that bundles the `hash-wasm` runtime into the
 * `anthropic-billing-header` plugin's dist output. The plugin does its
 * cch attestation via `require('hash-wasm')`, but the published Docker
 * image (pipeline/Dockerfile.manifest) does NOT ship the host repo's
 * node_modules — only the compiled `dist/` + `package.json`. So a
 * plain `require('hash-wasm')` would fail with MODULE_NOT_FOUND at
 * runtime.
 *
 * Two facts make a per-plugin bundle the right shape:
 *   - hash-wasm ships a ~1.1 MB self-contained WASM blob (the
 *     xxhash64 binary is built in to the same .umd.js entry, plus a
 *     handful of lazily-loaded per-algorithm .umd.min.js chunks).
 *     We bundle only the xxhash64 chunk to keep the dist small.
 *   - esbuild produces a single CJS bundle that the plugin's compiled
 *     `require()` can resolve, no matter where the host repo's
 *     node_modules is on disk at runtime.
 *
 * Run automatically via `npm run build`. Re-runnable (overwrites the
 * bundled output on every run).
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const PLUGIN_DIR = resolve(repoRoot, 'dist/plugins/anthropic-billing-header');
const ENTRY_FILE = join(PLUGIN_DIR, 'plugin.js');
const BUNDLE_OUT = join(PLUGIN_DIR, 'vendor-hash-wasm.js');

async function main() {
  // Read the compiled plugin source to find the `require('hash-wasm')`
  // call sites we want to inline.
  const pluginSrc = readFileSync(ENTRY_FILE, 'utf-8');
  if (!pluginSrc.includes("require('hash-wasm')")) {
    console.log('vendor-hash-wasm: no hash-wasm require() found in plugin.js; skipping');
    return;
  }

  // Bundle a tiny shim that re-exports `createXXHash64` from hash-wasm.
  // We bundle the whole hash-wasm package (the CJS UMD entry is
  // self-contained and lazy-loads per-algorithm chunks via dynamic
  // import).
  const shimEntry = `
    const { createXXHash64 } = require('hash-wasm');
    module.exports = { createXXHash64 };
  `;

  mkdirSync(PLUGIN_DIR, { recursive: true });

  const result = await build({
    stdin: { contents: shimEntry, resolveDir: repoRoot, sourcefile: 'hash-wasm-shim.js' },
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: BUNDLE_OUT,
    // Don't try to resolve Node built-ins; the host repo's @types/node
    // doesn't exist at Docker build time.
    external: [],
    logLevel: 'error',
    metafile: false,
    sourcemap: false,
    minify: false,
    treeShaking: true,
    // Tell esbuild where to find hash-wasm in the host repo's
    // node_modules at build time. The Docker build context does NOT
    // have access to this — but the build script runs on the CI host
    // where the plugin source was just `npm install`-ed.
    nodePaths: [resolve(repoRoot, 'node_modules')],
  });

  if (result.errors.length > 0) {
    console.error('vendor-hash-wasm: build failed:');
    for (const err of result.errors) console.error(' ', err);
    process.exit(1);
  }

  // Rewrite the plugin's `require('hash-wasm')` to point at the bundle.
  // We use a precise rewrite because the plugin calls the same require
  // at multiple sites.
  const rewritten = pluginSrc.replace(
    /require\(['"]hash-wasm['"]\)/g,
    "require('./vendor-hash-wasm')",
  );
  writeFileSync(ENTRY_FILE, rewritten, 'utf-8');

  console.log(`vendor-hash-wasm: bundled hash-wasm into ${BUNDLE_OUT}`);
}

main().catch((err) => {
  console.error('vendor-hash-wasm: unexpected error:', err);
  process.exit(1);
});