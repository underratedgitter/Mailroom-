import { api, go, hooks, setClass, setText, state, toast, ui } from './api.mjs';
import { refreshPreview } from './compose.mjs';
import { setConn } from './overview.mjs';

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

export function initSettings() {
  ui.signOutBtn.addEventListener('click', signOut);
  ui.signOutBtn2.addEventListener('click', signOut);
  ui.settingsForm.addEventListener('submit', saveSettings);
  ui.settingsForm.addEventListener('input', () => { state.settingsDirty = true; });
  // The two common ports each imply a mode; pick it so the selector starts right.
  ui.setPort.addEventListener('change', () => {
    const port = Number(ui.setPort.value);
    if (port === 465) ui.setSecure.value = 'true';
    else if (port === 587 || port === 25) ui.setSecure.value = 'false';
  });
  ui.settingsTestBtn.addEventListener('click', testSettings);
}
