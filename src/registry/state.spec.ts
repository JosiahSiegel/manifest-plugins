/**
 * Unit tests for the persisted plugin enable/disable state.
 *
 * The state file is the durable source of truth for which plugins are
 * on or off. Operators toggle plugins via the admin HTTP API, the
 * `npm run plugins:*` CLI, or the React dashboard island — all three
 * write to the same JSON file. On boot, the host loads the file and
 * applies the persisted toggles.
 *
 * Locks the contract:
 *   - Missing file → `{}` (not an error).
 *   - Malformed JSON → `{}` + warning (not an error).
 *   - Non-object root (array, primitive) → `{}` + warning.
 *   - Non-boolean values inside the map are silently dropped (the
 *     host's runtime is the safety net — never crash on bad state).
 *   - `savePluginState` writes through a temp file + rename so a
 *     crash mid-write cannot corrupt the destination.
 *   - `savePluginState` creates the parent directory if missing.
 *   - `loadPluginState` round-trips with `savePluginState` for a
 *     multi-plugin state.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadPluginState, savePluginState } from './state';

// Sanity guard: this spec lives in src/, so the parent of src/ must
// exist. If this fails the test layout itself is broken.
if (!existsSync(join(__dirname, '..', '..', 'src'))) {
  throw new Error(
    `state.spec.ts is in an unexpected location; src/ not found at ${join(__dirname, '..', '..', 'src')}`,
  );
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('loadPluginState', () => {
  it('returns {} when the file does not exist (no throw)', () => {
    const tmp = makeTempDir('mwp-state-missing-');
    try {
      const file = join(tmp, 'does-not-exist.json');
      expect(existsSync(file)).toBe(false);
      expect(loadPluginState(file)).toEqual({});
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns parsed state when the file contains valid JSON', () => {
    const tmp = makeTempDir('mwp-state-valid-');
    try {
      const file = join(tmp, 'state.json');
      writeFileSync(
        file,
        JSON.stringify({ 'show-all-router-views': true, 'anthropic-models-fix': false }),
        'utf-8',
      );
      expect(loadPluginState(file)).toEqual({
        'show-all-router-views': true,
        'anthropic-models-fix': false,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns {} when the file contains malformed JSON (and warns)', () => {
    const tmp = makeTempDir('mwp-state-malformed-');
    try {
      const file = join(tmp, 'state.json');
      writeFileSync(file, '{ this is not json', 'utf-8');
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const result = loadPluginState(file);
        expect(result).toEqual({});
        expect(warnSpy).toHaveBeenCalled();
        const firstCall = warnSpy.mock.calls[0];
        expect(firstCall).toBeDefined();
        const message = String(firstCall?.[0] ?? '');
        expect(message).toContain('not valid JSON');
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns {} when the file contains a JSON array (not an object)', () => {
    const tmp = makeTempDir('mwp-state-array-');
    try {
      const file = join(tmp, 'state.json');
      writeFileSync(file, JSON.stringify(['a', 'b', 'c']), 'utf-8');
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const result = loadPluginState(file);
        expect(result).toEqual({});
        expect(warnSpy).toHaveBeenCalled();
        const firstCall = warnSpy.mock.calls[0];
        expect(firstCall).toBeDefined();
        const message = String(firstCall?.[0] ?? '');
        expect(message).toContain('must be a JSON object');
        expect(message).toContain('array');
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns {} when the file contains a JSON primitive (string at root)', () => {
    // Locks the non-array branch of the typeof check: a valid JSON
    // document that parses to a string is rejected with the typeof
    // label rather than the 'array' label.
    const tmp = makeTempDir('mwp-state-primitive-');
    try {
      const file = join(tmp, 'state.json');
      writeFileSync(file, JSON.stringify('not-an-object'), 'utf-8');
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const result = loadPluginState(file);
        expect(result).toEqual({});
        expect(warnSpy).toHaveBeenCalled();
        const firstCall = warnSpy.mock.calls[0];
        expect(firstCall).toBeDefined();
        const message = String(firstCall?.[0] ?? '');
        expect(message).toContain('must be a JSON object');
        expect(message).toContain('string');
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('drops non-boolean values from the parsed state', () => {
    const tmp = makeTempDir('mwp-state-nonbool-');
    try {
      const file = join(tmp, 'state.json');
      writeFileSync(
        file,
        JSON.stringify({
          good: true,
          'string-truthy': 'true',
          numberish: 1,
          nullable: null,
          alsoGood: false,
          nested: { foo: 'bar' },
          array: [true, false],
        }),
        'utf-8',
      );
      expect(loadPluginState(file)).toEqual({ good: true, alsoGood: false });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns {} when readFileSync throws (and warns)', () => {
    // Defends the catch branch around readFileSync. On a healthy
    // filesystem this only happens when the file is deleted between
    // the existsSync check and the read, or when permissions block
    // the read. Either way, the loader must not throw.
    //
    // We force the branch via an isolated module load with a mocked
    // `fs` module where existsSync lies and readFileSync throws.
    // This is the only deterministic way to exercise the catch
    // without depending on filesystem race conditions.
    jest.isolateModules(() => {
      jest.doMock('fs', () => {
        const actual = jest.requireActual('fs');
        return {
          ...actual,
          existsSync: () => true,
          readFileSync: () => {
            throw new Error('EACCES: permission denied');
          },
        };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { loadPluginState: isolatedLoad } = require('./state') as typeof import('./state');
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const result = isolatedLoad('/any/path/state.json');
        expect(result).toEqual({});
        expect(warnSpy).toHaveBeenCalled();
        const firstCall = warnSpy.mock.calls[0];
        expect(firstCall).toBeDefined();
        const message = String(firstCall?.[0] ?? '');
        expect(message).toContain('could not read state file');
      } finally {
        warnSpy.mockRestore();
        jest.dontMock('fs');
      }
    });
  });
});

describe('savePluginState', () => {
  it('creates the parent directory if it does not exist', () => {
    const tmp = makeTempDir('mwp-state-mkdir-');
    try {
      const nestedDir = join(tmp, 'nested', 'deeper');
      const file = join(nestedDir, 'state.json');
      expect(existsSync(nestedDir)).toBe(false);
      savePluginState(file, { 'plugin-a': true });
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf-8')).toContain('"plugin-a": true');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('writes the state atomically — file contents equal the input state', () => {
    const tmp = makeTempDir('mwp-state-atomic-');
    try {
      const file = join(tmp, 'state.json');
      const state = { 'show-all-router-views': true, 'anthropic-models-fix': false };
      savePluginState(file, state);
      const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, boolean>;
      expect(onDisk).toEqual(state);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('round-trips with loadPluginState for a multi-plugin state', () => {
    const tmp = makeTempDir('mwp-state-roundtrip-');
    try {
      const file = join(tmp, 'state.json');
      const state = {
        'show-all-router-views': false,
        'anthropic-models-fix': true,
      };
      savePluginState(file, state);
      expect(loadPluginState(file)).toEqual(state);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});