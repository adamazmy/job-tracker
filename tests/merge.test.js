'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mergeScan } = require('../lib/merge');
const { normalizeDb } = require('../lib/schema');

const base = () =>
  normalizeDb({
    records: [
      {
        id: 'acme-widgets--graduate-engineer',
        company: 'Acme Widgets',
        role: 'Graduate Engineer',
        stage: 'Interview',
        outcome: 'Pending',
        dateApplied: '2026-02-01',
        lastEmailDate: '2026-03-01',
        location: 'Leeds',
        notes: 'my private notes',
        manualFields: ['location'],
      },
    ],
  });

test('scan never overwrites notes or manually edited fields', () => {
  const db = base();
  const report = mergeScan(db, {
    records: [{ company: 'Acme Widgets', role: 'Graduate Engineer', location: 'York', notes: 'scan notes', stage: 'Assessment centre', lastEmailDate: '2026-04-01' }],
  });
  const r = db.records[0];
  assert.equal(r.notes, 'my private notes');
  assert.equal(r.location, 'Leeds');
  assert.equal(r.scanSuggestions.location, 'York');
  assert.equal(r.stage, 'Assessment centre');
  assert.equal(r.lastEmailDate, '2026-04-01');
  assert.equal(report.protectedFields.length, 1);
});

test('stage does not regress, and the conflict is flagged', () => {
  const db = base();
  mergeScan(db, { records: [{ company: 'Acme Widgets', role: 'Graduate Engineer', stage: 'Applied', lastEmailDate: '2026-03-01' }] });
  const r = db.records[0];
  assert.equal(r.stage, 'Interview');
  assert.equal(r.needsReview, true);
});

test('terminal stage replaces earlier stage', () => {
  const db = base();
  mergeScan(db, { records: [{ company: 'Acme Widgets', role: 'Graduate Engineer', stage: 'Rejected', outcome: 'Rejected', lastEmailDate: '2026-05-01' }] });
  assert.equal(db.records[0].stage, 'Rejected');
});

test('keeps earliest applied date and latest email date', () => {
  const db = base();
  mergeScan(db, { records: [{ company: 'Acme Widgets', role: 'Graduate Engineer', dateApplied: '2026-02-10', lastEmailDate: '2026-01-15' }] });
  assert.equal(db.records[0].dateApplied, '2026-02-01');
  assert.equal(db.records[0].lastEmailDate, '2026-03-01');
});

test('sanitiser strips portal links, codes and non-Outlook links', () => {
  const db = normalizeDb({ records: [] });
  mergeScan(db, {
    records: [
      {
        company: 'Acme Widgets',
        role: 'Intern',
        stage: 'Online assessment',
        nextAction: 'Log in at https://portal.example.com/x?token=abc and use code: 829341',
        outlookLink: 'https://portal.example.com/login',
      },
    ],
  });
  const r = db.records[0];
  assert.ok(!/https?:/.test(r.nextAction));
  assert.ok(!/829341/.test(r.nextAction));
  assert.equal(r.outlookLink, '');
});

test('reviewed records are only re-flagged for newer email', () => {
  const db = base();
  db.records[0].reviewedAt = '2026-03-05T10:00:00.000Z';
  mergeScan(db, { records: [{ company: 'Acme Widgets', role: 'Graduate Engineer', needsReview: true, reviewReasons: ['x'], lastEmailDate: '2026-03-01' }] });
  assert.equal(db.records[0].needsReview, false);
  mergeScan(db, { records: [{ company: 'Acme Widgets', role: 'Graduate Engineer', needsReview: true, reviewReasons: ['y'], lastEmailDate: '2026-03-10' }] });
  assert.equal(db.records[0].needsReview, true);
});

test('unknown stage is flagged instead of guessed', () => {
  const db = normalizeDb({ records: [] });
  mergeScan(db, { records: [{ company: 'Acme Widgets', role: 'Intern', stage: 'Phone screen' }] });
  assert.equal(db.records[0].needsReview, true);
  assert.equal(db.records[0].stage, 'Applied');
});

test('duplicate company+role within one scan is kept separate and flagged', () => {
  const db = normalizeDb({ records: [] });
  mergeScan(db, { records: [{ company: 'Acme', role: 'Grad', location: 'Leeds' }, { company: 'Acme', role: 'Grad', location: 'York' }] });
  assert.equal(db.records.length, 2);
  assert.equal(db.records[1].needsReview, true);
});

test('explicit id lets two same-titled roles coexist', () => {
  const db = normalizeDb({ records: [] });
  mergeScan(db, { records: [{ id: 'acme--grad--leeds', company: 'Acme', role: 'Grad' }, { id: 'acme--grad--york', company: 'Acme', role: 'Grad' }] });
  assert.deepEqual(db.records.map((r) => r.id), ['acme--grad--leeds', 'acme--grad--york']);
});

test('scan records from before the cycle start are not added', () => {
  const db = base();
  db.settings.cycleStart = '2026-07-01';
  const report = mergeScan(db, {
    records: [
      { company: 'Old Co', role: 'Analyst', stage: 'Rejected', dateApplied: '2026-03-01', lastEmailDate: '2026-08-01' },
      { company: 'New Co', role: 'Analyst', stage: 'Applied', dateApplied: '2026-09-01', lastEmailDate: '2026-09-01' },
      { company: 'Acme Widgets', role: 'Graduate Engineer', stage: 'Assessment centre', lastEmailDate: '2026-09-02' },
    ],
  });
  assert.deepStrictEqual(report.beforeCycle.map((b) => b.id), ['old-co--analyst']);
  assert.ok(db.records.some((r) => r.id === 'new-co--analyst'));
  assert.ok(!db.records.some((r) => r.id === 'old-co--analyst'));
  // existing records are still updated
  assert.strictEqual(db.records.find((r) => r.company === 'Acme Widgets').stage, 'Assessment centre');
});
