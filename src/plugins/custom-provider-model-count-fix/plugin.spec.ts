/**
 * Unit tests for `custom-provider-model-count-fix`
 * (`CustomProviderModelCountFixPlugin`).
 *
 * The plan's task 1 calls for exactly six assertions that lock the
 * plugin's contract end-to-end:
 *
 *   1. metadata shape — id matches the scaffolder, kind is
 *      `dashboard-transform`, name/version/description are non-empty
 *      strings.
 *   2. `static metadata` identity — the class's static field points
 *      at the same frozen metadata object the module exports.
 *   3. constructability — `new CustomProviderModelCountFixPlugin()`
 *      does not throw.
 *   4. script presence — `getDashboardScript()` returns a non-empty
 *      string.
 *   5. script contents — the script string contains the expected
 *      pieces (IIFE wrapper, the API URL, the `custom:` filter, the
 *      MutationObserver registration, and the `data-mwp-` marker
 *      prefix). Regex assertions are used so the test does not depend
 *      on exact whitespace.
 *   6. metadata identity — `metadata.id === 'custom-provider-model-count-fix'`.
 *
 * Everything beyond those six is "operator-visible" behavior we
 * can only meaningfully verify against a live Manifest stack, so
 * it lives in wave 3 of the plan, not in this unit suite.
 */
import type { PluginMetadata } from '../..';
import {
  CUSTOM_PROVIDER_MODEL_COUNT_FIX_PLUGIN_METADATA,
  CustomProviderModelCountFixPlugin,
} from './plugin';

describe('CustomProviderModelCountFixPlugin', () => {
  it('declares metadata with the scaffolder id, a dashboard-transform kind, and non-empty name/version/description', () => {
    expect(CUSTOM_PROVIDER_MODEL_COUNT_FIX_PLUGIN_METADATA).toEqual({
      id: 'custom-provider-model-count-fix',
      name: 'Custom provider model count fix',
      version: '0.1.0',
      description: expect.any(String),
      kind: 'dashboard-transform',
    } satisfies PluginMetadata);
    expect((CUSTOM_PROVIDER_MODEL_COUNT_FIX_PLUGIN_METADATA.description as string).length).toBeGreaterThan(0);
  });

  it('exposes the metadata via the static class field as the same frozen object', () => {
    // Strict identity — not just deep equality. The scaffolder exports
    // the metadata via Object.freeze, and the class field must point
    // at the same instance so per-request metadata walks find it.
    expect(CustomProviderModelCountFixPlugin.metadata).toBe(CUSTOM_PROVIDER_MODEL_COUNT_FIX_PLUGIN_METADATA);
    expect(Object.isFrozen(CustomProviderModelCountFixPlugin.metadata)).toBe(true);
  });

  it('is constructable without throwing', () => {
    expect(() => new CustomProviderModelCountFixPlugin()).not.toThrow();
  });

  it('returns a non-empty string from getDashboardScript()', () => {
    const script = new CustomProviderModelCountFixPlugin().getDashboardScript();
    expect(typeof script).toBe('string');
    expect((script as string).length).toBeGreaterThan(0);
  });

  it('script body contains the IIFE wrapper, routing URL, custom: filter, MutationObserver, and data-mwp- marker', () => {
    const plugin = new CustomProviderModelCountFixPlugin();
    const script = plugin.getDashboardScript() as string;

    // IIFE wrapper — must be an immediately-invoked function expression
    // either as `(function() {...})()` or `function() {...}()` style.
    // We deliberately allow the trailing-comment and whitespace variants.
    expect(script).toMatch(/\(function\s*\(\)\s*\{[\s\S]*?\}\)\(\);?\s*$/);

    // The routing-picker endpoint must be present. We deliberately
    // match against the literal string `/api/v1/routing/` and a
    // `custom:` token because those are the public contract surface
    // the upstream router exposes.
    expect(script).toContain('/api/v1/routing/');
    expect(script).toContain('available-models');

    // The filter must check `provider.startsWith('custom:')` (or the
    // equivalent `indexOf('custom:') === 0` form used by the plugin).
    expect(script).toMatch(/custom:/);

    // The MutationObserver registration is what keeps the patch alive
    // across SPA navigation. Without it, the fix is one-shot.
    expect(script).toContain('MutationObserver');
    expect(script).toMatch(/observer\.observe\([^)]*\{[\s\S]*?childList[\s\S]*?subtree[\s\S]*?\}\)/);

    // The data-mwp- marker prefix is the idempotency key. Any variant
    // (data-mwp-model-count-patched, data-mwp-model-count-patched-note,
    // mwpModelCountPatched) all share this namespace; the test asserts
    // the namespace is present so future renames don't silently break it.
    expect(script).toContain('data-mwp-');
  });

  it('metadata.id matches the scaffolder id exactly', () => {
    expect(CustomProviderModelCountFixPlugin.metadata.id).toBe('custom-provider-model-count-fix');
    // And the exported object agrees — catches accidental divergence
    // (e.g. someone changing the class field but forgetting the export).
    expect(CUSTOM_PROVIDER_MODEL_COUNT_FIX_PLUGIN_METADATA.id).toBe('custom-provider-model-count-fix');
  });

  it('script body contains the ConnectionDetail patcher and its URL pattern', () => {
    const plugin = new CustomProviderModelCountFixPlugin();
    const script = plugin.getDashboardScript() as string;

    // The ConnectionDetail patcher function must be present so the
    // /providers/connections/<id> page gets the same fix as the
    // per-agent list page.
    expect(script).toContain('patchConnectionDetail');

    // The URL pattern for the ConnectionDetail page. The script matches
    // `/providers/connections/<id>` literally; we assert the regex
    // source is present so a future rename of the route is caught.
    expect(script).toContain('/providers\\/connections\\/');
  });

  it('script body contains the span-pair detection logic for the Models label', () => {
    const plugin = new CustomProviderModelCountFixPlugin();
    const script = plugin.getDashboardScript() as string;

    // The ConnectionDetail page renders fields as inline <span> pairs
    // (label + value). The patcher walks every <span> looking for the
    // literal "Models:" label, then patches the next-sibling <span>.
    // Assert both the literal label and the nextElementSibling walk
    // are present so a future refactor that switches to a different
    // DOM strategy is caught.
    expect(script).toContain('\'Models:\'');
    expect(script).toContain('nextElementSibling');
  });
});
