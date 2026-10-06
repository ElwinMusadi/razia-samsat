# AI Product Blueprint

## Project Information
- **Project Name:** Aplikasi Razia Kendaraan SAMSAT Kota Kupang
- **Project Type:** Web Application / Progressive Web App (PWA)
- **Primary Platform:** Smartphone Android
- **Domain/Location:** Wilayah UPTD SAMSAT, Nusa Tenggara Timur (NTT) - Khususnya Kota Kupang
- **Current Date:** October 2026

---

# STEP 00 — Project Brief

## 1. Executive Summary
Aplikasi Razia Kendaraan SAMSAT Kota Kupang adalah sebuah Web Application / PWA yang dirancang khusus untuk mendukung petugas lapangan SAMSAT dalam melakukan pengecekan awal status administratif kendaraan (Pajak dan STNK) pada saat kegiatan razia atau operasi pemeriksaan. Aplikasi ini mengandalkan input Nomor Polisi (NOPOL) secara cepat untuk menarik data dari API BPAD yang sudah ada, menyajikan informasi krusial yang sudah difilter demi keamanan data, dan membantu petugas mengambil keputusan operasional secara cepat tanpa menggantikan proses pemeriksaan fisik maupun otorisasi penegakan hukum.

## 2. Product Objectives
- **Efisiensi Operasional:** Menyediakan alat bantu digital yang cepat dan mudah dioperasikan (satu tangan, outdoor) untuk memverifikasi status pajak dan STNK kendaraan yang mendekati titik pemeriksaan.
- **Data-Driven Action:** Mengurangi ketergantungan pada sekadar ingatan atau perkiraan visual petugas terhadap pelat nomor, beralih ke validasi data sistemik.
- **Accountability & Monitoring:** Mencatat riwayat pengecekan (history) secara minimalis dan relevan untuk keperluan pelaporan kegiatan operasional lapangan berdasarkan lokasi dan jalur razia.
- **Data Privacy & Security:** Memastikan data sensitif masyarakat dilindungi melalui prinsip *data minimization* dan *least privilege access*.

## 3. Target Users & Operating Environment
### Target Users
- **Petugas Lapangan SAMSAT:** Pengguna utama (End-user). Bertugas menginput NOPOL dan menginterpretasi status untuk koordinasi HT.
- **Administrator:** Pengelola akses pengguna (Role-based access control, Single Device Session) dan konfigurasi sistem.

### Operating Environment
- **Device:** Smartphone Android (milik dinas atau pribadi petugas).
- **Kondisi Fisik:** Luar ruangan (outdoor), di bawah sinar matahari langsung (membutuhkan kontras UI yang tinggi), seringkali dioperasikan dengan satu tangan.
- **Kondisi Jaringan:** Koneksi internet seluler yang fluktuatif.
- **Tempo Kerja:** Cepat dan berulang-ulang, input data masif dalam waktu singkat.

## 4. Scope Definition
### In-Scope (MVP)
1. Autentikasi dan otorisasi pengguna (Login & Single Device Session).
2. Manajemen Sesi Razia (Input Lokasi dan Jalur).
3. Scanner pencarian kendaraan berdasarkan NOPOL (Auto-fetch dengan Debounce).
4. Tampilan hasil pencarian yang difokuskan pada: NOPOL, Merek, Tipe, Warna, Status Pajak, dan Status STNK.
5. Indikator keberhasilan, kegagalan sistem, dan validasi "Data Tidak Ditemukan" yang jelas.
6. Caching 5 menit via Cloudflare KV untuk efisiensi *resource* BPAD.
7. Pencatatan riwayat pengecekan operasional (Check History) dengan data minimal secara asinkron.
8. Optimasi Progressive Web App (PWA) untuk instalasi di Android.

### Out of Scope (MVP)
- Sistem pembayaran atau *payment gateway*.
- Penerbitan surat tilang / e-Ticketing.
- Manajemen regu yang kompleks.
- Pengganti alat komunikasi (HT digital) atau fitur chat antarpetugas.
- Modul *offline-first* yang kompleks untuk pencarian.

## 5. Technology Stack Baseline
- **Frontend / UI:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui.
- **Backend / API Framework:** Cloudflare Workers, Hono.
- **Database:** Cloudflare D1 (SQLite-compatible) & Cloudflare KV (Caching).
- **Deployment & Edge Network:** Cloudflare Platform.

---

# STEP 01 — Product Discovery

## 1. Problem Statement
Dalam kegiatan operasi pemeriksaan kendaraan oleh SAMSAT Kota Kupang, petugas di titik pengamatan awal masih mengandalkan pengamatan visual terhadap NOPOL. Ini menimbulkan risiko *false positive* (kendaraan diberhentikan namun ternyata surat lengkap) dan lambatnya koordinasi via HT. Sulitnya merekapitulasi jumlah kendaraan yang telah dipindai juga menjadi masalah.

