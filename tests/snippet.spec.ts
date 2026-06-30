/**
 * Unit tests for the host snippet template literals in `src/host/snippet.ts`.
 *
 * The snippet constants are byte-exact upstream anchors used by the
 * apply tool to inject host code into a fresh Manifest checkout. They
 * drift whenever upstream restructures the patched files. The RED
 * tests here assert the exact shape of every anchor and every
 * replacement the apply tool expects. If upstream drifts, this spec
 * fails with a precise error (which anchor moved, what changed) so
 * `src/host/snippet.ts` can be refreshed in one place.
 *
 * No network calls. These tests are pure string assertions against
 * the imported snippet constants — they are independent of any
 * Manifest checkout on disk.
 */
import {
  HELPER_MARKER_OLD,
  HOST_HELPER_SOURCE,
  PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_NEW,
  PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_OLD,
  PROXY_ROUTING_OVERRIDE_HOST_SOURCE,
  PROXY_ROUTING_OVERRIDE_IMPORT_NEW,
  PROXY_ROUTING_OVERRIDE_IMPORT_OLD,
  PROXY_ROUTING_OVERRIDE_NEW,
  PROXY_ROUTING_OVERRIDE_OLD,
  PROXY_SERVICE_HOST_SOURCE,
  PROXY_SERVICE_NEW,
  PROXY_SERVICE_OLD,
  RATE_LIMITER_HOST_SOURCE,
  RATE_LIMITER_NEW,
  RATE_LIMITER_OLD,
  RETURN_NEW,
  RETURN_OLD,
  buildHelperMarkerNew,
} from '../src/host/snippet';

