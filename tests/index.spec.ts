import { plugins, AnthropicBillingHeaderPlugin } from '../src/index';

describe('plugin registry', () => {
  it('exports exactly one plugin', () => {
    expect(plugins).toHaveLength(1);
  });

  it('exports the AnthropicBillingHeaderPlugin instance', () => {
    expect(plugins[0]).toBeInstanceOf(AnthropicBillingHeaderPlugin);
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