/**
 * Plugins for mnfst/manifest.
 *
 * The plugins repo has two plugin kinds, distinguished by lifecycle:
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
 * Both kinds live in the same `plugins` array. The host detects the kind
 * by method presence (duck-typing). A plugin can implement either or
 * both kinds.
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
// Plugin registry metadata + runtime toggles
// =============================================================================

export type PluginKind = 'transform' | 'policy';

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

type ManifestPlugin = Partial<RequestTransformPlugin> & Partial<RequestPolicyPlugin>;

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
