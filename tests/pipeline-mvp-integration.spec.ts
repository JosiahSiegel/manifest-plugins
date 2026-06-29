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
    content:
      'function getResolvedMaxMessagesPerRequest() { return Infinity; }\n' +
      "import { ProviderParamSpecService } from '../routing-core/provider-param-spec.service';\n" +
      "import { HeaderTierService } from '../header-tiers/header-tier.service';\n" +
      'function applyProxyRoutingOverridePlugins() {}\n' +
      '    private readonly providerParamSpecs: ProviderParamSpecService,\n' +
      '    private readonly headerTierService: HeaderTierService,\n' +
      '  ) {\n',
  },
] as const;

/**
 * Minimal upstream-shaped `proxy.service.ts` carrying the
 * `2ab748a6` explicit-model early-return anchor so the apply CLI's
 * `applyAllFour` path can install the routing-override hook
 * (Blocker #1). Mirrors the synthesized fixture shape used by
 * `tests/apply.spec.ts::applyProxyRoutingOverrideHost` so the CLI
 * integration test exercises the same upstream contract.
 */
const UPSTREAM_PROXY_SERVICE_FIXTURE = [
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
  "    return { tier: 'default', route: null };",
  '  }',
  '}',
  '',
].join('\n');

function writeUpstreamShapedManifestFixture(root: string): void {
  for (const file of PATCHED_MANIFEST_FILES) {
    const target = join(root, file.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    if (file.relativePath === 'packages/backend/src/routing/proxy/proxy.service.ts') {
      writeFileSync(target, UPSTREAM_PROXY_SERVICE_FIXTURE, 'utf-8');
    } else {
      writeFileSync(target, file.content, 'utf-8');
    }
  }
}

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

describe('apply CLI installs the routing-override hook by default (Blocker #1)', () => {
  it('default `npm run apply` installs the routing-override helper in proxy.service.ts', () => {
    // Blocker #1 contract: the default apply path (no `--apply-overlay`)
    // MUST install the routing-override hook on `proxy.service.ts`.
    // Before the fix this CLI used `applyAll` (3-file installer), which
    // skipped the routing-override patch entirely.
    const tmp = tempDir('manifest-apply-cli-routing-override-');
    try {
      writeUpstreamShapedManifestFixture(tmp);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MANIFEST_URL: '',
        MANIFEST_DIR: '',
        MANIFEST_CHECKOUT: '',
        MANIFEST_FORK: '',
        MVP_UI: '',
      };
      const result = run(process.execPath, [TSX_CLI, 'src/host/cli.ts', tmp], env, REPO_ROOT);

      if (result.status !== 0) {
        throw new Error(
          `expected apply CLI to succeed with the upstream-shaped fixture\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      const proxyService = readFileSync(
        join(tmp, 'packages/backend/src/routing/proxy/proxy.service.ts'),
        'utf-8',
      );
      // The routing-override host hook MUST be installed.
      expect(proxyService).toContain('function applyProxyRoutingOverridePlugins(');
      // The constructor MUST be extended with the headerTierService param.
      expect(proxyService).toContain(
        'private readonly headerTierService: HeaderTierService,',
      );
      // The HeaderTierService import MUST be added.
      expect(proxyService).toContain(
        "import { HeaderTierService } from '../header-tiers/header-tier.service';",
      );
      // The plugin call must appear BEFORE the explicit-model early-return.
      const pluginIdx = proxyService.indexOf('applyProxyRoutingOverridePlugins(');
      const earlyReturnIdx = proxyService.indexOf(
        "if (apiMode !== 'messages' && requestedModel && requestedModel !== OPENAI_MODEL_ID_AUTO) {",
      );
      expect(pluginIdx).toBeGreaterThanOrEqual(0);
      expect(earlyReturnIdx).toBeGreaterThanOrEqual(0);
      expect(pluginIdx).toBeLessThan(earlyReturnIdx);
    } finally {
      cleanup(tmp);
    }
  });

  it('cli.ts source imports `applyAllFour` (regression lock for the four-file installer)', () => {
    // Blocker #1 regression lock: the CLI module MUST import
    // `applyAllFour` (not just `applyAll`). This is a static-source
    // assertion so a future refactor cannot silently revert to the
    // three-file installer.
    const cli = readFileSync(join(REPO_ROOT, 'src/host/cli.ts'), 'utf-8');
    expect(cli).toMatch(/import\s*\{[^}]*\bapplyAllFour\b[^}]*\}\s*from\s*['"]\.\/apply['"]/);
  });

  it('cli.ts source calls `applyAllFour` (not `applyAll`) in the default path', () => {
    // Regression lock for the production default. The CLI's main
    // function must invoke `applyAllFour(checkoutPath, ...)` so the
    // routing-override hook is part of the default apply surface.
    const cli = readFileSync(join(REPO_ROOT, 'src/host/cli.ts'), 'utf-8');
    expect(cli).toMatch(/await\s+applyAllFour\s*\(/);
    expect(cli).not.toMatch(/await\s+applyAll\s*\(\s*checkoutPath\s*\)/);
  });
});

describe('host/verify.ts reads routing-override sentinels from proxy.service.ts (Blocker #2)', () => {
  it('verify.ts source resolves a proxy.service.ts path alongside provider-client.ts', () => {
    // Blocker #2 regression lock: the verifier MUST read
    // `proxy.service.ts` (in addition to `provider-client.ts`) so it
    // can confirm the routing-override host was installed. Without
    // this, `npm run verify` only checks the request-transform hook
    // and silently passes when the routing-override hook is missing.
    const verify = readFileSync(
      join(REPO_ROOT, 'src/host/verify.ts'),
      'utf-8',
    );
    expect(verify).toMatch(/proxy\.service\.ts/);
  });

  it('verify.ts source reads the routing-override helper sentinel `function applyProxyRoutingOverridePlugins(`', () => {
    const verify = readFileSync(
      join(REPO_ROOT, 'src/host/verify.ts'),
      'utf-8',
    );
    expect(verify).toContain('function applyProxyRoutingOverridePlugins(');
  });

  it('verify.ts source reads the routing-override constructor param `private readonly headerTierService: HeaderTierService,`', () => {
    const verify = readFileSync(
      join(REPO_ROOT, 'src/host/verify.ts'),
      'utf-8',
    );
    expect(verify).toContain(
      'private readonly headerTierService: HeaderTierService,',
    );
  });

  it('verify.ts preserves the existing provider-client sentinels (request-transform hook)', () => {
    // The existing checks for the request-transform hook (provider-client)
    // must remain — Blocker #2 fixes the verifier by ADDING the proxy.service
    // checks, not by removing the provider-client ones.
    const verify = readFileSync(
      join(REPO_ROOT, 'src/host/verify.ts'),
      'utf-8',
    );
    expect(verify).toContain('function applyRequestTransformPlugins(');
    expect(verify).toContain('const transformed = applyRequestTransformPlugins(');
  });

  it('verify.ts integration: succeeds when both files carry their host hooks; fails when proxy.service.ts is unpatched', () => {
    // End-to-end: build a tempdir with both patched files and run the
    // verifier. Then drop the routing-override hook from
    // `proxy.service.ts` and assert the verifier reports the missing
    // hook. Pre-fix, this test failed because the verifier only read
    // `provider-client.ts` and the proxy.service.ts file was never
    // inspected.
    const tmp = tempDir('manifest-verify-routing-override-');
    try {
      // Patch provider-client.ts with the request-transform hook
      // (so the existing verifier path passes), and write
      // proxy.service.ts carrying both the message-cap helper AND the
      // routing-override helper + constructor param.
      const providerClientTarget = join(
        tmp,
        'packages/backend/src/routing/proxy/provider-client.ts',
      );
      const proxyServiceTarget = join(
        tmp,
        'packages/backend/src/routing/proxy/proxy.service.ts',
      );
      mkdirSync(dirname(providerClientTarget), { recursive: true });
      mkdirSync(dirname(proxyServiceTarget), { recursive: true });

      writeFileSync(
        providerClientTarget,
        'function applyRequestTransformPlugins(){}\nconst transformed = applyRequestTransformPlugins();\n',
        'utf-8',
      );
      writeFileSync(
        proxyServiceTarget,
        [
          'function getResolvedMaxMessagesPerRequest(){return Infinity;}',
          "import { HeaderTierService } from '../header-tiers/header-tier.service';",
          'function applyProxyRoutingOverridePlugins(){}',
          'private readonly headerTierService: HeaderTierService,',
          '',
        ].join('\n'),
        'utf-8',
      );

      const passEnv: NodeJS.ProcessEnv = {
        ...process.env,
        // The verifier reads `MANIFEST_CHECKOUT` from argv[2] or env.
        // Point it at the tempdir via env so we don't depend on argv
        // shape across shells.
        MANIFEST_CHECKOUT: tmp,
        MVP_UI: '',
      };

      const okResult = run(process.execPath, [TSX_CLI, 'src/host/verify.ts'], passEnv, REPO_ROOT);
      // The verifier should report OK and exit 0 when both hooks
      // are present. Pre-fix this would have exited 0 too (because
      // the verifier never read proxy.service.ts), so we rely on
      // the stdout message shape to detect the fix.
      expect(okResult.stdout).toMatch(/OK/);
      expect(okResult.stdout).toMatch(/routing-override hook/);

      // Now drop the routing-override helper from proxy.service.ts
      // and re-run. The verifier MUST report the missing hook and
      // exit non-zero.
      writeFileSync(
        proxyServiceTarget,
        [
          'function getResolvedMaxMessagesPerRequest(){return Infinity;}',
          "import { HeaderTierService } from '../header-tiers/header-tier.service';",
          'private readonly headerTierService: HeaderTierService,',
          '',
        ].join('\n'),
        'utf-8',
      );

      const failResult = run(
        process.execPath,
        [TSX_CLI, 'src/host/verify.ts'],
        passEnv,
        REPO_ROOT,
      );
      expect(failResult.status).not.toBe(0);
      expect(failResult.stderr).toMatch(/routing-override/);
    } finally {
      cleanup(tmp);
    }
  });
});

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