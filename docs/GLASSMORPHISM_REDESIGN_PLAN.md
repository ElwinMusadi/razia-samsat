# Implementation Plan: Glassmorphism Razia SAMSAT

Status: IMPLEMENTASI LOKAL fase 1-5 selesai; regression lulus, UAT perangkat/release belum disetujui.
Tanggal: 13 Oktober 2026.
Basis analisis: branch `main`, HEAD `51f79f1c4b474769b5e5cd550f06210a5d2b77e8`.
Owner analisis, planning, dan implementasi frontend: `frontend-engineer`.
Pendukung: `test-engineer` untuk validasi dan `code-reviewer` untuk review independen.

## 1. Tujuan dan batas bukti

Redesign seluruh antarmuka aplikasi dengan Glassmorphism yang cocok untuk petugas
lapangan SAMSAT: jelas di bawah cahaya terang, mudah dioperasikan dengan satu tangan,
dan ringan pada PWA Android. Konsep: **Kaca Operasional SAMSAT — kaca untuk bingkai,
kertas untuk data**. Glass adalah material antarmuka, bukan alasan mengurangi kontras.

Analisis dilakukan melalui source, komponen, route, stylesheet, dokumentasi, dan test.
Tidak ada dev server, screenshot aplikasi, pengujian browser, test suite, atau build
dijalankan pada tahap planning. Ukuran layout, performa perangkat, dan hasil visual
masih perlu dibuktikan saat implementasi. Perhitungan warna awal merupakan simulasi
numerik, bukan audit WCAG lengkap atas aplikasi yang sudah dirender.

Dokumen ini tidak menimpa `docs/REDESIGN_PLAN.md` tanggal 12 Oktober. Rencana lama
bersifat historis; beberapa usulnya sudah diimplementasikan dan beberapa asumsi tidak
lagi sesuai source terbaru. `docs/DESIGN_SYSTEM.md` tetap menjadi baseline kontrak
interaksi; perubahan aturan visual diselaraskan setelah rencana ini disetujui.

## 2. Baseline dan analisis UI/UX

Stack: React 19, React Router 7, Vite 8, Tailwind 4, primitives existing dengan Radix
Slot/cva, Lucide, dan font self-hosted Inter/DM Serif Display. Tidak diperlukan migrasi
framework, router, state management, atau penambahan library animasi/komponen besar.

### Fondasi yang dipertahankan

- BrandLockup, StatusChip, Skeleton, SessionBar, Input/PasswordInput, Button,
  PageHeader, Surface, EmptyState/ErrorState sudah ada; reuse, jangan buat ulang.
- Bottom navigation terbaru: Petugas tiga destinasi, Admin lima destinasi dengan
  FAB Scanner di tengah. Nama aksesibel Scanner tetap tersedia walaupun icon-only.
- Target sentuh existing 48px, safe-area padding, live region scanner, heading/error
  focus, serta reduced-motion sudah ada.
- Lookup outcome FOUND/NOT_FOUND terpisah dari status pajak/STNK
  ACTIVE/EXPIRED/UNKNOWN. UNKNOWN tidak boleh digambarkan sebagai menunggak.
- Password uncontrolled/ref dan dibersihkan, role guard, reconciliation mutasi,
  expiry sesi, stale-response protection, dan privacy PWA tidak diubah.

### Temuan yang mengarahkan redesign

| Prioritas | Bukti source | Implikasi rencana |
| --- | --- | --- |
| P1 | `src/index.css:77,103-137`: permukaan dominan putih opak, shadow nav/FAB kuat | Bedakan chrome glass dari data opak; satu material konsisten, bukan blur setiap kartu |
| P1 | `src/index.css:101-117`: lebar minimum empat link dan FAB Admin | Potensi overflow 320px berdasarkan hitungan CSS; verifikasi browser sebelum menyebut bug |
| P1 | `src/history.tsx:305`: `bg-white text-black` | Pindahkan warna ke token semantik agar theme tidak terpecah |
| P1 | `src/components/ui/input.tsx:5`: `.input-control` belum didefinisikan eksplisit | Konsolidasikan input/select/focus/disabled/invalid tanpa mengganti kontrak form |
| P2 | `src/app.tsx:54-55`, `src/index.css:81,123`: dua elemen serif di login | Satu momen brand; heading form operasional Inter yang ringkas |
| P2 | `src/index.css:75`: layout `max-w-lg` | Scanner tetap fokus; riwayat/admin dapat lebih lebar pada desktop |
| P2 | `src/index.css:162,218-226`: selector operasional tidak digunakan dan motion 240ms | Hapus duplikasi hanya setelah trace pemakaian; motion fungsional 150-200ms |
| P2 | `public/offline.html:6`, stylesheet offline | Samakan bahasa visual offline/PWA tanpa mengubah privasi atau offline behavior |

