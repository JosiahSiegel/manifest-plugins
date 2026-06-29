/**
 * Unit tests for the HeaderTierRouterPlugin. Covers:
 *   - Skips Anthropic Messages apiMode (upstream contract preserved)
 *   - Skips when body.model is undefined (no override needed)
 *   - Skips when no header tier matches the inbound headers
 *   - Skips when the matched tier has no override_route (logs warning,
 *     does not block the request)
 *   - Returns the matched tier's override_route as a routing object
 *     with reason=header-match + tier metadata (id, name, color)
 *   - Honors `sort_order` (first match wins after ascending sort)
 *   - Honors disabled tiers (skipped)
 *   - Honors string[] header values (matches upstream
 *     `matchesHeaderRule` semantics)
 *   - Preserves fallback_routes, response_mode, badge_color
 *   - Does NOT set explicit_model_override=true (the override came
 *     from a header-tier match, not a body model)
 */
import type {
  RoutingOverrideContext,
  RoutingOverrideHeaderTier,
  RoutingOverrideRoute,
} from '../..';
import {
  buildResolvedRoutingFromTier,
  HeaderTierRouterPlugin,
  isRouteAvailableInDiscoveredModels,
  pickMatchingHeaderTier,
} from './plugin';

function makeRoute(overrides: Partial<RoutingOverrideRoute> = {}): RoutingOverrideRoute {
  return {
    provider: 'anthropic',
    authType: 'api_key',
    model: 'claude-sonnet-4-5',
    ...overrides,
  };
}

function makeTier(
  overrides: Partial<RoutingOverrideHeaderTier> = {},
): RoutingOverrideHeaderTier {
  return {
    id: 'tier-1',
    name: 'reasoning',
    header_key: 'x-manifest-tier',
    header_value: 'reasoning',
    enabled: true,
    sort_order: 0,
    badge_color: '#ff0000',
    override_route: makeRoute(),
    fallback_routes: null,
    output_modality: null,
    response_mode: null,
    ...overrides,
  };
}

/**
 * Build a discovered-models fixture that contains the route
 * `makeRoute()` produces by default. Tests that exercise a
 * successful header-tier override start from this fixture so the
 * plugin's stale-route gate (Blocker #5) does not spuriously
 * fire. Tests that exercise the stale-route fall-through
 * override `discoveredModels` to a list that does NOT contain
 * the configured route.
 */
function makeDiscoveredModels(
  routes: readonly RoutingOverrideRoute[] = [makeRoute()],
): { readonly id: string; readonly provider: string; readonly authType: string }[] {
  return routes.map((route) => ({
    id: route.model,
    provider: route.provider,
    authType: route.authType,
  }));
}

function makeCtx(
  overrides: Partial<RoutingOverrideContext> = {},
): RoutingOverrideContext {
  // Default discovered-models contains the default route so the
  // stale-route gate (Blocker #5) passes for the baseline tests.
  const discoveredModelsDefault = makeDiscoveredModels();
  const ctx: RoutingOverrideContext = {
    agentId: 'agent-1',
    tenantId: 'tenant-1',
    apiMode: 'chat_completions',
    body: { model: 'openai/gpt-4o-mini' },
    headers: { 'x-manifest-tier': 'reasoning' },
    requestedModel: 'openai/gpt-4o-mini',
    headerTiers: [],
    discoveredModels: discoveredModelsDefault,
    ...overrides,
  };
  return ctx;
}

