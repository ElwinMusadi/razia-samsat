# Operasi produksi SAMSAT

## Status dan batas persiapan

Dokumen ini adalah runbook operator, bukan bukti deployment atau izin membuat resource sekarang. Phase7 baru dipersiapkan lokal. Phase5 transport historis tetap belum PASS. Tidak ada kontak live BPAD, provisioning, deploy, migrasi remote, bootstrap remote, atau canary yang dilakukan dalam persiapan ini.

| Komponen | Persiapan | Verifikasi produksi |
| --- | --- | --- |
| Guard konfigurasi dan perintah operator | Tersedia lokal; hasil tests dicatat di PROJECT_STATUS.md | Belum |
| Akun `04b8b2073be2f1aa21fc6489e0db36f6` | Inventaris read-only AI Lead | Resource aplikasi belum dibuat |
| Worker `razia-samsat-production` | Nama usulan, bukan resource terkonfirmasi | BLOCKED |
| D1 `razia-samsat-production-db` | Nama usulan; tidak ada ID aktual | BLOCKED |
| KV `razia-samsat-production-vehicle-cache` | Nama usulan; namespace inventory kosong | BLOCKED |
| Domain, zone, TLS | Belum dipilih | BLOCKED |
| ADMIN pertama, lokasi awal | Input operator aman belum tersedia | BLOCKED |
| Dua NOPOL canary | Harus dipilih dan disetujui operator | BLOCKED |
| CPU Workers Free, Android aktual | Belum diukur/diuji | BLOCKED |

DB `sip-ikp-d1`, `njkb-api-production`, dan `kalkulator-pajak-db` tidak terkait aplikasi ini. Jangan menggunakan, menyalin, mengubah, atau mengimpor DB tersebut. Jangan mengisi ID tebakan atau membuat domain contoh seolah target nyata.

## Konfigurasi operator

1. Selesaikan pemilihan endpoint, persetujuan resource khusus, dan kebutuhan privasi. Helper ini hanya mendukung satu **custom domain** pada zone aktif dalam akun yang sama. `workers.dev`, wildcard routes, environment bertingkat, binding tambahan, dan parameter CLI bebas sengaja tidak didukung.
2. Jalankan `npm run production:prepare`. Ini menyalin contoh ke `wrangler.production.jsonc` di root proyek, menolak overwrite, tanpa jaringan. File operator dan `backups/` di-ignore Git. Contoh sengaja tidak valid: jangan deploy contoh langsung.
3. Isi account ID yang sudah terinventaris di atas, UUID D1 aktual, ID namespace KV aktual, hostname custom domain nyata, dan `zone_id` aktual. Semua path tetap relatif terhadap root proyek: `worker/index.ts`, `./dist`, `migrations`.
4. Jalankan `npm run production:check`. Hanya memeriksa konfigurasi lokal. Guard menolak sentinel, nama berbeda, `remote:false`, UUID/namespace invalid, bindings/fields tidak dikenal, baseline berbeda, serta konfigurasi endpoint/telemetry tidak aman. Field `remote` bila diisi harus `true`; field tersebut mengatur local development, bukan pengganti flag `--remote`. Jangan memakai konfigurasi production untuk `wrangler dev`.
5. Jalankan gates lokal yang dimiliki AI Lead, lalu `npm run build` dan `npm run production:dryrun`. Dry-run hanya bundling lokal; tidak membuktikan resource, TLS, autentikasi, CPU, atau canary produksi.

Baseline wajib **tepat** `PASSWORD_PBKDF2_ITERATIONS="100000"`, `SESSION_TTL_SECONDS="43200"`, `RETENTION_POLICY="UNSET"`. Bukan nilai minimum. Tidak menambah rate-limit, minimum password delapan karakter, idle timeout, paid service, atau parameter CPU baru.

## Verifikasi resource dan konfirmasi mutasi

Setiap operasi remote harus menyertakan empat flag nilai yang cocok persis dengan konfigurasi operator:

```text
--confirm-account <actual-account-id>
--confirm-database <actual-database-uuid>
--confirm-worker razia-samsat-production
--confirm-origin https://<approved-hostname>
```

`npm run production:verify -- <empat flag>` menjalankan `whoami --json`, `d1 list --json`, dan `kv namespace list` melalui Wrangler terpasang. ID dan nama harus berpasangan tepat, unik, serta sudah ada. Inventaris kosong, resource salah, autentikasi gagal, dan JSON ambigu menolak operasi. Helper tidak membuat resource atau login ulang. Token disediakan melalui process environment operator aman; tidak melalui argv, chat, source, atau file yang di-commit. Helper tidak membaca file OAuth sendiri dan tidak mencetak token, email, raw stdout/stderr, atau payload API.

