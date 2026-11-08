# Job Tracker

A private, local-only tracker for job applications, built from your Outlook email.

Every morning, Claude reads my inbox (read-only) for application confirmations, online
assessments, interview invites, offers and rejections. A small Node.js app turns those emails
into a checklist of what to do next and a tracker of where every application stands.

![Today page: overdue and upcoming actions, with a summary of where every application stands](docs/screenshots/today.png)

<details>
<summary>More screenshots</summary>

**All applications:** a progress tracker for each company, with search and filters.

![All applications page with a five-step progress tracker per application](docs/screenshots/all-applications.png)

**Narrow screens:**

<img src="docs/screenshots/phone.png" alt="Today page on a narrow screen" width="320">

</details>

*All screenshots use the made-up sample data in `data/sample-applications.json`.*

- **Today.** A checklist of what to do next:
  - **Overdue**: actions past their deadline.
  - **Coming up**: actions due in the next 7 days, soonest first.
  - **Quick checks**: missing or uncertain details.

  Tick an item when it's done; ticks are saved locally and survive rescans. A new deadline
  from a later email shows up as a new item. Ticking never changes an application's stage.
  The sidebar shows how many applications are at each stage, and the latest news.
- **All applications.** Every application with a five-step tracker (Applied, Test, Interview,
  Final stage, Offer), the next step and when you last heard. Search and the
  **All / Needs me / Waiting / Closed** filters work together. Closed applications show
  where they stopped.
- **Editable details and notes.** Click a row to edit it. Fields you edit are locked so later
  scans won't overwrite them; the panel shows what the latest email says, and you can switch
  back to it.
- Email history for each application, and a link to open the latest email in Outlook.
- Works at phone width, with keyboard support and large tap targets.

> **Your real data stays on your computer.** Applications are stored in
> `data/applications.json`. Git ignores that file and is never pushed. The server listens
> only on `127.0.0.1` and makes no outbound requests. There is no cloud database, and
> nothing is sent anywhere else.

## How it works

```mermaid
flowchart LR
    T["Windows Task Scheduler<br/>07:30 daily"] --> R
    B["Refresh button"] --> R
    R["scripts/run-scan.js"] -->|"prompt + JSON schema"| C["claude -p<br/>(headless Claude Code)"]
    C -->|"search + read only"| O[("Outlook<br/>Microsoft 365 connector")]
    C -->|"structured answer"| V["lib/scan-validate.js<br/>check tools used + every field"]
    V -->|"rejected: nothing saved"| L["logs/scan.log<br/>scan-status.json"]
    V -->|"valid"| M["lib/scan-apply.js + lib/merge.js<br/>skip seen emails, protect your edits"]
    M -->|"backup, then atomic write"| D[("data/applications.json<br/>(never leaves the PC)")]
    D --> S["server.js<br/>127.0.0.1 only"] --> U["Web UI<br/>Today · All applications"]
```

1. **Fetch.** A scheduled task (or the Refresh button) runs `scripts/run-scan.js`. It starts
   Claude Code headless with a prompt built from [`scan-prompt.md`](scan-prompt.md), a summary
   of the existing records and a JSON schema for the answer. Claude is allowed only two tools:
   Outlook search and read. Every send, draft, delete or move tool is explicitly blocked, as are
   shell, file and web access.
2. **Check.** The model's answer is treated as untrusted input. Before anything is saved,
   `lib/scan-validate.js` checks the run's own log: only allowed tools were called, at least one
   Outlook search succeeded, and no blocked MCP server (such as AgentsRoom) was loaded. It then validates every
   field of the answer: stages, dates, lengths, and that the only links are Outlook web links.
   Any failure means nothing is changed, and the page explains what went wrong.
3. **Merge.** Valid results are merged after a backup:
   - emails already processed are skipped by message id
   - fields you edited by hand are locked
   - a stage never moves backwards
   - a reworded but unchanged action keeps its original wording, so a ticked item doesn't reopen
   - anything uncertain is flagged for you to check instead of guessed
4. **Show.** A dependency-free Node server (only accessible from this PC) serves a plain
   HTML/CSS/JS front end. The **Today** page works out what needs doing, from deadlines and
   flags. The rules live in `public/shared.js`, which the browser and the tests both use.

**Design choices**

