/**
 * Dashboard-transform mount applicator.
 *
 * The 6th MVP overlay injects a single `<script src="/admin/dashboard-transform/all.js" defer>`
 * tag into the upstream Manifest dashboard's `packages/frontend/index.html`.
 * The script bundle is built at request time by the admin server
 * (see `src/admin/server.ts::buildDashboardTransformBundle`) and contains
 * the concatenated output of every enabled `dashboard-transform` plugin's
 * `getDashboardScript()`. The bundle is loaded with `defer` so the
 * dashboard's own bundle initializes first; each plugin's script then
 * runs on `DOMContentLoaded` (see the bundle's bootstrap function).
 *
 * Idempotency:
 *   - If `packages/frontend/index.html` already contains the
 *     `data-mwp-dashboard-transform` marker, the file is left
 *     untouched (no byte changes).
 *   - If the file does not exist, the applicator is a silent no-op
 *     (returns successfully without writing). This keeps the overlay
 *     safe to run against any Manifest checkout.
 *
 * Atomicity:
 *   - The file is written via write-temp-then-rename so a process
 *     crash mid-write cannot leave a half-written index.html.
 *
 * Injection strategy:
 *   - The script tag is inserted immediately before `</body>`,
 *     after the existing `<script src="/admin/admin.js" defer></script>`
 *     injected by the dashboard-plugin-manager-mount overlay. If
 *     `</body>` is missing, the script tag is appended to the end of
 *     the file.
 *
 * Why a single combined bundle rather than one <script> tag per
 * plugin:
 *   - Reduces the HTTP round-trip count from N to 1.
 *   - Guarantees a deterministic load order (the admin server sorts
 *     plugins by directory name in `src/registry/discover.ts`).
 *   - Lets the admin server add a runtime bootstrap that handles
 *     DOMContentLoaded vs. already-loaded and per-plugin error
 *     isolation. Per-plugin <script> tags would each have to
 *     repeat that logic.
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

const MOUNT_MARKER = 'data-mwp-dashboard-transform';
const SCRIPT_TAG =
  '<script src="/admin/dashboard-transform/all.js" defer data-mwp-dashboard-transform></script>';

function buildMountBlock(): string {
  return [
    '',
    '<!-- manifest-plugins: dashboard-transform bundle mount -->',
    SCRIPT_TAG,
    '',
  ].join('\n');
}

/**
 * Apply the dashboard-transform mount to the Manifest checkout.
 *
 * Reads `manifestRoot/packages/frontend/index.html`; if the file
 * already contains the mount marker, the function returns without
 * changes. Otherwise, the mount block is inserted before `</body>`
 * (or appended to the end if `</body>` is missing) and the file is
 * written atomically.
 *
 * If the file does not exist, the function is a no-op (silent skip).
 */
export async function mountDashboardTransform(manifestRoot: string): Promise<void> {
  const targetPath = join(manifestRoot, 'packages', 'frontend', 'index.html');
  if (!existsSync(targetPath)) {
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
  const tmpRoot = mkdtempSync(join(tmpdir(), 'mwp-dt-mount-'));
  const tmpFile = join(tmpRoot, 'index.html');
  try {
    writeFileSync(tmpFile, next, 'utf-8');
    renameSync(tmpFile, targetPath);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
