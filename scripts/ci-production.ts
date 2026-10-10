// Workers Builds gates for an existing Worker. No migration, bootstrap, trigger, domain or secret mutations.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from './lib.ts';
import { buildProductionAssets, runWrangler, verifyResources, verifyWorker, verifyDomain, deploymentTimestamp, type CliRunner } from './production.ts';
import { loadProductionConfig, ProductionError, object, validId, EXPECTED_ACCOUNT, EXPECTED_WORKER, EXPECTED_HOSTNAME, type ProductionTarget } from './production-config.ts';
import { MIGRATION_DATABASE_ID } from './production-migrations.ts';

const CONFIG = 'wrangler.production.jsonc';
const NAMESPACE = 'c8ca3a5faf9c4922a6f3f88aaa7ddbb7';
const SHA = /^[0-9a-f]{40}$/;
type CommandResult = { status: number | null; stdout: string; stderr: string };
export type PlatformPhase = 'preflight' | 'post_upload';
type PlatformFailureCategory = 'http' | 'api_error' | 'timeout' | 'aborted' | 'network' | 'invalid_response' | 'body_too_large';
export type CiDeps = {
  env: NodeJS.ProcessEnv; root: string; nodeVersion: string; wranglerVersion: string;
  git: (args: string[]) => CommandResult;
  load: () => ProductionTarget;
  build: () => Promise<void>;
  task: (name: 'lint' | 'test' | 'audit', env: NodeJS.ProcessEnv) => { status: number | null };
  runWrangler: CliRunner;
  readPlatform: (target: ProductionTarget, path: string, phase: PlatformPhase) => Promise<Record<string, unknown>>;
  notice: (message: string) => void;
};
type Hashes = Record<string, string>;
type Receipt = { schemaVersion: 1; sha: string; config: string; lock: string; sources: Hashes; assets: Hashes };
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const receiptPath = (deps: CiDeps) => join(deps.root, '.wrangler', 'ci-gate.json');
function fail(message: string): never { throw new ProductionError(message); }
function json(output: CommandResult): unknown { if (output.status !== 0) fail('Wrangler gagal; output sensitif tidak ditampilkan.'); try { return JSON.parse(output.stdout); } catch { fail('Metadata Wrangler tidak valid.'); } }
function git(deps: CiDeps, args: string[]): string { const r = deps.git(args); if (r.status !== 0) fail('Git context tidak dapat diverifikasi; output tidak ditampilkan.'); return r.stdout.trim(); }
function verifyEnv(deps: CiDeps): void {
  const env = deps.env;
  if ('WRANGLER_CI_OVERRIDE_NAME' in env) {
    const val = env.WRANGLER_CI_OVERRIDE_NAME;
    if (val !== undefined && val !== EXPECTED_WORKER) fail('Override nama Worker ditolak.');
  }
  if ('CLOUDFLARE_ENV' in env) {
    if (env.CLOUDFLARE_ENV !== undefined) fail('Override endpoint platform ditolak.');
  }
  if ('WRANGLER_API_ENVIRONMENT' in env) {
    const val = env.WRANGLER_API_ENVIRONMENT;
    // Wrangler 4.148.0 WRANGLER_API_ENVIRONMENT vendor supports production/staging; this pipeline production only.
    if (val !== undefined && val !== 'production') fail('Override endpoint platform ditolak.');
  }
  for (const k of ['CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL']) {
    if (k in env) {
      const val = env[k];
      if (val !== undefined && val !== 'https://api.cloudflare.com/client/v4') fail('Override endpoint platform ditolak.');
    }
  }
  if ('CLOUDFLARE_COMPLIANCE_REGION' in env) {
    const val = env.CLOUDFLARE_COMPLIANCE_REGION;
    if (val !== undefined && val !== 'public') fail('Override endpoint platform ditolak.');
  }
}
function versions(deps: CiDeps): void {
  if (deps.nodeVersion !== '24.21.0' || deps.wranglerVersion !== '4.148.0') fail('Toolchain wajib Node24.21.0 dan Wrangler4.148.0 yang telah diuji.');
}
function target(deps: CiDeps): ProductionTarget {
  versions(deps);
  const t = deps.load();
  verifyEnv(deps);
  if (t.account !== EXPECTED_ACCOUNT || t.worker !== EXPECTED_WORKER || t.database !== MIGRATION_DATABASE_ID || t.namespace !== NAMESPACE || t.hostname !== EXPECTED_HOSTNAME || t.origin !== 'https://'+EXPECTED_HOSTNAME || t.passwordIterations !== 10) fail('Target CI tidak sesuai resource produksi FINAL.');
  return t;
}
function safePath(path: string): void {
  if (!path) fail('Path tidak boleh kosong.');
  if (path.includes('\\') || path.includes(':') || [...path].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)) fail('Karakter path tidak aman.');
  const parts = path.split('/');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') fail('Komponen path tidak valid.');
    if (p !== p.trim()) fail('Spasi berlebih pada komponen path.');
    if (p.endsWith('.')) fail('Path komponen tidak valid.');
    const upper = p.toUpperCase();
    const base = upper.split('.')[0];
    if (['CON','PRN','AUX','NUL'].includes(base) || /^COM[1-9]$/.test(base) || /^LPT[1-9]$/.test(base)) fail('Nama device Windows tidak aman.');
  }
}
function safeFile(path: string): void {
  safePath(path);
  const parts = path.split('/');
  const root = parts[0];
  const rootLower = root.toLowerCase();
  if (['node_modules', '.wrangler', 'dist', 'coverage', 'backups'].includes(rootLower)) {
    if (root !== rootLower) fail('Casing direktori root tidak valid.');
  }
  for (const p of parts) {
    const component = p.toLowerCase();
    if (component.startsWith('.env') || component.startsWith('.dev.vars') || component === '.npmrc') fail('File konfigurasi secret dilarang.');
    if (/\.(pem|key|p12|pfx)$/.test(component)) fail('Ekstensi kunci dilarang.');
    if (/^(credentials?|tokens?|secrets?|passwords?|private[-_]key|id_rsa|id_ed25519)(?:\.[a-z0-9]+)?$/.test(component)) {
      if (!component.endsWith('.ts') && !component.endsWith('.tsx')) fail('File kredensial generik dilarang.');
    }
  }
}
function checkPhysical(deps: CiDeps, path: string) {
  const parts = path.split('/');
  let current = deps.root;
  try {
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) fail('Symlink tidak diizinkan.');
      if (i < parts.length - 1 && !stat.isDirectory()) fail('Bukan direktori.');
      if (i === parts.length - 1 && !stat.isFile()) fail('Bukan file regular.');
    }
  } catch (err: unknown) {
    if (err instanceof ProductionError) throw err;
    fail('Gagal memverifikasi path fisik.');
  }
}
function checkRootProactively(deps: CiDeps, name: string) {
  try {
    const stat = lstatSync(join(deps.root, name));
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`Direktori root ${name} tidak boleh symlink atau file regular.`);
  } catch (err: unknown) {
    if (err instanceof ProductionError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') fail(`Gagal memverifikasi root ${name}.`);
  }
}
function verifyRoot(deps: CiDeps): void {
  try {
    const stat = lstatSync(deps.root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Root workspace tidak valid.');
  } catch (err: unknown) {
    if (err instanceof ProductionError) throw err;
    fail('Gagal memverifikasi root workspace.');
  }
}
function context(deps: CiDeps): string {
  verifyRoot(deps);
  versions(deps);
  if (!['true','1'].includes(deps.env.CI ?? '') || deps.env.WORKERS_CI !== '1' || deps.env.WORKERS_CI_BRANCH !== 'main') fail('CI hanya untuk Workers Builds branch main.');
  const sha = deps.env.WORKERS_CI_COMMIT_SHA;
  if (!sha || !SHA.test(sha) || git(deps,['rev-parse','HEAD']) !== sha) fail('SHA Workers Builds tidak cocok dengan checkout Git.');
  const branch = git(deps,['branch','--show-current']);
  if (branch !== '' && branch !== 'main') fail('Checkout bukan main atau detached commit yang dikonfirmasi.');
  const url = git(deps,['remote','get-url','origin']);
  let repository: string;
  if (url.startsWith('git@github.com:')) repository = url.slice('git@github.com:'.length);
  else { try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.search || parsed.hash) fail('Remote repository tidak cocok.'); repository = parsed.pathname.slice(1); } catch { fail('Remote repository tidak cocok.'); } }
  if (repository.replace(/\.git$/, '') !== 'ElwinMusadi/razia-samsat') fail('Repository harus ElwinMusadi/razia-samsat.');
  const latest = git(deps,['ls-remote','origin','refs/heads/main']);
  if (latest !== `${sha}\trefs/heads/main`) fail('Commit sudah stale terhadap origin/main; tidak dirilis.');
  git(deps,['diff','--exit-code']); git(deps,['diff','--cached','--exit-code']);
  git(deps,['ls-files','--error-unmatch',CONFIG]);

  const untracked = gitNul(deps, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.length > 0) fail('File untracked tidak diizinkan; pastikan workspace bersih.');

  ['node_modules', 'dist', 'coverage', '.wrangler'].forEach(root => checkRootProactively(deps, root));

  const ignored = gitNul(deps, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '.', ':!:node_modules/']);
  for (const name of ignored) {
    safeFile(name);

    if (name.startsWith('dist/') || name.startsWith('coverage/')) {}
    else if (name === '.wrangler/ci-gate.json') {}
    else if (/^\.wrangler\/(state|tmp|dev-uat)\//.test(name)) {}
    else if (['tsconfig.app.tsbuildinfo', 'tsconfig.worker.tsbuildinfo', 'tsconfig.tools.tsbuildinfo', 'tsconfig.tsbuildinfo'].includes(name)) {}
    else fail('File ignored tidak diizinkan.');

    checkPhysical(deps, name);
  }

  return sha;
}
function fileHashes(deps: CiDeps, names: string[]): Hashes {
  const result: Hashes = {};
  const lowerNames = new Set<string>();
  const sortedNames = [...names].sort();
  for (const name of sortedNames) {
    safeFile(name);
    const root = name.split('/')[0];
    if (root === 'node_modules' || root === '.wrangler' || root === 'backups') fail('Manifest sumber tidak aman atau duplikat.');
    const lowerName = name.toLowerCase();
    if (lowerNames.has(lowerName)) fail('Manifest sumber tidak aman atau duplikat.');
    lowerNames.add(lowerName);
  }
  for (const name of sortedNames) {
    if (name in result) fail('Manifest sumber tidak aman atau duplikat.');
    checkPhysical(deps, name);
    result[name] = digest(readFileSync(join(deps.root, name)));
  }
  return result;
}
function gitNul(deps: CiDeps, args: string[]): string[] {
  const r = deps.git(args);
  if (r.status !== 0) fail('Git context tidak dapat diverifikasi; output tidak ditampilkan.');
  if (r.stdout === '') return [];
  if (!r.stdout.endsWith('\0')) fail('Format Git NUL tidak valid.');
  const parts = r.stdout.slice(0, -1).split('\0');
  const unique = new Set(parts);
  if (parts.length !== unique.size) fail('Duplikat record Git.');
  for (const p of parts) if (!p) fail('Record Git kosong dilarang.');
  return parts;
}
function sourceHashes(deps: CiDeps): Hashes {
  const files = gitNul(deps,['ls-files','-z']);
  if (!files.includes(CONFIG) || !files.includes('package-lock.json') || !files.length) fail('Manifest tracked source tidak lengkap.');
  return fileHashes(deps,files);
}
function assets(deps: CiDeps): Hashes {
  const names: string[] = [];
  const walk = (directory: string) => {
    const path = join(deps.root,directory); const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Direktori assets tidak aman.');
    for (const name of readdirSync(path)) { const relativeName = `${directory}/${name}`; const entry = lstatSync(join(deps.root,relativeName)); if (entry.isSymbolicLink()) fail('Symlink assets ditolak.'); if (entry.isDirectory()) walk(relativeName); else names.push(relativeName); }
  };
  walk('dist'); const result = fileHashes(deps,names);
  if (!result['dist/index.html']) fail('Assets build tidak lengkap.'); return result;
}
const same = (a: Hashes, b: Hashes) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
function readReceipt(deps: CiDeps, sha: string): Receipt {
  let r: Record<string, unknown>; try { r=object(JSON.parse(readFileSync(receiptPath(deps),'utf8'))); } catch { fail('Receipt tidak tersedia/valid; jalankan ci:build.'); }
  if (Object.keys(r).sort().join(',') !== 'assets,config,lock,schemaVersion,sha,sources' || r.schemaVersion !== 1 || r.sha !== sha) fail('Receipt bukan build sukses commit saat ini.');
  const hashes = (value: unknown): Hashes => { const x=object(value); if (!Object.keys(x).length || Object.values(x).some(v=>typeof v!=='string'||!/^[0-9a-f]{64}$/.test(v))) fail('Receipt hash tidak valid.'); return x as Hashes; };
  const sources=hashes(r.sources), current=sourceHashes(deps), built=hashes(r.assets);
  if (!same(sources,current) || r.config !== current[CONFIG] || r.lock !== current['package-lock.json'] || !same(built,assets(deps))) fail('Source/config/lock/assets berbeda dari build tervalidasi.');
  return {schemaVersion:1,sha,config:current[CONFIG],lock:current['package-lock.json'],sources,assets:built};
}
export async function ciBuild(deps: CiDeps): Promise<Receipt> {
  verifyRoot(deps);
  checkRootProactively(deps, '.wrangler');
  rmSync(receiptPath(deps),{force:true});
  const sha=context(deps); target(deps); const before=sourceHashes(deps);
  await deps.build();
  const env={...deps.env,NODE_ENV:'test'};
  for (const name of ['lint','test','audit'] as const) if (deps.task(name,env).status !== 0) fail(`Gate CI ${name} gagal; tidak ada receipt atau deployment.`);
  if (context(deps)!==sha || !same(before,sourceHashes(deps))) fail('Source berubah selama build.');
  const r: Receipt={schemaVersion:1,sha,config:before[CONFIG],lock:before['package-lock.json'],sources:before,assets:assets(deps)};
  mkdirSync(join(deps.root,'.wrangler'),{recursive:true});writeFileSync(receiptPath(deps),JSON.stringify(r,null,2),{mode:0o600});
  deps.notice(`CI build PASS commit=${sha}; receipt tanpa secret tersimpan.`); return r;
}
function noFallback(deps: CiDeps): void {
  if (!deps.env.CLOUDFLARE_API_TOKEN || ['CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL','CF_API_KEY','CF_EMAIL','CF_API_TOKEN'].some(k=>!!deps.env[k])) fail('Token platform eksplisit wajib; fallback credential ditolak.');
  verifyEnv(deps);
}
function verifyBindings(b: unknown, compatDate: unknown, t: ProductionTarget): void {
  if (compatDate !== '2026-10-07' || !Array.isArray(b)) fail('Settings Worker berbeda.');
  const bindings = b.map(object);
  const expected={PASSWORD_PBKDF2_ITERATIONS:'10',SESSION_TTL_SECONDS:'43200',RETENTION_POLICY:'UNSET'};
  if(bindings.length!==6||!bindings.some(x=>x.name==='DB'&&x.type==='d1'&&x.id===t.database)||!bindings.some(x=>x.name==='VEHICLE_CACHE'&&x.type==='kv_namespace'&&x.namespace_id===t.namespace)||!bindings.some(x=>x.name==='ASSETS'&&x.type==='assets'))fail('CI tidak diizinkan mengubah resources/secrets/bindings.');
  for(const[name,value]of Object.entries(expected))if(!bindings.some(x=>x.name===name&&x.type==='plain_text'&&x.text===value))fail('Variables runtime berbeda; review terpisah diperlukan.');
}
type Active = {id:string;version:string};
async function platform(deps: CiDeps,t:ProductionTarget,phase:PlatformPhase):Promise<Active> {
  await verifyResources(t,deps.runWrangler);
  const data=json(await deps.runWrangler(['deployments','list','--name',t.worker,'--json']));
  if(!Array.isArray(data)||!data.length) fail('Worker existing wajib tersedia.');
  const rows=data.map(value=>{const row=object(value);return{row,time:deploymentTimestamp(row.created_on)};}).sort((a,b)=>a.time===b.time?0:a.time>b.time?-1:1);
  const active=rows[0].row;
  if(!validId(active.id,true)||!Array.isArray(active.versions)||active.versions.length!==1)fail('Deployment existing tidak valid.');
  const v=object(active.versions[0]);if(!validId(v.version_id,true)||v.percentage!==100)fail('Versi active harus tunggal100%.');
  const flags=new Map([['confirm-deployment',active.id],['confirm-version',v.version_id],['confirm-hostname-review',t.origin]]);
  await verifyWorker(t,flags,deps.runWrangler);
  const read=async(path:string)=>{const payload=await deps.readPlatform(t,path,phase);if(payload.success!==true)fail('Metadata platform tidak terverifikasi.');return payload;};
  const domains=await read(`/accounts/${t.account}/workers/domains`);
  if(!Array.isArray(domains.result))fail('Custom-domain inventory tidak valid.');
  const attachments=domains.result.map(object).filter(d=>d.hostname===t.hostname);
  if(attachments.length!==1||attachments[0].service!==t.worker||attachments[0].zone_id!==t.zone)fail('Custom domain existing wajib tepat, tidak dibuat oleh CI.');
  const dns=await read(`/zones/${t.zone}/dns_records?name.exact=${encodeURIComponent(t.hostname)}&page=1&per_page=100`);
  if(!Array.isArray(dns.result)||dns.result.length!==1)fail('DNS existing wajib terverifikasi.');
  const record=object(dns.result[0]);if(!validId(record.id)||record.name!==t.hostname||!['A','AAAA'].includes(String(record.type))||record.proxied!==true)fail('Record existing tidak aman.');
  flags.set('confirm-dns-record',record.id);
  const fetchMetadata: typeof fetch=async(input,init)=>{if(init?.method&&init.method!=='GET')fail('Hanya metadata GET.');const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin!=='https://api.cloudflare.com'||!url.pathname.startsWith('/client/v4/'))fail('Endpoint metadata ditolak.');const body=await read(url.pathname.slice('/client/v4'.length)+url.search);return new Response(JSON.stringify(body),{status:200});};
  await verifyDomain(t,deps.env.CLOUDFLARE_API_TOKEN,fetchMetadata,flags);
  const settings=object((await read(`/accounts/${t.account}/workers/scripts/${t.worker}/settings`)).result);
  verifyBindings(settings.bindings, settings.compatibility_date, t);
  return{id:active.id,version:v.version_id};
}
export async function ciDeploy(deps: CiDeps): Promise<string> {
  const sha=context(deps);noFallback(deps);const t=target(deps);readReceipt(deps,sha);
  const before=await platform(deps,t,'preflight');
  verifyEnv(deps);
  const output=await deps.runWrangler(['versions','upload','--name',t.worker,'--strict','--tag',`git-${sha}`,'--message',`git:${sha}`]);
  if(output.status!==0)fail('Upload gagal/ambigu; tidak ada retry atau aktivasi otomatis.');
  const matches=[...output.stdout.matchAll(/^(?:Worker )?Version ID:\s*([0-9a-f-]{36})\s*$/gm)];
  if(matches.length!==1||!validId(matches[0][1],true))fail('Version ID upload tidak terverifikasi; aktivasi dibatalkan.');
  const id=matches[0][1];const version=object(json(await deps.runWrangler(['versions','view',id,'--name',t.worker,'--json'])));
  const annotations=object(version.annotations);
  if(version.id!==id||annotations['workers/message']!==`git:${sha}`||annotations['workers/tag']!==`git-${sha}`)fail('Versi upload tidak cocok dengan commit build.');
  const resources = object(version.resources);
  const runtime = object(resources.script_runtime);
  verifyBindings(resources.bindings, runtime.compatibility_date, t);
  if(context(deps)!==sha)fail('Commit sudah stale setelah upload; tidak diaktifkan.');readReceipt(deps,sha);
  const after=await platform(deps,t,'post_upload');if(before.id!==after.id||before.version!==after.version)fail('Deployment berubah bersamaan; versi baru tidak diaktifkan.');
  verifyEnv(deps);
  const activated=await deps.runWrangler(['versions','deploy',`${id}@100%`,'--name',t.worker,'--yes','--message',`git:${sha}`]);
  if(activated.status!==0)fail('Aktivasi gagal/ambigu; lakukan diagnosis read-only, bukan retry/rollback otomatis.');
  deps.notice(`Aktivasi diminta untuk version=${id}; commit=${sha}. Verifikasi runtime tetap diperlukan.`);return id;
}
export async function ciDryrun(deps: CiDeps): Promise<void> {
  const t = target(deps);await deps.build();const r=await deps.runWrangler(['versions','upload','--name',t.worker,'--dry-run','--strict']);if(r.status!==0)fail('Dry-run version gagal.');deps.notice('Dry-run lokal PASS; bukan deployment.');
}
export async function readPlatformGet(
  target: ProductionTarget,
  path: string,
  token: string,
  phase: PlatformPhase,
  notice: (message: string) => void,
  fetcher: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  if (phase !== 'preflight' && phase !== 'post_upload') fail('Fase platform tidak dikenal.');
  if (target.account !== EXPECTED_ACCOUNT || target.worker !== EXPECTED_WORKER || !validId(target.zone) || target.zone.length !== 32 || target.hostname !== EXPECTED_HOSTNAME) fail('Target tidak valid.');
  const expectedPaths = [
    `/accounts/${target.account}/workers/domains`,
    `/zones/${target.zone}/dns_records?name.exact=${encodeURIComponent(target.hostname)}&page=1&per_page=100`,
    `/zones/${target.zone}`,
    `/zones/${target.zone}/workers/routes`,
    `/accounts/${target.account}/workers/scripts/${target.worker}/settings`
  ];
  if (!expectedPaths.includes(path)) fail('Path API tidak sesuai scope.');
  if (!token) fail('Token platform tidak tersedia.');

  const diagnosticPath = path.split('?')[0];
  const diagnostic = (category: PlatformFailureCategory, status: number | null, codes: number[], requestIDs: Record<string, string|null>) => {
    notice(JSON.stringify({ method: 'GET', path: diagnosticPath, status, codes, requestIDs, category, phase }));
  };

  const url = 'https://api.cloudflare.com/client/v4' + path;
  const timeoutSignal = AbortSignal.timeout(15000);
  // Bound fetch and every body read, even when an injected transport ignores abort.
  const withinDeadline = <T>(pending: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const cleanup = () => timeoutSignal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(timeoutSignal.reason); };
    if (timeoutSignal.aborted) abort();
    else timeoutSignal.addEventListener('abort', abort, { once: true });
    void pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
  const networkCategory = (error: unknown): 'timeout' | 'aborted' | 'network' => {
    const name = error instanceof Error ? error.name : undefined;
    return name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'aborted' : 'network';
  };

  let response: Response;
  try {
    response = await withinDeadline(fetcher(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: timeoutSignal
    }));
  } catch (err: unknown) {
    diagnostic(networkCategory(err), null, [], { 'cf-ray': null, 'request-id': null });
    fail('Platform GET gagal; output tidak ditampilkan.');
  }

  const header = (name: string, format: RegExp): string | null => {
    try { const value = response.headers.get(name); return typeof value === 'string' && value.length <= 36 && ![...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) && format.test(value) ? value : null; }
    catch { return null; }
  };
  const requestFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const requestIDs = {
    'cf-ray': header('cf-ray', /^[0-9a-f]{16}(?:-[A-Z]{3})?$/i),
    'request-id': header('request-id', requestFormat) ?? header('x-request-id', requestFormat)
  };
  const emitError = (cat: PlatformFailureCategory, codes: number[] = []) => {
    diagnostic(cat, response.status, codes, requestIDs);
  };

  if (!response.body) {
    emitError(response.ok ? 'invalid_response' : 'http');
    fail('Platform GET gagal; output tidak ditampilkan.');
  }

  const reader = response.body.getReader();
  let received = 0;
  const limit = response.ok ? 1024 * 1024 : 64 * 1024;
  const buffer = new Uint8Array(limit);
  let bodyFailure: 'body_too_large' | 'timeout' | 'aborted' | 'network' | undefined;
  const cancel = () => { try { void reader.cancel().catch(() => {}); } catch { /* No raw cancellation errors. */ } };

  try {
    while (true) {
      const { done, value } = await withinDeadline(reader.read());
      if (done) break;
      if (value) {
        if (value.byteLength > limit - received) { bodyFailure = 'body_too_large'; break; }
        buffer.set(value, received);
        received += value.byteLength;
      }
    }
  } catch (err: unknown) {
    bodyFailure = networkCategory(err);
  } finally {
    if (bodyFailure) cancel();
    try { reader.releaseLock(); } catch { /* Pending transport reads must not replace the safe diagnostic. */ }
  }
  if (bodyFailure) {
    emitError(response.ok ? bodyFailure : 'http');
    fail(response.ok && bodyFailure === 'body_too_large' ? 'Metadata melebihi batas.' : 'Platform GET gagal; output tidak ditampilkan.');
  }

  const text = new TextDecoder().decode(buffer.subarray(0, received));
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    emitError(response.ok ? 'invalid_response' : 'http');
    fail('Platform GET gagal; output tidak ditampilkan.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    emitError(response.ok ? 'invalid_response' : 'http');
    fail('Platform GET gagal; output tidak ditampilkan.');
  }
  const payload = data as Record<string, unknown>;
  const codes: number[] = [];
  if (Array.isArray(payload.errors)) {
    for (const entry of payload.errors.slice(0, 20)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const code: unknown = entry.code;
        if (typeof code === 'number' && Number.isSafeInteger(code) && code > 0 && code <= 9999999 && !codes.includes(code) && codes.length < 5) codes.push(code);
      }
    }
  }
  if (!response.ok) {
    emitError('http', codes);
    fail('Platform GET gagal; output tidak ditampilkan.');
  }
  if (payload.success !== true) emitError('api_error', codes);
  return payload;
}

