'use strict';

const {
  STAGES,
  TERMINAL_STAGES,
  OUTCOMES,
  SCAN_FIELDS,
  DATE_RE,
  makeId,
  stageIndex,
  emptyRecord,
  firstDate,
  STEPS,
} = require('./schema');
const { reachedFromTimeline, isClosed } = require('../public/shared');
const { cleanText, cleanOutlookLink } = require('./sanitize');

const TEXT_FIELDS = ['company', 'role', 'location', 'outcome', 'nextAction'];
const DATE_FIELDS = ['dateApplied', 'deadline', 'lastEmailDate'];

// Validate and sanitise one record coming from a scan file.
function sanitizeScanRecord(raw) {
  const warnings = [];
  const reasons = Array.isArray(raw.reviewReasons) ? raw.reviewReasons.map((r) => cleanText(r, 'reviewReason', [])) : [];
  const s = {};

  for (const f of TEXT_FIELDS) if (raw[f] !== undefined) s[f] = cleanText(raw[f], f, warnings);
  for (const f of DATE_FIELDS) {
    if (raw[f] === undefined || raw[f] === null || raw[f] === '') continue;
    const v = String(raw[f]).slice(0, 10);
    if (DATE_RE.test(v)) s[f] = v;
    else reasons.push(`Could not read ${f} "${raw[f]}"`);
  }
  if (raw.outlookLink !== undefined) s.outlookLink = cleanOutlookLink(raw.outlookLink, warnings);

  if (raw.stage !== undefined) {
    if (STAGES.includes(raw.stage)) s.stage = raw.stage;
    else reasons.push(`Unknown stage "${raw.stage}"`);
  }
  if (raw.stageReached !== undefined && raw.stageReached !== '') {
    if (STEPS.includes(raw.stageReached)) s.stageReached = raw.stageReached;
    else reasons.push(`Unknown stage reached "${raw.stageReached}"`);
  }
  if (s.outcome !== undefined && !OUTCOMES.includes(s.outcome)) {
    reasons.push(`Unknown outcome "${s.outcome}"`);
    delete s.outcome;
  }
  if (!s.company) reasons.push('Company unclear');
  if (!s.role) reasons.push('Role unclear');

  const timeline = Array.isArray(raw.timeline)
    ? raw.timeline
        .filter((e) => e && DATE_RE.test(String(e.date || '').slice(0, 10)))
        .map((e) => ({
          date: String(e.date).slice(0, 10),
          event: cleanText(e.event || '', 'timeline', warnings),
        }))
    : [];

  return {
    id: raw.id ? String(raw.id) : makeId(s.company, s.role),
    fields: s,
    timeline,
    needsReview: Boolean(raw.needsReview) || reasons.length > 0,
    reviewReasons: reasons,
    warnings,
  };
}

function same(a, b) {
  return JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
}

