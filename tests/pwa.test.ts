import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const origin = 'https://synthetic.example';
const assets = new Map([['/offline', 'text/html'], ['/offline.css', 'text/css'], ['/manifest.webmanifest', 'application/manifest+json'], ['/icons/icon-192.png', 'image/png'], ['/icons/icon-512.png', 'image/png']]);
const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const advisory = await readFile(new URL('../public/offline.html', import.meta.url), 'utf8');
type FetchRequest = { url: string; method: string; mode: string };
type WorkerEvent = { request?: FetchRequest; waitUntil?: (promise: Promise<unknown>) => void; respondWith?: (promise: Promise<Response>) => void };
function harness() {
  const events = new Map<string, (event: WorkerEvent) => void>();
  const entries = new Map<string, Response>();
  const put = vi.fn(async (path: string, response: Response) => { entries.set(path, response.clone()); });
  const match = vi.fn(async (path: string) => entries.get(path)?.clone());
  const cache = { put, match };
  const caches = { open: vi.fn(async () => cache), keys: vi.fn(async () => ['razia-samsat-public-v0', 'razia-samsat-public-v1', 'razia-samsat-public-v2', 'unrelated-cache']), delete: vi.fn(async () => true) };
  const fetch = vi.fn(async (input: string | FetchRequest, _options?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input.url).pathname;
    return new Response(path === '/offline' ? advisory : 'public static bytes', { headers: { 'Content-Type': `${assets.get(path)}; charset=utf-8` } });
  });
  const claim = vi.fn(); const skipWaiting = vi.fn();
  runInNewContext(source, { self: { location: { origin }, addEventListener: (name: string, callback: (event: WorkerEvent) => void) => events.set(name, callback), clients: { claim }, skipWaiting }, caches, fetch, URL, Response, Headers });
  async function lifecycle(name: string) {
    let pending: Promise<unknown> | undefined;
    events.get(name)!({ waitUntil: promise => { pending = promise; } });
    await pending;
  }
  function dispatch(path: string, method = 'GET', mode = 'navigate') {
    const request = { url: new URL(path, origin).href, method, mode };
    let response: Promise<Response> | undefined;
    events.get('fetch')!({ request, respondWith: promise => { response = promise; } });
    return { request, response };
  }
  return { lifecycle, dispatch, entries, put, match, caches, fetch, claim, skipWaiting };
}

