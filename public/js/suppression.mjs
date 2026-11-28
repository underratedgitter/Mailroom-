import {
  api,
  confirmDialog,
  debounce,
  formatWhen,
  h,
  hooks,
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
import { refreshPreview } from './compose.mjs';

const SUPPRESS_TAG = { 'hard-bounce': 'failed', bounce: 'failed', complaint: 'failed', unsubscribe: 'skip' };

function formatAdded(value) {
  if (!value) return '';
  return Number.isFinite(Date.parse(value)) ? formatWhen(value) : value;
}

export async function loadSuppression() {
  try {
    const { q, reason, limit, offset } = state.suppressionPage;
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (q) params.set('q', q);
    if (reason) params.set('reason', reason);
    const data = await api('/api/suppression?' + params.toString());
    state.suppressed = data;
    state.suppressionPage.filtered = data.filtered ?? (data.entries || []).length;
    state.suppressionPage.offset = data.offset ?? offset;
    renderSuppression();
  } catch (err) {
    setText(ui.suppressNote, 'Could not load the list: ' + err.message);
  }
}

export function renderSuppression() {
  const data = state.suppressed;
  if (!data) return;
  const shown = data.entries || (data.emails || []).map((email) => ({ email, reason: '', added: '' }));
  const { q, reason, limit, offset, filtered } = state.suppressionPage;
  const matched = data.filtered ?? filtered ?? shown.length;

  setText(ui.suppressCount, plural(data.count, 'address', 'addresses'));
  reconcile(ui.suppressList, shown, (item) => item.email,
    () => h('li', {},
      h('div', { class: 'suppress__row' },
        h('div', { class: 'suppress__info' },
          h('span', { class: 'suppress__email' }),
          h('span', { class: 'tag' }),
          h('span', { class: 'queue__meta' })),
        h('button', { type: 'button', class: 'btn btn--sm btn--danger-quiet', dataset: { action: 'remove' } }, 'Remove'))),
    (li, item) => {
      const [row] = li.children;
      const [info, btn] = row.children;
      const [emailEl, reasonEl, addedEl] = info.children;
      setText(emailEl, item.email);
      setText(reasonEl, item.reason || '');
      setHidden(reasonEl, !item.reason);
      setAttr(reasonEl, 'class', 'tag' + (SUPPRESS_TAG[item.reason] ? ' tag--' + SUPPRESS_TAG[item.reason] : ''));
      const when = formatAdded(item.added);
      setText(addedEl, when);
      setHidden(addedEl, !when);
      setAttr(addedEl, 'title', item.added || '');
      setAttr(btn, 'aria-label', 'Remove ' + item.email);
    });

  setHidden(ui.suppressPager, matched <= limit || shown.length === 0);
  if (shown.length && matched > limit) {
    ui.suppressPrevBtn.disabled = offset <= 0;
    ui.suppressNextBtn.disabled = offset + shown.length >= matched;
    setText(ui.suppressPageInfo, (offset + 1) + '–' + (offset + shown.length) + ' of ' + matched);
  }

  setHidden(ui.suppressEmpty, shown.length > 0);
  setText(ui.suppressEmptyTitle, data.count ? 'No matches' : 'No suppressed addresses');
  setText(ui.suppressEmptyText, data.count
    ? 'Nothing on the list matches ' + ([q ? '“' + q + '”' : '', reason || ''].filter(Boolean).join(' · ') || 'that filter') + '.'
    : 'Addresses you add, and hard bounces found while sending, appear here. Unsubscribe requests are not added automatically: add them here when they arrive.');
  setText(ui.suppressNote, (matched < data.count ? plural(matched, 'match') + ' of ' + data.count + '. ' : '')
    + 'Stored in ' + data.path + '.');
}

async function removeSuppression(email) {
  const ok = await confirmDialog({
    title: 'Remove from suppression list?',
    body: h('p', {}, email + ' will be removed from the suppression list and can receive campaigns again.'),
    confirmLabel: 'Remove',
    cancelLabel: 'Keep suppressed',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/unsuppress', { email });
    toast(email + ' removed from the suppression list.');
    await Promise.all([loadSuppression(), hooks.loadState()]);
    refreshPreview();
  } catch (err) {
    toast(err.message, 'bad');
  }
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
  ui.suppressSearch.addEventListener('input', debounce(() => {
    state.suppressionPage.q = ui.suppressSearch.value.trim();
    state.suppressionPage.offset = 0;
    loadSuppression();
  }, 200));
  ui.suppressReasonFilter.addEventListener('change', () => {
    state.suppressionPage.reason = ui.suppressReasonFilter.value;
    state.suppressionPage.offset = 0;
    loadSuppression();
  });
  ui.suppressPrevBtn.addEventListener('click', () => {
    state.suppressionPage.offset = Math.max(0, state.suppressionPage.offset - state.suppressionPage.limit);
    loadSuppression();
  });
  ui.suppressNextBtn.addEventListener('click', () => {
    state.suppressionPage.offset += state.suppressionPage.limit;
    loadSuppression();
  });
  ui.suppressList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="remove"]');
    if (!button) return;
    const email = button.closest('li')?.dataset.key;
    if (email) removeSuppression(email);
  });
}
