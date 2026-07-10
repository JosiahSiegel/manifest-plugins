/**
 * The plugin-host patcher for mnfst/manifest.
 *
 * Patches three files to install the plugin host:
 *   1. `packages/backend/src/routing/proxy/provider-client.ts` — wraps the
 *      Anthropic branch's `return { ... }` with a call to
 *      `applyRequestTransformPlugins(decision, current)`. Lets the
 *      RequestTransformPlugin chain run per-request.
 *   2. `packages/backend/src/routing/proxy/proxy-rate-limiter.ts` —
 *      replaces the `const CONCURRENCY_MAX = 10;` constant with a call
 *      to `getResolvedConcurrencyMax()`. Lets the RequestPolicyPlugin
 *      chain override the per-agent concurrent-request cap.
 *   3. `packages/backend/src/routing/model.controller.ts` — inserts the
 *      model-list-override host so a `ModelListOverridePlugin` can rewrite
 *      the discovered-models list before it lands in the `GET /v1/models`
 *      response body.
 *
 * Wave-history note: this fork previously installed a routing-override
 * host on `proxy.service.ts` to work around upstream PR #2350's
 * explicit-model early-return regression. Upstream PR #2468
 * (commit `fccb0e2`, 2026-07-10) restored header-tier precedence over
 * explicit `body.model` directly in `proxy.service.ts::resolveExplicitModel`
 * and `resolve.service.ts::resolve()`, so the routing-override host is
 * no longer necessary. The corresponding snippet constants
 * (`PROXY_ROUTING_OVERRIDE_*`), the `applyProxyRoutingOverrideHost`
 * patcher, the `proxyService` field in `ManifestFileSpec`, and the
 * `applyAllFour` orchestrator were all retired on 2026-07-10.
 *
 * Earlier still: an earlier wave also installed a `maxMessagesPerRequest`
 * plugin host on `proxy.service.ts`. That host was removed when upstream
 * commit `c9009bcd5` deleted the `maxMessagesPerRequest` feature from
 * `proxy.service.ts` entirely.
 *
 * Each patch is byte-exact against upstream/main and idempotent (running
 * twice is a no-op). If upstream restructures, the patcher fails loudly
 * with the exact anchor that moved.
 *
 * The host query functions (`applyRequestTransformPlugins`,
 * `getResolvedConcurrencyMax`, `applyModelListOverridePlugins`) are
 * file-private — they're added immediately above the relevant class
 * declaration by the apply tool.
 */
import { promises as fs } from 'fs';
import {
  ADMIN_MOUNT_NEW,
  ADMIN_MOUNT_OLD,
  HELPER_MARKER_OLD,
  HOST_HELPER_SOURCE,
  MODEL_LIST_OVERRIDE_HOST_SOURCE,
  MODEL_LIST_OVERRIDE_HELPER_MARKER_OLD,
  MODEL_LIST_OVERRIDE_NEW,
  MODEL_LIST_OVERRIDE_OLD,
  ROUTING_MODEL_LIST_OVERRIDE_HELPER_MARKER_OLD_HEADER_TIER,
  ROUTING_MODEL_LIST_OVERRIDE_HELPER_MARKER_OLD_SPECIFICITY,
  ROUTING_MODEL_LIST_OVERRIDE_HELPER_MARKER_OLD_TIER,
  ROUTING_MODEL_LIST_OVERRIDE_NEW,
  ROUTING_MODEL_LIST_OVERRIDE_OLD,
  RETURN_NEW,
  RETURN_OLD,
  RATE_LIMITER_NEW,
  RATE_LIMITER_OLD,
  buildHelperMarkerNew,
  buildModelListOverrideHelperMarkerNew,
} from './snippet';
import {
  assertAnchors,
  type AnchorMarker,
} from '../apply/anchor-drift';

const HOUSEKEEPING_RATE_LIMITER_OLD = `const DEFAULT_CONCURRENCY_MAX = 10;
const CONCURRENCY_MAX = positiveIntegerEnv('CONCURRENCY_MAX', DEFAULT_CONCURRENCY_MAX);
`;

// =============================================================================
// Shared types
// =============================================================================

