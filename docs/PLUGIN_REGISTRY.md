# Plugin registry

How the `manifest-plugins` package discovers, registers, and toggles
plugins at runtime. For how to author a new plugin, see
[`PLUGIN_AUTHORING.md`](PLUGIN_AUTHORING.md).

## What the registry exposes

The package `dist/index.js` exposes four registries:

| Export | Shape | Mutable? | Purpose |
| --- | --- | --- | --- |
| `installedPlugins` | `readonly ManifestPlugin[]` | No | All installed instances, regardless of enabled state |
| `plugins` | `readonly ManifestPlugin[]` | No (reassigned on `setPluginEnabled`) | Enabled instances only — what the host walks |
| `getInstalledPlugins()` | `readonly InstalledPluginMetadata[]` | No | Installed metadata with per-plugin `enabled` flag |
| `setPluginEnabled(id, enabled)` | `void` | Side-effect | Runtime toggle |

The `installedPlugins` and `plugins` arrays are `Object.freeze`d. The
`plugins` export is reassigned (not mutated) when `setPluginEnabled`
runs, so `require('manifest-plugins').plugins` always reflects the
current enabled state.

## How the host loads plugins

The image build pipeline (`pipeline/build-and-publish.sh`) does:

1. Apply the four host patches to a clean `mnfst/manifest` checkout.
2. Copy `dist/` into `node_modules/manifest-plugins/dist`.
3. Build the Docker image.

At runtime, the host snippets `require('manifest-plugins')` and walk
`require('manifest-plugins').plugins` in registration order:

- `provider-client.ts::applyRequestTransformPlugins(...)` — request-transform hook
- `proxy-rate-limiter.ts::getResolvedConcurrencyMax()` — config-time policy (concurrency)
- `proxy.service.ts::getResolvedMaxMessagesPerRequest(config)` — config-time policy (message cap)
- `proxy.service.ts::applyProxyRoutingOverridePlugins(...)` — pre-routing override

Each snippet:

1. Calls `require('manifest-plugins')` inside `try/catch` so the
   upstream source stays compilable when the plugins package is
   missing.
2. Iterates `plugins` in registration order.
3. Walks each plugin's method (transformRequest, getRateLimitPolicy,
   overrideRouting) when present.
4. Catches per-plugin errors so one broken plugin does not block the
   request.
5. Logs a warning (`[manifest-plugins] <name> failed: <msg>`) for any
   thrown error.

## Auto-discovery

The registry is built at module load by `src/registry/discover.ts`:

1. Walk `src/plugins/<name>/plugin.ts` (post-`tsc`: `dist/plugins/<name>/plugin.js`).
2. For each file, `require()` it and find the named class export.
3. Read `MyClass.metadata` as the `PluginMetadata` shape.
4. Throw `PluginDiscoveryError` on:
   - Missing or non-unique `metadata.id`
   - Missing or non-unique class name
   - Missing `static metadata` field
   - Missing `plugin.ts` in the expected shape

Adding a new plugin requires only dropping a new directory with a
`plugin.ts` file — `src/index.ts` picks it up automatically.

See `src/registry/discover.ts::discoverPlugins` for the implementation
and `src/registry/discover.spec.ts` for the contract tests.

## Build-time toggle (`manifest-plugins.config.json`)

Each plugin's `enabledByDefault` flag is set at build time by
`scripts/filter-plugins.mjs::annotateEnabledDefaults`. The script:

1. Reads `manifest-plugins.config.json` (if present) from the repo root.
2. Walks `dist/plugins/*/plugin.js` for `exports.<ClassName> = ...` declarations.
3. For each plugin the user disabled in the config, flips its
   `enabledByDefault: true` → `enabledByDefault: false` in `dist/index.js`.

The plugin CLASS still ships in `dist/`; only the default-enabled
state changes. Operators can re-enable a disabled plugin at runtime
via `setPluginEnabled` (see below).

To disable a plugin at build time:

