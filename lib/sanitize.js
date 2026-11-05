'use strict';

// Privacy guard applied to everything a scan writes. The scan agent is told
// not to capture these things, and this is the second line of defence.

const OUTLOOK_LINK_RE = /^https:\/\/(outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com)\/(owa|mail)\//i;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
const CODE_RE = /\b(?:code|passcode|otp|pin|verification|password|pwd)\b[^\n]{0,20}?[:\s]\s*[A-Za-z0-9-]{4,}/gi;
const LONG_DIGITS_RE = /\b\d{6,}\b/g; // OTP-like numbers / reference ids
const TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g; // long opaque tokens

const MAX_LEN = {
  company: 120,
  role: 200,
  location: 120,
  outcome: 40,
  nextAction: 280,
  default: 280,
};

function cleanText(value, field, warnings) {
  if (value === undefined || value === null) return value;
  let s = String(value).replace(/\s+/g, ' ').trim();
  const before = s;
  s = s.replace(URL_RE, '[link removed]');
  s = s.replace(CODE_RE, '[code removed]');
  s = s.replace(TOKEN_RE, '[removed]');
  if (field !== 'role') s = s.replace(LONG_DIGITS_RE, '[number removed]');
  if (s !== before) warnings.push(`${field}: removed link/code-like text`);
  const max = MAX_LEN[field] || MAX_LEN.default;
  if (s.length > max) {
    s = s.slice(0, max - 1) + '…';
    warnings.push(`${field}: truncated`);
  }
  return s;
}

function cleanOutlookLink(value, warnings) {
  if (!value) return '';
  const s = String(value).trim();
  if (OUTLOOK_LINK_RE.test(s)) return s;
  warnings.push('outlookLink: not an Outlook web link, dropped');
  return '';
}

module.exports = { cleanText, cleanOutlookLink, OUTLOOK_LINK_RE };
