'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cfg = require('../lib/scan-config');
const { checkRun, validateAnswer, parseClaudeOutput } = require('../lib/scan-validate');
const { applyScan } = require('../lib/scan-apply');
const { normalizeDb } = require('../lib/schema');

const M365 = { name: cfg.M365_SERVER_NAME, status: 'connected' };
const run = ({ servers = [M365], tools = [cfg.ALLOWED_TOOLS[0]], result = {}, searchError = false } = {}) => ({
  arr: [
    { type: 'system', subtype: 'init', mcp_servers: servers, tools: [] },
    { type: 'assistant', message: { content: tools.map((name, i) => ({ type: 'tool_use', name, id: `t${i}` })) } },
    { type: 'user', message: { content: tools.map((name, i) => ({ type: 'tool_result', tool_use_id: `t${i}`, is_error: searchError })) } },
  ],
  init: { mcp_servers: servers, tools: [] },
  result: { type: 'result', is_error: false, ...result },
});

const rec = (over = {}) => ({
  id: '',
  company: 'Acme Widgets',
  role: 'Graduate Engineer',
  location: '',
  dateApplied: '',
  stage: 'Online assessment',
  stageReached: '',
  outcome: 'Pending',
  nextAction: 'Complete the online assessment',
  deadline: '2026-11-15',
  deadlineEstimated: false,
  lastEmailDate: '2026-11-07',
  outlookLink: '',
  needsReview: false,
  reviewReasons: [],
  events: [{ date: '2026-11-07', event: 'Online assessment invitation', messageId: 'msg-1' }],
  ...over,
});

test('run check accepts read-only Outlook tools only', () => {
  assert.ok(checkRun(run()));
  assert.throws(() => checkRun(run({ tools: ['mcp__claude_ai_Microsoft_365__outlook_send_mail'] })), { kind: 'safety' });
  assert.throws(() => checkRun(run({ tools: ['Bash'] })), { kind: 'safety' });
});

test('run check stops when AgentsRoom is loaded or Outlook is not connected', () => {
  assert.throws(() => checkRun(run({ servers: [M365, { name: 'AgentsRoom-MCP', status: 'connected' }] })), { kind: 'safety' });
  assert.throws(() => checkRun(run({ servers: [{ ...M365, status: 'needs-auth' }] })), { kind: 'connector' });
  // headless runs list no servers at start-up: fine as long as a search worked
  assert.ok(checkRun(run({ servers: [] })));
  assert.throws(() => checkRun(run({ servers: [], searchError: true })), { kind: 'connector' });
  assert.throws(() => checkRun(run({ servers: [], tools: [] })), { kind: 'connector' });
});

test('sign-in errors are reported as such', () => {
  assert.throws(() => parseClaudeOutput('Invalid API key · Please run /login'), { kind: 'claude_auth' });
});

test('answer validation rejects bad fields and links', () => {
  assert.strictEqual(validateAnswer({ status: 'ok', problem: '', records: [rec()] }).length, 1);
  assert.throws(() => validateAnswer({ status: 'ok', problem: '', records: [rec({ stage: 'Hired' })] }), { kind: 'invalid' });
  assert.throws(() => validateAnswer({ status: 'ok', problem: '', records: [rec({ outlookLink: 'https://evil.example/x' })] }), { kind: 'invalid' });
  assert.throws(() => validateAnswer({ status: 'connector_error', problem: 'auth', records: [] }), { kind: 'connector' });
});

test('new email adds a record; the same email is skipped next time', () => {
  const db = normalizeDb({ records: [] });
  const seen = {};
  const first = applyScan(db, [rec()], seen, { scanFrom: '2026-11-04' });
  assert.strictEqual(first.summary.added, 1);
  assert.strictEqual(db.records[0].stage, 'Online assessment');
  assert.strictEqual(seen['msg-1'], '2026-11-07');

  const again = applyScan(db, [rec({ id: db.records[0].id, nextAction: 'Do something else' })], seen, { scanFrom: '2026-11-05' });
  assert.strictEqual(again.summary.updates, 0);
  assert.strictEqual(db.records[0].nextAction, 'Complete the online assessment');
});

test('reworded action keeps the existing wording so a tick stays ticked', () => {
  const db = normalizeDb({
    records: [{ id: 'acme', company: 'Acme Widgets', role: 'Graduate Engineer', stage: 'Online assessment', nextAction: 'Complete the online assessment', deadline: '2026-11-15' }],
  });
  applyScan(db, [rec({ id: 'acme', nextAction: 'Complete online assessment', events: [{ date: '2026-11-08', event: 'Reminder', messageId: 'msg-2' }] })], {}, {});
  assert.strictEqual(db.records[0].nextAction, 'Complete the online assessment');
});
