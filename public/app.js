// Mailroom — browser front end.
// Talks only to the loopback server in src/gui.mjs, which owns all the real
// work. Nothing here holds credentials or sends mail by itself.

const $ = (id) => document.getElementById(id);

const el = {
  metaFrom: $('metaFrom'),
  metaServer: $('metaServer'),
  metaLog: $('metaLog'),
  verifyBtn: $('verifyBtn'),
  stamp: $('stampResult'),
  settingsBtn: $('settingsBtn'),
  signOutBtn: $('signOutBtn'),

  queueBtn: $('queueBtn'),
  queueCount: $('queueCount'),
  scheduleBtn: $('scheduleBtn'),
  scheduleModal: $('scheduleModal'),
  scheduleSummary: $('scheduleSummary'),
  scheduleAt: $('scheduleAt'),
  scheduleZone: $('scheduleZone'),
  scheduleStatus: $('scheduleStatus'),
  scheduleCancel: $('scheduleCancel'),
  scheduleConfirm: $('scheduleConfirm'),
  queueModal: $('queueModal'),
  queueList: $('queueList'),
  queueEmpty: $('queueEmpty'),
  queueClose: $('queueClose'),

  settingsModal: $('settingsModal'),
  settingsTitle: $('settingsTitle'),
  settingsLead: $('settingsLead'),
  setHost: $('setHost'),
  setPort: $('setPort'),
  setUser: $('setUser'),
  setPass: $('setPass'),
  setFrom: $('setFrom'),
  setUserHint: $('setUserHint'),
  setPassHint: $('setPassHint'),
  settingsStatus: $('settingsStatus'),
  settingsPath: $('settingsPath'),
  settingsTestBtn: $('settingsTestBtn'),
  settingsSaveBtn: $('settingsSaveBtn'),
  settingsCancel: $('settingsCancel'),

  form: $('compose'),
  template: $('template'),
  templateHint: $('templateHint'),
  csv: $('csv'),
  csvHint: $('csvHint'),
  modeSaved: $('modeSaved'),
  modePaste: $('modePaste'),
  roster: $('roster'),
  rosterCount: $('rosterCount'),
  rosterList: $('rosterList'),
  pastePanel: $('pastePanel'),
  pasteBox: $('pasteBox'),
  pasteCount: $('pasteCount'),
  saveCsvBtn: $('saveCsvBtn'),
  subject: $('subject'),
  tokens: $('tokens'),
  campaign: $('campaign'),
  limit: $('limit'),
  delay: $('delay'),
  testTo: $('testTo'),
  slipNo: $('slipNo'),

  sendBtn: $('sendBtn'),
  testBtn: $('testBtn'),
  previewBtn: $('previewBtn'),

  proofTo: $('proofTo'),
  proofSubject: $('proofSubject'),
  proofIndex: $('proofIndex'),
  proofImages: $('proofImages'),
  proofTotal: $('proofTotal'),
  proofEmpty: $('proofEmpty'),
  preview: $('preview'),
  prevBtn: $('prevBtn'),
  nextBtn: $('nextBtn'),

  runCounts: $('runCounts'),
  ledger: $('ledger'),
  cancelBtn: $('cancelBtn'),

  modal: $('modal'),
  modalBody: $('modalBody'),
  modalCheck: $('modalCheck'),
  modalCancel: $('modalCancel'),
  modalConfirm: $('modalConfirm'),

  notice: $('notice'),
};

const state = {
  smtp: null,
  setup: { configured: false, configPath: '', authRequired: false },
  firstRun: false,
  queue: [],
  csvs: [],
  templates: [],
  mode: 'saved',
  roster: null,
  index: 0,
  total: 0,
  willSend: 0,
  sending: false,
  stream: null,
  jobId: null,
  lastPreview: null,
  toastTimer: null,
};

const store = {
  get(key, fallback = '') {
    try { return localStorage.getItem(`ams:${key}`) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`ams:${key}`, value); } catch { /* private mode */ }
  },
};

// ── Plumbing ─────────────────────────────────────────────────────────
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message, kind = '') {
  el.notice.textContent = message;
  el.notice.className = `notice is-on${kind ? ` is-${kind}` : ''}`;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    el.notice.className = 'notice';
  }, 6000);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function options(select, items, current) {
  select.innerHTML = '';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.append(option);
  }
  if (current && items.some((i) => i.value === current)) select.value = current;
}

