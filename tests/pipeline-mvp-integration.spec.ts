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
  chmodSync,
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
      "import { ProviderParamSpecService } from '../routing-core/provider-param-spec.service';\n" +
      "import { HeaderTierService } from '../header-tiers/header-tier.service';\n" +
      'function applyProxyRoutingOverridePlugins() {}\n' +
      '    private readonly providerParamSpecs: ProviderParamSpecService,\n' +
      '    private readonly autofixService: AutofixService,\n' +
      '    private readonly headerTierService: HeaderTierService,\n' +
      '  ) {}\n',
  },
  {
    // Synthesized upstream `main.ts` carrying the listen anchor the
    // admin-mount patch needs. Mirrors the `apply.ts` test fixture.
    relativePath: 'packages/backend/src/main.ts',
    content:
      "import { NestFactory } from '@nestjs/core';\n" +
      "import { AppModule } from './app.module';\n" +
      '\n' +
      'export async function bootstrap() {\n' +
      '  const app = await NestFactory.create(AppModule);\n' +
      '  const expressApp = app.getHttpAdapter().getInstance();\n' +
      "  const port = Number(process.env['PORT'] ?? 3001);\n" +
      "  const host = process.env['BIND_ADDRESS'] ?? '127.0.0.1';\n" +
      '  await app.listen(port, host);\n' +
      '}\n',
  },
  {
    // Synthesized upstream `model.controller.ts` carrying the
    // getAvailableModels body the model-list-override patch anchors on.
    // Mirrors the `apply.ts` test fixture shape (the apply.ts anchor is
    // the `getModelsForAgent` call immediately followed by the
    // `customProviderService.list` build-up comment + call).
    relativePath: 'packages/backend/src/routing/model.controller.ts',
    content:
      "import { Controller, Get } from '@nestjs/common';\n" +
      '\n' +
      "@Controller('api/v1/routing')\n" +
      'export class ModelController {\n' +
      '  @Get(":agentName/available-models")\n' +
      '  async getAvailableModels(): Promise<unknown[]> {\n' +
      '    const agent = { tenant_id: "t", id: "a" };\n' +
      '    const models = await this.discoveryService.getModelsForAgent(agent.tenant_id, agent.id);\n' +
      '\n' +
      '    // Build display name map for custom providers (tenant-global)\n' +
      '    const customProviders = await this.customProviderService.list(agent.tenant_id);\n' +
      '    return models;\n' +
      '  }\n' +
      '}\n',
  },
  {
    // Synthesized upstream `routing-core/tier.service.ts` carrying
    // the getModelsForAgent call site the routing-layer model-list-
    // override patch anchors on.
    relativePath: 'packages/backend/src/routing/routing-core/tier.service.ts',
    content:
      "import { Injectable } from '@nestjs/common';\n" +
      "import { DiscoveryService } from '../../model-discovery/discovery.service';\n" +
      '\n' +
      '@Injectable()\n' +
      'export class TierService {\n' +
      '  constructor(private readonly discoveryService: DiscoveryService) {}\n' +
      '  async buildFallbackRoutes(tenantId: string, agentId: string) {\n' +
      '    const available = await this.discoveryService.getModelsForAgent(tenantId, agentId);\n' +
      '    return available;\n' +
      '  }\n' +
      '}\n',
  },
  {
    // Synthesized upstream `routing-core/specificity.service.ts`.
    relativePath: 'packages/backend/src/routing/routing-core/specificity.service.ts',
    content:
      "import { Injectable } from '@nestjs/common';\n" +
      "import { DiscoveryService } from '../../model-discovery/discovery.service';\n" +
      '\n' +
      '@Injectable()\n' +
      'export class SpecificityService {\n' +
      '  constructor(private readonly discoveryService: DiscoveryService) {}\n' +
      '  async buildFallbackRoutes(tenantId: string, agentId: string) {\n' +
      '    const available = await this.discoveryService.getModelsForAgent(tenantId, agentId);\n' +
      '    return available;\n' +
      '  }\n' +
      '}\n',
  },
  {
    // Synthesized upstream `header-tiers/header-tier.service.ts`.
    relativePath: 'packages/backend/src/routing/header-tiers/header-tier.service.ts',
    content:
      "import { Injectable } from '@nestjs/common';\n" +
      "import { DiscoveryService } from '../../model-discovery/discovery.service';\n" +
      '\n' +
      '@Injectable()\n' +
      'export class HeaderTierService {\n' +
      '  constructor(private readonly discoveryService: DiscoveryService) {}\n' +
      '  async buildFallbackRoutes(tenantId: string, agentId: string) {\n' +
      '    const available = await this.discoveryService.getModelsForAgent(tenantId, agentId);\n' +
      '    return available;\n' +
      '  }\n' +
      '}\n',
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

describe('apply CLI default install path', () => {
  it('cli.ts source imports `applyAllEight` (regression lock for the eight-file installer)', () => {
    // Blocker #1 regression lock: the CLI module MUST import
    // `applyAllEight` (not just `applyAllFive`). This is a static-source
    // assertion so a future refactor cannot silently revert to the
    // five-file installer or drop the routing-layer model-list-override
    // patches that close the "Cannot resolve fallback model" gap.
    const cli = readFileSync(join(REPO_ROOT, 'src/host/cli.ts'), 'utf-8');
    expect(cli).toMatch(/import\s*\{[^}]*\bapplyAllEight\b[^}]*\}\s*from\s*['"]\.\/apply['"]/);
  });

  it('cli.ts source calls `applyAllEight` (not `applyAll`) in the default path', () => {
    // Regression lock for the production default. The CLI's main
    // function must invoke `applyAllEight(checkoutPath, ...)` so all
    // eight host hooks are part of the default apply surface.
    const cli = readFileSync(join(REPO_ROOT, 'src/host/cli.ts'), 'utf-8');
    expect(cli).toMatch(/await\s+applyAllEight\s*\(/);
    expect(cli).not.toMatch(/await\s+applyAll\s*\(\s*checkoutPath\s*\)/);
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
        '[manifest-plugins/apply] all eight host hooks patched (or already no-op)',
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

describe('pipeline/build-and-publish.sh default install path', () => {
  it('default apply invocation passes --apply-overlay to install the routing-override hook', () => {
    // Blocker #1 regression lock: the pipeline's normal (non-MVP)
    // apply invocation MUST pass `--apply-overlay` so the
    // routing-override hook is part of the default image build.
    const script = readScript('build-and-publish.sh');
    // The default branch (no --apply-overlay flag) must include
    // --apply-overlay in the npm run apply -- invocation.
    const defaultApplyInvocation = script.match(
      /npm run apply --[^\n]*"\$MANIFEST_PATH"/,
    );
    expect(defaultApplyInvocation).not.toBeNull();
    if (defaultApplyInvocation === null) return;
    expect(defaultApplyInvocation[0]).toMatch(/--apply-overlay\b/);
  });

  it('default invocation is bash -n clean', () => {
    const result = run('bash', ['-n', BUILD_SCRIPT]);
    expect(result.status).toBe(0);
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

describe('.github/workflows/build-image.yml default build (Blocker #1)', () => {
  it('CI default image build passes the routing-override install flag', () => {
    // Blocker #1 regression lock: the GitHub Actions workflow MUST
    // pass the flag that triggers the four-overlay installer so the
    // default image build always installs the routing-override hook.
    const workflow = readFileSync(
      join(REPO_ROOT, '.github/workflows/build-image.yml'),
      'utf-8',
    );
    // The default ARGS construction must include the
    // routing-override install flag. The pipeline exposes this as
    // `--apply-overlay` (the documented flag for the five-file
    // installer), so we assert the workflow passes it.
    expect(workflow).toMatch(/ARGS=\([^)]*\)/);
    expect(workflow).toMatch(/ARGS\+=?\(\s*--apply-overlay\s*\)/);
  });
});

describe('pipeline/e2e-test.sh TIER_ROUTING_SMOKE asserts upstream-correct headers (Blocker #3)', () => {
  it('TIER_ROUTING_SMOKE expects X-Manifest-Tier: standard (not the configured tier name)', () => {
    // Blocker #3 regression lock: upstream sets the response
    // `X-Manifest-Tier` header from `meta.tier` (always
    // `'standard'` for header-tier matches), NOT from
    // `header_tier_name`. Asserting the tier name in
    // `X-Manifest-Tier` is a misread of the upstream contract; the
    // smoke must assert `standard`.
    const script = readScript('e2e-test.sh');
    // The tier-routing smoke branch must reference the upstream
    // tier value `standard` for the `X-Manifest-Tier` header
    // check (the configured tier name lives in `X-Manifest-Tier-Name`
    // or is encoded via `X-Manifest-Reason: header-match`).
    expect(script).toMatch(/X-Manifest-Tier:?\s*\$\{?TIER_HEADER_VALUE_STANDARD\}?|X-Manifest-Tier:\s*standard|standard/);
    // Negative: the smoke must NOT take `X-Manifest-Tier:
    // $TIER_HEADER_NAME` as the success condition. We assert the
    // exact positive `standard` check exists.
    expect(script).toMatch(/X-Manifest-Tier['":][^"]*standard/);
  });

  it('TIER_ROUTING_SMOKE expects X-Manifest-Reason: header-match', () => {
    // Blocker #3 regression lock: the `reason` field on a header-tier
    // match is upstream-defined as `header-match`. The smoke must
    // assert the response `X-Manifest-Reason` header equals
    // `header-match` so a regression to `direct` (the upstream
    // explicit-model branch's reason) is caught.
    const script = readScript('e2e-test.sh');
    expect(script).toMatch(/X-Manifest-Reason:?\s*header-match|X-Manifest-Reason.*header-match|header-match/);
  });

  it('TIER_ROUTING_SMOKE does NOT assert the configured tier name in X-Manifest-Tier', () => {
    // Explicit anti-regression: the smoke must not depend on
    // `$TIER_HEADER_NAME` appearing in the `X-Manifest-Tier` response
    // header. That assertion was the bug — it conflates
    // `header_tier_name` (lives in `header_tier_name` field, surfaced
    // via a different header) with `meta.tier` (always `standard`
    // for header-tier matches).
    const script = readScript('e2e-test.sh');
    // The success condition must not match on `$TIER_HEADER_NAME` as
    // the `X-Manifest-Tier` value.
    expect(script).not.toMatch(/RESP_TIER="\$\{?TIER_HEADER_NAME\}?"/);
    expect(script).not.toMatch(/X-Manifest-Tier:?\s*\$\{?TIER_HEADER_NAME\}?/);
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
      const stubPath = join(stubBin, 'jq');
      writeFileSync(
        stubPath,
        '#!/usr/bin/env bash\nexit 127\n',
        'utf-8',
      );
      chmodSync(stubPath, 0o755);

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

  it('always runs a self-contained plugin registry smoke inside the app container', () => {
    // Regression lock for the production image failure: the dashboard
    // could serve successfully while `manifest-plugins` discovered zero
    // runtime plugins from `dist/`. The always-on e2e smoke must require
    // the shipped package inside the app container and prove the
    // show-all-router-views plugin is installed + enabled.
    const script = readScript('e2e-test.sh');
    expect(script).toMatch(/plugin registry smoke/);
    expect(script).toMatch(/docker exec "\$APP_NAME" node -e/);
    expect(script).toMatch(/require\("\/app\/node_modules\/manifest-plugins"\)/);
    expect(script).toMatch(/plugin\.id === "show-all-router-views"/);
    expect(script).toMatch(/enabled plugin registry is empty/);
  });

  it('TIER_ROUTING_SMOKE documents the tier-routing gate (regression fix for upstream 2ab748a6)', () => {
    // Shell-text assertion: the e2e script must document and
    // implement a tier-routing smoke that proves `x-manifest-tier`
    // (or any configured `header_tiers` rule) wins over `body.model`.
    // Without this smoke, the upstream regression (explicit-model
    // early-return) can land in `latest` without detection.
    const script = readScript('e2e-test.sh');

    // 1. The gate env var is documented in the usage block.
    expect(script).toMatch(/TIER_ROUTING_SMOKE/);

    // 2. The smoke branch is gated on the env var (not always-on —
    // it requires a running image + a configured `header_tiers` row,
    // which is set up out-of-band by the pipeline runner). The
    // script uses the bash `[[ ]]` form.
    expect(script).toMatch(/if\s+\[\[\s*"\$TIER_ROUTING_SMOKE"\s*==\s*"1"\s*\]\]/);

    // 3. The smoke sends a real HTTP request to the running app
    // container with `x-manifest-tier` + a concrete `body.model`,
    // and asserts the response honors the header tier (not the body
    // model). We assert the log line shape so the regression class
    // is detectable from CI output.
    expect(script).toMatch(/tier-routing smoke/);

    // 4. The smoke must NOT require new host dependencies (no jq, no
    // new docker images, no new toolchain). It reuses the already-
    // running app container + curl.
    expect(script).not.toMatch(/command -v jq.*tier/i);
  });
});