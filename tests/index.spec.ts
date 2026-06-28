import { plugins, AnthropicBillingHeaderPlugin, DefaultPolicyPlugin } from '../src/index';

describe('plugin registry', () => {
  it('exports the two default plugins', () => {
    expect(plugins).toHaveLength(2);
  });

  it('includes the AnthropicBillingHeaderPlugin', () => {
    expect(plugins).toContainEqual(expect.any(AnthropicBillingHeaderPlugin));
  });

  it('includes the DefaultPolicyPlugin', () => {
    expect(plugins).toContainEqual(expect.any(DefaultPolicyPlugin));
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