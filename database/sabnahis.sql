-- ============================================================================
-- SABNAHIS — High School Online Enrollment System
-- Database schema + seed data (SQLite dialect)
--
-- Deliverable: database/sabnahis.sql
-- Import with:  sqlite3 data/sabnahis.db < database/sabnahis.sql
-- (The app auto-runs this file on first start, see src/db.js)
-- ============================================================================

PRAGMA foreign_keys = ON;

BEGIN;

-- ----------------------------------------------------------------------------
-- Core tables
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id        TEXT    NOT NULL UNIQUE,          -- username OR LRN (returning students)
  email           TEXT    UNIQUE,                   -- used for verification / password reset
  password_hash   TEXT    NOT NULL,                 -- scrypt: scrypt$salt$hash
  full_name       TEXT    NOT NULL,
  role            TEXT    NOT NULL DEFAULT 'applicant'
                    CHECK (role IN ('super_admin','registrar','cashier','adviser','applicant')),
  status          TEXT    NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled')),
  email_verified  INTEGER NOT NULL DEFAULT 0,
  verify_token    TEXT,
  reset_token     TEXT,
  reset_expires   TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  last_login      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS grade_levels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,                 -- e.g. G7, G11
  name        TEXT NOT NULL,                        -- e.g. Grade 7
  department  TEXT NOT NULL DEFAULT 'jhs' CHECK (department IN ('jhs','shs')),
  order_no    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS strands (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  code    TEXT NOT NULL UNIQUE,                     -- STEM, ABM, HUMSS, GAS, TVL
  name    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS school_years (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,                 -- e.g. 2026-2027
  start_date  TEXT,
  end_date    TEXT,
  is_current  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS grading_periods (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  school_year_id INTEGER NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,                     -- Quarter 1 .. Quarter 4
  order_no       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,                     -- e.g. Rizal
  grade_level_id INTEGER NOT NULL REFERENCES grade_levels(id) ON DELETE CASCADE,
  strand_id      INTEGER REFERENCES strands(id) ON DELETE SET NULL,
  capacity       INTEGER NOT NULL DEFAULT 45,
  adviser_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (grade_level_id, name)
);

CREATE TABLE IF NOT EXISTS subjects (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT,
  name           TEXT NOT NULL,
  grade_level_id INTEGER NOT NULL REFERENCES grade_levels(id) ON DELETE CASCADE,
  strand_id      INTEGER REFERENCES strands(id) ON DELETE SET NULL,  -- NULL = all strands
  units          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS enrollment_periods (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  label          TEXT NOT NULL,                     -- e.g. "Early Registration (Returning)"
  type           TEXT NOT NULL CHECK (type IN ('new','early')),
  school_year_id INTEGER NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  opens_at       TEXT,
  closes_at      TEXT,
  is_open        INTEGER NOT NULL DEFAULT 0
);

-- Fee structure (per grade level / strand / school year)
CREATE TABLE IF NOT EXISTS fees (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'miscellaneous'
                   CHECK (category IN ('tuition','miscellaneous','laboratory','uniform','books','other')),
  amount         REAL NOT NULL DEFAULT 0,
  grade_level_id INTEGER REFERENCES grade_levels(id) ON DELETE CASCADE,  -- NULL = applies to all
  strand_id      INTEGER REFERENCES strands(id) ON DELETE SET NULL,
  school_year_id INTEGER REFERENCES school_years(id) ON DELETE CASCADE,  -- NULL = applies to all
  is_active      INTEGER NOT NULL DEFAULT 1
);

-- Required documents per enrollment type / grade level
CREATE TABLE IF NOT EXISTS requirements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type      TEXT NOT NULL UNIQUE,               -- psa, report_card, good_moral, completion, id_photo
  label         TEXT NOT NULL,
  applies_to    TEXT NOT NULL DEFAULT 'all',        -- csv: new,transferee,returning,all
  grade_scope   TEXT NOT NULL DEFAULT 'all',        -- csv: G7,G11,all...
  is_required   INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

-- ----------------------------------------------------------------------------
-- Accounts (applicants) & enrollment records
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS students (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  lrn                TEXT UNIQUE,                   -- 12 digits; NULL until assigned (new students)
  first_name         TEXT NOT NULL,
  middle_name        TEXT,
  last_name          TEXT NOT NULL,
  suffix             TEXT,
  birthdate          TEXT,
  gender             TEXT CHECK (gender IN ('male','female')),
  civil_status       TEXT,
  nationality        TEXT DEFAULT 'Filipino',
  religion           TEXT,
  contact_number     TEXT,
  home_address       TEXT,
  psa_birth_cert_no  TEXT,
  enrollment_type    TEXT NOT NULL DEFAULT 'new'
                       CHECK (enrollment_type IN ('new','transferee','returning')),
  current_grade_level_id INTEGER REFERENCES grade_levels(id) ON DELETE SET NULL,  -- for returning students
  photo_path         TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT
);

CREATE TABLE IF NOT EXISTS guardians (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  relationship   TEXT NOT NULL CHECK (relationship IN ('mother','father','guardian')),
  first_name     TEXT NOT NULL,
  middle_name    TEXT,
  last_name      TEXT NOT NULL,
  occupation     TEXT,
  contact_number TEXT,
  email          TEXT,
  address        TEXT
);

CREATE TABLE IF NOT EXISTS education_background (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id          INTEGER NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
  last_school_name    TEXT,
  last_school_address TEXT,
  school_year_graded  TEXT,                          -- e.g. 2025-2026
  general_average     TEXT,                          -- e.g. 88 or 88.5
  grade_completed     TEXT,                          -- e.g. Grade 6 / Grade 10
  reason_for_transfer TEXT
);

CREATE TABLE IF NOT EXISTS enrollments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  school_year_id INTEGER NOT NULL REFERENCES school_years(id),
  grade_level_id INTEGER NOT NULL REFERENCES grade_levels(id),
  strand_id      INTEGER REFERENCES strands(id) ON DELETE SET NULL,
  section_id     INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  type           TEXT NOT NULL DEFAULT 'application' CHECK (type IN ('application','early')),
  status         TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','submitted','under_review','returned',
                                     'approved','enrolled','rejected')),
  reference_no   TEXT UNIQUE,
  remarks        TEXT,                               -- latest registrar remarks
  schedule_confirmed INTEGER NOT NULL DEFAULT 0,
  submitted_at   TEXT,
  approved_at    TEXT,
  enrolled_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT,
  UNIQUE (student_id, school_year_id, type)
);
CREATE INDEX IF NOT EXISTS idx_enrollments_status ON enrollments(status);

