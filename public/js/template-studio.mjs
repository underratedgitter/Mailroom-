import {
  api,
  confirmDialog,
  h,
  hooks,
  nameDialog,
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
import { describeTemplate, insertAtCursor, refreshPreview } from './compose.mjs';

const DEFAULT_TEMPLATE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>{{subject}}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #1f2430;">
  <p>Hi {{name}},</p>
  <p>Write your message here.</p>
  <p style="font-size: 12px; color: #667085;">
    <a href="{{unsubscribe_url}}">Unsubscribe</a>
  </p>
</body>
</html>
`;

export function setComposeTab(tab, { focus = false } = {}) {
  const next = tab === 'studio' ? 'studio' : 'message';
  state.composeTab = next;
  for (const button of ui.composeTabs.querySelectorAll('[role="tab"]')) {
    const on = button.dataset.tab === next;
    setAttr(button, 'aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
    setHidden(button.dataset.tab === 'studio' ? ui.panelComposeStudio : ui.panelComposeMessage, !on);
    if (on && focus) button.focus();
  }
  if (next === 'studio') loadStudioTemplate();
}

export function selectedTemplate() {
  return state.templates.find((x) => x.path === ui.template.value);
}

export function renderTemplateControls() {
  const t = selectedTemplate();
  const hasSelection = Boolean(t);
  const editable = Boolean(t && !t.bundled);
  ui.duplicateTemplateBtn.disabled = !hasSelection;
  ui.deleteTemplateBtn.disabled = !editable;
  ui.studioHtml.disabled = !hasSelection;
  ui.studioHtml.readOnly = Boolean(t?.bundled);
  ui.studioSaveBtn.disabled = !editable;
  ui.assetBtn.disabled = !editable;
}

export function setStudioStatus(text, kind = '') {
  setText(ui.studioStatus, text);
  setClass(ui.studioStatus, 'is-ok', kind === 'ok');
  setClass(ui.studioStatus, 'is-bad', kind === 'bad');
}

function renderAssets() {
  const readOnly = Boolean(selectedTemplate()?.bundled);
  setHidden(ui.assetEmpty, state.studioAssets.length > 0);
  reconcile(ui.assetList, state.studioAssets, (a) => a.filename,
    () => h('li', { class: 'asset-item' },
      h('div', { class: 'asset-item__meta' },
        h('span', { class: 'asset-item__name' }),
        h('span', { class: 'asset-item__cid mono' })),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', dataset: { action: 'insert' } }, 'Insert'),
        h('button', { class: 'btn btn--ghost btn--danger-quiet btn--sm', type: 'button', dataset: { action: 'delete' } }, 'Delete'))),
    (li, asset) => {
      const kb = asset.size < 1024 ? asset.size + ' B' : Math.max(1, Math.round(asset.size / 1024)) + ' KB';
      setText(li.firstElementChild.firstElementChild, asset.filename);
      setText(li.firstElementChild.lastElementChild, 'cid:' + asset.cid + ' · ' + kb);
      for (const btn of li.lastElementChild.children) btn.disabled = readOnly;
    });
}

export async function loadStudioTemplate({ force = false } = {}) {
  const path = ui.template.value;
  if (!path) {
    state.studioPath = '';
    state.studioDirty = false;
    state.studioAssets = [];
    ui.studioHtml.value = '';
    setText(ui.studioFile, 'No template selected');
    setStudioStatus('');
    renderAssets();
    renderTemplateControls();
    return;
  }
  if (!force && state.studioPath === path && state.studioDirty) return;

  const seq = ++state.studioSeq;
  try {
    const data = await api('/api/templates/read?path=' + encodeURIComponent(path));
    if (seq !== state.studioSeq) return;
    state.studioPath = data.path;
    state.studioDirty = false;
    state.studioAssets = data.assets || [];
    ui.studioHtml.value = data.html || '';
    setText(ui.studioFile, data.path);
    setStudioStatus(data.bundled ? 'Bundled template (read-only) — click Duplicate to edit a copy.' : '');
    renderAssets();
    renderTemplateControls();
  } catch (err) {
    if (seq !== state.studioSeq) return;
    setStudioStatus(err.message, 'bad');
  }
}

async function selectTemplateAndSync(path) {
  store.set('template', path);
  await hooks.loadState();
  ui.template.value = path;
  describeTemplate();
  await refreshPreview({ resetIndex: true });
  if (state.composeTab === 'studio') await loadStudioTemplate({ force: true });
}

async function createTemplate() {
  const name = await nameDialog({
    title: 'New template',
    hint: 'Created in templates/ as a .html file with unsubscribe and greeting placeholders.',
    confirmLabel: 'Create',
  });
  if (!name) return;
  try {
    const data = await api('/api/templates/save', { name, html: DEFAULT_TEMPLATE_HTML });
    await selectTemplateAndSync(data.path);
    setComposeTab('studio');
    toast('Created ' + data.name, 'ok');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function duplicateTemplate() {
  const path = ui.template.value;
  if (!path) return;
  const stem = path.replace(/^.*\//, '').replace(/\.html?$/i, '');
  const name = await nameDialog({
    title: 'Duplicate template',
    hint: 'Copies both the template HTML and its inline images folder.',
    value: stem + '-copy',
    confirmLabel: 'Duplicate',
  });
  if (!name) return;
  try {
    const data = await api('/api/templates/duplicate', { path, name });
    await selectTemplateAndSync(data.path);
    toast('Duplicated as ' + data.name, 'ok');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function deleteTemplate() {
  const path = ui.template.value;
  if (!path) return;
  const t = state.templates.find((x) => x.path === path);
  const note = t?.assets
    ? 'This removes the template file and its ' + plural(t.assets, 'inline image') + '.'
    : 'This removes the template file from templates/.';
  const ok = await confirmDialog({
    title: 'Delete template?',
    body: [h('p', {}, 'Delete ', h('strong', {}, t?.name || path), '?'), h('p', {}, note)],
    confirmLabel: 'Delete template',
    danger: true,
  });
  if (!ok) return;

  try {
    await api('/api/templates/delete', { path });
    if (store.get('template') === path) store.set('template', '');
    state.studioPath = '';
    state.studioDirty = false;
    await hooks.loadState();
    if (!state.templates.length) ui.template.value = '';
    store.set('template', ui.template.value || '');
    describeTemplate();
    await refreshPreview({ resetIndex: true });
    await loadStudioTemplate({ force: true });
    toast('Deleted ' + (t?.name || path), 'ok');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function saveStudioTemplate() {
  const path = ui.template.value;
  if (!path) return;
  ui.studioSaveBtn.disabled = true;
  setStudioStatus('Saving…');
  try {
    await api('/api/templates/save', { path, html: ui.studioHtml.value });
    state.studioDirty = false;
    setStudioStatus('Saved', 'ok');
    await hooks.loadState();
    await refreshPreview();
  } catch (err) {
    setStudioStatus(err.message, 'bad');
  } finally {
    renderTemplateControls();
  }
}

const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(new Error('Could not read ' + file.name));
  reader.readAsDataURL(file);
});

async function handleAssetFile(file) {
  const path = ui.template.value;
  if (!file || !path) return;
  if (file.size > 5 * 1024 * 1024) {
    toast('Images must be 5 MB or smaller.', 'bad');
    ui.assetInput.value = '';
    return;
  }
  ui.assetBtn.disabled = true;
  setStudioStatus('Uploading image…');
  try {
    const dataBase64 = await readFileAsDataUrl(file);
    const data = await api('/api/templates/assets', { template: path, filename: file.name, dataBase64 });
    await hooks.loadState();
    await loadStudioTemplate({ force: true });
    await refreshPreview();
    setStudioStatus('Uploaded ' + data.filename, 'ok');
    toast('Added ' + data.filename + ' (cid:' + data.cid + ')', 'ok');
  } catch (err) {
    setStudioStatus(err.message, 'bad');
    toast(err.message, 'bad');
  } finally {
    ui.assetInput.value = '';
    renderTemplateControls();
  }
}

async function deleteAsset(filename) {
  const path = ui.template.value;
  if (!path || !filename) return;
  const ok = await confirmDialog({
    title: 'Delete image?',
    body: h('p', {}, 'Remove ', h('strong', {}, filename), ' from this template?'),
    confirmLabel: 'Delete image',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/templates/assets/delete', { template: path, filename });
    await hooks.loadState();
    await loadStudioTemplate({ force: true });
    await refreshPreview();
    toast('Removed ' + filename, 'ok');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

export function initTemplateStudio() {
  ui.composeTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) setComposeTab(tab.dataset.tab);
  });
  ui.composeTabs.addEventListener('keydown', (event) => {
    const tabs = [...ui.composeTabs.querySelectorAll('[role="tab"]')];
    const at = tabs.indexOf(document.activeElement);
    if (at === -1) return;
    const next = { ArrowRight: (at + 1) % tabs.length, ArrowLeft: (at + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setComposeTab(tabs[next].dataset.tab, { focus: true });
  });
  ui.newTemplateBtn.addEventListener('click', createTemplate);
  ui.duplicateTemplateBtn.addEventListener('click', duplicateTemplate);
  ui.deleteTemplateBtn.addEventListener('click', deleteTemplate);
  ui.studioHtml.addEventListener('input', () => {
    state.studioDirty = true;
    setStudioStatus('Unsaved changes');
  });
  ui.studioSaveBtn.addEventListener('click', saveStudioTemplate);
  ui.assetBtn.addEventListener('click', () => ui.assetInput.click());
  ui.assetInput.addEventListener('change', () => {
    if (ui.assetInput.files?.[0]) handleAssetFile(ui.assetInput.files[0]);
  });
  ui.assetList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const filename = button.closest('li')?.dataset.key;
    const asset = state.studioAssets.find((a) => a.filename === filename);
    if (!asset) return;
    if (button.dataset.action === 'insert') {
      insertAtCursor(ui.studioHtml, '<img src="cid:' + asset.cid + '" alt="">');
      state.studioDirty = true;
      setStudioStatus('Unsaved changes');
    } else if (button.dataset.action === 'delete') {
      deleteAsset(asset.filename);
    }
  });
}
