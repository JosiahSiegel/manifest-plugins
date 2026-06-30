/**
 * Plugin manager UI island.
 *
 * Single-file React 19 component that mounts on
 * `<div id="plugin-manager-root">` and provides a clickable list of
 * installed plugins with toggle switches. Calls the admin HTTP API
 * (src/admin/server.ts) for read/write.
 *
 * Bundle shape: esbuild compiles this file into `dist/admin/admin.js`
 * as a single IIFE bundle (no externals — react and react-dom are
 * bundled). The bundle is served at `/admin/admin.js` by the admin
 * server and loaded by the dashboard mount overlay (mount-dashboard).
 *
 * Visual design — matches the upstream Manifest dashboard:
 *   The mount div is injected before `</body>` in
 *   `packages/frontend/index.html`, OUTSIDE the React root and OUTSIDE
 *   `.main-content`. To read as a native extension of the dashboard
 *   instead of a floating element, the panel adopts the dashboard's
 *   layout constraints directly:
 *     - margin-left: var(--sidebar-width, 230px)
 *     - padding: var(--gap-xl) var(--gap-xl) var(--gap-2xl)
 *     - max-width: 100% with sensible inner max via container
 *   All CSS variables are defined by the upstream `theme.css`; if the
 *   upstream ever renames a var, we fall back to literal values.
 *
 *   Color/spacing/typography are also dashboard-native:
 *     - body uses `var(--font-family)` (DM Sans) by inheritance
 *     - id / version use `var(--font-mono)` (JetBrains Mono)
 *     - kind pills use the same `status-badge` visual language
 *     - card surface uses `hsl(var(--card))` with the standard
 *       1px halo `box-shadow: rgba(0,0,0,0.08) 0px 0px 0px 1px`
 *
 * Behavior:
 *   - On mount: fetch `GET /api/plugins` → render the list.
 *   - On toggle: optimistic update + `PATCH /api/plugins/:id`; revert
 *     on failure (with the error surfaced in the UI). Polling is
 *     suppressed while a PATCH is in flight to prevent the periodic
 *     GET from racing the optimistic state.
 *   - Polling: re-fetch every 5 seconds; clear the interval on unmount.
 *   - The component does NOT include a router or shared store. It is a
 *     pure island that fetches the API directly. State is local to the
 *     component (useState + useEffect).
 *
 * Why `React.createElement` (no JSX)?
 *   The project's `tsconfig.json` has no `jsx` flag (and we cannot
 *   modify it, and we cannot extend it via a separate tsconfig.ui.json
 *   because jest's testMatch matches only `.spec.ts` and the
 *   transformer requires `jsx` set for `.tsx` files). The file is
 *   therefore saved as `.ts` with no JSX literals — esbuild still
 *   transpiles this fine when invoked with `--jsx=automatic`, and the
 *   spec file compiles under the same ts-jest config and stays
 *   JSX-free.
 */
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
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

// =============================================================================
// Theme tokens
// =============================================================================
//
// The dashboard's `theme.css` declares CSS custom properties on `:root`
// (and overrides them under `.dark`). We use those variables directly so the
// panel adopts whichever theme (light / dark / custom) the dashboard is
// currently rendering. Where the dashboard does not declare a variable we
// fall back to a literal value matching the dashboard's dark palette, so
// the panel still reads correctly in isolation (e.g. served from the
// admin standalone).
//
// Color expression convention follows the dashboard:
//   - text uses `hsl(var(--foreground))` etc.
//   - surfaces use `hsl(var(--card))` for elevated panels
//   - 1px halo shadow for elevation: `rgba(0,0,0,0.08) 0 0 0 1px`
//
// Pill (status-badge) styling copied from upstream `.status-badge`:
//   padding: 2px 8px; border-radius: 9999px; font-size: var(--font-size-xs);
//   font-weight: 500; display: inline-flex; align-items: center;
const KIND_PILL_TINT: Readonly<Record<PluginKind, { readonly bg: string; readonly fg: string }>> = {
  // Mirror the dashboard's chart palette so the pills read as "one of the
  // chart colors" rather than arbitrary hues.
  transform: { bg: 'hsl(var(--chart-1) / 0.15)', fg: 'hsl(var(--chart-1))' },          // teal/cyan
  policy: { bg: 'hsl(var(--success) / 0.12)', fg: 'hsl(var(--success))' },              // emerald
  'routing-override': { bg: 'hsl(var(--chart-5) / 0.15)', fg: 'hsl(var(--chart-5))' }, // amber
};

