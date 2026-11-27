import {
  api,
  body,
  confirmDialog,
  currentDelay,
  formatDuration,
  formatWhen,
  h,
  hooks,
  pad2,
  plural,
  reconcile,
  setAttr,
  setClass,
  setHidden,
  setText,
  state,
  toast,
  ui,
} from './api.mjs';
import { renderDraft } from './overview.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function relative(iso) {
  const diff = Date.parse(iso) - Date.now();
  if (diff <= 0) return 'due now';
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return 'in ' + Math.max(1, minutes) + ' min';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return 'in ' + hours + ' h';
  return 'in ' + Math.round(hours / 24) + ' d';
}

function toLocalInput(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    + 'T' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

export function renderScheduleSummary() {
  const p = state.lastPreview;
  const others = p ? p.willSend - 1 : 0;
  setText(ui.scheduleSummary, p
    ? plural(p.willSend, 'message') + ' to ' + p.to + (others > 0 ? ' and ' + others + ' more' : '') + ' — “' + p.subject + '”.'
    : 'Choose a template, subject and recipients first. The campaign you are drafting is what gets scheduled.');
}

export function prepareScheduleForm() {
  setText(ui.scheduleZone, 'Times are ' + Intl.DateTimeFormat().resolvedOptions().timeZone + '.');
  const current = ui.scheduleAt.value ? Date.parse(ui.scheduleAt.value) : NaN;
  if (!Number.isFinite(current) || current < Date.now()) {
    ui.scheduleAt.value = toLocalInput(new Date(Date.now() + 60 * 60 * 1000));
  }
  renderScheduleSummary();
}

function setScheduleStatus(text, kind = '') {
  setText(ui.scheduleStatus, text);
  setClass(ui.scheduleStatus, 'is-bad', kind === 'bad');
  setClass(ui.scheduleStatus, 'is-ok', kind === 'ok');
}

async function submitSchedule(event) {
  event.preventDefault();
  const when = ui.scheduleAt.value ? new Date(ui.scheduleAt.value) : null;
  if (!when || Number.isNaN(when.getTime())) { setScheduleStatus('Pick a date and time.', 'bad'); return; }

  ui.scheduleBtn.disabled = true;
  setScheduleStatus('Scheduling…');
  try {
    const data = await api('/api/schedule', body({ at: when.toISOString(), delay: currentDelay() }));
    setScheduleStatus('Scheduled for ' + formatWhen(when.toISOString()) + ' (' + plural(data.total, 'recipient') + ').', 'ok');
    toast('Scheduled for ' + formatWhen(when.toISOString()) + '.', 'ok');
    await loadQueue();
  } catch (err) {
    setScheduleStatus(err.message, 'bad');
  } finally {
    renderDraft();
  }
}

const QUEUE_LABEL = { pending: 'scheduled' };

export async function loadQueue() {
  try {
    const data = await api('/api/schedule');
    state.queue = data.entries || [];
    setText(ui.queueError, '');
    renderQueue();
    setText(ui.scheduleGrace, data.graceMs
      ? 'If Mailroom is not running at the scheduled time, a campaign up to ' + formatDuration(data.graceMs) + ' late still goes out. Later than that it is held here for you to decide.'
      : '');
    return data;
  } catch (err) {
    setText(ui.queueError, 'Could not load the schedule: ' + err.message);
    return null;
  }
}

export function queueActive() {
  return (state.queue || []).filter((e) => e.status === 'pending' || e.status === 'sending');
}

export function renderQueue() {
  const entries = state.queue || [];
  const active = queueActive();
  setText(ui.navScheduleBadge, String(active.length));
  setHidden(ui.navScheduleBadge, active.length === 0);
  setText(ui.statScheduled, active.length);
  const next = active.find((e) => e.status === 'pending');
  setText(ui.statScheduledSub, next ? 'Next ' + formatWhen(next.at) : 'Nothing queued');
  setText(ui.queueTotal, entries.length ? active.length + ' active · ' + entries.length + ' total' : '');
  setHidden(ui.queueEmpty, entries.length > 0);

  reconcile(ui.queueList, entries, (e) => e.id,
    () => h('li', {},
      h('div', {},
        h('div', { class: 'queue__line' }, h('span', { class: 'queue__when' }), h('span', { class: 'tag' }), h('span', { class: 'queue__meta' })),
        h('div', { class: 'queue__meta' }),
        h('div', { class: 'queue__note' })),
      h('div', { class: 'queue__actions' })),
    (li, e) => {
      const [main, actions] = li.children;
      const [line, meta, note] = main.children;
      setText(line.children[0], formatWhen(e.at));
      setText(line.children[1], QUEUE_LABEL[e.status] || e.status);
      setAttr(line.children[1], 'class', 'tag tag--' + e.status);
      setText(line.children[2], e.status === 'pending' ? relative(e.at) : '');
      setText(meta, [e.campaign || 'No campaign name', plural(e.recipients, 'recipient'), e.subject].filter(Boolean).join(' · '));
      const text = e.error || (e.status === 'pending' && e.interrupted ? 'Cut short; carries on automatically and skips anyone already mailed.' : e.result ? 'Sent ' + e.result.sent + ', failed ' + e.result.failed + ', skipped ' + e.result.skipped + (e.result.uncertain ? ', unconfirmed ' + e.result.uncertain : '') : '');
      setText(note, text);
      setHidden(note, !text);
      setClass(note, 'is-bad', Boolean(e.error));

      // Buttons depend only on status; rebuild them when it changes.
      if (li.dataset.status === e.status) return;
      li.dataset.status = e.status;
      actions.replaceChildren();
      if (e.status === 'pending' || e.status === 'missed') {
        actions.append(
          h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'run' } }, 'Send now'),
          h('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'reschedule' } }, 'Reschedule'),
          h('button', { type: 'button', class: 'btn btn--sm btn--danger-quiet', dataset: { action: 'cancel' } }, e.status === 'missed' ? 'Discard' : 'Cancel'));
      }
    });
}

