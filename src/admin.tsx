import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Link, useParams } from 'react-router';
import { useAuth } from './auth';
import { Button } from './components/ui/button';
import { useLatestRequest } from './history';
import { api, ApiError, formatWita, isAcceptablePassword, isAbort, normalizeUsername, providerLabel, VEHICLE_PROVIDERS, type AdminUser, type AdminSession, type AdminLocation, type VehicleProvider, type VehicleSourceState } from './lib/api';
import { Settings2 } from 'lucide-react';
import { PasswordInput } from './components/ui/input';
import { StatusChip } from './components/ui/status-chip';
import { PageHeader } from './components/ui/layout';

const CONTROL = 'min-w-12 whitespace-normal break-words';
const POLICY_NOTE = 'Riwayat tidak dihapus. Tindakan ini tidak menutup sesi razia secara otomatis.';
function Title({ children }: { children: ReactNode }) { return <PageHeader title={children} operational />; }
function Failure({ error, retry, busy = false }: { error: ApiError; retry?: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, [error]);
  return <div ref={ref} tabIndex={-1} role="alert" className="error-message flex min-w-0 flex-col gap-2">
    {error.status === 403 && <p className="font-semibold">Akses ditolak (403)</p>}
    {error.status === 404 && <p className="font-semibold">Pengguna atau sesi tidak ditemukan</p>}
    <p>{error.message}</p>
    {retry && error.status !== 403 && error.status !== 404 && <Button variant="outline" className={CONTROL} disabled={busy} onClick={retry}>Coba lagi</Button>}
  </div>;
}
const asError = (value: unknown) => value instanceof ApiError ? value : new ApiError('Terjadi kesalahan. Coba lagi.');
// A failed response can hide a committed write, including an invalid success body. Never replay it.
const ambiguous = (error: ApiError) => error.status === 0 || error.status >= 500;
const terminal = (error: ApiError | null) => error?.status === 403 || error?.status === 404;
function merge<T extends { id: string }>(previous: T[], next: T[]) {
  const entries = new Map(previous.map(item => [item.id, item]));
  for (const item of next) if (!entries.has(item.id)) entries.set(item.id, item);
  return [...entries.values()];
}
function UserFacts({ user }: { user: AdminUser }) {
  return <dl className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
    <div><dt>Peran</dt><dd className="font-semibold">{user.role === 'ADMIN' ? 'Admin' : 'Petugas'}</dd></div>
    <div><dt>Status akun</dt><dd className="font-semibold">{user.is_active ? 'Aktif' : 'Nonaktif'}</dd></div>
    <div><dt>Sesi perangkat aktif</dt><dd className="font-semibold">{user.active_session_count}</dd></div>
    <div><dt>Dibuat</dt><dd>{formatWita(user.created_at)}</dd></div>
    <div><dt>Diperbarui</dt><dd>{formatWita(user.updated_at)}</dd></div>
  </dl>;
}
/** Scope safety is usability only. The backend rechecks the exact actor on every operation. */
function AdminGate({ children, subject = 'pengguna' }: { children: ReactNode; subject?: string }) {
  const { auth } = useAuth();
  if (auth?.user.role !== 'ADMIN') return <section className="flex flex-col gap-3"><Title>Akses ditolak (403)</Title><p>Pengelolaan {subject} hanya tersedia untuk admin.</p></section>;
  return children;
}
function useIdentity() {
  const { auth } = useAuth();
  return `${auth?.user.id}:${auth?.user.role}:${auth?.session.expires_at}`;
}
export function AdminUsersRoute() {
  const identity = useIdentity();
  return <AdminGate><AdminUsers key={identity} /></AdminGate>;
}
export function AdminUserRoute() {
  const { id = '' } = useParams();
  const identity = useIdentity();
  return <AdminGate><AdminDetail key={`${identity}:${id}`} id={id} /></AdminGate>;
}
/** Cancels route-local mutations before paint; stale failures cannot invalidate a new identity. */
function useAdminOperation() {
  const { run } = useAuth();
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => { controller.current?.abort(); }, []);
  const perform = async <T,>(operation: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void) => {
    if (pending.current) return false;
    pending.current = true;
    const local = new AbortController(); controller.current = local;
    try {
      return await run(async signal => {
        const abort = () => local.abort();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) local.abort();
        try {
          const value = await operation(local.signal);
          if (local.signal.aborted) throw new DOMException('Request aborted', 'AbortError');
          return value;
        } catch (error) {
          if (local.signal.aborted) throw new DOMException('Request aborted', 'AbortError');
          throw error;
        } finally { signal.removeEventListener('abort', abort); }
      }, value => { if (!local.signal.aborted) accept(value); }, 'ADMIN');
    } finally { pending.current = false; controller.current = null; }
  };
  return { pending, perform };
}
function PasswordHelp() {
  return <p id="password-help" className="text-sm">Gunakan kata sandi yang kuat dan unik. Isian wajib diisi, maksimal 1024 byte UTF-8; tidak dinormalisasi.</p>;
}
/** Mounted with the conditional field, so cleanup captures the actual DOM input, never null. */
function PasswordField({ inputRef, label, disabled, invalid }: { inputRef: RefObject<HTMLInputElement | null>; label: string; disabled: boolean; invalid: boolean }) {
  useLayoutEffect(() => {
    const input = inputRef.current;
    return () => { if (input) input.value = ''; };
  }, [inputRef]);
  return <><div className="field" data-invalid={invalid}><label htmlFor="admin-password">{label}</label><PasswordInput id="admin-password" inputRef={inputRef} name="password" autoComplete="new-password" disabled={disabled} aria-invalid={invalid} aria-describedby="password-help" /></div><PasswordHelp /></>;
}
function AdminUsers() {
  const { busy } = useAuth();
  const { start, cancel } = useLatestRequest();
  const { pending, perform } = useAdminOperation();
  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const role = useRef<HTMLSelectElement>(null);
  const mounted = useRef(true);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'more' | 'ready'>('loading');
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [moreFailure, setMoreFailure] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState<ApiError | null>(null);
  const [needsSync, setNeedsSync] = useState(false);
  const [created, setCreated] = useState<AdminUser | null>(null);
  const fetchHead = useCallback((reconcile = false) => {
    start(signal => api.adminUsers({}, signal), page => {
      setUsers(merge([], page.users)); setCursor(page.next_cursor); setPhase('ready'); setFailure(null); setMoreFailure(null);
      if (reconcile) setNeedsSync(false);
    }, error => { const rejected = asError(error); if (terminal(rejected)) setUsers([]); setFailure(rejected); setPhase('ready'); });
  }, [start]);
  useEffect(() => { fetchHead(); return cancel; }, [fetchHead, cancel]);
  useLayoutEffect(() => {
    mounted.current = true; const input = password.current; const name = username.current;
    return () => { mounted.current = false; if (input) input.value = ''; if (name) name.value = ''; };
  }, []);
  useLayoutEffect(() => { if (busy) { cancel(); if (password.current) password.current.value = ''; } }, [busy, cancel]);
  function reload(reconcile = false) { if (busy) return; setPhase('loading'); setFailure(null); fetchHead(reconcile); }
  function more() {
    if (!cursor || phase !== 'ready' || busy) return;
    setPhase('more'); setMoreFailure(null);
    start(signal => api.adminUsers({ cursor }, signal), page => {
      setUsers(previous => merge(previous, page.users)); setCursor(page.next_cursor); setPhase('ready');
    }, error => { const rejected = asError(error); if (terminal(rejected)) { setUsers([]); setFailure(rejected); } else setMoreFailure(rejected); setPhase('ready'); });
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || busy || phase !== 'ready' || needsSync || terminal(failure)) return;
    const name = normalizeUsername(username.current?.value ?? '');
    const input = password.current;
    const selected = role.current?.value;
    if (!input) return;
    if (!name || !isAcceptablePassword(input.value) || (selected !== 'ADMIN' && selected !== 'OFFICER')) {
      input.value = ''; setFormError(new ApiError('Periksa nama pengguna, peran, dan kata sandi. Gunakan kata sandi yang kuat dan unik.', 400, 'INVALID_INPUT')); return;
    }
    setFormError(null); setCreated(null);
    const operation = perform(signal => api.adminCreate(name, input.value, selected, signal), user => {
      setCreated(user); setUsers(previous => [user, ...previous.filter(item => item.id !== user.id)]);
      if (username.current) username.current.value = '';
    });
    input.value = '';
    try { await operation; }
    catch (error) {
      if (!mounted.current || isAbort(error)) return;
      const rejected = asError(error); setFormError(rejected);
      if (ambiguous(rejected)) setNeedsSync(true);
      if (terminal(rejected)) { setUsers([]); setFailure(rejected); }
    }
  }
  if (busy && !pending.current) return <p role="status">Memproses sesi…</p>;
  return <section className="reading-layout flex min-w-0 flex-col gap-4" aria-busy={busy || phase !== 'ready'}>
    <Title>Kelola pengguna</Title>
    <p>Kelola akses akun dan sesi perangkat. Peran ditentukan saat akun dibuat.</p>
    {/* Settings entry lives here so the bottom navigation keeps its current five destinations. */}
    <Link to="/admin/settings" className="panel flex min-h-11 min-w-0 items-center gap-3 hover:bg-accent" aria-label="Pengaturan sumber data">
      <Settings2 aria-hidden="true" size={20} className="shrink-0" />
      <span className="flex min-w-0 flex-col"><span className="font-semibold">Pengaturan sumber data</span><span className="text-sm">Pilih BPAD atau Potensi NTT untuk semua pengguna.</span></span>
    </Link>
    {phase === 'loading' && <p role="status">Memuat pengguna…</p>}
    {failure && <Failure error={failure} retry={() => reload()} busy={busy} />}
    {!terminal(failure) && <>
      <Button variant="outline" className={`${CONTROL} self-start`} disabled={busy || phase === 'loading'} onClick={() => reload()}>Muat ulang pengguna</Button>
      {phase === 'ready' && !failure && users.length === 0 && <p role="status">Belum ada pengguna.</p>}
      {users.length > 0 && <ul aria-label="Daftar pengguna" className="flex min-w-0 flex-col gap-3">
        {users.map(user => <li key={user.id}><Link to={`/admin/users/${encodeURIComponent(user.id)}`} className="panel flex min-h-11 min-w-0 flex-col gap-2 hover:bg-accent">
          <span className="break-all text-lg font-semibold">{user.username}</span><UserFacts user={user} />
        </Link></li>)}
      </ul>}
      {moreFailure && <Failure error={moreFailure} retry={more} busy={busy || phase !== 'ready'} />}
      {cursor && !moreFailure && <Button variant="outline" className={CONTROL} disabled={busy || phase !== 'ready'} onClick={more}>{phase === 'more' ? 'Memuat…' : 'Muat lebih banyak pengguna'}</Button>}
      <section aria-labelledby="create-title" className="panel flex min-w-0 flex-col gap-4">
        <h2 id="create-title" className="text-xl font-semibold">Tambah pengguna</h2>
        {created && <p role="status">Pengguna {created.username} dibuat. <Link className="inline-flex min-h-11 items-center underline" to={`/admin/users/${encodeURIComponent(created.id)}`}>Buka detail pengguna</Link></p>}
        {formError && <Failure error={formError} />}
        {needsSync && <><p>Hasil tindakan belum pasti. Periksa daftar dari layanan sebelum mengirim lagi; jangan membuat akun duplikat.</p><Button variant="outline" className={CONTROL} disabled={busy || phase === 'loading'} onClick={() => reload(true)}>Periksa hasil tindakan</Button></>}
        <form onSubmit={event => { void create(event); }} className="flex min-w-0 flex-col gap-4" noValidate>
          <label className="field">Nama pengguna baru<input ref={username} name="username" autoComplete="off" disabled={busy || needsSync} aria-describedby="username-help" /></label>
          <p id="username-help" className="text-sm">1–100 karakter: huruf ASCII, angka, titik, garis bawah, atau tanda hubung. Spasi tepi dihapus dan huruf menjadi kecil; layanan menentukan ketersediaan.</p>
          <label className="field">Peran pengguna baru<span className="select-control"><select ref={role} name="role" defaultValue="OFFICER" disabled={busy || needsSync}><option value="OFFICER">Petugas</option><option value="ADMIN">Admin</option></select></span></label>
          <PasswordField inputRef={password} label="Kata sandi awal" disabled={busy || needsSync} invalid={!!formError} />
          <Button type="submit" className={CONTROL} disabled={busy || needsSync}>{busy ? 'Menyimpan…' : 'Buat pengguna'}</Button>
        </form>
      </section>
    </>}
  </section>;
}

