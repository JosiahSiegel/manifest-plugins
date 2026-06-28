/**
 * The plugin-host patcher for mnfst/manifest's `provider-client.ts`.
 *
 * Apply flow:
 *   1. Read the file.
 *   2. Verify the upstream anchors are present. If not, fail loudly with the
 *      exact anchor that moved so the user can update the snippet.
 *   3. Insert `HOST_HELPER_SOURCE` before `@Injectable()` (idempotent: if
 *      `applyRequestTransformPlugins` is already defined, no-op).
 *   4. Replace the Anthropic branch's `return { ... }; }` with the wrapped
 *      version that calls the helper (idempotent: if `transformed` is
 *      already in the return block, no-op).
 *
 * All operations are byte-exact against upstream/main. The patcher never
 * deletes or replaces anything outside the two anchored regions.
 */
import { promises as fs } from 'fs';
import {
  HELPER_MARKER_OLD,
  HOST_HELPER_SOURCE,
  RETURN_NEW,
  RETURN_OLD,
  buildHelperMarkerNew,
} from './snippet';

export type ApplyResult =
  | { status: 'applied'; helperInserted: boolean; returnReplaced: boolean }
  | { status: 'noop'; helperInserted: boolean; returnReplaced: boolean }
  | { status: 'upstream-drift'; reason: string };

const HOST_HELPER_SYMBOL = 'function applyRequestTransformPlugins(';
const RETURN_TRANSFORMED_SYMBOL = 'const transformed = applyRequestTransformPlugins(';

export interface ApplyOptions {
  /** Dry-run: report what would change without writing. Default: false. */
  dryRun?: boolean;
}

/**
 * Apply the plugin-host patch to a Manifest `provider-client.ts`.
 *
 * @param filePath Absolute or relative path to the source file.
 * @param options  Optional behaviour overrides.
 */
export async function applyProviderClientHost(
  filePath: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const original = await fs.readFile(filePath, 'utf-8');

  // --- State detection ---
  const hasUpstreamAnchors =
    original.includes(HELPER_MARKER_OLD) && original.includes(RETURN_OLD);
  const alreadyPatched =
    original.includes(HOST_HELPER_SYMBOL) &&
    original.includes(RETURN_TRANSFORMED_SYMBOL);

  if (!hasUpstreamAnchors && !alreadyPatched) {
    const missing: string[] = [];
    if (!original.includes(HELPER_MARKER_OLD)) {
      missing.push('helper insertion marker (HELPER_MARKER_OLD)');
    }
    if (!original.includes(RETURN_OLD)) {
      missing.push('return block (RETURN_OLD)');
    }
    return {
      status: 'upstream-drift',
      reason:
        `upstream/main restructured provider-client.ts — missing anchors: ` +
        missing.join(', ') +
        '. Update src/host/snippet.ts to match new upstream shape.',
    };
  }

  // --- Already patched — no-op ---
  if (alreadyPatched) {
    return { status: 'noop', helperInserted: false, returnReplaced: false };
  }

  // --- First apply ---
  let next = original;
  next = next.replace(HELPER_MARKER_OLD, buildHelperMarkerNew());
  next = next.replace(RETURN_OLD, RETURN_NEW);

  if (!options.dryRun) {
    await fs.writeFile(filePath, next, 'utf-8');
  }
  return { status: 'applied', helperInserted: true, returnReplaced: true };
}