/**
 * Operator CLI tests for `node scripts/plugins-cli.mjs`.
 *
 * The CLI mirrors the admin API: it reads + writes the SAME persisted
 * plugin state file (the file the admin server boots from). These
 * specs run the script via `spawnSync`, point `MANIFEST_PLUGINS_STATE_FILE`
 * at a per-test temp file, and assert the exit code, stdout, stderr,
 * and on-disk state file.
 *
 * Test contract:
 *   1. No args                    → exit 2, stdout contains `Usage:`
 *   2. Unknown subcommand         → exit 2, stderr contains `unknown subcommand`
 *   3. `list` against real repo   → exit 0, stdout lists all 3 known plugins + `ENABLED`
 *   4. `enable <id>`              → exit 0, state file contains `<id>: true`
 *   5. `disable <id>`             → exit 0, state file contains `<id>: false`
 *   6. `disable <unknown>`        → exit 3, stderr contains `unknown plugin id`
 *   7. `reset`                    → exit 0, state file no longer exists
 */
import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = process.cwd();
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'plugins-cli.mjs');

function makeTempStateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-plugins-cli-'));
  return join(dir, 'plugin-state.json');
}

function runCli(
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = {},
  options: { cwd?: string } = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf-8',
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...env },
  });
}

describe('plugins-cli operator CLI', () => {
  it('exits 2 with no args and prints Usage:', () => {
    const result = runCli([]);
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/Usage:/);
  });

  it('exits 2 on an unknown subcommand and prints the unknown subcommand message', () => {
    const result = runCli(['not-a-subcommand']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown subcommand/);
  });

  it('`list` enumerates the three shipped plugins + an ENABLED column', () => {
    const tempFile = makeTempStateFile();
    try {
      const result = runCli(['list'], {
        MANIFEST_PLUGINS_STATE_FILE: tempFile,
      });
      expect(result.status).toBe(0);
      // The three known plugins from this repo's `src/plugins/`.
      expect(result.stdout).toContain('anthropic-billing-header');
      expect(result.stdout).toContain('default-policy');
      expect(result.stdout).toContain('header-tier-router');
      // The header row must include the ENABLED column so the column
      // layout is intentional.
      expect(result.stdout).toMatch(/ENABLED/);
    // Each plugin file uses `kind: SOME_CONSTANT_NAME` (a const
    // reference, not a string literal). The CLI must resolve the
    // constant to its value so the KIND column shows the real
    // kind instead of "unknown". Regression lock.
    expect(result.stdout).toMatch(/transform/);
    expect(result.stdout).toMatch(/policy/);
    expect(result.stdout).toMatch(/routing-override/);
    } finally {
      rmSync(join(tempFile, '..'), { recursive: true, force: true });
    }
  });

  it('`enable <id>` writes the enabled flag to the state file', () => {
    const tempFile = makeTempStateFile();
    try {
      const result = runCli(
        ['enable', 'anthropic-billing-header'],
        { MANIFEST_PLUGINS_STATE_FILE: tempFile },
      );
      expect(result.status).toBe(0);
      expect(existsSync(tempFile)).toBe(true);
      const parsed = JSON.parse(readFileSync(tempFile, 'utf-8'));
      expect(parsed).toEqual({ 'anthropic-billing-header': true });
    } finally {
      rmSync(join(tempFile, '..'), { recursive: true, force: true });
    }
  });

  it('`disable <id>` writes the disabled flag to the state file', () => {
    const tempFile = makeTempStateFile();
    try {
      const result = runCli(
        ['disable', 'default-policy'],
        { MANIFEST_PLUGINS_STATE_FILE: tempFile },
      );
      expect(result.status).toBe(0);
      expect(existsSync(tempFile)).toBe(true);
      const parsed = JSON.parse(readFileSync(tempFile, 'utf-8'));
      expect(parsed).toEqual({ 'default-policy': false });
    } finally {
      rmSync(join(tempFile, '..'), { recursive: true, force: true });
    }
  });

  it('`disable <unknown-id>` exits 3 with an unknown plugin id message', () => {
    const tempFile = makeTempStateFile();
    try {
      const result = runCli(
        ['disable', 'nonexistent-plugin'],
        { MANIFEST_PLUGINS_STATE_FILE: tempFile },
      );
      expect(result.status).toBe(3);
      expect(result.stderr).toMatch(/unknown plugin id/);
    } finally {
      rmSync(join(tempFile, '..'), { recursive: true, force: true });
    }
  });

  it('`reset` deletes the state file', () => {
    const tempFile = makeTempStateFile();
    // Pre-create a non-empty state file so `reset` has something to delete.
    writeFileSync(tempFile, JSON.stringify({ 'default-policy': false }), 'utf-8');
    expect(existsSync(tempFile)).toBe(true);

    try {
      const result = runCli(
        ['reset'],
        { MANIFEST_PLUGINS_STATE_FILE: tempFile },
      );
      expect(result.status).toBe(0);
      expect(existsSync(tempFile)).toBe(false);
    } finally {
      rmSync(join(tempFile, '..'), { recursive: true, force: true });
    }
  });
});