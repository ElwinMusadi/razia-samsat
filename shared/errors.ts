export const errorCatalog = {
  INVALID_INPUT: { status: 400, message: 'Masukan tidak valid.' },
  AUTHENTICATION_ERROR: { status: 401, message: 'Autentikasi diperlukan.' },
  INVALID_CREDENTIALS: { status: 401, message: 'Nama pengguna atau kata sandi salah.' },
  AUTHORIZATION_ERROR: { status: 403, message: 'Akses tidak diizinkan.' },
  CSRF_REJECTED: { status: 403, message: 'Permintaan ditolak.' },
  ROUTE_NOT_FOUND: { status: 404, message: 'Endpoint tidak ditemukan.' },
  RAID_SESSION_NOT_FOUND: { status: 404, message: 'Sesi razia tidak ditemukan.' },
  USER_NOT_FOUND: { status: 404, message: 'Pengguna tidak ditemukan.' },
  LOCATION_NOT_FOUND: { status: 404, message: 'Lokasi tidak ditemukan.' },
  SESSION_NOT_FOUND: { status: 404, message: 'Sesi perangkat tidak ditemukan.' },
  USERNAME_TAKEN: { status: 409, message: 'Nama pengguna sudah digunakan.' },
  SELF_DEACTIVATION_FORBIDDEN: { status: 409, message: 'Akun sendiri tidak dapat dinonaktifkan.' },
  SESSION_CONFLICT: { status: 409, message: 'Akun sedang aktif di perangkat lain. Hubungi admin untuk mereset sesi.' },
  RAID_SESSION_ALREADY_ACTIVE: { status: 409, message: 'Masih ada sesi razia yang aktif.' },
  RAID_SESSION_REQUIRED: { status: 409, message: 'Sesi razia aktif diperlukan.' },
  VEHICLE_SOURCE_CONFLICT: { status: 409, message: 'Pengaturan sumber data sudah berubah. Muat ulang, lalu periksa kembali sebelum menyimpan.' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Ukuran permintaan terlalu besar.' },
  LOCATION_UNAVAILABLE: { status: 422, message: 'Lokasi tidak tersedia.' },
  VEHICLE_SOURCE_CREDENTIALS_MISSING: { status: 422, message: 'Sumber Potensi NTT belum dapat dipilih karena kredensial layanan belum tersedia.' },
  INTERNAL_ERROR: { status: 500, message: 'Terjadi kesalahan layanan.' },
  UPSTREAM_ERROR: { status: 502, message: 'Layanan data tidak tersedia.' },
  UPSTREAM_MALFORMED: { status: 502, message: 'Respons layanan data tidak valid.' },
  UPSTREAM_NETWORK: { status: 502, message: 'Layanan data tidak dapat dihubungi.' },
  UPSTREAM_FORBIDDEN: { status: 502, message: 'Layanan data menolak akses aplikasi. Hubungi admin untuk memeriksa kredensial sumber data.' },
  UPSTREAM_BUSY: { status: 503, message: 'Layanan data sedang sibuk.' },
  VEHICLE_SOURCE_UNAVAILABLE: { status: 503, message: 'Sumber data kendaraan belum tersedia. Hubungi admin untuk memeriksa pengaturan sumber data.' },
  TIMEOUT: { status: 504, message: 'Layanan data melewati batas waktu.' },
} as const;
export type ErrorCode = keyof typeof errorCatalog;
export class AppError extends Error {
  constructor(public readonly code: ErrorCode, public readonly retryAfter?: string) {
    super(errorCatalog[code].message);
    this.name = 'AppError';
  }
}
export function safeError(error: unknown): AppError {
  return error instanceof AppError && Object.hasOwn(errorCatalog, error.code) ? error : new AppError('INTERNAL_ERROR');
}
