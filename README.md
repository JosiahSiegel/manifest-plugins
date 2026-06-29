# @josiahsiegel/manifest-plugins

> Drop-in Manifest images with request-transform plugins baked in. Forks, fixes, and per-request request rewrites for [mnfst/manifest](https://github.com/mnfst/manifest) — without forking Manifest itself.

[![image build](https://img.shields.io/github/actions/workflow/status/JosiahSiegel/manifest-plugins/build-image.yml?branch=main&label=image%20build)](https://github.com/JosiahSiegel/manifest-plugins/actions/workflows/build-image.yml)
[![image](https://img.shields.io/badge/ghcr.io-manifest--with--plugins-blue)](https://github.com/JosiahSiegel/manifest-plugins/pkgs/container/manifest-with-plugins)
[![license](https://img.shields.io/github/license/JosiahSiegel/manifest-plugins)](LICENSE)
[![coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)]()

## TL;DR

```bash
# Pull and run a pre-built image with the plugin host pre-installed
docker run --rm -p 2099:2099 \
  -e DATABASE_URL=postgresql://myuser:mypassword@host:5432/manifest \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  ghcr.io/josiahsiegel/manifest-with-plugins:latest
# → Manifest dashboard at http://localhost:2099
```

A published image with the Anthropic billing-header plugin (Claude Pro/Max OAuth) and default rate-limit policy baked in. Drop-in replacement for the upstream Manifest image — same dashboard, same API, plus `x-anthropic-billing-header` automatically injected on every Anthropic request.

## Table of contents

- [Why this exists](#why-this-exists)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [Testing](#testing)
- [Architecture](#architecture)
- [Releases](#releases)
- [Contributing](#contributing)
- [License](#license)

## Why this exists

[mnfst/manifest](https://github.com/mnfst/manifest) is a single-service app that routes AI agent requests to the cheapest model that can handle them. Out of the box, it supports any provider with an OpenAI-compatible API, including Anthropic.

**The gap:** Anthropic's OAuth subscription tokens (Claude Pro / Max) require an `x-anthropic-billing-header` header to be sent on every request. Without it, Anthropic's classifier returns 429 "out of credit" — even though the user has an active Pro/Max subscription. Manifest doesn't add this header today.

**The fix:** a small plugin host injected into three Manifest source files (per-request transforms + config-time policy overrides) that runs the registered plugin chain on every Anthropic request. No fork of Manifest. No overlay patches to maintain across upstream pulls.

The flagship plugin (`AnthropicBillingHeaderPlugin`) injects the billing header so Claude Pro/Max traffic flows. The default policy plugin (`DefaultPolicyPlugin`) sets sensible concurrency + message-cap defaults. The host is **fail-safe**: if the plugins package is missing or broken, requests continue as-is.

## Quick start

### Use the pre-built image (no build required)

```bash
# Pull the image
docker pull ghcr.io/josiahsiegel/manifest-with-plugins:latest

# Run it (PostgreSQL + auth secret required)
docker run --rm -p 2099:2099 \
  -e DATABASE_URL=postgresql://myuser:mypassword@host:5432/manifest \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  ghcr.io/josiahsiegel/manifest-with-plugins:latest

# Open the dashboard
open http://localhost:2099
```

The image listens on port `2099` (matching upstream Manifest). See [`pipeline/`](pipeline/) for the full operator guide.

### Build it yourself (with custom plugins)

```bash
# Clone both repos as siblings
git clone https://github.com/JosiahSiegel/manifest-plugins.git
git clone https://github.com/mnfst/manifest.git ../manifest

cd manifest-plugins
make install
make build              # tsc + post-build plugin filter
make apply DIR=../manifest
make verify DIR=../manifest
```

The `make apply` step injects the plugin host into three files in your Manifest checkout:
- `packages/backend/src/routing/proxy/provider-client.ts`
- `packages/backend/src/routing/proxy/proxy-rate-limiter.ts`
- `packages/backend/src/routing/proxy/proxy.service.ts`

Each patch is byte-exact against upstream and **idempotent** — running `make apply` twice is safe.

To build a Docker image with the plugins baked in, see [Building an image](#building-an-image).

## Usage

### Selecting plugins at build time

By default, every plugin in the registry is enabled. Exclude specific plugins by creating `manifest-plugins.config.json`:

```bash
cp config.example.json manifest-plugins.config.json
```

```json
{
  "plugins": {
    "AnthropicBillingHeaderPlugin": true,
    "DefaultPolicyPlugin": false
  }
}
```

The post-build step (`scripts/filter-plugins.mjs`) reads this config and rewrites `dist/index.js` to instantiate only the enabled plugins. The TS source stays unfiltered, so `make test` runs against the full set with 100% coverage.

### Environment knobs

| Variable | Default | Purpose |
| --- | --- | --- |
| `MANIFEST_CC_VERSION` | `2.1.117` | Claude Code version stamped into `cc_version`. Bump when Anthropic rotates the classifier. |
| `MANIFEST_CCH_VALUE` | _(empty)_ | Override the SHA-derived `cch` token. Empty → use `00000`. |
| `MANIFEST_CHECKOUT` | `../manifest` | Path to the Manifest checkout for `npm run apply` / `npm run verify`. |
| `MANIFEST_URL` | `https://github.com/mnfst/manifest.git` | Git URL the pipeline clones when no local checkout exists. |

### Building an image

The [`pipeline/`](pipeline/) directory contains an end-to-end script that clones Manifest, builds the plugins, applies the host, and builds a Docker image. The image is `latest`-tagged only after the e2e test passes — see [Testing](#testing).

```bash
# Local build (no push) — image lands as manifest-with-plugins:<tag>
make pipeline

# Build + push to a registry (e.g. your ghcr.io org)
REGISTRY=ghcr.io/your-org bash pipeline/build-and-publish.sh --push
```

The pipeline uses buildx with `--load` (so you can run the e2e test locally) and gates `latest` on the e2e test passing.

## Testing

### Unit tests

```bash
make test                # jest with 100% coverage
```

40 tests cover the apply tool (3-file idempotency, drift detection, alternate patch shapes), the plugin registry, and each individual plugin.

### End-to-end test

The canonical validation: boot the built image against a scratch PostgreSQL and assert the dashboard actually serves at `GET /`. This catches every regression a unit test can't see (missing frontend dist, broken serve-static, asset-pipeline mismatch, port-binding regressions).

```bash
make e2e                                    # test manifest-with-plugins:latest
make e2e IMAGE=myimage:mytag                # test a specific tag
PORT=3001 make e2e IMAGE=myimage:mytag      # test on a non-default port
```

The e2e test:

1. Starts a scratch `postgres:16` container.
2. Starts the application container with `--network` + `-p` so the host can reach it.
3. Polls `GET /api/v1/health` until it returns 200 (or 60s timeout).
4. Asserts `GET /api/v1/health` is 200 + `application/json`.
5. Asserts `GET /` is 200 + `text/html` (the SolidJS dashboard, not Nest's default 404).
6. Asserts the dashboard's bundled JS asset (`/assets/index-*.js`) is 200 + `text/javascript`.

If any assertion fails, the script exits non-zero, prints the failing check, and tears down both containers.

### Running the pipeline test locally

The pipeline itself runs the e2e test as its final gate before pushing `latest`:

```
==> e2e test: boot container, GET / must serve the dashboard
  [1/4] starting scratch PostgreSQL on user-defined network
    postgres container up
    postgres ready
  [2/4] starting manifest-with-plugins:latest
    app container up (logs: docker logs mwp-e2e-app-…)
  [3/4] waiting for http://127.0.0.1:2099/api/v1/health (timeout: 60s)
    /api/v1/health is up
  [4/4] validating dashboard delivery
    GET /api/v1/health          → 200 (39 bytes, application/json)
    GET /                       → 200 (1826 bytes, text/html, contains dashboard title)
    GET /assets/index-…js        → 200 (118347 bytes, text/javascript)

PASS: manifest-with-plugins:latest
```

If the e2e test fails, the pipeline **still pushes the versioned tag** (e.g. `0.1.0.d48a57483`) but **skips the `latest` tag and exits non-zero**. The versioned tag is recoverable for inspection; `latest` only moves when the image is verified working.

## Architecture

```
manifest-plugins/
├── src/
│   ├── index.ts                  plugin registry (export const plugins = [...])
│   ├── host/
│   │   ├── snippet.ts            TS source pasted into the three Manifest files
│   │   ├── apply.ts              patcher (applyPatch + per-file wrappers + applyAll)
│   │   ├── cli.ts                `npm run apply` CLI
│   │   └── verify.ts             `npm run verify` CLI
│   └── plugins/
│       ├── anthropic-billing-header/  the flagship plugin (Claude Pro/Max OAuth)
│       └── default-policy/            default rate-limit + message-cap policy
├── scripts/
│   └── filter-plugins.mjs        post-build dist filter for plugin exclusion
├── tests/                        jest unit tests (40 tests, 100% coverage)
├── pipeline/
│   ├── Dockerfile.manifest       multi-stage Dockerfile (deps/build/prod-deps/runtime)
│   ├── build-and-publish.sh      end-to-end build + push pipeline
│   ├── e2e-test.sh               canonical dashboard-serves test (used by pipeline + local)
│   └── README.md                 operator guide (I just want the image)
├── examples/                     copy-pasteable fragments (Dockerfile, CI, build script)
├── docs/TROUBLESHOOTING.md       decision-tree FAQ
├── Makefile                      one-shot dev commands (make help)
└── config.example.json           template for the plugins config
```

### Two plugin kinds

A plugin implements one or both interfaces:

| Kind | Lifecycle | When called |
| --- | --- | --- |
| `RequestTransformPlugin` | per-request | every outgoing Anthropic request |
| `RequestPolicyPlugin` | config-time | once per process (in constructor / module load) |

```ts
// Per-request transform — e.g. inject OAuth headers
export interface RequestTransformPlugin {
  transformRequest(decision: RequestTransformDecision)
    : { url?: string; headers?: Record<string,string>; requestBody?: Record<string,unknown> }
    | undefined;
}

// Config-time policy — e.g. set concurrency / message-cap defaults
export interface RequestPolicyPlugin {
  getRateLimitPolicy(): { concurrencyMax: number | null; maxMessagesPerRequest: number | null } | null;
}
```

Plugin errors are **non-fatal** — the host catches and logs them and continues with the original request. Never throw to abort.

### The three patch sites

The apply tool injects one helper function + one call site per file:

| File | Helper function | Call site |
| --- | --- | --- |
| `provider-client.ts` | `applyRequestTransformPlugins(decision, current)` | the Anthropic branch's `return { ... }` |
| `proxy-rate-limiter.ts` | `getResolvedConcurrencyMax()` | the `CONCURRENCY_MAX` constant |
| `proxy.service.ts` | `getResolvedMaxMessagesPerRequest(config)` | the constructor's `maxMessagesPerRequest` assignment |

Each helper walks the plugin array, calls the appropriate hook, and returns the resolved value. If no plugin has an opinion, the helper falls through to the upstream default (env var or hardcoded constant).

## Releases

This repo has **three** release surfaces:

1. **GitHub Actions workflow** builds a manifest-with-plugins image on every push and on tag events. Manual runs are also available via `workflow_dispatch`. The image is published to `ghcr.io/josiahsiegel/manifest-with-plugins`.
2. **`latest` tag** moves only when the e2e test passes. The pipeline always pushes the versioned tag (e.g. `0.1.0.d48a57483`); `latest` is conditional.
3. **Changesets** are optional — the published artifact is the Docker image, not an npm package. Add a changeset if the change should appear in the changelog; omit otherwise.

The Docker image is the canonical artifact. Consumers should pin to a specific tag for reproducibility, falling back to `latest` for the most recent verified build.

## Contributing

PRs welcome. The bar is:

- **100% line + branch + statement + function coverage** (enforced by `jest.config.js`'s `coverageThreshold`).
- **No `as any`, `@ts-ignore`, or empty catch blocks** — these are blocked at lint time.
- **Idempotent patches only** — running `make apply` twice on the same checkout must be safe.
- **Fail-loud on upstream drift** — if your patch depends on an upstream anchor, the apply tool should report `upstream-drift` with a clear message rather than producing a broken patch.
- **Always run `make test` and `make e2e` before pushing** — the e2e test gates `latest` in CI.

To add a new plugin:

1. Create `src/plugins/<name>/plugin.ts` implementing `RequestTransformPlugin` and/or `RequestPolicyPlugin`.
2. Create `src/plugins/<name>/plugin.spec.ts` with 100% coverage.
3. Add the plugin instance to `plugins` in `src/index.ts`.
4. Add the class name to `PLUGIN_CLASS_NAMES` in `scripts/filter-plugins.mjs`.
5. Bump the version in `package.json` and `make build`.
6. Run `make test` and `make e2e`.

## License

[MIT](LICENSE)