/**
 * Integration test for the plugin-host patcher.
 *
 * The test:
 *   1. Reads upstream/main's three target files via `git show`.
 *   2. Copies them into a tempdir mirroring the manifest layout.
 *   3. Runs `applyAll()` against the tempdir.
 *   4. Asserts each file has its post-patch symbol + the upstream anchor is
 *      gone (replaced by the helper + call site).
 *   5. Runs the patcher a second time and asserts it is a no-op.
 *   6. Runs `tsc --noEmit` against the patched files (via the backend
 *      tsconfig) to ensure the inserted TS compiles in context.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import {
  applyAll,
  applyProviderClientHost,
  applyProxyRateLimiterHost,
  applyProxyServiceHost,
  DEFAULT_MANIFEST_FILES,
  type ApplyResult,
} from '../src/host/apply';

const MANIFEST_REPO = process.env['MANIFEST_REPO'] ?? '../manifest';
const FILES = DEFAULT_MANIFEST_FILES;

interface UpstreamFiles {
  providerClient: string;
  proxyRateLimiter: string;
  proxyService: string;
}

function readUpstream(file: string): string {
  const result = spawnSync(
    'git',
    ['-C', MANIFEST_REPO, 'show', `upstream/main:${file}`],
    { encoding: 'utf-8' },
  );
  if (result.status !== 0 || result.stderr) {
    const stderr = result.stderr || '(no stderr)';
    if (
      stderr.includes('unknown revision') ||
      stderr.includes('does not exist') ||
      stderr.includes('not a git repository')
    ) {
      throw new Error(
        `failed to read upstream ${file} at ${MANIFEST_REPO}: ${stderr.trim()}\n` +
          `  Set MANIFEST_REPO env var to the Manifest checkout path (must have an upstream/main ref).`,
      );
    }
    throw new Error(`failed to read upstream ${file}: ${stderr}`);
  }
  return result.stdout;
}

function readAllUpstream(): UpstreamFiles {
  return {
    providerClient: readUpstream(FILES.providerClient),
    proxyRateLimiter: readUpstream(FILES.proxyRateLimiter),
    proxyService: readUpstream(FILES.proxyService),
  };
}

interface TempFiles {
  /** Absolute path to the manifest root (the tempdir). */
  root: string;
  providerClient: string;
  proxyRateLimiter: string;
  proxyService: string;
  cleanup: () => void;
}

