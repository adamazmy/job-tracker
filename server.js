'use strict';

// Local-only job tracker server. Binds to 127.0.0.1 and never makes outbound
// network requests. Data lives in data/applications.json.

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const { STAGES, OUTCOMES, SCAN_FIELDS, EDITABLE_FIELDS, DATE_RE, makeId, emptyRecord, normalizeDb } = require('./lib/schema');
const { OUTLOOK_LINK_RE } = require('./lib/sanitize');

const PORT = Number(process.env.PORT) || 4870;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const FORCE_DEMO = process.env.JOB_TRACKER_DEMO === '1';

// Demo mode (no real data file yet, or forced): the sample file is loaded into
// memory and edits are not saved. Checked per request so the app switches to
// real data as soon as the first scan creates data/applications.json.
let demoDb = null;
function isDemo() {
  return FORCE_DEMO || !store.hasRealData();
}
function load() {
  if (!isDemo()) return store.loadReal();
  if (!demoDb) demoDb = store.loadSample();
  return demoDb;
}
function persist(db) {
  db.updatedAt = new Date().toISOString();
  if (isDemo()) demoDb = db;
  else store.save(db);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Block DNS-rebinding and cross-site requests: only accept our own host/origin.
function allowedRequest(req) {
  const okHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!okHosts.includes(req.headers.host)) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !okHosts.map((h) => `http://${h}`).includes(origin)) return false;
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return false;
  }
  return true;
}

function validateField(field, value) {
  if (field === 'archived') return typeof value === 'boolean' ? null : 'archived must be true/false';
  if (typeof value !== 'string') return `${field} must be text`;
  if (['dateApplied', 'deadline', 'lastEmailDate'].includes(field) && value && !DATE_RE.test(value))
    return `${field} must be YYYY-MM-DD`;
  if (field === 'stage' && !STAGES.includes(value)) return 'Unknown stage';
  if (field === 'outcome' && value && !OUTCOMES.includes(value)) return 'Unknown outcome';
  if (field === 'outlookLink' && value && !OUTLOOK_LINK_RE.test(value)) return 'Only Outlook web links are allowed';
  if (field === 'notes' && value.length > 20000) return 'Notes are too long';
  if (field !== 'notes' && value.length > 500) return `${field} is too long`;
  return null;
}

function applyEdits(rec, body) {
  for (const [field, value] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.includes(field)) continue;
    const err = validateField(field, value);
    if (err) throw Object.assign(new Error(err), { status: 400 });
    rec[field] = field === 'notes' || field === 'archived' ? value : value.trim();
    if (SCAN_FIELDS.includes(field) && !rec.manualFields.includes(field)) rec.manualFields.push(field);
    delete rec.scanSuggestions[field];
  }
  rec.updatedAt = new Date().toISOString();
}

async function api(req, res, parts) {
  const db = load();
  const [, , id, action] = parts; // /api/applications/:id/:action

  if (req.method === 'GET' && parts[1] === 'meta') {
    return send(res, 200, { stages: STAGES, outcomes: OUTCOMES, demo: isDemo(), lastScan: db.lastScan, updatedAt: db.updatedAt });
  }
  if (parts[1] !== 'applications') return send(res, 404, { error: 'Not found' });

  if (req.method === 'GET' && !id) return send(res, 200, { records: db.records, demo: isDemo(), lastScan: db.lastScan });

  if (req.method === 'POST' && !id) {
    const body = await readBody(req);
    if (!body.company || !body.role) return send(res, 400, { error: 'Company and role are required' });
    const now = new Date().toISOString();
    const newId = makeId(body.company, body.role);
    if (db.records.some((r) => r.id === newId)) return send(res, 409, { error: 'That company and role already exist' });
    const rec = emptyRecord(newId, now);
    rec.source = 'manual';
    applyEdits(rec, body);
    db.records.push(rec);
    persist(db);
    return send(res, 201, rec);
  }

  const rec = db.records.find((r) => r.id === decodeURIComponent(id || ''));
  if (!rec) return send(res, 404, { error: 'Record not found' });

  if (req.method === 'PATCH' && !action) {
    applyEdits(rec, await readBody(req));
    persist(db);
    return send(res, 200, rec);
  }

  if (req.method === 'POST' && action === 'review') {
    const { reviewed } = await readBody(req);
    if (reviewed) {
      rec.needsReview = false;
      rec.reviewReasons = [];
      rec.reviewedAt = new Date().toISOString();
      rec.manualFields = rec.manualFields.filter((f) => f !== 'needsReview');
    } else {
      rec.needsReview = true;
      rec.reviewReasons = rec.reviewReasons.length ? rec.reviewReasons : ['Flagged manually'];
      if (!rec.manualFields.includes('needsReview')) rec.manualFields.push('needsReview');
    }
    rec.updatedAt = new Date().toISOString();
    persist(db);
    return send(res, 200, rec);
  }

  // Release a manual lock so scans may update the field again; applies any
  // value the last scan suggested.
  if (req.method === 'POST' && action === 'unlock') {
    const { field } = await readBody(req);
    rec.manualFields = rec.manualFields.filter((f) => f !== field);
    if (field in rec.scanSuggestions) {
      rec[field] = rec.scanSuggestions[field];
      delete rec.scanSuggestions[field];
    }
    rec.updatedAt = new Date().toISOString();
    persist(db);
    return send(res, 200, rec);
  }

  return send(res, 405, { error: 'Method not allowed' });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!allowedRequest(req)) return send(res, 403, { error: 'Forbidden' });
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname === '/health') return send(res, 200, { ok: true, app: 'job-tracker' });
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] === 'api') return await api(req, res, parts);
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, pathname);
  } catch (err) {
    send(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
    if (!err.status) console.error(err);
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Job Tracker running at http://localhost:${PORT}${isDemo() ? ' (demo data, edits not saved)' : ''}`);
  });
}

module.exports = { server, normalizeDb };
