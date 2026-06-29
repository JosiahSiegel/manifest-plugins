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
 *   3. `packages/backend/src/routing/proxy/proxy.service.ts` — replaces
 *      the constructor's `this.maxMessagesPerRequest = parseMaxMessagesPerRequest(...)`
 *      with a call to `getResolvedMaxMessagesPerRequest(this.config)`. Lets
 *      the RequestPolicyPlugin chain override the per-request message-array cap.
 *
 * Each patch is byte-exact against upstream/main and idempotent (running
 * twice is a no-op). If upstream restructures, the patcher fails loudly
 * with the exact anchor that moved.
 *
 * The host query functions (`applyRequestTransformPlugins`,
 * `getResolvedConcurrencyMax`, `getResolvedMaxMessagesPerRequest`) are
 * file-private — they're added immediately above the relevant class
 * declaration by the apply tool.
 */
import { promises as fs } from 'fs';
import {
  HELPER_MARKER_OLD,
  HOST_HELPER_SOURCE,
  PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_NEW,
  PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_OLD,
  PROXY_ROUTING_OVERRIDE_HOST_SOURCE,
  PROXY_ROUTING_OVERRIDE_IMPORT_NEW,
  PROXY_ROUTING_OVERRIDE_IMPORT_OLD,
  PROXY_ROUTING_OVERRIDE_NEW,
  PROXY_ROUTING_OVERRIDE_OLD,
  PROXY_SERVICE_HOST_SOURCE,
  PROXY_SERVICE_NEW,
  PROXY_SERVICE_OLD,
  RETURN_NEW,
  RETURN_OLD,
  RATE_LIMITER_NEW,
  RATE_LIMITER_OLD,
  buildHelperMarkerNew,
} from './snippet';
import {
  assertAnchors,
  type AnchorMarker,
} from '../apply/anchor-drift';

const HOUSEKEEPING_RATE_LIMITER_OLD = `const DEFAULT_CONCURRENCY_MAX = 10;
const CONCURRENCY_MAX = positiveIntegerEnv('CONCURRENCY_MAX', DEFAULT_CONCURRENCY_MAX);
`;

const HOUSEKEEPING_PROXY_SERVICE_OLD = `    // Fork: disable message cap by default. Set MAX_MESSAGES_PER_REQUEST or
    // MANIFEST_MAX_MESSAGES to a positive integer to re-enable.
    const maxMessagesRaw =
      process.env['MAX_MESSAGES_PER_REQUEST'] ??
      this.config.get<string>('MANIFEST_MAX_MESSAGES');
    this.maxMessagesPerRequest =
      maxMessagesRaw === undefined || maxMessagesRaw === '' || maxMessagesRaw === '0'
        ? Infinity
        : parseMaxMessagesPerRequest(maxMessagesRaw);
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
 * Patch `proxy.service.ts` to install the message-cap host. Two
 * operations: insert `getResolvedMaxMessagesPerRequest` helper before
 * the class, then replace the constructor's
 * `this.maxMessagesPerRequest = parseMaxMessagesPerRequest(...)` block
 * with a call to the helper.
 */
export async function applyProxyServiceHost(
  filePath: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  // The helper marker here is the end of the `ProxyService` class's
  // import block, ending with the import of `parseMaxMessagesPerRequest`
  // and a blank line, before the class declaration. We use the line
  // right before `@Injectable()` to anchor.
  const helperMarkerOld = `import { parseMaxMessagesPerRequest } from './message-limit';
`;
  const helperMarkerNew = `${PROXY_SERVICE_HOST_SOURCE}import { parseMaxMessagesPerRequest } from './message-limit';
`;
  return applyPatch(
    {
      filePath,
      postPatchSymbol: 'function getResolvedMaxMessagesPerRequest(',
      oldText: PROXY_SERVICE_OLD,
      oldTextAlternatives: [HOUSEKEEPING_PROXY_SERVICE_OLD],
      newText: PROXY_SERVICE_NEW,
      helperMarkerOld,
      helperMarkerNew,
    },
    options,
  );
}

/**
 * Patch `proxy.service.ts` to install the routing-override host.
 *
 * Three operations, all in one pass:
 *   1. Insert the `HeaderTierService` import below the existing
 *      `ProviderParamSpecService` import line.
 *   2. Extend the constructor with a new `headerTierService` parameter
 *      after `providerParamSpecs`.
 *   3. Insert the `applyProxyRoutingOverridePlugins(...)` helper at the
 *      top of the class (above the existing message-cap helper), then
 *      splice the plugin call into `resolveRouting()` BEFORE the
 *      upstream `2ab748a6` explicit-model early-return.
 *
 * The function deliberately composes the three sub-edits as separate
 * `applyPatch` calls (rather than threading a multi-anchor PatchSpec)
 * so each sub-edit has its own post-patch sentinel, its own
 * idempotency check, and its own upstream-drift detection. If any
 * sub-edit fails, the caller can still see which one drifted.
 */
export async function applyProxyRoutingOverrideHost(
  filePath: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  // Run the three sub-edits serially. They all write to the same file,
  // so parallel execution races: each sub-edit reads the file at the
  // start of its `applyPatch` call, so they need to see the
  // post-previous-sub-edit state. Serializing is the simplest correct
  // approach; performance is irrelevant here (this runs once per
  // image build, not per request).
  //
  // The composite status is `applied` when all three succeed, `noop`
  // when all three are already present, and `upstream-drift` when any
  // one reports drift.
  const importResult = await applyPatch(
    {
      filePath,
      postPatchSymbol: PROXY_ROUTING_OVERRIDE_IMPORT_NEW,
      oldText: PROXY_ROUTING_OVERRIDE_IMPORT_OLD,
      newText: PROXY_ROUTING_OVERRIDE_IMPORT_NEW,
    },
    options,
  );
  if (importResult.status === 'upstream-drift') return importResult;

  const constructorResult = await applyPatch(
    {
      filePath,
      postPatchSymbol: PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_NEW,
      oldText: PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_OLD,
      newText: PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_NEW,
    },
    options,
  );
  if (constructorResult.status === 'upstream-drift') return constructorResult;

  const bodyResult = await applyPatch(
    {
      filePath,
      postPatchSymbol: 'function applyProxyRoutingOverridePlugins(',
      oldText: PROXY_ROUTING_OVERRIDE_OLD,
      newText: PROXY_ROUTING_OVERRIDE_NEW,
      helperMarkerOld:
        '    // Anthropic Messages requests require a provider-native model field; only',
      helperMarkerNew: `${PROXY_ROUTING_OVERRIDE_HOST_SOURCE}    // Anthropic Messages requests require a provider-native model field; only`,
    },
    options,
  );
  if (bodyResult.status === 'upstream-drift') return bodyResult;

  // Idempotency: if all three sub-edits already applied, the
  // composite is noop.
  if (
    importResult.status === 'noop' &&
    constructorResult.status === 'noop' &&
    bodyResult.status === 'noop'
  ) {
    return { status: 'noop', file: filePath };
  }

  return { status: 'applied', file: filePath };
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
  proxyService: string;
}

