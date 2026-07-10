# pipeline/

End-to-end build pipeline that produces a **published Docker image** with the manifest-plugins host pre-installed. Consumers `docker pull` and run it — no apply step required.

## What this is

`build-and-publish.sh` + `Dockerfile.manifest` + `e2e-test.sh` form a complete pipeline that:

1. Clones (or uses) a Manifest source tree.
2. Builds the manifest-plugins package.
3. Applies the plugin host to all three target files.
4. Builds a Docker image with the plugins baked in.
5. **Runs an end-to-end test** (boots the image, asserts the dashboard serves at `GET /`).
6. Tags the image as `latest` — only if the e2e test passed.
7. Optionally pushes the image to a registry.

The image is `manifest-with-plugins:<tag>` (distinct from the plain `manifest` image) and is a drop-in replacement — `docker run` it exactly like the upstream image.

## Usage

### Pull the pre-built image (no build required)

```bash
docker pull ghcr.io/josiahsiegel/manifest-with-plugins:latest

docker run --rm -p 2099:2099 \
  -e DATABASE_URL=postgresql://myuser:mypassword@host:5432/manifest \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  ghcr.io/josiahsiegel/manifest-with-plugins:latest
```

Open `http://localhost:2099` to access the dashboard. To use a different container port, set `PORT` and map the same port:

```bash
docker run --rm -p 38238:38238 \
  -e PORT=38238 \
  -e DATABASE_URL=postgresql://myuser:mypassword@host:5432/manifest \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  ghcr.io/josiahsiegel/manifest-with-plugins:latest
```

Or map a different host port to the default container port:

```bash
# host 8080 → container 2099
docker run --rm -p 8080:2099 \
  -e PORT=2099 \
  -e DATABASE_URL=postgresql://myuser:mypassword@host:5432/manifest \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  ghcr.io/josiahsiegel/manifest-with-plugins:latest
```

### Build it yourself

```bash
# Build only (no push) — image lands as manifest-with-plugins:<tag>
bash pipeline/build-and-publish.sh

# Build + push to a registry
REGISTRY=ghcr.io/your-org bash pipeline/build-and-publish.sh --push
```

### Options

| Flag | Env var | Default | Purpose |
| --- | --- | --- | --- |
| `--manifest PATH` | `MANIFEST_PATH` | _(clone fresh)_ | Path to a Manifest checkout (clone happens if absent) |
| `--manifest-url URL` | `MANIFEST_URL` | `https://github.com/mnfst/manifest.git` | Git URL to clone when no local checkout exists |
| `--tag TAG` | _(none)_ | `<plugins-ver>.<manifest-sha>` | Override the image tag |
| `--registry REGISTRY` | `REGISTRY` | _(none)_ | Image registry (e.g. `ghcr.io/your-org`) |
| `--push` | _(none)_ | `false` | Push to the registry after build |
| `--platform PLATFORM` | `PLATFORM` | `linux/amd64` | Docker buildx platform |
| `--no-cache` | _(none)_ | `false` | Disable Docker build cache |

### Run the pipeline as a GitHub Action

The [`../.github/workflows/build-image.yml`](../.github/workflows/build-image.yml) workflow runs the same pipeline on GitHub's CI and publishes the image to `ghcr.io/josiahsiegel/manifest-with-plugins`.

**Triggers:**
- `workflow_dispatch` (manual): go to **Actions** → **"Build Manifest image with plugins"** → **"Run workflow"** → optionally set inputs.
- `push tags: v*`: every semver tag (e.g. `git tag v0.2.1 && git push --tags`) auto-builds a versioned image.

**Resulting image:** `ghcr.io/josiahsiegel/manifest-with-plugins:<tag>` (and `latest` if the e2e test passes).

## How the image is gated

`latest` is **only** pushed when the e2e test passes. The versioned tag (e.g. `0.1.0.d48a57483`) is always pushed.

```
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
==> pushing 'latest' tag (e2e test passed)
```

If any assertion fails, the pipeline prints the failure, pushes only the versioned tag, skips the `latest` push, and exits non-zero:

```
==> SKIPPING 'latest' tag push (e2e test failed — see log above)
    consumers will pull the versioned tag instead
```

## End-to-end test

The e2e test (`pipeline/e2e-test.sh`) is a sibling script — same logic runs locally (`make e2e`) and in CI. It boots the image against a scratch PostgreSQL and asserts:

1. `GET /api/v1/health` → 200, `application/json`
2. `GET /` → 200, `text/html` containing `<title>Manifest</title>`
3. `GET /assets/<filename>` → 200, `application/javascript` or `text/css`
4. `docker exec <app> node -e ...` can require `/app/node_modules/manifest-plugins`, sees the `show-all-router-views` plugin installed/enabled, and confirms `getDashboardScript()` returns a non-empty string for that plugin against an in-memory fixture

The first assertion catches backend boot regressions; the second catches missing-frontend-dist regressions (the original 404 bug); the third catches Vite asset-pipeline / hash-mismatch regressions; the fourth catches plugin packaging/runtime-discovery regressions where the image serves the dashboard but boots with an empty plugin registry.

You can run it independently:

```bash
make e2e                                    # test manifest-with-plugins:latest
make e2e IMAGE=myimage:mytag                # test a specific tag
PORT=3001 make e2e IMAGE=myimage:mytag      # test on a non-default port
```

## Selecting a subset of plugins

The plugins repo supports build-time plugin exclusion via `manifest-plugins.config.json` (at the root of the plugins repo). The pipeline's `npm run build` step runs the post-build filter, which rewrites `dist/index.js` accordingly.

For example, to ship an "Anthropic-billing-only" image (no Anthropic models fix):

```json
{
  "plugins": {
    "AnthropicBillingHeaderPlugin": true,
    "AnthropicModelsFixPlugin": false
  }
}
```

## Cleaning up old images

The default image tag includes a short git SHA of the Manifest checkout, so each pipeline run produces a new tag rather than overwriting. To reclaim disk space:

```bash
docker image prune -f
```

The pipeline never auto-deletes — run it freely without losing old images.