CREATE TABLE IF NOT EXISTS enrollment_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,
  remarks       TEXT,
  changed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  doc_type      TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL,                       -- random filename in uploads/docs
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  remarks       TEXT,
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (student_id, doc_type)
);

CREATE TABLE IF NOT EXISTS payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id  INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  student_id     INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount         REAL NOT NULL DEFAULT 0,
  method         TEXT NOT NULL DEFAULT 'deposit_slip'
                   CHECK (method IN ('deposit_slip','online_reference')),
  reference_no   TEXT,                               -- ORS / online payment reference
  slip_stored_name TEXT,                             -- uploaded proof file
  slip_original_name TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','verified','rejected')),
  remarks        TEXT,
  verified_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  verified_at    TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  link       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name  TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  details    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at INTEGER NOT NULL
);

-- ----------------------------------------------------------------------------
-- Seed data
-- ----------------------------------------------------------------------------

-- Settings ------------------------------------------------------------------
INSERT OR IGNORE INTO settings(key, value) VALUES
  ('school_name',        'Sablayan National Comprehensive High School'),
  ('school_tagline',     'Your School of Choice! • School ID 301596'),
  ('system_title',       'Online Enrollment Module'),
  ('school_address',     'Sto. Niño, Sablayan, Occidental Mindoro, Philippines'),
  ('school_contact',     '0950 039 4012  •  fb.com/sabnahisofficial2026  •  enroll@sabnahis.edu.ph'),
  ('primary_color',      '#15803d'),
  ('logo_path',          '/images/logo.png'),
  ('campus_bg_path',     '/images/campus-bg.jpg'),
  ('entrance_path',      '/images/entrance.jpg'),
  ('instructions',       'NEW students (Grade 7 & Grade 11) and TRANSFEREE students must create an account by clicking "Enroll Here". Students who already created an account (including returning students — use your 12-digit LRN as username) should click "Log In".'),
  ('enrollment_deadline', '2026-10-30'),
  ('currency',           'PHP');

