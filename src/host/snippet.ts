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
 * \`{ url?, headers?, requestBody? }\` with optional overrides.
 *
 *   - url          — replacement for the current request URL
 *   - headers      — merged into the current headers map (shallow merge,
 *                    last plugin wins per key)
 *   - requestBody  — REPLACED wholesale when the plugin returns one (NOT
 *                    shallow-merged). Plugins that mutate the body to
 *                    prepend a system[] block (e.g. for Anthropic OAuth
 *                    fingerprinting) MUST see their output land on the
 *                    wire byte-for-byte; a shallow merge would keep the
 *                    upstream's key order intact and break byte-faithful
 *                    consumers (the cch preimage is key order-sensitive).
 *
 * Plugin errors are caught and logged; one broken plugin must not break the request.
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
          // requestBody is REPLACED wholesale when the plugin returns one,
          // not shallow-merged. Plugins that mutate the body (e.g. to
          // prepend a system[] block for Anthropic OAuth fingerprinting)
          // MUST see their output land on the wire byte-for-byte; a
          // shallow merge would leave the upstream's key order intact
          // and break byte-faithful consumers (the cch preimage is key
          // order-sensitive).
          requestBody:
            out.requestBody && typeof out.requestBody === 'object'
              ? (out.requestBody as Record<string, unknown>)
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
 * As of upstream commit `c9009bcd5`, the `ProxyService` constructor
 * closes with `) {}` (empty body) — the legacy
 * `this.maxMessagesPerRequest = parseMaxMessagesPerRequest(...)`
 * initialization block was removed from upstream and is no longer
 * anchored here. The patcher extends the constructor parameter list
 * with `headerTierService` immediately before the closing
 * `) {}`. If upstream renames the `providerParamSpecs` param or
 * reorders the constructor, update this anchor.
 *
 * Wave-history note: upstream commit `849f6e3a0` ("feat/autofix-healing")
 * inserted a new `autofixService: AutofixService` parameter immediately
 * AFTER `providerParamSpecs` and BEFORE the closing `) {}`. This anchor
 * now spans from `providerParamSpecs` through `autofixService` so the
 * patcher's text replacement still finds the unique closing-brace
 * sequence in the new constructor shape.
 */
export const PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_OLD =
  '    private readonly providerParamSpecs: ProviderParamSpecService,\n    private readonly autofixService: AutofixService,\n  ) {}\n';

export const PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_NEW =
  '    private readonly providerParamSpecs: ProviderParamSpecService,\n    private readonly autofixService: AutofixService,\n    private readonly headerTierService: HeaderTierService,\n  ) {}\n';

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
// Model-list override host (injected into model-fetcher.ts / /v1/models)
// =============================================================================

/**
 * The host helper inserted into upstream's model-fetcher layer so a
 * `ModelListOverridePlugin` can rewrite the `discoveredModels` array
 * before upstream serializes it as the response body of
 * `GET /v1/models`.
 *
 * Behavior:
 *   - Plugins receive a fully-resolved context (`tenantId`, `agentId`,
 *     `discoveredModels`, `requestMetadata`). The host does the upstream
 *     `modelDiscovery.getModelsForAgent(...)` work; plugins only read.
 *   - The FIRST non-null result wins. The host returns the plugin's
 *     `discoveredModels` array verbatim as the replacement for the
 *     upstream default. Later plugins are skipped for the same request.
 *   - Plugin errors are non-fatal — the host catches and logs them and
 *     continues with the next plugin (or upstream's default if every
 *     plugin errored or returned `null`).
 *
 * Why `require()` and not `import`? Same rationale as the other host
 * snippets: the helper is pasted into upstream Manifest source where
 * `manifest-plugins` may not be installed. `require()` inside try/catch
 * degrades to a no-op when the module is missing, so the upstream
 * source stays compilable in either state.
 *
 * Trigger: Anthropic shipped (June 2026) several breaking changes that
 * broke the upstream static `DiscoveredModel` catalog for the Anthropic
 * provider — `claude-sonnet-4-20250514` and `claude-opus-4-20250514`
 * were retired June 15, `claude-sonnet-5` (with breaking tokenizer /
 * removed extended thinking / sampling-parameter 400s) shipped June 30,
 * and fast-mode was removed from `claude-opus-4-6` on June 29. Until
 * upstream re-syncs its catalog, operators need a way to surface the
 * correct /v1/models list to clients without forking Manifest. This
 * host hook is that mechanism.
 */
export const MODEL_LIST_OVERRIDE_HOST_SOURCE = `/**
 * Fork: apply registered model-list-override plugins to the
 * discovered-models list returned by upstream
 * \`discoveryService.getModelsForAgent(...)\` BEFORE the upstream
 * \`.map(...)\` transforms it into the wire-shape response body of
 * the canonical \`GET :agentName/available-models\` endpoint. Plugins
 * live in the sibling \`manifest-plugins\` repo and are loaded via
 * \`require('manifest-plugins')\`. If the package is not installed
 * (e.g. on upstream or in CI without the fork's plugin layer), this
 * is a no-op.
 *
 * Plugin contract: each entry in \`require('manifest-plugins').plugins\`
 * may implement \`overrideModelList(ctx)\` returning
 * \`{ discoveredModels, reason? }\` or \`null\`. The host walks the
 * plugin array in order and returns the first non-null result. Plugin
 * errors are caught and logged; one broken plugin must not break the
 * \`/v1/models\` response.
 *
 * Type-safety note: the parameter types below are intentionally
 * structural / loose (\`ReadonlyArray<Record<string, unknown>>\`) so
 * this host source compiles in BOTH contexts: (a) inside upstream
 * Manifest where \`getModelsForAgent\` returns the upstream
 * \`DiscoveredModel\` shape (with strongly-typed union fields like
 * \`authType: 'api_key' | 'local' | 'subscription'\` and
 * \`capabilities: readonly Modality[]\`) and (b) inside the
 * \`manifest-plugins\` package where \`overrideModelList\` expects
 * \`ModelListOverrideDiscoveredModel\`. Both shapes satisfy
 * \`Record<string, unknown>\` (the index signature makes them
 * structurally compatible), so the helper type-checks in either
 * build without re-defining upstream's exact row shape here.
 */
