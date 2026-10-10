// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import { AuthProvider } from '../src/auth';
import { REQUEST_TIMEOUT_MS, type AuthState, type RaidSession } from '../src/lib/api';

const location = { id: '11111111-1111-4111-8111-111111111111', name: 'Lokasi sintetis' };
const raid: RaidSession = { id: '22222222-2222-4222-8222-222222222222', location, lane: 'arah pusat kota', status: 'ACTIVE', started_at: 1791331200, closed_at: null };
const auth = (active: RaidSession | null = raid): AuthState => ({ user: { id: '33333333-3333-4333-8333-333333333333', username: 'synthetic.officer', role: 'OFFICER' }, session: { expires_at: Math.floor(Date.now() / 1000) + 3600 }, active_raid_session: active });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const failure = (status: number, code: string, requestId = 'req-error') => json({ error: { code, message: 'Pesan layanan sintetis', request_id: requestId } }, status);
const vehicle = (nopol = 'DH1234ZZ', patch: Record<string, unknown> = {}) => ({ nopol, owner_name: 'Pemilik Sintetis', brand: 'Merek Sintetis', type: 'Tipe Sintetis', color: 'Warna Sintetis', tax_due_date: '2026-10-07', stnk_due_date: '2027-03-01', tax_status: 'EXPIRED', stnk_status: 'ACTIVE', ...patch });
const found = (nopol = 'DH1234ZZ', patch: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => json({ outcome: 'FOUND', vehicle: vehicle(nopol, patch), source: 'LIVE', fetched_at: '2026-10-06T16:30:05.000Z', evaluated_on: '2026-10-07', request_id: 'req-found', ...extra });
const sensitive = { NIK: 'SENSITIVE_NIK', Alamat: 'SENSITIVE_ADDRESS', NoRangka: 'SENSITIVE_CHASSIS', NoMesin: 'SENSITIVE_ENGINE', NoBPKB: 'SENSITIVE_BPKB', NOPOL_EKS: 'SENSITIVE_EKS', Kohir: 'SENSITIVE_KOHIR' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }

type Lookup = (nopol: string, init: RequestInit) => Promise<Response> | Response;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let lookupSignals: AbortSignal[];
function routes(me: AuthState | Response, lookup: Lookup, active: unknown = { active_raid_session: raid }) {
  fetchMock.mockImplementation(async (input, init) => {
    if (input === '/api/auth/me') return me instanceof Response ? me : json(me);
    if (input === '/api/vehicle-lookups') {
      lookupSignals.push(init!.signal!);
      return lookup((JSON.parse(String(init!.body)) as { nopol: string }).nopol, init!);
    }
    if (input === '/api/raid-sessions/active') return json(active);
    if (input === '/api/locations') return json({ locations: [location] });
    if (input === '/api/history/raid-sessions') return json({ raid_sessions: [], next_cursor: null });
    // Separate Phase 5 panel has empty synthetic data; lookup assertions remain scoped to Phase 4.
    if (String(input).endsWith('/checks?limit=10')) return json({ checks: [], next_cursor: null });
    if (String(input).endsWith('/summary')) return json({ raid_session: { ...raid, owner: me instanceof Response ? auth().user : me.user }, summary: { total_checks: 0, found: 0, not_found: 0, tax_active: 0, tax_expired: 0, tax_unknown: 0 } });
    if (input === '/api/auth/logout') return new Response(null, { status: 204 });

    throw new Error(`Unexpected route ${String(input)}`);
  });
}
const lookupCalls = () => fetchMock.mock.calls.filter(([path]) => path === '/api/vehicle-lookups');
function Path() { return createElement('output', { 'data-testid': 'path' }, useLocation().pathname); }
function mount(path = '/razia/scanner') {
  return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(AuthProvider, null, createElement(App), createElement(Path))));
}
const field = () => screen.getByLabelText('Nomor polisi (NOPOL)') as HTMLInputElement;
// The test harness renders an <output> (implicit role=status) for the path, so select the scanner region by ID.
const lookupStatus = () => { const node = document.getElementById('lookup-status')!; expect(node.getAttribute('role')).toBe('status'); return node; };
async function ready(me: AuthState = auth(), lookup: Lookup = nopol => found(nopol), active?: unknown) {
  routes(me, lookup, active); mount();
  return await screen.findByLabelText('Nomor polisi (NOPOL)') as HTMLInputElement;
}
async function search(value: string) {
  const user = userEvent.setup();
  await user.clear(field());
  await user.type(field(), `${value}{Enter}`);
  return user;
}

