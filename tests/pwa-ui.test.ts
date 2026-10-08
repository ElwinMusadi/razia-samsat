// @vitest-environment jsdom
import { createElement, StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PwaControls, PwaProvider } from '../src/pwa';
import { App } from '../src/app';
import { AuthProvider } from '../src/auth';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; }); return { promise, resolve, reject }; }
function registration(waiting = false) {
  const value = Object.assign(new EventTarget(), { waiting: waiting ? {} : null, installing: null as (EventTarget & { state: string }) | null });
  return value;
}
let register: ReturnType<typeof vi.fn>; let media: EventTarget & { matches: boolean }; let serviceWorker: { register: ReturnType<typeof vi.fn>; controller: object | null };
function setup(standalone = false) {
  media.matches = standalone;
  return render(createElement(PwaControls));
}
function installEvent(choice: Promise<{ outcome: string }> = Promise.resolve({ outcome: 'dismissed' }), prompt = vi.fn(async () => {})) {
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt, userChoice: choice });
  fireEvent(window, event); return event;
}
beforeEach(() => {
  register = vi.fn().mockResolvedValue(registration());
  serviceWorker = { register, controller: null };
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  vi.stubGlobal('matchMedia', vi.fn(() => media));
});
afterEach(() => { cleanup(); Reflect.deleteProperty(navigator, 'serviceWorker'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('ephemeral PWA controls', () => {
  it('registers same-origin once in StrictMode with update caching disabled and manual guidance', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    render(createElement(StrictMode, null, createElement(PwaControls)));
    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
    expect(screen.getByText('Panduan instalasi')).toBeTruthy(); expect(screen.getByText(/Nama menu dan ketersediaannya/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pasang aplikasi' })).toBeNull(); expect(storage).not.toHaveBeenCalled();
  });
  it.each(['no-service-worker', 'insecure'])('renders nothing for %s without errors or requests', async kind => {
    if (kind === 'no-service-worker') Reflect.deleteProperty(navigator, 'serviceWorker');
    else vi.stubGlobal('isSecureContext', false);
    const view = setup(); await act(async () => {});
    expect(view.container.textContent).toBe(''); expect(register).not.toHaveBeenCalled();
  });
  it('hides installation help in standalone and after display-mode change', async () => {
    const view = setup(true); await waitFor(() => expect(register).toHaveBeenCalled());
    expect(screen.queryByText('Panduan instalasi')).toBeNull(); view.unmount();
    setup(); expect(screen.getByText('Panduan instalasi')).toBeTruthy();
    await act(async () => { media.matches = true; media.dispatchEvent(new Event('change')); });
    expect(screen.queryByText('Panduan instalasi')).toBeNull();
  });
  it.each(['accepted', 'dismissed', 'unknown'])('uses one user gesture prompt for %s and never claims installation from userChoice', async outcome => {
    const storage = vi.spyOn(Storage.prototype, 'setItem'); setup();
    const choice = deferred<{ outcome: string }>(); const event = installEvent(choice.promise);
    expect(event.defaultPrevented).toBe(true);
    const button = screen.getByRole('button', { name: 'Pasang aplikasi' });
    expect(button.classList.contains('min-h-12')).toBe(true); expect(button.classList.contains('min-w-12')).toBe(true);
    expect(button.className).toContain('whitespace-normal');
    fireEvent.click(button); fireEvent.click(button); expect(event.prompt).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Membuka instalasi…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => choice.resolve({ outcome }));
    expect(screen.getByRole('status').textContent).toContain(outcome === 'accepted' ? 'Permintaan instalasi diterima' : outcome === 'dismissed' ? 'Instalasi dibatalkan' : 'Instalasi belum dapat dipastikan');
    expect(screen.getByText('Panduan instalasi')).toBeTruthy(); expect(storage).not.toHaveBeenCalled();
    fireEvent(window, new Event('appinstalled')); expect(screen.queryByText('Panduan instalasi')).toBeNull(); expect(screen.queryByRole('status')).toBeNull();
  });
  it('handles prompt failure with a generic notice without logging raw errors', async () => {
    const error = vi.spyOn(console, 'error'); const log = vi.spyOn(console, 'log'); setup();
    const event = installEvent(Promise.resolve({ outcome: 'dismissed' }), vi.fn(async () => { throw new Error('synthetic raw detail'); }));
    fireEvent.click(screen.getByRole('button', { name: 'Pasang aplikasi' }));
    await screen.findByText('Instalasi belum dapat dibuka. Periksa menu browser.');
    expect(event.prompt).toHaveBeenCalledTimes(1); expect(document.body.textContent).not.toContain('synthetic raw detail'); expect(error).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  });
  it('handles userChoice rejection and an installed event racing the pending choice', async () => {
    setup(); const choice = deferred<{ outcome: string }>(); installEvent(choice.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Pasang aplikasi' }));
    await act(async () => choice.reject(new Error('synthetic rejected choice')));
    expect(screen.getByText('Instalasi belum dapat dibuka. Periksa menu browser.')).toBeTruthy();
    const late = deferred<{ outcome: string }>(); installEvent(late.promise); fireEvent.click(screen.getByRole('button', { name: 'Pasang aplikasi' }));
    fireEvent(window, new Event('appinstalled')); await act(async () => late.resolve({ outcome: 'dismissed' }));
    expect(screen.queryByText('Panduan instalasi')).toBeNull(); expect(screen.queryByRole('status')).toBeNull();
  });
  it('shows generic registration failure without logging or interfering with login fields', async () => {
    register.mockRejectedValue(new Error('synthetic raw registration error'));
    const error = vi.spyOn(console, 'error'); const log = vi.spyOn(console, 'log');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'AUTHENTICATION_ERROR', message: 'Sesi tidak tersedia.', request_id: 'synthetic-request' } }), { status: 401 })));
    render(createElement(MemoryRouter, { initialEntries: ['/login'] }, createElement(AuthProvider, null, createElement(App))));
    await screen.findByRole('heading', { name: 'Masuk' });
    const password = screen.getByLabelText('Kata sandi') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'synthetic password input' } }); password.focus();
    await screen.findByText(/Persiapan instalasi belum berhasil/);
    expect(password.value).toBe('synthetic password input'); expect(document.activeElement).toBe(password);
    expect(screen.queryByRole('alert')).toBeNull(); expect(document.body.textContent).not.toContain('synthetic raw registration error'); expect(error).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  });
  it('announces waiting and installing updates without reload, activation messages or input changes', async () => {
    const value = registration(true); register.mockResolvedValue(value); serviceWorker.controller = {};
    const postMessage = vi.fn(); Object.assign(value.waiting!, { postMessage });
    const view = render(createElement('div', null, createElement('input', { 'aria-label': 'Synthetic operation', defaultValue: 'synthetic in-flight input' }), createElement(PwaControls)));
    const input = screen.getByLabelText('Synthetic operation') as HTMLInputElement; input.focus();
    await screen.findByText(/Pembaruan aplikasi tersedia/);
    expect(screen.getByText(/Tidak ada muat ulang otomatis/)).toBeTruthy(); expect(postMessage).not.toHaveBeenCalled();
    expect(input.value).toBe('synthetic in-flight input'); expect(document.activeElement).toBe(input);
    value.waiting = null; value.installing = Object.assign(new EventTarget(), { state: 'installing' });
    await act(async () => value.dispatchEvent(new Event('updatefound')));
    await act(async () => { value.installing!.state = 'installed'; value.installing!.dispatchEvent(new Event('statechange')); });
    expect(input.value).toBe('synthetic in-flight input'); expect(window.location.pathname).toBe('/'); view.unmount();
  });
  it('does not announce first installation as an application update', async () => {
    const value = registration(); value.installing = Object.assign(new EventTarget(), { state: 'installed' }); register.mockResolvedValue(value); setup();
    await waitFor(() => expect(register).toHaveBeenCalled()); expect(screen.queryByText(/Pembaruan aplikasi tersedia/)).toBeNull();
  });
  it('shares one registration and pending prompt across control remounts', async () => {
    const first = createElement(PwaProvider, null, createElement(PwaControls, { key: 'first' }));
    const view = render(first); await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    const event = installEvent(); expect(event.defaultPrevented).toBe(true);
    view.rerender(createElement(PwaProvider, null, createElement(PwaControls, { key: 'next' })));
    fireEvent.click(screen.getByRole('button', { name: 'Pasang aplikasi' }));
    await waitFor(() => expect(event.prompt).toHaveBeenCalledTimes(1));
    expect(register).toHaveBeenCalledTimes(1);
  });
  it('keeps PWA and account details collapsed without hiding the only logout action', async () => {
    const state = { user: { id: '11111111-1111-4111-8111-111111111111', username: 'synthetic.officer', role: 'OFFICER' }, session: { expires_at: Math.floor(Date.now() / 1000) + 3600 }, active_raid_session: null };
    vi.stubGlobal('fetch', vi.fn(async input => new Response(JSON.stringify(String(input) === '/api/auth/me' ? state : { locations: [] }))));
    render(createElement(MemoryRouter, { initialEntries: ['/razia/setup'] }, createElement(AuthProvider, null, createElement(App))));
    await screen.findByRole('heading', { name: 'Sesi razia' });
    const account = document.querySelector<HTMLDetailsElement>('.account-disclosure')!;
    expect(account.open).toBe(false); expect(screen.getByRole('complementary', { name: 'Instalasi aplikasi' }).closest('details')!.hasAttribute('open')).toBe(false);
    expect(screen.getAllByRole('button', { name: 'Keluar' })).toHaveLength(1); expect(screen.getByRole('button', { name: 'Keluar' }).closest('header')).not.toBeNull();
    expect(within(screen.getByRole('navigation')).queryByRole('button', { name: 'Keluar' })).toBeNull();
    const event = installEvent(); expect(event.defaultPrevented).toBe(true);
    await userEvent.click(screen.getByText('Akun')); expect(account.open).toBe(true);
    expect(screen.getByText('synthetic.officer')).toBeTruthy(); expect(screen.getByText('Keluar tidak menutup sesi razia aktif.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pasang aplikasi' })); await waitFor(() => expect(event.prompt).toHaveBeenCalledTimes(1));
    expect(register).toHaveBeenCalledTimes(1);
  });
  it('retains a pre-login install event across routes without registering twice', async () => {
    let signedIn = false;
    const state = { user: { id: '11111111-1111-4111-8111-111111111111', username: 'synthetic.officer', role: 'OFFICER' }, session: { expires_at: Math.floor(Date.now() / 1000) + 3600 }, active_raid_session: null };
    vi.stubGlobal('fetch', vi.fn(async input => {
      if (String(input) === '/api/auth/me') return new Response(JSON.stringify(signedIn ? state : { error: { code: 'AUTHENTICATION_ERROR', message: 'Sesi tidak tersedia.', request_id: 'synthetic-request' } }), { status: signedIn ? 200 : 401 });
      if (String(input) === '/api/auth/login') { signedIn = true; return new Response(JSON.stringify(state)); }
      return new Response(JSON.stringify({ locations: [] }));
    }));
    render(createElement(MemoryRouter, { initialEntries: ['/login'] }, createElement(AuthProvider, null, createElement(App))));
    await screen.findByRole('heading', { name: 'Masuk' }); await waitFor(() => expect((screen.getByRole('button', { name: 'Masuk' }) as HTMLButtonElement).disabled).toBe(false));
    const event = installEvent();
    const footer = document.querySelector<HTMLDetailsElement>('.installation-disclosure')!;
    expect(footer.open).toBe(false); expect(footer.compareDocumentPosition(document.querySelector('form')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nama pengguna'), { target: { value: 'synthetic.officer' } }); fireEvent.change(screen.getByLabelText('Kata sandi'), { target: { value: 'synthetic-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Masuk' })); await screen.findByRole('heading', { name: 'Sesi razia' });
    await userEvent.click(screen.getByText('Akun')); fireEvent.click(screen.getByRole('button', { name: 'Pasang aplikasi' }));
    await waitFor(() => expect(event.prompt).toHaveBeenCalledTimes(1)); expect(register).toHaveBeenCalledTimes(1);
  });
  it('keeps update notices in account disclosure and preserves scanner focus and input during navigation', async () => {
    const value = registration(true); register.mockResolvedValue(value); serviceWorker.controller = {};
    const raid = { id: '22222222-2222-4222-8222-222222222222', location: { id: '33333333-3333-4333-8333-333333333333', name: 'Lokasi sintetis' }, lane: 'timur', status: 'ACTIVE', started_at: 1791331200, closed_at: null };
    const state = { user: { id: '11111111-1111-4111-8111-111111111111', username: 'synthetic.officer', role: 'OFFICER' }, session: { expires_at: Math.floor(Date.now() / 1000) + 3600 }, active_raid_session: raid };
    vi.stubGlobal('fetch', vi.fn(async input => new Response(JSON.stringify(String(input) === '/api/auth/me' ? state : String(input) === '/api/history/raid-sessions' ? { raid_sessions: [], next_cursor: null } : String(input).endsWith('/summary') ? { raid_session: { ...raid, owner: state.user }, summary: { total_checks: 0, found: 0, not_found: 0, tax_active: 0, tax_expired: 0, tax_unknown: 0 } } : { checks: [], next_cursor: null }))));
    function RouteControl() { const navigate = useNavigate(); return createElement('button', { onClick: () => navigate('/history') }, 'Test route'); }
    render(createElement(MemoryRouter, { initialEntries: ['/razia/scanner'] }, createElement(AuthProvider, null, createElement(App), createElement(RouteControl))));
    const input = await screen.findByLabelText('Nomor polisi (NOPOL)') as HTMLInputElement; fireEvent.change(input, { target: { value: 'dh-' } }); input.focus();
    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(document.querySelector('.account-disclosure')!.hasAttribute('open')).toBe(false);
    expect(screen.getByRole('complementary', { name: 'Instalasi aplikasi' }).closest('details')!.hasAttribute('open')).toBe(false); expect(input.value).toBe('dh-'); expect(document.activeElement).toBe(input);
    await userEvent.click(screen.getByText('Akun')); const notice = screen.getByText(/Pembaruan aplikasi tersedia/);
    expect(notice.closest('.account-disclosure')).not.toBeNull(); expect(notice.textContent).toContain('Tidak ada muat ulang otomatis');
    await userEvent.click(screen.getByRole('button', { name: 'Test route' })); await screen.findByRole('heading', { name: 'Riwayat' });
    expect(register).toHaveBeenCalledTimes(1);
  });
  it('ignores registration completion and install events after unmount', async () => {
    const result = deferred<ReturnType<typeof registration>>(); register.mockReturnValue(result.promise);
    const view = setup(); await waitFor(() => expect(register).toHaveBeenCalled()); view.unmount();
    const value = registration(true); const listener = vi.spyOn(value, 'addEventListener');
    await act(async () => result.resolve(value));
    const event = installEvent(); expect(event.defaultPrevented).toBe(false); expect(listener).not.toHaveBeenCalled();
  });
});
