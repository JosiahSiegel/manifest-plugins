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
const ROUTING_OVERRIDE_SYMBOL = 'function applyProxyRoutingOverridePlugins(';
const ROUTING_OVERRIDE_HEADER_TIER_IMPORT_SYMBOL =
  "import { HeaderTierService } from '../header-tiers/header-tier.service';";
const ROUTING_OVERRIDE_CONSTRUCTOR_SYMBOL =
  'private readonly headerTierService: HeaderTierService,';

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
  const proxyServicePath = resolve(
    checkoutPath,
    'packages/backend/src/routing/proxy/proxy.service.ts',
  );

  if (!existsSync(providerClientPath)) {
    process.stderr.write(`[manifest-plugins/verify] missing: ${providerClientPath}\n`);
    return 2;
  }
  if (!existsSync(proxyServicePath)) {
    process.stderr.write(`[manifest-plugins/verify] missing: ${proxyServicePath}\n`);
    return 2;
  }

  const providerClientText = readFileSync(providerClientPath, 'utf-8');
  const proxyServiceText = readFileSync(proxyServicePath, 'utf-8');
  const hasHelper = providerClientText.includes(HOST_HELPER_SYMBOL);
  const hasReturnWrap = providerClientText.includes(RETURN_TRANSFORMED_SYMBOL);
  const hasRoutingOverrideHelper = proxyServiceText.includes(ROUTING_OVERRIDE_SYMBOL);
  const hasRoutingOverrideImport = proxyServiceText.includes(
    ROUTING_OVERRIDE_HEADER_TIER_IMPORT_SYMBOL,
  );
  const hasRoutingOverrideConstructor = proxyServiceText.includes(
    ROUTING_OVERRIDE_CONSTRUCTOR_SYMBOL,
  );

  if (
    hasHelper &&
    hasReturnWrap &&
    hasRoutingOverrideHelper &&
    hasRoutingOverrideImport &&
    hasRoutingOverrideConstructor
  ) {
    process.stdout.write(
      `[manifest-plugins/verify] OK — hosts installed in ${checkoutPath}\n` +
        `  ✓ request-transform hook (provider-client.ts)\n` +
        `  ✓ routing-override hook (proxy.service.ts)\n`,
    );
    return 0;
  }

  process.stderr.write(
    `[manifest-plugins/verify] host NOT fully installed in ${checkoutPath}\n` +
      `  request-transform helper present: ${hasHelper}\n` +
      `  request-transform return wrapped: ${hasReturnWrap}\n` +
      `  routing-override helper present:   ${hasRoutingOverrideHelper}\n` +
      `  routing-override import present:   ${hasRoutingOverrideImport}\n` +
      `  routing-override constructor:     ${hasRoutingOverrideConstructor}\n` +
      `  run \`npm run apply\` from this repo.\n`,
  );
  return 1;
}

process.exit(main());