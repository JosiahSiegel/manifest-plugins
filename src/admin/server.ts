/**
 * Plugin admin HTTP API.
 *
 * A small Express sidecar that exposes a JSON HTTP surface for
 * managing plugin enable/disable state. The same state file is
 * read/written by the CLI (scripts/plugins-cli.mjs) and the React
 * dashboard island (src/admin/ui/index.tsx). The admin server is
 * the single source of truth for the in-memory `enabledOverrides`
 * map inside the host process.
 *
 * Routes:
 *   GET    /api/plugins              list every installed plugin + state
 *   GET    /api/plugins/:id          get one plugin (404 if unknown)
 *   PATCH  /api/plugins/:id          toggle enabled (body: { enabled: boolean })
 *   POST   /api/plugins/reload       re-read the state file from disk
 *   GET    /api/plugins/health       liveness probe ({ status: 'ok' })
 *   GET    /admin/admin.js           static file (esbuild IIFE bundle)
 *   GET    /admin/dashboard-transform/all.js
 *                                    combined IIFE bundle of every
 *                                    enabled dashboard-transform plugin
 *                                    (consumed by the dashboard mount
 *                                    overlay via a single <script> tag)
 *   GET    /admin/dashboard-transform/<id>.js
 *                                    one plugin's script (debug aid; the
 *                                    combined bundle is what the dashboard
 *                                    loads in production)
 *
 * Defaults: bind 127.0.0.1, port 3010 (configurable via
 * MANIFEST_PLUGINS_ADMIN_PORT). Localhost-only is intentional:
 * the admin endpoint has no auth (it's behind a reverse proxy in
 * the production image) and must not be exposed to the network.
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  getInstalledPlugins,
  setPluginEnabled,
  resetPersistedPluginState,
  getPersistedStateFile,
  installedPlugins,
  type DashboardTransformPlugin,
} from '../index';
import { loadPluginState, savePluginState } from '../registry/state';

export interface AdminServerOptions {
  /** Port to listen on. Default: 3010. Env: MANIFEST_PLUGINS_ADMIN_PORT. */
  readonly port?: number;
  /** Bind address. Default: '127.0.0.1' (localhost-only). */
  readonly bindHost?: string;
  /** Path to the persisted state file. Default: /app/data/plugin-state.json. */
  readonly stateFilePath?: string;
  /** Path to the static admin assets directory (where admin.js lives). Default: <dist>/admin. */
  readonly staticDir?: string;
}

const DEFAULT_PORT = 3010;
const DEFAULT_BIND = '127.0.0.1';
const DEFAULT_STATE_FILE = '/app/data/plugin-state.json';

function resolveOptions(options?: AdminServerOptions): Required<AdminServerOptions> {
  const envPort = process.env['MANIFEST_PLUGINS_ADMIN_PORT'];
  const parsedPort = envPort !== undefined ? Number(envPort) : NaN;
  return {
    port: options?.port ?? (Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT),
    bindHost: options?.bindHost ?? DEFAULT_BIND,
    stateFilePath: options?.stateFilePath ?? process.env['MANIFEST_PLUGINS_STATE_FILE'] ?? DEFAULT_STATE_FILE,
    staticDir: options?.staticDir ?? join(__dirname),
  };
}

