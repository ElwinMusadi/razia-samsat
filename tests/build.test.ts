import { build } from 'vite';
import { expect, it } from 'vitest';

it('production frontend graph excludes server modules, shared backend logic and fixtures', async () => {
  const moduleIds: string[] = [];
  await build({
    logLevel: 'silent',
    build: { write: false },
    plugins: [{
      name: 'verify-client-boundary',
      generateBundle() { moduleIds.push(...this.getModuleIds()); },
    }],
  });
  expect(moduleIds.length).toBeGreaterThan(0);
  const projectModules = moduleIds.filter(id => !id.includes('node_modules')).map(id => id.replaceAll('\\', '/'));
  expect(projectModules.some(id => id.endsWith('/src/main.tsx'))).toBe(true);
  expect(projectModules.filter(id => /\/(worker|shared|tests|fixtures|migrations)\//.test(id))).toEqual([]);
  expect(moduleIds.filter(id => /node_modules\/(hono|miniflare|wrangler)\//.test(id.replaceAll('\\', '/')))).toEqual([]);
});
