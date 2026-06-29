/**
 * Plugin auto-discovery.
 *
 * The `manifest-plugins` registry is built by walking
 * `<pluginsDir>/<name>/plugin.ts` files. Each file is loaded with
 * `require()` (post-`tsc` build) and inspected for:
 *   - a named class export with a `static readonly metadata: PluginMetadata`
 *   - the metadata object reachable from that class via `MyClass.metadata`
 *
 * Adding a new plugin requires only dropping a new file under
 * `src/plugins/<name>/plugin.ts`. The registry re-reads on every
 * process start, so a rebuild + restart picks up new plugins
 * without touching `src/index.ts`.
 *
 * Failure modes (all throw `PluginDiscoveryError`):
 *   - `<pluginsDir>` does not exist.
 *   - A plugin file has no exported class with `static metadata`.
 *   - Two plugins share the same `metadata.id`.
 *   - Two plugins share the same exported class name.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import type {
  RequestPolicyPlugin,
  RequestTransformPlugin,
  RoutingOverridePlugin,
  PluginKind,
  PluginMetadata,
} from '../index';

type ManifestPlugin = Partial<RequestTransformPlugin> &
  Partial<RequestPolicyPlugin> &
  Partial<RoutingOverridePlugin>;

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
 * Find a plugin's `plugin.ts` under `<pluginsDir>/<dir>/plugin.ts`.
 * Returns absolute paths; throws on missing or non-directory root.
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
 * Pull the (single) class export name from a TS plugin file. The
 * discoverer expects exactly one named class export per file — plugins
 * are objects with one role. We read the file as text and look for
 * `export class <Name>` (and ignore `export const` declarations).
 */
function findExportedClassName(pluginFile: string): string | null {
  const text = readFileSync(pluginFile, 'utf-8');
  const pattern = /^export\s+class\s+([A-Z][A-Za-z0-9_]*)\b/gm;
  let match: RegExpExecArray | null;
  let found: string | null = null;
  while ((match = pattern.exec(text)) !== null) {
    if (found !== null) {
      throw new PluginDiscoveryError(
        `${pluginFile}: multiple exported classes are not allowed; found '${found}' and '${match[1]}'`,
      );
    }
    found = match[1] as string;
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
 * `<pluginsDir>/<name>/plugin.ts`. Returns an array of discovered
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
    const pluginFile = join(childAbs, 'plugin.ts');
    if (!existsSync(pluginFile)) continue;
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