import {
  api,
  baseName,
  confirmDialog,
  currentLimit,
  debounce,
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
  store,
  toast,
  ui,
} from './api.mjs';
import { refreshPreview, renderTokens } from './compose.mjs';
import { renderDraft } from './overview.mjs';

export function describeCsv() {
  const c = state.csvs.find((x) => x.path === ui.csv.value);
  setText(ui.csvHint, c?.error || '');
  ui.deleteCsvBtn.disabled = !ui.csv.value;
}

async function deleteCsv() {
  const path = ui.csv.value;
  if (!path) return;
  const ok = await confirmDialog({
    title: 'Delete saved list?',
    body: h('p', {}, baseName(path) + ' will be removed from data/ and cannot be undone.'),
    confirmLabel: 'Delete list',
    cancelLabel: 'Keep list',
    danger: true,
  });
  if (!ok) return;
  ui.deleteCsvBtn.disabled = true;
  try {
    await api('/api/csv/delete', { path });
    if (store.get('csv') === path) store.set('csv', '');
    ui.csv.value = '';
    toast('Deleted ' + baseName(path) + '.');
    await hooks.loadState();
    await loadRoster();
    await refreshPreview({ resetIndex: true });
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    describeCsv();
  }
}

function activeRosterKey() {
  return state.tab === 'upload' ? 'upload' : state.mode;
}

export function setTab(tab, { focus = false, quiet = false } = {}) {
  state.tab = tab;
  for (const button of ui.sourceTabs.querySelectorAll('[role="tab"]')) {
    const on = button.dataset.tab === tab;
    setAttr(button, 'aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
    setHidden(ui['panel' + button.dataset.tab[0].toUpperCase() + button.dataset.tab.slice(1)], !on);
    if (on && focus) button.focus();
  }
  if (quiet) return;
  if (tab === 'saved' || tab === 'paste') setMode(tab);
  else renderRoster();
}

export function setMode(mode, { refresh = true } = {}) {
  const next = mode === 'paste' ? 'paste' : 'saved';
  const changed = next !== state.mode;
  state.mode = next;
  store.set('mode', next);
  if (!changed && !refresh) return;

  if (next === 'paste') validatePaste();
  else loadRoster();
  renderRoster();
  if (refresh) refreshPreview({ resetIndex: true });
}

export async function loadRoster() {
  if (state.mode !== 'saved') return;
  if (!ui.csv.value) {
    state.rosters.saved = null;
    state.rosterErrors.saved = '';
    renderRoster();
    return;
  }
  const seq = ++state.rosterSeq;
  try {
    const data = await api('/api/roster', { csv: ui.csv.value, campaign: ui.campaign.value.trim(), limit: currentLimit() });
    if (seq !== state.rosterSeq) return;
    state.rosters.saved = data;
    state.rosterErrors.saved = '';
    state.columns = data.columns || [];
    renderTokens();
    renderDraft();
  } catch (err) {
    if (seq !== state.rosterSeq) return;
    state.rosters.saved = null;
    state.rosterErrors.saved = err.message;
  }
  renderRoster();
  renderDraft();
}

const looksLikeCsv = (text) => {
  const first = text.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith('#')) || '';
  return !first.includes('@') && /(^|[,;\t])\s*"?e-?mail/i.test(first);
};

export async function validatePaste() {
  const text = ui.pasteBox.value;
  const seq = ++state.pasteSeq;
  if (!text.trim()) {
    state.rosters.paste = null;
    state.rosterErrors.paste = '';
    setText(ui.pasteCount, 'One address per line; name and company optional.');
    renderRoster();
    return;
  }
  try {
    const data = await api('/api/recipients', { text, dryRun: true });
    if (seq !== state.pasteSeq) return;
    state.rosters.paste = data;
    state.rosterErrors.paste = '';
    const parts = [plural(data.total, 'address', 'addresses')];
    if (data.duplicates) parts.push(plural(data.duplicates, 'duplicate'));
    if (data.invalid) parts.push(data.invalid + ' unusable');
    if (looksLikeCsv(text)) parts.push('this looks like a CSV with a header row: use Upload CSV to keep its columns');
    setText(ui.pasteCount, parts.join(' · '));
  } catch (err) {
    if (seq !== state.pasteSeq) return;
    state.rosters.paste = null;
    state.rosterErrors.paste = err.message;
    setText(ui.pasteCount, err.message);
  }
  renderRoster();
}