type Action = 'activate' | 'deactivate' | 'password' | 'all' | { session: AdminSession };
function AdminDetail({ id }: { id: string }) {
  const { auth, busy, administrativeSignOut } = useAuth();
  const { start, cancel } = useLatestRequest();
  const { pending, perform } = useAdminOperation();
  const password = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [user, setUser] = useState<AdminUser | null>(null);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'more' | 'ready'>('loading');
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [moreFailure, setMoreFailure] = useState<ApiError | null>(null);
  const [operationError, setOperationError] = useState<ApiError | null>(null);
  const [needsSync, setNeedsSync] = useState(false);
  const [confirmation, setConfirmation] = useState<Action | null>(null);
  const [message, setMessage] = useState('');
  const fetchHead = useCallback((reconcile = false) => {
    start(signal => Promise.all([api.adminUser(id, signal), api.adminSessions(id, {}, signal)]), ([target, page]) => {
      setUser(target); setSessions(merge([], page.sessions)); setCursor(page.next_cursor); setPhase('ready'); setFailure(null); setMoreFailure(null);
      if (reconcile) { setNeedsSync(false); setConfirmation(null); setMessage('Data layanan diperiksa. Jika tindakan masih diperlukan, pilih dan konfirmasi lagi.'); }
    }, error => { setUser(null); setSessions([]); setFailure(asError(error)); setPhase('ready'); });
  }, [id, start]);
  useEffect(() => { fetchHead(); return cancel; }, [fetchHead, cancel]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => { if (busy) { cancel(); if (password.current) password.current.value = ''; } }, [busy, cancel]);
  const self = user?.id === auth?.user.id;
  function reload(reconcile = false) { if (busy) return; setPhase('loading'); setFailure(null); fetchHead(reconcile); }
  function more() {
    if (!cursor || phase !== 'ready' || busy) return;
    setPhase('more'); setMoreFailure(null);
    start(signal => api.adminSessions(id, { cursor }, signal), page => {
      setSessions(previous => merge(previous, page.sessions)); setCursor(page.next_cursor); setPhase('ready');
    }, error => { const rejected = asError(error); if (terminal(rejected)) { setUser(null); setSessions([]); setFailure(rejected); } else setMoreFailure(rejected); setPhase('ready'); });
  }
  function choose(action: Action | null) {
    if (busy || needsSync) return;
    if (password.current) password.current.value = '';
    setConfirmation(action); setMessage(''); setOperationError(null);
  }
  async function execute(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!confirmation || !user || busy || phase !== 'ready' || pending.current || needsSync || (confirmation === 'deactivate' && self)) return;
    const action = confirmation;
    const input = password.current;
    if (action === 'password' && (!input || !isAcceptablePassword(input.value))) {
      if (input) input.value = '';
      setOperationError(new ApiError('Isi kata sandi baru yang valid. Gunakan kata sandi yang kuat dan unik.', 400, 'INVALID_INPUT')); return;
    }
    setOperationError(null); setMessage('');
    const operation = perform(async signal => {
      if (action === 'activate' || action === 'deactivate') return { user: await (action === 'activate' ? api.adminActivate(id, signal) : api.adminDeactivate(id, signal)), signed_out: false };
      if (action === 'password') return api.adminPassword(id, input!.value, signal);
      return api.adminRevoke(id, action === 'all' ? undefined : action.session.id, signal);
    }, result => {
      if (result.signed_out) { administrativeSignOut(action === 'password' ? 'password' : 'sessions'); return; }
      setUser(result.user); setConfirmation(null);
      if (action === 'password' || action === 'all' || action === 'deactivate') { setSessions([]); setCursor(null); }
      else if (typeof action === 'object') setSessions(previous => previous.filter(item => item.id !== action.session.id));
      setMessage(action === 'password' ? 'Kata sandi diperbarui. Semua sesi pengguna dicabut.' : action === 'activate' ? 'Akun diaktifkan. Sesi lama tidak dipulihkan.' : action === 'deactivate' ? 'Akun dinonaktifkan dan sesi pengguna dicabut.' : 'Sesi perangkat dicabut. Pengguna aktif tetap dapat masuk kembali.');
    });
    if (input) input.value = '';
    try { await operation; }
    catch (error) {
      if (!mounted.current || isAbort(error)) return;
      const rejected = asError(error); setOperationError(rejected);
      if (ambiguous(rejected)) setNeedsSync(true);
      if (terminal(rejected)) { setUser(null); setSessions([]); setFailure(rejected); }
    }
  }
  const disabled = busy || needsSync || phase !== 'ready';
  if (busy && !pending.current) return <p role="status">Memproses sesi…</p>;
  return <section className="reading-layout flex min-w-0 flex-col gap-4" aria-busy={busy || phase !== 'ready'}>
    <Link to="/admin/users" className="inline-flex min-h-11 min-w-11 items-center self-start underline">Kembali ke daftar pengguna</Link>
    <Title>Detail pengguna</Title>
    {phase === 'loading' && <p role="status">Memuat detail pengguna…</p>}
    {failure && <Failure error={failure} retry={() => reload()} busy={busy} />}
    {user && !terminal(failure) && <>
      <section className="panel flex min-w-0 flex-col gap-3"><h2 className="break-all text-xl font-semibold">{user.username}{self ? ' (akun Anda)' : ''}</h2><UserFacts user={user} /></section>
      <p className="text-sm">Akun nonaktif tidak dapat masuk. Aktivasi tidak memulihkan sesi lama. {POLICY_NOTE}</p>
      {message && <p role="status">{message}</p>}
      {operationError && <Failure error={operationError} />}
      {needsSync && <><p>Hasil tindakan belum pasti. Periksa data layanan sebelum mengirim tindakan lagi. Kata sandi tidak disimpan; isikan ulang hanya jika reset masih diperlukan.</p><Button variant="outline" className={CONTROL} disabled={busy || phase === 'loading'} onClick={() => reload(true)}>Periksa hasil tindakan</Button></>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className={CONTROL} disabled={busy || phase === 'loading'} onClick={() => reload()}>Muat ulang detail</Button>
        <Button variant="outline" className={CONTROL} disabled={disabled || (self && user.is_active)} aria-describedby={self && user.is_active ? 'self-deactivate-help' : undefined} onClick={() => choose(user.is_active ? 'deactivate' : 'activate')}>{user.is_active ? 'Nonaktifkan akun' : 'Aktifkan akun'}</Button>
        <Button variant="outline" className={CONTROL} disabled={disabled} onClick={() => choose('password')}>Reset kata sandi</Button>
      </div>
      {self && user.is_active && <p id="self-deactivate-help" className="text-sm">Akun Anda sendiri tidak dapat dinonaktifkan. Layanan juga menolak tindakan ini.</p>}
      <section aria-labelledby="sessions-title" className="panel flex min-w-0 flex-col gap-3">
        <h2 id="sessions-title" className="text-xl font-semibold">Sesi perangkat aktif</h2>
        <p className="text-sm">Hanya sesi pengguna ini yang ditampilkan. Pencabutan sesi bukan pemblokiran login baru; nonaktifkan akun untuk mencegah login. {POLICY_NOTE}</p>
        {sessions.length === 0 && <p role="status">Tidak ada sesi perangkat aktif.</p>}
        {sessions.length > 0 && <ul aria-label="Sesi perangkat pengguna" className="flex min-w-0 flex-col gap-3">
          {sessions.map((session, index) => <li key={session.id} className="flex min-w-0 flex-col gap-2 rounded-md border border-input p-3">
            <p className="font-semibold">Sesi {index + 1}{session.is_current ? ' · Perangkat ini' : ''}</p>
            <p>Dibuat: {formatWita(session.created_at)}</p><p>Berakhir: {formatWita(session.expires_at)}</p>
            <Button variant="outline" className={CONTROL} disabled={disabled} onClick={() => choose({ session })}>Cabut sesi {index + 1}</Button>
          </li>)}
        </ul>}
        {moreFailure && <Failure error={moreFailure} retry={more} busy={busy || phase !== 'ready'} />}
        {cursor && !moreFailure && <Button variant="outline" className={CONTROL} disabled={disabled} onClick={more}>{phase === 'more' ? 'Memuat…' : 'Muat lebih banyak sesi'}</Button>}
        <Button variant="outline" className={CONTROL} disabled={disabled || user.active_session_count === 0} onClick={() => choose('all')}>Cabut semua sesi</Button>
      </section>
      {confirmation && <section aria-labelledby="confirm-title" className="panel confirmation flex min-w-0 flex-col gap-3">
        <h2 id="confirm-title" className="text-xl font-semibold">Konfirmasi tindakan</h2>
        <p>{confirmation === 'activate' ? `Aktifkan akun ${user.username}?` : confirmation === 'deactivate' ? `Nonaktifkan akun ${user.username} dan cabut sesinya?` : confirmation === 'password' ? `Reset kata sandi ${user.username} dan cabut SEMUA sesinya?` : confirmation === 'all' ? `Cabut SEMUA sesi ${user.username}?` : `Cabut sesi yang dipilih untuk ${user.username}?`}</p>
        {(self && (confirmation === 'password' || confirmation === 'all' || (typeof confirmation === 'object' && confirmation.session.is_current))) && <p className="font-semibold">Perangkat ini akan keluar. Anda harus masuk kembali.</p>}
        <p className="text-sm">{POLICY_NOTE}</p>
        <form onSubmit={event => { void execute(event); }} className="flex min-w-0 flex-col gap-3" noValidate>
          {confirmation === 'password' && <PasswordField inputRef={password} label="Kata sandi baru" disabled={disabled} invalid={!!operationError} />}
          <div className="flex flex-wrap gap-2"><Button type="submit" variant={confirmation === 'activate' ? 'default' : 'destructive'} className={CONTROL} disabled={disabled}>{busy ? 'Memproses…' : 'Ya, lanjutkan'}</Button><Button type="button" variant="outline" className={CONTROL} disabled={busy} onClick={() => choose(null)}>Batal</Button></div>
        </form>
      </section>}
    </>}
  </section>;
}

