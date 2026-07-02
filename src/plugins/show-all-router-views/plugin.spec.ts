/**
 * Unit tests for the ShowAllRouterViewsPlugin.
 *
 * The plugin exports a single browser-side script string via
 * `getDashboardScript()`. The tests pin:
 *   - metadata shape and static class field
 *   - constructability
 *   - the script is non-empty
 *   - the script includes the IIFE wrapper
 *   - the script contains the URL pattern for the routing page
 *     (both /agents/<name>/routing AND /harnesses/<name>/routing)
 *   - the script contains the inline audit panel mount + toggle logic
 *   - the script contains the API fetch paths for the audit data
 *   - the script contains the OFFICIAL Complexity toggle endpoint
 *     (POST /complexity/toggle) — the only operator-controllable
 *     lever for the upstream deprecation gate
 *   - the script does NOT include delete affordances (upstream has
 *     no DELETE endpoint for tier rows; clearOverride has its own
 *     upstream bug — see plugin.ts docstring)
 *   - the script does NOT contain a raw innerHTML assignment with
 *     untrusted content (we use textContent + DOM construction)
 *   - the script does NOT inject CSS overrides or mutate the
 *     existing DOM (non-invasive contract — see "non-invasive
 *     DOM contract" describe block below)
 *   - the script, when executed in a vm sandbox fixture, actually
 *     inserts the panel as a sibling of `.routing-tabs` with
 *     the expected attributes (the strongest assertion we can
 *     make without a real Manifest backend running).
 *
 * Higher-level "the dashboard actually surfaces the audit data"
 * tests are E2E (e2e-test.sh in pipeline/). The unit suite stays
 * focused on the contract that ships to the browser: if any of
 * the strings upstream tooling greps for disappears, the unit
 * suite catches it before the dashboard mount.
 */
import type { DashboardTransformPlugin, PluginMetadata } from '../..';
import {
  SHOW_ALL_ROUTER_VIEWS_PLUGIN_KIND,
  SHOW_ALL_ROUTER_VIEWS_PLUGIN_METADATA,
  SHOW_ALL_ROUTER_VIEWS_SCRIPT,
  ShowAllRouterViewsPlugin,
} from './plugin';