beforeEach(() => { fetchMock = vi.fn<typeof fetch>(); lookupSignals = []; vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('scanner shell and navigation', () => {
  it('keeps fresh login heading non-focusable and tabs through the form controls in order', async () => {
    fetchMock.mockResolvedValue(failure(401, 'AUTHENTICATION_ERROR')); mount('/login');
    const heading = screen.getByRole('heading', { level: 1, name: 'Masuk' });
    expect(heading.hasAttribute('tabindex')).toBe(false); expect(heading.tabIndex).toBe(-1);
    expect(document.activeElement).not.toBe(heading);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Masuk' }) as HTMLButtonElement).disabled).toBe(false));
    expect(document.activeElement).not.toBe(heading); expect(screen.queryByRole('alert')).toBeNull();
    const user = userEvent.setup();
    const username = screen.getByLabelText('Nama pengguna');
    const password = screen.getByLabelText('Kata sandi') as HTMLInputElement;
    const toggle = screen.getByRole('button', { name: 'Tampilkan kata sandi' });
    const login = screen.getByRole('button', { name: 'Masuk' });
    for (const control of [username, password, toggle, login]) { await user.tab(); expect(document.activeElement).toBe(control); }
    await user.tab({ shift: true }); expect(document.activeElement).toBe(toggle);
    await user.keyboard('{Enter}'); expect(password.type).toBe('text'); expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await user.keyboard('{Enter}'); expect(password.type).toBe('password'); expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/auth/login')).toBe(false);
    expect(heading.hasAttribute('tabindex')).toBe(false); expect(document.activeElement).not.toBe(heading);
  });
  it('places one session header after the loaded history panel inside main and preserves account/logout controls', async () => {
    const registration = Object.assign(new EventTarget(), { waiting: null, installing: null });
    const register = vi.fn().mockResolvedValue(registration);
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', Object.create(navigator, { serviceWorker: { configurable: true, value: { register, controller: null } } }));
    const owner = auth();
    routes(owner, nopol => found(nopol));
    const defaultRoutes = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => String(input).endsWith('/checks?limit=10')
      ? Promise.resolve(json({ checks: [{ id: '44444444-4444-4444-8444-444444444444', nopol: 'DH1823HJ', outcome: 'FOUND', tax_status: 'ACTIVE', stnk_status: 'ACTIVE', source: 'CACHE', checked_at: raid.started_at }], next_cursor: null }))
      : defaultRoutes(input, init));
    mount();
    const history = await screen.findByRole('list', { name: 'Pengecekan terbaru' });
    const heading = screen.getByRole('heading', { name: 'Riwayat sesi ini' });
    const panel = heading.closest('section')!;
    const main = screen.getByRole('main');
    const headers = document.querySelectorAll('header');
    expect(headers).toHaveLength(1);
    const header = headers[0]!;
    const footer = main.querySelector('[data-session-controls-footer]')!;
    expect(footer.className).toBe('scanner-session-controls');
    expect(main.lastElementChild).toBe(footer);
    expect(footer.lastElementChild).toBe(header);
    expect(main.contains(panel)).toBe(true); expect(main.contains(header)).toBe(true);
    for (const node of [heading, history, panel]) expect(node.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelectorAll('.session-indicator')).toHaveLength(1);
    expect(within(header).getByText('SESI AKTIF')).toBeTruthy();
    expect(document.querySelectorAll('.account-disclosure')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Keluar' })).toHaveLength(1);
    const disclosure = header.querySelector('details')!;
    const account = within(header).getByText('Akun').closest('summary')!;
    expect(disclosure.open).toBe(false);
    await userEvent.click(account);
    expect(disclosure.open).toBe(true);
    expect(within(header).getByText(owner.user.username)).toBeTruthy();
    expect(disclosure.querySelector('.account-panel .pwa-controls')).not.toBeNull();
    account.focus(); expect(document.activeElement).toBe(account);
    const logout = within(header).getByRole('button', { name: 'Keluar' });
    expect(logout.className).toContain('min-h-12');
    expect(logout.getAttribute('aria-describedby')).toBe('logout-help');
    const nav = screen.getByRole('navigation', { name: 'Navigasi utama' });
    expect(main.contains(nav)).toBe(false);
    expect(header.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(logout);
    await screen.findByRole('heading', { name: 'Masuk' });
    const calls = fetchMock.mock.calls.filter(([path]) => path === '/api/auth/logout');
    expect(calls).toHaveLength(1); expect(calls[0]![1]!.method).toBe('POST'); expect(calls[0]![1]!.body).toBe('{}');
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/close'))).toBe(false);
  });
  it.each(['/razia/setup', '/history'])('keeps the header before main and default heading focus on %s', async path => {
    routes(auth(), nopol => found(nopol)); mount(path);
    const heading = await screen.findByRole('heading', { level: 1, name: path === '/history' ? 'Riwayat' : 'Sesi razia' });
    const main = screen.getByRole('main');
    const headers = document.querySelectorAll('header');
    expect(headers).toHaveLength(1);
    const header = headers[0]!;
    expect(main.contains(header)).toBe(false); expect(main.previousElementSibling).toBe(header);
    expect(header.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('[data-session-controls-footer]')).toBeNull();
    expect(header.querySelector('.account-disclosure')).not.toBeNull();
    expect(document.querySelectorAll('.session-indicator')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Keluar' })).toHaveLength(1);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
  it.each([true, false])('uses one fixed bottom navigation with safe-area and content clearance (active=%s)', async active => {
    const input = await ready(auth(active ? raid : null));
    const nav = screen.getByRole('navigation', { name: 'Navigasi utama' });
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    for (const token of ['fixed', 'inset-x-0', 'bottom-0', 'z-20', 'bg-background', 'bottom-navigation']) expect(nav.className.split(' ')).toContain(token);
    expect(nav.closest('header')).toBeNull();
    const row = nav.firstElementChild!;
    for (const token of ['flex', 'w-full', 'max-w-lg', 'gap-2', 'px-4']) expect(row.className.split(' ')).toContain(token);
    expect(row.className).not.toContain('flex-wrap');
    expect(row.children).toHaveLength(3);
    expect([...row.children].map(control => control.textContent)).toEqual(['Scanner', 'Sesi', 'Riwayat']);
    expect(within(nav).getByRole('link', { name: 'Sesi' }).getAttribute('href')).toBe('/razia/setup');
    expect(within(nav).getByRole('link', { name: 'Riwayat' }).getAttribute('href')).toBe('/history');
    expect(within(nav).getByRole('link', { name: 'Scanner' }).getAttribute('href')).toBe('/razia/scanner');
    expect(within(nav).queryByRole('button', { name: 'Keluar' })).toBeNull();
    const logout = screen.getAllByRole('button', { name: 'Keluar' });
    expect(logout).toHaveLength(1); expect(logout[0]!.closest('header')).not.toBeNull();
    for (const control of [...row.children]) {
      expect(control.classList.contains('nav-link')).toBe(true);
      expect(control.getAttribute('aria-current')).toBe(control.textContent === 'Scanner' ? 'page' : null);
      expect(control.classList.contains('active')).toBe(control.textContent === 'Scanner');
    }
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    const shell = nav.parentElement!;
    expect(shell.className).toContain('pb-[calc(6rem+env(safe-area-inset-bottom,0px))]');
    expect(screen.getByRole('main').parentElement).toBe(shell);
    expect(screen.getByRole('main').contains(nav)).toBe(false);
    expect(screen.getByRole('main').contains(input)).toBe(true);
    expect(input.closest('form')!.parentElement!.className).toBe('scanner-search');
    if (active) {
      expect(within(nav).getByRole('link', { name: 'Scanner' }).getAttribute('aria-current')).toBe('page');
      await userEvent.click(within(nav).getByRole('link', { name: 'Sesi' }));
      await screen.findByRole('heading', { name: 'Sesi aktif' });
      expect(screen.getByRole('navigation', { name: 'Navigasi utama' }).parentElement!.className).toContain('pb-[calc(6rem+env(safe-area-inset-bottom,0px))]');
      expect(screen.getByRole('link', { name: 'Sesi' }).getAttribute('aria-current')).toBe('page');
      expect(screen.getByRole('link', { name: 'Scanner' }).getAttribute('aria-current')).toBeNull();
    }
  });
  it('renders initial state with autofocus, input attributes, raid context and title', async () => {
    const input = await ready();
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('autocapitalize')).toBe('characters');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('inputmode')).toBe('text');
    expect(input.getAttribute('enterkeyhint')).toBe('search');
    // Preserve the complete pasted input so the pre-normalization 64-character rule can reject it.
    expect(input.hasAttribute('maxlength')).toBe(false);
    expect(input.className).toContain('nopol-input');
    expect(input.disabled).toBe(false);
    expect(screen.getByText(/Lokasi sintetis · Jalur arah pusat kota/)).toBeTruthy();
    expect(screen.getByRole('search', { name: 'Cari kendaraan' })).toBeTruthy();
    expect(lookupStatus().textContent).toBe('');
    expect(lookupStatus().className).toBe('sr-only'); expect(lookupStatus().hasAttribute('hidden')).toBe(false);
    expect(lookupStatus().getAttribute('aria-hidden')).toBeNull();
    const scanner = screen.getByRole('region', { name: 'Scanner' });
    expect(scanner.classList.contains('gap-3')).toBe(true); expect(scanner.classList.contains('gap-4')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hapus NOPOL' })).toBeNull();
    expect(document.title).toBe('Scanner — Razia SAMSAT');
    expect(screen.getByRole('link', { name: 'Scanner' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Sesi' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('button', { name: 'Keluar' })).toBeTruthy();
    expect(lookupCalls()).toHaveLength(0);
  });
  it('disables input without an active raid and links to setup', async () => {
    const input = await ready(auth(null));
    expect(input.disabled).toBe(true);
    expect(screen.getByText('Belum ada sesi razia aktif.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Buka sesi razia' }).getAttribute('href')).toBe('/razia/setup');
    expect(screen.getByRole('link', { name: 'Scanner' }).getAttribute('href')).toBe('/razia/scanner');
    fireEvent.change(input, { target: { value: 'DH1234ZZ' } }); fireEvent.submit(input.form!);
    expect(lookupCalls()).toHaveLength(0);
  });
  it('always exposes Scanner navigation and links active setup to scanner', async () => {
    routes(auth(null), nopol => found(nopol)); const view = mount('/razia/setup');
    await screen.findByLabelText('Jalur');
    expect(screen.getByRole('link', { name: 'Scanner' }).getAttribute('href')).toBe('/razia/scanner');
    expect(screen.getByRole('link', { name: 'Sesi' }).getAttribute('aria-current')).toBe('page');
    expect(document.title).toBe('Sesi razia — Razia SAMSAT');
    view.unmount();
    routes(auth(), nopol => found(nopol)); mount('/razia/setup');
    await screen.findByRole('heading', { name: 'Sesi aktif' });
    expect(screen.queryByText(/Scanner belum tersedia/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Scanner' }).getAttribute('href')).toBe('/razia/scanner');
    expect(screen.getByRole('link', { name: 'Scanner' }).getAttribute('aria-current')).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: 'Buka scanner' }));
    await screen.findByLabelText('Nomor polisi (NOPOL)');
    expect(screen.getByTestId('path').textContent).toBe('/razia/scanner');
  });
  it.each([[raid, '/razia/scanner'], [null, '/razia/setup']] as const)('redirects root by active raid %#', async (active, target) => {
    routes(auth(active), nopol => found(nopol)); mount('/');
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe(target));
  });
  it('redirects login with an active raid to scanner', async () => {
    fetchMock.mockImplementation(async input => {
      if (input === '/api/auth/me') return failure(401, 'AUTHENTICATION_ERROR');
      if (input === '/api/auth/login') return json(auth());
      throw new Error('unexpected');
    });
    mount('/login');
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Masuk' });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Masuk' }) as HTMLButtonElement).disabled).toBe(false));
    await user.type(screen.getByLabelText('Nama pengguna'), 'synthetic.officer');
    await user.type(screen.getByLabelText('Kata sandi'), 'synthetic-password');
    await user.click(screen.getByRole('button', { name: 'Masuk' }));
    await screen.findByLabelText('Nomor polisi (NOPOL)');
    expect(screen.getByTestId('path').textContent).toBe('/razia/scanner');
  });
});

