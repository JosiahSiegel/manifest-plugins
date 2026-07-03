/**
 * RED tests for `assertAnchors` against the current upstream
 * proxy-rate-limiter / proxy.service / provider-client shapes.
 *
 * These tests are RED only when one of the anchors has drifted.
 * They are GREEN for the already-fixed anchors:
 *
 *   1. `provider-client.ts` — Anthropic branch's `return { url, headers, requestBody }`.
 *   2. `proxy-rate-limiter.ts` — `const CONCURRENCY_MAX = positiveIntegerEnv(...)` line.
 *
 * Wave-history note: an earlier wave also asserted a third anchor on
 * `proxy.service.ts` for the `maxMessagesPerRequest` constructor
 * block. Upstream commit `c9009bcd5` removed that feature from
 * `proxy.service.ts` entirely (import, field, constructor body, and
 * `validatePayload` enforcement check all disappeared), so the
 * corresponding `PROXY_SERVICE_OLD` constant was retired along with
 * its drift check. The routing-override constructor anchor
 * (`PROXY_ROUTING_OVERRIDE_CONSTRUCTOR_OLD`) covers the remaining
 * drift surface on `proxy.service.ts`; if upstream renames or
 * reorders the `providerParamSpecs` constructor parameter, the apply
 * path will report drift on the routing-override patch instead.
 *
 * Strategy:
 *   - Read the two files from the upstream/main ref via
 *     `git show upstream/main:<path>` (mirroring `tests/apply.spec.ts`).
 *     This guarantees we test against the unpatched upstream shape,
 *     not the local working tree (which may already have the
 *     plugin-host patches applied).
 *   - Build a small `AnchorMarker[]` per file from the snippets in
 *     `src/host/snippet.ts` (so the test stays in sync if the
 *     patches are refreshed).
 *   - Call `assertAnchors` and assert `ok === true`. If upstream
 *     drifts, `missing` is non-empty and the test reports the
 *     specific anchor that broke.
 *
 * No network calls. Files are read via `git show` against the
 * sibling checkout at $MANIFEST_REPO (default: ../manifest).
 */
import { spawnSync } from 'child_process';
import { join } from 'path';
import {
  HELPER_MARKER_OLD,
  RETURN_OLD,
  RATE_LIMITER_OLD,
} from '../src/host/snippet';
import { assertAnchors, type AnchorMarker } from '../src/apply/anchor-drift';

const MANIFEST_REPO = process.env['MANIFEST_REPO'] ?? '../manifest';

interface UpstreamFiles {
  readonly providerClient: string;
  readonly proxyRateLimiter: string;
}

function readUpstreamFile(file: string): string {
  const result = spawnSync(
    'git',
    ['-C', MANIFEST_REPO, 'show', `upstream/main:${file}`],
    { encoding: 'utf-8' },
  );
  if (result.status !== 0) {
    const stderr = result.stderr || '(no stderr)';
    throw new Error(
      `failed to read upstream/main:${file} at ${MANIFEST_REPO}: ${stderr.trim()}\n` +
        `  Set MANIFEST_REPO env var to a Manifest checkout with an upstream/main ref.`,
    );
  }
  return result.stdout;
}

function readAllUpstream(): UpstreamFiles {
  return {
    providerClient: readUpstreamFile(
      'packages/backend/src/routing/proxy/provider-client.ts',
    ),
    proxyRateLimiter: readUpstreamFile(
      'packages/backend/src/routing/proxy/proxy-rate-limiter.ts',
    ),
  };
}

describe('assertAnchors against current upstream shapes', () => {
  it('provider-client.ts contains RETURN_OLD + HELPER_MARKER_OLD anchors', () => {
    const upstream = readAllUpstream();
    const anchors: AnchorMarker[] = [
      { name: 'provider-client/return-old', marker: RETURN_OLD },
      { name: 'provider-client/helper-marker-old', marker: HELPER_MARKER_OLD },
    ];
    const report = assertAnchors(upstream.providerClient, anchors);
    if (!report.ok) {
      throw new Error(
        `provider-client.ts anchors drifted: ${report.missing.join(', ')}`,
      );
    }
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it('proxy-rate-limiter.ts contains RATE_LIMITER_OLD anchor', () => {
    const upstream = readAllUpstream();
    const anchors: AnchorMarker[] = [
      { name: 'proxy-rate-limiter/concurrency-old', marker: RATE_LIMITER_OLD },
    ];
    const report = assertAnchors(upstream.proxyRateLimiter, anchors);
    if (!report.ok) {
      throw new Error(
        `proxy-rate-limiter.ts anchors drifted: ${report.missing.join(', ')}`,
      );
    }
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it('all files together: bundled anchor report is ok', () => {
    // The canonical "is the apply orchestrator still safe to run?"
    // assertion: every anchor the orchestrator relies on, in one
    // report. If this fails, the apply path will produce drift on
    // the next run.
    const upstream = readAllUpstream();

    const allAnchors: ReadonlyArray<{
      readonly file: 'provider-client' | 'proxy-rate-limiter';
      readonly content: string;
      readonly markers: AnchorMarker[];
    }> = [
      {
        file: 'provider-client',
        content: upstream.providerClient,
        markers: [
          { name: 'return-old', marker: RETURN_OLD },
          { name: 'helper-marker-old', marker: HELPER_MARKER_OLD },
        ],
      },
      {
        file: 'proxy-rate-limiter',
        content: upstream.proxyRateLimiter,
        markers: [{ name: 'concurrency-old', marker: RATE_LIMITER_OLD }],
      },
    ];

    const reports = allAnchors.map((entry) => ({
      file: entry.file,
      report: assertAnchors(entry.content, entry.markers),
    }));

    const failed = reports.filter((r) => !r.report.ok);
    if (failed.length > 0) {
      const summary = failed
        .map((f) => `${f.file}: ${f.report.missing.join(', ')}`)
        .join('\n');
      throw new Error(`upstream anchor drift detected:\n${summary}`);
    }
    expect(failed).toEqual([]);
  });
});