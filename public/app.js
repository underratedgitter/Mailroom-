// Mailroom — browser front end.
// Talks only to the loopback server in src/gui.mjs, which owns all the real
// work. Nothing here holds credentials or sends mail by itself.
//
// Layout stability: the page is polled in the background, so every render
// path patches the DOM in place (setText, reconcile) and touches a node only
// when its value really changed. Nothing rebuilds a list that is unchanged.
'use strict';

// ── DOM helpers ──────────────────────────────────────────────────────
// Reading a property of ui is a getElementById lookup, cached. A missing id
// throws at first use rather than failing silently.
const ui = new Proxy({}, {
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

function h(tag, props = {}, ...children) {
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

function icon(name, className = 'icon') {
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
function setText(node, text) {
  const value = String(text);
  if (node.textContent !== value) node.textContent = value;
}

function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}

function setAttr(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function setClass(node, name, on) {
  if (node.classList.contains(name) !== on) node.classList.toggle(name, on);
}

/**
 * Brings the keyed children of parent in line with items: creates the new,
 * updates the kept, removes the gone and reorders only what moved. A list that
 * did not change is left alone, so hover, focus and scroll state survive.
 */
function reconcile(parent, items, keyOf, create, update) {
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

const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
const baseName = (path) => String(path).split('/').pop();
const mailboxOf = (smtp) => smtp.user || (smtp.from.match(/<([^>]+)>/) || [])[1] || smtp.from || '';

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── State ────────────────────────────────────────────────────────────
const state = {
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
  suppression: { path: '', count: 0 },
  queue: null,
  suppressed: null,

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

  sending: false,
  stream: null,
  jobId: null,
  run: { total: 0, sent: 0, failed: 0, skipped: 0, label: '', campaign: '' },
  tested: false,
  settingsDirty: false,
};

const store = {
  get(key, fallback = '') {
    try { return localStorage.getItem('ams:' + key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('ams:' + key, value); } catch { /* private mode */ }
  },
};

// ── Plumbing ─────────────────────────────────────────────────────────
async function api(path, body) {
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

function toast(message, kind = 'info') {
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
function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, check = '' }) {
  ui.confirmTitle.textContent = title;
  ui.confirmBody.replaceChildren(...[].concat(body));
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

function currentLimit() {
  const n = Number(ui.limit.value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function currentDelay() {
  const n = Number(ui.delay.value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4000;
}

function body(extra = {}) {
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

function options(select, items, preferred) {
  const unchanged = select.options.length === items.length
    && items.every((item, i) => select.options[i].value === item.value && select.options[i].textContent === item.label);
  if (unchanged) return;

  const keep = select.value;
  select.replaceChildren(...items.map((item) => h('option', { value: item.value }, item.label)));
  const wanted = [keep, preferred].find((value) => value && items.some((item) => item.value === value));
  if (wanted) select.value = wanted;
}

function formatWhen(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function relative(iso) {
  const diff = Date.parse(iso) - Date.now();
  if (diff <= 0) return 'due now';
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return 'in ' + Math.max(1, minutes) + ' min';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return 'in ' + hours + ' h';
  return 'in ' + Math.round(hours / 24) + ' d';
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + ' s';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours + ' h' + (rest ? ' ' + rest + ' min' : '');
}

const pad2 = (n) => String(n).padStart(2, '0');

function toLocalInput(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    + 'T' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

// ── Routing ──────────────────────────────────────────────────────────
const ROUTES = [
  { id: 'overview', title: 'Overview', view: 'viewOverview', heading: 'hOverview', enter: () => loadHealth() },
  { id: 'compose', title: 'Compose', view: 'viewCompose', heading: 'hCompose' },
  { id: 'recipients', title: 'Recipients', view: 'viewRecipients', heading: 'hRecipients' },
  { id: 'send', title: 'Send', view: 'viewSend', heading: 'hSend' },
  { id: 'schedule', title: 'Schedule', view: 'viewSchedule', heading: 'hSchedule', enter: () => { prepareScheduleForm(); loadQueue(); } },
  { id: 'suppression', title: 'Suppression list', view: 'viewSuppression', heading: 'hSuppression', enter: () => loadSuppression() },
  { id: 'settings', title: 'Settings', view: 'viewSettings', heading: 'hSettings', enter: () => { loadSettingsForm(); loadHealth(); } },
];

function currentRoute() {
  const id = window.location.hash.replace(/^#\/?/, '').split(/[?/]/)[0];
  return ROUTES.find((route) => route.id === id) || ROUTES[0];
}

let shownRoute = null;

function showRoute({ focus = false } = {}) {
  const route = currentRoute();
  const changed = route !== shownRoute;
  shownRoute = route;

  for (const item of ROUTES) setHidden(ui[item.view], item !== route);
  for (const link of ui.nav.querySelectorAll('a')) {
    if (link.dataset.route === route.id) setAttr(link, 'aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = route.title + ' · Mailroom';

  if (!changed) return;
  window.scrollTo(0, 0);
  const current = ui.nav.querySelector('[aria-current]');
  current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focus) ui[route.heading].focus({ preventScroll: true });
  route.enter?.();
}

function go(id) {
  window.location.hash = '#/' + id;
}

// ── Connection status ────────────────────────────────────────────────
function renderConn() {
  if (!state.smtp) return;
  const configured = state.setup.configured;
  const kind = !configured ? 'warn' : state.conn;
  const labels = { idle: 'Not checked', wait: 'Checking…', ok: 'Connected', bad: 'Failed', warn: 'Not set up' };

  setText(ui.connPill, labels[kind]);
  setAttr(ui.connPill, 'data-state', kind);
  setAttr(ui.sidebarConn, 'data-state', kind === 'wait' ? 'idle' : kind);
  setText(ui.connSub, configured ? (mailboxOf(state.smtp) || state.smtp.host) : 'Not connected');
  setText(ui.connTitle, !configured ? 'Mailbox needs setup' : labels[kind] === 'Not checked' ? 'Mailbox' : 'Mailbox ' + labels[kind].toLowerCase());
}

function setConn(kind) {
  state.conn = kind;
  renderConn();
}

// ── Loading the server's state ───────────────────────────────────────
async function loadState() {
  const data = await api('/api/state');
  applyState(data);
  return data;
}

function applyState(data) {
  const sig = JSON.stringify(data);
  if (sig === state.stateSig) return;
  state.stateSig = sig;

  state.version = data.app?.version || '';
  state.platform = data.platform || '';
  state.smtp = data.smtp;
  state.setup = data.setup || state.setup;
  state.csvs = data.csvs;
  state.templates = data.templates;
  state.log = data.log;
  state.suppression = data.suppression;
  state.defaults = data.defaults;

  const localRelay = data.smtp.host === '127.0.0.1' || data.smtp.host === 'localhost';
  const transport = data.smtp.secure ? 'SSL' : localRelay ? 'plain' : 'STARTTLS';
  setText(ui.statMailbox, mailboxOf(data.smtp) || 'Not connected');
  setText(ui.statServer, data.smtp.host ? data.smtp.host + ':' + data.smtp.port + ' · ' + transport : 'No server set');
  setHidden(ui.setupCallout, data.setup.configured);

  const listed = data.csvs.reduce((sum, c) => sum + c.recipients, 0);
  setText(ui.statLists, data.csvs.length);
  setText(ui.statListsSub, data.csvs.length ? plural(listed, 'recipient') + ' in total' : 'No lists yet');
  const withImages = data.templates.filter((t) => t.assets).length;
  setText(ui.statTemplates, data.templates.length);
  setText(ui.statTemplatesSub, data.templates.length ? withImages + ' with inline images' : 'None found');
  setText(ui.statSuppressed, data.suppression.count);
  setText(ui.statLog, data.log.entries);
  setText(ui.statLogSub, baseName(data.log.path));
  setAttr(ui.statLogSub, 'title', data.log.path);

  setHidden(ui.signOutBtn, !data.setup.authRequired);
  setHidden(ui.accessActions, !data.setup.authRequired);
  setText(ui.accessText, data.setup.authRequired
    ? 'A password is required to open Mailroom.'
    : 'Mailroom is only reachable from this computer.');
  setText(ui.aboutVersion, data.app?.version || '—');
  setText(ui.aboutPlatform, data.platform || '—');
  setText(ui.aboutLog, data.log.path);
  setText(ui.aboutSuppression, data.suppression.path);
  setText(ui.settingsPath, data.setup.configPath ? 'Saved to ' + data.setup.configPath : '');
  setText(ui.settingsLead, data.setup.configured
    ? 'Change where Mailroom sends from. The password is never shown again once saved.'
    : 'Mailroom sends through your own SMTP account, so mail comes from your address and lands in your sent folder. Nothing is shared with anyone else.');

  options(ui.template, data.templates.map((t) => ({ value: t.path, label: t.name })), store.get('template'));
  options(ui.csv, data.csvs.map((c) => ({
    value: c.path,
    label: c.error ? c.name + ' (unreadable)' : c.name + ' — ' + plural(c.recipients, 'recipient'),
  })), store.get('csv'));
  setHidden(ui.csvEmpty, data.csvs.length > 0);
  setHidden(ui.csv.closest('.field'), data.csvs.length === 0);

  if (!ui.campaign.value) ui.campaign.value = store.get('campaign') || data.defaults.campaign;
  if (!ui.delay.dataset.touched && store.get('delay') === '') ui.delay.value = data.defaults.delay;

  renderCampaigns();
  describeTemplate();
  describeCsv();
  renderConn();
  renderDraft();
}

function describeTemplate() {
  const t = state.templates.find((x) => x.path === ui.template.value);
  if (!state.templates.length) { setText(ui.templateHint, 'No templates found. Add an .html file to the templates folder.'); return; }
  if (!t) { setText(ui.templateHint, ''); return; }
  setText(ui.templateHint, t.assets
    ? plural(t.assets, 'file') + ' in ' + t.assetsDir + ' — attached inline via cid:'
    : 'No asset folder beside this template; images would not be embedded.');
}

function describeCsv() {
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
    await loadState();
    await loadRoster();
    await refreshPreview({ resetIndex: true });
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    describeCsv();
  }
}

async function loadHealth() {
  try {
    const data = await api('/api/health');
    state.online = true;
    state.version = data.version || state.version;
    setText(ui.aboutHealth, 'Online' + (data.version ? ' · v' + data.version : ''));
  } catch {
    state.online = false;
    setText(ui.aboutHealth, 'Unreachable');
  }
  setHidden(ui.offlineBar, state.online);
}

// ── Overview ─────────────────────────────────────────────────────────
function renderCampaigns() {
  const rows = state.log.campaigns || [];
  setHidden(ui.campaignsEmpty, rows.length > 0);
  setHidden(ui.campaignsWrap, rows.length === 0);
  const cells = (c) => [c.id, String(c.sent), String(c.failed), String(c.skipped), c.last ? formatWhen(c.last) : '—'];
  reconcile(ui.campaignsBody, rows, (c) => c.id,
    () => h('tr', {}, h('th', { scope: 'row' }), h('td', { class: 'num' }), h('td', { class: 'num' }), h('td', { class: 'num' }), h('td')),
    (tr, c) => {
      cells(c).forEach((text, i) => setText(tr.children[i], text));
      setClass(tr.children[2], 'is-bad', c.failed > 0);
    });
}

function setStep(name, done, text) {
  const li = ui.steps.querySelector('[data-step="' + name + '"]');
  setAttr(li, 'data-state', done ? 'done' : 'todo');
  const sub = ui['step' + name[0].toUpperCase() + name.slice(1)];
  setText(sub, text);
  setAttr(sub, 'title', text);
}

function unpreviewedRecipients() {
  const roster = state.rosters[state.mode];
  return roster && roster.total
    ? plural(roster.total, 'address', 'addresses') + ' in the list. Add a subject to see who will be mailed.'
    : 'No recipients chosen yet.';
}

// What the campaign being drafted still needs, shown on Overview and Send.
function draftChecks() {
  const p = state.lastPreview;
  const subject = ui.subject.value.trim();
  const template = state.templates.find((t) => t.path === ui.template.value);
  const held = p ? [
    p.skipped ? p.skipped + ' already sent' : null,
    p.suppressed ? p.suppressed + ' suppressed' : null,
  ].filter(Boolean) : [];

  return {
    mailbox: {
      ok: state.setup.configured,
      text: state.setup.configured ? (state.smtp.from || state.smtp.user) : 'Not connected yet — add your SMTP details in Settings.',
    },
    compose: {
      ok: Boolean(template && subject),
      text: !state.templates.length ? 'No templates found.'
        : !subject ? 'Add a subject line.'
          : template.name + ' · “' + subject + '”',
    },
    recipients: {
      ok: Boolean(p && p.willSend > 0),
      text: p
        ? (p.willSend > 0
          ? plural(p.willSend, 'message') + ' to send' + (held.length ? ' (' + held.join(', ') + ')' : '')
          : 'Nothing left to send' + (held.length ? ': ' + held.join(', ') : '') + '.')
        : state.previewError || unpreviewedRecipients(),
    },
    // A warning, not a blocker: the message can still be sent.
    links: {
      ok: Boolean(p && !p.warnings?.length),
      text: !p ? 'Checked once there is a preview.'
        : p.warnings?.length ? p.warnings.map((w) => w.message).join(' ')
          : 'Every link works and there is an unsubscribe link.',
    },
  };
}

function renderDraft() {
  if (!state.smtp) return;
  const checks = draftChecks();
  const p = state.lastPreview;

  for (const [name, check] of Object.entries(checks)) {
    const li = ui.sendChecks.querySelector('[data-check="' + (name === 'compose' ? 'template' : name) + '"]');
    setAttr(li, 'data-state', check.ok ? 'ok' : 'bad');
    const sub = ui[{ mailbox: 'chkMailbox', compose: 'chkCompose', recipients: 'chkRecipients', links: 'chkLinks' }[name]];
    setText(sub, check.text);
    setAttr(sub, 'title', check.text);
  }
  setStep('mailbox', checks.mailbox.ok, checks.mailbox.ok ? checks.mailbox.text : 'Required before anything can be sent.');
  setStep('compose', checks.compose.ok, checks.compose.text);
  setStep('recipients', checks.recipients.ok, checks.recipients.text);
  setStep('test', state.tested, state.tested ? 'Test delivered in this session.' : 'Recommended before every campaign.');

  setText(ui.sumFrom, state.smtp.from || '(not set)');
  setText(ui.sumSubject, p ? p.subject : (ui.subject.value.trim() || '—'));
  setText(ui.sumCampaign, ui.campaign.value.trim() || 'No campaign name');
  setText(ui.recipientSummary, p
    ? 'Sending to ' + plural(p.willSend, 'recipient') + (p.source === 'pasted' ? ' from your pasted list.' : ' from ' + baseName(p.source) + '.')
    : 'No recipients chosen yet.');

  const ready = checks.mailbox.ok && checks.compose.ok && checks.recipients.ok;
  setText(ui.sendLabel, ready ? 'Send ' + plural(p.willSend, 'message') : 'Send campaign');
  ui.sendBtn.disabled = state.sending || !ready;
  ui.scheduleBtn.disabled = !(checks.compose.ok && checks.recipients.ok);

  const total = p ? p.willSend * currentDelay() : 0;
  setText(ui.delayHint, ready && total > 0
    ? 'About ' + formatDuration(total) + ' for ' + plural(p.willSend, 'message') + '.'
    : 'Keeps a single mailbox inside provider rate limits.');

  renderScheduleSummary();
}

// ── Merge fields ─────────────────────────────────────────────────────
const BUILTIN_FIELDS = ['name', 'company', 'email'];

function availableFields() {
  const extra = state.columns.filter((c) => c.role === 'field').map((c) => c.name);
  return [...BUILTIN_FIELDS, ...extra.filter((name) => !BUILTIN_FIELDS.includes(name))];
}

function renderTokens() {
  reconcile(ui.tokens, availableFields(), (name) => name,
    (name) => h('button', { type: 'button', class: 'chip', dataset: { field: name }, 'aria-label': 'Insert ' + name }, '{{' + name + '}}'),
    () => {});
}

function renderPlaceholders(placeholders) {
  const labels = { builtin: 'built in', column: 'from your list', missing: 'not in your list' };
  setHidden(ui.placeholdersHint, false);
  reconcile(ui.placeholders, placeholders, (p) => p.name,
    (p) => h('span', { class: 'chip', role: 'listitem' }, h('code'), h('span', { class: 'chip__note' })),
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

function insertToken(token) {
  const input = ui.subject;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + token + input.value.slice(end);
  input.focus();
  input.setSelectionRange(start + token.length, start + token.length);
  store.set('subject', input.value);
  refreshPreview();
}

// ── Preview ──────────────────────────────────────────────────────────
function clearProof(title, text = '', kind = 'error') {
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

async function refreshPreview({ resetIndex = false } = {}) {
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

function applyPreview(data) {
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
  markRosterCurrent();
  renderDraft();
}

// ── Recipients: source tabs, roster and columns ──────────────────────
function activeRosterKey() {
  return state.tab === 'upload' ? 'upload' : state.mode;
}

function setTab(tab, { focus = false, quiet = false } = {}) {
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

function setMode(mode, { refresh = true } = {}) {
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

async function loadRoster() {
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

async function validatePaste() {
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

function renderRoster() {
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

function markRosterCurrent() {
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
    await loadState();
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

// ── Connection check and test send ───────────────────────────────────
async function verify() {
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
    const data = await api('/api/test', body({ to }));
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

function renderRun() {
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

function lockControls() {
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

function unlockControls() {
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
async function resumeActiveJob({ quiet = false } = {}) {
  if (state.sending) return;
  try {
    const active = await api('/api/jobs/active');
    if (!active?.jobId) return;
    lockControls();
    listen(active.jobId);
    if (!quiet) toast('Showing a campaign that is still sending' + (active.total ? ' (' + plural(active.total, 'recipient') + ')' : '') + '.', 'ok');
  } catch { /* nothing running, or server restarting */ }
}

function listen(jobId, attempt = 0) {
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
        note: (data.scope === 'hour' ? 'hourly send ceiling' : data.scope + ' ceiling') + ' reached, resuming in about ' + Math.ceil(data.waitMs / 60000) + ' min',
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
    await loadState();
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

// ── Schedule ─────────────────────────────────────────────────────────
function renderScheduleSummary() {
  const p = state.lastPreview;
  const others = p ? p.willSend - 1 : 0;
  setText(ui.scheduleSummary, p
    ? plural(p.willSend, 'message') + ' to ' + p.to + (others > 0 ? ' and ' + others + ' more' : '') + ' — “' + p.subject + '”.'
    : 'Choose a template, subject and recipients first. The campaign you are drafting is what gets scheduled.');
}

function prepareScheduleForm() {
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

async function loadQueue() {
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

function queueActive() {
  return (state.queue || []).filter((e) => e.status === 'pending' || e.status === 'sending');
}

function renderQueue() {
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
    (e) => h('li', {},
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
      if (!state.sending) lockControls();
      listen(active.jobId);
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

// ── Suppression list ─────────────────────────────────────────────────
const SUPPRESS_SHOWN = 300;

async function loadSuppression() {
  try {
    const data = await api('/api/suppression');
    state.suppressed = data;
    renderSuppression();
  } catch (err) {
    setText(ui.suppressNote, 'Could not load the list: ' + err.message);
  }
}

function renderSuppression() {
  const data = state.suppressed;
  if (!data) return;
  const query = ui.suppressSearch.value.trim().toLowerCase();
  const matches = query ? data.emails.filter((e) => e.includes(query)) : data.emails;
  const shown = matches.slice(0, SUPPRESS_SHOWN);

  setText(ui.suppressCount, plural(data.count, 'address', 'addresses'));
  reconcile(ui.suppressList, shown, (email) => email, (email) => h('li'), (li, email) => setText(li, email));
  setHidden(ui.suppressEmpty, shown.length > 0);
  setText(ui.suppressEmptyTitle, data.count ? 'No matches' : 'No suppressed addresses');
  setText(ui.suppressEmptyText, data.count ? 'Nothing on the list matches “' + ui.suppressSearch.value.trim() + '”.' : 'Addresses you add, and hard bounces found while sending, appear here. Unsubscribe requests are not added automatically: add them here when they arrive.');
  setText(ui.suppressNote, (matches.length > shown.length ? 'Showing the first ' + shown.length + ' of ' + matches.length + '. Filter to narrow it down. ' : '')
    + 'To remove an address, edit ' + data.path + '.');
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
    await loadState();
    refreshPreview();
  } catch (err) {
    setSuppressStatus(err.message, 'bad');
  } finally {
    ui.suppressBtn.disabled = false;
  }
}

function setSuppressStatus(text, kind = '') {
  setText(ui.suppressStatus, text);
  setClass(ui.suppressStatus, 'is-ok', kind === 'ok');
  setClass(ui.suppressStatus, 'is-bad', kind === 'bad');
}

// ── Settings ─────────────────────────────────────────────────────────
async function loadSettingsForm() {
  if (state.settingsDirty) return;
  try {
    const settings = await api('/api/settings');
    if (state.settingsDirty) return;
    ui.setHost.value = settings.host || '';
    ui.setPort.value = settings.port || 465;
    ui.setSecure.value = String(Boolean(settings.secure));
    ui.setUser.value = settings.user || '';
    ui.setFrom.value = settings.from || '';
    ui.setReplyTo.value = settings.replyTo || '';
    ui.setUnsubUrl.value = settings.unsubscribeUrl || '';
    ui.setMaxPerHour.value = settings.maxPerHour || '';
    ui.setPass.value = '';
    ui.setPass.placeholder = settings.passwordSet ? 'Saved — leave blank to keep it' : '16 characters';
    setText(ui.setPassHint, settings.passwordSet
      ? 'A password is already saved. Leave blank unless you are changing it.'
      : 'Gmail needs an App Password, not your login password.');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function settingsPayload() {
  return {
    host: ui.setHost.value.trim(),
    port: Number(ui.setPort.value) || undefined,
    secure: ui.setSecure.value === 'true',
    user: ui.setUser.value.trim(),
    pass: ui.setPass.value,
    from: ui.setFrom.value.trim(),
    replyTo: ui.setReplyTo.value.trim(),
    unsubscribeUrl: ui.setUnsubUrl.value.trim(),
    maxPerHour: ui.setMaxPerHour.value.trim(),
  };
}

function setSettingsStatus(text, kind = '') {
  setText(ui.settingsStatus, text);
  setClass(ui.settingsStatus, 'is-ok', kind === 'ok');
  setClass(ui.settingsStatus, 'is-bad', kind === 'bad');
}

function settingsBusy(busy) {
  ui.settingsTestBtn.disabled = busy;
  ui.settingsSaveBtn.disabled = busy;
}

async function testSettings() {
  settingsBusy(true);
  setSettingsStatus('Connecting…');
  try {
    const data = await api('/api/settings/test', settingsPayload());
    if (data.ok) {
      setSettingsStatus('Connected to ' + data.smtp.host + ':' + data.smtp.port + ' as ' + (data.smtp.user || 'local') + '.', 'ok');
    } else {
      setSettingsStatus(data.error || 'Connection failed.', 'bad');
    }
  } catch (err) {
    setSettingsStatus(err.message, 'bad');
  } finally {
    settingsBusy(false);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const firstRun = !state.setup.configured;
  settingsBusy(true);
  setSettingsStatus('Checking the connection…');
  try {
    const data = await api('/api/settings', settingsPayload());
    if (!data.ok) {
      setSettingsStatus(data.error || 'Those settings did not work.', 'bad');
      return;
    }
    state.settingsDirty = false;
    ui.setPass.value = '';
    setSettingsStatus('Saved. Mailroom signed in successfully.', 'ok');
    setConn('ok');
    toast('Mailbox connected — settings saved.', 'ok');

    await loadState();
    await loadSettingsForm();
    await refreshPreview({ resetIndex: true });
    if (firstRun) go('compose');
  } catch (err) {
    setSettingsStatus(err.message, 'bad');
  } finally {
    settingsBusy(false);
  }
}

async function signOut() {
  try { await api('/api/logout', {}); } catch { /* already signed out */ }
  window.location.replace('/login.html');
}

// ── Events ───────────────────────────────────────────────────────────
window.addEventListener('hashchange', () => showRoute({ focus: true }));

ui.nav.addEventListener('click', (event) => {
  // Choosing the page you are on should still move focus to its heading.
  const link = event.target.closest('a');
  if (link && link.dataset.route === currentRoute().id) ui[currentRoute().heading].focus({ preventScroll: true });
});

document.querySelector('.skip').addEventListener('click', (event) => {
  event.preventDefault();
  ui.main.focus();
});

ui.retryBtn.addEventListener('click', () => { loadHealth(); refreshBackground(); });

ui.verifyBtn.addEventListener('click', verify);
ui.verifyBtn2.addEventListener('click', verify);
ui.signOutBtn.addEventListener('click', signOut);
ui.signOutBtn2.addEventListener('click', signOut);

// Compose
ui.template.addEventListener('change', () => {
  store.set('template', ui.template.value);
  describeTemplate();
  refreshPreview({ resetIndex: true });
});
ui.subject.addEventListener('input', debounce(() => {
  store.set('subject', ui.subject.value);
  refreshPreview();
}, 420));
ui.campaign.addEventListener('input', () => {
  store.set('campaign', ui.campaign.value);
  renderDraft();
  refreshForCampaign();
});
const refreshForCampaign = debounce(() => { refreshPreview(); loadRoster(); }, 450);
ui.tokens.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-field]');
  if (chip) insertToken('{{' + chip.dataset.field + '}}');
});
ui.previewBtn.addEventListener('click', () => refreshPreview({ resetIndex: true }));
ui.prevBtn.addEventListener('click', () => { state.index--; refreshPreview(); });
ui.nextBtn.addEventListener('click', () => { state.index++; refreshPreview(); });
ui.composeForm.addEventListener('submit', (event) => event.preventDefault());

// Recipients
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

// Send
ui.sendBtn.addEventListener('click', startSend);
ui.testBtn.addEventListener('click', sendTest);
ui.testTo.addEventListener('input', () => store.set('test', ui.testTo.value));
ui.testTo.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); sendTest(); }
});
ui.delay.addEventListener('input', () => { ui.delay.dataset.touched = '1'; renderDraft(); });
ui.delay.addEventListener('change', () => store.set('delay', ui.delay.value));
ui.cancelBtn.addEventListener('click', cancelSend);

// Schedule
ui.scheduleForm.addEventListener('submit', submitSchedule);
ui.queueList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const id = button.closest('li').dataset.key;
  if (button.dataset.action === 'run') runScheduled(id);
  else if (button.dataset.action === 'reschedule') openReschedule(id);
  else cancelScheduled(id);
});

// Suppression
ui.suppressForm.addEventListener('submit', submitSuppress);
ui.suppressSearch.addEventListener('input', debounce(renderSuppression, 150));

// Settings
ui.settingsForm.addEventListener('submit', saveSettings);
ui.settingsForm.addEventListener('input', () => { state.settingsDirty = true; });
// The two common ports each imply a mode; pick it so the selector starts right.
ui.setPort.addEventListener('change', () => {
  const port = Number(ui.setPort.value);
  if (port === 465) ui.setSecure.value = 'true';
  else if (port === 587 || port === 25) ui.setSecure.value = 'false';
});
ui.settingsTestBtn.addEventListener('click', testSettings);

// Confirm dialog
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

ui.rescheduleForm.addEventListener('submit', submitReschedule);
ui.rescheduleCancel.addEventListener('click', () => ui.rescheduleDialog.close());
ui.rescheduleDialog.addEventListener('click', (event) => {
  if (event.target === ui.rescheduleDialog) ui.rescheduleDialog.close();
});
ui.rescheduleDialog.addEventListener('close', () => { rescheduleId = null; });

// ── Background refresh ───────────────────────────────────────────────
// The scheduler runs on the server; poll so counts, the queue and progress
// from a scheduled send stay honest without a reload. Every poll patches in
// place, so an idle page does not move.
async function refreshBackground() {
  try {
    await loadState();
    state.online = true;
    setHidden(ui.offlineBar, true);
  } catch {
    state.online = false;
    setHidden(ui.offlineBar, false);
    return;
  }
  await loadQueue();
  if (currentRoute().id === 'suppression') await loadSuppression();
  if (currentRoute().id === 'settings' || currentRoute().id === 'overview') await loadHealth();
}

let tick = 0;
setInterval(async () => {
  if (document.hidden) return;
  tick++;
  if (!state.sending) await resumeActiveJob({ quiet: true });
  if (tick % 3 === 0) await refreshBackground();
}, 5000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.loaded) { resumeActiveJob({ quiet: true }); refreshBackground(); }
});

// ── Boot ─────────────────────────────────────────────────────────────
async function boot() {
  // Restore the draft from an earlier session before anything renders.
  ui.subject.value = store.get('subject', '');
  ui.testTo.value = store.get('test', '');
  if (store.get('delay')) ui.delay.value = store.get('delay');
  state.mode = store.get('mode') === 'paste' ? 'paste' : 'saved';
  state.tab = state.mode;
  setTab(state.tab, { quiet: true });
  showRoute();

  try {
    const data = await loadState();
    state.loaded = true;
    if (!data.setup.configured && !window.location.hash) {
      history.replaceState(null, '', '#/settings');
      showRoute();
    }
    renderTokens();
    await Promise.all([
      state.mode === 'saved' ? loadRoster() : validatePaste(),
      refreshPreview({ resetIndex: true }),
      loadQueue(),
      loadHealth(),
    ]);
    await resumeActiveJob({ quiet: true });
  } catch (err) {
    setText(ui.offlineText, 'Could not reach the Mailroom server: ' + err.message);
    setHidden(ui.offlineBar, false);
    toast('Could not reach the local server. Is it still running?', 'bad');
  } finally {
    document.body.classList.remove('is-loading');
  }
}

boot();
