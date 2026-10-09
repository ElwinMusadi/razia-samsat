// Operator tooling only. Repository-controlled file ingestion, not the vendor migration CLI.
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PROJECT_ROOT } from './lib.ts';
import { EXPECTED_ACCOUNT, EXPECTED_WORKER, loadProductionConfig, ProductionError, validId, type ProductionTarget } from './production-config.ts';
import type { CliRunner } from './production.ts';

export const MIGRATION_DATABASE_ID = '6fd6706b-5e09-4b54-aef7-c49a82b38bd1';
// Exact getCreateMigrationsTableQuery/buildMigrationQuery contract in Wrangler 4.148.0.
export const MIGRATION_METADATA_SQL = 'CREATE TABLE IF NOT EXISTS "d1_migrations"(\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n);';
export type CatalogEntry = { name: string; type: string; sql: string | null };
export type MigrationRow = { id: number; name: string; applied_at: string };
export type MigrationState = { catalog: CatalogEntry[]; migrations: MigrationRow[]; foreignKeys: number; foreignKeyViolations: unknown[] };
export type MigrationStore = {
  readState: () => Promise<MigrationState>;
  initializeMetadata: () => Promise<void>;
  importFile: (file: string) => Promise<void>;
};
export type MigrationSource = { filename: string; path: string; sql: string; sha256: string };
export type ScratchTarget = { scope: 'scratch'; account: string; database: string; databaseName: string };
const filenamePattern = /^\d{4}_[a-z0-9_]+\.sql$/;
function fail(message: string): never { throw new ProductionError(message); }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Tokenize only schema comparisons; ingestion never rewrites or splits source SQL. */
export function normalizeSchemaSql(sql: string): string {
  const tokens: string[] = [];
  for (let i = 0; i < sql.length;) {
    const char = sql[i];
    if (/\s/.test(char)) { i++; continue; }
    if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i + 2); i = end < 0 ? sql.length : end + 1; continue; }
    if (sql.startsWith('/*', i)) { const end = sql.indexOf('*/', i + 2); if (end < 0) fail('Komentar skema tidak lengkap.'); i = end + 2; continue; }
    if (["'", '"', '`', '['].includes(char)) {
      const endChar = char === '[' ? ']' : char;
      const start = i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i++] !== endChar) continue;
        if (char !== '[' && sql[i] === endChar) { i++; continue; }
        closed = true; break;
      }
      if (!closed) fail('Literal skema tidak lengkap.');
      tokens.push(sql.slice(start, i)); continue;
    }
    const word = /^[\p{L}\p{N}_$]+/u.exec(sql.slice(i));
    if (word) { tokens.push(word[0]); i += word[0].length; continue; }
    const operator = /^(?:->>|->|>=|<=|!=|<>|==|\|\||<<|>>)/.exec(sql.slice(i));
    if (operator) { tokens.push(operator[0]); i += operator[0].length; continue; }
    tokens.push(char); i++;
  }
  if (tokens.at(-1) === ';') tokens.pop();
  return JSON.stringify(tokens);
}

function applicationCatalog(catalog: CatalogEntry[]): CatalogEntry[] {
  const names = new Set<string>();
  return catalog.filter(entry => {
    if (!entry || typeof entry.name !== 'string' || !['table','index','trigger','view'].includes(entry.type) || (entry.sql !== null && typeof entry.sql !== 'string') || names.has(entry.name)) fail('Katalog skema tidak valid atau duplikat.');
    names.add(entry.name);
    if (entry.name.startsWith('sqlite_')) return false;
    if (entry.name.startsWith('_cf_')) {
      if (entry.type !== 'table' || !['_cf_KV','_cf_METADATA'].includes(entry.name)) fail('Objek internal D1 tidak dikenal; pemeriksaan operator diperlukan.');
      return false;
    }
    return entry.name !== 'd1_migrations';
  });
}
export function schemaFingerprint(catalog: CatalogEntry[]): string {
  const entries = applicationCatalog(catalog).map(entry => {
    if (!entry.sql) fail('Definisi objek aplikasi tidak lengkap.');
    return [entry.type, entry.name, normalizeSchemaSql(entry.sql)];
  }).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  return digest(JSON.stringify(entries));
}
function sqliteCatalog(db: DatabaseSync): CatalogEntry[] {
  return db.prepare('SELECT name,type,sql FROM sqlite_master ORDER BY type,name').all() as CatalogEntry[];
}
const metadataDb = new DatabaseSync(':memory:');
let expectedMetadataSql: string;
try { metadataDb.exec(MIGRATION_METADATA_SQL); expectedMetadataSql = normalizeSchemaSql(sqliteCatalog(metadataDb).find(entry => entry.name === 'd1_migrations')!.sql!); }
finally { metadataDb.close(); }

