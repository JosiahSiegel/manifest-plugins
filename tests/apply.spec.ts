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
  applyAllFour,
  applyProviderClientHost,
  applyProxyRateLimiterHost,
  applyProxyRoutingOverrideHost,
  applyProxyServiceHost,
  DEFAULT_MANIFEST_FILES,
  type ApplyResult,
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

/**
 * Fixture-only shape of `proxy.service.ts` for the new
 * `applyProxyRoutingOverrideHost` patcher. We don't need to
 * `git show` upstream here — the patcher doesn't read upstream
 * directly; it works against whatever bytes are on disk. We
 * synthesize the upstream shape inline so the test is hermetic
 * and doesn't depend on the sibling Manifest checkout having a
 * specific post-`2ab748a6` commit checked out.
 *
 * The shape mirrors upstream/main `proxy.service.ts` at commit
 * `2ab748a6` (2026-06-29), with the explicit-model early-return
 * block at the signature line `): Promise<ResolvedRouting> {`
 * down to `if (apiMode !== 'messages' && ... && requestedModel
 * !== OPENAI_MODEL_ID_AUTO) {`.
 *
 * The fixture also carries the pre-existing message-cap anchors
 * (`parseMaxMessagesPerRequest` import + `getResolvedMaxMessagesPerRequest`
 * call site) so `applyProxyServiceHost` succeeds against it. The
 * `applyAllFour` orchestrator runs all four patches; each must
 * match its own anchor.
 */
function synthesizeProxyServiceFixture(): string {
  return [
    "import { ProviderParamSpecService } from '../routing-core/provider-param-spec.service';",
    "import { OPENAI_MODEL_ID_AUTO, routeForOpenAiModelId } from './openai-model-id';",
    "import { parseMaxMessagesPerRequest } from './message-limit';",
    '',
    '@Injectable()',
    'export class ProxyService {',
    '  constructor(',
    '    private readonly resolveService: ResolveService,',
    '    private readonly modelDiscovery: ModelDiscoveryService,',
    '    private readonly providerKeyService: ProviderKeyService,',
    '    private readonly tierService: TierService,',
    '    private readonly openaiOauth: OpenaiOauthService,',
    '    private readonly providerParamSpecs: ProviderParamSpecService,',
    '  ) {',
    "    this.maxMessagesPerRequest = parseMaxMessagesPerRequest(",
    "      this.config.get<string>('MANIFEST_MAX_MESSAGES'),",
    '    );',
    '  }',
    '',
    '  private async resolveRouting(',
    '    agentId: string,',
    '    tenantId: string,',
    '    body: ProxyRequestOptions[\'body\'],',
    '    sessionKey: string,',
    '    specificityOverride: ProxyRequestOptions[\'specificityOverride\'],',
    '    headers: ProxyRequestOptions[\'headers\'],',
    '    apiMode: ProxyApiMode,',
    '  ): Promise<ResolvedRouting> {',
    "    const requestedModel = typeof body.model === 'string' ? body.model : undefined;",
    '    // Anthropic Messages requests require a provider-native model field; only',
    '    // OpenAI-compatible surfaces use /v1/models IDs as route overrides.',
    "    if (apiMode !== 'messages' && requestedModel && requestedModel !== OPENAI_MODEL_ID_AUTO) {",
    '      return {',
    "        tier: 'default' as const,",
    '        route: routeForOpenAiModelId(requestedModel, []),',
    "        fallback_routes: null,",
    '      };',
    '    }',
    '    return { tier: \'default\', route: null };',
    '  }',
    '}',
    '',
  ].join('\n');
}

interface RoutingOverrideTempFiles {
  root: string;
  proxyService: string;
  cleanup: () => void;
}