-- School years --------------------------------------------------------------
INSERT OR IGNORE INTO school_years(id, name, start_date, end_date, is_current) VALUES
  (1, '2025-2026', '2025-06-02', '2026-03-27', 0),
  (2, '2026-2027', '2026-06-01', '2027-03-26', 1);

INSERT OR IGNORE INTO grading_periods(id, school_year_id, name, order_no) VALUES
  (1, 2, 'Quarter 1', 1), (2, 2, 'Quarter 2', 2),
  (3, 2, 'Quarter 3', 3), (4, 2, 'Quarter 4', 4),
  (5, 1, 'Quarter 1', 1), (6, 1, 'Quarter 2', 2),
  (7, 1, 'Quarter 3', 3), (8, 1, 'Quarter 4', 4);

-- Grade levels --------------------------------------------------------------
INSERT OR IGNORE INTO grade_levels(id, code, name, department, order_no) VALUES
  (1, 'G7',  'Grade 7',  'jhs', 1),
  (2, 'G8',  'Grade 8',  'jhs', 2),
  (3, 'G9',  'Grade 9',  'jhs', 3),
  (4, 'G10', 'Grade 10', 'jhs', 4),
  (5, 'G11', 'Grade 11', 'shs', 5),
  (6, 'G12', 'Grade 12', 'shs', 6);

-- Strands -------------------------------------------------------------------
INSERT OR IGNORE INTO strands(id, code, name) VALUES
  (1, 'STEM',  'Science, Technology, Engineering & Mathematics'),
  (2, 'ABM',   'Accountancy, Business & Management'),
  (3, 'HUMSS', 'Humanities & Social Sciences'),
  (4, 'GAS',   'General Academic Strand'),
  (5, 'TVL',   'Technical-Vocational-Livelihood');

-- Sections (capacity 45 default) -------------------------------------------
INSERT OR IGNORE INTO sections(id, name, grade_level_id, strand_id, capacity) VALUES
  (1, 'Rizal',      1, NULL, 45), (2, 'Bonifacio', 1, NULL, 45), (3, 'Mabini',   1, NULL, 45),
  (4, 'Sampaguita', 2, NULL, 45), (5, 'Ilang-Ilang',2, NULL, 45),
  (6, 'Narra',      3, NULL, 45), (7, 'Acacia',    3, NULL, 45),
  (8, 'Molave',     4, NULL, 45), (9, 'Ipil',       4, NULL, 45),
  (10,'Laurel',     5, 1, 40),  (11, 'Aguinaldo', 5, 1, 40),
  (12,'Mabini',     5, 2, 40),  (13, 'Quezon',    5, 3, 40),
  (14,'Kalayaan',   6, 1, 40),  (15, 'Katipunan', 6, 2, 40);

