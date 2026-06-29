# Plugin authoring guide

How to add a new plugin to `manifest-plugins` and ship it inside the
`manifest-with-plugins` Docker image.

For the internal data model and runtime toggle surface, see
[`PLUGIN_REGISTRY.md`](PLUGIN_REGISTRY.md). For author onboarding with
the scaffolder, see "Quick start" below.

## Quick start

The scaffolder generates the plugin file pair with the right interface
stubs and TDD-friendly test layout. Pick a kebab-case name (the
registry discoverer only accepts that shape) and an optional kind.

```bash
# Default kind is `transform` (lowest risk — request-transform is the
# most common plugin shape).
npm run new-plugin -- my-header

# Pick a different kind explicitly.
npm run new-plugin -- tier-router --kind=routing-override
npm run new-plugin -- rate-cap --kind=policy
```

The scaffolder writes two files and prints next steps:

- `src/plugins/<name>/plugin.ts` — class + `static metadata` from a kind-aware template.
- `src/plugins/<name>/plugin.spec.ts` — three scaffolded assertions (metadata shape, `static metadata` field, constructability). Replace the placeholder tests with real ones.

Then implement, test, build:

```bash
# Edit plugin.ts to implement the no-op hook body.
# Replace the TODO test in plugin.spec.ts with real assertions.
npm test
npm run build
```

The build runs `tsc` + `filter-plugins.mjs`. No registry edits are
needed: the auto-discoverer at `src/registry/discover.ts` finds the
new plugin at the next process start.

## Plugin kinds

There are three plugin kinds, distinguished by lifecycle:

| Kind | When it fires | Hook signature | Use cases |
| --- | --- | --- | --- |
| `transform` | Per request, before the upstream HTTP fetch | `transformRequest(decision): RequestTransformResult \| undefined` | Mutate headers/body/URL on the outgoing call. The default kind. |
| `policy` | Once per process (cached) | `getRateLimitPolicy(): RateLimitPolicy \| null` | Set per-agent concurrency caps and per-request message-array caps. |
| `routing-override` | Per request, BEFORE the upstream router runs | `overrideRouting(ctx): RoutingOverrideResolvedRouting \| null` | Override routing decisions based on inbound HTTP headers or discovered models. |

A plugin can implement any combination. The discoverer inspects the
class's `static metadata.kind` and the host walks each array
independently — implementing multiple kinds on one class is allowed
but discouraged (each kind has its own error semantics; mixing them
makes failures harder to attribute).

## File layout convention

Each plugin lives in its own directory under `src/plugins/`:

```
src/plugins/<name>/
  plugin.ts         # exports the class + static metadata
  plugin.spec.ts    # tests (TDD first)
```

The auto-discoverer at `src/registry/discover.ts` walks this directory
on every process start. Adding a plugin requires ONLY dropping a new
`<name>/plugin.ts` file — `src/index.ts`, `package.json`, and the
build script pick it up automatically.

Failure modes (all throw `PluginDiscoveryError`):

- The file has no exported class.
- The class has no `static metadata: PluginMetadata`.
- The `metadata.id` duplicates another plugin's id.
- The class name duplicates another plugin's class name.
- The plugin file imports a type from a non-existent module.

## Discovery contract (what the auto-loader looks for)

```typescript
import type { PluginMetadata, RequestTransformPlugin } from '../..';

export const MY_HEADER_METADATA: PluginMetadata = Object.freeze({
  id: 'my-header',                       // unique across the registry
  name: 'My header',                      // human-readable
  version: '0.1.0',                       // semver
  description: 'Injects X-Foo header.',   // one-line summary
  kind: 'transform',                      // transform | policy | routing-override
});

export class MyHeaderPlugin implements RequestTransformPlugin {
  static readonly metadata: PluginMetadata = MY_HEADER_METADATA;

  transformRequest(decision): RequestTransformResult | undefined {
    // ...
  }
}
```

Required:

- Exactly one named class export (the discoverer throws on multiple).
- The class must declare `static readonly metadata: PluginMetadata`.
- `metadata.id` must be unique across the registry.
- The class name must be unique across the registry.
- `metadata.kind` must be one of `transform`, `policy`, `routing-override`.

## TDD checklist

Write tests FIRST. The scaffolder ships three scaffolded assertions;
replace them with real ones that exercise the plugin's behavior.

| Test category | What to assert |
| --- | --- |
| Metadata | `id`, `name`, `version`, `kind`, `description` are correct |
| Static field | `MyPlugin.metadata === MY_METADATA` (object identity) |
| Constructability | `new MyPlugin()` does not throw |
| Happy path | Each public hook returns the expected object for a typical input |
| Edge cases | Empty inputs, missing fields, malformed inputs |
| Error semantics | A plugin that throws MUST NOT abort the request; the host catches and logs |

The host's error semantics:

> Plugin errors MUST be non-fatal: the host catches and logs them and
> continues with the original request. Never throw to abort the
> request.

This applies to ALL three kinds. Plugins that throw inside a hook
are silent failures for the operator unless the host log line is
inspected.

## Build-time toggle (`manifest-plugins.config.json`)

Every plugin ships enabled by default. To disable a plugin without
removing its file, copy `config.example.json` to
`manifest-plugins.config.json` and set the class name to `false`:

```json
{
  "plugins": {
    "AnthropicBillingHeaderPlugin": true,
    "DefaultPolicyPlugin": true,
    "HeaderTierRouterPlugin": false
  }
}
```

Then rebuild (`npm run build`). The `filter-plugins.mjs` post-build
script rewrites `dist/index.js`'s registry to mark disabled plugins
`enabledByDefault: false`. See [`PLUGIN_REGISTRY.md`](PLUGIN_REGISTRY.md#runtime-toggle)
for the difference between build-time and runtime toggle.

## Runtime toggle (`setPluginEnabled`)

Operators can also flip a plugin's enabled state at runtime via the
`setPluginEnabled(id, enabled)` export — see
[`PLUGIN_REGISTRY.md`](PLUGIN_REGISTRY.md#runtime-toggle). The change
takes effect on the next call into that plugin's hook; it does NOT
survive a process restart unless persisted (e.g. via
`MANIFEST_PLUGINS_DISABLED` — see Wave 5 of the work plan).

## Versioning

`metadata.version` is free-form but should follow semver. Bump it
when:

- A new hook method is added (minor).
- A public field is renamed or removed (major).
- A bug fix lands that changes observable behavior (patch).

## Publishing (none — fork-only)

This repo does NOT publish to npm. The image build pipeline
(`pipeline/build-and-publish.sh`) bundles `dist/` into
`ghcr.io/josiahsiegel/manifest-with-plugins` via a named Docker build
context. Consumers `docker pull` the image — no plugin install step
required.

For per-deployment customization (e.g. adding a private plugin), fork
the repo, drop the plugin in `src/plugins/<name>/`, and rebuild the
image. The auto-discoverer picks it up with no registry edits.