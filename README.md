# 🎓 Sablayan National Comprehensive High School — Online Enrollment System

A complete, production-ready **Online Enrollment Module** for
**Sablayan National Comprehensive High School** (DepEd School ID **301596**,
Sto. Niño, Sablayan, Occidental Mindoro — fb.com/sabnahisofficial2026) with a modern
school-portal design: full-screen campus background, centered white card landing page,
multi-step student application with draft saving, early registration for returning
students, and a full **Admin Panel** (registrar, cashier, adviser, super admin).

**Stack:** Node.js · Express 5 · EJS · SQLite (better-sqlite3) · Bootstrap 5 · Chart.js

---

## ✨ Features

### Public / Student side
- **Landing page** — campus background photo + centered white rounded card with logo,
  school name, “Online Enrollment Module” title, *Please Read* instructions,
  Username/LRN + Password fields, green **Enroll Here** and blue **Log In** buttons,
  and *Forgot your password? Click Here*.
- **Account registration** (new & transferee) with **email verification**
  (demo mode writes the email to `data/mail.log` and shows the link on screen).
- **Multi-step enrollment form** with draft saving:
  1. Student personal info (incl. **12-digit LRN validation**, PSA birth cert no.)
  2. Parent / guardian info (mother, father, optional guardian)
  3. Educational background (new / transferee fields + reason for transferring)
  4. Grade level (7–12) + SHS strand (**STEM, ABM, HUMSS, GAS, TVL**) + live fee preview
  5. Requirements upload (PSA, Form 138/137, good moral, completion cert, ID photo)
  → Review & Submit → generates an **Enrollment Reference Number** (`ENR-2026-00000x`)
- **Student dashboard** — status tracker timeline
  (*Submitted → Under Review → Approved/For Assessment → Enrolled*), notifications,
  printable summary/assessment, payment upload, schedule confirmation and
  **Certificate of Registration** printing.
- **Early registration** for returning students (LRN login): grade promotion confirm,
  contact update, strand selection (G10→G11), section choice with live slots,
  fee assessment, deposit-slip / online-reference payment, printable COR.

### Admin panel
| Area | What it does |
|---|---|
| **Dashboard** | Stats (total enrollees, pending, payments to verify, enrolled) + charts per grade/type/status + recent activity |
| **Applicants** | Search/filter (grade, strand, type, status), full profile + documents, **Approve / Reject / Return for Correction** with remarks, section assignment, **bulk approve**, CSV export, print |
| **Enrollment Mgmt** | Open/close enrollment periods (new & early) with dates, section capacity & adviser, assign unassigned students to sections |
| **Academic Setup** | CRUD: grade levels, sections, strands, subjects, school years, grading periods, fee structure |
| **Requirements Mgr** | Required documents per enrollment type / grade scope |
| **Payments** | Cashier verifies deposit slips & payment references → auto-enrolls approved students |
| **Reports** | By grade / section / strand, **class lists**, collection report, status summary — printable + CSV (Excel) |
| **Users & Roles** | Super Admin, Registrar, Cashier/Finance, Adviser — permission-gated routes |
| **Settings** | School name, tagline, address, contact, colors, logo/background image paths, landing instructions, deadline |
| **Audit Log** | Every admin action recorded (filterable, CSV export) |

### Security
- scrypt password hashing (per-user salt, timing-safe compare)
- Login **attempt limiting** — account locks 15 min after 5 failures + per-IP rate limit
- Session handling in SQLite (`sessions` table), httpOnly + SameSite=Lax cookies,
  same-origin check on state-changing requests
- LRN format validation (12 digits, unique)
- File uploads validated by **magic bytes** (PDF/JPG/PNG only), 5 MB limit,
  random filenames, served only through authenticated owner/staff routes
- Role-based access control (`super_admin`, `registrar`, `cashier`, `adviser`, `applicant`)
- Audit logging of login, approvals, settings changes, deletions, etc.

---

## 🚀 Setup Guide

**Requirements:** Node.js 18+ (tested on Node 22). No MySQL/PHP needed — the database
is SQLite and is created automatically.

```bash
# 1. Install dependencies
npm install

# 2. (Optional) configure environment
cp .env.example .env        # then edit PORT / SESSION_SECRET for production

# 3. Start the server (auto-creates data/sabnahis.db from database/sabnahis.sql)
npm start
```

