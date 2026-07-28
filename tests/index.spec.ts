import {
  installedPlugins,
  ShowAllRouterViewsPlugin,
} from '../src/index';

describe('plugin registry', () => {
  it('exports the one remaining built-in plugin', () => {
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
    //
    // Tests assert against `installedPlugins` (always-shipped, regardless
    // of runtime toggle) rather than `plugins` (the enabled-only subset
    // consumed by the host), so a plugin disabled by `manifest-plugins.config.json`
    // (`enabled: false`) still appears here.
    expect(installedPlugins).toHaveLength(1);
  });

  it('includes the ShowAllRouterViewsPlugin', () => {
    expect(installedPlugins).toContainEqual(expect.any(ShowAllRouterViewsPlugin));
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
