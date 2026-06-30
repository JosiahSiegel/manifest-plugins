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
      writeDashboardIndex(tmp.path, '<html><body><main>Dashboard</main></body></html>');
      const before = tempMountRoots();

      await mountDashboardPluginManager(tmp.path);

      expect(tempMountRoots()).toEqual(before);
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