const ROLE_LABEL = { email: 'Email address', name: 'Name', company: 'Company', field: 'Merge field' };

function mergeFieldsFor(column) {
  const alias = column.role === 'field' ? null : column.role;
  return [alias, column.name === alias ? null : column.name].filter(Boolean).map((field) => '{{' + field + '}}').join('  ');
}

function renderColumns(columns) {
  setHidden(ui.columnsWrap, columns.length === 0);
  setHidden(ui.columnsEmpty, columns.length > 0);
  reconcile(ui.columnsBody, columns, (c) => c.name,
    () => h('tr', {}, h('th', { scope: 'row', class: 'mono' }), h('td'), h('td', { class: 'mono' })),
    (tr, c) => {
      setText(tr.children[0], c.name);
      setText(tr.children[1], ROLE_LABEL[c.role]);
      setText(tr.children[2], mergeFieldsFor(c));
    });
  setText(ui.columnsNote, columns.length && !columns.some((c) => c.role === 'email')
    ? 'No email column found. Name the column email (or e-mail, email address) so Mailroom can find the addresses.'
    : '');
}

export function renderRoster() {
  const key = activeRosterKey();
  const data = state.rosters[key];
  const error = state.rosterErrors[key];
  const selectable = key !== 'upload';

  const sources = {
    saved: baseName(data?.path || ui.csv.value || 'No list selected'),
    paste: 'Pasted list, not saved',
    upload: state.upload ? state.upload.name + ' (not saved yet)' : 'No file chosen',
  };
  setText(ui.rosterSource, sources[key]);
  setHidden(ui.rosterPreviewLink, !selectable || !data);

  const stats = [];
  if (data) {
    stats.push({ kind: 'total', text: plural(data.total, 'address', 'addresses'), state: data.total ? 'ok' : 'warn' });
    if (data.sentCount) stats.push({ kind: 'sent', text: data.sentCount + ' already sent', state: 'warn' });
    if (data.truncated) stats.push({ kind: 'limit', text: data.truncated + ' held by limit', state: 'warn' });
    if (data.duplicates) stats.push({ kind: 'dupes', text: plural(data.duplicates, 'duplicate'), state: 'warn' });
    if (data.invalid) stats.push({ kind: 'invalid', text: data.invalid + ' unusable', state: 'bad' });
  }
  reconcile(ui.rosterStats, stats, (s) => s.kind,
    () => h('span', { class: 'pill' }),
    (node, s) => { setText(node, s.text); setAttr(node, 'data-state', s.state); });

  const rows = data ? data.recipients : [];
  const position = new Map(rows.map((rec, i) => [rec.email.toLowerCase(), i]));
  reconcile(ui.rosterList, rows, (rec) => rec.email.toLowerCase(),
    () => h('li', {}, h('button', { type: 'button', class: 'rrow' },
      h('span', { class: 'rrow__no' }),
      h('span', { class: 'rrow__main' }, h('span', { class: 'rrow__mail' }), h('span', { class: 'rrow__meta' })),
      h('span', { class: 'tag' }, 'sent'))),
    (li, rec) => {
      const row = li.firstElementChild;
      const i = position.get(rec.email.toLowerCase());
      row.dataset.index = String(i);
      row.disabled = !selectable;
      setAttr(row, 'title', rec.email);
      setText(row.children[0], pad2(i + 1));
      setText(row.children[1].children[0], rec.email);
      setText(row.children[1].children[1], [rec.name, rec.company].filter(Boolean).join(' · '));
      setClass(row, 'is-sent', Boolean(rec.sent));
    });

  const empty = !rows.length;
  setHidden(ui.rosterEmpty, !empty);
  if (empty) {
    const titles = {
      saved: ui.csv.value ? 'No recipients found' : 'No list selected',
      paste: 'Nothing pasted yet',
      upload: 'No file chosen',
    };
    const texts = {
      saved: ui.csv.value ? 'This list has no valid email addresses.' : 'Choose a saved list, paste addresses or upload a CSV.',
      paste: 'Paste one address per line and they appear here as you type.',
      upload: 'Choose a CSV file to check it before saving.',
    };
    setText(ui.rosterEmptyTitle, error ? 'Could not read this list' : titles[key]);
    setText(ui.rosterEmptyText, error || texts[key]);
  }

  renderColumns(data ? data.columns || [] : []);
  markRosterCurrent();
}

