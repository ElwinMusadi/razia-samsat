// Local bootstrap helpers (P2-09). Node-only; run through Node type stripping, so keep erasable syntax.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIterationsConfig, parsePasswordHash, PASSWORD_MAX_BYTES, passwordByteLength } from '../shared/password.ts';
import { USERNAME_PATTERN } from '../shared/username.ts';

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROLES = ['ADMIN', 'OFFICER'] as const;
export type BootstrapRole = typeof ROLES[number];
const FORBIDDEN_TEXT = /[\p{Cc}\p{Cs}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

export class UsageError extends Error {}

/** Parses `--name value` pairs. Unknown, repeated or valueless flags are rejected. */
export function parseFlags(argv: string[], allowed: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith('--') || !allowed.includes(flag.slice(2)) || flags.has(flag.slice(2)) || value === undefined || value.startsWith('--')) {
      throw new UsageError(`Unexpected argument: ${flag}`);
    }
    flags.set(flag.slice(2), value);
  }
  return flags;
}

export function assertUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new UsageError('Invalid UUID');
  return value;
}

export function assertRole(value: string | undefined): BootstrapRole {
  const role = ROLES.find(candidate => candidate === value);
  if (!role) throw new UsageError('Role must be ADMIN or OFFICER');
  return role;
}

/** Location names: trim, 1..200 code points, no control or bidi formatting characters. */
export function assertLocationName(value: string | undefined): string {
  const name = typeof value === 'string' ? value.trim() : '';
  const length = [...name].length;
  if (length < 1 || length > 200 || FORBIDDEN_TEXT.test(name)) throw new UsageError('Location name must be 1..200 printable characters');
  return name;
}

function sqlText(value: string): string {
  if (value.includes('\0')) throw new UsageError('NUL is not allowed');
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildCreateUserSql(input: { id: string; username: string; role: string; passwordHash: string; iterations: number }): string {
  assertUuid(input.id);
  if (!USERNAME_PATTERN.test(input.username)) throw new UsageError('Invalid username');
  assertRole(input.role);
  const parsed = parsePasswordHash(input.passwordHash);
  if (!parsed || parsed.iterations !== input.iterations) throw new UsageError('Invalid password hash');
  return `INSERT INTO users(id, username, password_hash, role, is_active) VALUES(${sqlText(input.id)}, ${sqlText(input.username)}, ${sqlText(input.passwordHash)}, ${sqlText(input.role)}, 1);\n`;
}

export function buildCreateLocationSql(input: { id: string; name: string }): string {
  assertUuid(input.id);
  if (assertLocationName(input.name) !== input.name) throw new UsageError('Location name must be trimmed');
  return `INSERT INTO locations(id, name, is_active) VALUES(${sqlText(input.id)}, ${sqlText(input.name)}, 1);\n`;
}

/** Iterations come from `--iterations` or else from wrangler.jsonc vars; both are range-checked. */
export async function resolveIterations(flag: string | undefined): Promise<number> {
  let source: unknown = flag;
  if (source === undefined) {
    const { experimental_readRawConfig } = await import('wrangler');
    const { rawConfig } = experimental_readRawConfig({ config: join(PROJECT_ROOT, 'wrangler.jsonc') });
    source = (rawConfig.vars as Record<string, unknown> | undefined)?.PASSWORD_PBKDF2_ITERATIONS;
  }
  const iterations = parseIterationsConfig(source);
  if (iterations === null) throw new UsageError('PBKDF2 iterations must be an integer in 1000..100000');
  return iterations;
}

function stripLineEnding(value: string): string {
  return value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value;
}

async function readHiddenLine(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0003' || character === '\u0004') return finish(new UsageError('Cancelled'));
        if (character === '\u007f' || character === '\b') value = [...value].slice(0, -1).join('');
        else value += character;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPipedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > PASSWORD_MAX_BYTES + 2) throw new UsageError(`Password must be at most ${PASSWORD_MAX_BYTES} UTF-8 bytes`);
    chunks.push(buffer);
  }
  try {
    return stripLineEnding(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new UsageError('Password must be valid UTF-8');
  }
}

/**
 * Reads the password from stdin only (never argv/env). Interactive terminals get a no-echo prompt with
 * confirmation; piped stdin is read once with one trailing line ending removed. No normalization is applied.
 * The password policy (minimum length/complexity) is UNRESOLVED, so only non-empty and the byte cap apply.
 */
export async function readPassword(): Promise<string> {
  let password: string;
  if (process.stdin.isTTY) {
    password = await readHiddenLine('Password: ');
    if (password !== await readHiddenLine('Confirm password: ')) throw new UsageError('Passwords do not match');
  } else {
    password = await readPipedStdin();
  }
  if (password.length === 0 || passwordByteLength(password) > PASSWORD_MAX_BYTES) throw new UsageError(`Password must be 1..${PASSWORD_MAX_BYTES} UTF-8 bytes`);
  return password;
}

/** Writes SQL to a random 0600 file under os.tmpdir(), runs `wrangler d1 execute DB --local --file`, always deletes it. */
export async function executeLocalSql(sql: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'razia-bootstrap-'));
  const file = join(directory, `${randomBytes(16).toString('hex')}.sql`);
  try {
    await writeFile(file, sql, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const wrangler = join(PROJECT_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    const result = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'DB', '--local', '--file', file], {
      cwd: PROJECT_ROOT, stdio: ['ignore', 'ignore', 'inherit'], shell: false,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    if (result.status !== 0) throw new Error('wrangler d1 execute failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runMain(main: () => Promise<void>, usage: string): Promise<void> {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof UsageError ? error.message : 'Bootstrap failed'}\n${error instanceof UsageError ? usage : ''}\n`);
    process.exitCode = 1;
  }
}