-- Subjects (JHS core + SHS core/strand-specific) ----------------------------
INSERT OR IGNORE INTO subjects(code, name, grade_level_id, strand_id, units) VALUES
  -- Grade 7
  ('MA7',    'Mathematics 7', 1, NULL, 1), ('SCI7','Science 7', 1, NULL, 1),
  ('ENG7',   'English 7', 1, NULL, 1),     ('FIL7','Filipino 7', 1, NULL, 1),
  ('SOC7',   'Araling Panlipunan 7', 1, NULL, 1), ('MAPEH7','MAPEH 7', 1, NULL, 1),
  ('TLE7',   'Technology & Livelihood Education 7', 1, NULL, 1), ('VAL7','Values Education 7', 1, NULL, 1),
  -- Grade 8
  ('MA8',    'Mathematics 8', 2, NULL, 1), ('SCI8','Science 8', 2, NULL, 1),
  ('ENG8',   'English 8', 2, NULL, 1),     ('FIL8','Filipino 8', 2, NULL, 1),
  ('SOC8',   'Araling Panlipunan 8', 2, NULL, 1), ('MAPEH8','MAPEH 8', 2, NULL, 1),
  ('TLE8',   'Technology & Livelihood Education 8', 2, NULL, 1), ('VAL8','Values Education 8', 2, NULL, 1),
  -- Grade 9
  ('MA9',    'Mathematics 9', 3, NULL, 1), ('SCI9','Science 9', 3, NULL, 1),
  ('ENG9',   'English 9', 3, NULL, 1),     ('FIL9','Filipino 9', 3, NULL, 1),
  ('SOC9',   'Araling Panlipunan 9', 3, NULL, 1), ('MAPEH9','MAPEH 9', 3, NULL, 1),
  ('TLE9',   'Technology & Livelihood Education 9', 3, NULL, 1), ('VAL9','Values Education 9', 3, NULL, 1),
  -- Grade 10
  ('MA10',   'Mathematics 10', 4, NULL, 1), ('SCI10','Science 10', 4, NULL, 1),
  ('ENG10',  'English 10', 4, NULL, 1),    ('FIL10','Filipino 10', 4, NULL, 1),
  ('SOC10',  'Araling Panlipunan 10', 4, NULL, 1), ('MAPEH10','MAPEH 10', 4, NULL, 1),
  ('TLE10',  'Technology & Livelihood Education 10', 4, NULL, 1), ('VAL10','Values Education 10', 4, NULL, 1),
  -- Grade 11 core
  ('OC11',   'Oral Communication', 5, NULL, 1), ('GM11','General Mathematics', 5, NULL, 1),
  ('PD11',   'Personal Development', 5, NULL, 1), ('PAN11','Pagbata at Pananaliksik', 5, NULL, 1),
  ('UTS11',  'Understanding Culture & Society', 5, NULL, 1),
  -- Grade 11 STEM
  ('STEM1',  'Earth & Life Science (STEM)', 5, 1, 1), ('STEM2','Pre-Calculus (STEM)', 5, 1, 1),
  -- Grade 11 ABM
  ('ABM1',   'Business Mathematics (ABM)', 5, 2, 1), ('ABM2','Organization & Management (ABM)', 5, 2, 1),
  -- Grade 11 HUMSS
  ('HUM1',   'Introduction to Philosophy (HUMSS)', 5, 3, 1), ('HUM2','Discipline & Ideas (HUMSS)', 5, 3, 1),
  -- Grade 11 GAS/TVL
  ('GAS1',   'Statistics & Probability (GAS)', 5, 4, 1),
  ('TVL1', 'Food & Beverage Services (TVL)', 5, 5, 1), ('TVL2','Industrial Arts (TVL)', 5, 5, 1),
  -- Grade 12 core
  ('STS12',  'Research Project (CAP)', 6, NULL, 1), ('PR12','Practical Research 1', 6, NULL, 1),
  ('GM12',   'General Mathematics 12', 6, NULL, 1),
  -- Grade 12 STEM
  ('STEM3',  'General Chemistry 1 (STEM)', 6, 1, 1), ('STEM4','Physics (STEM)', 6, 1, 1),
  -- Grade 12 ABM
  ('ABM3',   'Business Finance (ABM)', 6, 2, 1),
  -- Grade 12 HUMSS
  ('HUM3',   'Gender & Society (HUMSS)', 6, 3, 1),
  -- Grade 12 GAS/TVL
  ('GAS2', 'Applied Economics (GAS)', 6, 4, 1), ('TVL3','Home Economics (TVL)', 6, 5, 1);

