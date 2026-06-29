#!/usr/bin/env node
/**
 * `npm run apply -- <manifest-checkout-path>`
 *
 * Locates a Manifest checkout and patches three files to install the
 * plugin host:
 *   - `packages/backend/src/routing/proxy/provider-client.ts`
 *   - `packages/backend/src/routing/proxy/proxy-rate-limiter.ts`
 *   - `packages/backend/src/routing/proxy/proxy.service.ts`
 *
 * Each patch is byte-exact against upstream/main and idempotent. The
 * tool fails loud if upstream restructures (anchor mismatch).
 *
 * Optional env / argv:
 *   - argv[2] or MANIFEST_CHECKOUT: path to the Manifest checkout.
 *   - --link : also `npm link` this package into the checkout's
 *              `packages/backend/node_modules` so `require('manifest-plugins')`
 *              resolves at runtime.
 *   - --apply-overlay: after `applyAll`, run the MVP overlay apply
 *              path (`src/apply/mvp-overlay.ts`). Exits non-zero if
 *              any overlay reports drift.
 *   - --manifest-url / --manifest-ref / --manifest-dir / --manifest-fork:
 *              pick a non-default Manifest source. Defaults to a fresh
 *              official clone (https://github.com/mnfst/manifest.git).
 *   - --mvp / MVP_UI=1: requires an explicit source — refuse to publish
 *              MVP UI against the implicit official clone.
 *
 * Exits 0 if all three patches applied (or were already no-op). Exits 1
 * if any file reported upstream drift (which is a real build failure —
 * the user must update `src/host/snippet.ts` to match new upstream shape).
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import { promises as fs } from 'fs';
import { applyAll, type ApplyResult } from './apply';
import {
  OFFICIAL_MANIFEST_URL,
  resolveManifestSource,
  type ManifestSource,
} from '../apply/source-resolver';

type ParsedArgs = {
  readonly checkoutPath?: string;
  readonly link: boolean;
  readonly mvp: boolean;
  readonly applyOverlay: boolean;
  readonly manifestUrl?: string;
  readonly manifestRef?: string;
  readonly manifestDir?: string;
  readonly manifestFork?: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let link = false;
  let mvp = false;
  let applyOverlay = false;
  let manifestUrl: string | undefined;
  let manifestRef: string | undefined;
  let manifestDir: string | undefined;
  let manifestFork: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) break;
    switch (arg) {
      case '--link':
        link = true;
        break;
      case '--mvp':
        mvp = true;
        break;
      case '--apply-overlay':
        applyOverlay = true;
        break;
      case '--manifest-url':
        i += 1;
        manifestUrl = args[i];
        break;
      case '--manifest-ref':
        i += 1;
        manifestRef = args[i];
        break;
      case '--manifest-dir':
        i += 1;
        manifestDir = args[i];
        break;
      case '--manifest-fork':
        i += 1;
        manifestFork = args[i];
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`unknown flag: ${arg}`);
        }
        positional.push(arg);
        break;
    }
  }
  const fromArg = positional[0];
  const fromEnv = process.env['MANIFEST_CHECKOUT'];
  const raw = fromArg ?? fromEnv;
  return {
    checkoutPath: raw === undefined ? undefined : resolve(process.cwd(), raw),
    link,
    mvp,
    applyOverlay,
    manifestUrl,
    manifestRef,
    manifestDir,
    manifestFork,
  };
}

function fileLabel(file: string): string {
  // Short label: "provider-client.ts" instead of the full path.
  return file.split(/[\\/]/).pop() ?? file;
}

function logResult(label: string, result: ApplyResult): void {
  const where = fileLabel(result.file);
  if (result.status === 'noop') {
    process.stdout.write(
      `[manifest-plugins/apply] ${where}: already patched — nothing to do.\n`,
    );
  } else if (result.status === 'applied') {
    process.stdout.write(`[manifest-plugins/apply] ${where}: applied\n`);
  } else {
    process.stderr.write(
      `[manifest-plugins/apply] ${where}: upstream-drift — ${result.reason}\n`,
    );
  }
  // Suppress unused-arg warning for `label` parameter (kept for future
  // multi-checkout support).
  void label;
}

function mvpRequested(args: ParsedArgs): boolean {
  return args.mvp || process.env['MVP_UI'] === '1';
}

function isImplicitOfficialClone(source: ManifestSource): boolean {
  return source.kind === 'url' && source.url === OFFICIAL_MANIFEST_URL;
}

async function recordSourceCommit(checkoutPath: string, commit: string): Promise<void> {
  const target = join(checkoutPath, '.manifest-source-commit');
  await fs.writeFile(target, `${commit}\n`, 'utf-8');
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv);
  const mvp = mvpRequested(parsed);

  let checkoutPath: string;
  let source: ManifestSource;
  const localCheckoutPath = parsed.checkoutPath ?? parsed.manifestDir;
  try {
    if (localCheckoutPath !== undefined) {
      source = await resolveManifestSource({
        manifestDir: localCheckoutPath,
        manifestUrl: parsed.manifestUrl,
        manifestRef: parsed.manifestRef,
        manifestFork: parsed.manifestFork,
        env: {},
      });
    } else {
      source = await resolveManifestSource({
        manifestUrl: parsed.manifestUrl,
        manifestRef: parsed.manifestRef,
        manifestDir: parsed.manifestDir,
        manifestFork: parsed.manifestFork,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[manifest-plugins/apply] failed: ${msg}\n`);
    return 2;
  }

  if (mvp && isImplicitOfficialClone(source)) {
    process.stderr.write(
      '[manifest-plugins/apply] --mvp / MVP_UI=1 requires an explicit Manifest source.\n' +
        '  Pass --manifest-url, --manifest-ref, --manifest-fork, or --manifest-dir\n' +
        '  so the MVP build is traceable. Defaulting to the implicit official clone\n' +
        '  would publish MVP UI against whatever upstream HEAD happens to be.\n',
    );
    return 2;
  }

  checkoutPath = source.path;

  process.stdout.write(`[manifest-plugins/apply] SOURCE_COMMIT=${source.commit}\n`);
  process.stdout.write(
    `[manifest-plugins/apply] patching three files in ${checkoutPath}\n`,
  );

  try {
    await recordSourceCommit(checkoutPath, source.commit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[manifest-plugins/apply] failed: ${msg}\n`);
    return 2;
  }

  if (!existsSync(checkoutPath)) {
    process.stderr.write(
      `[manifest-plugins/apply] manifest checkout not found at ${checkoutPath}\n` +
        `  Pass the path as argv[2] or set MANIFEST_CHECKOUT.\n`,
    );
    return 2;
  }

  try {
    const all = await applyAll(checkoutPath);
    logResult('provider-client', all.providerClient);
    logResult('proxy-rate-limiter', all.proxyRateLimiter);
    logResult('proxy-service', all.proxyService);

    if (all.hasDrift) {
      process.stderr.write(
        '[manifest-plugins/apply] one or more files reported upstream-drift. ' +
          'Update src/host/snippet.ts to match the new upstream shape, then re-run.\n',
      );
      return 1;
    }

    process.stdout.write(
      '[manifest-plugins/apply] all three files patched (or already no-op)\n',
    );

    if (parsed.applyOverlay) {
      // The MVP overlay apply path is a typed/declarative batch over
      // the same three target files. It runs AFTER applyAll so the
      // host snippet patcher has already had a chance to install
      // the helpers, and it captures SOURCE_COMMIT internally via
      // the same git runner. Drift here means the overlay manifest
      // references an overlay id that did not match the live
      // applyAll state.
      const { applyMvpOverlay } = await import('../apply/mvp-overlay');
      const overlay = await applyMvpOverlay(checkoutPath);
      if (overlay.hasDrift) {
        process.stderr.write(
          `[manifest-plugins/apply] --apply-overlay: drift on ${overlay.missing.length} overlay(s): ` +
            `${overlay.missing.join(', ')}.\n`,
        );
        return 1;
      }
      process.stdout.write(
        `[manifest-plugins/apply] --apply-overlay: applied ${overlay.missing.length === 0 ? 'all' : 'no'} overlays\n`,
      );
    }

    if (parsed.link) {
      const cwd = resolve(checkoutPath, 'packages/backend');
      process.stdout.write(`[manifest-plugins/apply] npm link in ${cwd}\n`);
      const linkResult = spawnSync('npm', ['link', process.cwd()], {
        cwd,
        stdio: 'inherit',
      });
      if (linkResult.status !== 0) {
        process.stderr.write(
          `[manifest-plugins/apply] npm link failed (exit ${linkResult.status})\n`,
        );
        return 1;
      }
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[manifest-plugins/apply] failed: ${msg}\n`);
    return 1;
  }
}

void main().then((code) => {
  process.exit(code);
});