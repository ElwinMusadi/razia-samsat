import { Shield } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * BrandMark & BrandLockup — identitas visual aplikasi.
 *
 * Mark perisai dalam kotak rounded memberi aplikasi satu titik visual yang
 * dikenali sekilas, menggantikan brand yang sebelumnya hanya berupa teks.
 *
 * Fondasi Fase 0: komponen ini belum dipakai layar produksi mana pun.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-foreground text-primary-foreground',
        className,
      )}
    >
      <Shield size={22} strokeWidth={2.25} />
    </span>
  );
}

export function BrandLockup({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2.5', className)}>
      <BrandMark />
      <span className="flex min-w-0 flex-col leading-none">
        <span className="text-sm font-extrabold tracking-[0.18em]">SAMSAT</span>
        {!compact && <span className="mt-1 text-xs font-medium text-secondary-foreground">Kota Kupang</span>}
      </span>
    </span>
  );
}
