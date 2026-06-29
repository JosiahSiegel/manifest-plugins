/**
 * RED shell-level integration tests for the pipeline.
 *
 * Locks down the MVP gate behavior of the pipeline scripts by
 * running them directly via `bash`:
 *
 *   - `pipeline/build-and-publish.sh --help` exits 0 with usage text.
 *   - `pipeline/build-and-publish.sh --mvp` with no source override
 *     exits 2 (refuses MVP build against implicit official clone).
 *   - The default flow (no flags) defaults `MANIFEST_URL` to the
 *     official `https://github.com/mnfst/manifest.git` clone URL.
 *   - Both pipeline scripts pass `bash -n` syntax check.
 *   - Both pipeline scripts pass `shellcheck -s bash` lint.
 *   - `pipeline/e2e-test.sh` MVP_UI=1 path detects a missing / broken
 *     `jq` on PATH and exits 4 — without requiring jq itself.
 *
 * All tests are sync (no async timing flakes) and never invoke
 * `docker` or hit the network. We exercise the MVP gate branch by
 * stubbing the prerequisites that would otherwise fail first:
 *   - For `--mvp` without source: the script checks the gate BEFORE
 *     the docker / git / node prerequisite loop, so a stub PATH
 *     suffices.
 *   - For `--help`: the script's `usage` function `exit 0`s before
 *     any prerequisite check.
 *   - For the e2e MVP_UI jq check: we put a non-functional stub
 *     `jq` on PATH first so the `command -v jq` succeeds but
 *     `jq --version` fails, matching the documented exit code 4.
 */
import { spawnSync, SpawnSyncReturns } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const REPO_ROOT = join(__dirname, '..');
const BUILD_SCRIPT = join(REPO_ROOT, 'pipeline', 'build-and-publish.sh');
const E2E_SCRIPT = join(REPO_ROOT, 'pipeline', 'e2e-test.sh');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PATCHED_MANIFEST_FILES = [
  {
    relativePath: 'packages/backend/src/routing/proxy/provider-client.ts',
    content: 'function applyRequestTransformPlugins() {}\n',
  },
  {
    relativePath: 'packages/backend/src/routing/proxy/proxy-rate-limiter.ts',
    content: 'function getResolvedConcurrencyMax() { return 10; }\n',
  },
  {
    relativePath: 'packages/backend/src/routing/proxy/proxy.service.ts',
    content: 'function getResolvedMaxMessagesPerRequest() { return Infinity; }\n',
  },
] as const;

function readScript(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, 'pipeline', relativePath), 'utf-8');
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function writePatchedManifestFixture(root: string): void {
  for (const file of PATCHED_MANIFEST_FILES) {
    const target = join(root, file.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf-8');
  }
}

function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): SpawnSyncReturns<string> {
  return spawnSync(command, args as string[], {
    env,
    cwd,
    encoding: 'utf-8',
  });
}

