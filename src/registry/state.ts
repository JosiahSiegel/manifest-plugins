/**
 * Persisted plugin enable/disable state.
 *
 * Operators toggle plugins at runtime via:
 *   - the admin HTTP API (src/admin/server.ts), or
 *   - the `npm run plugins:*` CLI (scripts/plugins-cli.mjs), or
 *   - the React dashboard island (src/admin/ui/index.tsx)
 *
 * All three write to the SAME state file. The format is intentionally
 * minimal — a flat map of plugin-id → enabled boolean:
 *
 *   { "default-policy": true, "header-tier-router": false }
 *
 * Atomicity: writes go through `write-temp-then-rename` so a process
 * crash mid-write cannot leave a half-written file. The rename is
 * atomic on POSIX filesystems and "atomic enough" on Windows (the
 * destination is replaced as a single operation).
 *
 * Path: taken from the `MANIFEST_PLUGINS_STATE_FILE` env var, with a
 * sensible default. The function takes the path as an argument so
 * tests can pass temp paths without touching the global env.
 *
 * Failure semantics:
 *   - `loadPluginState` returns `{}` when the file is missing OR
 *     malformed (logs a one-line warning). Operators can re-toggle to
 *     rebuild the file. A missing file is NOT an error.
 *   - `savePluginState` throws on write failure (ENOSPC, EROFS, etc.).
 *     The caller (admin server / CLI) catches and returns a 500 / exit 1.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

export interface PluginStateFile {
  readonly [pluginId: string]: boolean;
}

export function loadPluginState(filePath: string): PluginStateFile {
  if (!existsSync(filePath)) return {};
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[manifest-plugins] could not read state file ${filePath}: ${(err as Error).message}`,
    );
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[manifest-plugins] state file ${filePath} is not valid JSON: ${(err as Error).message}`,
    );
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[manifest-plugins] state file ${filePath} must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
    );
    return {};
  }
  const out: { [pluginId: string]: boolean } = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'boolean') continue;
    out[key] = value;
  }
  return out;
}

export function savePluginState(filePath: string, state: PluginStateFile): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  // write-temp-then-rename for atomicity. mkdtempSync creates a unique
  // dir under the OS tmpdir; we write into a stable name inside it
  // so multiple concurrent writers don't collide. The temp dir is
  // best-effort cleaned up after the rename.
  const tmpRoot = mkdtempSync(join(tmpdir(), 'mwp-state-'));
  const tmpFile = join(tmpRoot, 'state.json');
  try {
    writeFileSync(tmpFile, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    renameSync(tmpFile, filePath);
  } finally {
    // best-effort cleanup of the temp dir; ignore failures
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}