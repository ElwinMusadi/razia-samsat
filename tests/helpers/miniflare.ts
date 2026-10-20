import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions, type V4WorkerOptions } from 'miniflare';

export type TestD1 = Awaited<ReturnType<Miniflare['getD1Database']>>;

/**
 * The host UTC date may still be October 6 while the target WITA date is October 7.
 * Miniflare rejects a future UTC date; keep Wrangler's approved target unchanged.
 */
export function localCompatibilityDate(): string {
  const hostDate = new Date().toISOString().slice(0, 10);
  return hostDate < '2026-10-07' ? hostDate : '2026-10-07';
}

/** Production migration files are authoritative; preserve complete trigger bodies. */
export async function loadMigrationFiles(throughFilename?: string): Promise<{ filename: string; statements: string[] }[]> {
  const directory = new URL('../../migrations/', import.meta.url);
  const filenames = (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  if (throughFilename && !filenames.includes(throughFilename)) throw new Error('Unknown migration filename');
  const files = [];
  for (const filename of filenames.filter(name => !throughFilename || name <= throughFilename)) {
    const migration = await readFile(new URL(filename, directory), 'utf8');
    const statements: string[] = [];
    let statement = '';
    let trigger = false;
    for (const line of migration.split('\n')) {
      const text = line.trim();
      if (!text || text.startsWith('--')) continue;
      if (text.startsWith('CREATE TRIGGER')) trigger = true;
      statement += ` ${text}`;
      if ((!trigger && text.endsWith(';')) || (trigger && (text === 'END;' || (text.startsWith('BEGIN ') && text.endsWith('END;'))))) {
        statements.push(statement.trim()); statement = ''; trigger = false;
      }
    }
    if (statement) throw new Error(`Incomplete migration statement: ${filename}`);
    files.push({ filename, statements });
  }
  return files;
}

export async function loadMigrationStatements(throughFilename?: string): Promise<string> {
  return (await loadMigrationFiles(throughFilename)).flatMap(file => file.statements).join('\n');
}

/** One atomic D1 batch per file, matching migration boundaries without manual transactions. */
export async function applyTestMigrations(db: TestD1, throughFilename?: string, afterFilename?: string): Promise<void> {
  for (const file of await loadMigrationFiles(throughFilename)) {
    if (!afterFilename || file.filename > afterFilename) await db.batch(file.statements.map(statement => db.prepare(statement)));
  }
}

const placeholderWorker: V4WorkerOptions = { modules: true, script: 'export default { fetch(){ return new Response("test"); } };' };

/** Starts real workerd with all migrations, or an explicit upgrade baseline. */
export async function startMigratedD1(worker: V4WorkerOptions = placeholderWorker, throughFilename?: string): Promise<{ mf: Miniflare; db: TestD1 }> {
  const mf = new Miniflare(convertV4MiniflareOptions({ ...worker, compatibilityDate: localCompatibilityDate(), d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    await applyTestMigrations(db, throughFilename);
    return { mf, db };
  } catch (error) {
    // A failed startup must not strand a workerd process or its proxy sockets.
    await mf.dispose();
    throw error;
  }
}

/** Suite-scoped runtime, per-test data isolation. Keep real schema/triggers/FKs intact. */
/**
 * Test-only: drops vehicle source changes (version > 1) so their admin actors can be deleted. The schema forbids
 * DELETE on that table, so the append-only trigger is removed and re-created verbatim from the migration file
 * inside the same atomic batch. Application code can never do this.
 */
export async function clearVehicleSourceChanges(db: TestD1): Promise<void> {
  const table = await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='vehicle_source_settings'").first<number>('n');
  if (!table || !await db.prepare('SELECT count(*) AS n FROM vehicle_source_settings WHERE version > 1').first<number>('n')) return;
  const file = (await loadMigrationFiles('0005_vehicle_source.sql')).find(entry => entry.filename === '0005_vehicle_source.sql');
  const guard = file?.statements.find(statement => statement.startsWith('CREATE TRIGGER vehicle_source_settings_append_only'));
  if (!guard) throw new Error('Append-only trigger definition not found');
  await db.batch([db.prepare('DROP TRIGGER vehicle_source_settings_append_only'), db.prepare('DELETE FROM vehicle_source_settings WHERE version > 1'), db.prepare(guard)]);
}

/** Suite-scoped runtime, per-test data isolation. Keep real schema/triggers/FKs intact. */
export async function resetTestD1(db: TestD1): Promise<void> {
  // Vehicle source changes reference their admin actor; only the migration seed row (version 1) survives.
  await clearVehicleSourceChanges(db);
  // Delete children before parents with foreign keys enabled; never bypass schema guards.
  await db.batch(['check_logs', 'admin_audit_logs', 'raid_sessions', 'user_sessions', 'users', 'locations']
    .map(table => db.prepare(`DELETE FROM ${table}`)));
}
