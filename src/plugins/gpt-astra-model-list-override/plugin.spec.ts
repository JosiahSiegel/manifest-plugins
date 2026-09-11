/**
 * Unit tests for the `gpt-astra-model-list-override` plugin
 * (`GptAstraModelListOverridePlugin`). RED-PHASE spec for plan
 * checkbox 7: `./plugin` is absent on disk, so the loader fails
 * with `Cannot find module .../plugin` and the Jest run reports
 * the missing implementation as the red reason.
 *
 * // allow: SIZE_OK — plan checkbox 7 mandates this exact filename
 * //         as the single red-phase spec file; the 9 contract cases
 * //         cannot be split across siblings without violating the
 * //         "Files created/modified: plugin.spec.ts only" constraint.
 *
 * Coverage map:
 *   (a) no openai upstream row → overrideModelList returns null
 *   (b) one synthetic row per present openai api_key/subscription
 *       auth type; `local` skipped
 *   (c) upstream rows preserved verbatim (incl. pricing,
 *       capabilities, quality score)
 *   (d) existing `(openai, gpt-6-astra, authType)` triple → null
 *   (e) plugin throw inside overrideModelList is contained
 *       (`console.warn` spy restored in afterEach)
 *   (f) deprecated 3-tier upstream → widened to the full five
 *       tiers on the correct wire path
 *   (g) partial 2-tier upstream → `medium/high/xhigh/max` added
 *   (h) full active five-tier upstream → null (yield)
 *   (i) MANIFEST_PLUGINS_DISABLED excludes the plugin from the
 *       LIVE `plugins` registry; env restored in afterEach
 *
 * All fixtures are `Object.freeze`-ed. Assertions target
 * observable return values (no implementation-call mocks, no prose
 * assertions, no snapshot of natural-language strings).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type {
  ModelListOverrideContext,
  ModelListOverrideDiscoveredModel,
  ModelListOverridePlugin,
  ModelListOverrideResult,
  PluginMetadata,
  ProviderParamSpec,
} from '../..';
import { applyDisabledListFromEnv } from '../../host/env-toggle';
import { plugins as livePlugins, setPluginEnabled } from '../..';

// Plugin loader — intentionally red until checkbox 8 lands.
declare class GptAstraPluginDecl implements ModelListOverridePlugin {
  static readonly metadata: PluginMetadata;
  constructor(catalog?: readonly ProviderParamSpec[]);
  overrideProviderParamSpecs(
    provider: 'openai',
    authType: 'api_key' | 'subscription',
    model: 'gpt-6-astra',
  ): readonly ProviderParamSpec[] | null;
  overrideProviderParamSpecs(
    provider: undefined,
    authType: undefined,
    model: undefined,
  ): readonly Pick<ProviderParamSpec, 'provider' | 'authType' | 'model'>[];
  overrideModelList(ctx: ModelListOverrideContext): ModelListOverrideResult | null;
}
type PluginShape = {
  readonly GPT_ASTRA_MODEL_LIST_OVERRIDE_PLUGIN_METADATA: PluginMetadata;
  readonly GptAstraModelListOverridePlugin: typeof GptAstraPluginDecl;
};
function loadPlugin(): PluginShape {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  return require('./plugin') as PluginShape;
}

// ---- Frozen fixtures --------------------------------------------------------
const ASTRA_ID = 'gpt-6-astra';
const OPENAI_PROVIDER = 'openai';
const REQUIRED_TIERS: readonly string[] = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function makeRow(
  id: string,
  provider: string,
  authType: 'api_key' | 'subscription' | 'local',
  input: number,
  output: number,
  qualityScore: number,
  overrides: Record<string, unknown> = {},
): ModelListOverrideDiscoveredModel {
  return Object.freeze({
    id,
    displayName: id,
    provider,
    contextWindow: 128000,
    inputPricePerToken: input,
    outputPricePerToken: output,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore,
    authType,
    ...overrides,
  });
}

const API_KEY_ROW = makeRow('gpt-5', OPENAI_PROVIDER, 'api_key', 3e-6, 1.5e-5, 3);
const SUBSCRIPTION_ROW = makeRow('gpt-5-chat-latest', OPENAI_PROVIDER, 'subscription', 3e-6, 1.5e-5, 3);
const LOCAL_ROW = makeRow('gpt-oss-20b', OPENAI_PROVIDER, 'local', 0, 0, 2);
const EXISTING_ASTRA_API_KEY = makeRow(ASTRA_ID, OPENAI_PROVIDER, 'api_key', 1e-5, 5e-5, 5, { displayName: 'GPT-6 Astra' });
const ANTHROPIC_ROW = makeRow('claude-sonnet-4-6', 'anthropic', 'api_key', 1.5e-5, 7.5e-5, 5);

function ctx(rows: readonly ModelListOverrideDiscoveredModel[]): ModelListOverrideContext {
  return {
    tenantId: 'tenant-7',
    agentId: 'agent-7',
    discoveredModels: Object.freeze(rows),
    requestMetadata: Object.freeze({ source: 'plugin-spec.fixture' }),
  };
}

function makeParamRow(
  values: readonly string[],
  extras: { readonly status?: string } = {},
): ProviderParamSpec {
  const base: ProviderParamSpec = {
    provider: OPENAI_PROVIDER,
    authType: 'api_key',
    model: ASTRA_ID,
    path: 'reasoning_effort',
    type: 'enum',
    label: 'Reasoning effort',
    description: 'Controls OpenAI reasoning effort for GPT-6 Astra.',
    default: 'medium',
    values: Object.freeze([...values]),
    group: 'reasoning',
  };
  // `status` is not on the typed `ProviderParamSpec`; fold it on
  // via a structural superset so the fixtures mirror what task 8
  // will read from the upstream modelparams catalog at runtime.
  return Object.freeze({ ...base, ...(extras.status !== undefined ? { status: extras.status } : {}) });
}

function ctor(): GptAstraPluginDecl {
  return new (loadPlugin().GptAstraModelListOverridePlugin)();
}

function callModelListOverride(
  context: ModelListOverrideContext,
): ModelListOverrideResult | null {
  return ctor().overrideModelList(context);
}

function withModelparamsFixture<T>(data: string, run: () => T): T {
  const root = mkdtempSync(join(tmpdir(), 'gpt-astra-modelparams-'));
  const generatedDir = join(root, 'packages/backend/node_modules/modelparams/dist/generated');
  mkdirSync(join(root, 'packages/backend/dist'), { recursive: true });
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(join(root, 'packages/backend/dist/index.js'), '');
  writeFileSync(
    join(root, 'packages/backend/node_modules/modelparams/package.json'),
    JSON.stringify({ name: 'modelparams', version: '0.0.60' }),
  );
  writeFileSync(join(generatedDir, 'data.js'), data);
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    return run();
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- Tests ------------------------------------------------------------------
describe('GptAstraModelListOverridePlugin', () => {
  let warnSpy: jest.SpyInstance | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['MANIFEST_PLUGINS_DISABLED'];
  });

  afterEach(() => {
    if (warnSpy !== undefined) {
      warnSpy.mockRestore();
      warnSpy = undefined;
    }
    if (savedEnv === undefined) {
      delete process.env['MANIFEST_PLUGINS_DISABLED'];
    } else {
      process.env['MANIFEST_PLUGINS_DISABLED'] = savedEnv;
    }
    setPluginEnabled('gpt-astra-model-list-override', true);
    setPluginEnabled('show-all-router-views', true);
    setPluginEnabled('custom-provider-model-count-fix', true);
  });

  it('exports the plugin class, the frozen metadata constant, and a static-field identity link', () => {
    const plugin = loadPlugin();
    expect(typeof plugin.GptAstraModelListOverridePlugin).toBe('function');
    const metadata = plugin.GPT_ASTRA_MODEL_LIST_OVERRIDE_PLUGIN_METADATA;
    expect(metadata.id).toBe('gpt-astra-model-list-override');
    expect(metadata.kind).toBe('model-list-override');
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(plugin.GptAstraModelListOverridePlugin.metadata).toBe(metadata);
  });

  describe('overrideModelList', () => {
    it('returns null when no openai row is present in the upstream list (no-op)', () => {
      expect(callModelListOverride(ctx([ANTHROPIC_ROW]))).toBeNull();
    });

    it('adds a gpt-6-astra row per present openai api_key/subscription auth type and skips local', () => {
      const result = callModelListOverride(ctx([API_KEY_ROW, SUBSCRIPTION_ROW, LOCAL_ROW])) as ModelListOverrideResult;
      const astra = result.discoveredModels.filter(
        (r) => r.id === ASTRA_ID && r.provider === OPENAI_PROVIDER,
      );
      expect(astra).toHaveLength(2);
      expect(astra.map((r) => r.authType).sort()).toEqual(['api_key', 'subscription']);
      // Every synthetic Astra row carries the full required price /
      // cache-rate / capability / modality / endpoint surface so
      // task 8 can satisfy the host's strict `models.map(...)` block.
      for (const row of astra) {
        const enriched = row as unknown as {
          cacheReadPricePerToken: number;
          cacheWritePricePerToken: number;
          capabilityReasoning: boolean;
          capabilityCode: boolean;
          capabilities: readonly string[];
          inputModalities: readonly string[];
          outputModalities: readonly string[];
          supportedEndpoints: readonly string[];
        };
        expect(enriched.cacheReadPricePerToken).toBeGreaterThan(0);
        expect(enriched.cacheWritePricePerToken).toBeGreaterThan(0);
        expect(enriched.capabilityReasoning).toBe(true);
        expect(enriched.capabilityCode).toBe(true);
        expect(enriched.capabilities).toEqual(expect.arrayContaining(['text', 'tools', 'stream']));
        expect(enriched.inputModalities).toEqual(expect.arrayContaining(['text']));
        expect(enriched.outputModalities).toEqual(expect.arrayContaining(['text']));
        expect(enriched.supportedEndpoints[0]?.startsWith('/')).toBe(true);
      }
      // The local row passes through untouched with no Astra sibling.
      const localIds = result.discoveredModels.filter((r) => r.authType === 'local').map((r) => r.id);
      expect(localIds).toEqual(['gpt-oss-20b']);
    });

    it('preserves upstream rows verbatim including pricing, capabilities, and quality score', () => {
      const priced = Object.freeze({
        id: 'gpt-5-pro',
        displayName: 'GPT-5 Pro',
        provider: OPENAI_PROVIDER,
        contextWindow: 256000,
        inputPricePerToken: 0.000012,
        outputPricePerToken: 0.000048,
        cacheReadPricePerToken: 0.000001,
        cacheWritePricePerToken: 0.0000125,
        capabilityReasoning: true,
        capabilityCode: true,
        qualityScore: 5,
        capabilities: Object.freeze(['text', 'tools', 'stream']),
        inputModalities: Object.freeze(['text']),
        outputModalities: Object.freeze(['text']),
        supportedEndpoints: Object.freeze(['/v1/chat/completions']),
        authType: 'api_key' as const,
      }) as ModelListOverrideDiscoveredModel;
      const result = callModelListOverride(ctx([priced])) as ModelListOverrideResult;
      const preserved = result.discoveredModels.find((r) => r.id === 'gpt-5-pro');
      expect(preserved).toBe(priced);
      expect(preserved?.inputPricePerToken).toBe(0.000012);
      expect(preserved?.outputPricePerToken).toBeCloseTo(0.000048, 12);
      const enriched = preserved as unknown as {
        cacheReadPricePerToken: number;
        cacheWritePricePerToken: number;
        capabilities: readonly string[];
      };
      expect(enriched.cacheReadPricePerToken).toBe(0.000001);
      expect(enriched.cacheWritePricePerToken).toBe(0.0000125);
      expect(enriched.capabilities).toEqual(['text', 'tools', 'stream']);
      expect(Object.isFrozen(enriched.capabilities)).toBe(true);
    });

    it('returns null when upstream already has the exact (openai, gpt-6-astra, api_key) triple', () => {
      expect(callModelListOverride(ctx([EXISTING_ASTRA_API_KEY]))).toBeNull();
    });

    it('does not mutate the frozen ctx.discoveredModels input', () => {
      const before = [API_KEY_ROW, ANTHROPIC_ROW] as const;
      const c = ctx(before);
      callModelListOverride(c);
      expect(c.discoveredModels).toBe(before);
      expect(Object.isFrozen(c.discoveredModels)).toBe(true);
    });

    it('logs and returns null for a malformed null model-list context', () => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const result = callModelListOverride(null as unknown as ModelListOverrideContext);
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/gpt-astra-model-list-override/);
    });

    it('logs via console.warn when the plugin throws and returns null (host catch-and-log contract)', () => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const result = callModelListOverride({} as unknown as ModelListOverrideContext);
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/gpt-astra-model-list-override/);
    });

    it('logs non-Error model-list failures without throwing', () => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const malformed = Object.defineProperty({}, 'discoveredModels', {
        get: () => {
          throw new String('malformed model-list context');
        },
      });
      expect(callModelListOverride(malformed as ModelListOverrideContext)).toBeNull();
      expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/malformed model-list context/);
    });
  });

  describe('overrideProviderParamSpecs', () => {
    function callOverride(
      provider: 'openai',
      authType: 'api_key' | 'subscription',
      model: 'gpt-6-astra',
      catalog?: readonly ProviderParamSpec[],
    ): readonly ProviderParamSpec[] | null {
      const Plugin = loadPlugin().GptAstraModelListOverridePlugin;
      return new Plugin(catalog).overrideProviderParamSpecs(provider, authType, model);
    }

    it('widens the deprecated 3-tier upstream to the full 5-tier set on the reasoning_effort path', () => {
      const deprecated = makeParamRow(['low', 'medium', 'high'], { status: 'deprecated' });
      const merged = callOverride('openai', 'api_key', 'gpt-6-astra', [deprecated]);
      expect(merged).not.toBeNull();
      const wide = (merged as readonly ProviderParamSpec[]).find(
        (r) => r.path === 'reasoning_effort' || r.path === 'reasoning.effort',
      );
      expect(wide).toBeDefined();
      expect(Array.from(wide?.values ?? []).sort()).toEqual([...REQUIRED_TIERS].sort());
      expect(wide?.provider).toBe(OPENAI_PROVIDER);
      expect(wide?.authType).toBe('api_key');
      expect(wide?.model).toBe(ASTRA_ID);
      // The widened row must NOT carry `status: 'deprecated'`.
      const enriched = wide as unknown as { status?: string };
      if (enriched.status !== undefined) {
        expect(enriched.status).not.toBe('deprecated');
      }
    });

    it('adds medium/high/xhigh/max when upstream has only low on the reasoning_effort path', () => {
      const partial = makeParamRow(['low']);
      const merged = callOverride('openai', 'api_key', 'gpt-6-astra', [partial]) ?? [];
      const wide = merged.find(
        (r) => r.path === 'reasoning_effort' || r.path === 'reasoning.effort',
      );
      expect(wide).toBeDefined();
      expect(Array.from(wide?.values ?? []).sort()).toEqual([...REQUIRED_TIERS].sort());
      expect(merged).toHaveLength(1);
      expect(merged?.[0]).not.toBe(partial);
    });

    it('returns null when upstream already covers all five tiers (yield)', () => {
      const fullRow = Object.freeze({
        ...makeParamRow([...REQUIRED_TIERS], { status: 'active' }),
        apiSurface: 'openai-chat-completions',
      });
      expect(
        callOverride('openai', 'api_key', 'gpt-6-astra', [fullRow]),
      ).toBeNull();
    });

    it('yields when Responses exposes all five active reasoning tiers', () => {
      const responseRow = Object.freeze({
        ...makeParamRow([...REQUIRED_TIERS], { status: 'active' }),
        apiSurface: 'openai-responses',
        path: 'reasoning.effort',
      });
      expect(callOverride('openai', 'api_key', ASTRA_ID, [responseRow])).toBeNull();
    });

    it('does not treat mismatched or non-enum catalog rows as full coverage', () => {
      const mismatched = Object.freeze({
        ...makeParamRow([...REQUIRED_TIERS], { status: 'active' }),
        apiSurface: 'other-surface',
        path: 'temperature',
      });
      const missingValues = Object.freeze({
        ...makeParamRow([], { status: 'active' }),
        values: undefined,
        apiSurface: 'openai-chat-completions',
      });
      const result = callOverride('openai', 'api_key', ASTRA_ID, [mismatched, missingValues]);
      expect(result?.[0]?.values).toEqual(REQUIRED_TIERS);
    });

    it('parses the current GENERATED_CATALOG shape for no-argument active coverage', () => {
      const rows = (['api_key', 'subscription'] as const).map((authType) => ({
        provider: OPENAI_PROVIDER,
        authType,
        apiSurface: 'openai-chat-completions',
        model: ASTRA_ID,
        status: 'active',
        params: [{
          path: 'reasoning_effort', type: 'enum', label: 'Reasoning effort',
          description: 'Controls OpenAI reasoning effort for GPT-6 Astra.',
          default: 'medium', values: [...REQUIRED_TIERS], group: 'reasoning',
        }],
      }));
      const data = `const GENERATED_CATALOG = ${JSON.stringify(rows)};\n` +
        'export const CATALOG = GENERATED_CATALOG;\n' +
        'function authSuffix(authType) { return authType === "api_key" ? "" : "-subscription"; }\n';
      withModelparamsFixture(data, () => {
        const Plugin = loadPlugin().GptAstraModelListOverridePlugin;
        const plugin = new Plugin();
        expect(plugin.overrideProviderParamSpecs('openai', 'api_key', ASTRA_ID)).toBeNull();
        expect(plugin.overrideProviderParamSpecs('openai', 'subscription', ASTRA_ID)).toBeNull();
      });
    });

    it('warns and falls back when the generated catalog shape is unsupported', () => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      withModelparamsFixture('const GENERATED_CATALOG = [];\nexport const CATALOG = GENERATED_CATALOG;\n', () => {
        const result = new (loadPlugin().GptAstraModelListOverridePlugin)()
          .overrideProviderParamSpecs('openai', 'api_key', ASTRA_ID);
        expect(result?.[0]?.values).toEqual(REQUIRED_TIERS);
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '[gpt-astra-model-list-override] modelparams catalog shape is unsupported',
      );
    });

    it('warns and falls back when the generated catalog JSON is malformed', () => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      withModelparamsFixture(
        'const GENERATED_CATALOG = not-json;\nexport const CATALOG = GENERATED_CATALOG;\nfunction authSuffix() {}\n',
        () => {
          const result = new (loadPlugin().GptAstraModelListOverridePlugin)()
            .overrideProviderParamSpecs('openai', 'api_key', ASTRA_ID);
          expect(result?.[0]?.values).toEqual(REQUIRED_TIERS);
        },
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/modelparams catalog parse failed/);
    });

    it('falls back when a valid catalog payload is not an array', () => {
      withModelparamsFixture(
        'const GENERATED_CATALOG = {};\nexport const CATALOG = GENERATED_CATALOG;\nfunction authSuffix() {}\n',
        () => {
          const result = new (loadPlugin().GptAstraModelListOverridePlugin)()
            .overrideProviderParamSpecs('openai', 'api_key', ASTRA_ID);
          expect(result?.[0]?.values).toEqual(REQUIRED_TIERS);
        },
      );
    });

    it('handles malformed catalog entries and optional fields without throwing', () => {
      const entries = [
        null,
        'not-an-entry',
        { model: ASTRA_ID, authType: 'api_key', params: [] },
        { provider: OPENAI_PROVIDER, authType: 'api_key', params: [] },
        { provider: OPENAI_PROVIDER, model: ASTRA_ID, authType: 'unknown', params: [] },
        { provider: OPENAI_PROVIDER, model: ASTRA_ID, authType: 'local', params: [] },
        { provider: OPENAI_PROVIDER, model: ASTRA_ID, authType: 'api_key', params: {} },
        {
          provider: OPENAI_PROVIDER,
          model: ASTRA_ID,
          authType: 'api_key',
          params: [null, 'not-a-param', {}, {
            path: 'temperature', type: 1, label: 2, description: 3,
            default: 1, range: { min: 0 }, group: 2,
          }],
        },
      ];
      withModelparamsFixture(
        `const GENERATED_CATALOG = ${JSON.stringify(entries)};\n` +
          'export const CATALOG = GENERATED_CATALOG;\nfunction authSuffix() {}\n',
        () => {
          const result = new (loadPlugin().GptAstraModelListOverridePlugin)()
            .overrideProviderParamSpecs('openai', 'api_key', ASTRA_ID);
          expect(result?.[0]?.values).toEqual(REQUIRED_TIERS);
        },
      );
    });

    it('uses the non-Error parse failure message when JSON parsing throws a string object', () => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const parseSpy = jest.spyOn(JSON, 'parse').mockImplementation(() => {
        throw new String('catalog parse string failure');
      });
      try {
        withModelparamsFixture(
          'const GENERATED_CATALOG = [];\nexport const CATALOG = GENERATED_CATALOG;\nfunction authSuffix() {}\n',
          () => {
            const result = new (loadPlugin().GptAstraModelListOverridePlugin)()
              .overrideProviderParamSpecs('openai', 'api_key', ASTRA_ID);
            expect(result?.[0]?.values).toEqual(REQUIRED_TIERS);
          },
        );
      } finally {
        parseSpy.mockRestore();
      }
      expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/catalog parse string failure/);
    });

    it('uses the empty catalog when the modelparams package cannot be read', () => {
      const root = mkdtempSync(join(tmpdir(), 'gpt-astra-modelparams-missing-'));
      mkdirSync(join(root, 'packages/backend/dist'), { recursive: true });
      writeFileSync(join(root, 'packages/backend/dist/index.js'), '');
      const previousCwd = process.cwd();
      try {
        process.chdir(root);
        const result = new (loadPlugin().GptAstraModelListOverridePlugin)()
          .overrideProviderParamSpecs('openai', 'api_key', ASTRA_ID);
        expect(result?.[0]?.values).toEqual(REQUIRED_TIERS);
      } finally {
        process.chdir(previousCwd);
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('returns Astra identity rows for the host listModelIds undefined-argument call', () => {
      const Plugin = loadPlugin().GptAstraModelListOverridePlugin;
      const identities = new Plugin().overrideProviderParamSpecs(undefined, undefined, undefined);
      expect(identities).toEqual([
        { provider: OPENAI_PROVIDER, authType: 'api_key', model: ASTRA_ID },
        { provider: OPENAI_PROVIDER, authType: 'subscription', model: ASTRA_ID },
      ]);
    });

    it('returns null for a normal wrong provider identity', () => {
      const Plugin = loadPlugin().GptAstraModelListOverridePlugin;
      const override = new Plugin().overrideProviderParamSpecs as unknown as (
        provider: string,
        authType: 'api_key' | 'subscription',
        model: 'gpt-6-astra',
      ) => readonly ProviderParamSpec[] | null;
      expect(override('anthropic', 'api_key', ASTRA_ID)).toBeNull();
    });

    it('returns null and warns when an injected catalog throws during coverage inspection', () => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const throwingCatalog = Object.freeze({
        some: (): boolean => {
          throw new Error('catalog inspection failed');
        },
      }) as unknown as readonly ProviderParamSpec[];
      const Plugin = loadPlugin().GptAstraModelListOverridePlugin;
      const result = new Plugin(throwingCatalog).overrideProviderParamSpecs('openai', 'api_key', ASTRA_ID);
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/overrideProviderParamSpecs failed/);
    });

    it('uses the non-Error provider failure message when coverage throws a string object', () => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const throwingCatalog = Object.freeze({
        some: (): boolean => {
          throw new String('catalog inspection string failure');
        },
      }) as unknown as readonly ProviderParamSpec[];
      const Plugin = loadPlugin().GptAstraModelListOverridePlugin;
      expect(new Plugin(throwingCatalog).overrideProviderParamSpecs('openai', 'api_key', ASTRA_ID)).toBeNull();
      expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/catalog inspection string failure/);
    });

    it('scopes every returned row to the exact (openai, gpt-6-astra, subscription) identity', () => {
      const merged = callOverride('openai', 'subscription', 'gpt-6-astra');
      if (merged !== null) {
        for (const row of merged) {
          expect(row.provider).toBe(OPENAI_PROVIDER);
          expect(row.model).toBe(ASTRA_ID);
          expect(row.authType).toBe('subscription');
        }
      }
    });
  });

  describe('registry environment toggle', () => {
    const knownIds = new Set<string>([
      'show-all-router-views',
      'custom-provider-model-count-fix',
      'gpt-astra-model-list-override',
    ]);
    // Inspect the live `plugins` export (registry's enabled set),
    // not `installedPlugins` (which is the always-included list).
    const liveClassNames = (): string[] =>
      livePlugins.map(
        (p) => (p as unknown as { constructor: { name: string } }).constructor.name,
      );

    it('excludes the plugin from the live plugins export when MANIFEST_PLUGINS_DISABLED targets its id', () => {
      // Pre-condition: the plugin class is present in the live
      // registry (it is enabled by default at module load).
      // Without this assertion the test would pass vacuously on a
      // missing module.
      expect(liveClassNames()).toContain('GptAstraModelListOverridePlugin');
      process.env['MANIFEST_PLUGINS_DISABLED'] = 'gpt-astra-model-list-override';
      const applied = applyDisabledListFromEnv(process.env['MANIFEST_PLUGINS_DISABLED'], { knownIds });
      expect(applied).toEqual(['gpt-astra-model-list-override']);
      const names = liveClassNames();
      expect(names).not.toContain('GptAstraModelListOverridePlugin');
      expect(names).toContain('ShowAllRouterViewsPlugin');
      expect(names).toContain('CustomProviderModelCountFixPlugin');
    });

    it('keeps the plugin in the live plugins export when the env var targets a different plugin id', () => {
      process.env['MANIFEST_PLUGINS_DISABLED'] = 'show-all-router-views';
      applyDisabledListFromEnv(process.env['MANIFEST_PLUGINS_DISABLED'], { knownIds });
      const names = liveClassNames();
      expect(names).toContain('GptAstraModelListOverridePlugin');
      expect(names).not.toContain('ShowAllRouterViewsPlugin');
    });
  });
});
