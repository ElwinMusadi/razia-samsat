# DESIGN_SYSTEM.md

# Design System — Aplikasi Razia Kendaraan SAMSAT Kota Kupang

**Status:** APPROVED — Phase 8 Implementation Contract  
**Role:** UI/UX Single Source of Truth  
**Product:** Aplikasi Razia Kendaraan SAMSAT Kota Kupang  
**Primary platform:** Android smartphone PWA  
**Implementation foundation:** React + TypeScript + Tailwind CSS + shadcn/ui

---

## 1. Purpose

Dokumen ini adalah **Single Source of Truth (SSOT) untuk UI/UX** aplikasi.

Design System ini menerjemahkan design language referensi **TinyKPI dari Kage** menjadi sistem visual untuk aplikasi operasional lapangan SAMSAT.

Referensi TinyKPI digunakan sebagai **visual language**, bukan sebagai template yang disalin.

### Yang diadopsi

- editorial minimalism;
- warm off-white canvas;
- near-black typography;
- restrained royal-blue accent;
- generous whitespace;
- hairline borders;
- rounded surfaces;
- editorial serif + neutral sans pairing;
- quiet functional motion;
- strong information hierarchy.

### Yang tidak diadopsi

- TinyKPI branding;
- TinyKPI logo/mascot;
- TinyKPI copy;
- TinyKPI illustrations/screenshots;
- marketing landing-page structure;
- pricing;
- product integrations;
- macOS framing;
- launch countdown;
- marketing CTA patterns yang tidak relevan dengan aplikasi operasional.

### Prinsip utama

> **Editorial minimalism × Operational clarity × Mobile-first field UI**

---

# 2. Product Context

Aplikasi digunakan petugas SAMSAT saat operasi/razia kendaraan.

Karakteristik penggunaan:

- Android smartphone;
- outdoor;
- one-handed;
- kondisi cahaya dapat berubah;
- petugas membutuhkan hasil yang dapat dipahami dalam waktu singkat;
- input utama adalah NOPOL;
- hasil harus memiliki hierarchy yang jelas;
- UI tidak boleh menghambat pekerjaan lapangan.

Aplikasi:

- bukan aplikasi pembayaran;
- bukan aplikasi ticketing;
- bukan aplikasi komunikasi;
- bukan sistem automatic enforcement.

**Keputusan akhir tetap berada pada petugas.**

Design System tidak boleh membuat UI memberi kesan bahwa aplikasi secara otomatis menetapkan pelanggaran atau tindakan hukum.

---

# 3. Design Principles

## 3.1 Information First

Informasi operasional harus selalu lebih dominan daripada dekorasi.

Prioritas visual:

1. NOPOL;
2. outcome pemeriksaan;
3. status pajak;
4. status STNK;
5. informasi pendukung;
6. metadata.

---

## 3.2 Quiet Visual Language

UI menggunakan:

- whitespace;
- border;
- typography;
- subtle contrast;
- semantic color.

Hindari:

- heavy shadows;
- excessive gradients;
- animated backgrounds;
- decorative illustrations;
- visual noise.

---

## 3.3 One Idea per Surface

Satu card atau section sebaiknya memiliki satu tujuan utama.

Jangan menggabungkan terlalu banyak informasi yang tidak berhubungan dalam satu surface.

---

## 3.4 Operational Clarity

Setiap state harus dapat dikenali tanpa mengandalkan warna saja.

Contoh:

- `PAJAK AKTIF`;
- `PAJAK MATI`;
- `STNK AKTIF`;
- `STNK MATI`;
- `TIDAK DAPAT DITENTUKAN`;
- `FOUND`;
- `NOT_FOUND`.

Warna, icon, dan text bekerja bersama.

---

## 3.5 Mobile First

Design dimulai dari smartphone.

Target utama:

- 320×740 critical minimum viewport;
- 360px;
- 375px;
- 390px;
- 414px;
- 430px.

Layout yang lebih besar merupakan enhancement, bukan baseline.

---

## 3.6 Outdoor Readability

UI harus tetap terbaca dan operasional pada:

- brightness tinggi;
- glare;
- kondisi outdoor;
- penggunaan satu tangan;
- kondisi pengguna bergerak.

Konsekuensinya:

- jangan menggunakan gray text terlalu pucat untuk informasi penting;
- jangan menggunakan font weight terlalu tipis untuk operational content;
- status harus high contrast;
- NOPOL harus besar dan jelas;
- primary action harus sangat jelas;
- border penting harus tetap terlihat.