## 2. Solution Vision
Membangun Progressive Web App (PWA) "Quick Scanner" NOPOL. Aplikasi memungkinkan petugas mengetik NOPOL, dan sistem akan langsung melakukan *auto-fetch* (tanpa klik tombol Cari) dari cache atau API BPAD, menampilkan status Pajak dan STNK secara instan (warna merah/hijau). Semua riwayat diikat pada "Sesi Razia" spesifik (Lokasi & Jalur).

## 3. User Personas
1. **Petugas Lapangan (The Observer / Scanner)**
   - Fokus pada input cepat satu tangan dan visibilitas layar di bawah matahari (Light mode paksa).
2. **Administrator (SAMSAT IT/Admin)**
   - Fokus pada manajemen user, mereset sesi perangkat yang nyangkut, dan melihat log riwayat keseluruhan.

## 4. Value Proposition
- **Kecepatan (Speed):** Respons hasil di bawah 2 detik per kendaraan berkat *Edge Network* dan *caching*.
- **Akurasi (Accuracy):** Mengurangi *human error* dalam menebak status pajak kendaraan.
- **Akuntabilitas:** Histori pengecekan terekam otomatis di latar belakang berdasarkan Lokasi dan Jalur razia.

---

# STEP 02 — Module & Feature Architecture

| No | Modul | Fitur |
|---:|---|---|
| **A** | **[Autentikasi & Sesi]** | |
| 1 | Autentikasi Pengguna | Login & Single Device Session validation. |
| 2 | Sesi Razia (Operasional) | Buka Sesi (Input Lokasi dan Jalur Razia: 1/2). |
| 3 | | Tutup Sesi Razia. |
| **B** | **[Operasional Lapangan (Core)]**| |
| 4 | Pencarian Kendaraan | Input NOPOL (*Auto-uppercase*, hapus spasi). |
| 5 | | *Auto-fetch* dengan *Debounce* (tanpa tombol Cari). |
| 6 | | Tombol 'X' (Clear Input) untuk menghapus hasil & autofocus cepat. |
| 7 | Visualisasi Hasil | Menampilkan Merek, Tipe, Warna, Status Pajak, STNK (Warna kontras). |
| 8 | Kalkulator Status | Logika Status (Aktif/Mati) dihitung otomatis oleh Worker. |
| 9 | Caching Mechanism | Caching KV 5 menit per NOPOL. |
| 10 | Error & State Handling | *Loading Indicator*, Data Not Found, dan Timeout Alert. |
| **C** | **[Riwayat & Pelaporan]** | |
| 11 | Riwayat Pengecekan | Pencatatan otomatis log secara *asynchronous* (`waitUntil`). |
| 12 | Live List | Daftar riwayat NOPOL yang baru di-scan pada sesi aktif. |
| 13 | Rekapitulasi Sesi | Ringkasan metrik sesi aktif: Total Scan, Pajak Aktif, Pajak Mati. |
| **D** | **[Manajemen Admin]** | |
| 14 | Manajemen Pengguna | Tambah, Edit, Nonaktifkan akun Petugas. |
| 15 | | Fitur "Reset Sesi Perangkat" (Force Logout user lain). |

---

# STEP 03 — Requirements & Business Rules

## 1. Core Business Processes
- **BP-01 (Mulai Operasi):** Petugas Login $\rightarrow$ Validasi Single Session $\rightarrow$ Isi Lokasi & Jalur $\rightarrow$ Sesi Aktif.
- **BP-02 (Scanning Cepat):** Ketik NOPOL $\rightarrow$ *Debounce* 600ms $\rightarrow$ Cek Cache KV (Jika miss $\rightarrow$ API BPAD) $\rightarrow$ Tampil Hasil Merah/Hijau $\rightarrow$ Log Disimpan *Background* $\rightarrow$ Petugas lapor HT $\rightarrow$ Klik 'X' untuk bersihkan input $\rightarrow$ Ketik kendaraan berikutnya.
- **BP-03 (Reset Sesi):** HP Petugas mati/rusak $\rightarrow$ Admin mereset sesi via *dashboard* $\rightarrow$ Petugas login di HP baru.

## 2. Business Rules & Logic
- **BR-01 (Status Pajak Mati):** Pajak = MATI (Merah) jika Tanggal Hari Ini (WITA) $\ge$ Tanggal Jatuh Tempo (`SD_NOTICE`). Jika `<`, maka AKTIF (Hijau).
- **BR-02 (Status STNK Mati):** STNK = MATI (Merah) jika Tanggal Hari Ini (WITA) $\ge$ Tanggal Jatuh Tempo (`SD_STNK`). Jika `<`, maka AKTIF (Hijau).
- **BR-03 (Data Privacy):** Tidak merekam/menampilkan detail identitas pribadi seperti KTP, Alamat, atau No Rangka.

---

# STEP 04 — Product Requirements Document (PRD)

## 1. Functional Requirements (FR)
- **FR-01:** Sistem HARUS melakukan *auto-fetch* saat petugas berhenti mengetik NOPOL (interval *debounce* ~600ms).
- **FR-02:** Sistem HARUS membersihkan kolom input dan me-*reset autofocus* keyboard saat tombol 'X' ditekan.
- **FR-03:** Sistem HARUS memeriksa *Cache* Cloudflare KV sebelum meminta data ke API BPAD (TTL 5 Menit).
- **FR-04:** Sistem HARUS mencatat histori (NOPOL, Status) secara asinkron tanpa memblokir perenderan UI.
- **FR-05:** Sistem HARUS menolak login jika mendeteksi *session ID* aktif di perangkat lain untuk pengguna yang sama.

