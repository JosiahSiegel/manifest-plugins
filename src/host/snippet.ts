/**
 * The plugin-host TS source that gets pasted into a Manifest
 * `packages/backend/src/routing/proxy/provider-client.ts` checkout.
 *
 * The two constants exported here are:
 *   - `HOST_HELPER_SOURCE`     — the `applyRequestTransformPlugins(...)` helper
 *                                inserted immediately before the
 *                                `@Injectable() export class ProviderClient {`
 *                                class declaration.
 *   - `RETURN_REPLACEMENT`     — the wrapper that calls the helper before the
 *                                Anthropic branch's `return { ... }`.
 *
 * The `apply.ts` tool uses these strings verbatim when patching a clean
 * Manifest checkout. Keeping them as TypeScript template literals lets us
 * type-check and unit-test the patcher against the same source it ships.
 *
 * Why `require()` and not `import`? Upstream Manifest's `provider-client.ts`
 * has no existing import for the plugin package. Adding an `import` line
 * would fail tsc whenever the plugins package isn't installed (i.e. on
 * upstream itself and on CI without the fork's plugin layer). `require`
 * inside try/catch degrades to a no-op when the module is missing, so the
 * upstream source stays compilable in either state.
 */
export const HOST_HELPER_SOURCE = `/**
 * Fork: apply registered request-transform plugins to the Anthropic outgoing
 * request. Plugins live in the sibling \`manifest-plugins\` repo and are loaded
 * via \`require('manifest-plugins')\`. If the package is not installed (e.g. on
 * upstream or in CI without the fork's plugin layer), this is a no-op.
 *
 * Plugin contract: each entry in \`require('manifest-plugins').plugins\` is an
 * object with a synchronous \`transformRequest(decision)\` method that returns
 * \`{ url?, headers?, requestBody? }\` with optional overrides. Plugin errors
 * are caught and logged; one broken plugin must not break the request.
 */
function applyRequestTransformPlugins(
  decision: {
    endpointKey: string;
    provider: string;
    bareModel: string;
    apiKey: string;
    authType: string | undefined;
    apiMode?: string;
    stream: boolean;
  },
  current: {
    url: string;
    headers: Record<string, string>;
    requestBody: Record<string, unknown>;
  },
): {
  url: string;
  headers: Record<string, string>;
  requestBody: Record<string, unknown>;
} {
  let pkg: { plugins?: unknown } | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    pkg = require('manifest-plugins') as { plugins?: unknown };
  } catch {
    return current;
  }
  if (!pkg || !Array.isArray(pkg.plugins)) return current;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toggle = (pkg as any).applyDisabledListFromEnv;
    if (typeof toggle === 'function') {
      toggle(process.env['MANIFEST_PLUGINS_DISABLED']);
    }
  } catch {
    // env-toggle is best-effort; never block a request on it.
  }
  let result = current;
  for (const plugin of pkg.plugins) {
    if (!plugin || typeof plugin.transformRequest !== 'function') continue;
    try {
      const out = plugin.transformRequest({
        ...decision,
        url: result.url,
        headers: result.headers,
        requestBody: result.requestBody,
      });
      if (out && typeof out === 'object') {
        result = {
          url:
            typeof out.url === 'string' ? out.url : result.url,
          headers:
            out.headers && typeof out.headers === 'object'
              ? { ...result.headers, ...(out.headers as Record<string, string>) }
              : result.headers,
          requestBody:
            out.requestBody && typeof out.requestBody === 'object'
              ? { ...result.requestBody, ...(out.requestBody as Record<string, unknown>) }
              : result.requestBody,
        };
      }
    } catch (err) {
      const name =
        (plugin as { constructor?: { name?: string } }).constructor?.name ??
        'plugin';
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(\`[manifest-plugins] \${name} failed: \${msg}\`);
    }
  }
  return result;
}

`;

