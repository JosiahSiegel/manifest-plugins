/**
 * Live-execution tests for ShowAllRouterViewsPlugin.
 *
 * Runs the actual emitted script in a `vm` sandbox that mirrors
 * the upstream Manifest Routing page structure, and asserts the
 * inline audit panel lands in the DOM with the expected attributes
 * + behavior. This is the strongest "the panel is available/visible"
 * assertion we can make in CI without a real Manifest backend running.
 *
 * Why `vm` instead of jsdom: the script reads `window.location.pathname`
 * to detect the routing page. jsdom makes `window.location` read-only
 * and un-configurable, so we cannot stub the pathname from a test.
 * `vm.createContext` gives us full control over the script's environment
 * without the browser DOM overhead, and the assertions we care about
 * (panel mounts, is collapsed by default, toggles on click, registers
 * on the global registry) don't depend on a real DOM — they depend
 * on the panel being inserted into the parent's children list and
 * having the right attributes set, which our mock elements track.
 */
import * as vm from 'vm';
import { SHOW_ALL_ROUTER_VIEWS_SCRIPT } from './plugin';

interface MockElement {
  tagName: string;
  nodeType: number;
  id?: string;
  className: string;
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  style: Record<string, string>;
  textContent: string;
  children: MockElement[];
  parentElement: MockElement | null;
  listeners: Record<string, Array<(event?: unknown) => void>>;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  hasAttribute: (k: string) => boolean;
  removeAttribute: (k: string) => void;
  appendChild: (c: MockElement) => MockElement;
  insertBefore: (newNode: MockElement, refNode: MockElement | null) => MockElement;
  addEventListener: (event: string, fn: (event?: unknown) => void) => void;
  removeEventListener: () => void;
  querySelector: (sel: string) => MockElement | null;
  querySelectorAll: (sel: string) => MockElement[];
  click: () => void;
  focus: () => void;
}

function makeEl(tag: string): MockElement {
  // dataset is a Proxy that maps data-* keys onto `attrs`. This lets
  // the script write `node.dataset.expanded = 'false'` AND query
  // `node.attrs['data-expanded']` from the test, both of which the
  // script + tests depend on.
  const datasetProxy: Record<string, string> = new Proxy(
    {},
    {
      get: (_target, prop: string) => el.attrs['data-' + prop],
      set: (_target, prop: string, value: string) => {
        el.attrs['data-' + prop] = value;
        return true;
      },
    },
  );
  // textContent is a computed property: walk the children, concatenate
  // any text nodes + text of element children. This matches the DOM
  // textContent contract.
  const computeText = (): string => {
    const parts: string[] = [];
    const walk = (node: unknown): void => {
      if (node === null || node === undefined) return;
      if (typeof node === 'string') {
        parts.push(node);
        return;
      }
      const n = node as { nodeType?: number; textContent?: string; children?: unknown[] };
      if (n.nodeType === 3) {
        parts.push(n.textContent || '');
        return;
      }
      if (n.children) {
        for (const c of n.children) walk(c);
      }
    };
    for (const c of el.children) walk(c);
    return parts.join('');
  };
  const el: MockElement = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    className: '',
    dataset: datasetProxy as unknown as Record<string, string>,
    attrs: {},
    style: {},
    get textContent(): string {
      return computeText();
    },
    set textContent(v: string) {
      // Setting textContent replaces all children with a single text
      // node — mirrors the DOM contract.
      el.children.length = 0;
      el.children.push(makeTextNode(v) as unknown as MockElement);
    },
    children: [],
    parentElement: null,
    listeners: {},
  setAttribute: (k, v) => {
    el.attrs[k] = v;
    if (k === 'id') el.id = v;
    if (k === 'class') el.className = v;
  },
  getAttribute: (k: string): string | null => (k in el.attrs ? el.attrs[k] as string : null),
  hasAttribute: (k: string) => k in el.attrs,
    removeAttribute: (k) => {
      delete el.attrs[k];
    },
    appendChild: (c) => {
      c.parentElement = el;
      el.children.push(c);
      return c;
    },
    insertBefore: (newNode, refNode) => {
      newNode.parentElement = el;
      const idx = refNode ? el.children.indexOf(refNode) : -1;
      if (idx >= 0) el.children.splice(idx, 0, newNode);
      else el.children.push(newNode);
      return newNode;
    },
    addEventListener: (event, fn) => {
      el.listeners[event] = el.listeners[event] || [];
      el.listeners[event].push(fn);
    },
    removeEventListener: () => {
      /* noop */
    },
    querySelector: (sel) => {
      const idMatch = sel.match(/^#(.+)$/);
      if (idMatch) {
        const targetId = idMatch[1];
        const walk = (root: MockElement): MockElement | null => {
          if (root.attrs && root.attrs.id === targetId) return root;
          if (root.children) {
            for (const c of root.children) {
              const found = walk(c);
              if (found) return found;
            }
          }
          return null;
        };
        return walk(el);
      }
      return null;
    },
    querySelectorAll: (_sel) => [],
    click: () => {
      const handlers = el.listeners['click'] || [];
      const event = { stopPropagation: () => undefined };
      for (const h of handlers) h(event);
    },
    focus: () => {
      /* noop */
    },
  };
  return el;
}