## 2. Non-Functional Requirements (NFR)
- **Performance:** Waktu perenderan layar sejak fetch data $< 300$ ms.
- **Usability:** UI wajib *forced Light Mode* agar terbaca jelas di bawah matahari.
- **Reliability:** Timeout API ke BPAD dibatasi maksimal 3 detik untuk mencegah UI *hang*.

---

# STEP 05 — Information Architecture & User Flow

## 1. Sitemap & Page Hierarchy
- `/login` (Public)
- `/razia/setup` (Petugas/Admin) - Buka Sesi Razia (Lokasi & Jalur)
- `/razia/scanner` (Petugas/Admin) - **[CORE]** Scanner, Indikator Status & Live History
- `/history` (Petugas/Admin) - Daftar Riwayat Sesi
- `/account` (Petugas/Admin) - Profil Pengguna & Logout
- `/admin/users` (Admin Only) - Manajemen Akun & Reset Sesi Perangkat

## 2. User Flows
- **Single Session Flow:** Login $\rightarrow$ Cek `active_session_id` $\rightarrow$ Tolak jika *device* berbeda.
- **Scanner Flow:** Ketik NOPOL $\rightarrow$ Debounce $\rightarrow$ Hit Cache/API $\rightarrow$ Tampil Hasil $\rightarrow$ Klik ikon **(X)** $\rightarrow$ UI Bersih & Autofocus Keyboard.

---

# STEP 06 — Data & Technical Concept

## 1. Entity Relationship
1. **users:** `id`, `username`, `password_hash`, `role`, `active_session_id`, `is_active`.
2. **sesi_razia:** `id`, `user_id`, `lokasi`, `jalur`, `status`, `waktu_mulai`.
3. **log_pengecekan:** `id`, `sesi_razia_id`, `nopol`, `status_pajak`, `status_stnk`, `timestamp`.

## 2. Technical Architecture
- **Frontend:** PWA dengan React + TypeScript + Vite. Di- *host* di Cloudflare Pages.
- **Backend/Edge:** Cloudflare Workers (Hono framework). Mengamankan API Key BPAD dan melakukan komputasi waktu jatuh tempo di *Edge server*.
- **Database:** Cloudflare D1 (Serverless SQLite).
- **Cache:** Cloudflare KV (Key `bpad_nopol_{nopol}`, TTL 300s).
- **Auth:** JWT HTTP-only Cookies dengan sinkronisasi `active_session_id`.

---

# STEP 07 — UI/UX Design Specification

## 1. Global UI Principles
- **Theme:** Forced Light Mode (menghindari pantulan layar *outdoor*).
- **Design System:** Tailwind CSS + shadcn/ui.
- **Mobile First:** *Bottom Navigation Bar*, elemen utama (input, hasil, tombol clear) dijangkau ibu jari.
- **Touch Targets:** Minimal 44x44 px (khususnya untuk tombol Clear 'X').

## 2. Page Specifics: Quick Scanner (`/razia/scanner`)
- **Layout:** *Sticky Search Section* di atas, *Scrollable Body* untuk Kartu Hasil dan Mini History.
- **Input NOPOL:** Teks sangat besar (text-2xl), tebal, dengan atribut `autocapitalize="characters"`.
- **Tombol Clear (X):** Posisi di dalam form input sisi kanan. Memiliki ikon yang tebal dan *hitbox* yang lebar.
- **Result Card:** Teks hitam legam di atas latar putih/abu muda. Badge Status sangat besar: `bg-red-600` (MATI) dan `bg-emerald-600` (AKTIF). Teks di dalam badge tebal dan *uppercase*.
- **State Handling:** Spinner *loading* minimalis saat *debounce* berjalan (tidak menutupi layar). *Banner timeout* berwarna *amber/orange* jika koneksi *offline*/gagal.

---

# FINAL QUALITY REVIEW

## 1. Blueprint Consolidation Status
Seluruh tahapan dari STEP 00 hingga STEP 07 telah dikonsolidasikan, diselaraskan, dan disetujui.

## 2. Core Requirement Traceability
- **Speed:** *Auto-fetch*, integrasi Cloudflare KV (5 menit TTL), tombol *Clear* + *Autofocus*.
- **Outdoor Operability:** *Forced Light Mode*, tipografi tebal, warna status merah/hijau solid, ukuran target sentuh standar aksesibilitas.
- **Data Minimization:** Nama Pemilik, NIK, dsb, dihapus dari log database.
- **Security:** *Single Device Session* via JWT dan Cloudflare D1.

## Quality Gate Final
Status: ✅ **PASSED (READY FOR HANDOFF)**

Dokumen ini sudah final dan merupakan Single Source of Truth untuk implementasi teknis dan desain UI/UX.