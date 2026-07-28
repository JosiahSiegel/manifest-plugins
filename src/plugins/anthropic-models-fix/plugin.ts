/**
 * AnthropicModelsFixPlugin — ModelListOverridePlugin that rewrites the
 * Anthropic slice of the upstream DiscoveredModel catalog so the
 * GET /v1/models endpoint reports the correct models as of July 2026.
 *
 * Why this plugin exists:
 *   Anthropic shipped several breaking changes between June 15 and
 *   July 1, 2026 that the upstream Manifest model-fetcher.ts
 *   DiscoveredModel catalog does not yet reflect:
 *     - June 15  2026 - claude-sonnet-4-20250514 and
 *                       claude-opus-4-20250514 retired.
 *     - June 29  2026 - fast mode removed from claude-opus-4-6.
 *     - June 30  2026 - claude-sonnet-5 launched (new tokenizer,
 *                       removed extended thinking, sampling-param 400s).
 *     - July  1  2026 - Claude Fable 5 / Mythos 5 restored.
 *     - July 24  2026 - fast mode removed from claude-opus-4-7.
 *
 *   This plugin rewrites the Anthropic slice of GET /v1/models so the
 *   gateway serves the correct latest-stable surface until upstream
 *   Manifest re-syncs its catalog.
 *
 * Row shape contract:
 *   Every row this plugin returns MUST populate every REQUIRED field of
 *   `ModelListOverrideDiscoveredModel` (id, displayName, provider,
 *   contextWindow, inputPricePerToken, outputPricePerToken,
 *   capabilityReasoning, capabilityCode, qualityScore, authType). The
 *   host pastes the plugin's output verbatim into upstream's
 *   `models.map(...)` block, which dereferences every required field
 *   without null-guards. Missing fields surface downstream as
 *   `undefined` in the JSON response and break the frontend's strict
 *   `AvailableModel` interface (the routing page's "Add fallback"
 *   button would 500 because `extractOriginPath` tries to construct a
 *   URL from `undefined`).
 *
 *   Pricing defaults to `null` (upstream's "free / unknown" sentinel).
 *   capabilityReasoning / capabilityCode are conservatively false for
 *   new rows. qualityScore defaults to 3 (upstream's mid-tier default).
 */
import type {
  ModelListOverrideContext,
  ModelListOverrideDiscoveredModel,
  ModelListOverridePlugin,
  ModelListOverrideResult,
  PluginKind,
  PluginMetadata,
} from '../..';

export const ANTHROPIC_MODELS_FIX_PLUGIN_KIND: PluginKind = 'model-list-override';

export const ANTHROPIC_MODELS_FIX_PLUGIN_METADATA: PluginMetadata = Object.freeze({
  id: 'anthropic-models-fix',
  name: 'Anthropic models fix (July 2026)',
  version: '0.3.0',
  description:
    'Fixes the Anthropic model list per Anthropic June/July 2026 changes.',
  kind: ANTHROPIC_MODELS_FIX_PLUGIN_KIND,
  // Upstream Manifest now fetches Anthropic models live from
  // https://api.anthropic.com/v1/models via provider-model-fetcher.service.ts,
  // so the static-catalog workaround this plugin implemented is no longer
  // needed for the standard image build. Operators shipping a build that
  // intentionally disables this plugin can do so via `manifest-plugins.config.json`
  // (set `"anthropic-models-fix": false`); the plugin remains enabled by
  // default here so the CI e2e gate (which exercises overrideModelList)
  // stays green.
});

const PLUGIN_INSTANCE_NAME = 'AnthropicModelsFixPlugin';

export const RETIRED_ANTHROPIC_MODEL_IDS: ReadonlySet<string> = Object.freeze(
  new Set(['claude-sonnet-4-20250514', 'claude-opus-4-20250514']),
);

/**
 * Full row shape for the latest-stable Anthropic surface. Mirrors
 * upstream's `DiscoveredModel` exactly. Pricing values are sourced from
 * the Anthropic pricing page as of 2026-07-07; capability flags reflect
 * public documentation. Update `version` in `ANTHROPIC_MODELS_FIX_PLUGIN_METADATA`
 * whenever this catalog changes.
 */
export interface LatestStableAnthropicModel {
  readonly id: string;
  readonly displayName: string;
  readonly contextWindow: number;
  readonly inputPricePerToken: number | null;
  readonly outputPricePerToken: number | null;
  readonly capabilityReasoning: boolean;
  readonly capabilityCode: boolean;
  readonly qualityScore: number;
  /**
   * Upstream `DiscoveredModel.capabilities` is `readonly ModelCapability[]`
   * (an array of capability strings like 'text', 'stream', 'tools'), NOT
   * an object map. The upstream `mergeModelCapabilities()` helper iterates
   * this with `for...of`, which throws `TypeError: object is not iterable`
   * on a plain object, causing a 500 on every `/v1/models` request.
   */
  readonly capabilities: readonly string[];
  readonly addedOn: string;
}

