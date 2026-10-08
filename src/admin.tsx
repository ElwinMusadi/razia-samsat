import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Link, useParams } from 'react-router';
import { useAuth } from './auth';
import { Button } from './components/ui/button';
import { useLatestRequest } from './history';
import { api, ApiError, formatWita, isAcceptablePassword, isAbort, normalizeUsername, type AdminUser, type AdminSession } from './lib/api';

const CONTROL = 'min-w-11 whitespace-normal break-words';
const POLICY_NOTE = 'Riwayat tidak dihapus. Tindakan ini tidak menutup sesi razia secara otomatis.';
function Title({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <h1 ref={ref} tabIndex={-1} className="break-words text-2xl font-semibold">{children}</h1>;
}
function Failure({ error, retry, busy = false }: { error: ApiError; retry?: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, [error]);
  return <div ref={ref} tabIndex={-1} role="alert" className="error-message flex min-w-0 flex-col gap-2">
    {error.status === 403 && <p className="font-semibold">Akses ditolak (403)</p>}
    {error.status === 404 && <p className="font-semibold">Pengguna atau sesi tidak ditemukan</p>}
    <p>{error.message}</p>
    {error.requestId && <p className="break-all text-sm">ID permintaan: {error.requestId}</p>}
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
function AdminGate({ children }: { children: ReactNode }) {
  const { auth } = useAuth();
  if (auth?.user.role !== 'ADMIN') return <section className="flex flex-col gap-3"><Title>Akses ditolak (403)</Title><p>Pengelolaan pengguna hanya tersedia untuk admin.</p></section>;
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
  return <><label className="field" data-invalid={invalid}>{label}<input ref={inputRef} name="password" type="password" autoComplete="new-password" disabled={disabled} aria-invalid={invalid} aria-describedby="password-help" /></label><PasswordHelp /></>;
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
  return <section className="flex min-w-0 flex-col gap-4" aria-busy={busy || phase !== 'ready'}>
    <Title>Kelola pengguna</Title>
    <p>Kelola akses akun dan sesi perangkat. Peran ditentukan saat akun dibuat.</p>
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
          <label className="field">Peran pengguna baru<select ref={role} name="role" defaultValue="OFFICER" disabled={busy || needsSync}><option value="OFFICER">Petugas</option><option value="ADMIN">Admin</option></select></label>
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
  return <section className="flex min-w-0 flex-col gap-4" aria-busy={busy || phase !== 'ready'}>
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
      {confirmation && <section aria-labelledby="confirm-title" className="panel flex min-w-0 flex-col gap-3">
        <h2 id="confirm-title" className="text-xl font-semibold">Konfirmasi tindakan</h2>
        <p>{confirmation === 'activate' ? `Aktifkan akun ${user.username}?` : confirmation === 'deactivate' ? `Nonaktifkan akun ${user.username} dan cabut sesinya?` : confirmation === 'password' ? `Reset kata sandi ${user.username} dan cabut SEMUA sesinya?` : confirmation === 'all' ? `Cabut SEMUA sesi ${user.username}?` : `Cabut sesi yang dipilih untuk ${user.username}?`}</p>
        {(self && (confirmation === 'password' || confirmation === 'all' || (typeof confirmation === 'object' && confirmation.session.is_current))) && <p className="font-semibold">Perangkat ini akan keluar. Anda harus masuk kembali.</p>}
        <p className="text-sm">{POLICY_NOTE}</p>
        <form onSubmit={event => { void execute(event); }} className="flex min-w-0 flex-col gap-3" noValidate>
          {confirmation === 'password' && <PasswordField inputRef={password} label="Kata sandi baru" disabled={disabled} invalid={!!operationError} />}
          <div className="flex flex-wrap gap-2"><Button type="submit" className={CONTROL} disabled={disabled}>{busy ? 'Memproses…' : 'Ya, lanjutkan'}</Button><Button type="button" variant="outline" className={CONTROL} disabled={busy} onClick={() => choose(null)}>Batal</Button></div>
        </form>
      </section>}
    </>}
  </section>;
}
