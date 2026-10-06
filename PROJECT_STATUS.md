# Project Status

## Project
Aplikasi Razia Kendaraan SAMSAT Kota Kupang (PWA). Spesifikasi utama: `docs/AI Product Blueprint - Aplikasi Razia Kendaraan SAMSAT Kota Kupang.md`.

## Current Phase
PHASE 0 — Repository & Blueprint Audit: SELESAI. Menunggu persetujuan user untuk PHASE 1 — Architecture & Data Foundation.

## Overall Status
Repository `D:\Herd\razia-samsat` kosong (hanya `docs/` dan file ini; bukan git repo). Audit arsitektur selesai dan direview. Belum ada kode. Phase 1 dinilai Code Reviewer: APPROVED WITH CHANGES (syarat di Next Step).

## Completed
- Inventaris repository & proyek referensi (AI Lead).
- Audit arsitektur Phase 0 (System Architect): usulan AD-01..AD-11, skema D1 draft, kontrak API draft, ambiguitas A0..A20, risiko.
- Review arsitektur Phase 0 (Code Reviewer): 1 Critical, 6 High, 6 Medium, 7 Low. Koreksi dimasukkan ke Architecture Decisions di bawah.

## In Progress
- Tidak ada. Menunggu keputusan user.

## Pending
- Keputusan user (lihat Next Step).
- Pengajuan dependensi provider njkb-api-ntt D1..D4 + sampel BPAD nyata (di luar repo ini; tidak dikerjakan agen).
- PHASE 1..8.