Nama bukan bukti Worker existing aman ditimpa. Helper memeriksa `deployments list --name razia-samsat-production --json`, memilih timestamp `created_on` terbaru yang valid dan tidak ambigu, lalu mengharuskan satu versi aktif dengan traffic100%. Operator meninjau source, binding, pemilik, deployment aktif, dan perubahan remote sebelum memberi **kedua** flag `--confirm-deployment <active-deployment-id>` dan `--confirm-version <active-version-id>`. Upload versi terbaru yang belum deployed tidak menjadi otorisasi. Deployment gradual/multi-version, timestamp sama, JSON tidak valid, serta daftar kosong ditolak. Worker baru hanya diterima bila API Wrangler menghasilkan kode not-found tepat `10007` dan operator memberikan `--confirm-new-worker razia-samsat-production` tanpa flag deployment/version existing; 403/network/hasil kosong bukan izin membuat Worker.

Deployment juga memeriksa metadata zone, custom domains, DNS exact hostname, dan route zone Cloudflare read-only. Ini memerlukan `CLOUDFLARE_API_TOKEN` dari kanal aman dengan akses baca metadata zone/Worker/DNS yang sesuai dan akses mutasi yang memang disetujui. Jangan memperluas permission global atau menyimpan token. Zone harus aktif dan account/hostname cocok; domain yang terikat service/zone lain ditolak.

- DNS memakai filter terdokumentasi `name.exact=<encoded-hostname>`, `page=1`, `per_page=100`. Envelope `result` dan `result_info` harus konsisten: page pertama lengkap, counts sesuai, tanpa halaman lanjutan. Daftar terpotong, metadata hilang/ambigu, duplicate records, atau nama hasil tidak cocok menolak deployment; helper tidak menganggap halaman pertama kosong sebagai bukti bebas collision.
- Untuk hostname **belum terikat** exact Worker/zone ini, seluruh existing DNS bernama sama ditolak, termasuk A/AAAA/CNAME. `--confirm-dns-record` tidak dapat mengizinkan pengambilalihan DNS aplikasi lain. Helper tidak menghapus atau menimpa record collision.
- Redeploy hostname yang **sudah terikat exact Worker/zone** dapat diterima hanya dengan paling banyak satu record proxied A/AAAA, ID aktual ditinjau lewat `--confirm-dns-record <reviewed-record-id>`, dan konfirmasi deployment/version aktif. Ini bukan klaim tipe/content record membuktikan ownership; binding exact dan review operator wajib bersama. CNAME, record tambahan, atau konfigurasi ambigu memerlukan rekonsiliasi operator terpisah.
- Route Worker aktif dengan pola exact/wildcard yang mencakup hostname ditolak, termasuk route milik Worker yang sama; helper khusus custom domain, bukan pengubah route existing.
- Semua deploy wajib `--confirm-hostname-review https://<approved-hostname>` setelah operator meninjau wildcard DNS, delegasi/subdomain, catch-all/proxy/redirect, Pages/aplikasi lain, serta kepemilikan endpoint. Tidak adanya exact DNS record **bukan** bukti hostname tidak dipakai. Helper tidak melakukan audit DNS wildcard/delegasi menyeluruh atau membuktikan TLS siap.

Metadata remote dapat berubah setelah pemeriksaan; helper bukan lock platform. Deploy custom domain dapat membuat DNS/certificate Cloudflare, sehingga seluruh peninjauan endpoint harus selesai sebelum mutasi disetujui.

## Urutan migrasi, bootstrap, deployment

Urutan berikut hanya dijalankan operator setelah blockers diatasi dan deployment/canary disetujui. Jangan menyalin DB lokal atau fixture sintetis menjadi data produksi.

