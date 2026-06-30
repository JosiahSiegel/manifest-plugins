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
 * server and loaded by the dashboard mount overlay (T7).
 *
 * Visual design:
 *   - Dark theme, matching the upstream Manifest dashboard (#0a0a0a bg,
 *     light text, soft white-on-dark borders).
 *   - Full-width: the dashboard injects the mount div before `</body>`,
 *     so this component spans the parent content width. No `maxWidth`
 *     or auto margins; a single top hairline separates it from the
 *     table above.
 *   - Each row: toggle on the left, name + id + version + kind on the
 *     first line, description as a quieter line below.
 *
 * Behavior:
 *   - On mount: fetch `GET /api/plugins` → render the list.
 *   - On toggle: optimistic update + `PATCH /api/plugins/:id`; revert
 *     on failure (with the error surfaced in the UI).
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

// =============================================================================
// Theme tokens
// =============================================================================
//
// Mirrors the upstream Manifest dashboard's dark palette so the panel
// reads as a natural extension of the page rather than a floating card.
// Hex values are picked to blend with the dashboard's #0a0a0a page bg
// and the table's #e5e5e5 text. Borders use a translucent white so they
// soften against any container (page bg, table row bg, future themes).
const THEME = {
  // Surfaces
  pageBg: 'transparent',          // let the dashboard's #0a0a0a show through
  rowBg: 'transparent',           // rows inherit; subtle hover only
  rowBgHover: 'rgba(255,255,255,0.03)',
  // Text
  textPrimary: '#e5e5e5',
  textSecondary: '#9ca3af',       // id, version, kind labels
  textTertiary: '#a1a1aa',        // descriptions
  textMuted: '#71717a',           // helper text at the bottom
  // Borders / dividers
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.14)',
  // Accents
  accentOn: '#22d3ee',            // cyan toggle on — matches the cyan ORCHESTRATE tag
  accentOnGlow: 'rgba(34,211,238,0.35)',
  accentOff: '#52525b',           // zinc toggle off
  accentError: '#f87171',
  // Kind tag colors (loosely mirror the table's amber/teal/orange pills)
  kindTransform: '#22d3ee',       // cyan
  kindPolicy: '#14b8a6',          // teal
  kindRoutingOverride: '#f59e0b', // amber
} as const;

function kindColor(kind: PluginKind): string {
  switch (kind) {
    case 'transform':
      return THEME.kindTransform;
    case 'policy':
      return THEME.kindPolicy;
    case 'routing-override':
      return THEME.kindRoutingOverride;
  }
}

// =============================================================================
// Components
// =============================================================================

/**
 * Toggle switch styled to match the dashboard. Renders an inline `<label>`
 * wrapping a hidden checkbox and a visible track + thumb. We use the
 * native checkbox for accessibility (focus, keyboard, screen readers)
 * but visually replace it.
 */
function ToggleSwitch(props: {
  readonly id: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}): React.ReactElement {
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      props.onChange(e.target.checked);
    },
    [props],
  );

  const trackBg = props.checked ? THEME.accentOn : THEME.accentOff;
  const thumbStyle: React.CSSProperties = {
    position: 'absolute',
    top: '2px',
    left: props.checked ? '22px' : '2px',
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    background: '#ffffff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
    transition: 'left 120ms ease-out',
    pointerEvents: 'none',
  };

  return createElement(
    'label',
    {
      // The label is the click target for accessibility. The actual
      // <input> is visually hidden but still focusable for keyboard
      // users; clicking the label triggers the input's native click,
      // which fires onChange. We deliberately do NOT add an onClick
      // handler on the label — that would double-fire with the input's
      // change event.
      style: {
        position: 'relative',
        display: 'inline-block',
        width: '42px',
        height: '22px',
        cursor: 'pointer',
        flexShrink: 0,
      },
      'aria-label': props.id,
    },
    createElement('input', {
      type: 'checkbox',
      checked: props.checked,
      onChange: handleInputChange,
      'data-testid': `plugin-toggle-${props.id}`,
      style: {
        // Visually hidden but still focusable for keyboard / a11y,
        // and sized to fill the toggle so clicks anywhere on the
        // visible track + thumb land on the input.
        position: 'absolute',
        opacity: 0,
        width: '100%',
        height: '100%',
        margin: 0,
        cursor: 'pointer',
        zIndex: 1,
      },
      tabIndex: 0,
    }),
    createElement('span', {
      'aria-hidden': true,
      style: {
        position: 'absolute',
        inset: 0,
        borderRadius: '999px',
        background: trackBg,
        boxShadow: props.checked
          ? `0 0 0 1px ${THEME.accentOnGlow}`
          : 'inset 0 0 0 1px rgba(255,255,255,0.06)',
        transition: 'background 120ms ease-out',
        pointerEvents: 'none',
      },
    }),
    createElement('span', { 'aria-hidden': true, style: thumbStyle }),
  );
}

