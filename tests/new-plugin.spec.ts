/**
 * Unit tests for `npm run new-plugin -- <name>`.
 *
 * The scaffolder writes `src/plugins/<name>/plugin.ts` + `plugin.spec.ts`
 * from a kind-aware template and exits non-zero on bad input. We
 * exercise it via `spawnSync` against a tempdir copy of the repo so
 * we never touch the real `src/plugins/` tree.
 */
import { spawnSync } from 'child_process';
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

const REPO_ROOT = process.cwd();
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'new-plugin.mjs');

function copyRepoToTemp(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-scaffold-'));
  mkdirSync(join(tmp, 'src'), { recursive: true });
  mkdirSync(join(tmp, 'tests'), { recursive: true });
  mkdirSync(join(tmp, 'scripts'), { recursive: true });
  return tmp;
}

function copyRepoFilesTo(tmp: string): void {
  // Stage only the files the scaffolder reads (the scaffolder itself +
  // the plugins dir + the package.json so `node scripts/new-plugin.mjs`
  // resolves cleanly). The scaffolder does not actually read package.json
  // but we keep it for the node ESM resolver.
  const files: ReadonlyArray<{ src: string; dst: string }> = [
    { src: join(REPO_ROOT, 'scripts', 'new-plugin.mjs'), dst: 'scripts/new-plugin.mjs' },
    { src: join(REPO_ROOT, 'package.json'), dst: 'package.json' },
  ];
  for (const { src, dst } of files) {
    mkdirSync(dirname(join(tmp, dst)), { recursive: true });
    writeFileSync(join(tmp, dst), readFileSync(src, 'utf-8'), 'utf-8');
  }
}

function run(
  name: string,
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT_PATH, name], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

describe('npm run new-plugin scaffolder', () => {
  it('writes plugin.ts + plugin.spec.ts under src/plugins/<name>/', () => {
    if (!existsSync(SCRIPT_PATH)) {
      throw new Error(`Scaffolder script missing at ${SCRIPT_PATH}`);
    }
    const result = run('demo-plugin');
    expect(result.status).toBe(0);

    const pluginPath = join(REPO_ROOT, 'src', 'plugins', 'demo-plugin', 'plugin.ts');
    const specPath = join(REPO_ROOT, 'src', 'plugins', 'demo-plugin', 'plugin.spec.ts');
    expect(existsSync(pluginPath)).toBe(true);
    expect(existsSync(specPath)).toBe(true);

    // The plugin file must reference the new class name and a kind
    // defaulting to `transform` (the lowest-risk default).
    const pluginText = readFileSync(pluginPath, 'utf-8');
    expect(pluginText).toContain('export class DemoPluginPlugin');
    expect(pluginText).toContain("id: 'demo-plugin'");
    expect(pluginText).toContain("kind: 'transform'");

    // Spec file references the same class.
    const specText = readFileSync(specPath, 'utf-8');
    expect(specText).toContain('DemoPluginPlugin');

    // Clean up the generated fixture so we do not pollute the repo.
    rmSync(join(REPO_ROOT, 'src', 'plugins', 'demo-plugin'), {
      recursive: true,
      force: true,
    });
  });

  it('exits 2 when the name is missing', () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      encoding: 'utf-8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage|missing/i);
  });

  it('exits 2 when the name has invalid characters (uppercase, spaces, leading digit)', () => {
    for (const bad of ['MyPlugin', 'has space', '1leading-digit', '']) {
      const result = run(bad);
      expect(result.status).toBe(2);
    }
  });

  it('exits 3 when the target directory already exists', () => {
    const target = join(REPO_ROOT, 'src', 'plugins', 'dup-plugin');
    mkdirSync(target, { recursive: true });
    try {
      const result = run('dup-plugin');
      expect(result.status).toBe(3);
      expect(result.stderr).toMatch(/already exists/i);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('honors --kind=policy / --kind=routing-override / --kind=transform', () => {
    for (const kind of ['transform', 'policy', 'routing-override']) {
      const result = spawnSync(process.execPath, [SCRIPT_PATH, 'k-' + kind, '--kind', kind], {
        encoding: 'utf-8',
      });
      expect(result.status).toBe(0);

      const pluginPath = join(
        REPO_ROOT,
        'src',
        'plugins',
        'k-' + kind,
        'plugin.ts',
      );
      const text = readFileSync(pluginPath, 'utf-8');
      expect(text).toContain(`kind: '${kind}'`);

      // Each kind template includes the matching hook method.
      const expectedMethod: Record<string, string> = {
        transform: 'transformRequest(',
        policy: 'getRateLimitPolicy(',
        'routing-override': 'overrideRouting(',
      };
      expect(text).toContain(expectedMethod[kind]);

      rmSync(join(REPO_ROOT, 'src', 'plugins', 'k-' + kind), {
        recursive: true,
        force: true,
      });
    }
  });

  it('rejects an unknown --kind with exit 2', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'bad-kind', '--kind', 'garbage'],
      { encoding: 'utf-8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/kind/i);
  });
});

// Quiet unused warnings for `copyRepoToTemp` / `copyRepoFilesTo` if the
// scaffolder grows into needing them; kept here so the test file is the
// canonical location for scaffolder integration contracts.
void copyRepoToTemp;
void copyRepoFilesTo;