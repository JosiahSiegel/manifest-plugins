/**
 * Plugins for mnfst/manifest.
 *
 * The plugins repo has three plugin kinds, distinguished by lifecycle:
 *
 *   - RequestTransformPlugin — per-request, called by the host in
 *     `provider-client.ts` immediately before the upstream HTTP fetch.
 *     Lets the plugin mutate headers, body, or URL (e.g. inject OAuth
 *     billing headers, prepend a system-prompt preamble).
 *
 *   - RequestPolicyPlugin — config-time, called by the host in
 *     `proxy-rate-limiter.ts` and `proxy.service.ts` constructors. Lets
 *     the plugin set per-agent concurrency caps, message-array caps, etc.
 *     Called once per process (the result is cached in the host).
 *
 *   - RoutingOverridePlugin — per-request, called by the host in
 *     `proxy.service.ts::resolveRouting()` BEFORE the upstream router
 *     selects a provider/model. Lets the plugin override the routing
 *     decision (e.g. honor a `x-manifest-tier` request header even when
 *     the request body contains a concrete `model` ID, restoring the
 *     pre-`2ab748a6` precedence where header tiers win over body model).
 *     The host fetches the data the plugin needs (configured header
 *     tiers + discovered models) and passes it in the context; the
 *     plugin returns a routing override or `null` to defer.
 *
 * All three kinds live in the same `plugins` array. The host detects the
 * kind by method presence (duck-typing). A plugin can implement any
 * combination.
 *
 * To add a new plugin:
 *   1. Create `src/plugins/<name>/plugin.ts` implementing the interface(s).
 *   2. Add the plugin instance to the registry below.
 *   3. `npm test && npm run build` and push.
 *
 * The apply tool (`src/host/cli.ts`) handles the source-code side: it
 * patches `provider-client.ts`, `proxy-rate-limiter.ts`, and
 * `proxy.service.ts` to install the host extensions. After every
 * `git pull` of upstream, run `npm run apply -- /path/to/manifest` to
 * re-inject the hosts. No fork repo or housekeeping overlay needed.
 */
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { applyDisabledListFromEnv } from './host/env-toggle';
import { discoverPlugins } from './registry/discover';

// =============================================================================
// RequestTransformPlugin — per-request hook
// =============================================================================

/**
 * The host calls each plugin's `transformRequest(decision)` synchronously
 * before forwarding the outgoing request. Plugins can:
 *   - Add / overwrite headers (e.g. OAuth billing headers).
 *   - Mutate the request body (e.g. inject a static system-prompt preamble).
 *   - Replace the upstream URL (rare; e.g. shadow-route to a staging endpoint).
 *
 * Each field in the return value is optional. Unspecified fields fall back to
 * the values the host already computed from the upstream Manifest pipeline.
 *
 * Plugin errors MUST be non-fatal: the host catches and logs them and
 * continues with the original request. Never throw to abort the request.
 */
export interface RequestTransformDecision {
  /** Endpoint key (e.g. `'anthropic'`, `'openai'`, `'byteplus-anthropic'`). */
  readonly endpointKey: string;
  /** Routing-layer provider id (e.g. `'anthropic'`, `'custom:foo'`). */
  readonly provider: string;
  /** Model name with vendor prefix stripped. */
  readonly bareModel: string;
  /** Resolved API key / OAuth token for the upstream call. */
  readonly apiKey: string;
  /** `'api_key' | 'subscription' | undefined`. */
  readonly authType: string | undefined;
  /** Inbound API mode (chat_completions | responses | messages). */
  readonly apiMode?: string;
  /** Whether the caller asked for streaming. */
  readonly stream: boolean;
  /** Outgoing URL the host computed. */
  readonly url: string;
  /** Outgoing headers the host computed. */
  readonly headers: Readonly<Record<string, string>>;
  /** Outgoing request body the host computed. */
  readonly requestBody: Readonly<Record<string, unknown>>;
}

export interface RequestTransformResult {
  url?: string;
  headers?: Record<string, string>;
  requestBody?: Record<string, unknown>;
}

