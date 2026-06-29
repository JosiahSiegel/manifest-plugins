#!/usr/bin/env node
/**
 * build-overlay.mjs
 * ==================
 *
 * Compiles `src/overlays/mvp/*.ts` into `dist/overlays/mvp/*.js` using
 * the dedicated `tsconfig.overlay.json`. This is the runtime artifact
 * the MVP overlay apply path ships — `applyMvpOverlay` reads the
 * compiled JS from the plugin package's own dist, so the build must
 * produce it before the overlay can be applied.
 *
 * Idempotent: re-running the script overwrites the dist without
 * affecting the source. Pure ESM Node script — no transitive
 * dependencies beyond `typescript` (already a devDependency).
 *
 * Invoked by:
 *   - `npm run build:overlay` (manual)
 *   - `pipeline/build-and-publish.sh` when `--apply-overlay` is set
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const TSCONFIG_OVERLAY = resolve(repoRoot, 'tsconfig.overlay.json');
const OVERLAY_SRC_DIR = resolve(repoRoot, 'src', 'overlays', 'mvp');
const OVERLAY_OUT_DIR = resolve(repoRoot, 'dist', 'overlays', 'mvp');
// Resolve the locally-installed tsc binary directly so the script
// works without a global TypeScript install. The path mirrors
// `node_modules/.bin/tsc`; on Windows the extension is `.cmd`.
const TSC_BIN = process.platform === 'win32'
  ? join(repoRoot, 'node_modules', '.bin', 'tsc.cmd')
  : join(repoRoot, 'node_modules', '.bin', 'tsc');

function main() {
  // Preflight: refuse to run if the source directory is missing. The
  // MVP overlay surface is a hard requirement; an empty or missing
  // src/overlays/mvp/ would be a packaging regression and we want the
  // script to fail loud with a clear message.
  if (!existsSync(OVERLAY_SRC_DIR)) {
    process.stderr.write(
      `build-overlay: ${OVERLAY_SRC_DIR} does not exist. ` +
        'The MVP overlay package must be checked in before the build can run.\n',
    );
    process.exit(1);
  }

  const entries = readdirSync(OVERLAY_SRC_DIR);
  const tsEntries = entries.filter((name) => name.endsWith('.ts'));
  if (tsEntries.length === 0) {
    process.stderr.write(
      `build-overlay: no .ts source files in ${OVERLAY_SRC_DIR}. ` +
        'Add at least one overlay (e.g. manifest.ts) before building.\n',
    );
    process.exit(1);
  }

  // Run `tsc -p tsconfig.overlay.json`. We use execFileSync so the
  // tsc exit code propagates directly to the parent shell. We
  // resolve the locally-installed tsc binary directly to avoid
  // depending on `npx` (which is not guaranteed to be on PATH in
  // the script's exec context).
  if (!existsSync(TSC_BIN)) {
    process.stderr.write(
      `build-overlay: local tsc not found at ${TSC_BIN}. ` +
        'Run `npm install` to install the devDependency.\n',
    );
    process.exit(1);
  }
  try {
    // On Windows, .cmd shims require `shell: true` for execFileSync
    // (Node refuses to spawn .cmd binaries without it). On POSIX,
    // shell: true is unnecessary but harmless.
    execFileSync(TSC_BIN, ['-p', TSCONFIG_OVERLAY], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    // execFileSync already piped tsc's output to the parent. Just
    // re-emit the exit signal.
    const code = err && typeof err === 'object' && 'status' in err ? err.status : 1;
    process.exit(typeof code === 'number' ? code : 1);
  }

  // Post-build sanity check: confirm the out directory has at least
  // one .js artifact. A successful tsc run with `noEmit: false`
  // produces JS, but a misconfigured tsconfig.overlay.json (e.g. with
  // `noEmit: true`) could silently produce nothing.
  if (!existsSync(OVERLAY_OUT_DIR)) {
    process.stderr.write(
      `build-overlay: expected ${OVERLAY_OUT_DIR} to exist after tsc, but it does not.\n`,
    );
    process.exit(1);
  }
  const outEntries = readdirSync(OVERLAY_OUT_DIR);
  const jsEntries = outEntries.filter((name) => name.endsWith('.js'));
  if (jsEntries.length === 0) {
    process.stderr.write(
      `build-overlay: tsc produced no .js files in ${OVERLAY_OUT_DIR}. ` +
        'Check tsconfig.overlay.json (rootDir, outDir, noEmit).\n',
    );
    process.exit(1);
  }

  // Optional size check: refuse to ship an empty artifact. The
  // MVP overlay JS is tiny (a few hundred bytes), so a 0-byte file
  // is always wrong.
  for (const jsEntry of jsEntries) {
    const fullPath = resolve(OVERLAY_OUT_DIR, jsEntry);
    const stats = statSync(fullPath);
    if (stats.size === 0) {
      process.stderr.write(
        `build-overlay: ${fullPath} is 0 bytes — tsc output is empty.\n`,
      );
      process.exit(1);
    }
  }

  process.stdout.write(
    `build-overlay: compiled ${tsEntries.length} .ts source file(s) ` +
      `into ${jsEntries.length} .js artifact(s) at ${OVERLAY_OUT_DIR}\n`,
  );
}

main();