1. Catat commit sumber yang ditinjau, versi Worker existing bila ada, metadata account/D1/KV/zone, serta gates lokal aktual. Periksa source canary dan schema kompatibel. Target Workers Free tetap.
2. Ambil backup D1 terproteksi sebelum migrasi pada DB existing. Dengan target yang diverifikasi, command installed Wrangler adalah `npx wrangler d1 export DB --remote --config wrangler.production.jsonc --output backups/<approved-backup-name>.sql`. Siapkan direktori ignored dengan ACL operator; export berisi credential hash, history/NOPOL, dan metadata pengguna. Jangan tampilkan isi, kirim ke chat, atau commit. Perlindungan ACL Windows harus diperiksa; mode POSIX bukan jaminan ACL Windows. Restore memerlukan persetujuan terpisah; tidak ada rollback DB otomatis.
3. `npm run production:migrate -- <empat flag>`. Helper memverifikasi account dan resource sebelum `d1 migrations apply DB --remote`. Installed command ini tidak mempunyai `--yes`; helper tidak menambah flag tidak valid. stdin child di-ignore sehingga Wrangler memakai konfirmasi noninteraktif existing; empat konfirmasi target helper tetap wajib sebelum command tersebut. Migrasi `0001` sampai `0003` tetap forward, tidak dimodifikasi. Wrangler rollback hanya migrasi yang gagal; migrasi sebelumnya dapat tetap applied. Jangan menganggap keseluruhan urutan satu transaksi. Periksa migration list, enam tabel, indexes/trigger yang disyaratkan, dan `PRAGMA foreign_key_check` read-only pada DB terkonfirmasi. Duplicate history akan membuat migration0002 gagal tanpa menghapus data.
4. `npm run production:bootstrap -- <empat flag> --username <approved-first-admin>`. Password dibaca melalui stdin existing (terminal tanpa echo dan konfirmasi, atau pipe aman), non-empty/maks1024 byte UTF-8, tanpa normalisasi atau minimum baru. Hash PBKDF2 100000 dengan salt acak. Tidak ada role flag; hanya ADMIN pertama.
5. Tabel `users` harus kosong **seluruhnya**, bukan sekadar tidak ada ADMIN aktif. Bahkan satu OFFICER/inactive user menolak bootstrap. Gunakan jalur admin existing untuk akun berikutnya; tidak ada endpoint bootstrap/master password.
6. Trigger sementara `production_bootstrap_<uuid-without-hyphens>` dipasang khusus UUID, username, role ADMIN aktif pertama, dan count users=1. Satu `INSERT ... SELECT ... WHERE NOT EXISTS(users)` memicu audit `USER_CREATED` dengan actor/target user baru. **INSERT user dan audit atomik** karena trigger AFTER INSERT; audit gagal membatalkan user. CREATE trigger dan DROP terpisah, bukan satu transaksi CLI file SQL. Tidak menggunakan `BEGIN/COMMIT` manual.
7. Helper memeriksa counts total/intended/audit tanpa memilih hash, lalu DROP hanya nama trigger nonce tersebut dalam finally. SQL disimpan di file sementara acak mode0600 dan dihapus finally; raw output dan debug log Wrangler diisolasi/disingkirkan. Tidak mencetak SQL/hash/password. Jika proses terputus, direktori temp yang tertinggal juga sensitif dan perlu dibersihkan operator dengan ACL tepat.
8. Jika CREATE/INSERT/check/DROP gagal atau hasil ambigu, **jangan mengulang bootstrap buta**. Baca metadata user/audit tanpa hash. User berhasil tidak dihapus demi retry. Trigger residual tidak dapat membuat user dan hanya mengaudit UUID intended tersebut; tidak mengaudit semua INSERT users. Cleanup manual dengan DB/account yang kembali terverifikasi dan persetujuan operator: periksa `sqlite_master` untuk nama nonce yang dilaporkan, cocokkan definisi/UUID, kemudian DROP **hanya nama tersebut**. Jangan drop semua trigger atau menghapus audit/user. Retry menolak DB nonempty.
9. Lokasi awal harus berasal dari input organisasi yang disetujui. Helper tidak men-seed lokasi produksi dan script `bootstrap:location` tetap LOCAL. Setup lokasi produksi memerlukan tindakan operator terpisah yang ditinjau; jangan mengarang nama, fixture, atau endpoint baru.
10. `npm run production:deploy -- <empat flag> --confirm-hostname-review https://<approved-hostname> --confirm-new-worker razia-samsat-production` untuk target baru yang benar-benar not-found. Untuk existing, ganti flag new-worker dengan `--confirm-deployment <reviewed-active-deployment-id> --confirm-version <reviewed-active-version-id>`, serta `--confirm-dns-record <reviewed-record-id>` bila satu DNS existing yang diizinkan hadir. Helper memakai `deploy --strict --autoconfig=false`; tidak provisioning resource otomatis, tidak menyisipkan secret file, tidak mengubah source/runtime. Catat versi aktual dan lakukan canary manual sebelum menyatakan siap produksi.

## Canary terbatas dan keamanan

