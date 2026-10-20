// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import { AuthProvider } from '../src/auth';
import { parseVehicleSourceState, type AuthState, type VehicleSourceState } from '../src/lib/api';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BASE = '/api/admin/vehicle-source';
const actor = uuid(1);
const state = (patch: Partial<VehicleSourceState['setting']> = {}, configured = true): VehicleSourceState => ({
  setting: { provider: 'BPAD', version: 1, updated_at: 1791331200, updated_by: null, ...patch }, potensi_credentials_configured: configured,
});
const auth = (role: 'ADMIN' | 'OFFICER' = 'ADMIN'): AuthState => ({ user: { id: actor, username: 'synthetic.actor', role }, session: { expires_at: Math.floor(Date.now() / 1000) + 3600 }, active_raid_session: null });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'X-Request-ID': 'req-settings-ui' } });
const failure = (status: number, code: string) => json({ error: { code, message: `Pesan layanan sintetis ${code}`, request_id: 'req-settings-ui' } }, status);
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
type Handler = (path: string, init: RequestInit) => Response | Promise<Response>;
function routes(handler?: Handler, me = auth()) {
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === '/api/auth/me') return json(me);
    if (path === '/api/auth/logout') return new Response(null, { status: 204 });
    if (path === '/api/locations') return json({ locations: [] });
    if (path === '/api/history/raid-sessions') return json({ raid_sessions: [], next_cursor: null });
    if (path === '/api/admin/users') return json({ users: [], next_cursor: null });
    if (handler) return handler(path, init!);
    if (path === BASE) return json(state());
    throw new Error(`unmocked ${path}`);
  });
}
function Path() { return createElement('output', { 'data-testid': 'path' }, useLocation().pathname); }
function mount(path = '/admin/settings') {
  return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(AuthProvider, null, createElement(App), createElement(Path))));
}
const puts = () => fetchMock.mock.calls.filter(([path, init]) => String(path) === BASE && init?.method === 'PUT');
const radio = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}`) }) as HTMLInputElement;
// The heading renders before the setting loads; wait for the radios (the loaded state) before interacting.
const loaded = () => screen.findByRole('radio', { name: /^BPAD/ });
beforeEach(() => { fetchMock = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('vehicle source state parser', () => {
  it('accepts exact DTO and rejects malformed or secret-bearing bodies', () => {
    expect(parseVehicleSourceState(state())).toEqual(state());
    expect(parseVehicleSourceState({ ...state({ provider: 'POTENSI_NTT', version: 2, updated_by: { id: actor, username: 'synthetic.actor' } }), extra: 'x' })).toEqual(state({ provider: 'POTENSI_NTT', version: 2, updated_by: { id: actor, username: 'synthetic.actor' } }));
    for (const body of [null, {}, { setting: state().setting }, { ...state(), potensi_credentials_configured: 'yes' }, state({ provider: 'NJKB' as never }), state({ version: 0 }), state({ version: 1.5 }), state({ updated_at: -1 }), state({ updated_by: { id: 'x', username: 'synthetic.actor' } }), state({ updated_by: { id: actor, username: 'Upper' } }), { setting: { ...state().setting, client_secret: 'LEAK' }, potensi_credentials_configured: true, POTENSI_ACCESS_CLIENT_SECRET: 'LEAK' }]) {
      if (body && typeof body === 'object' && 'POTENSI_ACCESS_CLIENT_SECRET' in body) { expect(JSON.stringify(parseVehicleSourceState(body))).not.toContain('LEAK'); continue; }
      expect(() => parseVehicleSourceState(body)).toThrow();
    }
  });
});

describe('admin settings UI', () => {
  it('is reachable from the Admin page without a new bottom navigation item', async () => {
    routes(); mount('/admin/users');
    const link = await screen.findByRole('link', { name: 'Pengaturan sumber data' });
    expect(link.getAttribute('href')).toBe('/admin/settings');
    const nav = screen.getByRole('navigation', { name: 'Navigasi utama' });
    expect(within(nav).getAllByRole('link').map(item => item.getAttribute('href'))).toEqual(['/razia/setup', '/history', '/razia/scanner', '/admin/users', '/admin/locations']);
    await userEvent.click(link);
    expect(await screen.findByRole('heading', { name: 'Pengaturan sumber data' })).toBeTruthy();
    expect(document.title).toBe('Pengaturan — Razia SAMSAT');
  });
  it('denies officers client-side (server remains authoritative)', async () => {
    routes(undefined, auth('OFFICER')); mount();
    await screen.findByText('Akses ditolak (403)');
    expect(fetchMock.mock.calls.some(([path]) => String(path) === BASE)).toBe(false);
  });
  it('renders the active setting, disables Potensi while credentials are absent and never shows secret values', async () => {
    routes(path => path === BASE ? json(state({}, false)) : failure(500, 'UNEXPECTED')); mount();
    await screen.findByRole('heading', { name: 'Pengaturan sumber data' });
    expect((await loaded() as HTMLInputElement).checked).toBe(true);
    expect(radio('BPAD').getAttribute('aria-describedby')).toBe('provider-BPAD-help');
    const potensi = radio('Potensi NTT');
    expect(potensi.disabled).toBe(true);
    expect(document.body.textContent).toContain('kredensial layanan Potensi NTT belum tersedia');
    expect(document.body.textContent).toContain('bukan jaminan izin akses');
    expect(document.body.textContent).toContain('Pengaturan awal');
    expect((screen.getByRole('button', { name: 'Simpan' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.innerHTML).not.toMatch(/CLIENT_SECRET|secret_text/);
  });
  it('saves with compare-and-set after confirmation and reports the global effect', async () => {
    routes(async (path, init) => {
      if (path === BASE && init.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toEqual({ provider: 'POTENSI_NTT', expected_version: 1 });
        expect(init.credentials).toBe('same-origin'); expect(init.cache).toBe('no-store');
        return json(state({ provider: 'POTENSI_NTT', version: 2, updated_by: { id: actor, username: 'synthetic.actor' } }));
      }
      if (path === BASE) return json(state());
      throw new Error(`unmocked ${path}`);
    });
    mount();
    await screen.findByRole('heading', { name: 'Pengaturan sumber data' }); await loaded();
    const user = userEvent.setup();
    await user.click(radio('Potensi NTT'));
    await user.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(puts()).toHaveLength(0);
    expect(await screen.findByRole('heading', { name: 'Konfirmasi perubahan sumber' })).toBeTruthy();
    expect(document.body.textContent).toContain('untuk semua pengguna');
    expect(document.body.textContent).toContain('snapshot BPAD, bukan data BPAD saat ini');
    await user.click(screen.getByRole('button', { name: 'Ya, terapkan' }));
    await screen.findByText(/Sumber data Potensi NTT berlaku untuk semua pengguna/);
    expect(puts()).toHaveLength(1);
    expect(screen.getByText('Potensi NTT', { selector: '[data-active-provider]' })).toBeTruthy();
    expect(document.body.textContent).toContain('synthetic.actor');
    expect((screen.getByRole('button', { name: 'Simpan' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows a clear conflict when another admin changed the setting, requires reload and never replays', async () => {
    let reloads = 0;
    routes(async (path, init) => {
      if (path === BASE && init.method === 'PUT') return failure(409, 'VEHICLE_SOURCE_CONFLICT');
      if (path === BASE) return json(++reloads > 1 ? state({ provider: 'POTENSI_NTT', version: 2, updated_by: { id: uuid(2), username: 'synthetic.other' } }) : state());
      throw new Error(`unmocked ${path}`);
    });
    mount();
    await screen.findByRole('heading', { name: 'Pengaturan sumber data' }); await loaded();
    const user = userEvent.setup();
    await user.click(radio('Potensi NTT'));
    await user.click(screen.getByRole('button', { name: 'Simpan' }));
    await user.click(await screen.findByRole('button', { name: 'Ya, terapkan' }));
    await screen.findByText(/diubah admin lain sejak halaman ini dimuat/);
    expect(puts()).toHaveLength(1);
    expect(radio('BPAD').disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Simpan' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Muat ulang pengaturan' }));
    await screen.findByText(/Pengaturan dimuat ulang dari layanan/);
    expect(screen.getByText('Potensi NTT', { selector: '[data-active-provider]' })).toBeTruthy();
    expect(document.body.textContent).toContain('synthetic.other');
    expect(puts()).toHaveLength(1);
    expect(radio('Potensi NTT').disabled).toBe(false);
  });
  it.each([[0, 'NETWORK'], [500, 'INTERNAL_ERROR'], [502, 'UPSTREAM_ERROR']])('treats status %i as ambiguous: reconciliation required, no automatic replay', async (status, code) => {
    routes(async (path, init) => {
      if (path === BASE && init.method === 'PUT') return status === 0 ? Promise.reject(new TypeError('offline')) : failure(status, code);
      if (path === BASE) return json(state());
      throw new Error(`unmocked ${path}`);
    });
    mount();
    await screen.findByRole('heading', { name: 'Pengaturan sumber data' }); await loaded();
    const user = userEvent.setup();
    await user.click(radio('Potensi NTT'));
    await user.click(screen.getByRole('button', { name: 'Simpan' }));
    await user.click(await screen.findByRole('button', { name: 'Ya, terapkan' }));
    await screen.findByText(/Hasil penyimpanan belum pasti/);
    expect(puts()).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Simpan' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Muat ulang pengaturan' }));
    await screen.findByText(/Pengaturan dimuat ulang dari layanan/);
    expect(puts()).toHaveLength(1);
  });
  it('surfaces 422 when credentials disappear server-side and keeps BPAD active', async () => {
    routes(async (path, init) => {
      if (path === BASE && init.method === 'PUT') return failure(422, 'VEHICLE_SOURCE_CREDENTIALS_MISSING');
      if (path === BASE) return json(state());
      throw new Error(`unmocked ${path}`);
    });
    mount();
    await screen.findByRole('heading', { name: 'Pengaturan sumber data' }); await loaded();
    const user = userEvent.setup();
    await user.click(radio('Potensi NTT'));
    await user.click(screen.getByRole('button', { name: 'Simpan' }));
    await user.click(await screen.findByRole('button', { name: 'Ya, terapkan' }));
    await screen.findByText(/VEHICLE_SOURCE_CREDENTIALS_MISSING/);
    expect(screen.getByText('BPAD', { selector: '[data-active-provider]' })).toBeTruthy();
    expect(radio('Potensi NTT').disabled).toBe(false);
  });
});
