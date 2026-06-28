#!/usr/bin/env node
/**
 * `npm run apply -- <manifest-checkout-path>`
 *
 * Locates a Manifest checkout and patches `provider-client.ts` to install
 * the plugin host. Safe to re-run (idempotent).
 *
 * Optional env / argv:
 *   - argv[2] or MANIFEST_CHECKOUT: path to the Manifest checkout.
 *   - --link : also `npm link` this package into the checkout's
 *              `packages/backend/node_modules` so `require('manifest-plugins')`
 *              resolves at runtime.
 *
 * Exits 0 on success (applied or no-op). Exits 1 if anchors have drifted.
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { applyProviderClientHost } from './apply';

function parseArgs(argv: string[]): { checkoutPath: string; link: boolean } {
  const args = argv.slice(2);
  const link = args.includes('--link');
  const positional = args.filter((a) => !a.startsWith('--'));
  const fromArg = positional[0];
  const fromEnv = process.env['MANIFEST_CHECKOUT'];
  const raw = fromArg ?? fromEnv ?? '../manifest';
  return { checkoutPath: resolve(process.cwd(), raw), link };
}

function main(): number {
  const { checkoutPath, link } = parseArgs(process.argv);

  const providerClientPath = resolve(
    checkoutPath,
    'packages/backend/src/routing/proxy/provider-client.ts',
  );

  if (!existsSync(providerClientPath)) {
    process.stderr.write(
      `[manifest-plugins/apply] provider-client.ts not found at ${providerClientPath}\n` +
        `  checkout path: ${checkoutPath}\n` +
        `  Pass the path as argv[2] or set MANIFEST_CHECKOUT.\n`,
    );
    return 2;
  }

  process.stdout.write(`[manifest-plugins/apply] patching ${providerClientPath}\n`);
  applyProviderClientHost(providerClientPath)
    .then((result) => {
      if (result.status === 'upstream-drift') {
        process.stderr.write(`[manifest-plugins/apply] ${result.reason}\n`);
        process.exit(1);
      }
      if (result.status === 'noop') {
        process.stdout.write(
          '[manifest-plugins/apply] host already installed — nothing to do.\n',
        );
      } else {
        process.stdout.write(
          `[manifest-plugins/apply] applied (helperInserted=${result.helperInserted}, ` +
            `returnReplaced=${result.returnReplaced})\n`,
        );
      }
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