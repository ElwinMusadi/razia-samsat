import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { AuthState } from './lib/api';

type ScanContext = { auth: AuthState | null; busy: boolean };
import { Link } from 'react-router';
import { Button } from './components/ui/button';
import { useAuth } from './auth';
import { cn } from './lib/utils';
import { api, ApiError, formatCalendarDate, formatInstantWita, isAbort, normalizeNopol, type VehicleFound, type VehicleStatus } from './lib/api';
import { RaidHistoryPanel } from './history';

export const LOOKUP_DEBOUNCE_MS = 600;

type ScanState =
  | { kind: 'idle' }
  | { kind: 'queued'; nopol: string }
  | { kind: 'loading'; nopol: string }
  | { kind: 'found'; nopol: string; result: VehicleFound }
  | { kind: 'not-found'; nopol: string; requestId: string }
  | { kind: 'input-error'; nopol: string; error: ApiError }
  | { kind: 'raid-required'; nopol: string; error: ApiError; sync: 'pending' | 'done' | 'failed' }
  | { kind: 'failure'; nopol: string; error: ApiError | null };

const STATUS_VIEW: Record<VehicleStatus, { text: string; className: string }> = {
  ACTIVE: { text: 'AKTIF', className: 'bg-emerald-600 text-white' },
  EXPIRED: { text: 'MATI', className: 'bg-red-600 text-white' },
  UNKNOWN: { text: 'TIDAK DAPAT DITENTUKAN', className: 'border-2 border-stone-900 bg-stone-100 text-stone-950' },
};

function Spinner() {
  return <span aria-hidden="true" className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />;
}
function RequestId({ id }: { id?: string }) {
  return id ? <p className="break-all text-sm">ID permintaan: {id}</p> : null;
}
function StatusBlock({ id, label, status, due }: { id: string; label: string; status: VehicleStatus; due: string | null }) {
  const view = STATUS_VIEW[status];
  return <section aria-labelledby={id} className="flex flex-col gap-2 rounded-md border border-input bg-white p-3">
    <h3 id={id} className="text-base font-semibold">{label}</h3>
    <p data-status={status} className={cn('rounded-md px-3 py-3 text-center text-2xl font-extrabold uppercase tracking-wide break-words', view.className)}>{view.text}</p>
    <p>Jatuh tempo: <span className="font-semibold">{formatCalendarDate(due)}</span></p>
  </section>;
}
function VehicleCard({ result }: { result: VehicleFound }) {
  const { vehicle } = result;
  return <article aria-labelledby="result-nopol" className="flex flex-col gap-4 rounded-md border border-input bg-white p-4 text-black">
    <h2 id="result-nopol" className="break-all text-3xl font-extrabold tracking-wider">{vehicle.nopol}</h2>
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div><dt className="text-sm">Nama pemilik</dt><dd className="break-words text-lg font-semibold">{vehicle.owner_name}</dd></div>
      <div><dt className="text-sm">Merek</dt><dd className="break-words text-lg font-semibold">{vehicle.brand}</dd></div>
      <div><dt className="text-sm">Tipe</dt><dd className="break-words text-lg font-semibold">{vehicle.type}</dd></div>
      <div><dt className="text-sm">Warna</dt><dd className="break-words text-lg font-semibold">{vehicle.color}</dd></div>
    </dl>
    <StatusBlock id="tax-status-title" label="Status Pajak" status={vehicle.tax_status} due={vehicle.tax_due_date} />
    <StatusBlock id="stnk-status-title" label="Status STNK" status={vehicle.stnk_status} due={vehicle.stnk_due_date} />
    <div className="flex flex-col gap-1 text-sm">
      <p className="font-semibold">{result.source === 'LIVE' ? 'Data langsung' : 'Data cache (≤5 menit)'}</p>
      <p>Diambil <time dateTime={result.fetched_at}>{formatInstantWita(result.fetched_at)}</time></p>
      <p>Dievaluasi <time dateTime={result.evaluated_on}>{formatCalendarDate(result.evaluated_on)}</time> WITA</p>
      <RequestId id={result.request_id} />
    </div>
    <p className="text-sm">Status adalah data administratif. Keputusan pemeriksaan tetap pada petugas.</p>
  </article>;
}