## Architecture Decisions
(Status: USULAN TERREVIEW — belum disetujui user. Item bertanda [PERLU PERSETUJUAN] menyimpang dari Blueprint.)
- AD-01 Integrasi: konsumsi Private API njkb-api-ntt `GET /api/v1/vehicle/{nopol}` sebagai principal baru `razia-samsat-kupang` (Cloudflare Access service token). Diakses lewat port `VehicleSource` (adapter `PrivateApiSource` + mock) agar Opsi B (BPAD langsung) tetap mungkin tanpa refactor. Dependensi provider: D1 respons eksplisit vehicle_not_found; D2 scope sempit `validity:read` (notice_valid_until + stnk_valid_until); D3 skip NJKB matching tanpa `njkb:read`; D4 onboarding + kuota + timeout BPAD per principal.
- AD-02 [PERLU PERSETUJUAN] Platform: satu Cloudflare Worker (Hono) + Workers Static Assets (SPA fallback, `run_worker_first: ["/api/*"]`), D1 + KV satu `wrangler.jsonc`. Blueprint menyebut Pages. Security header static asset via `_headers`.
- AD-03 [PERLU PERSETUJUAN] Sesi: opaque token 256-bit, SHA-256 hash di `user_sessions`, cookie `__Host-rs_sid` HttpOnly Secure SameSite=Strict, partial unique index satu sesi aktif (menggantikan `users.active_session_id`). Login kedua DITOLAK (FR-05) + idle/absolute timeout + admin revoke. Blueprint menyebut JWT. `is_active` dicek di setiap request (JOIN). Error UNIQUE constraint ⇒ 409, bukan 500. Tanpa `SESSION_REPLACED`; pakai `SESSION_REVOKED` + `revoke_reason`.
- AD-04 Password: PBKDF2-SHA256 100.000 iterasi (maksimum workerd), format berversi `pbkdf2-sha256$100000$salt$hash`, `timingSafeEqual`, dummy hash untuk username tak dikenal. Butuh Workers Paid (CPU).
- AD-05 CSRF: SameSite=Strict + `Origin` harus = origin env; bila `Origin` absen hanya terima `Sec-Fetch-Site: same-origin`; wajib `application/json`.
- AD-06 Lookup: `POST /api/vehicle-lookups` (NOPOL tidak di URL). Normalizer NOPOL = regex provider `^[A-Z]{1,2}[0-9]{1,4}[A-Z]{0,3}$`. Status `ACTIVE|EXPIRED|UNKNOWN` dihitung saat respons (WITA UTC+8, jam server). Null/invalid ⇒ UNKNOWN. Aturan hari H = konstanta kebijakan terparameter (default Blueprint `>=`).
- AD-07 KV: key `v1:vehicle:` + HMAC-SHA256(secret, nopol) (NOPOL tidak plaintext di key), value minimal (brand, type, color, category, tax_due_date, stnk_due_date, fetched_at) tanpa status, TTL 300s, `put` via `waitUntil`, error/timeout/429 tidak di-cache, NOT_FOUND tidak di-cache sampai semantik terverifikasi. Respons menyertakan `source: LIVE|CACHE` + `fetched_at`.
- AD-08 Riwayat: upsert `check_logs` per `(user_id, check_cycle_id)` hanya bila `raid_session_id` sama, sesi ACTIVE, dan `lookup_seq` lebih besar. Siklus baru hanya saat X / input kosong / "seal" (hasil tampil ≥N detik lalu input berubah) — final sebelum Phase 4. ERROR/TIMEOUT tidak masuk `check_logs`, hanya structured log tanpa PII.
- AD-09 [PERLU PERSETUJUAN] Naming DB Inggris: sesi_razia→raid_sessions, log_pengecekan→check_logs, lokasi→location, jalur→lane (INTEGER 1|2).
- AD-10 PWA: precache app shell saja; tanpa runtimeCaching `/api/*`; semua `/api/*` `Cache-Control: no-store`; tanpa CORS.
- AD-11 Test: vitest + Miniflare (pola `njkb-api-ntt/tests/support.ts`); oxlint; `tsc`.
- AD-12 Skema: FK `ON DELETE RESTRICT` (user tidak di-hard-delete); CHECK status memuat UNKNOWN; rekap punya bucket UNKNOWN; indeks: check_logs(raid_session_id, checked_at), check_logs(raid_session_id, tax_status, stnk_status), check_logs(user_id, checked_at), raid_sessions(user_id, started_at), user_sessions(user_id), user_sessions(absolute_expires_at), admin_audit_logs(created_at). Migrasi tanpa BEGIN/COMMIT. Tanpa read replication untuk query auth.
- AD-13 Error model & mapping upstream: envelope `{error:{code,message,request_id,retryable}}`. Provider 401/403/3xx/non-JSON ⇒ `UPSTREAM_ERROR` 502 (BUKAN UNAUTHENTICATED); provider 429 ⇒ `UPSTREAM_BUSY` 503 + Retry-After (BUKAN RATE_LIMITED user); 503/500 ⇒ `UPSTREAM_ERROR`; 504/abort ⇒ `UPSTREAM_TIMEOUT`; 400 invalid_nopol ⇒ `INVALID_INPUT`. 502 TIDAK PERNAH dipetakan ke NOT_FOUND. `fetch` dengan `redirect:'manual'`, tanpa auto-retry. Timeout konsumen 3000 ms.
- AD-14 Logging: tidak pernah me-log NOPOL, token, cookie, password, atau body provider/BPAD.