export function AdminLocationsRoute() {
  const identity = useIdentity();
  return <AdminGate subject="lokasi razia"><AdminLocations key={identity} /></AdminGate>;
}
function AdminLocations() {
  const { busy } = useAuth();
  const { start, cancel } = useLatestRequest();
  const { pending, perform } = useAdminOperation();
  const nameInput = useRef<HTMLInputElement>(null);
  const editInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [locations, setLocations] = useState<AdminLocation[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready'>('loading');
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState<ApiError | null>(null);
  const [needsSync, setNeedsSync] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editError, setEditError] = useState<ApiError | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const fetchHead = useCallback((reconcile = false) => {
    start(signal => api.adminLocations(signal), rows => {
      setLocations(rows); setPhase('ready'); setFailure(null);
      if (reconcile) setNeedsSync(false);
    }, error => { const rejected = asError(error); if (terminal(rejected)) setLocations([]); setFailure(rejected); setPhase('ready'); });
  }, [start]);
  useEffect(() => { fetchHead(); return cancel; }, [fetchHead, cancel]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { if (busy) cancel(); }, [busy, cancel]);
  function reload(reconcile = false) { if (busy) return; setPhase('loading'); setFailure(null); fetchHead(reconcile); }
  const validName = (value: string) => { const name = value.trim(); return name.length >= 1 && name.length <= 200 ? name : null; };
  async function mutate(operation: (signal: AbortSignal) => Promise<AdminLocation>, accept: (row: AdminLocation) => void, onError: (error: ApiError) => void) {
    try { await perform(operation, accept); }
    catch (error) {
      if (!mounted.current || isAbort(error)) return;
      const rejected = asError(error); onError(rejected);
      if (ambiguous(rejected)) setNeedsSync(true);
      if (terminal(rejected)) { setLocations([]); setFailure(rejected); }
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || busy || phase !== 'ready' || needsSync || terminal(failure)) return;
    const name = validName(nameInput.current?.value ?? '');
    if (name === null) { setFormError(new ApiError('Nama lokasi wajib diisi, maksimal 200 karakter.', 400, 'INVALID_INPUT')); return; }
    setFormError(null);
    await mutate(signal => api.adminCreateLocation(name, signal), row => {
      setLocations(previous => [...previous.filter(item => item.id !== row.id), row].sort((a, b) => a.name.localeCompare(b.name, 'id')));
      if (nameInput.current) nameInput.current.value = '';
    }, setFormError);
  }
  async function rename(event: FormEvent<HTMLFormElement>, row: AdminLocation) {
    event.preventDefault();
    if (pending.current || busy || needsSync || terminal(failure)) return;
    const name = validName(editInput.current?.value ?? '');
    if (name === null) { setEditError(new ApiError('Nama lokasi wajib diisi, maksimal 200 karakter.', 400, 'INVALID_INPUT')); return; }
    setEditError(null);
    await mutate(signal => api.adminUpdateLocation(row.id, { name }, signal), updated => {
      setLocations(previous => previous.map(item => item.id === updated.id ? updated : item).sort((a, b) => a.name.localeCompare(b.name, 'id')));
      setEditingId(null);
    }, setEditError);
  }
  async function setActive(row: AdminLocation, is_active: boolean) {
    if (pending.current || busy || needsSync || terminal(failure)) return;
    setConfirmingId(null);
    await mutate(signal => api.adminUpdateLocation(row.id, { is_active }, signal), updated => {
      setLocations(previous => previous.map(item => item.id === updated.id ? updated : item));
    }, setFormError);
  }
  async function remove(row: AdminLocation) {
    if (pending.current || busy || needsSync || terminal(failure)) return;
    setConfirmingId(null);
    await mutate(signal => api.adminDeleteLocation(row.id, signal), updated => {
      setLocations(previous => previous.map(item => item.id === updated.id ? updated : item));
    }, setFormError);
  }
  if (busy && !pending.current) return <p role="status">Memproses sesi…</p>;
  return <section className="reading-layout flex min-w-0 flex-col gap-4" aria-busy={busy || phase !== 'ready'}>
    <Title>Kelola lokasi razia</Title>
    <p>Tambah, ubah, dan nonaktifkan lokasi razia. Lokasi yang dinonaktifkan tidak muncul di pilihan sesi baru, tetapi riwayat sesi tetap utuh.</p>
    {phase === 'loading' && <p role="status">Memuat lokasi…</p>}
    {failure && <Failure error={failure} retry={() => reload()} busy={busy} />}
    {!terminal(failure) && <>
      {needsSync && <p role="alert" className="error-message">Perubahan terakhir belum pasti tersimpan. Muat ulang sebelum melanjutkan.</p>}
      <form onSubmit={event => { void create(event); }} className="panel flex min-w-0 flex-col gap-3" noValidate>
        <div className="field"><label htmlFor="location-name">Nama lokasi baru</label>
          <input id="location-name" ref={nameInput} name="name" type="text" autoComplete="off" maxLength={200} disabled={busy || phase !== 'ready'} aria-invalid={!!formError} placeholder="cth. Jln. El Tari - DPRD Provinsi NTT" /></div>
        {formError && <p role="alert" className="error-message">{formError.message}</p>}
        <div><Button type="submit" className={CONTROL} disabled={busy || phase !== 'ready'}>Tambah lokasi</Button></div>
      </form>
      {phase === 'ready' && !failure && locations.length === 0 && <p role="status">Belum ada lokasi.</p>}
      {locations.length > 0 && <ul aria-label="Daftar lokasi razia" className="flex min-w-0 flex-col gap-3">
        {locations.map(row => <li key={row.id} className="panel flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 break-words text-lg font-semibold">{row.name}</span>
            <StatusChip tone={row.is_active ? 'success' : 'neutral'}>{row.is_active ? 'Aktif' : 'Nonaktif'}</StatusChip>
          </div>
          <p className="text-sm">Diperbarui {formatWita(row.updated_at)}</p>
          {editingId === row.id ? <form onSubmit={event => { void rename(event, row); }} className="flex min-w-0 flex-col gap-2" noValidate>
            <div className="field"><label htmlFor={`edit-${row.id}`}>Nama lokasi</label>
              <input id={`edit-${row.id}`} ref={editInput} name="name" type="text" autoComplete="off" maxLength={200} defaultValue={row.name} disabled={busy} aria-invalid={!!editError} /></div>
            {editError && <p role="alert" className="error-message">{editError.message}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className={CONTROL} disabled={busy}>Simpan</Button>
              <Button type="button" variant="outline" className={CONTROL} disabled={busy} onClick={() => { setEditingId(null); setEditError(null); }}>Batal</Button>
            </div>
          </form> : confirmingId === row.id ? <div className="flex min-w-0 flex-col gap-2">
            <p className="font-semibold">Nonaktifkan lokasi “{row.name}”?</p>
            <p className="text-sm">Lokasi tidak muncul di pilihan sesi baru. Riwayat sesi tetap utuh.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="destructive" className={CONTROL} disabled={busy} onClick={() => { void remove(row); }}>Ya, nonaktifkan</Button>
              <Button type="button" variant="outline" className={CONTROL} disabled={busy} onClick={() => setConfirmingId(null)}>Batal</Button>
            </div>
          </div> : <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className={CONTROL} disabled={busy} onClick={() => { setEditingId(row.id); setEditError(null); setConfirmingId(null); }}>Ubah nama</Button>
            {row.is_active
              ? <Button type="button" variant="outline" className={CONTROL} disabled={busy} onClick={() => { setConfirmingId(row.id); setEditingId(null); }}>Nonaktifkan</Button>
              : <Button type="button" variant="outline" className={CONTROL} disabled={busy} onClick={() => { void setActive(row, true); }}>Aktifkan</Button>}
          </div>}
        </li>)}
      </ul>}
    </>}
  </section>;
}

export function AdminSettingsRoute() {
  const identity = useIdentity();
  return <AdminGate subject="pengaturan"><AdminSettings key={identity} /></AdminGate>;
}
const providerHelp: Record<VehicleProvider, string> = {
  BPAD: 'Data langsung dari layanan BPAD pada saat pencarian.',
  POTENSI_NTT: 'Salinan (snapshot) data BPAD yang ditarik berkala. Hasil menampilkan waktu penarikan snapshot, bukan data BPAD saat ini.',
};
/**
 * Global vehicle data source. The selection is stored server-side and applies to every user on their
 * next lookup; in-flight lookups finish with the provider they started with. Saving uses compare-and-set,
 * so a concurrent change by another admin is reported (409) and must be reloaded, never replayed.
 */
function AdminSettings() {
  const { busy } = useAuth();
  const { start, cancel } = useLatestRequest();
  const { pending, perform } = useAdminOperation();
  const mounted = useRef(true);
  const [state, setState] = useState<VehicleSourceState | null>(null);
  const [selection, setSelection] = useState<VehicleProvider | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready'>('loading');
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [operationError, setOperationError] = useState<ApiError | null>(null);
  const [needsSync, setNeedsSync] = useState<'ambiguous' | 'conflict' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('');
  const fetchHead = useCallback((reconcile = false) => {
    start(signal => api.vehicleSource(signal), next => {
      setState(next); setSelection(next.setting.provider); setPhase('ready'); setFailure(null); setConfirming(false);
      if (reconcile) { setNeedsSync(null); setOperationError(null); setMessage('Pengaturan dimuat ulang dari layanan. Periksa sumber aktif sebelum mengubah lagi.'); }
    }, error => { setState(null); setFailure(asError(error)); setPhase('ready'); });
  }, [start]);
  useEffect(() => { fetchHead(); return cancel; }, [fetchHead, cancel]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { if (busy) cancel(); }, [busy, cancel]);
  function reload(reconcile = false) { if (busy) return; setPhase('loading'); setFailure(null); fetchHead(reconcile); }
  const disabled = busy || needsSync !== null || phase !== 'ready' || !state;
  const changed = !!state && selection !== null && selection !== state.setting.provider;
  const potensiBlocked = !!state && !state.potensi_credentials_configured;
  async function save() {
    if (!state || !selection || !changed || disabled || pending.current) return;
    if (selection === 'POTENSI_NTT' && potensiBlocked) return;
    const expected = state.setting.version;
    setOperationError(null); setMessage('');
    try {
      await perform(signal => api.updateVehicleSource(selection, expected, signal), next => {
        setState(next); setSelection(next.setting.provider); setConfirming(false);
        setMessage(`Sumber data ${providerLabel(next.setting.provider)} berlaku untuk semua pengguna pada pencarian berikutnya.`);
      });
    } catch (error) {
      if (!mounted.current || isAbort(error)) return;
      const rejected = asError(error); setOperationError(rejected); setConfirming(false);
      if (rejected.code === 'VEHICLE_SOURCE_CONFLICT') setNeedsSync('conflict');
      else if (ambiguous(rejected)) setNeedsSync('ambiguous');
      if (terminal(rejected)) { setState(null); setFailure(rejected); }
    }
  }
  if (busy && !pending.current) return <p role="status">Memproses sesi…</p>;
  return <section className="reading-layout flex min-w-0 flex-col gap-4" aria-busy={busy || phase !== 'ready'}>
    <Link to="/admin/users" className="inline-flex min-h-11 min-w-11 items-center self-start underline">Kembali ke Admin</Link>
    <Title>Pengaturan sumber data</Title>
    <p>Pilihan berlaku global untuk semua pengguna dan disimpan di server. Perubahan berlaku pada pencarian berikutnya; pencarian yang sedang berjalan menyelesaikan sumber yang sedang dipakai.</p>
    {phase === 'loading' && <p role="status">Memuat pengaturan…</p>}
    {failure && <Failure error={failure} retry={() => reload()} busy={busy} />}
    {state && !terminal(failure) && <>
      <dl className="panel grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Pengaturan aktif">
        <div><dt>Sumber aktif</dt><dd className="font-semibold" data-active-provider={state.setting.provider}>{providerLabel(state.setting.provider)}</dd></div>
        <div><dt>Versi pengaturan</dt><dd className="font-semibold">{state.setting.version}</dd></div>
        <div><dt>Diubah</dt><dd>{formatWita(state.setting.updated_at)}</dd></div>
        <div><dt>Oleh</dt><dd className="break-all">{state.setting.updated_by ? state.setting.updated_by.username : 'Pengaturan awal'}</dd></div>
      </dl>
      {message && <p role="status">{message}</p>}
      {operationError && <Failure error={operationError} />}
      {needsSync && <>
        <p>{needsSync === 'conflict' ? 'Pengaturan diubah admin lain sejak halaman ini dimuat. Muat ulang untuk melihat sumber aktif, lalu putuskan apakah perubahan masih diperlukan.' : 'Hasil penyimpanan belum pasti. Muat ulang pengaturan dari layanan sebelum mencoba lagi; jangan mengirim ulang begitu saja.'}</p>
        <Button variant="outline" className={CONTROL} disabled={busy || phase === 'loading'} onClick={() => reload(true)}>Muat ulang pengaturan</Button>
      </>}
      <form className="panel flex min-w-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); if (changed && !disabled) setConfirming(true); }} noValidate>
        <fieldset className="flex min-w-0 flex-col gap-3" disabled={disabled}>
          <legend className="text-xl font-semibold">Sumber data NOPOL</legend>
          {VEHICLE_PROVIDERS.map(provider => {
            const blocked = provider === 'POTENSI_NTT' && potensiBlocked;
            return <label key={provider} className={`flex min-h-11 min-w-0 items-start gap-3 rounded-md border border-input p-3 ${blocked ? 'opacity-70' : ''}`}>
              <input type="radio" name="provider" value={provider} className="mt-1 size-5 shrink-0" checked={selection === provider} disabled={disabled || blocked} aria-labelledby={`provider-${provider}-label`} aria-describedby={`provider-${provider}-help`}
                onChange={() => { setSelection(provider); setConfirming(false); setOperationError(null); setMessage(''); }} />
              <span className="flex min-w-0 flex-col gap-1">
                <span id={`provider-${provider}-label`} className="font-semibold">{providerLabel(provider)}{state.setting.provider === provider ? ' · aktif' : ''}</span>
                <span id={`provider-${provider}-help`} className="text-sm">{providerHelp[provider]}{blocked ? ' Belum dapat dipilih: kredensial layanan Potensi NTT belum tersedia di server. Ketersediaan kredensial bukan jaminan izin akses sudah benar.' : ''}</span>
              </span>
            </label>;
          })}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" className={CONTROL} disabled={disabled || !changed || confirming}>Simpan</Button>
          {/* Any reload after a conflict or an uncertain save is a reconciliation; it clears the lock only on fresh server data. */}
          <Button type="button" variant="outline" className={CONTROL} disabled={busy || phase === 'loading'} onClick={() => reload(needsSync !== null)}>Muat ulang</Button>
        </div>
      </form>
      {confirming && selection && changed && <section aria-labelledby="source-confirm-title" className="panel confirmation flex min-w-0 flex-col gap-3">
        <h2 id="source-confirm-title" className="text-xl font-semibold">Konfirmasi perubahan sumber</h2>
        <p>Terapkan <span className="font-semibold">{providerLabel(selection)}</span> sebagai sumber data untuk semua pengguna? Perubahan berlaku pada pencarian berikutnya.</p>
        {selection === 'POTENSI_NTT' && <p className="text-sm">Potensi NTT adalah snapshot BPAD, bukan data BPAD saat ini. Hasil akan menampilkan waktu penarikan snapshot.</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="destructive" className={CONTROL} disabled={disabled} onClick={() => { void save(); }}>{busy ? 'Menyimpan…' : 'Ya, terapkan'}</Button>
          <Button type="button" variant="outline" className={CONTROL} disabled={busy} onClick={() => setConfirming(false)}>Batal</Button>
        </div>
      </section>}
    </>}
  </section>;
}