describe('apply CLI integration', () => {
  it('uses positional checkout path even when MANIFEST_URL remains in the environment', () => {
    const tmp = tempDir('manifest-apply-cli-env-url-');
    try {
      writePatchedManifestFixture(tmp);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MANIFEST_URL: 'https://github.com/mnfst/manifest.git',
        MANIFEST_DIR: '',
        MANIFEST_CHECKOUT: '',
        MANIFEST_FORK: '',
        MVP_UI: '',
      };

      const result = run(process.execPath, [TSX_CLI, 'src/host/cli.ts', tmp], env, REPO_ROOT);

      if (result.status !== 0) {
        throw new Error(
          `expected apply CLI to succeed with an already-resolved checkout path\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      expect(result.stderr).not.toContain('choose only one Manifest source');
      expect(result.stdout).toContain('[manifest-plugins/apply] SOURCE_COMMIT=');
      expect(result.stdout).toContain(
        '[manifest-plugins/apply] all three files patched (or already no-op)',
      );
    } finally {
      cleanup(tmp);
    }
  });

  it('still rejects an explicit manifest URL when a positional checkout path is supplied', () => {
    const tmp = tempDir('manifest-apply-cli-explicit-url-');
    try {
      writePatchedManifestFixture(tmp);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MANIFEST_URL: '',
        MANIFEST_DIR: '',
        MANIFEST_CHECKOUT: '',
        MANIFEST_FORK: '',
        MVP_UI: '',
      };

      const result = run(
        process.execPath,
        [TSX_CLI, 'src/host/cli.ts', '--manifest-url', 'https://github.com/example/manifest.git', tmp],
        env,
        REPO_ROOT,
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('choose only one Manifest source');
    } finally {
      cleanup(tmp);
    }
  });
});

describe('pipeline/build-and-publish.sh integration', () => {
  it('--help exits 0 and prints usage text', () => {
    const result = run('bash', [BUILD_SCRIPT, '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    // The documented flag set must appear in --help output.
    expect(result.stdout).toMatch(/--manifest-url\b/);
    expect(result.stdout).toMatch(/--manifest-ref\b/);
    expect(result.stdout).toMatch(/--manifest-dir\b/);
    expect(result.stdout).toMatch(/--manifest-fork\b/);
    expect(result.stdout).toMatch(/--mvp\b/);
  });

  it('--mvp without an explicit source override exits 2', () => {
    // Pre-flight: ensure no MANIFEST_* / MVP_UI env vars leak in.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MANIFEST_PATH: '',
      MANIFEST_DIR: '',
      MANIFEST_REF: '',
      MANIFEST_FORK: '',
      MANIFEST_URL: '',
      MANIFEST_CHECKOUT: '',
      MVP_UI: '',
    };
    const result = run('bash', [BUILD_SCRIPT, '--mvp'], env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--mvp');
    expect(result.stderr).toContain('requires an explicit Manifest source');
  });

  it('defaults MANIFEST_URL to the official Manifest repository URL', () => {
    // Read the script source to assert the documented default.
    const script = readScript('build-and-publish.sh');
    expect(script).toMatch(
      /MANIFEST_URL="\$\{MANIFEST_URL:-https:\/\/github\.com\/mnfst\/manifest\.git\}"/,
    );
  });

  it('passes bash -n syntax check', () => {
    const result = run('bash', ['-n', BUILD_SCRIPT]);
    expect(result.status).toBe(0);
  });

  it('passes shellcheck -s bash', () => {
    // Skip if shellcheck isn't installed (e.g. minimal CI image).
    if (!existsSync('/c/ProgramData/chocolatey/bin/shellcheck')) {
      const probe = run('shellcheck', ['--version']);
      if (probe.status !== 0) {
        // eslint-disable-next-line no-console
        console.warn('shellcheck not on PATH — skipping shellcheck test');
        return;
      }
    }
    const result = run('shellcheck', ['-s', 'bash', BUILD_SCRIPT]);
    expect(result.status).toBe(0);
    if (result.status !== 0) {
      // Surface the lint errors so failures are debuggable.
      throw new Error(
        `shellcheck failed for build-and-publish.sh:\n${result.stdout}\n${result.stderr}`,
      );
    }
  });
});

describe('pipeline/e2e-test.sh integration', () => {
  it('passes bash -n syntax check', () => {
    const result = run('bash', ['-n', E2E_SCRIPT]);
    expect(result.status).toBe(0);
  });

  it('passes shellcheck -s bash', () => {
    if (!existsSync('/c/ProgramData/chocolatey/bin/shellcheck')) {
      const probe = run('shellcheck', ['--version']);
      if (probe.status !== 0) {
        // eslint-disable-next-line no-console
        console.warn('shellcheck not on PATH — skipping shellcheck test');
        return;
      }
    }
    const result = run('shellcheck', ['-s', 'bash', E2E_SCRIPT]);
    expect(result.status).toBe(0);
    if (result.status !== 0) {
      throw new Error(
        `shellcheck failed for e2e-test.sh:\n${result.stdout}\n${result.stderr}`,
      );
    }
  });

  it('MVP_UI=1 detects missing/broken jq and exits 4 (without requiring jq)', () => {
    // Stub a non-functional `jq` on PATH: `command -v jq` succeeds,
    // but `jq --version` fails with non-zero. The e2e script's MVP
    // preflight should detect this and exit 4 BEFORE attempting
    // docker, curl, or any real assertion.
    const tmp = tempDir('manifest-pipeline-mvp-jq-');
    try {
      const stubBin = join(tmp, 'bin');
      mkdirSync(stubBin, { recursive: true });
      // Write a stub jq that responds to `--version` with failure
      // (exit 127). This is the documented detection path: the
      // script probes functionality, not just presence.
      writeFileSync(
        join(stubBin, 'jq'),
        '#!/usr/bin/env bash\nexit 127\n',
        'utf-8',
      );

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MVP_UI: '1',
        PORT: '2099',
        // Force the script's preflight path: image inspect will
        // never be reached because the jq check aborts first.
        PATH: `${stubBin}:${process.env['PATH'] ?? ''}`,
      };
      const result = run('bash', [E2E_SCRIPT, 'whatever:latest'], env);
      expect(result.status).toBe(4);
      expect(result.stderr).toMatch(/MVP_UI=1.*jq/);
    } finally {
      cleanup(tmp);
    }
  });
});