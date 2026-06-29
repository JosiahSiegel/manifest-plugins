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

  // 404 fallback for /api/* (admin namespace)
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

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