async function runScheduled(id) {
  const entry = state.queue.find((e) => e.id === id);
  if (!entry) return;
  const ok = await confirmDialog({
    title: 'Send this campaign now?',
    body: [
      h('p', { class: 'dialog__count' }, h('strong', {}, String(entry.recipients)), entry.recipients === 1 ? 'recipient will get this message' : 'recipients will get this message'),
      h('p', {}, '“' + entry.subject + '” was scheduled for ' + formatWhen(entry.at) + '. Sending now skips the wait and mails real inboxes immediately.'),
    ],
    confirmLabel: 'Send ' + plural(entry.recipients, 'message') + ' now',
    danger: true,
    check: 'I understand these messages go out immediately to real inboxes.',
  });
  if (!ok) return;
  try {
    await api('/api/schedule/' + id + '/run', {});
    toast('Sending now.', 'ok');
    await loadQueue();
    await attachWhenStarted();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

/** The scheduler picks the entry up a beat after the request lands. */
async function attachWhenStarted(attempts = 16) {
  for (let i = 0; i < attempts; i++) {
    const active = await api('/api/jobs/active').catch(() => null);
    if (active?.jobId) {
      hooks.attachJob(active.jobId);
      return;
    }
    await sleep(250);
  }
}

async function cancelScheduled(id) {
  const entry = state.queue.find((e) => e.id === id);
  if (!entry) return;
  const ok = await confirmDialog({
    title: entry.status === 'missed' ? 'Discard this campaign?' : 'Cancel this scheduled campaign?',
    body: h('p', {}, '“' + entry.subject + '” to ' + plural(entry.recipients, 'recipient') + ' will not be sent.'),
    confirmLabel: entry.status === 'missed' ? 'Discard it' : 'Cancel campaign',
    cancelLabel: 'Keep it',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/schedule/' + id + '/cancel', {});
    toast('Scheduled campaign removed.');
    await loadQueue();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

let rescheduleId = null;

function openReschedule(id) {
  const entry = state.queue.find((e) => e.id === id);
  if (!entry) return;
  rescheduleId = id;
  setText(ui.rescheduleMeta, (entry.campaign || entry.subject) + ' · ' + plural(entry.recipients, 'recipient'));
  setText(ui.rescheduleStatus, '');
  const current = Date.parse(entry.at);
  ui.rescheduleAt.value = toLocalInput(new Date(Number.isFinite(current) && current > Date.now() ? current : Date.now() + 60 * 60 * 1000));
  ui.rescheduleSave.disabled = false;
  ui.rescheduleDialog.showModal();
  ui.rescheduleAt.focus();
}

async function submitReschedule(event) {
  event.preventDefault();
  if (!rescheduleId) return;
  const when = ui.rescheduleAt.value ? new Date(ui.rescheduleAt.value) : null;
  if (!when || Number.isNaN(when.getTime())) { setText(ui.rescheduleStatus, 'Pick a date and time.'); return; }
  ui.rescheduleSave.disabled = true;
  setText(ui.rescheduleStatus, '');
  try {
    await api('/api/schedule/' + rescheduleId + '/reschedule', { at: when.toISOString() });
    rescheduleId = null;
    ui.rescheduleDialog.close();
    toast('Rescheduled for ' + formatWhen(when.toISOString()) + '.', 'ok');
    await loadQueue();
  } catch (err) {
    setText(ui.rescheduleStatus, err.message);
  } finally {
    ui.rescheduleSave.disabled = false;
  }
}

export function initSchedule() {
  ui.scheduleForm.addEventListener('submit', submitSchedule);
  ui.queueList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const id = button.closest('li').dataset.key;
    if (button.dataset.action === 'run') runScheduled(id);
    else if (button.dataset.action === 'reschedule') openReschedule(id);
    else cancelScheduled(id);
  });
  ui.rescheduleForm.addEventListener('submit', submitReschedule);
  ui.rescheduleCancel.addEventListener('click', () => ui.rescheduleDialog.close());
  ui.rescheduleDialog.addEventListener('click', (event) => {
    if (event.target === ui.rescheduleDialog) ui.rescheduleDialog.close();
  });
  ui.rescheduleDialog.addEventListener('close', () => { rescheduleId = null; });
}
