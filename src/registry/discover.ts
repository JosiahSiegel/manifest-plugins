/**
 * Plugin auto-discovery.
 *
 * The `manifest-plugins` registry is built by walking
 * `<pluginsDir>/<name>/` directories and loading the first plugin file
 * found, in this order of preference:
 *
 *   1. `plugin.js` — the post-`tsc` compiled shape. This is the
 *      **production runtime shape**: `tsc` emits `.js` and `.d.ts`
 *      into `dist/`, never `.ts`. The host boots from `dist/` and
 *      loads via `require()`, so the discoverer MUST accept `.js`
 *      files. Failing to do so silently ships an empty plugin
 *      registry and the image falls back to upstream behavior.
 *   2. `plugin.ts` — the source shape, used during local development
 *      and unit tests that bypass the build step.
 *
 * Both shapes are inspected for:
 *   - a named class export with a `static readonly metadata: PluginMetadata`
 *   - the metadata object reachable from that class via `MyClass.metadata`
 *
 * Adding a new plugin requires only dropping a new file under
 * `src/plugins/<name>/plugin.ts` (and rebuilding). The registry re-reads
 * on every process start, so a rebuild + restart picks up new plugins
 * without touching `src/index.ts`.
 *
 * Failure modes (all throw `PluginDiscoveryError`):
 *   - `<pluginsDir>` does not exist.
 *   - A plugin file has no exported class with `static metadata`.
 *   - Two plugins share the same `metadata.id`.
 *   - Two plugins share the same exported class name.
 *
 * Subdirectories with neither `plugin.js` nor `plugin.ts` are ignored;
 * this keeps the plugins root tolerant of README-only or scratch folders.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import type {
  RequestPolicyPlugin,
  RequestTransformPlugin,
  RoutingOverridePlugin,
  DashboardTransformPlugin,
  PluginKind,
  PluginMetadata,
} from '../index';

type ManifestPlugin = Partial<RequestTransformPlugin> &
  Partial<RequestPolicyPlugin> &
  Partial<RoutingOverridePlugin> &
  Partial<DashboardTransformPlugin>;

export class PluginDiscoveryError extends Error {
  override readonly name = 'PluginDiscoveryError';
  constructor(message: string) {
    super(message);
  }
}

export interface DiscoveredPluginEntry {
  readonly pluginClassName: string;
  readonly metadata: PluginMetadata;
  readonly instance: ManifestPlugin;
}

/**
 * Resolve the plugin root. Returns an absolute path; throws on missing
 * or non-directory roots.
 */
function resolvePluginsDir(pluginsDir: string): string {
  const abs = resolve(pluginsDir);
  if (!existsSync(abs)) {
    throw new PluginDiscoveryError(
      `plugins directory not found: ${abs}`,
    );
  }
  const stat = statSync(abs);
  if (!stat.isDirectory()) {
    throw new PluginDiscoveryError(
      `plugins path is not a directory: ${abs}`,
    );
  }
  return abs;
}

/**
 * Resolve a plugin file under one plugin directory. Prefer compiled
 * `plugin.js` because production boots from `dist/`; fall back to
 * `plugin.ts` for source-mode tests and local development.
 */
function resolvePluginFile(pluginDir: string): string | null {
  const compiledFile = join(pluginDir, 'plugin.js');
  if (existsSync(compiledFile)) return compiledFile;
  const sourceFile = join(pluginDir, 'plugin.ts');
  if (existsSync(sourceFile)) return sourceFile;
  return null;
}

/**
 * Pull the (single) exported plugin class name from either supported
 * file shape:
 *   - TS source: `export class MyPlugin`
 *   - CommonJS output: `exports.MyPlugin = MyPlugin;`
 *
 * The discoverer expects exactly one named class export per file —
 * plugins are objects with one role. Metadata constants are ignored.
 */