// =============================================================================
// Components
// =============================================================================

/**
 * Toggle switch styled to match the shadcn `Switch` primitive the
 * dashboard is built on. Renders a `<label>` with an absolutely-
 * positioned invisible `<input type="checkbox">` (focusable for
 * keyboard / a11y) plus a visible track + thumb built from spans.
 *
 * Uses CSS variables so it adopts the dashboard's focus ring color
 * and primary accent (`--ring`, `--foreground`).
 */
function ToggleSwitch(props: {
  readonly id: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}): React.ReactElement {
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      if (props.disabled === true) return;
      props.onChange(e.target.checked);
    },
    [props],
  );

  return createElement(
    'label',
    {
      // Label is the click target. The native checkbox fires onChange.
      // We deliberately do NOT add an onClick on the label — that
      // double-fires with the input's change event.
      className: 'mwp-toggle',
      'aria-label': props.id,
      style: {
        position: 'relative',
        display: 'inline-block',
        width: '36px',
        height: '20px',
        cursor: props.disabled === true ? 'not-allowed' : 'pointer',
        flexShrink: 0,
        opacity: props.disabled === true ? 0.5 : 1,
      },
    },
    createElement('input', {
      type: 'checkbox',
      checked: props.checked,
      onChange: handleInputChange,
      disabled: props.disabled === true,
      'data-testid': `plugin-toggle-${props.id}`,
      className: 'mwp-toggle__input',
      style: {
        position: 'absolute',
        opacity: 0,
        width: '100%',
        height: '100%',
        margin: 0,
        cursor: 'inherit',
        zIndex: 1,
      },
      tabIndex: 0,
    }),
    createElement('span', {
      'aria-hidden': true,
      className: 'mwp-toggle__track',
      style: {
        position: 'absolute',
        inset: 0,
        borderRadius: '999px',
        background: props.checked
          ? 'hsl(var(--foreground))'
          : 'hsl(var(--muted) / 0.6)',
        transition: 'background 150ms cubic-bezier(0.4, 0, 0.2, 1)',
        pointerEvents: 'none',
      },
    }),
    createElement('span', {
      'aria-hidden': true,
      className: 'mwp-toggle__thumb',
      style: {
        position: 'absolute',
        top: '2px',
        left: props.checked ? '18px' : '2px',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: props.checked ? 'hsl(var(--background))' : 'hsl(var(--foreground))',
        transition: 'left 150ms cubic-bezier(0.4, 0, 0.2, 1)',
        pointerEvents: 'none',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
      },
    }),
  );
}

function PluginRow(props: {
  readonly plugin: PluginMetadata;
  readonly onToggle: (id: string, enabled: boolean) => void;
  readonly pending: boolean;
}): React.ReactElement {
  const handleToggle = useCallback(
    (enabled: boolean): void => {
      props.onToggle(props.plugin.id, enabled);
    },
    [props.onToggle, props.plugin.id],
  );

  const pillTint = KIND_PILL_TINT[props.plugin.kind];

  return createElement(
    'li',
    {
      className: 'mwp-plugin-row',
      style: {
        listStyle: 'none',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        gap: '16px',
        alignItems: 'center',
        padding: '14px 0',
        borderBottom: '1px solid hsl(var(--border))',
      },
    },
    createElement(ToggleSwitch, {
      id: props.plugin.id,
      checked: props.plugin.enabled,
      onChange: handleToggle,
      disabled: props.pending,
    }),
    createElement(
      'div',
      { className: 'mwp-plugin-row__body', style: { minWidth: 0 } },
      createElement(
        'div',
        {
          className: 'mwp-plugin-row__title',
          style: {
            display: 'flex',
            alignItems: 'baseline',
            gap: '10px',
            flexWrap: 'wrap',
          },
        },
        createElement(
          'span',
          {
            style: {
              color: 'hsl(var(--foreground))',
              fontSize: 'var(--font-size-sm)',
              fontWeight: 500,
            },
          },
          props.plugin.name,
        ),
        createElement(
          'span',
          {
            style: {
              color: 'hsl(var(--muted-foreground))',
              fontSize: 'var(--font-size-xs)',
              fontFamily: 'var(--font-mono)',
            },
          },
          props.plugin.id,
        ),
        createElement(
          'span',
          {
            style: {
              color: 'hsl(var(--muted-foreground))',
              fontSize: 'var(--font-size-xs)',
              fontFamily: 'var(--font-mono)',
            },
          },
          `v${props.plugin.version}`,
        ),
      ),
      props.plugin.description !== ''
        ? createElement(
            'p',
            {
              className: 'mwp-plugin-row__desc',
              style: {
                margin: '4px 0 0 0',
                color: 'hsl(var(--muted-foreground))',
                fontSize: 'var(--font-size-sm)',
                lineHeight: 1.5,
                overflowWrap: 'anywhere',
              },
            },
            props.plugin.description,
          )
        : null,
    ),
    createElement(
      'span',
      {
        'data-testid': `plugin-kind-${props.plugin.id}`,
        className: 'status-badge',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          padding: '2px 8px',
          borderRadius: '9999px',
          fontSize: 'var(--font-size-xs)',
          fontWeight: 500,
          background: pillTint.bg,
          color: pillTint.fg,
          whiteSpace: 'nowrap',
          flexShrink: 0,
          alignSelf: 'flex-start',
        },
      },
      props.plugin.kind,
    ),
  );
}