Temuan di atas adalah audit source, bukan klaim kegagalan usability yang diamati.
Tidak diasumsikan bahwa komponen StatusChip/BrandLockup belum ada. Scanner saat ini
submit Enter, bukan debounce 600ms yang tercantum pada dokumen lama.

## 3. Arah visual dan design system

### Identitas visual

Canvas cool-mist dengan tint biru/teal statis. Signature berupa pita kaca pada chrome
scanner dan floating navigation; hasil kendaraan tetap menyerupai lembar data yang
kokoh. Tidak memakai neon, blob bergerak, gambar dekoratif eksternal, atau kaca gelap
transparan rendah. Teal adalah aksen konteks sesi, bukan status pajak baru.

### Proposal token

Sumber token utama tetap `src/index.css`, menggunakan semantic CSS variables dan
`@theme inline` yang sudah tersedia. Nilai berikut proposal, perlu visual QA:

| Token/role | Nilai awal |
| --- | --- |
| Canvas aplikasi | `#F3F7F9` |
| Teks utama | `#0F1319` |
| Brand/action fill | `#2B63F6` |
| Teks link/aktif di atas glass | `#1E4FD6` |
| Aksen sesi | `#0F766E` |
| Surface data/input/status | `#FFFFFF` opak |
| Glass chrome | putih 90%; fallback putih 100% |
| Border dekoratif | `#D6DEE3` atau ink alpha 14%; tidak diklaim memenuhi 3:1 |
| Border kontrol kritis | `#64748B` atau token existing yang lolos pengukuran 3:1 |
| Radius | Gunakan skala existing 10/16/24/32px dan pill |
| Blur | band 12-16px; nav/account maksimal 12px; fallback tanpa blur |
| Motion | opacity/transform 150-200ms; tanpa animasi ambient atau filter |

Inter untuk label, form, heading operasional, dan data. DM Serif Display hanya pada
momen brand/empty-state dengan restraint. NOPOL dan metrik memakai tabular numbers;
slashed-zero hanya jika font aktual mendukung dan visualnya membantu. Tidak perlu
font baru, CDN, atau mengubah license/font assets.

Perhitungan awal: ink/canvas sekitar 17,28:1; teks strong-blue/canvas 6,20:1;
strong-blue pada glass putih 90% di atas hitam sekitar 5,33:1; control border/canvas
4,42:1. Border dekoratif ink 14%/putih hanya sekitar 1,35:1, sehingga tidak boleh
dipakai sebagai satu-satunya affordance kontrol. Brand-blue biasa di atas glass
90%/hitam sekitar 3,97:1: gunakan strong-blue/ink untuk teks, bukan brand-blue.

Semantik success/danger/warning/neutral tetap berbeda. Semua pasangan harus diukur
ulang pada background/gradient/content terburuk yang benar-benar dirender, bukan
hanya swatch canvas. Teks biasa minimum 4,5:1, teks besar 3:1, dan batas/fokus kontrol
minimum 3:1. Status selalu memiliki label dan ikon, bukan warna saja.

### Aturan implementasi glass

- Default surface tetap solid yang terbaca; glass diaktifkan sebagai progressive
  enhancement melalui `@supports` untuk backdrop-filter/WebKit fallback.
- Maksimal tiga permukaan blur terlihat bersamaan; tidak ada nested blur. Data,
  setiap baris list, tombol, input, dan panel konfirmasi tidak memakai blur.
