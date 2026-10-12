# Rencana Redesign UI/UX — Aplikasi Razia Kendaraan SAMSAT Kota Kupang (PWA)

**Status:** DRAFT untuk review — belum ada perubahan kode
**Tanggal:** 12 Oktober 2026
**Cakupan:** Analisis UI/UX + implementation plan. Tidak menyentuh repo `ElwinMusadi/razia-samsat`.
**Sumber analisis:** `docs/DESIGN_SYSTEM.md`, `src/app.tsx`, `src/scanner.tsx`, `src/history.tsx`, `src/admin.tsx`, `src/components/*`, `src/index.css`, `src/pwa.tsx`, `PROJECT_STATUS.md`

---

## 1. Ringkasan eksekutif

Kabar baiknya: fondasinya sehat. `DESIGN_SYSTEM.md` sebenarnya sudah bagus — prinsip *outdoor readability*, pemisahan domain *lookup outcome* vs *status kendaraan*, token semantik, dan pola aksesibilitas (focus management, aria-live, reduced motion) semuanya sudah benar dan harus dipertahankan.

Kesan "AI slop" bukan berasal dari fondasi yang rusak, melainkan dari **eksekusi yang terlalu setia pada default**: komponen terlihat seperti shadcn generik tanpa ciri khas, serif dekoratif dipakai di layar operasional, status hanya mengandalkan warna teks, dan tidak ada identitas visual milik aplikasi ini. Redesign yang diusulkan adalah **evolusi, bukan revolusi**: pertahankan arsitektur, token, dan alur — tajamkan detail visual, perkuat identitas, dan perbaiki titik lemah operasional.

Prinsip redesign: **"Field-first editorial"** — bahasa editorial (serif, whitespace lega) hanya untuk momen brand dan empty state; layar operasional 100% fungsional, padat, dan terbaca di bawah matahari.

---

## 2. Yang sudah bagus — jangan diubah

| Area | Catatan |
|---|---|
| Token semantik (`index.css` + `@theme inline`) | Struktur warna sudah benar; komponen mengonsumsi token, bukan hex hard-code |
| Pemisahan `FOUND`/`NOT_FOUND` vs `AKTIF`/`MATI`/`UNKNOWN` | Invariant domain yang penting; pertahankan di semua komponen baru |
| Aksesibilitas | `focus-visible`, `aria-live` pada hasil lookup, `role="alert"`, `prefers-reduced-motion` — pertahankan polanya di setiap komponen baru |
| Kontrak interaksi scanner | Debounce 600ms, Enter untuk cari langsung, clear/reset, proteksi stale-request — **jangan diubah** (sudah diamanatkan DESIGN_SYSTEM §16) |
| Bottom navigation | Target 48px, safe-area inset, urutan Scanner–Sesi–Riwayat–Admin — pertahankan pola |
| Copy Bahasa Indonesia | Jelas dan konsisten ("Sesi razia", "Riwayat", "Tutup sesi razia") |
| Mobile-first, max-w-lg | Sudah tepat untuk PWA Android lapangan |

---

## 3. Temuan UI/UX

### F1. Tidak ada identitas visual milik aplikasi (tinggi)
Brand hanya berupa teks "SAMSAT Kota Kupang". Tidak ada mark, tidak ada perlakuan khas. Hasilnya: aplikasi terlihat seperti *template* shadcn generik — inilah sumber utama kesan "AI slop". Seorang petugas harus bisa mengenali aplikasi ini dari jarak satu meter.

### F2. Serif dipakai di layar operasional (tinggi)
Heading 40px DM Serif di "Masuk" dan "Sesi razia". Di alat kerja lapangan, serif besar memperlambat pemindaian visual dan terasa dekoratif. DESIGN_SYSTEM §20 sendiri melarang "oversized marketing-style headers on operational pages" — implementasi saat ini melanggar semangat aturannya sendiri. Serif seharusnya hanya untuk momen brand (login) dan empty state.