/**
 * The exact text that the patcher inserts in place of the original Anthropic
 * branch's `return { ... }; }` block. Original (verbatim from upstream/main):
 *
 *     return {
 *       url: \`\${endpoint.baseUrl}\${endpoint.buildPath(bareModel)}\`,
 *       headers: endpoint.buildHeaders(apiKey, authType),
 *       requestBody,
 *     };
 *     }
 *
 * The replacement is byte-equivalent to the host's intent above.
 */
export const RETURN_OLD = `      return {
        url: \`\${endpoint.baseUrl}\${endpoint.buildPath(bareModel)}\`,
        headers: endpoint.buildHeaders(apiKey, authType),
        requestBody,
      };
    }
`;

export const RETURN_NEW = `      const transformed = applyRequestTransformPlugins(
        {
          endpointKey,
          provider: ctx.provider,
          bareModel,
          apiKey,
          authType,
          apiMode: ctx.apiMode,
          stream,
        },
        {
          url: \`\${endpoint.baseUrl}\${endpoint.buildPath(bareModel)}\`,
          headers: endpoint.buildHeaders(apiKey, authType),
          requestBody,
        },
      );
      return {
        url: transformed.url,
        headers: transformed.headers,
        requestBody: transformed.requestBody,
      };
    }
`;

/**
 * Marker for the helper insertion point: end of `stripModelPrefix` body +
 * blank line + `@Injectable()` + `export class ProviderClient {`. The patcher
 * inserts `HOST_HELPER_SOURCE` immediately before the `@Injectable()` line.
 *
 * Note: the patched marker is computed dynamically in `apply.ts` from this
 * old marker and `HOST_HELPER_SOURCE`, so any edit to the helper source
 * automatically propagates.
 */
export const HELPER_MARKER_OLD = `  return stripVendorPrefix(model);
}

@Injectable()
export class ProviderClient {
`;

/**
 * Build the post-insertion marker by replacing the closing of
 * `stripModelPrefix` + `@Injectable()` boundary with the helper definition
 * followed by the `@Injectable()` line. This keeps `HOST_HELPER_SOURCE` as
 * the single source of truth for the helper body.
 */
export function buildHelperMarkerNew(): string {
  return HELPER_MARKER_OLD.replace(
    '}\n\n@Injectable()\nexport class ProviderClient {\n',
    `}\n\n${HOST_HELPER_SOURCE}@Injectable()\nexport class ProviderClient {\n`,
  );
}

// =============================================================================
// Rate-limiter host query (injected into proxy-rate-limiter.ts)
// =============================================================================

/**
 * The host query inserted into `proxy-rate-limiter.ts`. Resolves the
 * `CONCURRENCY_MAX` value at module load by:
 *   1. Walking the plugin array and asking each plugin for a policy.
 *   2. Falling through to `process.env.CONCURRENCY_MAX` if no plugin has
 *      an opinion.
 *   3. Falling through to the `DEFAULT_CONCURRENCY_MAX = 10` constant if
 *      the env var is unset or invalid.
 *
 * Replaces the upstream env-backed `CONCURRENCY_MAX` initialization with
 * `const CONCURRENCY_MAX = getResolvedConcurrencyMax();`.
 */
