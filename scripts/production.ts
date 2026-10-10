// Operator tooling only. No bootstrap endpoint and no automatic resource provisioning.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, isAcceptablePassword, parsePasswordHash } from '../shared/password.ts';
import { normalizeUsername } from '../shared/username.ts';
import { assertUuid, parseFlags, PROJECT_ROOT, readPassword } from './lib.ts';
import { confirmTarget, EXPECTED_ZONE_NAME, loadProductionConfig, object, PRODUCTION_CONFIG, PRODUCTION_PASSWORD_ITERATIONS, ProductionError, validId, verifyInventory, type ProductionTarget } from './production-config.ts';
import { assertProductionMigrationTarget, migrateProduction } from './production-migrations.ts';

export type CliResult = { status: number | null; stdout: string; stderr: string };
export type CliRunner = (args: string[]) => Promise<CliResult>;
function fail(message: string): never { throw new ProductionError(message); }
function json(result: CliResult): unknown {
  if (result.status !== 0) fail('Verifikasi Wrangler gagal; output mentah disembunyikan.');
  try { return JSON.parse(result.stdout); } catch { fail('Hasil JSON Wrangler tidak valid.'); }
}

/** Capture both streams and isolate Wrangler debug logs, which could include SQL or credentials. */
export const runWrangler = async (args: string[], environment: NodeJS.ProcessEnv = process.env): Promise<CliResult> => {
  // Capture before yielding so async log setup cannot change the validated CLI environment.
  const env = { ...environment };
  const directory = await mkdtemp(join(tmpdir(), 'razia-production-cli-'));
  try {
    const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'node_modules/wrangler/bin/wrangler.js'), ...args, '--config', PRODUCTION_CONFIG], {
      cwd: PROJECT_ROOT, encoding: 'utf8', shell: false, stdio: ['ignore','pipe','pipe'], maxBuffer: 8 * 1024 * 1024,
      env: { ...env, CLOUDFLARE_ACCOUNT_ID: '04b8b2073be2f1aa21fc6489e0db36f6', WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true', WRANGLER_LOG_LEVEL: 'log', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_LOG_PATH: join(directory, 'wrangler.log') },
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally { await rm(directory, { recursive: true, force: true }); }
};

type BuildCommandRunner = (command: string, args: string[], options: SpawnSyncOptions) => { status: number | null };
/** Rebuild shared dist deterministically; inherited shell/dotenv UAT markers cannot select the UI. */
export async function buildProductionAssets(run: BuildCommandRunner = spawnSync, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const env = { ...environment, VITE_APP_MODE: 'production', NODE_ENV: 'production' };
  const tsc = join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const vite = join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const commands = [
    ...['tsconfig.app.json', 'tsconfig.worker.json', 'tsconfig.tools.json'].map(config => [tsc, '-p', config]),
    [vite, 'build', '--mode', 'production', '--emptyOutDir'],
  ];
  try {
    for (const args of commands) {
      const result = run(process.execPath, args, { cwd: PROJECT_ROOT, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      if (result.status !== 0) fail('Build aset production gagal; operasi dihentikan sebelum Wrangler.');
    }
  } catch { fail('Build aset production gagal; detail sensitif disembunyikan dan Wrangler tidak dijalankan.'); }
}

async function requireProductionAssets(build: () => Promise<void>): Promise<void> {
  try { await build(); }
  catch { fail('Build aset production gagal; detail sensitif disembunyikan dan Wrangler tidak dijalankan.'); }
}

export async function verifyResources(target: ProductionTarget, run: CliRunner): Promise<void> {
  const whoami = json(await run(['whoami','--json']));
  const databases = json(await run(['d1','list','--json']));
  // Namespace list emits JSON by default; no unsupported --json flag is passed.
  const namespaces = json(await run(['kv','namespace','list']));
  verifyInventory(target, whoami, databases, namespaces);
}

/** Strict UTC timestamps with supported microsecond precision, without Date millisecond truncation. */
export function deploymentTimestamp(value: unknown): bigint {
  if (typeof value !== 'string') fail('Metadata deployment Worker tidak valid.');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match || match[0] !== value) fail('Metadata deployment Worker tidak valid.');
  const canonicalSecond = `${match[1]}.000Z`;
  const milliseconds = Date.parse(canonicalSecond);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== canonicalSecond) fail('Timestamp deployment Worker tidak valid.');
  return BigInt(milliseconds) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

/** Review the currently active deployment, not a newer uploaded but undeployed version. */
export async function verifyWorker(target: ProductionTarget, flags: Map<string,string>, run: CliRunner): Promise<void> {
  const result = await run(['deployments','list','--name',target.worker,'--json']);
  if (result.status !== 0) {
    if (/\[code:\s*10007\]/.test(result.stderr) && flags.get('confirm-new-worker') === target.worker && !flags.has('confirm-version') && !flags.has('confirm-deployment')) return;
    fail('Worker belum dapat diverifikasi; target baru memerlukan confirm-new-worker setelah not-found otoritatif.');
  }
  const deployments = json(result);
  if (!Array.isArray(deployments) || deployments.length === 0 || flags.has('confirm-new-worker')) fail('Metadata deployment Worker kosong, tidak valid, atau konfirmasi bertentangan.');
  const rows = deployments.map(value => {
    const row = object(value);
    if (!validId(row.id, true)) fail('Metadata deployment Worker tidak valid.');
    const created = deploymentTimestamp(row.created_on);
    return { row, created };
  }).sort((a,b) => a.created === b.created ? 0 : a.created > b.created ? -1 : 1);
  if (new Set(rows.map(value => value.row.id)).size !== rows.length || (rows.length > 1 && rows[0].created === rows[1].created)) fail('Deployment aktif ambigu; pemeriksaan operator diperlukan.');
  const current = rows[0].row;
  if (!Array.isArray(current.versions) || current.versions.length !== 1) fail('Deployment bertahap/multi-version tidak didukung helper.');
  const version = object(current.versions[0]);
  if (!validId(version.version_id, true) || version.percentage !== 100 || flags.get('confirm-deployment') !== current.id || flags.get('confirm-version') !== version.version_id) fail('Konfirmasi deployment aktif dan versi tunggal 100% wajib cocok persis.');
}

/** Reject truncated inventory rather than assuming a partial page proves absence. */
function inventoryRows(payload: Record<string,unknown>, requirePagination = false, optionalTotalPages = false): Record<string,unknown>[] {
  if (!Array.isArray(payload.result)) fail('Inventaris endpoint bukan array.');
  const rows = payload.result.map(object);
  if (requirePagination || payload.result_info !== undefined) {
    if (!payload.result_info || typeof payload.result_info !== 'object' || Array.isArray(payload.result_info)) fail('Inventaris endpoint memiliki metadata pagination tidak valid.');
    const info = object(payload.result_info);
    // count describes the returned results; only total_count proves the unfiltered inventory is complete.
    // List Worker Domains declares total_pages optional and has no documented page traversal parameters.
    const terminalPage = info.total_pages === undefined && optionalTotalPages
      ? true
      : (info.total_pages === 0 || info.total_pages === 1) && (rows.length === 0 || info.total_pages === 1);
    if (info.page !== 1 || !Number.isSafeInteger(info.per_page) || Number(info.per_page) < 1 || Number(info.per_page) < rows.length || !Number.isSafeInteger(info.count) || !Number.isSafeInteger(info.total_count) || info.count !== rows.length || info.total_count !== rows.length || !terminalPage) fail('Inventaris endpoint terpotong atau pagination ambigu.');
  }
  return rows;
}

/** DNS records may be reviewed only when the hostname is already bound to this exact Worker. */
export async function verifyDomain(target: ProductionTarget, token: string | undefined, request: typeof fetch = fetch, flags = new Map<string,string>()): Promise<void> {
  if (!token) fail('Verifikasi zone/domain memerlukan CLOUDFLARE_API_TOKEN dengan akses baca yang sesuai.');
  if (flags.get('confirm-hostname-review') !== target.origin) fail('Konfirmasi peninjauan hostname, wildcard DNS, dan route operator wajib cocok.');
  const get = async (path: string): Promise<Record<string,unknown>> => {
    try {
      const response = await request(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) fail('Metadata zone/domain/DNS gagal diverifikasi.');
      const payload = object(await response.json());
      if (payload.success !== true) fail('Metadata zone/domain/DNS gagal diverifikasi.');
      return payload;
    } catch { fail('Metadata zone/domain/DNS gagal diverifikasi; tidak ada deployment.'); }
  };
  const zone = object((await get(`/zones/${target.zone}`)).result);
  const account = object(zone.account);
  if (zone.id !== target.zone || account.id !== target.account || zone.status !== 'active' || zone.name !== EXPECTED_ZONE_NAME || !(target.hostname === zone.name || target.hostname.endsWith(`.${zone.name}`))) fail('Zone aktif/account/hostname tidak cocok.');
  const domains = inventoryRows(await get(`/accounts/${target.account}/workers/domains`), false, true);
  const matches = domains.filter(domain => domain.hostname === target.hostname);
  if (matches.length > 1 || (matches.length === 1 && (matches[0].service !== target.worker || matches[0].zone_id !== target.zone))) fail('Custom domain dimiliki target lain atau metadata ambigu.');
  // Use the documented exact name filter; do not query record content or log DNS payloads.
  const dns = inventoryRows(await get(`/zones/${target.zone}/dns_records?name.exact=${encodeURIComponent(target.hostname)}&page=1&per_page=100`),true);
  if (dns.some(record => !validId(record.id) || record.name !== target.hostname || typeof record.type !== 'string')) fail('Metadata DNS hostname tidak valid.');
  if (dns.length > 0) {
    if (matches.length !== 1 || dns.length !== 1 || !['A','AAAA'].includes(String(dns[0].type)) || dns[0].proxied !== true || flags.get('confirm-dns-record') !== dns[0].id) fail('DNS hostname sudah ada; hanya satu record proxied A/AAAA yang ditinjau pada binding Worker yang sama dapat diterima.');
  } else if (flags.has('confirm-dns-record')) fail('Konfirmasi DNS tidak cocok dengan inventaris kosong.');
  const routes = inventoryRows(await get(`/zones/${target.zone}/workers/routes`));
  for (const route of routes) {
    if (typeof route.pattern !== 'string' || (route.script !== null && typeof route.script !== 'string')) fail('Metadata route zone tidak valid.');
    if (!route.script) continue;
    const host = /^(?:https?:\/\/)?([^/]+)(?:\/.*)?$/.exec(route.pattern)?.[1];
    if (!host || !/^[a-z0-9.*-]+$/.test(host)) fail('Pola route zone tidak dapat diverifikasi.');
    const regex = new RegExp(`^${host.replaceAll('.', '\\.').replaceAll('*','.*')}$`);
    if (regex.test(target.hostname)) fail('Route Worker aktif menutupi hostname; rekonsiliasi operator diperlukan.');
  }
}

function sqlText(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
export type BootstrapSql = { id: string; auditId: string; triggerName: string; create: string; insert: string; drop: string; check: string };
export function buildBootstrapSql(id: string, auditId: string, rawUsername: string, passwordHash: string, passwordIterations: number): BootstrapSql {
  assertUuid(id); assertUuid(auditId);
  const username = normalizeUsername(rawUsername);
  if (!username || passwordIterations !== PRODUCTION_PASSWORD_ITERATIONS || parsePasswordHash(passwordHash)?.iterations !== passwordIterations) fail('Username, kebijakan iterasi atau hash bootstrap tidak valid.');
  const triggerName = `production_bootstrap_${id.replaceAll('-', '')}`;
  const create = `CREATE TRIGGER ${triggerName} AFTER INSERT ON users
WHEN NEW.id = ${sqlText(id)} AND NEW.username = ${sqlText(username)} AND NEW.role = 'ADMIN' AND NEW.is_active = 1 AND (SELECT COUNT(*) FROM users) = 1
BEGIN
 INSERT INTO admin_audit_logs(id,actor_user_id,action,target_user_id) VALUES(${sqlText(auditId)},NEW.id,'USER_CREATED',NEW.id);
END;`;
  const insert = `INSERT INTO users(id,username,password_hash,role,is_active) SELECT ${sqlText(id)},${sqlText(username)},${sqlText(passwordHash)},'ADMIN',1 WHERE NOT EXISTS (SELECT 1 FROM users);`;
  const drop = `DROP TRIGGER IF EXISTS ${triggerName};`;
  const check = `SELECT (SELECT COUNT(*) FROM users) AS users_count, (SELECT COUNT(*) FROM users WHERE id=${sqlText(id)} AND role='ADMIN' AND is_active=1) AS intended_count, (SELECT COUNT(*) FROM admin_audit_logs WHERE id=${sqlText(auditId)} AND actor_user_id=${sqlText(id)} AND target_user_id=${sqlText(id)} AND action='USER_CREATED') AS audit_count;`;
  return { id, auditId, triggerName, create, insert, drop, check };
}
export const EMPTY_USERS_SQL = 'SELECT COUNT(*) AS users_count FROM users;';
export type SqlRunner = (sql: string) => Promise<unknown>;
function countRow(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) fail('Pemeriksaan D1 tidak valid.');
  const result = object(value[0]);
  if (result.success !== true || !Array.isArray(result.results) || result.results.length !== 1) fail('Pemeriksaan D1 tidak valid.');
  return object(result.results[0]);
}

/** CREATE/DROP are independent operations. Only the INSERT plus AFTER audit trigger is atomic. */
export async function bootstrapAdmin(sql: BootstrapSql, execute: SqlRunner, notice: (message: string) => void): Promise<void> {
  if (countRow(await execute(EMPTY_USERS_SQL)).users_count !== 0) fail('Bootstrap ditolak: tabel users harus kosong seluruhnya.');
  let cleanupFailed = false;
  try {
    await execute(sql.create);
    await execute(sql.insert);
    const counts = countRow(await execute(sql.check));
    if (counts.users_count !== 1 || counts.intended_count !== 1 || counts.audit_count !== 1) fail('Bootstrap tidak terkonfirmasi; periksa metadata D1 sebelum tindakan lanjutan.');
  } finally {
    try { await execute(sql.drop); }
    catch { cleanupFailed = true; notice(`Pembersihan trigger gagal: ${sql.triggerName}. Jangan ulang bootstrap; lakukan rekonsiliasi operator.`); }
  }
  if (cleanupFailed) fail('Bootstrap memerlukan pembersihan trigger operator; akun tidak dihapus.');
}

export async function executeRemoteSql(sql: string, run: CliRunner): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), 'razia-production-sql-'));
  try {
    const file = join(directory, `${randomUUID()}.sql`);
    await writeFile(file, sql, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const output = json(await run(['d1','execute','DB','--remote','--file',file,'--json','--yes']));
    if (!Array.isArray(output) || output.length === 0 || output.some(entry => object(entry).success !== true)) fail('Eksekusi D1 tidak terkonfirmasi; detail sensitif disembunyikan.');
    return output;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export type OperationDependencies = { run: CliRunner; build: () => Promise<void>; load: () => ProductionTarget; password: () => Promise<string>; domain: (target: ProductionTarget, flags: Map<string,string>) => Promise<void>; sql: SqlRunner; notice: (message: string) => void; migrate?: (target: ProductionTarget, run: CliRunner, notice: (message: string) => void) => Promise<void> };
export async function runProduction(argv: string[], dependencies: OperationDependencies): Promise<string> {
  const [mode, ...args] = argv;
  const common = ['confirm-account','confirm-database','confirm-worker','confirm-origin'];
  const allowed = mode === 'bootstrap' ? [...common,'username'] : mode === 'deploy' ? [...common,'confirm-new-worker','confirm-version','confirm-deployment','confirm-dns-record','confirm-hostname-review'] : mode === 'migrate' || mode === 'verify' ? common : [];
  const flags = parseFlags(args, allowed);
  if (!['check','dryrun','verify','migrate','deploy','bootstrap'].includes(mode)) fail('Perintah production tidak dikenal.');
  const target = dependencies.load();
  if (mode === 'check') return 'Konfigurasi lokal valid; resource remote belum diverifikasi.';
  if (mode === 'dryrun') {
    await requireProductionAssets(dependencies.build);
    const result = await dependencies.run(['deploy','--dry-run','--autoconfig=false']);
    if (result.status !== 0) fail('Dry-run gagal; output mentah disembunyikan.');
    return 'Dry-run lokal berhasil; bukan validasi produksi.';
  }
  confirmTarget(target, flags);
  if (mode === 'migrate') assertProductionMigrationTarget(target);
  const username = mode === 'bootstrap' ? normalizeUsername(flags.get('username')) : null;
  if (mode === 'bootstrap' && username === null) fail('Username ADMIN pertama wajib valid.');
  if (mode === 'bootstrap' && target.passwordIterations !== PRODUCTION_PASSWORD_ITERATIONS) fail('Kebijakan iterasi bootstrap production tidak cocok.');
  // Fail before even read-only remote inventory if the release assets cannot be rebuilt.
  if (mode === 'deploy') await requireProductionAssets(dependencies.build);
  await verifyResources(target, dependencies.run);
  if (mode === 'verify') return 'Account serta ID/nama D1 dan KV cocok; endpoint/CPU/canary belum diverifikasi.';
  if (mode === 'deploy') {
    await verifyWorker(target, flags, dependencies.run);
    await dependencies.domain(target,flags);
    if ((await dependencies.run(['deploy','--strict','--autoconfig=false'])).status !== 0) fail('Deployment gagal; rekonsiliasi versi/route sebelum mengulang.');
    return 'Deployment selesai; canary dan CPU belum dinyatakan PASS.';
  }
  if (mode === 'migrate') {
    await (dependencies.migrate ?? migrateProduction)(target, dependencies.run, dependencies.notice);
    return 'Migrasi file terkonfirmasi oleh metadata, skema, dan FK; bukan jalur completion CLI migrasi resmi vendor. Backup tetap tanggung jawab operator.';
  }
  const password = await dependencies.password();
  // Operator input follows the existing validation; never import or reuse development seed credentials.
  if (!isAcceptablePassword(password)) fail('Password bootstrap tidak valid.');
  const sql = buildBootstrapSql(randomUUID(), randomUUID(), username!, await hashPassword(password,target.passwordIterations), target.passwordIterations);
  await bootstrapAdmin(sql, dependencies.sql, dependencies.notice);
  return `ADMIN pertama dan audit terkonfirmasi; user_id=${sql.id}; audit_id=${sql.auditId}.`;
}

export async function prepareProductionConfig(): Promise<void> {
  await copyFile(join(PROJECT_ROOT,'wrangler.production.example.jsonc'),PRODUCTION_CONFIG,constants.COPYFILE_EXCL);
}
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (process.argv[2] === 'prepare' && process.argv.length === 3) {
      await prepareProductionConfig();
      process.stdout.write('Konfigurasi operator dibuat dengan placeholder tidak valid; isi hanya metadata yang disetujui.\n');
    } else {
      const result = await runProduction(process.argv.slice(2), { run: runWrangler, build: buildProductionAssets, load: loadProductionConfig, password: readPassword,
        domain: (target,flags) => verifyDomain(target, process.env.CLOUDFLARE_API_TOKEN,fetch,flags), sql: sql => executeRemoteSql(sql, runWrangler), notice: message => process.stderr.write(`${message}\n`) });
      process.stdout.write(`${result}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof ProductionError ? error.message : 'Operasi production ditolak atau gagal; detail sensitif disembunyikan.'}\n`);
    process.exitCode = 1;
  }
}