`#8A8F96` hanya untuk secondary/supporting content dan **tidak boleh digunakan untuk informasi kritis**.

---

# 4. Visual Language

## 4.1 Page Canvas

Primary page background:

```text
#F7F6F2
```

Token:

```text
--background
```

Karakter:

- warm;
- light;
- editorial;
- tidak pure white.

---

## 4.2 Core Palette

| Token | Value | Usage |
|---|---|---|
| `background` | `#F7F6F2` | app/page background |
| `foreground` | `#0F1319` | primary text |
| `muted-foreground` | `#8A8F96` | secondary/supporting text |
| `border` | `#E7E4DC` | hairline borders |
| `primary` | `#2B63F6` | active/link/action/focus |
| `primary-foreground` | `#FFFFFF` | text on primary |
| `dark-surface` | `#0A0A0C` | dark UI/mockup surfaces |
| `dark-tile` | `#17181B` | dark inner UI tiles |

Large dark blocks are not permitted as general page chrome. Dark surfaces are reserved for relevant product/UI previews or intentionally emphasized controls.

---

# 5. Semantic Status and Outcome Colors

Status colors are independent from the visual accent system.

## 5.1 Success — AKTIF

Base:

```text
#16803C
```

Use for:

- `PAJAK AKTIF`;
- `STNK AKTIF`;
- successful operational state.

Do not color an entire result card green.

Preferred treatment:

- semantic icon;
- explicit status label;
- restrained tint/background where necessary.

---

## 5.2 Danger — MATI

Base:

```text
#C62828
```

Use for:

- `PAJAK MATI`;
- `STNK MATI`;
- states requiring attention.

Do not interpret this as an automatic enforcement decision.

---

## 5.3 Neutral — UNKNOWN

Base:

```text
#6B7280
```

Use for:

- `TIDAK DAPAT DITENTUKAN`;
- unavailable/indeterminate status;
- neutral information state.

---

## 5.4 Warning

Base:

```text
#A16207
```

Use only for warning/information states where warning semantics are actually appropriate.

Do not use warning as a substitute for `MATI`.

---

## 5.5 NOT_FOUND

`NOT_FOUND` is a **lookup outcome**, not a vehicle status and not a violation status.

It must not be represented using the same semantic state as `MATI`.

Preferred treatment:

```text
NOT_FOUND
Nomor polisi tidak ditemukan.
```

Use a neutral visual treatment with explicit text.

The UI must never imply:

```text
NOT_FOUND = PAJAK MATI
```

or:

```text
NOT_FOUND = STNK MATI
```

---

# 6. Outcome/Status Domain Separation

This separation is an implementation invariant.

```text
Lookup Outcome
├── FOUND
└── NOT_FOUND

Vehicle Status
├── ACTIVE
├── EXPIRED
└── UNKNOWN
```

Component APIs must preserve this distinction.

Conceptual examples:

```tsx
<LookupOutcomeBadge outcome="FOUND" />
<LookupOutcomeBadge outcome="NOT_FOUND" />

<VehicleStatus status="ACTIVE" />
<VehicleStatus status="EXPIRED" />
<VehicleStatus status="UNKNOWN" />
```

Avoid a single generic status API that conflates lookup outcome with tax/STNK status.

---

# 7. Semantic Token Structure

The implementation should expose semantic tokens rather than hard-code colors throughout components.

Conceptual token groups:

```text
background
foreground
card
card-foreground
muted
muted-foreground
border
input
ring

primary
primary-foreground

success
success-foreground
success-muted

danger
danger-foreground
danger-muted

warning
warning-foreground
warning-muted

neutral
neutral-foreground
neutral-muted
```

Components should consume semantic tokens.

Avoid repeated arbitrary values such as:

```tsx
className="text-[#C62828]"
```

inside unrelated components.

Prefer semantic utility classes or component-level variants.

---

# 8. Typography

## 8.1 Typography Roles

Two type categories are used.

### Editorial Serif

Used selectively for:

- major page statements;
- empty-state statements;
- informational headings;
- high-level editorial sections.

### Neutral Sans

Used for:

- navigation;
- form controls;
- NOPOL;
- status;
- metadata;
- tables/lists;
- admin screens;
- operational content.

**Operational information must remain sans-serif**, even when editorial serif is used elsewhere on the page.

