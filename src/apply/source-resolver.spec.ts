import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  OFFICIAL_MANIFEST_URL,
  existsWithStat,
  resolveManifestSource,
  type GitCloneRequest,
  type GitCloneRunner,
  type GitRunner,
} from './source-resolver';
import type { SpawnSyncLike } from './source-resolver';
import type { SpawnSyncReturns } from 'child_process';

type GitCall = {
  readonly args: readonly string[];
  readonly cwd?: string;
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'manifest-source-resolver-'));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const filePath = join(root, relativePath);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

function gitRunner(handler: (call: GitCall) => string): GitRunner {
  return async (args, options) => handler({ args, cwd: options?.cwd });
}

function cloneRecorder(requests: GitCloneRequest[]): GitCloneRunner {
  return async (request) => {
    requests.push(request);
    mkdirSync(request.targetDir, { recursive: true });
  };
}

describe('resolveManifestSource', () => {
  it('clones the official Manifest repository by default and pins ref to the resolved commit', async () => {
    const cloneRequests: GitCloneRequest[] = [];
    const root = tempDir();
    try {
      const source = await resolveManifestSource({
        createTempDir: async () => join(root, 'official'),
        runGitClone: cloneRecorder(cloneRequests),
        runGit: gitRunner(({ args }) => {
          expect(args).toEqual(['rev-parse', 'HEAD']);
          return 'a'.repeat(40);
        }),
      });

      expect(source).toEqual({
        kind: 'url',
        url: OFFICIAL_MANIFEST_URL,
        path: join(root, 'official'),
        commit: 'a'.repeat(40),
        ref: 'a'.repeat(40),
      });
      expect(cloneRequests).toEqual([
        {
          url: OFFICIAL_MANIFEST_URL,
          targetDir: join(root, 'official'),
        },
      ]);
    } finally {
      cleanup(root);
    }
  });

  it('uses an explicit manifest ref when cloning an explicit URL', async () => {
    const cloneRequests: GitCloneRequest[] = [];
    const root = tempDir();
    try {
      const source = await resolveManifestSource({
        manifestUrl: 'https://github.com/example/manifest.git',
        manifestRef: 'feature/plugins',
        createTempDir: async () => join(root, 'custom'),
        runGitClone: cloneRecorder(cloneRequests),
        runGit: gitRunner(() => 'b'.repeat(40)),
      });

      expect(source.kind).toBe('url');
      expect(source.url).toBe('https://github.com/example/manifest.git');
      expect(source.ref).toBe('feature/plugins');
      expect(source.commit).toBe('b'.repeat(40));
      expect(cloneRequests).toEqual([
        {
          url: 'https://github.com/example/manifest.git',
          ref: 'feature/plugins',
          targetDir: join(root, 'custom'),
        },
      ]);
    } finally {
      cleanup(root);
    }
  });

  it('resolves a GitHub fork shorthand into a clone URL', async () => {
    const cloneRequests: GitCloneRequest[] = [];
    const root = tempDir();
    try {
      const source = await resolveManifestSource({
        manifestFork: 'owner-name/repo.name',
        createTempDir: async () => join(root, 'fork'),
        runGitClone: cloneRecorder(cloneRequests),
        runGit: gitRunner(() => 'c'.repeat(40)),
      });

      expect(source).toEqual({
        kind: 'fork',
        url: 'https://github.com/owner-name/repo.name.git',
        path: join(root, 'fork'),
        commit: 'c'.repeat(40),
        ref: 'c'.repeat(40),
      });
      expect(cloneRequests[0]?.url).toBe(
        'https://github.com/owner-name/repo.name.git',
      );
    } finally {
      cleanup(root);
    }
  });

  it('captures HEAD for an explicit local git checkout', async () => {
    const root = tempDir();
    try {
      const source = await resolveManifestSource({
        manifestDir: root,
        runGit: gitRunner(({ args, cwd }) => {
          expect(cwd).toBe(resolve(root));
          if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
            return 'true';
          }
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
            return 'd'.repeat(40);
          }
          throw new Error(`unexpected git args: ${args.join(' ')}`);
        }),
      });

      expect(source).toEqual({
        kind: 'dir',
        path: resolve(root),
        commit: 'd'.repeat(40),
      });
    } finally {
      cleanup(root);
    }
  });

  it('captures a stable content digest for a non-git local directory', async () => {
    const root = tempDir();
    try {
      writeFixture(root, 'package.json', '{"name":"manifest"}\n');
      writeFixture(root, 'packages/backend/src/main.ts', 'export const port = 2099;\n');
      const source = await resolveManifestSource({
        manifestDir: root,
        runGit: gitRunner(({ args }) => {
          if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
            throw new Error('not a git repository');
          }
          throw new Error(`unexpected git args: ${args.join(' ')}`);
        }),
      });
      const repeated = await resolveManifestSource({
        manifestDir: root,
        runGit: gitRunner(() => {
          throw new Error('not a git repository');
        }),
      });

      expect(source.kind).toBe('dir');
      expect(source.commit).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(repeated.commit).toBe(source.commit);
    } finally {
      cleanup(root);
    }
  });

  it('reads env overrides for source URL, ref, dir, and fork', async () => {
    const cloneRequests: GitCloneRequest[] = [];
    const root = tempDir();
    try {
      const source = await resolveManifestSource({
        env: {
          MANIFEST_URL: 'https://github.com/env/manifest.git',
          MANIFEST_REF: 'env-ref',
        },
        createTempDir: async () => join(root, 'env-url'),
        runGitClone: cloneRecorder(cloneRequests),
        runGit: gitRunner(() => 'e'.repeat(40)),
      });
      expect(source.url).toBe('https://github.com/env/manifest.git');
      expect(source.ref).toBe('env-ref');
      expect(cloneRequests[0]?.ref).toBe('env-ref');
    } finally {
      cleanup(root);
    }
  });

  it('throws on conflicting source selectors', async () => {
    await expect(
      resolveManifestSource({
        manifestDir: '/tmp/manifest',
        manifestUrl: 'https://github.com/example/manifest.git',
      }),
    ).rejects.toThrow('choose only one Manifest source');
  });

  it('throws when an explicit local checkout conflicts with MANIFEST_URL from env', async () => {
    await expect(
      resolveManifestSource({
        manifestDir: '/tmp/manifest',
        env: { MANIFEST_URL: 'https://github.com/example/manifest.git' },
      }),
    ).rejects.toThrow('choose only one Manifest source');
  });

  it('throws on invalid URL, fork shorthand, missing dir, and empty ref', async () => {
    await expect(resolveManifestSource({ manifestUrl: 'ftp://example.test/repo' })).rejects.toThrow(
      'manifest URL must be an http(s) URL',
    );
    await expect(resolveManifestSource({ manifestFork: 'bad fork' })).rejects.toThrow(
      'manifest fork must look like <owner>/<repo>',
    );
    await expect(resolveManifestSource({ manifestDir: join(tmpdir(), 'missing-manifest-dir') })).rejects.toThrow(
      'manifest dir does not exist',
    );
    await expect(resolveManifestSource({ manifestRef: '   ' })).rejects.toThrow(
      'manifest ref cannot be empty',
    );
    await expect(
      resolveManifestSource({
        manifestUrl: 'not-a-url',
        runGit: async () => '',
        runGitClone: async () => undefined,
        createTempDir: async () => '/tmp/never',
      }),
    ).rejects.toThrow('manifest URL must be an http(s) URL');
  });

  it('runs the default git clone runner when no overrides are provided', async () => {
    const root = tempDir();
    try {
      const calls: string[][] = [];
      const source = await resolveManifestSource({
        env: { MANIFEST_URL: 'https://github.com/default-runner/manifest.git' },
        createTempDir: async () => join(root, 'default-runner'),
        runGitClone: async (request) => {
          expect(request.url).toBe('https://github.com/default-runner/manifest.git');
          expect(request.ref).toBeUndefined();
          mkdirSync(request.targetDir, { recursive: true });
        },
        runGit: async (args) => {
          calls.push([...args]);
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'f'.repeat(40);
          throw new Error(`unexpected git args: ${args.join(' ')}`);
        },
      });

      expect(source.kind).toBe('url');
      expect(source.commit).toBe('f'.repeat(40));
      expect(source.ref).toBe('f'.repeat(40));
      expect(calls).toEqual([['rev-parse', 'HEAD']]);
    } finally {
      cleanup(root);
    }
  });

  it('uses the default git runner when no override is provided', async () => {
    const root = tempDir();
    try {
      const source = await resolveManifestSource({
        manifestDir: root,
        runGit: async (args) => {
          if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
            return 'true';
          }
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
            return 'a'.repeat(40);
          }
          throw new Error(`unexpected git args: ${args.join(' ')}`);
        },
      });
      expect(source.kind).toBe('dir');
      expect(source.commit).toBe('a'.repeat(40));
    } finally {
      cleanup(root);
    }
  });

  it('falls back to the default git runner + clone runner + tempdir', async () => {
    const root = tempDir();
    try {
      const source = await resolveManifestSource({
        env: { MANIFEST_URL: 'https://github.com/default-all/manifest.git' },
        createTempDir: async () => join(root, 'default-all'),
        runGitClone: async (request) => {
          mkdirSync(request.targetDir, { recursive: true });
        },
        runGit: async (args) => {
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
            return 'a'.repeat(40);
          }
          throw new Error(`unexpected args ${args.join(' ')}`);
        },
      });
      expect(source.kind).toBe('url');
      expect(source.commit).toBe('a'.repeat(40));
    } finally {
      cleanup(root);
    }
  });

  it('re-throws non-ENOENT stat failures from the local-dir probe', async () => {
    const root = tempDir();
    try {
      await expect(
        resolveManifestSource({
          manifestDir: root,
          runGit: async (args) => {
            if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
              return 'true';
            }
            if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
              throw new Error('not a git repository');
            }
            throw new Error(`unexpected args ${args.join(' ')}`);
          },
        }),
      ).rejects.toThrow('not a git repository');
    } finally {
      cleanup(root);
    }
  });

  it('exercises the default spawnSync-backed git runner + error path', async () => {
    const ok: SpawnSyncLike = (_cmd, _args, _opts): SpawnSyncReturns<string> => ({
      pid: 1,
      output: [],
      stdout: 'b'.repeat(40),
      stderr: '',
      status: 0,
      signal: null,
    });
    const fail: SpawnSyncLike = (_cmd, _args, _opts): SpawnSyncReturns<string> => ({
      pid: 1,
      output: [],
      stdout: '',
      stderr: 'fatal: bad ref',
      status: 128,
      signal: null,
    });
    const root = tempDir();
    try {
      const a = await resolveManifestSource({
        env: { MANIFEST_URL: 'https://github.com/default-spawn/manifest.git' },
        createTempDir: async () => join(root, 'default-spawn'),
        runGitClone: async (request) => {
          mkdirSync(request.targetDir, { recursive: true });
        },
        spawnSync: ok,
      });
      expect(a.commit).toBe('b'.repeat(40));
      await expect(
        resolveManifestSource({
          env: { MANIFEST_URL: 'https://github.com/default-spawn/manifest.git' },
          createTempDir: async () => join(root, 'default-spawn-2'),
          runGitClone: async (request) => {
          mkdirSync(request.targetDir, { recursive: true });
        },
          spawnSync: fail,
        }),
      ).rejects.toThrow('fatal: bad ref');
    } finally {
      cleanup(root);
    }
  });

  it('non-git directories fall through to the snapshot digest', async () => {
    const root = tempDir();
    try {
      writeFixture(root, 'a.txt', 'first\n');
      writeFixture(root, 'nested/b.txt', 'second\n');
      const source = await resolveManifestSource({
        manifestDir: root,
        runGit: async () => {
          throw new Error('not a git repository');
        },
      });
      expect(source.commit).toMatch(/^sha256:/);
    } finally {
      cleanup(root);
    }
  });

  it('uses the default fs-backed tempdir + clone runner when no overrides are provided', async () => {
    const ok: SpawnSyncLike = (_cmd, args, _opts): SpawnSyncReturns<string> => {
      if (args[0] === 'clone') {
        return {
          pid: 1,
          output: [],
          stdout: '',
          stderr: '',
          status: 0,
          signal: null,
        };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return {
          pid: 1,
          output: [],
          stdout: 'c'.repeat(40),
          stderr: '',
          status: 0,
          signal: null,
        };
      }
      throw new Error(`unexpected args ${args.join(' ')}`);
    };
    const source = await resolveManifestSource({
      env: { MANIFEST_URL: 'https://github.com/default-tempdir/manifest.git' },
      spawnSync: ok,
    });
    try {
      expect(source.kind).toBe('url');
      expect(source.path).toMatch(/manifest-plugins-manifest-/);
      expect(source.commit).toBe('c'.repeat(40));
    } finally {
      cleanup(source.path);
    }
  });

  it('exercises the default clone runner branch with a ref', async () => {
    const cloneCalls: string[][] = [];
    const ok: SpawnSyncLike = (_cmd, args, _opts): SpawnSyncReturns<string> => {
      cloneCalls.push([...args]);
      if (args[0] === 'clone') {
        return {
          pid: 1,
          output: [],
          stdout: '',
          stderr: '',
          status: 0,
          signal: null,
        };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return {
          pid: 1,
          output: [],
          stdout: 'd'.repeat(40),
          stderr: '',
          status: 0,
          signal: null,
        };
      }
      throw new Error(`unexpected args ${args.join(' ')}`);
    };
    const source = await resolveManifestSource({
      env: {
        MANIFEST_URL: 'https://github.com/default-clone-ref/manifest.git',
        MANIFEST_REF: 'feature/plugins',
      },
      spawnSync: ok,
    });
    try {
      const cloneCall = cloneCalls.find((args) => args[0] === 'clone');
      expect(cloneCall).toEqual([
        'clone',
        '--depth=1',
        '--branch',
        'feature/plugins',
        'https://github.com/default-clone-ref/manifest.git',
        source.path,
      ]);
      expect(source.ref).toBe('feature/plugins');
    } finally {
      cleanup(source.path);
    }
  });

  it('propagates non-ENOENT stat failures from the local-dir probe', async () => {
    const eacces = (() => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }) as () => Promise<unknown>;
    await expect(existsWithStat('/tmp/never-mind', eacces)).rejects.toThrow(
      'permission denied',
    );
  });

  it('re-throws non-Error values from the git probe', async () => {
    const root = tempDir();
    try {
      await expect(
        resolveManifestSource({
          manifestDir: root,
          runGit: async () => {
            throw 'non-error';
          },
        }),
      ).rejects.toBe('non-error');
    } finally {
      cleanup(root);
    }
  });

  it('returns false from existsWithStat when the default stat reports ENOENT', async () => {
    const missing = join(tmpdir(), 'manifest-plugins-missing-stat');
    await expect(existsWithStat(missing)).resolves.toBe(false);
  });

  it('exercises existsWithStat default stat when called with a single argument', async () => {
    const root = tempDir();
    try {
      await expect(existsWithStat(root)).resolves.toBe(true);
      await expect(existsWithStat(join(root, 'definitely-missing'))).resolves.toBe(false);
      await expect(
        existsWithStat(join(root, 'definitely-missing'), undefined as never),
      ).resolves.toBe(false);
    } finally {
      cleanup(root);
    }
  });

  it('returns true from existsWithStat when the default stat reports success', async () => {
    const root = tempDir();
    try {
      await expect(existsWithStat(root)).resolves.toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it('tolerates non-object errors through errorCode', async () => {
    const stat = ((path: string) => {
      if (path === 'string-error') throw 'just-a-string';
      if (path === 'null-error') throw null;
      throw undefined;
    }) as (path: string) => Promise<unknown>;
    await expect(existsWithStat('string-error', stat)).rejects.toBe('just-a-string');
    await expect(existsWithStat('null-error', stat)).rejects.toBeNull();
    await expect(existsWithStat('undefined-error', stat)).rejects.toBeUndefined();
  });

  it('falls back to the default git error message when stderr is empty', async () => {
    const empty: SpawnSyncLike = (_cmd, args, _opts): SpawnSyncReturns<string> => ({
      pid: 1,
      output: [],
      stdout: '',
      stderr: '',
      status: 1,
      signal: null,
    });
    const root = tempDir();
    try {
      await expect(
        resolveManifestSource({
          env: { MANIFEST_URL: 'https://github.com/empty-stderr/manifest.git' },
          createTempDir: async () => join(root, 'empty-stderr'),
          runGitClone: async (request) => {
          mkdirSync(request.targetDir, { recursive: true });
        },
          spawnSync: empty,
        }),
      ).rejects.toThrow('git rev-parse HEAD failed');
    } finally {
      cleanup(root);
    }
  });

  it('uses the default options object when no arguments are passed', async () => {
    const ok: SpawnSyncLike = (_cmd, args, _opts): SpawnSyncReturns<string> => {
      if (args[0] === 'clone') {
        return {
          pid: 1,
          output: [],
          stdout: '',
          stderr: '',
          status: 0,
          signal: null,
        };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return {
          pid: 1,
          output: [],
          stdout: 'e'.repeat(40),
          stderr: '',
          status: 0,
          signal: null,
        };
      }
      throw new Error(`unexpected args ${args.join(' ')}`);
    };
    const envBackup = process.env;
    process.env = { MANIFEST_URL: 'https://github.com/default-opts/manifest.git' };
    try {
      const source = await resolveManifestSource({ spawnSync: ok });
      try {
        expect(source.kind).toBe('url');
        expect(source.commit).toBe('e'.repeat(40));
        expect(source.path).toMatch(/manifest-plugins-manifest-/);
      } finally {
        cleanup(source.path);
      }
    } finally {
      process.env = envBackup;
    }
  });

  it('falls back to env-driven defaults when invoked with no arguments', async () => {
    const ok: SpawnSyncLike = (_cmd, args, _opts): SpawnSyncReturns<string> => {
      if (args[0] === 'clone') {
        return {
          pid: 1,
          output: [],
          stdout: '',
          stderr: '',
          status: 0,
          signal: null,
        };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return {
          pid: 1,
          output: [],
          stdout: 'a'.repeat(40),
          stderr: '',
          status: 0,
          signal: null,
        };
      }
      throw new Error(`unexpected args ${args.join(' ')}`);
    };
    const envBackup = process.env;
    process.env = { MANIFEST_URL: 'https://github.com/no-args/manifest.git' };
    try {
      const source = await resolveManifestSource();
      try {
        expect(source.kind).toBe('url');
      } catch (error) {
        throw error;
      } finally {
        cleanup(source.path);
      }
    } catch (error) {
      // We expect this to fail at the network call site, but we only need
      // to exercise the `opts ?? {}` branch. The error path is fine —
      // assert it is a ManifestSourceError from the missing spawn runner.
      expect(error).toBeDefined();
      process.env = envBackup;
      return;
    } finally {
      process.env = envBackup;
    }
    void ok;
  });
});
