import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Express } from 'express';
import request from 'supertest';
import {
  getInstalledPlugins,
  resetPersistedPluginState,
  setPluginEnabled,
} from '../index';

type CreateAdminServerOptions = {
  readonly port?: number;
  readonly bindHost?: string;
  readonly stateFilePath?: string;
  readonly staticDir?: string;
};

type AdminServerModule = {
  readonly createAdminServer: (options?: CreateAdminServerOptions) => Express;
};

type PluginJson = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly kind: string;
  readonly enabledByDefault: boolean;
  readonly enabled: boolean;
};

const EXPECTED_PLUGIN_IDS = [
  'default-policy',
  'header-tier-router',
  'show-all-router-views',
];

let tempDir = '';
let stateFilePath = '';
let previousStateFile: string | undefined;
let previousDisabledList: string | undefined;
let previousAdminPort: string | undefined;

function createApp(options?: CreateAdminServerOptions): Express {
  const adminServerModule: AdminServerModule = require('./server');
  return adminServerModule.createAdminServer(options);
}

function readPlugins(body: { readonly plugins?: unknown }): readonly PluginJson[] {
  expect(Array.isArray(body.plugins)).toBe(true);
  return body.plugins as PluginJson[];
}

function findPlugin(
  plugins: readonly PluginJson[],
  pluginId: string,
): PluginJson | undefined {
  return plugins.find((plugin) => plugin.id === pluginId);
}

beforeEach(() => {
  previousStateFile = process.env['MANIFEST_PLUGINS_STATE_FILE'];
  previousDisabledList = process.env['MANIFEST_PLUGINS_DISABLED'];
  previousAdminPort = process.env['MANIFEST_PLUGINS_ADMIN_PORT'];
  tempDir = mkdtempSync(join(tmpdir(), 'mwp-admin-server-'));
  stateFilePath = join(tempDir, 'plugin-state.json');
  process.env['MANIFEST_PLUGINS_STATE_FILE'] = stateFilePath;
  delete process.env['MANIFEST_PLUGINS_DISABLED'];
  delete process.env['MANIFEST_PLUGINS_ADMIN_PORT'];
  resetPersistedPluginState();
});