export function markRosterCurrent() {
  const selectable = activeRosterKey() !== 'upload';
  let active = null;
  for (const li of ui.rosterList.children) {
    const row = li.firstElementChild;
    const current = selectable && Number(row.dataset.index) === state.index;
    setClass(row, 'is-current', current);
    if (current) {
      setAttr(row, 'aria-current', 'true');
      active = row;
    } else if (row.hasAttribute('aria-current')) {
      row.removeAttribute('aria-current');
    }
  }
  // One tab stop for the whole list; arrow keys move within it.
  const stop = active || ui.rosterList.querySelector('.rrow');
  for (const li of ui.rosterList.children) {
    const row = li.firstElementChild;
    const want = row === stop ? 0 : -1;
    if (row.tabIndex !== want) row.tabIndex = want;
  }
  // Only follow the preview when it moved; otherwise every refresh would
  // yank a list the reader has scrolled elsewhere back to the current row.
  if (active && state.rosterMarked !== state.index) active.scrollIntoView({ block: 'nearest' });
  state.rosterMarked = state.index;
}

// Saving a pasted or uploaded list makes it a saved list and selects it.
async function saveList({ text, name, format, button, label }) {
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const data = await api('/api/recipients', { text, name, format });
    await hooks.loadState();
    if (state.csvs.some((c) => c.path === data.path)) {
      ui.csv.value = data.path;
      store.set('csv', data.path);
    }
    describeCsv();
    toast('Saved ' + plural(data.recipients, 'address', 'addresses') + ' to ' + data.path, 'ok');
    return true;
  } catch (err) {
    toast(err.message, 'bad');
    return false;
  } finally {
    button.textContent = label;
    button.disabled = false;
  }
}

async function savePastedList() {
  const text = ui.pasteBox.value.trim();
  if (!text) { ui.pasteBox.focus(); toast('Paste some addresses first.', 'bad'); return; }
  const saved = await saveList({
    text,
    name: ui.pasteName.value.trim() || ui.campaign.value.trim(),
    format: looksLikeCsv(text) ? 'csv' : 'lines',
    button: ui.saveCsvBtn,
    label: 'Save as list',
  });
  if (!saved) return;
  ui.pasteBox.value = '';
  ui.pasteName.value = '';
  state.rosters.paste = null;
  setText(ui.pasteCount, 'One address per line; name and company optional.');
  setTab('saved');
  await loadRoster();
}

const MAX_UPLOAD = 1.5 * 1024 * 1024;

async function handleFile(file) {
  if (!file) return;
  state.upload = null;
  state.rosters.upload = null;
  ui.uploadSaveBtn.disabled = true;
  setText(ui.dropTitle, file.name);

  const fail = (message) => {
    setText(ui.uploadStatus, message);
    setClass(ui.uploadStatus, 'is-bad', true);
    setClass(ui.uploadStatus, 'is-ok', false);
    renderRoster();
  };

  if (file.size > MAX_UPLOAD) { fail('That file is larger than 1.5 MB. Split it into smaller lists.'); return; }
  let text;
  try { text = await file.text(); } catch { fail('Could not read that file.'); return; }

  state.upload = { name: file.name, text };
  setClass(ui.uploadStatus, 'is-bad', false);
  setClass(ui.uploadStatus, 'is-ok', false);
  setText(ui.uploadStatus, 'Checking ' + file.name + '…');
  renderRoster();
  try {
    const data = await api('/api/recipients', { text, format: 'csv', dryRun: true });
    state.rosters.upload = data;
    const parts = [plural(data.total, 'valid address', 'valid addresses')];
    if (data.duplicates) parts.push(plural(data.duplicates, 'duplicate'));
    if (data.invalid) parts.push(data.invalid + ' unusable');
    setText(ui.uploadStatus, parts.join(' · '));
    setClass(ui.uploadStatus, 'is-ok', data.total > 0);
    setClass(ui.uploadStatus, 'is-bad', data.total === 0);
    ui.uploadSaveBtn.disabled = data.total === 0;
    renderRoster();
  } catch (err) {
    fail(err.message);
  }
}

