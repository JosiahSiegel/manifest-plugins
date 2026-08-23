# Custom provider model count fix (dashboard-transform plugin)

**Compatibility:** Manifest **6.12.0** (verified) — bundle hashes
`AgentProviders-DkdPn0fN.js`, `ConnectionDetail-nZtX-q3D.js`,
`ProviderConnectionsPage-DH0AOtaO.js`, `Routing-DcBwpf1-.js`. The DOM
walkers anchor on **semantic** markers (the literal `Models:` label,
the `/^custom:[0-9a-f-]{36}$/` UUID shape, and the table's 4th-`<td>`
position), not on hashed CSS class names, so the plugin survives minor
upstream bundle reshuffles. If a 6th surface appears in a future
Manifest release, add it explicitly in a follow-up plan rather than
generalising the walker.

## (a) The bug — what upstream renders wrong and why

As of Manifest 6.x, the per-tenant provider listing endpoint at
`/api/v1/providers` (`tenant-providers.controller.ts::listProviders`)
computes `cached_model_count` by reading
`tenant_providers.cached_models.length`. For rows where
`provider = 'custom:<uuid>'` (the schema used by every custom
Anthropic-compatible provider, e.g. `claude-proxy`), the
`cached_models` JSON column is `NULL`. The controller therefore falls
back to `total_models: 0`, and the dashboard renders `0 models` (or
`0` / `-` in the Models column) even though the proxy is fully
reachable and routes traffic correctly.

A second, related bug: the routing picker
(`/agents/<name>/routing` or `/harnesses/<name>/routing`) labels each
custom provider group with the raw `custom:<uuid>` string instead of
the human-readable provider display name, because the upstream bundle
never joins the display name onto the picker row.

The router-picker endpoint
(`/api/v1/routing/<agentName>/available-models`,
`ModelController::getAvailableModels`) **does** correctly return the
models for custom providers — it queries
`CustomProviderService.list(tenant_id)` and joins them in, populating
`provider_display_name` on rows where `provider.startsWith('custom:')`.
This plugin re-queries that endpoint from the dashboard browser
context, groups the results by `provider_display_name`, and rewrites
the rendered count / label in the DOM. The plugin does **not** modify
any API response.

## (b) What the plugin now patches

Five surfaces, each with its own walker and idempotency marker:

| Surface | Page | DOM node patched | Marker | Reason |
| --- | --- | --- | --- | --- |
| **S1** | `/harnesses/<agentName>/providers` (per-agent Connections list) | The Models `<td>` (4th cell) of each row in `table.data-table` whose 1st `<td>` matches a custom provider's display name and whose current text is `0` or `-`. | `data-mwp-model-count-patched="true"` (legacy) | Rewrites the broken `0` count to the real model count. |
| **S2** | Same page as S1 (agent-list subscription note) | The `<span>` inside the same row whose text matches `/models?:\s*\d+/i`. Only the numeric capture is rewritten; the surrounding `models: ` prefix is preserved. | `data-mp-count-fix="s2"` | Patches the secondary "models: N" subscription note that appears adjacent to the row. |
| **S3** | `/providers/connections/<id>` (ConnectionDetail) | The `<span>` value node immediately following the literal `<span>Models:</span>` label. | `data-mwp-model-count-patched="true"` (legacy, unchanged) | Patches the detail-card `Models: 0` field. Now scoped per-connection when a stable provider-name selector is found in the page header; falls back to the total with a different subtitle otherwise. |
| **S5** | `/providers` (connections-list page across all auth types) | Per-row badge in the connections list. | `data-mp-count-fix="s5"` | Same broken `0` count, different page. Strict-fallback: rows without a stable selector are skipped silently (no marker, no wrong value). |
| **S6** | `/agents/<name>/routing`, `/harnesses/<name>/routing`, or `/routing` (routing picker) | Text nodes whose content matches `/^custom:[0-9a-f-]{36}$/` are replaced with the provider display name. | `data-mp-count-fix="s6"` (set on the parent element) | Label-only relabel; **no** count badge is added inside the picker dropdown. |

