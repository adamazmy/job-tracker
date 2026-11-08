'use strict';

// Checks everything that comes back from `claude -p` before any of it can
// touch the data file: the run metadata (which servers connected, which tools
// were used) and the structured answer itself.

const cfg = require('./scan-config');
const { STAGES, OUTCOMES, STEPS, DATE_RE } = require('./schema');
const { OUTLOOK_LINK_RE } = require('./sanitize');

class ScanError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.kind = kind; // claude_missing | claude_auth | connector | safety | invalid | timeout | busy | failed
    this.detail = detail || '';
  }
}

// What to tell the user for each kind of failure.
const ADVICE = {
  claude_missing:
    'Claude Code was not found. Install it (npm install -g @anthropic-ai/claude-code), then press Refresh.',
  claude_auth:
    'Your Claude sign-in has expired. Open PowerShell, run "claude", type /login and sign in, then press Refresh.',
  connector:
    'The Microsoft 365 connector needs reconnecting. On claude.ai go to Settings > Connectors > Microsoft 365, choose Connect (or Reconnect) and sign in with your Outlook account, then press Refresh.',
  safety: 'The check was stopped by a safety rule, so nothing was changed. Details are in logs/scan.log.',
  invalid: "Claude's answer didn't pass validation, so nothing was changed. Press Refresh to try again.",
  timeout: 'The check took too long and was stopped. Nothing was changed. Press Refresh to try again.',
  busy: 'A check is already running.',
  failed: 'The check failed and nothing was changed. Press Refresh to try again.',
};

function parseClaudeOutput(stdout) {
  let arr;
  try {
    arr = JSON.parse(stdout);
  } catch {
    // Not JSON: usually an error message printed by the CLI.
    const text = String(stdout || '').slice(0, 300);
    if (/log ?in|authenticat|oauth|401|expired|credential/i.test(text)) throw new ScanError('claude_auth', ADVICE.claude_auth, text);
    throw new ScanError('failed', ADVICE.failed, `Unreadable output: ${text}`);
  }
  if (!Array.isArray(arr)) arr = [arr];
  const init = arr.find((m) => m && m.type === 'system' && m.subtype === 'init');
  const result = arr.find((m) => m && m.type === 'result');
  return { arr, init, result };
}

// Confirms Microsoft 365 connected, no AgentsRoom server was present, and
// only the allowed tools were used.
function checkRun({ arr, init, result }) {
  if (!result) throw new ScanError('failed', ADVICE.failed, 'No result in output');
  if (result.is_error) {
    const text = `${result.subtype || ''} ${result.result || ''} ${result.api_error_status || ''}`;
    if (/log ?in|authenticat|oauth|401|403|expired|credential|invalid api key/i.test(text)) {
      throw new ScanError('claude_auth', ADVICE.claude_auth, text.slice(0, 200));
    }
    throw new ScanError('failed', ADVICE.failed, text.slice(0, 200));
  }
  if (!init) throw new ScanError('safety', ADVICE.safety, 'Run metadata missing');

  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  const forbidden = servers.filter((s) => cfg.FORBIDDEN_SERVER_RE.test(s.name || ''));
  if (forbidden.length) throw new ScanError('safety', ADVICE.safety, `AgentsRoom server present: ${forbidden.map((s) => s.name).join(', ')}`);
  const forbiddenTools = (init.tools || []).filter((t) => /agentsroom/i.test(t));
  if (forbiddenTools.length) throw new ScanError('safety', ADVICE.safety, 'AgentsRoom tools present');

  // claude.ai connectors connect after start-up in headless runs, so Microsoft 365
  // is usually missing from this list. Only a listed, unhealthy server fails here;
  // otherwise the searches below must have worked.
  const m365 = servers.find((s) => s.name === cfg.M365_SERVER_NAME);
  if (m365 && m365.status !== 'connected') {
    throw new ScanError('connector', ADVICE.connector, `Microsoft 365 status: ${m365.status}`);
  }

  const uses = arr
    .filter((m) => m && m.type === 'assistant' && m.message && Array.isArray(m.message.content))
    .flatMap((m) => m.message.content.filter((c) => c.type === 'tool_use'));
  const used = uses.map((c) => c.name);
  const ok = new Set([...cfg.ALLOWED_TOOLS, ...cfg.HARMLESS_TOOLS]);
  const bad = [...new Set(used.filter((t) => !ok.has(t)))];
  if (bad.length) throw new ScanError('safety', ADVICE.safety, `Unexpected tools used: ${bad.join(', ')}`);

  // At least one Outlook search must have returned without an error.
  const searchIds = new Set(uses.filter((c) => c.name === cfg.ALLOWED_TOOLS[0]).map((c) => c.id));
  const searchResults = arr
    .filter((m) => m && m.type === 'user' && m.message && Array.isArray(m.message.content))
    .flatMap((m) => m.message.content.filter((c) => c.type === 'tool_result' && searchIds.has(c.tool_use_id)));
  const goodSearches = searchResults.filter((c) => !c.is_error).length;
  if (!goodSearches) {
    const said = result.structured_output && typeof result.structured_output.problem === 'string' ? result.structured_output.problem : '';
    throw new ScanError('connector', ADVICE.connector, `No Outlook search succeeded (${searchIds.size} tried)${said ? `. Claude said: ${said.slice(0, 300)}` : ''}`);
  }

  return { servers: servers.map((s) => `${s.name}=${s.status}`), toolsUsed: used.length, searches: goodSearches, costUsd: result.total_cost_usd };
}