export const DEFAULT_MANIFEST_FILES: ManifestFileSpec = {
  providerClient: 'packages/backend/src/routing/proxy/provider-client.ts',
  proxyRateLimiter: 'packages/backend/src/routing/proxy/proxy-rate-limiter.ts',
  proxyService: 'packages/backend/src/routing/proxy/proxy.service.ts',
};

export interface ApplyAllResult {
  providerClient: ApplyResult;
  proxyRateLimiter: ApplyResult;
  proxyService: ApplyResult;
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
  const [providerClient, proxyRateLimiter, proxyService] = await Promise.all([
    applyProviderClientHost(resolve(files.providerClient), options),
    applyProxyRateLimiterHost(resolve(files.proxyRateLimiter), options),
    applyProxyServiceHost(resolve(files.proxyService), options),
  ]);
  return {
    providerClient,
    proxyRateLimiter,
    proxyService,
    fullyApplied:
      providerClient.status !== 'upstream-drift' &&
      proxyRateLimiter.status !== 'upstream-drift' &&
      proxyService.status !== 'upstream-drift',
    hasDrift:
      providerClient.status === 'upstream-drift' ||
      proxyRateLimiter.status === 'upstream-drift' ||
      proxyService.status === 'upstream-drift',
  };
}

/**
 * Result of the four-file patch surface (legacy three + the new
 * routing-override hook). See {@link applyAllFour}.
 */
export interface ApplyAllFourResult extends ApplyAllResult {
  /**
   * Result of the routing-override host patch on `proxy.service.ts`.
   * Independent of the message-cap patch — they look at different
   * anchors. Drift on this field does not block the other three
   * patches from reporting `applied` / `noop`.
   */
  proxyRoutingOverride: ApplyResult;
}

/**
 * Run all four host patches against a Manifest checkout. Like
 * {@link applyAll} but additionally installs the routing-override
 * hook on `proxy.service.ts`. Use this when the upstream checkout
 * is at or after commit `2ab748a6` (2026-06-29); pre-`2ab748a6`
 * upstream will report `upstream-drift` on `proxyRoutingOverride`
 * (correct: that hook only exists post-`2ab748a6`).
 *
 * Sequencing: the two `proxy.service.ts` patches (message-cap and
 * routing-override) are serialized — the message-cap patch runs
 * first so its helper insertion marker is present in the file
 * when the routing-override patch splices its own body anchor.
 * Running them in parallel would race on the shared file.
 *
 * The aggregate `fullyApplied` / `hasDrift` include the new field
 * — pre-`2ab748a6` upstreams will see `fullyApplied: false` even
 * when the legacy three patches all succeeded.
 */
export async function applyAllFour(
  manifestRoot: string,
  files: ManifestFileSpec = DEFAULT_MANIFEST_FILES,
  options: ApplyOptions = {},
): Promise<ApplyAllFourResult> {
  const resolve = (rel: string) => `${manifestRoot.replace(/\/$/, '')}/${rel}`;
  const proxyServicePath = resolve(files.proxyService);
  // Phase 1: provider-client + rate-limiter run in parallel.
  // Phase 2: message-cap runs alone so the file is settled.
  // Phase 3: routing-override runs alone so its anchor scan
  //          sees the post-message-cap file state.
  const [providerClient, proxyRateLimiter, proxyService] = await Promise.all([
    applyProviderClientHost(resolve(files.providerClient), options),
    applyProxyRateLimiterHost(resolve(files.proxyRateLimiter), options),
    applyProxyServiceHost(proxyServicePath, options),
  ]);
  const proxyRoutingOverride = await applyProxyRoutingOverrideHost(
    proxyServicePath,
    options,
  );
  return {
    providerClient,
    proxyRateLimiter,
    proxyService,
    proxyRoutingOverride,
    fullyApplied:
      providerClient.status !== 'upstream-drift' &&
      proxyRateLimiter.status !== 'upstream-drift' &&
      proxyService.status !== 'upstream-drift' &&
      proxyRoutingOverride.status !== 'upstream-drift',
    hasDrift:
      providerClient.status === 'upstream-drift' ||
      proxyRateLimiter.status === 'upstream-drift' ||
      proxyService.status === 'upstream-drift' ||
      proxyRoutingOverride.status === 'upstream-drift',
  };
}