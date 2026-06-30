import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import * as registry from '../src/index';
import {
  DefaultPolicyPlugin,
  HeaderTierRouterPlugin,
} from '../src/index';

type PluginKind = 'transform' | 'policy' | 'routing-override';

interface InstalledPluginMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly kind: PluginKind;
  readonly enabledByDefault: boolean;
  readonly enabled: boolean;
}

type InstalledPluginsGetter = () => readonly InstalledPluginMetadata[];
type PluginEnabledSetter = (pluginId: string, enabled: boolean) => void;

function readRegistryExport(name: string): unknown {
  return Reflect.get(registry, name);
}

function isInstalledPluginsGetter(value: unknown): value is InstalledPluginsGetter {
  return typeof value === 'function';
}

function isPluginEnabledSetter(value: unknown): value is PluginEnabledSetter {
  return typeof value === 'function';
}

function getInstalledPlugins(): readonly InstalledPluginMetadata[] {
  const candidate = readRegistryExport('getInstalledPlugins');
  expect(candidate).toEqual(expect.any(Function));
  if (!isInstalledPluginsGetter(candidate)) {
    throw new Error('getInstalledPlugins export is missing from manifest-plugins');
  }
  return candidate();
}

function setPluginEnabled(pluginId: string, enabled: boolean): void {
  const candidate = readRegistryExport('setPluginEnabled');
  expect(candidate).toEqual(expect.any(Function));
  if (!isPluginEnabledSetter(candidate)) {
    throw new Error('setPluginEnabled export is missing from manifest-plugins');
  }
  candidate(pluginId, enabled);
}

function findPluginMetadata(
  installed: readonly InstalledPluginMetadata[],
  pluginId: string,
): InstalledPluginMetadata {
  const metadata = installed.find((plugin) => plugin.id === pluginId);
  if (metadata === undefined) {
    throw new Error(`installed plugin metadata is missing for ${pluginId}`);
  }
  return metadata;
}

function resetRuntimeEnabledState(): void {
  const candidate = readRegistryExport('setPluginEnabled');
  if (!isPluginEnabledSetter(candidate)) return;
  candidate('default-policy', true);
  candidate('header-tier-router', true);
}

function withTempFilterProject(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'manifest-plugins-filter-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFile(root: string, relativePath: string, content: string): void {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
}

