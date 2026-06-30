# External plugins

`manifest-plugins` ships two built-in plugins (`default-policy`,
`header-tier-router`). This document explains how to add **external plugins**:
plugins that live in separate repositories and are fetched at build/test time
into `src/plugins/<name>/` so the existing auto-discovery picks them up.

External plugins are useful when:

- The plugin's source shouldn't live in the public `manifest-plugins` repo
  (private business logic, sensitive billing integration, licensed code, etc.)
- The plugin is large enough that vendoring it would bloat the core repo
- The plugin is owned by a different team and has its own release cadence
- You want to ship a plugin as a commercial add-on

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│ external-plugins.json   (manifest: list of plugin entries)   │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ scripts/fetch-external-plugins.mjs                           │
│   - reads external-plugins.json                              │
│   - for each entry, runs `git clone --depth 1 --branch <ref>  │
│     <source> <tmp>`                                         │
│   - copies src/plugins/<name>/ from the clone into the      │
│     local src/plugins/<name>/                               │
│   - runs the plugin's vendor-hash-wasm.mjs if present       │
│   - cleans up                                               │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ src/plugins/<name>/   (materialized from external repo)       │
│   - same layout as built-in plugins                          │
│   - auto-discovered at build time by src/registry/discover.ts│
└──────────────────────────────────────────────────────────────┘
```

The fetch runs in two places:

1. **`npm run build`** — before the existing build steps (tsc, filter-plugins,
   vendor-hash-wasm, etc.) so the plugin is in place when auto-discovery scans.
2. **`npm test`** — as a Jest `globalSetup` so the plugin's spec files are
   present alongside built-in plugin specs.

The local `src/plugins/<name>/` is **gitignored** (see `.gitignore`) so it
never gets accidentally committed to the core repo.

## Plugin manifest schema

`external-plugins.json` is a single JSON object with a `plugins` array.
Each entry has:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | The plugin directory name under `src/plugins/`. Must be unique. Must match the plugin's `metadata.id` in its own `plugin.ts`. |
| `source` | string | yes | Git URL. SSH (`git+ssh://git@github.com/owner/repo.git`) or HTTPS (`https://...`). HTTPS+token is auto-substituted when `GIT_TOKEN` env is set or `gh auth` is available. |
| `ref` | string | yes | Git ref to pin: tag (`v1.2.3`), branch (`main`), or commit SHA. Tags recommended for reproducible builds. |
| `private` | boolean | no | `true` for private repos. Affects auth flow logging only; the fetch works the same either way. |
| `enabledByDefault` | boolean | no | Whether the plugin should be enabled by default in the runtime registry. The plugin runtime always wins over this via the `MANIFEST_PLUGINS_DISABLED` env var or the persisted state file. |

### Example: a private billing plugin

```jsonc
{
  "plugins": [
    {
      "name": "my-private-plugin",
      "source": "git+ssh://git@github.com/myorg/my-private-plugin.git",
      "ref": "v1.0.0",
      "private": true,
      "enabledByDefault": true
    },
    {
      "name": "my-public-plugin",
      "source": "https://github.com/myorg/my-public-plugin.git",
      "ref": "main",
      "enabledByDefault": false
    }
  ]
}
```

## External plugin source repo layout

The external plugin's repo MUST follow the same convention as a built-in
plugin's directory. The fetch looks for the plugin in this order:

1. `src/plugins/<name>/` (preferred — matches built-in layout)
2. `src/<name>/`
3. `<name>/`
4. Repo root (fallback for single-plugin repos)

The plugin's `plugin.ts` must export a class with the standard `metadata`
static + `transformRequest` method (see `docs/PLUGIN_AUTHORING.md`). If it
has its own `vendor-hash-wasm.mjs` (because it bundles `hash-wasm`), the
fetch script runs that script automatically after copying.

## Adding a new external plugin

1. **Publish your plugin to a separate repo.** It must export a
   `RequestTransformPlugin` class (or `RequestPolicyPlugin` /
   `RoutingOverridePlugin`, depending on the plugin kind) following
   `docs/PLUGIN_AUTHORING.md`.

