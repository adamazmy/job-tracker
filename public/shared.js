// Shared logic for the browser UI and the Node scripts/tests: progress steps,
// the Today checklist, list grouping and "latest news". No DOM access here.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JT = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STEPS = ['Applied', 'Test', 'Interview', 'Final stage', 'Offer'];
  const STAGE_TO_STEP = {
    Applied: 'Applied',
    'Online assessment': 'Test',
    Interview: 'Interview',
    'Assessment centre': 'Final stage',
    Offer: 'Offer',
  };
  // Plain-English names for the stored stage values.
  const STAGE_LABEL = {
    Draft: 'Draft',
    Applied: 'Applied',
    'Online assessment': 'Test',
    Interview: 'Interview',
    'Assessment centre': 'Final stage',
    Offer: 'Offer',
    Rejected: 'Not successful',
    Withdrawn: 'Withdrawn',
  };
  const CLOSED_STAGES = ['Rejected', 'Withdrawn'];
  const QUIET_DAYS = 30;
  const SOON_DAYS = 7;

  const isClosed = (r) => CLOSED_STAGES.includes(r.stage);

  // ---- dates (all YYYY-MM-DD strings, local time) ----
  function todayStr(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function toDay(s) {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  }
  function daysBetween(a, b) {
    return toDay(b) - toDay(a);
  }
  function addDays(s, n) {
    const t = new Date((toDay(s) + n) * 86400000);
    return t.toISOString().slice(0, 10);
  }

  // Small stable hash so tick keys stay short in the data file.
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  // ---- reading progress from the email timeline ----
  // Returns the step an email event shows, and whether it closed the application.
  function classifyEvent(text) {
    const t = String(text || '').toLowerCase();
    const out = { step: '', closed: '', reminder: false };
    if (/remind|incomplete|not completed|not submitted|still interested|deadline missed/.test(t)) {
      out.reminder = true;
      return out;
    }
    if (/reject|unsuccessful|not successful|not (be )?progress|not to proceed|not to move forward|regret/.test(t)) out.closed = 'Rejected';
    else if (/withdr|cancel/.test(t)) out.closed = 'Withdrawn';
    if (/\boffer\b/.test(t)) out.step = 'Offer';
    else if (/assessment cent|assessment day|final (round|stage|interview)|superday/.test(t)) out.step = 'Final stage';
    else if (/interview/.test(t)) out.step = 'Interview';
    else if (/assessment|\btest\b|hackerrank|codility|\btask\b|discovery portal|game|situational|screening/.test(t)) out.step = 'Test';
    else if (/appl|received|submitted|confirm/.test(t)) out.step = 'Applied';
    return out;
  }

  // Furthest step the timeline clearly shows, or '' if it doesn't show one.
  function reachedFromTimeline(timeline) {
    let best = -1;
    for (const e of timeline || []) {
      const c = classifyEvent(e.event);
      if (c.step) best = Math.max(best, STEPS.indexOf(c.step));
    }
    return best >= 0 ? STEPS[best] : '';
  }

  // Where a closed application stopped: the saved value, else what the emails show.
  function stoppedAt(r) {
    if (!isClosed(r)) return '';
    return STEPS.includes(r.stageReached) ? r.stageReached : reachedFromTimeline(r.timeline);
  }

  // Tracker state: index of the current step (-1 = none) and whether it's closed.
  function progress(r) {
    if (r.stage === 'Draft') return { current: -1, closed: false, draft: true };
    if (isClosed(r)) {
      const s = stoppedAt(r);
      return { current: s ? STEPS.indexOf(s) : -1, closed: true, unknown: !s };
    }
    return { current: STEPS.indexOf(STAGE_TO_STEP[r.stage]), closed: false };
  }

  const isWaitingText = (s) => /^\s*(wait|await|no action|nothing to do)/i.test(s || '');

  // ---- Today checklist ----
  // Every open thing to do or check, for every application.
  // group: overdue | soon | later | check
  function itemsFor(r, today) {
    if (r.archived) return [];
    const done = r.done || {};
    const items = [];
    const reasons = (r.needsReview && Array.isArray(r.reviewReasons) ? r.reviewReasons : []).filter(Boolean);
    const base = { recordId: r.id, company: r.company || 'Unknown company', role: r.role || '', link: r.outlookLink || '' };
    const add = (it) => items.push({ ...base, ...it, doneAt: done[it.key] || '' });

    const active = !isClosed(r);
    const roleMissing = !String(r.role || '').trim();
    let actionShown = false;

    if (active && r.nextAction && !isWaitingText(r.nextAction)) {
      const key = `a:${hash(`${r.nextAction}|${r.deadline || ''}`)}`;
      let group;
      if (!r.deadline) group = 'check';
      else if (r.deadline < today) group = 'overdue';
      else if (r.deadline <= addDays(today, SOON_DAYS)) group = 'soon';
      else group = 'later';
      const ctx = [STAGE_LABEL[r.stage] || r.stage];
      if (!r.deadline) ctx.push('No due date found in the emails');
      if (reasons.length) ctx.push(`Not sure: ${reasons.join('; ')}`);
      add({ key, kind: 'action', group, title: r.nextAction, context: ctx.join(' · '), due: r.deadline || '' });
      actionShown = true;
    }

    if (roleMissing) {
      add({ key: 'q:role', kind: 'check', group: 'check', title: 'Find out which role this is', context: "The emails don't name the job title.", due: '' });
    }
    if (isClosed(r) && !stoppedAt(r)) {
      add({
        key: 'q:reached',
        kind: 'check',
        group: 'check',
        title: 'Note how far you got',
        context: `${STAGE_LABEL[r.stage]}, but the emails don't show which stage you reached.`,
        due: '',
      });
    }
    if (active && !actionShown && ['Interview', 'Assessment centre'].includes(r.stage) && r.lastEmailDate) {
      const quiet = daysBetween(r.lastEmailDate, today);
      if (quiet >= QUIET_DAYS) {
        add({
          key: `q:quiet:${r.lastEmailDate}`,
          kind: 'check',
          group: 'check',
          title: 'Check where things stand',
          context: `${STAGE_LABEL[r.stage]} · no email for ${quiet} days`,
          due: '',
        });
      }
    }
    if (reasons.length && !actionShown) {
      const rest = roleMissing ? reasons.filter((x) => !/role (unclear|not named)/i.test(x)) : reasons;
      if (rest.length) {
        add({ key: `q:review:${hash(rest.join('|'))}`, kind: 'check', group: 'check', title: 'Check these details', context: rest.join('; '), due: '' });
      }
    }
    return items;
  }

  function allItems(records, today) {
    return records.flatMap((r) => itemsFor(r, today));
  }

  const GROUP_RANK = { overdue: 0, soon: 1, later: 2, check: 3 };
  function compareItems(a, b) {
    if (GROUP_RANK[a.group] !== GROUP_RANK[b.group]) return GROUP_RANK[a.group] - GROUP_RANK[b.group];
    if (a.due !== b.due) return (a.due || '9999').localeCompare(b.due || '9999');
    return a.company.localeCompare(b.company);
  }

  // ---- All applications grouping ----
  // needs: an open action or check; closed: Rejected/Withdrawn; waiting: the rest.
  function bucket(r, today) {
    const open = itemsFor(r, today).filter((i) => !i.doneAt);
    if (open.length) return { bucket: 'needs', top: open.sort(compareItems)[0] };
    return { bucket: isClosed(r) ? 'closed' : 'waiting', top: null };
  }

  function sortForList(rows) {
    const order = { needs: 0, waiting: 1, closed: 2 };
    return rows.sort((a, b) => {
      if (a.bucket !== b.bucket) return order[a.bucket] - order[b.bucket];
      if (a.bucket === 'needs') {
        const c = compareItems(a.top, b.top);
        if (c) return c;
      }
      return (b.record.lastEmailDate || '').localeCompare(a.record.lastEmailDate || '');
    });
  }

  // ---- Latest news: real moves forward, rejections and withdrawals ----
  const NEWS_TEXT = {
    Test: 'Moved on to a test',
    Interview: 'Invited to interview',
    'Final stage': 'Reached the final stage',
    Offer: 'Offer',
  };
  function news(records, limit = 3) {
    const out = [];
    for (const r of records) {
      if (r.archived) continue;
      let best = -1;
      const tl = (r.timeline || []).slice().sort((a, b) => a.date.localeCompare(b.date));
      tl.forEach((e, i) => {
        const c = classifyEvent(e.event);
        let text = '';
        if (c.closed === 'Rejected') text = 'Not successful';
        else if (c.closed === 'Withdrawn') text = /cancel/i.test(e.event) ? 'Role cancelled' : 'Withdrawn';
        else if (c.step) {
          const idx = STEPS.indexOf(c.step);
          if (idx > best) {
            best = idx;
            text = NEWS_TEXT[c.step] || '';
          }
        }
        if (text) out.push({ date: e.date, order: i, recordId: r.id, company: r.company, role: r.role, text, detail: e.event });
      });
    }
    out.sort((a, b) => b.date.localeCompare(a.date) || b.order - a.order);
    return out.slice(0, limit);
  }

  return {
    STEPS,
    STAGE_TO_STEP,
    STAGE_LABEL,
    CLOSED_STAGES,
    QUIET_DAYS,
    SOON_DAYS,
    isClosed,
    todayStr,
    daysBetween,
    addDays,
    hash,
    classifyEvent,
    reachedFromTimeline,
    stoppedAt,
    progress,
    isWaitingText,
    itemsFor,
    allItems,
    compareItems,
    bucket,
    sortForList,
    news,
  };
});
