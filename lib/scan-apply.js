'use strict';

// Turns a validated scan answer into a merge: skips emails already processed
// (by Outlook message id), keeps ticked actions from reopening when Claude only
// rewords them, and summarises what changed in plain language.

const { mergeScan } = require('./merge');
const { TERMINAL_STAGES } = require('./schema');
const JT = require('../public/shared');

const STOP = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'your', 'you', 'if', 'in', 'on', 'at', 'with', 'by', 'have', 'not', 'already']);
function words(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !STOP.has(w))
  );
}
// True when two action texts say the same thing in different words.
function sameAction(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return A.size === B.size;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= 0.6;
}

/**
 * @param db        normalised database (changed in place)
 * @param records   validated answer records
 * @param seen      { [messageId]: 'YYYY-MM-DD' } already processed (changed in place)
 * @param opts      { scanFrom, now }
 */
function applyScan(db, records, seen, { scanFrom, now = new Date().toISOString() } = {}) {
  const before = new Map(db.records.map((r) => [r.id, { stage: r.stage, deadline: r.deadline, nextAction: r.nextAction }]));
  const scanRecords = [];
  const skipped = [];
  const newIds = [];

  for (const r of records) {
    const fresh = r.events.filter((e) => !seen[e.messageId]);
    const existing = r.id ? db.records.find((x) => x.id === r.id) : null;
    if (!fresh.length) {
      skipped.push(r.company);
      continue; // nothing new for this application: leave it exactly as it is
    }
    const out = {
      company: r.company,
      role: r.role,
      stage: r.stage,
      outcome: r.outcome,
      lastEmailDate: r.lastEmailDate,
      needsReview: r.needsReview,
      reviewReasons: [...r.reviewReasons],
      timeline: fresh.map((e) => ({ date: e.date, event: e.event })),
    };
    if (r.id && existing) out.id = r.id;
    for (const f of ['location', 'dateApplied', 'stageReached', 'outlookLink']) if (r[f]) out[f] = r[f];

    // Next step and deadline: keep the current wording unless the action or
    // deadline genuinely changed, so a ticked item doesn't reopen.
    let nextAction = r.nextAction;
    let deadline = r.deadline;
    if (existing && existing.nextAction && deadline === existing.deadline && sameAction(nextAction, existing.nextAction)) {
      nextAction = existing.nextAction;
    }
    if (existing && !deadline && existing.deadline && sameAction(nextAction, existing.nextAction)) {
      deadline = existing.deadline; // a later email that doesn't mention the deadline doesn't remove it
      nextAction = existing.nextAction;
    }
    out.nextAction = nextAction;
    if (deadline) out.deadline = deadline;
    if (r.deadlineEstimated && deadline) {
      out.needsReview = true;
      out.reviewReasons.push("Deadline estimated from wording like 'within 7 days' - check the email");
    }
    scanRecords.push(out);
    for (const e of fresh) newIds.push([e.messageId, e.date]);
  }

  const report = mergeScan(db, { records: scanRecords, scanFrom }, now);
  for (const [id, date] of newIds) seen[id] = date;

  // Plain-language summary of what changed.
  const updates = report.added.length + report.updated.length;
  let newDeadlines = 0;
  let closed = 0;
  const changedIds = new Set([...report.added, ...report.updated.map((u) => u.id)]);
  for (const id of changedIds) {
    const rec = db.records.find((r) => r.id === id);
    const was = before.get(id);
    if (!rec) continue;
    if (rec.deadline && (!was || was.deadline !== rec.deadline)) newDeadlines++;
    if (JT.CLOSED_STAGES.includes(rec.stage) && (!was || !TERMINAL_STAGES.includes(was.stage))) closed++;
  }
  return {
    report,
    summary: {
      updates,
      added: report.added.length,
      newDeadlines,
      closed,
      skippedAlreadySeen: skipped.length,
      text: summaryText({ updates, newDeadlines }),
    },
  };
}

function summaryText({ updates, newDeadlines }) {
  if (!updates) return 'No changes';
  const parts = [`${updates} ${updates === 1 ? 'update' : 'updates'}`];
  if (newDeadlines) parts.push(`${newDeadlines} new ${newDeadlines === 1 ? 'deadline' : 'deadlines'}`);
  return parts.join(', ');
}

module.exports = { applyScan, sameAction, summaryText };