export function createAdminServer(options?: AdminServerOptions): Express {
  const opts = resolveOptions(options);
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // GET /api/plugins
  app.get('/api/plugins', (_req, res) => {
    res.json({ plugins: getInstalledPlugins() });
  });

  // GET /api/plugins/health
  app.get('/api/plugins/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // GET /api/plugins/:id
  app.get('/api/plugins/:id', (req, res) => {
    const id = req.params.id;
    const found = getInstalledPlugins().find((p) => p.id === id);
    if (found === undefined) {
      res.status(404).json({ error: 'plugin not found', id });
      return;
    }
    res.json({ plugin: found });
  });

  // PATCH /api/plugins/:id
  app.patch('/api/plugins/:id', (req, res) => {
    const id = req.params.id;
    const body = req.body as { enabled?: unknown } | undefined;
    if (body === null || typeof body !== 'object' || typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'body must be { enabled: boolean }' });
      return;
    }
    const known = getInstalledPlugins();
    if (!known.some((p) => p.id === id)) {
      res.status(404).json({ error: 'plugin not found', id });
      return;
    }
    setPluginEnabled(id, body.enabled);
    // Persist to the state file (write-through).
    const persisted = loadPluginState(opts.stateFilePath);
    savePluginState(opts.stateFilePath, { ...persisted, [id]: body.enabled });
    res.json({ plugin: getInstalledPlugins().find((p) => p.id === id) });
  });

  // POST /api/plugins/reload
  app.post('/api/plugins/reload', (_req, res) => {
    const reloaded = loadPluginState(opts.stateFilePath);
    resetPersistedPluginState();
    for (const [id, enabled] of Object.entries(reloaded)) {
      setPluginEnabled(id, enabled);
    }
    res.json({ plugins: getInstalledPlugins() });
  });

  // GET /admin/admin.js (static; returns 404 when the bundle is missing —
  // this is fine in development; production runs the build step first).
  app.get('/admin/admin.js', (req: Request, res: Response, next: NextFunction) => {
    const filePath = join(opts.staticDir, 'admin.js');
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'admin bundle not built — run `npm run build`' });
      return;
    }
    res.sendFile(filePath, (err) => {
      if (err !== undefined) next(err);
    });
  });

  // -----------------------------------------------------------------------
  // Dashboard-transform bundle
  // -----------------------------------------------------------------------
  //
  // Every enabled `dashboard-transform` plugin contributes a script
  // string via `getDashboardScript()`. The combined bundle is an IIFE
  // that registers a small bootstrap on the global namespace; each
  // plugin's script body runs inside that bootstrap. The bundle is
  // served as `application/javascript` so the browser executes it as
  // a classic script (the dashboard mount overlay's <script> tag has
  // no `type="module"`).
  //
  // The bundle is recomputed on every request. That sounds expensive
  // (string concat per HTTP call) but the plugin set is small (a
  // handful) and the strings are short; the alternative — caching
  // and invalidating on enable/disable — adds a class of bugs where
  // the cache is stale after `setPluginEnabled` runs in another
  // process (or the same process via PATCH).
  //
  // Disabled plugins are excluded from the bundle. The 404 path is
  // intentional: the dashboard mount overlay injects the script
  // tag unconditionally; if every dashboard-transform plugin is
  // disabled, the tag is a harmless 404. We do NOT return an empty
  // bundle because the admin UI mounts on the same port and an
  // empty script would still cost a network round-trip.
  //
  // Headers:
  //   - `Content-Type: application/javascript; charset=utf-8` so
  //     browsers execute the response (not offer it as a download).
  //   - `Cache-Control: no-store` because the bundle's contents
  //     change as soon as the operator toggles a plugin.

  /**
   * Build the combined dashboard-transform bundle from every enabled
   * plugin in the registry. Plugins whose `getDashboardScript()` returns
   * null/empty are skipped.
   */
  function buildDashboardTransformBundle(): string {
    const enabledTransforms = installedPlugins.filter(
      (p): p is DashboardTransformPlugin =>
        typeof (p as Partial<DashboardTransformPlugin>).getDashboardScript === 'function',
    );
    const parts: string[] = [
      '// Combined dashboard-transform bundle (auto-generated at request time).',
      '// Each enabled dashboard-transform plugin contributes one IIFE.',
      '// Disabled plugins are excluded. Toggling a plugin takes effect on the next',
      '// page load (the dashboard mount overlay fetches this bundle on every render).',
      '(function () {',
      '  if (typeof window === "undefined") return;',
      '  if (window.__manifestPluginsDashboardTransform === undefined) {',
      '    window.__manifestPluginsDashboardTransform = [];',
      '  }',
      '  var BOOTSTRAP_LOADED = "__manifestPluginsDashboardTransformBootstrap";',
      '  if (window[BOOTSTRAP_LOADED]) return;',
      '  window[BOOTSTRAP_LOADED] = true;',
      '  // Run each plugin script on DOMContentLoaded (or immediately if the page is already loaded).',
      '  function __manifestRunDashboardTransform() {',
      '    var plugins = window.__manifestPluginsDashboardTransform || [];',
      '    for (var i = 0; i < plugins.length; i += 1) {',
      '      var p = plugins[i];',
      '      if (!p || p.__installed) continue;',
      '      try {',
      '        if (typeof p.install === "function") p.install();',
      '        p.__installed = true;',
      '      } catch (e) {',
      '        console.warn("[manifest-plugins] dashboard-transform install failed for " + (p && p.id || "?") + ": " + (e && e.message || e));',
      '      }',
      '    }',
      '  }',
      '  if (document.readyState === "loading") {',
      '    document.addEventListener("DOMContentLoaded", __manifestRunDashboardTransform, { once: true });',
      '  } else {',
      '    __manifestRunDashboardTransform();',
      '  }',
      '})();',
    ];
    for (const plugin of enabledTransforms) {
      const script = plugin.getDashboardScript();
      if (script === null || script === undefined || script === '') continue;
      const pluginId = (plugin as { constructor?: { metadata?: { id?: string } } }).constructor
        ?.metadata?.id ?? 'unknown';
      parts.push(`// === dashboard-transform: ${pluginId} ===`);
      parts.push(script);
    }
    return parts.join('\n\n');
  }

  // Combined bundle — the URL the dashboard mount overlay loads.
  // This route MUST be registered before the `:id.js` route so
  // Express matches `all` literally instead of treating it as a
  // plugin id.
  app.get('/admin/dashboard-transform/all.js', (_req, res) => {
    const bundle = buildDashboardTransformBundle();
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(bundle);
  });

  // Single-plugin endpoint (debug aid). Returns 404 when the plugin
  // is not installed, not a dashboard-transform, or currently
  // disabled.
  app.get('/admin/dashboard-transform/:id.js', (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) {
      res.status(400).json({ error: 'invalid plugin id' });
      return;
    }
    const meta = getInstalledPlugins().find((p) => p.id === id);
    if (meta === undefined) {
      res.status(404).json({ error: 'plugin not found', id });
      return;
    }
    if (meta.kind !== 'dashboard-transform') {
      res.status(400).json({ error: 'plugin is not a dashboard-transform', id, kind: meta.kind });
      return;
    }
    if (!meta.enabled) {
      res.status(404).json({ error: 'plugin is disabled', id });
      return;
    }
    // Walk the instance array; the instance's constructor carries
    // the static `metadata` field. We identify the plugin by
    // comparing the static metadata's `id`.
    const plugin = installedPlugins.find(
      (p): p is DashboardTransformPlugin => {
        if (typeof (p as Partial<DashboardTransformPlugin>).getDashboardScript !== 'function') {
          return false;
        }
        const ctor = (p as { constructor?: { metadata?: { id?: string } } }).constructor;
        return ctor?.metadata?.id === id;
      },
    );
    if (plugin === undefined) {
      res.status(500).json({ error: 'plugin metadata present but instance missing', id });
      return;
    }
    const script = plugin.getDashboardScript();
    if (script === null || script === undefined || script === '') {
      res.status(204).end();
      return;
    }
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(script);
  });

  // Note: no catch-all 404 middleware here. When the admin app is
  // mounted as a sub-app via `expressApp.use(adminApp)`, a catch-all
  // would intercept ALL `/api/*` requests — including NestJS routes
  // like `/api/v1/health` that the admin namespace does not own.
  // The 404 for unmatched admin routes is handled per-route above
  // (e.g. GET /api/plugins/:id returns 404 for unknown ids).
  // When the admin app is run standalone (e.g. in unit tests),
  // Express's default 404 handler kicks in for unmatched routes.

  return app;
}

export interface StartedServer {
  readonly port: number;
  readonly close: () => Promise<void>;
}

export async function startAdminServer(
  app: Express,
  options?: { readonly port?: number; readonly bindHost?: string },
): Promise<StartedServer> {
  const opts = resolveOptions({
    port: options?.port,
    bindHost: options?.bindHost,
  });
  return new Promise((resolveFn, rejectFn) => {
    const server = app.listen(opts.port, opts.bindHost, () => {
      const addr = server.address();
      const port =
        addr !== null && typeof addr === 'object' && 'port' in addr ? addr.port : opts.port;
      resolveFn({
        port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err !== undefined ? rejectClose(err) : resolveClose()));
          }),
      });
    });
    server.once('error', (err: Error) => {
      rejectFn(err);
    });
  });
}
