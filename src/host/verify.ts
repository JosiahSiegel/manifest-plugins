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
  const modelFetcherPath = resolve(
    checkoutPath,
    'packages/backend/src/routing/model.controller.ts',
  );

  if (!existsSync(providerClientPath)) {
    process.stderr.write(`[manifest-plugins/verify] missing: ${providerClientPath}\n`);
    return 2;
  }
  if (!existsSync(modelFetcherPath)) {
    process.stderr.write(`[manifest-plugins/verify] missing: ${modelFetcherPath}\n`);
    return 2;
  }

  const providerClientText = readFileSync(providerClientPath, 'utf-8');
  const modelFetcherText = readFileSync(modelFetcherPath, 'utf-8');
  const hasHelper = providerClientText.includes(HOST_HELPER_SYMBOL);
  const hasReturnWrap = providerClientText.includes(RETURN_TRANSFORMED_SYMBOL);
  const hasModelListOverrideHelper = modelFetcherText.includes(MODEL_LIST_OVERRIDE_SYMBOL);
  const hasModelListOverrideReturn = modelFetcherText.includes(
    MODEL_LIST_OVERRIDE_RETURN_SYMBOL,
  );
  const hasProviderEnvToggle =
    providerClientText.includes(ENV_TOGGLE_SYMBOL) &&
    providerClientText.includes(ENV_VAR_SYMBOL);
  const hasModelFetcherEnvToggle =
    modelFetcherText.includes(ENV_TOGGLE_SYMBOL) &&
    modelFetcherText.includes(ENV_VAR_SYMBOL);

  if (
    hasHelper &&
    hasReturnWrap &&
    hasModelListOverrideHelper &&
    hasModelListOverrideReturn &&
    hasProviderEnvToggle &&
    hasModelFetcherEnvToggle
  ) {
    process.stdout.write(
      `[manifest-plugins/verify] OK — hosts installed in ${checkoutPath}\n` +
        `  ✓ request-transform hook (provider-client.ts)\n` +
        `  ✓ model-list-override hook (model.controller.ts)\n` +
        `  ✓ MANIFEST_PLUGINS_DISABLED env-toggle wired\n`,
    );
    return 0;
  }

  process.stderr.write(
    `[manifest-plugins/verify] host NOT fully installed in ${checkoutPath}\n` +
      `  request-transform helper present: ${hasHelper}\n` +
      `  request-transform return wrapped: ${hasReturnWrap}\n` +
      `  model-list-override helper present: ${hasModelListOverrideHelper}\n` +
      `  model-list-override return wrapped: ${hasModelListOverrideReturn}\n` +
      `  env-toggle wired (provider-client): ${hasProviderEnvToggle}\n` +
      `  env-toggle wired (model-fetcher):   ${hasModelFetcherEnvToggle}\n` +
      `  run \`npm run apply\` from this repo.\n`,
  );
  return 1;
}

process.exit(main());