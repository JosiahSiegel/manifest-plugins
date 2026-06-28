import { DefaultPolicyPlugin } from './plugin';
import type { RateLimitPolicy, RequestPolicyPlugin } from '../..';

describe('DefaultPolicyPlugin', () => {
  let plugin: RequestPolicyPlugin;

  beforeEach(() => {
    plugin = new DefaultPolicyPlugin();
  });

  it('returns a non-null policy', () => {
    const policy = plugin.getRateLimitPolicy();
    expect(policy).not.toBeNull();
    expect(policy).toBeDefined();
  });

  it('caps concurrency at 10 (matches source-code DEFAULT_CONCURRENCY_MAX)', () => {
    const policy = plugin.getRateLimitPolicy()!;
    expect(policy.concurrencyMax).toBe(10);
  });

  it('disables the per-request message-array cap by default (null = Infinity)', () => {
    const policy = plugin.getRateLimitPolicy()!;
    expect(policy.maxMessagesPerRequest).toBeNull();
  });

  it('returns a fresh object on each call (host caches the result, never mutates)', () => {
    const a = plugin.getRateLimitPolicy()!;
    const b = plugin.getRateLimitPolicy()!;
    expect(a).not.toBe(b);
    expect(a.concurrencyMax).toBe(b.concurrencyMax);
    expect(a.maxMessagesPerRequest).toBe(b.maxMessagesPerRequest);
  });

  it('matches the RateLimitPolicy interface shape exactly', () => {
    const policy: RateLimitPolicy = plugin.getRateLimitPolicy()!;
    expect(policy).toEqual({
      concurrencyMax: expect.any(Number),
      maxMessagesPerRequest: null,
    });
  });
});