export const RATE_LIMITER_HOST_SOURCE = `/**
 * Resolve the per-agent concurrent-request cap. Plugins override first;
 * if none have an opinion, the env var wins; otherwise the hardcoded
 * default (10) is used. The default is inlined here (not a reference
 * to DEFAULT_CONCURRENCY_MAX) because the upstream source file may or
 * may not have such a constant — we want this host function to compile
 * regardless of upstream's variable naming.
 */
const PLUGIN_HOST_CONCURRENCY_DEFAULT = 10;

function getResolvedConcurrencyMax(): number {
  try {
    const pkg = require('manifest-plugins') as {
      plugins?: ReadonlyArray<{
        getRateLimitPolicy?: () => { concurrencyMax: number | null } | null;
      }>;
    };
    if (pkg?.plugins && Array.isArray(pkg.plugins)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toggle = (pkg as any).applyDisabledListFromEnv;
        if (typeof toggle === 'function') {
          toggle(process.env['MANIFEST_PLUGINS_DISABLED']);
        }
      } catch {
        // env-toggle is best-effort; never block a request on it.
      }
      for (const plugin of pkg.plugins) {
        if (plugin && typeof plugin.getRateLimitPolicy === 'function') {
          try {
            const policy = plugin.getRateLimitPolicy();
            if (
              policy &&
              typeof policy.concurrencyMax === 'number' &&
              policy.concurrencyMax > 0
            ) {
              return policy.concurrencyMax;
            }
          } catch (err) {
            const name =
              (plugin as { constructor?: { name?: string } }).constructor?.name ??
              'plugin';
            const msg = err instanceof Error ? err.message : String(err);
            // eslint-disable-next-line no-console
            console.warn(
              \`[manifest-plugins] \${name} policy failed: \${msg}\`,
            );
          }
        }
      }
    }
  } catch {
    // manifest-plugins not installed; fall through to env/default.
  }
  const raw = process.env['CONCURRENCY_MAX'];
  if (!raw) return PLUGIN_HOST_CONCURRENCY_DEFAULT;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : PLUGIN_HOST_CONCURRENCY_DEFAULT;
}

`;

/**
 * The exact text from upstream/main's `proxy-rate-limiter.ts` that the
 * apply tool replaces. Verbatim against the canonical upstream shape —
 * any whitespace difference breaks the patcher. `apply.ts`'s
 * `oldTextAlternatives` accepts the housekeeping overlay variant for
 * forks that already patched the file.
 */
export const RATE_LIMITER_OLD = `const CONCURRENCY_MAX = 10;
`;

/**
 * The replacement text. The original env-backed `CONCURRENCY_MAX` block
 * is replaced with a call to `getResolvedConcurrencyMax()` (defined in
 * `RATE_LIMITER_HOST_SOURCE`, which the apply tool inserts immediately
 * above this line).
 */
export const RATE_LIMITER_NEW = `${RATE_LIMITER_HOST_SOURCE}const CONCURRENCY_MAX = getResolvedConcurrencyMax();
`;

// =============================================================================
// Proxy-service host query (injected into proxy.service.ts)
// =============================================================================

/**
 * The host query inserted into `proxy.service.ts`. Resolves the
 * `maxMessagesPerRequest` value at constructor time by:
 *   1. Walking the plugin array and asking each plugin for a policy.
 *   2. Falling through to env vars (`MAX_MESSAGES_PER_REQUEST`,
 *      `MANIFEST_MAX_MESSAGES`) if no plugin has an opinion.
 *   3. Falling through to `parseMaxMessagesPerRequest(undefined)` (the
 *      upstream default of 1000) if no env var is set.
 *
 * Replaces the current upstream constructor block that resolves
 * `maxMessagesRaw` from `MAX_MESSAGES_PER_REQUEST` / `MANIFEST_MAX_MESSAGES`
 * and then parses it into `this.maxMessagesPerRequest`.
 *
 * The new method is added to the class body. The apply tool inserts both
 * the function definition (above the class) and the method call (in
 * the constructor) in one pass.
 */