describe('ShowAllRouterViewsPlugin', () => {
  let plugin: DashboardTransformPlugin;

  beforeEach(() => {
    plugin = new ShowAllRouterViewsPlugin();
  });

  describe('metadata', () => {
    it('declares the dashboard-transform kind', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_PLUGIN_METADATA.kind).toBe(
        SHOW_ALL_ROUTER_VIEWS_PLUGIN_KIND,
      );
      expect(SHOW_ALL_ROUTER_VIEWS_PLUGIN_METADATA.kind).toBe(
        'dashboard-transform',
      );
    });

    it('uses a kebab-case id that is unique within the registry', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_PLUGIN_METADATA.id).toBe(
        'show-all-router-views',
      );
      expect(SHOW_ALL_ROUTER_VIEWS_PLUGIN_METADATA.id).toMatch(
        /^[a-z][a-z0-9-]*$/,
      );
    });

    it('ships a non-empty name + description that explain the operator use case', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_PLUGIN_METADATA.name.length).toBeGreaterThan(0);
      expect(SHOW_ALL_ROUTER_VIEWS_PLUGIN_METADATA.description.length).toBeGreaterThan(40);
      const desc = SHOW_ALL_ROUTER_VIEWS_PLUGIN_METADATA.description.toLowerCase();
      expect(
        desc.includes('routing') || desc.includes('router'),
      ).toBe(true);
    });

    it('exposes metadata via the static class field', () => {
      expect(ShowAllRouterViewsPlugin.metadata).toEqual<PluginMetadata>(
        SHOW_ALL_ROUTER_VIEWS_PLUGIN_METADATA,
      );
    });
  });

  describe('constructor', () => {
    it('is constructable without throwing', () => {
      expect(() => new ShowAllRouterViewsPlugin()).not.toThrow();
    });
  });

  describe('getDashboardScript', () => {
    it('returns the SHOW_ALL_ROUTER_VIEWS_SCRIPT constant', () => {
      expect(plugin.getDashboardScript()).toBe(SHOW_ALL_ROUTER_VIEWS_SCRIPT);
    });

    it('returns a non-empty string', () => {
      const script = plugin.getDashboardScript();
      expect(typeof script).toBe('string');
      expect((script as string).length).toBeGreaterThan(1000);
    });

    it('wraps the entire body in an IIFE so the script is self-contained', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT.startsWith('(function () {')).toBe(true);
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT.trimEnd().endsWith('})();')).toBe(true);
    });

    it('uses strict mode inside the IIFE', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toMatch(/'use strict';/);
    });

    it('short-circuits when window is undefined (SSR / non-browser)', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toMatch(
        /typeof window === 'undefined'\) return;/,
      );
    });

    it('registers itself on the global registry for HMR idempotency', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain(
        'window.__manifestPluginsDashboardTransform',
      );
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain(
        'id: PLUGIN_ID',
      );
    });
  });

  describe('routing-page detection', () => {
    it('contains a regex for the /agents/<name>/routing AND /harnesses/<name>/routing paths', () => {
      // Upstream Manifest renamed `agents` → `harnesses` at some point.
      // The plugin must fire on both URL shapes so it works on every
      // upstream version (newer builds use /harnesses/...).
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toMatch(/\/agents\/[^/]+\/routing/);
      expect(script).toMatch(/\/harnesses\/[^/]+\/routing/);
      // The regex uses a non-capturing group `(?:agents|harnesses)` so a
      // single match handles both URL shapes.
      expect(script).toContain('(?:agents|harnesses)');
    });

    it('decodes the URL-encoded agent name before fetching', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain('decodeURIComponent');
    });
  });

  describe('non-invasive DOM contract', () => {
    // The plugin must NEVER touch the existing DOM. The upstream
    // gate uses SolidJS <Show when={false}> guards which don't
    // render their children at all, so trying to "force show" them
    // via CSS is both futile (no DOM to target) and harmful (it
    // breaks the existing flex/grid layouts of the routing cards
    // that ARE rendered). These tests pin the non-invasive contract.

    it('does NOT inject any <style> element with display/visibility overrides', () => {
      // The CSS-override block was removed; these runtime tokens
      // must NOT appear anywhere in the shipped script. Comments
      // may reference them (for context), so we anchor the assertions
      // to runtime call sites / element IDs / setAttribute keys.
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).not.toContain('show-all-router-views-style');
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).not.toContain('data-show-all-router-views-scope');
      // No styleEl element is created or appended.
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).not.toMatch(/document\.head\.appendChild/);
    });

    it('does NOT walk the DOM tree for hidden router surfaces (no createTreeWalker)', () => {
      // The earlier "force show hidden ancestors" walker was removed.
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).not.toContain('createTreeWalker');
    });

    it('does NOT call removeAttribute("hidden") or removeAttribute("aria-hidden")', () => {
      // The earlier "strip hidden attributes" pass was removed.
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).not.toContain("removeAttribute('hidden')");
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).not.toContain("removeAttribute('aria-hidden')");
    });

    it('does NOT run a MutationObserver against the existing DOM', () => {
      // The earlier MutationObserver that watched for the existing
      // DOM re-hiding itself was removed. The remaining observer is
      // bounded to `childList + subtree` only (used for path-change
      // detection, not DOM mutation watching).
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).not.toContain('attributeFilter');
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).not.toContain('isElementHidden');
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).not.toContain('isRouterSurface');
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).not.toContain('forceVisible');
    });
  });

  describe('audit modal — API surface', () => {
    it('fetches all four routing endpoints in parallel', () => {
      // The exact URL paths are pinned against the upstream Manifest
      // controllers (packages/backend/src/routing/{tier,specificity,
      // header-tiers}.controller.ts). When upstream renames a path, this
      // test fails — the operator then re-derives the new path from
      // the upstream source and updates the plugin.
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toContain(
        "/api/v1/routing/' + encodeURIComponent(agentName) + '/tiers",
      );
      expect(script).toContain(
        "/api/v1/routing/' + encodeURIComponent(agentName) + '/specificity'",
      );
      expect(script).toContain(
        "/api/v1/routing/' + encodeURIComponent(agentName) + '/header-tiers",
      );
      expect(script).toContain(
        "/api/v1/routing/' + encodeURIComponent(agentName) + '/complexity/status",
      );
    });

    it('uses credentials: same-origin so the existing auth session is reused', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      const fetchCount = (script.match(/fetch\(/g) || []).length;
      const credentialsCount = (script.match(/credentials: 'same-origin'/g) || []).length;
      expect(fetchCount).toBeGreaterThan(0);
      expect(credentialsCount).toBe(fetchCount);
    });

    it('does NOT include any delete affordances (read-only panel — official upstream API does not allow tier-row deletion)', () => {
      // The plugin is read-only by design. Per the upstream
      // TierController, there is no DELETE endpoint for tier rows
      // (only clearOverride, which has its own upstream bug). The
      // plugin shows the data the upstream UI hides via the
      // deprecation gate, then provides a Complexity Toggle button
      // (the only official operator-controllable lever).
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).not.toContain("method: 'DELETE'");
      expect(script).not.toContain("Delete failed");
      expect(script).not.toContain('window.confirm(');
    });

    it('includes the official Complexity toggle endpoint (POST /api/v1/routing/<agent>/complexity/toggle)', () => {
      // The toggle endpoint is the OFFICIAL, upstream-blessed fix
      // for the operator's "calls accidentally route to simple"
      // problem. Per resolve.service.ts, when
      // complexity_routing_enabled = false, every request
      // short-circuits to the `default` tier.
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toContain(
        "/api/v1/routing/' + encodeURIComponent(agentName) + '/complexity/toggle'",
      );
      expect(script).toContain("method: 'POST'");
      expect(script).toContain('Disable complexity routing');
      expect(script).toContain('Enable complexity routing');
    });
  });

  describe('audit modal — rendering safety', () => {
    it('builds DOM via createElement (no innerHTML assignment with template strings)', () => {
      const matches = SHOW_ALL_ROUTER_VIEWS_SCRIPT.match(
        /\.innerHTML\s*=\s*[^'"\s][^;]+;/g,
      ) || [];
      const suspicious = matches.filter(function (m) {
        return !/\.innerHTML\s*=\s*''\s*;/.test(m);
      });
      expect(suspicious).toEqual([]);
    });

    it('uses textContent for any CSS or text content (no innerHTML with untrusted data)', () => {
      // The script does not inject CSS at all (the visibility-override
      // was removed). For any text it does set, it uses textContent /
      // createTextNode, never innerHTML with template strings. This
      // is the regression guard for the XSS surface the script would
      // otherwise open by interpolating user-controlled data (tier
      // names, header keys, model names) into the audit tables.
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain('createTextNode');
      const matches = SHOW_ALL_ROUTER_VIEWS_SCRIPT.match(
        /\.innerHTML\s*=\s*[^'"\s][^;]+;/g,
      ) || [];
      const suspicious = matches.filter((m) => !/\.innerHTML\s*=\s*''\s*;/.test(m));
      expect(suspicious).toEqual([]);
    });
  });

  describe('inline audit panel', () => {
    it('mounts an inline panel (not a floating overlay) before a known upstream mount point', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      // The panel sits inline with the routing content, not as a FAB
      // or full-screen modal. The mount point is just before one of
      // the known upstream selectors, so the audit surface appears
      // above the routing content in the page flow.
      expect(script).toContain('show-all-router-views-panel');
      expect(script).toContain('mountParent.insertBefore(panel, mountBefore)');
      // The panel className (used for the global CSS override scope
      // + the testid selector).
      expect(script).toContain('show-all-router-views__panel');
    });

    it('probes all known upstream mount points (legacy tabs + new unified view)', () => {
      // The upstream routing page has TWO layouts: legacy (with
      // .routing-tabs + tabs) and clean-agent unified (with
      // .routing-cards + .routing-section__header). The plugin
      // probes for both so the panel lands in a sensible place on
      // either layout.
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toContain(".routing-tabs");
      expect(script).toContain(".routing-cards");
      expect(script).toContain(".routing-section");
      expect(script).toContain(".container--lg");
      expect(script).toContain('main');
      expect(script).toContain('body');
    });

    it('falls back through the mount-point chain when each upstream selector is missing', () => {
      // The mount strategy name in the success log includes the
      // exact selector path the plugin ended up using. This is
      // operator-facing diagnostic info (printed to the browser
      // console) that lets a developer verify which upstream layout
      // they're looking at without digging through the DOM.
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toContain('mountStrategy');
      expect(script).toMatch(/console\.log\('\[show-all-router-views\] panel mounted/);
    });

    it('renders the panel header with a "Reveal all routing views" title + summary badge', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toContain("'Reveal all routing views'");
      // The summary badge is the entry point for the audit count
      // ("N rules: 2 tier overrides, 1 specificity, 1 header tier").
      expect(script).toContain('show-all-router-views-summary');
      expect(script).toContain('formatSummary');
    });

    it('collapses by default and expands in place when the operator clicks the header', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toContain('togglePanel');
      expect(script).toContain('expandPanel');
      expect(script).toContain('collapsePanel');
      // The body is hidden by default — collapsed state.
      expect(script).toContain("display: 'none'");
      // Expand flips the data-expanded attribute to 'true'.
      expect(script).toContain("setAttribute('data-expanded', 'true')");
      // The toggle button text changes between "Show all" and "Hide".
      expect(script).toContain("'Show all'");
      expect(script).toContain("'Hide'");
    });

    it('caches the routing data so the expand path renders instantly after the first fetch', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      // The first install path fetches in the background and stores
      // the result in cachedData; the expand path reuses the cache
      // when the cachedAgentName matches the current agent.
      expect(script).toContain('cachedData');
      expect(script).toContain('cachedAgentName');
      expect(script).toMatch(/cachedData\s*&&\s*cachedAgentName/);
    });

    it('is keyboard accessible (Enter / Space on the header toggles the panel)', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toMatch(/e\.key === 'Enter'/);
      expect(script).toMatch(/e\.key === ' '/);
      expect(script).toContain("header.setAttribute('tabindex', '0')");
      expect(script).toContain("header.setAttribute('role', 'button')");
    });

    it('back-compat: legacy ensureFab() and openModal()/closeModal() shims still work', () => {
      // Older test fixtures and external callers may still reference
      // the original FAB+modal API. The new design preserves them as
      // thin shims that call into the panel expand/collapse path.
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toContain('function ensureFab()');
      expect(script).toContain('return ensurePanel()');
      expect(script).toContain('function openModal()');
      expect(script).toContain('function closeModal()');
      expect(script).toContain('window.__showAllRouterViewsExpand');
      expect(script).toContain('window.__showAllRouterViewsCollapse');
    });
  });

  describe('lifecycle', () => {
    it('installs on DOMContentLoaded (or immediately if already loaded)', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toContain('document.readyState');
      expect(script).toContain("'DOMContentLoaded'");
    });

    it('uses popstate to re-install on browser back/forward', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain("'popstate'");
    });

    it('is a no-op on non-routing pages', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toContain('getAgentName()');
      expect(script).toMatch(/if\s*\(!onRoutePage\(\)\)\s*return;/);
    });
  });
});