- Inventory per route: scanner hanya search band + nav pill + account panel jika
  terbuka; header footer scanner solid/tanpa blur. Route lain hanya lapisan dekoratif
  header + nav pill + account panel. Panel akun bukan descendant lapisan blurred.
- Hindari blur fullscreen dan permukaan blur yang menutupi mayoritas viewport.
  Jika performa Android turun, kurangi blur atau gunakan opaque fallback.
- Akun/dropdown jangan menjadi child terklip dari surface blurred. Gunakan wrapper
  chrome dengan lapisan dekoratif terpisah; evaluasi stacking/containing block.
  Jangan menerapkan `contain: paint` atau overflow hidden pada header secara global.
- Gunakan background CSS berlapis pada canvas, bukan pseudo-element z-index negatif
  yang sulit diprediksi. Hindari background-attachment fixed dan will-change global.
- `prefers-reduced-motion`, `forced-colors`, dan solid fallback wajib. Media query
  `prefers-reduced-transparency` hanya enhancement karena dukungannya belum merata;
  keterbacaan default tidak boleh bergantung padanya. Tidak menambah toggle baru.
- CSS classes/file lokal dan Lucide SVG DOM, tanpa inline style baru, unsafe-inline,
  external fonts, atau data-URI textures. CSP tetap tidak dilonggarkan.

## 4. Cakupan layar dan state

| Area | Target redesign | Invariant yang harus tetap |
| --- | --- | --- |
| `/login` | Brand tunggal, form solid dalam komposisi glass, instalasi lebih terstruktur | Labels, autocomplete, password cleanup, loading/expired/conflict/error, details instalasi |
| Shell semua protected route | Chrome konsisten, akun mudah dibaca, glass pill + FAB pusat | Petugas 3/Admin 5 destinasi, role-gated links, aria-current, safe area, logout semantics |
| `/razia/setup` | Form lokasi/jalur solid, konteks sesi dan aksi jelas | Start/close/sync, locations loading/error/empty, 409 reconciliation, needsSync |
| `/razia/scanner` | Pita pencarian glass, NOPOL sebagai jangkar, hasil opak dan chip konsisten | Prefix DH, Enter-only, blur setelah submit, clear/refocus, mounted live region, stale protection |
| Hasil scanner | FOUND/NOT_FOUND, status, waktu dan fakta berhierarki | UNKNOWN/null tidak jadi EXPIRED; input-error/failure/raid-required tetap berbeda |
| `/history` | Kartu daftar ringkas, filter/status/pagination terbaca | Role scope, loading/empty/retry, snapshot wording dan route detail |
| `/history/:id` | Header sesi dan enam metrik konsisten; detail lookup solid | Forbidden/not-found, more-error, data-metric/data-check-id dan snapshot semantics |
| `/admin/users` | List/form lebih padat, lebar adaptif desktop | ADMIN gate, create/activate/deactivate, loading/empty/error dan no self-deactivate |
| `/admin/users/:id` | Identitas, role/status, password/sesi dan confirmation jelas | Password refs, revoke/password administrative sign-out, ambiguous mutation needsSync |
| `/admin/locations` | Nama/status/aksi lokasi konsisten dengan admin users | Edit/activate/deactivate/remove sesuai API existing; jangan tampilkan seolah hard-delete baru |
| PWA controls | Install/update/network notice terbaca dalam language visual yang sama | Native details dipertahankan, pending/installed/unsupported/failed, update tidak auto-reload |
| `/offline` | Halaman anonim solid dengan style yang selaras | Tanpa data pribadi, form/script; teks advisory dan link masuk tetap |

Tidak menambah kamera/OCR, chart/dashboard, ekspor, dark mode, menu baru, atau dialog
konfirmasi yang mengubah workflow. Scanner heading/focus dan close-session behavior
tidak dihapus/diubah hanya demi estetika. Perubahan behavior baru memerlukan scope
terpisah; redesign ini mempertahankan native details dan konfirmasi admin existing.

### Responsive dan interaksi

Mobile-first 320/375/390px, tablet 768px, desktop 1024/1440px. Scanner dapat tetap
berkolom tunggal; riwayat/admin mendapat lebar dan grid fakta lebih efisien pada
desktop, tanpa memaksakan desktop sidebar sebagai bagian scope awal.

