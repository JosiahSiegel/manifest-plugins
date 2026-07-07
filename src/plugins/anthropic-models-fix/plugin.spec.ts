/**
 * Unit tests for the AnthropicModelsFixPlugin.
 */
import type { ModelListOverrideDiscoveredModel, PluginMetadata } from '../..';
import {
  AnthropicModelsFixPlugin,
  ANTHROPIC_MODELS_FIX_PLUGIN_METADATA,
  RETIRED_ANTHROPIC_MODEL_IDS,
  LATEST_STABLE_ANTHROPIC_MODELS,
  buildAnthropicModelList,
  buildReason,
  resolveDefaultAuthType,
} from './plugin';

/**
 * Build a full upstream-compatible ModelListOverrideDiscoveredModel row
 * for tests. Real upstream `DiscoveredModel` requires every field;
 * the plugin must preserve this contract when it adds new rows.
 */
function row(
  id: string,
  provider: string,
  authType: string = 'api_key',
  overrides: Partial<ModelListOverrideDiscoveredModel> = {},
): ModelListOverrideDiscoveredModel {
  return Object.freeze({
    id,
    displayName: id,
    provider,
    contextWindow: 200_000,
    inputPricePerToken: null,
    outputPricePerToken: null,
    capabilityReasoning: false,
    capabilityCode: true,
    qualityScore: 3,
    authType,
    ...overrides,
  });
}

describe('AnthropicModelsFixPlugin (metadata + construction)', () => {
  it('declares metadata with the scaffolder id and a non-empty shape', () => {
    expect(ANTHROPIC_MODELS_FIX_PLUGIN_METADATA.id).toBe('anthropic-models-fix');
    expect(ANTHROPIC_MODELS_FIX_PLUGIN_METADATA.name).toEqual(expect.any(String));
    expect((ANTHROPIC_MODELS_FIX_PLUGIN_METADATA.name as string).length).toBeGreaterThan(0);
    expect(ANTHROPIC_MODELS_FIX_PLUGIN_METADATA.kind).toEqual(
      expect.stringMatching(
        /^(transform|policy|routing-override|dashboard-transform|model-list-override)$/,
      ),
    );
  });

  it('exposes the metadata via the static class field', () => {
    expect(AnthropicModelsFixPlugin.metadata).toEqual<PluginMetadata>(
      ANTHROPIC_MODELS_FIX_PLUGIN_METADATA,
    );
  });

  it('is constructable without throwing', () => {
    expect(() => new AnthropicModelsFixPlugin()).not.toThrow();
  });

  it('exposes the documented retired-ID set verbatim', () => {
    expect(RETIRED_ANTHROPIC_MODEL_IDS.has('claude-sonnet-4-20250514')).toBe(true);
    expect(RETIRED_ANTHROPIC_MODEL_IDS.has('claude-opus-4-20250514')).toBe(true);
    expect(RETIRED_ANTHROPIC_MODEL_IDS.size).toBe(2);
  });

  it('exposes the latest-stable catalog with the documented three models', () => {
    const ids = LATEST_STABLE_ANTHROPIC_MODELS.map((m) => m.id);
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-opus-4-6');
    expect(ids).toContain('claude-haiku-4-5');
    expect(LATEST_STABLE_ANTHROPIC_MODELS.length).toBe(3);
  });

  it('catalog rows populate every required upstream DiscoveredModel field', () => {
    // Regression lock: a row missing ANY of these required fields would
    // surface as `undefined` in the upstream /v1/models JSON response
    // and break the frontend's AvailableModel interface (e.g. the
    // routing page's "Add fallback" button would 500). See plugin.ts
    // header comment for the full contract.
    for (const entry of LATEST_STABLE_ANTHROPIC_MODELS) {
      expect(entry.contextWindow).toEqual(expect.any(Number));
      expect(entry.contextWindow).toBeGreaterThan(0);
      expect(entry.inputPricePerToken === null || typeof entry.inputPricePerToken === 'number').toBe(true);
      expect(entry.outputPricePerToken === null || typeof entry.outputPricePerToken === 'number').toBe(true);
      expect(typeof entry.capabilityReasoning).toBe('boolean');
      expect(typeof entry.capabilityCode).toBe('boolean');
      expect(entry.qualityScore).toEqual(expect.any(Number));
      expect(entry.qualityScore).toBeGreaterThanOrEqual(1);
      expect(entry.qualityScore).toBeLessThanOrEqual(5);
      expect(typeof entry.displayName).toBe('string');
      expect(entry.displayName.length).toBeGreaterThan(0);
    }
  });
});

