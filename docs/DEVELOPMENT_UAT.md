# Development dan UAT lokal

## Batas penggunaan

Lingkungan ini hanya untuk development/UAT pada komputer lokal. Data kendaraan merupakan simulasi dengan nama pemilik/merek/tipe/warna sintetik, bukan rekaman BPAD. Tidak melakukan request BPAD langsung atau fallback ke provider produksi. Tidak untuk deploy, provisioning, migrasi remote, bootstrap produksi, atau pengujian akun produksi.

Entry `worker/dev-index.ts` hanya menerima origin HTTP/HTTPS dengan hostname exact `localhost`, `127.0.0.1`, atau `[::1]` dan marker server `APP_ENV=development`. Permintaan lain ditolak503 sebelum API maupun assets. Host/forwarding header bukan bukti server lokal; launcher mengikat listener ke127.0.0.1. Konfigurasi development menggunakan `run_worker_first=true`, bindings `remote=false`, ID sentinel terpisah, dan persistence `.wrangler/dev-uat`. Entry produksi tetap `worker/index.ts` dengan BPAD, tanpa import simulator/credential development; validator produksi menolak entry/vars/bindings development.

## Menjalankan

```sh
npm run dev
```

Perintah memvalidasi konfigurasi lokal tetap, memeriksa direktori fisik state, menerapkan semua migration existing secara berurutan lewat Wrangler LOCAL, seed idempotent, menyelesaikan build awal, lalu menjalankan build-watch dan Wrangler LOCAL. Buka **http://127.0.0.1:8787**. API dan SPA berada pada origin yang sama; tidak memakai proxy Vite atau browser mock. Build development memberi `VITE_APP_MODE=development` untuk banner simulasi non-PII; marker ini hanya tampilan, bukan pemilih provider. Build produksi normal tidak memberi marker tersebut.

Launcher development menulis `dist` bersama dengan build produksi. Sebelum dry-run/deployment produksi, hentikan launcher development/build-watch agar tidak ada penulis aset paralel. Helper operator `production:dryrun` dan `production:deploy` selalu menjalankan typecheck existing serta rebuild Vite modeproduction dengan child environment `VITE_APP_MODE=production`/`NODE_ENV=production`, menimpa marker development shell/dotenv tanpa mengubah environment parent. Build gagal menghentikan Wrangler sebelum inventory/mutasi remote. Jangan menggunakan `dist` hasil development sebagai aset produksi; `npm run build` biasa tetap memerlukan shell/env normal bila dijalankan langsung. Raw `npx wrangler deploy` melewati guard helper dan bukan alur operator yang didukung. Rebuild ini mencegah banner simulasi tersisa; pemilihan provider tetap hanya entry Worker, bukan marker browser.

Perintah migration/seed menahan kedua stream CLI, memaksa log error/sanitasi/metricsfalse, mengarahkan debug log Wrangler ke direktori sementara unik, lalu menghapusnya dalam `finally` termasuk ketika CLI gagal. Tidak meneruskan SQL/hash/raw error ke terminal atau direktori log global. Kegagalan cleanup menghentikan persiapan UAT dengan pesan generik.

Cookie opaque HttpOnly/Secure/SameSite=Strict tetap sesuai aplikasi. Browser Chromium memperlakukan loopback sebagai origin terpercaya; jangan menghapus atribut Secure untuk UAT. Gunakan alamat loopback yang sama secara konsisten. Tidak membuka listener ke jaringan/LAN, tidak melakukan port forwarding/tunnel.

## Akun yang diizinkan khusus lokal

| Username | Password development | Role tersimpan |
| --- | --- | --- |
| `elwinbessiesura` | `password` | `ADMIN` |
| `yusuf.adoe` | `password` | `OFFICER` |

ADMIN juga dapat menjalankan alur petugas sesuai otorisasi existing; tidak ada role gabungan baru. OFFICER tetap satu sesi aktif dan ADMIN multi-session. Password ini secara eksplisit diizinkan user untuk seed/docs lokal saja, tidak berada dalam client atau Worker produksi, dan ditolak oleh bootstrap operator produksi. Hash memakai PBKDF2-SHA256100000 dengan salt acak; TTL43200 tetap.

Lokasi baseline: **UAT — Titik Pemeriksaan**. Jalur tetap teks bebas sesuai kontrak produk. Tidak dibuat raid/history/sesi login otomatis; lakukan login dan buka sesi melalui UI asli.

## Seed ulang dan reset

```sh
npm run dev:seed
```

Seed tidak menimpa username existing, ID, role, password, aktivitas akun, nama/aktivitas lokasi, sesi, audit, raid atau history. Akun existing dengan ID berbeda tetap dipertahankan berdasarkan username; collision ID milik username lain gagal eksplisit. Lokasi existing bernama sama tidak ditambah atau diaktifkan diam-diam. Password akun yang sudah diubah tetap berlaku. Seed pertama yang terputus dapat dilanjutkan tanpa menghapus data.

**Reset menghapus seluruh DB, KV/cache dan state UAT lokal. Hentikan `npm run dev` terlebih dahulu.**

```sh
npm run dev:reset -- --confirm-reset
```

Tanpa konfirmasi exact perintah ditolak. Reset hanya direktori fisik `.wrangler/dev-uat` pada root repository tetap; symlink/junction pada root/ancestor/descendant ditolak. Tidak menerima path/config/resource dari operator, tidak menyentuh `.wrangler/state`, state produksi atau data di luar repository. Sesudah penghapusan, migration+seed memulihkan baseline. Pemeriksaan filesystem merupakan snapshot, bukan jaminan terhadap aktor lokal yang mengganti path secara bersamaan.

