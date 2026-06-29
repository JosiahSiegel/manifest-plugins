# Troubleshooting

Decision-tree FAQ. Find your symptom below; the answer is on the same branch.

## Build-time failures

### `npm run apply` reports `upstream-drift`

The apply tool couldn't find one of the byte-exact upstream anchors. This happens when upstream refactored one of the three target files.

**Fix:**

1. Check which file is drifting (`apply` prints the file path).
2. Pull the latest upstream: `git -C ../manifest pull`.
3. Open the failing file in `../manifest/packages/backend/src/routing/proxy/` and compare against the anchor defined in `src/host/snippet.ts`.
4. Update the `*_OLD` constant in `snippet.ts` to match the new upstream shape, and the `*_NEW` constant to the desired post-patch shape.
5. Re-run `make apply`.

If upstream genuinely restructured the file (e.g. split into multiple files), the fix is more involved — open an issue with the failing upstream commit.

### `docker build` fails with `forbidden path outside build context`

You forgot `--build-context manifest-plugins=...`. The Dockerfile expects a named build context.

**Fix:**

```bash
docker build \
  --build-context manifest-plugins=$(pwd) \
  -t manifest:dev \
  ../manifest
```

### Image builds but `make e2e` fails

The e2e test failed an assertion. Read the failure output:

| Failure | Likely cause |
| --- | --- |
| `GET /api/v1/health did not respond within 60s` | Backend didn't boot. Check `docker logs <container>` — usually a database connection error or missing env var. |
| `GET / → 404` | Frontend dist is missing from the image. Check `Dockerfile.manifest` — the build stage must include `npx turbo build --filter=manifest-frontend` and the runtime stage must `COPY packages/frontend/dist`. |
| `GET / content-type: application/json` | Serve-static middleware isn't routing the request. Check that `@nestjs/serve-static` is configured to serve `packages/frontend/dist`. |
| `GET /assets/index-…js → 404` | Vite asset hash mismatch. The dist's index.html references a hashed filename the dist doesn't ship. Re-run `npm run build` in the frontend. |

## Runtime failures

### Dashboard returns `404 Not Found` (Nest's default JSON)

The frontend dist is missing from the runtime image. This is the regression the e2e test was added to prevent — if you're seeing it in a published image, the e2e test was bypassed.

**Fix:**

1. Verify the image contains the frontend: `docker run --rm <image> ls /app/packages/frontend/dist/` (distroless has no ls, use `docker cp <container>:/app/packages/frontend/dist /tmp/inspect && ls /tmp/inspect`).
2. If the directory is missing, rebuild with the corrected `Dockerfile.manifest`.
3. If the directory is present, the issue is serve-static configuration — check the runtime logs.

### `docker pull ghcr.io/.../manifest-with-plugins:latest` returns `denied`

The image is private. Authenticate with a token that has `read:packages`:

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u <username> --password-stdin
```

For the public version, use `ghcr.io/josiahsiegel/manifest-with-plugins:latest` (the [repo settings](https://github.com/JosiahSiegel/manifest-plugins/settings) control visibility).

### Anthropic Pro/Max traffic still returns 429

The `AnthropicBillingHeaderPlugin` isn't running. Most common causes:

1. **`provider-client.ts` was reverted** by a fresh upstream `git pull`. Re-apply: `make apply`.
2. **The plugin is excluded** via `manifest-plugins.config.json`. Check that `"AnthropicBillingHeaderPlugin": true`.
3. **The classifier version is stale.** Anthropic rotates the `cc_version` they classify against; bump `MANIFEST_CC_VERSION` and rebuild.

Verify the plugin is actually loaded:

```bash
docker run --rm -p 2099:2099 <image> /nodejs/bin/node -e \
  'console.log(require("/app/node_modules/manifest-plugins/dist/index.js").plugins.map(p => p.constructor.name))'
# Expected: [ 'AnthropicBillingHeaderPlugin', 'DefaultPolicyPlugin' ]
```

## Development environment issues

### Tests fail on Windows with "Invalid regular expression"

CRLF got into your checkout. Run `git config core.autocrlf false` and re-clone. The repo's `.gitattributes` enforces LF line endings repo-wide.

### `npm install` fails with a `ts-node` peer-dep conflict

Use `npm install --legacy-peer-deps` (or `make install`, which passes this flag).

### Build fails with "unknown plugin"

Typo in `manifest-plugins.config.json`. The class name must match an exported plugin (validated against the registry at build time).

### `make e2e` fails on Windows with `D:/Program Files/Git/nodejs/bin/node`

Docker Desktop on Windows translates `/nodejs/bin/node` → `D:/Program Files/Git/nodejs/bin/node` (host path), which doesn't exist on the Windows host. This is a Docker Desktop limitation, not a code bug. The e2e test works correctly on Linux CI and on macOS/Linux Docker hosts.

For Windows local testing, use WSL2 or run the e2e test from within a Linux container.