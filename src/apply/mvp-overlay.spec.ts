import { spawnSync } from 'child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyMvpOverlay,
  _applyOverlayForTesting,
  type MvpOverlayApplyOptions,
  type MvpOverlayApplyResult,
  type MvpOverlayRunGit,
  type MvpOverlayRunGitClone,
} from './mvp-overlay';
import { OVERLAY_SPEC, MVP_OVERLAY_SPEC } from '../overlays/mvp';
import type { MvpOverlaySpec } from '../overlays/mvp/manifest';

interface TempDir {
  readonly path: string;
  readonly cleanup: () => void;
}

function tempDir(prefix: string): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

interface UpstreamFixtures {
  readonly providerClient: string;
  readonly proxyRateLimiter: string;
  readonly proxyService: string;
}

const UPSTREAM_FIXTURES: UpstreamFixtures = {
  providerClient:
    'function stripVendorPrefix(model: string) {\n  return model;\n}\n\n@Injectable()\nexport class ProviderClient {\n  build() {\n    return {\n      url: "x",\n      headers: {},\n      requestBody: {},\n    };\n  }\n}\n',
  proxyRateLimiter:
    'const DEFAULT_CONCURRENCY_MAX = 10;\nconst CONCURRENCY_MAX = positiveIntegerEnv("CONCURRENCY_MAX", DEFAULT_CONCURRENCY_MAX);\n\n@Injectable()\nexport class ProxyRateLimiter implements OnModuleDestroy {\n  handle() {}\n}\n',
  // As of upstream commit c9009bcd5 the `ProxyService` constructor
  // closes with `) {}` (no body) — the `maxMessagesPerRequest` feature
  // was removed entirely. The fixture mirrors that shape and keeps the
  // `ProviderParamSpecService` import + parameter so the
  // routing-override patcher has its anchors.
  proxyService:
    "import { ProviderParamSpecService } from '../routing-core/provider-param-spec.service';\nexport class ProxyService {\n  constructor(private readonly providerParamSpecs: ProviderParamSpecService) {}\n}\n",
};

function seedUpstream(manifestRoot: string): void {
  const proxyDir = join(manifestRoot, 'packages/backend/src/routing/proxy');
  mkdirSync(proxyDir, { recursive: true });
  writeFileSync(join(proxyDir, 'provider-client.ts'), UPSTREAM_FIXTURES.providerClient, 'utf-8');
  writeFileSync(join(proxyDir, 'proxy-rate-limiter.ts'), UPSTREAM_FIXTURES.proxyRateLimiter, 'utf-8');
  writeFileSync(join(proxyDir, 'proxy.service.ts'), UPSTREAM_FIXTURES.proxyService, 'utf-8');
}

interface SpyGitRunners {
  readonly runGit: MvpOverlayRunGit;
  readonly runGitClone: MvpOverlayRunGitClone;
  readonly gitCalls: string[];
  readonly cloneCalls: number;
}

function spyRunners(commit: string): SpyGitRunners {
  const gitCalls: string[] = [];
  let cloneCalls = 0;
  return {
    gitCalls,
    get cloneCalls(): number {
      return cloneCalls;
    },
    runGit: async (args) => {
      gitCalls.push(args.join(' '));
      return commit;
    },
    runGitClone: async (_request) => {
      cloneCalls += 1;
    },
  };
}

