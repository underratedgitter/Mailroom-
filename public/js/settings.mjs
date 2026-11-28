import { api, go, h, hooks, reconcile, setAttr, setClass, setHidden, setText, state, toast, ui } from './api.mjs';
import { refreshPreview } from './compose.mjs';
import { setConn } from './overview.mjs';

export const WEBHOOK_PATH = '/api/webhooks/bounces';

let savedMailbox = null;

function updatePasswordHint() {
  const host = ui.setHost.value.trim().toLowerCase();
  const user = ui.setUser.value.trim();
  const canReuse = savedMailbox?.host === host && savedMailbox?.user === user;
  setHidden(ui.setGmailHelp, host !== 'smtp.gmail.com');
  setText(ui.setPassHint, canReuse
    ? 'Leave blank to keep the saved password.'
    : host === 'localhost' || host === '127.0.0.1'
      ? 'Leave blank if your relay requires no sign-in.'
      : 'Enter the password provided for SMTP sign-in.');
}

export async function loadSettingsForm() {
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
    ui.setPublicUrl.value = settings.publicUrl || '';
    ui.setMaxPerHour.value = settings.maxPerHour || '';
    ui.setMaxPerDomainPerHour.value = settings.maxPerDomainPerHour || '';
    ui.setMaxPerDay.value = settings.maxPerDay || '';
    ui.setPass.value = '';
    savedMailbox = settings.passwordSet ? { host: ui.setHost.value.toLowerCase(), user: ui.setUser.value } : null;
    if (ui.setHost.value.toLowerCase() !== 'smtp.gmail.com' || settings.port !== 465 || !settings.secure) {
      ui.setServerOptions.open = true;
    }
    updatePasswordHint();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function settingsPayload() {
  return {
    host: ui.setHost.value.trim(),
    port: ui.setPort.value === '' ? undefined : Number(ui.setPort.value),
    secure: ui.setSecure.value === 'true',
    user: ui.setUser.value.trim(),
    pass: ui.setPass.value,
    from: ui.setFrom.value.trim(),
    replyTo: ui.setReplyTo.value.trim(),
    unsubscribeUrl: ui.setUnsubUrl.value.trim(),
    publicUrl: ui.setPublicUrl.value.trim(),
    maxPerHour: ui.setMaxPerHour.value.trim(),
    maxPerDomainPerHour: ui.setMaxPerDomainPerHour.value.trim(),
    maxPerDay: ui.setMaxPerDay.value.trim(),
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

    await hooks.loadState();
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

const DNS_LABELS = [
  ['mx', 'MX'],
  ['spf', 'SPF'],
  ['dmarc', 'DMARC'],
  ['dkim', 'DKIM'],
];

const DNS_TAG = { pass: 'sent', warn: 'skip', fail: 'failed' };

function renderDnsReport(report) {
  if (!report?.checks) {
    setHidden(ui.dnsList, true);
    return;
  }
  const items = DNS_LABELS.map(([key, label]) => ({
    key,
    label,
    ...(report.checks[key] || { status: 'fail', detail: 'Not checked' }),
  }));
  reconcile(ui.dnsList, items, (item) => item.key,
    () => h('li', { class: 'dns-item' },
      h('div', {}, h('div', { class: 'dns-item__label' }), h('div', { class: 'dns-item__detail' })),
      h('span', { class: 'tag' })),
    (li, item) => {
      const [info, tag] = li.children;
      setText(info.children[0], item.label);
      setText(info.children[1], item.detail || '');
      setText(tag, item.status || '');
      setAttr(tag, 'class', 'tag' + (DNS_TAG[item.status] ? ' tag--' + DNS_TAG[item.status] : ''));
    });
  setHidden(ui.dnsList, false);
}

async function checkDns() {
  ui.dnsCheckBtn.disabled = true;
  setText(ui.dnsStatus, 'Looking up DNS records…');
  setClass(ui.dnsStatus, 'is-ok', false);
  setClass(ui.dnsStatus, 'is-bad', false);
  try {
    const report = await api('/api/settings/dns', {
      from: ui.setFrom.value.trim(),
      selector: ui.dnsSelector.value.trim(),
    });
    state.dns = report;
    setText(ui.dnsStatus, report.summary || 'DNS check complete.');
    setClass(ui.dnsStatus, 'is-ok', Boolean(report.ok));
    setClass(ui.dnsStatus, 'is-bad', !report.ok);
    renderDnsReport(report);
  } catch (err) {
    setHidden(ui.dnsList, true);
    setText(ui.dnsStatus, err.message);
    setClass(ui.dnsStatus, 'is-ok', false);
    setClass(ui.dnsStatus, 'is-bad', true);
  } finally {
    ui.dnsCheckBtn.disabled = false;
  }
}

export function initSettings() {
  ui.signOutBtn.addEventListener('click', signOut);
  ui.signOutBtn2.addEventListener('click', signOut);
  ui.settingsForm.addEventListener('submit', saveSettings);
  ui.settingsForm.addEventListener('input', (event) => {
    state.settingsDirty = true;
    setSettingsStatus('');
    if (event.target === ui.setHost || event.target === ui.setUser) updatePasswordHint();
  });
  // The two common ports each imply a mode; pick it so the selector starts right.
  ui.setPort.addEventListener('change', () => {
    const port = Number(ui.setPort.value);
    if (port === 465) ui.setSecure.value = 'true';
    else if (port === 587 || port === 25) ui.setSecure.value = 'false';
  });
  ui.settingsTestBtn.addEventListener('click', testSettings);
  ui.dnsCheckBtn.addEventListener('click', checkDns);
}
