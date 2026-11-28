// Shared browser DOM, state, dialog, toast, and API plumbing.

// Reading a property of ui is a getElementById lookup, cached. A missing id
// throws at first use rather than failing silently.
export const ui = new Proxy({}, {
  get(cache, id) {
    if (typeof id !== 'string') return undefined;
    if (!(id in cache)) {
      const node = document.getElementById(id);
      if (!node) throw new Error('Missing element #' + id);
      cache[id] = node;
    }
    return cache[id];
  },
});

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

export function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

// Writing identical text still swaps the text node, which makes the browser
// re-layout (and can drop a text selection), so repeated refreshes go through
// these and touch the DOM only when the value really changed.
export function setText(node, text) {
  const value = String(text);
  if (node.textContent !== value) node.textContent = value;
}

export function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}

export function setAttr(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

export function setClass(node, name, on) {
  if (node.classList.contains(name) !== on) node.classList.toggle(name, on);
}

/**
 * Brings the keyed children of parent in line with items: creates the new,
 * updates the kept, removes the gone and reorders only what moved. A list that
 * did not change is left alone, so hover, focus and scroll state survive.
 */
export function reconcile(parent, items, keyOf, create, update) {
  const old = new Map();
  for (const child of parent.children) old.set(child.dataset.key, child);

  const seen = new Set();
  let cursor = parent.firstElementChild;
  for (const item of items) {
    const key = String(keyOf(item));
    seen.add(key);
    let node = old.get(key);
    if (!node) {
      node = create(item);
      node.dataset.key = key;
    }
    update(node, item);
    if (node === cursor) cursor = cursor.nextElementSibling;
    else parent.insertBefore(node, cursor);
  }
  for (const [key, node] of old) if (!seen.has(key)) node.remove();
}

export const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
export const baseName = (path) => String(path).split('/').pop();

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export const state = {
  loaded: false,
  stateSig: '',
  online: true,
  version: '',
  platform: '',
  smtp: null,
  setup: { configured: false, configPath: '', authRequired: false },
  conn: 'idle', // idle | wait | ok | bad — outcome of the last connection check
  csvs: [],
  templates: [],
  log: { path: '', entries: 0, campaigns: [] },
  campaigns: null,
  suppression: { path: '', count: 0 },
  queue: null,
  suppressed: null,
  campaignPage: { q: '', offset: 0, limit: 25, total: 0, filtered: 0 },
  suppressionPage: { q: '', reason: '', offset: 0, limit: 50, filtered: 0 },
  rosterPage: { q: '', offset: 0, pageSize: 200 },
  dns: null,
  webhook: { configured: false },

  mode: 'saved', // which source the campaign really uses: saved | paste
  tab: 'saved', // which source tab is showing: saved | paste | upload
  rosters: { saved: null, paste: null, upload: null },
  rosterErrors: { saved: '', paste: '', upload: '' },
  rosterSig: '',
  rosterMarked: -1,
  columns: [],
  upload: null,
  previewSeq: 0,
  rosterSeq: 0,
  pasteSeq: 0,
  index: 0,
  total: 0,
  lastPreview: null,
  previewError: '',
  previewMode: 'html',
  previewMobile: false,
  previewDark: false,
  composeTab: 'message',
  studioPath: '',
  studioDirty: false,
  studioAssets: [],
  studioSeq: 0,

  sending: false,
  stream: null,
  jobId: null,
  run: { total: 0, sent: 0, failed: 0, skipped: 0, label: '', campaign: '' },
  tested: false,
  settingsDirty: false,
};

export const store = {
  get(key, fallback = '') {
    try { return localStorage.getItem('ams:' + key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('ams:' + key, value); } catch { /* private mode */ }
  },
};

// Cross-module callbacks registered by main.mjs to keep module imports acyclic.
export const hooks = {
  loadState: async () => {},
  renderScheduleSummary: () => {},
  markRosterCurrent: () => {},
  loadRoster: async () => {},
  renderTemplateControls: () => {},
  loadStudioTemplate: async (_opts) => {},
  attachJob: (_jobId) => {},
};

export async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Cannot reach the Mailroom server. Is it still running?');
  }
  if (res.status === 401 && path !== '/api/login') {
    window.location.replace('/login.html');
    throw new Error('Sign in required');
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
  return data;
}

export function toast(message, kind = 'info') {
  const close = h('button', { class: 'toast__close', type: 'button', 'aria-label': 'Dismiss notification' }, icon('x'));
  const node = h('div', { class: 'toast', role: kind === 'bad' ? 'alert' : 'status', dataset: { kind } },
    h('span', { class: 'toast__text' }, message), close);
  const remove = () => node.remove();
  close.addEventListener('click', remove);
  ui.toasts.append(node);
  while (ui.toasts.children.length > 4) ui.toasts.firstElementChild.remove();
  setTimeout(remove, kind === 'bad' ? 9000 : 5000);
}

let confirmResolve = null;

/** A modal question. Resolves true only when the person confirms. */
export function confirmDialog({ title, body: bodyContent, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, check = '' }) {
  ui.confirmTitle.textContent = title;
  ui.confirmBody.replaceChildren(...[].concat(bodyContent));
  ui.confirmOk.textContent = confirmLabel;
  ui.confirmOk.className = 'btn ' + (danger ? 'btn--danger' : 'btn--primary');
  ui.confirmCancel.textContent = cancelLabel;
  ui.confirmCheckText.textContent = check;
  ui.confirmCheck.checked = false;
  setHidden(ui.confirmCheckRow, !check);
  ui.confirmOk.disabled = Boolean(check);
  ui.confirmDialog.returnValue = '';

  return new Promise((resolve) => {
    confirmResolve = resolve;
    ui.confirmDialog.showModal();
    (check ? ui.confirmCheck : ui.confirmCancel).focus();
  });
}

let nameResolve = null;

/** A modal text prompt for naming or duplicating a template. */
export function nameDialog({ title, hint = '', value = '', confirmLabel = 'Create' }) {
  ui.nameTitle.textContent = title;
  setText(ui.nameHint, hint);
  ui.nameInput.value = value;
  setText(ui.nameError, '');
  ui.nameOk.textContent = confirmLabel;
  ui.nameDialog.returnValue = '';

  return new Promise((resolve) => {
    nameResolve = resolve;
    ui.nameDialog.showModal();
    ui.nameInput.focus();
    ui.nameInput.select();
  });
}

export function currentLimit() {
  const n = Number(ui.limit.value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function currentDelay() {
  const n = Number(ui.delay.value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4000;
}

export function body(extra = {}) {
  const base = {
    html: ui.template.value,
    subject: ui.subject.value,
    campaign: ui.campaign.value.trim(),
    limit: currentLimit(),
    ...extra,
  };
  return state.mode === 'paste'
    ? { ...base, raw: ui.pasteBox.value }
    : { ...base, csv: ui.csv.value };
}

export function formatWhen(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + ' s';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours + ' h' + (rest ? ' ' + rest + ' min' : '');
}

export const pad2 = (n) => String(n).padStart(2, '0');

export function go(id) {
  window.location.hash = '#/' + id;
}

export function initDialogs() {
  ui.confirmCheck.addEventListener('change', () => { ui.confirmOk.disabled = !ui.confirmCheck.checked; });
  ui.confirmCheck.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && ui.confirmCheck.checked) { event.preventDefault(); ui.confirmDialog.close('ok'); }
  });
  ui.confirmOk.addEventListener('click', () => ui.confirmDialog.close('ok'));
  ui.confirmCancel.addEventListener('click', () => ui.confirmDialog.close('cancel'));
  ui.confirmDialog.addEventListener('click', (event) => {
    if (event.target === ui.confirmDialog) ui.confirmDialog.close('cancel');
  });
  ui.confirmDialog.addEventListener('close', () => {
    const resolve = confirmResolve;
    confirmResolve = null;
    resolve?.(ui.confirmDialog.returnValue === 'ok');
  });

  ui.nameInput.addEventListener('input', () => setText(ui.nameError, ''));
  ui.nameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!ui.nameInput.value.trim()) {
      setText(ui.nameError, 'Enter a template name.');
      ui.nameInput.focus();
      return;
    }
    ui.nameDialog.close('ok');
  });
  ui.nameCancel.addEventListener('click', () => ui.nameDialog.close('cancel'));
  ui.nameDialog.addEventListener('click', (event) => {
    if (event.target === ui.nameDialog) ui.nameDialog.close('cancel');
  });
  ui.nameDialog.addEventListener('close', () => {
    const resolve = nameResolve;
    nameResolve = null;
    resolve?.(ui.nameDialog.returnValue === 'ok' ? ui.nameInput.value.trim() : null);
  });
}