export function getDefaultDeps(): CiDeps {
  const environment: NodeJS.ProcessEnv = Object.freeze({ ...process.env });
  const run=(command:string,args:string[],env:NodeJS.ProcessEnv=environment):CommandResult=>{const r=spawnSync(command,args,{cwd:PROJECT_ROOT,env,shell:false,encoding:'utf8',stdio:['ignore','pipe','pipe']});return{status:r.status,stdout:r.stdout??'',stderr:r.stderr??''};};
  const notice = (m: string) => process.stdout.write(`${m}\n`);
  return {env:environment,root:PROJECT_ROOT,nodeVersion:process.versions.node,wranglerVersion:JSON.parse(readFileSync(join(PROJECT_ROOT,'node_modules/wrangler/package.json'),'utf8')).version,load:loadProductionConfig,git:args=>run('git',args),build:()=>buildProductionAssets(spawnSync,environment),task:(name,env)=>{const args=name==='audit'?['audit','--audit-level=high','--include=dev']:['run',name==='test'?'test':'lint'];return process.platform==='win32'?run('cmd.exe',['/d','/s','/c',`npm ${args.join(' ')}`],env):run('npm',args,env);},runWrangler:args=>runWrangler(args,environment),notice,readPlatform:async(t,path,phase)=>{const token=environment.CLOUDFLARE_API_TOKEN;if(!token)fail('Token platform tidak tersedia.');return readPlatformGet(t,path,token,phase,notice,fetch);}};
}
const isMain=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){try{if(process.argv.length!==3)fail('Gunakan build, deploy, atau dryrun tanpa argument tambahan.');const deps=getDefaultDeps();const mode=process.argv[2];if(mode==='build')await ciBuild(deps);else if(mode==='deploy')await ciDeploy(deps);else if(mode==='dryrun')await ciDryrun(deps);else fail('Mode CI tidak dikenal.');}catch(error){process.stderr.write(`${error instanceof ProductionError?error.message:'CI gagal; detail sensitif tidak ditampilkan.'}\n`);process.exitCode=1;}}
