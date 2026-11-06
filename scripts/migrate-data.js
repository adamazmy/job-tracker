'use strict';

// Usage: node scripts/migrate-data.js [--dry-run]
// Upgrades data/applications.json to the current format (version 2):
//  - adds the new fields (stageReached, done) with empty defaults
//  - for closed applications, fills in "stage reached" when the email timeline
//    clearly shows it; otherwise leaves it empty so the app asks you
// Notes, manual edits and every existing value are left as they are.
// A backup is taken first (data/backups/).

const store = require('../lib/store');
const { reachedFromTimeline, isClosed } = require('../public/shared');

const dryRun = process.argv.includes('--dry-run');
const before = store.readJson(store.REAL_FILE);
const db = store.loadReal(); // normalises: adds missing fields, keeps everything else

const filled = [];
const unknown = [];
for (const r of db.records) {
  if (!isClosed(r) || r.stageReached || r.manualFields.includes('stageReached')) continue;
  const reached = reachedFromTimeline(r.timeline);
  if (reached) {
    r.stageReached = reached;
    filled.push(`${r.company} | ${r.role || '(role unknown)'}: ${reached}`);
  } else unknown.push(`${r.company} | ${r.role || '(role unknown)'}`);
}

// Safety check: nothing the user wrote may change.
const byId = new Map(db.records.map((r) => [r.id, r]));
for (const old of before.records || []) {
  const now = byId.get(old.id);
  if (!now) throw new Error(`Record ${old.id} would be lost - stopping`);
  if ((old.notes || '') !== now.notes) throw new Error(`Notes for ${old.id} would change - stopping`);
  for (const f of old.manualFields || []) {
    if (JSON.stringify(old[f]) !== JSON.stringify(now[f])) throw new Error(`Manual edit ${old.id}.${f} would change - stopping`);
  }
}

if (!dryRun) store.save(db, store.REAL_FILE, { withBackup: true });
console.log(`${dryRun ? '[dry run] ' : ''}Data format: version ${before.version || 1} -> ${db.version}, ${db.records.length} records`);
console.log(`  stage reached filled from emails: ${filled.length}`);
filled.forEach((x) => console.log(`    - ${x}`));
console.log(`  stage reached unclear (shown in Quick checks): ${unknown.length}`);
unknown.forEach((x) => console.log(`    - ${x}`));
