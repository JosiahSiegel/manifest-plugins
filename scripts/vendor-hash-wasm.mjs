#!/usr/bin/env node
/**
 * vendor-hash-wasm.mjs
 * =====================
 *
 * Post-build step that bundles the `hash-wasm` runtime into any plugin
 * dist directory that imports it. The plugin does its cch attestation via
 * `require('hash-wasm')`, but the published Docker image
 * (pipeline/Dockerfile.manifest) does NOT ship the host repo's node_modules
 * — only the compiled `dist/` + `package.json`. So a plain
 * `require('hash-wasm')` would fail with MODULE_NOT_FOUND at runtime.
 *
 * Scans every plugin under `dist/plugins/<name>/` for
 * `require('hash-wasm')` calls, bundles them into a per-plugin
 * `vendor-hash-wasm.js`, and rewrites the require to use the bundled
 * shim. Plugins that don't use hash-wasm are skipped (no output).
 *
 * Run automatically via `npm run build`. Re-runnable (overwrites the
 * bundled output on every run).
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const PLUGINS_DIST_DIR = resolve(repoRoot, 'dist', 'plugins');

function listJsFiles(dir) {
  const out = [];
  for (const child of readdirSync(dir)) {
    const full = join(dir, child);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listJsFiles(full));
    } else if (child.endsWith('.js') && child !== 'vendor-hash-wasm.js') {
      out.push(full);
    }
  }
  return out;
}

function findPluginsUsingHashWasm(pluginsDir) {
  // Group .js files by their containing plugin directory (one level
  // deep under pluginsDir, e.g. dist/plugins/<name>/...).
  const byPlugin = new Map();
  for (const file of listJsFiles(pluginsDir)) {
    const rel = file.slice(pluginsDir.length + 1).split(/[\\/]/);
    if (rel.length < 2) continue; // skip files directly in pluginsDir
    const pluginName = rel[0];
    let content;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    if (content.includes("require('hash-wasm')") || content.includes('require("hash-wasm")')) {
      if (!byPlugin.has(pluginName)) byPlugin.set(pluginName, []);
      byPlugin.get(pluginName).push(file);
    }
  }
  return byPlugin;
}

async function bundleForPlugin(pluginName, files) {
  const pluginDir = join(PLUGINS_DIST_DIR, pluginName);
  const bundleOut = join(pluginDir, 'vendor-hash-wasm.js');

  const shimEntry = `
    const { createXXHash64 } = require('hash-wasm');
    module.exports = { createXXHash64 };
  `;

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
    outfile: bundleOut,
    external: [],
    logLevel: 'error',
    metafile: false,
    sourcemap: false,
    minify: false,
    treeShaking: true,
    nodePaths: [resolve(repoRoot, 'node_modules')],
  });

  if (result.errors.length > 0) {
    console.error(`vendor-hash-wasm: ${pluginName} build failed:`);
    for (const err of result.errors) console.error('  ', err);
    return 0;
  }

  let rewrittenCount = 0;
  for (const file of files) {
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
    `vendor-hash-wasm: bundled hash-wasm into ${pluginName} (rewrote ${rewrittenCount} file(s))`,
  );
  return rewrittenCount;
}

async function main() {
  const byPlugin = findPluginsUsingHashWasm(PLUGINS_DIST_DIR);
  if (byPlugin.size === 0) {
    console.log(
      'vendor-hash-wasm: no hash-wasm require() found in any plugin .js; skipping',
    );
    return;
  }

  let totalRewritten = 0;
  for (const [pluginName, files] of byPlugin) {
    totalRewritten += await bundleForPlugin(pluginName, files);
  }
  if (totalRewritten > 0) {
    console.log(`vendor-hash-wasm: bundled ${byPlugin.size} plugin(s)`);
  }
}

main().catch((err) => {
  console.error('vendor-hash-wasm: unexpected error:', err);
  process.exit(1);
});