export interface RequestTransformPlugin {
  transformRequest(
    decision: RequestTransformDecision,
  ): RequestTransformResult | undefined;
}

// =============================================================================
// RequestPolicyPlugin — config-time hook
// =============================================================================

/**
 * The host calls each plugin's `getRateLimitPolicy()` once at process
 * start (cached for the process lifetime). The first non-null field
 * returned by any plugin wins; later plugins are skipped for that field.
 * Plugins that throw are caught and logged; the host falls through to
 * the next plugin and ultimately to the env-var fallback.
 *
 * Returning `null` from `getRateLimitPolicy()` means "I have no opinion"
 * and the host skips to the next plugin. Returning `undefined` has the
 * same effect (back-compat alias).
 */
export interface RateLimitPolicy {
  /**
   * Per-agent concurrent-request cap (how many in-flight Anthropic
   * requests one tenant can have at once). `null` means "no opinion;
   * use the env-var default".
   */
  readonly concurrencyMax: number | null;
  /**
   * Per-request message-array cap (size of the `messages` array). `null`
   * means "no opinion; use the env-var default (or upstream's default
   * of 1000 if no env var is set)".
   */
  readonly maxMessagesPerRequest: number | null;
}

export interface RequestPolicyPlugin {
  /**
   * Called once per process. Return a static policy or `null` to defer.
   * The host walks the plugin array in order; the first non-null
   * concurrencyMax wins, then the first non-null maxMessagesPerRequest
   * wins, independently.
   */
  getRateLimitPolicy(): RateLimitPolicy | null;
}

// =============================================================================
// RoutingOverridePlugin — pre-routing hook
// =============================================================================

/**
 * The structural shape of a single `header_tiers` row (mirrors
 * `mnfst/manifest` `packages/backend/src/entities/header-tier.entity.ts`).
 *
 * The host fetches the configured tiers once per request via
 * `HeaderTierService.list(agentId)` and passes them in
 * {@link RoutingOverrideContext.headerTiers}. Plugins read this array
 * to find a matching rule and return its `override_route` as a routing
 * override. The plugin MUST NOT mutate this object.
 */
export interface RoutingOverrideHeaderTier {
  readonly id: string;
  readonly name: string;
  readonly header_key: string;
  readonly header_value: string;
  readonly enabled: boolean;
  readonly sort_order: number;
  readonly badge_color: string | null;
  /**
   * The configured route for this tier. `null` when the row was
   * created without an explicit (provider, authType, model) triple —
   * upstream `resolveHeaderTier` silently falls through in that case.
   * Plugins SHOULD treat `null` as "no opinion" and return `null`.
   */
  readonly override_route: RoutingOverrideRoute | null;
  readonly fallback_routes: readonly RoutingOverrideRoute[] | null;
  readonly output_modality: string | null;
  readonly response_mode: string | null;
}

/**
 * The structural shape of `override_route` / `fallback_routes` jsonb
 * columns. Mirrors `mnfst/manifest` `packages/shared/src/tiers.ts`
 * `ModelRoute` (camelCase) but typed loosely because the host cannot
 * import the upstream type without breaking upstream compilability.
 */
export interface RoutingOverrideRoute {
  readonly provider: string;
  readonly authType: string;
  readonly model: string;
  readonly keyLabel?: string | null;
}

/**
 * The structural shape of a single discovered model row (mirrors
 * `mnfst/manifest` `packages/backend/src/routing/model-discovery/model-fetcher.ts`
 * `DiscoveredModel`).
 */
export interface RoutingOverrideDiscoveredModel {
  readonly id: string;
  readonly provider: string;
  readonly authType?: string;
}

/**
 * The host-supplied context passed to every `RoutingOverridePlugin`
 * during `proxy.service.ts::resolveRouting()`. The host does all the
 * DB / Nest work; the plugin only reads.
 */
