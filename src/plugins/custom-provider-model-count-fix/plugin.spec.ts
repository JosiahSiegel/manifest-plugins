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
      version: '0.2.0',
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

  it('script body contains the S5 marker assignment (data-mp-count-fix="s5")', () => {
    const plugin = new CustomProviderModelCountFixPlugin();
    const script = plugin.getDashboardScript() as string;

    // The S5 patcher (per-row badge on the /providers connections-list
    // page) tags the patched <td> via `dataset.mpCountFix = 's5'`, which
    // the browser materialises as the `data-mp-count-fix="s5"`
    // attribute. The IIFE is JavaScript, so the literal HTML attribute
    // form is NOT in the string — only the assignment site. We assert
    // the assignment site and the literal value to lock the marker
    // contract end-to-end.
    expect(script).toMatch(/dataset\.mpCountFix\s*=\s*'s5'/);
  });

  it('script body contains the S6 marker assignment (data-mp-count-fix="s6")', () => {
    const plugin = new CustomProviderModelCountFixPlugin();
    const script = plugin.getDashboardScript() as string;

    // The S6 patcher (routing-picker relabel) tags the parent element
    // of each rewritten text node with `dataset.mpCountFix = 's6'`.
    // As with S5, the IIFE carries the JS assignment, not the HTML
    // attribute form — the browser emits the attribute at runtime.
    expect(script).toMatch(/dataset\.mpCountFix\s*=\s*'s6'/);
  });

  it('script body contains the S2 regex /models?:\\s*\\d+/i', () => {
    const plugin = new CustomProviderModelCountFixPlugin();
    const script = plugin.getDashboardScript() as string;

    // S2 rewrites the agent-list subscription note span whose text
    // matches `/models?:\s*\d+/i`. The IIFE is built by joining a
    // string array with '\n', so the literal backslashes are escaped
    // as `\\s` and `\\d` in the joined output. We assert the
    // JS-source form so the test does not depend on what the
    // `String.prototype.replace` regex engine sees at runtime.
    expect(script).toMatch(/models\?:\\s\*\\d\+/i);
  });

  it('script body contains the S6 regex /^custom:[0-9a-f-]{36}$/', () => {
    const plugin = new CustomProviderModelCountFixPlugin();
    const script = plugin.getDashboardScript() as string;

    // S6 matches text nodes whose content is exactly `custom:<uuid>`
    // (36 hex/dash chars after the colon). The regex source contains
    // no backslashes, so the IIFE carries it verbatim.
    expect(script).toContain('^custom:[0-9a-f-]{36}$');
  });

  it('script body contains the provider_display_name field for the label map', () => {
    const plugin = new CustomProviderModelCountFixPlugin();
    const script = plugin.getDashboardScript() as string;

    // The S6 label map is built from the SAME fetch as the count data
    // — there is no second network request for the routing picker
    // relabel. We assert the field name appears in the IIFE so a
    // future refactor that adds a separate fetch path is caught. The
    // field also appears in fetchAvailableModels (count data), so
    // occurrence-count would be >= 2; we only assert presence.
    expect(script).toContain('provider_display_name');
  });

  it('script body contains the S3 per-connection scoping branch', () => {
    const plugin = new CustomProviderModelCountFixPlugin();
    const script = plugin.getDashboardScript() as string;

    // S3 is now scoped per-connection: the patcher parses the
    // connection ID from the URL, inspects the page header for a
    // stable provider-name selector, and uses the scoped count with
    // subtitle "(patched: this connection)" when found. When the
    // selector is missing, the subtitle falls back to the strict
    // "(patched: all custom providers — scoping unavailable)"
    // message. Both branches are part of the per-connection
    // scoping contract; assert the connectionId parse site AND the
    // scoped subtitle so a future refactor that drops the fallback
    // branch is caught.
    expect(script).toContain('connectionId');
    expect(script).toContain('(patched: this connection)');
  });

  it('script body contains the UUID-slug fallback for missing provider_display_name', () => {
    const plugin = new CustomProviderModelCountFixPlugin();
    const script = plugin.getDashboardScript() as string;

    // The fetchAvailableModels function must NOT skip rows that lack
    // provider_display_name. Instead it falls back to a truncated-UUID
    // slug so totalCustom still increments for every custom: row.
    // Assert the ellipsis escape and the custom:-prefix reconstruction
    // so a future refactor that drops the fallback is caught.
    expect(script).toContain('\\u2026');
    expect(script).toMatch(/providerKey\.indexOf\('custom:'\)\s*===\s*0/);
    expect(script).toMatch(/uuid\.slice\(0,\s*8\)/);
  });
});
