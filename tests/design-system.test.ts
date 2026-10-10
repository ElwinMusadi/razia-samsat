// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { createElement, createRef, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../src/components/ui/button';
import { Input, PasswordInput } from '../src/components/ui/input';
import { EmptyState, ErrorState, PageHeader, Surface } from '../src/components/ui/layout';
import { LookupOutcomeBadge, VehicleStatus, VehicleResultCard } from '../src/components/vehicle';
import { NopolInput } from '../src/components/nopol-input';
import { ApiError, errorText, type VehicleFound } from '../src/lib/api';

const css = await readFile(`${process.cwd()}/src/index.css`, 'utf8');
const result: VehicleFound = { outcome: 'FOUND', vehicle: { nopol: 'DH1823HJ', owner_name: 'Pemilik Sintetis', brand: 'Merek Sintetis', type: 'Tipe Sintetis', color: 'Warna Sintetis', tax_due_date: '2000-01-01', stnk_due_date: null, tax_status: 'ACTIVE', stnk_status: 'UNKNOWN' }, source: 'LIVE', fetched_at: '2026-10-08T00:00:00.000Z', evaluated_on: '2026-10-08', request_id: 'PRIVATE_REQUEST_ID' };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function rgb(hex: string) { return hex.replace('#', '').match(/../g)!.map(value => parseInt(value, 16) / 255); }
function luminance(color: number[]) { return color.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0); }
function contrast(a: number[], b: number[]) { const l = [luminance(a), luminance(b)].sort((x, y) => y - x); return (l[0]! + 0.05) / (l[1]! + 0.05); }
const tokens = { canvas: rgb('#F7F6F2'), ink: rgb('#0F1319'), white: rgb('#FFFFFF'), blue: rgb('#2B63F6'), success: rgb('#16803C'), danger: rgb('#C62828'), neutral: rgb('#6B7280'), warning: rgb('#A16207') };