Every patched count node (S1, S3, S5) also gets a single
`<small class="mwp-model-count-patch-note">` subtitle appended so the
operator can tell the value was patched client-side. S2 rewrites only
the digit inside the existing span (no subtitle — the span's own text
is the context). S6 is label-only and adds no subtitle.

The plugin does **not**:

- Remove or replace any upstream DOM nodes outside the five surfaces.
- Disable any upstream scripts.
- Inject CSS (no `<style>` tags, no `innerHTML` for user-controlled data).
- Modify the Manifest API responses or backend code.

## (c) Why no generic walker

A naive "find every `0` / `-` / empty text node and rewrite it"
walker is **unsafe** on this dashboard. The same broken-state tokens
appear in budget fields, latency fields, token-usage columns, quota
indicators, and pagination footers — rewriting any of those to a
model count would be a silent data-corruption bug visible to the
operator.

The plugin therefore only touches the **five known surfaces**, each
anchored by an explicit, semantic check:

- S1 / S5: the row's 1st `<td>` must match a known custom provider
  display name from the fetch, AND the 4th `<td>` must currently read
  `0`, `-`, or the already-patched count.
- S2: the span's text must match `/models?:\s*\d+/i`.
- S3: the label span's text must be exactly `Models:`.
- S6: the text node must match `/^custom:[0-9a-f-]{36}$/`.

Anything outside those anchors is left untouched. This is the
deliberate trade-off: less coverage, zero false positives.

## (d) Per-connection scoping on S3 + S5 residual limitation

### S3 subtitle differentiation

The ConnectionDetail page renders one connection at a time and has no
per-connection join key in the DOM. The plugin tries to scope the
count to **this** connection by:

1. Parsing the connection ID from the URL
   (`/providers/connections/<id>`).
2. Inspecting the page header (`h1`, `h2`, `[data-provider-name]`,
   `.provider-name`, `.connection-provider`) for a stable selector
   whose text matches a known custom provider display name.

If a match is found, the patched value is that provider's count and
the subtitle reads **`(patched: this connection)`**. If no match is
found, the plugin falls back to the **total** custom-provider model
count across all custom providers and the subtitle reads
**`(patched: all custom providers — scoping unavailable)`**. Under no
circumstances does the plugin paint a wrong count.

### S5 residual limitation

The `/providers` connections-list page has two possible upstream
layouts: a `table.data-table` (handled) and a card-based layout
(**not** handled, because no stable selector for the badge node was
identified at implementation time). The strict-fallback contract is:
**if no stable selector for a row is found, that row is skipped
silently** — no marker, no wrong value. The operator continues to see
the upstream `0` on that row. This is intentional: painting a wrong
count is worse than leaving the broken `0`. If a future Manifest
version exposes a stable selector for the card layout, add it in a
follow-up plan.

## (e) Operator prerequisites and caveats

- **`enabled_for_agent` must be TRUE** on the custom provider for the
  routing picker to return rows. If the provider is disabled for the
  agent you're viewing, `/available-models` returns no rows for it
  and the plugin has nothing to patch with — the badge stays at `0`.
- **30 s TTL disclosure.** The label map used by S6 is memoized
  per-URL with a **30-second TTL**. After adding a new custom
  provider, the routing picker label may show the raw `custom:<uuid>`
  for up to 30 seconds before the cache refreshes and the display
  name appears.
- **Marker-invalidation caveat.** The idempotency markers
  (`data-mwp-model-count-patched`, `data-mp-count-fix`) live on the
  DOM nodes themselves. A hard refresh clears the DOM and therefore
  the markers; if upstream data has changed in the meantime, the
  plugin re-patches with the fresh count on the next pass. The
  markers do **not** persist across page loads and are not a source
  of truth.

## (f) Install

### Option A — proper: rebuild the `manifest-with-plugins` image

From the `manifest-plugins` workspace:

```bash
cd /workspaces/manifest-plugins
npm run build
# then rebuild the image per pipeline/README.md
```

