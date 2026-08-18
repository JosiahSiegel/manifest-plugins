/**
 * CustomProviderModelCountFixPlugin — dashboard-transform plugin that
 * patches the "0 models" badge shown on the Manifest Connections page
 * (`/harnesses/<agentName>/providers`) for custom Anthropic-compatible
 * providers (e.g. `claude-proxy`).
 *
 * ## Background — the upstream bug being worked around
 *
 * As of Manifest 6.x, the per-tenant provider listing endpoint at
 * `/api/v1/providers` (`tenant-providers.controller.ts::listProviders`)
 * computes `cached_model_count` by reading
 * `tenant_providers.cached_models.length`. For rows where
 * `provider = 'custom:<uuid>'` the `cached_models` JSON column is
 * `NULL`, so the upstream code (per the relevant controller) falls
 * back to `total_models: 0` and the dashboard renders `0 models` /
 * `0` in the Models column even though the proxy / custom provider
 * is fully reachable and routes traffic correctly.
 *
 * The router-picker endpoint (`/api/v1/routing/<agentName>/available-models`,
 * `ModelController::getAvailableModels`) DOES correctly return the
 * models for custom providers — it queries
 * `CustomProviderService.list(tenant_id)` and joins them in. So we
 * re-query that endpoint from the dashboard, group the results by
 * `provider_display_name` (which is only set on rows where
 * `provider.startsWith('custom:')`), and rewrite the rendered count.
 *
 * ## What this plugin touches
 *
 * Strictly the Models-column `<td>` of each row in the
 * `table.data-table` on the Connections page. It also appends a
 * single `<small class="mwp-model-count-patch-note">` subtitle to
 * that same `<td>`. Nothing else in the DOM is mutated.
 *
 * ## Idempotency strategy
 *
 * The script tags each patched `<td>` with
 * `data-mwp-model-count-patched="true"`. MutationObserver re-fires
 * when upstream re-renders the table on data refresh; the script
 * skips already-tagged cells. Without this marker, every upstream
 * `r.refresh()` would trigger a re-patch and a parallel re-fetch
 * from `/available-models`.
 *
 * The script also registers one entry on
 * `window.__manifestPluginsDashboardTransform` and bails early if
 * an entry with `id === 'custom-provider-model-count-fix'` already
 * exists (the bundle re-evaluates on every page navigation since
 * the host serves it without cache headers).
 *
 * ## Why no upstream patch instead?
 *
 * The upstream fix would be a 5-line change in
 * `tenant-providers.controller.ts::listProviders` (swap
 * `cached_models.length` for `await customProviderRepo.models(uuid).length`)
 * plus `provider.controller.ts::99`. That fix is being tracked
 * upstream separately. Until it ships, this plugin delivers the
 * operator-visible UX result.
 *
 * ## Plugin kind
 *
 * `dashboard-transform`. The host concatenates every enabled
 * `dashboard-transform` plugin's `getDashboardScript()` output
 * into the single bundle served at
 * `/admin/dashboard-transform/all.js` and injects it via the
 * dashboard mount overlay.
 */
import type {
  DashboardTransformPlugin,
  PluginMetadata,
} from '../..';

export const CUSTOM_PROVIDER_MODEL_COUNT_FIX_PLUGIN_METADATA: PluginMetadata = Object.freeze({
  id: 'custom-provider-model-count-fix',
  name: 'Custom provider model count fix',
  version: '0.1.0',
  description:
    'Patches the Connections page "0 models" badge for custom ' +
    'Anthropic-compatible providers (e.g. claude-proxy) by ' +
    're-querying /api/v1/routing/<agentName>/available-models and ' +
    'rewriting the rendered DOM count. Disabling this plugin restores ' +
    'the upstream display. Becomes a no-op once Manifest fixes the ' +
    'upstream cached_models.length fallback for custom providers.',
  kind: 'dashboard-transform',
});