Pill nav mempertahankan FAB/urutan role. Rule compact 320px mengurangi padding/gap,
bukan mengecilkan target sentuh di bawah 44px; target utama tetap 48px, FAB 56px.
Hitungan lebar Admin adalah hipotesis hingga diukur. Hindari nav dua baris atau
menutupi content/focus/keyboard. Uji safe area dan orientasi landscape.

Semua kontrol memiliki default/hover/focus/pressed/disabled/loading/invalid yang
konsisten. Focus tidak dihilangkan; error tetap dekat field dan role alert tersedia.
Input mobile minimum 16px; informasi penting tetap terlihat pada zoom 200%, keyboard
terbuka, serta reflow 320px. Perubahan active indicator menggunakan warna + bentuk.

## 5. File scope dan batas produksi

Utama: `src/index.css`, `src/app.tsx`, `src/scanner.tsx`, `src/history.tsx`,
`src/admin.tsx`, `src/components/vehicle.tsx`, `nopol-input.tsx`, `session-bar.tsx`,
dan primitives existing di `src/components/ui/`. Edit scanner hanya jika markup
presentasi perlu; handler/state tidak diubah. `src/pwa.tsx` hanya presentasi controls.
Seluruh route files (`app.tsx`, `scanner.tsx`, `history.tsx`, `admin.tsx`, `pwa.tsx`)
hanya boleh mengubah classNames/wrapper presentasi dan styling yang disetujui.
Handlers, effects, refs, role conditions, API calls, `NavLink` to/end, aria semantics,
autocomplete, dan reconciliation tetap. Pengecualian perubahan accessible markup
harus direview terpisah dengan assertion intent yang tetap, bukan perubahan behavior.
Final diff diverifikasi terhadap allowlist file dan pembatasan presentasi ini.

Reuse CSS/primitives terlebih dahulu; belum ada kebutuhan komponen GlassSurface
baru. Jangan menamai file `tokens.css`, `tokens.json`, atau path credential/secret
karena bertentangan dengan source-cleanliness guard CI. Token cukup di index.css;
jika pemisahan diperlukan gunakan nama seperti `design-tokens.css` setelah review.

Public theme/offline metadata: `index.html`, `public/manifest.webmanifest`,
`public/offline.html`, `public/offline.css`; cache-version-only pada `public/sw.js`
bersifat conditional dalam fase PWA atomik. Ikon/logo existing tidak perlu diganti.
Offline mempertahankan system-ui dan CSS-only styling, tanpa font/gambar baru atau
penambahan service-worker precache list.

Tidak diubah: `worker/**`, `shared/**`, `migrations/**`, `src/lib/api.ts`,
`src/auth.tsx` seluruhnya, logic service-worker/PWA, Wrangler, scripts CI/deploy, DNS/domain,
binding DB/KV/Assets, secrets/data, package dan lockfile. Tidak melemahkan CSP atau
cache rules. Cache hanya public assets; API/payload/auth HTML tidak ikut cache.

Dokumentasi design system hanya diselaraskan setelah visual proposal disetujui.
Dokumen lama tidak dihapus. Source/theme tests boleh diperbarui untuk nilai visual
baru, tetapi assertion security/role/focus/label/pending tidak boleh dilemahkan.

## 6. Tahapan implementasi

Setiap fase owner `frontend-engineer`; selesai hanya setelah diff review, tests
relevan, bukti visual, dan review independen. Checkpoint terpisah, bukan rewrite
seluruh aplikasi sekaligus. Tahap berikutnya tidak dimulai saat defect material
fase sebelumnya belum selesai. Tidak ada commit otomatis dalam fase-fase ini.