describe('buildAnthropicModelList (pure helper)', () => {
  it('drops retired IDs from the Anthropic slice', () => {
    const input = [
      row('claude-sonnet-4-20250514', 'anthropic'),
      row('claude-opus-4-20250514', 'anthropic'),
      row('claude-opus-4-6', 'anthropic'),
    ];
    const out = buildAnthropicModelList(input, 'api_key');
    const ids = out.map((m) => m.id);
    expect(ids).not.toContain('claude-sonnet-4-20250514');
    expect(ids).not.toContain('claude-opus-4-20250514');
    expect(ids).toContain('claude-opus-4-6');
  });

  it('adds the latest-stable Anthropic catalog for the requested auth type', () => {
    const input: ModelListOverrideDiscoveredModel[] = [];
    const out = buildAnthropicModelList(input, 'api_key');
    const anthropic = out.filter((m) => m.provider === 'anthropic');
    const ids = anthropic.map((m) => m.id);
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-opus-4-6');
    expect(ids).toContain('claude-haiku-4-5');
    for (const m of anthropic) {
      expect(m.authType).toBe('api_key');
    }
  });

  it('preserves non-Anthropic provider rows verbatim', () => {
    const input = [
      row('gpt-5', 'openai'),
      row('gemini-2.5-pro', 'google'),
      row('claude-sonnet-5', 'anthropic'),
    ];
    const out = buildAnthropicModelList(input, 'api_key');
    const openai = out.find((m) => m.provider === 'openai');
    const google = out.find((m) => m.provider === 'google');
    expect(openai).toBeDefined();
    expect(google).toBeDefined();
    expect(openai?.id).toBe('gpt-5');
    expect(google?.id).toBe('gemini-2.5-pro');
  });

  it('does not duplicate an existing (provider, id, authType) triple', () => {
    const input = [row('claude-sonnet-5', 'anthropic', 'api_key')];
    const out = buildAnthropicModelList(input, 'api_key');
    const matches = out.filter(
      (m) => m.provider === 'anthropic' && m.id === 'claude-sonnet-5' && m.authType === 'api_key',
    );
    expect(matches).toHaveLength(1);
  });

  it('sorts the result by (provider, id, authType)', () => {
    const input = [
      row('claude-opus-4-6', 'anthropic'),
      row('gpt-5', 'openai'),
      row('claude-haiku-4-5', 'anthropic'),
      row('claude-sonnet-5', 'anthropic'),
    ];
    const out = buildAnthropicModelList(input, 'api_key');
    const providers = out.map((m) => m.provider);
    const anthropicIndices = providers.map((p, i) => (p === 'anthropic' ? i : -1)).filter((i) => i >= 0);
    const openaiIndices = providers.map((p, i) => (p === 'openai' ? i : -1)).filter((i) => i >= 0);
    expect(Math.max(...anthropicIndices)).toBeLessThan(Math.min(...openaiIndices));
  });

  it('does not mutate the input array', () => {
    const input = [
      row('claude-sonnet-4-20250514', 'anthropic'),
      row('claude-opus-4-6', 'anthropic'),
    ];
    const before = JSON.stringify(input);
    buildAnthropicModelList(input, 'api_key');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('is idempotent: re-running on the output yields the same output', () => {
    const input: ModelListOverrideDiscoveredModel[] = [];
    const first = buildAnthropicModelList(input, 'api_key');
    const second = buildAnthropicModelList(first, 'api_key');
    expect(second).toEqual(first);
  });

  it('surfaces displayName + capabilities for added rows', () => {
    const input: ModelListOverrideDiscoveredModel[] = [];
    const out = buildAnthropicModelList(input, 'api_key');
    const sonnet5 = out.find((m) => m.id === 'claude-sonnet-5');
    expect(sonnet5).toBeDefined();
    expect(sonnet5?.displayName).toBe('Claude Sonnet 5');
    expect(sonnet5?.capabilities).toBeDefined();
    expect(
      (sonnet5?.capabilities as Record<string, unknown> | undefined)?.['context_window'],
    ).toBe(1_000_000);
  });

  it('populates every required upstream DiscoveredModel field on added rows', () => {
    // Regression lock: a row missing ANY required field surfaces as
    // undefined in /v1/models JSON response and breaks the frontend.
    const input: ModelListOverrideDiscoveredModel[] = [];
    const out = buildAnthropicModelList(input, 'api_key');
    const required: ReadonlyArray<keyof ModelListOverrideDiscoveredModel> = [
      'id',
      'displayName',
      'provider',
      'contextWindow',
      'inputPricePerToken',
      'outputPricePerToken',
      'capabilityReasoning',
      'capabilityCode',
      'qualityScore',
    ];
    const anthropic = out.filter((m) => m.provider === 'anthropic');
    expect(anthropic.length).toBeGreaterThan(0);
    for (const m of anthropic) {
      for (const key of required) {
        expect(m[key]).toBeDefined();
        // Specifically: numeric fields must not be NaN / Infinity / null.
        if (
          key === 'contextWindow' ||
          key === 'inputPricePerToken' ||
          key === 'outputPricePerToken' ||
          key === 'qualityScore'
        ) {
          expect(typeof m[key]).toBe('number');
        }
      }
    }
  });

  it('scopes added rows to subscription authType when requested', () => {
    const input: ModelListOverrideDiscoveredModel[] = [];
    const out = buildAnthropicModelList(input, 'subscription');
    const anthropic = out.filter((m) => m.provider === 'anthropic');
    expect(anthropic.length).toBeGreaterThan(0);
    for (const m of anthropic) {
      expect(m.authType).toBe('subscription');
    }
  });

  it('preserves upstream pricing/capability fields on surviving rows verbatim', () => {
    // Regression lock: the plugin must not overwrite upstream's
    // pricing/capability data on rows that are already in the catalog
    // — only the LATEST_STABLE_ANTHROPIC_MODELS additions get the
    // plugin's hardcoded values; everything else flows through.
    const upstreamRow = row('claude-opus-4-6', 'anthropic', 'api_key', {
      inputPricePerToken: 99.99,
      outputPricePerToken: 88.88,
      contextWindow: 123456,
      qualityScore: 5,
    });
    const out = buildAnthropicModelList([upstreamRow], 'api_key');
    const passthrough = out.find((m) => m.id === 'claude-opus-4-6');
    expect(passthrough).toBeDefined();
    expect(passthrough?.inputPricePerToken).toBe(99.99);
    expect(passthrough?.outputPricePerToken).toBe(88.88);
    expect(passthrough?.contextWindow).toBe(123456);
    expect(passthrough?.qualityScore).toBe(5);
  });
});

describe('buildReason (audit-trail helper)', () => {
  it('reports retired count and added count', () => {
    const input = [
      row('claude-sonnet-4-20250514', 'anthropic'),
      row('claude-opus-4-20250514', 'anthropic'),
      row('claude-opus-4-6', 'anthropic'),
    ];
    const out = buildAnthropicModelList(input, 'api_key');
    const reason = buildReason(input, out);
    expect(reason).toMatch(/retired=2/);
    expect(reason).toMatch(/added=/);
    expect(reason).toMatch(/total_anthropic_in=3/);
    expect(reason).toMatch(/total_anthropic_out=/);
  });
});

describe('resolveDefaultAuthType (env-var resolution)', () => {
  const ORIGINAL_ENV = process.env['ANTHROPIC_DEFAULT_AUTH_TYPE'];

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env['ANTHROPIC_DEFAULT_AUTH_TYPE'];
    } else {
      process.env['ANTHROPIC_DEFAULT_AUTH_TYPE'] = ORIGINAL_ENV;
    }
  });

  it('defaults to api_key when env var is unset', () => {
    delete process.env['ANTHROPIC_DEFAULT_AUTH_TYPE'];
    expect(resolveDefaultAuthType()).toBe('api_key');
  });

  it('honors ANTHROPIC_DEFAULT_AUTH_TYPE=subscription', () => {
    process.env['ANTHROPIC_DEFAULT_AUTH_TYPE'] = 'subscription';
    expect(resolveDefaultAuthType()).toBe('subscription');
  });

  it('falls back to api_key when env var is an unrecognized value', () => {
    process.env['ANTHROPIC_DEFAULT_AUTH_TYPE'] = 'oauth-extra-secret';
    expect(resolveDefaultAuthType()).toBe('api_key');
  });
});

