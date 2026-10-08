// @vitest-environment jsdom
import { createElement, useLayoutEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import { AuthProvider, useAuth } from '../src/auth';
import type { AuthState, HistoryCheck, HistoryRaid, HistorySummary } from '../src/lib/api';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RAID = uuid(2);
const location = { id: uuid(1), name: 'Lokasi sintetis' };
const owner = { id: uuid(3), username: 'synthetic.owner' };
const raid: HistoryRaid = { id: RAID, location, lane: 'arah pusat kota', status: 'ACTIVE', started_at: 1791331200, closed_at: null, owner };
const closed: HistoryRaid = { ...raid, id: uuid(4), lane: 'jalur barat', status: 'CLOSED', closed_at: raid.started_at + 60 };
const cursor = 'opaqueCursor_Az09-';
const auth = (active = true, role: 'ADMIN' | 'OFFICER' = 'OFFICER'): AuthState => ({ user: { id: uuid(3), username: 'synthetic.reader', role }, session: { expires_at: Math.floor(Date.now() / 1000) + 3600 }, active_raid_session: active ? raid : null });
const check = (n: number, tax: HistoryCheck['tax_status'] = 'ACTIVE'): HistoryCheck => ({ id: uuid(100 + n), nopol: `DH${n}ZZ`, outcome: tax === null ? 'NOT_FOUND' : 'FOUND', tax_status: tax, stnk_status: tax === null ? null : 'UNKNOWN', source: tax === null ? 'LIVE' : 'CACHE', checked_at: raid.started_at + n });
const zeros: HistorySummary = { total_checks: 0, found: 0, not_found: 0, tax_active: 0, tax_expired: 0, tax_unknown: 0 };
const summary: HistorySummary = { total_checks: 4, found: 3, not_found: 1, tax_active: 1, tax_expired: 1, tax_unknown: 1 };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const failure = (status: number, code = 'INTERNAL_ERROR') => json({ error: { code, message: 'Pesan layanan sintetis', request_id: 'req-history' } }, status, { 'X-Request-ID': 'req-history' });
const recap = (metrics = summary, activeRaid = raid) => json({ raid_session: activeRaid, summary: metrics });
const found = (nopol: string) => json({ outcome: 'FOUND', vehicle: { nopol, owner_name: 'Pemilik Sintetis', brand: 'Merek Sintetis', type: 'Tipe Sintetis', color: 'Warna Sintetis', tax_due_date: '2000-01-01', stnk_due_date: null, tax_status: 'ACTIVE', stnk_status: 'UNKNOWN' }, source: 'LIVE', fetched_at: '2026-10-07T01:00:00.000Z', evaluated_on: '2026-10-07', request_id: 'req-found' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function Path() { return createElement('output', { 'data-testid': 'path' }, useLocation().pathname); }
function mount(path = '/history', extra?: ReturnType<typeof createElement>) {
  return render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(AuthProvider, null, createElement(App), createElement(Path), extra)));
}
// Commit-time observations verify old panel data is already absent before the next paint.
function ContextProbe({ observe }: { observe: (state: AuthState | null) => void }) {
  const { auth: state } = useAuth();
  useLayoutEffect(() => { observe(state); }, [state, observe]);
  return null;
}
type Handler = (path: string, init: RequestInit) => Response | Promise<Response>;
function routes(handler: Handler, state = auth()) {
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === '/api/auth/me') return json(state);
    if (path === '/api/auth/logout') return new Response(null, { status: 204 });
    if (path === '/api/locations') return json({ locations: [location] });
    return handler(path, init!);
  });
}
const detail = `/history/${RAID}`;
const checksUrl = `/api/raid-sessions/${RAID}/checks`;
const summaryUrl = `/api/raid-sessions/${RAID}/summary`;
const listUrl = '/api/history/raid-sessions';
const historyCalls = () => fetchMock.mock.calls.filter(([path]) => String(path).includes('/checks') || String(path).includes('/summary'));
const panel = () => screen.getByRole('region', { name: 'Riwayat sesi ini' });
const input = () => screen.getByLabelText('Nomor polisi (NOPOL)') as HTMLInputElement;
async function lookup(nopol = 'DH1234ZZ') { fireEvent.change(input(), { target: { value: nopol } }); fireEvent.submit(input().form!); }
function metric(region: HTMLElement, label: string) { return region.querySelector(`[data-metric="${label}"]`)!.textContent; }