describe('approved design foundation', () => {
  it('keeps approved colors centralized and operational fonts self-hosted', () => {
    for (const value of ['#F7F6F2', '#0F1319', '#8A8F96', '#E7E4DC', '#2B63F6', '#16803C', '#C62828', '#6B7280', '#A16207']) expect(css).toContain(value);
    expect(css).toContain('@fontsource/inter/latin-400.css'); expect(css).toContain('@fontsource/inter/latin-800.css'); expect(css).toContain('@fontsource/dm-serif-display/latin-400.css');
    expect(css).not.toMatch(/https?:\/\/|--radius-sm: var\(--radius-sm\)/);
  });
  it.each(['ink', 'blue', 'success', 'danger', 'warning'] as const)('meets normal-text AA for %s on the canvas and white surface', color => {
    expect(contrast(tokens[color], tokens.canvas)).toBeGreaterThanOrEqual(4.5); expect(contrast(tokens[color], tokens.white)).toBeGreaterThanOrEqual(4.5);
  });
  it('gives neutral status an explicit white surface for normal-text AA', () => {
    expect(contrast(tokens.neutral, tokens.white)).toBeGreaterThanOrEqual(4.5);
    expect(css).toContain(".vehicle-status[data-status='UNKNOWN'] { color: var(--neutral); background: var(--card); }");
    expect(css).toContain('--secondary-foreground: color-mix(in srgb, var(--foreground) 76%, var(--background))');
    const secondary = tokens.ink.map((value, index) => value * 0.76 + tokens.canvas[index]! * 0.24);
    expect(contrast(secondary, tokens.canvas)).toBeGreaterThanOrEqual(4.5);
  });
  it('declares mobile targets, safe area, visible focus and reduced motion', () => {
    expect(css).toMatch(/\.nav-link \{[^}]*min-h-12 min-w-12/); expect(css).toContain('env(safe-area-inset-bottom, 0px)');
    expect(css).toContain('outline: 2px solid var(--ring)'); expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('--radius-sm: 10px'); expect(css).toContain('--radius-md: 16px'); expect(css).toContain('--radius-lg: 24px');
  });
  it.each(['default', 'outline', 'destructive'] as const)('renders the %s button with 48px targets and semantic styles', variant => {
    render(createElement(Button, { variant }, 'Tindakan')); const button = screen.getByRole('button');
    expect(button.className).toContain('min-h-12'); expect(button.className).toContain('rounded-full');
    expect(button.className).toContain(variant === 'default' ? 'bg-foreground' : variant === 'destructive' ? 'bg-danger' : 'border-input');
  });
  it('focuses PageHeader headings by default for route accessibility', () => {
    render(createElement(PageHeader, { title: 'Riwayat' }));
    const heading = screen.getByRole('heading', { level: 1, name: 'Riwayat' });
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(heading);
  });
  it('keeps a PageHeader heading non-focusable when focusHeading is false', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    render(createElement(PageHeader, { title: 'Masuk', focusHeading: false }));
    const heading = screen.getByRole('heading', { level: 1, name: 'Masuk' });
    expect(heading.hasAttribute('tabindex')).toBe(false);
    expect(document.activeElement).not.toBe(heading);
    expect(focus).not.toHaveBeenCalled();
  });
  it('retains interactive focus outlines and scopes the scanner account panel upward', () => {
    expect(css).toContain('input:focus-visible, select:focus-visible, a:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }');
    expect(css).not.toMatch(/outline:\s*(?:none|0)\b/);
    expect(css).toContain('.scanner-session-controls { margin-top: var(--space-4); }');
    expect(css).toContain('.scanner-session-controls .account-panel { top: auto; bottom: calc(100% + var(--space-2)); }');
    expect(css).toMatch(/\.account-panel \{[^}]*top: calc\(100% \+ var\(--space-2\)\); width: min\(288px, calc\(100vw - var\(--space-8\)\)\)/);
  });
  it('uses compact scanner search spacing without new negative margins or a custom sr-only override', () => {
    const searchRule = css.match(/\.scanner-search \{([^}]+)\}/)![1]!;
    expect(searchRule).toContain('gap-2'); expect(searchRule).toContain('pb-2');
    expect(searchRule).not.toMatch(/gap-3|pb-4|margin-top|margin-bottom|-mt-|-mb-/);
    expect(css).toContain('--space-2: 8px'); expect(css).toContain('--space-3: 12px');
    expect(css).not.toMatch(/\.sr-only\s*\{/);
    // The pre-existing horizontal sticky-search bleed is the only negative margin utility.
    expect(css.match(/-(?:m[trblxy]?)-\d+/g)).toEqual(['-mx-4']);
  });
  it('forwards an Input ref and associated label unchanged', () => {
    const ref = createRef<HTMLInputElement>(); render(createElement('label', null, 'Jalur', createElement(Input, { ref, name: 'lane' })));
    expect(screen.getByLabelText('Jalur')).toBe(ref.current);
  });
  it('preserves raw NOPOL punctuation and overlength values, forwarding clear without normalizing', () => {
    const change = vi.fn(), clear = vi.fn(), ref = createRef<HTMLInputElement>(); const raw = 'dh-1234 zz'.padEnd(65, ' ');
    render(createElement(NopolInput, { ref, 'aria-label': 'NOPOL', value: raw, onChange: change, showClear: true, onClear: clear }));
    expect(ref.current!.value).toBe(raw); expect(ref.current!.hasAttribute('maxlength')).toBe(false);
    fireEvent.change(ref.current!, { target: { value: 'dh.12' } }); expect(change).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Hapus NOPOL' })); expect(clear).toHaveBeenCalledTimes(1);
  });
  it('toggles only password visibility and clears the uncontrolled credential on unmount', () => {
    const ref = createRef<HTMLInputElement>(); const storage = vi.spyOn(Storage.prototype, 'setItem');
    const view = render(createElement(PasswordInput, { inputRef: ref, 'aria-label': 'Kata sandi' })); const input = ref.current!;
    fireEvent.change(input, { target: { value: 'synthetic-secret' } }); fireEvent.click(screen.getByRole('button', { name: 'Tampilkan kata sandi' }));
    expect(input.type).toBe('text'); expect(input.value).toBe('synthetic-secret');
    fireEvent.click(screen.getByRole('button', { name: 'Sembunyikan kata sandi' })); expect(input.type).toBe('password'); expect(input.value).toBe('synthetic-secret');
    view.unmount(); expect(input.value).toBe(''); expect(storage).not.toHaveBeenCalled();
  });
  it('uses consistent surfaces and informative empty and error states', () => {
    render(createElement(Surface, null, createElement(EmptyState, { title: 'Belum ada data.' }, 'Buka sesi.'), createElement(ErrorState, { title: 'Pemeriksaan gagal.', warning: true }, 'Coba lagi.')));
    expect(screen.getByRole('status').textContent).toContain('Buka sesi.'); expect(screen.getByRole('alert').textContent).toContain('Coba lagi.');
    expect(screen.getByRole('alert').className).toContain('feedback-warning');
  });
});

