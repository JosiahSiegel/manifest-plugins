import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  applyProxyRateLimiterHost,
  type ApplyResult,
} from '../src/host/apply';

const MANIFEST_REPO = process.env['MANIFEST_REPO'] ?? '../manifest';

interface CurrentManifestFiles {
  readonly root: string;
  readonly proxyRateLimiter: string;
  readonly cleanup: () => void;
}

function copyCurrentManifestFiles(): CurrentManifestFiles {
  const root = mkdtempSync(join(tmpdir(), 'manifest-plugins-snippet-drift-'));
  const files = {
    proxyRateLimiter: 'packages/backend/src/routing/proxy/proxy-rate-limiter.ts',
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
  it('matches current proxy-rate-limiter shape', async () => {
    // Wave-history note: this test previously also exercised a
    // proxy.service.ts message-cap drift check, but the message-cap
    // patcher was retired when upstream commit `c9009bcd5` removed
    // the `maxMessagesPerRequest` feature from `proxy.service.ts`.
    // The remaining drift surface on `proxy.service.ts` is the
    // routing-override constructor anchor (`PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_OLD`),
    // which `tests/apply.spec.ts::reports upstream-drift when the
    // providerParamSpecs constructor anchor is missing` exercises
    // synthetically (no live-upstream copy needed because the
    // anchor is a literal string in the snippet module).
    const files = copyCurrentManifestFiles();
    try {
      const rateLimiter = await applyProxyRateLimiterHost(files.proxyRateLimiter, {
        dryRun: true,
      });
      const reports = [
        driftReport('proxy-rate-limiter.ts', rateLimiter),
      ].filter((report): report is DriftReport => report !== null);

      if (reports.length > 0) {
        const summary = reports
          .map((report) => `${report.label}: ${report.reason}`)
          .join('\n');
        throw new Error(`host snippet anchors drifted:\n${summary}`);
      }
      expect(rateLimiter.status).toBe('applied');
    } finally {
      files.cleanup();
    }
  });
});
