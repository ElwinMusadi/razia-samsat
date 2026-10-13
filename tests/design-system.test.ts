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
const tokens = { canvas: rgb('#F3F7F9'), ink: rgb('#0F1319'), white: rgb('#FFFFFF'), blue: rgb('#2B63F6'), link: rgb('#1E4FD6'), controlBorder: rgb('#64748B'), success: rgb('#16803C'), danger: rgb('#C62828'), neutral: rgb('#6B7280'), warning: rgb('#A16207') };

describe('approved design foundation', () => {
  it('keeps approved colors centralized and operational fonts self-hosted', () => {
    for (const value of ['#F3F7F9', '#0F1319', '#8A8F96', '#E7E4DC', '#2B63F6', '#1E4FD6', '#64748B', '#16803C', '#C62828', '#6B7280', '#A16207']) expect(css).toContain(value);
    expect(css).toContain('@fontsource/inter/latin-400.css'); expect(css).toContain('@fontsource/inter/latin-800.css'); expect(css).toContain('@fontsource/dm-serif-display/latin-400.css');
    expect(css).not.toMatch(/https?:\/\/|--radius-sm: var\(--radius-sm\)/);
  });
  it.each(['ink', 'blue', 'success', 'danger', 'warning'] as const)('meets normal-text AA for %s on the canvas and white surface', color => {
    expect(contrast(tokens[color], tokens.canvas)).toBeGreaterThanOrEqual(4.5); expect(contrast(tokens[color], tokens.white)).toBeGreaterThanOrEqual(4.5);
  });
  it('gives neutral status an explicit white surface for normal-text AA', () => {
    expect(contrast(tokens.neutral, tokens.white)).toBeGreaterThanOrEqual(4.5);
    const { container } = render(createElement(VehicleStatus, { status: 'UNKNOWN' }));
    const chip = container.querySelector('[data-status="UNKNOWN"]')!;
    expect(chip.className).toMatch(/bg-neutral-muted/);
    expect(chip.className).not.toMatch(/bg-transparent/);
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
    expect(css).toContain('.scanner-session-controls { margin-top: var(--space-4); position: relative; z-index: 10; }');
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
  it('reserves space beyond the fixed navigation and isolates the scanner footer stacking', async () => {
    const app = await readFile(`${process.cwd()}/src/app.tsx`, 'utf8');
    const reserve = '\n.operational-layout { padding-bottom: calc(6rem + var(--space-8) + env(safe-area-inset-bottom, 0px)); }';
    expect(css).toContain(reserve);
    expect(css.indexOf(reserve)).toBeGreaterThan(css.indexOf('@media (min-width: 1024px) {'));
    expect(css).toContain('.scanner-session-controls { margin-top: var(--space-4); position: relative; z-index: 10; }');
    expect(app).toContain('className="bottom-navigation fixed inset-x-0 bottom-0 z-20"');
    expect(app).toContain('page-layout operational-layout pb-[calc(6rem+env(safe-area-inset-bottom,0px))]');
    expect(css).toContain('.scanner-session-controls .account-panel { top: auto; bottom: calc(100% + var(--space-2)); }');
    // Require a top-level rule: layered CSS would lose to desktop page padding.
    const prefix = css.slice(0, css.indexOf(reserve)).replace(/\/\*[\s\S]*?\*\//g, '');
    expect([...prefix].reduce((depth, char) => depth + (char === '{' ? 1 : char === '}' ? -1 : 0), 0)).toBe(0);
  });
  it('attaches the scanner notch with concave shoulders and accessible dark contrast', () => {
    const notch = css.match(/\.session-bar\.scanner-notch \{([^}]+)\}/)![1]!;
    expect(notch).toContain('width: min(560px, calc(100% - 2 * var(--notch-radius)))');
    expect(notch).toContain('min-height: 44px');
    expect(notch).toContain('border-radius: 0 0 var(--notch-radius) var(--notch-radius)');
    expect(css).toContain('--notch-radius: var(--radius-md)');
    expect(css).toContain('.scanner-search:has(.scanner-notch) { padding-top: 0; }');
    expect(css).toMatch(/\.session-bar\.scanner-notch::before \{[^}]*radial-gradient\(circle at 0 100%, transparent/);
    expect(css).toMatch(/\.session-bar\.scanner-notch::after \{[^}]*radial-gradient\(circle at 100% 100%, transparent/);
    expect(css).toMatch(/@media \(forced-colors: active\) \{[^}]*\.session-bar\.scanner-notch::before, \.session-bar\.scanner-notch::after \{ display: none; \}/);
    expect(css).not.toMatch(/scanner-notch[^{]*\{[^}]*(?:mask|clip-path|backdrop-filter)/);
    for (const hex of ['#F7F9FB', '#CBD5E1', '#A7F3D0']) {
      expect(css).toContain(hex);
      expect(contrast(rgb(hex), rgb('#090B0D'))).toBeGreaterThanOrEqual(4.5);
    }
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
  it('implements solid-first chrome with progressive blur and explicit accessibility overrides', () => {
    expect(css).toMatch(/--chrome-surface:\s*var\(--card\);/);
    expect(css).toMatch(/--chrome-filter:\s*none;/);
    expect(css).toMatch(/--chrome-border:\s*#D6DEE3;/);
    expect(css).toContain('@supports ((backdrop-filter: blur(12px)) or (-webkit-backdrop-filter: blur(12px)))');
    expect(css).toContain('--chrome-surface: rgb(255 255 255 / 0.9); --chrome-filter: blur(12px);');
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{\s*:root \{\s*--chrome-surface: var\(--card\);\s*--chrome-filter: none;/);
    expect(css).toMatch(/@media \(forced-colors: active\) \{[^}]*--chrome-surface: Canvas;[^}]*--chrome-filter: none;/);
  });
  it('isolates header chrome pseudo-layer and disables it in scanner session controls while keeping account panel opaque', () => {
    expect(css).toMatch(/\.app-header::before \{[^}]*content: '';[^}]*background: var\(--chrome-surface\);[^}]*backdrop-filter: var\(--chrome-filter\);/);
    expect(css).toContain('.scanner-session-controls .app-header { background: var(--card); border: 1px solid var(--chrome-border); }');
    expect(css).toContain('.scanner-session-controls .app-header::before { display: none; }');
    const accountPanelMatch = css.match(/(?:^|\n)\s*\.account-panel \{([^}]+)\}/);
    expect(accountPanelMatch).not.toBeNull();
    expect(accountPanelMatch![1]).toContain('bg-card');
    expect(accountPanelMatch![1]).not.toMatch(/backdrop-filter/);
  });
  it('keeps data cards opaque white without filters and bounds blur variables to 12px', () => {
    // Note: JSDOM cannot evaluate rendered blur or visual composition; actual visual blur rendering is MANUAL VISUAL PENDING.
    for (const className of ['panel', 'surface', 'vehicle-result', 'metric', 'history-row', 'empty-state']) {
      expect(css).toMatch(new RegExp(`\\.${className}[^{]*\\{[^}]*bg-card`));
    }
    const backdropRules = css.match(/[^{}]+(?=\{[^}]*backdrop-filter)/g) ?? [];
    for (const rule of backdropRules) {
      expect(rule).toMatch(/\.app-header::before|\.bottom-navigation-pill|\.scanner-search|@supports/);
      expect(rule).not.toMatch(/\.vehicle-result|\.metric|\.history-row|\.panel|\.surface|\.empty-state/);
    }
    const blurs = css.match(/blur\([^)]+\)/g) ?? [];
    expect(blurs.length).toBeGreaterThan(0);
    for (const blur of blurs) {
      expect(blur).toBe('blur(12px)');
    }
  });
  it('satisfies 320px compact navigation geometry arithmetic across all 5 destinations in source sizing', () => {
    const linkWidth = 48;
    const fabWidth = 56;
    const gap = 2;
    const paddingInline = 8 * 2;
    const borders = 1 * 2;
    const totalPillWidth = (4 * linkWidth) + fabWidth + (4 * gap) + paddingInline + borders;
    expect(totalPillWidth).toBe(274);
    const availableWidthAt320 = 320 - (16 * 2);
    expect(availableWidthAt320).toBe(288);
    expect(totalPillWidth).toBeLessThanOrEqual(availableWidthAt320);
    expect(css).toMatch(/@media \(max-width: 359px\) \{[^}]*\.bottom-navigation-pill \{[^}]*gap: calc\(var\(--space-1\) \/ 2\);/);
    expect(css).toMatch(/\.nav-link \{[^}]*flex: 0 0 var\(--space-12\);/);
    expect(css).toMatch(/\.nav-fab \{[^}]*margin-inline: 0;/);
  });
  it('enforces strong link contrast over 90% composited glass and verifies non-text control border contrast', () => {
    const compositedGlass = tokens.white.map(value => value * 0.9);
    expect(contrast(tokens.blue, compositedGlass)).toBeLessThan(4.5);
    expect(contrast(tokens.link, compositedGlass)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.link, tokens.white)).toBeGreaterThanOrEqual(4.5);
    expect(css).toMatch(/\.nav-link\[aria-current='page'\] \{[^}]*color: var\(--link\);/);
    expect(contrast(tokens.controlBorder, tokens.white)).toBeGreaterThanOrEqual(3.0);
    expect(contrast(tokens.controlBorder, tokens.canvas)).toBeGreaterThanOrEqual(3.0);
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
