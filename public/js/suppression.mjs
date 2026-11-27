import {
  api,
  debounce,
  h,
  hooks,
  plural,
  reconcile,
  setClass,
  setHidden,
  setText,
  state,
  toast,
  ui,
} from './api.mjs';
import { refreshPreview } from './compose.mjs';

const SUPPRESS_SHOWN = 300;

export async function loadSuppression() {
  try {
    const data = await api('/api/suppression');
    state.suppressed = data;
    renderSuppression();
  } catch (err) {
    setText(ui.suppressNote, 'Could not load the list: ' + err.message);
  }
}

export function renderSuppression() {
  const data = state.suppressed;
  if (!data) return;
  const query = ui.suppressSearch.value.trim().toLowerCase();
  const matches = query ? data.emails.filter((e) => e.includes(query)) : data.emails;
  const shown = matches.slice(0, SUPPRESS_SHOWN);

  setText(ui.suppressCount, plural(data.count, 'address', 'addresses'));
  reconcile(ui.suppressList, shown, (email) => email, () => h('li'), (li, email) => setText(li, email));
  setHidden(ui.suppressEmpty, shown.length > 0);
  setText(ui.suppressEmptyTitle, data.count ? 'No matches' : 'No suppressed addresses');
  setText(ui.suppressEmptyText, data.count ? 'Nothing on the list matches “' + ui.suppressSearch.value.trim() + '”.' : 'Addresses you add, and hard bounces found while sending, appear here. Unsubscribe requests are not added automatically: add them here when they arrive.');
  setText(ui.suppressNote, (matches.length > shown.length ? 'Showing the first ' + shown.length + ' of ' + matches.length + '. Filter to narrow it down. ' : '')
    + 'To remove an address, edit ' + data.path + '.');
}

function setSuppressStatus(text, kind = '') {
  setText(ui.suppressStatus, text);
  setClass(ui.suppressStatus, 'is-ok', kind === 'ok');
  setClass(ui.suppressStatus, 'is-bad', kind === 'bad');
}

async function submitSuppress(event) {
  event.preventDefault();
  const emails = ui.suppressEmails.value.trim();
  if (!emails) { ui.suppressEmails.focus(); setSuppressStatus('Enter at least one address.', 'bad'); return; }

  ui.suppressBtn.disabled = true;
  setSuppressStatus('Adding…');
  try {
    const data = await api('/api/suppress', { emails, reason: ui.suppressReason.value });
    const parts = [];
    if (data.added.length) parts.push(plural(data.added.length, 'address', 'addresses') + ' added');
    if (data.already.length) parts.push(data.already.length + ' already on the list');
    if (data.invalid.length) parts.push('not valid: ' + data.invalid.join(', '));
    setSuppressStatus(parts.join(' · '), data.added.length ? 'ok' : data.invalid.length ? 'bad' : '');
    if (data.added.length) {
      toast(plural(data.added.length, 'address', 'addresses') + ' added to the suppression list.', 'ok');
      ui.suppressEmails.value = '';
    }
    await loadSuppression();
    await hooks.loadState();
    refreshPreview();
  } catch (err) {
    setSuppressStatus(err.message, 'bad');
  } finally {
    ui.suppressBtn.disabled = false;
  }
}

export function initSuppression() {
  ui.suppressForm.addEventListener('submit', submitSuppress);
  ui.suppressSearch.addEventListener('input', debounce(renderSuppression, 150));
}
