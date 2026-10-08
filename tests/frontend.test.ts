// @vitest-environment jsdom
import { createElement, StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import { AuthProvider, useAuth } from '../src/auth';
import type { AuthState, RaidSession } from '../src/lib/api';

const location = { id: '11111111-1111-4111-8111-111111111111', name: 'Lokasi sintetis' };
const raid: RaidSession = { id: '22222222-2222-4222-8222-222222222222', location, lane: 'arah pusat kota', status: 'ACTIVE', started_at: 1791331200, closed_at: null };
const auth = (active: RaidSession | null = null): AuthState => ({ user: { id: '33333333-3333-4333-8333-333333333333', username: 'synthetic.officer', role: 'OFFICER' }, session: { expires_at: Math.floor(Date.now() / 1000) + 3600 }, active_raid_session: active });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const failure = (status: number, code = 'INTERNAL_ERROR') => json({ error: { code, message: 'Pesan layanan sintetis', request_id: 'req-synthetic' } }, status);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function Path() { return createElement('output', { 'data-testid': 'path' }, useLocation().pathname); }
function mount(path = '/razia/setup', strict = false) {
  const tree = createElement(MemoryRouter, { initialEntries: [path] }, createElement(AuthProvider, null, createElement(App), createElement(Path)));
  return render(strict ? createElement(StrictMode, null, tree) : tree);
}
function routes(me = auth(), locations: unknown = { locations: [location] }) {
  fetchMock.mockImplementation(async input => {
    if (input === '/api/auth/me') return json(me);
    if (input === '/api/locations') return json(locations);
    throw new Error(`Unexpected route ${input}`);
  });
}
async function loginFields() {
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Masuk' });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Masuk' }) as HTMLButtonElement).disabled).toBe(false));
  await user.type(screen.getByLabelText('Nama pengguna'), 'synthetic.officer');
  await user.type(screen.getByLabelText('Kata sandi'), 'synthetic-password');
  return user;
}
async function setupFields(lane = ' arah pusat kota ') {
  const user = userEvent.setup();
  await screen.findByRole('option', { name: location.name });
  await user.selectOptions(screen.getByLabelText('Lokasi'), location.id);
  await user.type(screen.getByLabelText('Jalur'), lane);
  return user;
}
beforeEach(() => { fetchMock = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('auth UI', () => {
  it('guards while initial auth is pending, then redirects on 401', async () => {
    const pending = deferred<Response>(); fetchMock.mockReturnValue(pending.promise); mount();
    expect(screen.getByText('Memeriksa sesi…').getAttribute('role')).toBe('status');
    expect(screen.queryByLabelText('Jalur')).toBeNull();
    await act(async () => pending.resolve(failure(401, 'AUTHENTICATION_ERROR')));
    await screen.findByRole('heading', { name: 'Masuk' });
    expect(screen.getByTestId('path').textContent).toBe('/login');
  });
  it.each(['500', '503', 'network'])('keeps initial %s failure recoverable and retries', async kind => {
    fetchMock.mockImplementationOnce(async () => { if (kind === 'network') throw new TypeError('offline'); return failure(Number(kind)); });
    mount();
    await screen.findByRole('heading', { name: 'Sesi belum dapat diperiksa' });
    expect(screen.getByTestId('path').textContent).toBe('/razia/setup');
    routes(); await userEvent.click(screen.getByRole('button', { name: 'Coba lagi' }));
    await screen.findByLabelText('Jalur');
  });
  it('logs in, clears rendered password and never stores tokens', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const pending = deferred<Response>();
    fetchMock.mockImplementation(async input => {
      if (input === '/api/auth/me') return failure(401, 'AUTHENTICATION_ERROR');
      if (input === '/api/auth/login') return pending.promise;
      return json({ locations: [location] });
    });
    mount('/login'); const user = await loginFields();
    const password = screen.getByLabelText('Kata sandi') as HTMLInputElement;
    await user.click(screen.getByRole('button', { name: 'Masuk' }));
    expect(password.value).toBe('');
    expect((screen.getByRole('button', { name: 'Sedang masuk…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve(json(auth())));
    await screen.findByLabelText('Jalur');
    expect(screen.getByTestId('path').textContent).toBe('/razia/setup');
    expect(storage).not.toHaveBeenCalled();
    expect(document.cookie).toBe('');
    expect(fetchMock.mock.calls.find(([path]) => path === '/api/auth/login')?.[1]?.body).toBe(JSON.stringify({ username: 'synthetic.officer', password: 'synthetic-password' }));
  });
  it.each([[401, 'INVALID_CREDENTIALS'], [409, 'SESSION_CONFLICT']] as const)('keeps login %s/%s on form with cleared password', async (status, code) => {
    fetchMock.mockImplementation(async input => input === '/api/auth/me' ? failure(401) : failure(status, code));
    mount('/login'); const user = await loginFields(); await user.click(screen.getByRole('button', { name: 'Masuk' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Pesan layanan sintetis');
    expect(alert.textContent).toContain('req-synthetic');
    if (code === 'SESSION_CONFLICT') expect(alert.textContent).toContain('Hubungi admin');
    expect((screen.getByLabelText('Kata sandi') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('path').textContent).toBe('/login');
    expect(document.activeElement).toBe(alert);
  });
  it('clears password on unmount without submitting', async () => {
    fetchMock.mockResolvedValue(failure(401)); const view = mount('/login'); await loginFields();
    const password = screen.getByLabelText('Kata sandi') as HTMLInputElement;
    view.unmount(); expect(password.value).toBe('');
  });
  it('logout is single-flight, clears auth, and does not close the active raid', async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation(async input => input === '/api/auth/me' ? json(auth(raid)) : input === '/api/auth/logout' ? pending.promise : json({ locations: [location] }));
    mount(); await screen.findByRole('heading', { name: 'Sesi aktif' });
    const button = screen.getByRole('button', { name: 'Keluar' });
    fireEvent.click(button); fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/logout')).toHaveLength(1);
    await act(async () => pending.resolve(new Response(null, { status: 204 })));
    await screen.findByRole('heading', { name: 'Masuk' });
    expect(screen.queryByRole('heading', { name: 'Sesi aktif' })).toBeNull();
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/close'))).toBe(false);
  });
  it('expires proactively and redirects', async () => {
    vi.useFakeTimers(); routes();
    await act(async () => { mount(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3600001); });
    expect(screen.getByRole('heading', { name: 'Masuk' })).toBeTruthy();
    expect(screen.getByText('Sesi berakhir. Silakan masuk kembali.')).toBeTruthy();
  });
  it('revalidates on focus; 401 clears existing auth', async () => {
    routes(); mount(); await screen.findByLabelText('Jalur');
    fetchMock.mockResolvedValue(failure(401)); fireEvent(window, new Event('focus'));
    await screen.findByRole('heading', { name: 'Masuk' });
  });
  it('keeps authenticated UI on transient focus revalidation failure', async () => {
    routes(); mount(); await setupFields('jalur barat');
    fetchMock.mockResolvedValue(failure(503)); fireEvent(window, new Event('focus'));
    await screen.findByRole('button', { name: 'Periksa sesi lagi' });
    expect(screen.getByTestId('path').textContent).toBe('/razia/setup');
    expect((screen.getByLabelText('Jalur') as HTMLInputElement).value).toBe('jalur barat');
  });
  it('strict mount cancels deferred initialization without extra requests', async () => {
    routes(); const view = mount('/razia/setup', true); await screen.findByLabelText('Jalur');
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/me')).toHaveLength(1);
    view.unmount();
  });
});

describe('raid UI', () => {
  it('shows location failure, retries and preserves typed lane', async () => {
    fetchMock.mockImplementation(async input => input === '/api/auth/me' ? json(auth()) : failure(503));
    mount(); await screen.findByRole('button', { name: 'Muat lokasi lagi' });
    expect(screen.queryByText(/Belum ada lokasi aktif/)).toBeNull();
    await userEvent.type(screen.getByLabelText('Jalur'), 'jalur timur');
    routes(); await userEvent.click(screen.getByRole('button', { name: 'Muat lokasi lagi' }));
    await screen.findByRole('option', { name: location.name });
    expect((screen.getByLabelText('Jalur') as HTMLInputElement).value).toBe('jalur timur');
  });
  it('shows empty locations explicitly and disables start', async () => {
    routes(auth(), { locations: [] }); mount(); await screen.findByText(/Belum ada lokasi aktif/);
    expect((screen.getByRole('button', { name: 'Mulai sesi razia' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it.each(['OFFICER', 'ADMIN'] as const)('starts and closes own free-form lane for %s without duplicate pending requests', async role => {
    const state = auth(); state.user.role = role;
    const start = deferred<Response>(); const close = deferred<Response>();
    fetchMock.mockImplementation(async input => {
      if (input === '/api/auth/me') return json(state);
      if (input === '/api/locations') return json({ locations: [location] });
      if (input === '/api/raid-sessions') return start.promise;
      if (String(input).endsWith('/close')) return close.promise;
      throw new Error('unexpected route');
    });
    mount(); await setupFields();
    const button = screen.getByRole('button', { name: 'Mulai sesi razia' });
    fireEvent.click(button); fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Keluar' }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/raid-sessions')).toHaveLength(1);
    expect(fetchMock.mock.calls.find(([path]) => path === '/api/raid-sessions')?.[1]?.body).toBe(JSON.stringify({ location_id: location.id, lane: 'arah pusat kota' }));
    await act(async () => start.resolve(json(raid, 201)));
    await screen.findByRole('heading', { name: 'Sesi aktif' });
    expect(screen.getByText(/WITA/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Scanner' }).getAttribute('href')).toBe('/razia/scanner');
    const closeButton = screen.getByRole('button', { name: 'Tutup sesi razia' });
    fireEvent.click(closeButton); fireEvent.click(closeButton);
    expect((closeButton as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/close'))).toHaveLength(1);
    await act(async () => close.resolve(json({ ...raid, status: 'CLOSED', closed_at: raid.started_at + 60 })));
    await screen.findByRole('button', { name: 'Mulai sesi razia' });
    expect(screen.getByText(/Sesi razia ditutup:/)).toBeTruthy();
    expect((screen.getByLabelText('Jalur') as HTMLInputElement).value).toBe(' arah pusat kota ');
  });
  it('rejects invalid lane without a POST', async () => {
    routes(); mount(); await setupFields('x'.repeat(101));
    await userEvent.click(screen.getByRole('button', { name: 'Mulai sesi razia' }));
    await screen.findByRole('alert'); expect(fetchMock.mock.calls.some(([path]) => path === '/api/raid-sessions')).toBe(false);
  });
  it('re-fetches active after start 409 from another device', async () => {
    fetchMock.mockImplementation(async input => {
      if (input === '/api/auth/me') return json(auth());
      if (input === '/api/locations') return json({ locations: [location] });
      if (input === '/api/raid-sessions') return failure(409, 'RAID_SESSION_ALREADY_ACTIVE');
      return json({ active_raid_session: raid });
    });
    mount(); await setupFields(); await userEvent.click(screen.getByRole('button', { name: 'Mulai sesi razia' }));
    await screen.findByRole('heading', { name: 'Sesi aktif' });
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/raid-sessions/active')).toBe(true);
    expect(screen.getByText(/perangkat lain/)).toBeTruthy();
  });
  it.each(['locations', 'start', 'close'])('clears auth on protected %s 401', async operation => {
    fetchMock.mockImplementation(async input => {
      if (input === '/api/auth/me') return json(auth(operation === 'close' ? raid : null));
      if (input === '/api/locations' && operation !== 'locations') return json({ locations: [location] });
      return failure(401, 'AUTHENTICATION_ERROR');
    });
    mount();
    if (operation === 'start') { await setupFields(); await userEvent.click(screen.getByRole('button', { name: 'Mulai sesi razia' })); }
    if (operation === 'close') { await screen.findByRole('heading', { name: 'Sesi aktif' }); await userEvent.click(screen.getByRole('button', { name: 'Tutup sesi razia' })); }
    await screen.findByRole('heading', { name: 'Masuk' });
    expect(screen.getByTestId('path').textContent).toBe('/login');
  });
  it('requires reconciliation after an ambiguous network failure', async () => {
    fetchMock.mockImplementation(async input => {
      if (input === '/api/auth/me') return json(auth());
      if (input === '/api/locations') return json({ locations: [location] });
      if (input === '/api/raid-sessions') throw new TypeError('offline');
      return json({ active_raid_session: raid });
    });
    mount(); await setupFields(); await userEvent.click(screen.getByRole('button', { name: 'Mulai sesi razia' }));
    await screen.findByRole('button', { name: 'Periksa sesi aktif' });
    expect((screen.getByRole('button', { name: 'Mulai sesi razia' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Periksa sesi aktif' }));
    await screen.findByRole('heading', { name: 'Sesi aktif' });
  });
});

// Direct provider controls exercise races even when the normal UI correctly disables login.
function RaceControls() {
  const { auth: state, login, logout } = useAuth();
  return createElement('div', null,
    createElement('output', { 'data-testid': 'identity' }, state?.user.username ?? 'none'),
    createElement('button', { onClick: () => { void login('synthetic.officer', 'synthetic-password'); } }, 'Login control'),
    createElement('button', { onClick: () => { void logout(); } }, 'Logout control'));
}
it('stale /me after login and logout cannot overwrite or resurrect auth', async () => {
  const initial = deferred<Response>(); const stale = deferred<Response>();
  let checks = 0;
  fetchMock.mockImplementation(async input => {
    if (input === '/api/auth/me') return ++checks === 1 ? initial.promise : stale.promise;
    if (input === '/api/auth/login') return json(auth());
    return new Response(null, { status: 204 });
  });
  render(createElement(AuthProvider, null, createElement(RaceControls)));
  await waitFor(() => expect(checks).toBe(1));
  await userEvent.click(screen.getByRole('button', { name: 'Login control' }));
  await waitFor(() => expect(screen.getByTestId('identity').textContent).toBe('synthetic.officer'));
  await act(async () => initial.resolve(json({ ...auth(), user: { ...auth().user, username: 'stale.initial' } })));
  expect(screen.getByTestId('identity').textContent).toBe('synthetic.officer');
  fireEvent(window, new Event('focus')); await waitFor(() => expect(checks).toBe(2));
  await userEvent.click(screen.getByRole('button', { name: 'Logout control' }));
  await waitFor(() => expect(screen.getByTestId('identity').textContent).toBe('none'));
  await act(async () => stale.resolve(json(auth(raid))));
  expect(screen.getByTestId('identity').textContent).toBe('none');
});
it('stale logout response after unmount cannot clear a new authenticated provider', async () => {
  const pending = deferred<Response>();
  fetchMock.mockImplementation(async input => input === '/api/auth/logout' ? pending.promise : json(auth()));
  const view = render(createElement(AuthProvider, null, createElement(RaceControls)));
  await waitFor(() => expect(screen.getByTestId('identity').textContent).toBe('synthetic.officer'));
  await userEvent.click(screen.getByRole('button', { name: 'Logout control' })); view.unmount();
  render(createElement(AuthProvider, null, createElement(RaceControls)));
  await waitFor(() => expect(screen.getByTestId('identity').textContent).toBe('synthetic.officer'));
  await act(async () => pending.resolve(new Response(null, { status: 204 })));
  expect(screen.getByTestId('identity').textContent).toBe('synthetic.officer');
});
it('stale login response after provider unmount does not restore a new provider', async () => {
  const pending = deferred<Response>();
  fetchMock.mockImplementation(async input => input === '/api/auth/login' ? pending.promise : failure(401));
  const view = render(createElement(AuthProvider, null, createElement(RaceControls)));
  await userEvent.click(screen.getByRole('button', { name: 'Login control' })); view.unmount();
  render(createElement(AuthProvider, null, createElement(RaceControls)));
  await act(async () => pending.resolve(json(auth())));
  expect(screen.getByTestId('identity').textContent).toBe('none');
});
