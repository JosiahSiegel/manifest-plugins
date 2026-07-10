import {
  plugins,
  ShowAllRouterViewsPlugin,
  AnthropicModelsFixPlugin,
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
    //   - ShowAllRouterViewsPlugin  (still shipped — see plugin source)
    //   - AnthropicModelsFixPlugin  (still shipped — see plugin source)
    expect(plugins).toHaveLength(2);
  });

  it('includes the ShowAllRouterViewsPlugin', () => {
    expect(plugins).toContainEqual(expect.any(ShowAllRouterViewsPlugin));
  });

  it('includes the AnthropicModelsFixPlugin', () => {
    expect(plugins).toContainEqual(expect.any(AnthropicModelsFixPlugin));
  });

  it('freezes the registry to prevent runtime mutation', () => {
    expect(Object.isFrozen(plugins)).toBe(true);
  });

  it('does not allow mutating the frozen plugins array', () => {
    expect(() => {
      // Cast to any because TypeScript prevents this at compile time;
      // the runtime freeze is what we actually exercise.
      (plugins as unknown as { push: (p: unknown) => void }).push({} as never);
    }).toThrow();
  });
});