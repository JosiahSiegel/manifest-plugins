import {
  plugins,
  DefaultPolicyPlugin,
  HeaderTierRouterPlugin,
  ShowAllRouterViewsPlugin,
} from '../src/index';

describe('plugin registry', () => {
  it('exports the three built-in plugins', () => {
    expect(plugins).toHaveLength(3);
  });

  it('includes the DefaultPolicyPlugin', () => {
    expect(plugins).toContainEqual(expect.any(DefaultPolicyPlugin));
  });

  it('includes the HeaderTierRouterPlugin', () => {
    expect(plugins).toContainEqual(expect.any(HeaderTierRouterPlugin));
  });

  it('includes the ShowAllRouterViewsPlugin', () => {
    expect(plugins).toContainEqual(expect.any(ShowAllRouterViewsPlugin));
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