## Known Issues
- Repository kosong; seluruh scaffolding harus dibuat.
- Private API tidak punya respons vehicle not found: not-found BPAD ⇒ 502 (atau 504 bila lambat). Timeout 504, D1 NJKB 503, internal 500 (`njkb-api-ntt/src/private-api/http.ts:15-28`, `contracts.ts:5`, `src/bpad/adapter.ts:83-86`).
- Semantik not-found BPAD TIDAK TERVERIFIKASI (hanya mock `njkb-api-ntt/scripts/mock-bpad.ts:21`).
- Format mentah SD_NOTICE/SD_STNK produksi TIDAK TERVERIFIKASI; normalizer provider hanya menerima `YYYY-MM-DD`.
- `SD_STNK` hanya tersedia lewat scope `registration:read` yang juga membuka NoRangka/NoMesin/NoBPKB/NOPOL_EKS; `tax:read` membuka kohir. Matrix onboarding provider melarang `registration:read` untuk pengecekan masa pajak (`docs/security/private-api-consumer-onboarding.md:107`).
- Timeout provider→BPAD 5000 ms + 1 retry > timeout konsumen 3000 ms.
- Blueprint menyebut "API Key BPAD" — tidak ada (`adapter.ts:75`).
- Kontrak drift di kalkulator-pajak (mapper mengharapkan `vehicle_status:'not_found'`) — di luar scope, hanya dicatat.
- Dokumen draft kedua `D:\Herd\native-academy\monitor-pajak-kendaraan-razia.md` ("NOT FOR IMPLEMENTATION") berisi keputusan bertentangan dengan Blueprint (D-016 hari H masih berlaku, D-018 admin dikecualikan single-session, D-019/D-024 nama pemilik, D-020/D-034 not-found tidak dicatat, D-033/D-038 penugasan admin, D-039 ekspor, D-021/D-042 retensi).
- Agent `code-reviewer` global dikonfigurasi dengan model `9router/code-reviewer` yang tidak tersedia; review dijalankan dengan override model sesi.

## Risks
- CRITICAL C-1: "Data Tidak Ditemukan" (Blueprint FR) tidak dapat dipenuhi via Private API tanpa D1 provider. Blok keluar Phase 3 & rilis.
- HIGH H-1: Status STNK butuh scope yang melanggar BR-03 sampai D2 tersedia.
- HIGH H-2: Salah mapping error provider dapat memicu logout palsu / salah atribusi rate limit (mitigasi AD-13).
- HIGH H-3: Heuristik siklus pengecekan dapat menggabungkan dua kendaraan atau mencatat NOPOL salah ketik (mitigasi AD-08).
- HIGH H-4: Enumerasi username, DoS lockout (petugas berbagi IP CGNAT), session fixation (mitigasi Phase 2: respons seragam, throttle progresif, rotasi sesi).
- HIGH H-5: Aturan hari H jatuh tempo (`>=` Blueprint vs `>` D-016; "SD" = "sampai dengan").
- HIGH H-6: PBKDF2 vs batas CPU Workers Free; plan belum diketahui.
- MEDIUM: rantai timeout; single point of failure + kuota bersama provider; nonaktif akun harus revoke sesi + tutup raid session; kuota write KV; kebijakan CSRF; raid session tanpa auto-close; bootstrap/break-glass admin; retensi.
- LOW: `__Host-` cookie di localhost Safari; header static assets; collation NOCASE ASCII; idle timeout efektif ±5 menit; D1 read replication; migrasi tanpa transaksi eksplisit.

## Validation Status
- Phase 0 — Code Review arsitektur (read-only, tanpa eksekusi): CHANGES REQUIRED pada usulan awal (sudah diintegrasikan sebagai AD-12..AD-14 dan koreksi AD-01..AD-08); Phase 1: APPROVED WITH CHANGES.
  - Klaim terverifikasi: tidak ada not-found; scope luas membuka field sensitif; matcher + audit D1 selalu jalan untuk kendaraan ditemukan (`composition.ts:37`); rate limit in-memory per isolate (`rate-limit.ts:10`); tanpa API key BPAD.
  - Koreksi: "semua jadi 502" berlebihan (504/503/500 juga mungkin).
  - Disetujui: opaque session; `db.batch` atomik + partial unique index aman dari race; POST lookup; no-store/tanpa CORS; UNKNOWN≠ACTIVE; cache menyimpan tanggal.
- Belum ada build/test/lint (belum ada kode).

## Files / Modules Changed
- `PROJECT_STATUS.md` (dibuat/diperbarui). Tidak ada file lain.

