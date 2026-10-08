// Operator-only production configuration. Runtime Env and local configuration remain unchanged.
import { join, resolve } from 'node:path';
import { experimental_readRawConfig } from 'wrangler';
import { PROJECT_ROOT } from './lib.ts';

export const PRODUCTION_CONFIG = join(PROJECT_ROOT, 'wrangler.production.jsonc');
export const EXPECTED_ACCOUNT = '04b8b2073be2f1aa21fc6489e0db36f6';
export const EXPECTED_WORKER = 'razia-samsat-production';
export const EXPECTED_DATABASE = 'razia-samsat-production-db';
export const EXPECTED_NAMESPACE = 'razia-samsat-production-vehicle-cache';
export class ProductionError extends Error {}
function fail(message: string): never { throw new ProductionError(message); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Bentuk konfigurasi atau hasil verifikasi tidak valid.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('Field konfigurasi tidak diizinkan.');
}
function single(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) fail('Harus tepat satu binding atau route production.');
  return object(value[0]);
}
export function validId(value: unknown, uuid = false): value is string {
  return typeof value === 'string' && (uuid ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/ : /^[0-9a-f]{32}$/).test(value) && !/^0[-0]*$/.test(value) && value !== '00000000000000000000000000000001';
}
export type ProductionTarget = { account: string; worker: string; database: string; namespace: string; hostname: string; origin: string; zone: string };

/** A deliberately narrow policy, not a general Wrangler schema validator. Unknown fields fail closed. */
export function validateProductionConfig(input: unknown, configPath = PRODUCTION_CONFIG): ProductionTarget {
  if (resolve(configPath) !== resolve(PRODUCTION_CONFIG)) fail('Konfigurasi operator wajib berada di root proyek: wrangler.production.jsonc.');
  const config = object(input);
  keys(config, ['$schema','name','main','compatibility_date','account_id','workers_dev','preview_urls','assets','routes','d1_databases','kv_namespaces','vars','observability']);
  if (config.$schema !== 'node_modules/wrangler/config-schema.json' || config.name !== EXPECTED_WORKER || config.account_id !== EXPECTED_ACCOUNT || !validId(config.account_id)) fail('Account atau nama Worker production belum valid.');
  if (config.main !== 'worker/index.ts' || config.compatibility_date !== '2026-10-07' || config.workers_dev !== false || config.preview_urls !== false) fail('Entrypoint, compatibility atau endpoint production tidak sesuai baseline.');
  const assets = object(config.assets); keys(assets, ['directory','binding','not_found_handling','run_worker_first']);
  if (assets.directory !== './dist' || assets.binding !== 'ASSETS' || assets.not_found_handling !== 'single-page-application' || JSON.stringify(assets.run_worker_first) !== '["/api","/api/*"]') fail('Static Assets atau batas API tidak sesuai baseline.');
  const db = single(config.d1_databases); keys(db, ['binding','database_name','database_id','migrations_dir','remote']);
  if (db.binding !== 'DB' || db.database_name !== EXPECTED_DATABASE || !validId(db.database_id, true) || db.migrations_dir !== 'migrations' || ('remote' in db && db.remote !== true)) fail('Binding D1 production tidak valid; placeholder/local ditolak.');
  const kv = single(config.kv_namespaces); keys(kv, ['binding','id','remote']);
  if (kv.binding !== 'VEHICLE_CACHE' || !validId(kv.id) || ('remote' in kv && kv.remote !== true)) fail('Binding KV production tidak valid; placeholder/local ditolak.');
  if (db.database_id.replaceAll('-', '') === kv.id || kv.id === config.account_id) fail('ID resource production bertabrakan.');
  const vars = object(config.vars); keys(vars, ['PASSWORD_PBKDF2_ITERATIONS','SESSION_TTL_SECONDS','RETENTION_POLICY']);
  if (vars.PASSWORD_PBKDF2_ITERATIONS !== '100000' || vars.SESSION_TTL_SECONDS !== '43200' || vars.RETENTION_POLICY !== 'UNSET') fail('Baseline production wajib tepat 100000/43200/UNSET.');
  const observability = object(config.observability); keys(observability, ['enabled','logs','traces']);
  const logs = object(observability.logs); keys(logs, ['enabled','invocation_logs']);
  const traces = object(observability.traces); keys(traces, ['enabled']);
  if (typeof observability.enabled !== 'boolean' || logs.enabled !== observability.enabled || logs.invocation_logs !== false || traces.enabled !== false) fail('Observability hanya console aman; invocation logs dan traces dilarang.');
  const route = single(config.routes); keys(route, ['pattern','zone_id','custom_domain']);
  const hostname = route.pattern;
  if (typeof hostname !== 'string' || hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname) || /\.(invalid|test|example|localhost)$/.test(hostname) || /(?:^|\.)example\.(com|net|org)$/.test(hostname) || hostname.endsWith('.workers.dev') || route.custom_domain !== true || !validId(route.zone_id)) fail('Satu custom domain nyata dan zone_id wajib dipilih; placeholder ditolak.');
  return { account: config.account_id, worker: EXPECTED_WORKER, database: db.database_id, namespace: kv.id, hostname, origin: `https://${hostname}`, zone: route.zone_id };
}

export function loadProductionConfig(): ProductionTarget {
  try {
    const { rawConfig } = experimental_readRawConfig({ config: PRODUCTION_CONFIG });
    return validateProductionConfig(rawConfig);
  } catch (error) {
    if (error instanceof ProductionError) throw error;
    fail('Konfigurasi operator tidak tersedia atau JSONC tidak valid.');
  }
}

export function confirmTarget(target: ProductionTarget, flags: Map<string, string>): void {
  if (flags.get('confirm-account') !== target.account || flags.get('confirm-database') !== target.database || flags.get('confirm-worker') !== target.worker || flags.get('confirm-origin') !== target.origin) fail('Konfirmasi account/database/worker/origin wajib cocok persis.');
}

/** Validate only inventory metadata, never trust names without their paired IDs. */
export function verifyInventory(target: ProductionTarget, whoami: unknown, databases: unknown, namespaces: unknown): void {
  const user = object(whoami);
  if (user.loggedIn !== true || !Array.isArray(user.accounts) || user.accounts.filter(account => object(account).id === target.account).length !== 1) fail('Account terautentikasi tidak cocok.');
  for (const [inventory, idKey, nameKey, id, name] of [[databases,'uuid','name',target.database,EXPECTED_DATABASE],[namespaces,'id','title',target.namespace,EXPECTED_NAMESPACE]] as const) {
    if (!Array.isArray(inventory)) fail('Inventaris resource bukan array.');
    const rows = inventory.map(object);
    const matches = rows.filter(row => row[idKey] === id || row[nameKey] === name);
    if (matches.length !== 1 || matches[0][idKey] !== id || matches[0][nameKey] !== name) fail('ID/nama resource tidak cocok, duplikat, atau belum tersedia.');
  }
}