export interface RoutingOverrideContext {
  readonly agentId: string;
  readonly tenantId: string;
  /** Inbound HTTP API mode (`chat_completions` | `responses` | `messages`). */
  readonly apiMode: string;
  /** Inbound request body (untyped; plugins should treat as opaque). */
  readonly body: Readonly<Record<string, unknown>>;
  /** Raw inbound HTTP headers (string | string[] | undefined per Express). */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /**
   * `model` field parsed from `body.model` if it was a string, otherwise
   * `undefined`. The host does this parsing once and shares the result.
   */
  readonly requestedModel: string | undefined;
  /** Configured header tiers for the agent (already filtered server-side). */
  readonly headerTiers: readonly RoutingOverrideHeaderTier[];
  /** Discovered models for the agent (used to resolve provider IDs). */
  readonly discoveredModels: readonly RoutingOverrideDiscoveredModel[];
}

/**
 * The structural shape of a successful `overrideRouting()` return.
 *
 * Mirrors `mnfst/manifest` `packages/backend/src/routing/resolve/resolve.service.ts`
 * `ResolveResponse`. When a plugin returns this object, the host uses it
 * as the `ResolvedRouting` for the request — short-circuiting both the
 * upstream `2ab748a6` explicit-model branch and the upstream
 * `resolveHeaderTier` silent fall-through.
 */
export interface RoutingOverrideResolvedRouting {
  readonly tier?: string;
  readonly route: RoutingOverrideRoute | null;
  readonly fallback_routes?: readonly RoutingOverrideRoute[] | null;
  readonly response_mode?: string | null;
  readonly confidence?: number;
  readonly score?: number;
  readonly reason?: string;
  readonly header_tier_id?: string;
  readonly header_tier_name?: string;
  readonly header_tier_color?: string | null;
  /**
   * Output modality for the matched header tier (mirrors upstream's
   * `ResolvedRouting.output_modality`). Surfaced from the configured
   * `header_tiers` row so downstream consumers (and upstream's
   * `proxy-response-handler.ts`) see the same shape that the
   * header-tier resolver would have produced pre-`2ab748a6`.
   */
  readonly output_modality?: string | null;
  /** Should be `false` when the override is from a header-tier match. */
  readonly explicit_model_override?: boolean;
}

export interface RoutingOverridePlugin {
  /**
   * Called once per request by the host, BEFORE the upstream router
   * selects a provider/model. Return a `RoutingOverrideResolvedRouting`
   * to short-circuit upstream routing, or `null` to defer.
   *
   * Plugin errors MUST be non-fatal: the host catches and logs them and
   * continues with the upstream default. Never throw to abort the
   * request.
   */
  overrideRouting(ctx: RoutingOverrideContext): RoutingOverrideResolvedRouting | null;
}

// =============================================================================
// DashboardTransformPlugin — browser-side dashboard augmentation
// =============================================================================

/**
 * Plugins that augment the Manifest dashboard's browser-side
 * rendering. The host (admin server) collects `getDashboardScript()`
 * from every enabled `dashboard-transform` plugin, concatenates the
 * results into a single IIFE bundle served at
 * `/admin/dashboard-transform/all.js`, and the dashboard mount
 * overlay injects a single `<script src="/admin/dashboard-transform/all.js" defer>`
 * tag into `packages/frontend/index.html`. Each plugin's script
 * registers itself on `window.__manifestPluginsDashboardTransform`
 * and the bundle iterates that registry on `DOMContentLoaded`.
 *
 * Use cases:
 *   - Audit tools (e.g. `show-all-router-views` shows every
 *     configured routing rule, including ones the upstream UI hides
 *     via the deprecation gate).
 *   - DOM-level patches to expose hidden tabs / panels.
 *   - Floating action buttons that fetch additional data via the
 *     public API.
 *
 * The script MUST:
 *   - Be self-contained (no external imports, no require/import
 *     statements — it runs in a browser without a module loader).
 *   - Wrap its body in an IIFE so it does not leak globals.
 *   - Be idempotent (safe to re-run on HMR / route change).
 *   - No-op on pages that are not relevant.
 *   - Use safe DOM construction (createElement + textContent /
 *     appendChild) for any user-controlled data. Never assign
 *     user-controlled strings to innerHTML.
 *
 * The script SHOULD:
 *   - Register itself on `window.__manifestPluginsDashboardTransform`
 *     so the host can introspect which plugins are loaded.
 *   - Use CSS variables (`hsl(var(--foreground))`, etc.) so the
 *     injected UI adopts the dashboard's theme (light / dark).
 *
 * Plugin errors MUST be non-fatal: the host catches and logs them
 * and continues with the upstream dashboard. Never throw to abort
 * the dashboard.
 */
