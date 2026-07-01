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
 *   - the script contains the visibility-override style block
 *   - the script contains the audit modal + API fetch paths
 *   - the script contains the FAB markup
 *   - the script contains the delete-row affordance for each
 *     of the three routing surfaces
 *   - the script does NOT contain a raw innerHTML assignment with
 *     untrusted content (we use textContent + DOM construction)
 *
 * Higher-level "the dashboard actually un-hides hidden tabs" tests
 * are E2E (Playwright). The unit suite stays focused on the
 * contract that ships to the browser: if any of the strings
 * upstream tooling greps for disappears, the unit suite catches
 * it before the dashboard mount.
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
    it('contains a regex for the /agents/<name>/routing path', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain(
        '/agents\\/([^/]+)\\/routing',
      );
    });

    it('decodes the URL-encoded agent name before fetching', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain('decodeURIComponent');
    });
  });

  describe('visibility override', () => {
    it('installs a <style> element with display/visibility overrides', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain(
        'show-all-router-views-style',
      );
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain('display: revert !important');
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain('visibility: visible !important');
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain('opacity: 1 !important');
    });

    it('strips the hidden attribute when force-showing a node', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain("removeAttribute('hidden')");
    });

    it('strips aria-hidden when force-showing a node', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain(
        "removeAttribute('aria-hidden')",
      );
    });

    it('walks the DOM tree for hidden router surfaces', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain('createTreeWalker');
    });

    it('checks all four known hide mechanisms: display, visibility, opacity, hidden attr', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toMatch(/style\.display === 'none'/);
      expect(script).toMatch(/style\.visibility === 'hidden'/);
      expect(script).toMatch(/style\.visibility === 'collapse'/);
      expect(script).toMatch(/parseFloat\(style\.opacity/);
      expect(script).toMatch(/hasAttribute\('hidden'\)/);
    });

    it('walks ancestors when a parent is hidden, so the unhidden child actually shows', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toMatch(/while \(ancestor && ancestor !== root\)/);
    });

    it('does not re-touch elements already marked forced', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain(
        'data-show-all-router-views-forced',
      );
    });

    it('re-applies the override on every mutation, not just on initial install', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toContain('reapplyIfHidden');
      expect(script).toContain('MutationObserver');
      expect(script).toMatch(/attributeFilter:\s*\[/);
    });

    it('handles all four classes of hide mechanism in the style override', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      // The CSS override targets all the class names we know
      // about: routing-card, routing-section, panel__tab,
      // tab--hidden, tab--disabled, tab--collapsed.
      expect(script).toMatch(/routing-card/);
      expect(script).toMatch(/routing-section/);
      expect(script).toMatch(/panel__tab/);
      expect(script).toMatch(/tab--hidden/);
      expect(script).toMatch(/tab--disabled/);
      expect(script).toMatch(/tab--collapsed/);
    });
  });

  describe('audit modal — API surface', () => {
    it('fetches all four routing endpoints in parallel', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toContain(
        "/api/v1/routing/' + encodeURIComponent(agentName) + '/tiers",
      );
      expect(script).toContain(
        "/api/v1/routing/' + encodeURIComponent(agentName) + '/specificity-assignments",
      );
      expect(script).toContain(
        "/api/v1/routing/' + encodeURIComponent(agentName) + '/header-tiers",
      );
      expect(script).toContain(
        "/api/v1/routing/' + encodeURIComponent(agentName) + '/complexity-status",
      );
    });

    it('uses credentials: same-origin so the existing auth session is reused', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      const fetchCount = (script.match(/fetch\(/g) || []).length;
      const credentialsCount = (script.match(/credentials: 'same-origin'/g) || []).length;
      expect(fetchCount).toBeGreaterThan(0);
      expect(credentialsCount).toBe(fetchCount);
    });

    it('renders a Delete affordance for each routing surface', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toContain(
        "/api/v1/routing/' + encodeURIComponent(agentName) + '/tiers/' + encodeURIComponent(row.tier)",
      );
      expect(script).toContain(
        "/api/v1/routing/' + encodeURIComponent(agentName) + '/specificity/' + encodeURIComponent(row.category)",
      );
      expect(script).toContain(
        "/api/v1/routing/' + encodeURIComponent(agentName) + '/header-tiers/' + encodeURIComponent(row.id)",
      );
    });

    it('confirms before deleting a row (no accidental click deletes a tier)', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain('window.confirm');
    });

    it('uses DELETE method for the delete affordance', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain(
        "method: 'DELETE'",
      );
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

    it('uses textContent for the global style block (safe CSS text)', () => {
      expect(SHOW_ALL_ROUTER_VIEWS_SCRIPT).toContain('styleEl.textContent');
    });
  });

  describe('floating action button', () => {
    it('renders a fixed-position FAB on the routing page', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toContain('show-all-router-views-fab');
      expect(script).toContain("position: 'fixed'");
      expect(script).toContain("'Reveal all router views'");
    });

    it('tears down the FAB when navigating away from the routing page', () => {
      const script = SHOW_ALL_ROUTER_VIEWS_SCRIPT;
      expect(script).toMatch(/!onRoutePage\(\)/);
      expect(script).toContain("qs('#show-all-router-views-fab')");
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