Canary hanya dua NOPOL yang dipilih operator, bukan contoh nyata historis, nomor buatan agen, enumerasi prefix, atau fixture synthetic yang dianggap kendaraan produksi. Gunakan browser pada origin TLS yang disetujui. Catat metrics/status/request ID tanpa NOPOL, pemilik, raw payload, cookie, password, token, atau SQL hash.

- Pastikan cookie `__Host-rs_session`, `Path=/`, `HttpOnly`, `Secure`, `SameSite=Strict`, expiry absolut43200; jangan menyalin value cookie ke evidence.
- Pastikan API JSON/no-store/X-Request-ID dan headers keamanan tetap; `/api`, `/api/*` yang tidak dikenal tidak menjadi SPA. CSRF origin asing ditolak403, tanpa menambahkan CORS. TLS/redirect/certificate diverifikasi browser aktual.
- Uji ADMIN dan OFFICER, ownership raid/history, OFFICER single active session, logout/revoke/expiry/deactivation, password reset merevoke semua sesi termasuk self, admin403 tanpa logout, data/history tidak dihapus. Gunakan akun operator yang disetujui, bukan seed tambahan spekulatif.
- Pastikan LIVE/CACHE/fetched_at/status WITA, TTL KV300, found/not-found/error berbeda, timeout BPAD3000ms. History D5-01 pertama unik raid+nopol immutable; lookup ulang tidak menambah/mengubah snapshot. D5-02 snapshot terotorisasi tetap eligible saat logout/raid close setelah final guard; waitUntil best-effort bukan durable delivery.
- Ukur CPU aktual melalui dashboard/metrics Cloudflare pada login valid, salah, dan lookup yang disetujui. Workers Free **10ms CPU/request**; latency/wall time termasuk I/O bukan CPU. Tidak menyimpulkan PBKDF2 kompatibel dari tests lokal atau stopwatch. Bila CPU tidak lolos, hentikan rollout dan minta keputusan; jangan menurunkan100000 atau menaikkan limit/plan diam-diam.
- Android instalasi, keyboard, 320px, safe-area, network interruption dan update PWA tetap gate manual; jsdom/build bukan bukti visual perangkat. PWA tidak boleh cache API/data kendaraan atau memberi hasil offline palsu.

## Privasi, observability, retensi

`owner_name` **saat ini disimpan di normalized KV cache dan ditampilkan UI**, sesuai keputusan eksplisit Phase3. Ini tetap PII; key hashed adalah pseudonymization, bukan encryption. History tidak menyimpan owner_name. Jika larangan Phase7 tentang informasi sensitif pemilik juga dimaksudkan melarang nama di KV, diperlukan klarifikasi keputusan sebelum deployment. Jangan menyatakan cache bebas PII atau diam-diam strip field/mengubah kontrak. NIK, alamat, chassis, engine, BPKB, dan raw BPAD tidak boleh disimpan/log.

Contoh production memakai Workers Logs console-only (`enabled:true`, `logs.enabled:true`, `invocation_logs:false`, `traces.enabled:false`). Safe logger hanya allowlisted event/request_id/code; tidak URL/query/header/payload/user/IP. Review kode dan sink sebelum mengaktifkan produksi; jangan memakai raw `wrangler tail` atau invocation/subrequest telemetry sebagai jalan pintas. Cloudflare Free Logs menurut dokumentasi yang ditinjau AI Lead:200000 events/hari, retensi3 hari saat ini; pricing berubah1Desember, wajib ditinjau ulang. Monitor agregat auth failure, upstream/timeouts, cache/history write failures, D1/KV quota dan CPU tanpa payload. Konfigurasi ini bukan bukti monitoring produksi telah diuji.

`RETENTION_POLICY=UNSET` dan tidak ada purge otomatis. Tidak menetapkan periode organisasi atau unlimited retention secara implisit. Backup/debug log sementara mengikuti kebijakan proteksi/retensi organisasi; kebijakan permanen masih terbuka.

## Pemulihan darurat

