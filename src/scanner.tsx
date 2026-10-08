import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { AuthState } from './lib/api';

type ScanContext = { auth: AuthState | null; busy: boolean };
import { Link } from 'react-router';
import { Button } from './components/ui/button';
import { useAuth } from './auth';
import { api, ApiError, isAbort, normalizeNopol, type VehicleFound } from './lib/api';
import { NopolInput } from './components/nopol-input';
import { LookupOutcomeBadge, VehicleResultCard } from './components/vehicle';
import { EmptyState, Spinner } from './components/ui/layout';
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
    <div className="scanner-search">
      <h1 id="scanner-title" className="scanner-heading">Scanner</h1>
      {raid && <p className="break-words text-sm font-medium"><span className="sr-only">Sesi razia aktif: </span>{raid.location.name} · Jalur {raid.lane}</p>}
      <form role="search" aria-label="Cari kendaraan" onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor="nopol-input" className="font-medium">Nomor polisi (NOPOL)</label>
        <NopolInput
          ref={input} id="nopol-input" name="nopol" type="text" value={value} onChange={change} disabled={!enabled}
          autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} inputMode="text" enterKeyHint="search"
          placeholder="DH 1234 ZZ" aria-describedby={describedBy} aria-invalid={showHint || state.kind === 'input-error'}
          showClear={enabled && (value !== '' || state.kind !== 'idle')} onClear={clear}
        />
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
      {state.kind === 'found' && <VehicleResultCard result={state.result} />}
      {state.kind === 'not-found' && <section className="vehicle-result" aria-labelledby="not-found-nopol">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="eyebrow">Hasil pemeriksaan</p><LookupOutcomeBadge outcome="NOT_FOUND" /></div>
        <h2 id="not-found-nopol" className="result-nopol">{state.nopol}</h2>
        <p className="font-semibold">Data kendaraan tidak ditemukan</p>
        <p className="supporting">Periksa kembali NOPOL yang diketik.</p>
      </section>}
      {raid && state.kind === 'idle' && value === '' && <EmptyState title="Siap memeriksa kendaraan.">Ketik nomor polisi. Hasil pajak dan STNK akan tampil di sini.</EmptyState>}
    </div>
    {state.kind === 'input-error' && <div role="alert" className="error-message flex flex-col gap-1">
      <p className="font-semibold">NOPOL ditolak oleh layanan. Periksa kembali format NOPOL.</p>
      <p>{state.error.message}</p>
    </div>}
    {state.kind === 'raid-required' && <div role="alert" className="error-message flex flex-col gap-3">
      <p className="font-semibold">Sesi razia aktif diperlukan untuk memeriksa kendaraan.</p>
      <p>{state.error.message}</p>
      {state.sync === 'pending' && <p className="text-sm">Memeriksa status sesi razia…</p>}
      {state.sync === 'failed' && <p className="text-sm">Status sesi razia belum dapat diperiksa ulang.</p>}
      <Button asChild><Link to="/razia/setup">Buka sesi razia</Link></Button>
    </div>}
    {state.kind === 'failure' && <div role="alert" className="feedback feedback-warning flex flex-col gap-2">
      <p className="text-lg font-bold">Data kendaraan tidak dapat diambil</p>
      <p>{state.error?.message ?? 'Terjadi kesalahan. Coba lagi.'}</p>
      <p className="text-sm">NOPOL: <span className="font-semibold">{state.nopol}</span>. Ini bukan berarti kendaraan tidak terdaftar.</p>
      <Button type="button" variant="outline" onClick={retry} className="self-start">Coba lagi</Button>
    </div>}
    {/* Keyed by user, role, expiry and raid: changes to those fields drop prior panel data before paint.
        Hidden while logout is pending, which also cancels its in-flight reads. */}
    {raid && auth && !busy && <RaidHistoryPanel key={`${auth.user.id}:${auth.user.role}:${auth.session.expires_at}:${raid.id}`} raidId={raid.id} refreshRef={historyRefresh} />}
  </section>;
}