/**
 * The browser-side script shipped to the dashboard. Self-contained:
 * no `import`/`require`, only `fetch`, `document`, and standard DOM
 * APIs (all available in the browser without a module loader).
 *
 * Shape: a single IIFE that:
 *   1. Bails if the dashboard-transform registry already has a
 *      `custom-provider-model-count-fix` entry (defensive: the bundle
 *      is re-evaluated on every page navigation).
 *   2. Detects whether the current page is the Connections page
 *      (`/harnesses/<agentName>/providers`) or the legacy alias
 *      (`/agents/<agentName>/providers`). On other pages the script
 *      is a no-op until the user navigates.
 *   3. Fetches the real model list once from
 *      `/api/v1/routing/<agentName>/available-models`, filters rows
 *      where `provider.startsWith('custom:')`, and groups them by
 *      `provider_display_name` (the human-readable name like
 *      'claude-proxy').
 *   4. Walks every row of `table.data-table` on the page. If the
 *      provider-name `<td>` matches a custom provider's display name
 *      AND the Models `<td>` (the 4th cell) reads `0` or `-`, it
 *      rewrites the cell's text content to the real count (using
 *      `textContent`, never `innerHTML`) and appends a single
 *      `<small class="mwp-model-count-patch-note">` subtitle.
 *   5. Each patched `<td>` gets `data-mwp-model-count-patched="true"`
 *      so MutationObserver-triggered re-runs skip it.
 *   6. Installs a MutationObserver on `document.body` with
 *      `{childList: true, subtree: true}` so SPA navigation back to
 *      the Connections page re-runs the patch on the fresh table.
 */
