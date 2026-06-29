/**
 * Unit tests for the plugin auto-discoverer.
 *
 * The discoverer scans `src/plugins/<name>/plugin.ts` and extracts the
 * named class export + `static metadata` for each plugin file. Adding a
 * new plugin requires only dropping a new file in the plugins directory —
 * the registry re-reads on every build.
 *
 * Locks the Wave 2 contract:
 *   - Named class exports (no `default` required).
 *   - `static metadata` with a unique `id` is required.
 *   - Throws loudly on duplicate class names AND duplicate `metadata.id`.
 *   - Discovers the 3 built-in plugins from the real `src/plugins/`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
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
  it('discovers the three built-in plugins from src/plugins/', () => {
    const discovered = discoverPlugins(PLUGINS_SRC_DIR);

    const classNames = discovered.map((entry) => entry.pluginClassName);
    expect(classNames).toEqual(
      expect.arrayContaining([
        'AnthropicBillingHeaderPlugin',
        'DefaultPolicyPlugin',
        'HeaderTierRouterPlugin',
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
        expect.stringMatching(/^(transform|policy|routing-override)$/),
      );
      expect(entry.instance).toBeDefined();
    }
  });

  it('discovers plugins in a tempdir fixture (named class export + static metadata)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-'));
    try {
      writeTempPlugin(tmp, 'alpha', 'AlphaPlugin', 'alpha');
      writeTempPlugin(tmp, 'beta', 'BetaPlugin', 'beta');
      const discovered = discoverPlugins(tmp);
      const ids = discovered.map((entry) => entry.metadata.id);
      expect(ids).toEqual(expect.arrayContaining(['alpha', 'beta']));
      expect(discovered).toHaveLength(2);
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

  it('skips subdirectories without a plugin.ts', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-discover-skip-'));
    try {
      writeTempPlugin(tmp, 'real', 'RealPlugin', 'real');
      mkdirSync(join(tmp, 'no-plugin-here'), { recursive: true });
      expect(discoverPlugins(tmp)).toHaveLength(1);
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