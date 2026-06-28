# Pipeline

End-to-end build pipeline that produces a **published Docker image** with the manifest-plugins host pre-installed. Consumers `docker pull` the image and run it — no apply step required on their end.

## What this is

`build-and-publish.sh` and the accompanying `Dockerfile.manifest` form a complete pipeline that:

1. Clones (or uses) a Manifest source tree.
2. Builds the manifest-plugins package (this repo) so the apply CLI and runtime `dist/` are available.
3. Applies the plugin host to all three target files in the Manifest checkout.
4. Builds a Docker image with the plugins baked in.
5. Runs a smoke test in the built image to confirm the host functions are present.
6. Optionally pushes the image to a registry.

The image is named `manifest-with-plugins:<tag>` (distinct from any plain `manifest` image) and is published as a drop-in replacement — `docker run` it exactly like upstream's image.

## Prerequisites

- Docker 20.10+ with buildx enabled
- Node 20+ and npm
- Git
- A registry to push to (optional; `ghcr.io/your-org` works out of the box if you log in via `docker login`)

## Usage

### Build only (no push)

```bash
# Run from the plugins repo root
./pipeline/build-and-publish.sh
```

This:
- Clones `mnfst/manifest` to `../manifest` (or uses the existing checkout if present)
- Builds the plugins package
- Applies the plugin host to all three target files
- Builds the Docker image as `manifest-with-plugins:<tag>` (default tag: `<plugins-version>+<manifest-sha>`)
- Runs a smoke test in the built image
- Prints usage instructions

### Build and push to a registry

```bash
REGISTRY=ghcr.io/your-org ./pipeline/build-and-publish.sh --push
```

This additionally pushes:
- `ghcr.io/your-org/manifest-with-plugins:<tag>`
- `ghcr.io/your-org/manifest-with-plugins:latest`

You need to be logged in to the registry first: `docker login ghcr.io`.

### Options

```text
--manifest PATH       Path to the Manifest checkout (default: ../manifest)
--tag TAG             Image tag (default: <plugins-version>+<manifest-sha>)
--registry REGISTRY   Image registry (e.g. ghcr.io/your-org)
                      If unset, image is built but not pushed.
--push                Push to the registry after build
--platform PLATFORM   Docker buildx platform (default: linux/amd64)
--no-cache            Disable Docker build cache
-h, --help            Show this help
```

All options also accept env-var equivalents (`MANIFEST_PATH`, `REGISTRY`, `PLATFORM`).

## What the image contains

A complete Manifest backend with the three host queries injected:

- **`provider-client.ts`** — `applyRequestTransformPlugins(decision, current)` runs on every outgoing Anthropic request. The `AnthropicBillingHeaderPlugin` adds the `x-anthropic-billing-header` so Claude Pro/Max OAuth traffic doesn't get 429'd.
- **`proxy-rate-limiter.ts`** — `getResolvedConcurrencyMax()` runs once at module load. The `DefaultPolicyPlugin` returns `{concurrencyMax: 10, maxMessagesPerRequest: null}` (10 concurrent requests per agent, no message cap).
- **`proxy.service.ts`** — `getResolvedMaxMessagesPerRequest(this.config)` runs once at constructor time. The `DefaultPolicyPlugin`'s `maxMessagesPerRequest: null` means "no cap" (Infinity).

All three hosts are **fail-safe**: if `require('manifest-plugins')` throws (e.g. the package was somehow excluded from the build), the host catches the error and the request continues without plugin behavior.

## Selecting a subset of plugins

The plugins repo supports build-time plugin exclusion via `manifest-plugins.config.json` (at the root of the plugins repo). When the pipeline runs `npm run build` (step 2), the post-build filter (`scripts/filter-plugins.mjs`) reads the config and rewrites `dist/index.js` accordingly.

For example, to ship an "Anthropic-billing-only" image (no DefaultPolicyPlugin):

```json
{
  "plugins": {
    "AnthropicBillingHeaderPlugin": true,
    "DefaultPolicyPlugin": false
  }
}
```

With this config in place before running `build-and-publish.sh`, the resulting image has only the billing-header plugin in `dist/index.js`. The default policy is the upstream hardcoded values (concurrency = 10, message cap = 1000).

## Verifying the image

After the pipeline completes, run a smoke test:

```bash
docker run --rm --entrypoint='["node","-e"]' manifest-with-plugins:<tag> \
  'const fs = require("fs");
   const host = fs.readFileSync("/app/packages/backend/dist/routing/proxy/provider-client.js", "utf-8");
   const rateLimiter = fs.readFileSync("/app/packages/backend/dist/routing/proxy/proxy-rate-limiter.js", "utf-8");
   const proxyService = fs.readFileSync("/app/packages/backend/dist/routing/proxy/proxy.service.js", "utf-8");
   const ok = host.includes("applyRequestTransformPlugins") &&
             rateLimiter.includes("getResolvedConcurrencyMax") &&
             proxyService.includes("getResolvedMaxMessagesPerRequest");
   if (!ok) { console.error("FAIL"); process.exit(1); }
   const p = require("/app/node_modules/manifest-plugins/package.json");
   console.log("OK:", p.name, p.version);
   console.log("plugins:", require("/app/node_modules/manifest-plugins/dist/index.js").plugins.map(x => x.constructor.name));'
```

Expected output:

```
OK: @josiahsiegel/manifest-plugins 0.2.0
plugins: [ 'AnthropicBillingHeaderPlugin', 'DefaultPolicyPlugin' ]
```

(The plugin list reflects whatever's in `manifest-plugins.config.json` at build time. With `DefaultPolicyPlugin: false`, only `AnthropicBillingHeaderPlugin` is listed.)

## Running the image

```bash
# Local
docker run --rm -p 3001:3001 manifest-with-plugins:<tag>

# From a registry
docker run --rm -p 3001:3001 ghcr.io/your-org/manifest-with-plugins:<tag>
```

Set your `.env` / `DATABASE_URL` / `BETTER_AUTH_SECRET` etc. via `-e` flags or a `docker run --env-file`.

## Cleaning up old images

The default image tag includes a short git SHA of the Manifest checkout (`<plugins-version>+<manifest-sha>`), so each pipeline run produces a new tag rather than overwriting. To reclaim disk space:

```bash
# List local manifest-with-plugins images
docker images manifest-with-plugins

# Remove old ones
docker image prune -f
```

The script never auto-deletes — you can run it freely without losing old images.

## File layout

```
pipeline/
├── Dockerfile.manifest         # The buildx target (used by build-and-publish.sh)
├── build-and-publish.sh        # The end-to-end entry point
└── README.md                   # This file
```

The `Dockerfile.manifest` is a **complete, drop-in replacement** for upstream's `docker/Dockerfile`. It produces a distroless-based image with the plugin host pre-baked.

## Why a separate `pipeline/` directory?

The plugins repo has three layers:

| Layer | Purpose | Audience |
|---|---|---|
| `src/` | Plugin implementations + apply tool source | Plugin authors, contributors |
| `examples/` | Copy-pasteable fragments (Dockerfile snippet, CI workflow, build script) | Existing Manifest users adding plugins |
| `pipeline/` | End-to-end script + full Dockerfile that produces a published image | Operators who want a pre-built image |

`pipeline/` is the "I just want the image" path. `examples/` is the "I'm integrating plugins into my own setup" path. Both share the same underlying tools (`scripts/filter-plugins.mjs`, `src/host/apply.ts`, etc.).