function makeTextNode(text: string) {
  return { nodeType: 3, textContent: text };
}

/**
 * Recursively find an element by id, returning null if not found.
 * Used to walk past the panel's header subtree (which contains the
 * toggle, h2, summary badge, etc. — all nested under header > wrapper div).
 */
function findById(root: MockElement, targetId: string): MockElement | null {
  if (root.attrs && root.attrs.id === targetId) return root;
  if (root.children) {
    for (const c of root.children) {
      const found = findById(c, targetId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Recursively find an element by tag name (e.g. 'h2').
 */
function findByTag(root: MockElement, tag: string): MockElement | null {
  if (root.tagName === tag.toUpperCase()) return root;
  if (root.children) {
    for (const c of root.children) {
      const found = findByTag(c, tag);
      if (found) return found;
    }
  }
  return null;
}

interface MockCtx {
  pathname: string;
  root: MockElement;
  routingTabs: MockElement | null;
  routingCards: MockElement | null;
  routingSection: MockElement | null;
  containerLg: MockElement;
  body: MockElement;
  head: MockElement;
  appended: MockElement[];
}

function buildContext(layout: 'legacy' | 'clean' = 'legacy'): MockCtx {
  const body: MockElement = makeEl('body');
  const head: MockElement = makeEl('head');
  const containerLg: MockElement = makeEl('div');
  containerLg.setAttribute('class', 'container--lg');
  body.appendChild(containerLg);
  let routingTabs: MockElement | null = null;
  let routingCards: MockElement | null = null;
  let routingSection: MockElement | null = null;
  if (layout === 'legacy') {
    routingTabs = makeEl('div');
    routingTabs.setAttribute('class', 'routing-tabs');
    containerLg.appendChild(routingTabs);
  } else {
    // Clean-agent unified view (post-`49ef687` upstream restructure):
    // there's a .routing-section__header + .routing-cards container
    // but NO .routing-tabs.
    routingSection = makeEl('div');
    routingSection.setAttribute('class', 'routing-section__header routing-section__header--header-tiers');
    containerLg.appendChild(routingSection);
    routingCards = makeEl('div');
    routingCards.setAttribute('class', 'routing-cards');
    containerLg.appendChild(routingCards);
  }
  return {
    pathname: '/',
    root: body,
    body,
    head,
    routingTabs: routingTabs as MockElement | null,
    containerLg,
    appended: [],
    routingCards: routingCards as MockElement | null,
    routingSection: routingSection as MockElement | null,
  };
}

interface ScriptRun {
  ctx: MockCtx;
  panel: MockElement | null;
  header: MockElement | null;
  toggle: MockElement | null;
  body: MockElement | null;
  h2: MockElement | null;
  summary: MockElement | null;
}

function runScriptOn(ctx: MockCtx): ScriptRun {
  const sandbox: Record<string, unknown> = {
    location: { pathname: ctx.pathname },
    addEventListener: () => undefined,
    __manifestPluginsDashboardTransform: [] as unknown[],
    document: {
      readyState: 'complete',
      addEventListener: () => undefined,
      createElement: (tag: string) => {
        const node = makeEl(tag);
        ctx.appended.push(node);
        return node;
      },
      createTextNode: (text: string) => makeTextNode(text),
      createTreeWalker: () => ({ currentNode: null, nextNode: () => null }),
      getComputedStyle: () => ({ display: '', visibility: '', opacity: '1' }),
      head: ctx.head,
      body: ctx.body,
      querySelector: (sel: string) => {
        if (sel === '.container--lg') return ctx.containerLg;
        if (sel === '.routing-tabs') return ctx.routingTabs;
        if (sel === '.routing-cards') return ctx.routingCards;
        if (sel === '.routing-section') return ctx.routingSection;
        if (sel === 'main') return ctx.body; // body is the closest mock of <main>
        if (sel === 'body') return ctx.body;
        // ID-selector support so the script's `qs('#show-all-router-views-panel')`
        // works after install. The findById helper handles nested traversal.
        if (sel.startsWith('#')) {
          return findById(ctx.body, sel.slice(1));
        }
        return null;
      },
      querySelectorAll: () => [],
      getElementById: () => null,
    },
    NodeFilter: { SHOW_ELEMENT: 1 },
    MutationObserver: function () {
      return { observe: () => undefined, disconnect: () => undefined };
    },
    setTimeout: () => 0,
    setInterval: () => 0,
    console,
    Promise,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
    encodeURIComponent,
    decodeURIComponent,
    Number,
    Object,
    Array,
    String,
    RegExp,
    Math,
    Error,
    JSON,
    Boolean,
    parseFloat,
    parseInt,
    isNaN,
    isFinite,
    Date,
    alert: () => undefined,
    confirm: () => true,
    clearInterval: () => undefined,
    clearTimeout: () => undefined,
    getComputedStyle: () => ({ display: '', visibility: '', opacity: '1' }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SHOW_ALL_ROUTER_VIEWS_SCRIPT, sandbox, { timeout: 5000 });

  const panel =
    ctx.containerLg.children.find(
      (c) => c.attrs && c.attrs.id === 'show-all-router-views-panel',
    ) || null;
  // The toggle + summary are nested inside the panel (under header).
  // Use a recursive search so the test sees the actual rendered structure.
  const toggle = panel ? findById(panel, 'show-all-router-views-toggle') : null;
  const summary = panel ? findById(panel, 'show-all-router-views-summary') : null;
  const body = panel ? findById(panel, 'show-all-router-views-body') : null;
  const header = panel && panel.children.length > 0 ? panel.children[0] || null : null;
  const h2 = header ? findByTag(header, 'h2') : null;

  return {
    ctx,
    panel: panel as MockElement | null,
    header,
    body: body as MockElement | null,
    toggle: toggle as MockElement | null,
    h2,
    summary,
  };
}

describe('ShowAllRouterViewsPlugin (live execution)', () => {
  // Upstream Manifest uses TWO different URL shapes for the routing
  // page, depending on the build version. Pre-rename builds use
  // /agents/<name>/routing; post-rename builds use
  // /harnesses/<name>/routing. The plugin must fire on BOTH shapes
  // so it works on every Manifest version. Each test in this suite
  // runs against both shapes via `forEach`.
  const routingShapes = [
    '/agents/my-agent/routing',
    '/harnesses/my-harness/routing',
  ];

  routingShapes.forEach((pathname) => {
    describe(`on ${pathname}`, () => {
      it('inserts the panel as a sibling of .routing-tabs, BEFORE it', () => {
        const ctx = buildContext();
        ctx.pathname = pathname;
        runScriptOn(ctx);

        expect(ctx.routingTabs).not.toBeNull();
        expect(ctx.routingTabs!.parentElement).toBe(ctx.containerLg);
        const panelIdx = ctx.containerLg.children.findIndex(
          (c) => c.attrs && c.attrs.id === 'show-all-router-views-panel',
        );
        const tabsIdx = ctx.containerLg.children.indexOf(ctx.routingTabs as MockElement);
        expect(panelIdx).toBeGreaterThanOrEqual(0);
        expect(tabsIdx).toBeGreaterThanOrEqual(0);
        expect(panelIdx).toBeLessThan(tabsIdx);
      });

      it('panel is collapsed by default (body hidden, toggle reads "Show all")', () => {
        const ctx = buildContext();
        ctx.pathname = pathname;
        const run = runScriptOn(ctx);

        expect(run.panel).not.toBeNull();
        expect(run.panel!.attrs['data-expanded']).toBe('false');
        expect(run.body).not.toBeNull();
        expect(run.body!.style.display).toBe('none');
        expect(run.body!.attrs['role']).toBe('region');
        expect(run.toggle).not.toBeNull();
        expect(run.toggle!.textContent).toBe('Show all');
        expect(run.toggle!.attrs['aria-expanded']).toBe('false');
      });

      it('header has the "Reveal all routing views" title and a summary badge', () => {
        const ctx = buildContext();
        ctx.pathname = pathname;
        const run = runScriptOn(ctx);

        expect(run.h2).not.toBeNull();
        expect(run.h2!.textContent).toBe('Reveal all routing views');
        expect(run.summary).not.toBeNull();
        expect(run.summary!.attrs.id).toBe('show-all-router-views-summary');
      });

      it('toggles from collapsed to expanded when the toggle is clicked', () => {
        const ctx = buildContext();
        ctx.pathname = pathname;
        const run = runScriptOn(ctx);

        expect(run.panel!.attrs['data-expanded']).toBe('false');
        expect(run.body!.style.display).toBe('none');
        expect(run.toggle!.textContent).toBe('Show all');

        run.toggle!.click();

        expect(run.panel!.attrs['data-expanded']).toBe('true');
        expect(run.body!.style.display).toBe('block');
        expect(run.toggle!.textContent).toBe('Hide');
        expect(run.toggle!.attrs['aria-expanded']).toBe('true');
      });
    });
  });

  it('registers itself on the global dashboard-transform registry', () => {
    const ctx = buildContext();
    ctx.pathname = '/agents/my-agent/routing';
    const sandbox = vm.createContext({
      location: { pathname: ctx.pathname },
      addEventListener: () => undefined,
      __manifestPluginsDashboardTransform: [] as unknown[],
      document: {
        readyState: 'complete',
        addEventListener: () => undefined,
        createElement: (tag: string) => makeEl(tag),
        createTextNode: (text: string) => makeTextNode(text),
        createTreeWalker: () => ({ currentNode: null, nextNode: () => null }),
        getComputedStyle: () => ({ display: '', visibility: '', opacity: '1' }),
        head: ctx.head,
        body: ctx.body,
        querySelector: (sel: string) => {
          if (sel === '.container--lg') return ctx.containerLg;
          if (sel === '.routing-tabs') return ctx.routingTabs;
          return null;
        },
        querySelectorAll: () => [],
        getElementById: () => null,
      },
      NodeFilter: { SHOW_ELEMENT: 1 },
      MutationObserver: function () {
        return { observe: () => undefined, disconnect: () => undefined };
      },
      setTimeout: () => 0,
      setInterval: () => 0,
      console,
      Promise,
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
      encodeURIComponent,
      decodeURIComponent,
      Number, Object, Array, String, RegExp, Math, Error, JSON, Boolean,
      parseFloat, parseInt, isNaN, isFinite, Date,
      alert: () => undefined, confirm: () => true,
      clearInterval: () => undefined, clearTimeout: () => undefined,
      getComputedStyle: () => ({ display: '', visibility: '', opacity: '1' }),
    });
    (sandbox as Record<string, unknown>).window = sandbox;
    vm.runInContext(SHOW_ALL_ROUTER_VIEWS_SCRIPT, sandbox, { timeout: 5000 });

    const reg = (sandbox as { __manifestPluginsDashboardTransform: unknown[] })
      .__manifestPluginsDashboardTransform;
    expect(reg).toBeDefined();
    expect(Array.isArray(reg)).toBe(true);
    expect(reg.length).toBe(1);
    const entry = reg[0] as { id: string; version: string; install: unknown };
    expect(entry.id).toBe('show-all-router-views');
    expect(entry.version).toBe('0.1.0');
    expect(typeof entry.install).toBe('function');
  });

  it('is a no-op on non-routing pages (does not insert the panel)', () => {
    const ctx = buildContext();
    ctx.pathname = '/agents';
    const run = runScriptOn(ctx);

    expect(ctx.containerLg.children.length).toBe(1);
    expect(ctx.containerLg.children[0]).toBe(ctx.routingTabs);
    expect(run.panel).toBeNull();
  });

  it('is a no-op on /harnesses without /routing suffix', () => {
    // The /harnesses/<name>/ URL shape only fires when /routing is the
    // last segment. A bare /harnesses/<name> URL (e.g. overview) is a
    // no-op.
    const ctx = buildContext();
    ctx.pathname = '/harnesses/my-harness';
    const run = runScriptOn(ctx);

    expect(ctx.containerLg.children.length).toBe(1);
    expect(ctx.containerLg.children[0]).toBe(ctx.routingTabs);
    expect(run.panel).toBeNull();
  });

  describe('clean-agent unified view (post-upstream-restructure layout)', () => {
    // Upstream restructured the routing page: agents that have never
    // configured complexity/specificity see a flat unified view
    // with .routing-cards (no .routing-tabs). The plugin must mount
    // the panel inline above the cards in this layout too, OR the
    // entire user base (most agents on first install) will not see
    // the audit surface.
    const routingShapes = [
      '/agents/my-agent/routing',
      '/harnesses/my-harness/routing',
    ];

    routingShapes.forEach((pathname) => {
      it(`mounts inline above .routing-cards on the clean-agent unified view (${pathname})`, () => {
        const ctx = buildContext('clean');
        ctx.pathname = pathname;
        const run = runScriptOn(ctx);

        expect(run.panel).not.toBeNull();
        // No .routing-tabs in clean view — that's the whole point.
        expect(ctx.routingTabs).toBeNull();
        // .routing-cards exists; panel must mount immediately before it.
        expect(ctx.routingCards).not.toBeNull();
        const children = ctx.containerLg.children;
        const panelIdx = children.findIndex(
          (c) => c.attrs && c.attrs.id === 'show-all-router-views-panel',
        );
        const cardsIdx = ctx.routingCards
          ? children.indexOf(ctx.routingCards)
          : -1;
        expect(panelIdx).toBeGreaterThanOrEqual(0);
        expect(cardsIdx).toBeGreaterThanOrEqual(0);
        expect(panelIdx).toBeLessThan(cardsIdx);
      });
    });
  });
});