describe('lookup outcome and vehicle status domains', () => {
  it('keeps component type domains disjoint', () => {
    type Outcome = ComponentProps<typeof LookupOutcomeBadge>['outcome']; type Status = ComponentProps<typeof VehicleStatus>['status'];
    const disjoint: [Extract<Outcome, Status>] extends [never] ? true : false = true;
    expect(disjoint).toBe(true);
    // @ts-expect-error Vehicle status cannot be used as a lookup outcome.
    const invalidOutcome: Outcome = 'ACTIVE';
    // @ts-expect-error Lookup outcome cannot be used as vehicle status.
    const invalidStatus: Status = 'NOT_FOUND';
    expect(invalidOutcome).not.toBe(invalidStatus);
  });
  it.each([['FOUND', 'Ditemukan'], ['NOT_FOUND', 'Tidak ditemukan']] as const)('labels %s independently of color', (outcome, label) => {
    const { container } = render(createElement(LookupOutcomeBadge, { outcome })); expect(screen.getByText(label)).toBeTruthy();
    expect(container.querySelector('[data-status]')).toBeNull(); expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    container.querySelector('span')!.removeAttribute('class'); expect(container.textContent).toBe(label);
  });
  it.each([['ACTIVE', 'AKTIF'], ['EXPIRED', 'MATI'], ['UNKNOWN', 'TIDAK DAPAT DITENTUKAN']] as const)('labels %s independently of color', (status, label) => {
    const { container } = render(createElement(VehicleStatus, { status })); expect(screen.getByText(label)).toBeTruthy();
    expect(container.querySelector('[data-outcome]')).toBeNull(); expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    container.querySelector('[data-status]')!.removeAttribute('class'); expect(container.textContent).toBe(label);
  });
  it('orders NOPOL, authoritative statuses and vehicle facts without metadata, IDs or logging', () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem'); const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method));
    render(createElement(VehicleResultCard, { result })); const card = screen.getByRole('article');
    const heading = screen.getByRole('heading', { name: result.vehicle.nopol }); const status = card.querySelector('.status-group')!;
    expect(heading.className).toBe('result-nopol'); expect(css).toMatch(/\.result-nopol \{[^}]*font-family: var\(--font-ui\); font-size: 40px/);
    expect(heading.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(status.compareDocumentPosition(card.querySelector('.vehicle-facts')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.querySelector('.vehicle-metadata')).toBeNull();
    expect(card.textContent).not.toMatch(/Data langsung|Data cache|Diambil|Dievaluasi|Keputusan pemeriksaan tetap pada petugas/);
    expect(card.querySelector('[data-status="ACTIVE"]')!.textContent).toBe('AKTIF'); expect(card.querySelector('[data-status="UNKNOWN"]')!.textContent).toBe('TIDAK DAPAT DITENTUKAN');
    expect(card.className).not.toMatch(/success|danger|emerald|red/); expect(card.textContent).toContain('01 Jan 2000'); expect(card.textContent).not.toContain(result.request_id);
    expect(storage).not.toHaveBeenCalled(); for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it('retains error metadata internally while rendering only the safe message', () => {
    const error = new ApiError('Layanan bermasalah. Coba lagi.', 503, 'UPSTREAM_BUSY', 'PRIVATE_REQUEST_ID');
    expect(error.requestId).toBe('PRIVATE_REQUEST_ID'); expect(error.code).toBe('UPSTREAM_BUSY'); expect(errorText(error)).toBe(error.message);
  });
});