describe('public service worker privacy boundary', () => {
  it('precaches exactly public assets without credentials, redirects or private HTML', async () => {
    const h = harness(); await h.lifecycle('install');
    expect([...h.entries.keys()]).toEqual([...assets.keys()]);
    expect(h.fetch.mock.calls.map(([input]) => new URL(input as string).pathname)).toEqual([...assets.keys()]);
    for (const [, options] of h.fetch.mock.calls) expect(options).toEqual({ credentials: 'omit', cache: 'reload', redirect: 'error' });
    expect(h.skipWaiting).not.toHaveBeenCalled(); expect(h.claim).not.toHaveBeenCalled();
  });
  it.each(['wrong-mime', 'status-201', 'redirect', 'network'])('rejects unsafe install %s before writing cache', async kind => {
    const h = harness();
    h.fetch.mockImplementation(async () => {
      if (kind === 'network') throw new TypeError('synthetic network error');
      const response = new Response('synthetic rejected body', { status: kind === 'status-201' ? 201 : 200, headers: { 'Content-Type': kind === 'wrong-mime' ? 'application/json' : 'text/html' } });
      if (kind === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
      return response;
    });
    await expect(h.lifecycle('install')).rejects.toThrow(); expect(h.put).not.toHaveBeenCalled();
  });
  it('cleans only older application caches without claiming or skipping waiting', async () => {
    const h = harness(); await h.lifecycle('activate');
    expect(h.caches.delete.mock.calls).toEqual([['razia-samsat-public-v0'], ['razia-samsat-public-v1']]);
    expect(h.claim).not.toHaveBeenCalled(); expect(h.skipWaiting).not.toHaveBeenCalled();
  });
  const bypass = ['/api', '/api/auth/me', '/api/auth/me?input=synthetic', '/api/vehicle-lookups', '/api/admin/users', '/%61pi/auth/me', '/api%2fauth/me', '/offline?input=synthetic', '/icons/icon-192.png?x=1', '/login?input=synthetic', '/unknown', '/history/not-a-uuid', '/assets/index-synthetic.js', 'https://other.example/login'];
  it.each(bypass)('leaves %s entirely to network including rejected requests', async path => {
    const h = harness(); h.fetch.mockRejectedValue(new TypeError('synthetic offline'));
    expect(h.dispatch(path).response).toBeUndefined(); expect(h.fetch).not.toHaveBeenCalled();
    expect(h.caches.open).not.toHaveBeenCalled(); expect(h.put).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('bypasses every %s request even to public URLs', method => {
    const h = harness(); expect(h.dispatch('/offline', method).response).toBeUndefined(); expect(h.caches.open).not.toHaveBeenCalled();
  });
  it('bypasses API navigation and fetch without disguising network rejection as offline success', async () => {
    const h = harness(); h.fetch.mockRejectedValue(new TypeError('synthetic offline'));
    for (const mode of ['navigate', 'same-origin', 'cors']) {
      const { request, response } = h.dispatch('/api/auth/me', 'GET', mode);
      expect(response).toBeUndefined(); await expect(h.fetch(request)).rejects.toThrow('synthetic offline');
    }
    expect(h.caches.open).not.toHaveBeenCalled(); expect(h.put).not.toHaveBeenCalled();
  });
  const routes = ['/', '/login', '/razia/setup', '/razia/scanner', '/history', '/admin/users', '/history/11111111-1111-4111-8111-111111111111', '/admin/users/11111111-1111-4111-8111-111111111111'];
  it.each(routes)('returns only static advisory 503 for offline navigation %s', async path => {
    const h = harness(); await h.lifecycle('install'); h.fetch.mockRejectedValue(new TypeError('synthetic offline')); h.put.mockClear();
    const response = await h.dispatch(path).response!;
    expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe(advisory); expect(h.put).not.toHaveBeenCalled();
    expect([...h.entries.keys()]).toEqual([...assets.keys()]);
  });
  it('never saves online navigation bodies, never changes HTTP errors, and excludes non-navigation fetch', async () => {
    const h = harness(); await h.lifecycle('install'); h.put.mockClear();
    h.fetch.mockResolvedValue(new Response('synthetic private sentinel', { status: 401 }));
    const response = await h.dispatch('/login').response!;
    expect(response.status).toBe(401); expect(await response.text()).toBe('synthetic private sentinel');
    expect(h.put).not.toHaveBeenCalled(); expect(h.dispatch('/login', 'GET', 'same-origin').response).toBeUndefined();
    expect(await h.entries.get('/offline')!.clone().text()).not.toContain('synthetic private sentinel');
  });
  it('does not invent a successful fallback when the advisory is missing', async () => {
    const h = harness(); h.fetch.mockRejectedValue(new TypeError('synthetic offline'));
    await expect(h.dispatch('/login').response).rejects.toThrow('synthetic offline'); expect(h.put).not.toHaveBeenCalled();
  });
  it('serves public cache and uses credential-free network misses without runtime writes', async () => {
    const h = harness(); await h.lifecycle('install'); h.fetch.mockClear(); h.put.mockClear();
    expect((await h.dispatch('/icons/icon-192.png', 'GET', 'same-origin').response!)?.status).toBe(200);
    expect(h.fetch).not.toHaveBeenCalled(); h.entries.delete('/icons/icon-192.png');
    await h.dispatch('/icons/icon-192.png', 'GET', 'same-origin').response!;
    expect(h.fetch).toHaveBeenCalledWith(`${origin}/icons/icon-192.png`, { credentials: 'omit', redirect: 'error' }); expect(h.put).not.toHaveBeenCalled();
  });
});

describe('installable public artifacts', () => {
  it('declares Indonesian standalone login entry and actual non-maskable PNG icons', async () => {
    const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
    expect(manifest).toMatchObject({ id: '/', lang: 'id', start_url: '/login', scope: '/', display: 'standalone', theme_color: '#F7F6F2', background_color: '#F7F6F2' });
    expect(manifest.name).toBe('Razia SAMSAT Kota Kupang'); expect(manifest.short_name).toBe('Razia SAMSAT');
    expect(manifest.icons).toHaveLength(2);
    const sharp = createRequire(import.meta.url)('sharp');
    for (const size of [192, 512]) {
      const icon = manifest.icons.find((item: { sizes: string }) => item.sizes === `${size}x${size}`);
      expect(icon).toEqual({ src: `/icons/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' });
      const buffer = await readFile(new URL(`../public${icon.src}`, import.meta.url));
      expect([...buffer.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(buffer.readUInt32BE(16)).toBe(size); expect(buffer.readUInt32BE(20)).toBe(size);
      expect(await sharp(buffer).metadata()).toMatchObject({ format: 'png', width: size, height: size });
      const { info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true }); expect(info.width).toBe(size); expect(info.height).toBe(size);
    }
  });
  it('links install metadata and keeps offline page anonymous, script-free and external-styled', async () => {
    const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    expect(index).toContain('rel="manifest" href="/manifest.webmanifest"'); expect(index).toContain('name="color-scheme" content="light"');
    expect(advisory).toContain('tidak tersedia offline'); expect(advisory).toContain('href="/login"'); expect(advisory).toContain('href="/offline.css"');
    expect(advisory).not.toMatch(/<script|<style|<input|synthetic|owner_name|password_hash/);
  });
  it('inherits one CSP without duplicate comma-merged overrides and revalidates public artifacts', async () => {
    const headers = await readFile(new URL('../public/_headers', import.meta.url), 'utf8');
    expect(headers.match(/Content-Security-Policy:/g)).toHaveLength(1);
    expect(headers).toContain("style-src 'self'"); expect(headers).not.toContain('unsafe-inline');
    expect(headers).toContain('/sw.js\n  Cache-Control: no-store\n  Content-Type: text/javascript; charset=utf-8');
    expect(headers).toContain('/manifest.webmanifest\n  Cache-Control: no-cache\n  Content-Type: application/manifest+json');
    expect(headers).toContain('/offline\n  Cache-Control: no-cache\n  Content-Type: text/html; charset=utf-8');
  });
});