1. Hentikan operasi/canary ketika ada akses tidak sah, data tercampur, CPU/quota failure, atau audit ambigu. Simpan evidence metadata teredaksi.
2. Verifikasi account/config/Worker/version kembali. Installed CLI: `npx wrangler deployments list --config wrangler.production.jsonc --json`, `npx wrangler versions list --config wrangler.production.jsonc --json`, kemudian rollback versi aman yang ditinjau: `npx wrangler rollback <approved-version-id> --config wrangler.production.jsonc --message "Pemulihan operasional disetujui"`. Ini mutasi operator dengan persetujuan; bukan tindakan otomatis helper.
3. Rollback Worker tidak memulihkan D1/KV, secrets/data/binding dependency, atau schema. Versi lama harus kompatibel dengan schema/bindings saat ini; jangan rollback kode yang memerlukan trigger lama atau membuang history. Bila rollback tidak tersedia/kompatibel, redeploy commit versi aman yang ditinjau dengan guard existing-version. Jangan restore backup tanpa persetujuan/penilaian kehilangan data.
4. Untuk penghentian layanan penuh, operator dapat menonaktifkan **hanya custom domain/route target yang terverifikasi** melalui Cloudflare dengan persetujuan. Ini memutus semua akses, bukan runtime feature flag baru. Jangan menyentuh routes aplikasi lain atau hapus DB/KV.
5. ADMIN yang masih sah dapat revoke sesi melalui `/api/admin/users/:id/sessions/revoke` dan menonaktifkan akun melalui `/api/admin/users/:id/deactivate` sesuai CSRF/auth existing. Self-deactivation tetap ditolak. Metadata/audit/history dipertahankan; tidak hard-delete record. Jika tak ada akses ADMIN, recovery operator adalah insiden terpisah, bukan bootstrap kedua/backdoor.

## Referensi dan checklist keputusan

Dokumentasi/CLI ditinjau dalam Phase7; cocokkan kembali dengan versi Wrangler terpasang sebelum mutasi:
- https://developers.cloudflare.com/workers/wrangler/commands/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/d1/wrangler-commands/
- https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- https://developers.cloudflare.com/kv/platform/limits/
- https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/

## Hasil persiapan lokal dan checklist readiness

Hasil AI Lead 2026-10-08: full regression **28 files/1075 tests PASS**, 103,16 detik; typecheck/lint/build, migration lokal, FK check, audit full/produksi dan Wrangler dry-run PASS. Bootstrap diuji D1/workerd lokal sintetis, bukan akun produksi. Review guard setelah perbaikan DNS/deployment aktif PASS WITH NOTES; PWA PASS WITH NOTES terkait ketergantungan clean URL, sudah diverifikasi pada Workers Static Assets lokal.

| Area | Selesai pada persiapan lokal | Belum diverifikasi pada produksi |
| --- | --- | --- |
| Infrastruktur | Template invalid, guard account/resource/domain, bindings dan baseline | IDs khusus, custom domain, zone/DNS, TLS, Worker deployed |
| Aplikasi | Regresi auth/role, raid, lookup, dedup/history, admin, bootstrap atomik sintetis | Login ADMIN/OFFICER, CPU100000, cookie/logout/revoke/reset, raid/history canary |
| Keamanan | CSRF, headers lokal, minimization, secret exclusion, safe logger, collision guards | Headers/TLS/error disclosure dan sink log deployed, kebijakan nama pemilik di KV |
| Operasi | Bootstrap satu kali, runbook migrasi/rollback/emergency, no auto purge | ADMIN pertama/lokasi awal, backup/recovery aktual dan retention organisasi |
| Mobile/PWA | Manifest/PNG192512, SW cache5asetpublik, Chrome headless viewport320 tanpa overflow dan tombol44px | Android instalasi fisik, keyboard/safe-area/outdoor, alur terautentikasi perangkat |
| Deployment | Bundling Worker dry-run120,78KiB/gzip30,19KiB, assets12files | Deployment/canary terbatas dan versi sebelumnya untuk rollback |

Smoke Chrome memakai profile temporary terisolasi pada HTTP loopback, tanpa password/data kendaraan. Cache SW hanya `/offline`, `/offline.css`, manifest dan dua ikon; tidak app JS, network HTML, API atau data operasional. Ini bukan authenticated E2E, HTTPS production, atau Android real-device validation.

D1 Time Travel mempunyai batas **7 hari pada Free Plan** menurut dokumentasi; restore merupakan operasi destructive yang menimpa database dan membatalkan query berjalan. Tidak ada restore otomatis. Worker rollback tidak mengembalikan data DB/KV. Ambil bookmark/backup terproteksi dan persetujuan insiden sebelum mempertimbangkan pemulihan data.

Status persiapan: **PHASE 7 COMPLETE — PRODUCTION READINESS PREPARED, DEPLOYMENT BLOCKED**. Ini **NOT PRODUCTION READY**. Blockers domain/resource/input operator/canary/CPU/perangkat/kebijakan KV tidak terbuka otomatis karena tests lokal PASS. Phase5 transport historis tetap terdokumentasi, bukan diklaim terselesaikan.
