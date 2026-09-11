/**
 * Unit tests for the plugin auto-discoverer.
 *
 * The discoverer scans `<pluginsDir>/<name>/plugin.ts` (source mode) OR
 * `<pluginsDir>/<name>/plugin.js` (built/runtime mode) and extracts the
 * named class export + `static metadata` for each plugin file. Adding
 * a new plugin requires only dropping a new directory under the plugins
 * root — the registry re-reads on every build / process start.
 *
 * Locks the contract:
 *   - Named class exports (no `default` required).
 *   - `static metadata` with a unique `id` is required.
 *   - Throws loudly on duplicate class names AND duplicate `metadata.id`.
 *   - Discovers the 3 built-in plugins from the real `src/plugins/` AND
 *     from the compiled `dist/plugins/` mirror (this is the runtime
 *     shape; if it breaks, the production image boots with zero plugins).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { discoverPlugins, PluginDiscoveryError } from './discover';

const PLUGINS_SRC_DIR = join(__dirname, '..', 'plugins');

function writeTempPlugin(
  parent: string,
  name: string,
  className: string,
  pluginId: string,
): string {
  const pluginDir = join(parent, name);
  mkdirSync(pluginDir, { recursive: true });
  const file = join(pluginDir, 'plugin.ts');
  // Test fixtures intentionally avoid type-only imports of the host
  // package; the discoverer inspects runtime `static metadata` and
  // doesn't need the typed shape. This keeps fixtures hermetic.
  writeFileSync(
    file,
    [
      `export const ${name.toUpperCase().replace(/-/g, '_')}_METADATA = Object.freeze({`,
      `  id: '${pluginId}',`,
      `  name: '${pluginId}',`,
      `  version: '0.0.1',`,
      `  description: '${name} test plugin',`,
      `  kind: 'transform',`,
      `});`,
      `export class ${className} {`,
      `  static readonly metadata = ${name.toUpperCase().replace(/-/g, '_')}_METADATA;`,
      `  transformRequest() { return undefined; }`,
      `}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  return file;
}

function writeBrokenPlugin(
  parent: string,
  name: string,
  body: string,
): string {
  const pluginDir = join(parent, name);
  mkdirSync(pluginDir, { recursive: true });
  const file = join(pluginDir, 'plugin.ts');
  writeFileSync(file, body, 'utf-8');
  return file;
}

describe('discoverPlugins (filesystem enumeration)', () => {
  it('discovers all three built-in plugins from src/plugins/', () => {
    const discovered = discoverPlugins(PLUGINS_SRC_DIR);

    const classNames = discovered.map((entry) => entry.pluginClassName);
    expect(classNames).toEqual(
      expect.arrayContaining([
        'ShowAllRouterViewsPlugin',
        'CustomProviderModelCountFixPlugin',
        'GptAstraModelListOverridePlugin',
      ]),
    );
    const ids = discovered.map((entry) => entry.metadata.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'show-all-router-views',
        'custom-provider-model-count-fix',
        'gpt-astra-model-list-override',
      ]),
    );
    expect(discovered).toHaveLength(3);
  });

  it('returns plugin entries with a non-empty id, kind, and instance', () => {
    const discovered = discoverPlugins(PLUGINS_SRC_DIR);
    for (const entry of discovered) {
      expect(entry.metadata.id).toEqual(expect.any(String));
      expect(entry.metadata.id.length).toBeGreaterThan(0);
      expect(entry.metadata.kind).toEqual(
        expect.stringMatching(
          /^(transform|policy|routing-override|dashboard-transform|model-list-override)$/,
        ),
      );
      expect(entry.instance).toBeDefined();
    }
  });

  it('discovers plugins in a tempdir fixture (named class export + static metadata)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-'));
    try {
      writeTempPlugin(tmp, 'alpha', 'AlphaPlugin', 'alpha');
      writeTempPlugin(tmp, 'beta', 'BetaPlugin', 'beta');
      writeTempPlugin(
        tmp,
        'gpt-astra-model-list-override',
        'GptAstraModelListOverridePlugin',
        'gpt-astra-model-list-override',
      );
      const discovered = discoverPlugins(tmp);
      const ids = discovered.map((entry) => entry.metadata.id);
      expect(ids).toEqual(
        expect.arrayContaining(['alpha', 'beta', 'gpt-astra-model-list-override']),
      );
      expect(discovered).toHaveLength(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns an empty array when the directory has no plugins', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-empty-'));
    try {
      expect(discoverPlugins(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws when a plugin file has no static metadata', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-nometa-'));
    try {
      writeBrokenPlugin(
        tmp,
        'broken',
        [
          'export class BrokenPlugin {',
          '  transformRequest() { return undefined; }',
          '}',
        ].join('\n'),
      );
      expect(() => discoverPlugins(tmp)).toThrow(PluginDiscoveryError);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws on duplicate metadata.id', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-dup-id-'));
    try {
      writeTempPlugin(tmp, 'one', 'OnePlugin', 'same-id');
      writeTempPlugin(tmp, 'two', 'TwoPlugin', 'same-id');
      expect(() => discoverPlugins(tmp)).toThrow(/duplicate metadata\.id/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws on duplicate class name', () => {
    const tmp = mkdtempSync(
      join(tmpdir(), 'manifest-plugins-discover-dup-class-'),
    );
    try {
      writeTempPlugin(tmp, 'one', 'DupPlugin', 'one-id');
      writeTempPlugin(tmp, 'two', 'DupPlugin', 'two-id');
      expect(() => discoverPlugins(tmp)).toThrow(/duplicate class name/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws when the directory does not exist', () => {
    expect(() => discoverPlugins('/does/not/exist/anywhere')).toThrow(
      PluginDiscoveryError,
    );
  });

  it('skips subdirectories without a plugin file, hidden entries, and regular files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-skip-'));
    try {
      writeTempPlugin(tmp, 'real', 'RealPlugin', 'real');
      mkdirSync(join(tmp, 'no-plugin-here'), { recursive: true });
      mkdirSync(join(tmp, '.hidden-plugin'), { recursive: true });
      writeTempPlugin(tmp, '.hidden-plugin', 'HiddenPlugin', 'hidden');
      writeFileSync(join(tmp, 'regular.txt'), 'not a plugin', 'utf-8');
      expect(discoverPlugins(tmp).map((entry) => entry.metadata.id)).toEqual(['real']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws for a plugin root that is a regular file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-file-')), 'plugins.txt');
    try {
      writeFileSync(file, 'not a directory', 'utf-8');
      expect(() => discoverPlugins(file)).toThrow(/not a directory/);
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  it('throws on duplicate class names across compiled plugin files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-dup-js-class-'));
    try {
      for (const [name, id] of [['one', 'one-id'], ['two', 'two-id']] as const) {
        const dir = join(tmp, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'plugin.js'), `class DupPlugin {}\nconst META = { id: '${id}', name: '${id}', version: '0.0.1', description: 'x', kind: 'transform' };\nDupPlugin.metadata = META;\nexports.DupPlugin = DupPlugin;\n`, 'utf-8');
      }
      expect(() => discoverPlugins(tmp)).toThrow(/duplicate class name/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws when one plugin file exports two classes', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-multi-class-'));
    try {
      writeBrokenPlugin(tmp, 'multi', 'export class FirstPlugin {}\nexport class SecondPlugin {}\n');
      expect(() => discoverPlugins(tmp)).toThrow(/multiple exported classes/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips compiled plugin files without a matching exported class', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-no-class-'));
    try {
      const dir = join(tmp, 'empty-export');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'plugin.js'), 'exports.NotTheExpectedShape = {};\n', 'utf-8');
      expect(discoverPlugins(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not expose an undefined class name for malformed CommonJS exports', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-malformed-cjs-'));
    try {
      const dir = join(tmp, 'malformed');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'plugin.js'), 'exports. = {};\n', 'utf-8');
      expect(discoverPlugins(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws when compiled runtime export is not callable', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-not-callable-'));
    try {
      const dir = join(tmp, 'broken');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'plugin.js'), 'const BrokenPlugin = {};\nexports.BrokenPlugin = BrokenPlugin;\n', 'utf-8');
      expect(() => discoverPlugins(tmp)).toThrow(/expected exported class/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws when metadata id is empty', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-empty-id-'));
    try {
      writeBrokenPlugin(tmp, 'empty-id', [
        'export class EmptyIdPlugin {',
        "  static metadata = { id: '', name: 'x', version: '0.0.1', description: 'x', kind: 'transform' };",
        '}',
      ].join('\n'));
      expect(() => discoverPlugins(tmp)).toThrow(/metadata\.id/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws when metadata kind is unsupported', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-bad-kind-'));
    try {
      writeBrokenPlugin(tmp, 'bad-kind', [
        'export class BadKindPlugin {',
        "  static metadata = { id: 'bad-kind', name: 'x', version: '0.0.1', description: 'x', kind: 'unknown' };",
        '}',
      ].join('\n'));
      expect(() => discoverPlugins(tmp)).toThrow(/metadata\.kind/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('PluginDiscoveryError', () => {
  it('is a real Error subclass carrying a context message', () => {
    const err = new PluginDiscoveryError('alpha plugin.ts: missing metadata');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PluginDiscoveryError');
    expect(err.message).toContain('alpha plugin.ts');
  });
});

/**
 * Compiled-shape (post-`tsc`) discovery contract.
 *
 * `tsc` emits `dist/plugins/<name>/plugin.js` — NOT `plugin.ts`. The
 * production image boots from `dist/`, so the discoverer MUST work
 * against `.js` files; otherwise the host installs zero plugins and
 * the image returns upstream's "no providers configured" fallback.
 *
 * These tests are the gate against that regression. If they fail, the
 * image will silently lose every installed plugin at boot.
 */
