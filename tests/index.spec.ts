import {
  CustomProviderModelCountFixPlugin,
  installedPlugins,
  ShowAllRouterViewsPlugin,
} from '../src/index';

describe('plugin registry', () => {
  it('exports the two remaining built-in plugins', () => {
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
    //
    // Tests assert against `installedPlugins` (always-shipped, regardless
    // of runtime toggle) rather than `plugins` (the enabled-only subset
    // consumed by the host), so a plugin disabled by `manifest-plugins.config.json`
    // (`enabled: false`) still appears here.
    expect(installedPlugins).toHaveLength(2);
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
});