export interface DashboardTransformPlugin {
  /**
   * Return a self-contained JavaScript string to run in the
   * Manifest dashboard's browser context. The string is concatenated
   * into the combined bundle as-is — do NOT include a closing
   * `<script>` tag or any HTML; just the JavaScript.
   *
   * Returning `null` or `undefined` means "I have nothing to add
   * right now" and the host omits the plugin from the bundle. The
   * plugin still ships enabled in the admin UI so the operator can
   * see it's installed.
   */
  getDashboardScript(): string | null;
}

// =============================================================================
// Plugin registry metadata + runtime toggles
// =============================================================================

export type PluginKind = 'transform' | 'policy' | 'routing-override' | 'dashboard-transform';

export interface PluginMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly kind: PluginKind;
}

export interface InstalledPluginMetadata extends PluginMetadata {
  readonly enabledByDefault: boolean;
  readonly enabled: boolean;
}

type ManifestPlugin = Partial<RequestTransformPlugin> &
  Partial<RequestPolicyPlugin> &
  Partial<RoutingOverridePlugin> &
  Partial<DashboardTransformPlugin>;

interface PluginRegistryEntry {
  readonly pluginClassName: string;
  readonly metadata: PluginMetadata;
  readonly instance: ManifestPlugin;
  readonly enabledByDefault: boolean;
}

/**
 * Discover every plugin under `<__dirname>/plugins/` at module load.
 * Adding a new plugin requires only dropping a new directory with a
 * `plugin.ts` source file (which `tsc` compiles to `plugin.js`); the
 * discoverer prefers the compiled `plugin.js` and falls back to the
 * source `plugin.ts`, so the registry re-reads on every build / process
 * start and works for both local development and the production image.
 */
function loadPluginRegistry(): readonly PluginRegistryEntry[] {
  const discovered = discoverPlugins(join(__dirname, 'plugins'));
  return Object.freeze(
    discovered.map((entry) =>
      Object.freeze({
        pluginClassName: entry.pluginClassName,
        metadata: entry.metadata,
        instance: entry.instance,
        enabledByDefault: true,
      }),
    ),
  );
}

const pluginRegistry: readonly PluginRegistryEntry[] = loadPluginRegistry();

/** All installed plugin instances, regardless of their runtime enabled state. */
export const installedPlugins: readonly ManifestPlugin[] = Object.freeze(
  pluginRegistry.map((entry) => entry.instance),
);

const enabledOverrides = new Map<string, boolean>();

function isPluginEnabled(entry: PluginRegistryEntry): boolean {
  return enabledOverrides.get(entry.metadata.id) ?? entry.enabledByDefault;
}

function getEnabledPluginInstances(): readonly ManifestPlugin[] {
  return Object.freeze(
    pluginRegistry
      .filter((entry) => isPluginEnabled(entry))
      .map((entry) => entry.instance),
  );
}

/**
 * Enabled plugin instances consumed by the host. Reassigned when runtime
 * overrides change so `require('manifest-plugins').plugins` stays current.
 */
export let plugins: readonly ManifestPlugin[] = getEnabledPluginInstances();

export function getInstalledPlugins(): readonly InstalledPluginMetadata[] {
  return Object.freeze(
    pluginRegistry.map((entry) =>
      Object.freeze({
        ...entry.metadata,
        enabledByDefault: entry.enabledByDefault,
        enabled: isPluginEnabled(entry),
      }),
    ),
  );
}

export function setPluginEnabled(pluginId: string, enabled: boolean): void {
  enabledOverrides.set(pluginId, enabled);
  plugins = getEnabledPluginInstances();
}

// =============================================================================
// Re-exports for plugin authors
// =============================================================================
//
// Built-in plugins are re-exported here for direct import by plugin authors
// who want to compose or test them. External plugins (e.g.
// anthropic-billing-header — see docs/EXTERNAL_PLUGINS.md) are NOT re-exported
// because their source doesn't live in this repo; consumers fetch them via
// the external-plugins loader and `require('manifest-plugins').loadPlugin(...)`.

