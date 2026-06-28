# `@josiahsiegel/manifest-plugins`

Request-transform plugins for [mnfst/manifest](https://github.com/mnfst/manifest), applied to any Manifest checkout via `npm run apply`. Works on upstream, a fork, or a plain local clone. The plugins themselves are fork-flavored (e.g. Anthropic OAuth billing headers for Claude Pro/Max), but the apply tool itself doesn't care what kind of Manifest it patches.

The flagship plugin ships today: `AnthropicBillingHeaderPlugin` injects the `x-anthropic-billing-header` required by Anthropic's upstream classifier for OAuth subscription tokens (Claude Pro / Max). Without it, Claude Pro/Max traffic gets 429'd as out-of-credit.

---

## 5-minute happy path (fork, local)

```bash
# Terminal 1 — set up the plugins repo
git clone https://github.com/JosiahSiegel/manifest-plugins.git
cd manifest-plugins
npm install --legacy-peer-deps
npm run build

# Terminal 2 — clone Manifest as a sibling (or use an existing fork)
git clone --depth=1 https://github.com/mnfst/manifest.git ../manifest
# OR: git clone https://github.com/<your-org>/manifest.git ../manifest

# Apply the plugin host to the sibling Manifest checkout
cd manifest-plugins
npm run apply -- ../manifest
# → "applied (helperInserted=true, returnReplaced=true)"

# Verify
npm run verify -- ../manifest
# → "OK — host installed in <path>"

# Build a Docker image with the plugins
docker build \
  --build-context manifest-plugins=$(pwd) \
  --tag manifest:dev \
  ../manifest
# → final log line: "manifest-plugins installed   name: @josiahsiegel/manifest-plugins  version: ...  main: dist/index.js"

# Run it
docker run --rm -p 3001:3001 manifest:dev
```

That's it. The image has the plugin host baked in, and Anthropic Pro/Max traffic to it will no longer 429 out-of-credit.

---

## 5-minute happy path (upstream, no fork)

Same as above but `git clone https://github.com/mnfst/manifest.git ../manifest` instead of your fork. The apply tool doesn't know or care that it's upstream — it just patches the file. Run `npm run apply -- ../manifest` once after every fresh clone or upstream sync.

---

## What this is

`mnfst/manifest` (the upstream model router) is a single-service codebase. This repo holds the **plugin host** (a small TS function pasted into `provider-client.ts` at apply time) and a registry of **plugins** (each implementing `RequestTransformPlugin`). When the plugin host is installed in a Manifest checkout — upstream, fork, or local clone — every outgoing Anthropic (and future) request flows through the plugin chain, letting you inject headers, mutate the body, or rewrite the URL.

The plugin host is **fail-safe**: if `require('manifest-plugins')` throws (package missing, broken install), the host catches it and the request continues as-is. A fork can build with or without the plugins context.

## Layout

```
manifest-plugins/
├── .gitattributes                   # enforces LF line endings across the repo
├── .gitignore
├── package.json                     # @josiahsiegel/manifest-plugins
├── tsconfig.json                    # strict TS, LF enforced
├── jest.config.js                   # 100% line + branch + statement coverage
├── src/
│   ├── index.ts                     # plugin registry (export const plugins = [...])
│   ├── host/
│   │   ├── snippet.ts               # the TS source pasted into provider-client.ts
│   │   ├── apply.ts                 # idempotent patcher (applyProviderClientHost)
│   │   ├── cli.ts                   # `npm run apply -- <manifest-checkout>`
│   │   └── verify.ts                # `npm run verify -- <manifest-checkout>`
│   └── plugins/
│       └── anthropic-billing-header/
│           ├── plugin.ts            # the plugin
│           ├── plugin.spec.ts       # 100% coverage
│           └── README.md            # plugin-specific docs
├── tests/
│   ├── apply.spec.ts                # patcher integration test (runs tsc on patched file)
│   └── index.spec.ts                # plugin registry test
├── examples/
│   ├── docker/
│   │   └── Dockerfile.snippet       # copy-pasteable BuildKit plugins-install stage
│   ├── ci/
│   │   └── build-with-plugins.yml   # full GitHub Actions workflow example
│   └── scripts/
│       └── build-fork-image.sh      # end-to-end local build script
└── docs/
    └── TROUBLESHOOTING.md           # concrete failure modes + fixes
```

## Examples

Working, copy-pasteable examples live under `examples/`:

- **Docker integration**: [`examples/docker/Dockerfile.snippet`](./examples/docker/Dockerfile.snippet) — drop-in `plugins-install` BuildKit stage plus the runtime `COPY` line. Use the named context `--build-context manifest-plugins=...`.
- **CI workflow**: [`examples/ci/build-with-plugins.yml`](./examples/ci/build-with-plugins.yml) — full GitHub Actions workflow that syncs the fork, applies the plugin host, builds the image, and smoke-tests the plugin layer. Drop into `.github/workflows/build-with-plugins.yml` in your fork.
- **Local build script**: [`examples/scripts/build-fork-image.sh`](./examples/scripts/build-fork-image.sh) — bash one-liner that clones the plugins repo, builds it, applies the host, and runs `docker build`. Run `./examples/scripts/build-fork-image.sh --help` for options.

## Apply tool reference

### Setup

```bash
cd manifest-plugins
npm install --legacy-peer-deps    # --legacy-peer-deps avoids the ts-node peer-dep conflict
npm run build                     # produces dist/ for the docker build
```

### Apply

```bash
# Default: looks for ../manifest relative to this repo.
npm run apply

# Or specify explicitly:
npm run apply -- /path/to/manifest

# Or via env var:
MANIFEST_CHECKOUT=/path/to/manifest npm run apply
```

The apply tool is **idempotent** — running it twice is safe. After it has been applied once, subsequent runs report `noop`. The tool is also **fail-loud on upstream drift**: if `provider-client.ts` restructured upstream (anchors moved), it raises `SystemExit` with a clear message rather than producing a broken patch.

### Verify

```bash
npm run verify                  # checks ../manifest
npm run verify -- /custom/path  # checks an arbitrary checkout
```

Exits 0 if the host is installed, 1 otherwise. Useful as a smoke test before/after a sync run.

### Docker build

```bash
# Local (sibling clone):
docker build --build-context manifest-plugins=../manifest-plugins -t manifest:dev ../manifest

# CI (git URL):
docker build \
  --build-context manifest-plugins=https://github.com/<owner>/manifest-plugins.git \
  -t manifest:dev \
  ../manifest
```

Or use the all-in-one script: `./examples/scripts/build-fork-image.sh`.

### After every upstream sync

If you use a fork with the housekeeping overlay (which resets to upstream/main on every sync), re-apply the plugin host after each sync:

```bash
# Local:
cd manifest-plugins
npm run apply -- ../manifest

# CI (in your workflow file):
- run: cd manifest-plugins && npm run apply -- $GITHUB_WORKSPACE
```

The apply is idempotent — running it twice on a freshly-synced manifest will report `noop` the second time.

## Plugin contract

Every plugin implements:

```ts
interface RequestTransformPlugin {
  transformRequest(decision: RequestTransformDecision):
    | { url?: string; headers?: Record<string, string>; requestBody?: Record<string, unknown> }
    | undefined;
}
```

Plugins receive the routing decision (`endpointKey`, `authType`, `bareModel`, etc.) plus the outgoing `url` / `headers` / `requestBody` the host already computed. Return whatever you want to override; unspecified fields pass through.

Plugin errors are caught by the host and logged; one broken plugin must not break the request. Never throw to abort.

## Adding a new plugin

1. Create `src/plugins/<name>/plugin.ts` implementing `RequestTransformPlugin`.
2. Create `src/plugins/<name>/plugin.spec.ts` with 100% coverage.
3. Add the plugin instance to `plugins` in `src/index.ts`.
4. Bump the version in `package.json` and `npm run build`.
5. `npm run apply -- <manifest-checkout>` to pick up the change at runtime (only needed if you change the **plugin host** itself; new plugins are picked up automatically by the next docker build).

No overlay edits. No upstream-sync collisions.

## Environment knobs

| Var                     | Default     | Purpose                                                                 |
| ----------------------- | ----------- | ----------------------------------------------------------------------- |
| `MANIFEST_CC_VERSION`   | `2.1.117`   | Claude Code version stamped into `cc_version`. Bump when Anthropic rotates the classifier. |
| `MANIFEST_CCH_VALUE`    | (empty)     | Overrides the SHA-derived `cch` token. Empty → use `00000`. Set to a hex value to force a specific token. |

## Line endings

`.gitattributes` enforces LF line endings repo-wide. The plugin-host patch is byte-exact against upstream/main, which is also LF; mixed line endings break the patcher. If you're on Windows, run `git config core.autocrlf false` before cloning to avoid Windows checkout conversions.

## Tests

```bash
npm test              # 27/27 tests pass
npm run test:coverage # 100% line + branch + statement + function coverage
```

Coverage is enforced at 100% lines + branches + statements via `jest.config.js`'s `coverageThreshold.global`. CI fails if any new code path is uncovered.

The `apply.spec.ts` integration test copies upstream's `provider-client.ts` into a tempdir, runs the patcher, asserts idempotency, then runs `tsc --noEmit` against the patched file to ensure the inserted TS is syntactically valid in the real backend tsconfig context.

## Troubleshooting

See [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) for concrete failure modes and fixes. Common issues:

- **"upstream-drift"** — upstream refactored `provider-client.ts` and the anchors moved. Update `src/host/snippet.ts` (the constants) and bump the version.
- **`docker build` fails with "forbidden path outside build context"** — you forgot `--build-context manifest-plugins=...`.
- **Image runs but Anthropic Pro/Max traffic still gets 429** — usually means `provider-client.ts` was reset by the housekeeping overlay. Re-apply via `npm run apply`.
- **Tests fail on Windows with "Invalid regular expression"** — CRLF got into your checkout. Run `git config core.autocrlf false` and re-clone.