| Fase | Pekerjaan | Acceptance dan gate utama |
| --- | --- | --- |
| 0 Baseline | Capture screenshot/state sintetis lokal, catat bundle/performa, recheck Git, tetapkan visual sample login+scanner dan keputusan canvas/metadata | Baseline jelas; tidak memakai PII produksi; setujui material glass dan scope PWA sebelum roll-out |
| 1 Fondasi | Token canvas/glass/solid, typographic scale, focus/control borders, fallbacks, reduced motion | Kontras proposal dihitung; tidak ada ketergantungan blur; design-system tests diperbarui secara semantik |
| 2 Shell | Header, account panel layering, nav/FAB, compact Admin 320px | Route/role/aria-current/details unchanged; tidak clipping/focus tertutup; blur budget browser terukur |
| 3 Scanner dan sesi | Band pencarian, input pelat, hasil/skeleton/status/session; setup form | Semua state scanner dan start/close/sync tetap; keyboard/Enter/clear/UNKNOWN teruji |
| 4 Riwayat dan admin | List/detail/metrik, admin pengguna/detail/lokasi; konsistensi form dan confirmation | Tidak ada endpoint baru; pagination/error/permission/mutasi ambigu tetap; desktop/mobile adaptif |
| 5 Login dan PWA atomik | Login+install styling; samakan theme-color dan offline assets | Metadata HTML/manifest/offline, offline.css, CACHE_NAME baru dan tests dalam satu perubahan koheren |
| 6 Final QA | Full regression, a11y, visual/performa Android, CSP, production-mode build | Semua acceptance terukur; final diff hanya scope disetujui, tanpa perubahan production contracts |

Fase 5: perubahan precached public assets dan cache-version harus bersama, bukan
manifest pada fase 1 lalu cache-version pada fase lain. Version bump menggunakan
nilai versi aktual saat implementasi, bukan asumsi hardcoded v3. Jika cache-version
di luar izin implementasi, pertahankan precached assets sampai ada persetujuan.
Jangan menambah skipWaiting/clients.claim, auto reload, atau mengubah cache logic.
Canvas CSS app bisa dirancang lebih dulu; theme metadata tetap baseline sampai fase
PWA atomik selesai. Pilihan alternatif jika perubahan metadata ditolak: canvas lama
`#F7F6F2` dipertahankan, glass memakai tint blue/teal pada chrome saja.
Keputusan canvas diambil pada fase 0, bukan ditunda sampai fase 5. Tidak ada release
antara fase 1 dan fase PWA atomik. Test token/contrast canvas diperbarui pada fase 1;
assertion theme-color/manifest/offline metadata hanya diperbarui pada fase 5.

## 7. Testing dan quality gates

Commands berikut adalah rencana untuk tahap implementasi, belum dijalankan:

```text
npm test -- tests/design-system.test.ts tests/build.test.ts
npm test -- tests/frontend.test.ts tests/scanner.test.ts
npm test -- tests/history-ui.test.ts tests/admin-ui.test.ts tests/admin-locations-ui.test.ts
npm test -- tests/pwa.test.ts tests/pwa-ui.test.ts
npm run typecheck
npm run lint
npm test
```

Build final dengan environment tersanitasi dan mode produksi eksplisit:

```powershell
$env:VITE_APP_MODE = 'production'
npm run build -- --mode production --emptyOutDir
```

Perintah dijalankan di shell validation terpisah atau environment sebelumnya
dipulihkan setelah selesai. Jangan memodifikasi `.env` operator. Jika dotenv lokal
dapat memengaruhi build, gunakan snapshot terisolasi tanpa dotenv dan install dari
lockfile, bukan menghapus file lokal. Hentikan watcher yang menulis dist hanya jika
dimiliki sesi validation; jangan mematikan proses operator tanpa izin.

Validasi tidak memakai `ci:build`, `ci:deploy`, atau production deployment command.
Production preview lokal harus tidak merender development/simulation banner; buktikan
melalui DOM/runtime atau test compile yang tepat, bukan hanya pencarian string minified.

Preserve test contracts: Scanner accessible name pada FAB; nav Petugas/Admin; live
region mounted; autofocus; password cleanup; stale response; role/sesi; NOT_FOUND vs
UNKNOWN; pending/reconcile; konfirmasi admin; data snapshot; offline cache privacy.
Exact-class/hex assertions yang sudah obsolete dapat diperbarui secara terfokus
setelah perubahan desain disetujui, bukan menambahkan comment/token palsu agar lolos.

