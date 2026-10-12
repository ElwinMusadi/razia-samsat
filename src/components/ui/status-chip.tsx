import { AlertCircle, CheckCircle2, CircleHelp, CircleX, type LucideIcon } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * StatusChip — chip status operasional ber-tint untuk keterbacaan lapangan.
 *
 * Berbeda dengan teks berwarna saja, chip ini memasangkan ikon + label tegas
 * di atas background tint, sehingga tetap terbaca di bawah glare matahari.
 * Ikon tidak pernah berdiri sendiri: selalu ada label teks (DESIGN_SYSTEM §12).
 *
 * Fondasi Fase 0: komponen ini belum dipakai layar produksi mana pun.
 */
export type StatusChipTone = 'success' | 'danger' | 'warning' | 'neutral';
export type StatusChipSize = 'default' | 'compact';

const toneIcons: Record<StatusChipTone, LucideIcon> = {
  success: CheckCircle2,
  danger: CircleX,
  warning: AlertCircle,
  neutral: CircleHelp,
};

const toneClasses: Record<StatusChipTone, string> = {
  success: 'border-success/30 bg-success-muted text-success',
  danger: 'border-danger/30 bg-danger-muted text-danger',
  warning: 'border-warning/30 bg-warning-muted text-warning',
  neutral: 'border-border bg-neutral-muted text-foreground',
};

export function StatusChip({
  tone,
  icon,
  size = 'default',
  className,
  children,
  ...props
}: {
  /** Makna semantik status. Jangan memakai 'success' untuk netral atau sebaliknya. */
  tone: StatusChipTone;
  /** Ikon kustom; isi null untuk menyembunyikan ikon bawaan. */
  icon?: LucideIcon | null;
  size?: StatusChipSize;
  className?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLSpanElement>) {
  const Icon = icon === null ? null : (icon ?? toneIcons[tone]);
  return (
    <span
      {...props}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border font-bold',
        size === 'compact' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
        toneClasses[tone],
        className,
      )}
    >
      {Icon && <Icon aria-hidden="true" size={size === 'compact' ? 14 : 16} className="shrink-0" />}
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}
