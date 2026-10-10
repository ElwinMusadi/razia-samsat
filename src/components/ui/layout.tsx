import { useEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, Inbox, LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export function PageHeader({ title, eyebrow, children, operational = false, focusHeading = true }: { title: ReactNode; eyebrow?: string; children?: ReactNode; operational?: boolean; focusHeading?: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focusHeading) ref.current?.focus(); }, [focusHeading]);
  return <div className="page-header min-w-0">
    {eyebrow && <p className="eyebrow">{eyebrow}</p>}
    <h1 ref={focusHeading ? ref : undefined} tabIndex={focusHeading ? -1 : undefined} className={operational ? 'admin-heading' : 'page-heading'}>{title}</h1>
    {children && <div className="supporting">{children}</div>}
  </div>;
}
export function Surface({ className, children, ...props }: HTMLAttributes<HTMLElement>) {
  return <section {...props} className={cn('surface', className)}>{children}</section>;
}
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div role="status" className="empty-state"><Inbox aria-hidden="true" /><p className="empty-heading">{title}</p>{children && <div className="supporting">{children}</div>}</div>;
}
export function ErrorState({ title, children, warning = false, ...props }: HTMLAttributes<HTMLDivElement> & { title?: string; warning?: boolean }) {
  return <div {...props} role="alert" className={cn('feedback flex flex-col gap-2', warning && 'feedback-warning', props.className)}>
    {title && <p className="flex items-center gap-2 font-semibold"><AlertCircle aria-hidden="true" size={20} />{title}</p>}{children}
  </div>;
}
export function Spinner() { return <LoaderCircle aria-hidden="true" size={16} className="shrink-0 animate-spin motion-reduce:animate-none" />; }