export function PluginManager(): React.ReactElement {
  const [state, setState] = useState<PluginManagerState>({
    status: 'loading',
    plugins: [],
    error: null,
  });

  // Tracks which plugin id (if any) has a PATCH currently in flight.
  // While non-null:
  //   - that plugin's toggle is disabled (visual feedback)
  //   - the periodic poll skips its GET (avoids racing the PATCH)
  // After the PATCH resolves we either clear the flag (success) or
  // surface the error message in the UI (failure).
  const pendingPatchRef = useRef<string | null>(null);
  const [pendingPatch, setPendingPatch] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    // Skip the periodic poll while a PATCH is in flight. The PATCH
    // handler updates the in-memory map synchronously, so the next
    // poll after the PATCH resolves will already reflect the new state.
    // Without this guard the poll can fire between the optimistic
    // setState and the PATCH resolving, briefly overwriting the UI
    // with stale server state.
    if (pendingPatchRef.current !== null) return;
    try {
      const plugins = await fetchPlugins();
      setState({ status: 'ready', plugins, error: null });
    } catch (err) {
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
      // on failure. Mark the patch as in flight so the poll skips.
      pendingPatchRef.current = id;
      setPendingPatch(id);
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
      } finally {
        pendingPatchRef.current = null;
        setPendingPatch(null);
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
    'section',
    {
      'data-testid': 'plugin-manager',
      className: 'mwp-plugin-manager',
      style: {
        // Adopt the dashboard's `.main-content` layout so the panel
        // sits flush with the table column above and the sidebar
        // doesn't overlap the leftmost column (toggle). Fallback
        // values match the upstream `theme.css` defaults so the panel
        // still reads correctly if the dashboard hasn't loaded yet.
        //
        // `.main-content` upstream is:
        //   flex: 1; margin-left: var(--sidebar-width);
        //   padding: var(--gap-xl) var(--gap-xl) var(--gap-2xl);
        //   min-width: 0;
        // We mirror that here, but our mount point is a child of
        // `<body>` (not a flex container), so we explicitly set
        // `width` to leave room for the sidebar offset.
        marginLeft: 'var(--sidebar-width, 230px)',
        width: 'calc(100% - var(--sidebar-width, 230px))',
        padding: 'var(--gap-xl, 32px) var(--gap-xl, 32px) var(--gap-2xl, 48px)',
        color: 'hsl(var(--foreground))',
        fontFamily: 'var(--font-family)',
        boxSizing: 'border-box',
        minWidth: 0,
      },
    },
    createElement(
      'div',
      {
        // Inner container matches `.container--md` (max 1100px) so
        // the panel lines up with the dashboard's main column on
        // very wide viewports while filling the column on smaller
        // screens.
        className: 'mwp-plugin-manager__inner',
        style: {
          maxWidth: '1100px',
          margin: '0 auto',
        },
      },
      createElement(
        'header',
        {
          className: 'page-header',
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            gap: '16px',
            marginBottom: 'var(--gap-lg, 24px)',
            paddingBottom: 'var(--gap-lg, 24px)',
            borderBottom: '1px solid hsl(var(--border))',
          },
        },
        createElement(
          'div',
          null,
          createElement(
            'h2',
            {
              style: {
                margin: 0,
                fontFamily: 'var(--font-heading)',
                fontSize: 'var(--font-size-2xl, 1.875rem)',
                fontWeight: 700,
                letterSpacing: '-0.025em',
                lineHeight: 1.2,
                color: 'hsl(var(--foreground))',
              },
            },
            'Plugins',
          ),
          createElement(
            'p',
            {
              className: 'breadcrumb',
              style: {
                marginTop: '2px',
                fontSize: 'var(--font-size-sm, 0.875rem)',
                color: 'hsl(var(--muted-foreground))',
              },
            },
            'Installed plugins and their runtime enabled state.',
          ),
        ),
        createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--gap-sm, 8px)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            },
          },
          createElement(
            'span',
            {
              style: {
                color: 'hsl(var(--muted-foreground))',
                fontSize: 'var(--font-size-sm, 0.875rem)',
              },
              'data-testid': 'plugin-count',
            },
            state.plugins.length === 1 ? '1 plugin' : `${state.plugins.length} plugins`,
          ),
        ),
      ),
      state.status === 'loading'
        ? createElement(
            'p',
            {
              style: {
                color: 'hsl(var(--muted-foreground))',
                margin: '8px 0',
              },
              'data-testid': 'loading',
            },
            'Loading…',
          )
        : null,
      state.status === 'error' && state.plugins.length === 0
        ? createElement(
            'p',
            {
              style: {
                color: 'hsl(var(--destructive))',
                margin: '8px 0',
              },
              'data-testid': 'error',
            },
            state.error ?? 'Unknown error',
          )
        : null,
      state.error !== null && state.plugins.length > 0
        ? createElement(
            'p',
            {
              style: {
                color: 'hsl(var(--destructive))',
                margin: '4px 0 8px 0',
                fontSize: 'var(--font-size-sm, 0.875rem)',
              },
              'data-testid': 'refresh-error',
            },
            `Refresh failed: ${state.error}`,
          )
        : null,
      createElement(
        'ul',
        {
          className: 'mwp-plugin-list',
          style: {
            listStyle: 'none',
            margin: 0,
            padding: 0,
          },
          'data-testid': 'plugin-list',
        },
        state.plugins.map((plugin) =>
          createElement(PluginRow, {
            key: plugin.id,
            plugin,
            onToggle: handleToggle,
            pending: pendingPatch === plugin.id,
          }),
        ),
      ),
      createElement(
        'p',
        {
          style: {
            marginTop: 'var(--gap-md, 16px)',
            color: 'hsl(var(--muted-foreground))',
            fontSize: 'var(--font-size-sm, 0.875rem)',
            lineHeight: 1.5,
          },
        },
        'Changes are persisted to ',
        createElement(
          'code',
          {
            style: {
              color: 'hsl(var(--muted-foreground))',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--font-size-xs, 0.75rem)',
            },
          },
          '$MANIFEST_PLUGINS_STATE_FILE',
        ),
        ' and take effect immediately.',
      ),
    ),
  );
}

