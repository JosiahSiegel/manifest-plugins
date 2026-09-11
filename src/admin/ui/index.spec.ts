/**
 * @jest-environment jsdom
 *
 * Spec for the plugin manager UI island (src/admin/ui/index.tsx).
 *
 * The component is bundled into the admin dashboard page (T6 + T7). It
 * fetches `/api/plugins`, renders the list with toggle checkboxes, and
 * PATCHes `/api/plugins/:id` on toggle. Here we cover:
 *
 *   1. First-mount loading state shows a heading + loading indicator.
 *   2. After the fetch resolves, plugin names + checkboxes are rendered.
 *   3. Clicking a checkbox issues a PATCH with the new enabled value.
 *   4. PATCH failure reverts the checkbox to its previous state.
 *   5. After 5 seconds, fetch is invoked again (polling).
 *
 * The component source uses `React.createElement` (not JSX) because the
 * project's `tsconfig.json` has no `jsx` flag (and we cannot modify it);
 * the spec file does the same so both compile under the existing config.
 *
 * NOTE: The UI is generic — it renders whatever plugins the API returns.
 * The fixture uses only the in-tree plugins.
 */
import '@testing-library/jest-dom';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import {
  autoMountPluginManager,
  ensureResponsiveStylesInjected,
  handleToggleChange,
  hasAutoMountRoot,
  hasResponsiveStyle,
  isToggleDisabled,
  mountPluginManager,
  unmountPluginManager,
  type PluginMetadata,
} from './index';

interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

type FetchMock = jest.Mock<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>;

function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

const SAMPLE_PLUGINS: readonly PluginMetadata[] = [
  {
    id: 'show-all-router-views',
    name: 'Show all router views',
    version: '0.1.0',
    description: 'Un-hides hidden routing views.',
    kind: 'dashboard-transform',
    enabledByDefault: true,
    enabled: true,
  },
  {
    id: 'gpt-astra-model-list-override',
    name: 'OpenAI GPT-6 Astra compatibility shim',
    version: '0.1.0',
    description:
      'Adds the OpenAI GPT-6 Astra model row and reasoning-effort parameter spec.',
    kind: 'model-list-override',
    enabledByDefault: true,
    enabled: true,
  },
];

let originalFetch: typeof fetch | undefined;

beforeEach(() => {
  originalFetch = global.fetch;
  jest.useFakeTimers();
  const injected = document.querySelector('style[data-mwp-styles]');
  if (injected !== null) injected.remove();
  const root = document.getElementById('plugin-manager-root');
  if (root !== null) root.remove();
});

afterEach(() => {
  unmountPluginManager();
  cleanup();
  if (originalFetch === undefined) {
    delete (global as { fetch?: typeof fetch }).fetch;
  } else {
    global.fetch = originalFetch;
  }
  jest.useRealTimers();
});

function installFetchMock(impl: FetchMock): FetchMock {
  // The jest fetch mock returns our FetchResponseLike; we cast at the
  // boundary because jest is happy with looser fetch signatures.
  global.fetch = impl as unknown as typeof fetch;
  return impl;
}

function createAlwaysResolvingFetch(): FetchMock {
  const mock = jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>(
    () => Promise.resolve(jsonResponse({ plugins: SAMPLE_PLUGINS })),
  );
  return installFetchMock(mock);
}

