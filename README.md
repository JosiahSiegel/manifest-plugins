# Manifest with Plugins

This Docker image runs Manifest with the included plugins.

Use it when you want the normal Manifest dashboard and API, plus the fixes in
this repo, without maintaining your own Manifest fork.

[![image build](https://img.shields.io/github/actions/workflow/status/JosiahSiegel/manifest-plugins/build-image.yml?branch=main&label=image%20build)](https://github.com/JosiahSiegel/manifest-plugins/actions/workflows/build-image.yml)
[![image](https://img.shields.io/badge/ghcr.io-manifest--with--plugins-blue)](https://github.com/JosiahSiegel/manifest-plugins/pkgs/container/manifest-with-plugins)
[![coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)]()

## What you get

- The upstream Manifest app, packaged as `ghcr.io/josiahsiegel/manifest-with-plugins`.
- Two built-in plugins: `AnthropicModelsFixPlugin`, `ShowAllRouterViewsPlugin`. Enable, disable, or add your own at runtime. See [Manage plugins](#manage-plugins). For private plugins (e.g. ones living in a private repo), use the external-plugins loader — see [External plugins](docs/EXTERNAL_PLUGINS.md).
- A build pipeline that only promotes `latest` after the image passes the end-to-end dashboard test.

## Quick start

Replace `DATABASE_URL` with your PostgreSQL connection string.

```bash
docker run --rm -p 2099:2099 \
  -e DATABASE_URL=postgresql://myuser:mypassword@host:5432/manifest \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  ghcr.io/josiahsiegel/manifest-with-plugins:latest
```

Open <http://localhost:2099>.

For other ports, set `PORT` and map accordingly. See [`pipeline/README.md`](pipeline/README.md) for the full image options.

## Manage plugins

Built-in plugins are auto-discovered at build time. To turn one off without rebuilding the image, use the CLI. State persists across restarts in `$MANIFEST_PLUGINS_STATE_FILE` (default `/app/data/plugin-state.json`).

```bash
# List installed plugins + their enabled state
npm run plugins:list

# Disable a plugin at runtime (no rebuild)
npm run plugins:disable -- show-all-router-views

# Re-enable it
npm run plugins:enable -- show-all-router-views

# Reset to built-in defaults
npm run plugins:reset
```

Precedence: the `MANIFEST_PLUGINS_DISABLED` env var wins over the persisted state (so a container restart with env-var-only config keeps working). The CLI writes the same file the HTTP admin API reads.

For a UI, the dashboard injects a "Plugins" panel. Open <http://localhost:2099>, scroll to the bottom of any page. The HTTP API (for curl or scripts) is at `http://localhost:3010/api/plugins/` (see [API reference](docs/PLUGIN_REGISTRY.md#admin-http-api)).

### Add a new plugin

```bash
npm run new-plugin -- my-header                  # default kind: transform
npm run new-plugin -- tier-router --kind=routing-override
```

The scaffolder writes `src/plugins/<name>/plugin.ts` + `plugin.spec.ts`. The auto-discoverer picks up new plugins on the next `npm run build`. No `src/index.ts` edits needed. Rebuild the image to ship.

## Test

```bash
make test           # unit tests
make e2e            # Docker end-to-end test
```

## Plugin authoring

For the full authoring guide, see [`docs/PLUGIN_AUTHORING.md`](docs/PLUGIN_AUTHORING.md). For the registry data model and runtime toggle surface, see [`docs/PLUGIN_REGISTRY.md`](docs/PLUGIN_REGISTRY.md). For troubleshooting, see [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).
