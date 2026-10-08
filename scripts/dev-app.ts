// Same-origin local development: `vite build --watch` writes ./dist and `wrangler dev` serves the SPA
// (Static Assets) and /api from one origin, so cookies/CSRF behave as in production. No dev proxy/CORS.
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { PROJECT_ROOT } from './lib.ts';

// Miniflare rejects a compatibility date later than the host UTC date. While the host UTC date is still
// before the approved target, override it on the CLI only; wrangler.jsonc stays unchanged.
const hostDate = new Date().toISOString().slice(0, 10);
const compatibilityArgs = hostDate < '2026-10-07' ? ['--compatibility-date', hostDate] : [];
const bin = (pkg: string, file: string) => join(PROJECT_ROOT, 'node_modules', pkg, 'bin', file);
const children: ChildProcess[] = [];
const run = (args: string[]) => {
  const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, stdio: 'inherit', shell: false });
  child.on('exit', code => { for (const other of children) if (other !== child) other.kill(); process.exitCode = code ?? 1; });
  children.push(child);
};
run([bin('vite', 'vite.js'), 'build', '--watch']);
run([bin('wrangler', 'wrangler.js'), 'dev', '--local', ...compatibilityArgs]);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { for (const child of children) child.kill(); });