```json
{
  "plugins": {
    "AnthropicBillingHeaderPlugin": true,
    "DefaultPolicyPlugin": true,
    "HeaderTierRouterPlugin": false
  }
}
```

Then rebuild: `npm run build`.

## Runtime toggle (`setPluginEnabled`)

The `setPluginEnabled(id, enabled)` export flips a plugin's enabled
state at runtime. The change takes effect on the next call into any
plugin hook; `require('manifest-plugins').plugins` is reassigned
to reflect the new state.

```typescript
import { setPluginEnabled } from 'manifest-plugins';

// Disable a plugin at runtime.
setPluginEnabled('header-tier-router', false);

// Re-enable it.
setPluginEnabled('header-tier-router', true);
```

The toggle is in-memory only. It does NOT survive a process restart.
For persistent runtime toggle, use the `MANIFEST_PLUGINS_DISABLED`
environment variable (see [`MANIFEST_PLUGINS_DISABLED`](#manifest_plugins_disabled-env-var) below).

### Idempotency contract

- Setting an already-set value is a no-op (no log noise, no plugin walk).
- Setting an unknown `id` is a silent no-op (the discoverer and build-time
  filter are the only sources of known ids).
- `getInstalledPlugins()` always returns every installed plugin with its
  current `enabled` flag.

### Use cases

- A/B testing a new plugin against existing traffic.
- Flipping a misbehaving plugin off without rebuilding the image.
- Canary rollout: enable for a percentage of processes via the env var.

## `getInstalledPlugins()` shape

```typescript
interface InstalledPluginMetadata extends PluginMetadata {
  readonly enabledByDefault: boolean;
  readonly enabled: boolean;          // current runtime state
}
```

`enabled` reflects the most recent `setPluginEnabled(id, …)` call (or
`enabledByDefault` if never toggled). Use this for introspection from
admin endpoints or CLI tools:

```typescript
import { getInstalledPlugins } from 'manifest-plugins';

const installed = getInstalledPlugins();
// [
//   { id: 'anthropic-billing-header', kind: 'transform', enabled: true, … },
//   { id: 'default-policy',          kind: 'policy',    enabled: true, … },
//   { id: 'header-tier-router',       kind: 'routing-override', enabled: false, … },
// ]
```

## Plugin error semantics

Every plugin hook is wrapped by the host in a `try/catch`. A plugin
that throws is logged and skipped — never aborts the request.

| Hook | Plugin throws | Host behavior |
| --- | --- | --- |
| `transformRequest` | Yes | Log warning, use the untransformed request |
| `getRateLimitPolicy` | Yes | Log warning, fall through to next plugin or env/default |
| `overrideRouting` | Yes | Log warning, fall through to next plugin or default routing |

This is a hard contract. Plugins that intentionally abort a request
must do so by returning a value that the host treats as "abort" (e.g.
a routing override that returns a 4xx-shaped object — not yet
supported in any built-in plugin) rather than throwing.

## Plugin metadata contract

Every plugin declares a `PluginMetadata` object reachable from its
class via `static metadata`:

```typescript
interface PluginMetadata {
  readonly id: string;                  // unique across registry
  readonly name: string;                // human-readable
  readonly version: string;             // semver
  readonly description: string;         // one-line summary
  readonly kind: PluginKind;            // 'transform' | 'policy' | 'routing-override'
}
```

The runtime toggle is keyed by `metadata.id`. The build-time filter is
keyed by class name (because that is what `manifest-plugins.config.json`
uses). Both must be unique across the registry.

## `MANIFEST_PLUGINS_DISABLED` env var

Operators can disable a plugin at process start without rebuilding the
image by setting the env var:

```bash
# Disable a single plugin.
MANIFEST_PLUGINS_DISABLED=header-tier-router docker run …

# Disable multiple plugins (comma-separated, no spaces required).
MANIFEST_PLUGINS_DISABLED=header-tier-router,experimental-foo docker run …
```

### Contract

- **Format**: comma-separated list of plugin ids (`metadata.id`). Empty,
  unset, or whitespace-only value → no plugins disabled.
- **Whitespace**: each segment is `.trim()`ed before parsing; doubled or
  trailing commas produce empty segments that are dropped silently.
- **Duplicates**: deduped, preserving first-appearance order. `a,b,a,c,b`
  becomes `[a, b, c]`.
- **Unknown ids**: applied anyway (the host treats unknown ids as a
  misconfiguration, not as an error). The `setPluginEnabled(id, false)`
  call is invoked; if the id is not in the registry, the call is a
  no-op on the next `plugins` walk.
- **Timing**: the env value is read once per host snippet at module
  load. The call sits between the `require('manifest-plugins')` guard
  and the plugin walk, so the plugin walk already reflects the
  env-var-driven disable state.
- **Survives restart**: yes (process-level). The value lives in the
  process's environment, not in any persisted file.

### Host snippet wiring

Every pasted host snippet (provider-client, proxy-rate-limiter,
proxy.service, the routing-override hook) calls:

```typescript
try {
  const toggle = (require('manifest-plugins')).applyDisabledListFromEnv;
  if (typeof toggle === 'function') {
    toggle(process.env['MANIFEST_PLUGINS_DISABLED']);
  }
} catch {
  // env-toggle is best-effort; never block a request on it.
}
```

The host tolerates three failure modes without blocking the request:

1. `manifest-plugins` is missing (upstream without the plugins package).
2. The package exports no `applyDisabledListFromEnv` (older host build).
3. The call itself throws (defensive `try/catch`).

### Verifier sentinel

`src/host/verify.ts` checks that both patched files contain:

1. The literal `applyDisabledListFromEnv` reference (the helper call).
2. The literal `process.env['MANIFEST_PLUGINS_DISABLED']` reference
   (the env-var name).

If either sentinel is missing, `npm run verify` reports drift and the
patch needs to be re-applied. This guards against fork maintenance that
strips the env-var wiring and silently loses operator toggle.

### Use cases

- **Disable a misbehaving plugin** without rolling back the image:
  `docker run -e MANIFEST_PLUGINS_DISABLED=experimental-foo …`.
- **Canary rollout**: enable for a percentage of processes via
  orchestrator-level env-var injection.
- **Per-environment policy**: staging runs with one disable list, prod
  runs with another — no rebuild, just env-var differences.

### API surface

The host package exports the env-parse helpers so non-snippet callers
can reuse them:

```typescript
import {
  applyDisabledListFromEnv,
  parseDisabledList,
} from 'manifest-plugins';

// Pure parse — no side effects.
const ids = parseDisabledList(process.env.MANIFEST_PLUGINS_DISABLED);

// Side-effecting — disables each parsed id via setPluginEnabled.
const applied = applyDisabledListFromEnv(process.env.MANIFEST_PLUGINS_DISABLED);
```

See `src/host/env-toggle.ts` for the implementation and
`src/host/env-toggle.spec.ts` for the contract tests.

## Lifecycle summary

| Stage | Mechanism | Survives restart? |
| --- | --- | --- |
| Module load | `src/registry/discover.ts` walks `src/plugins/*/plugin.ts` | n/a |
| `npm run build` | `scripts/filter-plugins.mjs` rewrites `dist/index.js` `enabledByDefault` | Yes (image ships with the toggle) |
| `setPluginEnabled(id, …)` | Reassigns `plugins` export in memory | No |
| `MANIFEST_PLUGINS_DISABLED` env | Host snippet calls `applyDisabledListFromEnv(...)` at module load (see [`MANIFEST_PLUGINS_DISABLED` env var](#manifest_plugins_disabled-env-var)) | Yes (process-level) |
| Admin HTTP endpoint | (Not yet implemented — gated on auth model choice) | Yes (would persist via sidecar file) |

For sustained per-deployment customization, the recommended path is
to fork the repo, add the plugin under `src/plugins/<name>/`, and
rebuild the image — the auto-discoverer picks it up with no registry
edits.