### F3. Status hanya mengandalkan warna teks (tinggi)
`.vehicle-status` hanya mewarnai teks (hijau/merah/abu). Di bawah glare matahari, teks berwarna tipis sulit dibedakan sekilas. Butuh **chip ber-tint**: background tint + ikon + label tegas. DESIGN_SYSTEM §5 mengizinkan "restrained tint/background where necessary" — ini saatnya dipakai.

### F4. Aksi destruktif terlihat identik dengan aksi primer (tinggi)
"Tutup sesi razia" memakai varian button default (hitam) yang sama persis dengan "Mulai sesi". Petugas yang terburu-buru bisa salah tekan. DESIGN_SYSTEM §14 mencadangkan varian destructive untuk operasi konsekuensial **dengan konfirmasi eksplisit** — belum diterapkan.

### F5. Konteks sesi terkubur di layar tersibuk (sedang)
Di `/razia/scanner` — layar yang paling sering dipakai — info lokasi/jalur hanya teks kecil di bawah heading, dan kontrol akun/logout disembunyikan dalam `<details>` disclosure. Header malah dipindah ke bawah konten. Untuk aplikasi lapangan, konteks sesi (lokasi · jalur · status) harus selalu terlihat sekilas tanpa scroll.

### F6. Heading redundan di scanner (sedang)
Judul "Scanner" menduplikasi label navigasi bawah dan memakan ruang vertikal berharga di layar tersibuk. Ruang itu lebih baik untuk input NOPOL dan hasil.

### F7. Aksen biru #2B63F6 hampir tidak dipakai (sedang)
Biru royal didefinisikan sebagai warna "active/link/action/focus" tapi nyaris tak muncul kecuali di nav aktif dan focus ring. UI jadi monokrom-generik. Aksen yang konsisten adalah cara termurah membangun identitas.

### F8. Motion nyaris tidak ada (rendah)
Hanya spinner. Tidak ada transisi antar state (hasil muncul, chip berubah). "Quiet functional motion" ada di dokumen tapi belum diimplementasikan.

### F9. PWA install tersembunyi (rendah)
Kontrol instalasi PWA disembunyikan dalam `<details>` di halaman login — petugas baru kemungkinan tidak menemukannya.

### F10. Bahasa radius kurang berkarakter (rendah)
Radius mengikuti dokumen (pill untuk button, 16/24px untuk surface) — benar tapi generik. Ada peluang memberi ciri khas lewat `corner-shape: squircle` (progressive enhancement, Chrome/Edge sudah mendukung, browser lain fallback ke `border-radius`).

---

## 4. Arah redesign

1. **Evolusi, bukan revolusi.** Tidak ada perubahan API, worker, auth, atau alur bisnis. Semua perubahan di `src/` (frontend) dan `src/index.css`.
2. **Field-first editorial.** Serif (DM Serif Display) hanya untuk: momen brand di login dan empty state. Layar operasional: Inter sepenuhnya, skala heading lebih rapat (28–32px, bukan 40px).
3. **Status yang terbaca di bawah matahari.** Chip ber-tint untuk semua status operasional: `PAJAK AKTIF`, `PAJAK MATI`, `STNK AKTIF`, `STNK MATI`, `TIDAK DAPAT DITENTUKAN`, `DITEMUKAN`, `TIDAK DITEMUKAN`. Ikon + label + background tint, bukan warna teks saja.
4. **Identitas visual.** Brand lockup sederhana: mark perisai (Lucide `Shield`) dalam kotak rounded + wordmark "SAMSAT Kota Kupang". Aksen biru dipakai konsisten untuk keadaan aktif dan sorotan operasional.
5. **Konteks sesi selalu terlihat.** Session bar persisten di scanner: lokasi · jalur · indikator SESI AKTIF.
6. **Hierarki aksi yang jujur.** Primer (hitam, per dokumen) untuk aksi utama; biru untuk sorotan/aktif; varian destructive + dialog konfirmasi untuk "Tutup sesi razia".
7. **Quiet motion.** Transisi halus saat hasil muncul dan status berubah; skeleton saat loading; tetap hormati `prefers-reduced-motion`.
8. **Ciri khas modern.** `corner-shape: squircle` pada surface utama sebagai detail pembeda (dengan fallback mulus).