export const PROXY_SERVICE_HOST_SOURCE = `/**
 * Resolve the per-request message-array cap. Plugin policy wins; if no
 * plugin has an opinion, env vars (MAX_MESSAGES_PER_REQUEST or
 * MANIFEST_MAX_MESSAGES) win; if neither is set, the upstream default
 * (1000) applies via parseMaxMessagesPerRequest(undefined).
 */
function getResolvedMaxMessagesPerRequest(
  config: { get<T>(key: string): T | undefined },
): number {
  let fromPlugin: number | null = null;
  try {
    const pkg = require('manifest-plugins') as {
      plugins?: ReadonlyArray<{
        getRateLimitPolicy?: () => {
          concurrencyMax: number | null;
          maxMessagesPerRequest: number | null;
        } | null;
      }>;
    };
    if (pkg?.plugins && Array.isArray(pkg.plugins)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toggle = (pkg as any).applyDisabledListFromEnv;
        if (typeof toggle === 'function') {
          toggle(process.env['MANIFEST_PLUGINS_DISABLED']);
        }
      } catch {
        // env-toggle is best-effort; never block a request on it.
      }
      for (const plugin of pkg.plugins) {
        if (plugin && typeof plugin.getRateLimitPolicy === 'function') {
          try {
            const policy = plugin.getRateLimitPolicy();
            if (
              policy &&
              typeof policy.maxMessagesPerRequest === 'number' &&
              policy.maxMessagesPerRequest > 0
            ) {
              fromPlugin = policy.maxMessagesPerRequest;
              break;
            }
          } catch (err) {
            const name =
              (plugin as { constructor?: { name?: string } }).constructor?.name ??
              'plugin';
            const msg = err instanceof Error ? err.message : String(err);
            // eslint-disable-next-line no-console
            console.warn(
              \`[manifest-plugins] \${name} policy failed: \${msg}\`,
            );
          }
        }
      }
    }
  } catch {
    // manifest-plugins not installed; fall through to env/default.
  }
  if (fromPlugin !== null) return fromPlugin;
  const rawEnv = process.env['MAX_MESSAGES_PER_REQUEST'];
  const rawConfig = config.get<string>('MANIFEST_MAX_MESSAGES');
  const raw = rawEnv ?? rawConfig;
  if (raw === undefined || raw === '' || raw === '0') return Infinity;
  return parseMaxMessagesPerRequest(raw);
}

`;

/**
 * The exact text from upstream/main's `proxy.service.ts` constructor that
 * the apply tool replaces. Verbatim against the canonical upstream shape
 * — any whitespace difference breaks the patcher. `apply.ts`'s
 * `oldTextAlternatives` accepts the housekeeping overlay variant for
 * forks that already modernized the file.
 */
export const PROXY_SERVICE_OLD = `    this.maxMessagesPerRequest = parseMaxMessagesPerRequest(
      this.config.get<string>('MANIFEST_MAX_MESSAGES'),
    );
`;

/**
 * The replacement text. The original constructor block is replaced
 * with a single call to `getResolvedMaxMessagesPerRequest(this.config)`,
 * which is defined in `PROXY_SERVICE_HOST_SOURCE` (inserted immediately
 * above the class by the apply tool).
 */
export const PROXY_SERVICE_NEW = `    this.maxMessagesPerRequest = getResolvedMaxMessagesPerRequest(this.config);
`;

// =============================================================================
// Proxy-service routing override host (injected into proxy.service.ts)
// =============================================================================

/**
 * The host helper inserted into upstream `proxy.service.ts::resolveRouting()`.
 * Runs BEFORE the upstream router selects a provider/model, so a plugin can
 * override the routing decision when an inbound HTTP header (e.g.
 * `x-manifest-tier`) matches a configured `header_tiers` row.
 *
 * Behavior:
 *   - Plugins receive a fully-resolved context (`agentId`, `tenantId`,
 *     `apiMode`, `body`, `headers`, `requestedModel`, `headerTiers`,
 *     `discoveredModels`). The host does all the DB / Nest work because
 *     plugins run in a separate npm package and have no Nest access.
 *   - First non-null `route` from any plugin wins. The host returns that
 *     object directly as the request's `ResolvedRouting`, short-circuiting
 *     both the upstream `2ab748a6` explicit-model early-return and the
 *     upstream `resolveHeaderTier` silent fall-through.
 *   - Plugin errors are non-fatal — the host catches and logs them and
 *     continues with the upstream default routing path.
 *
 * Why `require()` and not `import`? The host snippet is pasted into
 * upstream's `proxy.service.ts`. Adding a top-level `import` would fail
 * `tsc` whenever the plugins package is not installed (e.g. on upstream
 * itself, or CI without the fork's plugin layer). `require()` inside
 * try/catch degrades to a no-op when the module is missing, so the
 * upstream source stays compilable in either state.
 */
