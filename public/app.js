'use strict';

(() => {
  const state = {
    records: [],
    meta: { stages: [], outcomes: [] },
    view: 'pipeline',
    sort: { key: 'lastEmailDate', dir: 'desc' },
    openId: null,
  };
  const TERMINAL = ['Offer', 'Rejected', 'Withdrawn'];
  const $ = (id) => document.getElementById(id);

  // ---------- helpers ----------
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const today = () => new Date().toISOString().slice(0, 10);
  function daysUntil(date) {
    if (!date) return null;
    return Math.round((new Date(date + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
  }
  function fmtDate(d) {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: dt.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  function isActive(r) {
    return !TERMINAL.includes(r.stage);
  }
  function deadlineTag(r) {
    if (!r.deadline || !isActive(r)) return null;
    const d = daysUntil(r.deadline);
    if (d < 0) return h('span', { class: 'tag due', text: `Overdue ${fmtDate(r.deadline)}` });
    if (d <= 3) return h('span', { class: 'tag due', text: d === 0 ? 'Due today' : `Due in ${d}d` });
    if (d <= 10) return h('span', { class: 'tag soon', text: `Due ${fmtDate(r.deadline)}` });
    return h('span', { class: 'tag', text: `Due ${fmtDate(r.deadline)}` });
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 2200);
  }
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  function safeOutlookLink(url) {
    return /^https:\/\/(outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com)\//i.test(url || '') ? url : null;
  }

  // ---------- filtering ----------
  function filtered() {
    const q = $('search').value.trim().toLowerCase();
    const stage = $('stageFilter').value;
    const outcome = $('outcomeFilter').value;
    const active = $('activeFilter').value;
    const review = $('reviewFilter').checked;
    const archived = $('archivedFilter').checked;
    return state.records.filter((r) => {
      if (!archived && r.archived) return false;
      if (stage && r.stage !== stage) return false;
      if (outcome && r.outcome !== outcome) return false;
      if (active === 'active' && !isActive(r)) return false;
      if (active === 'closed' && isActive(r)) return false;
      if (review && !r.needsReview) return false;
      if (q) {
        const hay = [r.company, r.role, r.location, r.notes, r.nextAction, r.stage, r.outcome].join(' ').toLowerCase();
        if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
      }
      return true;
    });
  }

  // ---------- rendering ----------
  function renderStats() {
    const live = state.records.filter((r) => !r.archived);
    const count = (fn) => live.filter(fn).length;
    const items = [
      ['Total', live.length],
      ['Active', count(isActive)],
      ['Interviews+', count((r) => ['Interview', 'Assessment centre', 'Offer'].includes(r.stage))],
      ['Offers', count((r) => r.stage === 'Offer')],
      ['Rejected', count((r) => r.stage === 'Rejected')],
      ['Needs review', count((r) => r.needsReview)],
    ];
    $('stats').replaceChildren(...items.map(([l, n]) => h('div', { class: 'stat' }, h('div', { class: 'n', text: n }), h('div', { class: 'l', text: l }))));
  }

  function card(r) {
    return h(
      'button',
      { class: 'card', type: 'button', onclick: () => openDrawer(r.id) },
      h('div', { class: 'company', text: r.company || '(unknown company)' }),
      h('div', { class: 'role', text: r.role || '(unknown role)' }),
      h(
        'div',
        { class: 'meta' },
        r.needsReview ? h('span', { class: 'tag review', text: 'Review' }) : null,
        deadlineTag(r),
        r.location ? h('span', { class: 'tag', text: r.location }) : null,
        r.lastEmailDate ? h('span', { class: 'tag', text: `Last email ${fmtDate(r.lastEmailDate)}` }) : null,
      ),
    );
  }

  function renderPipeline(list) {
    const cols = state.meta.stages.map((stage) => {
      const items = list
        .filter((r) => r.stage === stage)
        .sort((a, b) => (b.lastEmailDate || '').localeCompare(a.lastEmailDate || ''));
      return h(
        'section',
        { class: 'column', 'aria-label': stage },
        h('div', { class: 'column-head' }, h('span', { text: stage }), h('span', { class: 'count', text: items.length })),
        items.length ? items.map(card) : h('div', { class: 'empty', text: '—' }),
      );
    });
    $('pipelineView').replaceChildren(...cols);
  }

  const COLUMNS = [
    ['company', 'Company'],
    ['role', 'Role'],
    ['location', 'Location'],
    ['stage', 'Stage'],
    ['outcome', 'Outcome'],
    ['dateApplied', 'Applied'],
    ['deadline', 'Deadline'],
    ['lastEmailDate', 'Last email'],
    ['nextAction', 'Next action'],
  ];
  function renderTable(list) {
    const { key, dir } = state.sort;
    const rows = list.slice().sort((a, b) => {
      const av = key === 'stage' ? state.meta.stages.indexOf(a.stage) : a[key] || '';
      const bv = key === 'stage' ? state.meta.stages.indexOf(b.stage) : b[key] || '';
      const c = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return dir === 'asc' ? c : -c;
    });
    const head = h(
      'tr',
      {},
      COLUMNS.map(([k, label]) =>
        h('th', {
          class: k === key ? `sorted ${dir}` : '',
          text: label,
          onclick: () => {
            state.sort = { key: k, dir: key === k && dir === 'desc' ? 'asc' : 'desc' };
            render();
          },
        }),
      ),
    );
    const body = rows.map((r) =>
      h(
        'tr',
        { onclick: () => openDrawer(r.id) },
        h('td', {}, h('strong', { text: r.company }), r.needsReview ? [' ', h('span', { class: 'tag review', text: 'Review' })] : null),
        h('td', { text: r.role }),
        h('td', { text: r.location }),
        h('td', { class: 'nowrap', text: r.stage }),
        h('td', { text: r.outcome }),
        h('td', { class: 'nowrap', text: fmtDate(r.dateApplied) }),
        h('td', { class: 'nowrap' }, deadlineTag(r) || fmtDate(r.deadline)),
        h('td', { class: 'nowrap', text: fmtDate(r.lastEmailDate) }),
        h('td', { text: r.nextAction }),
      ),
    );
    $('tableView').replaceChildren(
      h('table', {}, h('thead', {}, head), h('tbody', {}, body.length ? body : h('tr', {}, h('td', { colspan: COLUMNS.length, class: 'empty', text: 'No applications match.' })))),
    );
  }

  function renderSide() {
    const upcoming = state.records
      .filter((r) => !r.archived && r.deadline && isActive(r) && daysUntil(r.deadline) >= -7)
      .sort((a, b) => a.deadline.localeCompare(b.deadline));
    $('deadlines').replaceChildren(
      ...(upcoming.length
        ? upcoming.map((r) => {
            const d = daysUntil(r.deadline);
            const when = d < 0 ? `Overdue (${fmtDate(r.deadline)})` : d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `${fmtDate(r.deadline)} · ${d} days`;
            return h(
              'li',
              { onclick: () => openDrawer(r.id) },
              h('div', { class: 'when', style: null, text: when }),
              h('div', { class: 'what', text: `${r.company} — ${r.stage}` }),
              r.nextAction ? h('div', { class: 'sub', text: r.nextAction }) : null,
            );
          })
        : [h('li', { class: 'empty', text: 'No upcoming deadlines.' })]),
    );
    const review = state.records.filter((r) => r.needsReview && !r.archived);
    $('reviewList').replaceChildren(
      ...(review.length
        ? review.map((r) =>
            h(
              'li',
              { onclick: () => openDrawer(r.id) },
              h('div', { class: 'what', text: `${r.company} — ${r.role}` }),
              h('div', { class: 'sub', text: (r.reviewReasons || []).join('; ') || 'Flagged' }),
            ),
          )
        : [h('li', { class: 'empty', text: 'Nothing to review.' })]),
    );
  }

  function render() {
    const list = filtered();
    renderStats();
    $('pipelineView').hidden = state.view !== 'pipeline';
    $('tableView').hidden = state.view !== 'table';
    if (state.view === 'pipeline') renderPipeline(list);
    else renderTable(list);
    renderSide();
  }

  // ---------- drawer ----------
  const FORM_FIELDS = [
    ['company', 'Company', 'text'],
    ['role', 'Role', 'text'],
    ['location', 'Location', 'text'],
    ['stage', 'Stage', 'stage'],
    ['outcome', 'Outcome', 'outcome'],
    ['dateApplied', 'Date applied', 'date'],
    ['deadline', 'Deadline', 'date'],
    ['lastEmailDate', 'Last email', 'date'],
    ['nextAction', 'Next action', 'text', true],
    ['outlookLink', 'Outlook link', 'url', true],
  ];

  function fieldInput(rec, key, type) {
    const value = rec ? rec[key] || '' : key === 'stage' ? 'Applied' : key === 'outcome' ? 'Pending' : '';
    if (type === 'stage' || type === 'outcome') {
      const opts = type === 'stage' ? state.meta.stages : state.meta.outcomes;
      return h('select', { name: key, id: `f-${key}` }, opts.map((o) => h('option', { value: o, selected: o === value, text: o })));
    }
    return h('input', { name: key, id: `f-${key}`, type, value });
  }

  function openDrawer(id) {
    const rec = id ? state.records.find((r) => r.id === id) : null;
    state.openId = rec ? rec.id : null;
    $('drawerTitle').textContent = rec ? `${rec.company} — ${rec.role}` : 'New application';
    const form = $('editForm');
    const parts = [];

    if (rec && rec.needsReview) {
      parts.push(
        h('div', { class: 'reasons' }, h('strong', { text: 'Needs review' }), h('ul', {}, (rec.reviewReasons.length ? rec.reviewReasons : ['Flagged']).map((x) => h('li', { text: x })))),
      );
    }

    for (const [key, label, type, full] of FORM_FIELDS) {
      const locked = rec && rec.manualFields.includes(key);
      const suggestion = rec && rec.scanSuggestions && rec.scanSuggestions[key];
      parts.push(
        h(
          'div',
          { class: `field${full ? ' full' : ''}` },
          h(
            'label',
            { for: `f-${key}` },
            label,
            locked ? h('span', { class: 'tag lock', title: 'You edited this; scans will not overwrite it', text: 'manual' }) : null,
            locked ? h('button', { type: 'button', class: 'lock-btn', onclick: () => unlock(rec.id, key), text: suggestion ? 'use scan value' : 'let scans update' }) : null,
          ),
          fieldInput(rec, key, type),
          suggestion !== undefined && suggestion !== null && suggestion !== '' ? h('div', { class: 'suggest', text: `Latest scan says: ${suggestion}` }) : null,
        ),
      );
    }

    const link = rec && safeOutlookLink(rec.outlookLink);
    if (link) parts.push(h('div', { class: 'field full' }, h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: 'Open latest email in Outlook ↗' })));

    parts.push(
      h(
        'div',
        { class: 'field full' },
        h('label', { for: 'f-notes' }, 'Notes (never changed by scans)'),
        h('textarea', { name: 'notes', id: 'f-notes' }, rec ? rec.notes || '' : ''),
      ),
    );

    if (rec && rec.timeline && rec.timeline.length) {
      parts.push(
        h(
          'div',
          { class: 'timeline' },
          h('strong', { text: 'Email timeline' }),
          h('ol', {}, rec.timeline.map((e) => h('li', {}, `${fmtDate(e.date)} — `, h('span', { text: e.event })))),
        ),
      );
    }

    parts.push(
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', type: 'submit', text: rec ? 'Save changes' : 'Add application' }),
        rec
          ? h('button', {
              class: 'btn',
              type: 'button',
              text: rec.needsReview ? 'Mark reviewed' : 'Flag for review',
              onclick: () => setReview(rec.id, rec.needsReview),
            })
          : null,
        h('span', { class: 'spacer' }),
        rec
          ? h('button', {
              class: 'btn danger',
              type: 'button',
              text: rec.archived ? 'Unarchive' : 'Archive',
              onclick: () => save(rec.id, { archived: !rec.archived }),
            })
          : null,
      ),
    );

    form.replaceChildren(...parts);
    $('drawer').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('backdrop').hidden = false;
    setTimeout(() => (rec ? $('f-notes') : $('f-company')).focus(), 50);
  }

  function closeDrawer() {
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('backdrop').hidden = true;
    state.openId = null;
  }

  function replaceRecord(rec) {
    const i = state.records.findIndex((r) => r.id === rec.id);
    if (i >= 0) state.records[i] = rec;
    else state.records.push(rec);
  }

  async function save(id, changes) {
    try {
      const rec = id ? await api('PATCH', `/api/applications/${encodeURIComponent(id)}`, changes) : await api('POST', '/api/applications', changes);
      replaceRecord(rec);
      render();
      openDrawer(rec.id);
      toast(id ? 'Saved' : 'Added');
    } catch (e) {
      toast(e.message);
    }
  }

  async function setReview(id, reviewed) {
    try {
      replaceRecord(await api('POST', `/api/applications/${encodeURIComponent(id)}/review`, { reviewed }));
      render();
      openDrawer(id);
      toast(reviewed ? 'Marked as reviewed' : 'Flagged for review');
    } catch (e) {
      toast(e.message);
    }
  }

  async function unlock(id, field) {
    try {
      replaceRecord(await api('POST', `/api/applications/${encodeURIComponent(id)}/unlock`, { field }));
      render();
      openDrawer(id);
      toast('Scans can update this field again');
    } catch (e) {
      toast(e.message);
    }
  }

  // Only send fields the user actually changed, so untouched fields stay
  // unlocked and keep receiving scan updates.
  $('editForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const rec = state.records.find((r) => r.id === state.openId);
    const data = Object.fromEntries(new FormData(ev.target).entries());
    const changes = {};
    for (const [k, v] of Object.entries(data)) {
      if (rec ? (rec[k] || '') !== v : v !== '') changes[k] = v;
    }
    if (rec && !Object.keys(changes).length) return toast('No changes');
    save(rec ? rec.id : null, changes);
  });

  // ---------- init ----------
  async function load() {
    const [meta, data] = await Promise.all([api('GET', '/api/meta'), api('GET', '/api/applications')]);
    state.meta = meta;
    state.records = data.records;
    $('demoBanner').hidden = !meta.demo;
    if (meta.lastScan && meta.lastScan.scannedAt) {
      $('scanInfo').textContent = `Last scan ${new Date(meta.lastScan.scannedAt).toLocaleString()}`;
    }
    if (!$('stageFilter').options.length || $('stageFilter').options.length === 1) {
      for (const s of meta.stages) $('stageFilter').append(h('option', { value: s, text: s }));
      for (const o of meta.outcomes) $('outcomeFilter').append(h('option', { value: o, text: o }));
    }
    render();
  }

  for (const id of ['search', 'stageFilter', 'outcomeFilter', 'activeFilter', 'reviewFilter', 'archivedFilter']) {
    $(id).addEventListener('input', render);
  }
  for (const b of document.querySelectorAll('.view-toggle button')) {
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      document.querySelectorAll('.view-toggle button').forEach((x) => x.classList.toggle('active', x === b));
      try { localStorage.setItem('jt-view', state.view); } catch {}
      render();
    });
  }
  try {
    const v = localStorage.getItem('jt-view');
    if (v === 'table' || v === 'pipeline') {
      state.view = v;
      document.querySelectorAll('.view-toggle button').forEach((x) => x.classList.toggle('active', x.dataset.view === v));
    }
  } catch {}
  $('addBtn').addEventListener('click', () => openDrawer(null));
  $('closeDrawer').addEventListener('click', closeDrawer);
  $('backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      $('search').focus();
    }
  });
  // Pick up changes from a rescan when the tab regains focus.
  window.addEventListener('focus', () => {
    if (!state.openId) load().catch(() => {});
  });

  load().catch((e) => toast(e.message));
})();