This produces a new `dist/plugins/custom-provider-model-count-fix/plugin.js`
and bakes it into the next `manifest-with-plugins` image build.

### Option B — fast iteration: `docker cp` into the running container

Useful when iterating on the plugin against a live stack:

```bash
cd /workspaces/manifest-plugins
npm run build
docker cp dist/plugins/custom-provider-model-count-fix/plugin.js \
  mnfst-manifest-1:/app/node_modules/manifest-plugins/dist/plugins/custom-provider-model-count-fix/plugin.js
./stack restart manifest
```

Then hard-refresh the dashboard. The `docker cp` path is **not**
persistent across container recreates — use Option A for anything
you want to keep.

## (g) Verification recipe

### Unit / jsdom

```bash
cd /workspaces/manifest-plugins
npx jest src/plugins/custom-provider-model-count-fix
```

Expected: **24 tests pass** (14 string-inspection + 10 live jsdom).

### Live in the running container

1. Confirm the API returns custom-provider rows:

   ```bash
   curl -s http://localhost:2099/api/v1/routing/Playground/available-models \
     | jq '.[] | select(.provider | startswith("custom:")) | {provider, provider_display_name}'
   ```

   You should see one row per model exposed by your custom provider,
   each with a non-empty `provider_display_name`.

2. Open the dashboard and walk the five surfaces:

   - **S1**: visit `/harnesses/<agentName>/providers`. The custom
     provider's row should show the real model count in the Models
     column with a `(patched by manifest-plugin)` subtitle.
   - **S2**: on the same page, the adjacent subscription note span
     should read `models: <realCount>` (not `models: 0`).
   - **S3**: click into the custom provider's connection card
     (`/providers/connections/<id>`). The `Models:` field should show
     the real count with subtitle `(patched: this connection)` (or
     `(patched: all custom providers — scoping unavailable)` if the
     header selector wasn't found).
   - **S5**: visit `/providers`. The custom provider's row badge
     should show the real count (or remain `0` if the row has no
     stable selector — see (d)).
   - **S6**: visit `/harnesses/<agentName>/routing`. The routing
     picker should list the custom provider under its display name,
     not `custom:<uuid>`.

3. Hard-refresh any of the above. The patch should re-apply
   idempotently — the subtitle and count stay the same, no duplicate
   subtitles appear.

4. Disable the plugin via the admin UI (or
   `npm run plugins:disable -- custom-provider-model-count-fix`) and
   refresh. All five surfaces should revert to the upstream display
   (`0` counts and `custom:<uuid>` labels).

## How to disable

Three ways, in increasing order of persistence:

1. **Runtime toggle (recommended for testing)**: visit
   `http://<manifest>:3010/api/plugins/custom-provider-model-count-fix`
   and `PATCH` with `{ "enabled": false }`. Takes effect on the next
   page load.
2. **Admin UI**: open the dashboard, scroll to the "Plugins" panel at
   the bottom of any page, and click "Disable" on
   `custom-provider-model-count-fix`.
3. **Build-time toggle** (persistent across rebuilds): add to
   `manifest-plugins.config.json`:

   ```json
   { "plugins": { "custom-provider-model-count-fix": false } }
   ```

   Then run `npm run build`.

## How it interacts with the upstream fix

When (or if) Manifest ships the upstream fix in
`tenant-providers.controller.ts::listProviders` (swap
`cached_models.length` for
`await customProviderRepo.models(uuid).length`), this plugin becomes a
no-op. The patch guards skip any row whose current text is not `0`,
`-`, or the already-patched count, so once the upstream fix lands the
plugin silently stops patching and can be removed at your leisure.

## Released in v0.2.0

This plugin version (0.2.0) ships with the v0.2.0 release of the [manifest-plugins](https://github.com/JosiahSiegel/manifest-plugins) package. The image `ghcr.io/josiahsiegel/manifest-with-plugins:v0.2.0` includes this plugin enabled by default. To disable at runtime, see `docs/PLUGIN_REGISTRY.md`.
