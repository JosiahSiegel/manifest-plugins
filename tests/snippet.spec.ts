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
    // Plugins that mutate the body (e.g. one that prepends a `system[]`
    // block with a classifier-aware identity string at the start of the
    // request body) need the host to use their returned body verbatim so
    // the JSON key order matches the wire format the server expects.
    // Shallow-merging would keep the upstream's existing keys at the
    // start of the serialized object and let later keys (like
    // `messages`) come before `system`, breaking any byte-sensitive
    // body attestation the plugin computes (e.g. Anthropic's cch). The
    // contract here is: when a plugin returns a requestBody, the host
    // uses that exact object — no merge with the previous
    // result.requestBody.
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
});