// ---- structured answer ----
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isDateOrEmpty = (v) => typeof v === 'string' && (v === '' || DATE_RE.test(v));

function validateAnswer(answer) {
  const errors = [];
  const fail = (msg) => {
    if (errors.length < 10) errors.push(msg);
  };
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    throw new ScanError('invalid', ADVICE.invalid, 'Answer is not an object');
  }
  if (!['ok', 'connector_error'].includes(answer.status)) fail('status');
  if (!isStr(answer.problem ?? '', 300)) fail('problem');
  if (answer.status === 'connector_error') {
    throw new ScanError('connector', ADVICE.connector, String(answer.problem || '').slice(0, 200));
  }
  if (!Array.isArray(answer.records) || answer.records.length > 300) fail('records');
  const records = Array.isArray(answer.records) ? answer.records : [];
  records.forEach((r, i) => {
    const at = `records[${i}]`;
    if (!r || typeof r !== 'object') return fail(at);
    if (!isStr(r.id, 200)) fail(`${at}.id`);
    if (!isStr(r.company, 200) || !r.company.trim()) fail(`${at}.company`);
    if (!isStr(r.role, 300)) fail(`${at}.role`);
    if (!isStr(r.location, 200)) fail(`${at}.location`);
    if (!STAGES.includes(r.stage)) fail(`${at}.stage`);
    if (!['', ...STEPS].includes(r.stageReached)) fail(`${at}.stageReached`);
    if (!OUTCOMES.includes(r.outcome)) fail(`${at}.outcome`);
    if (!isStr(r.nextAction, 400)) fail(`${at}.nextAction`);
    for (const f of ['dateApplied', 'deadline', 'lastEmailDate']) if (!isDateOrEmpty(r[f])) fail(`${at}.${f}`);
    if (typeof r.deadlineEstimated !== 'boolean') fail(`${at}.deadlineEstimated`);
    if (typeof r.outlookLink !== 'string' || (r.outlookLink && !OUTLOOK_LINK_RE.test(r.outlookLink))) fail(`${at}.outlookLink`);
    if (typeof r.needsReview !== 'boolean') fail(`${at}.needsReview`);
    if (!Array.isArray(r.reviewReasons) || r.reviewReasons.some((x) => !isStr(x, 300))) fail(`${at}.reviewReasons`);
    if (!Array.isArray(r.events) || r.events.length > 40) return fail(`${at}.events`);
    r.events.forEach((e, j) => {
      if (!e || !DATE_RE.test(e.date || '') || !isStr(e.event, 200) || !isStr(e.messageId, 400) || !e.messageId) {
        fail(`${at}.events[${j}]`);
      }
    });
  });
  if (errors.length) throw new ScanError('invalid', ADVICE.invalid, `Invalid fields: ${errors.join(', ')}`);
  return records;
}

module.exports = { ScanError, ADVICE, parseClaudeOutput, checkRun, validateAnswer };