Open **http://localhost:3000** — the database, seed data and demo accounts are
initialized on first boot.

```bash
npm run dev          # auto-reload on changes (node --watch)
npm run db:reset -- --yes   # drop & re-seed the database
```

### 🗄 Database deliverable
- `database/sabnahis.sql` — full **schema + seed data** (grade levels 7–12, strands,
  sections, subjects, fees, requirements, periods, settings).
  It is imported automatically on first start; you can also import manually:
  `sqlite3 data/sabnahis.db < database/sabnahis.sql`

### 🔑 Default accounts

| Role | Username | Password |
|---|---|---|
| Super Admin | `admin` | `Admin@2026` |
| Registrar | `registrar` | `Registrar@2026` |
| Cashier / Finance | `cashier` | `Cashier@2026` |
| Adviser (Grade 7 – Rizal) | `adviser` | `Adviser@2026` |
| Returning student (LRN login) | `123456789012` | `Student@2026` |
| Grade 10 student (early reg) | `987654321098` | `Student@2026` |

> ⚠️ Change these passwords in **Admin → Users** before going live, and set a strong
> `SESSION_SECRET` in `.env`.

---

## 🖼 Branding / Images

Replace these files with your own school assets (or edit the paths in
**Admin → Settings**):

| Asset | Path |
|---|---|
| School logo | `public/images/logo.png` *(recreated replica of the official seal — replace with your official PNG if preferred)* |
| Campus background (landing) | `public/images/campus-bg.jpg` |
| School entrance photo | `public/images/entrance.jpg` |

The seeded branding uses the real school details (name, *"Your School of Choice!"*,
School ID 301596, Sto. Niño Sablayan address, contact 0950 039 4012). School name,
tagline, colors, contact info, deadline and the *Please Read* instructions are all
editable in **Admin → Settings** (no code changes needed).

---

## 📁 Project structure

```
├── server.js                  # entry point
├── database/sabnahis.sql      # schema + seed (deliverable)
├── scripts/reset-db.js        # db reset helper
├── src/
│   ├── app.js                 # express wiring, sessions, flash, error handler
│   ├── config.js              # env-driven config & security limits
│   ├── db.js                  # sqlite bootstrap + demo password seeding
│   ├── session-store.js       # SQLite session store
│   ├── middleware/
│   │   ├── auth.js            # guards, permissions, login/rate-limit logic
│   │   └── upload.js          # multer + magic-byte validation
│   ├── routes/
│   │   ├── public.js          # landing, login, register, verify, reset
│   │   ├── student.js         # dashboard, notifications, early reg, payments, prints
│   │   ├── enroll.js          # multi-step application form
│   │   ├── admin.js           # dashboard, applicants, payments, enrollment mgmt
│   │   ├── admin-setup.js     # academic, requirements, users, reports, settings, audit
│   │   └── files.js           # authenticated document downloads
│   └── utils/                 # crypto (scrypt), helpers, queries, mailer
├── views/                     # EJS templates (public, auth, enroll, student, admin, print)
├── public/                    # css, js, vendored bootstrap + chart.js, images
├── uploads/                   # stored documents (random names; gitignored)
└── data/                      # sqlite db + mail.log (gitignored)
```

---

## ⚙️ Configuration reference (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | set `production` in deployment |
| `SESSION_SECRET` | dev fallback | **change in production** |
| `DB_PATH` | `./data/sabnahis.db` | database location |
| `UPLOADS_DIR` | `./uploads` | document storage |

Upload limit (5 MB), lockout policy (5 attempts / 15 min) and allowed file types are
defined in `src/config.js`.

## 📧 Email / SMS

Outgoing mail (verification, password reset) is written to **`data/mail.log`** and the
link is shown on-screen in demo mode — plug in nodemailer/your SMS provider in
`src/utils/mailer.js` for production.

## 🧪 Tested flows

- New student: register → verify → 5-step form → upload → submit → registrar review →
  approve (section assigned) → deposit-slip payment → cashier verifies → **enrolled** →
  confirm schedule → **print COR**
- Returning student: LRN login → early registration (strand + section slots) →
  submit with online payment reference → approve → verify → enrolled → COR
- Return-for-correction cycle, bulk approve, CSV exports, role permissions,
  account lockout, upload sniffing, cross-student file access denial.
