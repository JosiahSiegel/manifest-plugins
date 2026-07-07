/**
 * AnthropicModelsFixPlugin - ModelListOverridePlugin that rewrites the
 * Anthropic slice of the upstream DiscoveredModel catalog so the
 * GET /v1/models endpoint reports the correct models as of July 2026.
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
  version: '0.1.0',
  description: 'Fixes the Anthropic model list per Anthropic June/July 2026 changes.',
  kind: ANTHROPIC_MODELS_FIX_PLUGIN_KIND,
});

const PLUGIN_INSTANCE_NAME = 'AnthropicModelsFixPlugin';

export const RETIRED_ANTHROPIC_MODEL_IDS: ReadonlySet<string> = Object.freeze(
  new Set(['claude-sonnet-4-20250514', 'claude-opus-4-20250514']),
);

export interface LatestStableAnthropicModel {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly addedOn: string;
}

export const LATEST_STABLE_ANTHROPIC_MODELS: readonly LatestStableAnthropicModel[] = Object.freeze([
  { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', capabilities: Object.freeze({ context_window: 1_000_000, max_output_tokens: 128_000, supports_vision: true }), addedOn: '2026-06-30' },
  { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', capabilities: Object.freeze({ context_window: 200_000, max_output_tokens: 32_000, supports_vision: true }), addedOn: '2026-06-29' },
  { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', capabilities: Object.freeze({ context_window: 200_000, max_output_tokens: 8_192, supports_vision: false }), addedOn: '2025-10-01' },
]);

const DEFAULT_AUTH_TYPE = 'api_key';

export function resolveDefaultAuthType(): 'api_key' | 'subscription' {
  const raw = process.env['ANTHROPIC_DEFAULT_AUTH_TYPE'];
  if (raw === 'subscription' || raw === 'api_key') return raw;
  return DEFAULT_AUTH_TYPE;
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
    const candidate: ModelListOverrideDiscoveredModel = Object.freeze({
      id: entry.id,
      provider: 'anthropic',
      authType,
      displayName: entry.displayName,
      capabilities: entry.capabilities,
    });
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
