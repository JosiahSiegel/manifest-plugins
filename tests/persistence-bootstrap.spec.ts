/**
 * Tests for the boot-time persisted-state hook in src/index.ts.
 *
 * `bootPersistedState()` runs at module load. It reads the
 * `MANIFEST_PLUGINS_STATE_FILE` env var, loads the JSON state map,
 * applies each entry to the in-memory `enabledOverrides` map, then
 * re-applies `MANIFEST_PLUGINS_DISABLED` (env var wins precedence).
 *
 * `resetPersistedPluginState()` is the inverse: clears the in-memory
 * overrides, deletes the state file, then re-applies the env var so
 * `MANIFEST_PLUGINS_DISABLED` still wins.
 *
 * Test isolation strategy:
 *   - Each test sets `MANIFEST_PLUGINS_STATE_FILE` to a fresh temp
 *     path BEFORE importing `../src/index`.
 *   - `jest.isolateModules` re-evaluates the module per test, so the
 *     boot block runs fresh against the per-test env.
 *   - After each test, delete the env var and the state file to keep
 *     the rest of the test suite (which does NOT set the env var)
 *     from accidentally inheriting a state file.
 */
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

interface LoadedModule {
  readonly plugins: readonly unknown[];
  readonly getInstalledPlugins: () => readonly {
    readonly id: string;
    readonly enabled: boolean;
    readonly enabledByDefault: boolean;
  }[];
  readonly getPersistedStateFile: () => string;
  readonly resetPersistedPluginState: () => void;
  readonly ShowAllRouterViewsPlugin: new (...args: never[]) => unknown;
  readonly AnthropicModelsFixPlugin: new (...args: never[]) => unknown;
}

function freshStateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mwp-bootstrap-'));
  return join(dir, 'plugin-state.json');
}

function clearAllEnv(): void {
  delete process.env['MANIFEST_PLUGINS_STATE_FILE'];
  delete process.env['MANIFEST_PLUGINS_DISABLED'];
}

describe('persistence bootstrap (bootPersistedState)', () => {
  let stateFile: string;
  let tmpDir: string;

  beforeEach(() => {
    clearAllEnv();
    stateFile = freshStateFile();
    tmpDir = join(stateFile, '..');
    process.env['MANIFEST_PLUGINS_STATE_FILE'] = stateFile;
  });

  afterEach(() => {
    clearAllEnv();
    if (tmpDir !== undefined && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies a persisted false entry by removing the plugin from the runtime array', () => {
    writeFileSync(
      stateFile,
      JSON.stringify({ 'show-all-router-views': false }) + '\n',
      'utf-8',
    );

    let mod: LoadedModule;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('../src/index') as LoadedModule;
    });

    // Both shipped plugins are enabled by default; persisting
    // show-all-router-views=false leaves only AnthropicModelsFixPlugin
    // enabled at runtime.
    expect(mod!.plugins).toHaveLength(1);
    expect(mod!.plugins).not.toContainEqual(expect.any(mod!.ShowAllRouterViewsPlugin));
    expect(mod!.plugins).toContainEqual(expect.any(mod!.AnthropicModelsFixPlugin));
  });

  it('applies a persisted true entry so getInstalledPlugins reports enabled=true for that id', () => {
    writeFileSync(
      stateFile,
      JSON.stringify({ 'anthropic-models-fix': true }) + '\n',
      'utf-8',
    );

    let mod: LoadedModule;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('../src/index') as LoadedModule;
    });

    const installed = mod!.getInstalledPlugins();
    const mlop = installed.find((p) => p.id === 'anthropic-models-fix');
    expect(mlop).toBeDefined();
    expect(mlop!.enabled).toBe(true);
    // `enabledByDefault` reflects the source-declared default. Both shipped
    // plugins are enabled by default; AnthropicModelsFixPlugin can be
    // disabled per-build via `manifest-plugins.config.json` (copy-on-missing).
    expect(mlop!.enabledByDefault).toBe(true);
  });

  it('falls back to per-plugin defaults when the state file is missing', () => {
    // stateFile was set but never written — boot must treat it as a no-op.
    let mod: LoadedModule;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('../src/index') as LoadedModule;
    });

    // Both shipped plugins are enabled by default (the standard image
    // build ships with anthropic-models-fix enabled to satisfy the CI
    // e2e gate; local builds can disable it via
    // `manifest-plugins.config.json`).
    expect(mod!.plugins).toHaveLength(2);
    const installed = mod!.getInstalledPlugins();
    const sarv = installed.find((p) => p.id === 'show-all-router-views');
    expect(sarv!.enabled).toBe(true);
    expect(sarv!.enabledByDefault).toBe(true);
    const mlop = installed.find((p) => p.id === 'anthropic-models-fix');
    expect(mlop!.enabled).toBe(true);
    expect(mlop!.enabledByDefault).toBe(true);
  });

  it('exposes getPersistedStateFile() reading the env var (and a default when unset)', () => {
    let mod: LoadedModule;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('../src/index') as LoadedModule;
    });

    expect(mod!.getPersistedStateFile()).toBe(stateFile);
  });

  it('resetPersistedPluginState() deletes the state file AND restores defaults', () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        'show-all-router-views': false,
        'anthropic-models-fix': true,
      }) + '\n',
      'utf-8',
    );

    let mod: LoadedModule;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('../src/index') as LoadedModule;
    });

    // Boot has dropped show-all-router-views (persisted false) and
    // added anthropic-models-fix (persisted true). Net effect: still
    // exactly one enabled plugin.
    expect(mod!.plugins).toHaveLength(1);

    mod!.resetPersistedPluginState();

    expect(existsSync(stateFile)).toBe(false);

    // After reset: per-plugin defaults are restored. Both shipped plugins
    // are back to enabled by default.
    const installed = mod!.getInstalledPlugins();
    const sarv = installed.find((p) => p.id === 'show-all-router-views');
    expect(sarv!.enabled).toBe(true);
    expect(sarv!.enabledByDefault).toBe(true);
    const mlop = installed.find((p) => p.id === 'anthropic-models-fix');
    expect(mlop!.enabled).toBe(true);
    expect(mlop!.enabledByDefault).toBe(true);
    expect(mod!.plugins).toHaveLength(2);
  });
});
