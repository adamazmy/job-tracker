'use strict';

// Usage: node scripts/run-scan.js [--dry-run]
//
// Automatic, read-only Outlook check. Asks Claude Code (headless) to search
// Outlook for job emails since the last scan, checks the run and its answer
// (lib/scan-validate.js), then merges it into the data file with a backup.
// Used by the morning check (scripts/scan.ps1, run by Windows Task Scheduler).
// --dry-run does everything except save.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const store = require('../lib/store');
const cfg = require('../lib/scan-config');
const { ScanError, ADVICE, parseClaudeOutput, checkRun, validateAnswer } = require('../lib/scan-validate');
const { applyScan } = require('../lib/scan-apply');

const DRY_RUN = process.argv.includes('--dry-run');
const DATA_DIR = path.dirname(store.REAL_FILE);
const STATE_FILE = store.SCAN_STATE_FILE;
const STATUS_FILE = store.SCAN_STATUS_FILE;
const LOCK_FILE = store.SCAN_LOCK_FILE;
const KEEP_SEEN_DAYS = 90;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Start a little before the last successful scan, never before the cycle start.
function pickScanFrom(db) {
  const floor = [cfg.FULL_SCAN_FROM, db.settings.cycleStart || ''].sort().pop();
  const last = db.lastScan && db.lastScan.scannedAt ? db.lastScan.scannedAt.slice(0, 10) : '';
  if (!last) return floor;
  const from = addDays(last, -cfg.OVERLAP_DAYS);
  return from > floor ? from : floor;
}

function readState() {
  try {
    const s = store.readJson(STATE_FILE);
    return { seen: s && typeof s.seen === 'object' && s.seen ? s.seen : {} };
  } catch {
    return { seen: {} };
  }
}

function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function pruneSeen(seen) {
  const cutoff = addDays(new Date().toISOString().slice(0, 10), -KEEP_SEEN_DAYS);
  for (const [id, date] of Object.entries(seen)) if (!(date >= cutoff)) delete seen[id];
}

// One run at a time. A lock older than the Claude timeout is from a crashed run.
function takeLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (age > cfg.CLAUDE_TIMEOUT_MS + 5 * 60 * 1000) fs.unlinkSync(LOCK_FILE);
  } catch {
    /* no lock */
  }
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
  } catch {
    throw new ScanError('busy', ADVICE.busy);
  }
}
function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* already gone */
  }
}

// claude.cmd is an npm shim; start the real executable so no shell is involved.
function findClaude() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  const npmExe = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (fs.existsSync(npmExe)) return npmExe;
  try {
    const found = execFileSync('where.exe', ['claude.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim();
    if (found) return found;
  } catch {
    /* not on PATH */
  }
  throw new ScanError('claude_missing', ADVICE.claude_missing);
}

// Runs Claude in an empty folder, so no project files, CLAUDE.md or folder
// MCP configs (such as AgentsRoom in C:\Dev\.mcp.json) are picked up.
function runClaude(prompt) {
  const exe = findClaude();
  const workDir = path.join(os.tmpdir(), 'job-tracker-scan');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn(exe, cfg.claudeArgs(), { cwd: workDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new ScanError('timeout', ADVICE.timeout));
    }, cfg.CLAUDE_TIMEOUT_MS);
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new ScanError('claude_missing', ADVICE.claude_missing) : new ScanError('failed', ADVICE.failed, e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!out.trim()) {
        const text = err.slice(0, 300);
        if (/log ?in|authenticat|oauth|401|expired|credential/i.test(text)) return reject(new ScanError('claude_auth', ADVICE.claude_auth, text));
        return reject(new ScanError('failed', ADVICE.failed, `Exit ${code}: ${text}`));
      }
      resolve(out);
    });
    child.stdin.end(prompt, 'utf8');
  });
}

async function main() {
  const started = new Date().toISOString();
  takeLock();
  try {
    const db0 = store.loadReal();
    const scanFrom = pickScanFrom(db0);
    log(`Checking Outlook from ${scanFrom}${DRY_RUN ? ' (dry run)' : ''}`);

    const prompt = cfg.buildPrompt({ scanFrom, records: db0.records, root: store.ROOT });
    // The Outlook connector is sometimes not ready in time: try once more after a minute.
    let parsed;
    let run;
    for (let attempt = 1; ; attempt++) {
      try {
        parsed = parseClaudeOutput(await runClaude(prompt));
        run = checkRun(parsed);
        break;
      } catch (e) {
        if (attempt >= 2 || !(e instanceof ScanError) || e.kind !== 'connector') throw e;
        log(`Outlook not reachable (${e.detail}); retrying in 1 minute`);
        await new Promise((r) => setTimeout(r, 60 * 1000));
      }
    }
    log(`Claude finished: ${run.toolsUsed} tool calls, ${run.searches} Outlook searches, cost $${Number(run.costUsd || 0).toFixed(2)}`);
    const records = validateAnswer(parsed.result.structured_output);

    // Reload: the app may have saved edits while Claude was working.
    const db = store.loadReal();
    const state = readState();
    const { report, summary } = applyScan(db, records, state.seen, { scanFrom });
    pruneSeen(state.seen);

    if (!DRY_RUN) {
      store.save(db, store.REAL_FILE, { withBackup: true });
      writeJson(STATE_FILE, state);
      writeJson(STATUS_FILE, { ok: true, at: started, finishedAt: new Date().toISOString(), scanFrom, summary: summary.text });
    }
    log(`${summary.text} (${summary.added} new, ${report.updated.length} updated, ${summary.skippedAlreadySeen} already seen, ${report.flagged.length} need review)`);
    return 0;
  } finally {
    releaseLock();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    const err = e instanceof ScanError ? e : new ScanError('failed', ADVICE.failed, e && e.stack ? e.stack : String(e));
    log(`FAILED (${err.kind}): ${err.message}${err.detail ? ` | ${err.detail}` : ''}`);
    if (!DRY_RUN && err.kind !== 'busy') {
      try {
        writeJson(STATUS_FILE, { ok: false, at: new Date().toISOString(), kind: err.kind, message: err.message });
      } catch {
        /* nothing more to do */
      }
    }
    process.exit(1);
  });