describe('host snippet: existing anchors (pre-existing fixtures, regression coverage)', () => {
  it('RETURN_OLD matches the verbatim Anthropic branch return block', () => {
    expect(RETURN_OLD).toBe(
      [
        '      return {',
        '        url: `${endpoint.baseUrl}${endpoint.buildPath(bareModel)}`,',
        '        headers: endpoint.buildHeaders(apiKey, authType),',
        '        requestBody,',
        '      };',
        '    }',
        '',
      ].join('\n'),
    );
  });

  it('RETURN_NEW calls applyRequestTransformPlugins and uses the transformed values', () => {
    expect(RETURN_NEW).toContain('const transformed = applyRequestTransformPlugins(');
    expect(RETURN_NEW).toContain('return {');
    expect(RETURN_NEW).toContain('url: transformed.url');
    expect(RETURN_NEW).toContain('headers: transformed.headers');
    expect(RETURN_NEW).toContain('requestBody: transformed.requestBody');
  });

  it('HOST_HELPER_SOURCE declares applyRequestTransformPlugins and require()s manifest-plugins', () => {
    expect(HOST_HELPER_SOURCE).toContain('function applyRequestTransformPlugins(');
    expect(HOST_HELPER_SOURCE).toContain("require('manifest-plugins')");
    expect(HOST_HELPER_SOURCE).toContain('transformRequest');
  });

  it('HOST_HELPER_SOURCE REPLACES requestBody wholesale (not shallow-merges) so plugins can control JSON key order', () => {
    // Required for `anthropic-billing-header` v0.3.0+ to prepend a
    // `system[]` block with the Claude Code identity at the start of
    // the request body (Anthropic's classifier keys on system[0]
    // content). Shallow-merging would keep the upstream's existing
    // keys at the start of the serialized object and let later keys
    // (like `messages`) come before `system`, breaking the byte-exact
    // cch preimage. The contract here is: when a plugin returns a
    // requestBody, the host uses that exact object — no merge with
    // the previous result.requestBody.
    expect(HOST_HELPER_SOURCE).not.toContain(
      '{ ...result.requestBody, ...(out.requestBody',
    );
    // The replacement branch must reference `out.requestBody` directly
    // (no spread of the prior body).
    expect(HOST_HELPER_SOURCE).toContain(
      '(out.requestBody as Record<string, unknown>)',
    );
  });

  it('HOST_HELPER_SOURCE honors MANIFEST_PLUGINS_DISABLED at module load', () => {
    // Wave 5: the pasted snippet must call
    // `require('manifest-plugins').applyDisabledListFromEnv(...)` so
    // operators can flip plugins off at process start without a
    // rebuild. The call sits between the `require('manifest-plugins')`
    // guard and the plugin walk.
    expect(HOST_HELPER_SOURCE).toContain('applyDisabledListFromEnv');
    expect(HOST_HELPER_SOURCE).toContain(
      "process.env['MANIFEST_PLUGINS_DISABLED']",
    );
  });

  it('HELPER_MARKER_OLD anchors on the stripVendorPrefix + @Injectable() boundary', () => {
    expect(HELPER_MARKER_OLD).toBe(
      [
        '  return stripVendorPrefix(model);',
        '}',
        '',
        '@Injectable()',
        'export class ProviderClient {',
        '',
      ].join('\n'),
    );
  });

  it('buildHelperMarkerNew() inlines HOST_HELPER_SOURCE between stripVendorPrefix and @Injectable()', () => {
    const marker = buildHelperMarkerNew();
    const stripIdx = marker.indexOf('  return stripVendorPrefix(model);');
    const injectableIdx = marker.indexOf('@Injectable()');
    const helperIdx = marker.indexOf('function applyRequestTransformPlugins(');
    expect(stripIdx).toBeGreaterThanOrEqual(0);
    expect(helperIdx).toBeGreaterThan(stripIdx);
    expect(injectableIdx).toBeGreaterThan(helperIdx);
  });

  it('RATE_LIMITER_OLD anchors on the bare CONCURRENCY_MAX constant', () => {
    expect(RATE_LIMITER_OLD).toBe('const CONCURRENCY_MAX = 10;\n');
  });

  it('RATE_LIMITER_NEW delegates to getResolvedConcurrencyMax()', () => {
    expect(RATE_LIMITER_NEW).toContain('function getResolvedConcurrencyMax(');
    expect(RATE_LIMITER_NEW).toContain('const CONCURRENCY_MAX = getResolvedConcurrencyMax();');
  });

  it('RATE_LIMITER_HOST_SOURCE declares the helper and reads from manifest-plugins', () => {
    expect(RATE_LIMITER_HOST_SOURCE).toContain('function getResolvedConcurrencyMax(');
    expect(RATE_LIMITER_HOST_SOURCE).toContain("require('manifest-plugins')");
    expect(RATE_LIMITER_HOST_SOURCE).toContain('getRateLimitPolicy');
  });

  it('RATE_LIMITER_HOST_SOURCE honors MANIFEST_PLUGINS_DISABLED at module load', () => {
    // Wave 5: the pasted snippet must call
    // `require('manifest-plugins').applyDisabledListFromEnv(...)` so
    // operators can flip plugins off at process start without a
    // rebuild. The call sits between the `require('manifest-plugins')`
    // guard and the plugin walk.
    expect(RATE_LIMITER_HOST_SOURCE).toContain('applyDisabledListFromEnv');
    expect(RATE_LIMITER_HOST_SOURCE).toContain(
      "process.env['MANIFEST_PLUGINS_DISABLED']",
    );
  });

  it('PROXY_SERVICE_OLD anchors on the constructor maxMessages assignment', () => {
    expect(PROXY_SERVICE_OLD).toBe(
      [
        '    this.maxMessagesPerRequest = parseMaxMessagesPerRequest(',
        '      this.config.get<string>(\'MANIFEST_MAX_MESSAGES\'),',
        '    );',
        '',
      ].join('\n'),
    );
  });

  it('PROXY_SERVICE_NEW delegates to getResolvedMaxMessagesPerRequest', () => {
    expect(PROXY_SERVICE_NEW).toContain(
      'this.maxMessagesPerRequest = getResolvedMaxMessagesPerRequest(this.config);',
    );
  });

  it('PROXY_SERVICE_HOST_SOURCE declares the helper and reads from manifest-plugins', () => {
    expect(PROXY_SERVICE_HOST_SOURCE).toContain(
      'function getResolvedMaxMessagesPerRequest(',
    );
    expect(PROXY_SERVICE_HOST_SOURCE).toContain("require('manifest-plugins')");
    expect(PROXY_SERVICE_HOST_SOURCE).toContain('getRateLimitPolicy');
  });

  it('PROXY_SERVICE_HOST_SOURCE honors MANIFEST_PLUGINS_DISABLED at module load', () => {
    // Wave 5: the pasted snippet must call
    // `require('manifest-plugins').applyDisabledListFromEnv(...)` so
    // operators can flip plugins off at process start without a
    // rebuild. The call sits between the `require('manifest-plugins')`
    // guard and the plugin walk.
    expect(PROXY_SERVICE_HOST_SOURCE).toContain('applyDisabledListFromEnv');
    expect(PROXY_SERVICE_HOST_SOURCE).toContain(
      "process.env['MANIFEST_PLUGINS_DISABLED']",
    );
  });
});

