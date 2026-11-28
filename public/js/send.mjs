import {
  api,
  body,
  confirmDialog,
  currentDelay,
  formatDuration,
  h,
  hooks,
  plural,
  reconcile,
  setAttr,
  setClass,
  setHidden,
  setText,
  state,
  store,
  toast,
  ui,
} from './api.mjs';
import { refreshPreview } from './compose.mjs';
import { renderDraft, setConn } from './overview.mjs';
import { loadRoster } from './recipients.mjs';
import { loadQueue } from './schedule.mjs';

// ── Connection check and test send ───────────────────────────────────
export async function verify() {
  for (const button of [ui.verifyBtn, ui.verifyBtn2]) button.disabled = true;
  setConn('wait');
  try {
    const data = await api('/api/verify', {});
    if (data.ok) {
      setConn('ok');
      toast('Signed in to ' + data.smtp.host + ':' + data.smtp.port + ' as ' + (data.smtp.user || 'local'), 'ok');
    } else {
      setConn('bad');
      toast(data.error || 'Connection failed', 'bad');
    }
  } catch (err) {
    setConn('bad');
    toast(err.message, 'bad');
  } finally {
    for (const button of [ui.verifyBtn, ui.verifyBtn2]) button.disabled = state.sending;
  }
}

function setTestResult(text, kind = '') {
  setText(ui.testResult, text);
  setClass(ui.testResult, 'is-ok', kind === 'ok');
  setClass(ui.testResult, 'is-bad', kind === 'bad');
}

async function sendTest() {
  const to = ui.testTo.value.trim();
  if (!to) { ui.testTo.focus(); setTestResult('Enter an address for the test message.', 'bad'); return; }
  if (state.sending) return;

  ui.testBtn.disabled = true;
  ui.testBtn.textContent = 'Sending test…';
  setTestResult('Sending…');
  try {
    const data = await api('/api/test', body({ to, index: state.index }));
    if (data.ok) {
      state.tested = true;
      setTestResult('Test delivered to ' + to + ' (' + plural(data.inline, 'inline image') + ').', 'ok');
      toast('Test delivered to ' + to, 'ok');
      setConn('ok');
      renderDraft();
    } else {
      setTestResult(data.error || 'The test message was not sent.', 'bad');
      toast(data.error || 'The test message was not sent.', 'bad');
    }
  } catch (err) {
    setTestResult(err.message, 'bad');
    toast(err.message, 'bad');
  } finally {
    ui.testBtn.disabled = state.sending;
    ui.testBtn.textContent = 'Send test';
  }
}

// ── Campaign progress ────────────────────────────────────────────────
const LEDGER_LIMIT = 400;

function clearLedger() {
  ui.ledger.replaceChildren();
  setHidden(ui.ledgerEmpty, false);
}

const UNSENT_REASON = { suppressed: 'suppressed', uncertain: 'earlier attempt unconfirmed; not mailed again' };
const THROTTLE_SCOPE = {
  hour: 'hourly send ceiling',
  day: 'daily send ceiling',
  domain: 'domain send ceiling',
};

function addLine({ n, tag, tagLabel, addr, note, bad = false }) {
  setHidden(ui.ledgerEmpty, true);
  const li = h('li', {},
    h('span', { class: 'n' }, n),
    h('span', { class: 'tag tag--' + tag }, tagLabel),
    h('div', {}, h('span', { class: 'addr' }, addr), note ? h('span', { class: 'note' + (bad ? ' is-bad' : '') }, note) : null));
  appendToLedger(li);
}

function addSummary(text) {
  setHidden(ui.ledgerEmpty, true);
  appendToLedger(h('li', { class: 'ledger__summary' }, text));
}

// Follow new lines only while the reader is at the bottom; someone scrolled
// up to read an earlier failure must not be dragged down on every message.
function appendToLedger(li) {
  const list = ui.ledger;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  list.append(li);
  while (list.children.length > LEDGER_LIMIT) list.firstElementChild.remove();
  if (atBottom) list.scrollTop = list.scrollHeight;
}

export function renderRun() {
  const { total, sent, failed, skipped, uncertain } = state.run;
  const done = sent + failed + skipped + uncertain;
  for (const bar of [ui.runProgress, ui.liveProgress]) {
    if (bar.max !== Math.max(total, 1)) bar.max = Math.max(total, 1);
    if (bar.value !== done) bar.value = done;
  }

  const label = state.run.label || (total ? done + ' of ' + total + ' processed' : 'Starting…');
  setText(ui.runLabel, label);
  setText(ui.liveText, 'Sending' + (state.run.campaign ? ' “' + state.run.campaign + '”' : '') + ' — ' + (total ? done + ' of ' + total : 'starting'));

  const counts = [['sent', sent], ['failed', failed], ['skipped', skipped], ...(uncertain ? [['unconfirmed', uncertain]] : [])];
  reconcile(ui.runCounts, counts, ([name]) => name,
    ([name]) => h('span', {}, name + ' ', h('b')),
    (node, [name, value]) => {
      setText(node.lastElementChild, String(value));
      setClass(node, 'is-bad', (name === 'failed' || name === 'unconfirmed') && value > 0);
    });
}

