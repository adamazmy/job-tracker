'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeDb } = require('./schema');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const REAL_FILE = process.env.JOB_TRACKER_DATA || path.join(DATA_DIR, 'applications.json');
const SAMPLE_FILE = path.join(DATA_DIR, 'sample-applications.json');
// Backups live next to the data file, so a test copy (JOB_TRACKER_DATA) never
// writes into the real backups folder.
const BACKUP_DIR = process.env.JOB_TRACKER_DATA
  ? path.join(path.dirname(REAL_FILE), 'backups')
  : path.join(DATA_DIR, 'backups');
const KEEP_BACKUPS = 30;
// Automatic scan files, also next to the data file.
const SCAN_STATE_FILE = path.join(path.dirname(REAL_FILE), 'scan-state.json'); // processed message ids
const SCAN_STATUS_FILE = path.join(path.dirname(REAL_FILE), 'scan-status.json'); // result of the last run
const SCAN_LOCK_FILE = path.join(path.dirname(REAL_FILE), 'scan.lock');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

function backup(file = REAL_FILE) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `applications-${stamp()}.json`);
  fs.copyFileSync(file, dest);
  const old = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('applications-') && f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(KEEP_BACKUPS);
  for (const f of old) fs.unlinkSync(path.join(BACKUP_DIR, f));
  return dest;
}

function save(db, file = REAL_FILE, { withBackup = false } = {}) {
  if (withBackup) backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function loadReal() {
  if (!fs.existsSync(REAL_FILE)) return normalizeDb({ records: [] });
  return normalizeDb(readJson(REAL_FILE));
}

function loadSample() {
  return normalizeDb(readJson(SAMPLE_FILE));
}

function hasRealData() {
  return fs.existsSync(REAL_FILE);
}

module.exports = { ROOT, REAL_FILE, SAMPLE_FILE, BACKUP_DIR, SCAN_STATE_FILE, SCAN_STATUS_FILE, SCAN_LOCK_FILE, readJson, backup, save, loadReal, loadSample, hasRealData };