describe('host snippet: PROXY_ROUTING_OVERRIDE_* (new routing-override anchor)', () => {
  it('PROXY_ROUTING_OVERRIDE_HOST_SOURCE declares applyProxyRoutingOverridePlugins and calls overrideRouting', () => {
    expect(PROXY_ROUTING_OVERRIDE_HOST_SOURCE).toContain(
      'function applyProxyRoutingOverridePlugins(',
    );
    expect(PROXY_ROUTING_OVERRIDE_HOST_SOURCE).toContain("require('manifest-plugins')");
    expect(PROXY_ROUTING_OVERRIDE_HOST_SOURCE).toContain('overrideRouting');
  });

  it('PROXY_ROUTING_OVERRIDE_HOST_SOURCE honors MANIFEST_PLUGINS_DISABLED at module load', () => {
    // Wave 5: the pasted snippet must call
    // `require('manifest-plugins').applyDisabledListFromEnv(...)` so
    // operators can flip plugins off at process start without a
    // rebuild. The call sits between the `require('manifest-plugins')`
    // guard and the plugin walk.
    expect(PROXY_ROUTING_OVERRIDE_HOST_SOURCE).toContain(
      'applyDisabledListFromEnv',
    );
    expect(PROXY_ROUTING_OVERRIDE_HOST_SOURCE).toContain(
      'process.env[\'MANIFEST_PLUGINS_DISABLED\']',
    );
  });

  it('PROXY_ROUTING_OVERRIDE_NEW preserves the upstream comment block verbatim (so the helper marker anchors)', () => {
    // The helper marker anchor is the upstream comment line
    // `// Anthropic Messages...` which must survive the OLD→NEW replace.
    expect(PROXY_ROUTING_OVERRIDE_NEW).toContain(
      '    // Anthropic Messages requests require a provider-native model field; only',
    );
    expect(PROXY_ROUTING_OVERRIDE_NEW).toContain(
      '    // OpenAI-compatible surfaces use /v1/models IDs as route overrides.',
    );
  });

  it('PROXY_ROUTING_OVERRIDE_HOST_SOURCE does not throw — plugin errors are non-fatal', () => {
    expect(PROXY_ROUTING_OVERRIDE_HOST_SOURCE).toContain('catch');
    expect(PROXY_ROUTING_OVERRIDE_HOST_SOURCE).toContain('console.warn');
  });

  it('PROXY_ROUTING_OVERRIDE_HOST_SOURCE short-circuits on the first non-null plugin result', () => {
    // The host walks the plugin array in order and returns the first
    // non-null `route` from any plugin. Mirror that contract so the
    // helper behavior matches the upstream `ResolvedRouting` shape.
    expect(PROXY_ROUTING_OVERRIDE_HOST_SOURCE).toMatch(/for\s*\(/);
    expect(PROXY_ROUTING_OVERRIDE_HOST_SOURCE).toMatch(/continue/);
    expect(PROXY_ROUTING_OVERRIDE_HOST_SOURCE).toContain('return');
  });

  it('PROXY_ROUTING_OVERRIDE_HOST_SOURCE is assignable to upstream ResolvedRouting', () => {
    // Packaging regression lock: the pasted helper compiles inside
    // upstream `proxy.service.ts`, where `resolveRouting()` returns
    // `Promise<ResolvedRouting>`. A loose structural return type with
    // optional `tier` fails that build; use the upstream alias directly.
    expect(PROXY_ROUTING_OVERRIDE_HOST_SOURCE).toContain('): ResolvedRouting | null');
    expect(PROXY_ROUTING_OVERRIDE_HOST_SOURCE).not.toContain('tier?: string;');
  });

  it('PROXY_ROUTING_OVERRIDE_HOST_SOURCE accepts upstream ModelRoute keyLabel=null', () => {
    // Upstream manifest-shared ModelRoute is `keyLabel?: string | null`.
    // HeaderTier rows can therefore carry null keyLabel values; the
    // helper parameter and return cast must accept that shape.
    expect(PROXY_ROUTING_OVERRIDE_HOST_SOURCE).toContain('keyLabel?: string | null;');
  });

  it('PROXY_ROUTING_OVERRIDE_OLD matches the verbatim anchor introduced by upstream 2ab748a6', () => {
    // The anchor is the 5 lines after the `resolveRouting()` signature
    // close-brace. It's the signature of commit 2ab748a6.
    expect(PROXY_ROUTING_OVERRIDE_OLD).toBe(
      [
        '  ): Promise<ResolvedRouting> {',
        '    const requestedModel = typeof body.model === \'string\' ? body.model : undefined;',
        '    // Anthropic Messages requests require a provider-native model field; only',
        '    // OpenAI-compatible surfaces use /v1/models IDs as route overrides.',
        '    if (apiMode !== \'messages\' && requestedModel && requestedModel !== OPENAI_MODEL_ID_AUTO) {',
        '',
      ].join('\n'),
    );
  });

  it('PROXY_ROUTING_OVERRIDE_NEW inserts the plugin call BEFORE the explicit-model early-return', () => {
    // The host fetches headerTiers + discoveredModels and calls the
    // plugin BEFORE the upstream `if (apiMode !== 'messages' && ...)`
    // early-return branch. That is the entire point of this hook:
    // the plugin must run first so a header-tier match can override
    // the explicit-model branch.
    const pluginIdx = PROXY_ROUTING_OVERRIDE_NEW.indexOf(
      'applyProxyRoutingOverridePlugins(',
    );
    const earlyReturnIdx = PROXY_ROUTING_OVERRIDE_NEW.indexOf(
      "if (apiMode !== 'messages' && requestedModel && requestedModel !== OPENAI_MODEL_ID_AUTO) {",
    );
    expect(pluginIdx).toBeGreaterThanOrEqual(0);
    expect(earlyReturnIdx).toBeGreaterThanOrEqual(0);
    expect(pluginIdx).toBeLessThan(earlyReturnIdx);
  });

  it('PROXY_ROUTING_OVERRIDE_NEW preserves the original requestedModel block verbatim', () => {
    // After the plugin call, the original 2ab748a6 block must appear
    // unchanged. If upstream drifts, this assertion fires.
    expect(PROXY_ROUTING_OVERRIDE_NEW).toContain(
      '    const requestedModel = typeof body.model === \'string\' ? body.model : undefined;',
    );
    expect(PROXY_ROUTING_OVERRIDE_NEW).toContain(
      '    // Anthropic Messages requests require a provider-native model field; only',
    );
    expect(PROXY_ROUTING_OVERRIDE_NEW).toContain(
      '    if (apiMode !== \'messages\' && requestedModel && requestedModel !== OPENAI_MODEL_ID_AUTO) {',
    );
  });

  it('PROXY_ROUTING_OVERRIDE_NEW returns the plugin override or falls through to the original branch', () => {
    // The host MUST return the plugin's result directly when it is
    // non-null (short-circuit), otherwise let the existing branch
    // run. Both paths must be present.
    expect(PROXY_ROUTING_OVERRIDE_NEW).toMatch(/if\s*\([^)]*plugin[^)]*\)\s*return/);
    expect(PROXY_ROUTING_OVERRIDE_NEW).toContain('OPENAI_MODEL_ID_AUTO');
  });

  it('PROXY_ROUTING_OVERRIDE_IMPORT_OLD matches the verbatim import anchor', () => {
    expect(PROXY_ROUTING_OVERRIDE_IMPORT_OLD).toBe(
      "import { ProviderParamSpecService } from '../routing-core/provider-param-spec.service';\n",
    );
  });

  it('PROXY_ROUTING_OVERRIDE_IMPORT_NEW inserts the HeaderTierService import below the existing import', () => {
    expect(PROXY_ROUTING_OVERRIDE_IMPORT_NEW).toContain(
      'import { ProviderParamSpecService } from \'../routing-core/provider-param-spec.service\';',
    );
    expect(PROXY_ROUTING_OVERRIDE_IMPORT_NEW).toContain(
      'import { HeaderTierService } from \'../header-tiers/header-tier.service\';',
    );
    const existingIdx = PROXY_ROUTING_OVERRIDE_IMPORT_NEW.indexOf(
      'import { ProviderParamSpecService } from',
    );
    const headerTierIdx = PROXY_ROUTING_OVERRIDE_IMPORT_NEW.indexOf(
      'import { HeaderTierService } from',
    );
    expect(headerTierIdx).toBeGreaterThan(existingIdx);
  });

  it('PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_OLD anchors on the providerParamSpecs closing line', () => {
    // The existing constructor closes with `private readonly providerParamSpecs: ProviderParamSpecService,\n  ) {\n`.
    // We anchor on this exact shape (trailing comma + close-paren + brace)
    // so the patcher knows where to splice the new parameter.
    expect(PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_OLD).toContain(
      'private readonly providerParamSpecs: ProviderParamSpecService,',
    );
    expect(PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_OLD).toContain('  ) {');
  });

  it('PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_NEW adds the HeaderTierService parameter after providerParamSpecs', () => {
    expect(PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_NEW).toContain(
      'private readonly providerParamSpecs: ProviderParamSpecService,',
    );
    expect(PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_NEW).toContain(
      'private readonly headerTierService: HeaderTierService,',
    );
    const existingIdx = PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_NEW.indexOf(
      'private readonly providerParamSpecs:',
    );
    const headerTierIdx = PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_NEW.indexOf(
      'private readonly headerTierService:',
    );
    expect(headerTierIdx).toBeGreaterThan(existingIdx);
  });

  it('PROXY_ROUTING_OVERRIDE_NEW awaits the host fetches before calling the plugin', () => {
    // The host must fetch headerTiers + discoveredModels via async
    // service calls before invoking the plugin, since plugins cannot
    // access DB / Nest providers.
    expect(PROXY_ROUTING_OVERRIDE_NEW).toContain(
      'await this.headerTierService.list(agentId)',
    );
    expect(PROXY_ROUTING_OVERRIDE_NEW).toContain(
      'await this.modelDiscovery.getModelsForAgent(tenantId, agentId)',
    );
  });
});