# PDF → DOC Conversion Monitoring Dashboard

Stakeholder visibility for the daily PDF-to-Word batch conversion pipeline.

---

## Architecture

```
Angular Dashboard (port 4200)  ←→  Express API (port 3000)
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              │                          │                           │
    sftp-download.js           watch-conversion.js        move-to-final.js
    (Step 1: auto)             (Step 2+3: auto watcher)   (Step 4: manual trigger)
                                                                     │
                                                          send-notification.js
                                                          (Step 5: auto after move)
```

## Daily Folder Layout (local machine)

```
C:\PDF-Conversion\
└── 2026-03-29\                    ← created automatically
    ├── Scanned PDF\               ← scanned PDFs (image-only)
    ├── output-with-datetime\      ← digital PDFs  ← Adobe Acrobat input
    ├── converted_raw\             ← Adobe Acrobat output (DOCX files)
    ├── final_conversion\          ← final delivery folder
    └── reports\                   ← Excel logs (PDF-DOC-Report-YYYY-MM-DD.xlsx)
```

---

## Setup

### 1 — Backend

```bash
cd backend
cp .env.example .env          # fill in SFTP, email, local path settings
npm install
node server.js                # starts API on http://localhost:3000
```

### 2 — Angular Dashboard

```bash
# from project root
npm install
npm start                     # opens http://localhost:4200
```

---

## Daily Workflow

| Step | Who | How |
|------|-----|-----|
| **1. SFTP Download** | Operator / scheduled | Click **SFTP Download** button in dashboard (or `npm run download` in backend/) |
| **2. Start Watcher** | Operator | Click **Start Watcher** button — keeps running in background |
| **3. Adobe Conversion** | Operator | Open Adobe Acrobat Pro → run Action on `output-with-datetime/` → output to `converted_raw/` |
| **4. Quality Check** | Automatic | Watcher detects new DOCX files → runs ligature check → updates dashboard |
| **5. Move to Final** | Operator | Click **Move to Final** button once conversion is done |
| **6. Email Notification** | Automatic | Triggers automatically after move-to-final |

---

## Excel Report Columns

| Column | Description |
|--------|-------------|
| PDF Name | Original filename |
| Size (KB) | File size |
| Total Pages | Page count (from PDF metadata) |
| Scanned PDF | **Yes** if avg extractable text < 50 chars/page |
| Downloaded At | SFTP download timestamp |
| Download Status | completed / failed |
| Conversion Status | pending / completed (Adobe output detected) |
| Quality Check | passed / failed |
| Ligatures Found | Count of unresolved ligature chars (ﬁﬂﬀ…) |
| Final Status | completed once moved to final_conversion/ |

---

## Backend Scripts (can also run standalone)

```bash
cd backend

# Step 1 – Download from SFTP
node scripts/sftp-download.js

# Step 2 – Watch converted_raw for quality checks (run in background)
node scripts/watch-conversion.js

# Step 3 – Move to final + auto-trigger email
node scripts/move-to-final.js

# Step 4 – Re-send email notification
node scripts/send-notification.js
```

---

## Configuration (.env)

```
SFTP_HOST=localhost            # RebexTinyServer host
SFTP_PORT=22
SFTP_USER=tester
SFTP_PASS=password
SFTP_REMOTE_BASE_PATH=/daily   # today's subfolder added automatically

LOCAL_BASE_PATH=C:/PDF-Conversion

EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=you@gmail.com
EMAIL_PASS=app-password        # Gmail App Password (not account password)
EMAIL_TO=stakeholder@company.com
EMAIL_CC=
```
