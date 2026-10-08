import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from './components/ui/button';
import { useAuth } from './auth';
import { api, ApiError, formatWita, isAbort, type HistoryCheck, type HistoryRaid, type HistorySummary, type VehicleStatus as Status } from './lib/api';
import { LookupOutcomeBadge, VehicleStatus } from './components/vehicle';
import { EmptyState, PageHeader, Spinner } from './components/ui/layout';

type Failure = { kind: 'forbidden' } | { kind: 'not-found' } | { kind: 'error'; error: ApiError | null };
function classify(failure: unknown): Failure {
  if (failure instanceof ApiError && failure.status === 403) return { kind: 'forbidden' };
  if (failure instanceof ApiError && failure.status === 404) return { kind: 'not-found' };
  return { kind: 'error', error: failure instanceof ApiError ? failure : null };
}
/** Appends keyset pages while dropping IDs already shown (late inserts can shift page boundaries). */
function mergeById<T extends { id: string }>(current: T[], next: T[]): T[] {
  const seen = new Set(current.map(item => item.id));
  const merged = [...current];
  for (const item of next) {
    if (seen.has(item.id)) continue;
    seen.add(item.id); merged.push(item);
  }
  return merged;
}

/**
 * Single in-flight protected read with its own AbortController and sequence. A newer start,
 * cancel or unmount makes older responses inert; stale failures (including 401) are turned into
 * aborts before read() can invalidate the current authentication.
 */
// The shared protected-read hook intentionally stays with its existing consumers.
// eslint-disable-next-line react/only-export-components
export function useLatestRequest() {
  const { read } = useAuth();
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const cancel = useCallback(() => { controller.current?.abort(); controller.current = null; sequence.current++; }, []);
  // Invalidate during commit cleanup, before paint or a stale 401 microtask can affect new context.
  useLayoutEffect(() => cancel, [cancel]);
  const start = useCallback(<T,>(operation: (signal: AbortSignal) => Promise<T>, accept: (result: T) => void, reject: (failure: unknown) => void) => {
    cancel();
    const seq = sequence.current;
    const request = new AbortController(); controller.current = request;
    const live = () => seq === sequence.current && !request.signal.aborted;
    void read(async () => {
      try { return await operation(request.signal); }
      catch (failure) {
        if (!live()) throw new DOMException('Request aborted', 'AbortError');
        throw failure;
      }
    }).then(result => {
      if (!live()) return;
      controller.current = null; accept(result);
    }, (failure: unknown) => {
      if (!live() || isAbort(failure)) return;
      // Settle sibling requests of a combined read; the sequence still identifies this attempt.
      controller.current = null; request.abort();
      // read() already invalidated auth for 401; Protected redirects to /login.
      if (failure instanceof ApiError && failure.status === 401) return;
      reject(failure);
    });
  }, [cancel, read]);
  return { start, cancel };
}

function Title({ children }: { children: ReactNode }) { return <PageHeader title={children} />; }
function FailureView({ failure, onRetry, disabled }: { failure: Failure; onRetry?: () => void; disabled?: boolean }) {
  if (failure.kind === 'forbidden') return <div role="alert" className="error-message flex flex-col gap-1">
    <p className="font-semibold">Akses ditolak</p>
    <p>Anda tidak memiliki izin untuk melihat riwayat ini.</p>
  </div>;
  if (failure.kind === 'not-found') return <div role="alert" className="error-message flex flex-col gap-1">
    <p className="font-semibold">Sesi razia tidak ditemukan</p>
    <p>Sesi mungkin tidak ada atau bukan milik Anda.</p>
  </div>;
  return <div role="alert" className="flex flex-col gap-2 feedback feedback-warning">
    <p className="text-lg font-bold">Riwayat tidak dapat dimuat</p>
    <p>{failure.error?.message ?? 'Terjadi kesalahan. Coba lagi.'}</p>
    {onRetry && <Button type="button" variant="outline" className="self-start" disabled={disabled} onClick={onRetry}>Coba lagi</Button>}
  </div>;
}
function StatusBadge({ status }: { status: Status | null }) {
  return status === null ? <span data-status="none" className="font-semibold">—</span> : <VehicleStatus status={status} compact />;
}
const raidStatusText = (raid: HistoryRaid) => raid.status === 'ACTIVE' ? 'AKTIF' : 'DITUTUP';
const isoSeconds = (seconds: number) => new Date(seconds * 1000).toISOString();
function Instant({ seconds }: { seconds: number }) {
  return <time dateTime={isoSeconds(seconds)}>{formatWita(seconds)}</time>;
}
const SNAPSHOT_NOTE = 'Status adalah snapshot saat pengecekan, bukan status terkini.';
const EVENTUAL_NOTE = 'Riwayat diperbarui di latar belakang dan dapat tertunda sesaat.';