function withSynthProxyService(
  fn: (files: RoutingOverrideTempFiles) => Promise<void> | void,
): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-routing-override-'));
  const relPath =
    'packages/backend/src/routing/proxy/proxy.service.ts';
  const target = join(tmp, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, synthesizeProxyServiceFixture(), 'utf-8');
  const files: RoutingOverrideTempFiles = {
    root: tmp,
    proxyService: target,
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

describe('applyProxyRoutingOverrideHost (proxy.service.ts routing-override hook)', () => {
  it('patches the upstream-shaped proxy.service.ts and inserts the host helper before the explicit-model branch', async () => {
    await withSynthProxyService(async (files) => {
      const result = await applyProxyRoutingOverrideHost(files.proxyService);
      expectStatus('applyProxyRoutingOverrideHost', result, 'applied');

      const patched = readFileSync(files.proxyService, 'utf-8');
      // Helper function exists.
      expect(patched).toContain('function applyProxyRoutingOverridePlugins(');
      // HeaderTierService import was added.
      expect(patched).toContain(
        "import { HeaderTierService } from '../header-tiers/header-tier.service';",
      );
      // HeaderTierService was injected into the constructor.
      expect(patched).toContain(
        'private readonly headerTierService: HeaderTierService,',
      );
      // The plugin call appears BEFORE the explicit-model early-return.
      const pluginIdx = patched.indexOf('applyProxyRoutingOverridePlugins(');
      const earlyReturnIdx = patched.indexOf(
        "if (apiMode !== 'messages' && requestedModel && requestedModel !== OPENAI_MODEL_ID_AUTO) {",
      );
      expect(pluginIdx).toBeGreaterThanOrEqual(0);
      expect(earlyReturnIdx).toBeGreaterThanOrEqual(0);
      expect(pluginIdx).toBeLessThan(earlyReturnIdx);
      // The plugin call awaits the host fetches (headerTiers +
      // discoveredModels). This is the structural contract: the
      // plugin never sees DB / Nest providers, so the host must
      // resolve them before invoking.
      expect(patched).toContain('await this.headerTierService.list(agentId)');
      expect(patched).toContain(
        'await this.modelDiscovery.getModelsForAgent(tenantId, agentId)',
      );
    });
  });

  it('is idempotent — running twice on the same file reports noop', async () => {
    await withSynthProxyService(async (files) => {
      const first = await applyProxyRoutingOverrideHost(files.proxyService);
      expectStatus('applyProxyRoutingOverrideHost', first, 'applied');

      const second = await applyProxyRoutingOverrideHost(files.proxyService);
      expectStatus('applyProxyRoutingOverrideHost', second, 'noop');
    });
  });

  it('reports upstream-drift when the explicit-model anchor (2ab748a6 signature) is missing', async () => {
    await withSynthProxyService(async (files) => {
      // Strip the entire explicit-model block so the anchor is gone.
      const original = readFileSync(files.proxyService, 'utf-8');
      const stripped = original.replace(
        "    const requestedModel = typeof body.model === 'string' ? body.model : undefined;\n    // Anthropic Messages requests require a provider-native model field; only\n    // OpenAI-compatible surfaces use /v1/models IDs as route overrides.\n    if (apiMode !== 'messages' && requestedModel && requestedModel !== OPENAI_MODEL_ID_AUTO) {\n",
        '',
      );
      writeFileSync(files.proxyService, stripped, 'utf-8');

      const result = await applyProxyRoutingOverrideHost(files.proxyService);
      expectStatus('applyProxyRoutingOverrideHost', result, 'upstream-drift');
      if (result.status === 'upstream-drift') {
        expect(result.reason).toContain('expected upstream anchor');
      }
    });
  });

  it('reports upstream-drift when the HeaderTierService import anchor is missing', async () => {
    await withSynthProxyService(async (files) => {
      // Remove the existing ProviderParamSpec import so the import
      // anchor is gone.
      const original = readFileSync(files.proxyService, 'utf-8');
      const stripped = original.replace(
        "import { ProviderParamSpecService } from '../routing-core/provider-param-spec.service';\n",
        '',
      );
      writeFileSync(files.proxyService, stripped, 'utf-8');

      const result = await applyProxyRoutingOverrideHost(files.proxyService);
      expectStatus('applyProxyRoutingOverrideHost', result, 'upstream-drift');
    });
  });

  it('reports upstream-drift when the providerParamSpecs constructor anchor is missing', async () => {
    await withSynthProxyService(async (files) => {
      // Rewrite the constructor so the existing providerParamSpecs
      // closing line is gone. Use a different param name.
      const original = readFileSync(files.proxyService, 'utf-8');
      const stripped = original.replace(
        '    private readonly providerParamSpecs: ProviderParamSpecService,\n  ) {',
        '    private readonly providerSpecs: ProviderParamSpecService,\n  ) {',
      );
      writeFileSync(files.proxyService, stripped, 'utf-8');

      const result = await applyProxyRoutingOverrideHost(files.proxyService);
      expectStatus('applyProxyRoutingOverrideHost', result, 'upstream-drift');
    });
  });

  it('dryRun: reports applied but does not modify the file', async () => {
    await withSynthProxyService(async (files) => {
      const before = readFileSync(files.proxyService, 'utf-8');

      const result = await applyProxyRoutingOverrideHost(files.proxyService, {
        dryRun: true,
      });
      expectStatus('applyProxyRoutingOverrideHost', result, 'applied');

      const after = readFileSync(files.proxyService, 'utf-8');
      expect(after).toBe(before);
    });
  });
});

describe('applyAllFour includes the routing-override patcher (four-file patcher)', () => {
  it('patches all four files against the upstream shapes', async () => {
    await withTempManifest(async (files) => {
      // Stage a synthesized proxy.service.ts shape with the
      // 2ab748a6 anchor alongside the real provider-client.ts,
      // proxy-rate-limiter.ts, and the real (existing) proxy.service.ts
      // fixture the upstream tests already populated. We want the
      // synthesized routing-override content for proxy.service.ts so
      // applyProxyRoutingOverrideHost has an anchor to match.
      const synthProxyService = synthesizeProxyServiceFixture();
      writeFileSync(files.proxyService, synthProxyService, 'utf-8');

      const all = await applyAllFour(files.root);

      expectStatus('providerClient', all.providerClient, 'applied');
      expectStatus('proxyRateLimiter', all.proxyRateLimiter, 'applied');
      expectStatus('proxyService', all.proxyService, 'applied');
      expectStatus(
        'proxyRoutingOverride',
        all.proxyRoutingOverride,
        'applied',
      );
      expect(all.fullyApplied).toBe(true);
      expect(all.hasDrift).toBe(false);

      const patched = readFileSync(files.proxyService, 'utf-8');
      expect(patched).toContain('function applyProxyRoutingOverridePlugins(');
    });
  });

  it('reports the routing-override drift independently when proxy.service.ts is missing the 2ab748a6 anchor', async () => {
    await withTempManifest(async (files) => {
      // Write a proxy.service.ts WITHOUT the 2ab748a6 anchor so the
      // routing-override patcher reports drift but the other three
      // patches still apply.
      const strippedProxyService = synthesizeProxyServiceFixture().replace(
        "    const requestedModel = typeof body.model === 'string' ? body.model : undefined;\n    // Anthropic Messages requests require a provider-native model field; only\n    // OpenAI-compatible surfaces use /v1/models IDs as route overrides.\n    if (apiMode !== 'messages' && requestedModel && requestedModel !== OPENAI_MODEL_ID_AUTO) {\n",
        '',
      );
      writeFileSync(files.proxyService, strippedProxyService, 'utf-8');

      const all = await applyAllFour(files.root);

      expectStatus('providerClient', all.providerClient, 'applied');
      expectStatus('proxyRateLimiter', all.proxyRateLimiter, 'applied');
      expectStatus('proxyService', all.proxyService, 'applied');
      expectStatus(
        'proxyRoutingOverride',
        all.proxyRoutingOverride,
        'upstream-drift',
      );
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
      const result = await applyProxyServiceHost(files.proxyService, {
        preflightAnchors: [
          { name: 'upstream-class', marker: 'class ProxyService {' },
          { name: 'helper-symbol', marker: 'function getResolvedMaxMessagesPerRequest(' },
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
      const result = await applyProxyServiceHost(files.proxyService, {
        preflightAnchors: [],
      });
      expectStatus('preflight-empty', result, 'applied');
    });
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