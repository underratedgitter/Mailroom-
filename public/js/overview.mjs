import {
  api,
  baseName,
  currentDelay,
  debounce,
  formatDuration,
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
  ui,
} from './api.mjs';

export const mailboxOf = (smtp) => smtp.user || (smtp.from.match(/<([^>]+)>/) || [])[1] || smtp.from || '';

export function renderConn() {
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

export function setConn(kind) {
  state.conn = kind;
  renderConn();
}

export async function loadHealth() {
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

  try {
    const res = await fetch('/api/ready');
    const readyData = await res.json().catch(() => null);
    if (readyData?.ready) {
      setText(ui.aboutReady, 'Ready (templates, logs, scheduler)');
    } else if (readyData?.checks) {
      const failed = Object.entries(readyData.checks).filter(([, ok]) => !ok).map(([name]) => name);
      setText(ui.aboutReady, 'Not ready' + (failed.length ? ' (' + failed.join(', ') + ')' : ''));
    } else {
      setText(ui.aboutReady, res.ok ? 'Ready' : 'Not ready (' + res.status + ')');
    }
  } catch {
    setText(ui.aboutReady, 'Unreachable');
  }
}

export async function loadCampaigns() {
  try {
    const { q, limit, offset } = state.campaignPage;
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (q) params.set('q', q);
    const data = await api('/api/campaigns?' + params.toString());
    state.campaigns = data.campaigns || [];
    state.campaignPage.total = data.total ?? state.campaigns.length;
    state.campaignPage.filtered = data.filtered ?? state.campaigns.length;
    state.campaignPage.offset = data.offset ?? offset;
    renderCampaigns();
  } catch { /* fallback to /api/state recent list */ }
}

function exportHref(campaignId, kind, csvPath = '') {
  const params = new URLSearchParams({ kind });
  if (csvPath) params.set('csv', csvPath);
  return '/api/campaigns/' + encodeURIComponent(campaignId) + '/export?' + params.toString();
}

export function initOverview() {
  ui.reportCsv.addEventListener('change', renderCampaigns);
  ui.campaignSearch.addEventListener('input', debounce(() => {
    state.campaignPage.q = ui.campaignSearch.value.trim();
    state.campaignPage.offset = 0;
    loadCampaigns();
  }, 200));
  ui.campaignPrevBtn.addEventListener('click', () => {
    state.campaignPage.offset = Math.max(0, state.campaignPage.offset - state.campaignPage.limit);
    loadCampaigns();
  });
  ui.campaignNextBtn.addEventListener('click', () => {
    state.campaignPage.offset += state.campaignPage.limit;
    loadCampaigns();
  });
}

export function renderCampaigns() {
  const rows = state.campaigns || state.log.campaigns || [];
  const { total, filtered, limit, offset, q } = state.campaignPage;
  const knownTotal = state.campaigns ? total : rows.length;
  const knownFiltered = state.campaigns ? filtered : rows.length;

  setHidden(ui.campaignsEmpty, rows.length > 0);
  setHidden(ui.campaignsWrap, rows.length === 0);
  setHidden(ui.campaignsPager, knownFiltered <= limit || rows.length === 0);
  setText(ui.campaignsEmptyTitle, knownTotal && q ? 'No matching campaigns' : 'No campaigns yet');
  setText(ui.campaignsEmptyText, knownTotal && q
    ? 'No campaign name matches “' + q + '”.'
    : 'Sent campaigns show up here with their results.');
  if (rows.length) {
    ui.campaignPrevBtn.disabled = offset <= 0;
    ui.campaignNextBtn.disabled = offset + rows.length >= knownFiltered;
    setText(ui.campaignPageInfo, (offset + 1) + '–' + (offset + rows.length) + ' of ' + knownFiltered);
  }
  const csvPath = ui.reportCsv.value || '';

  reconcile(ui.campaignsBody, rows, (c) => c.id,
    () => h('tr', {},
      h('th', { scope: 'row' }, h('div'), h('div', { class: 'queue__meta' })),
      h('td', { class: 'num' }),
      h('td', { class: 'num' }),
      h('td', { class: 'num' }),
      h('td', {},
        h('div', { class: 'export-links' },
          h('a', { class: 'export-link', download: '' }, 'Sent'),
          h('a', { class: 'export-link', download: '' }, 'Failed'),
          h('a', { class: 'export-link', download: '' }, 'Unsent')))),
    (tr, c) => {
      const [head, sentCell, failedCell, skippedCell, exportCell] = tr.children;
      setText(head.children[0], c.id);
      setText(head.children[1], c.last ? formatWhen(c.last) : '—');
      setText(sentCell, c.sent);
      setText(failedCell, c.failed);
      setText(skippedCell, c.skipped);
      setClass(failedCell, 'is-bad', c.failed > 0);

      const [sentLink, failedLink, unsentLink] = exportCell.children[0].children;
      setAttr(sentLink, 'href', exportHref(c.id, 'sent', csvPath));
      setHidden(sentLink, !c.sent);
      setAttr(failedLink, 'href', exportHref(c.id, 'failed', csvPath));
      setHidden(failedLink, !c.failed);
      setAttr(unsentLink, 'href', csvPath ? exportHref(c.id, 'unsent', csvPath) : '#');
      setHidden(unsentLink, !csvPath);
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
export function draftChecks() {
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

export function renderDraft() {
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

  hooks.renderScheduleSummary();
}
