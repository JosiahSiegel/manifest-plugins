/**
 * Unit tests for `src/host/env-toggle.ts`.
 *
 * Wave 5 contract:
 *   - `parseDisabledList(env)` parses a comma-separated list of
 *     plugin ids from the env value. Empty / unset → empty array.
 *   - `applyDisabledListFromEnv(env, options?)` calls
 *     `setPluginEnabled(id, false)` for each parsed id and returns
 *     the list of ids that were disabled.
 *   - Unknown ids are silently ignored (with an optional `onUnknown`
 *     callback that gets called for each one).
 *   - The function is pure of side effects beyond the registry —
 *     it does not mutate `process.env` or call any other module.
 */
import {
  parseDisabledList,
  applyDisabledListFromEnv,
  type EnvToggleOptions,
} from './env-toggle';

function silentOptions(): EnvToggleOptions {
  return {
    onUnknown: () => undefined,
    onApplied: () => undefined,
  };
}

describe('parseDisabledList', () => {
  it('returns an empty array for undefined', () => {
    expect(parseDisabledList(undefined)).toEqual([]);
  });

  it('returns an empty array for the empty string', () => {
    expect(parseDisabledList('')).toEqual([]);
  });

  it('returns a single id from a bare string', () => {
    expect(parseDisabledList('header-tier-router')).toEqual([
      'header-tier-router',
    ]);
  });

  it('splits on commas and trims whitespace', () => {
    expect(parseDisabledList(' a , b ,c ')).toEqual(['a', 'b', 'c']);
  });

  it('filters empty segments produced by trailing or doubled commas', () => {
    expect(parseDisabledList('a,,b,,,c,')).toEqual(['a', 'b', 'c']);
  });

  it('preserves order of first appearance', () => {
    expect(parseDisabledList('zeta,alpha,mu')).toEqual([
      'zeta',
      'alpha',
      'mu',
    ]);
  });
});

describe('applyDisabledListFromEnv', () => {
  it('returns an empty list when env is undefined', () => {
    const disabled = applyDisabledListFromEnv(undefined, silentOptions());
    expect(disabled).toEqual([]);
  });

  it('returns an empty list when env is the empty string', () => {
    const disabled = applyDisabledListFromEnv('', silentOptions());
    expect(disabled).toEqual([]);
  });

  it('returns the parsed ids when env is non-empty', () => {
    const disabled = applyDisabledListFromEnv(
      'a,b,c',
      silentOptions(),
    );
    expect(disabled).toEqual(['a', 'b', 'c']);
  });

  it('invokes onApplied for each parsed id in order', () => {
    const applied: string[] = [];
    applyDisabledListFromEnv('zeta,alpha,mu', {
      onApplied: (id) => {
        applied.push(id);
      },
    });
    expect(applied).toEqual(['zeta', 'alpha', 'mu']);
  });

  it('invokes onUnknown for ids that are not known to the caller', () => {
    const known = new Set(['known-id']);
    const unknown: string[] = [];
    const disabled = applyDisabledListFromEnv(
      'known-id,unknown-id,another-unknown',
      {
        knownIds: known,
        onUnknown: (id) => {
          unknown.push(id);
        },
      },
    );
    // Unknown ids are still returned so the caller can log/audit them.
    expect(disabled).toEqual([
      'known-id',
      'unknown-id',
      'another-unknown',
    ]);
    expect(unknown).toEqual(['unknown-id', 'another-unknown']);
  });

  it('does not invoke onApplied when both env and knownIds produce zero matches (empty env)', () => {
    const calls: string[] = [];
    applyDisabledListFromEnv('', {
      onApplied: (id) => {
        calls.push(id);
      },
      onUnknown: (id) => {
        calls.push(id);
      },
    });
    expect(calls).toEqual([]);
  });
});