- **Privacy first.** Real data never leaves the machine and is excluded from git. Email bodies
  aren't stored, only short timeline entries. Text is cleaned of links, login codes and tokens.
- **An LLM for the reading, ordinary code for every decision.** The model only pulls facts out
  of emails into a fixed schema. Validation, merging, deadlines and what counts as overdue are
  normal, tested code (`npm test`).
- **Nothing to install** beyond Node.js and Claude Code, which reduces supply-chain risk and
  maintenance.
- **Accessible.** The UI works with a keyboard, uses large tap targets and works on narrow screens.

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
| `npm test` | Run the tests (merge, Today checklist, scan checks) |

If `data/applications.json` doesn't exist yet, the app runs in **demo mode** with the
made-up companies in `data/sample-applications.json`.

## How the scan works

Scans are run by Claude Code with the Microsoft 365 connector, using the instructions in
[`scan-prompt.md`](scan-prompt.md):

1. **Read-only access.** It only searches and reads mail. It never sends, drafts, forwards,
   moves, deletes or labels anything. Email content is treated as untrusted data, not as instructions.
2. It searches from the start of the current job cycle (`2026-07-01`) for confirmations, assessments,
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
   - skips applications whose first email is before the job-cycle start

   To start a new job cycle, run `node scripts/set-cycle-start.js YYYY-MM-DD` (add `--dry-run`
   to preview). It removes applications that started earlier, after taking a backup. Records
   with your own notes or edits are kept and flagged instead.

### Morning check (automatic)

A Windows scheduled task, **Job Tracker morning check**, runs `scripts/scan.ps1` every day
at 07:30. If the PC is off or asleep then, it runs as soon as it can, as long as you're signed in.
It starts `claude -p` headless from an empty temporary folder, so it uses only your
account's connectors and none of this project's files or folder MCP configs.

- It searches from two days before the last scan. Emails it has already processed are
  skipped by Outlook message id (`data/scan-state.json`).
- **Read-only, checked after the fact:** the run is rejected and nothing is saved if Claude used
  any tool other than Outlook search or read, if an AgentsRoom server was loaded, if no Outlook
  search succeeded, or if the answer fails validation (`lib/scan-validate.js`).
- A good run is merged with the same rules as above, after a backup. A changed next step keeps
  your existing wording when it only rewords the same action, so ticked items stay ticked.
- Results go to `logs/scan.log` and `data/scan-status.json`. The page's "Email last checked"
  line shows when the last successful check ran. If the last check failed, a red note explains what to do.
- **Refresh** at the top of the page runs the same check straight away. It takes a few minutes, and
  the page updates by itself when it's done. Only one check runs at a time, whether started by
  the button or the morning task.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-morning-check.ps1 -Time 07:30   # set up or change time
powershell -ExecutionPolicy Bypass -File scripts\install-morning-check.ps1 -Remove       # turn off
powershell -ExecutionPolicy Bypass -File scripts\scan.ps1 --dry-run                      # check now without saving
```

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
lib/scan-config.js         what an automatic scan may do: allowed tools, prompt, answer schema
lib/scan-validate.js       checks the run and the answer before anything is saved
lib/scan-apply.js          skips seen emails, keeps wording stable, summarises changes
scripts/run-scan.js        automatic scan (morning task and Refresh button)
scripts/scan.ps1           morning task entry point, logs to logs/scan.log
scripts/install-morning-check.ps1  create, change or remove the scheduled task
docs/screenshots/          README screenshots (sample data only)
public/                    web UI (plain HTML/CSS/JS)
public/shared.js           checklist, progress and grouping rules (used by the UI and tests)
public/fonts/              Inter, Space Grotesk, IBM Plex Mono (SIL Open Font License), served locally
scripts/merge-scan.js      merge a scan file into your data
scripts/migrate-data.js    upgrade an older data file to the current format (takes a backup)
scripts/set-cycle-start.js set the job-cycle start and drop older applications
scripts/launch.ps1         start server if needed and open the browser
scripts/create-shortcut.ps1  desktop shortcut
scan-prompt.md             reusable scan instructions
data/sample-applications.json  fake demo data (the only data file in git)
```

Ignored by git: `data/applications.json`, `data/backups/`, `scan-output/`, `logs/`,
`.env*` and other local files. See [`.gitignore`](.gitignore).