async function saveUpload() {
  if (!state.upload) return;
  const base = state.upload.name.replace(/\.[^.]+$/, '');
  const saved = await saveList({
    text: state.upload.text,
    name: ui.uploadName.value.trim() || base,
    format: 'csv',
    button: ui.uploadSaveBtn,
    label: 'Save and use',
  });
  if (!saved) return;

  state.upload = null;
  state.rosters.upload = null;
  ui.fileInput.value = '';
  ui.uploadName.value = '';
  setText(ui.dropTitle, 'Choose a CSV file or drop it here');
  setText(ui.uploadStatus, '');
  ui.uploadSaveBtn.disabled = true;
  setTab('saved');
  await loadRoster();
  await refreshPreview({ resetIndex: true });
}

export function initRecipients() {
  ui.sourceTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) setTab(tab.dataset.tab);
  });
  ui.sourceTabs.addEventListener('keydown', (event) => {
    const tabs = [...ui.sourceTabs.querySelectorAll('[role="tab"]')];
    const at = tabs.indexOf(document.activeElement);
    if (at === -1) return;
    const next = { ArrowRight: (at + 1) % tabs.length, ArrowLeft: (at + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setTab(tabs[next].dataset.tab, { focus: true });
  });
  ui.csv.addEventListener('change', () => {
    store.set('csv', ui.csv.value);
    describeCsv();
    state.index = 0;
    refreshPreview({ resetIndex: true });
    loadRoster();
  });
  ui.pasteBox.addEventListener('input', debounce(() => {
    validatePaste();
    refreshPreview({ resetIndex: true });
  }, 500));
  ui.saveCsvBtn.addEventListener('click', savePastedList);
  ui.deleteCsvBtn.addEventListener('click', deleteCsv);
  ui.limit.addEventListener('input', debounce(() => {
    refreshPreview({ resetIndex: true });
    loadRoster();
  }, 420));
  ui.rosterList.addEventListener('click', (event) => {
    const row = event.target.closest('.rrow');
    if (!row || row.disabled) return;
    state.index = Number(row.dataset.index);
    markRosterCurrent();
    refreshPreview();
  });
  ui.rosterList.addEventListener('keydown', (event) => {
    const row = event.target.closest('.rrow');
    if (!row) return;
    const rows = [...ui.rosterList.querySelectorAll('.rrow')];
    const at = rows.indexOf(row);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[event.key];
    if (next === undefined || !rows[next]) return;
    event.preventDefault();
    for (const other of rows) other.tabIndex = other === rows[next] ? 0 : -1;
    rows[next].focus();
  });
  ui.fileInput.addEventListener('change', () => handleFile(ui.fileInput.files[0]));
  ui.uploadSaveBtn.addEventListener('click', saveUpload);
  for (const name of ['dragenter', 'dragover']) {
    ui.dropzone.addEventListener(name, (event) => { event.preventDefault(); ui.dropzone.classList.add('is-over'); });
  }
  for (const name of ['dragleave', 'drop']) {
    ui.dropzone.addEventListener(name, (event) => { event.preventDefault(); ui.dropzone.classList.remove('is-over'); });
  }
  ui.dropzone.addEventListener('drop', (event) => handleFile(event.dataTransfer?.files?.[0]));
}