function withTempManifest(
  fn: (files: TempFiles) => Promise<void> | void,
): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-apply-'));
  const upstream = readAllUpstream();

  const writeFile = (relPath: string, content: string) => {
    const fullPath = join(tmp, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  };
  writeFile(FILES.providerClient, upstream.providerClient);
  writeFile(FILES.proxyRateLimiter, upstream.proxyRateLimiter);
  writeFile(FILES.proxyService, upstream.proxyService);

  const files: TempFiles = {
    root: tmp,
    providerClient: join(tmp, FILES.providerClient),
    proxyRateLimiter: join(tmp, FILES.proxyRateLimiter),
    proxyService: join(tmp, FILES.proxyService),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
  return Promise.resolve(fn(files)).finally(files.cleanup);
}

function expectStatus(
  label: string,
  result: ApplyResult,
  expected: 'applied' | 'noop' | 'upstream-drift',
): void {
  if (result.status !== expected) {
    throw new Error(
      `expected ${label}.status === '${expected}', got '${result.status}'` +
        (result.reason ? `: ${result.reason}` : ''),
    );
  }
}

describe('applyAll (three-file patcher)', () => {
  it('patches all three files against upstream shapes', async () => {
    await withTempManifest(async (files) => {
      const all = await applyAll(files.root);

      expectStatus('providerClient', all.providerClient, 'applied');
      expectStatus('proxyRateLimiter', all.proxyRateLimiter, 'applied');
      expectStatus('proxyService', all.proxyService, 'applied');
      expect(all.fullyApplied).toBe(true);
      expect(all.hasDrift).toBe(false);

      // Verify post-patch state in each file.
      const providerClient = readFileSync(files.providerClient, 'utf-8');
      expect(providerClient).toContain('function applyRequestTransformPlugins(');
      expect(providerClient).toContain('const transformed = applyRequestTransformPlugins(');

      const rateLimiter = readFileSync(files.proxyRateLimiter, 'utf-8');
      expect(rateLimiter).toContain('function getResolvedConcurrencyMax(');
      expect(rateLimiter).not.toContain('const CONCURRENCY_MAX = 10;');
      expect(rateLimiter).toContain('const CONCURRENCY_MAX = getResolvedConcurrencyMax();');

      const proxyService = readFileSync(files.proxyService, 'utf-8');
      expect(proxyService).toContain('function getResolvedMaxMessagesPerRequest(');
      expect(proxyService).toContain('this.maxMessagesPerRequest = getResolvedMaxMessagesPerRequest(this.config);');
    });
  });

  it('is idempotent — second run on the same tempdir reports noop for all three files', async () => {
    await withTempManifest(async (files) => {
      const first = await applyAll(files.root);
      expect(first.fullyApplied).toBe(true);

      const second = await applyAll(files.root);
      expectStatus('providerClient', second.providerClient, 'noop');
      expectStatus('proxyRateLimiter', second.proxyRateLimiter, 'noop');
      expectStatus('proxyService', second.proxyService, 'noop');
      expect(second.fullyApplied).toBe(true);
      expect(second.hasDrift).toBe(false);
    });
  });

  it('reports upstream-drift when one file is mutated', async () => {
    await withTempManifest(async (files) => {
      // First apply succeeds.
      const first = await applyAll(files.root);
      expect(first.fullyApplied).toBe(true);

      // Re-apply succeeds (noop).
      const second = await applyAll(files.root);
      expect(second.fullyApplied).toBe(true);

      // Overwrite provider-client.ts with garbage that lacks the
      // post-patch symbol AND lacks the upstream anchor. The third
      // apply should report drift on provider-client.ts only.
      writeFileSync(
        files.providerClient,
        '// upstream restructured — anchors are gone\n',
        'utf-8',
      );
      const third = await applyAll(files.root);
      expectStatus('providerClient', third.providerClient, 'upstream-drift');
      expectStatus('proxyRateLimiter', third.proxyRateLimiter, 'noop');
      expectStatus('proxyService', third.proxyService, 'noop');
      expect(third.fullyApplied).toBe(false);
      expect(third.hasDrift).toBe(true);
    });
  });

  it('reports upstream-drift when the helper-marker is missing (old-text still present)', async () => {
    // Construct a pathological upstream state: the constructor body
    // (the old-text anchor) is still present, but the
    // `import { parseMaxMessagesPerRequest } from './message-limit'`
    // import (the helper-marker anchor) has been removed by an upstream
    // refactor. The patcher should report drift on the helper-marker
    // branch (line 119 in apply.ts), not the old-text branch.
    await withTempManifest(async (files) => {
      const upstream = readFileSync(files.proxyService, 'utf-8');
      const stripped = upstream.replace(
        "import { parseMaxMessagesPerRequest } from './message-limit';\n",
        '',
      );
      writeFileSync(files.proxyService, stripped, 'utf-8');

      const result = await applyProxyServiceHost(files.proxyService);
      expectStatus('applyProxyServiceHost', result, 'upstream-drift');
      if (result.status === 'upstream-drift') {
        expect(result.reason).toContain('helper insertion marker');
      }
    });
  });

  it('dryRun: reports applied but does not modify the file', async () => {
    await withTempManifest(async (files) => {
      const before = {
        providerClient: readFileSync(files.providerClient, 'utf-8'),
        proxyRateLimiter: readFileSync(files.proxyRateLimiter, 'utf-8'),
        proxyService: readFileSync(files.proxyService, 'utf-8'),
      };

      const all = await applyAll(files.root, undefined, { dryRun: true });
      expect(all.fullyApplied).toBe(true);

      const after = {
        providerClient: readFileSync(files.providerClient, 'utf-8'),
        proxyRateLimiter: readFileSync(files.proxyRateLimiter, 'utf-8'),
        proxyService: readFileSync(files.proxyService, 'utf-8'),
      };
      expect(after.providerClient).toBe(before.providerClient);
      expect(after.proxyRateLimiter).toBe(before.proxyRateLimiter);
      expect(after.proxyService).toBe(before.proxyService);
    });
  });
});

describe('per-file wrappers', () => {
  it('applyProviderClientHost patches a single provider-client.ts in isolation', async () => {
    await withTempManifest(async (files) => {
      const result = await applyProviderClientHost(files.providerClient);
      expectStatus('applyProviderClientHost', result, 'applied');
      const patched = readFileSync(files.providerClient, 'utf-8');
      expect(patched).toContain('function applyRequestTransformPlugins(');
    });
  });

  it('applyProxyRateLimiterHost patches a single proxy-rate-limiter.ts in isolation', async () => {
    await withTempManifest(async (files) => {
      const result = await applyProxyRateLimiterHost(files.proxyRateLimiter);
      expectStatus('applyProxyRateLimiterHost', result, 'applied');
      const patched = readFileSync(files.proxyRateLimiter, 'utf-8');
      expect(patched).toContain('function getResolvedConcurrencyMax(');
    });
  });

  it('applyProxyServiceHost patches a single proxy.service.ts in isolation', async () => {
    await withTempManifest(async (files) => {
      const result = await applyProxyServiceHost(files.proxyService);
      expectStatus('applyProxyServiceHost', result, 'applied');
      const patched = readFileSync(files.proxyService, 'utf-8');
      expect(patched).toContain('function getResolvedMaxMessagesPerRequest(');
    });
  });

  it('per-file wrappers accept a no-argument call (default options)', async () => {
    // Covers the `options: ApplyOptions = {}` default parameter in applyPatch.
    await withTempManifest(async (files) => {
      // Fresh upstream content — no dryRun flag, so file IS written.
      const r1 = await applyProviderClientHost(files.providerClient);
      const r2 = await applyProxyRateLimiterHost(files.proxyRateLimiter);
      const r3 = await applyProxyServiceHost(files.proxyService);
      expectStatus('providerClient', r1, 'applied');
      expectStatus('proxyRateLimiter', r2, 'applied');
      expectStatus('proxyService', r3, 'applied');
    });
  });
});

describe('applyPatch direct invocation (covers internal defaults)', () => {
  it('uses default empty options when called with no second argument', async () => {
    // Covers the `options: ApplyOptions = {}` default parameter on
    // applyPatch itself. The per-file wrappers always pass an explicit
    // options object, so only a direct call hits the default branch.
    const { applyPatch, DEFAULT_MANIFEST_FILES } = await import(
      '../src/host/apply'
    );
    await withTempManifest(async (files) => {
      const result = await applyPatch({
        filePath: files.providerClient,
        postPatchSymbol: 'function applyRequestTransformPlugins(',
        oldText: require('../src/host/snippet').RETURN_OLD,
        newText: require('../src/host/snippet').RETURN_NEW,
        helperMarkerOld: require('../src/host/snippet').HELPER_MARKER_OLD,
        helperMarkerNew: require('../src/host/snippet').buildHelperMarkerNew(),
      });
      expectStatus('applyPatch direct', result, 'applied');
    });
    // Reference DEFAULT_MANIFEST_FILES to keep it in the type graph (no-op assertion).
    expect(DEFAULT_MANIFEST_FILES).toBeDefined();
  });
});

describe('tsc check on patched files', () => {
  it('all three files pass tsc --noEmit against the backend tsconfig', async () => {
    await withTempManifest(async (files) => {
      const all = await applyAll(files.root);
      expect(all.fullyApplied).toBe(true);

      // Place the patched files in the real backend tree so the
      // tsconfig can find them, then run tsc. Restore on exit.
      const realPaths = {
        providerClient: join(
          MANIFEST_REPO,
          'packages/backend/src/routing/proxy/provider-client.ts',
        ),
        proxyRateLimiter: join(
          MANIFEST_REPO,
          'packages/backend/src/routing/proxy/proxy-rate-limiter.ts',
        ),
        proxyService: join(
          MANIFEST_REPO,
          'packages/backend/src/routing/proxy/proxy.service.ts',
        ),
      };
      const backups = {
        providerClient: readFileSync(realPaths.providerClient),
        proxyRateLimiter: readFileSync(realPaths.proxyRateLimiter),
        proxyService: readFileSync(realPaths.proxyService),
      };
      writeFileSync(
        realPaths.providerClient,
        readFileSync(files.providerClient),
      );
      writeFileSync(
        realPaths.proxyRateLimiter,
        readFileSync(files.proxyRateLimiter),
      );
      writeFileSync(
        realPaths.proxyService,
        readFileSync(files.proxyService),
      );

      try {
        const tsc = spawnSync(
          'npx',
          ['tsc', '--noEmit', '-p', 'packages/backend/tsconfig.json'],
          { cwd: MANIFEST_REPO, encoding: 'utf-8' },
        );
        const out = ((tsc.stdout ?? '') + (tsc.stderr ?? '')).split('\n');
        const watched = [
          'provider-client',
          'applyRequestTransformPlugins',
          'proxy-rate-limiter',
          'getResolvedConcurrencyMax',
          'proxy.service',
          'getResolvedMaxMessagesPerRequest',
        ];
        const errors = out.filter((line) =>
          watched.some((s) => line.includes(s)),
        );
        if (errors.length > 0) {
          expect(errors.join('\n')).toBe('');
        }
        // tsc exit may be non-zero from unrelated pre-existing errors
        // (e.g. missing cacheable module). We only care that no error
        // points at the patched lines.
      } finally {
        writeFileSync(realPaths.providerClient, backups.providerClient);
        writeFileSync(realPaths.proxyRateLimiter, backups.proxyRateLimiter);
        writeFileSync(realPaths.proxyService, backups.proxyService);
      }
    });
  });
});