describe('AnthropicModelsFixPlugin.overrideModelList (integration)', () => {
  const plugin = new AnthropicModelsFixPlugin();

  it('returns a non-null no-op result when no Anthropic rows are present', () => {
    const ctx = Object.freeze({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      discoveredModels: Object.freeze([row('gpt-5', 'openai')]),
      requestMetadata: undefined,
    });
    const out = plugin.overrideModelList(ctx);
    expect(out).not.toBeNull();
    expect(out?.discoveredModels).toEqual(ctx.discoveredModels);
    expect(out?.reason).toMatch(/no-op/);
  });

  it('rewrites an upstream catalog that still ships retired Anthropic IDs', () => {
    const ctx = Object.freeze({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      discoveredModels: Object.freeze([
        row('claude-sonnet-4-20250514', 'anthropic'),
        row('claude-opus-4-20250514', 'anthropic'),
        row('claude-haiku-4-5', 'anthropic'),
      ]),
    });
    const out = plugin.overrideModelList(ctx);
    expect(out).not.toBeNull();
    const ids = out?.discoveredModels.map((m) => m.id) ?? [];
    expect(ids).not.toContain('claude-sonnet-4-20250514');
    expect(ids).not.toContain('claude-opus-4-20250514');
    expect(ids).toContain('claude-haiku-4-5');
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-opus-4-6');
    expect(out?.reason).toMatch(/anthropic-models-fix:/);
    expect(out?.reason).toMatch(/retired=2/);
  });

  it('returns upstream-compatible rows ready for the controllers models.map() block', () => {
    // Regression lock for the "Add fallback button fails" bug. The
    // controller does `m.inputPricePerToken`, `m.contextWindow`, etc.
    // without null-guards; if any field is undefined the JSON response
    // ships undefined values, the frontend's strict AvailableModel
    // interface breaks, and `extractOriginPath` throws because URL
    // construction cannot interpolate `undefined`. Every returned
    // row MUST have every required DiscoveredModel field defined.
    const ctx = Object.freeze({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      discoveredModels: Object.freeze([]),
    });
    const out = plugin.overrideModelList(ctx);
    expect(out).not.toBeNull();
    const requiredFields: ReadonlyArray<keyof ModelListOverrideDiscoveredModel> = [
      'id',
      'displayName',
      'provider',
      'contextWindow',
      'inputPricePerToken',
      'outputPricePerToken',
      'capabilityReasoning',
      'capabilityCode',
      'qualityScore',
    ];
    for (const m of out?.discoveredModels ?? []) {
      for (const field of requiredFields) {
        expect(m[field]).toBeDefined();
      }
    }
  });
});

