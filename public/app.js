'use strict';

/* global JT */
(function () {
  const STAGES = ['Draft', 'Applied', 'Online assessment', 'Interview', 'Assessment centre', 'Offer', 'Rejected', 'Withdrawn'];
  const STAGE_OPTION = {
    Draft: 'Draft (not sent yet)',
    Applied: 'Applied',
    'Online assessment': 'Test (online assessment)',
    Interview: 'Interview',
    'Assessment centre': 'Final stage (assessment centre)',
    Offer: 'Offer',
    Rejected: 'Not successful',
    Withdrawn: 'Withdrawn',
  };
  const EDIT_FIELDS = ['company', 'role', 'location', 'dateApplied', 'stage', 'stageReached', 'outcome', 'nextAction', 'deadline', 'lastEmailDate', 'notes'];
  const FIELD_LABEL = {
    company: 'company',
    role: 'role',
    location: 'location',
    dateApplied: 'date applied',
    stage: 'stage',
    stageReached: 'stage reached',
    outcome: 'decision',
    nextAction: 'next step',
    deadline: 'deadline',
    lastEmailDate: 'last heard',
  };
  const OUTLOOK_RE = /^https:\/\/outlook\.(live|office|office365)\.com\/(owa|mail)\//;
  const KEEP_TICKED_IN_PLACE_DAYS = 2;

  const state = {
    records: [],
    demo: false,
    lastScan: null,
    filter: 'all',
    search: '',
    showHidden: false,
    page: 'today',
    tickedThisSession: new Set(),
    editingId: null,
    loaded: false,
  };

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  // ---------- helpers ----------
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function parts(s) {
    const [y, m, d] = s.split('-').map(Number);
    return { y, m, d, wd: new Date(y, m - 1, d).getDay() };
  }
  function fmtDate(s, { year = false, weekday = false } = {}) {
    if (!s) return '';
    const p = parts(s);
    return `${weekday ? DAYS[p.wd] + ' ' : ''}${p.d} ${MONTHS[p.m - 1]}${year ? ' ' + p.y : ''}`;
  }
  function today() {
    return JT.todayStr();
  }
  function dueText(item) {
    if (!item.due) return '';
    const t = today();
    const n = JT.daysBetween(t, item.due);
    if (n < 0) return `Overdue · was due ${fmtDate(item.due, { weekday: true })}`;
    if (n === 0) return 'Due today';
    if (n === 1) return 'Due tomorrow';
    return `Due ${fmtDate(item.due, { weekday: true })}`;
  }
  const safeLink = (u) => (u && OUTLOOK_RE.test(u) ? u : '');
  const byId = (id) => state.records.find((r) => r.id === id);
  const visibleRecords = () => state.records.filter((r) => state.showHidden || !r.archived);

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2600);
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

  function replaceRecord(rec) {
    const i = state.records.findIndex((r) => r.id === rec.id);
    if (i >= 0) state.records[i] = rec;
    else state.records.push(rec);
  }

  async function load() {
    try {
      const data = await api('GET', '/api/applications');
      state.records = data.records || [];
      state.demo = !!data.demo;
      state.lastScan = data.lastScan || null;
      state.loaded = true;
      render();
    } catch (e) {
      $('#today-heading').textContent = "Couldn't load your applications";
      $('#today-sub').textContent = 'Is the Job Tracker server running? Try the desktop shortcut again.';
    }
  }

  // ---------- top bar ----------
  function renderTopbar() {
    $('#demo-banner').hidden = !state.demo;
    const s = state.lastScan && state.lastScan.scannedAt;
    if (s) {
      const d = new Date(s);
      const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      $('#scan-time').textContent = `Email last checked ${fmtDate(JT.todayStr(d))}, ${time}`;
    } else $('#scan-time').textContent = 'Email not checked yet';
    for (const a of $$('[data-nav]')) {
      if (a.dataset.nav === state.page) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  // ---------- Today ----------
  function itemVisibleInPlace(item) {
    if (!item.doneAt) return true;
    if (state.tickedThisSession.has(`${item.recordId}|${item.key}`)) return true;
    return JT.daysBetween(item.doneAt.slice(0, 10), today()) < KEEP_TICKED_IN_PLACE_DAYS;
  }

  function itemHtml(item) {
    const done = !!item.doneAt;
    const overdue = item.group === 'overdue';
    const link = safeLink(item.link);
    const id = `tick-${JT.hash(item.recordId + item.key)}`;
    const meta = [item.role, item.context].filter(Boolean).map(esc).join(' · ');
    return `
      <li class="item${done ? ' is-done' : ''}${overdue ? ' is-overdue' : ''}">
        <div class="tick">
          <input type="checkbox" id="${id}" data-record="${esc(item.recordId)}" data-key="${esc(item.key)}"${done ? ' checked' : ''}>
          <label for="${id}"><span class="sr-only">Done: ${esc(item.title)} (${esc(item.company)})</span></label>
        </div>
        <div class="item-body">
          <p class="item-title">${done ? '<span class="done-word">Done</span> ' : ''}${esc(item.title)}</p>
          <p class="item-meta"><button type="button" class="link-btn" data-open="${esc(item.recordId)}">${esc(item.company)}</button>${meta ? ' · ' + meta : ''}</p>
        </div>
        <div class="item-side">
          ${item.due ? `<span class="due${overdue ? ' due-overdue' : ''}">${esc(dueText(item))}</span>` : ''}
          ${link ? `<a class="btn btn-small" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open email<span class="sr-only"> from ${esc(item.company)}</span></a>` : ''}
        </div>
      </li>`;
  }

  function groupHtml(cls, title, hint, items, emptyText) {
    if (!items.length && !emptyText) return '';
    return `
      <section class="group group-${cls}" aria-labelledby="g-${cls}">
        <div class="group-head">
          <h2 id="g-${cls}">${esc(title)} <span class="group-count">${items.filter((i) => !i.doneAt).length}</span></h2>
          <p class="group-hint">${esc(hint)}</p>
        </div>
        ${items.length ? `<ul class="items">${items.map(itemHtml).join('')}</ul>` : `<p class="group-empty">${esc(emptyText)}</p>`}
      </section>`;
  }

  function renderToday() {
    const t = today();
    $('#today-date').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    const records = state.records.filter((r) => !r.archived);
    const all = JT.allItems(records, t).sort(JT.compareItems);
    const shown = all.filter((i) => i.group !== 'later');
    const inPlace = shown.filter(itemVisibleInPlace);
    const doneEarlier = shown.filter((i) => !itemVisibleInPlace(i));
    const g = (name) => inPlace.filter((i) => i.group === name);

    const overdue = g('overdue');
    const soon = g('soon');
    const checks = g('check');
    const count = [...overdue, ...soon].filter((i) => !i.doneAt).length;
    const openChecks = checks.filter((i) => !i.doneAt).length;

    $('#today-heading').textContent =
      count === 0 ? 'You are all caught up' : `${count} ${count === 1 ? 'thing needs' : 'things need'} you`;
    const later = all.filter((i) => i.group === 'later' && !i.doneAt).length;
    const sub = [];
    if (count === 0) sub.push('Nothing is overdue or due in the next 7 days.');
    if (openChecks) sub.push(`${openChecks} quick ${openChecks === 1 ? 'check' : 'checks'} below when you have a minute.`);
    if (later) sub.push(`${later} more ${later === 1 ? 'action is' : 'actions are'} due after next week.`);
    $('#today-sub').textContent = sub.join(' ');

    let html = '';
    html += groupHtml('overdue', 'Overdue', 'The deadline has passed.', overdue, '');
    html += groupHtml('soon', 'Coming up', 'Due in the next 7 days, soonest first.', soon, 'Nothing due in the next 7 days.');
    html += groupHtml('check', 'Quick checks', "Missing or uncertain details. These don't count towards the total above.", checks, '');
    if (doneEarlier.length) {
      html += `
        <details class="done-earlier">
          <summary>Done earlier (${doneEarlier.length})</summary>
          <ul class="items">${doneEarlier.map(itemHtml).join('')}</ul>
        </details>`;
    }
    if (!state.records.length) html = '<p class="group-empty">No applications yet. Add one, or run a scan.</p>';
    $('#checklist').innerHTML = html;

    renderBars(records);
    renderNews(records);
  }

  function renderBars(records) {
    const counts = STAGES.map((s) => ({ stage: s, n: records.filter((r) => r.stage === s).length }));
    const max = Math.max(1, ...counts.map((c) => c.n));
    $('#stage-bars').innerHTML = counts
      .map(
        (c) => `
        <li class="bar${JT.CLOSED_STAGES.includes(c.stage) ? ' bar-closed' : ''}">
          <span class="bar-label">${esc(JT.STAGE_LABEL[c.stage])}</span>
          <span class="bar-track" aria-hidden="true"><span class="bar-fill" data-w="${(c.n / max) * 100}"></span></span>
          <span class="bar-num">${c.n}</span>
        </li>`
      )
      .join('');
    // Widths set through the CSSOM (inline style attributes are blocked by the CSP).
    for (const el of $$('.bar-fill', $('#stage-bars'))) el.style.width = `${el.dataset.w}%`;
  }

  function renderNews(records) {
    const items = JT.news(records, 3);
    $('#news').innerHTML = items.length
      ? items
          .map(
            (n) => `
        <li>
          <button type="button" class="news-item" data-open="${esc(n.recordId)}">
            <span class="news-title"><strong>${esc(n.company)}</strong>: ${esc(n.text)}</span>
            <span class="news-meta">${esc(n.role)}${n.role ? ' · ' : ''}${esc(fmtDate(n.date, { year: true }))}</span>
          </button>
        </li>`
          )
          .join('')
      : '<li class="news-empty">No news yet.</li>';
  }

  // ---------- All applications ----------
  function matchesSearch(r, q) {
    if (!q) return true;
    const hay = [r.company, r.role, r.location, r.notes, r.nextAction].join(' ').toLowerCase();
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((w) => hay.includes(w));
  }

  function trackerHtml(r) {
    const p = JT.progress(r);
    const steps = JT.STEPS.map((name, i) => {
      let cls = 'todo';
      if (i < p.current) cls = 'done';
      else if (i === p.current) cls = 'current';
      return `<li class="step step-${cls}"><span class="dot" aria-hidden="true"></span><span class="step-name">${esc(name)}</span></li>`;
    }).join('');
    let label;
    let status = '';
    if (p.draft) {
      label = 'Draft, not sent yet';
      status = 'Not sent yet';
    } else if (p.closed) {
      const word = JT.STAGE_LABEL[r.stage];
      if (p.unknown) {
        label = `${word}, stage reached not known`;
        status = `${word} · stage reached not known`;
      } else {
        label = `${word} at ${JT.STEPS[p.current]}`;
        status = `${word} at ${JT.STEPS[p.current]}`;
      }
    } else label = `At ${JT.STEPS[p.current]}, step ${p.current + 1} of 5`;
    return `
      <div class="track">
        <ol class="tracker${p.closed ? ' is-closed' : ''}" aria-label="${esc(label)}">${steps}</ol>
        ${status ? `<p class="track-status">${esc(status)}</p>` : ''}
      </div>`;
  }

  function nextStepHtml(r, b) {
    const lines = [];
    if (r.stage === 'Draft') lines.push('<span class="next-main">Draft</span>');
    if (b.bucket === 'needs') {
      const it = b.top;
      const tag = it.group === 'overdue' ? '<span class="tag tag-overdue">Overdue</span>' : '<span class="tag tag-needs">Needs you</span>';
      lines.push(`<span class="next-main">${tag} ${esc(it.title)}</span>`);
      if (it.due) lines.push(`<span class="next-sub">${esc(dueText(it))}</span>`);
      else if (it.kind === 'check') lines.push(`<span class="next-sub">${esc(it.context)}</span>`);
    } else if (b.bucket === 'waiting' && r.stage !== 'Draft') {
      const ownAction = r.nextAction && !JT.isWaitingText(r.nextAction);
      if (ownAction) {
        // The action is ticked off: say so, then that we're waiting.
        lines.push(`<span class="next-main"><span class="tag">Done</span> ${esc(r.nextAction)}</span>`);
        lines.push('<span class="next-sub">Waiting to hear back</span>');
      } else {
        const text = r.nextAction && !/^\s*wait for response\s*$/i.test(r.nextAction) ? r.nextAction : 'Waiting to hear back';
        lines.push(`<span class="next-main">${esc(text)}</span>`);
      }
    } else if (b.bucket === 'closed') {
      lines.push(`<span class="next-main">Closed</span>`);
    }
    return lines.join('');
  }

  function renderAll() {
    const t = today();
    const q = state.search.trim();
    const base = visibleRecords().filter((r) => matchesSearch(r, q));
    const rows = base.map((r) => ({ record: r, ...JT.bucket(r, t) }));
    const counts = { all: rows.length, needs: 0, waiting: 0, closed: 0 };
    rows.forEach((x) => counts[x.bucket]++);

    for (const btn of $$('.pill')) {
      const f = btn.dataset.filter;
      btn.setAttribute('aria-pressed', String(f === state.filter));
      $('.pill-count', btn).textContent = counts[f];
    }

    const shown = JT.sortForList(rows.filter((x) => state.filter === 'all' || x.bucket === state.filter));
    $('#rows').innerHTML = shown
      .map(({ record: r, bucket, top }) => {
        const b = { bucket, top };
        return `
        <tr class="row row-${bucket}${r.archived ? ' row-hidden' : ''}" data-id="${esc(r.id)}">
          <td class="c-name">
            <button type="button" class="row-btn" data-open="${esc(r.id)}">
              <span class="company">${esc(r.company || 'Unknown company')}</span>
              <span class="role">${r.role ? esc(r.role) : '<em>Role not known</em>'}</span>
              ${r.archived ? '<span class="tag">Hidden</span>' : ''}
            </button>
          </td>
          <td class="c-track">${trackerHtml(r)}</td>
          <td class="c-next">${nextStepHtml(r, b)}</td>
          <td class="c-date">${r.lastEmailDate ? `<time datetime="${esc(r.lastEmailDate)}">${esc(fmtDate(r.lastEmailDate, { year: true }))}</time>` : '<span class="muted">Not yet</span>'}</td>
        </tr>`;
      })
      .join('');
    $('#empty').hidden = shown.length > 0;
    const filterName = { all: 'applications', needs: 'that need you', waiting: 'waiting to hear back', closed: 'closed' }[state.filter];
    $('#result-count').textContent = `Showing ${shown.length} ${state.filter === 'all' ? 'applications' : filterName}${q ? ` matching "${q}"` : ''}`;
    const anyHidden = state.records.some((r) => r.archived);
    $('#hidden-toggle-wrap').hidden = !anyHidden && !state.showHidden;
  }

  // ---------- editor ----------
  function fillSelect(sel, options) {
    sel.innerHTML = options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  }

  function updateConditionalFields() {
    const stage = $('#f-stage').value;
    $('#reached-field').hidden = !JT.CLOSED_STAGES.includes(stage);
    $('#decision-field').hidden = stage !== 'Offer';
  }

  function fieldMeta(rec) {
    for (const el of $$('.field-meta', $('#edit-form'))) el.remove();
    if (!rec) return;
    for (const f of EDIT_FIELDS) {
      const wrap = $(`.field[data-field="${f}"]`);
      if (!wrap) continue;
      const bits = [];
      if (rec.manualFields.includes(f)) {
        bits.push(`<span class="tag">Edited by you</span> <span class="muted">Email updates won't change this.</span>
          <button type="button" class="btn-link" data-unlock="${f}">Let email updates change it</button>`);
      }
      if (f in (rec.scanSuggestions || {})) {
        const v = rec.scanSuggestions[f];
        const shown = f === 'stage' ? JT.STAGE_LABEL[v] || v : f.endsWith('Date') || f === 'deadline' ? fmtDate(v, { year: true }) : v;
        bits.push(`<span>Latest email says: <strong>${esc(shown || '(empty)')}</strong></span>
          <button type="button" class="btn-link" data-unlock="${f}">Use this</button>`);
      }
      if (bits.length) wrap.insertAdjacentHTML('beforeend', `<p class="field-meta">${bits.join('<br>')}</p>`);
    }
  }

  function openEditor(id) {
    const rec = id ? byId(id) : null;
    state.editingId = rec ? rec.id : null;
    const form = $('#edit-form');
    form.reset();
    $('#form-error').textContent = '';
    fillSelect($('#f-stage'), STAGES.map((s) => [s, STAGE_OPTION[s]]));
    fillSelect($('#f-stageReached'), [['', 'Not sure'], ...JT.STEPS.map((s) => [s, s])]);

    $('#editor-title').textContent = rec ? `${rec.company}${rec.role ? ': ' + rec.role : ''}` : 'Add an application';
    const v = rec || { stage: 'Applied', outcome: 'Pending', dateApplied: today() };
    for (const f of EDIT_FIELDS) {
      const el = form.elements[f];
      if (!el) continue;
      if (f === 'stageReached') el.value = rec ? JT.stoppedAt(rec) || '' : '';
      else if (f === 'outcome') el.value = ['Accepted', 'Declined'].includes(v.outcome) ? v.outcome : 'Offer';
      else el.value = v[f] || '';
    }
    $('#f-company').readOnly = false;
    updateConditionalFields();
    fieldMeta(rec);

    const note = $('#review-note');
    if (rec && rec.needsReview && rec.reviewReasons.length) {
      note.hidden = false;
      note.innerHTML = `<strong>Needs checking:</strong> ${rec.reviewReasons.map(esc).join('; ')}`;
    } else note.hidden = true;

    $('#checked-btn').hidden = !(rec && rec.needsReview);
    $('#hide-btn').hidden = !rec;
    $('#hide-btn').textContent = rec && rec.archived ? 'Show in lists again' : 'Hide from lists';
    $('#save-btn').textContent = rec ? 'Save changes' : 'Add application';

    const link = rec && safeLink(rec.outlookLink);
    $('#email-link-wrap').innerHTML = link
      ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open latest email in Outlook</a>`
      : '';
    const tl = rec ? rec.timeline.slice().reverse() : [];
    $('#history-wrap').hidden = !tl.length;
    $('#history').innerHTML = tl
      .map((e) => `<li><span class="h-date">${esc(fmtDate(e.date, { year: true }))}</span> ${esc(e.event)}</li>`)
      .join('');
    $('#panel-extra').hidden = !rec;

    const dlg = $('#editor');
    if (!dlg.open) dlg.showModal();
    (rec ? $('#f-stage') : $('#f-company')).focus();
  }

  function closeEditor() {
    const dlg = $('#editor');
    if (dlg.open) dlg.close();
    state.editingId = null;
  }

  function collectChanges(rec) {
    const form = $('#edit-form');
    const out = {};
    const stage = form.elements.stage.value;
    for (const f of EDIT_FIELDS) {
      const el = form.elements[f];
      if (!el || f === 'outcome' || f === 'stageReached') continue;
      const val = f === 'notes' ? el.value : el.value.trim();
      const cur = rec ? rec[f] || '' : '';
      if (val !== cur && (rec || val)) out[f] = val;
    }
    // "Got as far as" only applies to closed applications.
    if (JT.CLOSED_STAGES.includes(stage)) {
      const reached = form.elements.stageReached.value;
      const cur = rec ? JT.stoppedAt(rec) || '' : '';
      if (reached !== cur) out.stageReached = reached;
    }
    // Keep the stored outcome in line with the stage (not shown as a separate field).
    let outcome;
    if (stage === 'Rejected') outcome = 'Rejected';
    else if (stage === 'Withdrawn') outcome = 'Withdrawn';
    else if (stage === 'Offer') outcome = form.elements.outcome.value;
    else outcome = 'Pending';
    if (!rec || rec.outcome !== outcome) out.outcome = outcome;
    return out;
  }

  async function saveEditor(ev) {
    ev.preventDefault();
    const rec = state.editingId ? byId(state.editingId) : null;
    const err = $('#form-error');
    err.textContent = '';
    const company = $('#f-company').value.trim();
    const role = $('#f-role').value.trim();
    if (!company) {
      err.textContent = 'Please enter the company name.';
      $('#f-company').focus();
      return;
    }
    if (!rec && !role) {
      err.textContent = 'Please enter the role so this application can be told apart from others.';
      $('#f-role').focus();
      return;
    }
    const changes = collectChanges(rec);
    if (rec && !Object.keys(changes).length) {
      closeEditor();
      return;
    }
    try {
      const saved = rec
        ? await api('PATCH', `/api/applications/${encodeURIComponent(rec.id)}`, changes)
        : await api('POST', '/api/applications', changes);
      replaceRecord(saved);
      closeEditor();
      render();
      toast(rec ? 'Changes saved' : 'Application added');
    } catch (e) {
      err.textContent = e.message;
    }
  }

  async function editorAction(fn, msg) {
    const id = state.editingId;
    try {
      const saved = await fn(id);
      replaceRecord(saved);
      render();
      if (msg) toast(msg);
      return saved;
    } catch (e) {
      $('#form-error').textContent = e.message;
      return null;
    }
  }

  // ---------- ticking ----------
  async function onTick(input) {
    const id = input.dataset.record;
    const key = input.dataset.key;
    const done = input.checked;
    state.tickedThisSession.add(`${id}|${key}`);
    const rec = byId(id);
    // Optimistic update so the checkbox responds immediately.
    if (rec) {
      rec.done = { ...(rec.done || {}) };
      if (done) rec.done[key] = new Date().toISOString();
      else delete rec.done[key];
    }
    render();
    restoreFocus(id, key);
    try {
      const saved = await api('POST', `/api/applications/${encodeURIComponent(id)}/done`, { key, done });
      replaceRecord(saved);
      render();
      restoreFocus(id, key);
    } catch (e) {
      toast(`Couldn't save that: ${e.message}`);
      load();
    }
  }
  function restoreFocus(id, key) {
    const el = $$('#checklist input[type="checkbox"]').find((i) => i.dataset.record === id && i.dataset.key === key);
    if (el) el.focus();
  }

  // ---------- routing and render ----------
  function route() {
    const h = location.hash.replace('#', '');
    state.page = h === 'all' ? 'all' : 'today';
    $('#page-today').hidden = state.page !== 'today';
    $('#page-all').hidden = state.page !== 'all';
    document.title = state.page === 'all' ? 'All applications · Job Tracker' : 'Today · Job Tracker';
    render();
  }

  function render() {
    renderTopbar();
    if (!state.loaded) return;
    if (state.page === 'today') renderToday();
    else renderAll();
  }

  // ---------- events ----------
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    const open = t.closest('[data-open]');
    if (open) {
      openEditor(open.dataset.open);
      return;
    }
    if (t.closest('[data-action="add"]')) {
      openEditor(null);
      return;
    }
    if (t.closest('[data-action="close"]')) {
      closeEditor();
      return;
    }
    const row = t.closest('tr.row');
    if (row && !t.closest('a, button, input')) {
      openEditor(row.dataset.id);
      return;
    }
    const pill = t.closest('.pill');
    if (pill) {
      state.filter = pill.dataset.filter;
      renderAll();
      return;
    }
    const unlock = t.closest('[data-unlock]');
    if (unlock) {
      const field = unlock.dataset.unlock;
      editorAction(
        (id) => api('POST', `/api/applications/${encodeURIComponent(id)}/unlock`, { field }),
        `Email updates can change the ${FIELD_LABEL[field] || field} again`
      ).then((saved) => saved && openEditor(saved.id));
    }
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.matches('#checklist input[type="checkbox"]')) onTick(t);
    if (t.id === 'f-stage') updateConditionalFields();
    if (t.id === 'show-hidden') {
      state.showHidden = t.checked;
      renderAll();
    }
  });

  $('#search').addEventListener('input', (ev) => {
    state.search = ev.target.value;
    renderAll();
  });
  $('#edit-form').addEventListener('submit', saveEditor);
  $('#editor').addEventListener('close', () => (state.editingId = null));
  $('#checked-btn').addEventListener('click', () =>
    editorAction((id) => api('POST', `/api/applications/${encodeURIComponent(id)}/review`, { reviewed: true }), 'Marked as checked').then(
      (saved) => saved && openEditor(saved.id)
    )
  );
  $('#hide-btn').addEventListener('click', async () => {
    const rec = byId(state.editingId);
    if (!rec) return;
    const saved = await editorAction(
      (id) => api('PATCH', `/api/applications/${encodeURIComponent(id)}`, { archived: !rec.archived }),
      rec.archived ? 'Shown in lists again' : 'Hidden from lists'
    );
    if (saved) closeEditor();
  });

  window.addEventListener('hashchange', () => {
    route();
    $('#main').focus();
  });
  // Pick up changes from a scan made while the page was open.
  window.addEventListener('focus', () => {
    if (!$('#editor').open) load();
  });

  route();
  load();
})();