describe('HeaderTierRouterPlugin', () => {
  describe('pickMatchingHeaderTier', () => {
    it('returns null when no tiers are configured', () => {
      const tier = pickMatchingHeaderTier(makeCtx({ headerTiers: [] }));
      expect(tier).toBeNull();
    });

    it('returns null when no tier matches the inbound header value', () => {
      const ctx = makeCtx({
        headers: { 'x-manifest-tier': 'unknown' },
        headerTiers: [makeTier({ header_value: 'reasoning' })],
      });
      expect(pickMatchingHeaderTier(ctx)).toBeNull();
    });

    it('matches when the inbound string equals the configured value', () => {
      const tier = makeTier();
      const ctx = makeCtx({ headerTiers: [tier] });
      expect(pickMatchingHeaderTier(ctx)).toBe(tier);
    });

    it('matches when the inbound string[] contains the configured value', () => {
      const tier = makeTier({ header_value: 'reasoning' });
      const ctx = makeCtx({
        headers: { 'x-manifest-tier': ['other', 'reasoning', 'extra'] },
        headerTiers: [tier],
      });
      expect(pickMatchingHeaderTier(ctx)).toBe(tier);
    });

    it('does not match an empty string[]', () => {
      const tier = makeTier({ header_value: 'reasoning' });
      const ctx = makeCtx({
        headers: { 'x-manifest-tier': [] },
        headerTiers: [tier],
      });
      expect(pickMatchingHeaderTier(ctx)).toBeNull();
    });

    it('skips disabled tiers even when header matches', () => {
      const tier = makeTier({ enabled: false });
      const ctx = makeCtx({ headerTiers: [tier] });
      expect(pickMatchingHeaderTier(ctx)).toBeNull();
    });

    it('honors sort_order ascending — first match wins', () => {
      const low = makeTier({
        id: 'low',
        name: 'low-priority',
        sort_order: 10,
        header_value: 'reasoning',
      });
      const high = makeTier({
        id: 'high',
        name: 'high-priority',
        sort_order: 1,
        header_value: 'reasoning',
      });
      const ctx = makeCtx({ headerTiers: [low, high] });
      const matched = pickMatchingHeaderTier(ctx);
      expect(matched?.id).toBe('high');
    });

    it('returns null when the header key is absent', () => {
      const tier = makeTier({ header_key: 'x-manifest-tier' });
      const ctx = makeCtx({
        headers: { 'unrelated-header': 'reasoning' },
        headerTiers: [tier],
      });
      expect(pickMatchingHeaderTier(ctx)).toBeNull();
    });

    it('treats null header value as no match (defensive)', () => {
      const tier = makeTier();
      const headers: Record<string, string | string[] | undefined> = {};
      Object.defineProperty(headers, 'x-manifest-tier', {
        value: null,
        enumerable: true,
      });
      const ctx = makeCtx({
        // Simulates malformed runtime input without weakening the
        // compile-time header type used by normal callers.
        headers,
        headerTiers: [tier],
      });
      expect(pickMatchingHeaderTier(ctx)).toBeNull();
    });
  });

  describe('isRouteAvailableInDiscoveredModels', () => {
    it('matches an available route by provider + authType + model id', () => {
      const route = makeRoute({
        provider: 'openai',
        authType: 'subscription',
        model: 'gpt-5',
      });
      const result = isRouteAvailableInDiscoveredModels(route, [
        { id: 'gpt-5', provider: 'openai', authType: 'subscription' },
      ]);
      expect(result).toBe(true);
    });

    it('does not match when authType differs (Blocker #5 route identity)', () => {
      const route = makeRoute({
        provider: 'openai',
        authType: 'subscription',
        model: 'gpt-5',
      });
      const result = isRouteAvailableInDiscoveredModels(route, [
        { id: 'gpt-5', provider: 'openai', authType: 'api_key' },
      ]);
      expect(result).toBe(false);
    });
  });

  describe('buildResolvedRoutingFromTier', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('returns null when override_route is null and logs a warning', () => {
      const tier = makeTier({ override_route: null });
      const result = buildResolvedRoutingFromTier(tier);
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('matched');
      expect(warnSpy.mock.calls[0]?.[0]).toContain('no override_route');
    });

    it('returns a routing object with reason=header-match when route is set', () => {
      const route = makeRoute({
        provider: 'openai',
        authType: 'subscription',
        model: 'gpt-5',
        keyLabel: null,
      });
      const tier = makeTier({ override_route: route });
      const result = buildResolvedRoutingFromTier(tier, makeDiscoveredModels([route]));
      expect(result).toEqual({
        tier: 'standard',
        route,
        fallback_routes: null,
        response_mode: null,
        confidence: 1,
        score: 0,
        reason: 'header-match',
        header_tier_id: 'tier-1',
        header_tier_name: 'reasoning',
        header_tier_color: '#ff0000',
        explicit_model_override: false,
        output_modality: null,
      });
    });

    it('preserves the header tier `output_modality` (Blocker #4 regression lock)', () => {
      // Blocker #4 regression lock: `buildResolvedRoutingFromTier`
      // MUST copy the configured `output_modality` from the tier row
      // onto the returned routing object so the upstream routing
      // response surfaces the header-tier metadata. The X-Manifest-Tier
      // response header is built from `meta.tier`, but downstream
      // consumers (and the upstream proxy-response-handler) also read
      // `output_modality` from the routing object — dropping it
      // breaks parity with upstream's resolved-routing shape.
      const tier = makeTier({ output_modality: 'text' });
      const result = buildResolvedRoutingFromTier(tier, makeDiscoveredModels());
      expect(result?.output_modality).toBe('text');
    });

    it('preserves fallback_routes and response_mode from the tier row', () => {
      const fallback = [makeRoute({ provider: 'gemini', model: 'gemini-2.5-flash' })];
      const route = makeRoute();
      const tier = makeTier({
        override_route: route,
        fallback_routes: fallback,
        response_mode: 'stream',
      });
      const result = buildResolvedRoutingFromTier(tier, makeDiscoveredModels([route]));
      expect(result?.fallback_routes).toBe(fallback);
      expect(result?.response_mode).toBe('stream');
    });

    it('sets explicit_model_override=false (header-tier is not a body override)', () => {
      const result = buildResolvedRoutingFromTier(makeTier(), makeDiscoveredModels());
      expect(result?.explicit_model_override).toBe(false);
    });
  });

  describe('HeaderTierRouterPlugin.overrideRouting', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('returns null when apiMode is messages (Anthropic Messages is left alone)', () => {
      const ctx = makeCtx({
        apiMode: 'messages',
        headerTiers: [makeTier()],
      });
      expect(new HeaderTierRouterPlugin().overrideRouting(ctx)).toBeNull();
    });

    it('returns null when requestedModel is undefined (no body model to override)', () => {
      const ctx = makeCtx({
        body: {},
        headers: { 'x-manifest-tier': 'reasoning' },
        requestedModel: undefined,
        headerTiers: [makeTier()],
      });
      expect(new HeaderTierRouterPlugin().overrideRouting(ctx)).toBeNull();
    });

    it('returns null when no header tier matches', () => {
      const ctx = makeCtx({
        headers: { 'x-manifest-tier': 'unknown' },
        headerTiers: [makeTier({ header_value: 'reasoning' })],
      });
      expect(new HeaderTierRouterPlugin().overrideRouting(ctx)).toBeNull();
    });

    it('returns the matched tier routing when body.model is concrete (regression fix)', () => {
      const tier = makeTier();
      const ctx = makeCtx({
        // The original regression: body.model is a concrete ID, not
        // "auto", and x-manifest-tier was being ignored. The plugin
        // must return the tier's override_route.
        body: { model: 'openai/gpt-4o-mini' },
        headers: { 'x-manifest-tier': 'reasoning' },
        requestedModel: 'openai/gpt-4o-mini',
        headerTiers: [tier],
      });
      const result = new HeaderTierRouterPlugin().overrideRouting(ctx);
      expect(result?.reason).toBe('header-match');
      expect(result?.route).toEqual(tier.override_route);
      expect(result?.header_tier_id).toBe('tier-1');
      expect(result?.explicit_model_override).toBe(false);
    });

    it('returns null when the matched tier has no override_route (does not block request)', () => {
      const ctx = makeCtx({
        body: { model: 'openai/gpt-4o-mini' },
        headers: { 'x-manifest-tier': 'reasoning' },
        requestedModel: 'openai/gpt-4o-mini',
        headerTiers: [makeTier({ override_route: null })],
      });
      const result = new HeaderTierRouterPlugin().overrideRouting(ctx);
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('returns null when the matched tier route is not in `discoveredModels` (Blocker #5: stale/unavailable route fall-through)', () => {
      // Blocker #5 regression lock: when the configured
      // `override_route` points at a model that no longer exists in
      // the agent's discovered-models list, the plugin MUST fall
      // through to default routing (return null) rather than forcing
      // a stale route. The match is by `route.provider` +
      // `route.authType` + `route.model === discoveredModel.id`.
      const route = makeRoute({
        provider: 'openai',
        authType: 'subscription',
        model: 'gpt-5-deleted',
      });
      const ctx = makeCtx({
        body: { model: 'openai/gpt-4o-mini' },
        headers: { 'x-manifest-tier': 'reasoning' },
        requestedModel: 'openai/gpt-4o-mini',
        headerTiers: [makeTier({ override_route: route })],
        // The configured model `gpt-5-deleted` is absent from the
        // discovered-models list (only `gpt-4o-mini` is known).
        discoveredModels: [
          { id: 'gpt-4o-mini', provider: 'openai', authType: 'subscription' },
        ],
      });
      const result = new HeaderTierRouterPlugin().overrideRouting(ctx);
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('not available');
    });

    it('returns the matched tier route when it IS present in `discoveredModels`', () => {
      // Blocker #5 positive case: when the configured `override_route`
      // matches a discovered model by provider+authType+model, the
      // plugin returns the routing override as expected.
      const route = makeRoute({
        provider: 'openai',
        authType: 'subscription',
        model: 'gpt-5',
      });
      const ctx = makeCtx({
        body: { model: 'openai/gpt-4o-mini' },
        headers: { 'x-manifest-tier': 'reasoning' },
        requestedModel: 'openai/gpt-4o-mini',
        headerTiers: [makeTier({ override_route: route })],
        discoveredModels: [
          { id: 'gpt-4o-mini', provider: 'openai', authType: 'subscription' },
          { id: 'gpt-5', provider: 'openai', authType: 'subscription' },
        ],
      });
      const result = new HeaderTierRouterPlugin().overrideRouting(ctx);
      expect(result).not.toBeNull();
      expect(result?.reason).toBe('header-match');
      expect(result?.route).toEqual(route);
    });

    it('ignores disabled tiers', () => {
      const ctx = makeCtx({
        body: { model: 'openai/gpt-4o-mini' },
        headers: { 'x-manifest-tier': 'reasoning' },
        requestedModel: 'openai/gpt-4o-mini',
        headerTiers: [makeTier({ enabled: false })],
      });
      expect(new HeaderTierRouterPlugin().overrideRouting(ctx)).toBeNull();
    });
  });

  describe('HeaderTierRouterPlugin.metadata', () => {
    it('declares kind=routing-override', () => {
      expect(HeaderTierRouterPlugin.metadata.kind).toBe('routing-override');
    });

    it('declares id=header-tier-router', () => {
      expect(HeaderTierRouterPlugin.metadata.id).toBe('header-tier-router');
    });
  });
});