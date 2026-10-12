import { cn } from '@/lib/utils';

/**
 * BrandMark & BrandLockup — identitas visual aplikasi.
 *
 * Memakai lambang resmi Provinsi Nusa Tenggara Timur sebagai mark,
 * dipadukan dengan wordmark SAMSAT Kota Kupang.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src="/logo-ntt.png"
      alt="Logo Provinsi Nusa Tenggara Timur"
      width={40}
      height={40}
      draggable={false}
      className={cn('h-10 w-10 shrink-0 object-contain', className)}
    />
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
