// Operator-only initial objects. No public endpoint, generic CRUD, password argument or default credential.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, readPassword, assertUuid } from './lib.ts';
import { loadProductionConfig, confirmTarget, ProductionError, type ProductionTarget } from './production-config.ts';
import { assertProductionMigrationTarget, createProductionMigrationStore, verifyAppliedMigrations } from './production-migrations.ts';
import { runWrangler, verifyResources, type CliRunner } from './production.ts';
import { hashPassword, isAcceptablePassword, parsePasswordHash } from '../shared/password.ts';

export const INITIAL_ADMIN = 'elwin.bessiesura';
export const INITIAL_OFFICER = 'yusuf.adoe';
export const INITIAL_LOCATION = 'Jln. El Tari - DPRD Provinsi NTT';
export type InitialUser = { id: string; username: string; role: string; is_active: number; password_hash: string };
export type InitialLocation = { id: string; name: string; is_active: number };
export type InitialAudit = { id: string; actor_user_id: string; action: string; target_user_id: string | null; target_location_id: string | null };
// Private operator state; never serialize this snapshot to output or errors.
export type InitialSnapshot = { users: InitialUser[]; locations: InitialLocation[]; audits: InitialAudit[]; usersCount: number; locationsCount: number; auditsCount: number; sessionsCount: number; raidsCount: number; checksCount: number };
export type BootstrapStore = { readSnapshot: () => Promise<InitialSnapshot>; write: (sql: string) => Promise<void>; verifySchema: () => Promise<void> };
export type BootstrapResult = { admin: 'created' | 'verified-existing' | 'pending' | 'unknown'; officer: 'created' | 'verified-existing' | 'pending' | 'unknown'; location: 'created' | 'verified-existing' | 'pending' | 'unknown' };
export class InitialBootstrapError extends ProductionError {
  readonly progress: BootstrapResult;
  constructor(message: string, progress: BootstrapResult) { super(`${message} Status: ${JSON.stringify(progress)}`); this.progress = { ...progress }; }
}
function fail(message: string): never { throw new ProductionError(message); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('State bootstrap tidak valid.'); return value as Record<string, unknown>; }
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('Jumlah objek tidak valid.'); return value; }
function text(value: unknown): string { if (typeof value !== 'string') fail('Field state tidak valid.'); return value; }
function identifier(value: unknown): string { const id = text(value); try { assertUuid(id); } catch { fail('Identitas objek bootstrap tidak valid.'); } return id; }
function nullableId(value: unknown): string | null { return value === null ? null : identifier(value); }

