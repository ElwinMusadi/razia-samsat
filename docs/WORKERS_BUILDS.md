# Workers Builds — Razia SAMSAT

Pipeline ini hanya menargetkan Worker existing `razia-samsat`. Kelulusan lokal atau
snapshot kandidat bukan otorisasi commit, push, upload, atau deployment produksi.

## Konfigurasi build

- Repository: `ElwinMusadi/razia-samsat`; production branch: `main`; root: `/`.
- Build command: `npm run ci:build`.
- Deploy command: `npm run ci:deploy`.
- Dependency diinstal dari `package-lock.json`, termasuk devDependencies.
- Node wajib `24.21.0`; Wrangler dari lockfile wajib `4.148.0`.
- `scripts/ci-production.ts`, konfigurasi produksi, dan seluruh sumber kandidat
  harus tracked. Jangan membawa `.env*`, `.dev.vars*`, atau credential laptop.

Screenshot yang dilaporkan operator mengonfirmasi repository, branch, commands,
dan root. Status Disable builds, preview builds, token, dan resource live masih
`NOT VERIFIED` sampai ada bukti aktual. Preview Builds berbeda dari Preview URLs;
`preview_urls: false` tidak membuktikan preview builds Dashboard nonaktif.
Push ke `main` dapat memicu produksi jika builds aktif. Jangan push sebelum ada
otorisasi terpisah yang mencakup konsekuensi tersebut.

## Environment build dan autentikasi

| Nama | Sumber dan kontrak |
| --- | --- |
| `NODE_VERSION` | Build variable Dashboard: `24.21.0` |
| `CI` | Workers Builds menyediakan `true`; guard menerima `true` atau `1` |
| `WORKERS_CI` | Workers Builds menyediakan `1` |
| `WORKERS_CI_BRANCH` | Harus `main` |
| `WORKERS_CI_COMMIT_SHA` | SHA 40 karakter lowercase yang cocok dengan checkout dan tip `origin/main` |
| `CLOUDFLARE_API_TOKEN` | Secret wajib untuk metadata dan deploy; availability/scope aktual `NOT VERIFIED` |

Jangan mengisi branch/SHA sistem dengan nilai statis. Pilih token melalui API token
di Build Configuration. Jika platform sudah menyediakan `CLOUDFLARE_API_TOKEN`,
jangan menambah secret duplikat. Jika tidak, kebutuhan penyediaannya harus ditinjau
operator; jangan mencetak, membuat, atau merotasi token sebagai bagian diagnosis.
CI deploy menolak fallback OAuth laptop, `CF_API_TOKEN`, serta global API key/email.
Environment CI disalin dan dibekukan; runner menyalinnya sebelum operasi async.
Account ID tidak perlu input terminal karena konfigurasi dan runner menentukannya.

- `WRANGLER_CI_OVERRIDE_NAME`: tidak tersedia atau tepat `razia-samsat`; kosong,
  whitespace, nama lain, padding, dan kapitalisasi berbeda ditolak sebelum upload.
- Wrangler `4.148.0` mendukung `WRANGLER_API_ENVIRONMENT=production|staging`, tetapi
  pipeline ini hanya menerima tidak tersedia atau `production`.
- Override `CLOUDFLARE_ENV` dan endpoint alternatif ditolak. Jangan gunakan
  konfigurasi redirect `.wrangler/deploy/config.json` untuk pipeline ini.

Build variables/secrets hanya tersedia pada build. Runtime Worker variables berasal
dari `wrangler.production.jsonc`, bukan dari Build variables: `RETENTION_POLICY`,
`PASSWORD_PBKDF2_ITERATIONS`, dan `SESSION_TTL_SECONDS`. Baseline PBKDF2 `10` adalah
risiko keamanan existing, bukan rekomendasi; perubahan keamanan memerlukan review
terpisah. Token Cloudflare tidak boleh dimasukkan ke runtime `vars`.

## Permission dan scope

Permission inti berikut mengikuti operasi API yang digunakan, bukan bukti bahwa
token Dashboard aktual sudah memilikinya:

| Scope | Permission | Pemakaian |
| --- | --- | --- |
| Account | Workers Scripts: Edit | Upload/aktivasi, metadata versi/settings/domain, dan aset |
| Account | Workers KV Storage: Read | Inventory namespace KV |
| Account | D1: Read | Inventory database D1 |
| Zone | Zone: Read | Identitas/status zone |
| Zone | DNS: Read | Record exact hostname dan proxied status |
| Zone | Workers Routes: Read | Review route yang berkonflik |

