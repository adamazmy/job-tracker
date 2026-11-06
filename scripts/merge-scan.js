'use strict';

// Usage: node scripts/merge-scan.js scan-output/scan-YYYY-MM-DD.json [--dry-run]
// Merges a scan result file into data/applications.json, taking a backup first.

const path = require('path');
const store = require('../lib/store');
const { mergeScan } = require('../lib/merge');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node scripts/merge-scan.js <scan-file.json> [--dry-run]');
  process.exit(1);
}

const scan = store.readJson(path.resolve(file));
const db = store.loadReal();
const report = mergeScan(db, scan);

if (!dryRun) {
  store.save(db, store.REAL_FILE, { withBackup: true });
}

console.log(`${dryRun ? '[dry run] ' : ''}Merged ${path.basename(file)} into ${path.relative(store.ROOT, store.REAL_FILE)}`);
console.log(`  added:     ${report.added.length}`);
console.log(`  updated:   ${report.updated.length}`);
console.log(`  unchanged: ${report.unchanged.length}`);
console.log(`  protected manual edits kept: ${report.protectedFields.length}`);
for (const p of report.protectedFields) console.log(`    - ${p.id}.${p.field}: kept "${p.kept}", scan said "${p.scanned}"`);
for (const w of report.warnings) console.log(`  sanitised ${w.id}: ${w.warnings.join('; ')}`);
if (report.beforeCycle.length) {
  console.log(`  skipped (before cycle start ${db.settings.cycleStart}): ${report.beforeCycle.length}`);
  for (const b of report.beforeCycle) console.log(`    - ${b.company} | ${b.role}: first email ${b.first}`);
}
console.log(`  needs review: ${report.flagged.length}`);
for (const f of report.flagged) console.log(`    - ${f.company} | ${f.role}: ${f.reasons.join('; ') || 'flagged'}`);
