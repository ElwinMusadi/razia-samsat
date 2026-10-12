import { MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * SessionBar — strip konteks sesi razia yang selalu terlihat di layar scanner.
 *
 * Menampilkan lokasi · jalur · indikator SESI AKTIF dalam satu baris ringkas
 * sehingga petugas tidak perlu scroll untuk memastikan sesi yang sedang berjalan.
 */
export function SessionBar({ location, lane, className }: { location: string; lane: string; className?: string }) {
  const context = `${location} · Jalur ${lane}`;
  return (
    <p className={cn('session-bar', className)} title={context}>
      <MapPin aria-hidden="true" size={16} className="shrink-0 text-secondary-foreground" />
      <span className="min-w-0 flex-1 truncate">
        <span className="sr-only">Sesi razia aktif: </span>
        {context}
      </span>
      <span className="session-bar-live">
        <span aria-hidden="true" className="session-bar-dot" />
        SESI AKTIF
      </span>
    </p>
  );
}
