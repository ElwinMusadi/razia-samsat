// @vitest-environment jsdom
import { createElement, StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PwaControls } from '../src/pwa';
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
    expect(button.className).toContain('min-h-11'); expect(button.className).toContain('whitespace-normal');
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
  it('ignores registration completion and install events after unmount', async () => {
    const result = deferred<ReturnType<typeof registration>>(); register.mockReturnValue(result.promise);
    const view = setup(); await waitFor(() => expect(register).toHaveBeenCalled()); view.unmount();
    const value = registration(true); const listener = vi.spyOn(value, 'addEventListener');
    await act(async () => result.resolve(value));
    const event = installEvent(); expect(event.defaultPrevented).toBe(false); expect(listener).not.toHaveBeenCalled();
  });
});