function applyModelListOverridePlugins(
  tenantId: string,
  agentId: string,
  discoveredModels: ReadonlyArray<unknown>,
  requestMetadata: Record<string, unknown> | undefined,
): {
  discoveredModels: ReadonlyArray<unknown>;
  reason: string | undefined;
} | null {
  let pkg: { plugins?: unknown } | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    pkg = require('manifest-plugins') as { plugins?: unknown };
  } catch {
    return null;
  }
  if (!pkg || !Array.isArray(pkg.plugins)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const toggle = (pkg as { applyDisabledListFromEnv?: unknown }).applyDisabledListFromEnv;
    if (typeof toggle === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (toggle as (v: unknown) => void)(process.env['MANIFEST_PLUGINS_DISABLED']);
    }
  } catch {
    // env-toggle is best-effort; never block a request on it.
  }
  for (const plugin of pkg.plugins) {
    if (!plugin || typeof (plugin as { overrideModelList?: unknown }).overrideModelList !== 'function') continue;
    try {
      const out = (plugin as {
        overrideModelList: (ctx: unknown) => unknown;
      }).overrideModelList({
        tenantId,
        agentId,
        discoveredModels,
        requestMetadata,
      });
      if (out && typeof out === 'object' && Array.isArray((out as { discoveredModels?: unknown }).discoveredModels)) {
        const result = out as {
          discoveredModels: ReadonlyArray<Record<string, unknown>>;
          reason?: string;
        };
        return { discoveredModels: result.discoveredModels, reason: result.reason };
      }
    } catch (err) {
      const name =
        (plugin as { constructor?: { name?: string } }).constructor?.name ?? 'plugin';
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(\`[manifest-plugins] \${name} overrideModelList failed: \${msg}\`);
    }
  }
  return null;
}

`;

/**
 * The exact text from upstream `packages/backend/src/routing/model.controller.ts`
 * (`GET :agentName/available-models` handler — the canonical `/v1/models`
 * endpoint in current upstream) that the apply tool replaces to insert
 * the model-list-override hook.
 *
 * The replacement is byte-equivalent to the host's intent above: it
 * runs the plugin array against the upstream `models` array BEFORE
 * the upstream `models.map(...)` transforms it into the wire-shape
 * response body. Plugins see raw `DiscoveredModel` rows (`id`,
 * `provider`, `authType`) and their returned array is consumed by
 * the upstream mapper unchanged.
 *
 * Anchor note: the anchor is the upstream `getModelsForAgent` call
 * immediately followed by `customProviderService.list(...)` plus the
 * `cpNameMap` build-up. If upstream restructures this block, update
 * this anchor.
 */
export const MODEL_LIST_OVERRIDE_OLD = `    const models = await this.discoveryService.getModelsForAgent(agent.tenant_id, agent.id);

    // Build display name map for custom providers (tenant-global)
    const customProviders = await this.customProviderService.list(agent.tenant_id);`;

/**
 * The replacement text. The host calls `applyModelListOverridePlugins(...)`
 * immediately after the upstream `getModelsForAgent` call and BEFORE
 * the upstream `customProviderService.list(...)` call, so the plugin
 * can rewrite the raw `models` array used by the wire-shape `.map`.
 * If a plugin returns a non-null result the plugin's `discoveredModels`
 * array replaces `models` for the rest of the handler.
 *
 * `reason` is surfaced via `console.info` so operators can audit why a
 * client sees a different model list than upstream's static catalog
 * would suggest.
 */
export const MODEL_LIST_OVERRIDE_NEW = `    const discovered = await this.discoveryService.getModelsForAgent(agent.tenant_id, agent.id);
    const pluginOverride = applyModelListOverridePlugins(
      agent.tenant_id,
      agent.id,
      discovered,
      { source: 'model-controller.available-models' },
    );
    const models = (pluginOverride ? pluginOverride.discoveredModels : discovered) as typeof discovered;
    if (pluginOverride) {
      if (pluginOverride.reason) {
        // eslint-disable-next-line no-console
        console.info(\`[manifest-plugins] /v1/models overridden: \${pluginOverride.reason}\`);
      }
    }
    // Build display name map for custom providers (tenant-global)
    const customProviders = await this.customProviderService.list(agent.tenant_id);`;

/**
 * Helper-marker anchor for inserting the
 * `applyModelListOverridePlugins` function definition above the
 * ModelController class. Mirrors the pattern used by the
 * routing-override host: insert the helper immediately above the
 * `@Controller(...)` decorator, which is a stable, byte-exact line in
 * upstream.
 */
export const MODEL_LIST_OVERRIDE_HELPER_MARKER_OLD =
  "@Controller('api/v1/routing')\nexport class ModelController {\n";

/**
 * Build the post-helper-insertion marker text: same anchor as
 * `_HELPER_MARKER_OLD` but prefixed with the helper definition so the
 * `apply.ts` patcher's `next.replace(helperMarkerOld, helperMarkerNew)`
 * call inserts the function above the call site.
 */
export function buildModelListOverrideHelperMarkerNew(): string {
  return `${MODEL_LIST_OVERRIDE_HOST_SOURCE}${MODEL_LIST_OVERRIDE_HELPER_MARKER_OLD}`;
}

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
