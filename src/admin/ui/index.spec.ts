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
 * The fixture below uses only the two in-tree plugins (default-policy,
 * header-tier-router). External plugins like anthropic-billing-header
 * can be added by the operator via external-plugins.local.json — the UI
 * shows them transparently.
 */
import '@testing-library/jest-dom';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import {
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
    id: 'default-policy',
    name: 'Default policy',
    version: '0.1.0',
    description: 'Applies the default request policy.',
    kind: 'policy',
    enabledByDefault: true,
    enabled: true,
  },
  {
    id: 'header-tier-router',
    name: 'Header tier router',
    version: '0.1.0',
    description: 'Routes by request header.',
    kind: 'routing-override',
    enabledByDefault: false,
    enabled: false,
  },
  {
    id: 'show-all-router-views',
    name: 'Show all router views',
    version: '0.1.0',
    description: 'Un-hides hidden routing views.',
    kind: 'dashboard-transform',
    enabledByDefault: true,
    enabled: true,
  },
];

let originalFetch: typeof fetch | undefined;

beforeEach(() => {
  originalFetch = global.fetch;
  jest.useFakeTimers();
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
    // Given: a fetch that resolves with the two in-tree plugins.
    const fetchMock = createAlwaysResolvingFetch();
    const target = document.createElement('div');
    document.body.appendChild(target);

    // When: the component mounts and the effect runs.
    mountPluginManager(target);
    await waitFor(() => expect(screen.getByTestId('plugin-list')).toBeTruthy());

    // Then: each plugin name and a checkbox is rendered, with the right
    // initial checked state.
    expect(screen.getByText('Default policy')).toBeTruthy();
    expect(screen.getByText('Header tier router')).toBeTruthy();
    const policyCheckbox = screen.getByTestId(
      'plugin-toggle-default-policy',
    ) as HTMLInputElement;
    const routerCheckbox = screen.getByTestId(
      'plugin-toggle-header-tier-router',
    ) as HTMLInputElement;
    expect(policyCheckbox.tagName).toBe('INPUT');
    expect(policyCheckbox.type).toBe('checkbox');
    expect(policyCheckbox.checked).toBe(true);
    expect(routerCheckbox.checked).toBe(false);
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

    // When: the header-tier-router checkbox is clicked (it starts unchecked).
    const routerCheckbox = screen.getByTestId(
      'plugin-toggle-header-tier-router',
    ) as HTMLInputElement;
    await act(async () => {
      routerCheckbox.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Then: the component issues a PATCH with enabled=true against the
    // right endpoint and JSON body.
    expect(patchCalls).toBe(1);
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const [urlArg, initArg] = patchCall as [string, RequestInit];
    expect(initArg.method).toBe('PATCH');
    expect(initArg.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(initArg.body as string)).toEqual({ enabled: true });
    expect(urlArg).toBe('/api/plugins/header-tier-router');
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
    const policyCheckbox = screen.getByTestId(
      'plugin-toggle-default-policy',
    ) as HTMLInputElement;
    expect(policyCheckbox.checked).toBe(true);

    // Suppress the expected unhandled rejection from the PATCH promise
    // (the component catches it internally with .catch; we still drain
    // microtasks so the revert state has flushed).
    const rejectionHandler = jest.fn();
    process.on('unhandledRejection', rejectionHandler);
    try {
      await act(async () => {
        policyCheckbox.click();
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
    expect(policyCheckbox.checked).toBe(true);
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

    // All three plugin kinds must render a kind pill with the right text.
    expect(screen.getByTestId('plugin-kind-default-policy')).toHaveTextContent('policy');
    expect(screen.getByTestId('plugin-kind-header-tier-router')).toHaveTextContent(
      'routing-override',
    );
    expect(screen.getByTestId('plugin-kind-show-all-router-views')).toHaveTextContent(
      'dashboard-transform',
    );
  });
});