import {
  plugins,
  DefaultPolicyPlugin,
  HeaderTierRouterPlugin,
} from '../src/index';

describe('plugin registry', () => {
  it('exports the two built-in plugins', () => {
    expect(plugins).toHaveLength(2);
  });

  it('includes the DefaultPolicyPlugin', () => {
    expect(plugins).toContainEqual(expect.any(DefaultPolicyPlugin));
  });

  it('includes the HeaderTierRouterPlugin', () => {
    expect(plugins).toContainEqual(expect.any(HeaderTierRouterPlugin));
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