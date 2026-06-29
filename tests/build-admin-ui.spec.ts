/**
 * Tests for `scripts/build-admin-ui.mjs`.
 *
 * The plugin admin React UI is bundled by this script into
 * `dist/admin/admin.js`, which is then served by the admin Express
 * server at `GET /admin/admin.js` and loaded into
 * `<div id="plugin-manager-root">` by the dashboard mount overlay.
 *
 * Tests are written as text-level inspections of the script source
 * plus a controlled end-to-end run in a tempdir. We never invoke the
 * real `scripts/build-admin-ui.mjs` against the repo's own dist —
 * that would pollute the working tree.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';

const REPO_ROOT = join(__dirname, '..');
const BUILD_SCRIPT = join(REPO_ROOT, 'scripts', 'build-admin-ui.mjs');

function readScript(): string {
  return readFileSync(BUILD_SCRIPT, 'utf-8');
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'manifest-plugins-build-admin-ui-'));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

describe('scripts/build-admin-ui.mjs', () => {
  it('is a real file on disk (not a phantom import)', () => {
    expect(existsSync(BUILD_SCRIPT)).toBe(true);
  });

  it('invokes esbuild to produce the bundle', () => {
    const script = readScript();
    expect(script).toMatch(/esbuild/);
    // The script must shell out to the esbuild binary rather than
    // reimplementing bundling inline.
    expect(script).toMatch(/execFileSync|spawn/);
  });

  it('writes the bundle to dist/admin/admin.js', () => {
    const script = readScript();
    expect(script).toMatch(/dist[\\/]+admin[\\/]+admin\.js/);
    // Sanity: the source entry under src/admin/ui/ must be referenced.
    expect(script).toMatch(/src[\\/]+admin[\\/]+ui/);
  });

  it('resolves the entry from both .tsx and .ts candidates', () => {
    const script = readScript();
    // The project tsconfig has no jsx flag; T5's WAVE 3 agent
    // therefore wrote the UI as index.ts (no JSX, uses
    // React.createElement). The build script must try both .tsx
    // and .ts in case a future revision adds JSX.
    expect(script).toMatch(/index\.tsx/);
    expect(script).toMatch(/index\.ts/);
  });

  it('runs end-to-end against a temp project and produces a non-empty IIFE bundle', () => {
    const tmp = tempDir();
    try {
      const stubRoot = tmp;
      const stubSrc = join(stubRoot, 'src', 'admin', 'ui');
      const stubOut = join(stubRoot, 'dist', 'admin');
      const stubBin = join(stubRoot, 'node_modules', '.bin');
      mkdirSync(join(stubRoot, 'scripts'), { recursive: true });
      mkdirSync(stubSrc, { recursive: true });
      mkdirSync(stubBin, { recursive: true });

      // Copy the real build script into the stub repo. The script's
      // import.meta.url resolution yields <stubRoot> when the
      // script lives at <stubRoot>/scripts/build-admin-ui.mjs, so
      // no path patching is needed.
      const buildScriptSource = readFileSync(BUILD_SCRIPT, 'utf-8');
      writeFileSync(
        join(stubRoot, 'scripts', 'build-admin-ui.mjs'),
        buildScriptSource,
        'utf-8',
      );

      // Copy the esbuild binary shim into the stub repo so the
      // build script's execFileSync can find it without depending
      // on PATH. The real esbuild package lives at
      // <repoRoot>/node_modules/esbuild — its lib/ subdirectory
      // holds the actual implementation that the .cmd shim
      // delegates to.
      const realEsbuildBin = process.platform === 'win32'
        ? join(REPO_ROOT, 'node_modules', '.bin', 'esbuild.cmd')
        : join(REPO_ROOT, 'node_modules', '.bin', 'esbuild');
      if (!existsSync(realEsbuildBin)) {
        // eslint-disable-next-line no-console
        console.warn(
          `esbuild binary not found at ${realEsbuildBin}; skipping end-to-end test.`,
        );
        return;
      }
      copyFileSync(
        realEsbuildBin,
        process.platform === 'win32'
          ? join(stubBin, 'esbuild.cmd')
          : join(stubBin, 'esbuild'),
      );
      // Recursive copy of the esbuild package directory so the
      // .cmd shim can find lib/main.js + platform-specific binary.
      // Also copy @esbuild/win32-x64 (an optionalDependency that
      // contains the actual platform binary esbuild spawns).
      const fs = require('node:fs') as typeof import('node:fs');
      const copyRecursive = (src: string, dest: string): void => {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          fs.mkdirSync(dest, { recursive: true });
          for (const entry of fs.readdirSync(src)) {
            copyRecursive(join(src, entry), join(dest, entry));
          }
        } else {
          fs.copyFileSync(src, dest);
        }
      };
      const realEsbuildDir = join(REPO_ROOT, 'node_modules', 'esbuild');
      const stubEsbuildDir = join(stubRoot, 'node_modules', 'esbuild');
      if (existsSync(realEsbuildDir)) {
        copyRecursive(realEsbuildDir, stubEsbuildDir);
      }
      const realEsbuildScopesDir = join(
        REPO_ROOT,
        'node_modules',
        '@esbuild',
      );
      const stubEsbuildScopesDir = join(stubRoot, 'node_modules', '@esbuild');
      if (existsSync(realEsbuildScopesDir)) {
        copyRecursive(realEsbuildScopesDir, stubEsbuildScopesDir);
      }

      // Write a minimal stub entry that compiles cleanly under
      // esbuild's TypeScript loader.
      const stubEntry = 'console.log("build-admin-ui e2e stub");\n';
      writeFileSync(join(stubSrc, 'index.ts'), stubEntry, 'utf-8');

      const result = spawnSync(
        'node',
        [join(stubRoot, 'scripts', 'build-admin-ui.mjs')],
        {
          encoding: 'utf-8',
          cwd: stubRoot,
        },
      );
      if (result.status !== 0) {
        throw new Error(
          `build-admin-ui.mjs failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
        );
      }
      const bundlePath = join(stubOut, 'admin.js');
      expect(existsSync(bundlePath)).toBe(true);
      const bundleStat = statSync(bundlePath);
      expect(bundleStat.size).toBeGreaterThan(0);
      const bundleSource = readFileSync(bundlePath, 'utf-8');
      expect(bundleSource.length).toBeGreaterThan(0);
      // The stub console.log should appear in the bundle.
      expect(bundleSource).toContain('build-admin-ui e2e stub');
    } finally {
      cleanup(tmp);
    }
  });
});

// Reference resolve/dirname so the imports stay live in the type
// graph (no-op at runtime).
void resolve;
void dirname;