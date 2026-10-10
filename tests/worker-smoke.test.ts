import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../shared/password';
import { startMigratedD1, type TestD1 } from './helpers/miniflare';

// Layer B: the production Worker bundle produced by Wrangler, executed in workerd with real D1.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = 'https://app.test';
const PASSWORD = 'Synthetic-Workerd-Pass';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
let outdir: string;
let mf: Miniflare;
let db: TestD1;

async function boot(vars: Record<string, string>): Promise<void> {
  await mf?.dispose();
  ({ mf, db } = await startMigratedD1({ modules: true, modulesRoot: outdir, scriptPath: join(outdir, 'index.js'), bindings: vars }));
}
const post = (path: string, body: unknown, cookie?: string) => mf.dispatchFetch(`${ORIGIN}${path}`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(cookie ? { Cookie: `__Host-rs_session=${cookie}` } : {}) },
});

beforeAll(async () => {
  outdir = await mkdtemp(join(tmpdir(), 'razia-bundle-'));
  const result = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'deploy', '--dry-run', '--outdir', outdir], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true' },
  });
  if (result.status !== 0) throw new Error(`wrangler dry-run failed: ${result.stderr}`);
  expect(existsSync(join(outdir, 'index.js'))).toBe(true);
}, 180000);
afterAll(async () => {
  try { await mf?.dispose(); }
  finally { if (outdir) await rm(outdir, { recursive: true, force: true }); }
});

describe('bundled Worker in workerd', () => {
  it('verifies a Node-generated 100000-iteration hash and runs login, me, logout end to end', async () => {
    await boot({ PASSWORD_PBKDF2_ITERATIONS: '100000', SESSION_TTL_SECONDS: '43200', RETENTION_POLICY: 'UNSET' });
    await db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'synthetic.admin',?,'ADMIN')").bind(ADMIN_ID, await hashPassword(PASSWORD, 100000)).run();
    const login = await post('/api/auth/login', { username: 'Synthetic.Admin', password: PASSWORD });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    const match = /^__Host-rs_session=([A-Za-z0-9_-]{43}); Max-Age=(\d+); Path=\/; HttpOnly; Secure; SameSite=Strict$/.exec(setCookie);
    expect(match).not.toBeNull();
    expect(Number(match?.[2])).toBeGreaterThan(43000);
    const token = match?.[1] ?? '';
    expect(await login.json()).toMatchObject({ user: { id: ADMIN_ID, username: 'synthetic.admin', role: 'ADMIN' }, active_raid_session: null });

    const me = await mf.dispatchFetch(`${ORIGIN}/api/auth/me`, { headers: { Cookie: `__Host-rs_session=${token}` } });
    expect(me.status).toBe(200);
    expect(me.headers.get('cache-control')).toBe('no-store');
    expect(me.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);

    const wrong = await post('/api/auth/login', { username: 'synthetic.admin', password: 'Wrong' });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });

    const logout = await post('/api/auth/logout', {}, token);
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toBe('__Host-rs_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict');
    expect((await mf.dispatchFetch(`${ORIGIN}/api/auth/me`, { headers: { Cookie: `__Host-rs_session=${token}` } })).status).toBe(401);
  }, 60000);
  it('rejects iteration counts above 100000 in config and in stored hashes', async () => {
    await boot({ PASSWORD_PBKDF2_ITERATIONS: '100001', SESSION_TTL_SECONDS: '43200', RETENTION_POLICY: 'UNSET' });
    const failing = await post('/api/auth/login', { username: 'synthetic.admin', password: PASSWORD });
    expect(failing.status).toBe(500);
    expect(await failing.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });

    await boot({ PASSWORD_PBKDF2_ITERATIONS: '100000', SESSION_TTL_SECONDS: '43200', RETENTION_POLICY: 'UNSET' });
    const valid = await hashPassword(PASSWORD, 100000);
    await db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'synthetic.admin',?,'ADMIN')").bind(ADMIN_ID, valid.replace('$100000$', '$100001$')).run();
    const response = await post('/api/auth/login', { username: 'synthetic.admin', password: PASSWORD });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
  }, 60000);
  it('enforces CSRF in the bundled Worker', async () => {
    await boot({ PASSWORD_PBKDF2_ITERATIONS: '1000', SESSION_TTL_SECONDS: '60', RETENTION_POLICY: 'UNSET' });
    const response = await mf.dispatchFetch(`${ORIGIN}/api/auth/login`, { method: 'POST', body: '{}', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });
  }, 60000);
});
