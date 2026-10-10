import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ciBuild, ciDryrun, ciDeploy, getDefaultDeps, type CiDeps } from '../scripts/ci-production.ts';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  EXPECTED_ACCOUNT,
  EXPECTED_DATABASE,
  EXPECTED_HOSTNAME,
  EXPECTED_NAMESPACE,
  EXPECTED_WORKER,
  EXPECTED_ZONE_NAME,
  type ProductionTarget,
} from '../scripts/production-config.ts';
import { MIGRATION_DATABASE_ID } from '../scripts/production-migrations.ts';

describe('default CI environment snapshot', () => {
  it('keeps a frozen independent environment when the process changes after creation', () => {
    const key = 'WRANGLER_CI_OVERRIDE_NAME';
    const previous = process.env[key];
    try {
      process.env[key] = EXPECTED_WORKER;
      const defaults = getDefaultDeps();
      expect(defaults.env).not.toBe(process.env);
      expect(Object.isFrozen(defaults.env)).toBe(true);
      process.env[key] = 'other-worker';
      expect(defaults.env[key]).toBe(EXPECTED_WORKER);
      expect(() => { defaults.env[key] = 'other-worker'; }).toThrow(TypeError);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});

describe('ci-production', () => {
  let tempRoot: string;
  let deps: CiDeps;

  const COMMIT_SHA = '1234567890123456789012345678901234567890';
  const CF_TOKEN = 'synthetic-cloudflare-api-token-value';
  const CI_NAMESPACE = 'c8ca3a5faf9c4922a6f3f88aaa7ddbb7';
  const SYNTHETIC_ZONE_ID = 'b'.repeat(32);
  const DNS_RECORD_ID = 'c'.repeat(32);
  const DEPLOYMENT_ID = '55555555-5555-4555-8555-555555555555';
  const ACTIVE_VERSION_ID = '44444444-4444-4444-8444-444444444444';
  const NEW_VERSION_ID = '77777777-7777-4777-8777-777777777777';

  const target: ProductionTarget = {
    account: EXPECTED_ACCOUNT,
    worker: EXPECTED_WORKER,
    database: MIGRATION_DATABASE_ID,
    namespace: CI_NAMESPACE,
    hostname: EXPECTED_HOSTNAME,
    origin: `https://${EXPECTED_HOSTNAME}`,
    zone: SYNTHETIC_ZONE_ID,
    passwordIterations: 10,
  };

  function sha256(content: string) {
    return createHash('sha256').update(content).digest('hex');
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'razia-ci-test-'));
    mkdirSync(join(tempRoot, 'dist'));
    writeFileSync(join(tempRoot, 'wrangler.production.jsonc'), 'config-content');
    writeFileSync(join(tempRoot, 'package-lock.json'), 'lock-content');
    writeFileSync(join(tempRoot, 'dist', 'index.html'), 'html-content');

    const env: NodeJS.ProcessEnv = {
      CI: '1',
      WORKERS_CI: '1',
      WORKERS_CI_BRANCH: 'main',
      WORKERS_CI_COMMIT_SHA: COMMIT_SHA,
      CLOUDFLARE_API_TOKEN: CF_TOKEN,
      RETENTION_POLICY: 'UNSET',
      PASSWORD_PBKDF2_ITERATIONS: '100000',
      SESSION_TTL_SECONDS: '43200',
    };

    const git = vi.fn().mockImplementation((args: string[]) => {
      const cmd = args.join(' ');
      if (cmd === 'rev-parse HEAD') {
        return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
      }
      if (cmd === 'branch --show-current') {
        return { status: 0, stdout: 'main\n', stderr: '' };
      }
      if (cmd === 'remote get-url origin') {
        return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
      }
      if (cmd === 'ls-remote origin refs/heads/main') {
        return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
      }
      if (cmd === 'diff --exit-code' || cmd === 'diff --cached --exit-code') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'ls-files --error-unmatch wrangler.production.jsonc') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'ls-files --others --exclude-standard -z') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === "ls-files --others --ignored --exclude-standard -z -- . :!:node_modules/") {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'ls-files -z') {
        return { status: 0, stdout: 'wrangler.production.jsonc\0package-lock.json\0', stderr: '' };
      }
      throw new Error(`Unexpected git invocation: ${cmd}`);
    });

    const runWrangler = vi.fn().mockImplementation(async (args: string[]) => {
      const cmd = args.join(' ');
      if (cmd === `versions upload --name ${EXPECTED_WORKER} --dry-run --strict`) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'whoami --json') {
        return {
          status: 0,
          stdout: JSON.stringify({
            loggedIn: true,
            accounts: [{ id: EXPECTED_ACCOUNT, name: 'Synthetic' }],
          }),
          stderr: '',
        };
      }
      if (cmd === 'd1 list --json') {
        return {
          status: 0,
          stdout: JSON.stringify([
            { uuid: MIGRATION_DATABASE_ID, name: EXPECTED_DATABASE },
          ]),
          stderr: '',
        };
      }
      if (cmd === 'kv namespace list') {
        return {
          status: 0,
          stdout: JSON.stringify([
            { id: CI_NAMESPACE, title: EXPECTED_NAMESPACE },
          ]),
          stderr: '',
        };
      }
      if (cmd === `deployments list --name ${EXPECTED_WORKER} --json`) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              id: DEPLOYMENT_ID,
              created_on: '2026-10-09T00:00:00.000000Z',
              versions: [{ version_id: ACTIVE_VERSION_ID, percentage: 100 }],
            },
          ]),
          stderr: '',
        };
      }
      if (cmd === `versions upload --name ${EXPECTED_WORKER} --strict --tag git-${COMMIT_SHA} --message git:${COMMIT_SHA}`) {
        return {
          status: 0,
          stdout: `Worker Version ID: ${NEW_VERSION_ID}\n`,
          stderr: '',
        };
      }
      if (cmd === `versions view ${NEW_VERSION_ID} --name ${EXPECTED_WORKER} --json`) {
        return {
          status: 0,
          stdout: JSON.stringify({
            id: NEW_VERSION_ID,
            annotations: {
              'workers/message': `git:${COMMIT_SHA}`,
              'workers/tag': `git-${COMMIT_SHA}`,
            },
            resources: {
              script_runtime: { compatibility_date: '2026-10-07' },
              bindings: [
                { name: 'DB', type: 'd1', id: target.database },
                { name: 'VEHICLE_CACHE', type: 'kv_namespace', namespace_id: target.namespace },
                { name: 'ASSETS', type: 'assets' },
                { name: 'PASSWORD_PBKDF2_ITERATIONS', type: 'plain_text', text: '10' },
                { name: 'SESSION_TTL_SECONDS', type: 'plain_text', text: '43200' },
                { name: 'RETENTION_POLICY', type: 'plain_text', text: 'UNSET' },
              ]
            }
          }),
          stderr: '',
        };
      }
      if (cmd === `versions deploy ${NEW_VERSION_ID}@100% --name ${EXPECTED_WORKER} --yes --message git:${COMMIT_SHA}`) {
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected runWrangler invocation: ${cmd}`);
    });

    const readPlatform = vi.fn().mockImplementation(async (target: ProductionTarget, path: string) => {
      if (path === `/accounts/${target.account}/workers/domains`) {
        return {
          success: true,
          result: [
            {
              id: 'd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1',
              hostname: target.hostname,
              service: target.worker,
              zone_id: target.zone,
            },
          ],
          result_info: {
            page: 1,
            per_page: 100,
            count: 1,
            total_count: 1,
            total_pages: 1,
          },
        };
      }
      if (path === `/zones/${target.zone}/dns_records?name.exact=${encodeURIComponent(target.hostname)}&page=1&per_page=100`) {
        return {
          success: true,
          result: [
            {
              id: DNS_RECORD_ID,
              name: target.hostname,
              type: 'A',
              proxied: true,
            },
          ],
          result_info: {
            page: 1,
            per_page: 100,
            count: 1,
            total_count: 1,
            total_pages: 1,
          },
        };
      }
      if (path === `/zones/${target.zone}`) {
        return {
          success: true,
          result: {
            id: target.zone,
            status: 'active',
            name: EXPECTED_ZONE_NAME,
            account: {
              id: target.account,
            },
          },
        };
      }
      if (path === `/zones/${target.zone}/workers/routes`) {
        return {
          success: true,
          result: [],
          result_info: {
            page: 1,
            per_page: 100,
            count: 0,
            total_count: 0,
            total_pages: 1,
          },
        };
      }
      if (path === `/accounts/${target.account}/workers/scripts/${target.worker}/settings`) {
        return {
          success: true,
          result: {
            compatibility_date: '2026-10-07',
            bindings: [
              { name: 'DB', type: 'd1', id: target.database },
              { name: 'VEHICLE_CACHE', type: 'kv_namespace', namespace_id: target.namespace },
              { name: 'ASSETS', type: 'assets' },
              { name: 'PASSWORD_PBKDF2_ITERATIONS', type: 'plain_text', text: '10' },
              { name: 'SESSION_TTL_SECONDS', type: 'plain_text', text: '43200' },
              { name: 'RETENTION_POLICY', type: 'plain_text', text: 'UNSET' },
            ],
          },
        };
      }
      throw new Error(`Unexpected readPlatform invocation: ${path}`);
    });

    const task = vi.fn().mockImplementation((name: string) => {
      if (name === 'lint' || name === 'test' || name === 'audit') {
        return { status: 0 };
      }
      throw new Error(`Unexpected task invocation: ${name}`);
    });

    deps = {
      env,
      root: tempRoot,
      nodeVersion: '24.21.0',
      wranglerVersion: '4.148.0',
      git,
      load: vi.fn().mockReturnValue(target),
      build: vi.fn().mockResolvedValue(undefined),
      task,
      runWrangler,
      readPlatform,
      notice: vi.fn(),
    };
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('ciBuild executes successfully and creates receipt', async () => {
    const receipt = await ciBuild(deps);

    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.sha).toBe(COMMIT_SHA);
    expect(receipt.config).toBe(sha256('config-content'));
    expect(receipt.lock).toBe(sha256('lock-content'));
    expect(receipt.sources).toEqual({
      'wrangler.production.jsonc': sha256('config-content'),
      'package-lock.json': sha256('lock-content'),
    });
    expect(receipt.assets).toEqual({
      'dist/index.html': sha256('html-content'),
    });

    const receiptDiskPath = join(tempRoot, '.wrangler', 'ci-gate.json');
    expect(existsSync(receiptDiskPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(receiptDiskPath, 'utf8'));
    expect(persisted).toEqual(receipt);
    expect(deps.notice).toHaveBeenCalledWith(expect.stringContaining(`CI build PASS commit=${COMMIT_SHA}`));
  });

  it('ciDeploy executes successfully', async () => {
    const configHash = sha256('config-content');
    const lockHash = sha256('lock-content');
    const htmlHash = sha256('html-content');

    mkdirSync(join(tempRoot, '.wrangler'), { recursive: true });
    writeFileSync(join(tempRoot, '.wrangler', 'ci-gate.json'), JSON.stringify({
      schemaVersion: 1,
      sha: COMMIT_SHA,
      config: configHash,
      lock: lockHash,
      sources: {
        'wrangler.production.jsonc': configHash,
        'package-lock.json': lockHash,
      },
      assets: {
        'dist/index.html': htmlHash,
      },
    }));

    const activatedVersionId = await ciDeploy(deps);
    expect(activatedVersionId).toBe(NEW_VERSION_ID);
    expect(deps.notice).toHaveBeenCalledWith(expect.stringContaining(`Aktivasi diminta untuk version=${NEW_VERSION_ID}`));
  });

  it('ciDryrun executes successfully', async () => {
    await expect(ciDryrun(deps)).resolves.not.toThrow();
    expect(deps.notice).toHaveBeenCalledWith('Dry-run lokal PASS; bukan deployment.');
  });

  describe('Guard tests', () => {
    it('fails if there are untracked files', async () => {
      deps.git = vi.fn().mockImplementation((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd.includes('ls-files --others --exclude-standard -z')) {
          return { status: 0, stdout: 'untracked-file.txt\0', stderr: '' };
        }
        if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
        if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
        if (cmd === 'diff --exit-code' || cmd === 'diff --cached --exit-code' || cmd === 'ls-files --error-unmatch wrangler.production.jsonc') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });
      await expect(ciBuild(deps)).rejects.toThrow('File untracked tidak diizinkan; pastikan workspace bersih.');
      expect(deps.build).not.toHaveBeenCalled();
    });

    it('fails if there are risky ignored files like .env', async () => {
      deps.git = vi.fn().mockImplementation((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd.includes("ls-files --others --ignored --exclude-standard -z -- . :!:node_modules/")) {
          return { status: 0, stdout: '.env\0', stderr: '' };
        }
        if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
        if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
        if (cmd === 'diff --exit-code' || cmd === 'diff --cached --exit-code' || cmd === 'ls-files --error-unmatch wrangler.production.jsonc' || cmd === 'ls-files --others --exclude-standard -z') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });
      await expect(ciBuild(deps)).rejects.toThrow('File konfigurasi secret dilarang.');
      expect(deps.build).not.toHaveBeenCalled();
    });

    it('fails if workspace is modified (git diff exit code 1)', async () => {
      deps.git = vi.fn().mockImplementation((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd === 'diff --exit-code') return { status: 1, stdout: '', stderr: '' };
        if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
        if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });
      await expect(ciBuild(deps)).rejects.toThrow('Git context tidak dapat diverifikasi; output tidak ditampilkan.');
    });

    it('fails if workspace has staged files (git diff --cached exit code 1)', async () => {
      deps.git = vi.fn().mockImplementation((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd === 'diff --cached --exit-code') return { status: 1, stdout: '', stderr: '' };
        if (cmd === 'diff --exit-code') return { status: 0, stdout: '', stderr: '' };
        if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
        if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });
      await expect(ciBuild(deps)).rejects.toThrow('Git context tidak dapat diverifikasi; output tidak ditampilkan.');
    });

    it('fails on embedded empty record or duplicates', async () => {
      deps.git = vi.fn().mockImplementation((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd === 'ls-files -z') {
          return { status: 0, stdout: 'wrangler.production.jsonc\0\0package-lock.json\0', stderr: '' };
        }
        if (cmd.includes('ls-files')) return { status: 0, stdout: '', stderr: '' };
        if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
        if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
        if (cmd === 'diff --exit-code' || cmd === 'diff --cached --exit-code') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });
      await expect(ciBuild(deps)).rejects.toThrow('Record Git kosong dilarang.');
    });

    it('fails on nested generic credentials in allowed directories', async () => {
      deps.git = vi.fn().mockImplementation((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd.includes("ls-files --others --ignored --exclude-standard -z -- . :!:node_modules/")) {
          return { status: 0, stdout: 'dist/secrets.json\0', stderr: '' };
        }
        if (cmd.includes('ls-files')) return { status: 0, stdout: '', stderr: '' };
        if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
        if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
        if (cmd === 'diff --exit-code' || cmd === 'diff --cached --exit-code') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });
      await expect(ciBuild(deps)).rejects.toThrow('File kredensial generik dilarang.');
    });

    it('fails on unsafe Windows absolute paths', async () => {
      deps.git = vi.fn().mockImplementation((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd.includes('ls-files -z')) {
          return { status: 0, stdout: 'wrangler.production.jsonc\0package-lock.json\0C:\\secret.txt\0', stderr: '' };
        }
        if (cmd.includes('ls-files')) return { status: 0, stdout: '', stderr: '' };
        if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
        if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
        if (cmd === 'diff --exit-code' || cmd === 'diff --cached --exit-code') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });
      await expect(ciBuild(deps)).rejects.toThrow('Karakter path tidak aman.');
    });

    it('fails on unknown ignored files', async () => {
      deps.git = vi.fn().mockImplementation((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd.includes("ls-files --others --ignored --exclude-standard -z -- . :!:node_modules/")) {
          return { status: 0, stdout: 'unknown-cache/file.txt\0', stderr: '' };
        }
        if (cmd.includes('ls-files')) return { status: 0, stdout: '', stderr: '' };
        if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
        if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
        if (cmd === 'diff --exit-code' || cmd === 'diff --cached --exit-code') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });
      await expect(ciBuild(deps)).rejects.toThrow('File ignored tidak diizinkan.');
    });

    it('fails if malformed git nul output', async () => {
      deps.git = vi.fn().mockImplementation((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd.includes('ls-files -z')) {
          return { status: 0, stdout: 'wrangler.production.jsonc\0package-lock.json', stderr: '' }; // missing trailing \0
        }
        if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
        if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
        if (cmd === 'diff --exit-code' || cmd === 'diff --cached --exit-code' || cmd === 'ls-files --error-unmatch wrangler.production.jsonc' || cmd === 'ls-files --others --exclude-standard -z' || cmd === "ls-files --others --ignored --exclude-standard -z -- . :!:node_modules/") return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });
      await expect(ciBuild(deps)).rejects.toThrow('Format Git NUL tidak valid.');
    });

    it('fails if symlink node_modules', async () => {
      const realPath = join(tempRoot, 'real_node_modules');
      mkdirSync(realPath);
      symlinkSync(realPath, join(tempRoot, 'node_modules'), 'dir');

      await expect(ciBuild(deps)).rejects.toThrow('Direktori root node_modules tidak boleh symlink atau file regular.');
    });

    it('fails if symlink .wrangler without destroying external receipt', async () => {
      const realPath = join(tempRoot, 'real_wrangler');
      mkdirSync(realPath);
      writeFileSync(join(realPath, 'ci-gate.json'), 'sentinel');
      symlinkSync(realPath, join(tempRoot, '.wrangler'), 'dir');

      await expect(ciBuild(deps)).rejects.toThrow('Direktori root .wrangler tidak boleh symlink atau file regular.');
      expect(readFileSync(join(realPath, 'ci-gate.json'), 'utf8')).toBe('sentinel');
    });

    it('rejects post-build introduced unsafe file', async () => {
      // Mock that build introduces an untracked file
      deps.build = vi.fn().mockImplementation(async () => {
        deps.git = vi.fn().mockImplementation((args: string[]) => {
          const cmd = args.join(' ');
          if (cmd.includes('ls-files --others --exclude-standard -z')) {
            return { status: 0, stdout: 'bad-file.txt\0', stderr: '' };
          }
          if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
          if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
          if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
          if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
          if (cmd === 'diff --exit-code' || cmd === 'diff --cached --exit-code' || cmd === 'ls-files --error-unmatch wrangler.production.jsonc') return { status: 0, stdout: '', stderr: '' };
          if (cmd === 'ls-files -z') return { status: 0, stdout: 'wrangler.production.jsonc\0package-lock.json\0', stderr: '' };
          if (cmd === "ls-files --others --ignored --exclude-standard -z -- . :!:node_modules/") return { status: 0, stdout: '', stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        });
      });

      await expect(ciBuild(deps)).rejects.toThrow('File untracked tidak diizinkan; pastikan workspace bersih.');
      const receiptDiskPath = join(tempRoot, '.wrangler', 'ci-gate.json');
      expect(existsSync(receiptDiskPath)).toBe(false);
    });

    it('rejects dangerous tracked credential filenames', async () => {
      deps.git = vi.fn().mockImplementation((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd === 'ls-files -z') {
          return { status: 0, stdout: 'wrangler.production.jsonc\0package-lock.json\0secret.pem\0', stderr: '' };
        }
        if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
        if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
        if (cmd === 'diff --exit-code' || cmd === 'diff --cached --exit-code' || cmd === 'ls-files --error-unmatch wrangler.production.jsonc' || cmd === 'ls-files --others --exclude-standard -z' || cmd === "ls-files --others --ignored --exclude-standard -z -- . :!:node_modules/") return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });
      writeFileSync(join(tempRoot, 'secret.pem'), 'key');
      await expect(ciBuild(deps)).rejects.toThrow('Ekstensi kunci dilarang.');
    });
  });

  describe('Environment WRANGLER_CI_OVERRIDE_NAME and API_ENVIRONMENT', () => {
    beforeEach(() => {
      const configHash = sha256('config-content');
      const lockHash = sha256('lock-content');
      const htmlHash = sha256('html-content');

      mkdirSync(join(tempRoot, '.wrangler'), { recursive: true });
      writeFileSync(join(tempRoot, '.wrangler', 'ci-gate.json'), JSON.stringify({
        schemaVersion: 1,
        sha: COMMIT_SHA,
        config: configHash,
        lock: lockHash,
        sources: {
          'wrangler.production.jsonc': configHash,
          'package-lock.json': lockHash,
        },
        assets: {
          'dist/index.html': htmlHash,
        },
      }));
    });

    it('allows when absent, uploads and activates with --name', async () => {
      await expect(ciDeploy(deps)).resolves.toBe(NEW_VERSION_ID);
      expect(deps.runWrangler).toHaveBeenCalledWith(['versions','upload','--name',EXPECTED_WORKER,'--strict','--tag',`git-${COMMIT_SHA}`,'--message',`git:${COMMIT_SHA}`]);
      expect(deps.runWrangler).toHaveBeenCalledWith(['versions','view',NEW_VERSION_ID,'--name',EXPECTED_WORKER,'--json']);
      expect(deps.runWrangler).toHaveBeenCalledWith(['versions','deploy',`${NEW_VERSION_ID}@100%`,'--name',EXPECTED_WORKER,'--yes','--message',`git:${COMMIT_SHA}`]);
    });

    it('allows exact razia-samsat', async () => {
      deps.env.WRANGLER_CI_OVERRIDE_NAME = EXPECTED_WORKER;
      await expect(ciDeploy(deps)).resolves.toBe(NEW_VERSION_ID);
    });

    it.each(['', ' ', '\t', '\n', 'another-worker', 'razia-samsat-production', ' razia-samsat', 'razia-samsat ', 'RAZIA-SAMSAT'])(
      'fails on invalid override name %s before any CLI',
      async (overrideName) => {
        deps.env.WRANGLER_CI_OVERRIDE_NAME = overrideName;
        await expect(ciDeploy(deps)).rejects.toThrow('Override nama Worker ditolak.');
        expect(deps.runWrangler).not.toHaveBeenCalled();
        expect(deps.readPlatform).not.toHaveBeenCalled();
        expect(deps.build).not.toHaveBeenCalled();
        expect(deps.task).not.toHaveBeenCalled();
      }
    );

    it.each(['', ' ', 'public', 'staging', 'bogus'])(
      'fails on invalid environment %s before any CLI',
      async (envName) => {
        deps.env.WRANGLER_API_ENVIRONMENT = envName;
        await expect(ciDeploy(deps)).rejects.toThrow('Override endpoint platform ditolak.');
        expect(deps.runWrangler).not.toHaveBeenCalled();
        expect(deps.readPlatform).not.toHaveBeenCalled();
      }
    );

    it('allows WRANGLER_API_ENVIRONMENT production', async () => {
      deps.env.WRANGLER_API_ENVIRONMENT = 'production';
      await expect(ciDeploy(deps)).resolves.toBe(NEW_VERSION_ID);
    });

    it('fails if target load returns wrong worker before CLI', async () => {
      deps.load = vi.fn().mockReturnValue({
        account: EXPECTED_ACCOUNT,
        worker: 'wrong-worker',
        database: MIGRATION_DATABASE_ID,
        namespace: CI_NAMESPACE,
        hostname: EXPECTED_HOSTNAME,
        origin: `https://${EXPECTED_HOSTNAME}`,
        zone: SYNTHETIC_ZONE_ID,
        passwordIterations: 10,
      });
      await expect(ciDeploy(deps)).rejects.toThrow('Target CI tidak sesuai resource produksi FINAL.');
      expect(deps.runWrangler).not.toHaveBeenCalled();
    });

    it('stops upload if env mutated during readPlatform (preflight)', async () => {
      const origImpl = (deps.readPlatform as any).getMockImplementation();
      deps.readPlatform = vi.fn().mockImplementation(async (t, path) => {
        if (path.includes('domains')) {
          deps.env.WRANGLER_CI_OVERRIDE_NAME = 'mutated';
        }
        return origImpl(t, path);
      });
      await expect(ciDeploy(deps)).rejects.toThrow('Override nama Worker ditolak.');
      expect(deps.runWrangler).not.toHaveBeenCalledWith(expect.arrayContaining(['upload']));
    });

    it('stops activation if env mutated during postupload check', async () => {
      const origImpl = (deps.readPlatform as any).getMockImplementation();
      let uploaded = false;
      const origWrangler = deps.runWrangler;
      deps.runWrangler = vi.fn().mockImplementation(async (args: string[]) => {
        if (args.includes('upload')) uploaded = true;
        return origWrangler(args);
      });
      deps.readPlatform = vi.fn().mockImplementation(async (t, path) => {
        if (uploaded && path.includes('domains')) {
          deps.env.WRANGLER_CI_OVERRIDE_NAME = 'mutated2';
        }
        return origImpl(t, path);
      });
      await expect(ciDeploy(deps)).rejects.toThrow('Override nama Worker ditolak.');
      expect(deps.runWrangler).toHaveBeenCalledWith(expect.arrayContaining(['upload']));
      expect(deps.runWrangler).not.toHaveBeenCalledWith(expect.arrayContaining(['deploy']));
    });

    const mutationKeys = [
      'CLOUDFLARE_API_BASE_URL',
      'CF_API_BASE_URL',
      'CLOUDFLARE_COMPLIANCE_REGION',
      'WRANGLER_API_ENVIRONMENT',
      'CLOUDFLARE_ENV'
    ];

    for (const key of mutationKeys) {
      it(`stops upload if ${key} mutated during preflight`, async () => {
        const origImpl = (deps.readPlatform as any).getMockImplementation();
        deps.readPlatform = vi.fn().mockImplementation(async (t, path) => {
          if (path.includes('domains')) {
            deps.env[key] = 'invalid-mutation';
          }
          return origImpl(t, path);
        });
        await expect(ciDeploy(deps)).rejects.toThrow('Override endpoint platform ditolak.');
        expect(deps.runWrangler).not.toHaveBeenCalledWith(expect.arrayContaining(['upload']));
      });

      it(`stops activation if ${key} mutated during postupload check`, async () => {
        const origImpl = (deps.readPlatform as any).getMockImplementation();
        let uploaded = false;
        const origWrangler = deps.runWrangler;
        deps.runWrangler = vi.fn().mockImplementation(async (args: string[]) => {
          if (args.includes('upload')) uploaded = true;
          return origWrangler(args);
        });
        deps.readPlatform = vi.fn().mockImplementation(async (t, path) => {
          if (uploaded && path.includes('domains')) {
            deps.env[key] = 'invalid-mutation';
          }
          return origImpl(t, path);
        });
        await expect(ciDeploy(deps)).rejects.toThrow('Override endpoint platform ditolak.');
        expect(deps.runWrangler).toHaveBeenCalledWith(expect.arrayContaining(['upload']));
        expect(deps.runWrangler).not.toHaveBeenCalledWith(expect.arrayContaining(['deploy']));
      });
    }
  });

  describe('Path policy crossOS cases', () => {
    it('fails on Windows reserved device name in paths', async () => {
      deps.git = vi.fn().mockImplementation((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd === 'ls-files -z') {
          return { status: 0, stdout: 'wrangler.production.jsonc\0package-lock.json\0aux.js\0', stderr: '' };
        }
        if (cmd.includes('ls-files')) return { status: 0, stdout: '', stderr: '' };
        if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
        if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
        if (cmd === 'diff --exit-code' || cmd === 'diff --cached --exit-code') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });
      await expect(ciBuild(deps)).rejects.toThrow('Nama device Windows tidak aman.');
    });

    it('fails on trailing dot in path', async () => {
      deps.git = vi.fn().mockImplementation((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd === 'ls-files -z') {
          return { status: 0, stdout: 'wrangler.production.jsonc\0package-lock.json\0dir./file.ts\0', stderr: '' };
        }
        if (cmd.includes('ls-files')) return { status: 0, stdout: '', stderr: '' };
        if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
        if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
        if (cmd === 'diff --exit-code' || cmd === 'diff --cached --exit-code') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });
      await expect(ciBuild(deps)).rejects.toThrow('Path komponen tidak valid.');
    });

    it('fails on duplicate case-insensitive source files', async () => {
      writeFileSync(join(tempRoot, 'file.ts'), '1');
      deps.git = vi.fn().mockImplementation((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd === 'ls-files -z') {
          return { status: 0, stdout: 'wrangler.production.jsonc\0package-lock.json\0file.ts\0FILE.ts\0', stderr: '' };
        }
        if (cmd.includes('ls-files')) return { status: 0, stdout: '', stderr: '' };
        if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
        if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
        if (cmd === 'diff --exit-code' || cmd === 'diff --cached --exit-code') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });
      await expect(ciBuild(deps)).rejects.toThrow('Manifest sumber tidak aman atau duplikat.');
    });

    it('fails on alternate cased root', async () => {
      deps.git = vi.fn().mockImplementation((args: string[]) => {
        const cmd = args.join(' ');
        if (cmd === 'ls-files -z') {
          return { status: 0, stdout: 'wrangler.production.jsonc\0package-lock.json\0Node_modules/bad.js\0', stderr: '' };
        }
        if (cmd.includes('ls-files')) return { status: 0, stdout: '', stderr: '' };
        if (cmd === 'rev-parse HEAD') return { status: 0, stdout: `${COMMIT_SHA}\n`, stderr: '' };
        if (cmd === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
        if (cmd === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/ElwinMusadi/razia-samsat.git\n', stderr: '' };
        if (cmd === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${COMMIT_SHA}\trefs/heads/main\n`, stderr: '' };
        if (cmd === 'diff --exit-code' || cmd === 'diff --cached --exit-code') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      });
      await expect(ciBuild(deps)).rejects.toThrow('Casing direktori root tidak valid.');
    });
  });

  describe('Environment override tests', () => {
    const canonical = 'https://api.cloudflare.com/client/v4';
    const invalidEndpoints = [
      '', ' ', '\t', '\n',
      `${canonical}/`, `${canonical}?x=1`, `${canonical}#x`,
      'https://user:pass@api.cloudflare.com/client/v4',
      'http://api.cloudflare.com/client/v4',
      'https://example.com/client/v4',
      'https://api.cloudflare.com.evil.test/client/v4',
      'https://api.staging.cloudflare.com/client/v4',
      'HTTPS://API.CLOUDFLARE.COM/CLIENT/V4',
      'https://api.cloudflare.com/CLIENT/V4',
      ` ${canonical}`, `${canonical} `
    ];

    for (const key of ['CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL']) {
      it.each(invalidEndpoints)(
        `fails if ${key} is invalid %s before any CLI in deploy and build`,
        async (val) => {
          deps.env[key] = val;
          await expect(ciBuild(deps)).rejects.toThrow('Override endpoint platform ditolak.');
          expect(deps.build).not.toHaveBeenCalled();
          await expect(ciDeploy(deps)).rejects.toThrow('Override endpoint platform ditolak.');
          expect(deps.runWrangler).not.toHaveBeenCalled();
          expect(deps.readPlatform).not.toHaveBeenCalled();
          delete deps.env[key];
        }
      );
    }

    it('rejects modern invalid with legacy valid and vice versa', async () => {
      deps.env.CLOUDFLARE_API_BASE_URL = 'invalid';
      deps.env.CF_API_BASE_URL = canonical;
      await expect(ciBuild(deps)).rejects.toThrow('Override endpoint platform ditolak.');
      await expect(ciDeploy(deps)).rejects.toThrow('Override endpoint platform ditolak.');
      expect(deps.build).not.toHaveBeenCalled();
      expect(deps.runWrangler).not.toHaveBeenCalled();
      expect(deps.readPlatform).not.toHaveBeenCalled();
      delete deps.env.CLOUDFLARE_API_BASE_URL;
      delete deps.env.CF_API_BASE_URL;

      deps.env.CLOUDFLARE_API_BASE_URL = canonical;
      deps.env.CF_API_BASE_URL = 'invalid';
      await expect(ciBuild(deps)).rejects.toThrow('Override endpoint platform ditolak.');
      await expect(ciDeploy(deps)).rejects.toThrow('Override endpoint platform ditolak.');
      expect(deps.build).not.toHaveBeenCalled();
      expect(deps.runWrangler).not.toHaveBeenCalled();
      expect(deps.readPlatform).not.toHaveBeenCalled();
      delete deps.env.CLOUDFLARE_API_BASE_URL;
      delete deps.env.CF_API_BASE_URL;
    });

    const invalidRegions = ['', ' ', '\t', '\n', 'fedramp_high', ' public', 'public ', 'PUBLIC'];
    it.each(invalidRegions)(
      'fails on invalid region %s',
      async (val) => {
        deps.env.CLOUDFLARE_COMPLIANCE_REGION = val;
        await expect(ciBuild(deps)).rejects.toThrow('Override endpoint platform ditolak.');
        expect(deps.build).not.toHaveBeenCalled();
        await expect(ciDeploy(deps)).rejects.toThrow('Override endpoint platform ditolak.');
        expect(deps.runWrangler).not.toHaveBeenCalled();
        delete deps.env.CLOUDFLARE_COMPLIANCE_REGION;
      }
    );

    it.each(['', ' ', 'staging', 'public', 'production ', ' PRODUCTION'])(
      'fails on invalid WRANGLER_API_ENVIRONMENT %s',
      async (val) => {
        deps.env.WRANGLER_API_ENVIRONMENT = val;
        await expect(ciBuild(deps)).rejects.toThrow('Override endpoint platform ditolak.');
        expect(deps.build).not.toHaveBeenCalled();
        await expect(ciDeploy(deps)).rejects.toThrow('Override endpoint platform ditolak.');
        expect(deps.runWrangler).not.toHaveBeenCalled();
        delete deps.env.WRANGLER_API_ENVIRONMENT;
      }
    );

    it.each(['', 'staging', 'production'])(
      'fails on any defined CLOUDFLARE_ENV %s',
      async (val) => {
        deps.env.CLOUDFLARE_ENV = val;
        await expect(ciBuild(deps)).rejects.toThrow('Override endpoint platform ditolak.');
        expect(deps.build).not.toHaveBeenCalled();
        await expect(ciDeploy(deps)).rejects.toThrow('Override endpoint platform ditolak.');
        expect(deps.runWrangler).not.toHaveBeenCalled();
        delete deps.env.CLOUDFLARE_ENV;
      }
    );

    it('allows unset endpoints, regions, environments', async () => {
      // defaults (unset)
      const configHash = sha256('config-content');
      const lockHash = sha256('lock-content');
      const htmlHash = sha256('html-content');

      mkdirSync(join(tempRoot, '.wrangler'), { recursive: true });
      writeFileSync(join(tempRoot, '.wrangler', 'ci-gate.json'), JSON.stringify({
        schemaVersion: 1,
        sha: COMMIT_SHA,
        config: configHash,
        lock: lockHash,
        sources: {
          'wrangler.production.jsonc': configHash,
          'package-lock.json': lockHash,
        },
        assets: {
          'dist/index.html': htmlHash,
        },
      }));
      await expect(ciDeploy(deps)).resolves.toBe(NEW_VERSION_ID);
      await expect(ciBuild(deps)).resolves.toHaveProperty('schemaVersion');
    });

    it('allows each canonical alias independently and explicit undefined', async () => {
      deps.env.CLOUDFLARE_API_BASE_URL = canonical;
      deps.env.CF_API_BASE_URL = undefined;
      deps.env.CLOUDFLARE_COMPLIANCE_REGION = undefined;
      deps.env.WRANGLER_API_ENVIRONMENT = 'production';

      const configHash = sha256('config-content');
      const lockHash = sha256('lock-content');
      const htmlHash = sha256('html-content');

      mkdirSync(join(tempRoot, '.wrangler'), { recursive: true });
      writeFileSync(join(tempRoot, '.wrangler', 'ci-gate.json'), JSON.stringify({
        schemaVersion: 1,
        sha: COMMIT_SHA,
        config: configHash,
        lock: lockHash,
        sources: {
          'wrangler.production.jsonc': configHash,
          'package-lock.json': lockHash,
        },
        assets: {
          'dist/index.html': htmlHash,
        },
      }));
      await expect(ciDeploy(deps)).resolves.toBe(NEW_VERSION_ID);
      await expect(ciBuild(deps)).resolves.toHaveProperty('schemaVersion');

      delete deps.env.CLOUDFLARE_API_BASE_URL;
      deps.env.CF_API_BASE_URL = canonical;
      deps.env.CLOUDFLARE_COMPLIANCE_REGION = 'public';

      await expect(ciDeploy(deps)).resolves.toBe(NEW_VERSION_ID);
      await expect(ciBuild(deps)).resolves.toHaveProperty('schemaVersion');

      deps.env.CLOUDFLARE_API_BASE_URL = canonical;
      deps.env.CF_API_BASE_URL = canonical;
      await expect(ciDeploy(deps)).resolves.toBe(NEW_VERSION_ID);
      await expect(ciBuild(deps)).resolves.toHaveProperty('schemaVersion');
    });
  });

  describe('Binding validation on upload', () => {
    beforeEach(() => {
      const configHash = sha256('config-content');
      const lockHash = sha256('lock-content');
      const htmlHash = sha256('html-content');

      mkdirSync(join(tempRoot, '.wrangler'), { recursive: true });
      writeFileSync(join(tempRoot, '.wrangler', 'ci-gate.json'), JSON.stringify({
        schemaVersion: 1,
        sha: COMMIT_SHA,
        config: configHash,
        lock: lockHash,
        sources: {
          'wrangler.production.jsonc': configHash,
          'package-lock.json': lockHash,
        },
        assets: {
          'dist/index.html': htmlHash,
        },
      }));
    });

    const createViewResult = (bindings: unknown[], compat: string = '2026-10-07') => ({
      status: 0,
      stdout: JSON.stringify({
        id: NEW_VERSION_ID,
        annotations: {
          'workers/message': `git:${COMMIT_SHA}`,
          'workers/tag': `git-${COMMIT_SHA}`,
        },
        resources: {
          script_runtime: { compatibility_date: compat },
          bindings
        }
      }),
      stderr: '',
    });

    const validBindings = [
      { name: 'DB', type: 'd1', id: MIGRATION_DATABASE_ID },
      { name: 'VEHICLE_CACHE', type: 'kv_namespace', namespace_id: CI_NAMESPACE },
      { name: 'ASSETS', type: 'assets' },
      { name: 'PASSWORD_PBKDF2_ITERATIONS', type: 'plain_text', text: '10' },
      { name: 'SESSION_TTL_SECONDS', type: 'plain_text', text: '43200' },
      { name: 'RETENTION_POLICY', type: 'plain_text', text: 'UNSET' },
    ];

    it('fails if uploaded version has missing bindings before deployment', async () => {
      const originalRunWrangler = deps.runWrangler;
      deps.runWrangler = vi.fn().mockImplementation(async (args: string[]) => {
        if (args.join(' ') === `versions view ${NEW_VERSION_ID} --name ${EXPECTED_WORKER} --json`) {
          return createViewResult([]);
        }
        return originalRunWrangler(args);
      });
      await expect(ciDeploy(deps)).rejects.toThrow('CI tidak diizinkan mengubah resources/secrets/bindings.');
      expect(originalRunWrangler).not.toHaveBeenCalledWith(expect.arrayContaining(['deploy', `${NEW_VERSION_ID}@100%`]));
    });

    it('fails on wrong D1 ID', async () => {
      const originalRunWrangler = deps.runWrangler;
      deps.runWrangler = vi.fn().mockImplementation(async (args: string[]) => {
        if (args.join(' ') === `versions view ${NEW_VERSION_ID} --name ${EXPECTED_WORKER} --json`) {
          const badBindings = [...validBindings];
          badBindings[0] = { name: 'DB', type: 'd1', id: 'wrong-id' };
          return createViewResult(badBindings);
        }
        return originalRunWrangler(args);
      });
      await expect(ciDeploy(deps)).rejects.toThrow('CI tidak diizinkan mengubah resources/secrets/bindings.');
    });

    it('fails on extra secret', async () => {
      const originalRunWrangler = deps.runWrangler;
      deps.runWrangler = vi.fn().mockImplementation(async (args: string[]) => {
        if (args.join(' ') === `versions view ${NEW_VERSION_ID} --name ${EXPECTED_WORKER} --json`) {
          const badBindings = [...validBindings, { name: 'SECRET', type: 'secret', text: 'shhh' }];
          return createViewResult(badBindings);
        }
        return originalRunWrangler(args);
      });
      await expect(ciDeploy(deps)).rejects.toThrow('CI tidak diizinkan mengubah resources/secrets/bindings.');
    });

    it('fails on wrong compat date', async () => {
      const originalRunWrangler = deps.runWrangler;
      deps.runWrangler = vi.fn().mockImplementation(async (args: string[]) => {
        if (args.join(' ') === `versions view ${NEW_VERSION_ID} --name ${EXPECTED_WORKER} --json`) {
          return createViewResult(validBindings, '2022-01-01');
        }
        return originalRunWrangler(args);
      });
      await expect(ciDeploy(deps)).rejects.toThrow('Settings Worker berbeda.');
    });

    it('fails on missing var', async () => {
      const originalRunWrangler = deps.runWrangler;
      deps.runWrangler = vi.fn().mockImplementation(async (args: string[]) => {
        if (args.join(' ') === `versions view ${NEW_VERSION_ID} --name ${EXPECTED_WORKER} --json`) {
          const badBindings = [...validBindings];
          badBindings.pop(); // remove RETENTION_POLICY
          return createViewResult(badBindings);
        }
        return originalRunWrangler(args);
      });
      await expect(ciDeploy(deps)).rejects.toThrow('CI tidak diizinkan mengubah resources/secrets/bindings.');
    });
  });

  describe('Git NUL and ignored contract real fixture', () => {
    it('verifies git ls-files nul output with real git repo', () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'git-fixture-'));
      try {
        spawnSync('git', ['init'], { cwd: fixtureRoot });
        writeFileSync(join(fixtureRoot, '.gitignore'), 'ignored.txt\n.env\nnode_modules/\n');
        writeFileSync(join(fixtureRoot, 'ignored.txt'), 'ignore');
        writeFileSync(join(fixtureRoot, '.env'), 'secret');
        mkdirSync(join(fixtureRoot, 'node_modules'));
        writeFileSync(join(fixtureRoot, 'node_modules', 'dep.js'), 'code');
        writeFileSync(join(fixtureRoot, 'untracked.txt'), 'untracked');

        const ignored = spawnSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '.', ':!:node_modules/'], { cwd: fixtureRoot });
        const ignoredFiles = ignored.stdout.toString().slice(0, -1).split('\0');
        expect(ignoredFiles.sort()).toEqual(['.env', 'ignored.txt'].sort());

        const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: fixtureRoot });
        const untrackedFiles = untracked.stdout.toString().slice(0, -1).split('\0');
        expect(untrackedFiles.sort()).toEqual(['.gitignore', 'untracked.txt'].sort());
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });
  });
});
