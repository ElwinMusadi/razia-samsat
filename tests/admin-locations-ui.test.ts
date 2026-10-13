// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import { AuthProvider } from '../src/auth';
import { type AdminLocation, type AuthState } from '../src/lib/api';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BASE = '/api/admin/locations';
const actor = uuid(1);
const location = (n: number, extra: Partial<AdminLocation> = {}): AdminLocation => ({
  id: uuid(n), name: `Lokasi ${n}`, is_active: true, created_at: 1791331200, updated_at: 1791331201, ...extra,
});
const auth = (role: 'ADMIN' | 'OFFICER' = 'ADMIN'): AuthState => ({ user: { id: actor, username: 'synthetic.actor', role }, session: { expires_at: Math.floor(Date.now() / 1000) + 3600 }, active_raid_session: null });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'X-Request-ID': 'req-admin-loc-ui' } });
const failure = (status: number, code = 'SYNTHETIC_ERROR') => json({ error: { code, message: 'Pesan layanan sintetis', request_id: 'req-admin-loc-ui' } }, status);
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
type Handler = (path: string, init: RequestInit) => Response | Promise<Response>;
function routes(handler?: Handler, state = auth()) {
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === '/api/auth/me') return json(state);
    if (path === '/api/auth/logout') return new Response(null, { status: 204 });
    if (path === '/api/locations') return json({ locations: [] });
    if (path === '/api/history/raid-sessions') return json({ raid_sessions: [], next_cursor: null });
    if (handler) return handler(path, init!);
    if (path === BASE) return json({ locations: [location(2), location(3, { is_active: false })] });
    throw new Error(`unmocked ${path}`);
  });
}
function Path() { return createElement('output', { 'data-testid': 'path' }, useLocation().pathname); }
function mount(path = '/admin/locations') {
  return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(AuthProvider, null, createElement(App), createElement(Path))));
}
const adminCalls = () => fetchMock.mock.calls.filter(([path]) => String(path).startsWith(BASE));
beforeEach(() => { fetchMock = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('admin locations UI', () => {
  it('renders the list with active/inactive status chips', async () => {
    routes(); mount();
    const list = await screen.findByRole('list', { name: 'Daftar lokasi razia' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Lokasi 2')).toBeTruthy();
    expect(within(items[0]).getByText('Aktif')).toBeTruthy();
    expect(within(items[1]).getByText('Nonaktif')).toBeTruthy();
    expect(within(items[1]).getByRole('button', { name: 'Aktifkan' })).toBeTruthy();
  });
  it('shows the nav link for admins', async () => {
    routes(); mount();
    await screen.findByRole('list', { name: 'Daftar lokasi razia' });
    expect(screen.getByRole('link', { name: 'Lokasi' }).getAttribute('href')).toBe('/admin/locations');
  });
  it('creates a location and appends it sorted', async () => {
    routes(async (path, init) => {
      if (path === BASE && init.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ name: 'Lokasi Baru' });
        return json(location(4, { name: 'Lokasi Baru' }), 201);
      }
      if (path === BASE) return json({ locations: [location(2)] });
      throw new Error(`unmocked ${path}`);
    });
    mount();
    await screen.findByRole('list', { name: 'Daftar lokasi razia' });
    fireEvent.change(screen.getByLabelText('Nama lokasi baru'), { target: { value: '  Lokasi Baru ' } });
    await userEvent.click(screen.getByRole('button', { name: 'Tambah lokasi' }));
    await screen.findByText('Lokasi Baru');
    expect(adminCalls().filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('rejects an empty name client-side without a request', async () => {
    routes(); mount();
    await screen.findByRole('list', { name: 'Daftar lokasi razia' });
    const before = adminCalls().length;
    fireEvent.change(screen.getByLabelText('Nama lokasi baru'), { target: { value: '   ' } });
    await userEvent.click(screen.getByRole('button', { name: 'Tambah lokasi' }));
    await screen.findByText('Nama lokasi wajib diisi, maksimal 200 karakter.');
    expect(adminCalls()).toHaveLength(before);
  });
  it('renames a location via PATCH', async () => {
    routes(async (path, init) => {
      if (path === `${BASE}/${uuid(2)}` && init.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({ name: 'Nama Diubah' });
        return json(location(2, { name: 'Nama Diubah' }));
      }
      if (path === BASE) return json({ locations: [location(2)] });
      throw new Error(`unmocked ${path}`);
    });
    mount();
    const list = await screen.findByRole('list', { name: 'Daftar lokasi razia' });
    await userEvent.click(within(list).getByRole('button', { name: 'Ubah nama' }));
    fireEvent.change(screen.getByLabelText('Nama lokasi'), { target: { value: 'Nama Diubah' } });
    await userEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await screen.findByText('Nama Diubah');
  });
  it('deactivates after confirmation with an empty DELETE body', async () => {
    routes(async (path, init) => {
      if (path === `${BASE}/${uuid(2)}` && init.method === 'DELETE') {
        expect(JSON.parse(String(init.body))).toEqual({});
        return json(location(2, { is_active: false }));
      }
      if (path === BASE) return json({ locations: [location(2)] });
      throw new Error(`unmocked ${path}`);
    });
    mount();
    const list = await screen.findByRole('list', { name: 'Daftar lokasi razia' });
    await userEvent.click(within(list).getByRole('button', { name: 'Nonaktifkan' }));
    await screen.findByText(/Nonaktifkan lokasi/);
    await userEvent.click(screen.getByRole('button', { name: 'Ya, nonaktifkan' }));
    await screen.findByText('Nonaktif');
    expect(adminCalls().filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  });
  it('reactivates an inactive location', async () => {
    routes(async (path, init) => {
      if (path === `${BASE}/${uuid(3)}` && init.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({ is_active: true });
        return json(location(3, { is_active: true }));
      }
      if (path === BASE) return json({ locations: [location(3, { is_active: false })] });
      throw new Error(`unmocked ${path}`);
    });
    mount();
    const list = await screen.findByRole('list', { name: 'Daftar lokasi razia' });
    await userEvent.click(within(list).getByRole('button', { name: 'Aktifkan' }));
    await screen.findByText('Aktif');
  });
  it('OFFICER direct URL shows 403 without a locations fetch', async () => {
    routes(undefined, auth('OFFICER')); mount();
    await screen.findByRole('heading', { name: 'Akses ditolak (403)' });
    expect(adminCalls()).toHaveLength(0);
  });
  it('surfaces API failures with retry', async () => {
    routes(async path => { if (path === BASE) return failure(500); throw new Error(`unmocked ${path}`); });
    mount();
    await screen.findByText('Pesan layanan sintetis');
    expect(screen.getByRole('button', { name: 'Coba lagi' })).toBeTruthy();
  });
  it('shows a server validation error on create', async () => {
    routes(async (path, init) => {
      if (path === BASE && init.method === 'POST') return failure(400, 'INVALID_INPUT');
      if (path === BASE) return json({ locations: [] });
      throw new Error(`unmocked ${path}`);
    });
    mount();
    await screen.findByText('Belum ada lokasi.');
    fireEvent.change(screen.getByLabelText('Nama lokasi baru'), { target: { value: 'X' } });
    await userEvent.click(screen.getByRole('button', { name: 'Tambah lokasi' }));
    await screen.findByText('Pesan layanan sintetis');
  });
});