2. **Tag a release.** Tags are the recommended way to pin external plugins
   so builds are reproducible. `v1.0.0` is fine; semver preferred.

3. **Add an entry to `external-plugins.json`** in the `manifest-plugins`
   repo:

   ```jsonc
   {
     "plugins": [
       {
         "name": "my-plugin",
         "source": "git+ssh://git@github.com/myorg/my-plugin.git",
         "ref": "v1.0.0",
         "private": true,
         "enabledByDefault": true
       }
     ]
   }
   ```

4. **Verify locally:**

   ```bash
   npm run fetch:external-plugins   # confirm the fetch works
   ls src/plugins/                  # confirm the plugin materialized
   npm run build                    # full build
   npm test                         # full test suite
   ```

5. **Open a PR.** The CI will run `npm test` (which auto-fetches external
   plugins via the Jest globalSetup). Build artifacts will include the
   plugin. The Dockerfile (if any) must support the SSH or HTTPS+token
   auth used by the entry.

## Authentication

| Environment | Mechanism |
| --- | --- |
| Developer machine with SSH key | SSH (default). Works out of the box if `~/.ssh/id_rsa` (or equivalent) is configured. |
| CI / sandbox without SSH key | Set `GIT_TOKEN` env var, OR have `gh auth` authenticated. The fetch substitutes the token into HTTPS URLs automatically. |
| CI with deploy key | SSH. Add the deploy key's fingerprint to the external repo's `Settings → Deploy keys`. |

For private repos in CI without SSH keys, the recommended approach is:

```yaml
env:
  GIT_TOKEN: ${{ secrets.GH_PAT }}
```

The token needs `repo` scope on the org/owner. For org-owned repos with SAML
enforcement, the token must be SSO-authorized.

## CI considerations

The `fetch-external-plugins` step runs in:

- **Build CI** (`npm run build`) — must have `GIT_TOKEN` or `gh auth` or
  SSH access to every external plugin's source repo
- **Test CI** (`npm test`) — same requirement

If a CI environment can't access an external repo, the build will fail.
Either grant access or temporarily remove the entry from `external-plugins.json`.

## Removing an external plugin

1. Remove the entry from `external-plugins.json`.
2. Delete the local `src/plugins/<name>/` directory (it was already
   gitignored).
3. Run `npm run build` to confirm no other plugin references it.

## Migrating an external plugin to be built-in

When an external plugin is ready to be vendored into the public repo:

1. Copy its source from the external repo into `src/plugins/<name>/`.
2. Remove the entry from `external-plugins.json`.
3. Add tests under `tests/` if it doesn't have them yet.
4. Open a PR with the moved source.

The reverse (moving a built-in plugin out to a private repo) is the same
process in reverse: copy the source into a new private repo, delete
`src/plugins/<name>/` from the core repo, and add an `external-plugins.json`
entry.

## Troubleshooting

**"fetch-external-plugins: failed to clone X"**

- Check `git ls-remote <source>` works manually with your auth.
- If using SSH: ensure the SSH key is added to the external repo.
- If using HTTPS: set `GIT_TOKEN` or run `gh auth login` first.

**"fetch-external-plugins: could not locate plugin dir for X"**

- The external repo must contain the plugin at one of: `src/plugins/<name>/`,
  `src/<name>/`, `<name>/`, or root. Check the repo structure.

**Plugin tests fail with "Cannot find module './plugin'"**

- The fetch didn't run before tests. Make sure
  `scripts/jest-global-setup.js` is wired into `jest.config.js` (it should
  be) and that `external-plugins.json` has the plugin entry.

**Build works locally but fails in CI**

- CI needs `GIT_TOKEN` env var or `gh auth` setup. Add to the CI workflow.

## See also

- `docs/PLUGIN_AUTHORING.md` — how to write a plugin (the contract an
  external plugin must implement)
- `docs/PLUGIN_REGISTRY.md` — how plugins are registered and discovered
  at runtime
- `src/registry/discover.ts` — the auto-discovery implementation
- `scripts/fetch-external-plugins.mjs` — the fetch implementation