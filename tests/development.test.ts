import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import { DEVELOPMENT_CONFIG, DEVELOPMENT_PERSIST, assertDevelopmentState, buildDevelopmentSeedStatements, loadDevelopmentConfig, localWranglerArgs, resetDevelopment, runLocalWrangler, validateDevelopmentConfig } from '../scripts/development';
import { PROJECT_ROOT } from '../scripts/lib';
import { dueStatus } from '../shared/dates';
import { isLocalDevelopment } from '../worker/dev-index';
import { developmentDueDate, DevVehicleSource } from '../worker/vehicle/development';

describe('development source and boundaries', () => {
  it('derives canonical dates across leap/year/WITA boundaries without changing the calculator', async () => {
    const now = new Date('2028-02-28T16:00:00.000Z');
    expect(developmentDueDate(now, 1)).toBe('2028-03-01');
    expect(developmentDueDate(new Date('2026-12-31T15:59:59.999Z'), 1)).toBe('2027-01-01');
    const source = new DevVehicleSource(() => now);
    for (const [nopol, tax, stnk] of [['DH1823HJ','ACTIVE','ACTIVE'],['DH7112DP','EXPIRED','UNKNOWN'],['DH5871GD','EXPIRED','EXPIRED']]) {
      const result = await source.lookup(nopol);
      expect(result.outcome).toBe('FOUND');
      if (result.outcome !== 'FOUND') throw new Error('Expected synthetic vehicle');
      expect(dueStatus(result.vehicle.tax_due_date, now)).toBe(tax);
      expect(dueStatus(result.vehicle.stnk_due_date, now)).toBe(stnk);
      expect(result.vehicle.provider_fetched_at).toBe(now.toISOString());
      expect(result.vehicle.owner_name).toBe('Pemilik Sintetik UAT');
    }
    expect(await source.lookup('DH6162RK')).toEqual({outcome:'NOT_FOUND'});
    expect(await source.lookup('DH9999ZZ')).toEqual({outcome:'NOT_FOUND'});
    await expect(source.lookup('invalid!')).rejects.toThrow();
  });
  it('accepts only exact loopback URL plus development marker, not forwarding headers', () => {
    const env = { APP_ENV: 'development' } as Env & { APP_ENV: string };
    for (const hostname of ['localhost','127.0.0.1','[::1]']) for (const scheme of ['http','https']) expect(isLocalDevelopment(new Request(`${scheme}://${hostname}:8787/login`),env)).toBe(true);
    for (const host of ['app.workers.dev','localhost.evil.test','127.0.0.2','app.test']) expect(isLocalDevelopment(new Request(`https://${host}/login`,{headers:{Host:'localhost','X-Forwarded-Host':'localhost'}}),env)).toBe(false);
    expect(isLocalDevelopment(new Request('http://localhost/login'),{...env,APP_ENV:'production'})).toBe(false);
  });
  it('validates every fixed config field before CLI and isolates persistence', () => {
    loadDevelopmentConfig();
    const config = experimental_readRawConfig({config:DEVELOPMENT_CONFIG}).rawConfig;
    for (const patch of [{main:'worker/index.ts'},{account_id:'a'.repeat(32)},{routes:[]},{workers_dev:true},{vars:{APP_ENV:'development'}},{assets:{run_worker_first:['/api/*']}},{d1_databases:[]},{kv_namespaces:[]}]) expect(() => validateDevelopmentConfig({...config,...patch})).toThrow();
    expect(() => validateDevelopmentConfig(config,join(PROJECT_ROOT,'wrangler.jsonc'))).toThrow();
    expect(localWranglerArgs(['d1','execute','DB'])).toEqual(['d1','execute','DB','--local','--config',DEVELOPMENT_CONFIG,'--persist-to',DEVELOPMENT_PERSIST]);
  });
  it('rejects unconfirmed reset and arbitrary CLI flags without touching state', async () => {
    await expect(resetDevelopment(false)).rejects.toThrow('--confirm-reset');
    const result = spawnSync(process.execPath,[join(PROJECT_ROOT,'scripts/dev-seed.ts'),'--remote','Sensitive-Synthetic'],{cwd:PROJECT_ROOT,encoding:'utf8'});
    expect(result.status).toBe(1); expect(result.stderr).not.toContain('Sensitive-Synthetic');
  });
  it('allows physical isolated state and refuses ancestor/descendant junctions', async () => {
    const parent = join(PROJECT_ROOT,'.wrangler','test-paths'); await mkdir(parent,{recursive:true});
    const root = await mkdtemp(join(parent,'phase8-')); const outside = await mkdtemp(join(parent,'outside-'));
    try {
      await mkdir(join(root,'.wrangler','dev-uat'),{recursive:true});
      await writeFile(join(outside,'sentinel'),'untouched');
      expect(await assertDevelopmentState(root,true)).toBe(join(root,'.wrangler','dev-uat'));
      await symlink(outside,join(root,'.wrangler','dev-uat','linked'),process.platform === 'win32' ? 'junction' : 'dir');
      await expect(assertDevelopmentState(root,true)).rejects.toThrow();
      await rm(join(root,'.wrangler','dev-uat','linked'));
      await rm(join(root,'.wrangler','dev-uat'),{recursive:true});
      await symlink(outside,join(root,'.wrangler','dev-uat'),process.platform === 'win32' ? 'junction' : 'dir');
      await expect(assertDevelopmentState(root)).rejects.toThrow();
      expect(await readFile(join(outside,'sentinel'),'utf8')).toBe('untouched');
    } finally { await rm(root,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}); }
  });
  it.each(['success','failure','exception'])('isolates and removes sensitive Wrangler logs on %s', mode => {
    let directory = '';
    const execute = () => runLocalWrangler(['d1','execute','DB','--file','synthetic-seed.sql'], (command, args, options) => {
      expect(command).toBe(process.execPath);
      expect(args).toContain('--local'); expect(args).not.toContain('--remote');
      expect(options.stdio).toEqual(['ignore','pipe','pipe']); expect(options.shell).toBe(false);
      expect(options.env).toMatchObject({WRANGLER_LOG:'error',WRANGLER_LOG_LEVEL:'error',WRANGLER_LOG_SANITIZE:'true',WRANGLER_SEND_METRICS:'false'});
      const path = options.env!.WRANGLER_LOG_PATH!; directory = dirname(path);
      expect(existsSync(directory)).toBe(true);
      writeFileSync(path, 'Synthetic secret SQL/hash diagnostic', {mode:0o600});
      if (mode === 'exception') throw new Error('Synthetic secret SQL/hash diagnostic');
      return {status:mode === 'success' ? 0 : 1};
    });
    if (mode === 'success') expect(execute).not.toThrow();
    else expect(execute).toThrow('detail sensitif disembunyikan');
    expect(directory).toContain('razia-development-cli-'); expect(existsSync(directory)).toBe(false);
  });
  it('seed builder rejects malformed hashes before SQL', () => {
    expect(() => buildDevelopmentSeedStatements([])).toThrow();
    expect(() => buildDevelopmentSeedStatements(['invalid','invalid'])).toThrow();
  });
});
