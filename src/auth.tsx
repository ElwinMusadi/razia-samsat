import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, errorText, isAbort, type AuthState, type RaidSession } from './lib/api';

type AuthContextValue = {
  auth: AuthState | null; loading: boolean; authError: string; notice: string; busy: boolean;
  retry: () => void; login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>; run: <T>(operation: (signal: AbortSignal) => Promise<T>, accept: (result: T) => void, scope?: 'ADMIN') => Promise<boolean>;
  administrativeSignOut: (reason: 'password' | 'sessions') => void;
  read: <T>(operation: () => Promise<T>) => Promise<T>;
  setRaid: (raid: RaidSession | null) => void;
};
const AuthContext = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const identityVersion = useRef(0);
  const checking = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const currentAuth = useRef<AuthState | null>(null);
  const update = useCallback((next: AuthState | null) => {
    if (next?.user.id !== currentAuth.current?.user.id || next?.user.role !== currentAuth.current?.user.role || next?.session.expires_at !== currentAuth.current?.session.expires_at) identityVersion.current++;
    currentAuth.current = next; setAuth(next);
  }, []);
  const invalidate = useCallback(() => {
    generation.current++;
    checking.current?.abort(); mutation.current?.abort(); mutation.current = null;
    update(null); setLoading(false); setBusy(false); setAuthError(''); setNotice('Sesi berakhir. Silakan masuk kembali.');
  }, [update]);
  const revalidate = useCallback(async () => {
    if (mutation.current) return;
    checking.current?.abort();
    const controller = new AbortController(); checking.current = controller;
    const version = ++generation.current;
    setAuthError('');
    if (!currentAuth.current) setLoading(true);
    try {
      const result = await api.me(controller.signal);
      if (version !== generation.current || controller.signal.aborted) return;
      update(result); setNotice('');
    } catch (error) {
      if (version !== generation.current || isAbort(error)) return;
      if (error instanceof ApiError && error.status === 401) { update(null); setNotice(''); }
      else setAuthError(errorText(error));
    } finally {
      if (version === generation.current) { setLoading(false); checking.current = null; }
    }
  }, [update]);
  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => { if (!disposed) return revalidate(); });
    const focus = () => { void revalidate(); };
    window.addEventListener('focus', focus);
    // These refs intentionally track the latest in-flight requests, not DOM nodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { disposed = true; generation.current++; checking.current?.abort(); mutation.current?.abort(); mutation.current = null; window.removeEventListener('focus', focus); };
  }, [revalidate]);
  const expiresAt = auth?.session.expires_at;
  useEffect(() => {
    if (expiresAt === undefined) return;
    // Long TTLs are chunked to avoid the browser's signed 32-bit timer limit.
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const remaining = expiresAt * 1000 - Date.now();
      if (remaining <= 0) invalidate();
      else timer = setTimeout(schedule, Math.min(remaining, 2147483647));
    };
    timer = setTimeout(schedule, Math.max(0, Math.min(expiresAt * 1000 - Date.now(), 2147483647)));
    return () => clearTimeout(timer);
  }, [expiresAt, invalidate]);
  const run = useCallback(async <T,>(operation: (signal: AbortSignal) => Promise<T>, accept: (result: T) => void, scope?: 'ADMIN' | 'login'): Promise<boolean> => {
    if (mutation.current) return false;
    if (scope === 'ADMIN' && currentAuth.current?.user.role !== 'ADMIN') throw new ApiError('Akses ditolak.', 403, 'AUTHORIZATION_ERROR');
    checking.current?.abort(); checking.current = null;
    const controller = new AbortController(); mutation.current = controller;
    const version = ++generation.current;
    setBusy(true); setAuthError('');
    try {
      const result = await operation(controller.signal);
      if (version !== generation.current || controller.signal.aborted) return false;
      accept(result); return true;
    } catch (error) {
      if (version !== generation.current || isAbort(error)) return false;
      if (error instanceof ApiError && error.status === 401 && !(scope === 'login' && error.code === 'INVALID_CREDENTIALS')) { invalidate(); return false; }
      throw error;
    } finally {
      if (version === generation.current) { mutation.current = null; setBusy(false); setLoading(false); }
    }
  }, [invalidate]);
  // Authoritative signed_out success clears pending /me without issuing a racing logout request.
  const administrativeSignOut = useCallback((reason: 'password' | 'sessions') => {
    invalidate();
    setNotice(reason === 'password' ? 'Kata sandi diperbarui dan semua sesi Anda dicabut. Silakan masuk kembali.' : 'Sesi perangkat ini dicabut. Silakan masuk kembali.');
  }, [invalidate]);
  const login = async (username: string, password: string) => { await run(signal => api.login(username, password, signal), result => { update(result); setNotice(''); }, 'login'); };
  const logout = async () => { await run(signal => api.logout(signal), () => { update(null); setNotice('Anda telah keluar. Sesi razia tidak ditutup oleh logout.'); }); };
  const setRaid = (raid: RaidSession | null) => {
    if (currentAuth.current) update({ ...currentAuth.current, active_raid_session: raid });
  };
  const read = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const version = identityVersion.current;
    try { return await operation(); }
    catch (error) {
      if (version === identityVersion.current && error instanceof ApiError && error.status === 401) invalidate();
      throw error;
    }
  }, [invalidate]);
  return <AuthContext.Provider value={{ auth, loading, authError, notice, busy, retry: () => { void revalidate(); }, login, logout, run, read, setRaid, administrativeSignOut }}>{children}</AuthContext.Provider>;
}
// The provider and its hook intentionally share the small auth module.
// eslint-disable-next-line react/only-export-components
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider is required');
  return value;
}
