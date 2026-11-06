'use strict';

const STAGES = [
  'Draft',
  'Applied',
  'Online assessment',
  'Interview',
  'Assessment centre',
  'Offer',
  'Rejected',
  'Withdrawn',
];
const TERMINAL_STAGES = ['Offer', 'Rejected', 'Withdrawn'];
const OUTCOMES = ['Pending', 'Offer', 'Accepted', 'Declined', 'Rejected', 'Withdrawn'];

// Fields a scan is allowed to write. Notes are never written by a scan.
const SCAN_FIELDS = [
  'company',
  'role',
  'location',
  'dateApplied',
  'stage',
  'outcome',
  'nextAction',
  'deadline',
  'lastEmailDate',
  'outlookLink',
];

// Fields the user can edit in the UI. Editing one of SCAN_FIELDS locks it
// (adds it to manualFields) so later scans will not overwrite it.
const EDITABLE_FIELDS = [...SCAN_FIELDS, 'notes', 'archived'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function slug(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function makeId(company, role) {
  return `${slug(company) || 'unknown'}--${slug(role) || 'unknown-role'}`;
}

function stageIndex(stage) {
  return STAGES.indexOf(stage);
}

function emptyRecord(id, now) {
  return {
    id,
    company: '',
    role: '',
    location: '',
    dateApplied: '',
    stage: 'Applied',
    outcome: 'Pending',
    nextAction: '',
    deadline: '',
    lastEmailDate: '',
    outlookLink: '',
    needsReview: false,
    reviewReasons: [],
    reviewedAt: '',
    notes: '',
    archived: false,
    manualFields: [],
    scanSuggestions: {},
    timeline: [],
    source: 'scan',
    createdAt: now,
    updatedAt: now,
    lastScannedAt: '',
  };
}

function normalizeRecord(r) {
  const base = emptyRecord(r.id || makeId(r.company, r.role), r.createdAt || new Date().toISOString());
  const out = { ...base, ...r };
  if (!Array.isArray(out.manualFields)) out.manualFields = [];
  if (!Array.isArray(out.reviewReasons)) out.reviewReasons = [];
  if (!Array.isArray(out.timeline)) out.timeline = [];
  if (!out.scanSuggestions || typeof out.scanSuggestions !== 'object') out.scanSuggestions = {};
  if (!STAGES.includes(out.stage)) {
    out.reviewReasons.push(`Unknown stage "${out.stage}"`);
    out.needsReview = true;
    out.stage = 'Applied';
  }
  return out;
}

// Earliest date we know for an application: date applied or first timeline entry,
// falling back to the last email date.
function firstDate(rec) {
  const dates = [rec.dateApplied, ...(rec.timeline || []).map((t) => t && t.date)].filter((d) => DATE_RE.test(d || ''));
  dates.sort();
  return dates[0] || (DATE_RE.test(rec.lastEmailDate || '') ? rec.lastEmailDate : '');
}

function normalizeDb(raw) {
  const db = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    updatedAt: db.updatedAt || '',
    lastScan: db.lastScan || null,
    settings: {
      // Applications whose first email is before this date belong to an earlier
      // job cycle and are left out. Set with scripts/set-cycle-start.js.
      cycleStart: db.settings && DATE_RE.test(db.settings.cycleStart || '') ? db.settings.cycleStart : '',
    },
    records: Array.isArray(db.records) ? db.records.map(normalizeRecord) : [],
  };
}

module.exports = {
  STAGES,
  TERMINAL_STAGES,
  OUTCOMES,
  SCAN_FIELDS,
  EDITABLE_FIELDS,
  DATE_RE,
  slug,
  makeId,
  firstDate,
  stageIndex,
  emptyRecord,
  normalizeRecord,
  normalizeDb,
};