Vitest/jsdom tidak membuktikan backdrop compositing, blur budget, kontras render,
keyboard viewport, atau frame-time. CSS-source tests hanya membuktikan deklarasi.
Browser manual/automation existing bila tersedia tetap wajib untuk visual QA.

### Matriks visual/manual

- 320, 375, 390, 768, 1024, 1440px; Petugas dan Admin; portrait/landscape.
- Semua route dan state pada tabel scope; contoh data sintetis, bukan PII live.
- Zoom 200%, keyboard navigation/visible focus, TalkBack atau screen reader setara,
  native keyboard Android terbuka, safe-area, dan konten panjang.
- Worst-case content/gradient di belakang kaca; forced-colors; reduced-motion;
  reduced-transparency jika didukung; browser tanpa backdrop-filter.
- PWA standalone/install/update/offline; CSP tanpa pelanggaran; offline tanpa data.
- Scroll dan perubahan hasil scanner di Android kelas rendah yang disepakati.
  Catat baseline vs hasil repaint/frame-time/bundle; kurangi blur jika regresi nyata.
- Contrast thresholds dan target sentuh dibuktikan pada hasil render, tidak diklaim
  lulus hanya dari token atau snapshot unit test.

## 8. Definition of done dan release

Redesign selesai bila seluruh layar konsisten Glassmorphism, seluruh data kritis
tetap opak/terbaca, route/role/API/interaksi tetap, seluruh automated gate lulus,
visual/a11y/performa terdokumentasi, dan review independen tidak menemukan blocker.
UAT lokal oleh operator menggunakan data sintetis dan tidak mengubah produksi.

Push `main` dapat langsung memicu Workers Builds dan deployment. Rencana ini tidak
mengotorisasi stage/commit/push atau deploy. Release memerlukan review kandidat,
persetujuan commit dan push terpisah, lalu evaluasi pipeline secara read-only.
Tidak ada rollback/retry/deployment manual sebagai fallback tanpa izin.

Risiko utama: kontras glass di atas konten dinamis, blur GPU, layering/focus clipping,
CSS selector test rapuh, nav Admin sempit, dan lifecycle cache PWA. Semuanya memiliki
gate khusus di atas. Performa perangkat, screenshot, browser compatibility aktual,
runtime production acceptance, serta baseline jumlah test terbaru belum diverifikasi
pada tahap planning ini.

Langkah berikutnya setelah review rencana: frontend-engineer mengerjakan fase 0 dan
fase 1 terlebih dahulu, menunjukkan sample login/scanner dan hasil validasinya, baru
melanjutkan roll-out layar lain setelah sample dinyatakan sesuai.

Referensi kompatibilitas: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-transparency

## Checkpoint implementasi — 13 Oktober 2026

- Fase fondasi, chrome, scanner/session, riwayat/admin/login, dan PWA atomik sudah
  diterapkan. Scope source tetap presentasi; tidak ada perubahan API/auth/backend.
- Lima regression test design-system ditambahkan. Full suite: 37 file, 1533 test PASS.
- Typecheck dan production-mode build PASS. Lint: 0 error, 9 warning existing pada
  empat file yang tidak diubah oleh redesign. Diff whitespace check PASS.
- Chrome headless lokal dengan fetch sintetis: login, scanner Admin, dan offline
  diuji pada 320/390/1024px; tidak ada horizontal overflow. Nav Admin 320px memiliki
  target link 48x60px dan FAB 56x56px. Banner development tidak muncul pada dist final
  yang dibangun eksplisit dalam mode produksi.
- Screenshot/measurement disimpan di temporary directory di luar repo. Preview
  lokal dan browser validation dihentikan setelah pemeriksaan.
- Visual seluruh route/state, keyboard mobile, zoom, forced-colors rendered, TalkBack,
  dan performa Android fisik masih pending; hasil kendaraan belum dicapture pada
  harness visual. Unit tests bukan pengganti verifikasi ini.
- Test/Integration Review PASS WITH NOTES. Code-reviewer tidak berhasil dijalankan
  karena provider 404; tidak ada klaim review senior independen telah selesai.
- Tidak ada stage, commit, push, atau deployment. Release tetap membutuhkan izin.
