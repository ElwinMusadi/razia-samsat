import { readFile } from 'node:fs/promises';
import { build } from 'vite';
import { expect, it } from 'vitest';

it('production frontend graph excludes server modules, shared backend logic and fixtures', async () => {
  const moduleIds: string[] = [];
  let html = '';
  let clientScript = '';
  const result = await build({
    logLevel: 'silent',
    build: { write: false },
    plugins: [{
      name: 'verify-client-boundary',
      generateBundle() { moduleIds.push(...this.getModuleIds()); },
    }],
  });
  // Inspect final output after Vite's HTML emission, not an earlier generateBundle hook.
  const outputs = Array.isArray(result) ? result : 'output' in result ? [result] : [];
  for (const output of outputs.flatMap(bundle => bundle.output)) {
    if (output.type === 'asset' && output.fileName === 'index.html') html = String(output.source);
    if (output.type === 'chunk') clientScript += output.code;
  }
  expect(moduleIds.length).toBeGreaterThan(0);
  const projectModules = moduleIds.filter(id => !id.includes('node_modules')).map(id => id.replaceAll('\\', '/'));
  expect(projectModules.some(id => id.endsWith('/src/main.tsx'))).toBe(true);
  expect(projectModules.some(id => id.endsWith('/src/pwa.tsx'))).toBe(true);
  expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
  expect(html).toContain('name="theme-color" content="#F7F6F2"');
  expect(clientScript).toContain('/sw.js');
  const pwaSource = await readFile(new URL('../src/pwa.tsx', import.meta.url), 'utf8');
  expect(pwaSource).not.toMatch(/skipWaiting|clients\.claim|location\.reload|postMessage/);
  expect(projectModules.filter(id => /\/(worker|shared|tests|fixtures|migrations)\//.test(id))).toEqual([]);
  expect(moduleIds.filter(id => /node_modules\/(hono|miniflare|wrangler)\//.test(id.replaceAll('\\', '/')))).toEqual([]);
  // Deployment must carry the original notices alongside bundled self-hosted font/icon bytes.
  for (const [packageName, publicPath] of [
    ['@fontsource/inter', 'fonts/inter-LICENSE.txt'],
    ['@fontsource/dm-serif-display', 'fonts/dm-serif-display-LICENSE.txt'],
    ['lucide-react', 'icons/lucide-LICENSE.txt'],
  ] as const) {
    const original = await readFile(new URL(`../node_modules/${packageName}/LICENSE`, import.meta.url), 'utf8');
    const distributed = await readFile(new URL(`../public/${publicPath}`, import.meta.url), 'utf8');
    expect(distributed.replaceAll('\r\n', '\n')).toBe(original.replaceAll('\r\n', '\n'));
  }
});