export const LATEST_STABLE_ANTHROPIC_MODELS: readonly LatestStableAnthropicModel[] = Object.freeze([
  {
    id: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    contextWindow: 1_000_000,
    inputPricePerToken: 3.0e-6,    // $3 / MTok (introductory through Aug 31 2026, then $3)
    outputPricePerToken: 15.0e-6,   // $15 / MTok
    capabilityReasoning: true,      // adaptive thinking on by default
    capabilityCode: true,
    qualityScore: 5,
    capabilities: Object.freeze(['text', 'image', 'tools', 'stream']),
    addedOn: '2026-06-30',
  },
  {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    contextWindow: 200_000,
    inputPricePerToken: 15.0e-6,    // $15 / MTok
    outputPricePerToken: 75.0e-6,   // $75 / MTok
    capabilityReasoning: true,
    capabilityCode: true,
    qualityScore: 5,
    capabilities: Object.freeze(['text', 'image', 'tools', 'stream']),
    addedOn: '2026-06-29',
  },
  {
    id: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    inputPricePerToken: 1.0e-6,     // $1 / MTok
    outputPricePerToken: 5.0e-6,    // $5 / MTok
    capabilityReasoning: false,
    capabilityCode: true,
    qualityScore: 4,
    capabilities: Object.freeze(['text', 'tools', 'stream']),
    addedOn: '2025-10-01',
  },
]);

const DEFAULT_AUTH_TYPE = 'api_key';

/**
 * Resolve the auth type the operator wants this plugin to surface for
 * added Anthropic models.
 */
export function resolveDefaultAuthType(): 'api_key' | 'subscription' {
  const raw = process.env['ANTHROPIC_DEFAULT_AUTH_TYPE'];
  if (raw === 'subscription' || raw === 'api_key') return raw;
  return DEFAULT_AUTH_TYPE;
}

/**
 * Convert a catalog entry into a full ModelListOverrideDiscoveredModel
 * row, setting the authType and dropping the catalog-only `addedOn` field.
 *
 * The output is a fully-formed upstream-compatible row — every required
 * field of `ModelListOverrideDiscoveredModel` is populated. See the
 * `Row shape contract` comment at the top of this file for why.
 */
function catalogRowToDiscoveredModel(
  entry: LatestStableAnthropicModel,
  authType: 'api_key' | 'subscription',
): ModelListOverrideDiscoveredModel {
  return Object.freeze({
    id: entry.id,
    displayName: entry.displayName,
    provider: 'anthropic',
    contextWindow: entry.contextWindow,
    inputPricePerToken: entry.inputPricePerToken,
    outputPricePerToken: entry.outputPricePerToken,
    capabilityReasoning: entry.capabilityReasoning,
    capabilityCode: entry.capabilityCode,
    qualityScore: entry.qualityScore,
    authType,
    capabilities: entry.capabilities,
    inputModalities: Object.freeze(['text']),
    outputModalities: Object.freeze(['text']),
    supportedEndpoints: Object.freeze(['messages']),
  });
}

export function buildAnthropicModelList(
  discovered: readonly ModelListOverrideDiscoveredModel[],
  authType: 'api_key' | 'subscription',
): readonly ModelListOverrideDiscoveredModel[] {
  const nonAnthropic = discovered.filter((m) => m.provider !== 'anthropic');
  const survivingAnthropic = discovered.filter(
    (m) => m.provider === 'anthropic' && !RETIRED_ANTHROPIC_MODEL_IDS.has(m.id),
  );

  const tripleKey = (m: { provider: string; id: string; authType?: string }): string =>
    m.provider + '|' + m.id + '|' + (m.authType ?? '');
  const existing = new Set(survivingAnthropic.map(tripleKey));
  const augmented: ModelListOverrideDiscoveredModel[] = [...survivingAnthropic];
  for (const entry of LATEST_STABLE_ANTHROPIC_MODELS) {
    const candidate = catalogRowToDiscoveredModel(entry, authType);
    if (!existing.has(tripleKey(candidate))) augmented.push(candidate);
  }

  const merged: ModelListOverrideDiscoveredModel[] = [...nonAnthropic, ...augmented];
  merged.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    if (a.id !== b.id) return a.id.localeCompare(b.id);
    return (a.authType ?? '').localeCompare(b.authType ?? '');
  });
  return Object.freeze(merged);
}

export function buildReason(
  discovered: readonly ModelListOverrideDiscoveredModel[],
  replaced: readonly ModelListOverrideDiscoveredModel[],
): string {
  const retiredInInput = discovered.filter(
    (m) => m.provider === 'anthropic' && RETIRED_ANTHROPIC_MODEL_IDS.has(m.id),
  ).length;
  const anthropicInInput = discovered.filter((m) => m.provider === 'anthropic').length;
  const anthropicInOutput = replaced.filter((m) => m.provider === 'anthropic').length;
  const added = Math.max(anthropicInOutput - (anthropicInInput - retiredInInput), 0);
  return (
    'anthropic-models-fix: retired=' + retiredInInput + ' added=' + added +
    ' total_anthropic_in=' + anthropicInInput + ' total_anthropic_out=' + anthropicInOutput
  );
}

export class AnthropicModelsFixPlugin implements ModelListOverridePlugin {
  static readonly metadata: PluginMetadata = ANTHROPIC_MODELS_FIX_PLUGIN_METADATA;

  overrideModelList(
    ctx: ModelListOverrideContext,
  ): ModelListOverrideResult | null {
    const authType = resolveDefaultAuthType();
    const hasAnthropic = ctx.discoveredModels.some((m) => m.provider === 'anthropic');

    if (!hasAnthropic) {
      return Object.freeze({
        discoveredModels: ctx.discoveredModels,
        reason: 'anthropic-models-fix: no-op (no anthropic rows in upstream catalog)',
      });
    }

    try {
      const replaced = buildAnthropicModelList(ctx.discoveredModels, authType);
      const reason = buildReason(ctx.discoveredModels, replaced);
      return Object.freeze({ discoveredModels: replaced, reason });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn('[' + PLUGIN_INSTANCE_NAME + '] failed: ' + msg);
      return null;
    }
  }
}