function PluginRow(props: {
  readonly plugin: PluginMetadata;
  readonly onToggle: (id: string, enabled: boolean) => void;
}): React.ReactElement {
  const handleToggle = useCallback(
    (enabled: boolean): void => {
      props.onToggle(props.plugin.id, enabled);
    },
    [props.onToggle, props.plugin.id],
  );

  return createElement(
    'li',
    {
      className: 'mwp-plugin-row',
      style: {
        listStyle: 'none',
        padding: '14px 0',
        borderBottom: `1px solid ${THEME.border}`,
      },
    },
    createElement(
      'div',
      {
        className: 'mwp-plugin-row__inner',
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          gap: '16px',
        },
      },
      createElement(ToggleSwitch, {
        id: props.plugin.id,
        checked: props.plugin.enabled,
        onChange: handleToggle,
      }),
      createElement(
        'div',
        { className: 'mwp-plugin-row__body', style: { flex: 1, minWidth: 0 } },
        createElement(
          'div',
          {
            className: 'mwp-plugin-row__header',
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
              className: 'mwp-plugin-row__name',
              style: {
                color: THEME.textPrimary,
                fontSize: '0.95rem',
                fontWeight: 600,
                letterSpacing: '-0.005em',
                minWidth: 0,
              },
            },
            props.plugin.name,
          ),
          createElement(
            'span',
            {
              className: 'mwp-plugin-row__id',
              style: {
                color: THEME.textSecondary,
                fontSize: '0.8rem',
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              },
            },
            props.plugin.id,
          ),
          createElement(
            'span',
            {
              className: 'mwp-plugin-row__version',
              style: {
                color: THEME.textSecondary,
                fontSize: '0.75rem',
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              },
            },
            `v${props.plugin.version}`,
          ),
          createElement(
            'span',
            {
              'aria-hidden': true,
              className: 'mwp-plugin-row__spacer',
              style: { flex: 1 },
            },
          ),
          createElement(
            'span',
            {
              'data-testid': `plugin-kind-${props.plugin.id}`,
              className: 'mwp-plugin-row__kind',
              style: {
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '0.7rem',
                fontWeight: 500,
                color: kindColor(props.plugin.kind),
                background: 'rgba(255,255,255,0.04)',
                border: `1px solid ${THEME.border}`,
                textTransform: 'lowercase',
                letterSpacing: '0.02em',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              },
            },
            props.plugin.kind,
          ),
        ),
        props.plugin.description !== ''
          ? createElement(
              'p',
              {
                className: 'mwp-plugin-row__desc',
                style: {
                  margin: '6px 0 0 0',
                  color: THEME.textTertiary,
                  fontSize: '0.85rem',
                  lineHeight: 1.45,
                  overflowWrap: 'anywhere',
                },
              },
              props.plugin.description,
            )
          : null,
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
    'section',
    {
      'data-testid': 'plugin-manager',
      className: 'mwp-plugin-manager',
      style: {
        // Section sits flush against the dashboard's bottom of the page.
        // We inherit the dashboard's font; the mount div is injected
        // inside `packages/frontend/index.html` so typography comes from
        // the upstream CSS. system-ui is a safety net for environments
        // where the dashboard CSS hasn't loaded yet (admin server in
        // isolation, etc.).
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        color: THEME.textPrimary,
        background: THEME.pageBg,
        // Soft top hairline that reads as a section divider rather
        // than a card border. No max-width — the section should fill
        // the parent content column exactly.
        borderTop: `1px solid ${THEME.borderStrong}`,
        marginTop: '32px',
        padding: '24px 0 16px 0',
      },
    },
    createElement(
      'header',
      {
        style: {
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '16px',
          marginBottom: '8px',
        },
      },
      createElement(
        'h2',
        {
          style: {
            margin: 0,
            fontSize: '1.05rem',
            fontWeight: 600,
            color: THEME.textPrimary,
            letterSpacing: '-0.01em',
          },
        },
        'Plugins',
      ),
      createElement(
        'span',
        {
          style: {
            color: THEME.textSecondary,
            fontSize: '0.8rem',
          },
        },
        state.plugins.length === 1 ? '1 plugin' : `${state.plugins.length} plugins`,
      ),
    ),
    state.status === 'loading'
      ? createElement(
          'p',
          {
            style: { color: THEME.textSecondary, margin: '8px 0' },
            'data-testid': 'loading',
          },
          'Loading…',
        )
      : null,
    state.status === 'error' && state.plugins.length === 0
      ? createElement(
          'p',
          {
            style: { color: THEME.accentError, margin: '8px 0' },
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
              color: THEME.accentError,
              margin: '4px 0 8px 0',
              fontSize: '0.8rem',
            },
            'data-testid': 'refresh-error',
          },
          `Refresh failed: ${state.error}`,
        )
      : null,
    createElement(
      'ul',
      {
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
        }),
      ),
    ),
    createElement(
      'p',
      {
        style: {
          marginTop: '12px',
          color: THEME.textMuted,
          fontSize: '0.78rem',
          lineHeight: 1.5,
        },
      },
      'Changes are persisted to ',
      createElement(
        'code',
        {
          style: {
            color: THEME.textSecondary,
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: '0.78rem',
          },
        },
        '$MANIFEST_PLUGINS_STATE_FILE',
      ),
      ' and take effect immediately.',
    ),
  );
}