-- Fee structure -------------------------------------------------------------
INSERT OR IGNORE INTO fees(name, category, amount, grade_level_id, strand_id, school_year_id, is_active) VALUES
  ('Tuition Fee',            'tuition',        8500, 1, NULL, 2, 1),
  ('Tuition Fee',            'tuition',        8500, 2, NULL, 2, 1),
  ('Tuition Fee',            'tuition',        8500, 3, NULL, 2, 1),
  ('Tuition Fee',            'tuition',        8500, 4, NULL, 2, 1),
  ('Tuition Fee',            'tuition',       10500, 5, NULL, 2, 1),
  ('Tuition Fee',            'tuition',       10500, 6, NULL, 2, 1),
  ('Miscellaneous Fee',      'miscellaneous',  1800, 1, NULL, 2, 1),
  ('Miscellaneous Fee',      'miscellaneous',  1800, 2, NULL, 2, 1),
  ('Miscellaneous Fee',      'miscellaneous',  1900, 3, NULL, 2, 1),
  ('Miscellaneous Fee',      'miscellaneous',  1900, 4, NULL, 2, 1),
  ('Miscellaneous Fee',      'miscellaneous',  2200, 5, NULL, 2, 1),
  ('Miscellaneous Fee',      'miscellaneous',  2200, 6, NULL, 2, 1),
  ('Laboratory Fee',         'laboratory',      900, 5, 1, 2, 1),
  ('Laboratory Fee',         'laboratory',      900, 5, 5, 2, 1),
  ('Laboratory Fee',         'laboratory',      900, 6, 1, 2, 1),
  ('Laboratory Fee',         'laboratory',      900, 6, 5, 2, 1),
  ('School Uniform (2 sets)', 'uniform',       1450, NULL, NULL, 2, 1),
  ('Learning Materials & Books', 'books',      1100, NULL, NULL, 2, 1);

-- Requirements --------------------------------------------------------------
INSERT OR IGNORE INTO requirements(id, doc_type, label, applies_to, grade_scope, is_required, sort_order) VALUES
  (1, 'psa',          'PSA Birth Certificate',            'new',                    'all',   1, 1),
  (2, 'report_card',  'Report Card (Form 138/137)',      'new,transferee,returning','all',  1, 2),
  (3, 'good_moral',   'Certificate of Good Moral Character','transferee',           'all',   1, 3),
  (4, 'completion',   'Certificate of Completion (Grade 6 / Grade 10)', 'new,transferee', 'G7,G11,G10', 1, 4),
  (5, 'id_photo',     '1x1 or 2x2 ID Photo',             'all',                    'all',   1, 5),
  (6, 'form137',      'Form 137 (Transferee Records)',   'transferee',             'all',   0, 6);

-- Enrollment periods --------------------------------------------------------
INSERT OR IGNORE INTO enrollment_periods(id, label, type, school_year_id, opens_at, closes_at, is_open) VALUES
  (1, 'Regular Enrollment — New & Transferee Students', 'new',   2, '2026-04-01', '2026-10-30', 1),
  (2, 'Early Registration — Returning Students',        'early', 2, '2026-04-01', '2026-09-30', 1);

-- Staff accounts (passwords are scrypt hashes; see README for credentials) --
INSERT OR IGNORE INTO users(login_id, email, password_hash, full_name, role, status, email_verified) VALUES
  ('admin',    'admin@sabnahis.edu.ph',    'scrypt$3f1c0d5a7b9e4c2d$0f3a1c9d8e7b6a5f4e3d2c1b0a99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa', 'Juan Dela Cruz (Super Admin)', 'super_admin', 'active', 1),
  ('registrar', 'registrar@sabnahis.edu.ph', 'scrypt$8b2e4f6a1c3d5e7f$1a2b3c4d5e6f708192a3b4c5d6e7f809182736455463728190a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff0011223344556677889900aabbccddeeff001122', 'Maria Santos (Registrar)',      'registrar',  'active', 1),
  ('cashier',   'cashier@sabnahis.edu.ph',   'scrypt$9c3d5e7f2a4b6d8e$2b3c4d5e6f708192a3b4c5d6e7f809182736455463728190a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff0011223344556677889900aabbccddeeff001122', 'Roberto Reyes (Cashier)',       'cashier',    'active', 1),
  ('adviser',   'adviser@sabnahis.edu.ph',   'scrypt$a1b2c3d4e5f60718$3c4d5e6f708192a3b4c5d6e7f809182736455463728190a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff0011223344556677889900aabbccddeeff001122', 'Ana Lim (Adviser — Grade 7 Rizal)', 'adviser', 'active', 1);

