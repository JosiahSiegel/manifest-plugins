# Manifest with Plugins

This Docker image runs Manifest with the included plugins.

Use it when you want the normal Manifest dashboard and API, plus the fixes in
this repo, without maintaining your own Manifest fork.

[![image build](https://img.shields.io/github/actions/workflow/status/JosiahSiegel/manifest-plugins/build-image.yml?branch=main&label=image%20build)](https://github.com/JosiahSiegel/manifest-plugins/actions/workflows/build-image.yml)
[![image](https://img.shields.io/badge/ghcr.io-manifest--with--plugins-blue)](https://github.com/JosiahSiegel/manifest-plugins/pkgs/container/manifest-with-plugins)
[![coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)]()

## What you get

- The upstream Manifest app, packaged as `ghcr.io/josiahsiegel/manifest-with-plugins`.
- `AnthropicBillingHeaderPlugin`, which adds the Anthropic billing header needed by Claude Pro/Max OAuth traffic.
- `DefaultPolicyPlugin`, which applies the default request policy shipped by this repo.
- A build pipeline that only promotes `latest` after the image passes the end-to-end dashboard test.

If you only want to run the image, start with [Quick start](#quick-start).
If you want build/publish details, see [`pipeline/README.md`](pipeline/README.md).

## Quick start

Replace `DATABASE_URL` with your PostgreSQL connection string.

```bash
docker run --rm -p 2099:2099 \
  -e DATABASE_URL=postgresql://myuser:mypassword@host:5432/manifest \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  ghcr.io/josiahsiegel/manifest-with-plugins:latest
```

Open <http://localhost:2099>.

## Ports

The image defaults to container port `2099`.

Use a different container port by setting `PORT` and mapping the same port:

```bash
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e DATABASE_URL=postgresql://myuser:mypassword@host:5432/manifest \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  ghcr.io/josiahsiegel/manifest-with-plugins:latest
```

Or map any host port to the default container port:

```bash
docker run --rm -p 8080:2099 \
  -e PORT=2099 \
  -e DATABASE_URL=postgresql://myuser:mypassword@host:5432/manifest \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  ghcr.io/josiahsiegel/manifest-with-plugins:latest
```

## Build the image yourself

Build a local image from a fresh upstream Manifest checkout:

```bash
bash pipeline/build-and-publish.sh
```

Build and push to your own registry:

```bash
REGISTRY=ghcr.io/your-org bash pipeline/build-and-publish.sh --push
```

Useful source options:

```bash
# Build against a specific Manifest checkout
bash pipeline/build-and-publish.sh --manifest-dir /path/to/manifest

# Build against a fork or pinned ref
bash pipeline/build-and-publish.sh --manifest-url https://github.com/your-org/manifest.git
bash pipeline/build-and-publish.sh --manifest-ref <commit-or-branch>
```

See [`pipeline/README.md`](pipeline/README.md) for the full pipeline options.

## Select plugins at build time

By default, every registered plugin is included. To disable one, create `manifest-plugins.config.json`:

```json
{
  "plugins": {
    "AnthropicBillingHeaderPlugin": true,
    "DefaultPolicyPlugin": false
  }
}
```

Then rebuild the package or image.

## Test

Run the unit tests:

```bash
make test
```

Run the Docker end-to-end test against `manifest-with-plugins:latest`:

```bash
make e2e
```

Run the same e2e test against a specific image or port:

```bash
make e2e IMAGE=ghcr.io/josiahsiegel/manifest-with-plugins:latest
PORT=8080 make e2e IMAGE=ghcr.io/josiahsiegel/manifest-with-plugins:latest
```

## Release behavior

The pipeline always builds a versioned image tag. It only promotes `latest`
after the built image passes the e2e dashboard test.

That test boots the image with PostgreSQL and verifies:

1. `GET /api/v1/health` returns `200`.
2. `GET /` serves the Manifest dashboard.
3. The dashboard asset referenced by the page is reachable.
4. The built image can require `manifest-plugins`, has `header-tier-router` installed/enabled, and its routing override returns `reason: "header-match"` for a header-tier fixture.

## Development notes

This repo patches a Manifest checkout during the image build. The patcher is
idempotent and fails loudly if upstream Manifest changes the expected source shape.

Common commands:

```bash
make build
make apply DIR=../manifest
make verify DIR=../manifest
```

For troubleshooting, see [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

## Plugin authoring

Adding a new plugin is a single command:

```bash
npm run new-plugin -- my-header                  # default kind: transform
npm run new-plugin -- tier-router --kind=routing-override
npm run new-plugin -- rate-cap --kind=policy
```

The scaffolder writes `src/plugins/<name>/plugin.ts` + `plugin.spec.ts` with the
right interface stubs. The registry auto-discovers plugins from `src/plugins/` on
every build — no `src/index.ts` edits needed.

For the full authoring guide, see [`docs/PLUGIN_AUTHORING.md`](docs/PLUGIN_AUTHORING.md).
For the registry data model and runtime toggle surface, see
[`docs/PLUGIN_REGISTRY.md`](docs/PLUGIN_REGISTRY.md).