let mountedRoot: Root | null = null;

/**
 * Inject the responsive stylesheet once per page load.
 *
 * Inline `style` props cannot express `@media` queries, so we ship the
 * mobile rules as a `<style>` element in the document head. The element
 * is tagged with `data-mwp-styles` so re-injection across HMR / multiple
 * mounts is a no-op.
 *
 * Breakpoints:
 *   - ≤640px: phones. Stack the row vertically (toggle on top, content
 *     below). Pin the kind badge to its own row so it never competes
 *     with id/version for horizontal space. Tighten padding.
 *   - ≥641px: tablets + desktop. Original layout (badge right-aligned
 *     inline with id/version).
 */
function ensureResponsiveStylesInjected(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-mwp-styles]') !== null) return;
  const style = document.createElement('style');
  style.setAttribute('data-mwp-styles', 'manifest-plugins-admin-ui');
  style.textContent = `
    .mwp-plugin-row__header { row-gap: 4px; }
    .mwp-plugin-row__spacer { display: block; }
    @media (max-width: 640px) {
      [data-testid="plugin-manager"] {
        padding: 16px 0 12px 0 !important;
        margin-top: 24px !important;
      }
      [data-testid="plugin-manager"] header {
        flex-wrap: wrap;
        gap: 4px 12px;
      }
      [data-testid="plugin-manager"] header h2 {
        font-size: 0.95rem !important;
      }
      .mwp-plugin-row {
        padding: 12px 0 !important;
      }
      /* Tighter mobile: toggle stays inline-left, content area stacks
       * the name/id/version row + kind badge vertically for predictable
       * wrap behavior across rows of different lengths. */
      .mwp-plugin-row__inner {
        align-items: flex-start !important;
        gap: 12px !important;
      }
      .mwp-plugin-row__body {
        min-width: 0;
      }
      .mwp-plugin-row__header {
        flex-direction: column !important;
        align-items: flex-start !important;
        gap: 4px !important;
      }
      .mwp-plugin-row__spacer {
        display: none !important;
      }
      .mwp-plugin-row__kind {
        align-self: flex-start !important;
        margin-top: 2px !important;
      }
      .mwp-plugin-row__desc {
        margin-top: 6px !important;
        font-size: 0.82rem !important;
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