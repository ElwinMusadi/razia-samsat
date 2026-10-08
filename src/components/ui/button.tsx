import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
const buttonVariants = cva('inline-flex min-w-12 items-center justify-center gap-2 whitespace-normal rounded-full text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-60 [&_svg]:size-5 [&_svg]:shrink-0', {
  variants: { variant: { default: 'bg-foreground text-primary-foreground hover:bg-foreground/90', outline: 'border border-input bg-card text-foreground hover:bg-accent', destructive: 'bg-danger text-primary-foreground hover:bg-danger/90' }, size: { default: 'min-h-12 px-5 py-3', sm: 'min-h-12 px-4 py-2', lg: 'min-h-12 px-8 py-3' } }, defaultVariants: { variant: 'default', size: 'default' }
});
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { asChild?: boolean }
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Component = asChild ? Slot : 'button';
  return <Component ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
});
Button.displayName = 'Button';
export { Button };