-- NOTE: the placeholder hashes above are replaced at first boot by scripts/
-- ensure-seed-hashes.js ONLY if they fail verification. The app seeds the real
-- hashes on first start (see src/db.js → seedStaffPasswords).

-- Sample returning student (LRN login) -------------------------------------
INSERT OR IGNORE INTO users(login_id, email, password_hash, full_name, role, status, email_verified) VALUES
  ('123456789012', 'kdelacruz@student.sabnahis.edu.ph',
   'scrypt$PLACEHOLDER$PLACEHOLDER',
   'Katrina Dela Cruz', 'applicant', 'active', 1);

INSERT OR IGNORE INTO students(user_id, lrn, first_name, middle_name, last_name, birthdate, gender,
  civil_status, nationality, religion, contact_number, home_address, psa_birth_cert_no, enrollment_type)
VALUES (LAST_INSERT_ROWID(), '123456789012', 'Katrina', 'Reyes', 'Dela Cruz', '2011-03-14', 'female',
  'single', 'Filipino', 'Catholic', '09171234567', '45 Bonifacio St., Imus, Cavite', '1234-5678-9012-3456', 'returning');

-- Bind the sample student user id explicitly (safety for re-runs)
UPDATE students SET user_id = (SELECT id FROM users WHERE login_id='123456789012')
 WHERE lrn='123456789012';

-- Attach adviser to Grade 7 – Rizal
UPDATE sections SET adviser_id = (SELECT id FROM users WHERE login_id='adviser') WHERE id = 1;

-- Sample Grade 10 returning student ready for early registration to Grade 11
INSERT OR IGNORE INTO users(login_id, email, password_hash, full_name, role, status, email_verified) VALUES
  ('987654321098', 'jsantos@student.sabnahis.edu.ph',
   'scrypt$PLACEHOLDER$PLACEHOLDER',
   'Joel Santos', 'applicant', 'active', 1);

INSERT OR IGNORE INTO students(user_id, lrn, first_name, middle_name, last_name, birthdate, gender,
  civil_status, nationality, religion, contact_number, home_address, psa_birth_cert_no, enrollment_type)
VALUES (LAST_INSERT_ROWID(), '987654321098', 'Joel', 'Cruz', 'Santos', '2010-07-22', 'male',
  'single', 'Filipino', 'Catholic', '09181234567', '78 Mabini St., Dasmariñas, Cavite', '9876-5432-1098-7654', 'returning');

UPDATE students SET user_id = (SELECT id FROM users WHERE login_id='987654321098')
 WHERE lrn='987654321098';

-- Current grade levels for the seeded returning students (SY 2026-2027)
UPDATE students SET current_grade_level_id = (SELECT id FROM grade_levels WHERE code='G8')
 WHERE lrn='123456789012';
UPDATE students SET current_grade_level_id = (SELECT id FROM grade_levels WHERE code='G10')
 WHERE lrn='987654321098';

COMMIT;

-- Note on demo passwords (also documented in README.md):
--   admin / Admin@2026        — Super Admin (full access)
--   registrar / Registrar@2026 — Registrar (applicants, enrollment, academics, reports)
--   cashier / Cashier@2026     — Cashier/Finance (payments, collection reports)
--   adviser / Adviser@2026     — Adviser (class lists of assigned section)
--   123456789012 / Student@2026 — returning student Katrina Dela Cruz (LRN login)
--   987654321098 / Student@2026 — Grade 10 student Joel Santos (early registration)
-- Real scrypt hashes for these are written on first start by src/db.js.