## Empat skenario kanonik

| NOPOL | Outcome | Pajak | STNK |
| --- | --- | --- | --- |
| `DH1823HJ` | FOUND | ACTIVE / AKTIF | ACTIVE / AKTIF |
| `DH7112DP` | FOUND | EXPIRED / MATI | UNKNOWN / TIDAK DAPAT DITENTUKAN |
| `DH5871GD` | FOUND | EXPIRED / MATI | EXPIRED / MATI |
| `DH6162RK` | NOT_FOUND | Tidak ada status | Tidak ada status |

Tanggal jatuh tempo diturunkan dari tanggal kalender WITA saat lookup: future untuk ACTIVE, past untuk EXPIRED; STNK `DH7112DP` null sesuai tanda—yang tidak mendefinisikan status. Kalkulator status server existing tetap otoritatif (`today >= due` ialah EXPIRED). NOPOL valid lainnya NOT_FOUND; input tidak valid tetap error existing. Tidak memasukkan raw body/PII BPAD nyata sebagai fixture.

`LIVE` berarti hasil langsung dari sumber yang dipilih Worker development (simulator), **bukan bukti request BPAD**. `CACHE` tetap KV lokal300detik, freshness dari `provider_fetched_at`, dan status dievaluasi ulang server. Banner development harus menjelaskan data simulasi; jangan menganggap sumber LIVE sebagai data produksi. NOT_FOUND tidak di-cache dan statusnya tidak diciptakan.

## Checklist operasional UAT

1. Login kedua role melalui UI; buka sesi dengan lokasi baseline/jalur. Uji ADMIN multi-device dan OFFICER409 tanpa melemahkan aturan sesi.
2. Uji empat skenario pada320×740,360×740,390×844,430×932: NOPOL jelas, FOUND/NOT_FOUND berbeda dari ACTIVE/EXPIRED/UNKNOWN, kontrol44px+, tanpa overflow.
3. Debounce600ms, Enter, X/autofocus, stale-response guards tetap. Lookup ulang satu NOPOL dapat CACHE, tetapi satu raid hanya empat snapshot pertama (D5-01).
4. Tunggu background history selesai melalui refresh manual, bukan timer polling. Rekap empat skenario: total4, found3, not_found1, tax_active1, tax_expired2, tax_unknown0. UNKNOWN STNK tidak masuk metrik pajak UNKNOWN.
5. OFFICER tidak mendapat endpoint admin(403), history milik user lain404. ADMIN mendapat history global existing.
6. Tutup sesi dan lihat snapshot historis tetap, logout tidak otomatis menutup raid. Password reset/revoke/admin tetap mengikuti kontrak existing.
7. Jangan menyatakan UAT browser sebagai validasi perangkat Android fisik, keyboard outdoor, BPAD live, cookie TLS produksi, CPU Free, atau production readiness.

## Hasil validasi lokal Phase 8 (2026-10-08)

Alur browser Chrome/CDP dengan UI, cookie dan Worker development nyata berhasil pada **320×740, 360×740, 390×844 dan 430×932**. Bukan mock HTTP browser: login ADMIN, sesi/jalur, empat skenario, lookup ulang, history/rekap4unik, close/logout, workflow OFFICER, penolakan admin dan history user lain, aktivasi/nonaktivasi, pembuatan akun UAT sementara, reset password, login dengan password baru dan logout akhir.

Pada enam layar per viewport (login/setup/FOUND/NOT_FOUND/history/admin), pengukuran tidak menemukan overflow horizontal, target sentuh di bawah44px, atau kontrol akhir yang tidak dapat digulir di atas bottom navigation. NOPOL40px sans, localStorage/sessionStorage0, tidak request non-loopback atau exception runtime pada alur final. Rekap4/3FOUND/1NOT_FOUND/1pajakACTIVE/2EXPIRED/0UNKNOWN; lookup ulang tidak menambah record. Akun sementara dibiarkan **nonaktif**, bukan dihapus; semuanya hanya state `.wrangler/dev-uat`.

Pengukuran browser diotomasi dengan interaksi DOM/keyboard nyata, bukan uji petugas lapangan atau perangkat Android fisik. Keyboard virtual, glare matahari dan brightness riil belum diuji. Peninjauan visual screenshot serta tests kontras/fokus/reduced-motion melengkapi baseline aksesibilitas, bukan sertifikasi penuh.

Sebelum hasil akhir terdapat perbaikan script diagnostik sementara (readiness halaman/lokasi/detail, serialisasi predikat, pemeriksaan clearance pada scroll-end) dan koreksi UI nyata: PWA/account dipadatkan agar hasil scanner terlihat pada320px. Tidak ada pelemahan test aplikasi, auto retry, sleep/cooldown, production SQL atau BPAD live untuk memperoleh PASS. Untuk mengulang alur dari baseline bersih, hentikan dev dan lakukan reset terkonfirmasi seperti prosedur di atas; reset bukan perbaikan aturan single-session.

Gate akhir AI Lead: **31 files/1127 tests PASS122,62s**, typecheck/lint/build/audits full dan produksi0vulnerabilities, migration lokal/FK bersih, Wrangler dry-run120,78KiB/gzip30,19KiB. Hasil dan limitasi produksi tetap dicatat di PROJECT_STATUS.md. Tidak ada deployment atau perubahan resource/secrets produksi.
