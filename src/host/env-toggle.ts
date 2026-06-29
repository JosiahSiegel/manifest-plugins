/**
 * `MANIFEST_PLUGINS_DISABLED` env-var-driven plugin toggle.
 *
 * Operators can disable a plugin at process start without rebuilding
 * the image by setting the env var:
 *
 *   MANIFEST_PLUGINS_DISABLED=header-tier-router,experimental-foo
 *
 * The pasted host snippets call `applyDisabledListFromEnv(...)` once
 * at module load, after `require('manifest-plugins')` resolves. The
 * function parses the comma-separated list, invokes
 * `setPluginEnabled(id, false)` for each id (in declaration order),
 * and returns the parsed list so the caller can log/audit.
 *
 * Why this lives in the host package and not in the host snippets:
 *   - The pasted snippet must be byte-exact and self-contained; it
 *     only reaches the plugins package via `require('manifest-plugins')`.
 *   - The env-parse + setPluginEnabled logic is unit-tested here.
 *   - The pasted snippet just calls `applyDisabledListFromEnv(process.env['MANIFEST_PLUGINS_DISABLED'])`.
 */
import { setPluginEnabled } from '../index';

export interface EnvToggleOptions {
  /**
   * Set of plugin ids that the caller considers valid. When provided,
   * ids NOT in this set are reported via `onUnknown` instead of
   * being silently applied. The apply step still calls
   * `setPluginEnabled(id, false)` for them — the host treats unknown
   * ids as a misconfiguration, not as an error.
   */
  readonly knownIds?: ReadonlySet<string>;
  /** Called for each id that is disabled by the parsed env value. */
  readonly onApplied?: (id: string) => void;
  /** Called for each id that is not in `knownIds` (only fires if `knownIds` was supplied). */
  readonly onUnknown?: (id: string) => void;
}

/**
 * Parse a comma-separated env value into a deduplicated list of ids,
 * preserving first-appearance order. Returns an empty array for
 * undefined or empty input.
 */
export function parseDisabledList(
  envValue: string | undefined,
): readonly string[] {
  if (envValue === undefined) return [];
  const trimmed = envValue.trim();
  if (trimmed.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of trimmed.split(',')) {
    const id = raw.trim();
    if (id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Apply the parsed list of ids as runtime-disabled plugins.
 * Returns the list of ids that were disabled, in declaration order.
 */
export function applyDisabledListFromEnv(
  envValue: string | undefined,
  options: EnvToggleOptions = {},
): readonly string[] {
  const ids = parseDisabledList(envValue);
  for (const id of ids) {
    setPluginEnabled(id, false);
    if (options.onApplied !== undefined) {
      options.onApplied(id);
    }
    if (
      options.knownIds !== undefined &&
      !options.knownIds.has(id) &&
      options.onUnknown !== undefined
    ) {
      options.onUnknown(id);
    }
  }
  return ids;
}