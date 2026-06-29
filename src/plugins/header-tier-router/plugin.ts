/**
 * Routes requests whose inbound HTTP headers match a configured
 * `header_tiers` row, restoring the pre-`2ab748a6` precedence where
 * `x-manifest-tier` (or any other configured tier header) wins over
 * `body.model`.
 *
 * Upstream commit `2ab748a6` (2026-06-29, PR #2350) added an
 * explicit-model early-return in `proxy.service.ts::resolveRouting()`
 * that bypasses `resolveService.resolve(..., headers)` for any
 * request whose `body.model !== "auto"`. As a side effect, the
 * configured `header_tiers` rules stopped firing on those requests
 * even when the inbound HTTP `x-manifest-tier` header was present.
 *
 * This plugin runs in the new `applyProxyRoutingOverridePlugins`
 * host hook, which fires BEFORE the explicit-model branch. The host
 * fetches `headerTiers` and `discoveredModels` and passes them in
 * the {@link RoutingOverrideContext}. The plugin returns a fully
 * formed routing object synthesized from the matched tier's
 * `override_route`, which the host uses as the request's
 * `ResolvedRouting` directly.
 *
 * Behavior:
 *   - Skips when `apiMode === 'messages'` (Anthropic Messages has its
 *     own native model field; PR #2350 deliberately left it alone).
 *   - Skips when `requestedModel === undefined` (let upstream handle
 *     untiered auto-routing).
 *   - Matches header values against `tier.header_value` using the same
 *     semantics as upstream `resolveHeaderTier.matchesHeaderRule`
 *     (string equality, or `string[]` contains).
 *   - Skips disabled tiers and tiers whose `override_route` is null
 *     (the upstream silent fall-through case). When a tier is matched
 *     but its `override_route` is null, the plugin logs a warning so
 *     operators see the misconfiguration.
 *   - First non-null `override_route` wins (matches upstream semantics:
 *     `sort_order` ascending, first match).
 *
 * Reference upstream code paths:
 *   - `packages/backend/src/routing/resolve/resolve.service.ts::resolveHeaderTier`
 *   - `packages/backend/src/routing/resolve/resolve.service.ts::matchesHeaderRule`
 */
import type {
  PluginKind,
  PluginMetadata,
  RoutingOverrideContext,
  RoutingOverrideDiscoveredModel,
  RoutingOverrideHeaderTier,
  RoutingOverridePlugin,
  RoutingOverrideResolvedRouting,
  RoutingOverrideRoute,
} from '../..';

export const HEADER_TIER_ROUTER_PLUGIN_KIND: PluginKind = 'routing-override';

export const HEADER_TIER_ROUTER_PLUGIN_METADATA: PluginMetadata = Object.freeze({
  id: 'header-tier-router',
  name: 'Header tier router',
  version: '0.1.0',
  description:
    'Routes requests whose inbound HTTP headers match a configured ' +
    '`header_tiers` row, restoring pre-`2ab748a6` precedence where ' +
    '`x-manifest-tier` (or any other configured tier header) wins over ' +
    '`body.model`.',
  kind: HEADER_TIER_ROUTER_PLUGIN_KIND,
});

const PLUGIN_INSTANCE_NAME = 'HeaderTierRouterPlugin';

/**
 * Pick the first enabled, ordered `header_tiers` row whose header
 * rule matches the inbound HTTP headers, OR `null` if none match.
 *
 * Mirrors `mnfst/manifest` `matchesHeaderRule` so behavior is
 * identical to upstream's existing resolver-side matching.
 */
export function pickMatchingHeaderTier(
  ctx: RoutingOverrideContext,
): RoutingOverrideHeaderTier | null {
  // Sort by sort_order ascending (upstream behavior).
  const sorted = [...ctx.headerTiers]
    .filter((tier) => tier.enabled)
    .sort((a, b) => a.sort_order - b.sort_order);

  for (const tier of sorted) {
    const raw = ctx.headers[tier.header_key];
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) {
      if (raw.includes(tier.header_value)) return tier;
      continue;
    }
    if (raw === tier.header_value) return tier;
  }
  return null;
}