function findExportedClassName(pluginFile: string): string | null {
  const text = readFileSync(pluginFile, 'utf-8');
  const pattern = pluginFile.endsWith('.js')
    ? /^exports\.([A-Z][A-Za-z0-9_]*)\s*=\s*\1\s*;/gm
    : /^export\s+class\s+([A-Z][A-Za-z0-9_]*)\b/gm;
  let match: RegExpExecArray | null;
  let found: string | null = null;
  while ((match = pattern.exec(text)) !== null) {
    const className = match[1];
    if (className === undefined) continue;
    if (found !== null) {
      throw new PluginDiscoveryError(
        `${pluginFile}: multiple exported classes are not allowed; found '${found}' and '${className}'`,
      );
    }
    found = className;
  }
  return found;
}

/**
 * Require a plugin file (post-`tsc`) and return the class constructor
 * plus its `static metadata`.
 */
function requirePluginClass(
  pluginFile: string,
  expectedClassName: string,
): {
  readonly className: string;
  readonly metadata: PluginMetadata;
  readonly instance: ManifestPlugin;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(pluginFile) as Record<string, unknown>;
  const candidate = mod[expectedClassName];
  if (typeof candidate !== 'function') {
    throw new PluginDiscoveryError(
      `${pluginFile}: expected exported class '${expectedClassName}' but it was not found at runtime`,
    );
  }
  const ctor = candidate as { metadata?: unknown };
  if (typeof ctor.metadata !== 'object' || ctor.metadata === null) {
    throw new PluginDiscoveryError(
      `${pluginFile}: '${expectedClassName}' is missing static 'metadata: PluginMetadata'`,
    );
  }
  const metadata = ctor.metadata as PluginMetadata;
  if (typeof metadata.id !== 'string' || metadata.id.length === 0) {
    throw new PluginDiscoveryError(
      `${pluginFile}: '${expectedClassName}.metadata.id' must be a non-empty string`,
    );
  }
  const validKinds: readonly PluginKind[] = [
    'transform',
    'policy',
    'routing-override',
    'dashboard-transform',
  ];
  if (!validKinds.includes(metadata.kind)) {
    throw new PluginDiscoveryError(
      `${pluginFile}: '${expectedClassName}.metadata.kind' must be one of ${validKinds.join(', ')}, got '${metadata.kind as string}'`,
    );
  }
  const instance = new (candidate as new () => ManifestPlugin)();
  return { className: expectedClassName, metadata, instance };
}

/**
 * Discover all plugins under `pluginsDir` by reading each
 * `<pluginsDir>/<name>/plugin.{js,ts}`. Returns an array of discovered
 * entries, ordered by directory name (alphabetical) so the registry
 * is deterministic across machines.
 *
 * Throws `PluginDiscoveryError` on the first validation failure.
 */
export function discoverPlugins(pluginsDir: string): DiscoveredPluginEntry[] {
  const absDir = resolvePluginsDir(pluginsDir);
  const entries: Array<{
    readonly dir: string;
    readonly pluginFile: string;
  }> = [];
  for (const child of readdirSync(absDir)) {
    if (child.startsWith('.')) continue;
    const childAbs = join(absDir, child);
    const stat = statSync(childAbs);
    if (!stat.isDirectory()) continue;
    const pluginFile = resolvePluginFile(childAbs);
    if (pluginFile === null) continue;
    entries.push({ dir: child, pluginFile });
  }
  entries.sort((a, b) => a.dir.localeCompare(b.dir));

  const seenClassNames = new Map<string, string>();
  const seenIds = new Map<string, string>();
  const discovered: DiscoveredPluginEntry[] = [];

  for (const { pluginFile } of entries) {
    const className = findExportedClassName(pluginFile);
    if (className === null) continue;
    if (seenClassNames.has(className)) {
      throw new PluginDiscoveryError(
        `duplicate class name '${className}' (already discovered from ${seenClassNames.get(className)}; also found at ${pluginFile})`,
      );
    }
    const loaded = requirePluginClass(pluginFile, className);
    if (seenIds.has(loaded.metadata.id)) {
      throw new PluginDiscoveryError(
        `duplicate metadata.id '${loaded.metadata.id}' (already discovered from ${seenIds.get(loaded.metadata.id)}; also found at ${pluginFile})`,
      );
    }
    seenClassNames.set(className, pluginFile);
    seenIds.set(loaded.metadata.id, pluginFile);
    discovered.push({
      pluginClassName: loaded.className,
      metadata: loaded.metadata,
      instance: loaded.instance,
    });
  }

  return discovered;
}