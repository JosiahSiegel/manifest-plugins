#!/usr/bin/env node
/**
 * `npm run verify -- <manifest-checkout-path>`
 *
 * Sanity check: reports whether the plugin host is installed in a Manifest
 * checkout's `provider-client.ts`. Exits 0 if present, 1 otherwise.
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const HOST_HELPER_SYMBOL = 'function applyRequestTransformPlugins(';
const RETURN_TRANSFORMED_SYMBOL = 'const transformed = applyRequestTransformPlugins(';

function parseArgs(argv: string[]): string {
  const args = argv.slice(2);
  const fromArg = args[0];
  const fromEnv = process.env['MANIFEST_CHECKOUT'];
  const raw = fromArg ?? fromEnv ?? '../manifest';
  return resolve(process.cwd(), raw);
}

function main(): number {
  const checkoutPath = parseArgs(process.argv);
  const providerClientPath = resolve(
    checkoutPath,
    'packages/backend/src/routing/proxy/provider-client.ts',
  );

  if (!existsSync(providerClientPath)) {
    process.stderr.write(`[manifest-plugins/verify] missing: ${providerClientPath}\n`);
    return 2;
  }

  const text = readFileSync(providerClientPath, 'utf-8');
  const hasHelper = text.includes(HOST_HELPER_SYMBOL);
  const hasReturnWrap = text.includes(RETURN_TRANSFORMED_SYMBOL);

  if (hasHelper && hasReturnWrap) {
    process.stdout.write(
      `[manifest-plugins/verify] OK — host installed in ${providerClientPath}\n`,
    );
    return 0;
  }

  process.stderr.write(
    `[manifest-plugins/verify] host NOT installed in ${providerClientPath}\n` +
      `  helper present: ${hasHelper}\n` +
      `  return wrapped: ${hasReturnWrap}\n` +
      `  run \`npm run apply\` from this repo.\n`,
  );
  return 1;
}

main();