export const PROXY_ROUTING_OVERRIDE_HOST_SOURCE = `/**
 * Fork: apply registered routing-override plugins before the upstream
 * router selects a provider/model. Plugins live in the sibling
 * \`manifest-plugins\` repo and are loaded via \`require('manifest-plugins')\`.
 * If the package is not installed (e.g. on upstream or in CI without
 * the fork's plugin layer), this is a no-op.
 *
 * Plugin contract: each entry in \`require('manifest-plugins').plugins\`
 * may implement \`overrideRouting(ctx)\` returning a routing object or
 * \`null\`. The host walks the plugin array in order and returns the
 * first non-null result. Plugin errors are caught and logged; one broken
 * plugin must not break the request.
 */
function applyProxyRoutingOverridePlugins(
  agentId: string,
  tenantId: string,
  apiMode: string,
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined> | undefined,
  requestedModel: string | undefined,
  headerTiers: ReadonlyArray<{
    id: string;
    name: string;
    header_key: string;
    header_value: string;
    enabled: boolean;
    sort_order: number;
    badge_color: string | null;
    override_route: {
      provider: string;
      authType: string;
      model: string;
      keyLabel?: string | null;
    } | null;
    fallback_routes: ReadonlyArray<{
      provider: string;
      authType: string;
      model: string;
      keyLabel?: string | null;
    }> | null;
    output_modality: string | null;
    response_mode: string | null;
  }>,
  discoveredModels: ReadonlyArray<{
    id: string;
    provider: string;
    authType?: string;
  }>,
): ResolvedRouting | null {
  let pkg: { plugins?: unknown } | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    pkg = require('manifest-plugins') as { plugins?: unknown };
  } catch {
    return null;
  }
  if (!pkg || !Array.isArray(pkg.plugins)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toggle = (pkg as any).applyDisabledListFromEnv;
    if (typeof toggle === 'function') {
      toggle(process.env['MANIFEST_PLUGINS_DISABLED']);
    }
  } catch {
    // env-toggle is best-effort; never block a request on it.
  }
  for (const plugin of pkg.plugins) {
    if (!plugin || typeof (plugin as { overrideRouting?: unknown }).overrideRouting !== 'function') continue;
    try {
      const out = (plugin as {
        overrideRouting: (ctx: unknown) => unknown;
      }).overrideRouting({
        agentId,
        tenantId,
        apiMode,
        body,
        headers: headers ?? {},
        requestedModel,
        headerTiers,
        discoveredModels,
      });
      if (out && typeof out === 'object' && (out as { route?: unknown }).route !== undefined) {
        return out as ResolvedRouting;
      }
    } catch (err) {
      const name =
        (plugin as { constructor?: { name?: string } }).constructor?.name ?? 'plugin';
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(\`[manifest-plugins] \${name} overrideRouting failed: \${msg}\`);
    }
  }
  return null;
}

`;

/**
 * The exact text from upstream/main's `proxy.service.ts` constructor
 * closing block that the apply tool replaces to inject the new
 * `HeaderTierService` dependency.
 *
 * The patcher extends the constructor with `headerTierService` after
 * `providerParamSpecs`. If upstream renames the param or reorders the
 * constructor, update this anchor.
 */
export const PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_OLD =
  '    private readonly providerParamSpecs: ProviderParamSpecService,\n  ) {\n';

export const PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_NEW =
  '    private readonly providerParamSpecs: ProviderParamSpecService,\n    private readonly headerTierService: HeaderTierService,\n  ) {\n';

/**
 * The exact import line in upstream/main's `proxy.service.ts` that the
 * apply tool uses as the anchor for inserting the new
 * `HeaderTierService` import.
 *
 * The patcher inserts the new import immediately below this line. If
 * upstream removes or reorders the existing import, update this anchor.
 */
