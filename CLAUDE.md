# CLAUDE.md — Razia SAMSAT Kota Kupang

Ringkasan kerja untuk agen. Sumber kebenaran produk: `docs/AI Product Blueprint - Aplikasi Razia Kendaraan SAMSAT Kota Kupang.md`. Status, bukti, dan keputusan terbaru: `PROJECT_STATUS.md` (keputusan user terbaru menggantikan catatan lama yang bertentangan).

## Tujuan dan arsitektur

- Aplikasi petugas razia SAMSAT Kota Kupang: buka sesi razia (lokasi + jalur), cari NOPOL, lihat status pajak/STNK, riwayat per sesi, dan administrasi pengguna/lokasi/sumber data.
- Satu Cloudflare Worker (`worker/index.ts`, Hono) melayani `/api/*`; aset SPA (`dist/`, React) dilayani binding `ASSETS`. Produksi: Worker `razia-samsat` di `https://tilang.uptdpenda-kupang.web.id`.
- Data: D1 `razia-samsat-db` (migrasi `migrations/0001`–`0005`). KV `VEHICLE_CACHE` tetap terpasang tetapi **tidak dipakai**.
- Sumber data kendaraan dipilih global oleh ADMIN (tabel `vehicle_source_settings`, default `BPAD`):
  - **BPAD** — API publik BPAD, data live (`worker/vehicle/bpad.ts`).
  - **Potensi NTT** — `https://api.uptdpenda-kupang.web.id/api/v1/vehicle/{nopol}` (Worker `api-potensi-ntt`, snapshot BPAD) di belakang Cloudflare Access; header `Authorization: Bearer` dari secret `POTENSI_API_KEY` (kunci `ptn_…` dari website potensi-tarik) **plus** `CF-Access-Client-Id/Secret` dari `POTENSI_ACCESS_CLIENT_ID` / `POTENSI_ACCESS_CLIENT_SECRET` selama Access masih aktif (`worker/vehicle/potensi.ts`). 403 `region_not_allowed` → `VEHICLE_REGION_NOT_ALLOWED` (422).
- Entry development `worker/dev-index.ts` mensimulasikan kedua provider (zero outbound), hanya untuk localhost.

## Stack dan versi

Node 24.21.0, Wrangler 4.148.0 (keduanya dipin oleh guard CI), TypeScript ~6.0, React 19, react-router 7, Hono 4, Vite 8, Tailwind 4, Vitest 4, Miniflare 5 (alpha), oxlint. Compatibility date `2026-10-07`.

## Perintah

```
npm run dev               # UAT lokal http://127.0.0.1:8787 (migrasi + seed lokal, data simulasi)
npm run typecheck         # app + worker + tools
npm run lint              # oxlint; baseline 0 error / 9 warning
npm test                  # vitest (D1/workerd lokal via Miniflare); 39 file / 1646 test per 2026-10-23
VITE_APP_MODE=production npm run build
npm audit --audit-level=high
npm run production:verify  -- --confirm-account … --confirm-database … --confirm-worker razia-samsat --confirm-origin https://tilang.uptdpenda-kupang.web.id
npm run production:migrate -- (flag konfirmasi yang sama)
```

Deploy produksi terjadi otomatis lewat Workers Builds saat push ke `main` (`npm run ci:build` lalu `npm run ci:deploy`). Lihat `docs/WORKERS_BUILDS.md` dan `docs/PRODUCTION_OPERATIONS.md`.

## Batas kerja

- **Push ke `main` = deploy produksi.** Stage/commit/push, migrasi remote, secret, perubahan Cloudflare/Access, dan deploy `api-potensi-ntt` hanya dengan izin eksplisit per tindakan.
- Jangan baca `.env`/`.dev.vars` atau meminta credential lewat chat. Jangan menyimpan nilai secret di repo, dokumen, atau log.
- Parameter produksi tetap: PBKDF2 `10`, `SESSION_TTL_SECONDS=43200`, `RETENTION_POLICY=UNSET`.
- Perubahan operator pada `.gitignore` (`docs/log`) jangan di-stage otomatis.
- Repo `D:\Herd\api-potensi-ntt` bukan Git; buat cadangan sebelum mengubah apa pun di sana.

## Konvensi dan keputusan desain