describe('PluginManager UI', () => {
  it('mountPluginManager renders the heading and loading indicator on first mount', () => {
    // Given: a root div (no `plugin-manager-root` id, so the impl's
    // auto-mount on import is a no-op for this test) and a fetch that
    // never resolves (so the loading state remains visible).
    const pending = new Promise<FetchResponseLike>(() => undefined);
    const fetchMock = jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>(
      () => pending,
    );
    installFetchMock(fetchMock);
    const target = document.createElement('div');
    document.body.appendChild(target);

    // When: the component is mounted onto the root. We wrap in `act`
    // because React 19 schedules the initial commit asynchronously; in
    // production the browser's own scheduler flushes before paint, but
    // under jsdom the assertion runs before the commit without `act`.
    act(() => {
      mountPluginManager(target);
    });

    // Then: the heading and loading indicator are visible.
    expect(screen.getByRole('heading', { level: 2, name: 'Plugins' })).toBeTruthy();
    expect(screen.getByTestId('loading')).toHaveTextContent(/loading/i);
  });

  it('renders plugin names + checkboxes after the fetch resolves', async () => {
    // Given: a fetch that resolves with the in-tree plugins.
    const fetchMock = createAlwaysResolvingFetch();
    const target = document.createElement('div');
    document.body.appendChild(target);

    // When: the component mounts and the effect runs.
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());

    // Then: each plugin name and a checkbox is rendered, with the right
    // initial checked state.
    expect(screen.getByText('Show all router views')).toBeTruthy();
    const routerCheckbox = screen.getByTestId(
      'plugin-toggle-show-all-router-views',
    ) as HTMLInputElement;
    expect(routerCheckbox.tagName).toBe('INPUT');
    expect(routerCheckbox.type).toBe('checkbox');
    expect(routerCheckbox.checked).toBe(true);
  });

  it('clicking a checkbox PATCHes the API with the new enabled value', async () => {
    // Given: the initial GET resolves, then any PATCH resolves with an
    // echo body for the targeted plugin id.
    let patchCalls = 0;
    const fetchMock = jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>(
      (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method ?? 'GET';
        if (method === 'GET') {
          return Promise.resolve(jsonResponse({ plugins: SAMPLE_PLUGINS }));
        }
        if (method === 'PATCH') {
          patchCalls += 1;
          const body = JSON.parse((init?.body as string) ?? '{}') as { enabled: boolean };
          const id = decodeURIComponent(url.split('/').pop() ?? '');
          const target = SAMPLE_PLUGINS.find((p) => p.id === id);
          if (target === undefined) {
            return Promise.resolve(jsonResponse({ error: 'not found' }, 404));
          }
          return Promise.resolve(
            jsonResponse({ plugin: { ...target, enabled: body.enabled } }),
          );
        }
        return Promise.resolve(jsonResponse({}, 200));
      },
    );
    installFetchMock(fetchMock);
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());

    // When: the show-all-router-views checkbox is clicked (it starts checked).
    const routerCheckbox = screen.getByTestId(
      'plugin-toggle-show-all-router-views',
    ) as HTMLInputElement;
    await act(async () => {
      routerCheckbox.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Then: the component issues a PATCH with enabled=false against the
    // right endpoint and JSON body.
    expect(patchCalls).toBe(1);
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const [urlArg, initArg] = patchCall as [string, RequestInit];
    expect(initArg.method).toBe('PATCH');
    expect(initArg.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(initArg.body as string)).toEqual({ enabled: false });
    expect(urlArg).toBe('/api/plugins/show-all-router-views');
  });

  it('PATCH failure reverts the checkbox to its previous state', async () => {
    // Given: GET resolves, but PATCH always rejects.
    const fetchMock = jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>(
      (_input, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET') {
          return Promise.resolve(jsonResponse({ plugins: SAMPLE_PLUGINS }));
        }
        return Promise.reject(new Error('PATCH failed (500)'));
      },
    );
    installFetchMock(fetchMock);
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());

    // When: the checkbox is clicked (initial value: checked=true), the
    // optimistic update flips it to false, and the PATCH fails.
    const routerCheckbox = screen.getByTestId(
      'plugin-toggle-show-all-router-views',
    ) as HTMLInputElement;
    expect(routerCheckbox.checked).toBe(true);

    // Suppress the expected unhandled rejection from the PATCH promise
    // (the component catches it internally with .catch; we still drain
    // microtasks so the revert state has flushed).
    const rejectionHandler = jest.fn();
    process.on('unhandledRejection', rejectionHandler);
    try {
      await act(async () => {
        routerCheckbox.click();
        // Allow the optimistic update to flush, then the .catch handler.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      // Flush any further queued microtasks from the rejection.
      await act(async () => {
        await Promise.resolve();
      });
    } finally {
      process.off('unhandledRejection', rejectionHandler);
    }

    // Then: the checkbox is reverted to checked=true.
    expect(routerCheckbox.checked).toBe(true);
  });

  it('polls /api/plugins again after 5 seconds', async () => {
    // Given: a fetch mock that always returns the same plugin list.
    const fetchMock = createAlwaysResolvingFetch();
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());

    // Establish the baseline call count after the initial fetch resolves.
    // The component fetches once on mount, then again every POLL_INTERVAL_MS.
    const callsAfterMount = fetchMock.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThanOrEqual(1);

    // When: we advance fake timers past one poll interval.
    const POLL_INTERVAL_MS = 5000;
    await act(async () => {
      jest.advanceTimersByTime(POLL_INTERVAL_MS);
      // Allow the queued fetch's then-handler to run.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Then: at least one additional fetch has been issued, and every new
    // call targeted the GET endpoint with no method override.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
    for (let i = callsAfterMount; i < fetchMock.mock.calls.length; i += 1) {
      const call = fetchMock.mock.calls[i];
      expect(call).toBeDefined();
      const [inputArg, initArg] = call as [RequestInfo | URL, RequestInit];
      const url = typeof inputArg === 'string' ? inputArg : inputArg.toString();
      expect(url).toBe('/api/plugins');
      expect((initArg?.method ?? 'GET')).toBe('GET');
    }
  });

  it('renders empty descriptions without a description paragraph', async () => {
    installFetchMock(jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>(() => Promise.resolve(jsonResponse({ plugins: [{ ...SAMPLE_PLUGINS[0], description: '' }] }))));
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());
    expect(document.querySelector('.mwp-plugin-row__desc')).toBeNull();
  });

  it('renders a kind pill for every installed plugin kind, including dashboard-transform', async () => {
    // Regression: KIND_PILL_TINT did not include the new 'dashboard-transform'
    // kind, so the row crashed with "Cannot read properties of undefined
    // (reading 'bg')" at the first render. This test pins the contract that
    // every plugin the API returns renders without throwing.
    createAlwaysResolvingFetch();
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());

    // The plugin's kind must render a kind pill with the right text.
    expect(screen.getByTestId('plugin-kind-show-all-router-views')).toHaveTextContent(
      'dashboard-transform',
    );
  });

  it('renders an error state when the initial plugin response is not ok', async () => {
    installFetchMock(jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>(() => Promise.resolve(jsonResponse({}, 503))));
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('error')).toBeTruthy());
    expect(screen.getByTestId('error')).toHaveTextContent('GET /api/plugins → 503');
  });

  it('uses the unknown-error fallback for a malformed initial fetch failure', async () => {
    installFetchMock(jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>(() => Promise.reject({})));
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('error')).toBeTruthy());
    expect(screen.getByTestId('error')).toHaveTextContent('Unknown error');
  });

  it('shows an error when patchPlugin receives a non-OK response', async () => {
    installFetchMock(jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>((input, init) => {
      if ((init?.method ?? 'GET') === 'PATCH') return Promise.resolve(jsonResponse({}, 500));
      return Promise.resolve(jsonResponse({ plugins: SAMPLE_PLUGINS }));
    }));
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());
    await act(async () => {
      (screen.getByTestId('plugin-toggle-show-all-router-views') as HTMLInputElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('refresh-error')).toBeTruthy());
    expect(screen.getByTestId('refresh-error')).toHaveTextContent('PATCH /api/plugins/show-all-router-views → 500');
  });

  it('shows an error for an unexpected plugin response shape', async () => {
    installFetchMock(jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>(() => Promise.resolve(jsonResponse({ plugins: {} }))));
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('error')).toBeTruthy());
    expect(screen.getByTestId('error')).toHaveTextContent('unexpected /api/plugins shape');
  });

  it('renders a refresh error while retaining previously loaded plugins', async () => {
    let calls = 0;
    installFetchMock(jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(jsonResponse({ plugins: SAMPLE_PLUGINS }))
        : Promise.resolve(jsonResponse({}, 503));
    }));
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());
    await act(async () => {
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('refresh-error')).toBeTruthy());
    expect(screen.getByTestId('refresh-error')).toHaveTextContent('Refresh failed');
  });

  it('shows the singular plugin count and idempotent style/mount behavior', async () => {
    installFetchMock(jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>(() => Promise.resolve(jsonResponse({ plugins: [SAMPLE_PLUGINS[0]] }))));
    const target = document.createElement('div');
    document.body.appendChild(target);
    act(() => {
      mountPluginManager(target);
      mountPluginManager(target);
    });
    await waitFor(() => expect(screen.getByTestId('plugin-count')).toHaveTextContent('1 plugin'));
    expect(screen.getByTestId('plugin-count')).toHaveTextContent('1 plugin');
    const checkbox = screen.getByTestId('plugin-toggle-show-all-router-views') as HTMLInputElement;
    fireEvent.change(checkbox, { target: { checked: true } });
    expect(checkbox.checked).toBe(true);
    expect(document.querySelectorAll('style[data-mwp-styles]')).toHaveLength(1);
    unmountPluginManager();
    unmountPluginManager();
  });

  it('shows a refresh error when a PATCH response has no plugin payload', async () => {
    const fetchMock = jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>((input, init) => {
      if ((init?.method ?? 'GET') === 'PATCH') return Promise.resolve(jsonResponse({}));
      return Promise.resolve(jsonResponse({ plugins: SAMPLE_PLUGINS }));
    });
    installFetchMock(fetchMock);
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());
    await act(async () => {
      (screen.getByTestId('plugin-toggle-show-all-router-views') as HTMLInputElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('refresh-error')).toBeTruthy());
    expect(screen.getByTestId('refresh-error')).toHaveTextContent('unexpected PATCH response shape');
  });

  it('shows a refresh error when a previously loaded plugin list fetch rejects', async () => {
    let calls = 0;
    installFetchMock(jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(jsonResponse({ plugins: SAMPLE_PLUGINS }))
        : Promise.reject(new Error('refresh transport failed'));
    }));
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());
    await act(async () => {
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('refresh-error')).toBeTruthy());
    expect(screen.getByTestId('refresh-error')).toHaveTextContent('refresh transport failed');
  });

  it('renders the singular count after the loaded list resolves', async () => {
    installFetchMock(jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>(() => Promise.resolve(jsonResponse({ plugins: [SAMPLE_PLUGINS[0]] }))));
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-count')).toHaveTextContent('1 plugin'));
    expect(screen.getByTestId('plugin-count')).toHaveTextContent('1 plugin');
  });

  it('does not invoke a disabled toggle callback', async () => {
    const calls: boolean[] = [];
    handleToggleChange(true, true, (checked) => calls.push(checked));
    expect(calls).toEqual([]);
    handleToggleChange(false, true, (checked) => calls.push(checked));
    expect(calls).toEqual([true]);

    const fetchMock = createAlwaysResolvingFetch();
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());
    const checkbox = screen.getByTestId('plugin-toggle-show-all-router-views') as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    await act(async () => {
      checkbox.click();
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true);
    const disabledTarget = document.createElement('div');
    disabledTarget.innerHTML = '<input type="checkbox">';
    const disabledCheckbox = disabledTarget.querySelector('input') as HTMLInputElement;
    disabledCheckbox.disabled = true;
    disabledCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(disabledCheckbox.disabled).toBe(true);
  });

  it('does not auto-mount when the root element is absent in an isolated module', () => {
    jest.isolateModules(() => {
      const root = document.getElementById('plugin-manager-root');
      root?.remove();
      expect(() => require('./index')).not.toThrow();
    });
  });

  it('no-ops style injection and auto-mount when no document is supplied', () => {
    expect(() => ensureResponsiveStylesInjected(null)).not.toThrow();
    expect(() => autoMountPluginManager(null)).not.toThrow();
  });

  it('injects styles once and auto-mounts only when a root exists', () => {
    ensureResponsiveStylesInjected(document);
    const before = document.querySelectorAll('style[data-mwp-styles]').length;
    ensureResponsiveStylesInjected(document);
    expect(document.querySelectorAll('style[data-mwp-styles]')).toHaveLength(before);
    const root = document.createElement('div');
    root.id = 'plugin-manager-root';
    document.body.appendChild(root);
    expect(() => autoMountPluginManager(document)).not.toThrow();
  });

  it('does not mount again when the responsive style is already present', async () => {
    const preexisting = document.createElement('style');
    preexisting.setAttribute('data-mwp-styles', 'manifest-plugins-admin-ui');
    document.head.appendChild(preexisting);
    installFetchMock(createAlwaysResolvingFetch());
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());
    expect(document.querySelectorAll('style[data-mwp-styles]')).toHaveLength(1);
  });

  it('ignores timer refresh while a PATCH is pending', async () => {
    let resolvePatch: ((response: FetchResponseLike) => void) | undefined;
    const fetchMock = jest.fn<Promise<FetchResponseLike>, [RequestInfo | URL, RequestInit?]>((input, init) => {
      if ((init?.method ?? 'GET') === 'PATCH') return new Promise((resolve) => { resolvePatch = resolve; });
      return Promise.resolve(jsonResponse({ plugins: SAMPLE_PLUGINS }));
    });
    installFetchMock(fetchMock);
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());
    await act(async () => {
      (screen.getByTestId('plugin-toggle-show-all-router-views') as HTMLInputElement).click();
      await Promise.resolve();
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === 'GET')).toHaveLength(1);
    resolvePatch?.(jsonResponse({ plugin: { ...SAMPLE_PLUGINS[0], enabled: false } }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  });

  it('keeps a toggle disabled while its PATCH is pending', async () => {
    let resolvePatch: ((response: FetchResponseLike) => void) | undefined;
    const patch = new Promise<FetchResponseLike>((resolve) => {
      resolvePatch = resolve;
    });
    installFetchMock(jest.fn((input, init) => {
      if ((init?.method ?? 'GET') === 'PATCH') return patch;
      return Promise.resolve(jsonResponse({ plugins: SAMPLE_PLUGINS }));
    }));
    const target = document.createElement('div');
    document.body.appendChild(target);
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());
    const checkbox = screen.getByTestId('plugin-toggle-show-all-router-views') as HTMLInputElement;
    await act(async () => {
      checkbox.click();
      await Promise.resolve();
    });
    expect(checkbox.disabled).toBe(true);
    fireEvent.change(checkbox, { target: { checked: true } });
    expect(checkbox.checked).toBe(true);
    resolvePatch?.(jsonResponse({ plugin: { ...SAMPLE_PLUGINS[0], enabled: false } }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(checkbox.disabled).toBe(false);
  });

  it('exercises both arms of the disabled guard through the production seam', () => {
    expect(isToggleDisabled(true)).toBe(true);
    expect(isToggleDisabled(false)).toBe(false);
    expect(isToggleDisabled(undefined)).toBe(false);
  });

  it('exercises the style and auto-mount nullish branches through the production seams', () => {
    const initialStyles = document.querySelectorAll('style[data-mwp-styles]').length;
    ensureResponsiveStylesInjected(null);
    expect(document.querySelectorAll('style[data-mwp-styles]').length).toBe(initialStyles);
    ensureResponsiveStylesInjected(document);
    expect(document.querySelectorAll('style[data-mwp-styles]').length).toBe(initialStyles + 1);
    expect(() => autoMountPluginManager(null)).not.toThrow();
    expect(hasAutoMountRoot()).toBe(false);
    const root = document.createElement('div');
    root.id = 'plugin-manager-root';
    document.body.appendChild(root);
    expect(hasAutoMountRoot()).toBe(true);
    expect(() => autoMountPluginManager(document)).not.toThrow();
  });

  it('returns safe defaults for an explicitly absent browser document', () => {
    expect(hasResponsiveStyle(null)).toBe(false);
    expect(hasAutoMountRoot(null)).toBe(false);
    expect(() => ensureResponsiveStylesInjected(null)).not.toThrow();
    expect(() => autoMountPluginManager(null)).not.toThrow();
  });

  it('reports responsive style and auto-mount root state from the current document', () => {
    expect(hasResponsiveStyle()).toBe(false);
    const style = document.createElement('style');
    style.setAttribute('data-mwp-styles', 'manifest-plugins-admin-ui');
    document.head.appendChild(style);
    expect(hasResponsiveStyle()).toBe(true);
    style.remove();

    const root = document.createElement('div');
    root.id = 'plugin-manager-root';
    document.body.appendChild(root);
    expect(hasAutoMountRoot()).toBe(true);
    root.remove();
    expect(hasAutoMountRoot()).toBe(false);
  });

  it('reports auto-mount root state from the current document', () => {
    const root = document.createElement('div');
    root.id = 'plugin-manager-root';
    document.body.appendChild(root);
    expect(hasAutoMountRoot()).toBe(true);
    root.remove();
    expect(hasAutoMountRoot()).toBe(false);
  });
});