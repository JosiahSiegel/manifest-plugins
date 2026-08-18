# Custom provider model count fix (dashboard-transform plugin)

## What this plugin does

`custom-provider-model-count-fix` patches the "0 models" badge shown on
two Manifest dashboard pages for custom Anthropic-compatible providers
(e.g. `claude-proxy`):

1. The per-agent Connections page (`/harnesses/<agentName>/providers`)
   — the Models column of the providers table.
2. The ConnectionDetail page (`/providers/connections/<id>`) — the
   `Models:` field in the connection's detail card.

Both pages read model counts from the `/api/v1/providers` endpoint,
which queries `tenant_providers.cached_models.length`. For rows where
`provider = 'custom:<uuid>'` (the schema used by all custom providers),
`cached_models` is `NULL` — so the badge always reads `0`, even though
the custom provider is fully reachable and routes traffic correctly.

This plugin does NOT change the API response. It re-queries the router
picker endpoint (`/api/v1/routing/<agentName>/available-models`) from
the dashboard browser context, finds the custom provider's models
there, and rewrites the rendered DOM text from `0` to the real count.
It also adds a small `(patched by manifest-plugin)` subtitle next to
the count so the operator can tell the value was patched client-side.

For the ConnectionDetail page (no agent name in the URL), the plugin
queries the picker with the built-in `Playground` agent — the picker
returns ALL custom provider models regardless of which agent is named,
so the choice of agent only has to be one that exists.

## When to use

Use this plugin whenever you have at least one custom
Anthropic-compatible provider (or any custom provider configured via the
Manifest dashboard's custom-provider UI) and you want the Connections page
to display a non-zero model count for it.

Common cases:
- `claude-proxy` (the in-stack subscription OAuth proxy for Claude Code)
- Any third-party Anthropic-compatible proxy you point Manifest at
- Custom OpenAI-compatible providers that you also want a real count for

## When NOT to use

Disable the plugin once Manifest fixes the upstream bug in
`tenant-providers.controller.ts` and `provider.controller.ts` (the
patch is a 5-line change in each controller). Until then, keep it
enabled.

## What this plugin touches

Two DOM surfaces:

1. **Connections page** (`/harnesses/<agentName>/providers`): the
   `Models` column `<td>` of each row in the
   `<table class="data-table">`. A single
   `<small class="mwp-model-count-patch-note">` subtitle is appended
   to that same `<td>`.
2. **ConnectionDetail page** (`/providers/connections/<id>`): the
   `<span>` value node immediately following the
   `<span>Models:</span>` label. The detail page renders fields as
   inline `<span>` pairs (label + value), not as a table, so a
   separate walker handles it. The same
   `<small class="mwp-model-count-patch-note">` subtitle is appended
   inside the value `<span>`.

Nothing else in the dashboard DOM is mutated.

It does NOT:
- Remove or replace any upstream DOM nodes
- Disable any upstream scripts
- Inject CSS (no `<style>` tags, no `innerHTML` for user-controlled data)
- Modify the Manifest API responses
- Modify the Manifest backend code

## How to disable

Three ways, in increasing order of persistence:

1. **Runtime toggle (recommended for testing)**: visit
   `http://<manifest>/3010/api/plugins/custom-provider-model-count-fix` and
   `PATCH` with `{ "enabled": false }`. The change takes effect on the
   next page load.

2. **Admin UI**: open the dashboard, scroll to the "Plugins" panel at
   the bottom of any page, and click "Disable" on
   `custom-provider-model-count-fix`.

3. **Build-time toggle** (persistent across rebuilds): add to
   `manifest-plugins.config.json`:
   ```json
   { "plugins": { "custom-provider-model-count-fix": false } }
   ```
   Then run `npm run build`. The plugin's `enabledByDefault` flag is
   flipped to `false` in the compiled `dist/`.

## How to remove entirely

1. Delete `src/plugins/custom-provider-model-count-fix/`.
2. Run `npm run build`.
3. The auto-discoverer at boot will no longer find the plugin; the
   combined dashboard bundle will omit the IIFE; the operator's
   dashboard renders the upstream (broken) `0 models` display.

## How it interacts with the upstream fix

When (or if) Manifest ships the upstream fix, this plugin becomes a
no-op. The patch guard `if (currentText !== '0' && currentText !== '-' &&
currentText !== String(realCount)) continue;` skips rows that don't
match the broken state. So once the upstream fix lands, the plugin
silently becomes a no-op and you can remove it at your leisure.

## Limitations

- The plugin only patches the **two dashboard pages** described above.
  The underlying `/api/v1/providers` endpoint still returns
  `total_models: 0` and `cached_model_count: 0` for custom providers.
  If you have tooling that consumes `/api/v1/providers` programmatically,
  it'll see the broken values until upstream fixes the controller.
- On the ConnectionDetail page the patched value is the **total**
  custom-provider model count across all custom providers, not the
  count for the single connection being viewed. The detail page shows
  one connection at a time and has no per-connection join key, so the
  total is the closest approximation available. The single-custom-
  provider case (the common one for `claude-proxy`) renders correctly.
  If you have multiple custom providers and navigate to a detail page
  for one of them, the displayed count will be the sum — disabling
  the plugin restores the upstream `0` display.
- The plugin does NOT patch `model_counts` in the `/api/v1/providers`
  response (the pricing-cache-driven count map). That's a different
  field with different semantics and is correctly empty for custom
  providers (they're intentionally excluded from the pricing cache).
- The plugin re-queries on every page navigation and on every DOM
  mutation in the connections root. The re-query is cheap (one HTTP
  GET, no payload), and the script uses an idempotency marker
  (`dataset.mwpModelCountPatched`) so already-patched cells are skipped
  on re-runs.

## How to test

After deploying the updated `manifest-with-plugins` image:

1. Add a custom Anthropic-compatible provider via the dashboard.
2. Navigate to `/harnesses/<agentName>/providers`.
3. Verify the custom provider's row shows the real model count (e.g.
   `3`) and the `(patched by manifest-plugin)` subtitle is visible.
4. Click into the custom provider's connection card to open
   `/providers/connections/<id>`.
5. Verify the `Models:` field shows the real count and the same
   `(patched by manifest-plugin)` subtitle is visible.
6. Refresh the page on either view. The patch should re-apply
   (idempotently — the subtitle and count stay the same).
7. Disable the plugin via the admin UI and refresh. Both badges
   should revert to `0`.