---

## 5. Spesifikasi per layar

### 5.1 Login (`/login`)
- Jadikan **momen brand**: mark perisai + "SAMSAT Kota Kupang" + serif "Razia Kendaraan" dalam komposisi vertikal yang tenang.
- Form tetap minimal (nama pengguna, kata sandi, tombol "Masuk").
- Ganti `<details>` "Instalasi aplikasi" dengan **kartu instalasi PWA** yang terlihat jelas (ikon + teks + tombol), karena ini titik masuk petugas baru.

### 5.2 Scanner (`/razia/scanner`) — prioritas tertinggi
- **Hapus heading "Scanner"** yang redundan.
- **Session bar persisten** di atas area input (sticky): `📍 Jln. El Tari — DPRD Provinsi NTT · Jalur A ● SESI AKTIF`. Ringkas, satu baris + wrap.
- Input NOPOL tetap hero (64px, bold, uppercase) — sudah bagus, pertahankan.
- Tambah **tombol aksi cepat** di samping input: clear (sudah ada) — pertahankan perilaku.
- **Result card v2**: NOPOL tetap jangkar utama; outcome (`DITEMUKAN`) sebagai eyebrow kecil (sesuai dokumen); status pajak & STNK memakai **chip ber-tint** baru, bukan teks berwarna saja; fakta kendaraan tetap `dl` dua kolom di layar ≥640px.
- **Skeleton loading** untuk kartu hasil saat `loading` (gantikan teks "Mencari data…" saja) — tetap pertahankan `aria-live`.
- NOT_FOUND: kartu netral yang lebih tenang (sesuai dokumen §24) + tombol "Coba lagi"/fokus kembali ke input.
- Pindahkan kontrol akun ke header yang konsisten (lihat §5.5), bukan di bawah konten.

### 5.3 Sesi (`/razia/setup`)
- Heading sans 28–32px (bukan serif 40px).
- Kartu "Sesi aktif" memakai session bar mini yang sama dengan scanner.
- **"Tutup sesi razia" → varian destructive + dialog konfirmasi** ("Tutup sesi di Jln. El Tari — DPRD Provinsi NTT? Tindakan ini tidak dapat dibatalkan.").

### 5.4 Riwayat (`/history`, `/history/:id`)
- Baris riwayat memakai chip status baru (compact).
- Pertahankan catatan snapshot ("Status adalah snapshot saat pengecekan…") — penting secara produk.
- Detail riwayat: terapkan hierarki kartu hasil v2 yang sama dengan scanner.

### 5.5 Shell & navigasi
- **Brand lockup** di header: mark perisai + "SAMSAT" bold tracking + "Kota Kupang".
- Bottom nav: active state diperkuat — background tint biru muda + teks biru (bukan teks biru saja).
- Kontrol akun: ganti `<details>` dengan tombol menu yang proper (tetap sederhana; tidak perlu library baru).

### 5.6 Admin (`/admin/users`)
- Terapkan skala heading sans + chip baru. Tidak ada perubahan fungsional.

---

## 6. Sistem komponen (baru / diubah)