async function checkedSource(path: string, directory: string): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || relative(directory, await realpath(path)) !== relative(directory, path)) fail('Path migrasi bukan file reguler dalam direktori yang disetujui.');
  const bytes = await readFile(path);
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) fail('Encoding migrasi bukan UTF-8 yang utuh.');
  const after = await lstat(path);
  if (after.isSymbolicLink() || !after.isFile() || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('File migrasi berubah saat dibaca.');
  return bytes;
}
export async function loadMigrationSources(directory = join(PROJECT_ROOT, 'migrations')): Promise<MigrationSource[]> {
  directory = resolve(directory);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || relative(directory, await realpath(directory)) !== '') fail('Direktori migrasi tidak aman.');
  const entries = await readdir(directory, { withFileTypes: true });
  if (!entries.length || entries.some(entry => !entry.isFile() || !filenamePattern.test(entry.name))) fail('Nama atau jenis file migrasi tidak valid.');
  const filenames = entries.map(entry => entry.name).sort();
  let previous = 0;
  const sources: MigrationSource[] = [];
  for (const filename of filenames) {
    const number = Number(filename.slice(0,4));
    if (number <= previous) fail('Nomor migrasi duplikat atau tidak meningkat.');
    previous = number;
    const path = join(directory, filename), bytes = await checkedSource(path, directory);
    sources.push({ filename, path, sql: bytes.toString('utf8'), sha256: digest(bytes) });
  }
  return sources;
}
export function buildMigrationPayload(source: MigrationSource): string {
  if (!filenamePattern.test(source.filename) || digest(source.sql) !== source.sha256) fail('Sumber migrasi tidak valid.');
  return `${source.sql}\nINSERT INTO "d1_migrations" (name)\nvalues ('${source.filename}');`;
}
function expectedPrefixes(sources: MigrationSource[]): string[] {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    const prefixes = [schemaFingerprint(sqliteCatalog(db))];
    for (const source of sources) {
      db.exec(source.sql);
      if (sqliteCatalog(db).some(entry => entry.name === 'd1_migrations' || entry.name.startsWith('_cf_'))) fail('Migrasi menyentuh metadata yang dilindungi.');
      prefixes.push(schemaFingerprint(sqliteCatalog(db)));
    }
    return prefixes;
  } catch { fail('Replay skema SQLite lokal gagal; migrasi remote tidak dijalankan.'); }
  finally { db.close(); }
}
/** CURRENT_TIMESTAMP is a canonical UTC calendar timestamp, not merely a matching pattern. */
function validAppliedAt(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return false;
  const iso = `${value.replace(' ', 'T')}.000Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso;
}
function statePrefix(state: MigrationState, sources: MigrationSource[], prefixes: string[]): number | null {
  if (!Array.isArray(state.catalog) || !Array.isArray(state.migrations) || state.foreignKeys !== 1 || !Array.isArray(state.foreignKeyViolations) || state.foreignKeyViolations.length) fail('Pemeriksaan skema/FK gagal atau tidak lengkap.');
  const fingerprint = schemaFingerprint(state.catalog);
  const metadata = state.catalog.find(entry => entry.name === 'd1_migrations');
  if (!metadata) {
    if (state.migrations.length || fingerprint !== prefixes[0]) fail('Skema aplikasi tanpa metadata migrasi; rekonsiliasi operator diperlukan.');
    return null;
  }
  if (metadata.type !== 'table' || !metadata.sql || normalizeSchemaSql(metadata.sql) !== expectedMetadataSql) fail('Definisi d1_migrations tidak kompatibel dengan Wrangler 4.148.0.');
  let lastId = 0;
  if (state.migrations.length > sources.length) fail('Metadata migrasi bukan prefix sumber yang diketahui.');
  for (const [index, row] of state.migrations.entries()) {
    if (!row || !Number.isSafeInteger(row.id) || row.id <= lastId || row.name !== sources[index].filename || !validAppliedAt(row.applied_at)) fail('Metadata migrasi tidak berurutan, tidak dikenal, atau ambigu.');
    lastId = row.id;
  }
  const count = state.migrations.length;
  if (fingerprint !== prefixes[count]) fail('Skema aplikasi tidak cocok dengan prefix metadata; tidak ada perbaikan otomatis.');
  return count;
}
async function assertSourcesUnchanged(sources: MigrationSource[]): Promise<void> {
  for (const source of sources) {
    if (digest(await checkedSource(source.path, resolve(source.path, '..'))) !== source.sha256) fail('Checksum sumber migrasi berubah; operasi dihentikan.');
  }
}

/** Each file plus its official metadata suffix is one supported file ingestion. */
export async function runMigrations(store: MigrationStore, options: { directory?: string; notice?: (message: string) => void } = {}): Promise<void> {
  const sources = await loadMigrationSources(options.directory), prefixes = expectedPrefixes(sources);
  let count = statePrefix(await store.readState(), sources, prefixes);
  if (count === null) {
    await store.initializeMetadata();
    count = statePrefix(await store.readState(), sources, prefixes);
    if (count !== 0) fail('Inisialisasi metadata tidak terkonfirmasi kosong.');
  }
  if (count > 0) options.notice?.(`Terverifikasi ${count} migrasi sudah diterapkan; prefix yang cocok tidak diimpor ulang.`);
  while (count < sources.length) {
    await assertSourcesUnchanged(sources);
    if (statePrefix(await store.readState(), sources, prefixes) !== count) fail('State migrasi berubah bersamaan; operasi dihentikan.');
    const source = sources[count];
    options.notice?.(`Menerapkan ${source.filename}; SHA-256=${source.sha256}.`);
    const directory = await mkdtemp(join(tmpdir(), 'razia-migration-'));
    try {
      const file = join(directory, source.filename);
      await writeFile(file, buildMigrationPayload(source), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try { await store.importFile(file); }
      catch {
        // A read may establish the committed prefix, but never authorizes automatic replay.
        let observed = 'tidak diketahui';
        try { observed = String(statePrefix(await store.readState(), sources, prefixes)); } catch { /* Keep diagnostics bounded and secret-free. */ }
        fail(`Impor ${source.filename} gagal atau ambigu; prefix teramati=${observed}. Periksa metadata sebelum menjalankan ulang; tidak ada retry otomatis.`);
      }
      await assertSourcesUnchanged(sources);
      if (statePrefix(await store.readState(), sources, prefixes) !== count + 1) fail('Impor tidak terkonfirmasi oleh skema dan metadata; pemeriksaan operator diperlukan.');
      count++;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  await assertSourcesUnchanged(sources);
  if (statePrefix(await store.readState(), sources, prefixes) !== sources.length) fail('Verifikasi akhir migrasi gagal.');
}

const catalogQuery = "SELECT name,type,sql FROM sqlite_master ORDER BY type,name;";
const snapshotQuery = `${catalogQuery} SELECT id,name,applied_at FROM "d1_migrations" ORDER BY id; PRAGMA foreign_key_check; PRAGMA foreign_keys;`;
function resultRows(stdout: string, expected: number): Record<string,unknown>[][] {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { fail('JSON snapshot D1 tidak valid.'); }
  if (!Array.isArray(value) || value.length !== expected) fail('Jumlah hasil snapshot D1 tidak valid.');
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || entry.success !== true || !Array.isArray(entry.results) || entry.results.some((row: unknown) => !row || typeof row !== 'object' || Array.isArray(row))) fail('Snapshot D1 tidak sukses atau tidak valid.');
    return entry.results as Record<string,unknown>[];
  });
}
export function createProductionMigrationStore(database: string, run: import('./production.ts').CliRunner, guard: () => void): MigrationStore {
  return cliStore(database, run, guard);
}
function cliStore(database: string, run: import('./production.ts').CliRunner, guard: () => void, metadataIdentifier = database): MigrationStore {
  const execute = async (args: string[]) => {
    guard();
    try { const result = await run(args); if (result.status !== 0) fail('Perintah migrasi Wrangler gagal; output mentah disembunyikan.'); return result; }
    catch { fail('Perintah migrasi Wrangler gagal; output mentah disembunyikan.'); }
  };
  return {
    readState: async () => {
      const catalog = resultRows((await execute(['d1','execute',database,'--remote','--command',catalogQuery,'--json'])).stdout, 1)[0] as CatalogEntry[];
      if (!catalog.some(entry => entry.name === 'd1_migrations')) {
        const checks = resultRows((await execute(['d1','execute',database,'--remote','--command',`${catalogQuery} PRAGMA foreign_key_check; PRAGMA foreign_keys;`,'--json'])).stdout, 3);
        return { catalog: checks[0] as CatalogEntry[], migrations: [], foreignKeyViolations: checks[1], foreignKeys: Number(checks[2][0]?.foreign_keys) };
      }
      const rows = resultRows((await execute(['d1','execute',database,'--remote','--command',snapshotQuery,'--json'])).stdout, 4);
      if (rows[3].length !== 1 || typeof rows[3][0].foreign_keys !== 'number') fail('Hasil PRAGMA foreign_keys tidak valid.');
      return { catalog: rows[0] as CatalogEntry[], migrations: rows[1] as MigrationRow[], foreignKeyViolations: rows[2], foreignKeys: rows[3][0].foreign_keys };
    },
    // The official migration command accepts a configured name/binding, not a UUID.
    initializeMetadata: async () => { await execute(['d1','migrations','list',metadataIdentifier,'--remote']); },
    importFile: async file => { await execute(['d1','execute',database,'--remote','--file',file,'--json','--yes']); },
  };
}
export function assertProductionMigrationTarget(target: ProductionTarget): void {
  if (target.account !== EXPECTED_ACCOUNT || target.worker !== EXPECTED_WORKER || target.database !== MIGRATION_DATABASE_ID) fail('Target migrasi bukan account/Worker/UUID produksi FINAL.');
}
export async function migrateProduction(target: ProductionTarget, run: CliRunner, notice: (message: string) => void): Promise<void> {
  assertProductionMigrationTarget(target);
  const guard = () => {
    assertProductionMigrationTarget(target);
    if (JSON.stringify(loadProductionConfig()) !== JSON.stringify(target)) fail('Konfigurasi produksi berubah sejak verifikasi resource.');
  };
  guard();
  const pkg = JSON.parse(await readFile(join(PROJECT_ROOT, 'node_modules/wrangler/package.json'), 'utf8')) as { version?: string };
  if (pkg.version !== '4.148.0') fail('Versi Wrangler belum ditinjau untuk kontrak migrasi ini.');
  await runMigrations(cliStore('DB', run, guard), { notice });
}

/** Parent-owned isolated experiments only; this scope is never exposed through the production CLI. */
export function createScratchMigrationStore(target: ScratchTarget, run: CliRunner): MigrationStore {
  const guard = () => {
    if (target.scope !== 'scratch' || target.account !== EXPECTED_ACCOUNT || !validId(target.database, true) || target.database === MIGRATION_DATABASE_ID || !/^razia-samsat-migration-design-[a-z0-9]{8,32}$/.test(target.databaseName)) fail('Target scratch migrasi tidak valid atau menyentuh produksi.');
  };
  guard();
  return cliStore(target.database, run, guard, target.databaseName);
}

export async function verifyAppliedMigrations(store: Pick<MigrationStore, 'readState'>, options: { directory?: string } = {}): Promise<void> {
  const sources = await loadMigrationSources(options.directory);
  const prefixes = expectedPrefixes(sources);
  const state = await store.readState();
  const count = statePrefix(state, sources, prefixes);
  if (count !== sources.length) fail('Skema aplikasi belum selesai dimigrasi. Teramati prefix=' + count + ', sumber=' + sources.length + '.');
}
