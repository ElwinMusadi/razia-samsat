import { cn } from '@/lib/utils';

/**
 * Skeleton — placeholder shimmer untuk status loading.
 *
 * Pakai untuk menggantikan teks "memuat…" polos pada permukaan penting
 * (mis. kartu hasil scanner). Animasi shimmer didefinisikan di index.css
 * dan otomatis dinonaktifkan saat prefers-reduced-motion.
 *
 * Fondasi Fase 0: komponen ini belum dipakai layar produksi mana pun.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('skeleton', className)} />;
}
