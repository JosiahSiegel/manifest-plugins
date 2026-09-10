import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import type {
  AuthType,
  ModelListOverrideContext,
  ModelListOverrideDiscoveredModel,
  ModelListOverridePlugin,
  ModelListOverrideResult,
  PluginMetadata,
  ProviderParamSpec,
  ProviderParamSpecPlugin,
} from '../..';

export const GPT_ASTRA_MODEL_LIST_OVERRIDE_PLUGIN_METADATA: PluginMetadata = Object.freeze({
  id: 'gpt-astra-model-list-override',
  name: 'OpenAI GPT-6 Astra compatibility shim',
  version: '0.1.0',
  description:
    'Adds the OpenAI GPT-6 Astra model row to the /v1/models response ' +
    'for every connected OpenAI auth type (api_key, subscription) and ' +
    'emits/merges the reasoning_effort parameter spec with the full ' +
    'five-tier enum (low, medium, high, xhigh, max) for the exact ' +
    '(openai, gpt-6-astra, authType) identity. Becomes a no-op ' +
    'automatically when Manifest or modelparams adds Astra coverage ' +
    'themselves (active full 5-tier upstream row, exact identity ' +
    'triple present in the discovered-models list, or no OpenAI ' +
    'connection on the agent). Disabling this plugin restores the ' +
    'upstream behavior. No request-transport or routing change; no ' +
    'fabricated models, providers, or tiers beyond the published ' +
    'GPT-6 Astra row.',
  kind: 'model-list-override',
});

const ASTRA_MODEL_ID = 'gpt-6-astra';
const ASTRA_TIERS: readonly string[] = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const OPENAI_AUTH_TYPES = ['api_key', 'subscription'] as const;
type ProviderParamIdentity = Pick<ProviderParamSpec, 'provider' | 'authType' | 'model'>;

interface CatalogParamSpec extends ProviderParamSpec {
  readonly apiSurface?: string;
  readonly status?: string;
}

interface ModelparamsParamSpec {
  readonly path: string;
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly default?: unknown;
  readonly values?: readonly unknown[];
  readonly range?: { readonly min?: number; readonly max?: number; readonly step?: number };
  readonly group: string;
}

interface ModelparamsEntry {
  readonly provider: string;
  readonly authType: AuthType;
  readonly model: string;
  readonly params: readonly ModelparamsParamSpec[];
  readonly apiSurface?: string;
  readonly status?: string;
}

const EMPTY_CATALOG: readonly CatalogParamSpec[] = Object.freeze([] as CatalogParamSpec[]);

