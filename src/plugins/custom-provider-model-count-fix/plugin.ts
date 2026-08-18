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
 * Two surfaces:
 *
 * 1. The per-agent Connections page (`/harnesses/<agentName>/providers`):
 *    the Models-column `<td>` of each row in the `table.data-table`.
 * 2. The ConnectionDetail page (`/providers/connections/<id>`): the
 *    `<span>` value node immediately following the
 *    `<span>Models:</span>` label. The detail page renders fields as
 *    inline `<span>` pairs (label + value), not as a table.
 *
 * Both patch sites append a single
 * `<small class="mwp-model-count-patch-note">` subtitle so the operator
 * can tell the value was patched client-side. Nothing else in the DOM
 * is mutated.
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
    'Patches the Connections page "0 models" badge AND the ' +
    'ConnectionDetail page "Models: 0" field for custom ' +
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
 *   2. Detects whether the current page is one of:
 *        - the per-agent Connections page
 *          (`/harnesses/<agentName>/providers`, or the legacy alias
 *          `/agents/<agentName>/providers`), or
 *        - the ConnectionDetail page
 *          (`/providers/connections/<id>`).
 *      On other pages the script is a no-op until the user navigates.
 *   3. Fetches the real model list once from
 *      `/api/v1/routing/<agentName>/available-models`, filters rows
 *      where `provider.startsWith('custom:')`, and groups them by
 *      `provider_display_name` (the human-readable name like
 *      'claude-proxy'). For the ConnectionDetail page (no agent in
 *      the URL) it uses the built-in `Playground` agent — the picker
 *      returns ALL custom provider models regardless of agent.
 *   4a. On the Connections page: walks every row of `table.data-table`.
 *      If the provider-name `<td>` matches a custom provider's display
 *      name AND the Models `<td>` (the 4th cell) reads `0` or `-`, it
 *      rewrites the cell's text content to the real count (using
 *      `textContent`, never `innerHTML`) and appends a single
 *      `<small class="mwp-model-count-patch-note">` subtitle.
 *   4b. On the ConnectionDetail page: walks every `<span>` looking for
 *      the literal `Models:` label, then patches the next-sibling
 *      `<span>` (the value node) with the TOTAL custom-provider model
 *      count. The detail page shows one connection at a time and the
 *      picker returns every custom model, so the total is the right
 *      number for the single-custom-provider case.
 *   5. Each patched node gets `data-mwp-model-count-patched="true"`
 *      so MutationObserver-triggered re-runs skip it.
 *   6. Installs a MutationObserver on `document.body` with
 *      `{childList: true, subtree: true}` so SPA navigation back to
 *      either patched page re-runs the patch on the fresh DOM.
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
  '  // Two page shapes are in scope:',
  '  //',
  '  // 1. Agent-scoped Connections page (list view):',
  '  //      /harnesses/<agentName>/providers',
  '  //    (Manifest renamed /agents → /harnesses in the 6.x range. The',
  '  //     bundle we inspected redirects /agents/<name>/* → /harnesses/<name>/*,',
  '  //     but we match the literal path too in case the redirect is bypassed',
  '  //     in the iframe context.)',
  '  //',
  '  // 2. ConnectionDetail page (single-connection view):',
  '  //      /providers/connections/<id>',
  '  //    Renders fields as inline <span> pairs (label + value) instead',
  '  //    of a table row, so it needs a different DOM walker.',
  '  //',
  '  // We do NOT match the global /providers list page — it shows the',
  '  // connections list across all auth types, and the routing-picker',
  '  // endpoint requires a specific agent name; that page is not in scope.',
  '  var CONNECTIONS_PATH_RE = /^\\/(?:agents|harnesses)\\/([^/]+)\\/providers\\/?$/;',
  '  var CONNECTION_DETAIL_PATH_RE = /^\\/providers\\/connections\\/[^/]+\\/?$/;',
  '',
  '  function getConnectionsAgentName() {',
  '    var m = window.location.pathname.match(CONNECTIONS_PATH_RE);',
  '    if (!m) return null;',
  '    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }',
  '  }',
  '',
  '  // Returns the kind of page we are on so the patch router can pick',
  '  // the right DOM walker. The ConnectionDetail URL has no agent name',
  '  // in it; for that page we query the routing-picker endpoint with a',
  '  // built-in agent (Playground) because the picker returns ALL custom',
  '  // provider models regardless of which agent is named — verified',
  '  // against the live Manifest 6.x bundle.',
  '  function getCurrentPageKind() {',
  '    if (getConnectionsAgentName() !== null) return \'agent-list\';',
  '    if (CONNECTION_DETAIL_PATH_RE.test(window.location.pathname)) return \'connection-detail\';',
  '    return \'other\';',
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
  '  // ─────────────────────────────────────────────────────────────────',
  '  // ConnectionDetail DOM patch',
  '  // ─────────────────────────────────────────────────────────────────',
  '  // The ConnectionDetail page (`/providers/connections/<id>`) renders',
  '  // each field as an inline <span> pair:',
  '  //   <span>',
  '  //     <span style="font-weight:600;...">Models:</span>',
  '  //     \' \',',
  '  //     <span style="color:hsl(var(--muted-foreground))">{count}</span>',
  '  //   </span>',
  '  // (Verified against ConnectionDetail-nZtX-q3D.js in the Manifest 6.x',
  '  //  frontend bundle.) There is no table, no data-testid, and no',
  '  //  provider name on the same line — so we cannot use the countsByName',
  '  //  join. Instead we use the TOTAL custom-provider model count: the',
  '  //  detail page only ever shows one custom connection at a time, and',
  '  //  the routing-picker endpoint returns every custom provider model',
  '  //  regardless of agent, so the total is the right number for the',
  '  //  common single-custom-provider case. If multiple custom providers',
  '  //  exist, the detail page would show the same total on each — that',
  '  //  is a known limitation documented in the operator docs.',
  '  function patchConnectionDetail(totalCustom) {',
  '    if (typeof totalCustom !== \'number\' || totalCustom <= 0) return;',
  '    // Walk every <span> in the document. The label span\'s text is',
  '    // exactly \'Models:\' (SolidJS renders it as a literal).',
  '    var spans = document.querySelectorAll(\'span\');',
  '    for (var i = 0; i < spans.length; i += 1) {',
  '      var label = spans[i];',
  '      if (!label) continue;',
  '      if (trim(getText(label)) !== \'Models:\') continue;',
  '      // The value span is the NEXT element sibling of the label span',
  '      // inside the same wrapper <span>. SolidJS inserts a text node',
  '      // (a single space) between them, so we use nextElementSibling',
  '      // to skip text nodes.',
  '      var valueSpan = label.nextElementSibling;',
  '      if (!valueSpan || valueSpan.tagName !== \'SPAN\') continue;',
  '      // Idempotency: skip if we already patched this value span.',
  '      if (valueSpan.dataset && valueSpan.dataset.mwpModelCountPatched === \'true\') continue;',
  '      var currentText = trim(getText(valueSpan));',
  '      // Only patch the broken state (0, -, or empty). If the upstream',
  '      // already shows the real count, leave it alone.',
  '      if (currentText !== \'0\' && currentText !== \'-\' && currentText !== \'\' && currentText !== String(totalCustom)) {',
  '        continue;',
  '      }',
  '      // Rewrite the value via textContent (never innerHTML).',
  '      while (valueSpan.firstChild) {',
  '        valueSpan.removeChild(valueSpan.firstChild);',
  '      }',
  '      valueSpan.appendChild(document.createTextNode(String(totalCustom)));',
  '      // Append the patch-note subtitle INSIDE the value span so it',
  '      // inherits the muted-foreground styling. The detail page layout',
  '      // is inline, so the note sits right after the count.',
  '      var note = document.createElement(\'small\');',
  '      note.className = \'mwp-model-count-patch-note\';',
  '      note.setAttribute(\'data-mwp-model-count-patched-note\', \'true\');',
  '      note.appendChild(document.createTextNode(\' (patched by manifest-plugin)\'));',
  '      valueSpan.appendChild(note);',
  '      valueSpan.dataset.mwpModelCountPatched = \'true\';',
  '    }',
  '  }',
  '',
  '  function runPatch() {',
  '    var pageKind = getCurrentPageKind();',
  '    if (pageKind === \'other\') return;',
  '    // For the agent-list page we use the agent from the URL. For the',
  '    // connection-detail page there is no agent in the URL, so we use',
  '    // the built-in Playground agent — the routing-picker endpoint',
  '    // returns ALL custom provider models regardless of which agent is',
  '    // named, so the choice of agent only has to be one that exists.',
  '    var agentName = pageKind === \'agent-list\' ? getConnectionsAgentName() : \'Playground\';',
  '    if (!agentName) return;',
  '    fetchAvailableModels(agentName).then(function (data) {',
  '      // If upstream fixed the bug in the meantime, the broken state',
  '      // never renders and countsByName is empty — the patch is a',
  '      // no-op, which is the intended behavior.',
  '      if (!data || !data.countsByName) return;',
  '      if (pageKind === \'agent-list\') {',
  '        var table = findTable();',
  '        if (!table) return;',
  '        patchTable(table, data.countsByName);',
  '      } else if (pageKind === \'connection-detail\') {',
  '        patchConnectionDetail(data.totalCustom);',
  '      }',
  '    }).catch(function (err) {',
  '      // eslint-disable-next-line no-console',
  '      console.warn(\'[\' + PLUGIN_ID + \'] available-models fetch failed:\', err && err.message || err);',
  '    });',
  '  }',
  '',
  '  function onPatchedPage() {',
  '    return getCurrentPageKind() !== \'other\';',
  '  }',
  '',
  '  function installOnCurrentRoute() {',
  '    if (!onPatchedPage()) return;',
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
  '    if (onPatchedPage()) {',
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
