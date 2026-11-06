'use strict';

// Usage: node scripts/set-cycle-start.js YYYY-MM-DD [--dry-run]
// Sets the start of the current job cycle and removes applications whose first
// email is before it. Records with your own notes or manual edits are kept and
// flagged instead. A backup is taken first (data/backups/).

const store = require('../lib/store');
const { DATE_RE, firstDate } = require('../lib/schema');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const date = args.find((a) => !a.startsWith('--'));
if (!DATE_RE.test(date || '')) {
  console.error('Usage: node scripts/set-cycle-start.js YYYY-MM-DD [--dry-run]');
  process.exit(1);
}

const db = store.loadReal();
const removed = [];
const keptForUser = [];
db.records = db.records.filter((r) => {
  const first = firstDate(r);
  if (!first || first >= date) return true;
  if (r.notes || r.manualFields.length) {
    keptForUser.push(r);
    r.needsReview = true;
    if (!r.reviewReasons.includes('Before current job cycle - delete or archive if not needed')) {
      r.reviewReasons.push('Before current job cycle - delete or archive if not needed');
    }
    return true;
  }
  removed.push({ r, first });
  return false;
});
db.settings.cycleStart = date;
db.updatedAt = new Date().toISOString();

if (!dryRun) store.save(db, store.REAL_FILE, { withBackup: true });

console.log(`${dryRun ? '[dry run] ' : ''}Cycle start set to ${date}`);
console.log(`  removed (first email before ${date}): ${removed.length}`);
for (const { r, first } of removed) console.log(`    - ${r.company} | ${r.role || '(role unknown)'} | first email ${first} | ${r.stage}`);
if (keptForUser.length) {
  console.log(`  kept because you added notes or edits (flagged): ${keptForUser.length}`);
  for (const r of keptForUser) console.log(`    - ${r.company} | ${r.role}`);
}
console.log(`  remaining: ${db.records.length}`);
