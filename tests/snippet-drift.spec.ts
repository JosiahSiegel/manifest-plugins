import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  applyProxyRateLimiterHost,
  applyProxyServiceHost,
  type ApplyResult,
} from '../src/host/apply';

const MANIFEST_REPO = process.env['MANIFEST_REPO'] ?? '../manifest';

interface CurrentManifestFiles {
  readonly root: string;
  readonly proxyRateLimiter: string;
  readonly proxyService: string;
  readonly cleanup: () => void;
}

function copyCurrentManifestFiles(): CurrentManifestFiles {
  const root = mkdtempSync(join(tmpdir(), 'manifest-plugins-snippet-drift-'));
  const files = {
    proxyRateLimiter: 'packages/backend/src/routing/proxy/proxy-rate-limiter.ts',
    proxyService: 'packages/backend/src/routing/proxy/proxy.service.ts',
  } as const;

  for (const relativePath of Object.values(files)) {
    const sourcePath = join(MANIFEST_REPO, relativePath);
    const targetPath = join(root, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, readFileSync(sourcePath), 'utf-8');
  }

  return {
    root,
    proxyRateLimiter: join(root, files.proxyRateLimiter),
    proxyService: join(root, files.proxyService),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

interface DriftReport {
  readonly label: string;
  readonly reason: string;
}

function driftReport(label: string, result: ApplyResult): DriftReport | null {
  if (result.status !== 'upstream-drift') return null;
  return { label, reason: result.reason ?? 'no reason provided' };
}

describe('host snippet anchors against current Manifest checkout', () => {
  it('matches current proxy-rate-limiter and proxy.service shapes', async () => {
    const files = copyCurrentManifestFiles();
    try {
      const rateLimiter = await applyProxyRateLimiterHost(files.proxyRateLimiter, {
        dryRun: true,
      });
      const proxyService = await applyProxyServiceHost(files.proxyService, {
        dryRun: true,
      });
      const reports = [
        driftReport('proxy-rate-limiter.ts', rateLimiter),
        driftReport('proxy.service.ts', proxyService),
      ].filter((report): report is DriftReport => report !== null);

      if (reports.length > 0) {
        const summary = reports
          .map((report) => `${report.label}: ${report.reason}`)
          .join('\n');
        throw new Error(`host snippet anchors drifted:\n${summary}`);
      }
      expect(rateLimiter.status).toBe('applied');
      expect(proxyService.status).toBe('applied');
    } finally {
      files.cleanup();
    }
  });
});