| Komponen | Lokasi | Perubahan |
|---|---|---|
| `StatusChip` (baru) | `src/components/ui/status-chip.tsx` | Chip ber-tint: `success`/`danger`/`warning`/`neutral` × ukuran `default`/`compact`. Ikon + label selalu berpasangan. Gantikan pemakaian `VehicleStatus` teks-saja |
| `LookupOutcomeBadge` | `src/components/vehicle.tsx` | Dibangun di atas `StatusChip` varian netral; tetap subtle (eyebrow) sesuai dokumen |
| `VehicleResultCard` | `src/components/vehicle.tsx` | Layout v2: chip ber-tint, metadata (waktu/WITA) di footer kartu |
| `SessionBar` (baru) | `src/components/session-bar.tsx` | Strip konteks sesi persisten: lokasi · jalur · indikator aktif |
| `BrandMark` (baru) | `src/components/ui/brand.tsx` | Lockup perisai + wordmark, dipakai di header & login |
| `Button` | `src/components/ui/button.tsx` | Tambah varian `destructive` yang benar (sudah ada tokennya); pertahankan pill + hitam untuk primer |
| `Skeleton` (baru) | `src/components/ui/skeleton.tsx` | Skeleton kartu hasil; nonaktifkan animasi saat `prefers-reduced-motion` |
| `ConfirmDialog` (baru) | `src/components/ui/confirm-dialog.tsx` | Dialog konfirmasi generik (untuk tutup sesi); pakai `<dialog>` native + fokus trap sederhana |
| `PageHeader` | `src/components/ui/layout.tsx` | Prop `tone: "operational" \| "editorial"` — operasional = sans 28–32px; editorial = serif untuk login/empty state |
| `EmptyState` | `src/components/ui/layout.tsx` | Pertahankan serif (sudah tepat) + ilustrasi ikon yang lebih ekspresif |
| `PwaInstallCard` (baru) | `src/pwa.tsx` | Kartu instalasi PWA yang terlihat, gantikan `<details>` |

### Token baru di `index.css`
- `--radius-*` tetap; tambah `corner-shape: squircle` pada `.vehicle-result`, `.feature-surface` (progressive enhancement).
- Token tint sudah ada (`--success-muted` dll.) — dipakai oleh `StatusChip`.
- Skala heading operasional: `.admin-heading` 28px dipertahankan; tambah `.page-heading-operational`.

---

## 7. Rencana implementasi bertahap

> Aturan setiap fase: tidak ada perubahan `worker/`, `migrations/`, API, atau alur auth. `npm test`, `typecheck`, `lint`, `build` harus hijau di akhir tiap fase.

### Fase 0 — Fondasi visual (estimasi: S)
- Token & utilitas di `index.css`: skala heading operasional, `corner-shape` untuk surface utama.
- `StatusChip`, `Skeleton`, `BrandMark` sebagai komponen baru (belum dipakai di mana-mana).
- **File:** `src/index.css`, `src/components/ui/status-chip.tsx`, `src/components/ui/skeleton.tsx`, `src/components/ui/brand.tsx`
- **Acceptance:** komponen ter-render di halaman sandbox/story internal; tidak ada perubahan visual di layar produksi.

### Fase 1 — Sistem status (S)
- Ganti `VehicleStatus` teks-saja → `StatusChip` di `VehicleResultCard`, riwayat (list & detail), dan admin bila relevan.
- `LookupOutcomeBadge` dibangun ulang di atas `StatusChip` netral.
- **File:** `src/components/vehicle.tsx`, `src/history.tsx`
- **Acceptance:** semua status tampil sebagai chip ber-tint; pemisahan outcome vs status tetap terjaga; tests hijau.

### Fase 2 — Layar scanner (M) — dampak terbesar
- `SessionBar` persisten; hapus heading "Scanner" redundan; header akun dipindah ke pola §5.5.
- `VehicleResultCard` v2 + skeleton loading + transisi kemunculan hasil.
- **File:** `src/scanner.tsx`, `src/components/session-bar.tsx`, `src/app.tsx` (bagian shell scanner)
- **Acceptance:** alur ketik → debounce → hasil tidak berubah perilakunya; konteks sesi terlihat tanpa scroll; hasil terbaca sekilas.