beforeEach(() => { fetchMock = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('history list and navigation', () => {
  it('shows loading then empty state without fabricating sessions', async () => {
    const pending = deferred<Response>();
    routes(() => pending.promise); mount();
    await screen.findByText('Memuat riwayat sesi…');
    expect(screen.queryByText('Belum ada sesi razia.')).toBeNull();
    await act(async () => pending.resolve(json({ raid_sessions: [], next_cursor: null })));
    await screen.findByText('Belum ada sesi razia.');
    expect(screen.queryByRole('button', { name: 'Muat lebih banyak' })).toBeNull();
    expect(document.title).toBe('Riwayat — Razia SAMSAT');
  });
  it.each(['OFFICER', 'ADMIN'] as const)('shows cards, status/WITA and owner only for %s', async role => {
    routes(() => json({ raid_sessions: [raid, closed], next_cursor: null }), auth(true, role)); mount();
    const list = await screen.findByRole('list', { name: 'Daftar sesi razia' });
    expect(list.children).toHaveLength(2);
    expect(list.textContent).toContain('Lokasi sintetis · Jalur arah pusat kota');
    expect(list.textContent).toContain('AKTIF'); expect(list.textContent).toContain('DITUTUP');
    expect(list.textContent).toContain('Selesai:'); expect(list.textContent).toContain('WITA');
    expect(list.textContent?.includes(owner.username)).toBe(role === 'ADMIN');
    expect(within(list).getAllByRole('link')[0]!.getAttribute('href')).toBe(detail);
  });
  it('load-more sends server cursor verbatim, disables while pending and deduplicates IDs', async () => {
    const pending = deferred<Response>();
    routes(path => path === listUrl ? json({ raid_sessions: [raid], next_cursor: cursor }) : pending.promise); mount();
    const button = await screen.findByRole('button', { name: 'Muat lebih banyak' });
    expect(button.className).toContain('min-h-11'); fireEvent.click(button); fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.filter(([path]) => path === `${listUrl}?cursor=${cursor}`)).toHaveLength(1);
    await act(async () => pending.resolve(json({ raid_sessions: [raid, closed, closed], next_cursor: null })));
    expect(screen.getByRole('list', { name: 'Daftar sesi razia' }).children).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Muat lebih banyak' })).toBeNull();
  });
  it.each(['server', 'network', 'invalid'] as const)('shows error banner and retry for %s', async kind => {
    let calls = 0;
    routes(() => {
      if (++calls > 1) return json({ raid_sessions: [raid], next_cursor: null });
      if (kind === 'network') throw new TypeError('sensitive transport');
      return kind === 'invalid' ? json({ raid_sessions: 'bad' }, 200, { 'X-Request-ID': 'req-invalid' }) : failure(500);
    }); mount();
    const alert = await screen.findByRole('alert'); expect(alert.className).toContain('amber');
    if (kind !== 'network') expect(alert.textContent).toContain(kind === 'invalid' ? 'req-invalid' : 'req-history');
    expect(document.body.textContent).not.toContain('sensitive transport');
    await userEvent.click(screen.getByRole('button', { name: 'Coba lagi' }));
    await screen.findByRole('list', { name: 'Daftar sesi razia' }); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('load-more error retries the same cursor without losing existing cards', async () => {
    let more = 0;
    routes(path => path === listUrl ? json({ raid_sessions: [raid], next_cursor: cursor }) : ++more === 1 ? failure(500) : json({ raid_sessions: [closed], next_cursor: null })); mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Muat lebih banyak' }));
    await screen.findByRole('alert'); expect(screen.getByRole('list', { name: 'Daftar sesi razia' }).children).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Coba lagi' }));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Daftar sesi razia' }).children).toHaveLength(2));
    expect(fetchMock.mock.calls.filter(([path]) => path === `${listUrl}?cursor=${cursor}`)).toHaveLength(2);
  });
  it('protected history 401 redirects to login through read()', async () => {
    routes(() => failure(401, 'AUTHENTICATION_ERROR')); mount();
    await screen.findByRole('heading', { name: 'Masuk' }); expect(screen.getByTestId('path').textContent).toBe('/login');
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/auth/logout')).toBe(false);
  });
  it('403 shows Akses ditolak without logout', async () => {
    routes(() => failure(403, 'AUTHORIZATION_ERROR')); mount();
    await screen.findByText('Akses ditolak'); expect(screen.getByTestId('path').textContent).toBe('/history');
    expect(screen.getByRole('button', { name: 'Keluar' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/auth/logout')).toBe(false);
  });
  it('list 404 displays the prescribed missing-session message without logout', async () => {
    routes(() => failure(404, 'RAID_SESSION_NOT_FOUND')); mount();
    await screen.findByText('Sesi razia tidak ditemukan');
    expect(screen.getByTestId('path').textContent).toBe('/history');
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/auth/logout')).toBe(false);
  });
  it.each([true, false])('uses one row with >=44px controls and Scanner conditional (active=%s)', async active => {
    routes(() => json({ raid_sessions: [], next_cursor: null }), auth(active)); mount();
    await screen.findByText('Belum ada sesi razia.');
    const nav = screen.getByRole('navigation', { name: 'Navigasi utama' });
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    expect(nav.className).toContain('fixed'); expect(nav.className).toContain('safe-area-inset-bottom');
    const row = nav.firstElementChild!; expect(row.className).not.toContain('flex-wrap');
    expect([...row.children].map(node => node.textContent)).toEqual(active ? ['Sesi razia', 'Scanner', 'Riwayat', 'Keluar'] : ['Sesi razia', 'Riwayat', 'Keluar']);
    for (const control of [...row.children]) for (const token of ['min-h-11', 'min-w-11', 'flex-1', 'px-1', 'whitespace-normal']) expect(control.className.split(' ')).toContain(token);
    expect(nav.parentElement!.className).toContain('pb-[calc(5rem+env(safe-area-inset-bottom,0px))]');
    expect(within(nav).getByRole('link', { name: 'Riwayat' }).getAttribute('aria-current')).toBe('page');
    // Declarative width arithmetic: 320 - 32px padding - 3*8px gaps = 264 / 4 = 66px per control.
    expect((320 - 32 - 3 * 8) / 4).toBeGreaterThanOrEqual(44);
  });
});

describe('history detail', () => {
  it('renders header, all recap metrics, snapshots and NOT_FOUND dashes', async () => {
    routes(path => path === summaryUrl ? recap() : json({ checks: [check(1), check(2, 'EXPIRED'), check(3, 'UNKNOWN'), check(4, null)], next_cursor: null })); mount(detail);
    const recapRegion = await screen.findByRole('region', { name: 'Rekap sesi' });
    for (const [label, value] of Object.entries({ 'Total Scan': '4', Ditemukan: '3', 'Tidak ditemukan': '1', 'Pajak Aktif': '1', 'Pajak Mati': '1', 'Pajak Tidak Dapat Ditentukan': '1' })) expect(metric(recapRegion, label)).toBe(value);
    expect(recapRegion.textContent).toContain('NOPOL unik');
    const list = screen.getByRole('list', { name: 'Daftar pengecekan' }); expect(list.children).toHaveLength(4);
    expect(list.textContent).toContain('AKTIF'); expect(list.textContent).toContain('MATI'); expect(list.textContent).toContain('TIDAK DAPAT DITENTUKAN');
    expect(list.textContent).toContain('Langsung'); expect(list.textContent).toContain('Cache'); expect(list.textContent).toContain('WITA');
    const nf = list.children[3]! as HTMLElement; expect(within(nf).getAllByText('—')).toHaveLength(2);
    expect(nf.textContent).toContain('Tidak ditemukan');
    expect(screen.getByText(/Status adalah snapshot saat pengecekan, bukan status terkini/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Kembali ke riwayat/ }).getAttribute('href')).toBe('/history');
    expect(document.title).toBe('Detail sesi — Razia SAMSAT');
    expect(within(screen.getByRole('navigation')).getByRole('link', { name: 'Riwayat' }).getAttribute('aria-current')).toBe('page');
  });
  it('load-more deduplicates checks and Muat ulang resets the cursor to head', async () => {
    let heads = 0;
    routes(path => {
      if (path === summaryUrl) return recap();
      if (path === checksUrl) return ++heads === 1 ? json({ checks: [check(1)], next_cursor: cursor }) : json({ checks: [check(9)], next_cursor: null });
      return json({ checks: [check(1), check(2), check(2)], next_cursor: null });
    }); mount(detail);
    await userEvent.click(await screen.findByRole('button', { name: 'Muat lebih banyak' }));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Daftar pengecekan' }).children).toHaveLength(2));
    expect(fetchMock.mock.calls.some(([path]) => path === `${checksUrl}?cursor=${cursor}`)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Muat ulang' }));
    await screen.findByText('DH9ZZ'); expect(screen.queryByText('DH1ZZ')).toBeNull();
    expect(fetchMock.mock.calls.filter(([path]) => path === checksUrl)).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([path]) => path === summaryUrl)).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([path]) => String(path).startsWith(summaryUrl + '?'))).toHaveLength(0);
  });
  it('detail pagination error keeps entries and retries the exact cursor', async () => {
    let more = 0;
    routes(path => path === summaryUrl ? recap() : path === checksUrl ? json({ checks: [check(1)], next_cursor: cursor })
      : ++more === 1 ? failure(500) : json({ checks: [check(1), check(2)], next_cursor: null }));
    mount(detail);
    await userEvent.click(await screen.findByRole('button', { name: 'Muat lebih banyak' }));
    await screen.findByRole('alert'); expect(screen.getByText('DH1ZZ')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Daftar pengecekan' }).children).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Coba lagi' }));
    await screen.findByText('DH2ZZ');
    expect(fetchMock.mock.calls.filter(([path]) => path === `${checksUrl}?cursor=${cursor}`)).toHaveLength(2);
    expect(screen.getByRole('list', { name: 'Daftar pengecekan' }).children).toHaveLength(2);
  });
  it.each(['success', '401'] as const)('head reload aborts a pending page and ignores its late %s', async outcome => {
    const pending = deferred<Response>(); let heads = 0; let pageSignal: AbortSignal | undefined;
    routes((path, init) => {
      if (path === summaryUrl) return recap();
      if (path === checksUrl) return json({ checks: [check(++heads === 1 ? 1 : 9)], next_cursor: heads === 1 ? cursor : null });
      pageSignal = init.signal!; return pending.promise;
    }); mount(detail);
    fireEvent.click(await screen.findByRole('button', { name: 'Muat lebih banyak' }));
    const reload = screen.getByRole('button', { name: 'Muat ulang' }) as HTMLButtonElement;
    expect(reload.disabled).toBe(false); fireEvent.click(reload);
    expect(pageSignal!.aborted).toBe(true); await screen.findByText('DH9ZZ');
    await act(async () => pending.resolve(outcome === '401' ? failure(401, 'AUTHENTICATION_ERROR') : json({ checks: [check(2)], next_cursor: null })));
    expect(screen.getByTestId('path').textContent).toBe(detail);
    expect(screen.queryByText('DH1ZZ')).toBeNull(); expect(screen.queryByText('DH2ZZ')).toBeNull();
    expect(screen.getByText('DH9ZZ')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('renders independently valid eventual summary and checks without inventing consistency', async () => {
    const pending = deferred<Response>();
    routes(path => path === summaryUrl ? recap(zeros, { ...raid, status: 'CLOSED', closed_at: raid.started_at + 60 }) : pending.promise);
    mount(detail); await screen.findByText('Memuat detail sesi…');
    await act(async () => pending.resolve(json({ checks: [check(1)], next_cursor: null })));
    expect(metric(screen.getByRole('region', { name: 'Rekap sesi' }), 'Total Scan')).toBe('0');
    expect(screen.getByText('DH1ZZ')).toBeTruthy(); expect(screen.getByText('DITUTUP')).toBeTruthy();
    expect(screen.getByText(/Riwayat diperbarui di latar belakang dan dapat tertunda sesaat/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull(); expect(historyCalls()).toHaveLength(2);
  });
  it('shows empty checks and zero metrics', async () => {
    routes(path => path === summaryUrl ? recap(zeros) : json({ checks: [], next_cursor: null })); mount(detail);
    await screen.findByText('Belum ada pengecekan pada sesi ini.'); expect(metric(screen.getByRole('region', { name: 'Rekap sesi' }), 'Total Scan')).toBe('0');
  });
  it.each([[404, 'RAID_SESSION_NOT_FOUND', 'Sesi razia tidak ditemukan'], [403, 'AUTHORIZATION_ERROR', 'Akses ditolak']] as const)('shows %i without logout', async (status, code, message) => {
    routes(() => failure(status, code)); mount(detail); await screen.findByText(message);
    expect(screen.getByTestId('path').textContent).toBe(detail); expect(fetchMock.mock.calls.some(([path]) => path === '/api/auth/logout')).toBe(false);
    expect(screen.queryByRole('region', { name: 'Rekap sesi' })).toBeNull();
  });
  it('detail 401 redirects to login', async () => {
    routes(() => failure(401, 'AUTHENTICATION_ERROR')); mount(detail); await screen.findByRole('heading', { name: 'Masuk' });
    expect(screen.getByTestId('path').textContent).toBe('/login');
  });
  it('detail error retries summary and checks', async () => {
    let fail = true;
    routes(path => fail ? failure(500) : path === summaryUrl ? recap() : json({ checks: [check(1)], next_cursor: null })); mount(detail);
    const alert = await screen.findByRole('alert'); expect(alert.textContent).toContain('req-history');
    fail = false; await userEvent.click(screen.getByRole('button', { name: 'Coba lagi' })); await screen.findByText('DH1ZZ');
  });
});

describe('scanner history panel isolation', () => {
  function scannerRoutes(handler?: Handler, state = auth()) {
    routes((path, init) => {
      if (handler) return handler(path, init);
      if (path === summaryUrl) return recap(zeros);
      if (path === `${checksUrl}?limit=10`) return json({ checks: [], next_cursor: null });
      if (path === '/api/vehicle-lookups') return found(JSON.parse(String(init.body)).nopol);
      throw new Error(`Unexpected route ${path}`);
    }, state);
  }
  it('mount fetches summary and limit=10, caps list at 10 and refreshes manually', async () => {
    let calls = 0;
    scannerRoutes(path => path === summaryUrl ? recap() : (++calls, json({ checks: Array.from({ length: 12 }, (_, n) => check(n + 1)), next_cursor: cursor }))); mount('/razia/scanner');
    await screen.findByRole('list', { name: 'Pengecekan terbaru' });
    expect(within(panel()).getByRole('list').children).toHaveLength(10);
    expect(historyCalls().map(([path]) => path)).toEqual([summaryUrl, `${checksUrl}?limit=10`]);
    expect(metric(panel(), 'Total Scan')).toBe('4'); expect(metric(panel(), 'Tidak ditemukan')).toBe('1');
    expect(within(panel()).getByText('Riwayat diperbarui di latar belakang dan dapat tertunda sesaat.')).toBeTruthy();
    const button = within(panel()).getByRole('button', { name: 'Muat ulang' }); expect(button.className).toContain('min-h-11');
    await userEvent.click(button); await waitFor(() => expect(calls).toBe(2));
    expect(historyCalls()).toHaveLength(4);
  });
  it('focus refreshes history head without polling', async () => {
    scannerRoutes(); mount('/razia/scanner'); await screen.findByText('Belum ada pengecekan tercatat pada sesi ini.');
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(historyCalls()).toHaveLength(4));
    expect(historyCalls().filter(([path]) => path === `${checksUrl}?limit=10`)).toHaveLength(2);
  });
  it.each(['FOUND', 'NOT_FOUND'] as const)('refreshes once after displayed %s, not on repeated Enter or X', async outcome => {
    scannerRoutes((path, init) => path === summaryUrl ? recap(zeros) : path === `${checksUrl}?limit=10` ? json({ checks: [], next_cursor: null }) : outcome === 'FOUND' ? found(JSON.parse(String(init.body)).nopol) : json({ outcome: 'NOT_FOUND', request_id: 'req-nf' }));
    mount('/razia/scanner'); await screen.findByText('Belum ada pengecekan tercatat pada sesi ini.');
    await lookup();
    if (outcome === 'FOUND') await screen.findByRole('heading', { name: 'DH1234ZZ' }); else await screen.findByText('Data kendaraan tidak ditemukan');
    await waitFor(() => expect(historyCalls()).toHaveLength(4));
    fireEvent.submit(input().form!); fireEvent.submit(input().form!);
    expect(historyCalls()).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Hapus NOPOL' }));
    expect(historyCalls()).toHaveLength(4);
    expect(input().value).toBe(''); expect(document.activeElement).toBe(input());
  });
  it.each(['error', 'invalid'] as const)('does not refresh history after lookup %s', async kind => {
    scannerRoutes(path => path === summaryUrl ? recap(zeros) : path === `${checksUrl}?limit=10` ? json({ checks: [], next_cursor: null }) : kind === 'error' ? failure(502, 'UPSTREAM_ERROR') : json({ outcome: 'FOUND', vehicle: {} }));
    mount('/razia/scanner'); await screen.findByText('Belum ada pengecekan tercatat pada sesi ini.');
    await lookup(); await screen.findByRole('alert'); expect(historyCalls()).toHaveLength(2);
  });
  it('stale panel response cannot overwrite newer data or invalidate auth with stale 401', async () => {
    const oldSummary = deferred<Response>(); const oldChecks = deferred<Response>();
    let summaries = 0, pages = 0; const signals: AbortSignal[] = [];
    scannerRoutes((path, init) => {
      signals.push(init.signal!);
      if (path === summaryUrl) return ++summaries === 1 ? oldSummary.promise : recap(summary);
      if (path === `${checksUrl}?limit=10`) return ++pages === 1 ? oldChecks.promise : json({ checks: [check(9)], next_cursor: null });
      return found(JSON.parse(String(init.body)).nopol);
    }); mount('/razia/scanner'); await screen.findByLabelText('Nomor polisi (NOPOL)');
    await lookup(); await screen.findByRole('heading', { name: 'DH1234ZZ' }); await screen.findByText('DH9ZZ');
    expect(signals[0]!.aborted).toBe(true); expect(signals[1]!.aborted).toBe(true);
    await act(async () => { oldChecks.resolve(json({ checks: [check(1)], next_cursor: null })); oldSummary.resolve(failure(401, 'AUTHENTICATION_ERROR')); });
    expect(screen.queryByText('DH1ZZ')).toBeNull(); expect(screen.getByText('DH9ZZ')).toBeTruthy();
    expect(screen.getByTestId('path').textContent).toBe('/razia/scanner'); expect(input().value).toBe('DH1234ZZ');
  });
  it.each(['user', 'role', 'raid', 'closed'] as const)('context %s clears the panel before paint, cancels old reads and suppresses stale 401', async kind => {
    const initial = auth();
    const next: AuthState = {
      ...initial, user: { ...initial.user, id: kind === 'user' ? uuid(8) : initial.user.id, role: kind === 'role' ? 'ADMIN' : initial.user.role },
      active_raid_session: kind === 'closed' ? null : kind === 'raid' ? { ...raid, id: uuid(7), lane: 'jalur baru' } : raid,
    };
    const oldSummary = deferred<Response>(); const oldChecks = deferred<Response>(); const nextMe = deferred<Response>();
    const staleSignals: AbortSignal[] = []; let pending = false; let contextChanged = false; let observed = false;
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url);
      if (path === '/api/auth/me') return contextChanged ? json(next) : pending ? nextMe.promise : json(initial);
      if (pending && !contextChanged) { staleSignals.push(init!.signal!); return path.endsWith('/summary') ? oldSummary.promise : oldChecks.promise; }
      if (path.endsWith('/summary')) return recap(summary, contextChanged ? { ...raid, ...next.active_raid_session } : raid);
      return json({ checks: [check(contextChanged ? 9 : 1)], next_cursor: null });
    });
    const observe = (state: AuthState | null) => {
      const changed = state && (state.user.id !== initial.user.id || state.user.role !== initial.user.role || state.active_raid_session?.id !== RAID);
      if (!changed) return;
      observed = true;
      expect(document.body.textContent).not.toContain('DH1ZZ');
      for (const signal of staleSignals) expect(signal.aborted).toBe(true);
    };
    mount('/razia/scanner', createElement(ContextProbe, { observe })); await screen.findByText('DH1ZZ');
    pending = true;
    fireEvent.click(within(panel()).getByRole('button', { name: 'Muat ulang' }));
    fireEvent(window, new Event('focus'));
    contextChanged = true; await act(async () => nextMe.resolve(json(next)));
    expect(observed).toBe(true);
    if (kind === 'closed') expect(screen.queryByRole('region', { name: 'Riwayat sesi ini' })).toBeNull();
    else await screen.findByText('DH9ZZ');
    await act(async () => { oldSummary.resolve(failure(401, 'AUTHENTICATION_ERROR')); oldChecks.resolve(json({ checks: [check(1)], next_cursor: null })); });
    expect(screen.getByTestId('path').textContent).toBe('/razia/scanner'); expect(screen.queryByText('DH1ZZ')).toBeNull();
    if (kind !== 'closed') expect(screen.getByText('DH9ZZ')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('panel refresh failure leaves the lookup error and typed input untouched', async () => {
    let historyFailure = false;
    scannerRoutes(path => path === '/api/vehicle-lookups' ? failure(502, 'UPSTREAM_ERROR') : historyFailure ? failure(500)
      : path === summaryUrl ? recap(zeros) : json({ checks: [], next_cursor: null }));
    mount('/razia/scanner'); await screen.findByText('Belum ada pengecekan tercatat pada sesi ini.');
    await lookup(); const lookupError = await screen.findByRole('alert'); const text = lookupError.textContent;
    historyFailure = true; fireEvent.click(within(panel()).getByRole('button', { name: 'Muat ulang' }));
    await screen.findByText('Riwayat sesi belum dapat dimuat.');
    expect(screen.getByRole('alert')).toBe(lookupError); expect(lookupError.textContent).toBe(text);
    expect(input().value).toBe('DH1234ZZ'); expect(historyCalls()).toHaveLength(4);
  });
  it.each([[403, 'AUTHORIZATION_ERROR', 'Akses ditolak.'], [404, 'RAID_SESSION_NOT_FOUND', 'Sesi razia tidak ditemukan.']] as const)('panel %i is separate and never logs out', async (status, code, message) => {
    scannerRoutes((path, init) => path === '/api/vehicle-lookups' ? found(JSON.parse(String(init.body)).nopol) : failure(status, code));
    mount('/razia/scanner'); await screen.findByText(message); await lookup();
    await screen.findByRole('heading', { name: 'DH1234ZZ' });
    expect(screen.getByTestId('path').textContent).toBe('/razia/scanner'); expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/auth/logout')).toBe(false);
  });
  it('panel error does not alter lookup input/result/error and manual retry stays separate', async () => {
    let historyFailure = false;
    scannerRoutes((path, init) => {
      if (path === '/api/vehicle-lookups') return found(JSON.parse(String(init.body)).nopol);
      if (historyFailure) return failure(500);
      return path === summaryUrl ? recap(zeros) : json({ checks: [], next_cursor: null });
    }); mount('/razia/scanner'); await screen.findByText('Belum ada pengecekan tercatat pada sesi ini.'); historyFailure = true;
    await lookup(); await screen.findByRole('heading', { name: 'DH1234ZZ' }); await screen.findByText('Riwayat sesi belum dapat dimuat.');
    expect(input().value).toBe('DH1234ZZ'); expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByText('Pemilik Sintetis')).toBeTruthy();
    await userEvent.click(within(panel()).getByRole('button', { name: 'Muat ulang' }));
    await waitFor(() => expect(historyCalls()).toHaveLength(6)); expect(screen.getByText('Pemilik Sintetis')).toBeTruthy();
  });
  it('panel 401 uses read() redirect; pending lookup is aborted by auth change, not panel state', async () => {
    const pending = deferred<Response>(); const history = deferred<Response>(); let lookupSignal: AbortSignal | undefined;
    scannerRoutes((path, init) => {
      if (path !== '/api/vehicle-lookups') return history.promise;
      lookupSignal = init.signal!; return pending.promise;
    });
    mount('/razia/scanner'); await screen.findByLabelText('Nomor polisi (NOPOL)'); await lookup();
    expect(lookupSignal!.aborted).toBe(false);
    await act(async () => history.resolve(failure(401, 'AUTHENTICATION_ERROR')));
    await screen.findByRole('heading', { name: 'Masuk' }); expect(screen.getByTestId('path').textContent).toBe('/login');
    expect(lookupSignal!.aborted).toBe(true);
    await act(async () => pending.resolve(found('DH1234ZZ')));
    expect(screen.queryByText('Pemilik Sintetis')).toBeNull();
  });
  it('does not render or fetch panel without active raid', async () => {
    scannerRoutes(undefined, auth(false)); mount('/razia/scanner'); await screen.findByText('Belum ada sesi razia aktif.');
    expect(screen.queryByRole('region', { name: 'Riwayat sesi ini' })).toBeNull(); expect(historyCalls()).toHaveLength(0);
  });
  it('elapsed fake time makes no additional history request', async () => {
    scannerRoutes(); mount('/razia/scanner'); await screen.findByText('Belum ada pengecekan tercatat pada sesi ini.');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(historyCalls()).toHaveLength(2);
  });
});

it('history never persists, logs, renders sensitive extras or enriches with BPAD/lookup', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method));
  const sensitive = { owner_name: 'SENSITIVE_OWNER', NIK: 'SENSITIVE_NIK', alamat: 'SENSITIVE_ADDRESS', raw: 'SENSITIVE_RAW' };
  routes(path => path === summaryUrl ? json({ raid_session: { ...raid, ...sensitive }, summary: { ...summary, ...sensitive } }) : json({ checks: [{ ...check(1), ...sensitive }], next_cursor: null, ...sensitive }));
  mount(detail); await screen.findByText('DH1ZZ');
  expect(document.body.innerHTML).not.toContain('SENSITIVE'); expect(storage).not.toHaveBeenCalled();
  for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/auth/me', summaryUrl, checksUrl]);
});