---

## 8.2 Recommended Typeface Direction

Editorial:

```text
DM Serif Display
```

UI:

```text
Inter
```

A system sans fallback must remain available.

The final implementation must avoid excessive font loading that materially harms PWA startup.

---

## 8.3 Type Scale

| Role | Size | Line Height |
|---|---:|---:|
| Display | 56–72px | ~1.02 |
| Page heading | 40–52px | ~1.08 |
| Section heading | 32–44px | ~1.12 |
| Large metric/NOPOL | 32–48px | ~1.05 |
| Body | 15–16px | 1.5–1.6 |
| Small body | 13–14px | 1.4–1.5 |
| Label | 12–13px | 1.3 |
| Eyebrow | 11px | 1.2 |

Mobile screens should use the lower end of the scale.

---

## 8.4 Editorial Headline Rule

Major editorial headlines may use a two-tone treatment:

```text
Periksa kendaraan.
Lihat statusnya.
```

First phrase:

- ink.

Continuation:

- muted gray.

The treatment is optional for editorial/informational screens.

Do not apply two-tone editorial headlines to:

- NOPOL;
- status badges;
- form labels;
- buttons;
- dense administrative lists.

---

## 8.5 Operational Typography Rule

The scanner and result experience prioritizes readability over editorial styling.

The following must remain sans-serif:

- NOPOL;
- `FOUND` / `NOT_FOUND`;
- tax status;
- STNK status;
- buttons;
- navigation;
- timestamps;
- metadata.

---

# 9. Spacing

Base unit:

```text
4px
```

Tokens:

| Token | Value |
|---|---:|
| `space-1` | 4px |
| `space-2` | 8px |
| `space-3` | 12px |
| `space-4` | 16px |
| `space-5` | 20px |
| `space-6` | 24px |
| `space-8` | 32px |
| `space-10` | 40px |
| `space-12` | 48px |
| `space-16` | 64px |
| `space-20` | 80px |
| `space-24` | 96px |

Large editorial sections may use 120–160px vertical rhythm on large screens.

This large spacing must not be blindly applied to scanner/mobile layouts.

---

# 10. Radius

| Token | Value | Usage |
|---|---:|---|
| `radius-sm` | 10px | small controls |
| `radius-md` | 16px | cards/inputs |
| `radius-lg` | 24px | major surfaces |
| `radius-xl` | 32px | media/major showcase |
| `radius-pill` | 9999px | pills/buttons/badges |

Use rounded geometry consistently.

Avoid arbitrary component-specific radius values.

---

# 11. Borders and Elevation

Primary border:

```text
#E7E4DC
```

Default:

```text
1px solid
```

The system prefers:

```text
border > shadow
```

Shadows must be:

- rare;
- soft;
- functional.

Do not use large black shadows or floating-card effects as the default visual language.

---

# 12. Iconography

Use one coherent icon family.

Recommended foundation:

```text
Lucide Icons
```

Icons should:

- be simple;
- use stroke-based geometry;
- avoid decorative illustrations;
- remain recognizable at small sizes.

Icon rules:

- default: 18–20px;
- compact metadata: 16px;
- major action: 20–24px;
- never rely on icon alone for critical status;
- pair important status icons with text.

---

# 13. Controls and Touch Targets

Minimum interactive target:

```text
44 × 44px
```

Preferred mobile target:

```text
48px
```

Buttons and form controls should not be compressed merely to fit more content.

---

# 14. Button System

## Primary

Visual:

- near-black/ink;
- white text;
- pill shape.

Examples:

```text
Mulai Sesi
Periksa Kendaraan
Simpan
```

## Secondary

Visual:

- light/transparent;
- border;
- ink text.

Examples:

```text
Kembali
Batal
Muat Ulang
```

## Destructive

Reserved for consequential administrative operations:

```text
Nonaktifkan
Reset Password
```

Destructive actions require explicit confirmation.

---

# 15. Input System

Inputs should be:

- high contrast;
- 48px or larger where practical;
- clearly labelled;
- keyboard friendly;
- focus-visible.

Focus:

```text
primary blue
#2B63F6
```

Avoid large glowing focus effects.

---

# 16. NOPOL Input

NOPOL is the most important input component.

Characteristics:

- prominent;
- large;
- one-handed friendly;
- autofocus when appropriate;
- clear/reset action;
- validation feedback;
- no unnecessary decoration.