Account scope baseline: `04b8b2073be2f1aa21fc6489e0db36f6`.
Zone scope baseline: `e937dc955107f12dae6cc95d6f84e2a0`.
`whoami --json` juga membaca inventory `/accounts`, `/user`, dan `/memberships`.
Account Settings: Read adalah kandidat permission discovery yang perlu diuji;
User Details: Read dan Memberships: Read bukan minimum mutlak yang terbukti karena
Wrangler menoleransi sebagian kegagalan permission. Minimum token lengkap dan
account inventory yang diterima guard tetap `NOT VERIFIED` sampai diuji read-only.
Token otomatis bawaan jangan diasumsikan cukup: daftar default resmi tidak
mencantumkan D1, Zone Read, dan DNS Read. Tidak dibutuhkan D1/KV write atau R2 untuk
pipeline ini. SSL Read hanya diperlukan jika audit sertifikat terpisah membacanya;
pipeline saat ini tidak melakukan API sertifikat.

## Urutan `ci:build`

1. Periksa root dan `.wrangler` fisik; hapus hanya receipt lama `ci-gate.json`.
   Tidak ada `git clean`, reset, stash, atau pembersihan perubahan operator.
2. Verifikasi toolchain, environment CI, SHA/branch/repository dan tip main.
   Tolak modified/staged/untracked files; konfigurasi produksi wajib tracked.
   Periksa ignored input dengan allowlist sempit untuk dependency/aset/cache;
   tolak credential, alias path, symlink/junction, dan metadata ambigu.
3. Muat konfigurasi produksi, periksa override/target, hash seluruh sumber tracked.
4. Bangun aset melalui typecheck dan Vite dengan `VITE_APP_MODE=production`.
5. Jalankan lint, seluruh test, dan `npm audit --audit-level=high --include=dev`.
   Task tersebut memakai `NODE_ENV=test`.
6. Ulangi pemeriksaan context dan hash sumber; hash aset `dist` termasuk index.
   Tulis `.wrangler/ci-gate.json` hanya setelah seluruh gate berhasil.

Receipt memuat SHA serta hash config, lockfile, sumber, dan aset; tidak memuat secret.
Receipt adalah artefak build untuk tahap deploy, bukan file yang di-commit.

## Urutan `ci:deploy`

1. Periksa context, token eksplisit, konfigurasi/override target, dan receipt.
2. Sebelum upload, baca account/D1/KV inventory, deployment aktif, custom domain,
   DNS, zone/routes, dan Worker settings. Nama dan ID harus cocok; metadata gagal
   atau ambigu menghentikan proses. Deployment existing harus satu versi 100%.
3. Ulangi guard environment; upload versi dengan `--name razia-samsat --strict`,
   tag/message commit, lalu inspeksi ID versi dengan target yang sama.
4. Validasi anotasi commit, binding snapshot, runtime compatibility date, sumber,
   receipt, aset, dan deployment aktif yang tidak berubah sejak preflight.
5. Ulangi guard environment; baru minta aktivasi versi 100% dengan target eksplisit
   dan `--yes`. Tidak ada retry otomatis jika upload/aktivasi gagal atau ambigu.

Konfigurasi hanya memuat identifier nonrahasia. Baseline D1 `razia-samsat-db`, KV
`razia-samsat-vehicle-cache`, binding `DB`/`VEHICLE_CACHE`/`ASSETS`, dan hostname
`tilang.uptdpenda-kupang.web.id` bukan bukti live: seluruh ID, binding/runtime,
domain, sertifikat, dan izin token masih `NOT VERIFIED` bila belum dibaca aktual.
Tidak ada migrasi, bootstrap, reset akun, secret rotation, atau mutasi DNS/domain
dalam pipeline. Command migrasi/operator lain di package tidak dipanggil oleh CI.

## Validasi dan diagnosis

Pada snapshot kandidat jalankan instalasi lockfile, test CI/produksi, typecheck,
lint, seluruh test, build, `production:check`, `production:dryrun`, dan audit.
Dry-run hanya packaging lokal, bukan validasi produksi. Receipt yang dibuktikan
melalui dependency injection Git/CI sintetis harus dilabeli sintetis; tidak boleh
dilaporkan sebagai build Cloudflare aktual atau bukti permission/resource live.

Jika gate gagal, pertahankan perubahan/artefak diagnosis; baca status, hash, error
tersanitasi, dan metadata yang diizinkan. Jangan mengulang upload/aktivasi, rollback,
login/refresh, perubahan permission, atau mutasi untuk membuat guard lulus.
Jika credential tidak tersedia/kedaluwarsa, laporkan `NOT VERIFIED`.
Operator membaca Settings > Build (token, variables, Disable builds/preview),
Worker bindings/deployment/domain, D1/KV IDs, zone/DNS/sertifikat tanpa Save/Retry.
Verifikasi deployment setelah otorisasi masa depan memeriksa versi aktif, binding,
hostname/TLS, aset, dan respons read-only; keberhasilan CLI saja tidak cukup.

Referensi: [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/),
[Worker override](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/),
[Worker domain permissions](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/).
