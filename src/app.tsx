import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router';
import { Button } from './components/ui/button';
import { useAuth } from './auth';
import { api, ApiError, errorText, formatWita, isAbort, normalizeLane, type Location, type RaidSession } from './lib/api';
import { Scanner } from './scanner';
import { HistoryDetailRoute, HistoryListRoute } from './history';
import { AdminUsersRoute, AdminUserRoute } from './admin';
import { PwaControls } from './pwa';

function ErrorMessage({ children, id = 'operation-error' }: { children: ReactNode; id?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { ref.current?.focus(); }, [children]);
  return <p id={id} ref={ref} role="alert" tabIndex={-1} className="error-message">{children}</p>;
}
function PageTitle({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <h1 ref={ref} tabIndex={-1} className="text-2xl font-semibold">{children}</h1>;
}
function Login() {
  const { auth, login, loading, authError, retry, notice, busy } = useAuth();
  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    mounted.current = true;
    const input = password.current;
    return () => { mounted.current = false; if (input) input.value = ''; };
  }, []);
  if (auth) return <Navigate to={homePath(auth.active_raid_session)} replace />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || busy || loading || authError) return;
    const input = password.current;
    const name = username.current?.value ?? '';
    if (!name.trim() || !input?.value) { setError('Isi nama pengguna dan kata sandi.'); return; }
    if (new TextEncoder().encode(input.value).length > 1024) { input.value = ''; setError('Kata sandi terlalu panjang.'); return; }
    submitting.current = true; setError('');
    const pending = login(name, input.value);
    // Clear rendered credentials immediately; never retain passwords in React state.
    input.value = '';
    try { await pending; }
    catch (failure) {
      if (mounted.current) setError(failure instanceof ApiError && failure.code === 'SESSION_CONFLICT' ? `${errorText(failure)} Hubungi admin untuk bantuan sesi perangkat lain.` : errorText(failure));
    } finally { submitting.current = false; }
  }
  return <main className="page-layout">
    <p className="text-sm">SAMSAT Kota Kupang</p>
    <PageTitle>Masuk</PageTitle>
    <p>Masuk untuk mengelola sesi razia milik Anda.</p>
    {notice && <p role="status">{notice}</p>}
    {loading && <p role="status">Memeriksa sesi…</p>}
    {authError && <><ErrorMessage>{authError}</ErrorMessage><Button variant="outline" onClick={retry}>Coba lagi</Button></>}
    <form onSubmit={submit} className="flex flex-col gap-4" aria-busy={busy}>
      <label className="field" data-invalid={!!error}>Nama pengguna<input ref={username} name="username" autoComplete="username" required disabled={busy} aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined} /></label>
      <label className="field" data-invalid={!!error}>Kata sandi<input ref={password} name="password" type="password" autoComplete="current-password" required disabled={busy} aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined} /></label>
      {error && <ErrorMessage id="login-error">{error}</ErrorMessage>}
      <Button type="submit" disabled={busy || loading || !!authError}>{busy ? 'Sedang masuk…' : 'Masuk'}</Button>
    </form>
  </main>;
}
function Protected({ children }: { children: ReactNode }) {
  const { auth, loading, authError, retry } = useAuth();
  if (loading) return <main className="page-layout"><p role="status">Memeriksa sesi…</p></main>;
  if (!auth && authError) return <main className="page-layout"><PageTitle>Sesi belum dapat diperiksa</PageTitle><ErrorMessage>{authError}</ErrorMessage><Button onClick={retry}>Coba lagi</Button></main>;
  if (!auth) return <Navigate to="/login" replace />;
  return children;
}
const homePath = (raid: RaidSession | null) => raid ? '/razia/scanner' : '/razia/setup';
function Home() {
  const { auth } = useAuth();
  return <Navigate to={homePath(auth?.active_raid_session ?? null)} replace />;
}
// Bottom navigation controls: >= 44x44px (min-h-11 from Button, min-w-11), equal widths, wrapping labels.
const NAV_CONTROL = 'min-w-11 flex-1 whitespace-normal px-1 text-center leading-tight';
const NAV_ITEM = `${NAV_CONTROL} aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground`;
function Shell({ children }: { children: ReactNode }) {
  const { auth, logout, busy, authError, retry } = useAuth();
  const [error, setError] = useState('');
  const logoutPending = useRef(false);
  async function exit() {
    if (logoutPending.current || busy) return;
    logoutPending.current = true; setError('');
    try { await logout(); } catch (failure) { setError(errorText(failure)); }
    finally { logoutPending.current = false; }
  }
  return <div className="page-layout pb-[calc(5rem+env(safe-area-inset-bottom,0px))]">
    <header className="flex flex-col gap-3">
      <p className="font-semibold">Razia SAMSAT Kota Kupang</p>
      <p className="break-words text-sm">{auth?.user.username} · {auth?.user.role === 'ADMIN' ? 'Admin' : 'Petugas'}</p>
      <p className="text-sm">Keluar tidak menutup sesi razia aktif.</p>
      {auth?.user.role === 'ADMIN' && <Button asChild variant="outline" className="min-w-11 self-start whitespace-normal"><NavLink to="/admin/users">Kelola pengguna</NavLink></Button>}
    </header>
    {authError && <><ErrorMessage>{authError}</ErrorMessage><Button variant="outline" disabled={busy} onClick={retry}>Periksa sesi lagi</Button></>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <main className="min-w-0">{children}</main>
    {/* One fixed row, never wrapped. At 320px with four items: 320 - 32 (px-4) - 3 x 8 (gap-2) = 264px,
        66px per control (>= 44px); text width 66 - 2 (border) - 8 (px-1) = 56px. Labels may wrap to
        two 17.5px lines: 35 + 16 (py-2) + 2 = 53px control, bar 8 + 53 + 8 + 1 = 70px <= 80px reserved.
        This is declared CSS arithmetic, not a measured browser layout. The same safe area is reserved. */}
    <nav aria-label="Navigasi utama" className="fixed inset-x-0 bottom-0 z-20 border-t border-input bg-background pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] pt-2">
      <div className="mx-auto flex w-full max-w-lg gap-2 px-4">
        <Button asChild variant="outline" className={NAV_ITEM}><NavLink to="/razia/setup" end>Sesi razia</NavLink></Button>
        {auth?.active_raid_session && <Button asChild variant="outline" className={NAV_ITEM}><NavLink to="/razia/scanner" end>Scanner</NavLink></Button>}
        {/* Not `end`: also active on /history/:id. */}
        <Button asChild variant="outline" className={NAV_ITEM}><NavLink to="/history">Riwayat</NavLink></Button>
        <Button variant="outline" className={NAV_CONTROL} onClick={exit} disabled={busy}>Keluar</Button>
      </div>
    </nav>
  </div>;
}
function RaidSetup() {
  const { auth, busy, run, read, setRaid } = useAuth();
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [locationsError, setLocationsError] = useState('');
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [locationId, setLocationId] = useState('');
  const [lane, setLane] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [action, setAction] = useState<'start' | 'close' | 'sync' | null>(null);
  const [needsSync, setNeedsSync] = useState(false);
  const actionPending = useRef(false);
  const mounted = useRef(true);
  const raid = auth?.active_raid_session;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void read(() => api.locations(controller.signal)).then(result => {
      if (!controller.signal.aborted) setLocations(result);
    }).catch(failure => { if (!controller.signal.aborted && !isAbort(failure)) setLocationsError(errorText(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLocationsLoading(false); });
    return () => controller.abort();
  }, [attempt, read]);
  async function perform(kind: 'start' | 'close' | 'sync') {
    if (actionPending.current || busy) return;
    const normalized = normalizeLane(lane);
    if (kind === 'start' && (!locations?.some(item => item.id === locationId) || normalized === null)) { setError('Pilih lokasi aktif dan isi jalur 1–100 karakter tanpa karakter kontrol.'); return; }
    if (kind === 'close' && !raid) return;
    actionPending.current = true; setAction(kind); setError(''); setMessage('');
    try {
      await run(async signal => {
        if (kind === 'sync') return { raid: await api.active(signal), message: 'Sesi aktif diperbarui.' };
        if (kind === 'close') {
          const closed = await api.close(raid!.id, signal);
          return { raid: closed, message: `Sesi razia ditutup: ${formatWita(closed.closed_at!)}.` };
        }
        try { return { raid: await api.start(locationId, normalized!, signal), message: 'Sesi razia dimulai.' }; }
        catch (failure) {
          if (failure instanceof ApiError && failure.status === 409) return { raid: await api.active(signal), message: 'Sesi aktif diperbarui dari layanan. Sesi mungkin dimulai di perangkat lain.' };
          throw failure;
        }
      }, result => {
        setRaid(result.raid?.status === 'ACTIVE' ? result.raid : null);
        if (mounted.current) { setMessage(result.message); setNeedsSync(false); }
      });
    } catch (failure) {
      if (mounted.current) {
        setError(errorText(failure));
        // An interrupted mutation can have succeeded on the server. Reconcile before retrying it.
        if (kind !== 'sync') setNeedsSync(true);
      }
    } finally { actionPending.current = false; if (mounted.current) setAction(null); }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void perform('start'); }
  return <section className="flex flex-col gap-4">
    <PageTitle>Sesi razia</PageTitle>
    {message && <p role="status" aria-live="polite">{message}</p>}
    {error && <ErrorMessage id="raid-error">{error}</ErrorMessage>}
    {needsSync && <><p>Periksa sesi di layanan sebelum mengulangi tindakan.</p><Button variant="outline" disabled={busy} onClick={() => { void perform('sync'); }}>{action === 'sync' ? 'Memeriksa…' : 'Periksa sesi aktif'}</Button></>}
    {raid ? <section aria-labelledby="active-title" className="panel flex flex-col gap-4">
      <h2 id="active-title" className="text-xl font-semibold">Sesi aktif</h2>
      <dl className="flex flex-col gap-3">
        <div><dt>Lokasi</dt><dd className="font-medium break-words">{raid.location.name}</dd></div>
        <div><dt>Jalur</dt><dd className="font-medium break-words">{raid.lane}</dd></div>
        <div><dt>Mulai</dt><dd><time dateTime={new Date(raid.started_at * 1000).toISOString()}>{formatWita(raid.started_at)}</time></dd></div>
      </dl>
      <Button asChild variant="outline"><Link to="/razia/scanner">Buka scanner</Link></Button>
      <Button disabled={busy || needsSync} onClick={() => { void perform('close'); }}>{action === 'close' ? 'Menutup sesi…' : 'Tutup sesi razia'}</Button>
    </section> : <>
      <p>Pilih lokasi dan isi jalur untuk memulai sesi milik Anda.</p>
      {locationsLoading && <p role="status">Memuat lokasi…</p>}
      {locationsError && <><ErrorMessage id="locations-error">{locationsError}</ErrorMessage><Button variant="outline" disabled={busy || locationsLoading} onClick={() => { setLocationsLoading(true); setLocationsError(''); setAttempt(value => value + 1); }}>Muat lokasi lagi</Button></>}
      {!locationsLoading && !locationsError && locations?.length === 0 && <p role="status">Belum ada lokasi aktif. Hubungi admin untuk pengaturan lokasi.</p>}
      <form onSubmit={submit} className="flex flex-col gap-4" aria-busy={busy}>
        <label className="field" data-invalid={!!error}>Lokasi<select name="location_id" value={locationId} onChange={event => setLocationId(event.target.value)} required disabled={busy || locationsLoading || !!locationsError || !locations?.length || needsSync} aria-invalid={!!error} aria-describedby={locationsError ? 'locations-error' : error ? 'raid-error' : undefined}>
          <option value="">Pilih lokasi</option>
          {locations?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label className="field" data-invalid={!!error}>Jalur<input name="lane" value={lane} onChange={event => setLane(event.target.value)} required disabled={busy || needsSync} aria-invalid={!!error} aria-describedby={error ? 'raid-error lane-help' : 'lane-help'} /></label>
        <p id="lane-help" className="text-sm">Teks bebas, 1–100 karakter. Contoh: arah menuju pusat kota.</p>
        <Button type="submit" disabled={busy || needsSync || locationsLoading || !!locationsError || !locations?.length}>{action === 'start' ? 'Memulai sesi…' : 'Mulai sesi razia'}</Button>
      </form>
    </>}
  </section>;
}
export function App() {
  const location = useLocation();
  useEffect(() => {
    const path = location.pathname;
    document.title = path === '/login' ? 'Masuk — Razia SAMSAT' : path === '/razia/scanner' ? 'Scanner — Razia SAMSAT'
      : path === '/history' ? 'Riwayat — Razia SAMSAT' : path.startsWith('/history/') ? 'Detail sesi — Razia SAMSAT'
      : path === '/admin/users' ? 'Kelola pengguna — Razia SAMSAT' : path.startsWith('/admin/users/') ? 'Detail pengguna — Razia SAMSAT' : 'Sesi razia — Razia SAMSAT';
  }, [location.pathname]);
  return <><PwaControls /><Routes>
    <Route path="/login" element={<Login />} />
    <Route path="/razia/setup" element={<Protected><Shell><RaidSetup /></Shell></Protected>} />
    <Route path="/razia/scanner" element={<Protected><Shell><Scanner /></Shell></Protected>} />
    <Route path="/history" element={<Protected><Shell><HistoryListRoute /></Shell></Protected>} />
    <Route path="/history/:id" element={<Protected><Shell><HistoryDetailRoute /></Shell></Protected>} />
    <Route path="/admin/users" element={<Protected><Shell><AdminUsersRoute /></Shell></Protected>} />
    <Route path="/admin/users/:id" element={<Protected><Shell><AdminUserRoute /></Shell></Protected>} />
    <Route path="*" element={<Protected><Home /></Protected>} />
  </Routes></>;
}
