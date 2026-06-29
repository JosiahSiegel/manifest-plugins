/**
 * RED tests for the MVP overlay apply path.
 *
 * Locks down the expected directory shape of `src/overlays/mvp/` and
 * the contract of the new apply entry point:
 *
 *   1. `src/overlays/mvp/` exists as a directory under the plugins
 *      package.
 *   2. The directory contains at minimum a manifest (e.g.
 *      `manifest.ts` / `index.ts`) describing the MVP overlays and a
 *      `manifest.json` describing the per-patch metadata that the
 *      apply orchestrator consumes.
 *   3. A synthesized Manifest checkout under a tempdir accepts the
 *      overlays via the new apply path. The apply entry point must
 *      accept stub `runGit` / `runGitClone` injections so it can be
 *      exercised without network calls.
 *
 * These tests are intentionally RED today:
 *   - `src/overlays/mvp/` does not exist yet.
 *   - The new apply path is not yet wired (no exported
 *     `applyMvpOverlay` / `applyMvpOverlays` / `MvpOverlaySpec`
 *     symbols from `src/apply/mvp-overlay.ts`).
 *
 * Once the GREEN wave lands, the tests must pass without modifying
 * the assertions themselves.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..');
const OVERLAY_DIR = join(REPO_ROOT, 'src', 'overlays', 'mvp');

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('src/overlays/mvp/ directory shape', () => {
  it('exists as a directory under the plugins package', () => {
    expect(existsSync(OVERLAY_DIR)).toBe(true);
  });

  it('contains a manifest module exporting the MVP overlay spec', () => {
    // The MVP overlay package is expected to expose either
    // `src/overlays/mvp/manifest.ts` (TS) or `src/overlays/mvp/index.ts`
    // exporting `MvpOverlaySpec` (or a `manifest` const + an `apply`
    // function).
    const candidates = [
      join(OVERLAY_DIR, 'manifest.ts'),
      join(OVERLAY_DIR, 'index.ts'),
    ];
    const found = candidates.some((p) => existsSync(p));
    expect(found).toBe(true);
  });

  it('contains a per-patch manifest.json describing the overlays', () => {
    const manifestJson = join(OVERLAY_DIR, 'manifest.json');
    expect(existsSync(manifestJson)).toBe(true);
    const raw = readFileSync(manifestJson, 'utf-8');
    const parsed = JSON.parse(raw) as {
      readonly overlays?: ReadonlyArray<{
        readonly id?: string;
        readonly target?: string;
        readonly postPatchSymbol?: string;
      }>;
    };
    expect(Array.isArray(parsed.overlays)).toBe(true);
    expect(parsed.overlays!.length).toBeGreaterThan(0);
    for (const overlay of parsed.overlays!) {
      expect(typeof overlay.id).toBe('string');
      expect(typeof overlay.target).toBe('string');
      expect(typeof overlay.postPatchSymbol).toBe('string');
    }
  });
});

describe('MVP overlay apply path (synthesized Manifest checkout)', () => {
  // The MVP overlay apply entry point must be importable from
  // `src/apply/mvp-overlay.ts`. The function must accept a
  // `MvpOverlayApplyOptions` argument with optional `runGit` /
  // `runGitClone` so it can be exercised offline.
  //
  // We import via a dynamic require so the file path is known even
  // if the module doesn't exist yet (the require itself will throw
  // and the test will be RED, which is the goal).
  //
  // The module path is typed as `unknown` so the test suite still
  // compiles when the module is missing. Once the GREEN wave lands,
  // the require succeeds and `applyModule.applyMvpOverlay` resolves
  // to a callable function.
  let applyModule:
    | {
        readonly applyMvpOverlay: (
          path: string,
          options: {
            readonly runGit?: (
              args: readonly string[],
              options?: { readonly cwd?: string },
            ) => Promise<string>;
            readonly runGitClone?: (request: {
              readonly url: string;
              readonly ref?: string;
              readonly targetDir: string;
            }) => Promise<void>;
          },
        ) => Promise<{
          readonly fullyApplied: boolean;
          readonly hasDrift: boolean;
        }>;
      }
    | undefined;

  beforeAll(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      applyModule = require('../src/apply/mvp-overlay');
    } catch {
      applyModule = undefined;
    }
  });

  it('exports an applyMvpOverlay function', () => {
    expect(applyModule).toBeDefined();
    expect(typeof applyModule!.applyMvpOverlay).toBe('function');
  });

  it('accepts stub runGit / runGitClone injections without touching the network', async () => {
    expect(applyModule).toBeDefined();
    const tmp = tempDir('manifest-plugins-mvp-apply-');
    try {
      const upstreamFiles = {
        providerClient:
          'function stripVendorPrefix(model: string) {\n  return model;\n}\n\n@Injectable()\nexport class ProviderClient {\n  build() {\n    return {\n      url: "x",\n      headers: {},\n      requestBody: {},\n    };\n  }\n}\n',
        proxyRateLimiter:
          'const DEFAULT_CONCURRENCY_MAX = 10;\nconst CONCURRENCY_MAX = positiveIntegerEnv("CONCURRENCY_MAX", DEFAULT_CONCURRENCY_MAX);\n\n@Injectable()\nexport class ProxyRateLimiter implements OnModuleDestroy {\n  handle() {}\n}\n',
        proxyService:
          "import { parseMaxMessagesPerRequest } from './message-limit';\n\nexport class ProxyService {\n  constructor() {\n    const maxMessagesRaw =\n      process.env['MAX_MESSAGES_PER_REQUEST'] ??\n      this.config.get<string>('MANIFEST_MAX_MESSAGES');\n    this.maxMessagesPerRequest =\n      maxMessagesRaw === undefined || maxMessagesRaw === '' || maxMessagesRaw === '0'\n        ? Infinity\n        : parseMaxMessagesPerRequest(maxMessagesRaw);\n  }\n}\n",
      };
      mkdirSync(join(tmp, 'packages/backend/src/routing/proxy'), { recursive: true });
      writeFileSync(
        join(tmp, 'packages/backend/src/routing/proxy/provider-client.ts'),
        upstreamFiles.providerClient,
        'utf-8',
      );
      writeFileSync(
        join(tmp, 'packages/backend/src/routing/proxy/proxy-rate-limiter.ts'),
        upstreamFiles.proxyRateLimiter,
        'utf-8',
      );
      writeFileSync(
        join(tmp, 'packages/backend/src/routing/proxy/proxy.service.ts'),
        upstreamFiles.proxyService,
        'utf-8',
      );

      const calls: string[] = [];
      const stubRunGit = async (
        args: readonly string[],
      ): Promise<string> => {
        calls.push(args.join(' '));
        return '0123456789abcdef0123456789abcdef01234567';
      };
      const stubRunGitClone = async (_request: {
        readonly url: string;
        readonly ref?: string;
        readonly targetDir: string;
      }): Promise<void> => {
        calls.push('clone');
      };

      const result = await applyModule!.applyMvpOverlay(tmp, {
        runGit: stubRunGit,
        runGitClone: stubRunGitClone,
      });

      expect(result).toBeDefined();
      expect(typeof result.fullyApplied).toBe('boolean');
      expect(typeof result.hasDrift).toBe('boolean');
      // The stub git runner must have been called at least once
      // (rev-parse HEAD for SOURCE_COMMIT capture).
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});