// Fixture dist/index.js emitted by tsc after the MVP registry contract was
// introduced. Note: anthropic-billing-header is now an external plugin (see
// docs/EXTERNAL_PLUGINS.md), so it does not appear in the in-tree fixture.
// The two in-tree built-in plugins remain: default-policy and
// header-tier-router.
const FILTER_DIST_FIXTURE = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setPluginEnabled = exports.getInstalledPlugins = exports.plugins = exports.installedPlugins = void 0;
const plugin_1 = require("./plugins/default-policy/plugin");
const plugin_2 = require("./plugins/header-tier-router/plugin");
const defaultPolicyPlugin = Object.freeze(new plugin_1.DefaultPolicyPlugin());
const headerTierRouterPlugin = Object.freeze(new plugin_2.HeaderTierRouterPlugin());
const pluginRegistry = Object.freeze([
  Object.freeze({
    pluginClassName: 'DefaultPolicyPlugin',
    instance: defaultPolicyPlugin,
    enabledByDefault: true,
  }),
  Object.freeze({
    pluginClassName: 'HeaderTierRouterPlugin',
    instance: headerTierRouterPlugin,
    enabledByDefault: true,
  }),
]);
exports.installedPlugins = Object.freeze(pluginRegistry.map((entry) => entry.instance));
exports.plugins = Object.freeze(pluginRegistry.map((entry) => entry.instance));
function getInstalledPlugins() {
  return Object.freeze(pluginRegistry.map((entry) => Object.freeze({
    id: 'placeholder',
    enabledByDefault: entry.enabledByDefault,
    enabled: entry.enabledByDefault,
  })));
}
exports.getInstalledPlugins = getInstalledPlugins;
function setPluginEnabled() {}
exports.setPluginEnabled = setPluginEnabled;
function idOfEntry(entry) {
  return entry.pluginClassName.toLowerCase().includes('defaultpolicy')
    ? 'default-policy'
    : 'header-tier-router';
}
function idToIndex() {
  return -1;
}
`;

describe('plugin-toggle MVP registry contract', () => {
  afterEach(() => {
    resetRuntimeEnabledState();
  });

  it('exports installed plugin metadata for both built-in plugins', () => {
    const installed = getInstalledPlugins();

    expect(installed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'default-policy',
          name: expect.any(String),
          version: expect.any(String),
          description: expect.any(String),
          kind: 'policy',
          enabledByDefault: true,
        }),
        expect.objectContaining({
          id: 'header-tier-router',
          name: expect.any(String),
          version: expect.any(String),
          description: expect.any(String),
          kind: 'routing-override',
          enabledByDefault: true,
        }),
      ]),
    );
  });

  it('can disable a policy plugin at runtime while leaving it discoverable', () => {
    setPluginEnabled('default-policy', false);

    expect(registry.plugins).not.toContainEqual(
      expect.any(DefaultPolicyPlugin),
    );
    expect(registry.plugins).toContainEqual(expect.any(HeaderTierRouterPlugin));

    const metadata = findPluginMetadata(
      getInstalledPlugins(),
      'default-policy',
    );
    expect(metadata).toEqual(
      expect.objectContaining({
        id: 'default-policy',
        kind: 'policy',
        enabledByDefault: true,
        enabled: false,
      }),
    );
  });

  it('can disable a routing-override plugin at runtime', () => {
    setPluginEnabled('header-tier-router', false);

    expect(registry.plugins).toContainEqual(expect.any(DefaultPolicyPlugin));
    expect(registry.plugins).not.toContainEqual(
      expect.any(HeaderTierRouterPlugin),
    );

    const metadata = findPluginMetadata(getInstalledPlugins(), 'header-tier-router');
    expect(metadata).toEqual(
      expect.objectContaining({
        id: 'header-tier-router',
        kind: 'routing-override',
        enabledByDefault: true,
        enabled: false,
      }),
    );
  });
});

describe('filter-plugins build-time config contract', () => {
  it('keeps false-config plugins discoverable instead of stripping them', () => {
    withTempFilterProject((root) => {
      const filterScript = readFileSync('scripts/filter-plugins.mjs', 'utf-8');
      writeFile(root, 'scripts/filter-plugins.mjs', filterScript);
      writeFile(root, 'dist/index.js', FILTER_DIST_FIXTURE);
      // The `parseRegistryClassNames` walker walks `dist/plugins/*/plugin.js`
      // for `exports.<ClassName> = ...` declarations. Stage one such
      // file per fixture plugin so the walker finds them.
      writeFile(
        root,
        'dist/plugins/default-policy/plugin.js',
        'exports.DefaultPolicyPlugin = class DefaultPolicyPlugin {};\n',
      );
      writeFile(
        root,
        'dist/plugins/header-tier-router/plugin.js',
        'exports.HeaderTierRouterPlugin = class HeaderTierRouterPlugin {};\n',
      );
      writeFile(
        root,
        'manifest-plugins.config.json',
        JSON.stringify({
          plugins: {
            DefaultPolicyPlugin: false,
            HeaderTierRouterPlugin: true,
          },
        }),
      );

      const result = spawnSync(process.execPath, ['scripts/filter-plugins.mjs'], {
        cwd: root,
        encoding: 'utf-8',
      });
      expect(result.status).toBe(0);

      const filtered = readFileSync(join(root, 'dist/index.js'), 'utf-8');
      // The DefaultPolicyPlugin was disabled (set false in config),
      // so the filter script must flip its enabledByDefault from true to
      // false while leaving the pluginClassName marker in dist. We assert
      // on those two observable side effects.
      expect(filtered).toContain("pluginClassName: 'DefaultPolicyPlugin'");
      expect(filtered).not.toContain(
        "pluginClassName: 'DefaultPolicyPlugin',\\n    instance: defaultPolicyPlugin,\\n    enabledByDefault: true",
      );
    });
  });
});