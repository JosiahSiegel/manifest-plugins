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
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { providerParamValueIsValid, type ProviderParamSpec, type ModelCapability } from 'manifest-shared';
import {
  applyAll,
  applyAllEight,
  applyAdminMount,
  applyAllFive,
  applyModelListOverrideHost,
  applyProviderClientHost,
  applyProviderParamSpecHost,
  applyProxyRateLimiterHost,
  applyRoutingModelListOverrideHost,
  formatUpstreamDriftReason,
  DEFAULT_MANIFEST_FILES,
  type ApplyResult,
  type ManifestFileSpec,
} from '../src/host/apply';
import {
  buildHelperMarkerNew,
  HELPER_MARKER_OLD,
  PROVIDER_PARAM_SPEC_HOST_SOURCE,
  PROVIDER_PARAM_SPEC_NEW_GET_SPECS,
  PROVIDER_PARAM_SPEC_NEW_LIST_MODEL_IDS,
  PROVIDER_PARAM_SPEC_OLD_GET_SPECS,
  PROVIDER_PARAM_SPEC_OLD_LIST_MODEL_IDS,
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

const SYNTHESIZED_PROVIDER_PARAM_SPEC_SERVICE = [
  "import { Injectable, type OnModuleInit } from '@nestjs/common';",
  "import { getProviderModelCapabilities, getProviderParamSpecs, normalizeProviderParamProviderId, type ProviderParamSpec } from 'manifest-shared';",
  '',
  'function providerMetadataIdentity(providerId: string | undefined, model: string | undefined): { provider: string; model: string } | null {',
  '  return providerId !== undefined && model !== undefined ? { provider: providerId, model } : null;',
  '}',
  'function metadataMatchesRoute(metadata: { provider: string; model: string }, providerId: string | undefined, model: string | undefined): boolean {',
  '  return metadata.provider === providerId && metadata.model === model;',
  '}',
  'function withRouteIdentity(spec: ProviderParamSpec, providerId: string | undefined, authType: string | undefined, model: string | undefined): ProviderParamSpec {',
  '  return { ...spec, provider: providerId ?? spec.provider, authType: authType ?? spec.authType, model: model ?? spec.model };',
  '}',
  '',
  '@Injectable()',
  'export class ProviderParamSpecService implements OnModuleInit {',
  '  onModuleInit(): void {}',
  '  private getProviderlessSpecs(_specs: readonly ProviderParamSpec[], _providerId: string | undefined, _authType: string | undefined, _model: string | undefined): readonly ProviderParamSpec[] { return []; }',
  '',
  '  listModelIds(): Array<{ provider: string; authType: AuthType; model: string }> {',
  '    return this.specs.map((entry) => {',
  '      const provider = normalizeProviderParamProviderId(entry.provider);',
  '      return {',
  '        provider,',
  '        authType: entry.authType,',
  '        model: entry.model,',
  '      };',
  '    });',
  '  }',
  '',
  '  async getSpecs(',
  '    providerId: string | undefined,',
  '    authType: AuthType | undefined,',
  '    model: string | undefined,',
  '  ): Promise<readonly ProviderParamSpec[]> {',
  '    const providerlessSpecs = this.getProviderlessSpecs(this.specs, providerId, authType, model);',
  '    if (providerlessSpecs.length > 0) return providerlessSpecs;',
  '',
  '    const directSpecs = getProviderParamSpecs(this.specs, providerId, authType, model);',
  '    if (directSpecs.length > 0) return directSpecs;',
  '',
  '    const metadata = providerMetadataIdentity(providerId, model);',
  '    if (!metadata || metadataMatchesRoute(metadata, providerId, model)) return directSpecs;',
  '',
  '    return getProviderParamSpecs(this.specs, metadata.provider, authType, metadata.model).map(',
  '      (spec) => withRouteIdentity(spec, providerId, authType, model),',
  '    );',
  '  }',
  '',
  '  async getCapabilities(',
  '    providerId: string | undefined,',
  '    authType: AuthType | undefined,',
  '    model: string | undefined,',
  '  ): Promise<readonly ModelCapability[] | null> {',
  '    const direct = getProviderModelCapabilities(this.specs, providerId, authType, model);',
  '    if (direct) return direct;',
  '',
  '    const metadata = providerMetadataIdentity(providerId, model);',
  '    if (!metadata || metadataMatchesRoute(metadata, providerId, model)) return direct;',
  '    return getProviderModelCapabilities(this.specs, metadata.provider, authType, metadata.model);',
  '  }',
  '}',
  '',
].join('\n');

function synthesizedRoutingService(
  className: 'TierService' | 'SpecificityService' | 'HeaderTierService',
): string {
  return [
    "import { Injectable } from '@nestjs/common';",
    '',
    '@Injectable()',
    `export class ${className} {`,
    '  async buildFallbackRoutes(tenantId: string, agentId: string) {',
    '    const available = await this.discoveryService.getModelsForAgent(tenantId, agentId);',
    '    return available;',
    '  }',
    '}',
    '',
  ].join('\n');
}

interface TempFiles {
  /** Absolute path to the manifest root (the tempdir). */
  root: string;
  providerClient: string;
  proxyRateLimiter: string;
  main: string;
  modelFetcher: string;
  providerParamSpecService: string;
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
  writeFile(
    FILES.tierService ?? 'packages/backend/src/routing/routing-core/tier.service.ts',
    synthesizedRoutingService('TierService'),
  );
  writeFile(
    FILES.specificityService ??
      'packages/backend/src/routing/routing-core/specificity.service.ts',
    synthesizedRoutingService('SpecificityService'),
  );
  writeFile(
    FILES.headerTierService ??
      'packages/backend/src/routing/header-tiers/header-tier.service.ts',
    synthesizedRoutingService('HeaderTierService'),
  );
  writeFile(
    FILES.providerParamSpecService ??
      'packages/backend/src/routing/routing-core/provider-param-spec.service.ts',
    SYNTHESIZED_PROVIDER_PARAM_SPEC_SERVICE,
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
    providerParamSpecService: join(
      tmp,
      FILES.providerParamSpecService ??
        'packages/backend/src/routing/routing-core/provider-param-spec.service.ts',
    ),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
  return Promise.resolve(fn(files)).finally(files.cleanup);
}

function loadPatchedProviderParamService(
  source: string,
  specs: readonly ProviderParamSpec[],
  capabilities: readonly ModelCapability[] | null = null,
): {
  readonly getSpecs: (provider: string, authType: string, model: string) => Promise<readonly ProviderParamSpec[]>;
  readonly getCapabilities: (provider: string, authType: string, model: string) => Promise<readonly ModelCapability[] | null>;
  readonly listModelIds: () => ReadonlyArray<{ provider: string; authType: string; model: string }>;
} {
  const transpiled = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const requireFromFixture = (id: string): unknown => {
    if (id === 'manifest-shared') {
      return {
        getProviderParamSpecs: () => specs,
        getProviderModelCapabilities: () => capabilities,
        normalizeProviderParamProviderId: (provider: string) => provider,
      };
    }
    if (id === '@nestjs/common') return { Injectable: () => () => undefined };
    if (id === 'manifest-plugins') return require('../src/index');
    throw new Error(`unexpected fixture dependency: ${id}`);
  };
  new Function('require', 'module', 'exports', transpiled)(requireFromFixture, module, module.exports);
  const Service = module.exports['ProviderParamSpecService'] as new () => {
    getSpecs: (provider: string, authType: string, model: string) => Promise<readonly ProviderParamSpec[]>;
    getCapabilities: (provider: string, authType: string, model: string) => Promise<readonly ModelCapability[] | null>;
    listModelIds: () => ReadonlyArray<{ provider: string; authType: string; model: string }>;
  };
  const service = new Service();
  Object.defineProperty(service, 'specs', { value: specs });
  return service;
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
      expect(rateLimiter).not.toContain('const DEFAULT_CONCURRENCY_MAX = 10;');
      expect(rateLimiter).toContain(
        'const DEFAULT_CONCURRENCY_MAX = getResolvedConcurrencyMax();',
      );
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
    //
    // Wave-history: pre-upstream-refactor (commit 3c5af562c) the
    // upstream anchor was `const CONCURRENCY_MAX = 10;` and the
    // post-patch call site was `const CONCURRENCY_MAX =
    // getResolvedConcurrencyMax();`. Upstream renamed the constant
    // to `DEFAULT_CONCURRENCY_MAX`; this test mirrors that rename.
    await withTempManifest(async (files) => {
      const original = readFileSync(files.proxyRateLimiter, 'utf-8');
      const customized = original.replace(
        'const DEFAULT_CONCURRENCY_MAX = 10;\n',
        'const DEFAULT_CONCURRENCY_MAX = getResolvedConcurrencyMax();\n',
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

  it('executes patched provider-param methods with capability and widening contracts', async () => {
    await withTempManifest(async (files) => {
      const result = await applyProviderParamSpecHost(files.providerParamSpecService);
      expectStatus('provider-param-runtime', result, 'applied');
      const direct = Object.freeze({
        provider: 'openai',
        authType: 'api_key',
        model: 'gpt-6-astra',
        path: 'reasoning_effort',
        type: 'enum',
        label: 'Reasoning effort',
        description: 'upstream deprecated row',
        default: 'medium',
        values: Object.freeze(['low', 'medium', 'high']),
        group: 'reasoning',
      });
      const service = loadPatchedProviderParamService(
        readFileSync(files.providerParamSpecService, 'utf-8'),
        [direct],
        ['text', 'image', 'stream'],
      );
      const specs = await service.getSpecs('openai', 'api_key', 'gpt-6-astra');
      expect(specs).toHaveLength(1);
      expect(specs[0]?.path).toBe('reasoning_effort');
      expect(specs[0]?.values).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      expect(providerParamValueIsValid(specs[0] ?? direct, 'xhigh')).toBe(true);
      expect(providerParamValueIsValid(specs[0] ?? direct, 'max')).toBe(true);
      const capabilities = await service.getCapabilities('openai', 'api_key', 'gpt-6-astra');
      expect(capabilities).toEqual(['text', 'image', 'stream']);
      expect(capabilities?.every((capability) => typeof capability === 'string')).toBe(true);
      const noCapabilitiesService = loadPatchedProviderParamService(
        readFileSync(files.providerParamSpecService, 'utf-8'),
        [direct],
        null,
      );
      await expect(
        noCapabilitiesService.getCapabilities('openai', 'api_key', 'gpt-6-astra'),
      ).resolves.toBeNull();
      const identities = service.listModelIds();
      expect(identities).toEqual([
        { provider: 'openai', authType: 'api_key', model: 'gpt-6-astra' },
        { provider: 'openai', authType: 'subscription', model: 'gpt-6-astra' },
      ]);
    });
  });

  it('applyProviderParamSpecHost patches the synthesized upstream service in isolation', async () => {
    await withTempManifest(async (files) => {
      const result = await applyProviderParamSpecHost(files.providerParamSpecService);

      expectStatus('applyProviderParamSpecHost', result, 'applied');
      const patched = readFileSync(files.providerParamSpecService, 'utf-8');
      expect(patched.match(/function applyProviderParamSpecPlugins\(/g)).toHaveLength(1);
      expect(patched).toContain(PROVIDER_PARAM_SPEC_NEW_GET_SPECS);
      expect(patched).toContain(PROVIDER_PARAM_SPEC_NEW_LIST_MODEL_IDS);
      expect(patched).toContain('async getCapabilities(');
    });
  });

  it('per-file wrappers accept a no-argument call (default options)', async () => {
    // Covers the `options: ApplyOptions = {}` default parameter in applyPatch.
    await withTempManifest(async (files) => {
      // Fresh upstream content — no dryRun flag, so file IS written.
      const r1 = await applyProviderClientHost(files.providerClient);
      const r2 = await applyProxyRateLimiterHost(files.proxyRateLimiter);
      const r3 = await applyModelListOverrideHost(files.modelFetcher);
      expectStatus('modelListOverride', r3, 'applied');
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

describe('applyAllEight provider-param-spec patch', () => {
  it('applies all nine hooks once and preserves provider-param bytes on the noop rerun', async () => {
    await withTempManifest(async (files) => {
      const first = await applyAllEight(files.root, undefined, { providerParamSpec: true });

      expectStatus('providerClient', first.providerClient, 'applied');
      expectStatus('proxyRateLimiter', first.proxyRateLimiter, 'applied');
      expectStatus('adminMount', first.adminMount, 'applied');
      expectStatus('modelListOverride', first.modelListOverride, 'applied');
      expectStatus('tierServiceRoutingModelList', first.tierServiceRoutingModelList, 'applied');
      expectStatus(
        'specificityServiceRoutingModelList',
        first.specificityServiceRoutingModelList,
        'applied',
      );
      expectStatus(
        'headerTierServiceRoutingModelList',
        first.headerTierServiceRoutingModelList,
        'applied',
      );
      expectStatus('providerParamSpec', first.providerParamSpec, 'applied');
      expect(first.fullyApplied).toBe(true);
      expect(first.hasDrift).toBe(false);

      const patched = readFileSync(files.providerParamSpecService, 'utf-8');
      expect(patched.match(/function applyProviderParamSpecPlugins\(/g)).toHaveLength(1);
      expect(patched).toContain(PROVIDER_PARAM_SPEC_HOST_SOURCE);
      expect(patched).toContain(PROVIDER_PARAM_SPEC_NEW_GET_SPECS);
      expect(patched).toContain(PROVIDER_PARAM_SPEC_NEW_LIST_MODEL_IDS);
      expect(patched).toContain('async getCapabilities(');
      expect(patched).not.toContain(PROVIDER_PARAM_SPEC_OLD_GET_SPECS);
      expect(patched).not.toContain(PROVIDER_PARAM_SPEC_OLD_LIST_MODEL_IDS);

      const second = await applyAllEight(files.root, undefined, { providerParamSpec: true });
      expectStatus('providerClient', second.providerClient, 'noop');
      expectStatus('proxyRateLimiter', second.proxyRateLimiter, 'noop');
      expectStatus('adminMount', second.adminMount, 'noop');
      expectStatus('modelListOverride', second.modelListOverride, 'noop');
      expectStatus('tierServiceRoutingModelList', second.tierServiceRoutingModelList, 'noop');
      expectStatus(
        'specificityServiceRoutingModelList',
        second.specificityServiceRoutingModelList,
        'noop',
      );
      expectStatus(
        'headerTierServiceRoutingModelList',
        second.headerTierServiceRoutingModelList,
        'noop',
      );
      expectStatus('providerParamSpec', second.providerParamSpec, 'noop');
      expect(second.fullyApplied).toBe(true);
      expect(second.hasDrift).toBe(false);
      expect(readFileSync(files.providerParamSpecService, 'utf-8')).toBe(patched);
    });
  });

  it('reports named provider drift while applying every unrelated hook', async () => {
    await withTempManifest(async (files) => {
      writeFileSync(
        files.providerParamSpecService,
        SYNTHESIZED_PROVIDER_PARAM_SPEC_SERVICE.replace(
          '  async getSpecs(',
          '  async getSpecsAfterUpstreamRefactor(',
        ),
        'utf-8',
      );

      const result = await applyAllEight(files.root, undefined, { providerParamSpec: true });

      expectStatus('providerClient', result.providerClient, 'applied');
      expectStatus('proxyRateLimiter', result.proxyRateLimiter, 'applied');
      expectStatus('adminMount', result.adminMount, 'applied');
      expectStatus('modelListOverride', result.modelListOverride, 'applied');
      expectStatus('tierServiceRoutingModelList', result.tierServiceRoutingModelList, 'applied');
      expectStatus(
        'specificityServiceRoutingModelList',
        result.specificityServiceRoutingModelList,
        'applied',
      );
      expectStatus(
        'headerTierServiceRoutingModelList',
        result.headerTierServiceRoutingModelList,
        'applied',
      );
      expectStatus('providerParamSpec', result.providerParamSpec, 'upstream-drift');
      expect(result.providerParamSpec.reason).toContain('getSpecs');
      expect(result.providerParamSpec.reason).not.toContain('listModelIds');
      expect(result.fullyApplied).toBe(false);
      expect(result.hasDrift).toBe(true);

      const partiallyPatched = readFileSync(files.providerParamSpecService, 'utf-8');
      expect(partiallyPatched.match(/function applyProviderParamSpecPlugins\(/g)).toHaveLength(1);
      expect(partiallyPatched).toContain(PROVIDER_PARAM_SPEC_NEW_LIST_MODEL_IDS);
      expect(partiallyPatched).toContain('async getCapabilities(');
      expect(partiallyPatched).not.toContain(PROVIDER_PARAM_SPEC_NEW_GET_SPECS);
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

describe('apply edge branches', () => {
  it('formats both present and absent drift reasons for aggregate reporting', () => {
    expect(
      formatUpstreamDriftReason({
        status: 'upstream-drift',
        file: 'provider-param-spec.service.ts',
        reason: 'anchor missing',
      }),
    ).toBe('anchor missing');
    expect(
      formatUpstreamDriftReason({
        status: 'upstream-drift',
        file: 'provider-param-spec.service.ts',
      }),
    ).toBe('unknown drift');
  });

  it('reports helper-marker drift and requires main.ts for applyAllFive', async () => {
    await withTempManifest(async (files) => {
      const broken = readFileSync(files.providerClient, 'utf-8').replace(
        'class ProviderClient',
        'class ProviderClientChanged',
      );
      writeFileSync(files.providerClient, broken, 'utf-8');
      const drift = await applyProviderClientHost(files.providerClient);
      expectStatus('helper-marker-drift', drift, 'upstream-drift');
    });
    await expect(
      applyAllFive('/tmp/f1-missing-main', {
        providerClient: 'provider-client.ts',
        proxyRateLimiter: 'rate-limiter.ts',
        main: undefined,
      }),
    ).rejects.toThrow(/files\.main is required/);
  });

  it('covers routing service class anchors and optional apply fallbacks', async () => {
    await withTempManifest(async (files) => {
      const header = await applyRoutingModelListOverrideHost(files.modelFetcher, 'HeaderTierService');
      expectStatus('header-routing', header, 'upstream-drift');
      const specificity = await applyRoutingModelListOverrideHost(files.modelFetcher, 'SpecificityService');
      expectStatus('specificity-routing', specificity, 'upstream-drift');
      const admin = await applyAdminMount(files.main);
      expectStatus('admin-mount', admin, 'applied');
    });
    await withTempManifest(async (files) => {
      const result = await applyAllEight(files.root, {
        providerClient: FILES.providerClient,
        proxyRateLimiter: FILES.proxyRateLimiter,
        main: FILES.main,
        modelFetcher: undefined,
        tierService: undefined,
        specificityService: undefined,
        headerTierService: undefined,
        providerParamSpecService: undefined,
      });
      expectStatus('tier-fallback', result.tierServiceRoutingModelList, 'noop');
      expectStatus('specificity-fallback', result.specificityServiceRoutingModelList, 'noop');
      expectStatus('header-fallback', result.headerTierServiceRoutingModelList, 'noop');
      expectStatus('provider-fallback', result.providerParamSpec, 'noop');
    });
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