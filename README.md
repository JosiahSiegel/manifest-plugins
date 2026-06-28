# `@josiahsiegel/manifest-plugins`

Request-transform plugins for [mnfst/manifest](https://github.com/mnfst/manifest), applied to any Manifest checkout via `npm run apply`. Works on upstream, a fork, or a plain local clone.

The plugins are **installable request transforms and policy overrides** for Manifest. The flagship plugin (`AnthropicBillingHeaderPlugin`) injects the `x-anthropic-billing-header` required by Anthropic's upstream classifier for OAuth subscription tokens (Claude Pro / Max). Without it, Claude Pro/Max traffic gets 429'd as out-of-credit. The default-policy plugin (`DefaultPolicyPlugin`) provides sensible baseline rate-limit + message-cap policies.

The apply tool patches **three** Manifest source files to install the plugin host:

- `provider-client.ts` — wraps the Anthropic branch's outbound request with `applyRequestTransformPlugins(decision, current)` (per-request transform hook).
- `proxy-rate-limiter.ts` — replaces the hardcoded `CONCURRENCY_MAX = 10` with `getResolvedConcurrencyMax()` (config-time policy hook).
- `proxy.service.ts` — replaces the constructor's message-cap check with `getResolvedMaxMessagesPerRequest(this.config)` (config-time policy hook).

Each patch is byte-exact against upstream/main and idempotent. After every `git pull` of upstream, run `npm run apply -- /path/to/manifest` to re-inject the hosts. No fork, no housekeeping overlay, no source patches to maintain.

---

## 5-minute happy path

```bash
# Clone both repos as siblings
git clone https://github.com/JosiahSiegel/manifest-plugins.git
git clone --depth=1 https://github.com/mnfst/manifest.git ../manifest
# OR: git clone https://github.com/<your-org>/manifest.git ../manifest  (fork is fine too)

cd manifest-plugins
npm install --legacy-peer-deps
npm run build

# Apply the plugin host to all three files in the sibling Manifest checkout
npm run apply -- ../manifest
# → applied all three files (or reports noop if already applied)

# Verify
npm run verify -- ../manifest
# → OK — host installed in <path>

# Build a Docker image with the plugins
docker build \
  --build-context manifest-plugins=$(pwd) \
  --tag manifest:dev \
  ../manifest
# → final log line: "manifest-plugins installed   name: @josiahsiegel/manifest-plugins  version: ...  main: dist/index.js"

# Run it
docker run --rm -p 3001:3001 manifest:dev
```

That's it. The image has all three hosts baked in, Anthropic Pro/Max traffic no longer 429s, and there's no fork-specific source code to maintain.

---

## What this is

`mnfst/manifest` (the upstream model router) is a single-service codebase. This repo holds the **plugin host** (a small TS function pasted into three Manifest source files at apply time) and a registry of **plugins** (each implementing one or both of the plugin interfaces). When the plugin host is installed in a Manifest checkout — upstream, fork, or local clone — every outgoing Anthropic (and future) request flows through the plugin chain, and every constructor / constant read consults the policy chain.

The plugin host is **fail-safe**: if `require('manifest-plugins')` throws (package missing, broken install), the host catches it and the request continues as-is. A vanilla upstream install builds and runs without any of this; a plugin-enabled build is purely additive.

## Two plugin kinds

| Kind | Lifecycle | When called | Files touched |
|---|---|---|---|
| `RequestTransformPlugin` | per-request | every outgoing Anthropic request | `provider-client.ts` host wraps the request before fetch |
| `RequestPolicyPlugin` | config-time | once per process (in constructor / module load) | `proxy-rate-limiter.ts` + `proxy.service.ts` hosts read policy at startup |

A plugin can implement either or both. The host detects the kind by method presence (duck-typing). The first non-null value returned by any policy plugin wins; later plugins are skipped for that field.

```ts
// Per-request transform (e.g. inject OAuth headers)
export interface RequestTransformPlugin {
  transformRequest(decision: RequestTransformDecision):
    | { url?: string; headers?: Record<string, string>; requestBody?: Record<string, unknown> }
    | undefined;
}

// Config-time policy (e.g. set concurrency / message-cap defaults)
export interface RequestPolicyPlugin {
  getRateLimitPolicy(): RateLimitPolicy | null;
  // where RateLimitPolicy = { concurrencyMax: number | null; maxMessagesPerRequest: number | null }
}
```

Plugin errors MUST be non-fatal: the host catches and logs them and continues with the original request. Never throw to abort.

## Layout

```
manifest-plugins/
├── .gitattributes                   # enforces LF line endings across the repo
├── .gitignore
├── config.example.json               # template for the user's manifest-plugins.config.json
├── package.json                     # @josiahsiegel/manifest-plugins
├── tsconfig.json                    # strict TS, LF enforced
├── jest.config.js                   # 100% line + branch + statement coverage
├── scripts/
│   └── filter-plugins.mjs           # post-build: rewrites dist/index.js to exclude plugins per config
├── src/
│   ├── index.ts                     # plugin registry (export const plugins = [...])
│   ├── host/
│   │   ├── snippet.ts               # TS source pasted into the three Manifest files
│   │   ├── apply.ts                 # generic applyPatch + per-file wrappers + applyAll
│   │   ├── cli.ts                   # `npm run apply -- <manifest-checkout>`
│   │   └── verify.ts                # `npm run verify -- <manifest-checkout>`
│   └── plugins/
│       ├── anthropic-billing-header/
│       │   ├── plugin.ts            # the Anthropic billing-header transform plugin
│       │   ├── plugin.spec.ts       # 100% coverage
│       │   └── README.md            # plugin-specific docs
│       └── default-policy/
│           ├── plugin.ts            # the default RequestPolicyPlugin
│           └── plugin.spec.ts       # 100% coverage
├── pipeline/                        # End-to-end pipeline that publishes a pre-built image
│   ├── Dockerfile.manifest         # Complete Dockerfile (uses --build-context manifest-plugins)
│   ├── build-and-publish.sh        # End-to-end script: clone, build, apply, docker build, push
│   └── README.md                   # Pipeline workflow + image verification
├── tests/
│   ├── apply.spec.ts                # patcher integration tests (3 files, idempotency, drift)
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

## Selecting plugins at build time

By default, every plugin in the registry is enabled. To exclude specific plugins from the built `dist/index.js` (and therefore from the docker image), create a `manifest-plugins.config.json` at the repo root:

```bash
cp config.example.json manifest-plugins.config.json
# edit and set the plugins you want to exclude to false
```

Schema:

```json
{
  "plugins": {
    "AnthropicBillingHeaderPlugin": true,
    "DefaultPolicyPlugin": false
  }
}
```

- Keys = plugin class names (validated against the registry at build time — typos fail loud).
- Values = `true` to include, `false` to exclude. Default if absent = enabled.
- If `manifest-plugins.config.json` is absent, **all plugins are enabled**.

The post-build step (`scripts/filter-plugins.mjs`) reads the config and rewrites `dist/index.js` to instantiate only the enabled plugins. The TS source (`src/index.ts`) stays unfiltered, so `npm test` runs against the full plugin set with 100% coverage. The runtime image carries only the chosen subset.

**Use cases:**
- Build a minimal "no fork behavior" image: exclude `DefaultPolicyPlugin` (revert to upstream's hardcoded `CONCURRENCY_MAX = 10` and the 1000-message cap).
- Build an "Anthropic-only" image: exclude `DefaultPolicyPlugin` (use AnthropicBillingHeaderPlugin only).
- Build an "everything-off" image: exclude both — then `require('manifest-plugins')` returns an empty plugins array, hosts no-op, runtime behaves like vanilla upstream.

## Want a pre-built image instead of building yourself?

The [`pipeline/`](./pipeline/) directory contains an end-to-end pipeline that produces a **published Docker image** with the plugin host pre-installed. Consumers just `docker pull` and `docker run` — no apply step required.

```bash
# Build only (no push) — image is local as manifest-with-plugins:<tag>
./pipeline/build-and-publish.sh

# Build and push to a registry (e.g. your ghcr.io org)
REGISTRY=ghcr.io/your-org ./pipeline/build-and-publish.sh --push
```

The pipeline does the full chain: clones Manifest, builds the plugins package, applies the host, builds the Docker image, smoke-tests the host functions in the built image, and optionally pushes. See [`pipeline/README.md`](./pipeline/README.md) for the full workflow, env-var configuration, and verification steps.

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
npm run build                     # tsc + filter-plugins (filters per manifest-plugins.config.json)
```

### Apply (all three files)

```bash
# Default: looks for ../manifest relative to this repo.
npm run apply

# Or specify explicitly:
npm run apply -- /path/to/manifest

# Or via env var:
MANIFEST_CHECKOUT=/path/to/manifest npm run apply
```

The apply tool is **idempotent** — running it twice is safe. After it has been applied once, subsequent runs report `noop` for all three files. The tool is also **fail-loud on upstream drift**: if any of the three files restructured upstream (anchors moved), it raises an error per file with a clear message rather than producing a broken patch.

### Verify

```bash
npm run verify                  # checks ../manifest
npm run verify -- /custom/path  # checks an arbitrary checkout
```

Exits 0 if the host is installed in all three files, 1 otherwise. Useful as a smoke test before/after an upstream `git pull`.

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

Direct upstream clones (or forks that rebase on upstream) get the original `provider-client.ts`, `proxy-rate-limiter.ts`, `proxy.service.ts` back on every pull. Re-apply the plugin host:

```bash
# Local:
cd manifest-plugins
npm run apply -- ../manifest

# CI (in your workflow file):
- run: cd manifest-plugins && npm run apply -- $GITHUB_WORKSPACE
```

The apply is idempotent — running it twice on a freshly-pulled manifest will report `noop` the second time.

## Adding a new plugin

1. Create `src/plugins/<name>/plugin.ts` implementing `RequestTransformPlugin` and/or `RequestPolicyPlugin`.
2. Create `src/plugins/<name>/plugin.spec.ts` with 100% coverage.
3. Add the plugin instance to `plugins` in `src/index.ts`.
4. Add the class name to `PLUGIN_CLASS_NAMES` in `scripts/filter-plugins.mjs` (so it can be excluded via config).
5. Bump the version in `package.json` and `npm run build`.
6. (Optional) Update `manifest-plugins.config.json` to enable/disable the new plugin per build target.

No apply-tool edits are needed for new plugins — they're picked up automatically by the next docker build.

## Environment knobs

| Var                     | Default     | Purpose                                                                 |
| ----------------------- | ----------- | ----------------------------------------------------------------------- |
| `MANIFEST_CC_VERSION`   | `2.1.117`   | Claude Code version stamped into `cc_version`. Bump when Anthropic rotates the classifier. |
| `MANIFEST_CCH_VALUE`    | (empty)     | Overrides the SHA-derived `cch` token. Empty → use `00000`. Set to a hex value to force a specific token. |
| `MANIFEST_CHECKOUT`     | `../manifest` | Path to the Manifest checkout for `npm run apply` / `npm run verify`. |

## Line endings

`.gitattributes` enforces LF line endings repo-wide. The plugin-host patch is byte-exact against upstream/main, which is also LF; mixed line endings break the patcher. If you're on Windows, run `git config core.autocrlf false` before cloning to avoid Windows checkout conversions.

## Tests

```bash
npm test              # 39/39 tests pass
npm run test:coverage # 100% line + branch + statement + function coverage
```

Coverage is enforced at 100% lines + branches + statements via `jest.config.js`'s `coverageThreshold.global`. CI fails if any new code path is uncovered.

The `apply.spec.ts` integration test copies upstream's three target files into a tempdir, runs `applyAll()`, asserts idempotency + per-file results, and runs `tsc --noEmit` against the patched files to ensure the inserted TS is syntactically valid in the real backend tsconfig context.

## Troubleshooting

See [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) for concrete failure modes and fixes. Common issues:

- **"upstream-drift"** — upstream refactored one of the three target files and the anchor moved. Update `src/host/snippet.ts` (the constants) and bump the version.
- **`docker build` fails with "forbidden path outside build context"** — you forgot `--build-context manifest-plugins=...`.
- **Image runs but Anthropic Pro/Max traffic still gets 429** — usually means `provider-client.ts` was reverted (e.g. by a fresh `git pull`). Re-apply via `npm run apply`.
- **Tests fail on Windows with "Invalid regular expression"** — CRLF got into your checkout. Run `git config core.autocrlf false` and re-clone.
- **Build fails with "unknown plugin"** — typo in `manifest-plugins.config.json`. The class name must match an exported plugin (validated against the registry at build time).