export type ApplyStatus = 'applied' | 'noop' | 'upstream-drift';

export interface ApplyResult {
  status: ApplyStatus;
  file: string;
  reason?: string;
}

export interface ApplyOptions {
  /** Dry-run: report what would change without writing. Default: false. */
  dryRun?: boolean;
  /**
   * Optional anchor markers to verify BEFORE reading the file. If any
   * marker is missing, the apply fails fast with `upstream-drift`
   * without writing the file. Used by the patcher + the apply CLI's
   * preflight pass to fail loud when upstream restructured.
   */
  preflightAnchors?: readonly AnchorMarker[];
}

interface PatchSpec {
  /** Absolute or relative path to the source file. */
  filePath: string;
  /**
   * Symbol (function/variable name) used to detect the post-patch state.
   * If the file already contains this symbol, the patch is a no-op.
   */
  postPatchSymbol: string;
  /**
   * The exact upstream text to replace.
   */
  oldText: string;
  /**
   * Older upstream anchors accepted for back-compat tests and stale checkouts.
   */
  oldTextAlternatives?: readonly string[];
  /**
   * The replacement text. May include a function definition that
   * precedes the call site.
   */
  newText: string;
  /**
   * Where to insert the function definition (if any) that precedes the
   * call site. The apply tool replaces this anchor with the helper
   * definition + the `@Injectable()` line. Same shape as
   * `HELPER_MARKER_OLD` for `provider-client.ts`.
   */
  helperMarkerOld?: string;
  /**
   * The new helper-marker text (replaces the old). If omitted, no helper
   * is inserted (used for patches that don't add a function definition).
   */
  helperMarkerNew?: string;
}

// =============================================================================
// Generic apply helper
// =============================================================================

/**
 * Pull a unique-shaped sentinel out of a patch's replacement text so the
 * apply tool can detect "already applied via a different shape" — e.g. a
 * hand-edit or a previous version of the patcher that achieved the same
 * intent. Strategy: walk the new text and find the *last*
 * identifier-shaped declaration (a `const X = ...` or `function X(...)`
 * line). If the file already contains that exact line verbatim, the
 * patch was already applied in this or a similar form.
 */