/**
 * True when the configured `route` resolves to a model the agent
 * still has access to. The host fetches the agent's
 * `discoveredModels` list (one entry per
 * provider+authType+model combination the agent has credentials for)
 * and passes it in the context. If the configured
 * `override_route` no longer matches any discovered model — e.g.
 * the operator removed the credential or renamed the model — the
 * route is stale / unavailable and the plugin must fall through
 * to default routing rather than forcing a broken override.
 *
 * Match shape: `route.provider` === `discovered.provider` AND
 * `route.authType` === `discovered.authType` (when present) AND
 * `route.model` === `discovered.id`. Mirrors upstream's
 * `resolveHeaderTier` availability gate.
 */
export function isRouteAvailableInDiscoveredModels(
  route: RoutingOverrideRoute,
  discoveredModels: readonly RoutingOverrideDiscoveredModel[],
): boolean {
  for (const discovered of discoveredModels) {
    if (discovered.provider !== route.provider) continue;
    if (discovered.id !== route.model) continue;
    if (discovered.authType !== route.authType) continue;
    return true;
  }
  return false;
}

/**
 * Build a {@link RoutingOverrideResolvedRouting} from a matched
 * `header_tiers` row. Returns `null` when the matched tier has no
 * resolvable route — this is the same case upstream silently falls
 * through on, and we log a warning so operators see the
 * misconfiguration.
 *
 * When `discoveredModels` is provided AND the configured route no
 * longer resolves to any discovered model, also returns `null` and
 * logs a warning. This mirrors upstream's silent fall-through for
 * stale / unavailable header-tier routes.
 */
export function buildResolvedRoutingFromTier(
  tier: RoutingOverrideHeaderTier,
  discoveredModels?: readonly RoutingOverrideDiscoveredModel[],
): RoutingOverrideResolvedRouting | null {
  const route = tier.override_route;
  if (route === null) {
    // Upstream-equivalent silent fall-through case. Surface the
    // misconfiguration to operators via a console warning rather than
    // failing the request — a misconfigured rule must not block the
    // request flow. The next match (or the default routing path)
    // handles the request.
    // eslint-disable-next-line no-console
    console.warn(
      `[${PLUGIN_INSTANCE_NAME}] header tier "${tier.name}" matched ` +
        `(${tier.header_key}=${tier.header_value}) but has no ` +
        `override_route configured — falling through to default routing. ` +
        `Re-save the tier with provider/auth_type/model set.`,
    );
    return null;
  }

  if (
    discoveredModels !== undefined &&
    !isRouteAvailableInDiscoveredModels(route, discoveredModels)
  ) {
    // The configured route is not in the agent's discovered-models
    // list. This is the upstream-equivalent "unavailable route"
    // fall-through: forcing an unavailable route would push the
    // request to a model the agent no longer has credentials for.
    // Log a warning so operators see the misconfiguration and can
    // either re-add the credential or delete the stale tier row.
    // eslint-disable-next-line no-console
    console.warn(
      `[${PLUGIN_INSTANCE_NAME}] header tier "${tier.name}" matched ` +
        `(${tier.header_key}=${tier.header_value}) but its ` +
        `override_route { provider: ${route.provider}, ` +
        `authType: ${route.authType}, model: ${route.model} } ` +
        `is not available in the agent's discovered models — ` +
        `falling through to default routing. Re-add the credential ` +
        `for this provider/model or remove the stale tier row.`,
    );
    return null;
  }

  return {
    tier: 'standard',
    route,
    fallback_routes: tier.fallback_routes,
    response_mode: tier.response_mode,
    confidence: 1,
    score: 0,
    reason: 'header-match',
    header_tier_id: tier.id,
    header_tier_name: tier.name,
    header_tier_color: tier.badge_color,
    output_modality: tier.output_modality,
    explicit_model_override: false,
  };
}

export class HeaderTierRouterPlugin implements RoutingOverridePlugin {
  static readonly metadata: PluginMetadata = HEADER_TIER_ROUTER_PLUGIN_METADATA;

  overrideRouting(
    ctx: RoutingOverrideContext,
  ): RoutingOverrideResolvedRouting | null {
    // Don't override Anthropic Messages requests — PR #2350 explicitly
    // leaves `apiMode === 'messages'` alone because the `model` field
    // is the provider-native Anthropic model ID, not an SDK routing
    // override.
    if (ctx.apiMode === 'messages') return null;

    // No `model` in the body means the upstream resolver handles it
    // already. Letting upstream handle this avoids duplicating the
    // specificity/scoring path here.
    if (ctx.requestedModel === undefined) return null;

    const matched = pickMatchingHeaderTier(ctx);
    if (matched === null) return null;

    return buildResolvedRoutingFromTier(matched, ctx.discoveredModels);
  }
}