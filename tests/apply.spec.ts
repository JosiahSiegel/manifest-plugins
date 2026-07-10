/**
 * Integration test for the plugin-host patcher.
 *
 * The test:
 *   1. Reads upstream/main's target files via `git show`.
 *   2. Copies them into a tempdir mirroring the manifest layout.
 *   3. Runs `applyAll()` (provider-client + rate-limiter) and
 *      `applyAllFive()` (provider-client + rate-limiter + admin-mount +
 *      model-list-override) against the tempdir.
 *   4. Asserts each file has its post-patch symbol + the upstream anchor is
 *      gone (replaced by the helper + call site).
 *   5. Runs the patcher a second time and asserts it is a no-op.
 *   6. Runs `tsc --noEmit` against the patched files (via the backend
 *      tsconfig) to ensure the inserted TS compiles in context.
 *
 * Wave-history note: prior to the `chore/retire-obsolete-plugins`
 * refactor (2026-07-10), this file also patched `proxy.service.ts`
 * via `applyProxyRoutingOverrideHost`. Upstream PR #2468 subsumed
 * the routing-override behavior, so that patcher is gone and
 * `proxy.service.ts` is no longer read here.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import {
  applyAll,
  applyAllFive,
  applyModelListOverrideHost,
  applyProviderClientHost,
  applyProxyRateLimiterHost,
  DEFAULT_MANIFEST_FILES,
  type ApplyResult,
  type ManifestFileSpec,
} from '../src/host/apply';
import {
  buildHelperMarkerNew,
  HELPER_MARKER_OLD,
  RETURN_NEW,
  RETURN_OLD,
} from '../src/host/snippet';

const MANIFEST_REPO = process.env['MANIFEST_REPO'] ?? '../manifest';
const FILES = DEFAULT_MANIFEST_FILES;

interface UpstreamFiles {
  providerClient: string;
  proxyRateLimiter: string;
  main: string;
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
    // Best-effort: the upstream sibling may not have main.ts (e.g. a
    // pre-monorepo checkout). When absent, the test fixture substitutes
    // a synthesized stub below.
    main: readUpstreamSafe(FILES.main ?? ''),
  };
}

function readUpstreamSafe(file: string): string {
  if (file === '') return '';
  try {
    return readUpstream(file);
  } catch {
    return '';
  }
}

/**
 * Synthesized upstream `main.ts` shape — used when the sibling
 * `MANIFEST_REPO` checkout does not have main.ts at upstream/main
 * (e.g. a stale local fork). Mirrors the `app.listen(port, host);`
 * block the admin-mount patch anchors on, plus the `expressApp`
 * variable initialization that the patch references.
 */
const SYNTHESIZED_MAIN_TS = [
  "import { NestFactory } from '@nestjs/core';",
  "import { AppModule } from './app.module';",
  '',
  'export async function bootstrap() {',
  '  const app = await NestFactory.create(AppModule);',
  '  const expressApp = app.getHttpAdapter().getInstance();',
  '  // ... upstream middleware ...',
  "  const port = Number(process.env['PORT'] ?? 3001);",
  "  const host = process.env['BIND_ADDRESS'] ?? '127.0.0.1';",
  '  await app.listen(port, host);',
  '}',
  '',
].join('\n');

interface TempFiles {
  /** Absolute path to the manifest root (the tempdir). */
  root: string;
  providerClient: string;
  proxyRateLimiter: string;
  main: string;
  modelFetcher: string;
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
  writeFile(
    FILES.main ?? 'packages/backend/src/main.ts',
    upstream.main !== '' ? upstream.main : SYNTHESIZED_MAIN_TS,
  );
  // Best-effort: synthesize a `model.controller.ts` upstream-shape fixture
  // when the sibling Manifest checkout has no `model.controller.ts` at
  // upstream/main (e.g. a stale fork or a refactor in flight). The
  // synthesized shape mirrors the `getAvailableModels` body the apply.ts
  // model-list-override patcher anchors on.
  const synthesizedModelFetcher = [
    "import { Controller, Get } from '@nestjs/common';",
    '',
    "@Controller('api/v1/routing')",
    'export class ModelController {',
    '  @Get(":agentName/available-models")',
    '  async getAvailableModels(): Promise<unknown[]> {',
    '    const agent = { tenant_id: "t", id: "a" };',
    '    const models = await this.discoveryService.getModelsForAgent(agent.tenant_id, agent.id);',
    '',
    '    // Build display name map for custom providers (tenant-global)',
    '    const customProviders = await this.customProviderService.list(agent.tenant_id);',
    '    return models;',
    '  }',
    '}',
    '',
  ].join('\n');
  let modelFetcherUpstream = '';
  try {
    modelFetcherUpstream = FILES.modelFetcher
      ? readUpstream(FILES.modelFetcher)
      : '';
  } catch {
    modelFetcherUpstream = '';
  }
  writeFile(
    FILES.modelFetcher ?? 'packages/backend/src/routing/model.controller.ts',
    modelFetcherUpstream !== '' ? modelFetcherUpstream : synthesizedModelFetcher,
  );