function extractSentinelFromNew(newText: string): string | null {
  const lines = newText.split('\n');
  let lastMatch: string | null = null;
  for (const line of lines) {
    if (/^(?:function|const)\s+\w+\s*[=(]/.test(line.trim())) {
      lastMatch = line;
    }
  }
  return lastMatch;
}

/**
 * Apply a single patch to a Manifest source file. Idempotent. Fail-loud on
 * upstream drift.
 */
export async function applyPatch(
  spec: PatchSpec,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const original = await fs.readFile(spec.filePath, 'utf-8');

  if (options.preflightAnchors && options.preflightAnchors.length > 0) {
    const report = assertAnchors(original, options.preflightAnchors);
    if (!report.ok) {
      return {
        status: 'upstream-drift',
        file: spec.filePath,
        reason:
          `upstream restructured ${spec.filePath} — preflight anchors missing: ` +
          report.missing.join(', '),
      };
    }
  }

  // --- Idempotency check ---
  if (original.includes(spec.postPatchSymbol)) {
    return { status: 'noop', file: spec.filePath };
  }

  // --- Anchor check ---
  const oldText = [spec.oldText, ...(spec.oldTextAlternatives ?? [])].find(
    (candidate) => original.includes(candidate),
  );
  if (oldText === undefined) {
    // The OLD upstream anchor is gone. Two possibilities:
    //   (a) The patch was already applied via a different shape — e.g.
    //       a fork's housekeeping overlay, a previous version of the
    //       patcher, or a hand-edit. If the new post-patch state is
    //       present (postPatchSymbol), the file is already in the
    //       patched state and we should report noop, not drift.
    //   (b) Upstream actually restructured and the patch is now stale.
    //       We surface the same drift message as before so the user
    //       knows to update snippet.ts.
    const newTextSentinel = extractSentinelFromNew(spec.newText);
    if (newTextSentinel && original.includes(newTextSentinel)) {
      return { status: 'noop', file: spec.filePath };
    }
    return {
      status: 'upstream-drift',
      file: spec.filePath,
      reason:
        `upstream restructured ${spec.filePath} — the expected upstream anchor is missing. ` +
        `Update src/host/snippet.ts to match the new upstream shape.`,
    };
  }
  if (spec.helperMarkerOld && !original.includes(spec.helperMarkerOld)) {
    // The helper-marker anchor is gone. If we got this far, the
    // postPatchSymbol check at line 136 didn't fire (else we'd have
    // returned noop already), so the helper function is genuinely
    // missing too. Report drift.
    return {
      status: 'upstream-drift',
      file: spec.filePath,
      reason:
        `upstream restructured ${spec.filePath} — the helper insertion marker is missing. ` +
        `Update src/host/snippet.ts to match the new upstream shape.`,
    };
  }

  // --- First apply ---
  let next = original;
  next = next.replace(oldText, spec.newText);
  if (spec.helperMarkerOld !== undefined && spec.helperMarkerNew !== undefined) {
    next = next.replace(spec.helperMarkerOld, spec.helperMarkerNew);
  }

  if (!options.dryRun) {
    await fs.writeFile(spec.filePath, next, 'utf-8');
  }
  return { status: 'applied', file: spec.filePath };
}

// =============================================================================
// Per-file patch specs
// =============================================================================

/**
 * Patch `provider-client.ts` to install the Anthropic request-transform
 * host. Two operations: insert `applyRequestTransformPlugins` helper
 * before the `ProviderClient` class, then replace the Anthropic branch's
 * `return { ... }` with a call to the helper.
 */
export async function applyProviderClientHost(
  filePath: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  return applyPatch(
    {
      filePath,
      postPatchSymbol: 'function applyRequestTransformPlugins(',
      oldText: RETURN_OLD,
      newText: RETURN_NEW,
      helperMarkerOld: HELPER_MARKER_OLD,
      helperMarkerNew: buildHelperMarkerNew(),
    },
    options,
  );
}

/**
 * Patch `proxy-rate-limiter.ts` to install the rate-limit host. Two
 * operations: insert `getResolvedConcurrencyMax` helper before the
 * `@Injectable()` decorator of the class, then replace the
 * `const CONCURRENCY_MAX = 10;` constant with a call to the helper.
 */
export async function applyProxyRateLimiterHost(
  filePath: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  // Helper insertion marker: the `@Injectable()` decorator + class
  // declaration. We include `implements OnModuleDestroy` because the
  // upstream class declares that interface; if upstream adds/removes an
  // interface, update this anchor.
  const helperMarkerOld = `@Injectable()
export class ProxyRateLimiter implements OnModuleDestroy {
`;
  const helperMarkerNew = `${HOST_HELPER_SOURCE}${helperMarkerOld}`;
  return applyPatch(
    {
      filePath,
      postPatchSymbol: 'function getResolvedConcurrencyMax(',
      oldText: RATE_LIMITER_OLD,
      oldTextAlternatives: [HOUSEKEEPING_RATE_LIMITER_OLD],
      newText: RATE_LIMITER_NEW,
      helperMarkerOld,
      helperMarkerNew,
    },
    options,
  );
}

/**
 * Patch the upstream `model.controller.ts` (or whichever file serves
 * `GET :agentName/available-models`) to install the model-list-override
 * host.
 *
 * Two operations, all in one pass:
 *   1. Insert the `applyModelListOverridePlugins` helper above the
 *      `modelDiscovery.getModelsForAgent` call site.
 *   2. Wrap the call site so a plugin can replace the discovered
 *      list before it lands in the `/v1/models` response body.
 *
 * Wave-history note: prior to the `chore/retire-obsolete-plugins`
 * refactor this function's docstring described a routing-override
 * patch on `proxy.service.ts`. That patch was retired when upstream
 * PR #2468 subsumed the behavior. The model-list-override host is
 * unchanged.
 */
export async function applyModelListOverrideHost(
  filePath: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  // Two operations, all in one pass:
  //   1. Insert the `applyModelListOverridePlugins` helper above the
  //      `modelDiscovery.getModelsForAgent` call site.
  //   2. Wrap the call site so a plugin can replace the discovered
  //      list before it lands in the `/v1/models` response body.
  return applyPatch(
    {
      filePath,
      postPatchSymbol: 'function applyModelListOverridePlugins(',
      oldText: MODEL_LIST_OVERRIDE_OLD,
      newText: MODEL_LIST_OVERRIDE_NEW,
      helperMarkerOld: MODEL_LIST_OVERRIDE_HELPER_MARKER_OLD,
      helperMarkerNew: buildModelListOverrideHelperMarkerNew(),
    },
    options,
  );
}

/**
 * Patch one of the routing-layer services (tier.service.ts,
 * specificity.service.ts, or header-tier.service.ts) to install
 * the routing-layer model-list-override call site. The helper
 * function `applyModelListOverridePlugins` is already defined in
 * `model.controller.ts` (installed by `applyModelListOverrideHost`),
 * so this patch only inserts the call-site wrapper — it does NOT
 * re-insert the helper definition.
 *
 * The `helperMarkerOld` and `helperMarkerNew` are identical
 * (byte-equal) so the `applyPatch` helper-insertion step is a
 * no-op; the call-site replacement still runs.
 *
 * @param filePath  Absolute or relative path to the routing-layer
 *                  service source file.
 * @param className One of `'TierService'`, `'SpecificityService'`,
 *                  `'HeaderTierService'`. Selects the byte-exact
 *                  `@Injectable()` + class declaration anchor for
 *                  the no-op helper-marker step.
 */
export async function applyRoutingModelListOverrideHost(
  filePath: string,
  className: 'TierService' | 'SpecificityService' | 'HeaderTierService',
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const helperMarkerOld =
    className === 'TierService'
      ? ROUTING_MODEL_LIST_OVERRIDE_HELPER_MARKER_OLD_TIER
      : className === 'SpecificityService'
        ? ROUTING_MODEL_LIST_OVERRIDE_HELPER_MARKER_OLD_SPECIFICITY
        : ROUTING_MODEL_LIST_OVERRIDE_HELPER_MARKER_OLD_HEADER_TIER;
  return applyPatch(
    {
      filePath,
      // Use the call-site anchor as the post-patch symbol so
      // idempotency is detected correctly: the post-patch state
      // contains `__availableRaw` (the renamed local), so we use
      // that as the sentinel. If the file already contains the
      // wrapper, the patch is a no-op.
      postPatchSymbol: 'const __availableRaw = await this.discoveryService.getModelsForAgent(',
      oldText: ROUTING_MODEL_LIST_OVERRIDE_OLD,
      newText: ROUTING_MODEL_LIST_OVERRIDE_NEW,
      helperMarkerOld,
      // byte-equal: no helper insertion. The `applyModelListOverridePlugins`
      // function is already defined in `model.controller.ts` (installed
      // by `applyModelListOverrideHost`) and is `require()`d at the
      // call site via the wrapper.
      helperMarkerNew: helperMarkerOld,
    },
    options,
  );
}
export async function applyAdminMount(
  filePath: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  // Mounts the plugin admin Express app on the backend's expressApp
  // instance. The patch adds a try { require('manifest-plugins') } +
  // expressApp.use(admin.createAdminServer()) call immediately before
  // `app.listen(port, host)`. After the patch, the dashboard's
  // `<script src="/admin/admin.js">` and the React UI's `fetch('/api/plugins')`
  // both resolve on the same port as the backend (2099) — no separate
  // sidecar, no reverse proxy. Idempotent via the `postPatchSymbol`.
  return applyPatch(
    {
      filePath,
      postPatchSymbol: 'expressApp.use(admin.createAdminServer())',
      oldText: ADMIN_MOUNT_OLD,
      newText: ADMIN_MOUNT_NEW,
    },
    options,
  );
}

// =============================================================================
// Manifest-checkout orchestrator
// =============================================================================

/**
 * Apply all three patches to a Manifest checkout. Returns the per-file
 * results. If any single file reports `upstream-drift`, the others still
 * run (so the user sees the full picture of what needs to be updated),
 * but no file is written if `dryRun` is true.
 */
export interface ManifestFileSpec {
  providerClient: string;
  proxyRateLimiter: string;
  /**
   * Path to the Manifest backend's `main.ts`. Used by `applyAllFive` to
   * install the admin Express mount. Optional for `applyAll` (the
   * 2-file patcher) which leaves it untouched.
   */
  main?: string;
  /**
   * Path to upstream's `model-fetcher.ts` (or whichever file serves
   * `GET /v1/models`). Used by `applyAllFive` to install the
   * model-list-override host. Optional for `applyAll` which leaves it
   * untouched.
   */
  modelFetcher?: string;
  /**
   * Path to upstream's `routing-core/tier.service.ts`. Used by
   * `applyAllEight` to install the routing-layer model-list-override
   * host (so the routing layer can resolve plugin-added model IDs).
   * Optional; when omitted, the routing-layer tier-service patch is
   * skipped.
   */
  tierService?: string;
  /**
   * Path to upstream's `routing-core/specificity.service.ts`. Used
   * by `applyAllEight` to install the routing-layer model-list-
   * override host. Optional.
   */
  specificityService?: string;
  /**
   * Path to upstream's `header-tiers/header-tier.service.ts`. Used
   * by `applyAllEight` to install the routing-layer model-list-
   * override host. Optional.
   */
  headerTierService?: string;
}

export const DEFAULT_MANIFEST_FILES: ManifestFileSpec = {
  providerClient: 'packages/backend/src/routing/proxy/provider-client.ts',
  proxyRateLimiter: 'packages/backend/src/routing/proxy/proxy-rate-limiter.ts',
  main: 'packages/backend/src/main.ts',
  modelFetcher: 'packages/backend/src/routing/model.controller.ts',
  tierService: 'packages/backend/src/routing/routing-core/tier.service.ts',
  specificityService: 'packages/backend/src/routing/routing-core/specificity.service.ts',
  headerTierService: 'packages/backend/src/routing/header-tiers/header-tier.service.ts',
};

export interface ApplyAllResult {
  providerClient: ApplyResult;
  proxyRateLimiter: ApplyResult;
  /** True if all three patches are applied (or were already no-op). */
  fullyApplied: boolean;
  /** True if at least one file reported upstream drift. */
  hasDrift: boolean;
}

export async function applyAll(
  manifestRoot: string,
  files: ManifestFileSpec = DEFAULT_MANIFEST_FILES,
  options: ApplyOptions = {},
): Promise<ApplyAllResult> {
  const resolve = (rel: string) => `${manifestRoot.replace(/\/$/, '')}/${rel}`;
  const [providerClient, proxyRateLimiter] = await Promise.all([
    applyProviderClientHost(resolve(files.providerClient), options),
    applyProxyRateLimiterHost(resolve(files.proxyRateLimiter), options),
  ]);
  return {
    providerClient,
    proxyRateLimiter,
    fullyApplied:
      providerClient.status !== 'upstream-drift' &&
      proxyRateLimiter.status !== 'upstream-drift',
    hasDrift:
      providerClient.status === 'upstream-drift' ||
      proxyRateLimiter.status === 'upstream-drift',
  };
}

/**
 * Result of the five-file patch surface (legacy three + the admin-mount
 * on `main.ts` + the model-list-override on the model-fetcher file).
 * See {@link applyAllFive}.
 *
 * Wave-history note: prior to the `chore/retire-obsolete-plugins`
 * refactor (2026-07-10), this surface also included a routing-override
 * patch on `proxy.service.ts` that worked around upstream PR #2350's
 * explicit-model early-return regression. That patch is now retired —
 * upstream PR #2468 restored the same behavior directly, so the
 * fork-side hook has nothing to override.
 */
export interface ApplyAllFiveResult extends ApplyAllResult {
  /**
   * Result of the admin Express mount patch on `main.ts`. Mounts the
   * plugin admin routes (`/api/plugins/*` + `/admin/admin.js`) on the
   * same Express instance as the dashboard, so the React UI is
   * reachable on the backend's port (2099) without a separate sidecar.
   */
  adminMount: ApplyResult;
  /**
   * Result of the model-list-override host patch on the
   * `model.controller.ts` (or whichever file serves `GET /v1/models`).
   * Drift on this field does not block the other patches from
   * reporting `applied` / `noop`.
   */
  modelListOverride: ApplyResult;
}

/**
 * Run all five host patches against a Manifest checkout. Patches the
 * request-transform host on `provider-client.ts`, the rate-limit host on
 * `proxy-rate-limiter.ts`, the admin Express mount on `main.ts`, and
 * the model-list-override host on `model.controller.ts`.
 *
 * Sequencing: provider-client + rate-limiter + admin-mount run in
 * parallel in Phase 1 (each writes a different file). The
 * model-list-override patch runs alone in Phase 2 because it targets
 * a different file but follows the same upstream-drift detection
 * pattern (read-anchor → write-replacement). The aggregate
 * `fullyApplied` / `hasDrift` include all five results.
 *
 * Both the admin-mount and the model-list-override patches are
 * optional: when the corresponding `files.<key> === undefined`, the
 * orchestrator returns a synthetic `noop` for that patch.
 *
 * Wave-history note: prior to 2026-07-10 this surface was 5 files
 * because the routing-override host also patched `proxy.service.ts`.
 * Upstream PR #2468 subsumed that behavior, so the file count dropped
 * to 4 — but the orchestrator name `applyAllFive` is kept for API
 * stability.
 *
 * The model-list-override patch is optional: when
 * `files.modelFetcher === undefined`, the orchestrator returns the
 * four-file result unchanged with a synthetic `modelListOverride`
 * field set to `{ status: 'noop', file: '<not requested>' }`.
 */
/**
 * Result of the eight-file patch surface (the five-file set +
 * routing-layer model-list-override). See {@link applyAllEight}.
 */
export interface ApplyAllEightResult extends ApplyAllFiveResult {
  /** Result of the routing-layer model-list-override patch on `tier.service.ts`. */
  tierServiceRoutingModelList: ApplyResult;
  /** Result of the routing-layer model-list-override patch on `specificity.service.ts`. */
  specificityServiceRoutingModelList: ApplyResult;
  /** Result of the routing-layer model-list-override patch on `header-tier.service.ts`. */
  headerTierServiceRoutingModelList: ApplyResult;
}

export async function applyAllFive(
  manifestRoot: string,
  files: ManifestFileSpec = DEFAULT_MANIFEST_FILES,
  options: ApplyOptions = {},
): Promise<ApplyAllFiveResult> {
  const resolve = (rel: string) => `${manifestRoot.replace(/\/$/, '')}/${rel}`;
  if (files.main === undefined) {
    throw new Error(
      'applyAllFive: files.main is required (path to packages/backend/src/main.ts for the admin mount patch)',
    );
  }
  const mainPath = resolve(files.main);
  // Phase 1: provider-client + rate-limiter + admin-mount run in parallel
  //          (each writes a different file).
  // Phase 2: model-list-override runs alone because it follows the same
  //          upstream-drift detection pattern (read-anchor → write-replacement)
  //          and serializing is the simplest correct approach.
  const [providerClient, proxyRateLimiter, adminMount] = await Promise.all([
    applyProviderClientHost(resolve(files.providerClient), options),
    applyProxyRateLimiterHost(resolve(files.proxyRateLimiter), options),
    applyAdminMount(mainPath, options),
  ]);
  const baseApplied =
    providerClient.status !== 'upstream-drift' &&
    proxyRateLimiter.status !== 'upstream-drift' &&
    adminMount.status !== 'upstream-drift';
  const baseDrift =
    providerClient.status === 'upstream-drift' ||
    proxyRateLimiter.status === 'upstream-drift' ||
    adminMount.status === 'upstream-drift';

  if (files.modelFetcher === undefined) {
    return {
      providerClient,
      proxyRateLimiter,
      adminMount,
      modelListOverride: { status: 'noop', file: '<modelFetcher not requested>' },
      fullyApplied: baseApplied,
      hasDrift: baseDrift,
    };
  }
  const modelListOverride = await applyModelListOverrideHost(
    resolve(files.modelFetcher),
    options,
  );
  return {
    providerClient,
    proxyRateLimiter,
    adminMount,
    modelListOverride,
    fullyApplied: baseApplied && modelListOverride.status !== 'upstream-drift',
    hasDrift: baseDrift || modelListOverride.status === 'upstream-drift',
  };
}

/**
 * Run all eight host patches against a Manifest checkout. Like
 * {@link applyAllFive} but additionally installs the routing-layer
 * model-list-override call sites on `tier.service.ts`,
 * `specificity.service.ts`, and `header-tier.service.ts` so the
 * routing layer can resolve plugin-added model IDs (closes the
 * "Cannot resolve fallback model" gap).
 *
 * Sequencing: the five-file set runs in {@link applyAllFive}'s
 * plan. The three routing-layer patches run in parallel in their
 * own phase (different files, no shared state).
 *
 * Each routing-layer patch is optional: when the corresponding
 * `files.<service> === undefined`, the orchestrator returns a
 * synthetic `noop` for that service.
 *
 * Drift on any routing-layer patch does NOT block the five-file
 * set — the `applyAllFive` result is reported as-is. The
 * `applyAllEight`-level aggregates include all eight results.
 */
export async function applyAllEight(
  manifestRoot: string,
  files: ManifestFileSpec = DEFAULT_MANIFEST_FILES,
  options: ApplyOptions = {},
): Promise<ApplyAllEightResult> {
  const fiveFileResult = await applyAllFive(manifestRoot, files, options);
  const resolve = (rel: string) => `${manifestRoot.replace(/\/$/, '')}/${rel}`;

  const routingPatches: Array<Promise<{ key: 'tierServiceRoutingModelList' | 'specificityServiceRoutingModelList' | 'headerTierServiceRoutingModelList'; result: ApplyResult }>> = [];

  if (files.tierService !== undefined) {
    routingPatches.push(
      applyRoutingModelListOverrideHost(resolve(files.tierService), 'TierService', options).then(
        (result) => ({ key: 'tierServiceRoutingModelList' as const, result }),
      ),
    );
  }
  if (files.specificityService !== undefined) {
    routingPatches.push(
      applyRoutingModelListOverrideHost(
        resolve(files.specificityService),
        'SpecificityService',
        options,
      ).then((result) => ({ key: 'specificityServiceRoutingModelList' as const, result })),
    );
  }
  if (files.headerTierService !== undefined) {
    routingPatches.push(
      applyRoutingModelListOverrideHost(
        resolve(files.headerTierService),
        'HeaderTierService',
        options,
      ).then((result) => ({ key: 'headerTierServiceRoutingModelList' as const, result })),
    );
  }

  const resolved = await Promise.all(routingPatches);
  const tierServiceRoutingModelList: ApplyResult =
    resolved.find((r) => r.key === 'tierServiceRoutingModelList')?.result ?? {
      status: 'noop',
      file: '<tierService not requested>',
    };
  const specificityServiceRoutingModelList: ApplyResult =
    resolved.find((r) => r.key === 'specificityServiceRoutingModelList')?.result ?? {
      status: 'noop',
      file: '<specificityService not requested>',
    };
  const headerTierServiceRoutingModelList: ApplyResult =
    resolved.find((r) => r.key === 'headerTierServiceRoutingModelList')?.result ?? {
      status: 'noop',
      file: '<headerTierService not requested>',
    };

  const allDrift = [
    tierServiceRoutingModelList,
    specificityServiceRoutingModelList,
    headerTierServiceRoutingModelList,
  ];
  const hasDrift = fiveFileResult.hasDrift || allDrift.some((r) => r.status === 'upstream-drift');
  const fullyApplied = fiveFileResult.fullyApplied && allDrift.every((r) => r.status !== 'upstream-drift');

  return {
    ...fiveFileResult,
    tierServiceRoutingModelList,
    specificityServiceRoutingModelList,
    headerTierServiceRoutingModelList,
    fullyApplied,
    hasDrift,
  };
}