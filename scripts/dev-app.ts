// Same-origin local UAT. Initial build must finish before the server can serve any assets.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { DEVELOPMENT_CONFIG, DEVELOPMENT_PERSIST, DevelopmentError, prepareDevelopment } from './development.ts';
import { PROJECT_ROOT } from './lib.ts';

const children = new Set<ChildProcess>();
const env = { ...process.env, VITE_APP_MODE: 'development', WRANGLER_SEND_METRICS: 'false' };
const bin = (pkg: string, file: string) => join(PROJECT_ROOT, 'node_modules', pkg, 'bin', file);
let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    // Windows SIGTERM does not recursively terminate descendants. Kill only this owned tree.
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
    else child.kill();
  }
}
function run(args: string[], persistent = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, stdio: 'inherit', shell: false, env });
    children.add(child);
    child.once('error', () => { children.delete(child); stop(); reject(new DevelopmentError('Proses development gagal dimulai.')); });
    child.once('exit', (code, signal) => {
      children.delete(child);
      if (stopping && signal) resolve();
      else if (code === 0 && !persistent) resolve();
      else { stop(); reject(new DevelopmentError('Proses development berhenti; seluruh proses anak dihentikan.')); }
    });
  });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
try {
  if (process.argv.length !== 2) throw new DevelopmentError('npm run dev tidak menerima konfigurasi atau target tambahan.');
  await prepareDevelopment();
  if (!stopping) await run([bin('vite', 'vite.js'), 'build']);
  if (!stopping) {
    process.stdout.write('UAT lokal dengan data simulasi: http://127.0.0.1:8787\n');
    await Promise.all([
      run([bin('vite', 'vite.js'), 'build', '--watch'], true),
      run([bin('wrangler', 'wrangler.js'), 'dev', '--local', '--config', DEVELOPMENT_CONFIG, '--persist-to', DEVELOPMENT_PERSIST, '--ip', '127.0.0.1', '--port', '8787'], true),
    ]);
  }
} catch (error) {
  stop();
  process.stderr.write(`${error instanceof DevelopmentError ? error.message : 'Development lokal gagal.'}\n`);
  process.exitCode = 1;
}
