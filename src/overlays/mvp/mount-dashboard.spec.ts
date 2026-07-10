import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mountDashboardPluginManager } from './mount-dashboard';

interface TempDir {
  readonly path: string;
  readonly cleanup: () => void;
}

const mountMarker = 'id="plugin-manager-root"';
const scriptTag = '<script src="/admin/admin.js" defer></script>';

function tempDir(prefix: string): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

function writeDashboardIndex(manifestRoot: string, content: string): string {
  const frontendDir = join(manifestRoot, 'packages', 'frontend');
  mkdirSync(frontendDir, { recursive: true });
  const indexPath = join(frontendDir, 'index.html');
  writeFileSync(indexPath, content, 'utf-8');
  return indexPath;
}

function tempMountRoots(): readonly string[] {
  return readdirSync(tmpdir())
    .filter((entry) => entry.startsWith('mwp-mount-'))
    .sort();
}

/**
 * Returns any leftover `.mwp-mount-*` temp directories inside the
 * given target directory. After the atomic rename, there should be
 * zero of them — the finally-block rmSync must have cleaned up.
 *
 * The mount function switched from `os.tmpdir()` to the target
 * directory for the temp file (to avoid EXDEV on Windows when
 * `os.tmpdir()` is on a different drive than the manifest checkout).
 */
function targetMountTemps(targetDir: string): readonly string[] {
  return readdirSync(targetDir)
    .filter((entry) => entry.startsWith('.mwp-mount-'))
    .sort();
}

describe('mountDashboardPluginManager', () => {
  it('injects the plugin manager div and script into packages/frontend/index.html that ends with </body>', async () => {
    const tmp = tempDir('manifest-plugins-mount-dashboard-inject-');
    try {
      const indexPath = writeDashboardIndex(
        tmp.path,
        '<html><body><main>Dashboard</main></body></html>',
      );

      await mountDashboardPluginManager(tmp.path);

      const next = readFileSync(indexPath, 'utf-8');
      expect(next).toContain('<div id="plugin-manager-root"></div>');
      expect(next).toContain(scriptTag);
    } finally {
      tmp.cleanup();
    }
  });

  it('inserts the plugin manager mount before </body>', async () => {
    const tmp = tempDir('manifest-plugins-mount-dashboard-before-body-');
    try {
      const indexPath = writeDashboardIndex(
        tmp.path,
        '<html><body><main>Dashboard</main></body></html>',
      );

      await mountDashboardPluginManager(tmp.path);

      const next = readFileSync(indexPath, 'utf-8');
      const markerIndex = next.indexOf(mountMarker);
      const bodyIndex = next.indexOf('</body>');
      expect(markerIndex).toBeGreaterThanOrEqual(0);
      expect(bodyIndex).toBeGreaterThanOrEqual(0);
      expect(markerIndex).toBeLessThan(bodyIndex);
    } finally {
      tmp.cleanup();
    }
  });

  it('appends the plugin manager mount to the end when </body> is missing', async () => {
    const tmp = tempDir('manifest-plugins-mount-dashboard-append-');
    try {
      const original = '<html><main>Dashboard</main></html>';
      const indexPath = writeDashboardIndex(tmp.path, original);

      await mountDashboardPluginManager(tmp.path);

      const next = readFileSync(indexPath, 'utf-8');
      expect(next.startsWith(original)).toBe(true);
      expect(next.endsWith(`\n${scriptTag}\n`)).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });

  it('leaves an already-mounted dashboard byte-equal when re-run', async () => {
    const tmp = tempDir('manifest-plugins-mount-dashboard-idempotent-');
    try {
      const indexPath = writeDashboardIndex(
        tmp.path,
        '<html><body><div id="plugin-manager-root"></div></body></html>',
      );
      const before = readFileSync(indexPath, 'utf-8');

      await mountDashboardPluginManager(tmp.path);

      expect(readFileSync(indexPath, 'utf-8')).toBe(before);
    } finally {
      tmp.cleanup();
    }
  });

  it('silently no-ops when packages/frontend/index.html is missing', async () => {
    const tmp = tempDir('manifest-plugins-mount-dashboard-missing-');
    try {
      await expect(mountDashboardPluginManager(tmp.path)).resolves.toBeUndefined();
      expect(existsSync(join(tmp.path, 'apps'))).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });

  it('removes the atomic-write temp directory after rename', async () => {
    const tmp = tempDir('manifest-plugins-mount-dashboard-atomic-');
    try {
      const indexPath = writeDashboardIndex(tmp.path, '<html><body><main>Dashboard</main></body></html>');
      const targetDir = join(tmp.path, 'packages', 'frontend');

      await mountDashboardPluginManager(tmp.path);

      // The temp dir now lives in the target directory (not os.tmpdir())
      // to avoid EXDEV on Windows when the manifest checkout is on a
      // different drive than the OS temp dir. The finally-block rmSync
      // must still clean it up.
      expect(targetMountTemps(targetDir)).toEqual([]);
      // And os.tmpdir() must not have any mwp-mount-* leftovers either.
      expect(tempMountRoots()).toEqual([]);
    } finally {
      tmp.cleanup();
    }
  });

  it('writes a mount block containing both the root marker and deferred admin script', async () => {
    const tmp = tempDir('manifest-plugins-mount-dashboard-block-');
    try {
      const indexPath = writeDashboardIndex(
        tmp.path,
        '<html><body><main>Dashboard</main></body></html>',
      );

      await mountDashboardPluginManager(tmp.path);

      const next = readFileSync(indexPath, 'utf-8');
      expect(next).toContain(mountMarker);
      expect(next).toContain(scriptTag);
    } finally {
      tmp.cleanup();
    }
  });
});
