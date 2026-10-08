import { DevelopmentError, prepareDevelopment, resetDevelopment } from './development.ts';
try {
  const args = process.argv.slice(2);
  if (args.length === 0) await prepareDevelopment();
  else if (args.length === 2 && args[0] === 'reset' && args[1] === '--confirm-reset') await resetDevelopment(true);
  else throw new DevelopmentError('Gunakan npm run dev:seed atau npm run dev:reset -- --confirm-reset.');
  process.stdout.write('Migrasi dan seed UAT lokal selesai; akun/lokasi existing tidak ditimpa.\n');
} catch (error) {
  process.stderr.write(`${error instanceof DevelopmentError ? error.message : 'Persiapan UAT lokal gagal.'}\n`);
  process.exitCode = 1;
}