afterEach(() => {
  resetPersistedPluginState();
  if (previousStateFile === undefined) {
    delete process.env['MANIFEST_PLUGINS_STATE_FILE'];
  } else {
    process.env['MANIFEST_PLUGINS_STATE_FILE'] = previousStateFile;
  }
  if (previousDisabledList === undefined) {
    delete process.env['MANIFEST_PLUGINS_DISABLED'];
  } else {
    process.env['MANIFEST_PLUGINS_DISABLED'] = previousDisabledList;
  }
  if (previousAdminPort === undefined) {
    delete process.env['MANIFEST_PLUGINS_ADMIN_PORT'];
  } else {
    process.env['MANIFEST_PLUGINS_ADMIN_PORT'] = previousAdminPort;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('plugin admin HTTP API', () => {
  it('GET /api/plugins returns 200 with all installed plugins', async () => {
    // Given: a fresh admin server using a per-test state file.
    const app = createApp();

    // When: the installed plugins list is requested.
    const response = await request(app).get('/api/plugins').expect(200);

    // Then: all installed plugins are returned.
    const plugins = readPlugins(response.body);
    expect(plugins).toHaveLength(EXPECTED_PLUGIN_IDS.length);
    expect(plugins.map((plugin) => plugin.id).sort()).toEqual(EXPECTED_PLUGIN_IDS);
  });

  it('GET /api/plugins reflects direct runtime enablement changes', async () => {
    // Given: the default-policy plugin was disabled through the runtime API.
    setPluginEnabled('default-policy', false);
    const app = createApp();

    // When: the installed plugins list is requested.
    const response = await request(app).get('/api/plugins').expect(200);

    // Then: the response reflects the in-memory override.
    const plugins = readPlugins(response.body);
    expect(findPlugin(plugins, 'default-policy')?.enabled).toBe(false);
  });

  it('GET /api/plugins/default-policy returns one plugin', async () => {
    // Given: a fresh admin server.
    const app = createApp();

    // When: a known plugin is requested by id.
    const response = await request(app).get('/api/plugins/default-policy').expect(200);

    // Then: the plugin metadata is returned.
    expect(response.body).toEqual({
      plugin: expect.objectContaining({
        id: 'default-policy',
        name: 'Default policy',
        kind: 'policy',
        enabledByDefault: true,
        enabled: true,
      }),
    });
  });

  it('GET /api/plugins/nonexistent returns 404 with the missing id', async () => {
    // Given: a fresh admin server.
    const app = createApp();

    // When: an unknown plugin is requested by id.
    const response = await request(app).get('/api/plugins/nonexistent').expect(404);

    // Then: the error includes the missing id.
    expect(response.body).toEqual({ error: 'plugin not found', id: 'nonexistent' });
  });

  it('PATCH /api/plugins/default-policy persists and reflects enabled false', async () => {
    // Given: a fresh admin server using a per-test state file.
    const app = createApp();

    // When: the default-policy plugin is disabled over HTTP.
    const response = await request(app)
      .patch('/api/plugins/default-policy')
      .send({ enabled: false })
      .expect(200);

    // Then: the response, persisted file, and runtime metadata agree.
    expect(response.body.plugin.enabled).toBe(false);
    expect(JSON.parse(readFileSync(stateFilePath, 'utf-8'))).toMatchObject({
      'default-policy': false,
    });
    expect(
      getInstalledPlugins().find((plugin) => plugin.id === 'default-policy')?.enabled,
    ).toBe(false);
  });

  it('PATCH /api/plugins/default-policy rejects a string enabled value', async () => {
    // Given: a fresh admin server.
    const app = createApp();

    // When: the enabled field is not a boolean.
    const response = await request(app)
      .patch('/api/plugins/default-policy')
      .send({ enabled: 'no' })
      .expect(400);

    // Then: the request is rejected as a bad body.
    expect(response.body).toEqual({ error: 'body must be { enabled: boolean }' });
  });

  it('PATCH /api/plugins/default-policy rejects an empty body', async () => {
    // Given: a fresh admin server.
    const app = createApp();

    // When: no enabled field is sent.
    const response = await request(app).patch('/api/plugins/default-policy').send({}).expect(400);

    // Then: the request is rejected as a bad body.
    expect(response.body).toEqual({ error: 'body must be { enabled: boolean }' });
  });

  it('PATCH /api/plugins/nonexistent returns 404 with the missing id', async () => {
    // Given: a fresh admin server.
    const app = createApp();

    // When: an unknown plugin is patched.
    const response = await request(app)
      .patch('/api/plugins/nonexistent')
      .send({ enabled: false })
      .expect(404);

    // Then: the error includes the missing id.
    expect(response.body).toEqual({ error: 'plugin not found', id: 'nonexistent' });
  });

  it('POST /api/plugins/reload re-reads the state file from disk', async () => {
    // Given: the state file disables the default policy plugin.
    writeFileSync(stateFilePath, JSON.stringify({ 'default-policy': false }), 'utf-8');
    const app = createApp();

    // When: the admin server reloads state from disk.
    await request(app).post('/api/plugins/reload').expect(200);
    const response = await request(app).get('/api/plugins').expect(200);

    // Then: the plugin list reflects the reloaded persisted state.
    const plugins = readPlugins(response.body);
    expect(findPlugin(plugins, 'default-policy')?.enabled).toBe(false);
  });

  it('GET /api/anything-else falls through to Express default 404 (no catch-all)', async () => {
    // Given: a fresh admin server. The admin app does NOT have a
    // catch-all `/api` 404 handler — that would intercept NestJS
    // routes when the admin app is mounted as a sub-app via
    // `expressApp.use(adminApp)`. Express's default 404 handler
    // returns a plain text body.
    const app = createApp();

    // When: an unknown path under /api is requested.
    const response = await request(app).get('/api/anything-else').expect(404);

    // Then: Express's default 404 fires (text/html, not JSON).
    expect(response.headers['content-type']).toMatch(/text\/html/);
  });

  it('GET /api/plugins/health returns ok', async () => {
    // Given: a fresh admin server.
    const app = createApp();

    // When: the health endpoint is requested.
    const response = await request(app).get('/api/plugins/health').expect(200);

    // Then: the liveness payload is returned.
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /admin/admin.js returns 404 with a build hint when the bundle is missing', async () => {
    // Given: a fresh admin server with a static dir that has no admin.js.
    const app = createApp({ staticDir: tempDir });

    // When: the static asset is requested.
    const response = await request(app).get('/admin/admin.js').expect(404);

    // Then: the response explains how to build the bundle.
    expect(response.body).toEqual({
      error: 'admin bundle not built — run `npm run build`',
    });
  });

  it('GET /admin/admin.js serves the bundle when present', async () => {
    // Given: a static dir that contains a placeholder admin.js.
    const staticDir = join(tempDir, 'static');
    const { mkdirSync } = await import('fs');
    mkdirSync(staticDir, { recursive: true });
    const bundlePath = join(staticDir, 'admin.js');
    const bundleBody = '/* placeholder admin bundle */\nconsole.log("admin");\n';
    writeFileSync(bundlePath, bundleBody, 'utf-8');
    const app = createApp({ staticDir });

    // When: the static asset is requested.
    const response = await request(app).get('/admin/admin.js').expect(200);

    // Then: the file body is returned with a JS content type.
    expect(response.text).toBe(bundleBody);
    expect(response.headers['content-type']).toMatch(/javascript|application\/octet-stream/);
  });

  // -------------------------------------------------------------------
  // Dashboard-transform bundle endpoints
  // -------------------------------------------------------------------

  it('GET /admin/dashboard-transform/all.js serves a JS bundle with the bootstrap + all enabled plugins', async () => {
    // Given: a fresh admin server.
    const app = createApp();

    // When: the combined bundle is requested.
    const response = await request(app)
      .get('/admin/dashboard-transform/all.js')
      .expect(200);

    // Then: the bundle has the right content type + a no-store cache header.
    expect(response.headers['content-type']).toMatch(/application\/javascript/);
    expect(response.headers['cache-control']).toBe('no-store');

    // And: the bundle includes the bootstrap, the show-all-router-views
    // plugin's script body, and the global registry key.
    const body = response.text;
    expect(body).toContain('__manifestPluginsDashboardTransformBootstrap');
    expect(body).toContain('window.__manifestPluginsDashboardTransform');
    // The show-all-router-views plugin's IIFE wrapper is in the bundle.
    expect(body).toContain('PLUGIN_ID = \'show-all-router-views\'');
    // The combined bundle header comment is present.
    expect(body).toContain('Combined dashboard-transform bundle');
  });

  it('GET /admin/dashboard-transform/<id>.js returns 400 for an invalid id', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/admin/dashboard-transform/Bad%20Id.js')
      .expect(400);
    expect(response.body).toEqual({ error: 'invalid plugin id' });
  });

  it('GET /admin/dashboard-transform/<id>.js returns 404 for an unknown plugin', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/admin/dashboard-transform/does-not-exist.js')
      .expect(404);
    expect(response.body).toEqual({
      error: 'plugin not found',
      id: 'does-not-exist',
    });
  });

  it('GET /admin/dashboard-transform/<id>.js returns 400 when the plugin is not a dashboard-transform', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/admin/dashboard-transform/default-policy.js')
      .expect(400);
    expect(response.body.error).toBe('plugin is not a dashboard-transform');
    expect(response.body.id).toBe('default-policy');
  });

  it('GET /admin/dashboard-transform/<id>.js serves the enabled plugin script', async () => {
    const app = createApp();
    const response = await request(app)
      .get('/admin/dashboard-transform/show-all-router-views.js')
      .expect(200);
    expect(response.headers['content-type']).toMatch(/application\/javascript/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).toContain('PLUGIN_ID = \'show-all-router-views\'');
  });

  it('GET /admin/dashboard-transform/<id>.js returns 404 for a disabled plugin', async () => {
    // Disable the plugin via setPluginEnabled, then re-fetch the
    // single-plugin endpoint. The combined bundle still includes
    // the bootstrap (always shipped) but the plugin's script is
    // omitted. The single-plugin endpoint returns 404.
    const app = createApp();
    setPluginEnabled('show-all-router-views', false);
    try {
      const response = await request(app)
        .get('/admin/dashboard-transform/show-all-router-views.js')
        .expect(404);
      expect(response.body).toEqual({
        error: 'plugin is disabled',
        id: 'show-all-router-views',
      });
    } finally {
      // Re-enable so subsequent tests see the default state.
      setPluginEnabled('show-all-router-views', true);
    }
  });

  it('startAdminServer binds the configured port and closes cleanly', async () => {
    // Given: a real HTTP listener (not just an Express app) and a
    // zero-arg port picker via the `port: 0` convention. We assert
    // the listener assigns an ephemeral port and the close() promise
    // resolves without error.
    const { startAdminServer } = require('./server');
    const app = createApp();
    const started = await startAdminServer(app, { port: 0, bindHost: '127.0.0.1' });
    expect(started.port).toBeGreaterThan(0);

    // When: we hit the health endpoint over real HTTP.
    const fetchBody = await fetch(`http://127.0.0.1:${started.port}/api/plugins/health`)
      .then((r) => r.json() as Promise<{ status: string }>);
    expect(fetchBody).toEqual({ status: 'ok' });

    // Then: close() resolves cleanly.
    await expect(started.close()).resolves.toBeUndefined();
  });

  it('startAdminServer rejects on EADDRINUSE', async () => {
    // Given: a server already bound on a port.
    const { startAdminServer } = require('./server');
    const app = createApp();
    const first = await startAdminServer(app, { port: 0, bindHost: '127.0.0.1' });
    const occupiedPort = first.port;

    // When: a second server tries to bind the same port.
    const app2 = createApp();
    const second = startAdminServer(app2, { port: occupiedPort, bindHost: '127.0.0.1' });

    // Then: the second start rejects.
    await expect(second).rejects.toThrow();

    // Cleanup.
    await first.close();
  });
});