function setRunState(kind, text) {
  setAttr(ui.runState, 'data-state', kind);
  setText(ui.runState, text);
}

export function lockControls() {
  state.sending = true;
  ui.sendBtn.disabled = true;
  ui.testBtn.disabled = true;
  ui.verifyBtn.disabled = true;
  ui.verifyBtn2.disabled = true;
  setHidden(ui.cancelBtn, false);
  ui.cancelBtn.disabled = false;
  ui.cancelBtn.textContent = 'Stop after this one';
  clearLedger();
  state.run = { total: 0, sent: 0, failed: 0, skipped: 0, uncertain: 0, label: '', campaign: '' };
  setRunState('run', 'Sending');
  setHidden(ui.liveBar, false);
  setHidden(ui.navSendBadge, false);
  renderRun();
}

export function unlockControls() {
  state.sending = false;
  state.jobId = null;
  ui.testBtn.disabled = false;
  ui.verifyBtn.disabled = false;
  ui.verifyBtn2.disabled = false;
  setHidden(ui.cancelBtn, true);
  setHidden(ui.liveBar, true);
  setHidden(ui.navSendBadge, true);
  renderDraft();
}

async function startSend() {
  const p = state.lastPreview;
  if (!p || state.sending) return;

  const total = p.willSend * currentDelay();
  const details = h('dl', { class: 'facts' },
    h('div', {}, h('dt', {}, 'From'), h('dd', {}, state.smtp.from)),
    h('div', {}, h('dt', {}, 'Subject'), h('dd', {}, p.subject)),
    h('div', {}, h('dt', {}, 'Campaign'), h('dd', {}, ui.campaign.value.trim() || 'No campaign name')),
    h('div', {}, h('dt', {}, 'Starts with'), h('dd', {}, p.to)),
    h('div', {}, h('dt', {}, 'Takes about'), h('dd', {}, formatDuration(total))));
  const held = [
    p.skipped ? p.skipped + ' already logged for this campaign' : null,
    p.suppressed ? p.suppressed + ' on the suppression list' : null,
  ].filter(Boolean);

  const ok = await confirmDialog({
    title: 'Send this campaign for real?',
    body: [
      h('p', { class: 'dialog__count' }, h('strong', {}, String(p.willSend)), p.willSend === 1 ? 'recipient will get this message' : 'recipients will get this message'),
      details,
      h('p', { class: 'muted' }, held.length ? held.join(' and ') + ' will be skipped.' : 'Every recipient in this selection will receive it.'),
    ],
    confirmLabel: 'Send ' + plural(p.willSend, 'message') + ' now',
    danger: true,
    check: 'I understand these messages go out immediately to real inboxes.',
  });
  if (!ok) return;

  lockControls();
  try {
    const data = await api('/api/send', body({ confirm: true, delay: currentDelay() }));
    listen(data.jobId);
  } catch (err) {
    unlockControls();
    toast(err.message, 'bad');
  }
}

/** Re-attach to a campaign that survived a page reload or was started by the scheduler. */
export async function resumeActiveJob({ quiet = false } = {}) {
  if (state.sending) return;
  try {
    const active = await api('/api/jobs/active');
    if (!active?.jobId) return;
    lockControls();
    listen(active.jobId);
    if (!quiet) toast('Showing a campaign that is still sending' + (active.total ? ' (' + plural(active.total, 'recipient') + ')' : '') + '.', 'ok');
  } catch { /* nothing running, or server restarting */ }
}

