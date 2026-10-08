// Node-only local UAT tooling. No operator-selected config, binding, persistence path or remote mode.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { lstat, realpath, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { experimental_readRawConfig } from 'wrangler';
import { hashPassword } from '../shared/password.ts';
import { buildCreateLocationSql, buildCreateUserSql, PROJECT_ROOT } from './lib.ts';

export const DEVELOPMENT_CONFIG = join(PROJECT_ROOT, 'wrangler.development.jsonc');
export const DEVELOPMENT_PERSIST = join(PROJECT_ROOT, '.wrangler', 'dev-uat');
export const DEVELOPMENT_USERS = [
  { id: '81000000-0000-4000-8000-000000000001', username: 'elwinbessiesura', role: 'ADMIN' },
  { id: '81000000-0000-4000-8000-000000000002', username: 'yusuf.adoe', role: 'OFFICER' },
] as const;
export const DEVELOPMENT_LOCATION = { id: '81000000-0000-4000-8000-000000000003', name: 'UAT — Titik Pemeriksaan' };
const EXPECTED = {
  $schema: 'node_modules/wrangler/config-schema.json', name: 'razia-samsat-development', main: 'worker/dev-index.ts',
  compatibility_date: '2026-10-07', workers_dev: false, preview_urls: false,
  assets: { directory: './dist', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true },
  d1_databases: [{ binding: 'DB', database_name: 'razia-samsat-uat-db', database_id: '00000000-0000-0000-0000-000000000001', migrations_dir: 'migrations', remote: false }],
  kv_namespaces: [{ binding: 'VEHICLE_CACHE', id: '00000000000000000000000000000001', remote: false }],
  vars: { APP_ENV: 'development', PASSWORD_PBKDF2_ITERATIONS: '100000', SESSION_TTL_SECONDS: '43200', RETENTION_POLICY: 'UNSET' },
  observability: { enabled: false, logs: { enabled: false, invocation_logs: false }, traces: { enabled: false } },
};
export class DevelopmentError extends Error {}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
export function validateDevelopmentConfig(input: unknown, configPath = DEVELOPMENT_CONFIG): void {
  if (resolve(configPath) !== resolve(DEVELOPMENT_CONFIG) || canonical(input) !== canonical(EXPECTED)) {
    throw new DevelopmentError('Konfigurasi development lokal tidak sesuai batas yang diizinkan.');
  }
}
export function loadDevelopmentConfig(): void {
  try { validateDevelopmentConfig(experimental_readRawConfig({ config: DEVELOPMENT_CONFIG }).rawConfig); }
  catch { throw new DevelopmentError('Konfigurasi development lokal ditolak.'); }
}
async function existingStat(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
/** Refuse linked ancestors before any command, and linked descendants before destructive reset. */
export async function assertDevelopmentState(root = PROJECT_ROOT, inspectDescendants = false): Promise<string> {
  const base = resolve(root);
  for (const path of [base, join(base, '.wrangler'), join(base, '.wrangler', 'dev-uat')]) {
    const stat = await existingStat(path);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory() || resolve(await realpath(path)) !== resolve(path))) {
      throw new DevelopmentError('State development harus direktori fisik tanpa symlink atau junction.');
    }
  }
  const state = join(base, '.wrangler', 'dev-uat');
  if (inspectDescendants) {
    const walk = async (path: string): Promise<void> => {
      const stat = await existingStat(path);
      if (!stat) return;
      if (stat.isSymbolicLink() || resolve(await realpath(path)) !== resolve(path)) throw new DevelopmentError('Reset menolak symlink atau junction.');
      if (stat.isDirectory()) for (const name of await readdir(path)) await walk(join(path, name));
    };
    await walk(state);
  }
  return state;
}
export function localWranglerArgs(args: string[]): string[] {
  return [...args, '--local', '--config', DEVELOPMENT_CONFIG, '--persist-to', DEVELOPMENT_PERSIST];
}
type LocalCommandRunner = (command: string, args: string[], options: SpawnSyncOptions) => { status: number | null };
export function runLocalWrangler(args: string[], run: LocalCommandRunner = spawnSync): void {
  // Validate even direct helper calls before creating files or starting a CLI process.
  loadDevelopmentConfig();
  const directory = mkdtempSync(join(tmpdir(), 'razia-development-cli-'));
  let failure: string | null = null;
  try {
    const result = run(process.execPath, [join(PROJECT_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), ...localWranglerArgs(args)], {
      cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true', WRANGLER_LOG: 'error', WRANGLER_LOG_LEVEL: 'error', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_LOG_PATH: join(directory, 'wrangler.log') },
    });
    // CLI diagnostics can contain SQL/hashes. Never relay either stream or raw exceptions.
    if (result.status !== 0) failure = 'Perintah development lokal gagal; detail sensitif disembunyikan.';
  } catch {
    failure = 'Perintah development lokal gagal; detail sensitif disembunyikan.';
  } finally {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { failure = 'Pembersihan log development gagal; persiapan UAT dihentikan.'; }
  }
  if (failure) throw new DevelopmentError(failure);
}
export function buildDevelopmentSeedStatements(hashes: readonly string[]): string[] {
  if (hashes.length !== DEVELOPMENT_USERS.length) throw new DevelopmentError('Hash seed tidak valid.');
  const statements = DEVELOPMENT_USERS.map((user, index) => {
    const sql = buildCreateUserSql({ ...user, passwordHash: hashes[index], iterations: 100000 }).trim();
    const values = sql.slice(sql.indexOf(' VALUES(') + 8, -2);
    // Existing username wins regardless of its ID, role, password or activity. Never escalate/reset it.
    return `INSERT INTO users(id, username, password_hash, role, is_active) SELECT ${values} WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = '${user.username}');`;
  });
  const sql = buildCreateLocationSql(DEVELOPMENT_LOCATION).trim();
  const values = sql.slice(sql.indexOf(' VALUES(') + 8, -2);
  statements.push(`INSERT INTO locations(id, name, is_active) SELECT ${values} WHERE NOT EXISTS (SELECT 1 FROM locations WHERE name = 'UAT — Titik Pemeriksaan');`);
  return statements;
}
export async function prepareDevelopment(): Promise<void> {
  loadDevelopmentConfig();
  await assertDevelopmentState();
  runLocalWrangler(['d1', 'migrations', 'apply', 'DB']);
  // This user-authorized literal belongs only to local seed tooling, never a Worker/client import.
  const hashes = await Promise.all(DEVELOPMENT_USERS.map(() => hashPassword('password', 100000)));
  const directory = await mkdtemp(join(tmpdir(), 'razia-dev-seed-'));
  try {
    const file = join(directory, 'seed.sql');
    await writeFile(file, buildDevelopmentSeedStatements(hashes).join('\n'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    runLocalWrangler(['d1', 'execute', 'DB', '--file', file]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function resetDevelopment(confirmed: boolean): Promise<void> {
  if (!confirmed) throw new DevelopmentError('Reset memerlukan --confirm-reset dan menghapus seluruh state UAT lokal.');
  loadDevelopmentConfig();
  const state = await assertDevelopmentState(PROJECT_ROOT, true);
  await rm(state, { recursive: true, force: true });
  await prepareDevelopment();
}
