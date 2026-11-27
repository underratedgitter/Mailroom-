// Mailroom — browser front end entry point.
// Talks only to the loopback server in src/gui.mjs, which owns all the real
// work. Nothing here holds credentials or sends mail by itself.
//
// Layout stability: the page is polled in the background, so every render
// path patches the DOM in place (setText, reconcile) and touches a node only
// when its value really changed. Nothing rebuilds a list that is unchanged.
import {
  api,
  baseName,
  h,
  hooks,
  initDialogs,
  plural,
  setAttr,
  setHidden,
  setText,
  state,
  store,
  toast,
  ui,
} from './api.mjs';
import { describeTemplate, initCompose, refreshPreview, renderTokens } from './compose.mjs';
import { initOverview, loadCampaigns, loadHealth, mailboxOf, renderCampaigns, renderConn, renderDraft } from './overview.mjs';
import { describeCsv, initRecipients, loadRoster, markRosterCurrent, setTab, validatePaste } from './recipients.mjs';
import { initSchedule, loadQueue, prepareScheduleForm, renderScheduleSummary } from './schedule.mjs';
import { initSend, listen, lockControls, resumeActiveJob } from './send.mjs';
import { initSettings, loadSettingsForm } from './settings.mjs';
import { initSuppression, loadSuppression } from './suppression.mjs';
import { initTemplateStudio, loadStudioTemplate, renderTemplateControls } from './template-studio.mjs';

function options(select, items, preferred) {
  const unchanged = select.options.length === items.length
    && items.every((item, i) => select.options[i].value === item.value && select.options[i].textContent === item.label);
  if (unchanged) return;

  const keep = select.value;
  select.replaceChildren(...items.map((item) => h('option', { value: item.value }, item.label)));
  const wanted = [keep, preferred].find((value) => value && items.some((item) => item.value === value));
  if (wanted) select.value = wanted;
}

// ── Routing ──────────────────────────────────────────────────────────
const ROUTES = [
  { id: 'overview', title: 'Overview', view: 'viewOverview', heading: 'hOverview', enter: () => { loadHealth(); loadCampaigns(); } },
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
  options(ui.reportCsv, data.csvs.filter((c) => !c.error).map((c) => ({
    value: c.path,
    label: c.name,
  })), ui.csv.value || store.get('csv'));
  setHidden(ui.reportCsvWrap, data.csvs.every((c) => c.error));
  setHidden(ui.csvEmpty, data.csvs.length > 0);
  setHidden(ui.csv.closest('.field'), data.csvs.length === 0);

  if (!ui.campaign.value) ui.campaign.value = store.get('campaign') || data.defaults.campaign;
  if (!ui.delay.dataset.touched && store.get('delay') === '') ui.delay.value = data.defaults.delay;

  renderCampaigns();
  describeTemplate();
  describeCsv();
  renderConn();
  renderDraft();
  if (state.composeTab === 'studio' && ui.template.value && state.studioPath !== ui.template.value) {
    loadStudioTemplate();
  }
}

// ── Background refresh ───────────────────────────────────────────────
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
  if (currentRoute().id === 'overview') await loadCampaigns();
  if (currentRoute().id === 'settings' || currentRoute().id === 'overview') await loadHealth();
}

// ── Events & boot ────────────────────────────────────────────────────
function initNavigation() {
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
}

hooks.loadState = loadState;
hooks.renderScheduleSummary = renderScheduleSummary;
hooks.markRosterCurrent = markRosterCurrent;
hooks.loadRoster = loadRoster;
hooks.renderTemplateControls = renderTemplateControls;
hooks.loadStudioTemplate = loadStudioTemplate;
hooks.attachJob = (jobId) => { if (!state.sending) lockControls(); listen(jobId); };

initDialogs();
initNavigation();
initOverview();
initCompose();
initTemplateStudio();
initRecipients();
initSend();
initSchedule();
initSuppression();
initSettings();

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