describe('discoverPlugins (compiled JS shape — post-tsc runtime)', () => {
  /**
   * Write a CommonJS-shaped `plugin.js` fixture that mimics tsc's
   * exact output: `exports.<ClassName> = ...` and `exports.<NAME>_METADATA = ...`.
   * The discoverer must accept this shape at runtime.
   */
  function writeCompiledPlugin(
    parent: string,
    name: string,
    className: string,
    pluginId: string,
  ): string {
    const pluginDir = join(parent, name);
    mkdirSync(pluginDir, { recursive: true });
    const file = join(pluginDir, 'plugin.js');
    const metaConst = `${name.toUpperCase().replace(/-/g, '_')}_METADATA`;
    writeFileSync(
      file,
      [
        `"use strict";`,
        `Object.defineProperty(exports, "__esModule", { value: true });`,
        `exports.${className} = exports.${metaConst} = void 0;`,
        `exports.${metaConst} = Object.freeze({`,
        `  id: '${pluginId}',`,
        `  name: '${pluginId}',`,
        `  version: '0.0.1',`,
        `  description: '${name} compiled-fixture',`,
        `  kind: 'transform',`,
        `});`,
        `class ${className} {`,
        `  static metadata = exports.${metaConst};`,
        `  transformRequest() { return undefined; }`,
        `}`,
        `exports.${className} = ${className};`,
        ``,
      ].join('\n'),
      'utf-8',
    );
    return file;
  }

  it('discovers plugins from compiled plugin.js (the production runtime shape)', () => {
    const tmp = mkdtempSync(
      join(tmpdir(), 'manifest-plugins-discover-compiled-'),
    );
    try {
      writeCompiledPlugin(tmp, 'alpha', 'AlphaPlugin', 'alpha');
      writeCompiledPlugin(tmp, 'beta', 'BetaPlugin', 'beta');
      writeCompiledPlugin(
        tmp,
        'gpt-astra-model-list-override',
        'GptAstraModelListOverridePlugin',
        'gpt-astra-model-list-override',
      );
      const discovered = discoverPlugins(tmp);
      const ids = discovered.map((entry) => entry.metadata.id);
      const classes = discovered.map((entry) => entry.pluginClassName);
      expect(ids).toEqual(
        expect.arrayContaining(['alpha', 'beta', 'gpt-astra-model-list-override']),
      );
      expect(classes).toEqual(
        expect.arrayContaining([
          'AlphaPlugin',
          'BetaPlugin',
          'GptAstraModelListOverridePlugin',
        ]),
      );
      expect(discovered).toHaveLength(3);
      // The instance must actually be a usable object, not the metadata bag.
      expect(typeof discovered[0]?.instance.transformRequest).toBe('function');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  /**
   * The canonical regression check: discover against the SAME `dist/`
   * tree that gets shipped in the published image. This is the exact
   * shape the host hits at boot. If `npm run build` hasn't been run
   * yet, the test skips with a clear message (so `npm test` doesn't
   * fail in a fresh checkout).
   *
   * The build context can otherwise ship ignored stale plugin output
   * (a leftover `dist/plugins/<retired-id>/` directory whose source
   * is no longer in `src/plugins/`); because `dist/` is checked into
   * the image, tsc won't notice the orphan and the host would boot
   * with a ghost plugin. A clean rebuild is required to drop it.
   */
  it('discovers the built-in plugins from the compiled dist/plugins tree', () => {
    // dist/ is one directory up from src/, next to package.json.
    const distPluginsDir = resolve(__dirname, '..', '..', 'dist', 'plugins');
    if (!existsSync(distPluginsDir)) {
      // Skip with a clear pointer to the fix. We do NOT throw, because
      // unit tests must remain runnable before the first build.
      // eslint-disable-next-line no-console
      console.warn(
        `[discover.spec] dist/plugins/ missing — skipping built-shape check. ` +
          `Run \`npm run build\` to populate it.`,
      );
      return;
    }
    const discovered = discoverPlugins(distPluginsDir);
    const ids = discovered.map((entry) => entry.metadata.id);
    const classNames = discovered.map((entry) => entry.pluginClassName);

    // Positive gate: the in-tree plugins MUST be present in dist.
    expect(ids).toEqual(
      expect.arrayContaining([
        'show-all-router-views',
        'custom-provider-model-count-fix',
        'gpt-astra-model-list-override',
      ]),
    );
    expect(classNames).toEqual(
      expect.arrayContaining([
        'ShowAllRouterViewsPlugin',
        'CustomProviderModelCountFixPlugin',
        'GptAstraModelListOverridePlugin',
      ]),
    );

    // Negative gate: the retired external plugin MUST NOT be present.
    // anthropic-billing-header was removed from this repo; any leftover
    // dist artifact would still be discovered and shipped.
    expect(ids).not.toContain('anthropic-billing-header');
    expect(classNames).not.toContain('AnthropicBillingHeaderPlugin');
    expect(existsSync(join(distPluginsDir, 'anthropic-billing-header'))).toBe(
      false,
    );
  });
});

// Quiet TypeScript when the package is `dist/`-built and the import path
// shifts; this is a runtime guard for the discovery check.
if (!existsSync(PLUGINS_SRC_DIR)) {
  throw new Error(
    `src/plugins/ directory missing at ${PLUGINS_SRC_DIR}; cannot run discovery tests.`,
  );
}
if (!existsSync(dirname(__filename))) {
  throw new Error('discover.spec.ts is in an unexpected location');
}