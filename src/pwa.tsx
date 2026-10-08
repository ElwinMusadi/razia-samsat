import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './components/ui/button';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

type PwaState = { supported: boolean; installed: boolean; available: boolean; pending: boolean; message: string; update: boolean; registrationFailed: boolean; install: () => Promise<void> };
const PwaContext = createContext<PwaState | null>(null);

/** Installation state is ephemeral. One app-level owner survives route and account disclosure changes. */
function usePwaState(): PwaState {
  const supported = window.isSecureContext === true && 'serviceWorker' in navigator;
  const [installed, setInstalled] = useState(() => window.matchMedia?.('(display-mode: standalone)').matches === true);
  const [available, setAvailable] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [update, setUpdate] = useState(false);
  const [registrationFailed, setRegistrationFailed] = useState(false);
  const deferred = useRef<InstallEvent | null>(null);
  const prompting = useRef(false);
  const alive = useRef(false);
  const installedRef = useRef(installed);
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    const media = window.matchMedia?.('(display-mode: standalone)');
    let registration: ServiceWorkerRegistration | undefined;
    let worker: ServiceWorker | null = null;
    const markInstalled = () => {
      installedRef.current = true; deferred.current = null;
      setInstalled(true); setAvailable(false); setPending(false); setMessage('');
    };
    const displayChanged = () => { if (media?.matches) markInstalled(); };
    const beforeInstall = (event: Event) => {
      if (!supported || installedRef.current) return;
      const candidate = event as InstallEvent;
      if (typeof candidate.prompt !== 'function' || !candidate.userChoice) return;
      candidate.preventDefault(); deferred.current = candidate; setAvailable(true); setMessage('');
    };
    const waiting = () => { if (registration?.waiting) setUpdate(true); };
    const stateChanged = () => {
      waiting();
      if (worker?.state === 'installed' && navigator.serviceWorker.controller) setUpdate(true);
    };
    const updateFound = () => {
      worker?.removeEventListener('statechange', stateChanged);
      worker = registration?.installing ?? null;
      worker?.addEventListener('statechange', stateChanged); stateChanged();
    };
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', markInstalled);
    media?.addEventListener('change', displayChanged);
    // Defer registration so StrictMode's disposed first effect cannot register twice.
    if (supported) void Promise.resolve().then(async () => {
      if (disposed) return;
      try {
        const result = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
        if (disposed) return;
        registration = result; waiting(); updateFound();
        registration.addEventListener('updatefound', updateFound);
      } catch {
        if (!disposed) setRegistrationFailed(true);
        // Do not log raw browser errors or change normal online authentication.
      }
    });
    return () => {
      disposed = true; alive.current = false; deferred.current = null;
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', markInstalled);
      media?.removeEventListener('change', displayChanged);
      registration?.removeEventListener('updatefound', updateFound);
      worker?.removeEventListener('statechange', stateChanged);
    };
  }, [supported]);
  async function install() {
    const event = deferred.current;
    if (!event || prompting.current || installedRef.current) return;
    prompting.current = true; deferred.current = null; setAvailable(false); setPending(true); setMessage('');
    try {
      // Called directly from the user gesture; acceptance is not proof of installation.
      await event.prompt();
      const choice = await event.userChoice;
      if (alive.current && !installedRef.current) setMessage(choice.outcome === 'accepted' ? 'Permintaan instalasi diterima. Ikuti petunjuk browser.' : choice.outcome === 'dismissed' ? 'Instalasi dibatalkan. Aplikasi tetap dapat digunakan di browser.' : 'Instalasi belum dapat dipastikan. Periksa menu browser.');
    } catch {
      if (alive.current && !installedRef.current) setMessage('Instalasi belum dapat dibuka. Periksa menu browser.');
    } finally {
      prompting.current = false; if (alive.current) setPending(false);
    }
  }
  return { supported, installed, available, pending, message, update, registrationFailed, install };
}
export function PwaProvider({ children }: { children: ReactNode }) {
  const state = usePwaState();
  return <PwaContext.Provider value={state}>{children}</PwaContext.Provider>;
}
/** Standalone consumers keep the original API; App consumers reuse its single provider. */
export function PwaControls() {
  const shared = useContext(PwaContext);
  return shared ? <PwaView state={shared} /> : <StandalonePwaControls />;
}
function StandalonePwaControls() { return <PwaView state={usePwaState()} />; }
function PwaView({ state }: { state: PwaState }) {
  const { supported, installed, available, pending, message, update, registrationFailed, install } = state;
  if (!supported) return null;
  return <aside aria-label="Instalasi aplikasi" className="pwa-controls">
    {!installed && <>
      {available || pending ? <Button type="button" variant="outline" className="min-w-12 self-start whitespace-normal break-words" disabled={pending} onClick={() => { void install(); }}>{pending ? 'Membuka instalasi…' : 'Pasang aplikasi'}</Button> : <details className="text-sm">
        <summary className="flex min-h-12 min-w-12 cursor-pointer items-center underline">Panduan instalasi</summary>
        <p>Di browser Android yang mendukung, buka menu browser lalu pilih Pasang aplikasi atau Tambahkan ke layar utama. Nama menu dan ketersediaannya bergantung pada browser. Instalasi tetap memerlukan internet; pengecekan data tidak tersedia offline.</p>
      </details>}
      {message && <p role="status" className="break-words text-sm">{message}</p>}
    </>}
    {registrationFailed && <p role="status" className="break-words text-sm">Persiapan instalasi belum berhasil. Aplikasi online tetap dapat digunakan; coba buka kembali setelah pekerjaan selesai.</p>}
    {update && <p role="status" className="break-words text-sm">Pembaruan aplikasi tersedia. Setelah selesai, tutup dan buka kembali aplikasi. Tidak ada muat ulang otomatis.</p>}
  </aside>;
}