export function Scanner() {
  const { auth, busy, read, setRaid } = useAuth();
  const raid = auth?.active_raid_session ?? null;
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [state, setState] = useState<ScanState>({ kind: 'idle' });
  const current = useRef<ScanState>({ kind: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  // Set by the separate history panel; called once per displayed FOUND/NOT_FOUND to refresh its head.
  const historyRefresh = useRef<(() => void) | null>(null);
  const apply = useCallback((next: ScanState) => { current.current = next; setState(next); }, []);
  // Invalidates every pending debounce and in-flight lookup; late responses are ignored by sequence.
  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    controller.current?.abort(); controller.current = null;
    sequence.current++;
  }, []);
  useEffect(() => () => cancel(), [cancel]);
  const enabled = raid !== null && !busy;
  const context = useRef<ScanContext>({ auth, busy });
  const reconciledRaid = useRef<{ auth: AuthState | null; raid: typeof raid } | null>(null);
  useLayoutEffect(() => {
    const previous = context.current;
    context.current = { auth, busy };
    if (previous.auth === auth && previous.busy === busy) return;
    cancel();
    setValue('');
    // Preserve only the 409 notice produced by this scanner's own successful reconciliation.
    // All vehicle data, errors and pending work from any other auth/context refresh are discarded.
    const expected = reconciledRaid.current;
    reconciledRaid.current = null;
    const ownReconciliation = expected && previous.auth === expected.auth && auth?.user.id === expected.auth?.user.id
      && auth?.session.expires_at === expected.auth?.session.expires_at && raid === expected.raid && !busy;
    if (!ownReconciliation || current.current.kind !== 'raid-required') apply({ kind: 'idle' });
  }, [auth, busy, raid, cancel, apply]);
  useEffect(() => { if (enabled) input.current?.focus(); }, [enabled]);

  async function lookup(nopol: string) {
    cancel();
    const seq = sequence.current;
    const request = new AbortController(); controller.current = request;
    const capturedContext = context.current;
    const live = () => seq === sequence.current && !request.signal.aborted && context.current === capturedContext;
    // Suppress errors from cancelled contexts before read() can invalidate current authentication.
    const protectedRead = <T,>(operation: () => Promise<T>) => read(async () => {
      try { return await operation(); }
      catch (failure) {
        if (!live()) throw new DOMException('Request aborted', 'AbortError');
        throw failure;
      }
    });
    apply({ kind: 'loading', nopol });
    try {
      const result = await protectedRead(() => api.lookup(nopol, request.signal));
      if (!live()) return;
      apply(result.outcome === 'FOUND' ? { kind: 'found', nopol, result } : { kind: 'not-found', nopol, requestId: result.request_id });
      historyRefresh.current?.();
    } catch (failure) {
      if (!live() || isAbort(failure)) return;
      // read() already invalidated auth for 401; Protected redirects to /login.
      if (failure instanceof ApiError && failure.status === 401) return;
      if (failure instanceof ApiError && (failure.code === 'INVALID_INPUT' || failure.code === 'PAYLOAD_TOO_LARGE')) { apply({ kind: 'input-error', nopol, error: failure }); return; }
      if (failure instanceof ApiError && failure.code === 'RAID_SESSION_REQUIRED') {
        apply({ kind: 'raid-required', nopol, error: failure, sync: 'pending' });
        try {
          const active = await protectedRead(() => api.active(request.signal));
          if (!live()) return;
          reconciledRaid.current = { auth: capturedContext.auth, raid: active };
          apply({ kind: 'raid-required', nopol, error: failure, sync: 'done' });
          setRaid(active);
        } catch (syncFailure) {
          if (!live() || isAbort(syncFailure)) return;
          if (syncFailure instanceof ApiError && syncFailure.status === 401) return;
          apply({ kind: 'raid-required', nopol, error: failure, sync: 'failed' });
        }
        return;
      }
      apply({ kind: 'failure', nopol, error: failure instanceof ApiError ? failure : null });
    }
  }
  function change(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value;
    setValue(next);
    const nopol = normalizeNopol(next);
    cancel();
    // Every edit clears the previous vehicle immediately, including whitespace-only edits.
    if (!enabled || !nopol) { apply({ kind: 'idle' }); return; }
    apply({ kind: 'queued', nopol });
    const seq = sequence.current;
    timer.current = setTimeout(() => { timer.current = null; if (seq === sequence.current) void lookup(nopol); }, LOOKUP_DEBOUNCE_MS);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled) return;
    const nopol = normalizeNopol(value);
    if (!nopol) return;
    const active = current.current;
    if (active.kind !== 'idle' && active.nopol === nopol && (active.kind === 'loading' || active.kind === 'found' || active.kind === 'not-found')) return;
    void lookup(nopol);
  }
  function clear() {
    cancel(); setValue(''); apply({ kind: 'idle' });
    input.current?.focus();
  }
  function retry() {
    if (state.kind === 'idle' || !enabled) return;
    void lookup(state.nopol);
    input.current?.focus();
  }

  const showHint = value !== '' && normalizeNopol(value) === null;
  const describedBy = [showHint ? 'nopol-hint' : '', 'nopol-help'].filter(Boolean).join(' ');
  return <section aria-labelledby="scanner-title" className="flex flex-col gap-4">
    <div className="sticky top-0 z-10 -mx-4 flex flex-col gap-2 border-b border-input bg-background px-4 pb-3 pt-2">
      <h1 id="scanner-title" className="text-2xl font-semibold">Scanner</h1>
      {raid && <p className="break-words text-sm font-medium"><span className="sr-only">Sesi razia aktif: </span>{raid.location.name} · Jalur {raid.lane}</p>}
      <form role="search" aria-label="Cari kendaraan" onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor="nopol-input" className="font-medium">Nomor polisi (NOPOL)</label>
        <div className="relative">
          <input
            ref={input} id="nopol-input" name="nopol" type="text" value={value} onChange={change} disabled={!enabled}
            autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} inputMode="text" enterKeyHint="search"
            placeholder="DH 1234 ZZ" aria-describedby={describedBy} aria-invalid={showHint || state.kind === 'input-error'}
            className="min-h-14 pr-14 text-2xl font-bold uppercase tracking-wider placeholder:font-normal placeholder:normal-case"
          />
          {enabled && (value !== '' || state.kind !== 'idle') && <button
            type="button" onClick={clear} aria-label="Hapus NOPOL"
            className="absolute inset-y-0 right-0 flex min-h-11 w-14 min-w-11 items-center justify-center rounded-r-md text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>}
        </div>
        <p id="nopol-help" className="text-sm">Pencarian otomatis setelah selesai mengetik. Tekan Enter untuk mencari segera.</p>
        {showHint && <p id="nopol-hint" className="text-sm font-medium">Format NOPOL belum valid: maksimal 64 karakter, 1–2 huruf, 1–4 angka, 0–3 huruf, tanpa tanda baca (contoh DH 1234 ZZ).</p>}
      </form>
      {/* The live region stays mounted so screen readers reliably announce loading changes. */}
      <p id="lookup-status" role="status" className="flex min-h-5 items-center gap-2 text-sm">
        {state.kind === 'loading' && <><Spinner />Mencari data {state.nopol}…</>}
        {state.kind === 'queued' && <><Spinner />Menunggu ketikan selesai…</>}
      </p>
    </div>
    {!raid && state.kind !== 'raid-required' && <div className="panel flex flex-col gap-3">
      <p className="font-semibold">Belum ada sesi razia aktif.</p>
      <p>Buka sesi razia terlebih dahulu untuk memeriksa kendaraan.</p>
      <Button asChild><Link to="/razia/setup">Buka sesi razia</Link></Button>
    </div>}
    <div aria-live="polite" className="flex flex-col gap-4">
      {state.kind === 'found' && <VehicleCard result={state.result} />}
      {state.kind === 'not-found' && <div className="flex flex-col gap-2 rounded-md border-2 border-stone-900 bg-white p-4 text-black">
        <p className="text-xl font-bold">Data kendaraan tidak ditemukan</p>
        <p>NOPOL: <span className="break-all font-bold tracking-wider">{state.nopol}</span></p>
        <p className="text-sm">Periksa kembali NOPOL yang diketik.</p>
        <RequestId id={state.requestId} />
      </div>}
    </div>
    {state.kind === 'input-error' && <div role="alert" className="error-message flex flex-col gap-1">
      <p className="font-semibold">NOPOL ditolak oleh layanan. Periksa kembali format NOPOL.</p>
      <p>{state.error.message}</p>
      <RequestId id={state.error.requestId} />
    </div>}
    {state.kind === 'raid-required' && <div role="alert" className="error-message flex flex-col gap-3">
      <p className="font-semibold">Sesi razia aktif diperlukan untuk memeriksa kendaraan.</p>
      <p>{state.error.message}</p>
      <RequestId id={state.error.requestId} />
      {state.sync === 'pending' && <p className="text-sm">Memeriksa status sesi razia…</p>}
      {state.sync === 'failed' && <p className="text-sm">Status sesi razia belum dapat diperiksa ulang.</p>}
      <Button asChild><Link to="/razia/setup">Buka sesi razia</Link></Button>
    </div>}
    {state.kind === 'failure' && <div role="alert" className="flex flex-col gap-2 rounded-md border-2 border-amber-600 bg-amber-100 p-4 text-amber-950">
      <p className="text-lg font-bold">Data kendaraan tidak dapat diambil</p>
      <p>{state.error?.message ?? 'Terjadi kesalahan. Coba lagi.'}</p>
      <p className="text-sm">NOPOL: <span className="font-semibold">{state.nopol}</span>. Ini bukan berarti kendaraan tidak terdaftar.</p>
      <RequestId id={state.error?.requestId} />
      <Button type="button" variant="outline" onClick={retry} className="self-start">Coba lagi</Button>
    </div>}
    {/* Keyed by user, role, expiry and raid: changes to those fields drop prior panel data before paint.
        Hidden while logout is pending, which also cancels its in-flight reads. */}
    {raid && auth && !busy && <RaidHistoryPanel key={`${auth.user.id}:${auth.user.role}:${auth.session.expires_at}:${raid.id}`} raidId={raid.id} refreshRef={historyRefresh} />}
  </section>;
}
