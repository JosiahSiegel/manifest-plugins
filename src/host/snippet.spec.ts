import { ADMIN_MOUNT_NEW, ADMIN_MOUNT_OLD } from './snippet';

describe('admin Express mount host snippet', () => {
  it('matches the upstream main.ts listen anchor byte-for-byte', () => {
    expect(ADMIN_MOUNT_OLD).toBe(`  const port = Number(process.env['PORT'] ?? 3001);
  const host = process.env['BIND_ADDRESS'] ?? '127.0.0.1';
  await app.listen(port, host);
`);
  });

  it('mounts manifest-plugins createAdminServer before app.listen', () => {
    expect(ADMIN_MOUNT_NEW).toBe(`  // Fork: mount the plugin admin Express app on the same port as the
  // dashboard. The admin app handles /api/plugins/* and /admin/admin.js.
  // The require() is best-effort: if the package is missing (upstream
  // or CI without the fork's plugin layer), this is a no-op.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const admin = require('manifest-plugins');
    if (admin && typeof admin.createAdminServer === 'function') {
      expressApp.use(admin.createAdminServer());
    }
  } catch {
    // admin app missing or failed to load; continue without it
  }
  const port = Number(process.env['PORT'] ?? 3001);
  const host = process.env['BIND_ADDRESS'] ?? '127.0.0.1';
  await app.listen(port, host);
`);
  });
});
