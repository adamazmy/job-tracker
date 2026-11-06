'use strict';

const test = require('node:test');
const assert = require('node:assert');
const JT = require('../public/shared');
const { mergeScan } = require('../lib/merge');
const { normalizeDb } = require('../lib/schema');

const TODAY = '2026-11-06';
const rec = (o) => ({
  id: 'x--y',
  company: 'Acme Widgets',
  role: 'Graduate Engineer',
  stage: 'Online assessment',
  outcome: 'Pending',
  nextAction: '',
  deadline: '',
  lastEmailDate: '2026-11-01',
  needsReview: false,
  reviewReasons: [],
  timeline: [],
  done: {},
  ...o,
});

test('actions are grouped as overdue, coming up, later or quick check', () => {
  const g = (deadline) => JT.itemsFor(rec({ nextAction: 'Do the test', deadline }), TODAY)[0].group;
  assert.strictEqual(g('2026-11-05'), 'overdue');
  assert.strictEqual(g('2026-11-06'), 'soon');
  assert.strictEqual(g('2026-11-13'), 'soon');
  assert.strictEqual(g('2026-11-14'), 'later');
  assert.strictEqual(g(''), 'check');
});

test('waiting-type next steps and closed applications are not actions', () => {
  assert.deepStrictEqual(JT.itemsFor(rec({ nextAction: 'Wait for response' }), TODAY), []);
  assert.deepStrictEqual(JT.itemsFor(rec({ nextAction: 'Do the test', deadline: '2026-11-07', stage: 'Rejected', stageReached: 'Test' }), TODAY), []);
});

test('quick checks: unknown role, unclear stage reached, quiet interview', () => {
  const keys = (r) => JT.itemsFor(rec(r), TODAY).map((i) => i.key);
  assert.ok(keys({ role: '' }).includes('q:role'));
  assert.ok(keys({ stage: 'Rejected', timeline: [{ date: '2026-10-01', event: 'Rejected' }] }).includes('q:reached'));
  assert.ok(!keys({ stage: 'Rejected', timeline: [{ date: '2026-10-01', event: 'Rejected after online assessment' }] }).includes('q:reached'));
  assert.ok(keys({ stage: 'Interview', lastEmailDate: '2026-10-01' }).some((k) => k.startsWith('q:quiet:')));
  assert.ok(!keys({ stage: 'Interview', lastEmailDate: '2026-10-20' }).some((k) => k.startsWith('q:quiet:')));
});

test('a ticked item stays ticked, but a new deadline makes a new item', () => {
  const r = rec({ nextAction: 'Do the test', deadline: '2026-11-08' });
  const [item] = JT.itemsFor(r, TODAY);
  r.done[item.key] = '2026-11-06T10:00:00Z';
  assert.ok(JT.itemsFor(r, TODAY)[0].doneAt);
  assert.strictEqual(JT.bucket(r, TODAY).bucket, 'waiting');
  r.deadline = '2026-11-12';
  const [again] = JT.itemsFor(r, TODAY);
  assert.notStrictEqual(again.key, item.key);
  assert.strictEqual(again.doneAt, '');
  assert.strictEqual(JT.bucket(r, TODAY).bucket, 'needs');
});

test('progress tracker mapping', () => {
  assert.deepStrictEqual(JT.progress(rec({ stage: 'Draft' })), { current: -1, closed: false, draft: true });
  assert.strictEqual(JT.progress(rec({ stage: 'Applied' })).current, 0);
  assert.strictEqual(JT.progress(rec({ stage: 'Online assessment' })).current, 1);
  assert.strictEqual(JT.progress(rec({ stage: 'Interview' })).current, 2);
  assert.strictEqual(JT.progress(rec({ stage: 'Assessment centre' })).current, 3);
  assert.strictEqual(JT.progress(rec({ stage: 'Offer' })).current, 4);
  const closed = JT.progress(rec({ stage: 'Withdrawn', stageReached: 'Interview' }));
  assert.deepStrictEqual(closed, { current: 2, closed: true, unknown: false });
  assert.strictEqual(JT.progress(rec({ stage: 'Rejected' })).unknown, true);
});

test('list sorting: needs me by urgency, then waiting and closed by latest email', () => {
  const rs = [
    rec({ id: 'closed-new', stage: 'Rejected', stageReached: 'Applied', lastEmailDate: '2026-11-05' }),
    rec({ id: 'wait-old', stage: 'Applied', lastEmailDate: '2026-10-01' }),
    rec({ id: 'wait-new', stage: 'Applied', lastEmailDate: '2026-11-04' }),
    rec({ id: 'soon', nextAction: 'Test', deadline: '2026-11-09' }),
    rec({ id: 'overdue', nextAction: 'Test', deadline: '2026-11-01' }),
    rec({ id: 'check', nextAction: 'Test' }),
  ];
  const rows = JT.sortForList(rs.map((r) => ({ record: r, ...JT.bucket(r, TODAY) })));
  assert.deepStrictEqual(rows.map((x) => x.record.id), ['overdue', 'soon', 'check', 'wait-new', 'wait-old', 'closed-new']);
});

test('latest news lists real moves only, newest first', () => {
  const r = rec({
    timeline: [
      { date: '2026-10-01', event: 'Application received' },
      { date: '2026-10-05', event: 'Online assessment invite' },
      { date: '2026-10-07', event: 'Reminder: assessment not completed' },
      { date: '2026-10-20', event: 'Rejected after online assessment' },
    ],
  });
  assert.deepStrictEqual(JT.news([r]).map((n) => n.text), ['Not successful', 'Moved on to a test']);
});

test('scans never touch ticks, and record the stage reached for closed applications', () => {
  const db = normalizeDb({
    records: [{ id: 'acme-widgets--graduate-engineer', company: 'Acme Widgets', role: 'Graduate Engineer', stage: 'Online assessment', done: { 'a:abc': '2026-11-01T00:00:00Z' }, notes: 'mine' }],
  });
  mergeScan(db, {
    records: [
      {
        company: 'Acme Widgets',
        role: 'Graduate Engineer',
        stage: 'Rejected',
        outcome: 'Rejected',
        lastEmailDate: '2026-11-05',
        timeline: [{ date: '2026-11-05', event: 'Rejected after online assessment' }],
        done: {},
      },
    ],
  });
  const r = db.records[0];
  assert.deepStrictEqual(r.done, { 'a:abc': '2026-11-01T00:00:00Z' });
  assert.strictEqual(r.notes, 'mine');
  assert.strictEqual(r.stageReached, 'Test');
});