  const files: TempFiles = {
    root: tmp,
    providerClient: join(tmp, FILES.providerClient),
    proxyRateLimiter: join(tmp, FILES.proxyRateLimiter),
    main: join(tmp, FILES.main ?? 'packages/backend/src/main.ts'),
    modelFetcher: join(
      tmp,
      FILES.modelFetcher ?? 'packages/backend/src/routing/model.controller.ts',
    ),
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

describe('applyAll (two-file patcher)', () => {
  it('patches both files against upstream shapes', async () => {
    await withTempManifest(async (files) => {
      const all = await applyAll(files.root);

      expectStatus('providerClient', all.providerClient, 'applied');
      expectStatus('proxyRateLimiter', all.proxyRateLimiter, 'applied');
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
    });
  });

  it('is idempotent — second run on the same tempdir reports noop for both files', async () => {
    await withTempManifest(async (files) => {
      const first = await applyAll(files.root);
      expect(first.fullyApplied).toBe(true);

      const second = await applyAll(files.root);
      expectStatus('providerClient', second.providerClient, 'noop');
      expectStatus('proxyRateLimiter', second.proxyRateLimiter, 'noop');
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
      expect(third.fullyApplied).toBe(false);
      expect(third.hasDrift).toBe(true);
    });
  });

  it('reports noop (not drift) when an upstream-shaped file has been customized to behave like the patch', async () => {
    // Simulates the case where someone hand-applied a similar patch
    // using a different code path: the OLD upstream anchor is gone but
    // the new-text sentinel (the post-patch call site) is present. The
    // patcher should report noop, not drift.
    await withTempManifest(async (files) => {
      const original = readFileSync(files.proxyRateLimiter, 'utf-8');
      const customized = original.replace(
        'const CONCURRENCY_MAX = 10;\n',
        'const CONCURRENCY_MAX = getResolvedConcurrencyMax();\n',
      );
      writeFileSync(files.proxyRateLimiter, customized, 'utf-8');

      const result = await applyProxyRateLimiterHost(files.proxyRateLimiter);
      expectStatus('applyProxyRateLimiterHost', result, 'noop');
    });
  });

  it('dryRun: reports applied but does not modify the file', async () => {
    await withTempManifest(async (files) => {
      const before = {
        providerClient: readFileSync(files.providerClient, 'utf-8'),
        proxyRateLimiter: readFileSync(files.proxyRateLimiter, 'utf-8'),
      };

      const all = await applyAll(files.root, undefined, { dryRun: true });
      expect(all.fullyApplied).toBe(true);

      const after = {
        providerClient: readFileSync(files.providerClient, 'utf-8'),
        proxyRateLimiter: readFileSync(files.proxyRateLimiter, 'utf-8'),
      };
      expect(after.providerClient).toBe(before.providerClient);
      expect(after.proxyRateLimiter).toBe(before.proxyRateLimiter);
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

  it('per-file wrappers accept a no-argument call (default options)', async () => {
    // Covers the `options: ApplyOptions = {}` default parameter in applyPatch.
    await withTempManifest(async (files) => {
      // Fresh upstream content — no dryRun flag, so file IS written.
      const r1 = await applyProviderClientHost(files.providerClient);
      const r2 = await applyProxyRateLimiterHost(files.proxyRateLimiter);
      expectStatus('providerClient', r1, 'applied');
      expectStatus('proxyRateLimiter', r2, 'applied');
    });
  });
});


describe('applyAllFive (provider-client + rate-limiter + admin-mount + model-list-override)', () => {
  it('patches all four files against the upstream shapes', async () => {
    await withTempManifest(async (files) => {
      const all = await applyAllFive(files.root);

      expectStatus('providerClient', all.providerClient, 'applied');
      expectStatus('proxyRateLimiter', all.proxyRateLimiter, 'applied');
      expectStatus('adminMount', all.adminMount, 'applied');
      expectStatus('modelListOverride', all.modelListOverride, 'applied');
      expect(all.fullyApplied).toBe(true);
      expect(all.hasDrift).toBe(false);

      const patchedModelFetcher = readFileSync(files.modelFetcher, 'utf-8');
      expect(patchedModelFetcher).toContain('function applyModelListOverridePlugins(');
    });
  });

  it('returns a synthetic noop for modelListOverride when files.modelFetcher is undefined', async () => {
    await withTempManifest(async (files) => {
      const specWithoutModelFetcher: ManifestFileSpec = {
        providerClient: FILES.providerClient,
        proxyRateLimiter: FILES.proxyRateLimiter,
        main: FILES.main,
      };
      const all = await applyAllFive(files.root, specWithoutModelFetcher);

      expectStatus('modelListOverride', all.modelListOverride, 'noop');
      // The other patchers still ran.
      expectStatus('providerClient', all.providerClient, 'applied');
      expectStatus('proxyRateLimiter', all.proxyRateLimiter, 'applied');
      expectStatus('adminMount', all.adminMount, 'applied');
      // No drift, so fullyApplied stays true.
      expect(all.fullyApplied).toBe(true);
      expect(all.hasDrift).toBe(false);
    });
  });

  it('reports the model-list-override drift independently when model.controller.ts is missing the getModelsForAgent anchor', async () => {
    await withTempManifest(async (files) => {
      // Drop the model-list-override anchor so the patcher reports drift
      // but the other patches still apply.
      const strippedModelFetcher = readFileSync(files.modelFetcher, 'utf-8')
        // Strip both the old anchor and the post-patch sentinel so the
        // patcher's `extractSentinelFromNew` noop short-circuit doesn't
        // mask a real drift.
        .replace(
          '    const models = await this.discoveryService.getModelsForAgent(agent.tenant_id, agent.id);\n',
          '    const models: unknown[] = [];\n',
        )
        .replace(
          '    const customProviders = await this.customProviderService.list(agent.tenant_id);',
          '    const customProviders: unknown[] = [];',
        );
      writeFileSync(files.modelFetcher, strippedModelFetcher, 'utf-8');

      const all = await applyAllFive(files.root);

      expectStatus('providerClient', all.providerClient, 'applied');
      expectStatus('proxyRateLimiter', all.proxyRateLimiter, 'applied');
      expectStatus('adminMount', all.adminMount, 'applied');
      expectStatus('modelListOverride', all.modelListOverride, 'upstream-drift');
      expect(all.fullyApplied).toBe(false);
      expect(all.hasDrift).toBe(true);
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
        oldText: RETURN_OLD,
        newText: RETURN_NEW,
        helperMarkerOld: HELPER_MARKER_OLD,
        helperMarkerNew: buildHelperMarkerNew(),
      });
      expectStatus('applyPatch direct', result, 'applied');
    });
    // Reference DEFAULT_MANIFEST_FILES to keep it in the type graph (no-op assertion).
    expect(DEFAULT_MANIFEST_FILES).toBeDefined();
  });
});

describe('applyPatch preflight anchor drift', () => {
  it('reports upstream-drift when a preflight anchor marker is missing', async () => {
    await withTempManifest(async (files) => {
      const result = await applyModelListOverrideHost(files.modelFetcher, {
        preflightAnchors: [
          { name: 'upstream-class', marker: 'class ModelController {' },
          { name: 'helper-symbol', marker: 'function applyModelListOverridePlugins(' },
        ],
      });
      expectStatus('preflight-drift', result, 'upstream-drift');
      if (result.status === 'upstream-drift') {
        expect(result.reason).toContain('preflight anchors missing');
        expect(result.reason).toContain('helper-symbol');
        expect(result.reason).not.toContain('upstream-class');
      }
    });
  });

  it('passes the preflight anchor check when every marker is present', async () => {
    await withTempManifest(async (files) => {
      const upstream = readFileSync(files.proxyRateLimiter, 'utf-8');
      expect(upstream).toContain('class ProxyRateLimiter');
      const result = await applyProxyRateLimiterHost(files.proxyRateLimiter, {
        preflightAnchors: [
          { name: 'upstream-class', marker: 'class ProxyRateLimiter' },
        ],
      });
      expectStatus('preflight-pass', result, 'applied');
    });
  });

  it('treats an empty preflight anchor list as a no-op', async () => {
    await withTempManifest(async (files) => {
      const result = await applyModelListOverrideHost(files.modelFetcher, {
        preflightAnchors: [],
      });
      expectStatus('preflight-empty', result, 'applied');
    });
  });
});

describe('tsc check on patched files', () => {
  it('all patched files pass tsc --noEmit against the backend tsconfig', async () => {
    await withTempManifest(async (files) => {
      const all = await applyAllFive(files.root);
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
        modelFetcher: join(
          MANIFEST_REPO,
          'packages/backend/src/routing/model.controller.ts',
        ),
      };
      const backups = {
        providerClient: readFileSync(realPaths.providerClient),
        proxyRateLimiter: readFileSync(realPaths.proxyRateLimiter),
        modelFetcher: readFileSync(realPaths.modelFetcher),
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
        realPaths.modelFetcher,
        readFileSync(files.modelFetcher),
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
          'model.controller',
          'applyModelListOverridePlugins',
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
        writeFileSync(realPaths.modelFetcher, backups.modelFetcher);
      }
    });
  });
});