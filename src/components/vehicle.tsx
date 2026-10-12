import { SearchCheck, SearchX } from 'lucide-react';
import { StatusChip, type StatusChipTone } from './ui/status-chip';
import { formatCalendarDate, formatWita, type VehicleFound, type VehicleLookupResult, type VehicleStatus as Status } from '@/lib/api';

/** Lookup outcome and vehicle status intentionally have separate prop domains. */
export function LookupOutcomeBadge({ outcome }: { outcome: VehicleLookupResult['outcome'] }) {
  const Icon = outcome === 'FOUND' ? SearchCheck : SearchX;
  return (
    <StatusChip tone="neutral" size="compact" icon={Icon} data-outcome={outcome}>
      {outcome === 'FOUND' ? 'Ditemukan' : 'Tidak ditemukan'}
    </StatusChip>
  );
}

const statusTones: Record<Status, StatusChipTone> = { ACTIVE: 'success', EXPIRED: 'danger', UNKNOWN: 'neutral' };
const statusLabels: Record<Status, string> = { ACTIVE: 'AKTIF', EXPIRED: 'MATI', UNKNOWN: 'TIDAK DAPAT DITENTUKAN' };

export function VehicleStatus({ status, compact = false }: { status: Status; compact?: boolean }) {
  return (
    <StatusChip tone={statusTones[status]} size={compact ? 'compact' : 'default'} data-status={status}>
      {statusLabels[status]}
    </StatusChip>
  );
}
function StatusBlock({ id, label, status, due }: { id: string; label: string; status: Status; due: string | null }) {
  return <section aria-labelledby={id} className="status-block">
    <h3 id={id} className="text-sm font-semibold">{label}</h3>
    <VehicleStatus status={status} />
    <p className="supporting">Jatuh tempo: <span className="font-medium">{formatCalendarDate(due)}</span></p>
  </section>;
}
export function VehicleResultCard({ result }: { result: VehicleFound }) {
  const { vehicle } = result;
  return <article aria-labelledby="result-nopol" className="vehicle-result result-enter">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="eyebrow">Hasil pemeriksaan</p><LookupOutcomeBadge outcome={result.outcome} /></div>
    <h2 id="result-nopol" className="result-nopol">{vehicle.nopol}</h2>
    <div className="status-group">
      <StatusBlock id="tax-status-title" label="Status Pajak" status={vehicle.tax_status} due={vehicle.tax_due_date} />
      <StatusBlock id="stnk-status-title" label="Status STNK" status={vehicle.stnk_status} due={vehicle.stnk_due_date} />
    </div>
    <dl className="vehicle-facts">
      <div><dt>Nama pemilik</dt><dd>{vehicle.owner_name}</dd></div>
      <div><dt>Merek</dt><dd>{vehicle.brand}</dd></div>
      <div><dt>Tipe</dt><dd>{vehicle.type}</dd></div>
      <div><dt>Warna</dt><dd>{vehicle.color}</dd></div>
    </dl>
    <p className="result-meta">{result.source} · <time dateTime={result.fetched_at}>{formatWita(Math.floor(new Date(result.fetched_at).getTime() / 1000))}</time></p>
  </article>;
}
