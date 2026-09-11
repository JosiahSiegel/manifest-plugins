import {
  applyDisabledListFromEnv,
  createAdminServer,
  CustomProviderModelCountFixPlugin,
  CUSTOM_PROVIDER_MODEL_COUNT_FIX_PLUGIN_METADATA,
  CUSTOM_PROVIDER_MODEL_COUNT_FIX_SCRIPT,
  GptAstraModelListOverridePlugin,
  GPT_ASTRA_MODEL_LIST_OVERRIDE_PLUGIN_METADATA,
  installedPlugins,
  parseDisabledList,
  SHOW_ALL_ROUTER_VIEWS_PLUGIN_METADATA,
  SHOW_ALL_ROUTER_VIEWS_SCRIPT,
  ShowAllRouterViewsPlugin,
  startAdminServer,
} from '../src/index';

describe('plugin registry', () => {
  it('exports the three built-in plugins', () => {
    // The fork previously shipped four built-in plugins:
    //   - DefaultPolicyPlugin       (retired 2026-07-10 — duplicated
    //                                 upstream's hardcoded CONCURRENCY_MAX)
    //   - HeaderTierRouterPlugin    (retired 2026-07-10 — subsumed by
    //                                 upstream PR #2468, which restored
    //                                 header-tier precedence over explicit
    //                                 `body.model` directly in proxy.service.ts
    //                                 and resolve.service.ts)
    //   - AnthropicModelsFixPlugin  (retired — upstream Manifest now
    //                                 fetches Anthropic models live from
    //                                 https://api.anthropic.com/v1/models,
    //                                 so the static-catalog workaround this
    //                                 plugin implemented is no longer needed
    //                                 for the standard image build)
    //   - ShowAllRouterViewsPlugin  (still shipped — see plugin source)
    //   - CustomProviderModelCountFixPlugin (added 2026-08-18 — patches the
    //                                 Connections page "0 models" badge
    //                                 for custom Anthropic-compatible providers
    //                                 until upstream fixes the cached_models
    //                                 JSON null fallback in
    //                                 tenant-providers.controller.ts)
    //   - GptAstraModelListOverridePlugin (`gpt-astra-model-list-override` —
    //                                 adds GPT-6 Astra model-list and
    //                                 provider-parameter compatibility)
    //
    // Tests assert against `installedPlugins` (always-shipped, regardless
    // of runtime toggle) rather than `plugins` (the enabled-only subset
    // consumed by the host), so a plugin disabled by `manifest-plugins.config.json`
    // (`enabled: false`) still appears here.
    expect(installedPlugins).toHaveLength(3);
  });

  it('includes the GptAstraModelListOverridePlugin', () => {
    expect(installedPlugins).toContainEqual(expect.any(GptAstraModelListOverridePlugin));
  });

  it('includes the ShowAllRouterViewsPlugin', () => {
    expect(installedPlugins).toContainEqual(expect.any(ShowAllRouterViewsPlugin));
  });

  it('includes the CustomProviderModelCountFixPlugin', () => {
    expect(installedPlugins).toContainEqual(expect.any(CustomProviderModelCountFixPlugin));
  });

  it('freezes the registry to prevent runtime mutation', () => {
    expect(Object.isFrozen(installedPlugins)).toBe(true);
  });

  it('does not allow mutating the frozen plugins array', () => {
    expect(() => {
      // Cast to any because TypeScript prevents this at compile time;
      // the runtime freeze is what we actually exercise.
      (installedPlugins as unknown as { push: (p: unknown) => void }).push({} as never);
    }).toThrow();
  });

  it('reports installed metadata and restores runtime defaults after toggles', () => {
    const before = new Map(getInstalledPluginsForTest().map((plugin) => [plugin.id, plugin.enabled]));
    setPluginEnabledForTest('show-all-router-views', false);
    expect(getInstalledPluginsForTest().find((plugin) => plugin.id === 'show-all-router-views')?.enabled).toBe(false);
    resetPersistedStateForTest();
    expect(getInstalledPluginsForTest().find((plugin) => plugin.id === 'show-all-router-views')?.enabled).toBe(before.get('show-all-router-views'));
  });

  it('exposes the admin server wrappers through the public package', async () => {
    const app = createAdminServer();
    expect(typeof app).toBe('function');
    const started = await startAdminServer(app, { port: 0, bindHost: '127.0.0.1' });
    expect(started.port).toBeGreaterThan(0);
    await started.close();
  });

  it('covers public metadata/script exports and env parsing', () => {
    expect(SHOW_ALL_ROUTER_VIEWS_PLUGIN_METADATA.kind).toBe('dashboard-transform');
    expect(CUSTOM_PROVIDER_MODEL_COUNT_FIX_PLUGIN_METADATA.kind).toBe('dashboard-transform');
    expect(GPT_ASTRA_MODEL_LIST_OVERRIDE_PLUGIN_METADATA.kind).toBe('model-list-override');
    expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain('show-all-router-views');
    expect(CUSTOM_PROVIDER_MODEL_COUNT_FIX_SCRIPT).toContain('custom-provider-model-count-fix');
    expect(parseDisabledList('a,a,b')).toEqual(['a', 'b']);
    expect(applyDisabledListFromEnv('show-all-router-views', { knownIds: new Set(['show-all-router-views']) })).toEqual(['show-all-router-views']);
    resetPersistedStateForTest();
  });
});

import { getInstalledPlugins as getInstalledPluginsForTest, resetPersistedPluginState as resetPersistedStateForTest, setPluginEnabled as setPluginEnabledForTest } from '../src/index';
