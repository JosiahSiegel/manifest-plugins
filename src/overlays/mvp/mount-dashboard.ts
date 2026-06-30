/**
 * Dashboard plugin-manager mount applicator.
 *
 * The 5th MVP overlay injects the mount point + script tag for the
 * plugin admin UI island into the upstream Manifest dashboard's
 * `packages/frontend/index.html`. The script is loaded with `defer` so the
 * dashboard's own bundle initializes first; the plugin manager
 * mounts on `<div id="plugin-manager-root">` after DOMContentLoaded.
 *
 * Idempotency:
 *   - If `packages/frontend/index.html` already contains `id="plugin-manager-root"`,
 *     the file is left untouched (no byte changes).
 *   - If the file does not exist, the applicator is a silent no-op
 *     (returns successfully without writing). This keeps the overlay
 *     safe to run against any Manifest checkout, including forks where
 *     the dashboard is at a different path.
 *
 * Atomicity:
 *   - The file is written via write-temp-then-rename so a process crash
 *     mid-write cannot leave a half-written index.html.
 *
 * Injection strategy:
 *   - The mount + script block is inserted immediately before `</body>`.
 *     If `</body>` is missing, it is appended to the end of the file.
 *     The format is intentional: a stable, easy-to-grep pattern that
 *     shows up in the file as a self-contained block.
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

const MOUNT_MARKER = 'id="plugin-manager-root"';
const SCRIPT_TAG = '<script src="/admin/admin.js" defer></script>';

function buildMountBlock(): string {
  return [
    '',
    '<!-- manifest-plugins: plugin manager UI mount -->',
    '<div id="plugin-manager-root"></div>',
    SCRIPT_TAG,
    '',
  ].join('\n');
}

/**
 * Apply the dashboard mount to the Manifest checkout.
 *
 * Reads `manifestRoot/packages/frontend/index.html`; if the file already
 * contains the mount marker, the function returns without changes.
 * Otherwise, the mount block is inserted before `</body>` (or
 * appended to the end if `</body>` is missing) and the file is
 * written atomically.
 *
 * If the file does not exist, the function is a no-op (silent skip).
 */
export async function mountDashboardPluginManager(
  manifestRoot: string,
): Promise<void> {
  const targetPath = join(manifestRoot, 'packages', 'frontend', 'index.html');
  if (!existsSync(targetPath)) {
    // Silent skip — the dashboard may not exist in this Manifest
    // checkout. The orchestrator's `missing` list will not include
    // this overlay in that case.
    return;
  }
  const current = readFileSync(targetPath, 'utf-8');
  if (current.includes(MOUNT_MARKER)) {
    return;
  }
  const mountBlock = buildMountBlock();
  const next = current.includes('</body>')
    ? current.replace('</body>', `${mountBlock}</body>`)
    : current + mountBlock;
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'mwp-mount-'));
  const tmpFile = join(tmpRoot, 'index.html');
  try {
    writeFileSync(tmpFile, next, 'utf-8');
    renameSync(tmpFile, targetPath);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
