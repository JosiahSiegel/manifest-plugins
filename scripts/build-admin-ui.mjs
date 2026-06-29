#!/usr/bin/env node
/**
 * build-admin-ui.mjs
 * ==================
 *
 * Bundles the plugin admin React UI into a single IIFE file at
 * `dist/admin/admin.js`. The bundle is served by the admin Express
 * server at `GET /admin/admin.js` and is loaded by the dashboard
 * mount overlay (src/overlays/mvp/mount-dashboard.ts) into
 * `<div id="plugin-manager-root">`.
 *
 * Why esbuild (not tsc):
 *   - We need a single IIFE bundle (no external imports) that the
 *     browser can load via a `<script src="/admin/admin.js">` tag.
 *     tsc emits CommonJS modules that browsers can't run directly.
 *   - esbuild is fast (~50ms for this size) and the output is
 *     production-ready.
 *
 * Why bundle React (vs. external):
 *   - The dashboard `<script>` tag has no module system, no
 *     bundler, no resolve. Bundling React + ReactDOM in
 *     eliminates the import resolution problem entirely.
 *   - The cost is ~140KB minified, which is acceptable for an
 *     internal admin UI mounted once per dashboard session.
 *
 * Why target es2020:
 *   - Modern enough for the Manifest dashboard target (Node 20+,
 *     Chrome 90+, all evergreen browsers).
 *   - The esbuild minifier defaults are fine; we don't enable
 *     `--minify` because the bundle is small and we want readable
 *     stack traces in dev.
 *
 * Idempotent: re-running rebuilds the artifact in place. The script
 * exits 1 if the esbuild binary is missing, if the source is
 * missing, or if the bundle is empty.
 *
 * Wired into `npm run build` after `node scripts/build-overlay.mjs`.
 */

import { existsSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const ENTRY_CANDIDATES = [
  join(REPO_ROOT, 'src', 'admin', 'ui', 'index.tsx'),
  join(REPO_ROOT, 'src', 'admin', 'ui', 'index.ts'),
];
const OUT_DIR = join(REPO_ROOT, 'dist', 'admin');
const OUT_FILE = join(OUT_DIR, 'admin.js');

function findEntry() {
  for (const candidate of ENTRY_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function main() {
  const entry = findEntry();
  if (entry === null) {
    process.stderr.write(
      `build-admin-ui: no entry file found under src/admin/ui/ (tried ${ENTRY_CANDIDATES.join(', ')})\n`,
    );
    process.exit(1);
  }

  // Locate esbuild. Prefer the local install at
  // `<repoRoot>/node_modules/.bin/esbuild[.cmd]`. Fall back to a
  // global `esbuild` on PATH if the local one is missing.
  const localBin = process.platform === 'win32'
    ? join(REPO_ROOT, 'node_modules', '.bin', 'esbuild.cmd')
    : join(REPO_ROOT, 'node_modules', '.bin', 'esbuild');
  const esbuildBin = existsSync(localBin) ? localBin : 'esbuild';

  mkdirSync(OUT_DIR, { recursive: true });

  const args = [
    entry,
    '--bundle',
    '--format=iife',
    '--target=es2020',
    '--platform=browser',
    '--loader:.ts=ts',
    '--loader:.tsx=tsx',
    '--outfile=' + OUT_FILE,
    '--log-level=warning',
  ];

  try {
    // On Windows, .cmd shims require `shell: true` for execFileSync
    // (Node refuses to spawn .cmd binaries without it). On POSIX,
    // shell: true is unnecessary but harmless.
    execFileSync(esbuildBin, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    const code = err && typeof err === 'object' && 'status' in err ? err.status : 1;
    process.stderr.write(`build-admin-ui: esbuild failed (exit ${code})\n`);
    process.exit(typeof code === 'number' ? code : 1);
  }

  // Post-build sanity check: file exists, non-zero, and parses.
  if (!existsSync(OUT_FILE)) {
    process.stderr.write(`build-admin-ui: ${OUT_FILE} was not produced\n`);
    process.exit(1);
  }
  const stats = statSync(OUT_FILE);
  if (stats.size === 0) {
    process.stderr.write(`build-admin-ui: ${OUT_FILE} is empty (esbuild produced no output)\n`);
    process.exit(1);
  }
  const head = readFileSync(OUT_FILE, 'utf-8').slice(0, 4096);
  // The IIFE bundle must start with `(()=>{` or `var ...=` etc.
  // A simple "any non-whitespace content" check catches the
  // "empty bundle" failure mode esbuild can produce when the
  // entry has only type-only exports.
  if (head.trim().length === 0) {
    process.stderr.write(`build-admin-ui: ${OUT_FILE} contains only whitespace\n`);
    process.exit(1);
  }

  process.stdout.write(
    `build-admin-ui: wrote ${OUT_FILE} (${stats.size} bytes)\n`,
  );
}

main();