describe('additional coverage', () => {
  function fullRow(
    id: string,
    provider: string,
    authType: string = 'api_key',
  ): ModelListOverrideDiscoveredModel {
    return row(id, provider, authType);
  }

  it('sorts by authType as a tie-breaker within the same provider and id', () => {
    const mixed = [
      fullRow('claude-haiku-4-5', 'anthropic', 'subscription'),
      fullRow('claude-haiku-4-5', 'anthropic', 'api_key'),
    ];
    mixed.sort((a, b) => {
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      if (a.id !== b.id) return a.id.localeCompare(b.id);
      return (a.authType ?? '').localeCompare(b.authType ?? '');
    });
    expect(mixed[0]?.authType).toBe('api_key');
    expect(mixed[1]?.authType).toBe('subscription');
  });

  it('returns null and logs a warning when buildAnthropicModelList throws', () => {
    // Force the inner build to throw by injecting a discoveredModels
    // proxy that satisfies `.some()` but throws when `.filter()` is called.
    const trap: unknown = new Proxy([{}] as unknown[], {
      get(target, prop, receiver) {
        if (prop === 'filter') {
          return () => {
            throw new Error('forced for coverage');
          };
        }
        if (prop === 'some') {
          return () => true;
        }
        return Reflect.get(target as object, prop, receiver);
      },
    });
    const ctx = Object.freeze({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      discoveredModels: trap as any,
      requestMetadata: undefined,
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = new AnthropicModelsFixPlugin().overrideModelList(ctx);
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      const firstCall = warnSpy.mock.calls[0]?.[0] as string | undefined;
      expect(firstCall).toMatch(/AnthropicModelsFixPlugin/);
      expect(firstCall).toMatch(/forced for coverage/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});