function loadDefaultCatalog(): readonly CatalogParamSpec[] {
  let dataModule: string;
  try {
    const req = createRequire(join(process.cwd(), 'packages/backend/dist/index.js'));
    dataModule = readFileSync(join(dirname(req.resolve('modelparams/package.json')), 'dist/generated/data.js'), 'utf8');
  } catch {
    return EMPTY_CATALOG;
  }
  const catalogJson = dataModule.match(/(?:const GENERATED_CATALOG|export const CATALOG)\s*=\s*([\s\S]*?);\s*(?:export const CATALOG\s*=\s*GENERATED_CATALOG;\s*)?function authSuffix\b/)?.[1];
  if (catalogJson === undefined) {
    console.warn('[gpt-astra-model-list-override] modelparams catalog shape is unsupported');
    return EMPTY_CATALOG;
  }
  try {
    const parsed: unknown = JSON.parse(catalogJson);
    return Array.isArray(parsed) ? buildCatalog(parsed as readonly ModelparamsEntry[]) : EMPTY_CATALOG;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[gpt-astra-model-list-override] modelparams catalog parse failed: ${detail}`);
    return EMPTY_CATALOG;
  }
}

function buildCatalog(entries: readonly ModelparamsEntry[]): readonly CatalogParamSpec[] {
  const rows: CatalogParamSpec[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.provider !== 'string' || typeof entry.model !== 'string') continue;
    if (entry.authType !== 'api_key' && entry.authType !== 'subscription' && entry.authType !== 'local') continue;
    if (!Array.isArray(entry.params)) continue;
    for (const param of entry.params) {
      if (!param || typeof param !== 'object' || typeof param.path !== 'string') continue;
      const valuesArray = Array.isArray(param.values) ? param.values : undefined;
      rows.push(Object.freeze({
        provider: entry.provider,
        authType: entry.authType,
        model: entry.model,
        path: param.path,
        type: typeof param.type === 'string' ? param.type : 'string',
        label: typeof param.label === 'string' ? param.label : param.path,
        description: typeof param.description === 'string' ? param.description : '',
        default: param.default,
        values: valuesArray === undefined ? undefined : Object.freeze(valuesArray.slice()),
        range: param.range === undefined ? undefined : Object.freeze({ ...param.range }),
        group: typeof param.group === 'string' ? param.group : 'reasoning',
        ...(entry.apiSurface === undefined ? {} : { apiSurface: entry.apiSurface }),
        ...(entry.status === undefined ? {} : { status: entry.status }),
      }));
    }
  }
  return Object.freeze(rows);
}

function buildAstraRow(authType: AuthType): ModelListOverrideDiscoveredModel {
  return Object.freeze({
    id: ASTRA_MODEL_ID,
    displayName: 'GPT-6 Astra',
    provider: 'openai',
    contextWindow: 1_050_000,
    inputPricePerToken: 1e-5,
    outputPricePerToken: 5e-5,
    cacheReadPricePerToken: 1e-6,
    cacheWritePricePerToken: 1.25e-5,
    capabilityReasoning: true,
    capabilityCode: true,
    qualityScore: 5,
    authType,
    capabilities: Object.freeze(['text', 'image', 'tools', 'stream']),
    inputModalities: Object.freeze(['text', 'image']),
    outputModalities: Object.freeze(['text']),
    supportedEndpoints: Object.freeze(['/v1/chat/completions', '/v1/responses', '/v1/batch']),
  });
}

function selectOpenaiAuthTypes(
  rows: readonly ModelListOverrideDiscoveredModel[],
): ReadonlySet<AuthType> | null {
  let found = false;
  const present = new Set<AuthType>();
  for (const row of rows) {
    if (typeof row.provider !== 'string' || row.provider.toLowerCase() !== 'openai') continue;
    found = true;
    if (row.authType === 'api_key' || row.authType === 'subscription') present.add(row.authType);
  }
  return found ? present : null;
}

function buildReasoningEffortSpec(authType: AuthType): ProviderParamSpec {
  return Object.freeze({
    provider: 'openai',
    authType,
    model: ASTRA_MODEL_ID,
    path: 'reasoning_effort',
    type: 'enum',
    label: 'Reasoning effort',
    description: 'Controls how much reasoning the model should perform before producing an answer.',
    default: 'medium',
    values: Object.freeze([...ASTRA_TIERS]),
    group: 'reasoning',
  });
}

function upstreamHasFullActiveCoverage(
  rows: readonly CatalogParamSpec[],
  provider: string,
  authType: AuthType,
  model: string,
): boolean {
  return rows.some((row) => {
    if (row.provider !== provider || row.authType !== authType || row.model !== model) return false;
    if (row.status !== 'active') return false;
    const usesChatCompletionsPath = row.apiSurface === 'openai-chat-completions'
      && row.path === 'reasoning_effort';
    const usesResponsesPath = row.apiSurface === 'openai-responses'
      && row.path === 'reasoning.effort';
    if (!usesChatCompletionsPath && !usesResponsesPath) return false;
    if (!Array.isArray(row.values)) return false;
    const tiers = new Set(row.values.filter((value): value is string => typeof value === 'string'));
    return ASTRA_TIERS.every((tier) => tiers.has(tier));
  });
}

export class GptAstraModelListOverridePlugin
  implements ModelListOverridePlugin, ProviderParamSpecPlugin
{
  static readonly metadata: PluginMetadata = GPT_ASTRA_MODEL_LIST_OVERRIDE_PLUGIN_METADATA;

  private readonly catalog: readonly CatalogParamSpec[] | undefined;

  constructor(catalog?: readonly CatalogParamSpec[]) {
    this.catalog = catalog;
  }

  overrideModelList(ctx: ModelListOverrideContext): ModelListOverrideResult | null {
    try {
      if (ctx === null || typeof ctx !== 'object') {
        throw new TypeError('overrideModelList: ctx is not an object');
      }
      const discovered = (ctx as { discoveredModels?: unknown }).discoveredModels;
      if (!Array.isArray(discovered)) {
        throw new TypeError('overrideModelList: ctx.discoveredModels is not an array');
      }
      const upstreamRows = discovered as readonly ModelListOverrideDiscoveredModel[];
      const authTypes = selectOpenaiAuthTypes(upstreamRows);
      if (authTypes === null) return null;
      const ordered = OPENAI_AUTH_TYPES.filter(
        (authType) => authTypes.has(authType) && !upstreamRows.some(
          (row) => row.id === ASTRA_MODEL_ID
            && row.provider.toLowerCase() === 'openai'
            && row.authType === authType,
        ),
      );
      if (ordered.length === 0) return null;
      return {
        discoveredModels: Object.freeze([...upstreamRows, ...ordered.map(buildAstraRow)]),
        reason: `gpt-astra-model-list-override: appended gpt-6-astra row for ${ordered.join(', ')}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[gpt-astra-model-list-override] overrideModelList failed: ${msg}`);
      return null;
    }
  }

  overrideProviderParamSpecs(provider: 'openai', authType: 'api_key' | 'subscription', model: 'gpt-6-astra'): readonly ProviderParamSpec[] | null;

  overrideProviderParamSpecs(provider: undefined, authType: undefined, model: undefined): readonly ProviderParamIdentity[];

  overrideProviderParamSpecs(
    provider: 'openai' | undefined,
    authType: 'api_key' | 'subscription' | undefined,
    model: 'gpt-6-astra' | undefined,
  ): readonly ProviderParamSpec[] | readonly ProviderParamIdentity[] | null {
    try {
      if (provider === undefined && authType === undefined && model === undefined) {
        return Object.freeze([
          Object.freeze({ provider: 'openai', authType: 'api_key', model: ASTRA_MODEL_ID }),
          Object.freeze({ provider: 'openai', authType: 'subscription', model: ASTRA_MODEL_ID }),
        ]);
      }
      if (provider !== 'openai' || (authType !== 'api_key' && authType !== 'subscription') || model !== ASTRA_MODEL_ID) {
        return null;
      }
      const typed: AuthType = authType;
      const catalog = this.catalog ?? loadDefaultCatalog();
      if (upstreamHasFullActiveCoverage(catalog, provider, typed, ASTRA_MODEL_ID)) {
        return null;
      }
      return Object.freeze([buildReasoningEffortSpec(typed)]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[gpt-astra-model-list-override] overrideProviderParamSpecs failed: ${msg}`);
      return null;
    }
  }
}