export const CUSTOM_PROVIDER_MODEL_COUNT_FIX_SCRIPT: string = [
  '(function () {',
  '  \'use strict\';',
  '  if (typeof window === \'undefined\') return;',
  '',
  '  var PLUGIN_ID = \'custom-provider-model-count-fix\';',
  '  var SCRIPT_VERSION = \'0.1.0\';',
  '',
  '  // Combined-bundle registry. Every dashboard-transform plugin\'s IIFE',
  '  // appends one entry here; the host iterates the registry on',
  '  // DOMContentLoaded. We check it ourselves so a re-evaluation of',
  '  // the combined bundle (e.g. after SPA navigation) is a no-op.',
  '  if (window.__manifestPluginsDashboardTransform === undefined) {',
  '    window.__manifestPluginsDashboardTransform = [];',
  '  }',
  '  if (window.__manifestPluginsDashboardTransform.some(function (e) {',
  '    return e && e.id === PLUGIN_ID;',
  '  })) {',
  '    return;',
  '  }',
  '',
  '  // ─────────────────────────────────────────────────────────────────',
  '  // URL detection',
  '  // ─────────────────────────────────────────────────────────────────',
  '  // The agent-scoped Connections page lives at:',
  '  //   /harnesses/<agentName>/providers',
  '  // (Manifest renamed /agents → /harnesses in the 6.x range. The bundle',
  '  //  we inspected redirects /agents/<name>/* → /harnesses/<name>/*, but',
  '  //  we match the literal path too in case the redirect is bypassed in',
  '  //  the iframe context.)',
  '  // We do NOT match the global /providers/* pages because they show the',
  '  // connections list across all auth types, and the routing-picker',
  '  // endpoint requires a specific agent name — those pages are not in',
  '  // scope for this plugin.',
  '  var CONNECTIONS_PATH_RE = /^\\/(?:agents|harnesses)\\/([^/]+)\\/providers\\/?$/;',
  '',
  '  function getConnectionsAgentName() {',
  '    var m = window.location.pathname.match(CONNECTIONS_PATH_RE);',
  '    if (!m) return null;',
  '    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }',
  '  }',
  '',
  '  // ─────────────────────────────────────────────────────────────────',
  '  // Small DOM helpers (kept inline so the IIFE stays self-contained)',
  '  // ─────────────────────────────────────────────────────────────────',
  '  function getText(el) {',
  '    // textContent never executes HTML; safe for user-influenced strings.',
  '    return el ? (el.textContent || \'\') : \'\';',
  '  }',
  '',
  '  function trim(s) { return (s || \'\').replace(/^\\s+|\\s+$/g, \'\'); }',
  '',
  '  // ─────────────────────────────────────────────────────────────────',
  '  // API: fetch the routing-picker\'s available-models for the agent',
  '  // ─────────────────────────────────────────────────────────────────',
  '  // The router picker endpoint already returns the right list — we',
  '  // only need to count rows where `provider.startsWith(\'custom:\')`.',
  '  // We group the rows by `provider_display_name` so the DOM walk can',
  '  // look up the count by the visible provider name on each row.',
  '  function fetchAvailableModels(agentName) {',
  '    var url = \'/api/v1/routing/\' + encodeURIComponent(agentName) + \'/available-models\';',
  '    return fetch(url, { credentials: \'same-origin\' }).then(function (res) {',
  '      if (!res.ok) {',
  '        return res.text().then(function (body) {',
  '          throw new Error(\'GET \' + url + \' -> \' + res.status + \' \' + (body || \'\').slice(0, 200));',
  '        });',
  '      }',
  '      return res.json();',
  '    }).then(function (rows) {',
  '      var countsByName = Object.create(null);',
  '      var totalCustom = 0;',
  '      if (!Array.isArray(rows)) return { countsByName: countsByName, totalCustom: totalCustom };',
  '      for (var i = 0; i < rows.length; i += 1) {',
  '        var row = rows[i];',
  '        if (!row) continue;',
  '        // Filter: only custom:* provider rows.',
  '        if (typeof row.provider !== \'string\' || row.provider.indexOf(\'custom:\') !== 0) continue;',
  '        // The router picker populates `provider_display_name` with the',
  '        // custom provider\'s human-readable name. Fall back to a slug of',
  '        // the UUID if for some reason the field is missing — the row',
  '        // will then never match a DOM cell and stay unpainted, which',
  '        // is safer than firing a wrong-text rewrite.',
  '        var name = row.provider_display_name;',
  '        if (typeof name !== \'string\' || name.length === 0) continue;',
  '        countsByName[name] = (countsByName[name] || 0) + 1;',
  '        totalCustom += 1;',
  '      }',
  '      return { countsByName: countsByName, totalCustom: totalCustom };',
  '    });',
  '  }',
  '',
  '  // ─────────────────────────────────────────────────────────────────',
  '  // DOM patch',
  '  // ─────────────────────────────────────────────────────────────────',
  '  // The Connections page renders a `table.data-table` whose columns',
  '  // are: [Provider, Type, Connection, Models, Actions]. The Models',
  '  // cell we patch is the 4th <td> in each <tr>. The 1st <td>',
  '  // contains the provider display name (the same string used as',
  '  // key in `countsByName`).',
  '  function patchTable(table, countsByName) {',
  '    if (!table || !countsByName) return;',
  '    var tbody = table.tBodies && table.tBodies[0];',
  '    if (!tbody) return;',
  '    var rows = tbody.rows;',
  '    if (!rows || rows.length === 0) return;',
  '    for (var i = 0; i < rows.length; i += 1) {',
  '      var tr = rows[i];',
  '      if (!tr || tr.cells.length < 4) continue;',
  '      var nameCell = tr.cells[0];',
  '      var modelsCell = tr.cells[3];',
  '      var providerName = trim(getText(nameCell));',
  '      if (!providerName) continue;',
  '      var realCount = Object.prototype.hasOwnProperty.call(countsByName, providerName)',
  '        ? countsByName[providerName]',
  '        : null;',
  '      if (realCount === null || realCount <= 0) continue;',
  '      // Skip already-patched cells (idempotency). The dataset marker',
  '      // is set on the <td> so SPA-driven re-renders reuse it.',
  '      if (modelsCell && modelsCell.dataset && modelsCell.dataset.mwpModelCountPatched === \'true\') continue;',
  '      var currentText = trim(getText(modelsCell));',
  '      // Only patch when the rendered text is the broken state. The',
  '      // upstream renders `0` (number) or `-` (when nullish). If the',
  '      // cell already shows the real count we don\'t touch it.',
  '      if (currentText !== \'0\' && currentText !== \'-\' && currentText !== String(realCount)) {',
  '        // The cell shows something other than 0, -, or the real count.',
  '        // Conservative no-op: do not overwrite arbitrary text.',
  '        continue;',
  '      }',
  '      // Rewrite the displayed count via textContent (never innerHTML).',
  '      // We rebuild the cell rather than mutating text nodes so the',
  '      // subtitle sits on its own line beneath the count.',
  '      while (modelsCell.firstChild) {',
  '        modelsCell.removeChild(modelsCell.firstChild);',
  '      }',
  '      modelsCell.appendChild(document.createTextNode(String(realCount)));',
  '      // Append a single <small> subtitle so the operator knows the',
  '      // count was patched client-side. textContent for the message',
  '      // again — the string is a plugin constant, but defensive.',
  '      var note = document.createElement(\'small\');',
  '      note.className = \'mwp-model-count-patch-note\';',
  '      // data-mwp- marker on the note itself for downstream tooling.',
  '      note.setAttribute(\'data-mwp-model-count-patched-note\', \'true\');',
  '      note.appendChild(document.createTextNode(\'(patched by manifest-plugin)\'));',
  '      modelsCell.appendChild(note);',
  '      modelsCell.dataset.mwpModelCountPatched = \'true\';',
  '    }',
  '  }',
  '',
  '  function findTable() {',
  '    // The Connections page has exactly one `table.data-table` for the',
  '    // providers list. We target by class since neither id nor data-testid',
  '    // is set (verified against AgentProviders-DkdPn0fN.js).',
  '    return document.querySelector(\'table.data-table\');',
  '  }',
  '',
  '  function runPatch() {',
  '    var agentName = getConnectionsAgentName();',
  '    if (!agentName) return;',
  '    var table = findTable();',
  '    if (!table) return;',
  '    fetchAvailableModels(agentName).then(function (data) {',
  '      // If upstream fixed the bug in the meantime, the broken state',
  '      // never renders and countsByName is empty — the patch is a',
  '      // no-op, which is the intended behavior.',
  '      if (!data || !data.countsByName) return;',
  '      patchTable(table, data.countsByName);',
  '    }).catch(function (err) {',
  '      // eslint-disable-next-line no-console',
  '      console.warn(\'[\' + PLUGIN_ID + \'] available-models fetch failed:\', err && err.message || err);',
  '    });',
  '  }',
  '',
  '  function onConnectionsPage() {',
  '    return getConnectionsAgentName() !== null;',
  '  }',
  '',
  '  function installOnCurrentRoute() {',
  '    if (!onConnectionsPage()) return;',
  '    runPatch();',
  '  }',
  '',
  '  // ─────────────────────────────────────────────────────────────────',
  '  // Lifecycle',
  '  // ─────────────────────────────────────────────────────────────────',
  '  if (document.readyState === \'loading\') {',
  '    document.addEventListener(\'DOMContentLoaded\', installOnCurrentRoute, { once: true });',
  '  } else {',
  '    installOnCurrentRoute();',
  '  }',
  '',
  '  // SPA navigation: re-mount when the path changes. MutationObserver',
  '  // watches `document.body` with `childList + subtree` only (no',
  '  // attributes filter) so the cost is negligible — fires only when',
  '  // the upstream router swaps the page container. The bundle itself',
  '  // is re-evaluated on every page navigation, so this observer is the',
  '  // belt-and-braces path: it ensures the patch re-applies even when',
  '  // the SPA soft-navigates without re-loading the bundle.',
  '  var lastPath = window.location.pathname;',
  '  var observer = new MutationObserver(function () {',
  '    var currentPath = window.location.pathname;',
  '    if (currentPath === lastPath) return;',
  '    lastPath = currentPath;',
  '    if (onConnectionsPage()) {',
  '      installOnCurrentRoute();',
  '    }',
  '  });',
  '  observer.observe(document.body, { childList: true, subtree: true });',
  '',
  '  window.addEventListener(\'popstate\', installOnCurrentRoute);',
  '',
  '  window.__manifestPluginsDashboardTransform.push({',
  '    id: PLUGIN_ID,',
  '    version: SCRIPT_VERSION,',
  '    install: installOnCurrentRoute,',
  '  });',
  '})();',
].join('\n');

export class CustomProviderModelCountFixPlugin implements DashboardTransformPlugin {
  static readonly metadata: PluginMetadata = CUSTOM_PROVIDER_MODEL_COUNT_FIX_PLUGIN_METADATA;

  getDashboardScript(): string {
    return CUSTOM_PROVIDER_MODEL_COUNT_FIX_SCRIPT;
  }
}