describe('scanner lookup flow', () => {
  it('debounces 600 ms and only issues valid lookups', async () => {
    const input = await ready();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(input, { target: { value: 'dh' } });
    expect(screen.getByText(/Format NOPOL belum valid/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(lookupCalls()).toHaveLength(0);
    fireEvent.change(input, { target: { value: 'dh 1234' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fireEvent.change(input, { target: { value: 'dh 1234 zz' } });
    expect(screen.queryByText(/Format NOPOL belum valid/)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(599); });
    expect(lookupCalls()).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(lookupCalls()).toHaveLength(1);
    expect(lookupCalls()[0]![1]!.body).toBe('{"nopol":"DH1234ZZ"}');
    vi.useRealTimers();
    await screen.findByRole('heading', { name: 'DH1234ZZ' });
    expect(lookupCalls()).toHaveLength(1);
  });
  it.each(['DH-1234', 'DH.1234ZZ', 'DHA1234', 'DH12345', 'DH1234ZZZZ', '1234'])('shows hint without request for invalid %s, including Enter', async value => {
    await ready();
    await search(value);
    expect(screen.getByText(/Format NOPOL belum valid/)).toBeTruthy();
    expect(field().getAttribute('aria-invalid')).toBe('true');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(lookupCalls()).toHaveLength(0);
  });
  it('Enter looks up immediately, cancels debounce and does not duplicate', async () => {
    const pending = deferred<Response>();
    const input = await ready(auth(), () => pending.promise);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(input, { target: { value: 'DH1234ZZ' } });
    fireEvent.submit(input.form!);
    expect(lookupCalls()).toHaveLength(1);
    expect(lookupStatus().textContent).toContain('Mencari data DH1234ZZ');
    fireEvent.submit(input.form!);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(lookupCalls()).toHaveLength(1);
    vi.useRealTimers();
    await act(async () => pending.resolve(found()));
    await screen.findByRole('heading', { name: 'DH1234ZZ' });
    fireEvent.submit(input.form!);
    expect(lookupCalls()).toHaveLength(1);
    expect(document.activeElement).toBe(input);
  });
  it('keeps the same live region mounted, compact when idle and visible while queued or loading', async () => {
    const pending = deferred<Response>();
    const input = await ready(auth(), () => pending.promise);
    const status = lookupStatus();
    expect(status.className).toBe('sr-only'); expect(status.textContent).toBe('');
    fireEvent.change(input, { target: { value: 'DH1234ZZ' } });
    expect(lookupStatus()).toBe(status); expect(status.classList.contains('sr-only')).toBe(false);
    expect(status.classList.contains('min-h-5')).toBe(true); expect(status.textContent).toContain('Menunggu ketikan selesai');
    fireEvent.submit(input.form!);
    expect(lookupStatus()).toBe(status); expect(status.textContent).toContain('Mencari data DH1234ZZ');
    expect(status.classList.contains('sr-only')).toBe(false); expect(status.classList.contains('min-h-5')).toBe(true);
    expect(status.hasAttribute('hidden')).toBe(false); expect(status.getAttribute('aria-hidden')).toBeNull();
    expect(input.disabled).toBe(false); expect(lookupCalls()).toHaveLength(1);
    await act(async () => pending.resolve(found()));
    await screen.findByRole('heading', { name: 'DH1234ZZ' });
    expect(lookupStatus()).toBe(status); expect(status.textContent).toBe(''); expect(status.className).toBe('sr-only');
  });
  it.each(['LIVE', 'CACHE'] as const)('renders %s FOUND card with statuses and due dates without the removed scanner metadata', async source => {
    await ready(auth(), nopol => found(nopol, {}, { source }));
    await search('dh 1234 zz');
    const card = await screen.findByRole('article');
    expect(screen.getByRole('heading', { name: 'DH1234ZZ' })).toBeTruthy();
    for (const label of ['Nama pemilik', 'Merek', 'Tipe', 'Warna']) expect(screen.getByText(label)).toBeTruthy();
    for (const value of ['Pemilik Sintetis', 'Merek Sintetis', 'Tipe Sintetis', 'Warna Sintetis']) expect(screen.getByText(value)).toBeTruthy();
    const tax = screen.getByRole('region', { name: 'Status Pajak' });
    const stnk = screen.getByRole('region', { name: 'Status STNK' });
    expect(tax.textContent).toContain('MATI'); expect(tax.textContent).toContain('07 Okt 2026');
    expect(tax.querySelector('[data-status]')!.getAttribute('data-status')).toBe('EXPIRED');
    expect(tax.querySelector('[data-status] svg[aria-hidden="true"]')).not.toBeNull();
    expect(stnk.textContent).toContain('AKTIF'); expect(stnk.textContent).toContain('01 Mar 2027');
    expect(stnk.querySelector('[data-status]')!.getAttribute('data-status')).toBe('ACTIVE');
    expect(stnk.querySelector('[data-status] svg[aria-hidden="true"]')).not.toBeNull();
    expect(card.querySelector('.vehicle-metadata')).toBeNull();
    expect(card.textContent).not.toMatch(/Data langsung|Data cache|Diambil|Dievaluasi|Keputusan pemeriksaan tetap pada petugas/);
    expect(card.querySelector('time')).toBeNull();
    expect(card.closest('[aria-live="polite"]')).not.toBeNull();
    expect(document.activeElement).toBe(field());
    expect(screen.queryByText('Data kendaraan tidak ditemukan')).toBeNull();
  });
  it('renders UNKNOWN as neutral text without cache metadata', async () => {
    await ready(auth(), nopol => found(nopol, { tax_status: 'UNKNOWN', tax_due_date: null, stnk_status: 'UNKNOWN', stnk_due_date: null }, { source: 'CACHE' }));
    await search('DH1234ZZ');
    const tax = await screen.findByRole('region', { name: 'Status Pajak' });
    const badge = tax.querySelector('[data-status]')!;
    expect(badge.textContent).toBe('TIDAK DAPAT DITENTUKAN');
    expect(badge.className).not.toMatch(/bg-(red|emerald)-600/);
    expect(tax.textContent).toContain('Tidak tersedia');
    expect(screen.getByRole('region', { name: 'Status STNK' }).textContent).toContain('TIDAK DAPAT DITENTUKAN');
    const card = screen.getByRole('article');
    expect(card.querySelector('.vehicle-metadata')).toBeNull();
    expect(card.textContent).not.toMatch(/Data langsung|Data cache|Diambil|Dievaluasi|Keputusan pemeriksaan tetap pada petugas/);
  });
  it('shows NOT_FOUND distinctly with the requested normalized NOPOL', async () => {
    await ready(auth(), () => json({ outcome: 'NOT_FOUND', request_id: 'req-nf', message: 'SENSITIVE provider text' }));
    await search('dh 1 a');
    await screen.findByText('Data kendaraan tidak ditemukan');
    expect(screen.getByText('DH1A')).toBeTruthy();
    expect(screen.queryByText('Data kendaraan tidak dapat diambil')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toContain('SENSITIVE');
  });
  it.each([[400, 'INVALID_INPUT'], [413, 'PAYLOAD_TOO_LARGE']] as const)('shows validation message for %i %s', async (status, code) => {
    await ready(auth(), () => failure(status, code));
    await search('DH1234ZZ');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Periksa kembali format NOPOL');
    expect(alert.textContent).toContain('Pesan layanan sintetis');
    expect(alert.textContent).not.toContain('req-error');
    expect(screen.queryByText('Data kendaraan tidak ditemukan')).toBeNull();
    expect(document.activeElement).toBe(field());
  });
  it('handles RAID_SESSION_REQUIRED by reconciling active raid without creating one', async () => {
    await ready(auth(), () => failure(409, 'RAID_SESSION_REQUIRED'), { active_raid_session: null });
    await search('DH1234ZZ');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Sesi razia aktif diperlukan');
    await waitFor(() => expect(field().disabled).toBe(true));
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/raid-sessions/active')).toBe(true);
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/raid-sessions')).toBe(false);
    expect(screen.getByRole('link', { name: 'Buka sesi razia' }).getAttribute('href')).toBe('/razia/setup');
    expect(screen.getByRole('link', { name: 'Scanner' }).getAttribute('href')).toBe('/razia/scanner');
    expect(screen.queryByText('Data kendaraan tidak ditemukan')).toBeNull();
  });
  it('redirects to login on lookup 401', async () => {
    await ready(auth(), () => failure(401, 'AUTHENTICATION_ERROR'));
    await search('DH1234ZZ');
    await screen.findByRole('heading', { name: 'Masuk' });
    expect(screen.getByTestId('path').textContent).toBe('/login');
  });
  it.each([
    ['500', () => failure(500, 'INTERNAL_ERROR')], ['502', () => failure(502, 'UPSTREAM_ERROR')], ['502 malformed', () => failure(502, 'UPSTREAM_MALFORMED')],
    ['502 network', () => failure(502, 'UPSTREAM_NETWORK')], ['503', () => failure(503, 'UPSTREAM_BUSY')], ['504', () => failure(504, 'TIMEOUT')],
    ['403', () => failure(403, 'CSRF_REJECTED')], ['network', () => { throw new TypeError('offline'); }],
    ['invalid response', () => found('DH9999ZZ')], ['non-json', () => new Response('<html>', { status: 200 })],
  ] as const)('shows amber banner with retry for %s, never NOT_FOUND', async (_name, response) => {
    let calls = 0;
    await ready(auth(), nopol => ++calls === 1 ? response() : found(nopol));
    await search('DH1234ZZ');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Data kendaraan tidak dapat diambil');
    expect(alert.className).toContain('feedback-warning');
    expect(alert.textContent).not.toContain('ID permintaan:');
    if (_name !== 'network' && _name !== 'non-json' && _name !== 'invalid response') expect(alert.textContent).toContain('Pesan layanan sintetis');
    expect(screen.queryByText('Data kendaraan tidak ditemukan')).toBeNull();
    expect(document.activeElement).toBe(field());
    const retry = screen.getByRole('button', { name: 'Coba lagi' });
    expect(retry.className).toContain('min-h-12');
    await userEvent.click(retry);
    await screen.findByRole('heading', { name: 'DH1234ZZ' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(lookupCalls()).toHaveLength(2);
  });
  it('shows banner on client timeout', async () => {
    const input = await ready(auth(), (_nopol, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')))));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(input, { target: { value: 'DH1234ZZ' } }); fireEvent.submit(input.form!);
    await act(async () => { await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS); });
    vi.useRealTimers();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Data kendaraan tidak dapat diambil');
    expect(alert.textContent).toContain('terlalu lama');
    expect(lookupSignals[0]!.aborted).toBe(true);
  });
  it('clear button aborts, clears input/result/error and refocuses', async () => {
    const pending = deferred<Response>();
    await ready(auth(), () => pending.promise);
    const user = await search('DH1234ZZ');
    const clear = screen.getByRole('button', { name: 'Hapus NOPOL' });
    expect(clear.className).toBe('nopol-clear');
    expect(clear.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    await user.click(clear);
    expect(lookupSignals[0]!.aborted).toBe(true);
    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
    expect(lookupStatus().textContent).toBe('');
    await act(async () => pending.resolve(found()));
    expect(screen.queryByRole('article')).toBeNull();
    fetchMock.mockImplementation(async input => input === '/api/vehicle-lookups' ? failure(503, 'UPSTREAM_BUSY') : json(auth()));
    await search('DH1234ZZ');
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Hapus NOPOL' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
  });
  it('clears an old result as soon as the plate changes', async () => {
    await ready();
    const user = await search('DH1234ZZ');
    await screen.findByRole('article');
    await user.type(field(), '{Backspace}');
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByText('Pemilik Sintetis')).toBeNull();
  });
  it('clears result even for a whitespace edit and cancels queued lookup with X', async () => {
    await ready();
    await search('DH1234ZZ');
    await screen.findByRole('article');
    fireEvent.change(field(), { target: { value: 'DH1234ZZ ' } });
    expect(screen.queryByRole('article')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hapus NOPOL' }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(lookupCalls()).toHaveLength(1);
    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
  });
  it('clear removes a completed result and allows the same NOPOL again', async () => {
    await ready();
    const user = await search('DH1234ZZ');
    await screen.findByRole('article');
    await user.click(screen.getByRole('button', { name: 'Hapus NOPOL' }));
    expect(screen.queryByRole('article')).toBeNull();
    await search('DH1234ZZ');
    await screen.findByRole('article');
    expect(lookupCalls()).toHaveLength(2);
  });
  it('does not recompute backend status from due dates', async () => {
    await ready(auth(), nopol => found(nopol, { tax_status: 'ACTIVE', tax_due_date: '2000-01-01', stnk_status: 'EXPIRED', stnk_due_date: '2099-12-31' }));
    await search('DH1234ZZ');
    const tax = await screen.findByRole('region', { name: 'Status Pajak' });
    expect(tax.textContent).toContain('AKTIF');
    expect(screen.getByRole('region', { name: 'Status STNK' }).textContent).toContain('MATI');
  });
  it('rejects an overlength paste without truncating or normalizing it into a valid plate', async () => {
    await ready();
    const pasted = 'DH1234ZZ'.padEnd(65, ' ');
    const user = userEvent.setup();
    await user.click(field());
    await user.paste(pasted);
    expect(field().value).toBe(pasted);
    expect(screen.getByText(/Format NOPOL belum valid/).textContent).toContain('maksimal 64 karakter');
    fireEvent.submit(field().form!);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(lookupCalls()).toHaveLength(0);
  });
  it.each(['closed raid', 'different raid', 'same context refresh', 'changed session', 'changed role'] as const)('clears completed vehicle data after %s', async kind => {
    const initial = auth();
    await ready(initial);
    await search('DH1234ZZ');
    await screen.findByRole('article');
    const next = { ...initial, active_raid_session: kind === 'closed raid' ? null : kind === 'different raid' ? { ...raid, id: '44444444-4444-4444-8444-444444444444', lane: 'jalur baru' } : raid,
      session: { expires_at: initial.session.expires_at + (kind === 'changed session' ? 60 : 0) },
      user: { ...initial.user, role: kind === 'changed role' ? 'ADMIN' as const : initial.user.role } };
    routes(next, nopol => found(nopol));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
    expect(field().value).toBe('');
    expect(document.body.textContent).not.toContain('Pemilik Sintetis');
    expect(field().disabled).toBe(kind === 'closed raid');
    expect(lookupCalls()).toHaveLength(1);
  });
  it.each(['FOUND', '401', '502'] as const)('ignores late %s after a same-user raid/context refresh', async outcome => {
    const pending = deferred<Response>();
    const initial = auth();
    await ready(initial, () => pending.promise);
    await search('DH1234ZZ');
    const next = { ...initial, active_raid_session: { ...raid, id: '44444444-4444-4444-8444-444444444444', lane: 'jalur baru' } };
    routes(next, nopol => found(nopol));
    fireEvent(window, new Event('focus'));
    await screen.findByText(/Jalur jalur baru/);
    expect(lookupSignals[0]!.aborted).toBe(true);
    expect(field().value).toBe('');
    await act(async () => pending.resolve(outcome === 'FOUND' ? found() : failure(outcome === '401' ? 401 : 502, outcome === '401' ? 'AUTHENTICATION_ERROR' : 'UPSTREAM_ERROR')));
    expect(screen.getByTestId('path').textContent).toBe('/razia/scanner');
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    await search('DH2222BB');
    await screen.findByRole('heading', { name: 'DH2222BB' });
  });
  it('clears completed vehicle data immediately when logout starts, even if logout fails', async () => {
    const logout = deferred<Response>();
    await ready();
    await search('DH1234ZZ');
    await screen.findByRole('article');
    fetchMock.mockImplementation(async input => input === '/api/auth/logout' ? logout.promise : json(auth()));
    fireEvent.click(screen.getByRole('button', { name: 'Keluar' }));
    expect(screen.queryByRole('article')).toBeNull();
    expect(field().value).toBe('');
    expect(field().disabled).toBe(true);
    await act(async () => logout.resolve(failure(500, 'INTERNAL_ERROR')));
    await waitFor(() => expect(field().disabled).toBe(false));
    expect(screen.queryByRole('article')).toBeNull();
  });
  it('late lookup 401 during logout cannot cancel logout or restore vehicle data', async () => {
    const lookup = deferred<Response>(); const logout = deferred<Response>();
    await ready(auth(), () => lookup.promise);
    await search('DH1234ZZ');
    fetchMock.mockImplementation(async input => input === '/api/auth/logout' ? logout.promise : json(auth()));
    fireEvent.click(screen.getByRole('button', { name: 'Keluar' }));
    expect(lookupSignals[0]!.aborted).toBe(true);
    await act(async () => lookup.resolve(failure(401, 'AUTHENTICATION_ERROR')));
    expect(screen.getByTestId('path').textContent).toBe('/razia/scanner');
    expect((screen.getByRole('button', { name: 'Keluar' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => logout.resolve(new Response(null, { status: 204 })));
    await screen.findByRole('heading', { name: 'Masuk' });
    expect(screen.getByText(/Anda telah keluar/)).toBeTruthy();
  });
  it('stale responses cannot overwrite a newer lookup', async () => {
    const first = deferred<Response>(); const second = deferred<Response>();
    let calls = 0;
    await ready(auth(), () => ++calls === 1 ? first.promise : second.promise);
    await search('DH1111AA');
    await search('DH2222BB');
    expect(lookupSignals[0]!.aborted).toBe(true);
    await act(async () => second.resolve(found('DH2222BB')));
    await screen.findByRole('heading', { name: 'DH2222BB' });
    await act(async () => first.resolve(found('DH1111AA', { owner_name: 'Pemilik Lama' })));
    expect(screen.queryByText('Pemilik Lama')).toBeNull();
    expect(screen.getByRole('heading', { name: 'DH2222BB' })).toBeTruthy();
  });
  it.each(['clear', 'new plate'] as const)('ignores stale lookup 401 after %s without invalidating auth', async action => {
    const first = deferred<Response>();
    let calls = 0;
    await ready(auth(), nopol => ++calls === 1 ? first.promise : found(nopol));
    await search('DH1111AA');
    if (action === 'clear') await userEvent.click(screen.getByRole('button', { name: 'Hapus NOPOL' }));
    else { await search('DH2222BB'); await screen.findByRole('heading', { name: 'DH2222BB' }); }
    await act(async () => first.resolve(failure(401, 'AUTHENTICATION_ERROR')));
    expect(screen.getByTestId('path').textContent).toBe('/razia/scanner');
    expect(screen.queryByRole('alert')).toBeNull();
    if (action === 'clear') { expect(field().value).toBe(''); expect(screen.queryByRole('article')).toBeNull(); }
    else expect(screen.getByRole('heading', { name: 'DH2222BB' })).toBeTruthy();
  });
  it('ignores an in-flight lookup after an equivalent auth refresh', async () => {
    const pending = deferred<Response>();
    const initial = auth();
    await ready(initial, () => pending.promise);
    await search('DH1234ZZ');
    routes(initial, nopol => found(nopol));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(lookupSignals[0]!.aborted).toBe(true));
    await act(async () => pending.resolve(failure(401, 'AUTHENTICATION_ERROR')));
    expect(screen.getByTestId('path').textContent).toBe('/razia/scanner');
    expect(field().value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('active reconciliation 401 redirects to login through read()', async () => {
    await ready(auth(), () => failure(409, 'RAID_SESSION_REQUIRED'));
    fetchMock.mockImplementation(async input => input === '/api/vehicle-lookups' ? failure(409, 'RAID_SESSION_REQUIRED') : failure(401, 'AUTHENTICATION_ERROR'));
    await search('DH1234ZZ');
    await screen.findByRole('heading', { name: 'Masuk' });
    expect(screen.getByTestId('path').textContent).toBe('/login');
  });
  it('stale failure cannot replace a newer result', async () => {
    const first = deferred<Response>();
    let calls = 0;
    await ready(auth(), nopol => ++calls === 1 ? first.promise : found(nopol));
    await search('DH1111AA');
    await search('DH2222BB');
    await screen.findByRole('heading', { name: 'DH2222BB' });
    await act(async () => first.resolve(failure(502, 'UPSTREAM_ERROR')));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('never renders sensitive extras, stores data or logs to console', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method));
    await ready(auth(), nopol => found(nopol, sensitive, { ...sensitive, raw: sensitive }));
    await search('DH1234ZZ');
    await screen.findByRole('article');
    expect(document.body.textContent).not.toContain('SENSITIVE');
    expect(document.body.innerHTML).not.toContain('SENSITIVE');
    expect(storage).not.toHaveBeenCalled();
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
  });
  it('logout and unmount abort the in-flight lookup', async () => {
    await ready(auth(), () => new Promise(() => undefined));
    await search('DH1234ZZ');
    await userEvent.click(screen.getByRole('button', { name: 'Keluar' }));
    await screen.findByRole('heading', { name: 'Masuk' });
    expect(lookupSignals[0]!.aborted).toBe(true);
    cleanup();
    await ready(auth(), () => new Promise(() => undefined));
    await search('DH1234ZZ');
    cleanup();
    expect(lookupSignals[1]!.aborted).toBe(true);
  });
});
