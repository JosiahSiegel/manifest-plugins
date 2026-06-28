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