### Fase 3 — Shell & navigasi (S)
- Brand lockup di header semua layar; active state bottom nav diperkuat; kontrol akun sebagai tombol menu.
- **File:** `src/app.tsx`, `src/components/ui/brand.tsx`
- **Acceptance:** navigasi tetap 48px target; tidak ada konten tertutup nav.

### Fase 4 — Login, Sesi, Riwayat, Admin (M)
- Login: momen brand + kartu instalasi PWA.
- Sesi: heading operasional + tombol destructive + `ConfirmDialog` untuk tutup sesi.
- Riwayat & Admin: terapkan chip + skala baru.
- **File:** `src/app.tsx` (Login, RaidSetup), `src/history.tsx`, `src/admin.tsx`, `src/pwa.tsx`, `src/components/ui/confirm-dialog.tsx`
- **Acceptance:** tutup sesi selalu meminta konfirmasi; instalasi PWA mudah ditemukan.

### Fase 5 — Polish & QA lapangan (S)
- Audit kontras (teks operasional ≥ 4.5:1), uji viewport 320px, uji `prefers-reduced-motion`, uji instalasi PWA & mode offline dasar.
- Review copy Bahasa Indonesia menyeluruh.
- **Acceptance:** checklist QA §8 lolos; `npm test` 1255+ kasus hijau; tidak ada regresi fungsional.

**Estimasi kasar keseluruhan:** 5 fase, masing-masing 1–3 sesi kerja fokus. Urutan fase disusun berdasarkan dampak-per-usaha.

---

## 8. Checklist QA (definisi selesai)

- [ ] `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` hijau
- [ ] Tidak ada perubahan pada `worker/`, `migrations/`, kontrak API
- [ ] Kontras teks operasional ≥ 4.5:1 (periksa di bawah brightness tinggi)
- [ ] Viewport 320×740: tidak ada overflow horizontal, target sentuh ≥ 44px
- [ ] `prefers-reduced-motion`: tidak ada animasi non-esensial
- [ ] Screen reader: urutan baca hasil lookup tetap logis (NOPOL → status → fakta)
- [ ] Alur scanner tidak berubah: debounce 600ms, Enter, clear, stale-protection
- [ ] NOT_FOUND tidak menyerupai PAJAK MATI (uji visual berdampingan)
- [ ] Tutup sesi selalu konfirmasi; tidak ada aksi destruktif satu-klik
- [ ] PWA dapat diinstal dari halaman login
- [ ] Copy Bahasa Indonesia konsisten dan bebas typo

---

## 9. Non-goals (tidak dikerjakan dalam redesign ini)

- Perubahan API/worker/database/migrasi
- Perubahan alur autentikasi & otorisasi
- Fitur baru (termasuk kamera/OCR — tetap butuh persetujuan produk per §26)
- Dark mode (terang lebih terbaca di lapangan)
- Ganti framework, router, atau state management

---

## 10. Referensi desain yang disarankan

Untuk mengisi bagian "3 referensi visual" di `design-brief.md`, cari aplikasi operasional lapangan yang padat-informasi namun berkarakter, misalnya aplikasi driver ride-hailing (hierarki status sekilas), aplikasi field-service (kartu kerja + aksi cepat), dan satu aplikasi dengan bahasa visual editorial yang kuat untuk momen brand. Ekstrak token warnanya dengan **Token Inspector**, lalu petakan ke token semantik di `index.css` — bukan ditempel mentah.

---

## 11. Langkah selanjutnya yang disarankan

1. Review dokumen ini; tandai bagian yang tidak disetujui.
2. Kumpulkan 3 referensi visual (lihat §10).
3. Setujui Fase 0 sebagai titik mulai — fondasi tanpa risiko visual.
4. Setelah Fase 0 hijau, lanjutkan berurutan ke Fase 1–5.

---

*Dokumen ini adalah rencana, bukan eksekusi. Tidak ada satu baris pun kode repo yang diubah dalam penyusunannya.*