Conceptual composition:

```text
NOPOL

┌────────────────────────────────────┐
│ DH1823HJ                         × │
└────────────────────────────────────┘

[ Periksa Kendaraan ]
```

Existing interaction contract remains:

- typing;
- Enter to submit;
- clear/reset;
- 600ms debounce behavior;
- immediate Enter submission;
- stale-request protection.

Design implementation must not change these business/interaction contracts.

---

# 17. Application Shell

The application shell consists of:

1. header/page context;
2. page content;
3. fixed bottom navigation on mobile.

Conceptual mobile structure:

```text
┌──────────────────────────────┐
│ Page title                   │
│ Context / metadata           │
├──────────────────────────────┤
│                              │
│ Page content                 │
│                              │
│                              │
├──────────────────────────────┤
│ Scanner Sesi Riwayat Admin   │
└──────────────────────────────┘
```

Content must include sufficient bottom padding so the fixed navigation never obscures interactive content.

---

# 18. Navigation

Mobile primary navigation:

- Scanner;
- Sesi Razia;
- Riwayat;
- Admin, only for ADMIN.

Recommended order:

```text
Scanner | Sesi | Riwayat | Admin
```

For OFFICER:

```text
Scanner | Sesi | Riwayat
```

For ADMIN:

```text
Scanner | Sesi | Riwayat | Admin
```

Active navigation:

- royal blue;
- clear icon + label;
- no heavy background animation.

**Logout is not a bottom-navigation destination.**

Logout belongs to an account/session action.

The scanner must always remain easy to reach.

---

# 19. App Header and Session Context

Header must provide context without consuming excessive mobile space.

It may show:

- page title;
- current raid/session context;
- small active-session indicator.

Example:

```text
● SESI AKTIF
```

The active-session indicator should be visually small.

Do not use a large persistent banner for session state.

---

# 20. Page Header

Page headers use:

- optional eyebrow;
- page title;
- concise supporting text;
- contextual action where required.

Avoid oversized marketing-style headers on operational pages.

---

# 21. Surface System

Use a small number of surface types.

## Surface

General content surface:

- light background;
- hairline border;
- 16px radius.

## FeatureCard

For summary or emphasized information:

- 24px radius;
- 24–32px padding.

## ResultCard

Dedicated vehicle lookup result:

- 24px radius;
- clear NOPOL hierarchy;
- semantic status grouping.

## DarkPreview

Dark surface for actual UI previews or visualizations where appropriate:

```text
#0A0A0C
```

Dark surfaces are not general page background.

---

# 22. Vehicle Result Card

The Vehicle Result Card is the primary information surface after a lookup.

### Required hierarchy

```text
1. NOPOL
2. Vehicle status
3. Supporting vehicle information
4. Metadata
```

Conceptual composition:

```text
┌──────────────────────────────────┐
│ HASIL PEMERIKSAAN                │
│                                  │
│ DH1823HJ                         │
│                                  │
│ ● Pajak AKTIF                    │
│ ● STNK AKTIF                     │
│                                  │
│ Pemilik                          │
│ ...                              │
│                                  │
│ LIVE · 10:42 WITA                │
└──────────────────────────────────┘
```

Rules:

- NOPOL is the strongest data element;
- `FOUND` may appear as a small eyebrow/label, not as a giant badge;
- tax and STNK are independently visible;
- owner information is secondary;
- source and timestamp are metadata;
- do not use a fully green/red card;
- semantic color is localized to status indicators.

---

# 23. NOPOL as Visual Anchor

NOPOL is the equivalent of a primary metric in the TinyKPI visual language.

Example:

```text
DH1823HJ
```

should have:

- high contrast;
- large type;
- strong weight;
- generous surrounding whitespace;
- high outdoor readability.

NOPOL remains sans-serif.

---

# 24. NOT_FOUND State

Example:

```text
NOT_FOUND

DH6162RK

Nomor polisi tidak ditemukan.
```

The state should:

- be visually distinct;
- remain neutral;
- not resemble `PAJAK MATI`;
- offer a retry/reset action when appropriate.

---

# 25. UNKNOWN State

Example:

```text
PAJAK
TIDAK DAPAT DITENTUKAN
```

This state must not be represented as either active or expired.

Use:

- neutral icon;
- explicit text;
- muted treatment;
- sufficient contrast.

---

# 26. Scanner Screen

Scanner is the primary operational screen.