function currentLimit() {
  const n = Number(el.limit.value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function currentDelay() {
  const n = Number(el.delay.value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4000;
}

function body(extra = {}) {
  const base = {
    html: el.template.value,
    subject: el.subject.value,
    campaign: el.campaign.value.trim(),
    limit: currentLimit(),
    ...extra,
  };
  return state.mode === 'paste'
    ? { ...base, raw: el.pasteBox.value }
    : { ...base, csv: el.csv.value };
}

// ── Recipient source: saved CSV or a pasted list ─────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function inspectPaste(text = el.pasteBox.value) {
  const seen = new Set();
  let valid = 0, invalid = 0, duplicates = 0;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const angled = line.match(/^(.*?)<([^>]+)>\s*$/);
    const email = angled ? angled[2].trim() : (line.split(/\s*[,;\t]\s*/)[0] || '').trim();
    if (!EMAIL_RE.test(email)) { invalid++; continue; }
    const key = email.toLowerCase();
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    valid++;
  }
  return { valid, invalid, duplicates };
}

function updatePasteCount() {
  const { valid, invalid, duplicates } = inspectPaste();
  if (!valid && !invalid) {
    el.pasteCount.textContent = 'One address per line; name and company optional.';
    return;
  }
  const parts = [plural(valid, 'address', 'addresses')];
  if (duplicates) parts.push(`${duplicates} duplicate${duplicates === 1 ? '' : 's'}`);
  if (invalid) parts.push(`${invalid} unusable`);
  el.pasteCount.textContent = parts.join(' · ');
}

// ── Recipient roster (the saved CSV, made visible) ────────────────────
async function loadRoster() {
  if (state.mode !== 'saved' || !el.csv.value) { el.roster.hidden = true; return; }
  try {
    const data = await api('/api/roster', {
      csv: el.csv.value,
      campaign: el.campaign.value.trim(),
      limit: currentLimit(),
    });
    renderRoster(data);
  } catch (err) {
    el.roster.hidden = true;
    el.rosterList.innerHTML = '';
    el.rosterCount.textContent = err.message;
  }
}

function renderRoster(data) {
  state.roster = data;
  el.roster.hidden = false;

  const bits = [plural(data.total, 'address', 'addresses')];
  if (data.sentCount) bits.push(`${data.sentCount} already sent`);
  if (data.truncated) bits.push(`${data.truncated} held by limit`);
  if (data.duplicates) bits.push(`${data.duplicates} duplicate${data.duplicates === 1 ? '' : 's'}`);
  if (data.invalid) bits.push(`${data.invalid} unusable`);
  el.rosterCount.textContent = bits.join(' · ');

  const frag = document.createDocumentFragment();
  data.recipients.forEach((rec, i) => {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'roster__row';
    row.dataset.index = String(i);
    row.title = `${rec.email} — click to preview`;

    const no = document.createElement('span');
    no.className = 'roster__no';
    no.textContent = String(i + 1).padStart(2, '0');

    const content = document.createElement('span');
    content.className = 'roster__content';
    const mail = document.createElement('span');
    mail.className = 'roster__mail';
    mail.textContent = rec.email;
    content.append(mail);

    const meta = [rec.name, rec.company].filter(Boolean).join(' · ');
    if (meta) {
      const metaEl = document.createElement('span');
      metaEl.className = 'roster__meta';
      metaEl.textContent = meta;
      content.append(metaEl);
    }

    const tag = document.createElement('span');
    tag.className = 'roster__tag';
    tag.textContent = 'sent';
    tag.hidden = !rec.sent;

    row.append(no, content, tag);
    row.addEventListener('click', () => {
      state.index = i;
      refreshPreview();
    });
    li.append(row);
    frag.append(li);
  });

  el.rosterList.replaceChildren(frag);
  markRosterCurrent(state.index);
}

function markRosterCurrent(index) {
  let active = null;
  for (const row of el.rosterList.querySelectorAll('.roster__row')) {
    const current = Number(row.dataset.index) === index;
    row.classList.toggle('is-current', current);
    if (current) active = row;
  }
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function setMode(mode, { refresh = true, focus = false } = {}) {
  state.mode = mode === 'paste' ? 'paste' : 'saved';
  store.set('mode', state.mode);
  const pasting = state.mode === 'paste';

  el.modeSaved.classList.toggle('is-on', !pasting);
  el.modePaste.classList.toggle('is-on', pasting);
  el.modeSaved.setAttribute('aria-pressed', String(!pasting));
  el.modePaste.setAttribute('aria-pressed', String(pasting));

  el.csv.hidden = pasting;
  el.csvHint.hidden = pasting;
  el.roster.hidden = pasting;
  el.pastePanel.hidden = !pasting;
  el.sendBtn.disabled = true;

  updatePasteCount();
  if (pasting) {
    if (focus) el.pasteBox.focus();
  } else {
    loadRoster();
  }
  if (refresh) refreshPreview({ resetIndex: true });
}

// ── Boot ─────────────────────────────────────────────────────────────
async function loadState() {
  const data = await api('/api/state');
  state.smtp = data.smtp;
  state.csvs = data.csvs;
  state.templates = data.templates;
  state.setup = data.setup || state.setup;

  el.metaFrom.textContent = data.smtp.from || '(not set)';
  const localRelay = data.smtp.host === '127.0.0.1' || data.smtp.host === 'localhost';
  const transport = data.smtp.secure ? '' : localRelay ? ' plain' : ' starttls';
  el.metaServer.textContent = `${data.smtp.host}:${data.smtp.port}${transport}`;
  el.metaLog.textContent = data.log.path;
  el.signOutBtn.hidden = !state.setup.authRequired;

  const templateItems = data.templates.map((t) => ({
    value: t.path,
    label: t.name,
  }));
  const csvItems = data.csvs.map((c) => ({
    value: c.path,
    label: c.error ? `${c.name} (unreadable)` : `${c.name} — ${plural(c.recipients, 'recipient')}`,
  }));

  options(el.template, templateItems, store.get('template') || templateItems[0]?.value);
  options(el.csv, csvItems, store.get('csv') || csvItems[0]?.value);

  if (!el.campaign.value) el.campaign.value = store.get('campaign') || data.defaults.campaign;
  if (!el.delay.value) el.delay.value = data.defaults.delay;

  describeTemplate();
  describeCsv();
}

function describeTemplate() {
  const t = state.templates.find((x) => x.path === el.template.value);
  if (!t) { el.templateHint.textContent = ''; return; }
  el.templateHint.textContent = t.assets
    ? `${plural(t.assets, 'file')} in ${t.assetsDir} — attached inline via cid:`
    : 'No asset folder beside this template; images would not be embedded.';
}

// The roster below the picker carries the counts; this line is for errors.
function describeCsv() {
  const c = state.csvs.find((x) => x.path === el.csv.value);
  el.csvHint.textContent = c?.error || '';
}

// ── Preview ──────────────────────────────────────────────────────────
function clearProof(message) {
  el.proofEmpty.hidden = false;
  el.proofEmpty.textContent = message;
  el.preview.srcdoc = '';
  el.proofTo.textContent = 'No recipient';
  el.proofSubject.textContent = '';
  el.proofIndex.textContent = '0 / 0';
  el.proofImages.textContent = '0 inline images';
  el.proofTotal.textContent = '';
  el.sendBtn.textContent = 'Send';
  el.sendBtn.disabled = true;
  state.willSend = 0;
  state.lastPreview = null;
}

async function refreshPreview({ resetIndex = false } = {}) {
  if (!el.template.value) return;
  if (state.mode === 'paste' && !el.pasteBox.value.trim()) {
    clearProof('Paste one address per line — name and company are optional.');
    return;
  }
  if (state.mode === 'saved' && !el.csv.value) return;
  if (!el.subject.value.trim()) {
    clearProof('Add a subject line, then the preview appears here.');
    return;
  }
  if (resetIndex) state.index = 0;

  try {
    const data = await api('/api/preview', body({ index: state.index }));
    applyPreview(data);
  } catch (err) {
    clearProof(err.message);
  }
}

function applyPreview(data) {
  state.index = data.index;
  state.total = data.total;
  state.willSend = data.willSend;
  state.lastPreview = data;

  el.preview.srcdoc = data.html;
  el.proofEmpty.hidden = true;
  el.proofTo.textContent = data.to;
  el.proofSubject.textContent = data.subject;
  el.proofIndex.textContent = `${data.index + 1} / ${data.total}`;
  el.proofImages.textContent = plural(data.inline, 'inline image');
  el.proofTotal.textContent = [
    `${data.willSend} to send`,
    `${data.skipped} already sent`,
    data.truncated ? `${data.truncated} held back by limit` : null,
  ].filter(Boolean).join(' · ');

  markRosterCurrent(data.index);

  el.slipNo.textContent = el.campaign.value.trim() || 'no campaign';
  el.sendBtn.textContent = data.willSend ? `Send ${plural(data.willSend, 'message')}` : 'Nothing left to send';
  el.sendBtn.disabled = state.sending || data.willSend === 0;
  el.scheduleBtn.disabled = data.willSend === 0;

  el.prevBtn.disabled = data.index <= 0;
  el.nextBtn.disabled = data.index >= data.total - 1;
}

// ── Mailbox settings ─────────────────────────────────────────────────
async function openSettings({ firstRun = false } = {}) {
  state.firstRun = firstRun && !state.setup.configured;

  el.settingsTitle.textContent = state.firstRun ? 'Connect your mailbox' : 'Mailbox settings';
  el.settingsLead.textContent = state.firstRun
    ? 'Mailroom sends through your own SMTP account, so mail comes from your address and lands in your sent folder. Nothing is shared with anyone else.'
    : 'Change where Mailroom sends from. The password is never shown again once saved.';
  el.settingsCancel.hidden = state.firstRun;
  el.settingsStatus.textContent = '';
  el.settingsStatus.className = 'settings__status';
  el.settingsPath.textContent = state.setup.configPath
    ? `Saved to ${state.setup.configPath}`
    : '';

  el.settingsModal.hidden = false;

  try {
    const settings = await api('/api/settings');
    el.setHost.value = settings.host || '';
    el.setPort.value = settings.port || 465;
    el.setUser.value = settings.user || '';
    el.setFrom.value = settings.from || '';
    el.setPass.value = '';
    el.setPass.placeholder = settings.passwordSet ? 'Saved — leave blank to keep it' : '16 characters';
    el.setPassHint.textContent = settings.passwordSet
      ? 'A password is already saved. Leave blank unless you are changing it.'
      : 'Gmail needs an App Password, not your login password.';
  } catch (err) {
    toast(err.message, 'bad');
  }

  (el.setHost.value ? el.setUser : el.setHost).focus();
}

function closeSettings() {
  if (state.firstRun) return; // setup cannot be skipped
  el.settingsModal.hidden = true;
}

function settingsPayload() {
  return {
    host: el.setHost.value.trim(),
    port: Number(el.setPort.value) || undefined,
    user: el.setUser.value.trim(),
    pass: el.setPass.value,
    from: el.setFrom.value.trim(),
  };
}

function setSettingsStatus(text, kind = '') {
  el.settingsStatus.textContent = text;
  el.settingsStatus.className = `settings__status${kind ? ` is-${kind}` : ''}`;
}

async function testSettings() {
  el.settingsTestBtn.disabled = true;
  el.settingsSaveBtn.disabled = true;
  setSettingsStatus('Connecting…');
  try {
    const data = await api('/api/settings/test', settingsPayload());
    if (data.ok) {
      setSettingsStatus(`Connected to ${data.smtp.host}:${data.smtp.port} as ${data.smtp.user || 'local'}`, 'ok');
      setStamp('ok', 'connection ok');
    } else {
      setSettingsStatus(data.error || 'Connection failed', 'bad');
    }
  } catch (err) {
    setSettingsStatus(err.message, 'bad');
  } finally {
    el.settingsTestBtn.disabled = false;
    el.settingsSaveBtn.disabled = false;
  }
}

async function saveSettings() {
  el.settingsSaveBtn.disabled = true;
  el.settingsTestBtn.disabled = true;
  setSettingsStatus('Checking the connection…');
  try {
    const data = await api('/api/settings', settingsPayload());
    if (!data.ok) {
      setSettingsStatus(data.error || 'Those settings did not work', 'bad');
      return;
    }
    state.firstRun = false;
    el.settingsModal.hidden = true;
    el.setPass.value = '';
    setStamp('ok', 'connection ok');
    toast('Mailbox connected — settings saved.', 'ok');

    await loadState();
    await refreshPreview({ resetIndex: true });
    if (state.mode === 'saved') await loadRoster();
  } catch (err) {
    setSettingsStatus(err.message, 'bad');
  } finally {
    el.settingsSaveBtn.disabled = false;
    el.settingsTestBtn.disabled = false;
  }
}

async function signOut() {
  try { await api('/api/logout', {}); } catch { /* already signed out */ }
  window.location.replace('/login.html');
}

// ── Connection check ─────────────────────────────────────────────────
async function verify() {
  el.verifyBtn.disabled = true;
  setStamp('wait', 'checking');
  try {
    const data = await api('/api/verify', {});
    if (data.ok) {
      setStamp('ok', 'connection ok');
      toast(`Signed in to ${data.smtp.host}:${data.smtp.port} as ${data.smtp.user || 'local'}`, 'ok');
    } else {
      setStamp('bad', 'failed');
      toast(data.error || 'Connection failed', 'bad');
    }
  } catch (err) {
    setStamp('bad', 'failed');
    toast(err.message, 'bad');
  } finally {
    el.verifyBtn.disabled = false;
  }
}

function setStamp(kind, text) {
  el.stamp.dataset.state = kind;
  el.stamp.textContent = text;
}

// ── Test send ────────────────────────────────────────────────────────
async function sendTest() {
  const to = el.testTo.value.trim();
  if (!to) { el.testTo.focus(); toast('Enter an address for the test message', 'bad'); return; }
  if (state.sending) return;

  el.testBtn.disabled = true;
  el.testBtn.textContent = 'Sending test…';
  try {
    const data = await api('/api/test', body({ to }));
    if (data.ok) {
      toast(`Test delivered to ${to}`, 'ok');
      addLine({ n: 'test', tag: 'sent', tagLabel: 'test', addr: to, note: `${data.inline} inline` });
    } else {
      toast(data.error, 'bad');
      addLine({ n: 'test', tag: 'failed', tagLabel: 'test', addr: to, note: data.error });
    }
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    el.testBtn.disabled = false;
    el.testBtn.textContent = 'Send test';
  }
}

// ── Save a pasted list into data/ ────────────────────────────────────
async function savePastedList() {
  const text = el.pasteBox.value.trim();
  if (!text) { el.pasteBox.focus(); toast('Paste some addresses first', 'bad'); return; }
  if (!inspectPaste(text).valid) { toast('No usable addresses in that list yet', 'bad'); return; }

  el.saveCsvBtn.disabled = true;
  el.saveCsvBtn.textContent = 'Saving…';
  try {
    const data = await api('/api/recipients', { text, name: el.campaign.value.trim() });
    await loadState();

    setMode('saved', { refresh: false });
    if (state.csvs.some((c) => c.path === data.path)) {
      el.csv.value = data.path;
      store.set('csv', data.path);
    }
    describeCsv();

    el.pasteBox.value = '';
    updatePasteCount();
    toast(`Saved ${plural(data.recipients, 'address', 'addresses')} to ${data.path}`, 'ok');
    await refreshPreview({ resetIndex: true });
    await loadRoster();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    el.saveCsvBtn.disabled = false;
    el.saveCsvBtn.textContent = 'Save as CSV';
  }
}

// ── Ledger ───────────────────────────────────────────────────────────
function clearLedger() {
  el.ledger.innerHTML = '';
}

function addLine({ n, tag, tagLabel, addr, note }) {
  const idle = el.ledger.querySelector('.ledger__idle');
  if (idle) idle.remove();

  const li = document.createElement('li');
  const num = document.createElement('span');
  num.className = 'n';
  num.textContent = n;

  const label = document.createElement('span');
  label.className = `tag tag--${tag}`;
  label.textContent = tagLabel;

  const who = document.createElement('span');
  who.className = 'addr';
  who.textContent = addr;

  const extra = document.createElement('span');
  extra.className = tag === 'failed' ? 'err' : '';
  extra.textContent = note || '';

  li.append(num, label, who, extra);
  el.ledger.append(li);
  el.ledger.scrollTop = el.ledger.scrollHeight;
}

function addSummary(text) {
  const li = document.createElement('li');
  li.className = 'ledger__summary';
  li.textContent = text;
  el.ledger.append(li);
  el.ledger.scrollTop = el.ledger.scrollHeight;
}

function setCounts({ sent = 0, failed = 0, skipped = 0 }) {
  el.runCounts.innerHTML = '';
  const groups = [
    ['sent', sent, false],
    ['failed', failed, failed > 0],
    ['skipped', skipped, false],
  ];
  for (const [name, value, bad] of groups) {
    const span = document.createElement('span');
    if (bad) span.className = 'is-bad';
    span.innerHTML = `${name} <b>${value}</b>`;
    el.runCounts.append(span);
  }
}

// ── Send ─────────────────────────────────────────────────────────────
function openConfirm() {
  if (!state.lastPreview) return;
  const p = state.lastPreview;
  el.modalBody.innerHTML = '';
  const lead = document.createElement('p');
  lead.append('This sends ');
  const count = document.createElement('strong');
  count.textContent = plural(p.willSend, 'message');
  lead.append(count, ` from ${state.smtp.from} through ${state.smtp.host}, starting with ${p.to}.`);
  const note = document.createElement('p');
  note.textContent = p.skipped
    ? `${p.skipped} address${p.skipped === 1 ? ' is' : 'es are'} already logged for this campaign and will be skipped.`
    : 'Every recipient in this selection will receive it.';

  el.modalBody.append(lead, note);
  el.modalCheck.checked = false;
  el.modalConfirm.disabled = true;
  el.modal.hidden = false;
  el.modalCheck.focus();
}

function closeConfirm() {
  el.modal.hidden = true;
}

function lockControls() {
  state.sending = true;
  el.sendBtn.disabled = true;
  el.testBtn.disabled = true;
  el.verifyBtn.disabled = true;
  el.cancelBtn.hidden = false;
  el.cancelBtn.disabled = false;
  el.cancelBtn.textContent = 'Stop after this one';
  clearLedger();
  setCounts({});
}

async function startSend() {
  closeConfirm();
  if (state.sending) return;

  lockControls();

  try {
    const data = await api('/api/send', body({ confirm: true, delay: currentDelay() }));
    listen(data.jobId);
  } catch (err) {
    unlockControls();
    toast(err.message, 'bad');
  }
}

/** Re-attach to a campaign that survived a page reload. */
async function resumeActiveJob({ quiet = false } = {}) {
  if (state.sending) return;
  try {
    const active = await api('/api/jobs/active');
    if (!active?.jobId) return;
    lockControls();
    listen(active.jobId);
    if (!quiet) {
      toast(`Showing a campaign that is still sending${active.total ? ` (${active.total} recipients)` : ''}.`, 'ok');
    }
  } catch { /* nothing running, or server restarting */ }
}

function listen(jobId, attempt = 0) {
  if (state.stream) state.stream.close();
  const stream = new EventSource(`/api/jobs/${jobId}/events`);
  state.stream = stream;
  state.jobId = jobId;

  let counts = { sent: 0, failed: 0, skipped: 0 };
  let finished = false;

  stream.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    if (data.type === 'start') {
      addLine({ n: '—', tag: 'run', tagLabel: 'start', addr: plural(data.total, 'recipient'), note: data.campaign || 'untagged' });
    } else if (data.type === 'progress') {
      if (data.status === 'sent') counts.sent++;
      if (data.status === 'failed') counts.failed++;
      if (data.status === 'skip') counts.skipped++;
      setCounts(counts);
      addLine({
        n: String(data.index).padStart(2, '0'),
        tag: data.status,
        tagLabel: data.status === 'skip' ? 'skip' : data.status,
        addr: data.email,
        note: data.error || '',
      });
    } else if (data.type === 'fatal') {
      addLine({ n: '!!', tag: 'failed', tagLabel: 'halt', addr: data.email, note: data.error });
    } else if (data.type === 'error') {
      addLine({ n: '!!', tag: 'failed', tagLabel: 'error', addr: '', note: data.error });
    } else if (data.type === 'done') {
      finished = true;
      state.jobId = null;
      const s = data.summary || {};
      addSummary(s.error
        ? `Stopped — ${s.error}`
        : `${s.stopped ? 'Stopped' : 'Done'} — sent ${s.sent || 0}, failed ${s.failed || 0}, skipped ${s.skipped || 0}.${s.failed ? ' Failures are in the log.' : ''}`);
      finishSend(s);
      stream.close();
    }
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
    toast('Lost the progress stream — check the send log before re-running.', 'bad');
  };
}

function unlockControls() {
  state.sending = false;
  state.jobId = null;
  el.testBtn.disabled = false;
  el.verifyBtn.disabled = false;
  el.cancelBtn.hidden = true;
  if (state.lastPreview) {
    el.sendBtn.textContent = state.lastPreview.willSend ? `Send ${plural(state.lastPreview.willSend, 'message')}` : 'Nothing left to send';
    el.sendBtn.disabled = state.lastPreview.willSend === 0;
  }
}

async function finishSend(summary) {
  unlockControls();
  if (summary.error) toast(summary.error, 'bad');
  else if (summary.failed) toast(`${summary.failed} message${summary.failed === 1 ? '' : 's'} failed — see the ledger and log.`, 'bad');
  else if (summary.stopped) toast(`Stopped after ${plural(summary.sent || 0, 'message')} sent.`, 'ok');
  else toast(`Campaign finished: ${plural(summary.sent || 0, 'message')} sent.`, 'ok');

  try {
    await loadState();
    await refreshPreview({ resetIndex: true });
    await loadRoster();
  } catch { /* the summary above is enough */ }
}

async function cancelSend() {
  if (!state.jobId) return;
  el.cancelBtn.disabled = true;
  el.cancelBtn.textContent = 'Stopping…';
  try {
    await api(`/api/jobs/${state.jobId}/cancel`, {});
  } catch (err) {
    toast(err.message, 'bad');
    el.cancelBtn.disabled = false;
    el.cancelBtn.textContent = 'Stop after this one';
  }
}

// ── Scheduling ───────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');

function toLocalInput(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
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
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}

async function loadQueue() {
  try {
    const data = await api('/api/schedule');
    state.queue = data.entries || [];
    const active = state.queue.filter((e) => e.status === 'pending' || e.status === 'sending').length;
    el.queueCount.textContent = String(active);
    el.queueCount.hidden = active === 0;
    if (!el.queueModal.hidden) renderQueue();
    return data;
  } catch {
    return null;
  }
}

function queueStatusLabel(status) {
  return status === 'pending' ? 'scheduled' : status;
}

function renderQueue() {
  el.queueList.replaceChildren();
  el.queueEmpty.hidden = state.queue.length > 0;

  for (const entry of state.queue) {
    const li = document.createElement('li');

    const content = document.createElement('div');
    content.className = 'queue__content';

    const line = document.createElement('div');
    line.className = 'queue__line';
    const when = document.createElement('span');
    when.className = 'queue__when';
    when.textContent = formatWhen(entry.at);
    const chip = document.createElement('span');
    chip.className = `tag-status tag-status--${entry.status}`;
    chip.textContent = queueStatusLabel(entry.status);
    line.append(when, chip);

    if (entry.status === 'pending') {
      const rel = document.createElement('span');
      rel.className = 'queue__meta';
      rel.textContent = relative(entry.at);
      line.append(rel);
    }

    const meta = document.createElement('div');
    meta.className = 'queue__meta';
    meta.textContent = [
      entry.campaign || 'no campaign',
      plural(entry.recipients, 'recipient'),
      entry.subject,
    ].filter(Boolean).join(' · ');

    content.append(line, meta);

    const note = entry.error
      || (entry.result ? `sent ${entry.result.sent}, failed ${entry.result.failed}, skipped ${entry.result.skipped}` : '');
    if (note) {
      const noteEl = document.createElement('div');
      noteEl.className = entry.error ? 'queue__error' : 'queue__meta';
      noteEl.textContent = note;
      content.append(noteEl);
    }

    const actions = document.createElement('div');
    actions.className = 'queue__actions';

    if (entry.status === 'pending' || entry.status === 'missed') {
      const run = document.createElement('button');
      run.type = 'button';
      run.className = 'btn';
      run.textContent = 'Send now';
      run.addEventListener('click', () => runScheduled(entry.id));
      actions.append(run);

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn--quiet';
      cancel.textContent = entry.status === 'missed' ? 'Discard' : 'Cancel';
      cancel.addEventListener('click', () => cancelScheduled(entry.id));
      actions.append(cancel);
    }

    li.append(content, actions);
    el.queueList.append(li);
  }
}

async function runScheduled(id) {
  try {
    await api(`/api/schedule/${id}/run`, {});
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function cancelScheduled(id) {
  try {
    await api(`/api/schedule/${id}/cancel`, {});
    toast('Scheduled campaign removed.');
    await loadQueue();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function openSchedule() {
  const preview = state.lastPreview;
  if (!preview) return;

  const others = preview.willSend - 1;
  el.scheduleSummary.textContent = `${plural(preview.willSend, 'message')} to ${preview.to}${others > 0 ? ` and ${others} more` : ''} — “${preview.subject}”.`;
  el.scheduleAt.value = toLocalInput(new Date(Date.now() + 60 * 60 * 1000));
  el.scheduleZone.textContent = `Times are ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`;
  el.scheduleStatus.textContent = '';
  el.scheduleStatus.className = 'settings__status';
  el.scheduleModal.hidden = false;
  el.scheduleAt.focus();
}

function closeSchedule() {
  el.scheduleModal.hidden = true;
}

async function submitSchedule() {
  const when = el.scheduleAt.value ? new Date(el.scheduleAt.value) : null;
  if (!when || Number.isNaN(when.getTime())) {
    el.scheduleStatus.textContent = 'Pick a date and time';
    el.scheduleStatus.className = 'settings__status is-bad';
    return;
  }

  el.scheduleConfirm.disabled = true;
  el.scheduleStatus.textContent = 'Scheduling…';
  el.scheduleStatus.className = 'settings__status';
  try {
    await api('/api/schedule', body({ at: when.toISOString(), delay: currentDelay() }));
    closeSchedule();
    toast(`Scheduled for ${formatWhen(when.toISOString())}.`, 'ok');
    await loadQueue();
  } catch (err) {
    el.scheduleStatus.textContent = err.message;
    el.scheduleStatus.className = 'settings__status is-bad';
  } finally {
    el.scheduleConfirm.disabled = false;
  }
}

// ── Merge-field chips ────────────────────────────────────────────────
function buildTokens() {
  el.tokens.innerHTML = '';
  for (const name of ['name', 'company', 'email']) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'token';
    chip.textContent = `{{${name}}}`;
    chip.addEventListener('click', () => insertToken(`{{${name}}}`));
    el.tokens.append(chip);
  }
}

function insertToken(token) {
  const input = el.subject;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + token + input.value.slice(end);
  input.focus();
  input.setSelectionRange(start + token.length, start + token.length);
  store.set('subject', input.value);
  refreshPreview();
}

// ── Events ───────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

el.verifyBtn.addEventListener('click', verify);
el.queueBtn.addEventListener('click', async () => {
  await loadQueue();
  renderQueue();
  el.queueModal.hidden = false;
});
el.queueClose.addEventListener('click', () => { el.queueModal.hidden = true; });
el.queueModal.addEventListener('click', (event) => {
  if (event.target === el.queueModal) el.queueModal.hidden = true;
});

el.scheduleBtn.addEventListener('click', openSchedule);
el.scheduleCancel.addEventListener('click', closeSchedule);
el.scheduleConfirm.addEventListener('click', submitSchedule);
el.scheduleModal.addEventListener('click', (event) => {
  if (event.target === el.scheduleModal) closeSchedule();
});

el.settingsBtn.addEventListener('click', () => openSettings());
el.signOutBtn.addEventListener('click', signOut);
el.settingsTestBtn.addEventListener('click', testSettings);
el.settingsSaveBtn.addEventListener('click', saveSettings);
el.settingsCancel.addEventListener('click', closeSettings);
el.testBtn.addEventListener('click', sendTest);
el.previewBtn.addEventListener('click', () => refreshPreview({ resetIndex: true }));
el.prevBtn.addEventListener('click', () => { state.index--; refreshPreview(); });
el.nextBtn.addEventListener('click', () => { state.index++; refreshPreview(); });
el.sendBtn.addEventListener('click', openConfirm);
el.modalCancel.addEventListener('click', closeConfirm);
el.cancelBtn.addEventListener('click', cancelSend);

el.modal.addEventListener('click', (event) => {
  if (event.target === el.modal) closeConfirm();
});

el.settingsModal.addEventListener('click', (event) => {
  if (event.target === el.settingsModal) closeSettings();
});

for (const input of [el.setHost, el.setPort, el.setUser, el.setPass, el.setFrom]) {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveSettings();
    }
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.modal.hidden) closeConfirm();
  if (event.key === 'Escape' && !el.settingsModal.hidden) closeSettings();
  if (event.key === 'Escape' && !el.scheduleModal.hidden) closeSchedule();
  if (event.key === 'Escape' && !el.queueModal.hidden) el.queueModal.hidden = true;
  if (event.key === 'Enter' && !el.scheduleModal.hidden) submitSchedule();
  if (event.key === 'Enter' && !el.modal.hidden && !el.modalConfirm.disabled && document.activeElement === el.modalCheck) {
    startSend();
  }
});

el.modalCheck.addEventListener('change', () => {
  el.modalConfirm.disabled = !el.modalCheck.checked;
});
el.modalConfirm.addEventListener('click', startSend);

el.modeSaved.addEventListener('click', () => setMode('saved'));
el.modePaste.addEventListener('click', () => setMode('paste', { focus: true }));
el.saveCsvBtn.addEventListener('click', savePastedList);

el.pasteBox.addEventListener('input', debounce(() => {
  updatePasteCount();
  refreshPreview({ resetIndex: true });
}, 600));

el.template.addEventListener('change', () => {
  store.set('template', el.template.value);
  describeTemplate();
  refreshPreview({ resetIndex: true });
});

el.csv.addEventListener('change', () => {
  store.set('csv', el.csv.value);
  describeCsv();
  state.index = 0;
  refreshPreview({ resetIndex: true });
  loadRoster();
});

el.subject.addEventListener('input', debounce(() => {
  store.set('subject', el.subject.value);
  refreshPreview();
}, 420));

const refreshForCampaign = debounce(() => {
  refreshPreview();
  loadRoster();
}, 450);

el.campaign.addEventListener('input', () => {
  store.set('campaign', el.campaign.value);
  el.slipNo.textContent = el.campaign.value.trim() || 'no campaign';
  refreshForCampaign();
});

el.limit.addEventListener('input', debounce(() => {
  refreshPreview({ resetIndex: true });
  loadRoster();
}, 420));
el.delay.addEventListener('change', () => store.set('delay', el.delay.value));
el.testTo.addEventListener('input', () => store.set('test', el.testTo.value));

// Restore fields saved from an earlier session, then load.
el.subject.value = store.get('subject', el.subject.value);
el.testTo.value = store.get('test', '');
if (store.get('delay')) el.delay.value = store.get('delay');
buildTokens();
setMode(store.get('mode') === 'paste' ? 'paste' : 'saved', { refresh: false });

// The scheduler runs on the server; poll so the badge and queue stay honest
// and progress from a scheduled send appears without a reload.
setInterval(async () => {
  await loadQueue();
  if (!state.sending) await resumeActiveJob({ quiet: true });
}, 15000);

loadState()
  .then(async () => {
    await refreshPreview({ resetIndex: true });
    if (state.mode === 'saved') await loadRoster();
    await loadQueue();
    await resumeActiveJob({ quiet: true });
    if (!state.setup.configured) openSettings({ firstRun: true });
  })
  .catch((err) => {
    el.proofEmpty.hidden = false;
    el.proofEmpty.textContent = `Could not reach the local server: ${err.message}`;
    toast('Could not reach the local server. Is `npm run gui` still running?', 'bad');
  });
