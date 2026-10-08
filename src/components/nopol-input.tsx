import { forwardRef, type InputHTMLAttributes } from 'react';
import { X } from 'lucide-react';
import { Input } from './ui/input';

/** Styling only: raw input, debounce, normalization and cancellation belong to the scanner. */
export const NopolInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { showClear: boolean; onClear: () => void }>(({ showClear, onClear, ...props }, ref) => <div className="relative">
  <Input {...props} ref={ref} className="nopol-input" />
  {showClear && <button type="button" onClick={onClear} aria-label="Hapus NOPOL" className="nopol-clear"><X aria-hidden="true" size={24} strokeWidth={2.5} /></button>}
</div>);
NopolInput.displayName = 'NopolInput';