### Visual priorities

1. NOPOL input;
2. loading/result;
3. result status;
4. quick access to recent history;
5. session context.

The scanner should feel faster and more direct than other screens.

### Density rule

> **Scanner is the screen with the highest operational density and the lowest decorative density.**

Do not turn the scanner into a marketing/editorial composition.

During loading:

```text
Memeriksa kendaraan...
```

Keep the input and relevant context visible.

Do not replace the entire screen with a blocking decorative loader.

No camera/OCR/barcode UI should be introduced unless explicitly approved in product scope.

---

# 27. Login Screen

Login should be minimal.

Recommended hierarchy:

```text
SAMSAT
Razia Kendaraan

Masuk untuk melanjutkan.

Username
[........................]

Password
[........................]

[ Masuk ]
```

Characteristics:

- warm background;
- strong typography;
- no unnecessary marketing content;
- password visibility control if implemented;
- error message close to the relevant form;
- no credential stored in browser storage.

---

# 28. Raid Setup

The raid setup page should emphasize:

1. location;
2. lane;
3. start session.

Location is selected from the configured list.

Lane remains a free-text operational field according to the existing product contract.

The screen should avoid unnecessary fields.

---

# 29. History UI

History is operational, not a marketing dashboard.

List hierarchy:

```text
DH1823HJ
FOUND · Pajak AKTIF · STNK AKTIF
10:42 WITA
```

For a raid session:

```text
Sesi Razia
08 Oktober 2026 · 10:15 WITA

12 pemeriksaan
8 FOUND
4 NOT_FOUND
```

Historical status is the snapshot recorded at lookup time.

UI must not imply that historical status is automatically recalculated to current status.

---

# 30. History Summary Metrics

Allowed summary concepts:

- total checks;
- found;
- not found;
- tax active;
- tax expired;
- tax unknown.

Metric numbers may be visually prominent, following the TinyKPI principle that metrics can act as visual anchors.

Do not introduce unrelated business metrics.

---

# 31. Admin UI

Admin screens should use the same visual language but slightly higher information density.

Areas:

- user list;
- user status;
- role;
- activation/deactivation;
- password reset;
- session management.

Avoid turning Admin into a generic enterprise dashboard.

Administrative actions require:

- clear target;
- clear consequence;
- confirmation for destructive/consequential actions;
- explicit success/error feedback.

---

# 32. Loading State

Loading should preserve layout stability.

Preferred:

- skeleton;
- inline spinner where appropriate;
- disabled duplicate submission;
- clear loading label.

Avoid:

- full-screen animated loaders for small requests;
- decorative animation.

---

# 33. Error State

Errors must distinguish:

- invalid input;
- session/authentication;
- no active raid session;
- NOT_FOUND;
- upstream/provider failure;
- network/timeout;
- system error.

Error copy must explain the next action when practical.

Example:

```text
Pemeriksaan gagal.

Data kendaraan belum dapat diperoleh.
Coba lagi.

[ Coba Lagi ]
```

Do not expose:

- stack traces;
- raw provider errors;
- internal IDs;
- sensitive infrastructure details.

---

# 34. Empty State

Empty states should be concise and useful.

Structure:

1. simple icon;
2. short editorial heading;
3. one sentence;
4. relevant action.

Avoid decorative illustrations unless they materially improve comprehension.

---

# 35. Responsive Rules

## Critical minimum

```text
320 × 740
```

Must remain usable without horizontal overflow.

## Mobile

Primary target:

```text
360–430px
```

Rules:

- single column;
- bottom navigation;
- large touch targets;
- compact page padding;
- scanner-first hierarchy;
- no horizontal scrolling;
- primary action remains easy to reach.

## Tablet

- increased content width;
- optional two-column content where useful;
- maintain touch-friendly controls.

## Desktop

- centered max-width content;
- editorial split layouts may be used;
- history/admin can become denser;
- navigation may transform according to application shell implementation.

Responsive behavior must preserve information hierarchy.

---

# 36. Accessibility

Minimum requirements:

- semantic HTML;
- WCAG AA-oriented contrast for normal text and essential UI;
- visible keyboard focus;
- labels associated with inputs;
- keyboard operation where applicable;
- status communicated through text/icon, not color alone;
- touch target ≥44px;
- reduced-motion support;
- no critical information hidden only in hover;
- error messages programmatically associated where appropriate;
- meaningful screen-reader labels.