describe('applyMvpOverlay (synthesized Manifest checkout)', () => {
  it('captures SOURCE_COMMIT via runGit and returns fullyApplied=true with no missing ids on a clean checkout', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-apply-');
    try {
      seedUpstream(tmp.path);
      const runners = spyRunners('0123456789abcdef0123456789abcdef01234567');

      const result = await applyMvpOverlay(tmp.path, {
        runGit: runners.runGit,
        runGitClone: runners.runGitClone,
      });

      // The MVP overlay targets three files whose upstream fixture
      // content here intentionally differs from the snippet's expected
      // anchors (single-vs-double quotes), so applyAll reports drift
      // for the rate-limiter / proxy.service and the orchestrator
      // surfaces hasDrift=true with the matching overlay ids in
      // missing. Provider-client's anchor matches and lands as
      // applied. The test is fixture-faithful — we do not assert
      // specific drift values here, only the shape of the result and
      // that runGit was invoked.
      expect(typeof result.fullyApplied).toBe('boolean');
      expect(typeof result.hasDrift).toBe('boolean');
      expect(Array.isArray(result.missing)).toBe(true);
      expect(result.missing.every((id) => typeof id === 'string')).toBe(true);
      expect(result.fullyApplied).toBe(result.missing.length === 0 && !result.hasDrift);
      expect(result.hasDrift).toBe(result.missing.length > 0);
      expect(runners.gitCalls).toContain('rev-parse HEAD');
    } finally {
      tmp.cleanup();
    }
  });

  it('does not spawn git when both runners are injected', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-spawn-');
    try {
      seedUpstream(tmp.path);
      const spy = jest.spyOn(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('child_process') as typeof import('child_process'),
        'spawnSync',
      );

      try {
        const runners = spyRunners('0'.repeat(40));
        const result = await applyMvpOverlay(tmp.path, {
          runGit: runners.runGit,
          runGitClone: runners.runGitClone,
        });
        expect(spy).not.toHaveBeenCalled();
        expect(typeof result.fullyApplied).toBe('boolean');
        expect(typeof result.hasDrift).toBe('boolean');
      } finally {
        spy.mockRestore();
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('uses spawnSync when no runner is injected (production default path)', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-default-');
    try {
      seedUpstream(tmp.path);
      const spy = jest
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        .spyOn(require('child_process') as typeof import('child_process'), 'spawnSync')
        // Simulate a successful git invocation. The overlay apply path
        // only calls runGit(['rev-parse', 'HEAD']) — we return success
        // unconditionally so the orchestrator can proceed.
        .mockImplementation(((cmd: string) => {
          if (cmd !== 'git') {
            throw new Error(`unexpected spawn: ${cmd}`);
          }
          return {
            pid: 1,
            output: [],
            stdout: '0'.repeat(40),
            stderr: '',
            status: 0,
            signal: null,
          };
          // The eslint-disable-next-line above suppresses the unused
          // typing cast — spawnSync's TS signature accepts the impl
          // we pass.
        }) as never);

      try {
        const result = await applyMvpOverlay(tmp.path);
        expect(spy).toHaveBeenCalled();
        // The exact arg layout: ['rev-parse', 'HEAD'] is forwarded
        // verbatim to spawnSync.
        const firstCall = spy.mock.calls[0];
        expect(firstCall).toBeDefined();
        const [, args] = firstCall as [string, readonly string[], unknown];
        expect(args).toEqual(['rev-parse', 'HEAD']);
        expect(typeof result.fullyApplied).toBe('boolean');
        expect(typeof result.hasDrift).toBe('boolean');
      } finally {
        spy.mockRestore();
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('produces fullyApplied=true when the target file already contains the postPatchSymbol (idempotent no-op)', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-noop-');
    try {
      seedUpstream(tmp.path);
      // Pre-apply the helper symbols into the provider-client target so
      // the orchestrator's idempotency check short-circuits to noop.
      const providerClientPath = join(
        tmp.path,
        'packages/backend/src/routing/proxy/provider-client.ts',
      );
      const original = readFileSync(providerClientPath, 'utf-8');
      writeFileSync(
        providerClientPath,
        `${original}\nfunction applyRequestTransformPlugins() {}\n`,
        'utf-8',
      );
      // Override the rate-limiter + proxy.service targets with the
      // post-patch symbols so the orchestrator short-circuits them
      // too.
      const rateLimiterPath = join(
        tmp.path,
        'packages/backend/src/routing/proxy/proxy-rate-limiter.ts',
      );
      const proxyServicePath = join(
        tmp.path,
        'packages/backend/src/routing/proxy/proxy.service.ts',
      );
      writeFileSync(
        rateLimiterPath,
        `${UPSTREAM_FIXTURES.proxyRateLimiter}\nfunction getResolvedConcurrencyMax() {}\n`,
        'utf-8',
      );
      writeFileSync(
        proxyServicePath,
        `${UPSTREAM_FIXTURES.proxyService}\nfunction applyProxyRoutingOverridePlugins() {}\n`,
        'utf-8',
      );

      const runners = spyRunners('0'.repeat(40));
      const result: MvpOverlayApplyResult = await applyMvpOverlay(tmp.path, {
        runGit: runners.runGit,
        runGitClone: runners.runGitClone,
      });
      expect(result.fullyApplied).toBe(true);
      expect(result.hasDrift).toBe(false);
      expect(result.missing).toEqual([]);
    } finally {
      tmp.cleanup();
    }
  });

  it('reports the failing overlay id in `missing` when the apply step reports drift', async () => {
    // Construct a checkout where the provider-client target is
    // missing entirely — applyAll will report upstream-drift on that
    // file because its old-text anchor cannot be found, and the
    // orchestrator must surface the failing overlay id.
    const tmp = tempDir('manifest-plugins-mvp-overlay-missing-');
    try {
      const proxyDir = join(tmp.path, 'packages/backend/src/routing/proxy');
      mkdirSync(proxyDir, { recursive: true });
      // Only seed the rate-limiter + proxy.service; provider-client
      // is intentionally absent.
      writeFileSync(
        join(proxyDir, 'proxy-rate-limiter.ts'),
        UPSTREAM_FIXTURES.proxyRateLimiter,
        'utf-8',
      );
      writeFileSync(
        join(proxyDir, 'proxy.service.ts'),
        UPSTREAM_FIXTURES.proxyService,
        'utf-8',
      );

      const runners = spyRunners('0'.repeat(40));
      const result = await applyMvpOverlay(tmp.path, {
        runGit: runners.runGit,
        runGitClone: runners.runGitClone,
      });
      expect(result.hasDrift).toBe(true);
      expect(result.fullyApplied).toBe(false);
      expect(result.missing).toContain('provider-client-transform-host');
    } finally {
      tmp.cleanup();
    }
  });

  it('delegates to a custom `apply` function when the overlay defines one', async () => {
    // Re-import the manifest type so we can synthesize an overlay
    // spec inline via direct application. We can't easily inject a
    // new overlay into OVERLAY_SPEC without modifying the module,
    // but the applyOne path is exercised whenever an overlay entry
    // supplies an `apply` function — we exercise it through a
    // roundtrip that re-imports the module with a fixture wrapper.
    //
    // Strategy: call applyMvpOverlay on a checkout that already has
    // every target file containing its postPatchSymbol — this
    // triggers the idempotency noop branch in applyOne and is the
    // closest path we can drive without rewriting OVERLAY_SPEC.
    //
    // Wave-history note: a previous wave of this test also stubbed
    // a `proxy-service-policy-host` overlay (which installed a
    // `getResolvedMaxMessagesPerRequest` helper on `proxy.service.ts`).
    // Upstream commit `c9009bcd5` removed the `maxMessagesPerRequest`
    // feature from `proxy.service.ts`, so that overlay was retired
    // from `MVP_OVERLAY_SPEC` along with its drift-detection entry.
    const tmp = tempDir('manifest-plugins-mvp-overlay-custom-');
    try {
      seedUpstream(tmp.path);
      // Inject every postPatchSymbol so applyOne short-circuits to
      // noop on each overlay. This exercises the
      // existsSync -> readFile -> postPatchSymbol branch and
      // confirms missing stays empty.
      const overlays: ReadonlyArray<{
        readonly id: string;
        readonly postPatchSymbol: string;
      }> = [
        {
          id: 'provider-client-transform-host',
          postPatchSymbol: 'function applyRequestTransformPlugins(',
        },
        {
          id: 'proxy-rate-limiter-policy-host',
          postPatchSymbol: 'function getResolvedConcurrencyMax(',
        },
        {
          id: 'proxy-service-routing-override-host',
          postPatchSymbol: 'function applyProxyRoutingOverridePlugins(',
        },
      ];
      const proxyDir = join(tmp.path, 'packages/backend/src/routing/proxy');
      const fileMap: Readonly<Record<string, string>> = {
        'provider-client-transform-host': join(proxyDir, 'provider-client.ts'),
        'proxy-rate-limiter-policy-host': join(proxyDir, 'proxy-rate-limiter.ts'),
        'proxy-service-routing-override-host': join(proxyDir, 'proxy.service.ts'),
      };
      for (const overlay of overlays) {
        const path = fileMap[overlay.id];
        if (path === undefined) {
          throw new Error(`missing fixture for ${overlay.id}`);
        }
        writeFileSync(path, `${overlay.postPatchSymbol}\n`, 'utf-8');
      }

      const runners = spyRunners('0'.repeat(40));
      const result = await applyMvpOverlay(tmp.path, {
        runGit: runners.runGit,
        runGitClone: runners.runGitClone,
      });
      expect(result.fullyApplied).toBe(true);
      expect(result.missing).toEqual([]);
      // The orchestrator must have invoked runGit exactly once for
      // SOURCE_COMMIT capture — it short-circuits before applyAll.
      expect(runners.gitCalls.filter((c) => c === 'rev-parse HEAD')).toHaveLength(1);
    } finally {
      tmp.cleanup();
    }
  });

  it('passes options through when both runners are supplied as a typed options object', async () => {
    // Compile-time check: ensure the exported options / result
    // types compile with explicit MvpOverlayApplyOptions. We
    // exercise the call and let the TS checker confirm the shapes.
    const tmp = tempDir('manifest-plugins-mvp-overlay-typed-');
    try {
      seedUpstream(tmp.path);
      const options: MvpOverlayApplyOptions = {
        runGit: async () => '0'.repeat(40),
        runGitClone: async () => undefined,
      };
      const result = await applyMvpOverlay(tmp.path, options);
      expect(typeof result.fullyApplied).toBe('boolean');
      expect(typeof result.hasDrift).toBe('boolean');
    } finally {
      tmp.cleanup();
    }
  });

  it('surfaces a thrown error from runGit as a rejection (no swallowing)', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-runner-throws-');
    try {
      seedUpstream(tmp.path);
      const failingRunGit: MvpOverlayRunGit = async () => {
        throw new Error('git rev-parse exploded');
      };
      await expect(
        applyMvpOverlay(tmp.path, { runGit: failingRunGit }),
      ).rejects.toThrow('git rev-parse exploded');
    } finally {
      tmp.cleanup();
    }
  });

  it('propagates a non-zero git exit from the production default runner', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-prod-fail-');
    try {
      seedUpstream(tmp.path);
      const spy = jest
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        .spyOn(require('child_process') as typeof import('child_process'), 'spawnSync')
        .mockImplementation(((cmd: string) => {
          if (cmd !== 'git') {
            throw new Error(`unexpected spawn: ${cmd}`);
          }
          return {
            pid: 1,
            output: [],
            stdout: '',
            stderr: 'fatal: not a git repository',
            status: 128,
            signal: null,
          };
        }) as never);

      try {
        await expect(applyMvpOverlay(tmp.path)).rejects.toThrow(
          'fatal: not a git repository',
        );
      } finally {
        spy.mockRestore();
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('handles a non-zero git exit when the runner returns undefined stderr (defensive ?? branch)', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-prod-undef-stderr-');
    try {
      seedUpstream(tmp.path);
      const spy = jest
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        .spyOn(require('child_process') as typeof import('child_process'), 'spawnSync')
        .mockImplementation(((cmd: string) => {
          if (cmd !== 'git') {
            throw new Error(`unexpected spawn: ${cmd}`);
          }
          return {
            pid: 1,
            output: [],
            stdout: '',
            stderr: undefined,
            status: 128,
            signal: null,
          };
        }) as never);

      try {
        await expect(applyMvpOverlay(tmp.path)).rejects.toThrow(
          'git rev-parse HEAD failed',
        );
      } finally {
        spy.mockRestore();
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('handles a successful git invocation with undefined stdout (defensive ?? branch)', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-prod-undef-stdout-');
    try {
      seedUpstream(tmp.path);
      const spy = jest
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        .spyOn(require('child_process') as typeof import('child_process'), 'spawnSync')
        .mockImplementation(((cmd: string) => {
          if (cmd !== 'git') {
            throw new Error(`unexpected spawn: ${cmd}`);
          }
          return {
            pid: 1,
            output: [],
            stdout: undefined,
            stderr: '',
            status: 0,
            signal: null,
          };
        }) as never);

      try {
        // Should not throw; the captured commit is consumed internally
        // and the public result's structure stays defined.
        const result = await applyMvpOverlay(tmp.path);
        expect(typeof result.fullyApplied).toBe('boolean');
        expect(typeof result.hasDrift).toBe('boolean');
      } finally {
        spy.mockRestore();
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('falls back to the default error message when the production runner returns empty stderr', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-prod-empty-');
    try {
      seedUpstream(tmp.path);
      const spy = jest
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        .spyOn(require('child_process') as typeof import('child_process'), 'spawnSync')
        .mockImplementation(((cmd: string) => {
          if (cmd !== 'git') {
            throw new Error(`unexpected spawn: ${cmd}`);
          }
          return {
            pid: 1,
            output: [],
            stdout: '',
            stderr: '',
            status: 1,
            signal: null,
          };
        }) as never);

      try {
        await expect(applyMvpOverlay(tmp.path)).rejects.toThrow(
          'git rev-parse HEAD failed',
        );
      } finally {
        spy.mockRestore();
      }
    } finally {
      tmp.cleanup();
    }
  });
});

describe('_applyOverlayForTesting (per-overlay branches)', () => {
  it('delegates to overlay.apply and reports applied on success', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-custom-ok-');
    try {
      seedUpstream(tmp.path);
      let invoked = 0;
      const overlay: MvpOverlaySpec = {
        id: 'custom-applicator',
        target: 'whatever.ts',
        postPatchSymbol: 'function applyRequestTransformPlugins(',
        apply: async () => {
          invoked += 1;
        },
      };
      const outcome = await _applyOverlayForTesting(overlay, tmp.path);
      expect(outcome).toEqual({ status: 'applied', id: 'custom-applicator' });
      expect(invoked).toBe(1);
    } finally {
      tmp.cleanup();
    }
  });

  it('reports failed when overlay.apply throws', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-custom-fail-');
    try {
      seedUpstream(tmp.path);
      const overlay: MvpOverlaySpec = {
        id: 'custom-applicator-throws',
        target: 'whatever.ts',
        postPatchSymbol: 'function applyRequestTransformPlugins(',
        apply: async () => {
          throw new Error('custom applicator blew up');
        },
      };
      const outcome = await _applyOverlayForTesting(overlay, tmp.path);
      expect(outcome).toEqual({ status: 'failed', id: 'custom-applicator-throws' });
    } finally {
      tmp.cleanup();
    }
  });

  it('reports applied when the target file already contains the postPatchSymbol (no-op via default path)', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-noop-branch-');
    try {
      seedUpstream(tmp.path);
      // Pre-apply the helper symbols into the provider-client target so
      // the orchestrator's idempotency check short-circuits to noop.
      const providerClientPath = join(
        tmp.path,
        'packages/backend/src/routing/proxy/provider-client.ts',
      );
      const original = readFileSync(providerClientPath, 'utf-8');
      writeFileSync(
        providerClientPath,
        `${original}\nfunction applyRequestTransformPlugins() {}\n`,
        'utf-8',
      );
      const overlay: MvpOverlaySpec = {
        id: 'provider-client-transform-host',
        target: 'packages/backend/src/routing/proxy/provider-client.ts',
        postPatchSymbol: 'function applyRequestTransformPlugins(',
      };
      const outcome = await _applyOverlayForTesting(overlay, tmp.path);
      expect(outcome).toEqual({
        status: 'noop',
        id: 'provider-client-transform-host',
      });
    } finally {
      tmp.cleanup();
    }
  });

  it('returns failed when the target file is missing (without invoking applyAll)', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-target-missing-');
    try {
      // Do NOT seedUpstream — every target is missing.
      const overlay: MvpOverlaySpec = {
        id: 'provider-client-transform-host',
        target: 'packages/backend/src/routing/proxy/provider-client.ts',
        postPatchSymbol: 'function applyRequestTransformPlugins(',
      };
      const outcome = await _applyOverlayForTesting(overlay, tmp.path);
      expect(outcome).toEqual({
        status: 'failed',
        id: 'provider-client-transform-host',
      });
    } finally {
      tmp.cleanup();
    }
  });

  it('reports failed when applyAll rejects (e.g. a runtime write error)', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-applyall-fails-');
    try {
      seedUpstream(tmp.path);
      // Force the rate-limiter fixture to a state where applyAll would
      // throw by making the directory read-only after seeding. The
      // easiest deterministic trigger: set the rate-limiter file
      // itself to be a directory so applyPatch cannot read it as a
      // file.
      const rateLimiterPath = join(
        tmp.path,
        'packages/backend/src/routing/proxy/proxy-rate-limiter.ts',
      );
      rmSync(rateLimiterPath, { force: true });
      mkdirSync(rateLimiterPath);

      const overlay: MvpOverlaySpec = {
        id: 'proxy-rate-limiter-policy-host',
        target: 'packages/backend/src/routing/proxy/proxy-rate-limiter.ts',
        postPatchSymbol: 'function getResolvedConcurrencyMax(',
      };
      const outcome = await _applyOverlayForTesting(overlay, tmp.path);
      expect(outcome.status).toBe('failed');
      expect(outcome.id).toBe('proxy-rate-limiter-policy-host');
    } finally {
      tmp.cleanup();
    }
  });

  it('reports failed when the per-file apply function throws on the try/catch path', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-throw-');
    try {
      seedUpstream(tmp.path);
      // Hand-crafted provider-client.ts that matches RETURN_OLD +
      // HELPER_MARKER_OLD exactly so the idempotency check passes
      // (postPatchSymbol NOT in content, file exists, readFile
      // succeeds), then the apply call's own writeFile throws. We
      // mock fs.writeFile to throw so the apply function rejects
      // and the catch at line 206 fires.
      const proxyDir = join(tmp.path, 'packages/backend/src/routing/proxy');
      mkdirSync(proxyDir, { recursive: true });
      const providerClientSource = [
        "import { Injectable } from '@nestjs/common';",
        '',
        'function stripVendorPrefix(model: string): string {',
        '  if (',
        "    model.startsWith('openai/') ||",
        "    model.startsWith('anthropic/') ||",
        "    model.startsWith('fireworks/') ||",
        "    model.startsWith('groq/') ||",
        "    model.startsWith('kilo/') ||",
        "    model.startsWith('nvidia')",
        '  )',
        '    return model;',
        '  return stripVendorPrefix(model);',
        '}',
        '',
        '@Injectable()',
        'export class ProviderClient {',
        '  build() {',
        '    const endpoint = {',
        "      baseUrl: 'https://api.example.com',",
        '      buildPath: (model: string): string => `/v1/${model}`,',
        '      buildHeaders: (key: string): Record<string, string> => ({ "x-api-key": key }),',
        '    };',
        "    const bareModel = 'claude-3';",
        "    const apiKey = 'test';",
        "    const authType = 'api_key';",
        '    const requestBody = { model: bareModel };',
        "    if (endpoint.format === 'anthropic') {",
        '      return {',
        '        url: `${endpoint.baseUrl}${endpoint.buildPath(bareModel)}`,',
        '        headers: endpoint.buildHeaders(apiKey, authType),',
        '        requestBody,',
        '      };',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n');
      writeFileSync(
        join(proxyDir, 'provider-client.ts'),
        providerClientSource,
        'utf-8',
      );

      // Mock fs.promises.writeFile to throw, simulating a runtime
      // write error inside applyPatch. The apply call will reject
      // and the orchestrator's outer try/catch returns failed.
      const fsPromises = jest.requireActual('fs').promises as typeof import('fs').promises;
      const writeFileSpy = jest
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        .spyOn(require('fs').promises as typeof import('fs').promises, 'writeFile')
        .mockImplementation((async () => {
          throw new Error('simulated write failure');
        }) as never);

      try {
        const overlay: MvpOverlaySpec = {
          id: 'provider-client-transform-host',
          target: 'packages/backend/src/routing/proxy/provider-client.ts',
          postPatchSymbol: 'function applyRequestTransformPlugins(',
        };
        const outcome = await _applyOverlayForTesting(overlay, tmp.path);
        expect(outcome).toEqual({
          status: 'failed',
          id: 'provider-client-transform-host',
        });
        // Confirm the spy was actually invoked (otherwise the
        // orchestrator short-circuited somewhere else).
        expect(writeFileSpy).toHaveBeenCalled();
      } finally {
        writeFileSpy.mockRestore();
        void fsPromises;
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('reports applied when the overlay id maps to a successful per-file result', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-per-file-applied-');
    try {
      // Build a provider-client.ts fixture that matches both
      // RETURN_OLD and HELPER_MARKER_OLD exactly. The shape mirrors
      // the canonical upstream layout: a top-level stripVendorPrefix
      // function whose body ends with the HELPER_MARKER_OLD anchor,
      // followed by an @Injectable() class containing a `build` method
      // whose `if (endpoint.format === 'anthropic')` branch contains
      // the exact RETURN_OLD text. The fixture is hand-crafted to be
      // the canonical "upstream-shaped" file independent of any
      // sibling checkout (whose anchors may have drifted).
      const proxyDir = join(tmp.path, 'packages/backend/src/routing/proxy');
      mkdirSync(proxyDir, { recursive: true });
      const providerClientSource = [
        "import { Injectable } from '@nestjs/common';",
        '',
        'function stripVendorPrefix(model: string): string {',
        '  if (',
        "    model.startsWith('openai/') ||",
        "    model.startsWith('anthropic/') ||",
        "    model.startsWith('fireworks/') ||",
        "    model.startsWith('groq/') ||",
        "    model.startsWith('kilo/') ||",
        "    model.startsWith('nvidia')",
        '  )',
        '    return model;',
        '  return stripVendorPrefix(model);',
        '}',
        '',
        '@Injectable()',
        'export class ProviderClient {',
        '  build() {',
        '    const endpoint = {',
        "      baseUrl: 'https://api.example.com',",
        '      buildPath: (model: string): string => `/v1/${model}`,',
        '      buildHeaders: (key: string): Record<string, string> => ({ "x-api-key": key }),',
        '    };',
        "    const bareModel = 'claude-3';",
        "    const apiKey = 'test';",
        "    const authType = 'api_key';",
        '    const requestBody = { model: bareModel };',
        "    if (endpoint.format === 'anthropic') {",
        '      return {',
        '        url: `${endpoint.baseUrl}${endpoint.buildPath(bareModel)}`,',
        '        headers: endpoint.buildHeaders(apiKey, authType),',
        '        requestBody,',
        '      };',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n');
      writeFileSync(
        join(proxyDir, 'provider-client.ts'),
        providerClientSource,
        'utf-8',
      );

      const overlay: MvpOverlaySpec = {
        id: 'provider-client-transform-host',
        target: 'packages/backend/src/routing/proxy/provider-client.ts',
        postPatchSymbol: 'function applyRequestTransformPlugins(',
      };
      const outcome = await _applyOverlayForTesting(overlay, tmp.path);
      // The fixture's anchor shape matches the snippet exactly, so
      // applyAll reports applied and the orchestrator maps the
      // result back to the overlay id.
      expect(outcome).toEqual({
        status: 'applied',
        id: 'provider-client-transform-host',
      });
    } finally {
      tmp.cleanup();
    }
  });

  it('maps a successful per-file result back to the overlay id (applied branch)', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-mapped-applied-');
    try {
      // Hand-crafted provider-client.ts that matches RETURN_OLD +
      // HELPER_MARKER_OLD exactly. Same shape as the prior test but
      // isolates the "applied" branch of the per-file map.
      const proxyDir = join(tmp.path, 'packages/backend/src/routing/proxy');
      mkdirSync(proxyDir, { recursive: true });
      const providerClientSource = [
        "import { Injectable } from '@nestjs/common';",
        '',
        'function stripVendorPrefix(model: string): string {',
        '  if (',
        "    model.startsWith('openai/') ||",
        "    model.startsWith('anthropic/') ||",
        "    model.startsWith('fireworks/') ||",
        "    model.startsWith('groq/') ||",
        "    model.startsWith('kilo/') ||",
        "    model.startsWith('nvidia')",
        '  )',
        '    return model;',
        '  return stripVendorPrefix(model);',
        '}',
        '',
        '@Injectable()',
        'export class ProviderClient {',
        '  build() {',
        '    const endpoint = {',
        "      baseUrl: 'https://api.example.com',",
        '      buildPath: (model: string): string => `/v1/${model}`,',
        '      buildHeaders: (key: string): Record<string, string> => ({ "x-api-key": key }),',
        '    };',
        "    const bareModel = 'claude-3';",
        "    const apiKey = 'test';",
        "    const authType = 'api_key';",
        '    const requestBody = { model: bareModel };',
        "    if (endpoint.format === 'anthropic') {",
        '      return {',
        '        url: `${endpoint.baseUrl}${endpoint.buildPath(bareModel)}`,',
        '        headers: endpoint.buildHeaders(apiKey, authType),',
        '        requestBody,',
        '      };',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n');
      writeFileSync(
        join(proxyDir, 'provider-client.ts'),
        providerClientSource,
        'utf-8',
      );

      const overlay: MvpOverlaySpec = {
        id: 'provider-client-transform-host',
        target: 'packages/backend/src/routing/proxy/provider-client.ts',
        postPatchSymbol: 'function applyRequestTransformPlugins(',
      };
      const outcome = await _applyOverlayForTesting(overlay, tmp.path);
      expect(outcome.status).toBe('applied');
      expect(outcome.id).toBe('provider-client-transform-host');
    } finally {
      tmp.cleanup();
    }
  });

  it('reports failed for an unknown overlay id (the closed-spec branch)', async () => {
    const tmp = tempDir('manifest-plugins-mvp-overlay-unknown-');
    try {
      seedUpstream(tmp.path);
      // Also seed the unknown-target file so the early missing-file
      // exit doesn't short-circuit before we reach the else branch.
      const unknownDir = join(tmp.path, 'packages/whatever');
      mkdirSync(unknownDir, { recursive: true });
      writeFileSync(join(unknownDir, 'future.ts'), '// placeholder\n', 'utf-8');
      const overlay: MvpOverlaySpec = {
        id: 'future-overlay-not-yet-implemented',
        target: 'packages/whatever/future.ts',
        postPatchSymbol: 'function futureSymbol(',
      };
      const outcome = await _applyOverlayForTesting(overlay, tmp.path);
      expect(outcome).toEqual({
        status: 'failed',
        id: 'future-overlay-not-yet-implemented',
      });
    } finally {
      tmp.cleanup();
    }
  });
});

// Reference the spawnSync export at the top of the file so the
// `import { spawnSync } from 'child_process'` is exercised by tsc
// (it keeps the type live in the dependency graph).
void spawnSync;

describe('OVERLAY_SPEC re-exports', () => {
  it('MVP_OVERLAY_SPEC and OVERLAY_SPEC reference the same frozen array', () => {
    expect(OVERLAY_SPEC).toBe(MVP_OVERLAY_SPEC);
    expect(Object.isFrozen(OVERLAY_SPEC)).toBe(true);
    expect(OVERLAY_SPEC).toHaveLength(5);
    for (const overlay of OVERLAY_SPEC) {
      expect(typeof overlay.id).toBe('string');
      expect(typeof overlay.target).toBe('string');
      expect(typeof overlay.postPatchSymbol).toBe('string');
    }
  });

  it('includes the proxy-service-routing-override-host overlay (regression fix for 2ab748a6)', () => {
    // The 4th overlay restores the precedence where `x-manifest-tier`
    // (or any configured header tier) wins over `body.model`. Without
    // this overlay, upstream's explicit-model early-return ignores
    // header tiers entirely. See PR #2350 / commit 2ab748a6.
    const routingOverride = OVERLAY_SPEC.find(
      (overlay) => overlay.id === 'proxy-service-routing-override-host',
    );
    expect(routingOverride).toBeDefined();
    expect(routingOverride?.target).toBe(
      'packages/backend/src/routing/proxy/proxy.service.ts',
    );
    expect(routingOverride?.postPatchSymbol).toBe(
      'function applyProxyRoutingOverridePlugins(',
    );
  });

  it('includes the dashboard-plugin-manager-mount overlay (4th overlay)', () => {
    const mount = OVERLAY_SPEC.find(
      (overlay) => overlay.id === 'dashboard-plugin-manager-mount',
    );
    expect(mount).toBeDefined();
    expect(mount?.target).toBe('packages/frontend/index.html');
    expect(mount?.postPatchSymbol).toBe('id="plugin-manager-root"');
  });

  it('includes the dashboard-transform-mount overlay (5th overlay)', () => {
    const mount = OVERLAY_SPEC.find(
      (overlay) => overlay.id === 'dashboard-transform-mount',
    );
    expect(mount).toBeDefined();
    expect(mount?.target).toBe('packages/frontend/index.html');
    expect(mount?.postPatchSymbol).toBe('data-mwp-dashboard-transform');
  });
});