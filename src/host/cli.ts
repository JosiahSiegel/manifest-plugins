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
 *
 * Exits 0 if all three patches applied (or were already no-op). Exits 1
 * if any file reported upstream drift (which is a real build failure —
 * the user must update `src/host/snippet.ts` to match new upstream shape).
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { applyAll, type ApplyResult } from './apply';

function parseArgs(argv: string[]): { checkoutPath: string; link: boolean } {
  const args = argv.slice(2);
  const link = args.includes('--link');
  const positional = args.filter((a) => !a.startsWith('--'));
  const fromArg = positional[0];
  const fromEnv = process.env['MANIFEST_CHECKOUT'];
  const raw = fromArg ?? fromEnv ?? '../manifest';
  return { checkoutPath: resolve(process.cwd(), raw), link };
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

function main(): number {
  const { checkoutPath, link } = parseArgs(process.argv);

  if (!existsSync(checkoutPath)) {
    process.stderr.write(
      `[manifest-plugins/apply] manifest checkout not found at ${checkoutPath}\n` +
        `  Pass the path as argv[2] or set MANIFEST_CHECKOUT.\n`,
    );
    return 2;
  }

  process.stdout.write(
    `[manifest-plugins/apply] patching three files in ${checkoutPath}\n`,
  );

  applyAll(checkoutPath)
    .then((all) => {
      logResult('provider-client', all.providerClient);
      logResult('proxy-rate-limiter', all.proxyRateLimiter);
      logResult('proxy-service', all.proxyService);

      if (all.hasDrift) {
        process.stderr.write(
          '[manifest-plugins/apply] one or more files reported upstream-drift. ' +
            'Update src/host/snippet.ts to match the new upstream shape, then re-run.\n',
        );
        process.exit(1);
      }

      process.stdout.write(
        '[manifest-plugins/apply] all three files patched (or already no-op)\n',
      );

      if (link) {
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
          process.exit(1);
        }
      }
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[manifest-plugins/apply] failed: ${msg}\n`);
      process.exit(1);
    });
  return 0;
}

main();