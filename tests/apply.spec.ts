/**
 * Integration test for the plugin-host patcher.
 *
 * The test:
 *   1. Reads upstream/main's `provider-client.ts` via `git show`.
 *   2. Copies it into a tempdir.
 *   3. Runs `applyProviderClientHost` against the copy.
 *   4. Asserts the helper + return-wrap symbols are present.
 *   5. Runs the patcher a second time and asserts it is a no-op.
 *   6. Runs `tsc --noEmit` against the patched file (via the backend
 *      tsconfig) to ensure the inserted TS compiles in context.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyProviderClientHost } from '../src/host/apply';

const MANIFEST_REPO = process.env['MANIFEST_REPO'] ?? '../manifest';
const PROVIDER_CLIENT_PATH =
  'packages/backend/src/routing/proxy/provider-client.ts';

function readUpstreamProviderClient(): string {
  // Read from the sibling Manifest checkout. We use `-C` so the same command
  // works whether the test is invoked from this repo or from CI where the
  // Manifest checkout might be at an arbitrary absolute path.
  const result = spawnSync(
    'git',
    ['-C', MANIFEST_REPO, 'show', `upstream/main:${PROVIDER_CLIENT_PATH}`],
    { encoding: 'utf-8' },
  );
  if (result.status !== 0 || result.stderr) {
    const stderr = result.stderr || '(no stderr)';
    if (
      stderr.includes('unknown revision') ||
      stderr.includes('does not exist') ||
      stderr.includes('not a git repository')
    ) {
      throw new Error(
        `failed to read upstream provider-client.ts at ${MANIFEST_REPO}: ${stderr.trim()}\n` +
          `  Set MANIFEST_REPO env var to the Manifest checkout path (must have an upstream/main ref).`,
      );
    }
    throw new Error(`failed to read upstream provider-client.ts: ${stderr}`);
  }
  return result.stdout;
}

function withTempProviderClient(
  fn: (path: string, content: string) => Promise<void> | void,
): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'manifest-plugins-apply-'));
  const path = join(tmp, 'provider-client.ts');
  const content = readUpstreamProviderClient();
  writeFileSync(path, content, 'utf-8');
  return Promise.resolve(fn(path, content)).finally(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
}

describe('applyProviderClientHost', () => {
  it('patches upstream provider-client.ts idempotently', async () => {
    await withTempProviderClient(async (path) => {
      // First apply — should report applied.
      const first = await applyProviderClientHost(path);
      if (first.status !== 'applied') {
        throw new Error(`expected first.status === 'applied', got ${first.status}`);
      }
      expect(first.helperInserted).toBe(true);
      expect(first.returnReplaced).toBe(true);

      const patched = readFileSync(path, 'utf-8');
      expect(patched).toContain('function applyRequestTransformPlugins(');
      expect(patched).toContain('const transformed = applyRequestTransformPlugins(');

      // Second apply — should be no-op.
      const second = await applyProviderClientHost(path);
      if (second.status !== 'noop') {
        throw new Error(`expected second.status === 'noop', got ${second.status}`);
      }
      expect(second.helperInserted).toBe(false);
      expect(second.returnReplaced).toBe(false);

      const reread = readFileSync(path, 'utf-8');
      expect(reread).toBe(patched);
    });
  });

  it('dry-run does not modify the file', async () => {
    await withTempProviderClient(async (path, original) => {
      const result = await applyProviderClientHost(path, { dryRun: true });
      if (result.status !== 'applied') {
        throw new Error(`expected status === 'applied', got ${result.status}`);
      }
      expect(result.helperInserted).toBe(true);

      const after = readFileSync(path, 'utf-8');
      expect(after).toBe(original);
    });
  });

  it('reports upstream-drift when the helper anchor is missing', async () => {
    await withTempProviderClient(async (path) => {
      // Mutate to remove the helper anchor.
      writeFileSync(
        path,
        '// upstream restructured — anchors are gone\n',
        'utf-8',
      );

      const result = await applyProviderClientHost(path);
      expect(result.status).toBe('upstream-drift');
      if (result.status === 'upstream-drift') {
        expect(result.reason).toContain('helper insertion marker');
      }
    });
  });

  it('reports upstream-drift when the return anchor is missing', async () => {
    await withTempProviderClient(async (path, original) => {
      // Keep the helper anchor; remove the return anchor.
      // Use the upstream shape's full RETURN_OLD substring (which contains
      // the unique `endpoint.buildPath(bareModel)` continuation that
      // distinguishes the Anthropic branch from other `      return {`
      // blocks in provider-client.ts). Without this, the regex would match
      // a less-specific earlier block (e.g. the OpenAI fallback at the
      // bottom of buildRequest) and the test would silently keep the
      // real anchor.
      const RETURN_OLD =
        "      return {\n" +
        "        url: `${endpoint.baseUrl}${endpoint.buildPath(bareModel)}`,\n" +
        "        headers: endpoint.buildHeaders(apiKey, authType),\n" +
        "        requestBody,\n" +
        "      };\n" +
        "    }\n";
      const withoutReturn = original.replaceAll(RETURN_OLD, '');
      expect(withoutReturn).not.toBe(original);
      writeFileSync(path, withoutReturn, 'utf-8');

      const result = await applyProviderClientHost(path);
      expect(result.status).toBe('upstream-drift');
      if (result.status === 'upstream-drift') {
        expect(result.reason).toContain('return block');
      }
    });
  });

  it('the patched file passes tsc against packages/backend/tsconfig.json', async () => {
    await withTempProviderClient(async (path) => {
      const first = await applyProviderClientHost(path);
      expect(first.status).toBe('applied');

      // Place the patched file in the real backend tree so tsconfig can find it.
      const backendSrc = join(
        MANIFEST_REPO,
        'packages/backend/src/routing/proxy',
      );
      const realPath = join(backendSrc, 'provider-client.ts');
      const backup = readFileSync(realPath, 'utf-8');
      const patched = readFileSync(path, 'utf-8');
      writeFileSync(realPath, patched, 'utf-8');

      try {
        const tsc = spawnSync(
          'npx',
          ['tsc', '--noEmit', '-p', 'packages/backend/tsconfig.json'],
          {
            cwd: MANIFEST_REPO,
            encoding: 'utf-8',
          },
        );
        const out = ((tsc.stdout ?? '') + (tsc.stderr ?? '')).split('\n');
        const errors = out.filter(
          (line) => line.includes('provider-client') || line.includes('applyRequestTransformPlugins'),
        );
        if (errors.length > 0) {
          // Surface unexpected errors so the test fails loudly.
          expect(errors.join('\n')).toBe('');
        }
        // tsc exit may be non-zero from unrelated pre-existing errors
        // (e.g. missing cacheable module). We only care that no error
        // points at the patched lines.
      } finally {
        // Restore the real file.
        writeFileSync(realPath, backup, 'utf-8');
      }
    });
  });
});