### Required status test

If all semantic colors are removed, the user must still be able to distinguish:

- ACTIVE;
- EXPIRED;
- UNKNOWN;
- FOUND;
- NOT_FOUND.

---

# 37. Motion

Motion is:

> quiet and functional.

Allowed:

- subtle fade-up;
- state transition;
- underline transition;
- accordion expand/collapse;
- skeleton/loading;
- subtle navigation state change.

Not allowed by default:

- parallax;
- decorative particle effects;
- animated gradients;
- bouncing controls;
- excessive scale animations;
- long transition delays.

Respect:

```text
prefers-reduced-motion
```

---

# 38. Tailwind Architecture

Tailwind should represent the Design System tokens.

Preferred architecture:

```text
Design Tokens
      ↓
Tailwind Theme
      ↓
shadcn/ui primitives
      ↓
SAMSAT components
      ↓
Application screens
```

Do not scatter arbitrary design values throughout JSX.

Prefer:

```text
semantic token
→ component variant
→ screen
```

rather than:

```text
screen
→ arbitrary color/spacing/radius
```

---

# 39. shadcn/ui Strategy

shadcn/ui is the component foundation, not the final visual identity.

Components may include:

- Button;
- Input;
- Card;
- Badge;
- Dialog;
- Alert;
- Select;
- Dropdown;
- Skeleton;
- Separator;
- Sheet;
- Tabs;
- Accordion.

SAMSAT-specific components should compose these primitives.

Examples:

```text
Button
→ SamsatButton

Badge
→ StatusBadge

Input
→ NopolInput

Card
→ VehicleResultCard
```

Avoid unnecessary forks.

Do not mass-customize primitives in ways that make them inconsistent with the Design System.

---

# 40. Component Inventory

## Foundation

- Typography
- Color tokens
- Spacing
- Radius
- Border
- Elevation
- Icon
- Motion

## Form

- Input
- NopolInput
- PasswordInput
- Select
- FormField
- ValidationMessage

## Navigation

- AppHeader
- BottomNavigation
- PageHeader

## Feedback

- Badge
- LookupOutcomeBadge
- VehicleStatus
- Alert
- Toast
- Skeleton
- EmptyState
- ErrorState

## Vehicle

- VehicleResultCard
- VehicleMetadata
- LookupState

## History

- HistoryList
- HistoryRow
- RaidSessionCard
- HistorySummary
- Pagination

## Admin

- UserList
- UserRow
- UserStatus
- UserActionMenu
- SessionList
- ConfirmationDialog

---

# 41. Component Domain Rules

Components must preserve business semantics.

### Lookup outcome

```text
FOUND
NOT_FOUND
```

### Vehicle status

```text
ACTIVE
EXPIRED
UNKNOWN
```

Do not create a generic `status` prop that accepts every value above without domain distinction.

The UI component model should make incorrect combinations difficult to introduce.

---

# 42. Naming Conventions

Use semantic names.

Good:

```text
StatusBadge
LookupOutcomeBadge
VehicleResultCard
NopolInput
HistoryRow
```

Avoid names tied to temporary visual details:

```text
BlueCard
BigCard
RedBox
TinyKpiCard
```

Tokens should describe meaning, not implementation.

---

# 43. Kage Reference Usage

Kage/TinyKPI is a **design-language reference**.

Reference characteristics to study:

- hierarchy;
- rhythm;
- spacing;
- color restraint;
- typography pairing;
- rounded surfaces;
- hairline borders;
- editorial composition;
- quiet motion.

The application must adapt these characteristics to:

- mobile;
- field operations;
- NOPOL lookup;
- status-heavy information;
- history;
- admin management.

The result must be recognizably its own product.

---

# 44. MCP / External Design Reference

Kage MCP may be used by the coding/design agent during implementation if available.

MCP is a reference/research aid.

It must not become a dependency of the production application.

No Kage runtime service should be required for the application to function.

---

# 45. Development/UAT Canonical Scenarios

The following scenarios are canonical UI test fixtures.

| NOPOL | Outcome | Tax | STNK |
|---|---|---|---|
| `DH1823HJ` | FOUND | AKTIF | AKTIF |
| `DH7112DP` | FOUND | MATI | — |
| `DH5871GD` | FOUND | MATI | MATI |
| `DH6162RK` | NOT_FOUND | — | — |

These scenarios are for development/UAT simulation only.

