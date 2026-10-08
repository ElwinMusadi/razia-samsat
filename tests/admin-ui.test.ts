// @vitest-environment jsdom
import { createElement, useLayoutEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import { AuthProvider, useAuth } from '../src/auth';
import { ApiError, type AdminUser, type AdminSession, type AuthState } from '../src/lib/api';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BASE = '/api/admin/users';
const actor = uuid(1), target = uuid(2);
const detail = `/admin/users/${target}`, targetApi = `${BASE}/${target}`;
const cursor = 'Opaque_Az09-';
const user = (id = target, extra: Partial<AdminUser> = {}): AdminUser => ({ id, username: `synthetic.user.${id.slice(-1)}`, role: id === actor ? 'ADMIN' : 'OFFICER', is_active: true, created_at: 1791331200, updated_at: 1791331201, active_session_count: 2, ...extra });
const session = (n = 3, current = false): AdminSession => ({ id: uuid(n), created_at: 1791331200 + n, expires_at: 1791374400 + n, is_current: current });
const auth = (role: 'ADMIN' | 'OFFICER' = 'ADMIN', id = actor): AuthState => ({ user: { id, username: 'synthetic.actor', role }, session: { expires_at: Math.floor(Date.now() / 1000) + 3600 }, active_raid_session: null });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'X-Request-ID': 'req-admin-ui' } });
const failure = (status: number, code = 'SYNTHETIC_ERROR') => json({ error: { code, message: 'Pesan layanan sintetis', request_id: 'req-admin-ui' } }, status);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
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
    if (path.endsWith('/sessions?limit=20')) return json({ sessions: [session()], next_cursor: null });
    if (path === `${BASE}?limit=20`) return json({ users: [user()], next_cursor: null });
    return json(user(path.includes(actor) ? actor : target));
  });
}
function Path() { return createElement('output', { 'data-testid': 'path' }, useLocation().pathname); }
function NavigateTest({ to }: { to: string }) { const navigate = useNavigate(); return createElement('button', { onClick: () => navigate(to) }, 'Test navigation'); }
function Probe({ observe }: { observe: (value: AuthState | null) => void }) {
  const { auth: value } = useAuth(); useLayoutEffect(() => observe(value), [observe, value]); return null;
}
function mount(path = '/admin/users', extra?: ReturnType<typeof createElement>) {
  return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(AuthProvider, null, createElement(App), createElement(Path), extra)));
}
const adminCalls = () => fetchMock.mock.calls.filter(([path]) => String(path).startsWith(BASE));
const posts = () => adminCalls().filter(([, init]) => init?.method === 'POST');
const password = (label = 'Kata sandi baru') => screen.getByLabelText(label) as HTMLInputElement;
async function confirm() { await userEvent.click(screen.getByRole('button', { name: 'Ya, lanjutkan' })); }
async function openPassword() { await userEvent.click(await screen.findByRole('button', { name: 'Reset kata sandi' })); return password(); }
async function createValues(name = '  Synthetic.New ', value = ' x ') {
  fireEvent.change(screen.getByLabelText('Nama pengguna baru'), { target: { value: name } });
  fireEvent.change(password('Kata sandi awal'), { target: { value } });
}
beforeEach(() => { fetchMock = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('admin list, guards and navigation', () => {
  it('waits for pending authentication before any admin fetch or form', async () => {
    const pending = deferred<Response>(); fetchMock.mockReturnValue(pending.promise); mount();
    await screen.findByText('Memeriksa sesi…'); expect(adminCalls()).toHaveLength(0); expect(screen.queryByText('Tambah pengguna')).toBeNull();
    routes(); await act(async () => pending.resolve(json(auth()))); await screen.findByRole('list', { name: 'Daftar pengguna' });
  });
  it.each(['/admin/users', detail])('OFFICER direct URL %s shows403 without metadata fetch or logout', async path => {
    routes(undefined, auth('OFFICER')); mount(path); await screen.findByRole('heading', { name: 'Akses ditolak (403)' });
    expect(adminCalls()).toHaveLength(0); expect(screen.queryByRole('link', { name: 'Kelola pengguna' })).toBeNull();
    expect(screen.getByTestId('path').textContent).toBe(path); expect(screen.getByRole('button', { name: 'Keluar' })).toBeTruthy();
  });
  it('keeps ADMIN link in header and unchanged bottomnav safearea/44px declaration', async () => {
    routes(); mount(); await screen.findByRole('list', { name: 'Daftar pengguna' });
    const link = screen.getByRole('link', { name: 'Kelola pengguna' }); expect(link.closest('header')).not.toBeNull();
    expect(link.className).toContain('min-h-11'); expect(link.className).toContain('min-w-11'); expect(link.getAttribute('aria-current')).toBe('page');
    const nav = screen.getByRole('navigation'); expect([...nav.firstElementChild!.children].map(node => node.textContent)).toEqual(['Sesi razia', 'Riwayat', 'Keluar']);
    expect(nav.className).toContain('safe-area-inset-bottom'); expect(nav.firstElementChild!.className).not.toContain('flex-wrap');
    expect(screen.getByRole('heading', { name: 'Kelola pengguna' }).parentElement!.className).toContain('min-w-0');
  });
  it('shows list loading/empty and no invented data', async () => {
    const pending = deferred<Response>(); routes(() => pending.promise); mount(); await screen.findByText('Memuat pengguna…');
    expect(screen.queryByText('Belum ada pengguna.')).toBeNull(); await act(async () => pending.resolve(json({ users: [], next_cursor: null })));
    await screen.findByText('Belum ada pengguna.'); expect(screen.queryByRole('button', { name: 'Muat lebih banyak pengguna' })).toBeNull();
  });
  it('renders only user metadata and uses encoded detail links', async () => {
    const extras = { password_hash: 'PRIVATE_HASH', token_hash: 'PRIVATE_TOKEN', raw: 'PRIVATE_RAW' };
    routes(() => json({ users: [{ ...user(), ...extras }, user(actor)], next_cursor: null, ...extras })); mount();
    const list = await screen.findByRole('list', { name: 'Daftar pengguna' }); expect(list.children).toHaveLength(2);
    expect(list.textContent).toContain('Petugas'); expect(list.textContent).toContain('Admin'); expect(list.textContent).toContain('WITA');
    expect(document.body.innerHTML).not.toContain('PRIVATE'); expect(within(list).getAllByRole('link')[0].getAttribute('href')).toBe(detail);
  });
  it('pages exact cursor, blocks double click, deduplicates and retries same cursor', async () => {
    const pending = deferred<Response>(); let more = 0;
    routes(path => path === `${BASE}?limit=20` ? json({ users: [user()], next_cursor: cursor }) : ++more === 1 ? pending.promise : json({ users: [user(), user(uuid(9)), user(uuid(9))], next_cursor: null })); mount();
    const button = await screen.findByRole('button', { name: 'Muat lebih banyak pengguna' }); fireEvent.click(button); fireEvent.click(button);
    expect(adminCalls().filter(([path]) => String(path).includes('cursor='))).toHaveLength(1);
    await act(async () => pending.resolve(failure(500))); await screen.findByRole('alert'); expect(screen.getByRole('list', { name: 'Daftar pengguna' }).children).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Coba lagi' })); await waitFor(() => expect(screen.getByRole('list', { name: 'Daftar pengguna' }).children).toHaveLength(2));
    expect(adminCalls().filter(([path]) => path === `${BASE}?limit=20&cursor=${cursor}`)).toHaveLength(2);
  });
  it.each([403, 404])('read%i hides metadata and preserves authentication/request ID', async status => {
    routes(() => failure(status)); mount(); const alert = await screen.findByRole('alert'); expect(alert.textContent).toContain('req-admin-ui');
    expect(screen.queryByRole('list', { name: 'Daftar pengguna' })).toBeNull(); expect(screen.queryByText('Tambah pengguna')).toBeNull();
    expect(screen.getByTestId('path').textContent).toBe('/admin/users'); expect(fetchMock.mock.calls.some(([path]) => path === '/api/auth/logout')).toBe(false);
  });
  it.each(['/admin/users', detail])('read401 redirects %s through existing recovery', async path => {
    routes(() => failure(401)); mount(path); await screen.findByRole('heading', { name: 'Masuk' }); expect(screen.getByTestId('path').textContent).toBe('/login');
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/logout')).toBe(false);
  });
  it('invalid response is generic with request ID and explicit read retry', async () => {
    let calls = 0; routes(() => ++calls === 1 ? json({ password_hash: 'PRIVATE_HASH' }) : json({ users: [], next_cursor: null })); mount();
    const alert = await screen.findByRole('alert'); expect(alert.textContent).toContain('Respons layanan tidak valid'); expect(alert.textContent).toContain('req-admin-ui'); expect(document.body.innerHTML).not.toContain('PRIVATE');
    await userEvent.click(screen.getByRole('button', { name: 'Coba lagi' })); await screen.findByText('Belum ada pengguna.');
  });
});

describe('admin create credential handling and reconciliation', () => {
  it('creates normalized username/create-only role with unmodified short password, no storage/logging', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem'); const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method));
    const pending = deferred<Response>(); routes((_path, init) => init.method === 'POST' ? pending.promise : json({ users: [], next_cursor: null })); mount();
    await screen.findByText('Belum ada pengguna.'); await createValues(); fireEvent.change(screen.getByLabelText('Peran pengguna baru'), { target: { value: 'ADMIN' } });
    const input = password('Kata sandi awal'); fireEvent.submit(input.form!); fireEvent.submit(input.form!);
    expect(input.value).toBe(''); expect(posts()).toHaveLength(1); expect(JSON.parse(String(posts()[0][1]!.body))).toEqual({ username: 'synthetic.new', password: ' x ', role: 'ADMIN' });
    await act(async () => pending.resolve(json(user(uuid(9), { username: 'synthetic.new', role: 'ADMIN', active_session_count: 0 }), 201)));
    await screen.findByText(/Pengguna synthetic.new dibuat/); expect(screen.getByLabelText('Nama pengguna baru').getAttribute('value')).toBeNull();
    expect(storage).not.toHaveBeenCalled(); for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it.each(['username', 'role', 'password'])('rejects invalid %s locally and clears password', async kind => {
    routes(); mount(); await screen.findByRole('list', { name: 'Daftar pengguna' }); await createValues(kind === 'username' ? 'K' : 'new', kind === 'password' ? 'é'.repeat(513) : 'x');
    if (kind === 'role') fireEvent.change(screen.getByLabelText('Peran pengguna baru'), { target: { value: 'UNKNOWN' } });
    const input = password('Kata sandi awal'); fireEvent.submit(input.form!); await screen.findByRole('alert'); expect(input.value).toBe(''); expect(posts()).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toContain('kuat dan unik');
  });
  it('duplicate username409 stays in form with requestID and clears password', async () => {
    routes((_path, init) => init.method === 'POST' ? failure(409, 'USERNAME_TAKEN') : json({ users: [], next_cursor: null })); mount(); await screen.findByText('Belum ada pengguna.'); await createValues();
    const input = password('Kata sandi awal'); fireEvent.submit(input.form!); const alert = await screen.findByRole('alert'); expect(alert.textContent).toContain('req-admin-ui'); expect(input.value).toBe(''); expect(screen.getByTestId('path').textContent).toBe('/admin/users');
  });
  it('ambiguous create needs GET reconciliation before explicit resubmit and preserves initial error', async () => {
    let created = 0; routes((_path, init) => { if (init.method === 'POST') { if (++created === 1) throw new Error('PRIVATE_TRANSPORT'); return json(user(uuid(9)), 201); } return json({ users: created ? [user(uuid(9))] : [], next_cursor: null }); });
    mount(); await screen.findByText('Belum ada pengguna.'); await createValues(); fireEvent.submit(password('Kata sandi awal').form!);
    const alert = await screen.findByRole('alert'); expect(alert.textContent).not.toContain('PRIVATE'); expect(password('Kata sandi awal').value).toBe('');
    expect((screen.getByRole('button', { name: 'Buat pengguna' }) as HTMLButtonElement).disabled).toBe(true); expect(posts()).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Periksa hasil tindakan' })); await screen.findByRole('list', { name: 'Daftar pengguna' });
    expect(posts()).toHaveLength(1); expect(screen.getByRole('alert').textContent).toBe(alert.textContent); expect(adminCalls().filter(([, init]) => init!.method === 'GET')).toHaveLength(2);
    await createValues('synthetic.retry', 'y'); fireEvent.submit(password('Kata sandi awal').form!); await waitFor(() => expect(posts()).toHaveLength(2));
  });
  it('create password clears on navigation and unmount without wiping typing', async () => {
    routes(); const view = mount(undefined, createElement(NavigateTest, { to: '/history' })); await screen.findByRole('list', { name: 'Daftar pengguna' });
    const input = password('Kata sandi awal'); await userEvent.type(input, 'synthetic-secret'); expect(input.value).toBe('synthetic-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Test navigation' })); expect(input.value).toBe(''); view.unmount();
  });
});

describe('detail confirmations, sessions and credential lifecycle', () => {
  it('shows only target sessions, current-device marker/time and no token/UUID', async () => {
    routes(path => path.endsWith('/sessions?limit=20') ? json({ sessions: [{ ...session(3, true), token_hash: 'PRIVATE_TOKEN' }, session(4)], next_cursor: null }) : json({ ...user(), password_hash: 'PRIVATE_HASH' })); mount(detail);
    const list = await screen.findByRole('list', { name: 'Sesi perangkat pengguna' }); expect(list.children).toHaveLength(2); expect(list.textContent).toContain('Perangkat ini'); expect(list.textContent).toContain('WITA');
    expect(document.body.innerHTML).not.toContain('PRIVATE'); expect(list.textContent).not.toContain(uuid(3)); expect(adminCalls().every(([path]) => String(path).startsWith(targetApi))).toBe(true);
  });
  it('session pagination deduplicates and retries exact cursor retaining prior sessions', async () => {
    let more = 0; routes(path => path.endsWith('/sessions?limit=20') ? json({ sessions: [session()], next_cursor: cursor }) : path.includes('cursor=') ? ++more === 1 ? failure(500) : json({ sessions: [session(), session(4), session(4)], next_cursor: null }) : json(user()));
    mount(detail); await userEvent.click(await screen.findByRole('button', { name: 'Muat lebih banyak sesi' })); await screen.findByRole('alert'); expect(screen.getByRole('list', { name: 'Sesi perangkat pengguna' }).children).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Coba lagi' })); await waitFor(() => expect(screen.getByRole('list', { name: 'Sesi perangkat pengguna' }).children).toHaveLength(2));
    expect(adminCalls().filter(([path]) => path === `${targetApi}/sessions?limit=20&cursor=${cursor}`)).toHaveLength(2);
  });
  it.each(['activate', 'deactivate'] as const)('requires inline %s confirmation and preserves history/raid policy', async action => {
    const pending = deferred<Response>(); routes((path, init) => init.method === 'POST' ? pending.promise : path.endsWith('/sessions?limit=20') ? json({ sessions: [session()], next_cursor: null }) : json(user(target, { is_active: action === 'deactivate' })));
    mount(detail); await userEvent.click(await screen.findByRole('button', { name: action === 'activate' ? 'Aktifkan akun' : 'Nonaktifkan akun' }));
    expect(posts()).toHaveLength(0); const region = screen.getByRole('region', { name: 'Konfirmasi tindakan' }); expect(region.textContent).toContain('Riwayat tidak dihapus'); expect(region.textContent).toContain('tidak menutup sesi razia');
    await confirm(); fireEvent.submit(region.querySelector('form')!); expect(posts()).toHaveLength(1); expect(posts()[0][0]).toBe(`${targetApi}/${action}`); expect(posts()[0][1]!.body).toBe('{}');
    await act(async () => pending.resolve(json(user(target, { is_active: action === 'activate', active_session_count: 0 }))));
    await screen.findByText(action === 'activate' ? 'Akun diaktifkan. Sesi lama tidak dipulihkan.' : 'Akun dinonaktifkan dan sesi pengguna dicabut.');
    expect(screen.queryByRole('region', { name: 'Konfirmasi tindakan' })).toBeNull(); expect(adminCalls().some(([path]) => String(path).includes('raid'))).toBe(false);
  });
  it('self-deactivation disabled with explicit explanation and no request', async () => {
    routes(); mount(`/admin/users/${actor}`); const button = await screen.findByRole('button', { name: 'Nonaktifkan akun' }); expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('self-deactivate-help'); await screen.findByText(/Akun Anda sendiri tidak dapat dinonaktifkan/); fireEvent.click(button); expect(posts()).toHaveLength(0);
  });
  it.each(['all', 'specific'] as const)('revoke%s sends exact body only after confirmation', async kind => {
    routes((path, init) => init.method === 'POST' ? json({ user: user(target, { active_session_count: kind === 'all' ? 0 : 1 }), signed_out: false }) : path.endsWith('/sessions?limit=20') ? json({ sessions: [session(), session(4)], next_cursor: null }) : json(user())); mount(detail);
    await userEvent.click(await screen.findByRole('button', { name: kind === 'all' ? 'Cabut semua sesi' : 'Cabut sesi 1' })); expect(posts()).toHaveLength(0); await confirm();
    await screen.findByText('Sesi perangkat dicabut. Pengguna aktif tetap dapat masuk kembali.'); expect(posts()[0][0]).toBe(`${targetApi}/sessions/revoke`); expect(JSON.parse(String(posts()[0][1]!.body))).toEqual(kind === 'all' ? {} : { session_id: uuid(3) });
    if (kind === 'all') await screen.findByText('Tidak ada sesi perangkat aktif.'); else expect(screen.getByRole('list', { name: 'Sesi perangkat pengguna' }).children).toHaveLength(1);
    expect(screen.getByTestId('path').textContent).toBe(detail); expect(screen.getByText(/Pencabutan sesi bukan pemblokiran login baru/)).toBeTruthy();
  });
  it('password reset sends exact unnormalized body, clears immediately and drops all target sessions', async () => {
    const pending = deferred<Response>(); routes((path, init) => init.method === 'POST' ? pending.promise : path.endsWith('/sessions?limit=20') ? json({ sessions: [session(), session(4)], next_cursor: null }) : json(user())); mount(detail);
    const input = await openPassword(); fireEvent.change(input, { target: { value: ' e\u0301 ' } }); expect(posts()).toHaveLength(0); await confirm(); expect(input.value).toBe('');
    expect(posts()[0][0]).toBe(`${targetApi}/password`); expect(JSON.parse(String(posts()[0][1]!.body))).toEqual({ password: ' e\u0301 ' });
    await act(async () => pending.resolve(json({ user: user(target, { active_session_count: 0 }), signed_out: false })));
    await screen.findByText('Kata sandi diperbarui. Semua sesi pengguna dicabut.'); await screen.findByText('Tidak ada sesi perangkat aktif.');
  });
  it.each(['cancel', 'unmount', 'path'] as const)('conditional password ref clears on %s, typing stays intact', async kind => {
    routes(); const view = mount(detail, createElement(NavigateTest, { to: `/admin/users/${uuid(9)}` })); const input = await openPassword(); await userEvent.type(input, 'synthetic-secret'); expect(input.value).toBe('synthetic-secret');
    if (kind === 'cancel') await userEvent.click(screen.getByRole('button', { name: 'Batal' })); else if (kind === 'path') await userEvent.click(screen.getByRole('button', { name: 'Test navigation' })); else view.unmount();
    expect(input.value).toBe('');
  });
  it('invalid password remains generic, clears and sends nothing', async () => {
    routes(); mount(detail); const input = await openPassword(); fireEvent.change(input, { target: { value: 'é'.repeat(513) } }); await confirm(); await screen.findByRole('alert'); expect(input.value).toBe(''); expect(posts()).toHaveLength(0);
  });
  it.each(['password', 'all', 'current', 'other'] as const)('self%s signed_out routing is server-derived, no logout/me race', async kind => {
    const signedOut = kind !== 'other'; let meCalls = 0;
    routes((path, init) => init.method === 'POST' ? json({ user: user(actor, { active_session_count: kind === 'other' ? 1 : 0 }), signed_out: signedOut }) : path.endsWith('/sessions?limit=20') ? json({ sessions: [session(3, true), session(4)], next_cursor: null }) : json(user(actor)));
    const original = fetchMock.getMockImplementation()!; const staleMe = deferred<Response>();
    fetchMock.mockImplementation((path, init) => String(path) === '/api/auth/me' && ++meCalls === 2 ? staleMe.promise : original(path, init));
    mount(`/admin/users/${actor}`); await screen.findByRole('button', { name: 'Reset kata sandi' }); fireEvent(window, new Event('focus'));
    if (kind === 'password') { const input = await openPassword(); fireEvent.change(input, { target: { value: 'x' } }); } else await userEvent.click(screen.getByRole('button', { name: kind === 'all' ? 'Cabut semua sesi' : kind === 'current' ? 'Cabut sesi 1' : 'Cabut sesi 2' }));
    await confirm();
    if (signedOut) { await screen.findByRole('heading', { name: 'Masuk' }); expect(screen.getByTestId('path').textContent).toBe('/login'); expect(screen.getByText(kind === 'password' ? /Kata sandi diperbarui dan semua sesi Anda dicabut/ : /Sesi perangkat ini dicabut/)).toBeTruthy(); }
    else await screen.findByText('Sesi perangkat dicabut. Pengguna aktif tetap dapat masuk kembali.');
    await act(async () => staleMe.resolve(json(auth()))); expect(screen.getByTestId('path').textContent).toBe(signedOut ? '/login' : `/admin/users/${actor}`);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/me')).toHaveLength(2); expect(fetchMock.mock.calls.some(([path]) => path === '/api/auth/logout')).toBe(false);
  });
  it.each([401, 403, 404, 409])('mutation%i handles auth/denial/missing/conflict with requestID and no false success', async status => {
    routes((path, init) => init.method === 'POST' ? failure(status) : path.endsWith('/sessions?limit=20') ? json({ sessions: [session()], next_cursor: null }) : json(user())); mount(detail);
    const input = await openPassword(); fireEvent.change(input, { target: { value: 'x' } }); await confirm(); expect(input.value).toBe('');
    if (status === 401) { await screen.findByRole('heading', { name: 'Masuk' }); expect(screen.getByTestId('path').textContent).toBe('/login'); }
    else { const alerts = await screen.findAllByRole('alert'); expect(alerts.some(alert => alert.textContent?.includes('req-admin-ui'))).toBe(true); expect(screen.getByTestId('path').textContent).toBe(detail); if (status === 403 || status === 404) expect(screen.queryByRole('list', { name: 'Sesi perangkat pengguna' })).toBeNull(); }
    expect(screen.queryByText('Kata sandi diperbarui. Semua sesi pengguna dicabut.')).toBeNull(); expect(fetchMock.mock.calls.some(([path]) => path === '/api/auth/logout')).toBe(false);
  });
  it('ambiguous password requires GET user+sessions reconciliation before explicit confirmation/resubmit', async () => {
    let writes = 0; routes((path, init) => { if (init.method === 'POST') { writes++; if (writes === 1) return new Response('PRIVATE_BODY', { status: 500, headers: { 'X-Request-ID': 'req-missing' } }); return json({ user: user(target, { active_session_count: 0 }), signed_out: false }); } return path.endsWith('/sessions?limit=20') ? json({ sessions: writes ? [] : [session()], next_cursor: null }) : json(user(target, { active_session_count: writes ? 0 : 1 })); });
    mount(detail); const input = await openPassword(); fireEvent.change(input, { target: { value: 'first' } }); await confirm(); const alert = await screen.findByRole('alert'); expect(alert.textContent).toContain('req-missing'); expect(input.value).toBe(''); expect(document.body.textContent).not.toContain('PRIVATE');
    fireEvent.submit(input.form!); expect(posts()).toHaveLength(1); await userEvent.click(screen.getByRole('button', { name: 'Periksa hasil tindakan' })); await screen.findByText(/Data layanan diperiksa/);
    expect(posts()).toHaveLength(1); expect(adminCalls().filter(([, init]) => init!.method === 'GET')).toHaveLength(4); expect(screen.getByRole('alert').textContent).toBe(alert.textContent);
    const nextInput = await openPassword(); fireEvent.change(nextInput, { target: { value: 'second' } }); await confirm(); await screen.findByText('Kata sandi diperbarui. Semua sesi pengguna dicabut.'); expect(posts()).toHaveLength(2);
  });
});

describe('stale context isolation', () => {
  it('head reload supersedes a pending page and ignores its stale401 before auth recovery', async () => {
    const pending = deferred<Response>(); let heads = 0; let staleSignal: AbortSignal | undefined;
    routes((path, init) => { if (path.includes('cursor=')) { staleSignal = init.signal!; return pending.promise; } return json({ users: [user(++heads === 1 ? target : uuid(9))], next_cursor: heads === 1 ? cursor : null }); });
    mount(); await userEvent.click(await screen.findByRole('button', { name: 'Muat lebih banyak pengguna' })); await userEvent.click(screen.getByRole('button', { name: 'Muat ulang pengguna' }));
    await screen.findByText(user(uuid(9)).username); expect(staleSignal?.aborted).toBe(true);
    await act(async () => pending.resolve(failure(401))); expect(screen.queryByText(user().username)).toBeNull(); expect(screen.getByTestId('path').textContent).toBe('/admin/users');
  });
  it('list pagination403 clears prior metadata/forms without logging out', async () => {
    routes(path => path.includes('cursor=') ? failure(403) : json({ users: [user()], next_cursor: cursor })); mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Muat lebih banyak pengguna' })); await screen.findByRole('alert');
    expect(screen.queryByRole('list', { name: 'Daftar pengguna' })).toBeNull(); expect(screen.queryByText('Tambah pengguna')).toBeNull(); expect(screen.getByRole('button', { name: 'Keluar' })).toBeTruthy();
  });
  it('ADMIN run scope rejects an OFFICER operation locally; unwrapped stale401 after role change is inert', async () => {
    const old = deferred<Response>(); let current = auth(); let operationCalls = 0;
    fetchMock.mockImplementation(async path => String(path) === '/api/auth/me' ? json(current) : old.promise);
    function Controls() {
      const { run, read, retry } = useAuth();
      return createElement('div', null,
        createElement('button', { onClick: () => { void read(async () => { const response = await old.promise; if (response.status === 401) throw new ApiError('Sesi lama', 401); }).catch(() => {}); } }, 'Start old read'),
        createElement('button', { onClick: retry }, 'Refresh identity'),
        createElement('button', { onClick: () => { void run(async () => { operationCalls++; return true; }, () => {}, 'ADMIN').catch(() => {}); } }, 'Scoped operation'));
    }
    mount('/admin/users', createElement(Controls)); await screen.findByText('Memuat pengguna…'); fireEvent.click(screen.getByRole('button', { name: 'Start old read' }));
    current = auth('OFFICER'); fireEvent.click(screen.getByRole('button', { name: 'Refresh identity' })); await screen.findByRole('heading', { name: 'Akses ditolak (403)' });
    fireEvent.click(screen.getByRole('button', { name: 'Scoped operation' })); expect(operationCalls).toBe(0);
    await act(async () => old.resolve(failure(401))); expect(screen.getByTestId('path').textContent).toBe('/admin/users'); expect(screen.queryByRole('heading', { name: 'Masuk' })).toBeNull();
  });
  it('expiry during pending ADMIN mutation clears data/credentials and ignores late signed_out success', async () => {
    vi.useFakeTimers();
    const state = auth(); state.session.expires_at = Math.floor(Date.now() / 1000) + 10;
    const pending = deferred<Response>(); let signal: AbortSignal | undefined;
    routes((path, init) => { if (init.method === 'POST') { signal = init.signal!; return pending.promise; } return path.endsWith('/sessions?limit=20') ? json({ sessions: [session()], next_cursor: null }) : json(user()); }, state);
    await act(async () => { mount(detail); });
    fireEvent.click(screen.getByRole('button', { name: 'Reset kata sandi' })); const input = password(); fireEvent.change(input, { target: { value: 'x' } }); fireEvent.submit(input.form!);
    await act(async () => { await vi.advanceTimersByTimeAsync(11000); }); expect(input.value).toBe(''); expect(signal?.aborted).toBe(true);
    expect(screen.getByRole('heading', { name: 'Masuk' })).toBeTruthy(); expect(screen.queryByRole('heading', { name: user().username })).toBeNull();
    await act(async () => pending.resolve(json({ user: user(), signed_out: true }))); expect(screen.getByTestId('path').textContent).toBe('/login');
  });
  it.each(['success', '401'] as const)('path change clears field/data and aborts pending mutation; ignores late%s', async result => {
    const pending = deferred<Response>(); let mutationSignal: AbortSignal | undefined;
    routes((path, init) => { if (init.method === 'POST') { mutationSignal = init.signal!; return pending.promise; } return path.endsWith('/sessions?limit=20') ? json({ sessions: [session(path.includes(uuid(9)) ? 9 : 3)], next_cursor: null }) : json(user(path.includes(uuid(9)) ? uuid(9) : target)); });
    mount(detail, createElement(NavigateTest, { to: `/admin/users/${uuid(9)}` })); const input = await openPassword(); fireEvent.change(input, { target: { value: 'x' } }); await confirm();
    await userEvent.click(screen.getByRole('button', { name: 'Test navigation' })); expect(mutationSignal?.aborted).toBe(true); expect(input.value).toBe(''); expect(screen.queryByRole('heading', { name: user().username })).toBeNull();
    await act(async () => pending.resolve(result === '401' ? failure(401) : json({ user: user(), signed_out: true })));
    await screen.findByRole('heading', { name: user(uuid(9)).username }); expect(screen.getByTestId('path').textContent).toBe(`/admin/users/${uuid(9)}`);
  });
  it.each(['role', 'account'] as const)('auth%s change clears data/ref before paint, aborts read and suppresses stale401', async kind => {
    const initial = auth(), next = auth(kind === 'role' ? 'OFFICER' : 'ADMIN', kind === 'role' ? actor : uuid(8)); const pending = deferred<Response>(); let phase = 0; let staleSignal: AbortSignal | undefined; let observed = false;
    fetchMock.mockImplementation(async (input, init) => { const path = String(input); if (path === '/api/auth/me') { const state = phase ? next : initial; if (phase) phase = 2; return json(state); } if (phase === 1 && path.startsWith(BASE)) { staleSignal = init!.signal!; return pending.promise; } return path.endsWith('/sessions?limit=20') ? json({ sessions: [session()], next_cursor: null }) : json(user()); });
    let input: HTMLInputElement | undefined;
    mount(detail, createElement(Probe, { observe: state => { if (state && state !== initial && (state.user.role !== initial.user.role || state.user.id !== initial.user.id)) { observed = true; expect(input?.value).toBe(''); expect(staleSignal?.aborted).toBe(true); expect(screen.queryByRole('region', { name: 'Konfirmasi tindakan' })).toBeNull(); } } }));
    input = await openPassword(); fireEvent.change(input, { target: { value: 'secret' } }); phase = 1; fireEvent.click(screen.getByRole('button', { name: 'Muat ulang detail' })); fireEvent(window, new Event('focus')); await waitFor(() => expect(observed).toBe(true)); phase = 2;
    await act(async () => pending.resolve(failure(401))); expect(screen.getByTestId('path').textContent).toBe(detail); expect(screen.queryByRole('heading', { name: 'Masuk' })).toBeNull();
    if (kind === 'role') await screen.findByRole('heading', { name: 'Akses ditolak (403)' });
  });
  it('403 after pending mutation drops metadata before exposing denial; retains current auth', async () => {
    const pending = deferred<Response>(); routes((path, init) => init.method === 'POST' ? pending.promise : path.endsWith('/sessions?limit=20') ? json({ sessions: [session()], next_cursor: null }) : json(user())); mount(detail);
    const input = await openPassword(); fireEvent.change(input, { target: { value: 'x' } }); await confirm(); fireEvent(window, new Event('focus'));
    await act(async () => pending.resolve(failure(403, 'AUTHORIZATION_ERROR'))); await screen.findByText('Akses ditolak (403)'); expect(screen.queryByRole('heading', { name: user().username })).toBeNull(); expect(screen.queryByRole('list', { name: 'Sesi perangkat pengguna' })).toBeNull();
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/me')).toHaveLength(1); expect(screen.getByRole('button', { name: 'Keluar' })).toBeTruthy();
  });
  it('passwords/metadata never persist/log and global history remains the existing view', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem'); const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method));
    routes(); mount(detail); const input = await openPassword(); await userEvent.type(input, 'synthetic-secret'); await userEvent.click(screen.getByRole('link', { name: 'Riwayat' })); await screen.findByText('Belum ada sesi razia.');
    expect(input.value).toBe(''); expect(storage).not.toHaveBeenCalled(); for (const log of logs) expect(log).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
  });
});
