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
const MODEL_LIST_OVERRIDE_SYMBOL = 'function applyModelListOverridePlugins(';
const MODEL_LIST_OVERRIDE_RETURN_SYMBOL = 'const pluginOverride = applyModelListOverridePlugins(';
// Wave 5: every pasted host snippet must call
// `require('manifest-plugins').applyDisabledListFromEnv(...)` so the
// MANIFEST_PLUGINS_DISABLED env var is honored at process start.
// If a fork maintenance strips this call, operators lose the ability
// to flip plugins off without rebuilding — verifier must catch it.
const ENV_TOGGLE_SYMBOL = 'applyDisabledListFromEnv';
const ENV_VAR_SYMBOL = "process.env['MANIFEST_PLUGINS_DISABLED']";

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
  const modelFetcherPath = resolve(
    checkoutPath,
    'packages/backend/src/routing/model.controller.ts',
  );

  if (!existsSync(providerClientPath)) {
    process.stderr.write(`[manifest-plugins/verify] missing: ${providerClientPath}\n`);
    return 2;
  }
  if (!existsSync(proxyServicePath)) {
    process.stderr.write(`[manifest-plugins/verify] missing: ${proxyServicePath}\n`);
    return 2;
  }
  if (!existsSync(modelFetcherPath)) {
    process.stderr.write(`[manifest-plugins/verify] missing: ${modelFetcherPath}\n`);
    return 2;
  }

  const providerClientText = readFileSync(providerClientPath, 'utf-8');
  const proxyServiceText = readFileSync(proxyServicePath, 'utf-8');
  const modelFetcherText = readFileSync(modelFetcherPath, 'utf-8');
  const hasHelper = providerClientText.includes(HOST_HELPER_SYMBOL);
  const hasReturnWrap = providerClientText.includes(RETURN_TRANSFORMED_SYMBOL);
  const hasRoutingOverrideHelper = proxyServiceText.includes(ROUTING_OVERRIDE_SYMBOL);
  const hasRoutingOverrideImport = proxyServiceText.includes(
    ROUTING_OVERRIDE_HEADER_TIER_IMPORT_SYMBOL,
  );
  const hasRoutingOverrideConstructor = proxyServiceText.includes(
    ROUTING_OVERRIDE_CONSTRUCTOR_SYMBOL,
  );
  const hasModelListOverrideHelper = modelFetcherText.includes(MODEL_LIST_OVERRIDE_SYMBOL);
  const hasModelListOverrideReturn = modelFetcherText.includes(
    MODEL_LIST_OVERRIDE_RETURN_SYMBOL,
  );
  const hasProviderEnvToggle =
    providerClientText.includes(ENV_TOGGLE_SYMBOL) &&
    providerClientText.includes(ENV_VAR_SYMBOL);
  const hasProxyEnvToggle =
    proxyServiceText.includes(ENV_TOGGLE_SYMBOL) &&
    proxyServiceText.includes(ENV_VAR_SYMBOL);
  const hasModelFetcherEnvToggle =
    modelFetcherText.includes(ENV_TOGGLE_SYMBOL) &&
    modelFetcherText.includes(ENV_VAR_SYMBOL);

  if (
    hasHelper &&
    hasReturnWrap &&
    hasRoutingOverrideHelper &&
    hasRoutingOverrideImport &&
    hasRoutingOverrideConstructor &&
    hasModelListOverrideHelper &&
    hasModelListOverrideReturn &&
    hasProviderEnvToggle &&
    hasProxyEnvToggle &&
    hasModelFetcherEnvToggle
  ) {
    process.stdout.write(
      `[manifest-plugins/verify] OK — hosts installed in ${checkoutPath}\n` +
        `  ✓ request-transform hook (provider-client.ts)\n` +
        `  ✓ routing-override hook (proxy.service.ts)\n` +
        `  ✓ model-list-override hook (model-fetcher.ts)\n` +
        `  ✓ MANIFEST_PLUGINS_DISABLED env-toggle wired\n`,
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
      `  model-list-override helper present: ${hasModelListOverrideHelper}\n` +
      `  model-list-override return wrapped: ${hasModelListOverrideReturn}\n` +
      `  env-toggle wired (provider-client): ${hasProviderEnvToggle}\n` +
      `  env-toggle wired (proxy.service):   ${hasProxyEnvToggle}\n` +
      `  env-toggle wired (model-fetcher):   ${hasModelFetcherEnvToggle}\n` +
      `  run \`npm run apply\` from this repo.\n`,
  );
  return 1;
}

process.exit(main());