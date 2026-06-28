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
 * Replaces the upstream line `const CONCURRENCY_MAX = 10;` with
 * `const CONCURRENCY_MAX = getResolvedConcurrencyMax();`.
 */
export const RATE_LIMITER_HOST_SOURCE = `/**
 * Resolve the per-agent concurrent-request cap. Plugins override first;
 * if none have an opinion, the env var wins; otherwise the source default
 * (DEFAULT_CONCURRENCY_MAX = 10) is used.
 */
function getResolvedConcurrencyMax(): number {
  try {
    const pkg = require('manifest-plugins') as {
      plugins?: ReadonlyArray<{
        getRateLimitPolicy?: () => { concurrencyMax: number | null } | null;
      }>;
    };
    if (pkg?.plugins && Array.isArray(pkg.plugins)) {
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
  if (!raw) return DEFAULT_CONCURRENCY_MAX;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONCURRENCY_MAX;
}

`;

/**
 * The exact text from upstream/main's `proxy-rate-limiter.ts` line 8 that
 * the apply tool replaces. Verbatim — any whitespace difference breaks
 * the patcher.
 */
export const RATE_LIMITER_OLD = `const CONCURRENCY_MAX = 10;
`;

/**
 * The replacement text. The original `const CONCURRENCY_MAX = 10;` line
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
 * Replaces the upstream constructor block:
 *     this.maxMessagesPerRequest = parseMaxMessagesPerRequest(
 *       this.config.get<string>('MANIFEST_MAX_MESSAGES'),
 *     );
 * with:
 *     this.maxMessagesPerRequest = getResolvedMaxMessagesPerRequest(
 *       this.config,
 *     );
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
 * The exact text from upstream/main's `proxy.service.ts` lines 163-165 that
 * the apply tool replaces. Verbatim — any whitespace difference breaks
 * the patcher.
 */
export const PROXY_SERVICE_OLD = `    this.maxMessagesPerRequest = parseMaxMessagesPerRequest(
      this.config.get<string>('MANIFEST_MAX_MESSAGES'),
    );
`;

/**
 * The replacement text. The original 3-line constructor body is replaced
 * with a single call to `getResolvedMaxMessagesPerRequest(this.config)`,
 * which is defined in `PROXY_SERVICE_HOST_SOURCE` (inserted immediately
 * above the class by the apply tool).
 */
export const PROXY_SERVICE_NEW = `    this.maxMessagesPerRequest = getResolvedMaxMessagesPerRequest(this.config);
`;