They must not be treated as production BPAD records.

The UI must be validated against all four states.

---

# 46. Development Users

Development/UAT may use:

```text
ADMIN + OFFICER
username: elwinbessiesura

OFFICER
username: yusuf.adoe
```

Development password:

```text
password
```

These credentials are **development-only**.

They must never be used as production bootstrap credentials.

Production bootstrap continues to use the existing secure operator-input flow.

---

# 47. Security and Privacy UI Constraints

The Design System must not encourage exposure of sensitive vehicle data.

Do not introduce UI fields for:

- NIK/KTP;
- address;
- BPKB;
- chassis number;
- engine number;
- raw BPAD payload;
- other sensitive provider fields.

Vehicle owner name may be shown only where already permitted by the product contract.

Do not display internal:

- session tokens;
- password hashes;
- auth-session identifiers;
- raw request identifiers;
- provider implementation details.

---

# 48. UAT Acceptance Criteria

Phase 8 UI implementation is considered visually ready only when:

## Visual

- [ ] Design tokens implemented consistently.
- [ ] Kage/TinyKPI design language is recognizable but not copied.
- [ ] No TinyKPI branding/copy/assets remain.
- [ ] Typography hierarchy is consistent.
- [ ] Border/radius system is consistent.
- [ ] Semantic colors are consistent.
- [ ] Operational screens use sans-serif for critical information.
- [ ] NOPOL is the primary visual anchor on lookup results.

## Mobile

- [ ] 320×740 has no horizontal overflow.
- [ ] 360px layout has no horizontal overflow.
- [ ] 390px layout has no horizontal overflow.
- [ ] Bottom navigation does not obscure content.
- [ ] Controls meet touch target requirements.
- [ ] Scanner is usable one-handed.
- [ ] Primary action remains easy to reach.

## Outdoor readability

- [ ] Critical text is not rendered in low-contrast muted gray.
- [ ] NOPOL is clearly readable.
- [ ] Status labels remain readable under high brightness.
- [ ] Borders used for essential structure remain visible.
- [ ] UI does not rely on subtle shadows to establish hierarchy.

## Operational

- [ ] Login is usable.
- [ ] Raid setup is usable.
- [ ] Scanner is immediately understandable.
- [ ] FOUND/ACTIVE state is clear.
- [ ] FOUND/EXPIRED state is clear.
- [ ] FOUND/EXPIRED TAX + STNK state is clear.
- [ ] NOT_FOUND is clearly distinct from MATI.
- [ ] UNKNOWN is clearly distinct from ACTIVE/MATI.
- [ ] Historical data is visually identified as historical snapshot.
- [ ] Logout is an account/session action, not a primary navigation destination.

## Accessibility

- [ ] Status is not communicated by color alone.
- [ ] FOUND and NOT_FOUND remain distinguishable without color.
- [ ] ACTIVE, EXPIRED, and UNKNOWN remain distinguishable without color.
- [ ] Focus state is visible.
- [ ] Text contrast meets the intended accessibility baseline.
- [ ] Keyboard interaction works where applicable.
- [ ] Reduced-motion preference is respected.
- [ ] Screen-reader labels are meaningful.

## Consistency

- [ ] shadcn primitives are visually integrated.
- [ ] No arbitrary component-specific visual language has appeared.
- [ ] Admin and operational screens share the same foundation.
- [ ] Error/loading/empty states follow the same system.
- [ ] Lookup outcome and vehicle status remain separate component domains.

---

# 49. Phase 8 Implementation Boundary

This Design System governs UI/UX implementation.

It does **not** authorize changes to:

- business rules;
- authentication architecture;
- authorization model;
- history semantics;
- BPAD contract;
- vehicle status calculation;
- session semantics;
- database schema;
- production deployment.

Any such change requires separate architectural/product approval.

---

# 50. Final Design Direction

The final visual identity should feel:

**Calm. Precise. Modern. Operational.**

It should not feel:

**Playful. Corporate-dashboard-heavy. Marketing-heavy. Over-animated.**

The intended experience is:

> A field officer can open the application, immediately understand where they are, enter a NOPOL, and recognize the result without having to interpret the interface.

That is the primary success criterion of this Design System.

---

# 51. Approval

This specification has been reviewed and approved for Phase 8 implementation.

Implementation agents must treat this document as the UI/UX contract.

Any material deviation must be explicitly surfaced for review rather than silently introduced.