let mountedRoot: Root | null = null;

/**
 * Inject the responsive stylesheet once per page load.
 *
 * Inline `style` props cannot express `@media` queries, so we ship
 * the mobile rules as a `<style>` element in the document head.
 * Tagged with `data-mwp-styles` so re-injection across HMR / multiple
 * mounts is a no-op.
 *
 * Rules:
 *   - ≤768px: collapse the sidebar offset to 0 (the dashboard itself
 *     collapses the sidebar on small screens via `main-content--full`).
 *     Tighten padding. Stack the title row above the kind pill.
 *   - >768px: native dashboard layout (sidebar offset + container max).
 */
function ensureResponsiveStylesInjected(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-mwp-styles]') !== null) return;
  const style = document.createElement('style');
  style.setAttribute('data-mwp-styles', 'manifest-plugins-admin-ui');
  style.textContent = `
    .mwp-plugin-manager {
      width: 100%;
    }
    @media (max-width: 768px) {
      .mwp-plugin-manager {
        margin-left: 0 !important;
        width: 100% !important;
        padding: var(--gap-lg, 24px) var(--gap-md, 16px) var(--gap-xl, 32px) !important;
      }
      .mwp-plugin-manager header.page-header {
        flex-direction: column !important;
        align-items: flex-start !important;
        gap: 8px !important;
      }
      .mwp-plugin-manager header.page-header h2 {
        font-size: var(--font-size-xl, 1.5rem) !important;
      }
    }
  `;
  document.head.appendChild(style);
}

export function mountPluginManager(target: HTMLElement): void {
  ensureResponsiveStylesInjected();
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