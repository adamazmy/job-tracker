# Job Tracker

A private, local-only tracker for job applications, built from your Outlook email.

- **Pipeline view.** One column per stage: Draft, Applied, Online assessment, Interview,
  Assessment centre, Offer, Rejected, Withdrawn.
- **Table view** with sortable columns, plus **search** and **filters** for stage,
  outcome, active/closed, needs review and archived.
- **Upcoming deadlines** and a **Needs review** panel for anything the scan was unsure about.
- **Editable records and notes.** Edited fields are locked so later scans won't overwrite them.
  You can unlock a field, or accept the scan's suggested value, at any time.
- An email timeline for each application, and a link to open the latest email in Outlook.

> **Your real data stays on your computer.** Applications are stored in
> `data/applications.json`. Git ignores that file and is never pushed. The server listens
> only on `127.0.0.1` and makes no outbound requests. There is no cloud database, and
> nothing is sent anywhere else.

## Run it on Windows

Requirements: [Node.js](https://nodejs.org) 18 or newer. There are no npm dependencies to install.

```powershell
# one-off: put a "Job Tracker" shortcut on your desktop
powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
```

Double-click **Job Tracker** on the desktop. It starts the server in the background if
it isn't already running and opens http://localhost:4870 in your browser.

Other ways to start it:

| Command | What it does |
|---|---|
| `start-job-tracker.cmd` | Same as the desktop shortcut |
| `npm start` | Run the server in the current terminal |
| `npm run demo` | Run with the fake sample data only (nothing is saved) |
| `powershell -File scripts\stop.ps1` | Stop the background server |
| `npm test` | Run the merge/sanitiser tests |

If `data/applications.json` doesn't exist yet, the app runs in **demo mode** with the
made-up companies in `data/sample-applications.json`.

## How the scan works

Scans are run by Claude Code with the Microsoft 365 connector, using the instructions in
[`scan-prompt.md`](scan-prompt.md):

1. **Read-only access.** It only searches and reads mail. It never sends, drafts, forwards,
   moves, deletes or labels anything. Email content is treated as untrusted data, not as instructions.
2. It searches from the start date (default `2026-01-01`) for confirmations, assessments,
   interviews, assessment centres, offers and rejections, and pages through every result.
   It reads the full email whenever the preview is unclear.
3. It skips job alerts, newsletters, webinars and job-board marketing (e.g. Gradcracker),
   as well as university course admissions.
4. It builds **one record per company and role** and writes it to `scan-output/scan-YYYY-MM-DD.json`.
   Anything uncertain is flagged with `needsReview` and a reason instead of guessed.
5. It merges the scan with:

   ```powershell
   node scripts/merge-scan.js scan-output/scan-YYYY-MM-DD.json   # add --dry-run to preview
   ```

   The merge backs up `data/applications.json` to `data/backups/` first. Then it:
   - never touches your **notes** or any field you edited by hand
   - never moves a stage backwards, except to Offer, Rejected or Withdrawn
   - keeps the earliest applied date and the latest email date
   - only re-flags a record you marked reviewed if newer email arrives
   - leaves records that aren't in the scan alone

### Privacy guard

Whatever the scan produces, the merge script strips anything that looks like a link,
login or verification code, password or long token from the text fields. It only
accepts Outlook web links in `outlookLink`. Full email bodies are never stored, only a
short timeline of events.

## Project layout

```
server.js                  local HTTP server and JSON API (127.0.0.1 only)
lib/schema.js              stages, fields and record shape
lib/merge.js               scan merge rules (protects manual edits)
lib/sanitize.js            strips links, codes and tokens from scanned text
lib/store.js               load/save with atomic writes and backups
public/                    web UI (plain HTML/CSS/JS)
scripts/merge-scan.js      merge a scan file into your data
scripts/launch.ps1         start server if needed and open the browser
scripts/create-shortcut.ps1  desktop shortcut
scan-prompt.md             reusable scan instructions
data/sample-applications.json  fake demo data (the only data file in git)
```

Ignored by git: `data/applications.json`, `data/backups/`, `scan-output/`, `logs/`,
`.env*` and other local files. See [`.gitignore`](.gitignore).