export function validateInitialSnapshot(snapshot: InitialSnapshot): void {
  for (const key of ['usersCount','locationsCount','auditsCount','sessionsCount','raidsCount','checksCount'] as const) integer(snapshot[key]);
  if (!Array.isArray(snapshot.users) || !Array.isArray(snapshot.locations) || !Array.isArray(snapshot.audits) || snapshot.usersCount !== snapshot.users.length || snapshot.locationsCount !== snapshot.locations.length || snapshot.auditsCount !== snapshot.audits.length) fail('Inventaris bootstrap terpotong atau tidak konsisten.');
  if (snapshot.usersCount > 2 || snapshot.locationsCount > 1 || snapshot.auditsCount > 3 || snapshot.sessionsCount || snapshot.raidsCount || snapshot.checksCount) fail('Ada objek tambahan atau data operasional; bootstrap awal ditolak.');
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const user of snapshot.users) {
    identifier(user.id);
    const expectedRole = user.username === INITIAL_ADMIN ? 'ADMIN' : user.username === INITIAL_OFFICER ? 'OFFICER' : null;
    if (!expectedRole || user.role !== expectedRole || user.is_active !== 1 || !parsePasswordHash(user.password_hash) || names.has(user.username) || ids.has(user.id)) fail('Akun existing tidak cocok, nonaktif, duplikat, atau hash tidak valid; tidak diubah.');
    names.add(user.username); ids.add(user.id);
  }
  if (names.has(INITIAL_OFFICER) && !names.has(INITIAL_ADMIN)) fail('OFFICER tersedia tanpa ADMIN awal; perlu peninjauan operator.');
  for (const location of snapshot.locations) { identifier(location.id); if (location.name !== INITIAL_LOCATION || location.is_active !== 1) fail('Lokasi existing tidak cocok atau nonaktif; tidak diubah.'); }
  const admin = snapshot.users.find(user => user.username === INITIAL_ADMIN);
  const auditIds = new Set<string>(), auditTargets = new Set<string>();
  for (const audit of snapshot.audits) {
    identifier(audit.id); identifier(audit.actor_user_id);
    if (!admin || audit.actor_user_id !== admin.id || auditIds.has(audit.id)) fail('Audit awal tidak sesuai actor atau duplikat.');
    if (audit.action === 'USER_CREATED') {
      if (!audit.target_user_id || audit.target_location_id !== null || !snapshot.users.some(user => user.id === audit.target_user_id)) fail('Target audit akun tidak sesuai.');
    } else if (audit.action === 'LOCATION_CREATED') {
      if (!audit.target_location_id || audit.target_user_id !== null || !snapshot.locations.some(location => location.id === audit.target_location_id)) fail('Target audit lokasi tidak sesuai.');
    } else fail('Ada aksi audit di luar bootstrap awal.');
    const target = `${audit.action}:${audit.target_user_id ?? audit.target_location_id}`;
    if (auditTargets.has(target)) fail('Audit bootstrap duplikat.');
    auditTargets.add(target); auditIds.add(audit.id);
  }
  for (const user of snapshot.users) if (!auditTargets.has(`USER_CREATED:${user.id}`)) fail('Akun initial tidak memiliki audit penciptaan; perlu peninjauan operator tanpa auto-repair.');
  for (const location of snapshot.locations) if (!auditTargets.has(`LOCATION_CREATED:${location.id}`)) fail('Lokasi initial tidak memiliki audit penciptaan; perlu peninjauan operator tanpa auto-repair.');
}
export function publicBootstrapState(snapshot: InitialSnapshot): BootstrapResult {
  validateInitialSnapshot(snapshot);
  return { admin: snapshot.users.some(user => user.username === INITIAL_ADMIN) ? 'verified-existing' : 'pending', officer: snapshot.users.some(user => user.username === INITIAL_OFFICER) ? 'verified-existing' : 'pending', location: snapshot.locations.length ? 'verified-existing' : 'pending' };
}
function sqlText(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
export function buildInitialUserSql(id: string, auditId: string, role: 'ADMIN' | 'OFFICER', passwordHash: string, actorId: string, iterations: number): string {
  identifier(id); identifier(auditId); identifier(actorId);
  if (iterations !== 10 || parsePasswordHash(passwordHash)?.iterations !== iterations || !['ADMIN','OFFICER'].includes(role)) fail('Payload hash atau role bootstrap tidak valid.');
  const username = role === 'ADMIN' ? INITIAL_ADMIN : INITIAL_OFFICER;
  if (role === 'ADMIN' && actorId !== id) fail('Actor ADMIN awal harus akun yang baru dibuat.');
  const guard = role === 'ADMIN' ? 'NOT EXISTS(SELECT 1 FROM users)' : `EXISTS(SELECT 1 FROM users WHERE id=${sqlText(actorId)} AND username=${sqlText(INITIAL_ADMIN)} AND role='ADMIN' AND is_active=1) AND NOT EXISTS(SELECT 1 FROM users WHERE username=${sqlText(username)}) AND (SELECT count(*) FROM users)=1`;
  return `INSERT INTO users(id,username,password_hash,role,is_active) SELECT ${sqlText(id)},${sqlText(username)},${sqlText(passwordHash)},${sqlText(role)},1 WHERE ${guard};\nINSERT INTO admin_audit_logs(id,actor_user_id,action,target_user_id) SELECT ${sqlText(auditId)},${sqlText(actorId)},'USER_CREATED',id FROM users WHERE id=${sqlText(id)} AND username=${sqlText(username)} AND role=${sqlText(role)} AND is_active=1;`;
}
export function buildInitialLocationSql(id: string, auditId: string, actorId: string): string {
  identifier(id); identifier(auditId); identifier(actorId);
  return `INSERT INTO locations(id,name,is_active) SELECT ${sqlText(id)},${sqlText(INITIAL_LOCATION)},1 WHERE NOT EXISTS(SELECT 1 FROM locations) AND EXISTS(SELECT 1 FROM users WHERE id=${sqlText(actorId)} AND username=${sqlText(INITIAL_ADMIN)} AND role='ADMIN' AND is_active=1);\nINSERT INTO admin_audit_logs(id,actor_user_id,action,target_location_id) SELECT ${sqlText(auditId)},${sqlText(actorId)},'LOCATION_CREATED',id FROM locations WHERE id=${sqlText(id)} AND name=${sqlText(INITIAL_LOCATION)} AND is_active=1;`;
}
function sameSnapshot(a: InitialSnapshot, b: InitialSnapshot): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export async function runInitialBootstrap(store: BootstrapStore, options: { mode: 'preflight' | 'apply'; passwordIterations: number; readPassword?: (label: string) => Promise<string>; notice?: (message: string) => void }): Promise<BootstrapResult> {
  if (!['preflight','apply'].includes(options.mode) || options.passwordIterations !== 10) fail('Mode atau kebijakan produksi bootstrap tidak cocok.');
  await store.verifySchema();
  let current = await store.readSnapshot();
  const result = publicBootstrapState(current);
  const notice = options.notice ?? (() => {});
  if (options.mode === 'preflight') { notice(`Preflight: ${JSON.stringify(result)}`); return result; }
  const hashes = new Map<'ADMIN' | 'OFFICER', string>();
  const attempts = new Map<keyof BootstrapResult, { id: string; auditId: string }>();
  let adminPassword = '', officerPassword = '';
  try {
    if (result.admin === 'pending') { if (!options.readPassword) fail('Input terminal password diperlukan.'); adminPassword = await options.readPassword('Password ADMIN baru khusus produksi'); }
    if (result.officer === 'pending') { if (!options.readPassword) fail('Input terminal password diperlukan.'); officerPassword = await options.readPassword('Password OFFICER baru khusus produksi'); }
    if ((result.admin === 'pending' && !isAcceptablePassword(adminPassword)) || (result.officer === 'pending' && !isAcceptablePassword(officerPassword))) fail('Password tidak lolos validasi existing.');
    if (result.admin === 'pending' && result.officer === 'pending' && adminPassword === officerPassword) fail('Gunakan password berbeda untuk kedua akun.');
    if (result.admin === 'pending') hashes.set('ADMIN', await hashPassword(adminPassword, options.passwordIterations));
    if (result.officer === 'pending') hashes.set('OFFICER', await hashPassword(officerPassword, options.passwordIterations));
  } finally { adminPassword = ''; officerPassword = ''; }
  const apply = async (key: keyof BootstrapResult, sql: string, id: string, auditId: string, actorId: string, expectedHash?: string) => {
    await store.verifySchema();
    const before = await store.readSnapshot(); validateInitialSnapshot(before);
    if (!sameSnapshot(before, current)) fail('State berubah setelah preflight; jangan lanjut tanpa pemeriksaan baru.');
    attempts.set(key, { id, auditId });
    await store.write(sql);
    const after = await store.readSnapshot(); validateInitialSnapshot(after);
    const found = key === 'location' ? after.locations.find(row => row.id === id) : after.users.find(row => row.id === id);
    if (!found || (expectedHash && (!('password_hash' in found) || found.password_hash !== expectedHash)) || !after.audits.some(row => row.id === auditId && row.actor_user_id === actorId && (key === 'location' ? row.target_location_id === id && row.action === 'LOCATION_CREATED' : row.target_user_id === id && row.action === 'USER_CREATED'))) fail('Objek atau audit baru tidak terkonfirmasi.');
    const expected = structuredClone(before);
    if (key === 'location') { expected.locations.push(after.locations.find(row => row.id === id)!); expected.locationsCount++; }
    else { expected.users.push(after.users.find(row => row.id === id)!); expected.users.sort((a,b) => a.username.localeCompare(b.username)); expected.usersCount++; }
    expected.audits.push(after.audits.find(row => row.id === auditId)!); expected.audits.sort((a,b) => a.id.localeCompare(b.id)); expected.auditsCount++;
    if (!sameSnapshot(expected, after)) fail('Mutasi mengubah objek selain objek bootstrap yang diizinkan.');
    await store.verifySchema(); current = after; result[key] = 'created'; notice(`${key} dibuat dan terverifikasi.`);
  };
  try {
    if (result.admin === 'pending') { const id=randomUUID(), auditId=randomUUID(); await apply('admin',buildInitialUserSql(id,auditId,'ADMIN',hashes.get('ADMIN')!,id,options.passwordIterations),id,auditId,id,hashes.get('ADMIN')); }
    const actorId=current.users.find(user=>user.username===INITIAL_ADMIN)?.id;
    if (!actorId) fail('ADMIN awal tidak terverifikasi.');
    if (result.officer === 'pending') { const id=randomUUID(), auditId=randomUUID(); await apply('officer',buildInitialUserSql(id,auditId,'OFFICER',hashes.get('OFFICER')!,actorId,options.passwordIterations),id,auditId,actorId,hashes.get('OFFICER')); }
    if (result.location === 'pending') { const id=randomUUID(), auditId=randomUUID(); await apply('location',buildInitialLocationSql(id,auditId,actorId),id,auditId,actorId); }
    await store.verifySchema(); publicBootstrapState(await store.readSnapshot());
    notice(`Bootstrap terverifikasi: ${JSON.stringify(result)}`); return result;
  } catch {
    try {
      const observed = await store.readSnapshot(); validateInitialSnapshot(observed);
      for (const key of ['admin','officer','location'] as const) {
        if (result[key] !== 'pending') continue;
        const attempt = attempts.get(key);
        const row = key === 'location' ? observed.locations[0] : observed.users.find(user => user.username === (key === 'admin' ? INITIAL_ADMIN : INITIAL_OFFICER));
        if (!row) continue;
        const audited = attempt && observed.audits.some(audit => audit.id === attempt.auditId && (key === 'location' ? audit.target_location_id === attempt.id : audit.target_user_id === attempt.id));
        const expectedHash = key === 'location' ? undefined : hashes.get(key === 'admin' ? 'ADMIN' : 'OFFICER');
        result[key] = attempt && row.id === attempt.id && audited && (!expectedHash || ('password_hash' in row && row.password_hash === expectedHash)) ? 'created' : 'unknown';
      }
    }
    catch { for(const key of ['admin','officer','location'] as const) if(result[key]==='pending') result[key]='unknown'; }
    throw new InitialBootstrapError('Operasi berhenti; periksa state sebelum tindakan berikutnya. Tidak ada retry/repair otomatis.',result);
  } finally { hashes.clear(); }
}

export const INITIAL_SNAPSHOT_SQL = `SELECT json_object('usersCount',(SELECT count(*) FROM users),'locationsCount',(SELECT count(*) FROM locations),'auditsCount',(SELECT count(*) FROM admin_audit_logs),'sessionsCount',(SELECT count(*) FROM user_sessions),'raidsCount',(SELECT count(*) FROM raid_sessions),'checksCount',(SELECT count(*) FROM check_logs),'users',(SELECT json_group_array(json_object('id',id,'username',username,'role',role,'is_active',is_active,'password_hash',password_hash)) FROM (SELECT * FROM users ORDER BY username LIMIT 3)),'locations',(SELECT json_group_array(json_object('id',id,'name',name,'is_active',is_active)) FROM (SELECT * FROM locations ORDER BY name,id LIMIT 2)),'audits',(SELECT json_group_array(json_object('id',id,'actor_user_id',actor_user_id,'action',action,'target_user_id',target_user_id,'target_location_id',target_location_id)) FROM (SELECT * FROM admin_audit_logs ORDER BY id LIMIT 4))) AS state;`;
function parseSnapshot(output: string): InitialSnapshot {
  let value: unknown;
  try { value = JSON.parse(output); } catch { fail('Snapshot JSON tidak valid.'); }
  if (!Array.isArray(value) || value.length !== 1) fail('Envelope snapshot tidak valid.');
  const entry = record(value[0]);
  if (entry.success !== true || !Array.isArray(entry.results) || entry.results.length !== 1) fail('Query snapshot tidak sukses.');
  const row = record(entry.results[0]);
  let raw: Record<string, unknown>; try { raw = record(JSON.parse(text(row.state))); } catch { fail('State snapshot tidak valid.'); }
  if (!Array.isArray(raw.users) || !Array.isArray(raw.locations) || !Array.isArray(raw.audits)) fail('Daftar snapshot tidak valid.');
  const snapshot: InitialSnapshot = {
    usersCount: integer(raw.usersCount), locationsCount: integer(raw.locationsCount), auditsCount: integer(raw.auditsCount), sessionsCount: integer(raw.sessionsCount), raidsCount: integer(raw.raidsCount), checksCount: integer(raw.checksCount),
    users: raw.users.map(value => { const u=record(value); return {id:identifier(u.id),username:text(u.username),role:text(u.role),is_active:integer(u.is_active),password_hash:text(u.password_hash)}; }),
    locations: raw.locations.map(value => { const l=record(value); return {id:identifier(l.id),name:text(l.name),is_active:integer(l.is_active)}; }),
    audits: raw.audits.map(value => { const a=record(value); return {id:identifier(a.id),actor_user_id:identifier(a.actor_user_id),action:text(a.action),target_user_id:nullableId(a.target_user_id),target_location_id:nullableId(a.target_location_id)}; }),
  };
  validateInitialSnapshot(snapshot); return snapshot;
}
export function createInitialCliStore(target: ProductionTarget, run: CliRunner, load = loadProductionConfig): BootstrapStore {
  const guard=()=>{assertProductionMigrationTarget(target); if(JSON.stringify(load())!==JSON.stringify(target))fail('Konfigurasi berubah sejak target diverifikasi.');};
  return {
    verifySchema: async()=>{guard(); await verifyAppliedMigrations(createProductionMigrationStore('DB',run,guard));},
    readSnapshot: async()=>{guard(); const r=await run(['d1','execute','DB','--remote','--command',INITIAL_SNAPSHOT_SQL,'--json']); if(r.status!==0)fail('Pembacaan snapshot gagal; output mentah disembunyikan.'); return parseSnapshot(r.stdout);},
    write: async sql=>{guard(); const dir=await mkdtemp(join(tmpdir(),'razia-initial-'));try{const file=join(dir,`${randomUUID()}.sql`); await writeFile(file,sql,{encoding:'utf8',mode:0o600,flag:'wx'}); const r=await run(['d1','execute','DB','--remote','--file',file,'--json','--yes']);if(r.status!==0)fail('Import gagal atau hasil tidak pasti; tidak ada retry otomatis.');}finally{await rm(dir,{recursive:true,force:true});}},
  };
}
export type InitialDependencies = { load: () => ProductionTarget; run: CliRunner; store: (target: ProductionTarget) => BootstrapStore; password: (label: string) => Promise<string>; isTTY: () => boolean; notice: (message: string) => void };
export async function runInitialCommand(argv: string[], deps: InitialDependencies): Promise<BootstrapResult> {
  const [mode,...args]=argv;
  if(mode!=='preflight'&&mode!=='apply')fail('Mode wajib preflight atau apply.');
  const flags=parseFlags(args,['confirm-account','confirm-database','confirm-worker','confirm-origin','confirm-initial-objects']);
  const target=deps.load(); assertProductionMigrationTarget(target); confirmTarget(target,flags);
  if(mode==='apply'&&flags.get('confirm-initial-objects')!=='initial-accounts-and-location')fail('Konfirmasi objek awal wajib untuk apply.');
  if(mode==='preflight'&&flags.has('confirm-initial-objects'))fail('Flag apply tidak berlaku untuk preflight.');
  await verifyResources(target,deps.run);
  deps.notice(`Target produksi: account=${target.account}; D1=razia-samsat-db; UUID=${target.database}; Worker=${target.worker}.`);
  deps.notice('Gunakan password baru khusus produksi, jangan password development; gunakan password berbeda untuk kedua akun.');
  return runInitialBootstrap(deps.store(target),{mode,passwordIterations:target.passwordIterations,readPassword:async label=>{if(!deps.isTTY())fail('Input password memerlukan terminal interaktif tanpa echo dan konfirmasi.'); return deps.password(label);},notice:deps.notice});
}
const isMain=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){try{await runInitialCommand(process.argv.slice(2),{load:loadProductionConfig,run:runWrangler,store:target=>createInitialCliStore(target,runWrangler),password:readPassword,isTTY:()=>process.stdin.isTTY===true,notice:message=>process.stdout.write(`${message}\n`)});}catch(error){process.stderr.write(`${error instanceof ProductionError ? error.message : 'Bootstrap gagal; detail sensitif disembunyikan.'}\n`);process.exitCode=1;}}