export function listen(jobId, attempt = 0) {
  if (state.stream) state.stream.close();
  const stream = new EventSource('/api/jobs/' + jobId + '/events');
  state.stream = stream;
  state.jobId = jobId;

  let finished = false;

  stream.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    const run = state.run;

    if (data.type === 'start') {
      run.total = data.total;
      run.campaign = data.campaign || '';
      addLine({ n: '—', tag: 'run', tagLabel: 'start', addr: plural(data.total, 'recipient'), note: data.campaign || 'untagged' });
      ui.runAnnounce.textContent = 'Campaign started: ' + plural(data.total, 'recipient') + '.';
    } else if (data.type === 'progress') {
      if (data.status === 'sent') run.sent++;
      if (data.status === 'failed') run.failed++;
      if (data.status === 'uncertain') run.uncertain++;
      if (data.status === 'skip') run.skipped++;
      addLine({
        n: String(data.index).padStart(2, '0'),
        tag: data.status,
        tagLabel: data.status,
        addr: data.email,
        note: data.status === 'uncertain'
          ? 'no reply after the message was sent, so it may have been delivered; not retried (' + data.error + ')'
          : data.error || UNSENT_REASON[data.reason] || '',
        bad: data.status === 'failed' || data.status === 'uncertain',
      });
    } else if (data.type === 'throttle') {
      addLine({
        n: '—',
        tag: 'run',
        tagLabel: 'wait',
        addr: data.email,
        note: (THROTTLE_SCOPE[data.scope] || (data.scope + ' ceiling')) + ' reached, resuming in about ' + Math.ceil(data.waitMs / 60000) + ' min',
      });
    } else if (data.type === 'fatal') {
      addLine({ n: '!!', tag: 'failed', tagLabel: 'halt', addr: data.email, note: data.error, bad: true });
    } else if (data.type === 'error') {
      addLine({ n: '!!', tag: 'failed', tagLabel: 'error', addr: data.error, bad: true });
    } else if (data.type === 'done') {
      finished = true;
      const s = data.summary || {};
      const text = s.error
        ? 'Stopped — ' + s.error
        : (s.stopped ? 'Stopped' : 'Done') + ' — sent ' + (s.sent || 0) + ', failed ' + (s.failed || 0) + ', skipped ' + (s.skipped || 0)
          + (s.uncertain?.length ? ', unconfirmed ' + s.uncertain.length : '') + '.'
          + (s.failed ? ' Failures are in the log.' : '')
          + (s.uncertain?.length ? ' Unconfirmed messages may have been delivered; check your Sent folder before mailing them again.' : '');
      addSummary(text);
      run.label = text;
      setRunState(s.error ? 'bad' : s.stopped ? 'warn' : 'ok', s.error ? 'Failed' : s.stopped ? 'Stopped' : 'Finished');
      ui.runAnnounce.textContent = text;
      stream.close();
      finishSend(s);
    }
    renderRun();
  };

  stream.onerror = async () => {
    if (finished) return;
    // The server closes the stream after "done"; anything else is a real drop.
    stream.close();
    if (!state.sending) return;

    // A reloaded server or a sleeping tab can drop the stream while the send
    // continues. Re-attach to whatever is still running before giving up.
    if (attempt < 3) {
      try {
        const active = await api('/api/jobs/active');
        if (active?.jobId) {
          setTimeout(() => listen(active.jobId, attempt + 1), 800);
          return;
        }
      } catch { /* server unreachable */ }
    }

    unlockControls();
    setRunState('bad', 'Disconnected');
    toast('Lost the progress stream — check the send log before re-running.', 'bad');
  };
}

async function finishSend(summary) {
  unlockControls();
  if (summary.error) toast(summary.error, 'bad');
  else if (summary.failed) toast(plural(summary.failed, 'message') + ' failed — see the log on the Send page.', 'bad');
  else if (summary.uncertain?.length) toast(plural(summary.uncertain.length, 'message') + ' may or may not have been delivered — check your Sent folder before re-sending.', 'bad');
  else if (summary.stopped) toast('Stopped after ' + plural(summary.sent || 0, 'message') + ' sent.', 'ok');
  else toast('Campaign finished: ' + plural(summary.sent || 0, 'message') + ' sent.', 'ok');

  try {
    await hooks.loadState();
    await refreshPreview({ resetIndex: true });
    await loadRoster();
    await loadQueue();
  } catch { /* the summary above is enough */ }
}

async function cancelSend() {
  if (!state.jobId) return;
  ui.cancelBtn.disabled = true;
  ui.cancelBtn.textContent = 'Stopping…';
  try {
    await api('/api/jobs/' + state.jobId + '/cancel', {});
  } catch (err) {
    toast(err.message, 'bad');
    ui.cancelBtn.disabled = false;
    ui.cancelBtn.textContent = 'Stop after this one';
  }
}

export function initSend() {
  ui.verifyBtn.addEventListener('click', verify);
  ui.verifyBtn2.addEventListener('click', verify);
  ui.sendBtn.addEventListener('click', startSend);
  ui.testBtn.addEventListener('click', sendTest);
  ui.testTo.addEventListener('input', () => store.set('test', ui.testTo.value));
  ui.testTo.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); sendTest(); }
  });
  ui.delay.addEventListener('input', () => { ui.delay.dataset.touched = '1'; renderDraft(); });
  ui.delay.addEventListener('change', () => store.set('delay', ui.delay.value));
  ui.cancelBtn.addEventListener('click', cancelSend);
}