## Next Step
A. WAJIB sebelum Phase 1 (keputusan user):
  1. Setujui AD-02 (Worker + Static Assets, bukan Pages), AD-03 (opaque session, bukan JWT), AD-09 (naming Inggris).
  2. A0: tetapkan Blueprint sebagai Single Source of Truth; dokumen native-academy hanya referensi.
B. Isi Phase 1 setelah disetujui (Backend Engineer; tanpa fitur bisnis):
  scaffold single-package (Vite + React 19 + Tailwind 4 + shadcn forced light; Hono Worker; wrangler.jsonc dengan D1 `DB`, KV `VEHICLE_CACHE`, assets); `migrations/0001_init.sql` sesuai AD-12; `src/shared` (error catalog AD-13, NOPOL normalizer, util WITA, modul status terparameter, kontrak zod); port `VehicleSource` + mock provider (200/400/401/403/429/502/503/504/HTML/302); middleware request-id/security headers/onError/envelope; `/api/health`; modul logging aman; `.dev.vars` gitignore + dokumentasi secret; test harness vitest+Miniflare + unit test status/WITA/NOPOL/error mapping.
C. Paralel (user/pemilik provider): ajukan D1..D4 + sampel respons BPAD (ditemukan, tidak ditemukan, format tanggal); konfirmasi plan Cloudflare.
D. Gate fase berikut: Phase 2 ⇐ Workers Paid + desain login H-4; Phase 3 ⇐ D1..D4 + sampel BPAD + keputusan A1; Phase 4 ⇐ heuristik siklus final; Phase 5/6 ⇐ A11/A17/A3/A15/A16 + auto-close raid session + break-glass admin.

Keputusan user terbuka: A0, A1 (hari H), A3 (admin single-session), A9 (nama pemilik), A11 (log NOT_FOUND), A15 (penugasan), A16 (ekspor), A17 (retensi), A19 (interim scope luas — direkomendasikan DITOLAK), A20 (idle/absolute timeout, usulan 4 jam/16 jam).

## Agent Handoff Notes
- Ikuti urutan fase user: 1 Foundation, 2 Auth & Raid Session, 3 Scanner Backend, 4 Scanner Frontend, 5 History & Recap, 6 Admin, 7 PWA & Hardening, 8 Full Review.
- Proyek referensi READ-ONLY (JANGAN diubah):
  - `D:\Herd\kalkulator-pajak` — React 19 + Vite 8 + Tailwind 4 + shadcn (Radix) + vite-plugin-pwa, tanpa router, backend Pages Functions. Reusable: `src/components/ui/*`, `lib/utils.ts`, hooks `use-debounce`, `use-online-status`, `use-pwa`, `pwa-install-prompt.tsx`, `pwa-update-notice.tsx`. JANGAN tiru: runtimeCaching `/api/njkb/` 7 hari (`vite.config.ts:57-73`), `Access-Control-Allow-Origin: *`, `Cache-Control: public` data kendaraan, normalisasi NOPOL 4–12, query `?source=`.
  - `D:\Herd\njkb-api-ntt` — Worker + Hono 4.13 + D1 + zod 4 + vitest 3 (Miniflare). Adapter BPAD `src/bpad/adapter.ts`, field list `src/bpad/types.ts`, sensitivitas `src/bpad/field-policy.ts` (NOPOL = PERSONAL_DATA), Private API `docs/private-api.md`, `docs/openapi-private.json`, onboarding `docs/security/private-api-consumer-onboarding.md`, security headers `src/index.ts:76-83`, test support `tests/support.ts`.
- Tabel D1 target: users, user_sessions, raid_sessions, check_logs, admin_audit_logs (lihat AD-03/AD-08/AD-12).
- Field kendaraan yang boleh ditampilkan/di-cache: brand, type, color, category, tax due date, STNK due date. DILARANG: NamaPemilik, NoKTP, Alamat, NoRangka, NoMesin, NoBPKB, NOPOL_EKS, Kohir, dan raw payload.
