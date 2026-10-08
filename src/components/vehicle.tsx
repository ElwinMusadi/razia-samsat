import { CheckCircle2, CircleHelp, CircleX, SearchCheck, SearchX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCalendarDate, formatInstantWita, type VehicleFound, type VehicleLookupResult, type VehicleStatus as Status } from '@/lib/api';

/** Lookup outcome and vehicle status intentionally have separate prop domains. */
export function LookupOutcomeBadge({ outcome }: { outcome: VehicleLookupResult['outcome'] }) {
  const Icon = outcome === 'FOUND' ? SearchCheck : SearchX;
  return <span data-outcome={outcome} className="lookup-outcome"><Icon aria-hidden="true" />{outcome === 'FOUND' ? 'Ditemukan' : 'Tidak ditemukan'}</span>;
}
export function VehicleStatus({ status, compact = false }: { status: Status; compact?: boolean }) {
  const Icon = status === 'ACTIVE' ? CheckCircle2 : status === 'EXPIRED' ? CircleX : CircleHelp;
  const text = status === 'ACTIVE' ? 'AKTIF' : status === 'EXPIRED' ? 'MATI' : 'TIDAK DAPAT DITENTUKAN';
  return <span data-status={status} className={cn('vehicle-status', compact && 'vehicle-status-compact')}><Icon aria-hidden="true" /><span>{text}</span></span>;
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
  return <article aria-labelledby="result-nopol" className="vehicle-result">
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
    <div className="vehicle-metadata">
      <p className="font-semibold">{result.source === 'LIVE' ? 'Data langsung' : 'Data cache (≤5 menit)'}</p>
      <p>Diambil <time dateTime={result.fetched_at}>{formatInstantWita(result.fetched_at)}</time></p>
      <p>Dievaluasi <time dateTime={result.evaluated_on}>{formatCalendarDate(result.evaluated_on)}</time> WITA</p>
    </div>
    <p className="supporting">Status adalah data administratif. Keputusan pemeriksaan tetap pada petugas.</p>
  </article>;
}
