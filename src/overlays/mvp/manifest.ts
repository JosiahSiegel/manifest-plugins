/**
 * MVP overlay spec for mnfst/manifest.
 *
 * Each entry describes one MVP overlay: where it lands in a Manifest
 * checkout (`target`) and the symbol used to detect the post-patch
 * state (`postPatchSymbol`). The apply entry point
 * (`src/apply/mvp-overlay.ts`) walks this array and, for each entry:
 *
 *   1. Reads `target` from the Manifest checkout.
 *   2. If the file already contains `postPatchSymbol`, treats the
 *      overlay as already applied (no-op).
 *   3. Otherwise, writes the overlay's content into `target` (or
 *      calls `apply` when the overlay ships a custom applicator).
 *
 * The MVP overlays reuse the host snippet already shipped in
 * `src/host/snippet.ts` — the MVP overlay path is the typed +
 * declarative surface that consumes those snippets in one batch.
 */
export interface MvpOverlaySpec {
  /** Stable overlay identifier (matches the on-disk artifact id). */
  readonly id: string;
  /**
   * Path relative to the Manifest checkout where the overlay lands,
   * e.g. `packages/backend/src/routing/proxy/provider-client.ts`.
   */
  readonly target: string;
  /**
   * Symbol the apply tool checks to decide "already applied" — if the
   * target file already contains this string, the overlay is a no-op.
   */
  readonly postPatchSymbol: string;
  /**
   * Optional custom applicator. When omitted, the default apply path
   * writes the overlay's compiled JS content into `target`. When set,
   * the apply path delegates entirely to this function (which must
   * still respect idempotency via `postPatchSymbol`).
   */
  readonly apply?: (manifestRoot: string) => Promise<void>;
}

/**
 * The MVP overlay manifest. Iterated in order by `applyMvpOverlay`.
 *
 * The four overlays mirror the four patch sites in
 * `src/host/apply.ts`:
 *   - `provider-client-transform-host`         → Anthropic request-transform host
 *   - `proxy-rate-limiter-policy-host`         → per-agent concurrency cap host
 *   - `proxy-service-policy-host`              → per-request message-array cap host
 *   - `proxy-service-routing-override-host`    → routing-override hook on
 *     `proxy.service.ts::resolveRouting()`, installed BEFORE the upstream
 *     `2ab748a6` explicit-model early-return so configured `header_tiers`
 *     rules (e.g. `x-manifest-tier`) win over `body.model`. Pre-`2ab748a6`
 *     upstream does not have the anchor and the overlay reports drift —
 *     this is correct (the upstream shape pre-`2ab748a6` already routed
 *     headers first).
 */
export const MVP_OVERLAY_SPEC: readonly MvpOverlaySpec[] = Object.freeze([
  Object.freeze({
    id: 'provider-client-transform-host',
    target: 'packages/backend/src/routing/proxy/provider-client.ts',
    postPatchSymbol: 'function applyRequestTransformPlugins(',
  }),
  Object.freeze({
    id: 'proxy-rate-limiter-policy-host',
    target: 'packages/backend/src/routing/proxy/proxy-rate-limiter.ts',
    postPatchSymbol: 'function getResolvedConcurrencyMax(',
  }),
  Object.freeze({
    id: 'proxy-service-policy-host',
    target: 'packages/backend/src/routing/proxy/proxy.service.ts',
    postPatchSymbol: 'function getResolvedMaxMessagesPerRequest(',
  }),
  Object.freeze({
    id: 'proxy-service-routing-override-host',
    target: 'packages/backend/src/routing/proxy/proxy.service.ts',
    postPatchSymbol: 'function applyProxyRoutingOverridePlugins(',
  }),
]);