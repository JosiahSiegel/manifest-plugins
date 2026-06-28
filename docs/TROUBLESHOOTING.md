# Troubleshooting manifest-plugins

## Apply tool reports `upstream-drift`

**Symptom:**

```
[manifest-plugins/apply] upstream/main restructured provider-client.ts — missing anchors: helper insertion marker (HELPER_MARKER_OLD). Update src/host/snippet.ts to match new upstream shape.
```

**Cause:** upstream/main refactored `provider-client.ts` and the anchors the patcher looks for moved or disappeared.

**Fix:**

1. Pull the new upstream and diff `provider-client.ts` against the constants in `src/host/snippet.ts`:
   ```bash
   git -C ../manifest show upstream/main:packages/backend/src/routing/proxy/provider-client.ts \
     > /tmp/upstream-provider-client.ts
   diff -u /tmp/upstream-provider-client.ts \
            src/host/snippet.ts    # not the right diff target — read the constants directly
   ```
2. Read `src/host/snippet.ts` and update the `HELPER_MARKER_OLD` and `RETURN_OLD` constants to match the new upstream shape byte-for-byte (whitespace matters — the patcher does literal substring matching).
3. Bump the package version (`npm version patch`), commit, push, then re-run the apply.
4. If you also need to update the **call site** (the Anthropic-branch wrap), update `RETURN_NEW` and the `buildHelperMarkerNew()` helper in `apply.ts`.

## Apply tool reports `noop` but the file still doesn't have the plugin host

**Symptom:** `npm run verify` says "host NOT installed" but the apply tool says `noop`.

**Cause:** the apply tool is idempotent — if `provider-client.ts` already contains the post-patch markers, it skips. But there are two definitions of "already patched":

1. `function applyRequestTransformPlugins(` — the helper signature
2. `const transformed = applyRequestTransformPlugins(` — the call site

**If only one is present**, the apply tool won't add the other (it checks both as a unit). This shouldn't normally happen — it can only occur if someone manually edited the file mid-flight.

**Fix:** if you have a half-applied state, edit `provider-client.ts` to remove both markers, then re-run the apply.

## Docker build fails with `forbidden path outside build context`

**Symptom:**

```
ERROR: failed to solve: failed to compute cache key: failed to calculate checksum of ref ...: "/platforms": not found
```

or:

```
COPY --from=manifest-plugins /package.json /tmp/stamp.json
ERROR: "/package.json": not found in manifest-plugins
```

**Cause:** the named BuildKit context `manifest-plugins` wasn't supplied at build time.

**Fix:** add `--build-context` to your build invocation:

```bash
docker build \
  --build-context manifest-plugins=../manifest-plugins \
  -t manifest:dev .
```

If you're using a remote git URL, supply that:

```bash
docker build \
  --build-context manifest-plugins=https://github.com/<owner>/manifest-plugins.git \
  -t manifest:dev .
```

To build without plugins (e.g. for a smoke test), supply an empty tarball:

```bash
tar -czf /tmp/empty.tgz --files-from=/dev/null
docker build \
  --build-context manifest-plugins=/tmp/empty.tgz \
  -t manifest:noplugins .
```

## Docker build succeeds but plugin host never runs

**Symptom:** the image runs but Anthropic Pro/Max traffic still gets 429 out-of-credit.

**Cause 1 — `require('manifest-plugins')` fails inside `provider-client.ts`:** the package isn't in `node_modules`. Verify by:

```bash
docker run --rm --entrypoint='["node","-e"]' manifest:dev \
  'require("/app/node_modules/manifest-plugins/package.json")'
```

If you see `MODULE_NOT_FOUND`, the package didn't get copied. Re-check the `plugins-install` stage in your Dockerfile.

**Cause 2 — `provider-client.ts` was reset by the sync workflow:** the housekeeping overlay runs `git switch -C main upstream/main` and re-applies its own patches. If the plugin host injection lives in a tracked file (not preserved by the overlay), it gets wiped every sync. Re-apply via `npm run apply` after each sync.

**Cause 3 — `ANTHROPIC_CC_VERSION` is wrong:** the plugin's suffix derives from this. Bump via:

```bash
docker run -e ANTHROPIC_CC_VERSION=2.1.118 manifest:dev
```

If Anthropic rotates the classifier version, update the env var (or your `.env`).

**Cause 4 — Anthropic rotates the classifier algorithm:** the suffix/cch algorithm is reverse-engineered from Claude Code. When Anthropic ships a breaking change, the static values stop being accepted. Symptom: requests get rejected even though the header shape is correct. Mitigation: pin a known-good `MANIFEST_CCH_VALUE` to bypass the auto-derivation.

## Plugin errors in the runtime log

**Symptom:** the backend logs `[manifest-plugins] <PluginName> failed: <error>`.

**Cause:** a plugin threw inside its `transformRequest()` method.

**Behavior:** the host catches the error, logs it via `console.warn`, and continues with the request unchanged. The plugin is effectively a no-op for that request.

**Fix:** identify the broken plugin and check its state. Common causes:
- Plugin code references an env var that's not set.
- Plugin code expects a `requestBody.messages` shape that's not present (e.g. raw HTTP proxy, not chat-completions).
- Plugin code has a bug — see the plugin's `src/plugins/<name>/README.md` for the contract.

## `npm run apply` fails with "Cannot find module"

**Symptom:**

```
Error: Cannot find module './apply.js'
```

**Cause:** the CLI script `tsx src/host/cli.ts` couldn't resolve the import path.

**Fix:**

```bash
npm install --legacy-peer-deps --no-audit --no-fund
npm run build
```

The `--legacy-peer-deps` flag is required if you hit `npm error peer typescript@">=2.7" from ts-node@10.9.2`. (We've moved to `tsx` instead of `ts-node`, but if you're on an older npm or have a stale lockfile, this can resurface.)

## `jest --coverage` fails on Windows with "Invalid regular expression"

**Symptom:**

```
SyntaxError: Invalid regular expression: /.../u: Invalid escape
```

**Cause:** Windows default line endings (CRLF) are getting into the regex literals, or the test files contain Windows-style path separators (`\`) in regex.

**Fix:** enforce LF via `.gitattributes` (already in this repo) AND set:

```bash
git config core.autocrlf false
```

If the problem persists, check `git ls-files --eol` — any file showing `w/crlf` was checked out with CRLF and needs `git checkout --theirs .` then a fresh clone.

## Plugin host degrades to no-op on upstream

**Symptom:** you intentionally build upstream Manifest without the fork, but want the plugin host to be present for future plugin additions.

**Cause:** the plugin host's `require('manifest-plugins')` throws when the package isn't installed, the host's `try/catch` catches it, and the host becomes a no-op. This is by design.

**Fix:** install the package. The plugin host always works; it's the plugin **list** that's empty when no plugins are registered.

## Tests fail on first run after `npm install`

**Symptom:** jest reports "Test suite failed to run" with TypeScript errors.

**Cause:** ts-jest is compiling on the fly and the first compile hits a cold cache. Often it's a stale `.tsbuildinfo`.

**Fix:**

```bash
rm -rf node_modules/.cache .tsbuildinfo
npm test
```

If still failing, run `npx tsc --noEmit` to see the raw TypeScript error.