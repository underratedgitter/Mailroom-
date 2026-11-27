import {
  api,
  body,
  debounce,
  h,
  hooks,
  plural,
  reconcile,
  setAttr,
  setHidden,
  setText,
  state,
  store,
  ui,
} from './api.mjs';
import { renderDraft } from './overview.mjs';

export function describeTemplate() {
  hooks.renderTemplateControls();
  const t = state.templates.find((x) => x.path === ui.template.value);
  if (!state.templates.length) { setText(ui.templateHint, 'No templates found. Create one above or add an .html file to templates/.'); return; }
  if (!t) { setText(ui.templateHint, ''); return; }
  setText(ui.templateHint, t.assets
    ? plural(t.assets, 'file') + ' in ' + t.assetsDir + ' — attached inline via cid:'
    : 'No asset folder beside this template; images would not be embedded.');
}

// ── Merge fields ─────────────────────────────────────────────────────
const BUILTIN_FIELDS = ['name', 'company', 'email'];

function availableFields() {
  const extra = state.columns.filter((c) => c.role === 'field').map((c) => c.name);
  return [...BUILTIN_FIELDS, ...extra.filter((name) => !BUILTIN_FIELDS.includes(name))];
}

export function renderTokens() {
  reconcile(ui.tokens, availableFields(), (name) => name,
    (name) => h('button', { type: 'button', class: 'chip', dataset: { field: name }, 'aria-label': 'Insert ' + name }, '{{' + name + '}}'),
    () => {});
}

export function renderPlaceholders(placeholders) {
  const labels = { builtin: 'built in', column: 'from your list', missing: 'not in your list' };
  setHidden(ui.placeholdersHint, false);
  reconcile(ui.placeholders, placeholders, (p) => p.name,
    () => h('span', { class: 'chip', role: 'listitem' }, h('code'), h('span', { class: 'chip__note' })),
    (node, p) => {
      setAttr(node, 'data-status', p.status);
      setText(node.firstElementChild, '{{' + p.name + '}}');
      setText(node.lastElementChild, labels[p.status]);
    });
  const missing = placeholders.filter((p) => p.status === 'missing').map((p) => '{{' + p.name + '}}');
  setText(ui.placeholdersHint, missing.length
    ? missing.join(', ') + ' will be left blank: no column of that name in the recipient list.'
    : placeholders.length
      ? 'Every merge field in this message can be filled from your list.'
      : 'Use {{name}}, {{company}}, {{email}} or any column of your list.');
}

export function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.focus();
  input.setSelectionRange(start + text.length, start + text.length);
}

export function insertToken(token) {
  insertAtCursor(ui.subject, token);
  store.set('subject', ui.subject.value);
  refreshPreview();
}

// ── Preview ──────────────────────────────────────────────────────────
export function clearProof(title, text = '', kind = 'error') {
  state.previewSeq++;
  setHidden(ui.proofEmpty, false);
  setText(ui.proofEmptyTitle, title);
  setText(ui.proofEmptyText, text);
  if (ui.preview.srcdoc !== '') ui.preview.srcdoc = '';
  setText(ui.proofTo, 'No recipient');
  setText(ui.proofSubject, '');
  setText(ui.proofIndex, '0 / 0');
  setText(ui.proofImages, '0 inline images');
  setText(ui.proofTotal, '');
  ui.prevBtn.disabled = true;
  ui.nextBtn.disabled = true;
  state.lastPreview = null;
  state.previewError = kind === 'subject' ? '' : text || title;
  renderPlaceholders([]);
  renderDraft();
}

export async function refreshPreview({ resetIndex = false } = {}) {
  if (!ui.template.value) { clearProof('No template selected', 'Add an .html file to the templates folder.'); return; }
  if (state.mode === 'paste' && !ui.pasteBox.value.trim()) {
    clearProof('No recipients yet', 'Paste one address per line on the Recipients page.');
    return;
  }
  if (state.mode === 'saved' && !ui.csv.value) {
    clearProof('No recipient list', 'Choose, paste or upload a list on the Recipients page.');
    return;
  }
  if (!ui.subject.value.trim()) {
    clearProof('Add a subject line', 'The preview appears here once the message has a subject.', 'subject');
    return;
  }
  if (resetIndex) state.index = 0;

  const seq = ++state.previewSeq;
  try {
    const data = await api('/api/preview', body({ index: state.index }));
    if (seq === state.previewSeq) applyPreview(data);
  } catch (err) {
    if (seq === state.previewSeq) clearProof('Preview unavailable', err.message);
  }
}

export function applyPreview(data) {
  state.index = data.index;
  state.total = data.total;
  state.lastPreview = data;
  state.previewError = '';
  state.columns = data.columns || state.columns;

  // Assigning srcdoc reloads the frame even when the markup is identical,
  // which flashes white and resets its scroll position.
  if (ui.preview.srcdoc !== data.html) ui.preview.srcdoc = data.html;
  setHidden(ui.proofEmpty, true);
  setText(ui.proofTo, data.to);
  setText(ui.proofSubject, data.subject);
  setText(ui.proofIndex, (data.index + 1) + ' / ' + data.total);
  setText(ui.proofImages, plural(data.inline, 'inline image'));
  setText(ui.proofTotal, [
    data.willSend + ' to send',
    data.skipped + ' already sent',
    data.suppressed ? data.suppressed + ' suppressed' : null,
    data.truncated ? data.truncated + ' held back by limit' : null,
  ].filter(Boolean).join(' · '));

  ui.prevBtn.disabled = data.index <= 0;
  ui.nextBtn.disabled = data.index >= data.total - 1;

  renderPlaceholders(data.placeholders || []);
  renderTokens();
  hooks.markRosterCurrent();
  renderDraft();
}

export function initCompose() {
  ui.template.addEventListener('change', () => {
    store.set('template', ui.template.value);
    state.studioDirty = false;
    describeTemplate();
    refreshPreview({ resetIndex: true });
    if (state.composeTab === 'studio') hooks.loadStudioTemplate({ force: true });
  });
  ui.subject.addEventListener('input', debounce(() => {
    store.set('subject', ui.subject.value);
    refreshPreview();
  }, 420));
  const refreshForCampaign = debounce(() => { refreshPreview(); hooks.loadRoster(); }, 450);
  ui.campaign.addEventListener('input', () => {
    store.set('campaign', ui.campaign.value);
    renderDraft();
    refreshForCampaign();
  });
  ui.tokens.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-field]');
    if (chip) insertToken('{{' + chip.dataset.field + '}}');
  });
  ui.previewBtn.addEventListener('click', () => refreshPreview({ resetIndex: true }));
  ui.prevBtn.addEventListener('click', () => { state.index--; refreshPreview(); });
  ui.nextBtn.addEventListener('click', () => { state.index++; refreshPreview(); });
  ui.composeForm.addEventListener('submit', (event) => event.preventDefault());
}
