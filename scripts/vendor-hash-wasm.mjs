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
 * Implementation detail: v0.3.0 split the plugin into multiple files
 * (`plugin.ts`, `cch.ts`, `body.ts`, `constants.ts`). The
 * `require('hash-wasm')` call lives in `cch.ts` after the split; the
 * vendor step scans every plugin .js file for the require and bundles
 * them all into one shared `vendor-hash-wasm.js` that any of them can
 * pull in.
 *
 * Run automatically via `npm run build`. Re-runnable (overwrites the
 * bundled output on every run).
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const PLUGIN_DIR = resolve(repoRoot, 'dist/plugins/anthropic-billing-header');
const BUNDLE_OUT = join(PLUGIN_DIR, 'vendor-hash-wasm.js');

function listPluginFiles(dir) {
  const out = [];
  for (const child of readdirSync(dir)) {
    if (child === 'vendor-hash-wasm.js') continue;
    if (child.startsWith('.')) continue;
    if (child.endsWith('.js')) {
      out.push(join(dir, child));
    }
  }
  return out;
}

async function main() {
  // Find every plugin .js file that imports `hash-wasm` via require().
  const candidates = listPluginFiles(PLUGIN_DIR).filter((file) => {
    if (!file.endsWith('.js')) return false;
    try {
      return readFileSync(file, 'utf-8').includes("require('hash-wasm')");
    } catch {
      return false;
    }
  });

  if (candidates.length === 0) {
    console.log(
      'vendor-hash-wasm: no hash-wasm require() found in any plugin .js; skipping',
    );
    return;
  }

  // Bundle a tiny shim that re-exports `createXXHash64` from hash-wasm.
  // The hash-wasm UMD bundle is self-contained (WASM inlined) and lazy-loads
  // per-algorithm chunks via dynamic import.
  const shimEntry = `
    const { createXXHash64 } = require('hash-wasm');
    module.exports = { createXXHash64 };
  `;

  mkdirSync(PLUGIN_DIR, { recursive: true });

  const result = await build({
    stdin: {
      contents: shimEntry,
      resolveDir: repoRoot,
      sourcefile: 'hash-wasm-shim.js',
    },
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: BUNDLE_OUT,
    external: [],
    logLevel: 'error',
    metafile: false,
    sourcemap: false,
    minify: false,
    treeShaking: true,
    // Tell esbuild where to find hash-wasm in the host repo's
    // node_modules at build time.
    nodePaths: [resolve(repoRoot, 'node_modules')],
  });

  if (result.errors.length > 0) {
    console.error('vendor-hash-wasm: build failed:');
    for (const err of result.errors) console.error(' ', err);
    process.exit(1);
  }

  // Rewrite every plugin .js that imported `hash-wasm` to load the bundle
  // instead. The bundle is a sibling of `plugin.js`, so a relative
  // import works for every consumer.
  let rewrittenCount = 0;
  for (const file of candidates) {
    const src = readFileSync(file, 'utf-8');
    const rewritten = src.replace(
      /require\(['"]hash-wasm['"]\)/g,
      "require('./vendor-hash-wasm')",
    );
    if (rewritten !== src) {
      writeFileSync(file, rewritten, 'utf-8');
      rewrittenCount += 1;
    }
  }

  console.log(
    `vendor-hash-wasm: bundled hash-wasm into ${BUNDLE_OUT} (rewrote ${rewrittenCount} file(s))`,
  );
}

main().catch((err) => {
  console.error('vendor-hash-wasm: unexpected error:', err);
  process.exit(1);
});