- **Tanpa cache kendaraan** untuk semua provider (tanpa KV, Cache API, memori, browser storage). Setiap lookup memanggil upstream; respons API `Cache-Control: no-store`.
- **Riwayat:** satu snapshot pertama per `(raid_session_id, nopol)` (`ON CONFLICT DO NOTHING`), ditulis di `waitUntil` setelah revalidasi auth. `check_logs` immutable; baris lama (`source=CACHE`, `provider` NULL) tidak pernah ditulis ulang.
- **Provider** dibaca sekali di awal request bersama snapshot auth/raid; request berjalan selesai dengan provider awalnya. Setting hilang/invalid atau Potensi tanpa secret → `503 VEHICLE_SOURCE_UNAVAILABLE`. Tanpa fallback antar-provider, tanpa retry.
- **Setting sumber** append-only + CAS: versi baru wajib `max+1`, aktor ADMIN aktif, provider berubah; UPDATE/DELETE ditolak trigger. Konflik → `409`, kredensial Potensi belum ada → `422`. UI menolak replay otomatis saat hasil ambigu.
- **Adapter upstream:** endpoint tetap, `redirect: 'manual'`, body dibatasi, satu deadline untuk fetch + body (`worker/vehicle/transport.ts`). Potensi: 404 hanya NOT_FOUND jika envelope `vehicle_not_found`; 401/403 → `UPSTREAM_FORBIDDEN` (bukan logout Razia); null eksplisit pada nama/merek/tipe/warna sah, key hilang/tipe salah = malformed.
- **Parser ketat** di server dan klien (`src/lib/api.ts`): allowlist field, data tak valid → error, bukan NOT_FOUND. Hanya field yang perlu diproyeksikan; NIK, alamat, rangka/mesin, nominal tidak pernah keluar.
- **Keamanan:** CSRF same-origin + JSON untuk semua mutasi, body ≤ 4 KiB, setiap statement D1 mengikat sesi persis. Logger hanya event allowlist (`worker/logger.ts`), tanpa NOPOL/PII.
- **Migrasi** forward-only; jangan edit migrasi lama. Test memakai D1 nyata via Miniflare dan file migrasi asli.
- **Scanner:** NOPOL valid tepat 8 karakter langsung dicari dan input di-blur (keputusan user 2026-10-20); yang lebih pendek tetap Enter. Duplikat dicegah hanya selama loading. Pelat 9 karakter ikut terpicu di karakter ke-8.
- **UI:** Glassmorphism, notch sesi Scanner, footer di atas navigasi bawah dipertahankan. Navigasi bawah tetap lima tujuan; Pengaturan sumber data diakses dari halaman Admin (`/admin/settings`). Header Scanner sticky tanpa jarak atas. Teks UI berbahasa Indonesia.
- **Guard CI** (`scripts/ci-production.ts`): nama/tipe/ID resource/nilai var binding diperiksa persis; settings dan kandidat upload wajib tepat 9 binding (tiga `secret_text` Potensi: dua Access + `POTENSI_API_KEY`); versi aktif boleh masih baseline 8 binding (tanpa kunci) hanya untuk deploy yang memperkenalkan kunci. Tanpa flag bypass.

## Masalah yang sudah diselesaikan

- Fitur sumber data global BPAD/Potensi + penghapusan cache dirilis (commit `5d949ea`, migrasi `0005` di D1 produksi).
- Secret Potensi di-stage dengan `wrangler versions secret put` tanpa aktivasi dan terbukti terwariskan ke upload CI.
- Grant `razia-samsat` (scope `vehicle:read owner:read registration:read tax:read`) ditambahkan dan di-deploy di `api-potensi-ntt`.
- Potensi ditolak Access (401 Unauthorized): reusable policy "Razia SAMSAT - Service Auth" belum dipasang ke aplikasi Access "NJKB API - Private Vehicle Service Auth". Diperbaiki dengan menambahkannya ke aplikasi itu.
- Guard CI diperketat menjadi wajib 8 binding (`8a79991`).
- Gap atas Scanner dihapus dan pencarian otomatis 8 karakter dirilis (`a3dd33d`).
- Dry-run/deploy `api-potensi-ntt` butuh `NODE_OPTIONS=--max-old-space-size=6144` (Wrangler kehabisan memori tanpa itu).
- Halaman Access dashboard sering macet saat insiden Zero Trust; dashboard Workers tetap bisa dipakai untuk verifikasi.

## Pekerjaan terbuka

- **Kunci API Data Potensi (2026-10-23, belum commit/deploy):** buat kunci "Razia Samsat" (Pemilik, Registrasi, Pajak wajib) di website potensi-tarik → `wrangler versions secret put POTENSI_API_KEY` → commit/push → verifikasi "Terakhir dipakai". Rincian di `PROJECT_STATUS.md`.

- Verifikasi lalu lintas kalkulator pajak dan PINTU setelah deploy `api-potensi-ntt` (versi `cced787e…`; rollback ke `b2e9ec79…` bila perlu).
- Rotasi API token Cloudflare yang sempat terbaca dari `.env` di percakapan.
- Commit pembaruan `PROJECT_STATUS.md` (sengaja ditahan karena push = deploy).
- Uji kecepatan baru sebagian (n=20 per sumber, satu rentang waktu): Potensi median 951 ms vs BPAD 1052 ms, Potensi lebih stabil tetapi melewatkan 1 kendaraan. Perlu sampel di jam berbeda sebelum menetapkan sumber default.
- Opsional: tangani pelat 9 karakter pada pencarian otomatis; samakan perilaku header di halaman non-Scanner jika diminta.
- Rollback versi Razia hanya ke versi 8 binding (mis. `f33d0860…`, `df76de6e…`); versi pra-rilis `3f12f462…` akan ditolak guard.