function mergeTimeline(existing, incoming) {
  const seen = new Set(existing.map((e) => `${e.date}|${e.event}`));
  const out = existing.slice();
  for (const e of incoming) {
    const k = `${e.date}|${e.event}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Merge a scan into the database in place.
 * Rules:
 *  - notes are never touched by a scan
 *  - fields in record.manualFields are never overwritten; the scanned value is
 *    kept in record.scanSuggestions so the UI can offer it
 *  - stage never moves backwards unless the new stage is terminal
 *  - dateApplied keeps the earliest date, lastEmailDate keeps the latest
 *  - a record the user marked as reviewed is only re-flagged when newer email
 *    arrives or the merge itself finds a conflict
 *  - records missing from the scan are left alone
 */
function mergeScan(db, scan, now = new Date().toISOString()) {
  const report = { added: [], updated: [], unchanged: [], protectedFields: [], flagged: [], warnings: [], beforeCycle: [] };
  const cycleStart = (db.settings && db.settings.cycleStart) || '';
  const records = Array.isArray(scan && scan.records) ? scan.records : [];
  const seenIds = new Set();

  for (const raw of records) {
    const s = sanitizeScanRecord(raw);
    if (seenIds.has(s.id)) {
      // Two scanned records collapsed onto one id (same company + role).
      // Never merge them silently: keep both and flag the second one.
      let n = 2;
      while (seenIds.has(`${s.id}--${n}`)) n++;
      s.id = `${s.id}--${n}`;
      s.needsReview = true;
      s.reviewReasons.push('Same company and role as another record in this scan - give it an explicit id (e.g. with location)');
    }
    seenIds.add(s.id);
    if (s.warnings.length) report.warnings.push({ id: s.id, warnings: s.warnings });
    const mergeReasons = [];

    let rec = db.records.find((r) => r.id === s.id || (r.aliases || []).includes(s.id));
    const isNew = !rec;
    if (isNew && cycleStart) {
      const first = firstDate({ ...s.fields, timeline: s.timeline });
      if (first && first < cycleStart) {
        // Belongs to an earlier job cycle: don't add it.
        report.beforeCycle.push({ id: s.id, company: s.fields.company || '', role: s.fields.role || '', first });
        continue;
      }
    }
    if (isNew) {
      rec = emptyRecord(s.id, now);
      db.records.push(rec);
    }

    const changed = [];
    for (const f of SCAN_FIELDS) {
      if (!(f in s.fields)) continue;
      const v = s.fields[f];
      if (!isNew && rec.manualFields.includes(f)) {
        if (!same(rec[f], v)) {
          rec.scanSuggestions[f] = v;
          report.protectedFields.push({ id: rec.id, field: f, kept: rec[f], scanned: v });
        }
        continue;
      }
      if (!isNew && f === 'stage' && rec.stage && v !== rec.stage) {
        const regress = stageIndex(v) < stageIndex(rec.stage) && !TERMINAL_STAGES.includes(v);
        const leavingTerminal = TERMINAL_STAGES.includes(rec.stage) && !TERMINAL_STAGES.includes(v);
        if (regress || leavingTerminal) {
          mergeReasons.push(`Scan suggests stage "${v}" but record is at "${rec.stage}"`);
          rec.scanSuggestions.stage = v;
          continue;
        }
      }
      if (!isNew && f === 'dateApplied' && rec.dateApplied && v > rec.dateApplied) continue;
      if (!isNew && f === 'lastEmailDate' && rec.lastEmailDate && v < rec.lastEmailDate) continue;
      if (!isNew && f === 'outlookLink' && rec.outlookLink && s.fields.lastEmailDate && rec.lastEmailDate > s.fields.lastEmailDate) continue;
      if (!same(rec[f], v)) {
        rec[f] = v;
        changed.push(f);
      }
    }

    const tl = mergeTimeline(rec.timeline, s.timeline);
    if (tl.length !== rec.timeline.length) {
      rec.timeline = tl;
      changed.push('timeline');
    }

    // Closed applications: record how far they got when the emails show it.
    if (isClosed(rec) && !rec.stageReached && !rec.manualFields.includes('stageReached')) {
      const reached = reachedFromTimeline(rec.timeline);
      if (reached) {
        rec.stageReached = reached;
        changed.push('stageReached');
      }
    }

    // Review flag
    const reasons = [...new Set([...s.reviewReasons, ...mergeReasons])];
    const wantsReview = s.needsReview || mergeReasons.length > 0;
    const reviewedDay = rec.reviewedAt ? rec.reviewedAt.slice(0, 10) : '';
    const newerMail = !reviewedDay || (s.fields.lastEmailDate || '') > reviewedDay;
    if (wantsReview && (newerMail || mergeReasons.length > 0)) {
      if (!rec.needsReview || !same(rec.reviewReasons, reasons)) changed.push('needsReview');
      rec.needsReview = true;
      rec.reviewReasons = reasons;
    } else if (!wantsReview && rec.needsReview && !rec.manualFields.includes('needsReview')) {
      rec.needsReview = false;
      rec.reviewReasons = [];
      changed.push('needsReview');
    }

    rec.lastScannedAt = now;
    if (isNew) report.added.push(rec.id);
    else if (changed.length) {
      rec.updatedAt = now;
      report.updated.push({ id: rec.id, fields: changed });
    } else report.unchanged.push(rec.id);
    if (rec.needsReview) report.flagged.push({ id: rec.id, company: rec.company, role: rec.role, reasons: rec.reviewReasons });
  }

  db.lastScan = {
    scannedAt: now,
    from: scan.scanFrom || '',
    emailsReviewed: scan.emailsReviewed || null,
    recordsInScan: records.length,
  };
  db.updatedAt = now;
  return report;
}

module.exports = { mergeScan, sanitizeScanRecord };
