import { forwardRef, useLayoutEffect, useState, type InputHTMLAttributes, type RefObject } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => <input ref={ref} className={cn('input-control', className)} {...props} />);
Input.displayName = 'Input';

/** Only visibility is stateful; the credential stays in the uncontrolled DOM input. */
export function PasswordInput({ inputRef, className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange'> & { inputRef: RefObject<HTMLInputElement | null> }) {
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    const input = inputRef.current;
    return () => { if (input) input.value = ''; };
  }, [inputRef]);
  return <div className="password-control">
    <Input {...props} ref={inputRef} type={visible ? 'text' : 'password'} className={className} />
    <button type="button" className="password-toggle" disabled={props.disabled} aria-label={visible ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'} aria-pressed={visible} onClick={() => setVisible(value => !value)}>
      {visible ? <EyeOff aria-hidden="true" size={20} /> : <Eye aria-hidden="true" size={20} />}
    </button>
  </div>;
}
