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
import { AnthropicBillingHeaderPlugin } from './plugins/anthropic-billing-header/plugin';
import { DefaultPolicyPlugin } from './plugins/default-policy/plugin';
import { HeaderTierRouterPlugin } from './plugins/header-tier-router/plugin';

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
// Plugin registry metadata + runtime toggles
// =============================================================================

export type PluginKind = 'transform' | 'policy' | 'routing-override';

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
  Partial<RoutingOverridePlugin>;

interface PluginRegistryEntry {
  readonly pluginClassName: string;
  readonly metadata: PluginMetadata;
  readonly instance: ManifestPlugin;
  readonly enabledByDefault: boolean;
}

const anthropicBillingHeaderPlugin = Object.freeze(
  new AnthropicBillingHeaderPlugin(),
);
const defaultPolicyPlugin = Object.freeze(new DefaultPolicyPlugin());
const headerTierRouterPlugin = Object.freeze(new HeaderTierRouterPlugin());

const pluginRegistry: readonly PluginRegistryEntry[] = Object.freeze([
  Object.freeze({
    pluginClassName: 'AnthropicBillingHeaderPlugin',
    metadata: AnthropicBillingHeaderPlugin.metadata,
    instance: anthropicBillingHeaderPlugin,
    enabledByDefault: true,
  }),
  Object.freeze({
    pluginClassName: 'DefaultPolicyPlugin',
    metadata: DefaultPolicyPlugin.metadata,
    instance: defaultPolicyPlugin,
    enabledByDefault: true,
  }),
  Object.freeze({
    pluginClassName: 'HeaderTierRouterPlugin',
    metadata: HeaderTierRouterPlugin.metadata,
    instance: headerTierRouterPlugin,
    enabledByDefault: true,
  }),
]);

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

export { AnthropicBillingHeaderPlugin } from './plugins/anthropic-billing-header/plugin';
export { DefaultPolicyPlugin } from './plugins/default-policy/plugin';
export { HeaderTierRouterPlugin } from './plugins/header-tier-router/plugin';
