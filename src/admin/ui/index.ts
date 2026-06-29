/**
 * Plugin manager UI island.
 *
 * Single-file React 19 component that mounts on
 * `<div id="plugin-manager-root">` and provides a clickable list of
 * installed plugins with toggle checkboxes. Calls the admin HTTP API
 * (src/admin/server.ts) for read/write.
 *
 * Bundle shape: esbuild compiles this file into `dist/admin/admin.js`
 * as a single IIFE bundle (no externals — react and react-dom are
 * bundled). The bundle is served at `/admin/admin.js` by the admin
 * server and loaded by the dashboard mount overlay (T7).
 *
 * Behavior:
 *   - On mount: fetch `GET /api/plugins` → render the list.
 *   - On toggle: optimistic update + `PATCH /api/plugins/:id`; revert
 *     on failure (with the error surfaced in the UI).
 *   - Polling: re-fetch every 5 seconds; clear the interval on unmount.
 *   - The component does NOT include a router or shared store. It is a
 *     pure island that fetches the API directly. State is local to
 *     the component (useState + useEffect).
 *
 * Why `React.createElement` (no JSX)?
 *   The project's `tsconfig.json` has no `jsx` flag (and we cannot
 *   modify it, and we cannot extend it via a separate tsconfig.ui.json
 *   because jest's testMatch matches only `.spec.ts` and the
 *   transformer requires `jsx` set for `.tsx` files). The file is
 *   therefore saved as `.ts` with no JSX literals — esbuild still
 *   transpiles this fine when invoked with `--jsx=automatic` (T6), and
 *   the spec file compiles under the same ts-jest config and stays
 *   JSX-free.
 */
import { createElement, useCallback, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export type PluginKind = 'transform' | 'policy' | 'routing-override';

export interface PluginMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly kind: PluginKind;
  readonly enabledByDefault: boolean;
  readonly enabled: boolean;
}

interface PluginManagerState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly plugins: readonly PluginMetadata[];
  readonly error: string | null;
}

const POLL_INTERVAL_MS = 5000;

interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

async function fetchPlugins(): Promise<readonly PluginMetadata[]> {
  const res = (await fetch('/api/plugins')) as unknown as FetchResponseLike;
  if (!res.ok) throw new Error(`GET /api/plugins → ${res.status}`);
  const body = (await res.json()) as { plugins?: unknown };
  if (!Array.isArray(body.plugins)) throw new Error('unexpected /api/plugins shape');
  return body.plugins as readonly PluginMetadata[];
}

async function patchPlugin(id: string, enabled: boolean): Promise<PluginMetadata> {
  const res = (await fetch(`/api/plugins/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })) as unknown as FetchResponseLike;
  if (!res.ok) throw new Error(`PATCH /api/plugins/${id} → ${res.status}`);
  const body = (await res.json()) as { plugin?: PluginMetadata };
  if (body.plugin === undefined) throw new Error('unexpected PATCH response shape');
  return body.plugin;
}

function PluginRow(props: {
  readonly plugin: PluginMetadata;
  readonly onToggle: (id: string, enabled: boolean) => void;
}): React.ReactElement {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      props.onToggle(props.plugin.id, e.target.checked);
    },
    [props.onToggle, props.plugin.id],
  );
  return createElement(
    'li',
    {
      style: { padding: '8px 0', borderBottom: '1px solid #e5e7eb' },
    },
    createElement(
      'label',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          cursor: 'pointer',
        },
      },
      createElement('input', {
        type: 'checkbox',
        checked: props.plugin.enabled,
        onChange: handleChange,
        'data-testid': `plugin-toggle-${props.plugin.id}`,
        'aria-label': `Toggle ${props.plugin.name}`,
      }),
      createElement(
        'span',
        { style: { flex: 1, fontWeight: 500 } },
        props.plugin.name,
        createElement(
          'small',
          { style: { color: '#6b7280', marginLeft: '8px' } },
          `(${props.plugin.id})`,
        ),
      ),
      createElement(
        'span',
        { style: { color: '#6b7280', fontSize: '0.85em' } },
        props.plugin.kind,
      ),
    ),
  );
}

export function PluginManager(): React.ReactElement {
  const [state, setState] = useState<PluginManagerState>({
    status: 'loading',
    plugins: [],
    error: null,
  });

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const plugins = await fetchPlugins();
      setState({ status: 'ready', plugins, error: null });
    } catch (err) {
      // Preserve the previously-loaded list when a refresh fails so the
      // UI doesn't lose context — surface only the error message.
      setState((prev) => ({
        status: prev.plugins.length === 0 ? 'error' : prev.status,
        plugins: prev.plugins,
        error: (err as Error).message,
      }));
    }
  }, []);

  const handleToggle = useCallback(
    async (id: string, enabled: boolean): Promise<void> => {
      // Optimistic update: flip locally first, send the PATCH, revert
      // on failure.
      setState((prev) => ({
        ...prev,
        plugins: prev.plugins.map((p) => (p.id === id ? { ...p, enabled } : p)),
      }));
      try {
        await patchPlugin(id, enabled);
      } catch (err) {
        setState((prev) => ({
          ...prev,
          plugins: prev.plugins.map((p) =>
            p.id === id ? { ...p, enabled: !enabled } : p,
          ),
          error: (err as Error).message,
        }));
      }
    },
    [],
  );

  useEffect((): (() => void) => {
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return (): void => clearInterval(id);
  }, [refresh]);

  return createElement(
    'div',
    {
      style: {
        fontFamily: 'system-ui, -apple-system, sans-serif',
        background: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        padding: '16px',
        maxWidth: '720px',
        margin: '24px auto',
      },
    },
    createElement(
      'h2',
      { style: { margin: '0 0 12px 0', fontSize: '1.25rem' } },
      'Plugins',
    ),
    state.status === 'loading'
      ? createElement(
          'p',
          { style: { color: '#6b7280' }, 'data-testid': 'loading' },
          'Loading…',
        )
      : null,
    state.status === 'error'
      ? createElement(
          'p',
          { style: { color: '#b91c1c' }, 'data-testid': 'error' },
          state.error ?? 'Unknown error',
        )
      : null,
    createElement(
      'ul',
      {
        style: { listStyle: 'none', margin: 0, padding: 0 },
        'data-testid': 'plugin-list',
      },
      state.plugins.map((plugin) =>
        createElement(PluginRow, {
          key: plugin.id,
          plugin,
          onToggle: handleToggle,
        }),
      ),
    ),
    createElement(
      'p',
      { style: { marginTop: '12px', color: '#6b7280', fontSize: '0.85em' } },
      'Changes are persisted to ',
      createElement('code', null, '$MANIFEST_PLUGINS_STATE_FILE'),
      ' and take effect immediately.',
    ),
  );
}

let mountedRoot: Root | null = null;

export function mountPluginManager(target: HTMLElement): void {
  if (mountedRoot !== null) return; // idempotent — only one mount at a time
  mountedRoot = createRoot(target);
  mountedRoot.render(createElement(PluginManager));
}

export function unmountPluginManager(): void {
  if (mountedRoot !== null) {
    mountedRoot.unmount();
    mountedRoot = null;
  }
}

// Auto-mount when the bundle is loaded into a page that already has the
// root div injected by the dashboard mount overlay.
if (typeof document !== 'undefined') {
  const auto = document.getElementById('plugin-manager-root');
  if (auto !== null) mountPluginManager(auto);
}