export const PROXY_ROUTING_OVERRIDE_IMPORT_OLD =
  "import { ProviderParamSpecService } from '../routing-core/provider-param-spec.service';\n";

export const PROXY_ROUTING_OVERRIDE_IMPORT_NEW =
  "import { ProviderParamSpecService } from '../routing-core/provider-param-spec.service';\n" +
  "import { HeaderTierService } from '../header-tiers/header-tier.service';\n";

/**
 * The exact text from upstream/main's `proxy.service.ts::resolveRouting()`
 * (lines 459-465, the signature of commit `2ab748a6`) that the apply
 * tool replaces to insert the routing-override hook BEFORE the
 * explicit-model early-return.
 *
 * Pre-`2ab748a6` checkouts do not have these lines; the patcher will
 * report `upstream-drift` (correct: pre-`2ab748a6` upstream did not need
 * this hook because it always passed `headers` into `resolveService.resolve`).
 */
export const PROXY_ROUTING_OVERRIDE_OLD = `  ): Promise<ResolvedRouting> {
    const requestedModel = typeof body.model === 'string' ? body.model : undefined;
    // Anthropic Messages requests require a provider-native model field; only
    // OpenAI-compatible surfaces use /v1/models IDs as route overrides.
    if (apiMode !== 'messages' && requestedModel && requestedModel !== OPENAI_MODEL_ID_AUTO) {
`;

/**
 * The replacement text for the resolveRouting body. The host calls
 * `applyProxyRoutingOverridePlugins(...)` FIRST (with the headerTiers +
 * discoveredModels it just fetched via the Nest-injected services), and
 * if a plugin returns a non-null routing object the host returns it
 * directly — short-circuiting the explicit-model branch AND the
 * `resolveHeaderTier` silent fall-through. Otherwise the original
 * `2ab748a6` block runs unchanged.
 *
 * `requestedModel` is parsed here once and shared with the plugin so
 * the plugin does not need to re-parse `body.model`.
 */
export const PROXY_ROUTING_OVERRIDE_NEW = `  ): Promise<ResolvedRouting> {
    const requestedModel = typeof body.model === 'string' ? body.model : undefined;
    const pluginOverride = applyProxyRoutingOverridePlugins(
      agentId,
      tenantId,
      apiMode,
      body,
      headers,
      requestedModel,
      await this.headerTierService.list(agentId),
      await this.modelDiscovery.getModelsForAgent(tenantId, agentId),
    );
    if (pluginOverride) return pluginOverride;
    // Anthropic Messages requests require a provider-native model field; only
    // OpenAI-compatible surfaces use /v1/models IDs as route overrides.
    if (apiMode !== 'messages' && requestedModel && requestedModel !== OPENAI_MODEL_ID_AUTO) {
`;

// =============================================================================
// Admin Express app mount (injected into main.ts)
// =============================================================================

export const ADMIN_MOUNT_OLD = `  const port = Number(process.env['PORT'] ?? 3001);
  const host = process.env['BIND_ADDRESS'] ?? '127.0.0.1';
  await app.listen(port, host);
`;

export const ADMIN_MOUNT_NEW = `  // Fork: mount the plugin admin Express app on the same port as the
  // dashboard. The admin app handles /api/plugins/* and /admin/admin.js.
  // The require() is best-effort: if the package is missing (upstream
  // or CI without the fork's plugin layer), this is a no-op.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const admin = require('manifest-plugins');
    if (admin && typeof admin.createAdminServer === 'function') {
      expressApp.use(admin.createAdminServer());
    }
  } catch {
    // admin app missing or failed to load; continue without it
  }
  const port = Number(process.env['PORT'] ?? 3001);
  const host = process.env['BIND_ADDRESS'] ?? '127.0.0.1';
  await app.listen(port, host);
`;