/** Remounts history views when the signed-in identity changes so data never crosses users/roles. */
function useIdentityKey() {
  const { auth } = useAuth();
  return `${auth?.user.id ?? ''}:${auth?.user.role ?? ''}:${auth?.session.expires_at ?? ''}`;
}
/** While an auth mutation (logout) is pending, unmount views: cancels reads and clears data. */
function AuthIdle({ children }: { children: ReactNode }) {
  const { busy } = useAuth();
  return busy ? <p role="status">Memproses sesi…</p> : children;
}
export function HistoryListRoute() {
  return <AuthIdle><HistoryList key={useIdentityKey()} /></AuthIdle>;
}
function HistoryList() {
  const { auth, busy } = useAuth();
  const admin = auth?.user.role === 'ADMIN';
  const { start, cancel } = useLatestRequest();
  const [items, setItems] = useState<HistoryRaid[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'more' | 'ready'>('loading');
  const [failure, setFailure] = useState<{ failure: Failure; more: boolean } | null>(null);
  // State changes happen only in async callbacks; event handlers set the loading phase themselves.
  const fetchHead = useCallback(() => {
    start(signal => api.historyRaids(undefined, signal), page => {
      setItems(mergeById([], page.raid_sessions)); setCursor(page.next_cursor); setPhase('ready');
    }, error => { setFailure({ failure: classify(error), more: false }); setPhase('ready'); });
  }, [start]);
  useEffect(() => { fetchHead(); return cancel; }, [fetchHead, cancel]);
  function loadHead() { setPhase('loading'); setFailure(null); fetchHead(); }
  function loadMore() {
    if (cursor === null || phase !== 'ready' || busy) return;
    const after = cursor;
    setPhase('more'); setFailure(null);
    start(signal => api.historyRaids(after, signal), page => {
      setItems(current => mergeById(current, page.raid_sessions)); setCursor(page.next_cursor); setPhase('ready');
    }, error => { setFailure({ failure: classify(error), more: true }); setPhase('ready'); });
  }
  const blocking = failure && !failure.more;
  return <section className="flex flex-col gap-4" aria-busy={phase !== 'ready'}>
    <Title>Riwayat</Title>
    <p>Daftar sesi razia{admin ? ' seluruh petugas' : ' milik Anda'}, terbaru di atas.</p>
    {phase === 'loading' && <p role="status" className="flex items-center gap-2"><Spinner />Memuat riwayat sesi…</p>}
    {blocking && <FailureView failure={failure.failure} onRetry={loadHead} disabled={busy} />}
    {phase !== 'loading' && !blocking && items.length === 0 && <EmptyState title="Belum ada sesi razia.">Sesi razia yang Anda buka akan tercatat di sini.</EmptyState>}
    {items.length > 0 && <ul aria-label="Daftar sesi razia" className="flex flex-col gap-3">
      {items.map(raid => <li key={raid.id}>
        <Link to={`/history/${encodeURIComponent(raid.id)}`} className="panel flex min-h-11 flex-col gap-1 bg-card text-foreground hover:bg-accent">
          <span className="break-words text-lg font-semibold">{raid.location.name} · Jalur {raid.lane}</span>
          <span>Status: <span className="font-bold">{raidStatusText(raid)}</span></span>
          <span>Mulai: <Instant seconds={raid.started_at} /></span>
          {raid.closed_at !== null && <span>Selesai: <Instant seconds={raid.closed_at} /></span>}
          {admin && <span className="break-words">Petugas: {raid.owner.username}</span>}
        </Link>
      </li>)}
    </ul>}
    {failure?.more && <FailureView failure={failure.failure} onRetry={loadMore} disabled={busy} />}
    {cursor !== null && !blocking && !failure?.more && <Button type="button" variant="outline" disabled={phase !== 'ready' || busy} onClick={loadMore}>
      {phase === 'more' ? <><Spinner />Memuat…</> : 'Muat lebih banyak'}
    </Button>}
  </section>;
}

function RaidHeader({ raid, admin }: { raid: HistoryRaid; admin: boolean }) {
  return <dl className="panel grid grid-cols-1 gap-2 bg-card text-foreground sm:grid-cols-2">
    <div><dt className="text-sm">Lokasi · Jalur</dt><dd className="break-words font-semibold">{raid.location.name} · Jalur {raid.lane}</dd></div>
    <div><dt className="text-sm">Status sesi</dt><dd className="font-bold">{raidStatusText(raid)}</dd></div>
    <div><dt className="text-sm">Mulai</dt><dd><Instant seconds={raid.started_at} /></dd></div>
    <div><dt className="text-sm">Selesai</dt><dd>{raid.closed_at === null ? 'Belum ditutup' : <Instant seconds={raid.closed_at} />}</dd></div>
    {admin && <div><dt className="text-sm">Petugas</dt><dd className="break-words font-semibold">{raid.owner.username}</dd></div>}
  </dl>;
}
function Metric({ label, value, help }: { label: string; value: number; help?: string }) {
  return <div className="metric">
    <dt className="text-sm">{label}{help && <span className="block text-xs">{help}</span>}</dt>
    <dd className="text-2xl font-extrabold" data-metric={label}>{value}</dd>
  </div>;
}
function Recap({ summary }: { summary: HistorySummary }) {
  return <section aria-labelledby="recap-title" className="flex flex-col gap-2">
    <h2 id="recap-title" className="text-xl font-semibold">Rekap sesi</h2>
    <dl className="grid grid-cols-2 gap-2">
      <Metric label="Total Scan" value={summary.total_checks} help="NOPOL unik" />
      <Metric label="Ditemukan" value={summary.found} />
      <Metric label="Tidak ditemukan" value={summary.not_found} />
      <Metric label="Pajak Aktif" value={summary.tax_active} />
      <Metric label="Pajak Mati" value={summary.tax_expired} />
      <Metric label="Pajak Tidak Dapat Ditentukan" value={summary.tax_unknown} />
    </dl>
  </section>;
}
function CheckItem({ check }: { check: HistoryCheck }) {
  return <li className="history-row" data-check-id={check.id}>
    <p className="history-nopol">{check.nopol}</p>
    <LookupOutcomeBadge outcome={check.outcome} />
    <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
      <div><dt>Status Pajak</dt><dd><StatusBadge status={check.tax_status} /></dd></div>
      <div><dt>Status STNK</dt><dd><StatusBadge status={check.stnk_status} /></dd></div>
      <div><dt>Sumber</dt><dd className="font-semibold">{check.source === 'LIVE' ? 'Langsung' : 'Cache'}</dd></div>
      <div><dt>Waktu</dt><dd><Instant seconds={check.checked_at} /></dd></div>
    </dl>
  </li>;
}

/** Keys the detail view by route ID so a different raid never shows the previous raid's data. */
export function HistoryDetailRoute() {
  const { id = '' } = useParams();
  const identity = useIdentityKey();
  return <AuthIdle><HistoryDetail key={`${identity}:${id}`} id={id} /></AuthIdle>;
}
function HistoryDetail({ id }: { id: string }) {
  const { auth, busy } = useAuth();
  const admin = auth?.user.role === 'ADMIN';
  const { start, cancel } = useLatestRequest();
  const [raid, setRaid] = useState<HistoryRaid | null>(null);
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [checks, setChecks] = useState<HistoryCheck[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'more' | 'ready'>('loading');
  const [failure, setFailure] = useState<{ failure: Failure; more: boolean } | null>(null);
  // Reload always restarts at the head: summary and first checks page replace the current view.
  const fetchHead = useCallback(() => {
    start(signal => Promise.all([api.raidSummary(id, signal), api.raidChecks(id, {}, signal)]), ([recap, page]) => {
      setRaid(recap.raid_session); setSummary(recap.summary); setChecks(mergeById([], page.checks)); setCursor(page.next_cursor); setPhase('ready');
    }, error => { setFailure({ failure: classify(error), more: false }); setPhase('ready'); });
  }, [id, start]);
  useEffect(() => { fetchHead(); return cancel; }, [fetchHead, cancel]);
  function loadHead() { setPhase('loading'); setFailure(null); fetchHead(); }
  function loadMore() {
    if (cursor === null || phase !== 'ready' || busy) return;
    const after = cursor;
    setPhase('more'); setFailure(null);
    start(signal => api.raidChecks(id, { cursor: after }, signal), page => {
      setChecks(current => mergeById(current, page.checks)); setCursor(page.next_cursor); setPhase('ready');
    }, error => { setFailure({ failure: classify(error), more: true }); setPhase('ready'); });
  }
  const terminal = failure && failure.failure.kind !== 'error';
  return <section className="flex flex-col gap-4" aria-busy={phase !== 'ready'}>
    <Link to="/history" className="inline-flex min-h-11 items-center self-start font-medium underline underline-offset-4">← Kembali ke riwayat</Link>
    <Title>Detail sesi razia</Title>
    {phase === 'loading' && <p role="status" className="flex items-center gap-2"><Spinner />Memuat detail sesi…</p>}
    {failure && <FailureView failure={failure.failure} onRetry={failure.more ? loadMore : loadHead} disabled={busy} />}
    {!terminal && raid && summary && <>
      <RaidHeader raid={raid} admin={admin} />
      <Recap summary={summary} />
      <section aria-labelledby="checks-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="checks-title" className="text-xl font-semibold">Daftar pengecekan</h2>
          {/* A head reload may supersede a pending pagination request; only repeated head reloads wait. */}
          <Button type="button" variant="outline" disabled={phase === 'loading' || busy} onClick={loadHead}>Muat ulang</Button>
        </div>
        <p className="text-sm">{SNAPSHOT_NOTE} {EVENTUAL_NOTE}</p>
        {checks.length === 0 ? <p role="status">Belum ada pengecekan pada sesi ini.</p>
          : <ul aria-label="Daftar pengecekan" className="flex flex-col gap-3">{checks.map(check => <CheckItem key={check.id} check={check} />)}</ul>}
        {cursor !== null && !failure?.more && <Button type="button" variant="outline" disabled={phase !== 'ready' || busy} onClick={loadMore}>
          {phase === 'more' ? <><Spinner />Memuat…</> : 'Muat lebih banyak'}
        </Button>}
      </section>
    </>}
  </section>;
}

export const SCANNER_HISTORY_LIMIT = 10;
/**
 * Scanner side panel for the active raid. State is fully separate from the lookup state machine:
 * its own controller/sequence, and failures never touch input, result or lookup errors.
 * Refreshes on mount/raid change, manual reload, window focus and once per displayed lookup outcome.
 */
export type PanelRefresh = { current: (() => void) | null };
export function RaidHistoryPanel({ raidId, refreshRef }: { raidId: string; refreshRef: PanelRefresh }) {
  const { start, cancel } = useLatestRequest();
  const [data, setData] = useState<{ summary: HistorySummary; checks: HistoryCheck[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const fetchHead = useCallback(() => {
    start(signal => Promise.all([api.raidSummary(raidId, signal), api.raidChecks(raidId, { limit: SCANNER_HISTORY_LIMIT }, signal)]), ([recap, page]) => {
      setData({ summary: recap.summary, checks: page.checks.slice(0, SCANNER_HISTORY_LIMIT) }); setFailure(null); setLoading(false);
    }, error => { setFailure(classify(error)); setLoading(false); });
  }, [raidId, start]);
  const load = useCallback(() => { setLoading(true); setFailure(null); fetchHead(); }, [fetchHead]);
  useEffect(() => { fetchHead(); return cancel; }, [fetchHead, cancel]);
  useEffect(() => {
    // The scanner triggers exactly one head refresh per displayed outcome; no timers or polling.
    refreshRef.current = load;
    window.addEventListener('focus', load);
    return () => { if (refreshRef.current === load) refreshRef.current = null; window.removeEventListener('focus', load); };
  }, [load, refreshRef]);
  const message = failure?.kind === 'forbidden' ? 'Akses ditolak.' : failure?.kind === 'not-found' ? 'Sesi razia tidak ditemukan.' : failure?.error?.message ?? 'Terjadi kesalahan. Coba lagi.';
  return <section aria-labelledby="raid-history-title" className="panel flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id="raid-history-title" className="text-xl font-semibold">Riwayat sesi ini</h2>
      <Button type="button" variant="outline" disabled={loading} onClick={load}>Muat ulang</Button>
    </div>
    <p className="text-sm">{EVENTUAL_NOTE}</p>
    {/* Secondary panel: polite updates only, never alerts that could interrupt the lookup flow. */}
    <div aria-live="polite" className="flex flex-col gap-2">
      {loading && <p className="flex items-center gap-2 text-sm"><Spinner />Memuat riwayat sesi…</p>}
      {failure && <div data-panel-error="" className="flex flex-col gap-1 feedback feedback-warning">
        <p className="font-semibold">Riwayat sesi belum dapat dimuat.</p>
        <p>{message}</p>
      </div>}
    </div>
    {data && <>
      <dl className="grid grid-cols-2 gap-2">
        <Metric label="Total Scan" value={data.summary.total_checks} help="NOPOL unik" />
        <Metric label="Pajak Aktif" value={data.summary.tax_active} />
        <Metric label="Pajak Mati" value={data.summary.tax_expired} />
        {data.summary.not_found > 0 && <Metric label="Tidak ditemukan" value={data.summary.not_found} />}
      </dl>
      {data.checks.length === 0 ? <p>Belum ada pengecekan tercatat pada sesi ini.</p>
        : <ol aria-label="Pengecekan terbaru" className="flex flex-col gap-2">
          {data.checks.map(check => <li key={check.id} data-check-id={check.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-input bg-white p-2 text-black">
            <span className="break-all font-extrabold tracking-wider">{check.nopol}</span>
            {check.outcome === 'FOUND' ? <span className="flex items-center gap-1 text-sm">Pajak <StatusBadge status={check.tax_status} /></span> : <span className="text-sm font-semibold">Tidak ditemukan</span>}
            <Instant seconds={check.checked_at} />
          </li>)}
        </ol>}
      <p className="text-sm">{SNAPSHOT_NOTE}</p>
    </>}
    <Link to={`/history/${encodeURIComponent(raidId)}`} className="inline-flex min-h-11 items-center self-start font-medium underline underline-offset-4">Lihat semua riwayat sesi</Link>
  </section>;
}