export { DefaultPolicyPlugin } from './plugins/default-policy/plugin';
export { HeaderTierRouterPlugin } from './plugins/header-tier-router/plugin';
export {
  ShowAllRouterViewsPlugin,
  SHOW_ALL_ROUTER_VIEWS_PLUGIN_METADATA,
  SHOW_ALL_ROUTER_VIEWS_SCRIPT,
} from './plugins/show-all-router-views/plugin';

// =============================================================================
// Re-exports for the pasted host snippets
// =============================================================================

/**
 * Read `MANIFEST_PLUGINS_DISABLED` (or a caller-supplied value) and
 * disable each parsed plugin id at runtime. Called once per host
 * snippet at module load, BEFORE the plugin walk, so the plugin walk
 * already reflects the env-var-driven disable state.
 *
 * Exported here so the pasted snippets (which can only reach the
 * host package via `require('manifest-plugins')`) can invoke it.
 * The pure parse helper `parseDisabledList` is also re-exported for
 * callers that want to pre-flight the env value.
 */
export { applyDisabledListFromEnv, parseDisabledList } from './host/env-toggle';

/**
 * The plugin admin Express app factory. Exposed so the host's `main.ts`
 * patch (see `src/host/snippet.ts::ADMIN_MOUNT_NEW`) can mount the admin
 * routes (`/api/plugins/*` + `/admin/admin.js`) on the same Express
 * instance as the dashboard. The host snippet wraps the mount call in
 * a best-effort try/catch so a missing `manifest-plugins` package (e.g.
 * upstream without the fork's plugin layer) is a silent no-op.
 */
export { createAdminServer, startAdminServer } from './admin/server';

// =============================================================================
// Persisted state boot (MANIFEST_PLUGINS_STATE_FILE)
// =============================================================================

import { loadPluginState, savePluginState, type PluginStateFile } from './registry/state';

const DEFAULT_STATE_FILE = '/app/data/plugin-state.json';

export function getPersistedStateFile(): string {
  return process.env['MANIFEST_PLUGINS_STATE_FILE'] ?? DEFAULT_STATE_FILE;
}

/**
 * Apply the persisted state on top of the in-memory `enabledOverrides` map.
 * Called once at module load. The `MANIFEST_PLUGINS_DISABLED` env var is
 * a precedence-OVERRIDE — when both are set, the env var wins (so a
 * container restart with env-var-only config keeps working).
 *
 * Idempotent: re-running is a no-op when no env var and no state file.
 */
function bootPersistedState(): void {
  const stateFile = getPersistedStateFile();
  // If the state file is at the default path AND it does not exist
  // AND no env var is set, this is a no-op. Operators who want a
  // fresh state file just `npm run plugins:disable <id>` once.
  const persisted = loadPluginState(stateFile);
  for (const [id, enabled] of Object.entries(persisted)) {
    setPluginEnabled(id, enabled);
  }
  // The env var wins — applied LAST so it overrides any persisted value.
  applyDisabledListFromEnv(process.env['MANIFEST_PLUGINS_DISABLED']);
}

bootPersistedState();

/**
 * Reset the persisted state: delete the state file AND clear the
 * in-memory overrides so every plugin returns to its
 * `enabledByDefault` value. Used by the CLI's `reset` subcommand.
 * No-op when the state file does not exist.
 */
export function resetPersistedPluginState(): void {
  const stateFile = getPersistedStateFile();
  // Clear in-memory first so the next getInstalledPlugins() reflects defaults.
  for (const entry of pluginRegistry) {
    enabledOverrides.delete(entry.metadata.id);
  }
  plugins = getEnabledPluginInstances();
  // Then drop the file. If the env var is set, re-apply its precedence.
  try {
    if (existsSync(stateFile)) {
      unlinkSync(stateFile);
    }
  } catch {
    // ignore — file is best-effort cleanup
  }
  applyDisabledListFromEnv(process.env['MANIFEST_PLUGINS_DISABLED']);
}
